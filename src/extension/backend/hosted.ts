// A turn that runs built in (DESIGN §25), from the prompt interceptor to the record on the reply.
//
// Lumiverse waits for the interceptor before it sends a reply's prompt. In that wait the core's
// first half runs here (`prepare`): the main agent works and briefs the writer, and the prompt goes
// back with the brief put in, for Lumiverse's own generation to write the reply on the chat's own
// connection. When Lumiverse says the generation ended, the text it wrote is handed to the second
// half (`complete`) and the turn's record is written on the reply's message; a generation that
// failed or was stopped gives the turn up.
//
// It never costs the user a reply. Whatever fails here, and when the time Lumiverse gives is
// nearly gone, the prompt goes back exactly as it came, and the live view says why LumiAH had no
// part in that reply. The interceptor isn't required, so even a failure of this code leaves
// Lumiverse to answer alone. A first half that never returns is let go when its prompt goes back:
// it holds up no later reply of its chat.
//
// A turn that waits for its reply is kept in the user's storage from the moment its prompt is
// handed back (open.ts), so a restart of this worker between the two halves loses nothing without
// a word: a reply that was saved meanwhile still gets its record, and one that never came is let go.

import type { JsonObject, RequestMessage, TurnRequest } from "../../core/ports";
import type { CauseCode, NoPart, NoPartWhy } from "../../shared/ui";
import type { Builtin } from "./builtin";
import type { Chats } from "./chat";
import type { Connections } from "./connections";
import { wordsOf } from "./errors";
import { BUILTIN, type LiveBuffer } from "./live";
import type { OpenTurn, OpenTurns } from "./open";
import type { SettingsStore } from "./settings";
import type { BackendHost, GenerationEnded, InterceptorInput, InterceptorVerdict, PromptSlot } from "./spindle";
import type { Target, Turn, Turns } from "./turns";

/**
 * Lumiverse ends an interceptor's signal when the user stops the generation and when it stops
 * waiting, and says which in no way but the moment. Its timer and this clock are read apart, so a
 * signal that ends within this much of the deadline Lumiverse gave is its timeout. Not a setting:
 * it is how far two timers on one machine can stand apart, and nobody presses Stop by intent in
 * the last quarter second of the wait.
 */
const DEADLINE_SLACK_MS = 250;

export interface HostedDeps {
  turns: Turns;
  chats: Chats;
  connections: Connections;
  settings: SettingsStore;
  live: LiveBuffer;
  builtin: Builtin;
  /** The turns that wait for their replies, kept across a restart of this worker. */
  open: OpenTurns;
  /** The extension as its pages show it. */
  name: string;
  now(): number;
  /** Runs `fn` once after `ms`; what it returns cancels that. */
  later(ms: number, fn: () => void): () => void;
}

/** A turn here that isn't over: its first half runs, or it waits for its reply. */
interface Running {
  turn: Turn;
  target: Target;
  startedAt: number;
  /** When Lumiverse stops waiting for the turn's prompt. */
  limit: number;
  /** Ends its first half: a Stop in Lumiverse, the user's skip on a page, another reply asked for in its chat, or its time. */
  stop: AbortController;
  /** Resolves once its first half has returned, whichever way. */
  prepared: Promise<void>;
  /** Its first half is over and the turn waits for its reply: `complete` or `abandon` is owed. */
  pending: boolean;
  /** Its place in storage while it waits, once that was asked for: what takes it out again waits for this. */
  kept: Promise<void> | null;
  /** Lumiverse let its generation go (its own Stop): no reply follows, so nothing is said of who wrote one. */
  halted: boolean;
  /** What cut its first half short, where something did: the time Lumiverse gives ran out, the user skipped LumiAH for this reply, or another reply was asked for in its chat. */
  cut: "time" | "skipped" | "next" | null;
  /** It was let go before its first half returned: whatever that half hands over later, nobody will complete it. */
  letGo: boolean;
  /** For a continue: what the reply's swipe held before the generation, which isn't the turn's reply. */
  before: string;
  /** LumiAH had no part in the reply, and why. */
  noPart: NoPart | null;
  /** It is over, and what waited on it was told. */
  done: boolean;
}

/** A reason as a sentence of its own. */
function sentence(text: string): string {
  const said = text.trim();
  return said === "" || /[.!?…]$/.test(said) ? said : `${said}.`;
}

