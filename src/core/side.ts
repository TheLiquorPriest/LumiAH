// Side sessions (DESIGN §19): a conversation with an agent that is not a reply in a chat. The page's
// own chat with the main agent, or with any agent the user picks, about a chat or about nothing in
// particular. It has the same tools, workspace, guidance and live view as a turn; it is kept in the
// store and anchored to no message; and it never writes to a chat's messages: there is no writer,
// and the agent's answer is what the user reads.
//
// A side session about a chat reads that chat as it stands now, and writes the chat's own area where
// the latest turn on its path left it. One about no chat has the user's own area alone.

import { summaryOf } from "./compaction";
import { cutShort } from "./loop";
import { DOC } from "./paths";
import type { AgentUsage, JsonObject, ModelMessage, ReplySink, TurnStatus } from "./ports";
import { isRecord } from "./ports";
import { HarnessRefusal } from "./refusal";
import { agentsMissing, claimMissing, type Equipment, readSetup, Run, type Setup, type Shared } from "./run";
import { AGENT } from "./settings";
import type { SideDoc, SideRow, SidesDoc, SideTurnDoc } from "./stored";
import { TEXT } from "./texts";
import type { PastTurn } from "./tools";
import { emptyUsage } from "./usage";
import { clip, errorText, limitOf, stopWords, tokensOf } from "./util";
import { chatView, loreView } from "./views";

/** A turn of a side session as the page reads it: what the user said and what the agent answered, whole. */
export interface SideTurnView extends Omit<SideTurnDoc, "asked" | "answered"> {
  asked: string;
  answered: string | null;
}

/** How a turn of a side session ended: as a chat's turn does, with the turn as it was kept. */
export interface SideResult {
  status: TurnStatus;
  reason?: string;
  reply: string;
  usage: AgentUsage;
  turn: SideTurnDoc | null;
}

const rowOf = (doc: SideDoc): SideRow => ({ id: doc.id, chatId: doc.chatId, agent: doc.agent, title: doc.title, createdAt: doc.createdAt, lastAt: doc.lastAt, turns: doc.turns.length });

export class Sides {
  /** The list of side sessions has one writer at a time. */
  private writes: Promise<unknown> = Promise.resolve();
  /** The side sessions with a turn under way: a session takes one turn at a time. */
  private readonly busy = new Set<string>();
  /** The side sessions being removed: one takes no turn any more, so no turn that ends later writes it back. */
  private readonly removing = new Set<string>();

  constructor(private readonly shared: () => Shared) {}

  private async doc(id: string): Promise<SideDoc> {
    const raw = await this.shared().host.store.read(DOC.side(id));
    if (!(isRecord(raw) && raw.v === 1 && raw.kind === "side" && Array.isArray(raw.turns))) throw new HarnessRefusal("not_found", "That side session is gone.");
    return raw as unknown as SideDoc;
  }

  private async rows(): Promise<SideRow[]> {
    const raw = await this.shared().host.store.read(DOC.sides);
    return isRecord(raw) && raw.kind === "sides" && Array.isArray(raw.sides) ? (raw.sides as unknown as SideRow[]) : [];
  }

  /** Writes a side session, or (null) removes it, and its row in the list. */
  private put(id: string, doc: SideDoc | null): Promise<void> {
    const done = this.writes.then(async () => {
      const { store } = this.shared().host;
      if (doc) await store.write(DOC.side(id), doc as unknown as JsonObject);
      else await store.remove(DOC.side(id));
      const rows = (await this.rows()).filter((row) => row.id !== id);
      const list: SidesDoc = { v: 1, kind: "sides", sides: doc ? [...rows, rowOf(doc)] : rows };
      await store.write(DOC.sides, list as unknown as JsonObject);
    });
    this.writes = done.catch(() => undefined);
    return done;
  }

  /** The side sessions, the latest used first: all of them, those about one chat, or (null) those about no chat. */
  async list(input: { chatId?: string | null }): Promise<{ sides: SideRow[] }> {
    const about = input.chatId === undefined ? null : (input.chatId ?? "");
    return { sides: (await this.rows()).filter((row) => about === null || row.chatId === about).sort((a, b) => b.lastAt - a.lastAt) };
  }

