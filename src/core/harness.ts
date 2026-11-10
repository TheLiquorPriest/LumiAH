// The turn (DESIGN §2, §3): `createHarness(host, options).answer(turn, sink, signal)` answers one
// generation that reached the loopback connection.
//
// It reads the user's settings and texts, resumes the chat's session by walking its active path
// (§5), compacts it when it has grown past its setting, and runs the main agent on the request with
// its tools. The main agent decides its own steps: no code calls a tool or a model on its behalf.
// When it calls `write_reply` with a brief, the writer's call is made (§3.2: Lumiverse's assembled
// messages as they came, the brief put in, the request's own sampling parameters) and its answer
// streams to the sink as the reply. When Settings say the main agent writes, its final answer is the
// reply. The turn ends with its record, which the caller anchors on the reply's message.
//
// Every step goes to the host's trace port: each agent as it starts, each call with its tokens, time,
// cost and exact prompt, each tool result, each stop. The main agent's steps also go to the sink as
// progress lines, for the reply's thinking block.

import { AgentRegistry, baseAgents, type ResolvedAgent } from "./agents";
import { Blobs } from "./blobs";
import { CompactionMemo, foldKey, foldOf, summaryOf } from "./compaction";
import { type AgentDeps, type AgentReply, AgentTurn, startAgent } from "./loop";
import type { AgentUsage, HarnessHost, ModelDelta, PresetBlock, ReplySink, TraceEvent, TranscriptEntry, TurnRecord, TurnRequest, TurnResult, TurnStatus } from "./ports";
import { AgentAccounts } from "./provider";
import { carriedOf, receiptOf } from "./receipts";
import { requestDocument, writerMessages } from "./request";
import { type Compaction, type ResumedSession, type SegmentStep, type SessionSegment, Sessions } from "./sessions";
import { AGENT, defaultSettings, type Settings, settingsOf } from "./settings";
import { TEXT, TOOL, type Texts, textsOf } from "./texts";
import { type PastTurn, type ToolEnv, type ToolOutcome, ToolRegistry } from "./tools";
import { BASE_TOOLS } from "./tools/base";
import { TurnTrace } from "./transcript";
import { emptyUsage } from "./usage";
import { clip, errorText, limitOf } from "./util";
import { chatView, loreView } from "./views";

export interface HarnessOptions {
  /**
   * The user's settings and texts as stored, read at the start of every turn: the core's settings
   * object (whole or in part: the core fills in its defaults) and the user's own texts by id. So a
   * changed setting and a replaced text take effect on the next turn.
   */
  settings(): Promise<{ values: unknown; texts: unknown }>;
}

export interface Harness {
  /** The tools an agent definition may be given: the base tools, and whatever an extension registers. */
  readonly tools: ToolRegistry;
  /** The agent definitions: the main agent, the writer and the summarizer, and whatever an extension registers. */
  readonly agents: AgentRegistry;
  /**
   * Answers one turn. The reply streams to `sink`, which gets exactly one `done` or one `error`;
   * `signal` stops the turn. Never rejects: how the turn ended is in what it returns, with its record
   * for the caller to anchor on the reply's message.
   */
  answer(turn: TurnRequest, sink: ReplySink, signal: AbortSignal): Promise<TurnResult>;
}

/** What a harness keeps across turns: the connections' accounts, the blobs read lately, and the summaries made lately. */
interface Shared {
  host: HarnessHost;
  options: HarnessOptions;
  tools: ToolRegistry;
  agents: AgentRegistry;
  accounts: AgentAccounts;
  blobs: Blobs;
  sessions: Sessions;
  memo: CompactionMemo;
  /** The settings of the turn read last: what the memory limits above are read from. */
  latest: Settings;
}