/**
 * What Lumiverse is to send, from what the core handed back: each message that came keeps its
 * place among those that came (so Lumiverse sends it exactly as it made it), and what the core put
 * in (the brief, an entry of lore the main agent added) or changed goes as its role and text. The
 * core returns the messages it was given in their order, so one pass finds them: by being the same
 * message, else by saying the same.
 */
export function slotsOf(came: readonly RequestMessage[], places: readonly number[], handed: readonly RequestMessage[], name: string): PromptSlot[] {
  const slots: PromptSlot[] = [];
  let next = 0;
  for (const message of handed) {
    let at = came.indexOf(message, next);
    if (at < 0) at = came.findIndex((m, i) => i >= next && m.role === message.role && m.content === message.content);
    const place = at < 0 ? undefined : places[at];
    if (place !== undefined) {
      slots.push({ keep: place });
      next = at + 1;
      continue;
    }
    // Named for Lumiverse's Prompt Breakdown, where the user reads what LumiAH put in their prompt.
    const label = message.source === undefined ? `${name}: the main agent's brief` : message.source.kind === "lore" ? `${name}: lore the main agent added` : undefined;
    slots.push({ role: message.role, text: message.content, ...(label !== undefined ? { label } : {}) });
  }
  return slots;
}

export class HostedTurns {
  /** The turns here that aren't over, by their generation. */
  private readonly running = new Map<string, Running>();
  /** Each chat's turn whose first half runs, by `user chat`: one works on a chat at a time. */
  private readonly working = new Map<string, Running>();
  /** The users seen since this worker started: what the worker before it left waiting is looked for once for each, and then on the tick. */
  private readonly seen = new Set<string>();
  /** The turns from before this worker that are being settled now, so none is settled twice. */
  private readonly settling = new Set<string>();

  constructor(
    private readonly host: Pick<BackendHost, "log" | "interceptorMs" | "granted" | "chats">,
    private readonly deps: HostedDeps,
  ) {}

  /**
   * The interceptor's part for a chat that runs built in (`Turns.hostedBy`). Never rejects: with
   * anything that goes wrong, the prompt goes back as it came and the live view says why.
   */
  async intercept(input: InterceptorInput, turn: Turn, omit: number[]): Promise<InterceptorVerdict> {
    const startedAt = this.deps.now();
    const begun = { live: false };
    this.recover(turn.userId);
    try {
      return await this.work(input, turn, omit, startedAt, begun);
    } catch (error) {
      const text = `${sentence(wordsOf(error))} Lumiverse sent the prompt as it was, so the reply is its own.`;
      this.host.log("warn", `[LumiAH] turn ${turn.turn.slice(0, 8)} couldn't be worked on here (${wordsOf(error)}), so Lumiverse wrote the reply on its own`);
      await this.gaveUp(turn, begun.live, { why: "failed", text }, wordsOf(error)).catch(() => undefined);
      return {};
    }
  }

  /** Says in the live view that LumiAH had no part in a turn's reply, for a turn whose core never said how it ended: the run is shown, and shown as over. `cause`: why, as a code, where no trace of the turn could tell it. */
  private async gaveUp(turn: Turn, begun: boolean, noPart: NoPart, reason: string, cause?: CauseCode): Promise<void> {
    const { live, now } = this.deps;
    if (!begun) await live.begin(turn.userId, BUILTIN, { stream: turn.chatId, chatId: turn.chatId, turn: turn.turn, kind: turn.kind, messageId: turn.target?.message ?? null, place: "builtin", replyBy: null });
    live.noPart(turn.userId, turn.turn, noPart, cause);
    live.finish(turn.userId, turn.turn, { state: noPart.why === "stopped" ? "stopped" : "failed", at: now(), reason });
  }

