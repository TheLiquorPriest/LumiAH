// A turn (DESIGN §2, §3): one generation that reached the loopback connection, answered.
//
// It reads what the user set (`readSetup`), resumes the chat's session by walking its active path
// (§5), summarizes the main agent's notes when they have grown past their setting, and runs the main
// agent on the request with its tools. The main agent decides its own steps: no code calls a tool or
// a model on its behalf. When it calls `write_reply` with a brief, the writer's call is made (§3.2:
// Lumiverse's assembled messages as they came, the brief put in, the request's own sampling
// parameters) and its answer streams to the sink as the reply. When Settings say the main agent
// writes, its final answer is the reply. The turn ends with its record, which the caller anchors on
// the reply's message.
//
// Nothing of LumiAH's own that fails before the writer costs the reply (rule 5): settings that can't
// be read, a session that can't be resumed, the main agent's own run. The turn then ends where a
// main agent that stops short ends: the writer writes from the request alone, unless Settings say
// such a turn fails (`reply.withoutBrief`), and the thinking block, the trace and the turn's notes
// say what failed.
//
// Every step goes to the host's trace port: each agent as it starts, each call with its tokens, time,
// cost and exact prompt, each tool result, each stop. The main agent's steps also go to the sink as
// progress lines, for the reply's thinking block.

import type { ResolvedAgent } from "./agents";
import { foldKey, foldOf, summaryOf } from "./compaction";
import { mergeDefinitions } from "./definitions";
import { jobNews, jobState } from "./job-words";
import { type AgentReply, cutShort } from "./loop";
import { type AgentRef, type AgentUsage, type HarnessHost, isRecord, type JobView, type ModelDelta, modelMessages, type PathMessage, type PresetBlock, type ReplySink, type RequestMessage, type TraceEvent, type TranscriptEntry, type TurnRecord, type TurnRequest, type TurnResult, type TurnStatus } from "./ports";
import { chronicleRefusal } from "./recall/definitions";
import { recallTold } from "./recall/turn";
import { writerLore } from "./recall/writer";
import { carriedOf, receiptOf } from "./receipts";
import { briefedRequest, requestDocument, sentMessage } from "./request";
import { askExtension, readSetup, Run, type Setup, type Shared } from "./run";
import { type Compaction, compactionAsked, compactionDue, type ResumedSession, type SegmentStep, type SessionSegment } from "./sessions";
import { AGENT, type Settings, settingsOf } from "./settings";
import { leftOutWhy, type StorySource, storyHolds } from "./story";
import { TEXT, TOOL, type Texts, textsOf } from "./texts";
import type { PastTurn, ReplyStream, ToolCtx, ToolOutcome } from "./tools";
import { clip, errorText, limitOf, stopWords } from "./util";
import { chatView, loreView } from "./views";
import { type Area, changesBetween } from "./workspace";

/** How the writer's call went: it wrote the reply, or why it didn't (`stopped`: the turn's signal ended it). */
type Written = { ok: true } | { ok: false; reason: string; stopped: boolean };

/** How a turn stands once its agents are done: its reply written, or why not. */
type Outcome = { status: "done" } | { status: Exclude<TurnStatus, "done">; reason: string };

/** A turn stopped by its signal. */
class Stopped extends Error {}

/** What the writer was given in the brief's place, as the trace and the thinking block name it: a brief the main agent gave with `write_reply`, its last answer where it never made that call, nothing because it stopped short, or nothing because something of LumiAH's failed before it gave one. */
type BriefFrom = "call" | "answer" | "none" | "failed";

/** What a turn's work leaves for its record. */
class Work {
  session: ResumedSession | null = null;
  /** The chat's own area as this turn holds it. */
  area: Area | null = null;
  compaction: Compaction | null = null;
  request: { messages: number; last: number | null } = { messages: 0, last: null };
  /** The main agent's transcript, once its send ended. */
  main: TranscriptEntry[] = [];
  /** The main agent wrote the reply itself. */
  wrote = false;
  /** Its last answer was handed to the writer in the brief's place: it never called `write_reply`. */
  answerAsBrief = false;
  /** When it read which of the chat's jobs had stopped: the turn after it is told of those that stopped since. */
  heard: number | null = null;
  /** The run was given what its agents read and write. */
  equipped = false;
  /** What failed before the main agent gave a brief, where the writer was started on the reply all the same: the turn's notes say so. */
  failed: string | null = null;
}

/** One turn's work. */
export class Turn {
  private readonly host: HarnessHost;
  private settings: Settings;
  private texts: Texts = textsOf(null);
  private readonly startedAt: number;
  /** The reply's text as sent to the sink so far. */
  private reply = "";
  private finish = "stop";
  /** The sink was ended: nothing more goes to it. */
  private closed = false;
  /** The writer is at work on the reply. */
  private writing = false;
  /** The reply was written whole. */
  private written = false;
  /** Why the turn failed after part of the reply was sent: what was sent can't be taken back, so the turn can't try again. */
  private broken: string | null = null;
  /** The main agent's id, once it started: its tool calls are the turn's progress lines. */
  private mainId: string | null = null;
  /** Text of the reply was released by the turn's agents themselves (`reply_write`, `to_reply`): the reply is what they released, and no writer writes it. */
  private streamed = false;
  /** A sub-agent's answer is streaming into the reply (`to_reply`): nothing else goes in meanwhile. */
  private holder = false;
  /** What `reply_write` releases, one passage after another in the order the calls came. */
  private releasing: Promise<unknown> = Promise.resolve();

  constructor(
    private readonly shared: Shared,
    private readonly turn: TurnRequest,
    private readonly sink: ReplySink,
    /** What ends the turn's work: the user's stop. */
    private readonly signal: AbortSignal,
  ) {
    this.host = shared.host;
    this.settings = shared.latest;
    this.startedAt = this.host.clock.now();
  }

  async answer(): Promise<TurnResult> {
    const { turn, shared } = this;
    const userId = turn.userId === "" ? undefined : turn.userId;
    let setup: Setup;
    // Why the user's settings couldn't be read, where they couldn't.
    let unread: string | null = null;
    try {
      setup = await readSetup(shared, turn.chatId, userId);
    } catch (error) {
      // The reply isn't lost to it (rule 5). The turn goes on with Settings as shipped, and only as far as the writer: the main agent, its tools and its budgets are the user's to set, and it isn't run on a guess of them. Settings as shipped name no connection, so the writer's call goes to the host's default: to no model the user didn't choose.
      // The words are fixed: the user's texts are read with the settings, so there are none to say it in.
      unread = `LumiAH couldn't read its settings (${errorText(error)}): check that the runtime is linked to the extension`;
      setup = shippedSetup(shared, userId ?? shared.options.userId ?? "");
    }
    this.settings = setup.settings;
    this.texts = setup.texts;
    const run = new Run(shared, setup, { info: { id: turn.generationId, kind: turn.kind, chatId: turn.chatId }, budget: this.settings.turn, startedAt: this.startedAt, messageId: turn.target.messageId, turn, heard: (event) => this.heard(event) });
    run.reply = this.replyStream(run);
    const work = new Work();
    return this.conclude(work, run, await this.outcome(work, run, unread));
  }