export function createHarness(host: HarnessHost, options: HarnessOptions): Harness {
  const tools = new ToolRegistry();
  tools.register(...BASE_TOOLS);
  const agents = new AgentRegistry();
  agents.register(...baseAgents());
  const blobs = new Blobs(host, () => shared.latest.keep.blobChars);
  const shared: Shared = { host, options, tools, agents, accounts: new AgentAccounts(host), blobs, sessions: new Sessions(host, blobs), memo: new CompactionMemo(() => shared.latest.keep.summaries), latest: defaultSettings() };
  return { tools, agents, answer: (turn, sink, signal) => new Turn(shared, turn, sink, signal).answer() };
}

/** How the writer's call went: it wrote the reply, or why it didn't (`stopped`: the turn's signal ended it). */
type Written = { ok: true } | { ok: false; reason: string; stopped: boolean };

/** How a turn stands once its agents are done: its reply written, or why not. */
type Outcome = { status: "done" } | { status: Exclude<TurnStatus, "done">; reason: string };

/** A turn stopped by its signal, with the reason the signal gave where it gave one in words. */
class Stopped extends Error {}

/** One turn's work. */
class Turn {
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

  constructor(
    private readonly shared: Shared,
    private readonly turn: TurnRequest,
    private readonly sink: ReplySink,
    private readonly signal: AbortSignal,
  ) {
    this.host = shared.host;
    this.settings = shared.latest;
    this.startedAt = this.host.clock.now();
  }

  async answer(): Promise<TurnResult> {
    const { host, turn } = this;
    try {
      const stored = await this.shared.options.settings();
      // The schema is the registries': an extension's own tools and agent definitions are settings too.
      this.settings = settingsOf(stored.values, { tools: this.shared.tools.names(), agents: this.shared.agents.extra() });
      this.texts = textsOf(stored.texts);
      this.shared.latest = this.settings;
    } catch (error) {
      // Running on the defaults would call models the user didn't choose: the turn says why instead.
      // Its words are fixed: the user's texts are read with the settings, so there are none to say
      // it in; they go to the user as the turn's error, never to a model.
      const reason = `LumiAH couldn't read its settings (${errorText(error)}), so this turn wasn't answered. Check that the runtime is linked to the extension, then try again.`;
      this.end(() => this.sink.error(reason, "failed"));
      return { status: "failed", reason, record: null, reply: "", usage: emptyUsage() };
    }
    const trace = new TurnTrace(host, { turn: turn.generationId, chatId: turn.chatId }, this.shared.blobs, this.settings.keep.prompts, (event) => this.heard(event));
    const agents = new AgentTurn(this.settings.turn, this.startedAt, trace);
    trace.turn = agents;
    trace.emit({ kind: "turn_started", turn: turn.generationId, chatId: turn.chatId, generation: turn.kind, messageId: turn.target.messageId, at: this.startedAt });
    const work = new Work();
    let outcome: Outcome;
    try {
      outcome = await this.work(work, trace, { host, settings: this.settings, texts: this.texts, accounts: this.shared.accounts, turn: agents });
    } catch (error) {
      outcome = error instanceof Stopped || this.signal.aborted ? { status: "stopped", reason: this.text(TEXT.progress.turnStopped) } : { status: "failed", reason: errorText(error) };
    }
    const usage: AgentUsage = { ...agents.usage };
    const at = host.clock.now();
    // The reply ends first: its bookkeeping never holds the user's reply up.
    if (outcome.status === "done") this.end(() => this.sink.done(this.finish, usage));
    else if (outcome.status === "stopped" && this.reply !== "") this.end(() => this.sink.done("stop", usage));
    else {
      const { reason, status } = outcome;
      this.progress(TEXT.progress.stopped, { reason });
      this.end(() => this.sink.error(reason, status));
    }
    const reason = outcome.status === "done" ? undefined : outcome.reason;
    trace.emit({ kind: "turn_ended", status: outcome.status, ...(reason !== undefined ? { reason } : {}), usage, at });
    const record = await this.record(work, trace, { status: outcome.status, at, ...(reason !== undefined ? { reason } : {}) }, usage);
    return { status: outcome.status, ...(reason !== undefined ? { reason } : {}), record, reply: this.reply, usage };
  }

  // ---------------------------------------------------------------- the work