  /**
   * Another reply was asked for in a chat while a turn's first half still runs there. That turn is
   * told to stop, and its run is ended in the live view with why, before the new turn's takes its
   * place there: a page that follows the chat hears it. Lumiverse has usually let its generation
   * go; where it hasn't (a swipe written in the background), its reply is written from the prompt
   * as it came, with no record, as for a reply the user skipped. It is waited for a bounded time:
   * one that doesn't stop is let go, and the new reply is worked on all the same.
   */
  private async supersede(earlier: Running, waitMs: number): Promise<void> {
    const { live, builtin, name, later, now } = this.deps;
    const { userId, turn } = earlier.turn;
    earlier.cut = "next";
    earlier.noPart = { why: "stopped", text: `Another reply was asked for in this chat while this one's agents were still at work, so ${name} let this turn go. If Lumiverse writes this reply all the same, it writes it from the prompt as it was.` };
    live.noPart(userId, turn, earlier.noPart);
    earlier.stop.abort(new Error("Another reply was asked for in this chat."));
    const waited = Promise.withResolvers<"late">();
    const unwait = later(waitMs, () => waited.resolve("late"));
    const outcome = await Promise.race([earlier.prepared, waited.promise]);
    unwait();
    if (outcome === "late") this.letGo(earlier, "The turn didn't stop when another reply was asked for in its chat.");
    // What its core traced of its end goes first; one that traced none is ended here.
    await builtin.drained(userId);
    live.finish(userId, turn, { state: "stopped", at: now(), reason: "Another reply was asked for in this chat." });
  }

  /**
   * A turn whose first half doesn't return (it waits on something that never answers and can't be
   * told to stop) is abandoned: its signal is ended, its chat is free for the next reply, and
   * whatever it hands over later is given up at once.
   */
  private letGo(running: Running, reason: string): void {
    running.letGo = true;
    if (!running.stop.signal.aborted) running.stop.abort(new Error(reason));
    const key = `${running.turn.userId}\u0000${running.turn.chatId}`;
    if (this.working.get(key) === running) this.working.delete(key);
    this.over(running);
  }