  /** How the turn's agents left it: the main agent's part and then the writer's, or the writer's alone where something of LumiAH's own failed before it (`unread`: the settings, known before anything began). */
  private async outcome(work: Work, run: Run, unread: string | null): Promise<Outcome> {
    let failed = unread;
    if (failed === null) {
      try {
        const main = await this.runMain(work, run);
        // The agents released the reply themselves: it is what they released, whatever the main agent answered last (§3.4).
        if (this.streamed) return this.released();
        // Where the extension says only what is released is the reply, nothing else stands in for it.
        if (run.claim?.reply === "released") return main.reply.status === "cancelled" || this.signal.aborted ? { status: "stopped", reason: this.stoppedWhy() } : { status: "failed", reason: this.text(TEXT.progress.nothingReleased) };
        return main.writes ? this.ownReply(main.reply) : await this.briefed(main.reply, main.id, run, work);
      } catch (error) {
        if (error instanceof Stopped || this.signal.aborted) return { status: "stopped", reason: this.stoppedWhy() };
        failed = errorText(error);
      }
    }
    try {
      return await this.unbriefed(failed, work, run);
    } catch (error) {
      return this.signal.aborted ? { status: "stopped", reason: this.stoppedWhy() } : { status: "failed", reason: errorText(error) };
    }
  }

  /** A turn's end, whoever wrote its reply: its notes stored, the sink ended, its jobs and its run told how it ended, and its record made. */
  private async conclude(work: Work, run: Run, outcome: Outcome): Promise<TurnResult> {
    const { host, turn, shared } = this;
    const usage: AgentUsage = { ...run.agents.usage };
    const at = host.clock.now();
    const reason = outcome.status === "done" ? undefined : outcome.reason;
    const ended = { status: outcome.status, at, ...(reason !== undefined ? { reason } : {}) };
    // The turn's notes are stored before the reply's stream ends: one write, so that a turn whose notes can't be kept says so in the reply's thinking block, where the user reads it.
    const segment = await this.segment(work, run, ended);
    // Then the reply ends, before the rest of its bookkeeping: that never holds the user's reply up.
    if (outcome.status === "done") this.end(() => this.sink.done(this.finish, usage));
    else if (outcome.status === "stopped" && this.reply !== "") this.end(() => this.sink.done("stop", usage));
    else {
      const failed = outcome;
      this.progress(TEXT.progress.stopped, { reason: failed.reason });
      this.end(() => this.sink.error(failed.reason, failed.status));
    }
    const extension = shared.options.extension;
    if (outcome.status === "done") run.hook("answer to the reply being written", extension?.replyWritten ? () => extension.replyWritten?.({ userId: run.userId, chatId: turn.chatId, turn: turn.generationId, reply: this.reply, finish: this.finish }) ?? Promise.resolve() : undefined);
    // Jobs of this turn learn that it ended, and whether a record of it is coming, before the run is taken down: one that asks in between must not take the turn for gone.
    shared.jobs.turnEnded(turn.generationId, segment !== null);
    run.close(ended, usage);
    const record = segment === null ? null : await this.record(work, run, segment, ended, usage);
    shared.areas.closeTurn(turn.chatId, turn.generationId, record !== null);
    run.hook("answer to a run ending", extension?.runEnded ? () => extension.runEnded?.({ userId: run.userId, chatId: turn.chatId, turn: turn.generationId, kind: turn.kind, status: outcome.status, ...(reason !== undefined ? { reason } : {}), reply: this.reply, record, usage }) ?? Promise.resolve() : undefined);
    return { status: outcome.status, ...(reason !== undefined ? { reason } : {}), record, reply: this.reply, usage };
  }

  /** Why a stopped turn stopped: what its signal said, where whoever stopped it gave a reason in words; else the user's text for a stop. */
  private stoppedWhy(): string {
    return stopWords(this.signal) ?? this.text(TEXT.progress.turnStopped);
  }

  // ---------------------------------------------------------------- the work

  /** Gives the run what its agents read and write, from what the turn holds of the chat: its session (nothing of it where it couldn't be read), its own area, and the other areas as given. */
  private async equip(work: Work, run: Run, areas: { learned: Area | null; user: Area | null }): Promise<void> {
    const { host, turn, settings } = this;
    const { session } = work;
    await run.equip({
      chat: chatView(host, turn.chatId, session?.before ?? [], settings.tools),
      lore: loreView(host, turn, settings.tools),
      areas: { chat: work.area, ...areas },
      // past_turn reads what the agent carries, and, on a continue, what it did for this very reply before.
      past: session?.continued ? [...session.turns, session.continued] : (session?.turns ?? []),
      // A job this turn's agents start belongs to this turn.
      basis: turn.generationId,
    });
    work.equipped = true;
  }

  /**
   * The turn's place in the chat, for a turn that never read it (that read is what failed): the
   * session and the chat's files as the turn before left them, read once more now that the reply
   * is written, since its record needs the path's hash and the files' index. A second failure
   * leaves the turn without a record: the reply stands, and the log says so.
   */
  private async place(work: Work): Promise<void> {
    if (this.reply === "" || (work.session && work.area)) return;
    const { turn, shared } = this;
    try {
      const session = work.session ?? (await shared.sessions.resume(turn));
      work.area ??= shared.areas.openTurn(turn.chatId, turn.generationId, session.own ?? session.records.at(-1) ?? null);
      work.session = session;
    } catch (error) {
      // A record without the chat's files would say the chat has none: no record is the smaller loss.
      work.session = null;
      this.host.log("warn", `the chat couldn't be read for the turn's record (${errorText(error)}): the reply stands, and the main agent's notes won't hold this turn`);
    }
  }