  /** The turn's agents at work: the session read (and compacted), the main agent run, the reply written. */
  private async work(work: Work, trace: TurnTrace, deps: AgentDeps): Promise<Outcome> {
    const { host, turn, settings, texts, shared } = this;
    const session = await shared.sessions.resume(turn);
    work.session = session;
    this.live();
    let carried: { summary: string | null; turns: readonly PastTurn[] } = { summary: session.summary, turns: session.turns };
    const sizes = { receiptChars: settings.session.receiptChars, charsPerToken: settings.loop.charsPerToken, texts };
    const env: ToolEnv = { host, turn, settings, texts, agent: AGENT.main, chat: chatView(host, turn.chatId, session.before, settings.tools), lore: loreView(host, turn, settings.tools), past: carried.turns };
    if (carriedOf(carried, sizes).tokens > limitOf(settings.session.summarizeAtTokens)) {
      const made = await this.compact(carried, env, deps);
      if (made) {
        work.compaction = made.landed;
        carried = { summary: made.summary, turns: made.kept };
      }
      this.live();
    }
    const { history, lead, tokens } = carriedOf(carried, sizes);
    const { refs } = session;
    trace.emit({
      kind: "session",
      session: { turns: carried.turns.length, tokens, summary: carried.summary !== null, dropped: [...refs.dropped], missing: session.missing, ...(work.compaction ? { compacted: { folded: work.compaction.folded, kept: work.compaction.kept.length, summary: work.compaction.summary } } : {}), ...(refs.rolledBack !== null ? { rolledBack: { summary: refs.rolledBack } } : {}) },
      at: host.clock.now(),
    });
    if (carried.turns.length === 0 && carried.summary === null) this.progress(TEXT.progress.fresh);
    else this.progress(carried.summary !== null ? TEXT.progress.sessionSummary : TEXT.progress.session, { turns: texts.counted(carried.turns.length, TEXT.word.earlierTurn) });
    const droppedReplies = texts.render(refs.dropped.length === 1 ? TEXT.main.replyOne : TEXT.main.replyMany, { list: refs.dropped.map((index) => `#${index}`).join(", ") });
    if (refs.dropped.length > 0) this.progress(TEXT.progress.dropped, { replies: droppedReplies });

    const main = this.resolved(AGENT.main);
    const writes = settings.reply.writer === "main";
    const blocks = await this.blocks();
    const document = requestDocument(turn.messages, blocks, session.before, texts);
    work.request = { messages: document.messages, last: document.last };
    const notes = [
      ...(refs.dropped.length > 0 ? [texts.render(TEXT.main.noteDropped, { replies: droppedReplies })] : []),
      ...(refs.rolledBack !== null ? [texts.render(TEXT.main.noteRolledBack)] : []),
      ...(session.missing > 0 ? [texts.render(TEXT.main.noteMissing, { count: texts.counted(session.missing, TEXT.word.part) })] : []),
      ...(lead !== null ? [texts.render(TEXT.main.noteSummary, { summary: lead })] : []),
      ...(session.continued ? [texts.render(TEXT.main.noteContinued, { receipt: receiptOf(session.continued.segment, settings.session.receiptChars, texts) })] : []),
    ];
    const kinds = { new: TEXT.main.kindNew, regenerate: TEXT.main.kindRegenerate, swipe: TEXT.main.kindSwipe, continue: TEXT.main.kindContinue } as const;
    const message = texts.render(TEXT.main.turn, { kind: texts.render(kinds[turn.kind]), notes: notes.map((note) => `${note}\n\n`).join(""), count: texts.counted(document.messages, TEXT.word.message), request: document.text, ask: texts.render(writes ? TEXT.main.askWrites : TEXT.main.ask) });
    // past_turn reads what the agent carries, and, on a continue, what it did for this very reply before.
    const past = session.continued ? [...carried.turns, session.continued] : carried.turns;
    const tools = shared.tools.build(main.tools, { ...env, past, ...(writes ? {} : { writeReply: (brief: string, ctx: { agentId: string }) => this.writeReply(brief, ctx.agentId, env, deps) }) });
    const agent = startAgent({ role: AGENT.main, connectionId: main.connectionId, model: main.model, effort: main.effort, system: texts.render(writes ? TEXT.main.systemWrites : main.definition.instructions), prefix: [], tools, budget: main.budget, history }, deps);
    this.mainId = agent.id;
    const reply = await agent.send(message, this.signal);
    work.main = agent.transcript().entries;
    work.wrote = writes;
    return writes ? this.ownReply(reply) : this.briefed(reply, agent.id, env, deps, work);
  }