  /** Starts a side session with an agent (the main agent unless one is named), about a chat or (null) about none. */
  async start(input: { chatId: string | null; agent?: string }): Promise<{ side: SideRow }> {
    const shared = this.shared();
    const chatId = input.chatId ?? "";
    const setup = await readSetup(shared, chatId);
    const agent = input.agent ?? AGENT.main;
    // The writer's prompt is a chat's preset: outside a turn it has nothing to say.
    if (agent === AGENT.writer) throw new HarnessRefusal("not_found", `There is no agent "${agent}" to talk to: it may have been removed or switched off.`);
    if (!setup.definitions.agent(agent)) {
      // Missing because the extension's agents are, it may be there in a moment: the refusal says why.
      const missing = setup.unanswered.definitions;
      if (missing !== undefined && !setup.definitions.switchedOff(agent)) throw new HarnessRefusal("unavailable", `There is no agent "${agent}" to talk to now. ${agentsMissing(missing, setup.texts, shared.options)}.`);
      throw new HarnessRefusal("not_found", `There is no agent "${agent}" to talk to: it may have been removed or switched off.`);
    }
    const now = shared.host.clock.now();
    // Eight hex digits of a random id, as an agent's: a name, not a limit.
    const doc: SideDoc = { v: 1, kind: "side", id: `side_${crypto.randomUUID().slice(0, 8)}`, chatId, agent, title: "", createdAt: now, lastAt: now, turns: [] };
    await this.put(doc.id, doc);
    return { side: rowOf(doc) };
  }

  /** A side session's turns, oldest first, each with what was said and answered. */
  async turns(input: { id: string }): Promise<{ side: SideRow; turns: SideTurnView[] }> {
    const doc = await this.doc(input.id);
    const { blobs } = this.shared();
    const turns = await Promise.all(doc.turns.map(async (turn): Promise<SideTurnView> => ({ ...turn, asked: (await blobs.get(turn.asked)) ?? "", answered: turn.answered === null ? null : await blobs.get(turn.answered) })));
    return { side: rowOf(doc), turns };
  }

  async remove(input: { id: string }): Promise<{ removed: true }> {
    if (this.busy.has(input.id)) throw new HarnessRefusal("conflict", "That side session is answering: stop it first, then remove it.");
    if (this.removing.has(input.id)) throw new HarnessRefusal("not_found", "That side session is gone.");
    // Marked before anything is awaited, as a turn takes its place: a message sent back to back with this finds the session gone.
    this.removing.add(input.id);
    try {
      await this.doc(input.id);
      await this.put(input.id, null);
      return { removed: true };
    } finally {
      this.removing.delete(input.id);
    }
  }