  /** The turn's agents at work up to the main agent's last word: the session read (and summarized), and the main agent run on the request. */
  private async runMain(work: Work, run: Run): Promise<{ reply: AgentReply; id: string; writes: boolean }> {
    const { host, turn, settings, texts, shared } = this;
    const session = await shared.sessions.resume(turn);
    work.session = session;
    this.live();
    let carried: { summary: string | null; turns: readonly PastTurn[] } = { summary: session.summary, turns: session.turns };
    // The chat's area as the turn it follows left it: for a continue, the continued reply's own.
    work.area = shared.areas.openTurn(turn.chatId, turn.generationId, session.own ?? session.records.at(-1) ?? null);
    await this.equip(work, run, { learned: await shared.areas.learned(turn.chatId), user: shared.areas.user() });
    this.live();
    const sizes = { receiptChars: settings.session.receiptChars, receiptArgChars: settings.session.receiptArgChars, charsPerToken: settings.loop.charsPerToken, texts };
    const { refs } = session;
    const { rolledBackAt } = refs;
    const due = compactionDue({
      tokens: carriedOf(carried, sizes).tokens,
      limit: limitOf(settings.session.summarizeAtTokens),
      asked: await compactionAsked(host, turn.chatId).catch(() => null),
      records: session.records,
      rolledBackAt,
      // What the notes came to when the user rolled the summary back: the turns there were then.
      tokensAtRollback: rolledBackAt === null ? 0 : carriedOf({ summary: carried.summary, turns: carried.turns.filter((t) => t.segment.at <= rolledBackAt) }, sizes).tokens,
      margin: settings.session.rollbackMarginTokens,
    });
    if (due === "held") this.progress(TEXT.progress.compactionHeld, { margin: String(settings.session.rollbackMarginTokens) });
    if (due === "due") {
      const made = await this.compact(carried, run);
      if (made) {
        work.compaction = made.landed;
        carried = { summary: made.summary, turns: made.kept };
      }
      this.live();
    }
    const { history, lead, tokens } = carriedOf(carried, sizes);
    // The jobs the turn before this one started as due by it: waited for a while first, so the news below holds those that ended meanwhile.
    const dueNote = await this.dueJobs(session);
    // The jobs that stopped since the turn before this one last looked: its main agent hasn't heard of them.
    const before = session.records.at(-1);
    work.heard = host.clock.now();
    const news = await shared.jobs.news(turn.chatId, session.records, before ? (before.heard ?? before.began ?? before.at) : 0).catch((error: unknown) => {
      host.log("warn", `the chat's jobs couldn't be read (${errorText(error)}): the main agent isn't told of those that ended`);
      return [];
    });
    run.trace.emit({
      kind: "session",
      session: {
        turns: carried.turns.length,
        tokens,
        summary: carried.summary !== null,
        dropped: [...refs.dropped],
        missing: session.missing,
        ...(work.compaction ? { compacted: { folded: work.compaction.folded, kept: work.compaction.kept.length, summary: work.compaction.summary } } : {}),
        ...(refs.rolledBack !== null ? { rolledBack: { summary: refs.rolledBack } } : {}),
        ...(news.length > 0 ? { jobs: news } : {}),
      },
      at: host.clock.now(),
    });
    if (carried.turns.length === 0 && carried.summary === null) this.progress(TEXT.progress.fresh);
    else this.progress(carried.summary !== null ? TEXT.progress.sessionSummary : TEXT.progress.session, { turns: texts.counted(carried.turns.length, TEXT.word.earlierTurn) });
    // Notes that no longer fit the chat are said once: to the first turn after they stopped fitting. A turn that left a record was told of every one before it.
    const droppedReplies = texts.render(refs.fresh.length === 1 ? TEXT.main.replyOne : TEXT.main.replyMany, { list: refs.fresh.map((index) => `#${index}`).join(", ") });
    if (refs.fresh.length > 0) this.progress(TEXT.progress.dropped, { replies: droppedReplies });

    // The extension that claims the chat may name the agent that answers it; LumiAH's own answers every other.
    const claimed = run.claim?.mainAgent;
    const main = (claimed !== undefined ? run.resolve(claimed) : undefined) ?? this.resolved(run, AGENT.main);
    const writes = this.settings.reply.writer === "main";
    const blocks = await this.blocks();
    // What the prompt holds of the lore and of the chat (§24.1) and the top of the chat's chronicle (§24.7) follow the request's messages.
    // Upkeep is offered only where LumiAH's own agents keep the chronicle: in a chat whose extension puts an agent of its own in the chronicler's place, a job started for it would start that agent.
    const kept = settings.jobs.enabled && host.jobs !== undefined && chronicleRefusal(run.definitions, shared.options.extension?.name ?? null) === null;
    // Where the extension shows the main agent only the user's newest message, nothing of the prompt is told: it isn't shown the prompt.
    const newestOnly = run.claim?.request === "newest";
    const releasedOnly = run.claim?.reply === "released";
    const told = run.recall && !newestOnly ? await recallTold(run.recall, { path: session.before, blocks, writes, learned: run.areas.learned, jobs: kept ? () => shared.jobs.open(turn.chatId) : null, emit: (event) => run.trace.emit(event), log: host.log, now: host.clock.now() }) : undefined;
    const document = requestDocument(turn.messages, blocks, session.before, texts, told);
    work.request = { messages: document.messages, last: document.last };
    // The user's newest message: the last of the user's that came from the chat, else the last of the user's.
    const latest = newestOnly ? (turn.messages.findLast((m) => m.role === "user" && m.source?.kind === "history") ?? turn.messages.findLast((m) => m.role === "user") ?? null) : null;
    const newest = latest ? requestDocument([latest], blocks, session.before, texts).text : texts.render(TEXT.main.noNewest);
    run.request = newestOnly ? { count: texts.counted(latest ? 1 : 0, TEXT.word.message), text: newest, newest: true } : { count: texts.counted(document.messages, TEXT.word.message), text: document.text };
    const jobs = jobNews(news, texts);
    // Where only the model's replies are the story, the user's messages are directions: the main agent is told so, and given this reply's, read from the chat itself.
    const directed = await directedNote({
      source: run.story.source,
      before: session.before,
      texts,
      read: async (message) => {
        try {
          return (await host.chat.messages(turn.chatId, message.index, message.index + 1)).find((m) => m.id === message.id)?.content ?? null;
        } catch (error) {
          host.log("warn", `[LumiAH] the user's newest message couldn't be read (${errorText(error)}): the main agent is told the story is directed, without this reply's direction`);
          return null;
        }
      },
    });
    const notes = [
      ...(refs.fresh.length > 0 ? [texts.render(TEXT.main.noteDropped, { replies: droppedReplies })] : []),
      ...(refs.rolledBack !== null ? [texts.render(TEXT.main.noteRolledBack)] : []),
      ...(session.missing > 0 ? [texts.render(TEXT.main.noteMissing, { count: texts.counted(session.missing, TEXT.word.part) })] : []),
      ...(lead !== null ? [texts.render(TEXT.main.noteSummary, { summary: lead })] : []),
      ...(session.continued ? [texts.render(TEXT.main.noteContinued, { receipt: receiptOf(session.continued.segment, settings.session, texts) })] : []),
      ...(jobs !== null ? [jobs] : []),
      ...(dueNote !== null ? [dueNote] : []),
      ...(directed !== null ? [directed] : []),
    ];
    const kinds = { new: TEXT.main.kindNew, regenerate: TEXT.main.kindRegenerate, swipe: TEXT.main.kindSwipe, continue: TEXT.main.kindContinue } as const;
    const ask = texts.render(releasedOnly ? TEXT.main.askReleases : writes ? TEXT.main.askWrites : TEXT.main.ask);
    const noted = notes.map((note) => `${note}\n\n`).join("");
    const asked = newestOnly ? texts.render(TEXT.main.turnNewest, { kind: texts.render(kinds[turn.kind]), notes: noted, message: newest, ask }) : texts.render(TEXT.main.turn, { kind: texts.render(kinds[turn.kind]), notes: noted, count: run.request.count, request: document.text, ask });
    const { agent, lead: pinned } = await run.agent(main, {
      depth: 0,
      history,
      notes: true,
      main: true,
      // LumiAH's own main agent has instructions for each way the reply is written; any other definition's are its own.
      ...(writes && main.definition.text === TEXT.main.system ? { system: texts.render(TEXT.main.systemWrites) } : {}),
      // Where only what the agents release is the reply, no writer is there to brief.
      ...(writes || releasedOnly ? {} : { writeReply: (brief: string, ctx: ToolCtx) => this.writeReply(brief, ctx.agentId, run) }),
    });
    this.mainId = agent.id;
    const reply = await agent.send(pinned === "" ? asked : `${pinned}\n\n${asked}`, this.signal);
    // Its rounds are over: nothing the user says now would be read.
    run.quiet(true);
    work.main = agent.transcript().entries;
    work.wrote = writes;
    return { reply, id: agent.id, writes };
  }

