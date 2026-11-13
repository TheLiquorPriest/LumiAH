// A turn (DESIGN §2 steps 4 to 8): a tagged request's tag is checked with the extension, which
// answers with the turn (the user, the chat, the generation and its kind, the message it targets);
// the core's harness answers it, its progress and its reply streaming into the request's answer;
// and the record the turn leaves is handed to the extension, which anchors it on the reply's message
// once Lumiverse has saved it.
//
// One turn runs per chat at a time: a new one for a chat whose earlier turn hasn't ended stops that
// one first and waits for it, since Lumiverse has already let its generation go. An earlier turn
// that still hasn't ended after `turnWaitMs` is let go: taken off its chat, its answer ended, and
// whatever it does from then on ignored, so a stuck turn never costs its chat the next reply. A
// turn stops when Lumiverse closes its request (Stop), when the extension says so (Stop in the live
// view, or Lumiverse's own stop heard there), or when the runtime shuts down; the core hears each
// as its signal, and its model calls under way are cancelled with it.
//
// A reply may come in several pieces: the agents release it once, whole, and a sub-agent's answer
// handed on as the reply goes out as it is generated. Each piece goes out as it comes, in the order
// the core handed it, as the one completion Lumiverse reads; the agents' progress lines go to the
// reply's thinking block before, between and after them. Once the turn's signal has ended, nothing
// more goes out but its end: the core counts as released only what it handed before then, so what
// a stopped turn tells the extension it released is what the user saw.
//
// A reply the user stopped never ends as an error, which Lumiverse would show as a failed
// generation. Lumiverse knows of its own Stop and has closed the request. It doesn't know of a stop
// from the live view, so the runtime asks it to stop the generation as its own Stop does; where that
// can't be done, the reply ends as a finished one with whatever it had written.

import { AsyncLocalStorage } from "node:async_hooks";
import type { AgentUsage, JsonObject, ReplySink, TraceRecord, TurnRequest, TurnResult } from "../core/ports";
import type { StopBy, StopPush, TurnFacts } from "../link/contract";
import type { RuntimeTuning } from "../link/settings";
import type { WorkHarness } from "../link/work";
import type { RuntimeLink } from "./link";
import { LOST_WAIT, refusedReply } from "./link";
import { LiveError } from "./lumiverse";
import { maxTokensOf, modelMessages, samplingOf, withSources } from "./openai";
import type { TaggedRequest, TurnRunner } from "./relay";
import type { Answer, ReplyPiece } from "./sse";
import type { RuntimeSettings } from "./settings";
import { problemOf } from "./streams";
import type { TraceSink } from "./trace";

/**
 * The core's harness (`createHarness(host, …)`). `answer` answers a turn: it never rejects, and ends
 * the sink with one `done` or one `error`. The rest is what the work runner reaches of it
 * (`WorkHarness`: jobs, side sessions, the user's words to a run), and its page-facing methods
 * (`workspace.list`, `jobs.start`, …), which are reached by name.
 */
export interface Harness extends WorkHarness {
  answer(turn: TurnRequest, sink: ReplySink, signal: AbortSignal): Promise<TurnResult>;
}

export interface TurnsEnv {
  now(): number;
  log(text: string): void;
  tuning(): RuntimeTuning;
  /** The writer's connection, from the settings' values (the core's section names it); null: the user's default. */
  writerConnection(values: JsonObject): string | null;
  /** A reply turn of a chat has returned, however it ended: the jobs that waited for the reply may start. */
  replied(chatId: string): void;
  /** Asks Lumiverse to stop a generation as its own Stop does; false when it had none such running. Rejects when it can't be asked (no session, Lumiverse out of reach). */
  stopGeneration(generation: string, chat: string): Promise<boolean>;
  /** Resolves once the extension's storage holds everything the runtime saved before the call (its working store's `settle`); rejects in words that say why it doesn't. */
  settle(): Promise<void>;
  /** A reply's turn begins on a chat (the extension answered its `turn.begin`): the runtime's copy checks the chat before the turn's first read of it. */
  began?(chatId: string): void;
  /** The extension wrote the turn's record on a message now (`turn.commit` answered `now`), on that swipe: the runtime's copy of the chat waits for Lumiverse's word of that write, unless it holds the record already. `messageId` null: the reply's own message, which the turn didn't know. */
  committed?(chatId: string, messageId: string | null, swipe: number, record: NonNullable<TurnResult["record"]>): void;
}

/** The user stopped the turn: its words say where, and are what the turn's end says. `by` is null for an extension from before it said where. */
export class UserStop extends Error {
  constructor(
    message: string,
    readonly by: StopBy | null,
  ) {
    super(message);
  }
}