  /**
   * One turn of a side session: the agent is sent what the user said and answers it. Its answer
   * goes to `sink` whole, which gets exactly one `done` or one `error`; `signal` stops the turn.
   * Rejects (a `HarnessRefusal`) only before anything is done: there is no such session, or it is
   * answering already. After that it never rejects: how the turn ended is in what it returns.
   */
  async turn(input: { session: string; generationId: string; text: string }, sink: ReplySink, signal: AbortSignal): Promise<SideResult> {
    const shared = this.shared();
    const { host } = shared;
    if (typeof input.text !== "string" || input.text.trim() === "") throw new HarnessRefusal("bad_request", "Say something first.");
    if (this.removing.has(input.session)) throw new HarnessRefusal("not_found", "That side session is gone.");
    if (this.busy.has(input.session)) throw new HarnessRefusal("conflict", "That side session is still answering your last message.");
    // The place is taken before anything is awaited: two calls made back to back must not both pass.
    this.busy.add(input.session);
    const doc = await this.doc(input.session).catch((error: unknown) => {
      this.busy.delete(input.session);
      throw error;
    });
    const startedAt = host.clock.now();
    try {
      let setup: Setup;
      try {
        setup = await readSetup(shared, doc.chatId);
      } catch (error) {
        // As a chat's turn says it: never on the defaults, which would call models the user didn't choose.
        const reason = `LumiAH couldn't read its settings (${errorText(error)}), so this wasn't answered. Check that the runtime is linked to the extension, then try again.`;
        sink.error(reason, "failed");
        return { status: "failed", reason, reply: "", usage: emptyUsage(), turn: null };
      }
      const { settings, texts } = setup;
      const run = new Run(shared, setup, { info: { id: input.generationId, kind: "side", chatId: doc.chatId }, budget: settings.turn, startedAt, messageId: null, side: doc.id });
      let status: TurnStatus = "failed";
      let reason: string | undefined;
      let reply = "";
      let finish = "stop";
      try {
        // A chat whose extension never said whether it answers it itself isn't talked about as one of LumiAH's own.
        if (setup.unanswered.claim !== undefined) throw new Error(claimMissing(setup.unanswered.claim, texts, shared.options));
        const resolved = run.resolve(doc.agent);
        if (!resolved) {
          const missing = setup.unanswered.definitions;
          throw new Error(missing !== undefined && !setup.definitions.switchedOff(doc.agent) ? agentsMissing(missing, texts, shared.options) : `the agent "${doc.agent}" this session is with is gone or switched off`);
        }
        await run.equip(await this.equipment(doc.chatId, shared, setup));
        const carried = await this.history(doc, run, signal);
        const about = doc.chatId === "" ? texts.render(TEXT.side.aboutNothing) : texts.render(TEXT.side.aboutChat, { chat: run.chat?.name ?? doc.chatId });
        const { agent, lead } = await run.agent(resolved, { depth: 0, history: carried.messages, notes: true, main: true, about: texts.render(TEXT.side.about, { about }) });
        // The files pinned for it lead what it is sent, then the summary where no earlier turn carries it, then what the user said.
        const answered = await agent.send([lead, carried.lead ?? "", input.text].filter((part) => part !== "").join("\n\n"), signal);
        if (answered.status === "answered" && answered.text.trim() !== "") {
          status = "done";
          reply = answered.text;
          finish = answered.finish ?? "stop";
        } else if (answered.status === "cancelled" || signal.aborted) {
          status = "stopped";
          reason = stopWords(signal) ?? texts.render(TEXT.progress.turnStopped);
        } else reason = answered.reason ?? texts.render(TEXT.answer.replyEmpty);
        if (status === "done" && cutShort(finish)) reason = texts.render(TEXT.agents.cut, { setting: texts.setting(["agents", resolved.definition.id, "budget", "callTokensOut"]) });
      } catch (error) {
        status = signal.aborted ? "stopped" : "failed";
        reason = errorText(error);
      }
      const usage: AgentUsage = { ...run.agents.usage };
      const at = host.clock.now();
      const ended = { status, at, ...(reason !== undefined && status !== "done" ? { reason } : {}) };
      try {
        if (status === "done") {
          sink.content(reply);
          sink.done(finish, usage);
        } else sink.error(reason ?? "", status);
      } catch (error) {
        host.log("warn", `the side session's stream took nothing (${errorText(error)})`);
      }
      run.close(ended, usage);
      const kept = await this.keep(doc, { turn: input.generationId, at, status, usage, ...(reason !== undefined ? { reason } : {}) }, input.text, status === "done" ? reply : null, settings.keep.transcripts ? run.trace.transcript({ generation: "side", messageId: null, startedAt, ended }) : null, settings.reply.progressChars);
      const extension = shared.options.extension;
      run.hook("answer to a run ending", extension?.runEnded ? () => extension.runEnded?.({ userId: run.userId, chatId: doc.chatId, turn: input.generationId, kind: "side", status, ...(ended.reason !== undefined ? { reason: ended.reason } : {}), reply, record: null, usage }) ?? Promise.resolve() : undefined);
      return { status, ...(reason !== undefined ? { reason } : {}), reply, usage, turn: kept };
    } finally {
      this.busy.delete(doc.id);
    }
  }

  /** What a side session's agents read and write: its chat as it stands now, or nothing but the user's own area. */
  private async equipment(chatId: string, shared: Shared, setup: Setup): Promise<Equipment> {
    const { host, areas } = shared;
    const { tools } = setup.settings;
    if (chatId === "") return { chat: chatView(host, "", [], tools), lore: loreView(host, { chatId: "", generationId: "" }, tools), areas: { chat: null, learned: null, user: areas.user() }, past: [], basis: null };
    // The main agent's notes on the chat, for past_turn: read as a turn would read them, and nothing is written.
    let past: PastTurn[] = [];
    try {
      past = (await shared.sessions.resume({ chatId, target: { messageId: null, swipeId: 0 }, kind: "new" })).turns;
    } catch (error) {
      host.log("warn", `the chat's session couldn't be read for a side session (${errorText(error)}): past_turn has nothing to read`);
    }
    return {
      chat: chatView(host, chatId, await host.chat.path(chatId), tools),
      lore: loreView(host, { chatId, generationId: "" }, tools),
      areas: { chat: areas.now(chatId), learned: await areas.learned(chatId), user: areas.user() },
      past,
      // A job started from here belongs to the latest turn on the chat's path, as the chat's area it writes does.
      basis: (await areas.latest(chatId))?.record.generationId ?? null,
    };
  }