  /** The turn's signal ended it: nothing more of it is started. */
  private live(): void {
    if (this.signal.aborted) throw new Stopped();
  }

  /** One of the core's own definitions as this turn runs it. They can't be switched off or removed. */
  private resolved(run: Run, id: string): ResolvedAgent {
    const agent = run.resolve(id);
    if (!agent) throw new Error(`there is no agent definition "${id}"`);
    return agent;
  }

  /** The active preset's blocks, which mark the request's instructions; none when the chat has no preset, or it can't be read (the request then goes unmarked, and the log says why). */
  private async blocks(): Promise<PresetBlock[]> {
    const { presetId } = this.turn;
    if (presetId === null) return [];
    try {
      return await this.host.preset.blocks(presetId);
    } catch (error) {
      this.host.log("warn", `the preset ${presetId} couldn't be read (${errorText(error)}), so the request's instructions aren't marked this turn`);
      return [];
    }
  }

  /** The main agent wrote the reply itself: its final answer is the reply, sent whole once it is known to be the answer and not a round of tool calls. */
  private ownReply(reply: AgentReply): Outcome {
    if (reply.status === "answered" && reply.text.trim() !== "") {
      this.content(reply.text);
      this.finish = reply.finish ?? "stop";
      this.written = true;
      return { status: "done" };
    }
    if (reply.status === "cancelled" || this.signal.aborted) return { status: "stopped", reason: this.stoppedWhy() };
    return { status: "failed", reason: reply.reason ?? this.text(TEXT.answer.replyEmpty) };
  }

  /**
   * The main agent's send ended while a writer writes the reply: by `write_reply` (the reply is
   * written, or broke off), with an answer of its own and no such call, or short of one.
   *
   * An answer without the call isn't a brief the agent gave: it may be one it forgot to hand over,
   * or a remark. It is handed to the writer in the brief's place, since it is the best there is,
   * and everything that shows it says so: the thinking block, the trace, and the agent's own notes,
   * which keep it as what it wrote and never as a call it didn't make. An answer cut at its length
   * limit is no answer at all: the agent stopped short.
   */
  private async briefed(reply: AgentReply, mainId: string, run: Run, work: Work): Promise<Outcome> {
    if (this.written) return { status: "done" };
    if (this.broken !== null) return { status: "failed", reason: this.broken };
    if (reply.status === "cancelled" || this.signal.aborted) return { status: "stopped", reason: this.stoppedWhy() };
    const said = reply.text.trim();
    const cut = reply.status === "answered" && cutShort(reply.finish);
    if (reply.status === "answered" && said !== "" && !cut) {
      work.answerAsBrief = true;
      this.progress(TEXT.progress.answerAsBrief);
      const wrote = await this.write(said, "answer", mainId, run);
      if (wrote.ok) return { status: "done" };
      return wrote.stopped ? { status: "stopped", reason: this.stoppedWhy() } : { status: "failed", reason: wrote.reason };
    }
    const short = cut ? this.text(TEXT.agents.cut) : (reply.reason ?? this.text(TEXT.answer.replyEmpty));
    if (this.settings.reply.withoutBrief === "fail") return { status: "failed", reason: short };
    // The reply's thinking block says so here, and the trace in what the writer is started for.
    this.progress(TEXT.progress.writingAlone, { reason: short });
    const wrote = await this.write(null, "none", mainId, run, short);
    if (wrote.ok) return { status: "done" };
    return wrote.stopped ? { status: "stopped", reason: this.stoppedWhy() } : { status: "failed", reason: wrote.reason };
  }