  private async work(input: InterceptorInput, turn: Turn, omit: number[], startedAt: number, begun: { live: boolean }): Promise<InterceptorVerdict> {
    const { turns, chats, connections, settings, live, builtin, name, now, later } = this.deps;
    const { userId, chatId } = turn;
    const transport = await settings.transport(userId);
    // Lumiverse stops waiting at its own moment, where it says one, and after the time the manifest asks for in any case.
    const limit = Math.min(input.deadlineAt ?? Number.POSITIVE_INFINITY, startedAt + this.host.interceptorMs);
    const margin = transport.builtin.marginMs;
    const replyBy = limit - margin;

    // One turn works on a chat at a time: an earlier one still at work is another reply's.
    const key = `${userId}\u0000${chatId}`;
    const earlier = this.working.get(key);
    if (earlier !== undefined) await this.supersede(earlier, transport.runtime.turnWaitMs);

    const target = await turns.aim(turn);
    await live.begin(userId, BUILTIN, { stream: chatId, chatId, turn: turn.turn, kind: turn.kind, messageId: target.message, place: "builtin", replyBy });
    begun.live = true;
    if (replyBy <= now()) {
      const text = `Lumiverse waits ${Math.round((limit - startedAt) / 1000)} seconds for ${name} before a reply, which is no more than the margin ${name} keeps (${Math.round(margin / 1000)} seconds), so its agents had no time to work and Lumiverse sent the prompt as it was. ${name}'s own manifest asks Lumiverse for five minutes; where it has less, lower "Margin before Lumiverse's limit" in ${name}'s settings.`;
      await this.gaveUp(turn, true, { why: "time", text }, "There was no time to work before the reply.", "time");
      return {};
    }

    const left = new Set(omit);
    const places = input.messages.flatMap((_, i) => (left.has(i) ? [] : [i]));
    const came = places.flatMap((i): RequestMessage[] => {
      const m = input.messages[i];
      if (m === undefined) return [];
      const source: RequestMessage["source"] = m.history && m.sourceId !== undefined && m.sourceIndex !== undefined ? { kind: "history", messageId: m.sourceId, index: m.sourceIndex } : m.lore ? { kind: "lore" } : undefined;
      return [{ role: m.role, content: m.text, ...(source !== undefined ? { source } : {}) }];
    });
    const on = input.connectionId !== null ? { id: input.connectionId, loopback: false } : await connections.ofChat(userId, await chats.own(userId, chatId));
    const request: TurnRequest = {
      userId,
      chatId,
      generationId: turn.turn,
      kind: turn.kind,
      target: { messageId: target.message, swipeId: target.swipe },
      presetId: turn.presetId,
      messages: came,
      // The reply is Lumiverse's own generation: its sampling and its answer room are the chat's, and never pass through here.
      params: {},
      maxTokens: null,
      connectionId: on !== null && !on.loopback ? on.id : null,
    };
    // A continue adds to the swipe it writes on, shown or not: what that swipe holds now isn't the turn's reply.
    const before = turn.kind === "continue" && target.message !== null ? ((await this.host.chats.swipe(chatId, target.message, target.swipe)) ?? "") : "";

    const stop = new AbortController();
    const done = Promise.withResolvers<void>();
    const running: Running = { turn, target, startedAt, limit, stop, prepared: done.promise, pending: false, kept: null, halted: false, cut: null, letGo: false, before, noPart: null, done: false };
    this.running.set(turn.turn, running);
    this.working.set(key, running);
    // Lumiverse's own signal for this call ends when the generation is stopped, and when it stops waiting: which it was, the clock says.
    const gone = (): void => {
      const timedOut = now() >= limit - DEADLINE_SLACK_MS;
      if (timedOut) running.cut = "time";
      else running.halted = true;
      stop.abort(new Error(timedOut ? `Lumiverse stopped waiting for ${name}.` : "The reply was stopped in Lumiverse."));
    };
    if (input.signal?.aborted) gone();
    else input.signal?.addEventListener("abort", gone, { once: true });

    // The core hands over at `replyBy` by itself. Should it not have returned a little later still, the prompt goes back without it: Lumiverse must have its answer inside the margin.
    const last = Promise.withResolvers<"late">();
    const unlast = later(Math.max(0, limit - Math.floor(margin / 4) - now()), () => last.resolve("late"));
    const preparing = builtin.prepare(userId, request, replyBy, stop.signal);
    void preparing
      .then(async (prepared) => {
        running.pending = prepared.pending && !running.letGo;
        // Handed over after it was let go: nobody will complete it.
        if (prepared.pending && running.letGo) await builtin.abandon(userId, turn.turn, `${name} had let this turn go before its agents returned.`);
      })
      .catch(() => undefined)
      .finally(() => {
        input.signal?.removeEventListener("abort", gone);
        if (this.working.get(key) === running) this.working.delete(key);
        if (!running.pending) this.over(running);
        done.resolve();
      });
    const prepared = await Promise.race([preparing, last.promise]);
    unlast();

    if (prepared === "late") {
      running.cut = "time";
      running.noPart = { why: "time", text: `${name}'s agents weren't done when Lumiverse had to send the prompt, so Lumiverse sent it as it was. A turn that needs longer than Lumiverse waits can leave the rest to a job, or the chat can run in a runtime, which has no such limit.` };
      // It may wait on something that never answers: it is let go, so the chat's next reply is worked on and not held.
      this.letGo(running, `${name} ran out of the time Lumiverse gives it before a reply.`);
      await this.gaveUp(turn, true, running.noPart, "The turn ran out of the time Lumiverse gives it before a reply.", "time");
      return {};
    }
    if (prepared.part !== "none") {
      if (prepared.pending) this.keep(running);
      return { messages: slotsOf(came, places, prepared.messages, name) };
    }

    // Lumiverse stopped the generation: no reply follows, so there is none to say LumiAH had no part in.
    if (running.halted) return {};
    const reason = sentence(prepared.reason ?? "");
    const why: NoPartWhy = running.cut === "time" ? "time" : running.cut !== null ? "stopped" : now() >= replyBy ? "time" : "failed";
    const said = reason !== "" ? reason : why === "time" ? `${name}'s agents ran out of the time Lumiverse gives them before a reply.` : why === "stopped" ? `You skipped ${name} for this reply.` : `${name}'s agents didn't finish.`;
    const tail =
      why === "time"
        ? "Lumiverse sent the prompt as it was. A turn that needs longer can leave the rest to a job, or the chat can run in a runtime, which has no such limit."
        : why === "stopped"
          ? "Lumiverse wrote the reply from the prompt as it was. To stop a reply itself, use Lumiverse's own Stop."
          : "Lumiverse sent the prompt as it was, so the reply is its own.";
    // One let go for another reply was told why already (`supersede`).
    running.noPart ??= { why, text: `${said} ${tail}` };
    // What the turn's own trace can't tell is said with it: that its time ran out before its first half returned, and that the user skipped it.
    live.noPart(userId, turn.turn, running.noPart, why === "time" ? "time" : running.cut === "skipped" ? "skipped" : undefined);
    if (prepared.pending) this.keep(running);
    else {
      // The core says how such a turn ended in its trace; one it never began says nothing, and is ended here.
      await builtin.drained(userId);
      live.finish(userId, turn.turn, { state: why === "stopped" ? "stopped" : "failed", at: now(), ...(prepared.reason !== undefined ? { reason: prepared.reason } : {}) });
    }
    return {};
  }