interface Running {
  turn: string;
  chat: string;
  stop: AbortController;
  /** Resolves once the turn has let go of everything: the next turn of its chat may start. */
  done: Promise<void>;
  /** Lumiverse being asked to stop the turn's generation (Stop in the live view); settles once it answered or wasn't heard in time. Null when it wasn't asked. */
  asked: Promise<void> | null;
  /** Where the turn's reply goes. */
  answer: Answer;
  /** The chat's next reply stopped waiting for this turn to end: it is no turn of the chat's any more, and nothing it does from then on counts. */
  letGo: boolean;
}

/** The turn's usage as an OpenAI completion says usage, with the turn's id and the harness's own counts beside it: Lumiverse keeps the whole object with the reply. */
export function usageJson(usage: AgentUsage, turn: string): JsonObject {
  return {
    prompt_tokens: usage.in,
    completion_tokens: usage.out,
    total_tokens: usage.in + usage.out,
    prompt_tokens_details: { cached_tokens: usage.cachedIn },
    completion_tokens_details: { reasoning_tokens: usage.reasoningOut },
    lumiah_turn: turn,
    lumiah: { calls: usage.calls, tool_turns: usage.toolTurns, ms: usage.ms, estimated: usage.estimated, ...(usage.cost !== undefined ? { cost: usage.cost } : {}) },
  };
}

export class Turns implements TurnRunner {
  private readonly byTurn = new Map<string, Running>();
  private readonly byChat = new Map<string, Running>();
  /** The turn the code now running works for, and its chat: a model call names the turn, so the extension can end the call when Lumiverse stops it. */
  private readonly scope = new AsyncLocalStorage<{ turn: string; chat: string }>();

  constructor(
    private readonly link: RuntimeLink,
    private readonly harness: Harness,
    private readonly settings: RuntimeSettings,
    private readonly trace: TraceSink,
    private readonly env: TurnsEnv,
  ) {}

  /** The turns under way. */
  get count(): number {
    return this.byTurn.size;
  }

  ids(): string[] {
    return [...this.byTurn.keys()];
  }

  /** The turn the caller works for; null outside one. */
  readonly current = (): string | null => this.scope.getStore()?.turn ?? null;

  /** The chat of the turn the caller works for; null outside one. */
  readonly currentChat = (): string | null => this.scope.getStore()?.chat || null;

  /** Runs `fn` as the work of a run that is no reply (a job's, a side session's turn), so its model calls name it too. `chat` is `""` where it has none. */
  within<T>(run: { turn: string; chat: string }, fn: () => Promise<T>): Promise<T> {
    return this.scope.run(run, fn);
  }

  async writerConnection(): Promise<string | null> {
    return this.env.writerConnection((await this.settings.get()).values);
  }

  /** The extension says a turn is to stop: the user pressed Stop. */
  stop(push: StopPush): void {
    const running = this.byTurn.get(push.turn);
    if (running === undefined || running.stop.signal.aborted) return;
    // The turn's signal first, so its end says the live view stopped it and not Lumiverse, whose closing of the request follows. The turn can't have ended the reply before `asked` is set: it only goes on from its signal a tick later.
    running.stop.abort(new UserStop(push.why, push.by ?? null));
    if (push.by === "live") running.asked = this.askLumiverse(running);
  }

  /**
   * The core's event as the live view gets it: the end of a turn the user stopped says where they
   * stopped it. The core is handed those words as its signal's reason and says only that the turn
   * was stopped, so they are put on the event here.
   */
  traced(record: TraceRecord): TraceRecord {
    if (record.event.kind !== "turn_ended" || record.event.status !== "stopped") return record;
    const reason: unknown = this.byTurn.get(record.turn)?.stop.signal.reason;
    return reason instanceof UserStop ? { ...record, event: { ...record.event, reason: reason.message } } : record;
  }

  /** Asks Lumiverse to stop a turn's generation. Never rejects: what kept Lumiverse from stopping it is logged, and the turn then ends the reply itself. */
  private async askLumiverse(running: Running): Promise<void> {
    const asking = this.env.stopGeneration(running.turn, running.chat).then(
      (stopped) => (stopped ? null : "Lumiverse had no such generation running"),
      // Lumiverse's own words for it: `problemOf` reads a failed call to Lumiverse as the link's.
      (error: unknown) => (error instanceof Error ? error.message : String(error)),
    );
    const { promise: late, resolve } = Promise.withResolvers<string>();
    const timer = setTimeout(() => resolve("Lumiverse didn't answer in time"), this.env.tuning().stopAskMs);
    const kept = await Promise.race([asking, late]);
    clearTimeout(timer);
    if (kept !== null) this.env.log(`turn ${running.turn.slice(0, 8)}: Lumiverse wasn't made to stop the reply (${kept}), so the runtime ended it as a finished one`);
  }