  /**
   * Something of LumiAH's own failed before the writer had a brief: the user's settings or the
   * chat's session couldn't be read, or the main agent's run broke. That never costs the reply
   * (rule 5): the turn ends where a main agent that stops short ends. The writer writes from the
   * request alone, unless Settings say such a turn fails, and the thinking block, the trace and
   * the turn's notes say what failed.
   */
  private async unbriefed(reason: string, work: Work, run: Run): Promise<Outcome> {
    if (this.signal.aborted) return { status: "stopped", reason: this.stoppedWhy() };
    // What the agents released stands as the reply: the log keeps what broke after it.
    if (this.streamed) {
      this.host.log("warn", `[LumiAH] the turn's work failed after part of its reply was released (${reason}): what was released stands`);
      return this.released();
    }
    // Where only what is released is the reply, no writer writes in the agents' place.
    if (run.claim?.reply === "released") return { status: "failed", reason };
    // The reply stands as far as it was written: whole, the turn is done, and the log keeps what broke after it; in part, nothing can be written after it.
    if (this.written) {
      this.host.log("warn", `[LumiAH] the turn's work failed after its reply was written (${reason}): the reply stands`);
      return { status: "done" };
    }
    if (this.broken !== null) return { status: "failed", reason: this.broken };
    // A main agent that writes the reply itself has no writer to fall back on, as when it stops short.
    if (this.reply !== "" || this.settings.reply.writer === "main" || this.settings.reply.withoutBrief === "fail") return { status: "failed", reason };
    this.progress(TEXT.progress.writingFailed, { reason });
    run.trace.emit({ kind: "notice", text: this.text(TEXT.progress.writingFailed, { reason }), at: this.host.clock.now() });
    work.failed = reason;
    // The run may never have been given what its agents work with: the writer starts with what the turn did read. Its prompt is the request's own, so it misses nothing unless Settings give it tools.
    if (!work.equipped) await this.equip(work, run, { learned: null, user: null });
    let wrote: Written;
    try {
      wrote = await this.write(null, "failed", this.mainId, run, reason);
    } finally {
      await this.place(work);
    }
    if (wrote.ok) return { status: "done" };
    return wrote.stopped ? { status: "stopped", reason: this.stoppedWhy() } : { status: "failed", reason: wrote.reason };
  }

  // ---------------------------------------------------------------- the session's compaction

  /**
   * Summarizes all but the latest turns of what the main agent carries, in one call of the
   * summarizer's, and lands the summary. Null when there is nothing to fold or no summary stands
   * (the call failed, its answer was cut, or the summary couldn't be stored): the session then
   * goes on whole, and the next turn tries again.
   */
  private async compact(carried: { summary: string | null; turns: readonly PastTurn[] }, run: Run): Promise<{ landed: Compaction; summary: string; kept: readonly PastTurn[] } | null> {
    const { settings, texts, shared } = this;
    const fold = foldOf(carried, { keep: settings.session.keepTurns, limit: settings.session.summaryTokens, receiptChars: settings.session.receiptChars, receiptArgChars: settings.session.receiptArgChars, texts });
    if (!fold) return null;
    const whole = (reason: string): null => {
      this.progress(TEXT.progress.notCompacted, { reason });
      this.host.log("warn", `the main agent's notes weren't summarized (${reason}); they go on whole`);
      return null;
    };
    try {
      const summarizer = this.resolved(run, AGENT.summarizer);
      this.progress(TEXT.progress.compacting, { turns: texts.counted(fold.folded.length, TEXT.word.turn) });
      const key = await foldKey({ connectionId: summarizer.connectionId, model: summarizer.model, effort: summarizer.effort, callTokensOut: summarizer.budget.callTokensOut, system: fold.system, message: fold.message });
      const result = await shared.memo.run(key, async () => {
        // One call with instructions of its own and no tools: nothing of the run's guidance, skills or files goes with it.
        const { agent } = await run.agent(summarizer, { depth: 0, system: fold.system, toolless: true, plain: true, task: "summarize the main agent's notes" });
        return summaryOf(await agent.send(fold.message, this.signal), texts);
      });
      if ("failed" in result) return whole(result.failed);
      const landed = await shared.sessions.compact(result.summary, fold.kept, fold.folded.length);
      this.progress(TEXT.progress.compacted, { folded: texts.counted(fold.folded.length, TEXT.word.turn), kept: String(fold.kept.length) });
      return { landed, summary: result.summary, kept: fold.kept };
    } catch (error) {
      // A summary is work the turn can do without: whatever of it throws (its text's write, its definition gone) leaves the notes whole, as a call that failed does, and the main agent works from them.
      return whole(errorText(error));
    }
  }

  // ---------------------------------------------------------------- the writer

  /** `write_reply`: the writer writes from the main agent's brief, and its reply ends the main agent's send. */
  private async writeReply(brief: string, mainId: string, run: Run): Promise<ToolOutcome> {
    // Once the agents released part of the reply, it is theirs to finish: a writer would write a second reply after it.
    if (this.streamed) return { text: this.text(TEXT.answer.replyReleased), error: true };
    if (this.holder) return { text: this.text(TEXT.answer.releaseHeld), error: true };
    if (this.writing || this.written || this.broken !== null) return { text: this.text(TEXT.answer.replyBusy), error: true };
    this.progress(TEXT.progress.writing);
    const wrote = await this.write(brief, "call", mainId, run);
    if (wrote.ok) return { text: this.reply, end: true };
    // Part of the reply already reached the user: a second try would write a second reply after it, so the main agent's turn ends here. A writer the turn's stop ended isn't a failure: the turn ends as stopped, with what was sent kept.
    if (this.reply !== "") {
      if (!wrote.stopped) this.broken = wrote.reason;
      return { text: this.reply, end: true };
    }
    return { text: this.text(TEXT.answer.replyFailed, { reason: wrote.reason }), error: true };
  }

  /**
   * The writer's request (DESIGN §3.2): Lumiverse's assembled messages as they came, each still
   * bearing where it came from, with the lore `write_reply` added and without the lore it dropped
   * (§24.3), with the brief put in (null: none), the agents' guidance beside it where Settings give
   * it to the writer, and then as the extension rewrote it, where it did.
   */
  private async request(brief: string | null, run: Run): Promise<RequestMessage[]> {
    const { turn, settings, texts, shared } = this;
    // Added entries go where Lumiverse puts world info; a request with no such place takes their text beside the brief, after the guidance.
    const lore = writerLore(run.recall ?? undefined, turn.messages);
    const built = briefedRequest(lore.messages, brief, settings.reply, texts, [...(settings.reply.writerGuidance ? run.guidanceLines() : []), ...lore.beside]);
    const extension = shared.options.extension;
    // The extension may place what it prepared where the user's preset expects it; without an answer the messages go as built.
    const answered: unknown = await askExtension<unknown>(shared, "writer's request", this.settings.extension.waitMs, extension?.writerRequest ? () => extension.writerRequest?.({ userId: run.userId, chatId: turn.chatId, generationId: turn.generationId, kind: turn.kind, brief, messages: built.map(sentMessage) }) ?? Promise.resolve(null) : undefined, null);
    // Its answer comes from outside the core: only a list of model messages, with something in it, is sent. Anything else leaves the messages as built, and the log says so.
    const rewritten = answered === null || answered === undefined ? null : modelMessages(answered);
    if (answered !== null && answered !== undefined && (rewritten === null || rewritten.length === 0)) this.host.log("warn", "[LumiAH] the extension's answer to the writer's request isn't a list of model messages with something in it: the writer is sent the request as it was built");
    return rewritten !== null && rewritten.length > 0 ? rewritten : built;
  }