  /** A turn's prompt was handed back and it waits for its reply: from now it is kept in the user's storage, so a restart of this worker doesn't lose it without a word. */
  private keep(running: Running): void {
    const { turn, target, before, noPart } = running;
    running.kept = this.deps.open
      .put(turn.userId, { turn: turn.turn, chatId: turn.chatId, place: "builtin", kind: turn.kind, target: { message: target.message, swipe: target.swipe }, at: this.deps.now(), ...(before !== "" ? { before } : {}), ...(noPart !== null ? { noPart } : {}) })
      .catch((error: unknown) => this.host.log("warn", `[LumiAH] turn ${turn.turn.slice(0, 8)} couldn't be kept across a restart (${wordsOf(error)})`));
  }

  /** A turn here is over (recorded, given up, or never begun): it is kept no longer, and the jobs that waited for its chat's reply may start. */
  private over(running: Running): void {
    if (running.done) return;
    running.done = true;
    const { userId, chatId, turn } = running.turn;
    if (this.running.get(turn) === running) this.running.delete(turn);
    // After its keeping, where that is still on its way: taken out first, it would be put back for good.
    void (running.kept ?? Promise.resolve()).then(() => this.deps.open.drop(userId, turn)).catch(() => undefined);
    this.deps.builtin.replied(userId, chatId);
  }

  /**
   * The text a generation wrote, for the turn's second half: Lumiverse's own word for it; else the
   * swipe the turn targeted, when the saved message is the one it targeted; else what the saved
   * message shows (a reply whose message was made as it was saved has one swipe). Never the swipe a
   * message of several happens to show: Lumiverse may write a reply on a swipe that isn't shown,
   * and the user may turn to another while one is written. A continue's is what was added.
   */
  private async wrote(chatId: string, kind: Turn["kind"], target: { message: string | null; swipe: number }, before: string, event: GenerationEnded & { messageId: string }): Promise<{ swipe: number; text: string }> {
    const own = event.messageId === target.message;
    let text = event.content;
    if (text === null && own) text = await this.host.chats.swipe(chatId, event.messageId, target.swipe).catch(() => null);
    const shown = own && text !== null ? null : await this.deps.chats.find(chatId, event.messageId);
    text ??= shown?.content ?? "";
    return { swipe: own ? target.swipe : (shown?.swipeId ?? 0), text: kind === "continue" && before !== "" && text.startsWith(before) ? text.slice(before.length) : text };
  }

  /**
   * Lumiverse said a generation ended. For a turn that waits here for its reply: the text the
   * generation wrote goes to the core's second half, and the record it leaves is written on the
   * reply's message. A generation that failed, or saved nothing, gives the turn up. One this worker
   * doesn't hold may be one the worker before it handed over.
   */
  ended(event: GenerationEnded): void {
    const failed = (error: unknown): void => this.host.log("error", `[LumiAH] turn ${event.generationId.slice(0, 8)}: it couldn't be recorded (${wordsOf(error)})`);
    const running = this.running.get(event.generationId);
    if (running !== undefined) void this.complete(running, event).catch(failed);
    else if (event.userId !== null) void this.late(event.userId, event).catch(failed);
  }

  private async complete(running: Running, event: GenerationEnded): Promise<void> {
    const { turns, builtin } = this.deps;
    const { turn, target } = running;
    const { userId, chatId } = turn;
    // The generation can't end before its interceptor answered; should the first half still be going, its end is waited for.
    await running.prepared;
    if (!running.pending) return;
    running.pending = false;
    try {
      if (event.error !== null || event.messageId === null) {
        await builtin.abandon(userId, turn.turn, event.error !== null ? `Lumiverse's generation failed (${event.error}), so there is no reply to record.` : "Lumiverse saved no reply, so there is none to record.");
        return;
      }
      const { text } = await this.wrote(chatId, turn.kind, target, running.before, { ...event, messageId: event.messageId });
      // Lumiverse doesn't say how its generation finished: a saved reply is taken as one that stopped by itself.
      const result = await builtin.complete(userId, { generationId: turn.turn, reply: text, finish: "stop" });
      if (result.record === null) return;
      // A record the core finished from storage (its turn had lapsed in memory) says so itself.
      const ran: JsonObject = { place: "builtin", ...(running.noPart !== null ? { noPart: { why: running.noPart.why, text: running.noPart.text } } : {}) };
      const anchoring = await turns.commit(userId, turn.turn, chatId, { message: target.message, swipe: target.swipe }, result.record, ran);
      if (anchoring === "never" && this.host.granted("chat_mutation")) this.host.log("warn", `[LumiAH] turn ${turn.turn.slice(0, 8)}: its record wasn't written (the reply's message is gone)`);
    } finally {
      this.over(running);
    }
  }