  /** The runtime is stopping: every turn ends. */
  shutdown(): void {
    for (const running of this.byTurn.values()) running.stop.abort(new Error("The runtime is restarting."));
  }

  async run(request: TaggedRequest): Promise<void> {
    const { answer } = request;
    let facts: TurnFacts;
    try {
      facts = await this.begin(request);
      this.env.began?.(facts.chat);
    } catch (error) {
      // A link refused while the tag was checked is said as a request that found it refused is (relay.ts).
      const refused = refusedReply(this.link);
      const p = refused !== null ? { message: refused, code: "revoked" } : problemOf(error, this.link.backendName);
      answer.fail(p.message, p.code === "forbidden" ? "invalid_api_key" : p.code, this.env.now());
      return;
    }
    const stop = new AbortController();
    // Lumiverse closes a reply's request when the user stops it there.
    const closed = (): void => stop.abort(new UserStop(request.signal.reason instanceof Error ? request.signal.reason.message : "The reply was stopped in Lumiverse.", "lumiverse"));
    if (request.signal.aborted) closed();
    else request.signal.addEventListener("abort", closed, { once: true });
    const finished = Promise.withResolvers<void>();
    const running: Running = { turn: facts.turn, chat: facts.chat, stop, done: finished.promise, asked: null, answer, letGo: false };
    const stoppedByUser = (): boolean => stop.signal.reason instanceof UserStop;
    let last: ReplyPiece | null = null;
    try {
      await this.takeChat(running);
      this.settings.note(facts.settings);
      const turn: TurnRequest = {
        userId: facts.user,
        chatId: facts.chat,
        generationId: facts.generation,
        kind: facts.kind,
        target: { messageId: facts.target.message, swipeId: facts.target.swipe },
        presetId: facts.preset,
        messages: withSources(modelMessages(request.body.messages), facts.sources),
        params: samplingOf(request.body),
        maxTokens: maxTokensOf(request.body),
      };
      /** A piece of the reply, as the core hands it: out at once, unless the turn was stopped meanwhile. */
      const out = (piece: ReplyPiece): void => {
        if (!stop.signal.aborted) answer.piece(piece, this.env.now());
      };
      const sink: ReplySink = {
        progress: (text) => out({ kind: "progress", text }),
        reasoning: (text) => out({ kind: "reasoning", text }),
        content: (text) => out({ kind: "content", text }),
        // The end of a reply the user stopped is written once the turn is over (below).
        done: (finish, usage) => {
          const piece: ReplyPiece = { kind: "finish", finish: finish === "" ? "stop" : finish, usage: usageJson(usage, facts.turn) };
          if (stoppedByUser()) last = piece;
          else answer.piece(piece, this.env.now());
        },
        // Any other stop (the runtime restarting, another reply asked for in the chat) ends with its own words, which say more than the core's.
        error: (message, code) => {
          if (!stoppedByUser()) answer.fail(stop.signal.aborted && stop.signal.reason instanceof Error ? stop.signal.reason.message : message, code ?? "turn_failed", this.env.now());
        },
      };
      const result = await this.scope.run({ turn: facts.turn, chat: facts.chat }, () => this.harness.answer(turn, sink, stop.signal));
      // Let go meanwhile: its answer ended then, and what it came to is no turn of the chat's.
      if (running.letGo) return;
      if (!answer.ended && stoppedByUser()) {
        // Lumiverse, asked, closes the request itself; where it didn't, the reply ends as a finished one.
        await running.asked;
        if (!answer.ended) answer.piece(last ?? { kind: "finish", finish: "stop" }, this.env.now());
      }
      if (!answer.ended) answer.fail(result.reason ?? "The turn ended without a reply.", "turn_failed", this.env.now());
      if (result.record !== null) await this.commit(facts, result.record);
      else if (result.status !== "done") this.env.log(`turn ${facts.turn.slice(0, 8)} ${result.status}${result.reason !== undefined ? `: ${result.reason}` : ""}`);
    } catch (error) {
      // The harness never rejects; whatever did is the runtime's own failure, said in the chat.
      const p = problemOf(error, this.link.backendName);
      this.env.log(`turn ${facts.turn.slice(0, 8)} failed: ${p.message}`);
      answer.fail(`${this.link.backendName ?? "LumiAH"}'s turn failed: ${p.message}`, p.code, this.env.now());
    } finally {
      request.signal.removeEventListener("abort", closed);
      // The live view hears the turn's end before the turn lets go of its chat.
      await this.trace.drained().catch(() => undefined);
      this.trace.forget(facts.turn);
      if (this.byTurn.get(facts.turn) === running) this.byTurn.delete(facts.turn);
      if (this.byChat.get(facts.chat) === running) this.byChat.delete(facts.chat);
      finished.resolve();
      // The jobs that wait for the chat's reply wait for the one that took its place.
      if (!running.letGo) this.env.replied(facts.chat);
    }
  }