  /**
   * The writer's call (DESIGN §3.2): Lumiverse's assembled messages as they came, with the brief put
   * in (`from` says what stands in the brief's place; none when the main agent stopped short of
   * one, or something failed before it gave one: `short` is why), the request's own sampling
   * parameters and answer room, and the tools Settings give the writer (none by default). Its
   * answer streams to the sink as the reply. `parent`: the main agent, where one started.
   */
  private async write(brief: string | null, from: BriefFrom, parent: string | null, run: Run, short?: string): Promise<Written> {
    const { turn, texts } = this;
    this.writing = true;
    // While the writer writes, the main agent is in no round: a note the user says now would reach nobody, so it is refused with that said.
    run.quiet(true);
    try {
      const writer = this.resolved(run, AGENT.writer);
      const messages = (await this.request(brief, run)).map(sentMessage);
      const task = {
        call: "write the reply from the main agent's brief",
        answer: "write the reply from the main agent's last answer, taken as its brief: it never called write_reply",
        none: `write the reply without a brief: the main agent stopped short of one (${short ?? "no reason given"})`,
        failed: `write the reply without a brief: LumiAH failed before the main agent gave one (${short ?? "no reason given"})`,
      }[from];
      // Its prompt is the user's preset's, with the brief put in: nothing else of LumiAH's is added to it.
      const { agent } = await run.agent(writer, {
        depth: 0,
        ...(parent !== null ? { parent } : {}),
        task,
        system: "",
        plain: true,
        // A cap on a day's spend stops agents' work, never the reply the user waits for: the writer's call is made, and recorded.
        uncapped: true,
        history: messages,
        params: turn.params,
        onDelta: (delta) => this.delta(delta),
        // The request's own answer room where it names one: the preset governs the prose as it does without LumiAH.
        budget: { ...writer.budget, callTokensOut: turn.maxTokens ?? writer.budget.callTokensOut },
      });
      const reply = await agent.run(this.signal);
      if (reply.status !== "answered") return { ok: false, reason: reply.reason ?? texts.render(TEXT.answer.replyEmpty), stopped: reply.status === "cancelled" || this.signal.aborted };
      // A host that streams nothing still gave the answer whole: what wasn't streamed is sent now.
      if (reply.text.startsWith(this.reply)) this.content(reply.text.slice(this.reply.length));
      if (this.reply.trim() === "") return { ok: false, reason: texts.render(TEXT.answer.replyEmpty), stopped: false };
      this.finish = reply.finish ?? "stop";
      this.written = true;
      return { ok: true };
    } finally {
      this.writing = false;
      // A writer that failed with nothing sent hands the main agent the failure as write_reply's result, and it goes on: it reads notes again.
      if (from === "call" && this.reply === "") run.quiet(false);
    }
  }

  // ---------------------------------------------------------------- the sink

  private text(id: string, vars: Readonly<Record<string, string>> = {}): string {
    return this.texts.render(id, vars);
  }

  /** Something for the sink, unless it was ended; a sink that throws (its stream is gone) loses what it was given, never the turn. */
  private toSink(send: () => void): void {
    if (this.closed) return;
    try {
      send();
    } catch (error) {
      this.host.log("warn", `the reply's stream took nothing (${errorText(error)})`);
    }
  }

  /** Ends the sink, once. */
  private end(send: () => void): void {
    this.toSink(send);
    this.closed = true;
  }

  // ---------------------------------------------------------------- the reply, released by the agents (§3.4)

  /**
   * The reply as the turn's agents may write it themselves (`reply_write`, `delegate`'s
   * `to_reply`): a passage goes out once nothing else holds the reply and the extension lets it
   * (§21 `releasing`), in the order the calls came.
   */
  private replyStream(run: Run): ReplyStream {
    const shut = (): string | null => {
      if (this.closed || this.signal.aborted) return this.text(TEXT.answer.releaseEnded);
      if (this.writing || this.written || this.broken !== null) return this.text(TEXT.answer.releaseWriter);
      if (this.holder) return this.text(TEXT.answer.releaseHeld);
      return null;
    };
    return {
      refused: shut,
      write: (text, ctx) => {
        const next = this.releasing.then(() => this.release(text, ctx, run, shut));
        this.releasing = next.catch(() => undefined);
        return next;
      },
      hold: (agent) => {
        this.holder = true;
        let given = false;
        return (released) => {
          if (given) return;
          given = true;
          this.holder = false;
          if (released !== "") this.tellReleased(run, agent, released);
        };
      },
      stream: (text) => this.streamOut(text),
      length: () => this.reply.length,
    };
  }

  /** One `reply_write` passage: asked about (§21 `releasing`), then sent. Null once it went out; else why not, in words for the model. A check that fails or gives no word in time lets nothing go: the passage is held to what the extension let through. */
  private async release(text: string, ctx: ToolCtx, run: Run, shut: () => string | null): Promise<string | null> {
    const first = shut();
    if (first !== null) return first;
    const { turn, shared } = this;
    const agent: AgentRef = run.ref(ctx.agentId) ?? { agentId: ctx.agentId, role: ctx.role, ...(ctx.as !== undefined ? { as: ctx.as } : {}) };
    const extension = shared.options.extension;
    if (extension?.releasing) {
      const lost = {};
      const verdict: unknown = await askExtension<unknown>(shared, "word on a passage of the reply", this.settings.extension.waitMs, () => extension.releasing?.({ userId: run.userId, chatId: turn.chatId, turn: turn.generationId, agent, text }) ?? Promise.resolve(null), lost);
      if (verdict === lost) return this.text(TEXT.answer.releaseUnchecked);
      if (verdict !== null && verdict !== undefined) return isRecord(verdict) && typeof verdict.refused === "string" && verdict.refused.trim() !== "" ? clip(verdict.refused, this.settings.tools.pageChars) : this.text(TEXT.answer.releaseUnchecked);
      // Asked again: the reply may have ended, or another agent's answer begun streaming into it, while the extension looked.
      const late = shut();
      if (late !== null) return late;
    }
    if (!this.streamOut(text)) return this.text(TEXT.answer.releaseEnded);
    this.tellReleased(run, agent, text);
    return null;
  }

  /** Text the agents release goes to the reply, unless the turn was stopped or its reply ended: false where it went nowhere. */
  private streamOut(text: string): boolean {
    if (text === "" || this.closed || this.signal.aborted) return false;
    this.streamed = true;
    this.content(text);
    return true;
  }