  // ---------------------------------------------------------------- what the worker before this one left waiting

  /**
   * A user is here after this worker started. The built-in turns that waited for their replies
   * when the worker before it stopped are looked at, once for each user now and then on the tick.
   */
  recover(userId: string): void {
    if (this.seen.has(userId)) return;
    this.seen.add(userId);
    void this.leftBy(userId).catch((error: unknown) => this.host.log("warn", `[LumiAH] what the last restart left waiting couldn't be looked at (${wordsOf(error)})`));
  }

  private async leftBy(userId: string): Promise<void> {
    for (const kept of await this.deps.open.list(userId)) if (kept.place === "builtin" && !this.running.has(kept.turn)) await this.settle(userId, kept, null);
  }

  /** A generation this worker holds no turn for ended: where it is one the worker before this one handed over, it is settled now, by what Lumiverse says of it. */
  private async late(userId: string, event: GenerationEnded): Promise<void> {
    const kept = await this.deps.open.get(userId, event.generationId);
    if (kept !== null && kept.place === "builtin") await this.settle(userId, kept, event);
  }

  /** The reply a turn from before this worker was written, as the chat shows it now; null when the chat shows none. */
  private async savedIn(kept: OpenTurn): Promise<{ message: string; swipe: number; text: string } | null> {
    const { message, swipe } = kept.target;
    if (message !== null) {
      const text = await this.host.chats.swipe(kept.chatId, message, swipe).catch(() => null);
      // A swipe that holds what it held before a continue began has had nothing written.
      if (text === null || text === "" || (kept.kind === "continue" && text === (kept.before ?? ""))) return null;
      return { message, swipe, text: kept.kind === "continue" && kept.before !== undefined && text.startsWith(kept.before) ? text.slice(kept.before.length) : text };
    }
    // A new reply whose message Lumiverse makes as it saves it: the chat's last message, when it is a reply made since the hand-over that bears no record yet.
    const last = await this.deps.chats.last(kept.chatId);
    if (last === null || last.role !== "assistant" || last.content === "" || last.own !== null || (last.at !== null && last.at < kept.at)) return null;
    return { message: last.id, swipe: last.swipeId, text: last.content };
  }

  /**
   * A built-in turn nobody holds in memory (this worker started after its prompt was handed back):
   * where Lumiverse saved its reply, it still gets its record, marked as written after the fact;
   * where no reply came, it is let go. Either way it is said where the user follows the chat, and
   * nothing is lost without a word.
   */
  private async settle(userId: string, kept: OpenTurn, event: GenerationEnded | null): Promise<void> {
    if (this.settling.has(kept.turn)) return;
    this.settling.add(kept.turn);
    const { chats, turns, builtin, open, settings, now, name } = this.deps;
    try {
      await chats.own(userId, kept.chatId);
      let reply: { message: string; swipe: number; text: string } | null;
      if (event === null) reply = await this.savedIn(kept);
      else if (event.error !== null || event.messageId === null) reply = null;
      else {
        const wrote = await this.wrote(kept.chatId, kept.kind, kept.target, kept.before ?? "", { ...event, messageId: event.messageId });
        reply = wrote.text === "" ? null : { message: event.messageId, ...wrote };
      }
      if (reply === null) {
        // No reply yet. Where only this worker was restarted, the generation may still be writing: it is waited for as long as a record waits for its reply.
        if (event === null && now() - kept.at <= (await settings.transport(userId)).anchors.waitMs + this.host.interceptorMs) return;
        await builtin.abandon(userId, kept.turn, "No reply came for this turn.");
        await open.drop(userId, kept.turn);
        await this.say(userId, kept, `${name} was restarted while this reply was being written, and no reply was saved for it, so what its agents had worked out for it was let go.`);
        return;
      }
      // Its record was written before the worker stopped, and only the keeping was left.
      if (await chats.recorded(kept.chatId, reply.message, reply.swipe, kept.turn)) {
        await open.drop(userId, kept.turn);
        return;
      }
      const result = await builtin.complete(userId, { generationId: kept.turn, reply: reply.text, finish: "stop" });
      if (result.record === null) {
        await open.drop(userId, kept.turn);
        await this.say(userId, kept, `${name} was restarted while this reply was being written. The reply stands, and what its agents had worked out for it couldn't be recorded${result.reason !== undefined ? ` (${result.reason})` : ""}.`);
        return;
      }
      // The record says itself that it was written after the fact (`TurnRecord.recovered`), which the Sessions page shows.
      const ran: JsonObject = { place: "builtin", ...(kept.noPart !== undefined ? { noPart: { why: kept.noPart.why, text: kept.noPart.text } } : {}) };
      const anchoring = await turns.commit(userId, kept.turn, kept.chatId, { message: reply.message, swipe: reply.swipe }, result.record, ran);
      if (anchoring === "never") await this.say(userId, kept, `${name} was restarted while this reply was being written, and its record couldn't be written on the reply afterwards.`);
    } catch (error) {
      // The chat is gone, or the core no longer holds the turn: it is owed nothing more, and what happened is said.
      await open.drop(userId, kept.turn).catch(() => undefined);
      await this.say(userId, kept, `${name} was restarted while this reply was being written. The reply stands, and what its agents had worked out for it couldn't be recorded (${wordsOf(error)}).`).catch(() => undefined);
    } finally {
      this.settling.delete(kept.turn);
    }
  }