  /**
   * The conversation so far, as the agent takes it up: a summary of its older part where one was
   * made, then each turn as what the user said and what the agent answered. Once it has grown past
   * Summarize past, all but the latest turns are summarized in one call and the summary is kept.
   * `lead`: the summary, framed, when no turn follows it to lead: the turn's own message carries it
   * then, as the main agent's does (`carriedOf`).
   */
  private async history(doc: SideDoc, run: Run, signal: AbortSignal): Promise<{ messages: ModelMessage[]; lead: string | null }> {
    const { settings, texts, shared } = run;
    const { blobs } = shared;
    const whole = await Promise.all(
      doc.turns.map(async (turn) => ({
        asked: (await blobs.get(turn.asked)) ?? "",
        answered: turn.answered === null ? texts.render(TEXT.side.unanswered, { reason: turn.reason ?? turn.status }) : ((await blobs.get(turn.answered)) ?? texts.render(TEXT.side.unanswered, { reason: turn.status })),
      })),
    );
    let summary = doc.summary ? await blobs.get(doc.summary.text) : null;
    let from = doc.summary && summary !== null ? doc.summary.turns : 0;
    const size = (): number => tokensOf(`${summary ?? ""}${whole.slice(from).map((turn) => `${turn.asked}${turn.answered}`).join("")}`, settings.loop.charsPerToken);
    const fold = whole.length - settings.session.keepTurns;
    if (size() > limitOf(settings.session.summarizeAtTokens) && fold > from) {
      const summarizer = run.resolve(AGENT.summarizer);
      const turns = whole.slice(from, fold).map((turn) => `${texts.render(TEXT.side.asked, { text: turn.asked })}\n\n${texts.render(TEXT.side.answered, { text: turn.answered })}`);
      if (summarizer) {
        // One call with instructions of its own and no tools, as the summary of the main agent's notes is made.
        const { agent } = await run.agent(summarizer, { depth: 0, system: texts.render(TEXT.side.summarizer, { limit: String(settings.session.summaryTokens) }), toolless: true, plain: true, task: "summarize the side session's older turns" });
        const made = summaryOf(await agent.send(texts.render(TEXT.side.summarizerInput, { summary: summary ?? texts.render(TEXT.session.none), turns: turns.join("\n\n") }), signal), texts);
        // A summary that failed, or whose call was cut at its limit, never stands (the guard a summary of the main agent's notes passes, which reads how the call ended and never its last word): the conversation goes on whole, and the next turn tries again.
        if ("summary" in made) {
          summary = made.summary;
          from = fold;
          doc.summary = { text: await blobs.put(summary), turns: fold };
        } else shared.host.log("warn", `the side session's older turns weren't summarized (${made.failed}); it goes on whole`);
      }
    }
    const messages = whole.slice(from).flatMap((turn): ModelMessage[] => [
      { role: "user", content: turn.asked },
      { role: "assistant", content: turn.answered },
    ]);
    if (summary === null) return { messages, lead: null };
    const lead = texts.render(TEXT.side.summary, { summary });
    const [first, ...rest] = messages;
    // The summary leads the first message it stands before; nothing is put in the agent's mouth to carry it where none is left.
    return first ? { messages: [{ ...first, content: `${lead}\n\n${first.content}` }, ...rest], lead: null } : { messages: [], lead };
  }

  /** Keeps a turn with its session: what was said and answered and the turn's transcript as blobs, the turn in the session's document. Null when it can't be stored, which the log says. */
  private async keep(doc: SideDoc, turn: Omit<SideTurnDoc, "asked" | "answered" | "transcript">, asked: string, answered: string | null, transcript: JsonObject | null, titleChars: number): Promise<SideTurnDoc | null> {
    const { blobs, host } = this.shared();
    try {
      const kept: SideTurnDoc = { ...turn, asked: await blobs.put(asked), answered: answered === null ? null : await blobs.put(answered), ...(transcript ? { transcript: await blobs.putJson(transcript, false) } : {}) };
      // A session is named by how its first message opens: a line in the page's list, so a progress line's length.
      const title = doc.title !== "" ? doc.title : clip(asked.replace(/\s+/g, " ").trim(), titleChars);
      await this.put(doc.id, { ...doc, title, lastAt: turn.at, turns: [...doc.turns, kept] });
      return kept;
    } catch (error) {
      host.log("warn", `the side session's turn couldn't be kept (${errorText(error)}): it was answered, and the session won't remember it`);
      return null;
    }
  }
}