  /** The extension hears what reached the user (§21 `released`); nothing waits on it. */
  private tellReleased(run: Run, agent: AgentRef, text: string): void {
    const { turn } = this;
    const extension = this.shared.options.extension;
    run.hook("answer to a passage released", extension?.released ? () => extension.released?.({ userId: run.userId, chatId: turn.chatId, turn: turn.generationId, agent, text }) ?? Promise.resolve() : undefined);
  }

  /** The turn ends with the reply its agents released: whole, however the main agent's own work ended. */
  private released(): Outcome {
    if (this.signal.aborted) return { status: "stopped", reason: this.stoppedWhy() };
    this.written = true;
    this.finish = "stop";
    return { status: "done" };
  }

  /**
   * The jobs due by this turn (§15: `job_start`'s `due`): those the turn before it on the path
   * started as due by the next, waited for until they end or Wait for jobs due has passed. The note
   * that names those still not ended, for the main agent; null where there are none.
   */
  private async dueJobs(session: ResumedSession): Promise<string | null> {
    const { host, turn, settings, texts, shared } = this;
    const basis = (session.own ?? session.records.at(-1))?.generationId;
    if (basis === undefined || !settings.jobs.enabled || !host.jobs) return null;
    let still: JobView[];
    try {
      const due = await shared.jobs.awaitDue(turn.chatId, basis, 0, this.signal);
      if (due.length === 0) return null;
      this.progress(TEXT.progress.dueWait, { jobs: texts.counted(due.length, TEXT.jobs.word) });
      still = await shared.jobs.awaitDue(turn.chatId, basis, settings.jobs.dueWaitMs, this.signal);
    } catch (error) {
      host.log("warn", `[LumiAH] the jobs due by this turn couldn't be read (${errorText(error)}): the main agent isn't told of them`);
      return null;
    }
    this.live();
    if (still.length === 0) return null;
    return texts.render(TEXT.jobs.dueRunning, { jobs: still.map((job) => texts.render(TEXT.jobs.dueLine, { id: job.id, agent: job.agent, as: job.as !== undefined ? texts.render(TEXT.jobs.dueAs, { as: job.as }) : "", state: jobState(job, texts) })).join("\n") });
  }

  private content(text: string): void {
    // Nothing more counts as the reply once the turn was stopped: the runtime sends nothing after a stop, so the reply is what the user saw.
    if (text === "" || this.signal.aborted) return;
    this.reply += text;
    this.toSink(() => this.sink.content(text));
  }

  /** A piece of the writer's answer as it arrives: its text is the reply's, its reasoning the reply's thinking. */
  private delta(delta: ModelDelta): void {
    const { reasoning } = delta;
    if (reasoning !== undefined && reasoning !== "") this.toSink(() => this.sink.reasoning(reasoning));
    if (delta.content !== undefined) this.content(delta.content);
  }

  /** A progress line for the reply's thinking block, while Settings write them. */
  private progress(id: string, vars: Readonly<Record<string, string>> = {}): void {
    const { progress, progressChars } = this.settings.reply;
    if (progress) this.toSink(() => this.sink.progress(clip(this.text(id, vars), progressChars)));
  }

  /** Hears the turn's trace: each tool the main agent calls is a progress line, and so is each call any of the turn's agents makes again, since it holds the reply up. */
  private heard(event: TraceEvent): void {
    if (event.kind !== "agent_entry") return;
    const { entry } = event;
    if (entry.kind === "retry") this.progress(TEXT.progress.retry, { reason: entry.reason, attempt: String(entry.attempt), retries: String(entry.of) });
    if (event.agentId !== this.mainId || entry.kind !== "answer") return;
    // A passage the main agent releases is in the reply itself: the thinking block isn't given it again.
    for (const call of entry.calls) if (call.name !== TOOL.replyWrite) this.progress(TEXT.progress.call, { tool: call.name, args: JSON.stringify(call.args) });
  }

  // ---------------------------------------------------------------- the record

  /**
   * What the turn added to the main agent's notes, stored: its segment's hash. Null when no reply
   * text was sent (there is then no reply to anchor a record on) or the turn's session was never
   * read; and when it can't be stored, which the user is told where they read: the reply's
   * thinking block and the live view.
   */
  private async segment(work: Work, run: Run, ended: { status: TurnStatus; at: number; reason?: string }): Promise<string | null> {
    const { turn, shared } = this;
    const { session } = work;
    if (this.reply === "" || !session) return null;
    try {
      const own = finishedSteps(draftOf(work), { reply: String(session.reply), chars: String(this.reply.length), texts: this.texts, failed: work.failed, stopped: ended.reason, written: this.written });
      const segment: SessionSegment = { v: 1, kind: "segment", reply: session.reply, generationId: turn.generationId, turn: turn.kind, at: ended.at, request: work.request, steps: [...(session.continued?.segment.steps ?? []), ...own] };
      return await shared.sessions.segment(segment);
    } catch (error) {
      this.host.log("warn", `the turn's record wasn't made (${errorText(error)}): the reply stands, and the main agent's notes won't hold this turn`);
      this.progress(TEXT.progress.recordFailed, { error: errorText(error) });
      run.trace.emit({ kind: "notice", text: this.text(TEXT.progress.recordFailed, { error: errorText(error) }), at: this.host.clock.now() });
      return null;
    }
  }

  /**
   * The turn's record: its segment, its transcript (left out where it can't be stored: the notes
   * still stand), the chat's area as the turn left it with how many files it changed, and the jobs
   * its agents started.
   */
  private async record(work: Work, run: Run, segment: string, ended: { status: TurnStatus; at: number; reason?: string }, usage: AgentUsage): Promise<TurnRecord | null> {
    const { turn, settings, shared } = this;
    const { session } = work;
    if (!session) return null;
    let transcript: string | undefined;
    if (settings.keep.transcripts) {
      try {
        transcript = await shared.blobs.putJson(run.trace.transcript({ generation: turn.kind, messageId: turn.target.messageId, startedAt: this.startedAt, ended }), false);
      } catch (error) {
        this.host.log("warn", `the turn's transcript wasn't stored (${errorText(error)}): the Sessions page has no steps to show for it`);
      }
    }
    let workspace: string | null = null;
    let changed = 0;
    try {
      workspace = (await work.area?.headHash()) ?? null;
      changed = changesBetween("chat", await shared.workspace.index(session.records.at(-1)?.workspace ?? null), await shared.workspace.index(workspace)).length;
    } catch (error) {
      this.host.log("warn", `the chat's files couldn't be read for the turn's record (${errorText(error)}): the record names none`);
    }
    return {
      v: 1,
      generationId: turn.generationId,
      kind: turn.kind,
      began: this.startedAt,
      ...(work.heard !== null ? { heard: work.heard } : {}),
      at: ended.at,
      path: session.path,
      segment,
      ...(transcript !== undefined ? { transcript } : {}),
      // A rolled-back summary of the reply this turn answered again is carried on, marked as it was: the rollback then holds for the turns after it (`ResumedSession.held`).
      ...(work.compaction ? { summary: work.compaction.summary, kept: work.compaction.kept, folded: work.compaction.folded } : session.held ? { ...session.held } : {}),
      ...(workspace !== null ? { workspace } : {}),
      ...(changed > 0 ? { changed } : {}),
      ...(run.jobs.length > 0 ? { jobs: [...run.jobs] } : {}),
      usage,
    };
  }
}