  /** What became of a turn this worker never held is said where the user follows the chat: as the chat's live run, where no newer run stands there. */
  private async say(userId: string, kept: OpenTurn, reason: string): Promise<void> {
    const { live, now } = this.deps;
    this.host.log("warn", `[LumiAH] turn ${kept.turn.slice(0, 8)}: ${reason}`);
    if (live.whole(userId, kept.chatId) !== null) return;
    await live.begin(userId, BUILTIN, { stream: kept.chatId, chatId: kept.chatId, turn: kept.turn, kind: kept.kind, messageId: kept.target.message, place: "builtin", replyBy: null });
    live.finish(userId, kept.turn, { state: "lost", at: now(), reason });
  }

  // ---------------------------------------------------------------- stops, and the tick

  /**
   * Lumiverse stopped a turn's generation (`Turns.onStopped`): a first half under way ends with it,
   * and a turn that waited for its reply is given up, since Lumiverse keeps no finished reply of a
   * stopped generation.
   */
  stopped(turn: Turn, why: string): void {
    const running = this.running.get(turn.turn);
    if (running === undefined) return;
    running.halted = true;
    if (!running.pending) {
      running.stop.abort(new Error(why));
      return;
    }
    running.pending = false;
    void this.deps.builtin.abandon(turn.userId, turn.turn, why).finally(() => this.over(running));
  }

  /**
   * "Skip LumiAH for this reply" on a page, for a turn here (`lah.turn.stop`). While its first half
   * runs, that ends LumiAH's work: Lumiverse then writes the reply on its own, since an extension
   * can't stop Lumiverse's generation. False once the main agent has handed over: what runs then is
   * Lumiverse's own generation, which its own Stop ends.
   */
  stopFromLive(userId: string, turnId: string): boolean {
    const running = this.running.get(turnId);
    if (running === undefined || running.turn.userId !== userId || running.pending || running.stop.signal.aborted) return false;
    running.cut = "skipped";
    running.stop.abort(new Error(`You skipped ${this.deps.name} for this reply.`));
    return true;
  }

  /** Every so often: a turn whose generation never said it ended is given up once the time a record waits for its reply has passed, and what the worker before this one left waiting is looked at again. */
  async tick(): Promise<void> {
    const { settings, builtin, now } = this.deps;
    for (const running of [...this.running.values()]) {
      if (!running.pending) continue;
      const waitMs = (await settings.transport(running.turn.userId)).anchors.waitMs;
      if (now() - running.startedAt <= waitMs + this.host.interceptorMs) continue;
      running.pending = false;
      void builtin.abandon(running.turn.userId, running.turn.turn, "Lumiverse never said how this reply's generation ended.").finally(() => this.over(running));
    }
    for (const userId of this.seen) await this.leftBy(userId).catch(() => undefined);
  }
}