  /** The turn's signal ended it: nothing more of it is started. */
  private live(): void {
    if (this.signal.aborted) throw new Stopped();
  }

  /** An agent definition as this turn runs it. The core's own are always registered. */
  private resolved(id: string): ResolvedAgent {
    const agent = this.shared.agents.resolve(id, this.settings);
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
    if (reply.status === "cancelled") return { status: "stopped", reason: this.text(TEXT.progress.turnStopped) };
    return { status: "failed", reason: reply.reason ?? this.text(TEXT.answer.replyEmpty) };
  }

  /** The main agent's send ended while a writer writes the reply: by `write_reply` (the reply is written, or broke off), with an answer of its own (taken as the brief), or short of one. */
  private async briefed(reply: AgentReply, mainId: string, env: ToolEnv, deps: AgentDeps, work: Work): Promise<Outcome> {
    if (this.written) return { status: "done" };
    if (this.broken !== null) return { status: "failed", reason: this.broken };
    if (reply.status === "cancelled" || this.signal.aborted) return { status: "stopped", reason: this.text(TEXT.progress.turnStopped) };
    let brief: string | null = null;
    let short: string | undefined;
    if (reply.status === "answered" && reply.text.trim() !== "") {
      // It answered without calling write_reply: as its instructions say, its answer is its brief.
      brief = reply.text.trim();
      work.briefed = brief;
    } else {
      short = reply.reason ?? this.text(TEXT.answer.replyEmpty);
      if (this.settings.reply.withoutBrief === "fail") return { status: "failed", reason: short };
      // The reply's thinking block says so here, and the trace in what the writer is started for.
      this.progress(TEXT.progress.writingAlone, { reason: short });
    }
    const wrote = await this.write(brief, mainId, env, deps, short);
    if (wrote.ok) return { status: "done" };
    return wrote.stopped ? { status: "stopped", reason: this.text(TEXT.progress.turnStopped) } : { status: "failed", reason: wrote.reason };
  }

  // ---------------------------------------------------------------- the session's compaction

  /**
   * Summarizes all but the latest turns of what the main agent carries, in one call of the
   * summarizer's, and lands the summary. Null when there is nothing to fold or no summary stands
   * (the call failed, or its answer was cut): the session then goes on whole, and the next turn
   * tries again.
   */
  private async compact(carried: { summary: string | null; turns: readonly PastTurn[] }, env: ToolEnv, deps: AgentDeps): Promise<{ landed: Compaction; summary: string; kept: readonly PastTurn[] } | null> {
    const { settings, texts, shared } = this;
    const fold = foldOf(carried, { keep: settings.session.keepTurns, limit: settings.session.summaryTokens, receiptChars: settings.session.receiptChars, texts });
    if (!fold) return null;
    const summarizer = this.resolved(AGENT.summarizer);
    this.progress(TEXT.progress.compacting, { turns: texts.counted(fold.folded.length, TEXT.word.turn) });
    const key = await foldKey({ connectionId: summarizer.connectionId, model: summarizer.model, effort: summarizer.effort, callTokensOut: summarizer.budget.callTokensOut, system: fold.system, message: fold.message });
    const result = await shared.memo.run(key, async () => {
      const agent = startAgent({ role: AGENT.summarizer, connectionId: summarizer.connectionId, model: summarizer.model, effort: summarizer.effort, system: fold.system, prefix: [], tools: shared.tools.build(summarizer.tools, { ...env, agent: AGENT.summarizer }), budget: summarizer.budget, task: "summarize the main agent's notes" }, deps);
      return summaryOf(await agent.send(fold.message, this.signal), texts);
    });
    if ("failed" in result) {
      this.progress(TEXT.progress.notCompacted, { reason: result.failed });
      this.host.log("warn", `the main agent's notes weren't summarized (${result.failed}); they go on whole`);
      return null;
    }
    const landed = await shared.sessions.compact(result.summary, fold.kept, fold.folded.length);
    this.progress(TEXT.progress.compacted, { folded: texts.counted(fold.folded.length, TEXT.word.turn), kept: String(fold.kept.length) });
    return { landed, summary: result.summary, kept: fold.kept };
  }