  /** The tag checked and spent (DESIGN §2 step 4). Asked again after a socket that closed under it: the extension answers a request it already took as before. While the link is down it waits as long as Extension lost after says, which its words name when it runs out. */
  private async begin(request: TaggedRequest): Promise<TurnFacts> {
    const first = this.env.now();
    for (;;) {
      const wait = this.env.tuning().lostMs;
      try {
        return await this.link.request("turn.begin", { key: request.key, tag: request.tag, request: request.request }, wait, LOST_WAIT);
      } catch (error) {
        if (error instanceof LiveError && error.problem === "closed" && !request.signal.aborted && this.env.now() - first < wait) continue;
        throw error;
      }
    }
  }

  /** Makes `running` its chat's one turn: the chat's earlier turn is stopped and waited for, and let go when it doesn't end in time. */
  private async takeChat(running: Running): Promise<void> {
    // Again after each wait: another turn of the chat may have got in first meanwhile.
    for (let earlier = this.byChat.get(running.chat); earlier !== undefined; earlier = this.byChat.get(running.chat)) {
      earlier.stop.abort(new Error("Another reply was asked for in this chat."));
      const waitMs = this.env.tuning().turnWaitMs;
      const { promise: late, resolve } = Promise.withResolvers<"late">();
      const timer = setTimeout(() => resolve("late"), waitMs);
      const outcome = await Promise.race([earlier.done.then(() => "ended" as const), late]);
      clearTimeout(timer);
      if (outcome === "late" && this.byChat.get(running.chat) === earlier) this.letGo(earlier, waitMs);
    }
    this.byChat.set(running.chat, running);
    this.byTurn.set(running.turn, running);
  }

  /**
   * A turn that didn't end within the time its chat's next reply waited for it, though its signal
   * said to: it is taken off its chat, its answer ends here in words that say so, and the trace it
   * still writes is dropped. What it comes to, if it ever returns, is left (`run`).
   */
  private letGo(running: Running, waitedMs: number): void {
    running.letGo = true;
    this.byChat.delete(running.chat);
    this.byTurn.delete(running.turn);
    const seconds = Math.round(waitedMs / 1000);
    const waited = seconds === 1 ? "a second" : `${seconds} seconds`;
    this.trace.give(running.turn, `it hadn't stopped ${waited} after its chat's next reply was asked for, and was let go`);
    running.answer.fail(`LumiAH let this reply go: another reply was asked for in its chat, and this one hadn't stopped ${waited} later.`, "conflict", this.env.now());
    this.env.log(`turn ${running.turn.slice(0, 8)} hadn't stopped ${waited} after its chat's next reply was asked for: it was let go, so the next reply could start`);
  }

  /**
   * Hands the turn's record to the extension (DESIGN §2 step 8), once the extension's storage holds
   * what the turn saved: the record names its blobs, and whoever reads it there must find them. When
   * the storage doesn't take them in time, the record goes all the same: the runtime's own copy holds
   * them, and they follow as soon as the storage can be reached.
   */
  private async commit(facts: TurnFacts, record: NonNullable<TurnResult["record"]>): Promise<void> {
    const { turn } = facts;
    await this.env.settle().catch((error: unknown) => this.env.log(`turn ${turn.slice(0, 8)}: ${error instanceof Error ? error.message : String(error)}`));
    const first = this.env.now();
    for (;;) {
      const wait = this.env.tuning().lostMs;
      try {
        const { anchoring } = await this.link.request("turn.commit", { turn, chat: facts.chat, target: facts.target, record }, wait, LOST_WAIT);
        if (anchoring === "now") this.env.committed?.(facts.chat, facts.target.message, facts.target.swipe, record);
        if (anchoring === "never") this.env.log(`turn ${turn.slice(0, 8)}: its record wasn't anchored (the reply's message is gone)`);
        return;
      } catch (error) {
        if (error instanceof LiveError && error.problem === "closed" && this.env.now() - first < wait) continue;
        this.env.log(`turn ${turn.slice(0, 8)}: its record wasn't handed to LumiAH, so the session won't carry this turn (${problemOf(error).message})`);
        return;
      }
    }
  }
}