/** A turn's steps before its reply is known: `replied` names the steps that state the reply, by their place, and `asBrief` is where the note goes that the main agent's answer was taken as the brief (null: it wasn't). */
interface DraftSteps {
  steps: SegmentStep[];
  replied: number[];
  asBrief: number | null;
}

/**
 * The main agent's steps this turn, from its transcript: what it wrote beside its calls, each call
 * with what came back, and how it ended. The reply itself is never kept (it is in the chat):
 * `write_reply`'s result, which is the reply, and a reply the main agent wrote itself are left to be
 * filled in as a note of its length once it is written (`finishedSteps`).
 */
function draftOf(work: Work): DraftSteps {
  const results = new Map<string, Extract<TranscriptEntry, { kind: "result" }>>();
  for (const entry of work.main) if (entry.kind === "result") results.set(entry.callId, entry);
  const answers = work.main.filter((entry) => entry.kind === "answer");
  const steps: SegmentStep[] = [];
  const replied: number[] = [];
  let asBrief: number | null = null;
  for (const entry of work.main) {
    if (entry.kind === "stop") steps.push({ kind: "stop", reason: entry.reason });
    if (entry.kind !== "answer") continue;
    const final = entry === answers.at(-1) && entry.calls.length === 0;
    if (final && work.wrote) {
      replied.push(steps.length);
      steps.push({ kind: "reply", chars: 0 });
    } else if (entry.text.trim() !== "") steps.push({ kind: "said", text: entry.text });
    if (final && work.answerAsBrief) asBrief = steps.length;
    for (const call of entry.calls) {
      const result = results.get(call.id);
      if (!result) continue;
      const reply = call.name === TOOL.writeReply && !result.error;
      if (reply) replied.push(steps.length);
      steps.push({ kind: "call", name: call.name, args: call.args, result: reply ? "" : result.text, ...(result.error ? { error: true as const } : {}) });
    }
  }
  return { steps, replied, asBrief };
}

/**
 * A turn's steps once its reply is written (`chars`: its length; `reply`: its place in the chat):
 * the steps that state the reply say so with its length. An answer handed over in the brief's place
 * is followed by what became of it, where a reply was written from it: it is kept as what the agent
 * wrote, never as a `write_reply` call, which it didn't make.
 */
function finishedSteps(draft: DraftSteps, input: { reply: string; chars: string; texts: Texts; failed: string | null; stopped: string | undefined; written: boolean }): SegmentStep[] {
  const { texts } = input;
  const written = texts.render(TEXT.session.replyWritten, { chars: input.chars, reply: input.reply });
  const steps = draft.steps.map((step, at): SegmentStep => (!draft.replied.includes(at) ? step : step.kind === "reply" ? { kind: "reply", chars: Number(input.chars) } : step.kind === "call" ? { ...step, result: written } : step));
  if (draft.asBrief !== null && input.written) steps.splice(draft.asBrief, 0, { kind: "stop", reason: texts.render(TEXT.session.answerAsBrief, { chars: input.chars, reply: input.reply }) });
  // What failed before it gave a brief, where the writer was started all the same: its notes say why it had no part in the reply.
  if (input.failed !== null) steps.push({ kind: "stop", reason: texts.render(TEXT.session.unbriefed, { reason: input.failed }) });
  // A turn that ended short of its agents' own stop (its signal, a failure outside them) says so too.
  if (input.stopped !== undefined && !steps.some((step) => step.kind === "stop")) steps.push({ kind: "stop", reason: input.stopped });
  return steps;
}

/**
 * What the main agent's opening note says of the story where only the model's replies are (§3.1):
 * that the user directs it from outside, and, with `newest` "directive", the direction for this
 * reply, read from the chat itself (Lumiverse may have left it out of the prompt). The direction is
 * the user's message the turn's path ends with: a path that ends with a reply has none for this
 * reply, and a message the story leaves out as hidden gives none either. `read` gives a message's
 * text; null where it couldn't be read, and the note then goes without it. Null where everyone's
 * messages are the story: the note is as it always was.
 */
export async function directedNote(input: { source: StorySource; before: readonly PathMessage[]; read(message: PathMessage): Promise<string | null>; texts: Texts }): Promise<string | null> {
  const { source, before, texts } = input;
  if (source.from !== "replies") return null;
  let direction = "";
  if (source.newest === "directive") {
    const last = before.at(-1);
    const given = last !== undefined && last.role === "user" && leftOutWhy(last, source) !== "hidden" ? await input.read(last) : "";
    if (given === null) direction = "";
    else direction = given.trim() === "" ? texts.render(TEXT.main.noDirection) : texts.render(TEXT.main.direction, { text: given });
  }
  return texts.render(TEXT.main.directed, { direction });
}

/**
 * What a turn works with when the user's settings can't be read: Settings and texts as shipped and
 * the definitions written in code, with nothing of the user's, the extension's or the chat's. Only
 * the writer runs on it (`Turn.answer`).
 */
function shippedSetup(shared: Shared, userId: string): Setup {
  const definitions = mergeDefinitions({ code: { agents: shared.agents.all(), skills: shared.skills.all(), tools: shared.tools.all() }, core: shared.core, extension: { agents: [], skills: [] }, remote: [], user: null, claim: null }, shared.host);
  const settings = settingsOf(null, definitions.scope());
  // Whether prompts and transcripts are kept is the user's to say, and what they said can't be read: nothing they may have switched off is kept for this turn.
  settings.keep = { ...settings.keep, prompts: false, transcripts: false };
  return { userId, settings, texts: textsOf(null), definitions, chat: null, claim: null, story: storyHolds({ user: settings.story, sovereignHand: null }) };
}