  // ---------------------------------------------------------------- the writer

  /** `write_reply`: the writer writes from the main agent's brief, and its reply ends the main agent's send. */
  private async writeReply(brief: string, mainId: string, env: ToolEnv, deps: AgentDeps): Promise<ToolOutcome> {
    if (this.writing || this.written || this.broken !== null) return { text: this.text(TEXT.answer.replyBusy), error: true };
    const wrote = await this.write(brief, mainId, env, deps);
    if (wrote.ok) return { text: this.reply, end: true };
    // Part of the reply already reached the user: a second try would write a second reply after it, so the turn ends here, failed.
    if (this.reply !== "") {
      this.broken = wrote.reason;
      return { text: this.reply, end: true };
    }
    return { text: this.text(TEXT.answer.replyFailed, { reason: wrote.reason }), error: true };
  }

  /**
   * The writer's call (DESIGN §3.2): Lumiverse's assembled messages as they came, with the brief put
   * in (none when the main agent stopped short of one: `short` is why, which the trace tells as what
   * the writer was started for), the request's own sampling parameters and answer room, and the
   * tools Settings give the writer (none by default). Its answer streams to the sink as the reply.
   */
  private async write(brief: string | null, parent: string, env: ToolEnv, deps: AgentDeps, short?: string): Promise<Written> {
    const { turn, settings, texts, shared } = this;
    this.writing = true;
    try {
      const writer = this.resolved(AGENT.writer);
      if (brief !== null) this.progress(TEXT.progress.writing);
      const agent = startAgent(
        {
          role: AGENT.writer,
          connectionId: writer.connectionId,
          model: writer.model,
          effort: writer.effort,
          system: "",
          prefix: [],
          tools: shared.tools.build(writer.tools, { ...env, agent: AGENT.writer }),
          // The request's own answer room where it names one: the preset governs the prose as it does without LumiAH.
          budget: { ...writer.budget, callTokensOut: turn.maxTokens ?? writer.budget.callTokensOut },
          history: writerMessages(turn.messages, brief, settings.reply, texts),
          params: turn.params,
          onDelta: (delta) => this.delta(delta),
          parent,
          task: brief !== null ? "write the reply from the brief" : `write the reply without a brief: the main agent stopped short of one (${short ?? "no reason given"})`,
        },
        deps,
      );
      const reply = await agent.run(this.signal);
      if (reply.status !== "answered") return { ok: false, reason: reply.reason ?? texts.render(TEXT.answer.replyEmpty), stopped: reply.status === "cancelled" };
      // A host that streams nothing still gave the answer whole: what wasn't streamed is sent now.
      if (reply.text.startsWith(this.reply)) this.content(reply.text.slice(this.reply.length));
      if (this.reply.trim() === "") return { ok: false, reason: texts.render(TEXT.answer.replyEmpty), stopped: false };
      this.finish = reply.finish ?? "stop";
      this.written = true;
      return { ok: true };
    } finally {
      this.writing = false;
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

  private content(text: string): void {
    if (text === "") return;
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
    for (const call of entry.calls) this.progress(TEXT.progress.call, { tool: call.name, args: JSON.stringify(call.args) });
  }

  // ---------------------------------------------------------------- the record

  /**
   * The turn's record, its bodies stored: its segment of the session and its transcript. Null when no
   * reply text was sent (there is then no reply to anchor a record on) or the turn's session was
   * never read; and when its bodies can't be stored, which the log says.
   */
  private async record(work: Work, trace: TurnTrace, ended: { status: TurnStatus; at: number; reason?: string }, usage: AgentUsage): Promise<TurnRecord | null> {
    const { turn, settings, shared } = this;
    const { session } = work;
    if (this.reply === "" || !session) return null;
    try {
      const own = stepsOf(work, { reply: String(session.reply), chars: String(this.reply.length), texts: this.texts, stopped: ended.reason });
      const segment: SessionSegment = { v: 1, kind: "segment", reply: session.reply, generationId: turn.generationId, turn: turn.kind, at: ended.at, request: work.request, steps: [...(session.continued?.segment.steps ?? []), ...own] };
      const segmentHash = await shared.sessions.segment(segment);
      const transcript = settings.keep.transcripts ? await shared.blobs.putJson(trace.transcript({ generation: turn.kind, messageId: turn.target.messageId, startedAt: this.startedAt, ended }), false) : undefined;
      return { v: 1, generationId: turn.generationId, kind: turn.kind, at: ended.at, path: session.path, segment: segmentHash, ...(transcript !== undefined ? { transcript } : {}), ...(work.compaction ? { summary: work.compaction.summary, kept: work.compaction.kept, folded: work.compaction.folded } : {}), usage };
    } catch (error) {
      this.host.log("warn", `the turn's record wasn't made (${errorText(error)}): the reply stands, and the main agent's notes won't hold this turn`);
      return null;
    }
  }
}

/** What a turn's work leaves for its record. */
class Work {
  session: ResumedSession | null = null;
  compaction: Compaction | null = null;
  request: { messages: number; last: number | null } = { messages: 0, last: null };
  /** The main agent's transcript, once its send ended. */
  main: TranscriptEntry[] = [];
  /** The main agent wrote the reply itself. */
  wrote = false;
  /** Its own answer, taken as the brief because it never called `write_reply`. */
  briefed: string | null = null;
}

/**
 * The main agent's steps this turn, from its transcript: what it wrote beside its calls, each call
 * with what came back, and how it ended. The reply itself is never kept (it is in the chat):
 * `write_reply`'s result, which is the reply, is kept as a note of its length, and so is a reply the
 * main agent wrote itself. An answer taken as the brief is kept as the `write_reply` call it stood for.
 */
function stepsOf(work: Work, input: { reply: string; chars: string; texts: Texts; stopped: string | undefined }): SegmentStep[] {
  const { texts } = input;
  const written = texts.render(TEXT.session.replyWritten, { chars: input.chars, reply: input.reply });
  const results = new Map<string, Extract<TranscriptEntry, { kind: "result" }>>();
  for (const entry of work.main) if (entry.kind === "result") results.set(entry.callId, entry);
  const answers = work.main.filter((entry) => entry.kind === "answer");
  const steps: SegmentStep[] = [];
  for (const entry of work.main) {
    if (entry.kind === "stop") steps.push({ kind: "stop", reason: entry.reason });
    if (entry.kind !== "answer") continue;
    const final = entry === answers.at(-1) && entry.calls.length === 0;
    if (final && work.wrote) steps.push({ kind: "reply", chars: Number(input.chars) });
    else if (final && work.briefed !== null) steps.push({ kind: "call", name: TOOL.writeReply, args: { brief: work.briefed }, result: written });
    else if (entry.text.trim() !== "") steps.push({ kind: "said", text: entry.text });
    for (const call of entry.calls) {
      const result = results.get(call.id);
      if (!result) continue;
      const replied = call.name === TOOL.writeReply && !result.error;
      steps.push({ kind: "call", name: call.name, args: call.args, result: replied ? written : result.text, ...(result.error ? { error: true as const } : {}) });
    }
  }
  // A turn that ended short of its agents' own stop (its signal, a failure outside them) says so too.
  if (input.stopped !== undefined && !steps.some((step) => step.kind === "stop")) steps.push({ kind: "stop", reason: input.stopped });
  return steps;
}
