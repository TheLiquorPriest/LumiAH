// The agent loop (DESIGN §4.1). An agent starts from its spec (`startAgent`) and is talked to through
// its handle: each `send` gives it a message and runs its loop, calling the model, running the tools
// it calls (as many at once as its budget lets) and sending the results back, until it answers or a
// limit stops it. Every limit is a setting:
//
// - per call: the prompt's tokens, `max_tokens` (never more than the agent's or the turn's tokens
//   left), its time, and the tools one answer may call;
// - per agent: tokens in and out, rounds of tool calls, time from its first message, and revisions:
//   each message after its first answer counts against them;
// - per turn (`AgentTurn`, shared by a turn's agents): tokens in and out, rounds, time;
// - per connection (`AgentAccounts`): throttles.
//
// The loop detector stops an agent the moment it would make the same call with the same arguments
// a setting's number of times in a row, each on what it acts on as the one before found it: a tool
// whose arguments name something by where it stands now (`AgentTool.state`) makes a new call once
// that changed. A tool result past a setting's length reaches the model clipped, the whole kept in
// the agent's scratch for the built-in `scratch_read`. Cancel goes through the signals the host's
// calls take: the handle's own, a send's, and each deadline's.

import type { AgentStarted, AgentStatus, AgentStopCode, AgentUsage, CallUsage, HarnessHost, JsonObject, ModelDelta, ModelEffort, ModelMessage, ModelRequest, ModelTool, SamplingParams, TranscriptEntry } from "./ports";
import { type AgentAccounts, type AgentCall, AgentStop, type CallSpec, isTransient, type ModelReply, NATIVE_TURNS, type PreparedCall, ProviderSession, requestOf, TEXT_TURNS, type ToolResult, ToolsRefused } from "./provider";
import type { AgentBudget, Settings, TurnBudget } from "./settings";
import { SCRATCH_READ, TEXT, type Texts } from "./texts";
import type { AgentTool, ToolOutcome } from "./tools";
import { addCall, emptyUsage, toolTokens } from "./usage";
import { cutAt, errorText, jsonEqual, limitOf, timerMs, wholeArg } from "./util";

// ---------------------------------------------------------------- the contract

/**
 * An agent: the definition it runs as, the connection and model it runs on (null: the user's default
 * connection, the connection's model), its effort, its system prompt, the stable prefix it shares
 * with other agents (sent first, in order: where guidance files go), its tools and its budget.
 */
export interface AgentSpec {
  role: string;
  connectionId: string | null;
  model: string | null;
  effort: ModelEffort;
  system: string;
  prefix: string[];
  tools: AgentTool[];
  budget: AgentBudget;
  /**
   * The conversation it takes up, oldest first, sent after the opening and before the first message
   * it is sent: what the main agent carries from earlier turns, or, for the writer, Lumiverse's
   * assembled messages as they came. None of it counts as a message it was sent.
   */
  history?: readonly ModelMessage[];
  /** The sampling parameters its calls send; absent: the connection's own. */
  params?: SamplingParams;
  /** Where a streamed answer's text and reasoning go as they arrive; with it, its calls stream whatever Settings say. */
  onDelta?: (delta: ModelDelta) => void;
  /** The agent that started it, and what for, as the trace tells it. */
  parent?: string;
  task?: string;
}

export interface AgentReply {
  status: AgentStatus;
  /** The answer; short of one, what the model last said, if anything. */
  text: string;
  /** Why it isn't an answer, in a code and plain words. */
  code?: AgentStopCode;
  reason?: string;
  /** How this send's last model call ended, as its provider said (`stop`, `tool_calls`, …; `cutShort` reads a cut one); absent when no call came back. */
  finish?: string;
  /** What this send spent. */
  usage: AgentUsage;
}

/** Whether a call's finish reason says its answer was cut at its token limit, as the host passes each provider's on: OpenAI's `length` (`max_output_tokens` from its Responses API), Anthropic's `max_tokens`, Google's and Vertex's `MAX_TOKENS`. */
export function cutShort(finish: string | undefined): boolean {
  const f = finish?.toLowerCase();
  return f === "length" || f === "max_tokens" || f === "max_output_tokens";
}

export interface AgentTranscript {
  id: string;
  role: string;
  system: string;
  prefix: string[];
  /** How many messages of a conversation it took up (`AgentSpec.history`). */
  history: number;
  entries: TranscriptEntry[];
}

export interface AgentHandle {
  id: string;
  /** Sends it a message and runs its loop. */
  send(text: string, signal?: AbortSignal): Promise<AgentReply>;
  /** Runs its loop on the conversation as it stands, with no new message: for an agent whose conversation already ends with what it is to answer (the writer's). */
  run(signal?: AbortSignal): Promise<AgentReply>;
  cancel(): void;
  transcript(): AgentTranscript;
  usage(): AgentUsage;
}

/**
 * Hears everything a turn's agents do, for the live view and the turn's transcript: each agent as it
 * starts work, every step of its transcript as it is made, what each call spent, and when it
 * finishes a message. `prompt` keeps a call's exact request and gives its blob's hash (nothing while
 * Settings keep none). `delta` is for the live view alone: a piece of the answer of an agent's call
 * under way (`call`: counted from 1 as its `answer` entries are), never part of the transcript.
 */
export interface AgentTrace {
  start(agent: AgentStarted): void;
  entry(agentId: string, entry: TranscriptEntry): void;
  usage(agentId: string, call: CallUsage, agent: AgentUsage): void;
  idle(agentId: string, spent: AgentUsage): void;
  prompt(agentId: string, request: ModelRequest): Promise<string | undefined>;
  delta(agentId: string, call: number, piece: { text?: string; reasoning?: string }): void;
}

/** A turn's agents together: what they have spent against the turn's budget, and its time from when the turn began; `trace` hears everything they do. */
export class AgentTurn {
  /** What the turn's agents have spent together. */
  readonly usage = emptyUsage();

  constructor(
    readonly budget: TurnBudget,
    readonly startedAt: number,
    readonly trace: AgentTrace | null = null,
  ) {}
}

export interface AgentDeps {
  host: Pick<HarnessHost, "models" | "connections" | "clock" | "log">;
  settings: Readonly<Pick<Settings, "loop" | "cache" | "connections" | "prices" | "trace">>;
  /** The user's texts: each of the loop's texts sent to a model is theirs where they have one. */
  texts: Texts;
  accounts: AgentAccounts;
  /** The turn the agent works in; null outside one. */
  turn: AgentTurn | null;
}

export function startAgent(spec: AgentSpec, deps: AgentDeps): AgentHandle {
  return new Agent(spec, deps);
}

// ---------------------------------------------------------------- the loop

const STATUS: Readonly<Partial<Record<AgentStopCode, AgentStatus>>> = { cancelled: "cancelled", failed: "failed", loop: "stopped" };

/** The loop detector's run, this send: the last call, its tool's state as the call found it (`AgentTool.state`; null for a tool without one), and how many times in a row it was made. */
interface LoopRun {
  call: AgentCall | null;
  state: number | null;
  times: number;
}

class Agent implements AgentHandle {
  /** Eight hex digits of a random id: enough to tell a turn's agents apart, short enough to read in the live view. Not a setting: it is a name, not a limit. */
  readonly id = `agent_${crypto.randomUUID().slice(0, 8)}`;
  /** Ends every call and tool run of the agent: `cancel`. */
  private readonly controller = new AbortController();
  private readonly session: ProviderSession;
  private readonly callSpec: CallSpec;
  private readonly tools = new Map<string, AgentTool>();
  private readonly offered: ModelTool[];
  /** What its tools weigh in each call's prompt (`toolTokens`): the same on every call, since every call offers the same tools. */
  private readonly offeredTokens: number;
  /** What the model is sent after its opening: the conversation it took up, the messages, its answers, the results. */
  private readonly conversation: ModelMessage[];
  private readonly entries: TranscriptEntry[] = [];
  private readonly total = emptyUsage();
  /** Whole results that went to the model clipped, by handle. */
  private readonly scratch = new Map<string, string>();
  private startedAt: number | null = null;
  private answered = false;
  private revisions = 0;
  private busy = false;
  /** A tool's result this round that ends the send (`ToolOutcome.end`): its text is the answer. */
  private ending: string | null = null;
  /** Text of this send's answer went on to whoever takes it as it streams (`AgentSpec.onDelta`): it can't be taken back, so no call of this send is made again. */
  private sentOn = false;
  /** The live view is sent this agent's answers as they stream (`AgentTrace.delta`). */
  private readonly watched: boolean;
  /** What the call under way has brought since the live view was last sent some, and when that was (null: not yet); null while no call is under way. */
  private live: { text: string; reasoning: string; sentAt: number | null } | null = null;
  /** How many of its model calls have answered: the call under way is the next, the count its `answer` entries follow. */
  private answers = 0;

  constructor(
    private readonly spec: AgentSpec,
    private readonly deps: AgentDeps,
  ) {
    const { settings } = deps;
    const { onDelta } = spec;
    // The live view watches a call that streams anyway (Settings' Streaming, or an answer taken as it streams): watching never makes a call stream.
    this.watched = settings.trace.deltaMs > 0 && Boolean(deps.turn?.trace) && (settings.loop.stream || onDelta !== undefined);
    const streamed =
      onDelta || this.watched
        ? (delta: ModelDelta): void => {
            if (onDelta) {
              if (delta.content !== undefined && delta.content !== "") this.sentOn = true;
              onDelta(delta);
            }
            this.piece(delta);
          }
        : undefined;
    this.callSpec = { connectionId: spec.connectionId, model: spec.model, effort: spec.effort, system: spec.system, prefix: spec.prefix, cache: settings.cache, ...(spec.params ? { params: spec.params } : {}), ...(streamed ? { onDelta: streamed } : {}) };
    this.session = new ProviderSession(deps, this.callSpec);
    this.conversation = [...(spec.history ?? [])];
    for (const tool of spec.tools) this.tools.set(tool.name, tool);
    // An agent with tools gets scratch_read, for the results that come back clipped; it takes its name over any tool of the spec's.
    if (this.tools.size > 0) this.tools.set(SCRATCH_READ, this.scratchRead());
    this.offered = [...this.tools.values()].map((t) => ({ name: t.name, description: t.description, parameters: t.parameters }));
    this.offeredTokens = toolTokens(this.offered, settings.loop.charsPerToken);
    deps.turn?.trace?.start({ id: this.id, role: spec.role, connectionId: spec.connectionId, model: spec.model, effort: spec.effort, system: spec.system, prefix: [...spec.prefix], history: this.conversation.length, ...(spec.parent !== undefined ? { parent: spec.parent } : {}), ...(spec.task !== undefined ? { task: spec.task } : {}), at: this.now() });
  }

  private now(): number {
    return this.deps.host.clock.now();
  }

  private text(id: string, vars: Readonly<Record<string, string>> = {}): string {
    return this.deps.texts.render(id, vars);
  }

  send(text: string, signal?: AbortSignal): Promise<AgentReply> {
    return this.work(text, signal);
  }

  run(signal?: AbortSignal): Promise<AgentReply> {
    return this.work(null, signal);
  }

  /** One message's work: the message joins the conversation (none for `run`), and the loop runs on it. */
  private async work(text: string | null, signal: AbortSignal | undefined): Promise<AgentReply> {
    const used = emptyUsage();
    if (this.controller.signal.aborted) return this.end(used, new AgentStop("cancelled", { id: TEXT.stop.cancelled }));
    if (this.busy) return this.end(used, new AgentStop("busy", { id: TEXT.stop.busy }));
    if (this.answered) {
      if (this.revisions >= this.spec.budget.revisions) return this.end(used, new AgentStop("revisions", { id: TEXT.stop.revisions, vars: { revisions: this.deps.texts.counted(this.spec.budget.revisions, TEXT.word.revision) } }));
      this.revisions += 1;
    }
    this.busy = true;
    this.ending = null;
    this.sentOn = false;
    this.startedAt ??= this.now();
    if (text !== null) {
      this.conversation.push({ role: "user", content: text });
      this.record({ kind: "message", text, at: this.now() });
    }
    try {
      return await this.loop(used, signal);
    } catch (error) {
      // Nothing the loop awaits should throw past its own handling; if something does, the send still ends as a failure on the record.
      return this.end(used, error instanceof AgentStop ? error : new AgentStop("failed", { id: TEXT.stop.failed, vars: { error: errorText(error) } }));
    } finally {
      this.busy = false;
      this.deps.turn?.trace?.idle(this.id, { ...this.total });
    }
  }

  /** A step of its work joins its transcript, and the turn's trace hears it. */
  private record(entry: TranscriptEntry): void {
    this.entries.push(entry);
    if (entry.kind === "answer") this.answers += 1;
    this.deps.turn?.trace?.entry(this.id, entry);
  }

  /**
   * A piece of the answer of the call under way, for the live view: sent on at most once in
   * Settings' interval, with whatever arrived since the last. No timer runs for what is left: it
   * goes with the next piece once the interval is up, or when the call ends (`closeLive`), so
   * nothing of a call outlives it.
   */
  private piece(delta: ModelDelta): void {
    const live = this.live;
    if (!live) return;
    live.text += delta.content ?? "";
    live.reasoning += delta.reasoning ?? "";
    if (live.sentAt === null || this.now() - live.sentAt >= this.deps.settings.trace.deltaMs) this.flush(live);
  }

  private flush(live: { text: string; reasoning: string; sentAt: number | null }): void {
    if (live.text === "" && live.reasoning === "") return;
    this.deps.turn?.trace?.delta(this.id, this.answers + 1, { ...(live.text !== "" ? { text: live.text } : {}), ...(live.reasoning !== "" ? { reasoning: live.reasoning } : {}) });
    live.text = "";
    live.reasoning = "";
    live.sentAt = this.now();
  }

  /** The call under way is over: what is left of its answer goes to the live view before the entry that closes it (its answer, or why it has none). */
  private closeLive(): void {
    if (this.live) this.flush(this.live);
    this.live = null;
  }

  cancel(): void {
    this.controller.abort(new AgentStop("cancelled", { id: TEXT.stop.cancelled }));
  }

  transcript(): AgentTranscript {
    return { id: this.id, role: this.spec.role, system: this.spec.system, prefix: [...this.spec.prefix], history: this.spec.history?.length ?? 0, entries: [...this.entries] };
  }

  usage(): AgentUsage {
    return { ...this.total };
  }

  /** Calls the model and runs the tools it calls until it answers or a limit stops it. */
  private async loop(used: AgentUsage, signal: AbortSignal | undefined): Promise<AgentReply> {
    const { budget } = this.spec;
    const { turn, settings } = this.deps;
    const repeat: LoopRun = { call: null, state: null, times: 0 };
    let said = "";
    let finish: string | undefined;
    // How many times the call under way was made again: a call that answers starts the count afresh.
    let retried = 0;
    for (;;) {
      const late = this.timeUp();
      if (late) return this.end(used, late, said, finish);
      let prepared: PreparedCall;
      try {
        prepared = await this.session.prepare(this.conversation, this.offered);
      } catch (error) {
        return this.end(used, this.why(error, this.controller.signal), said, finish);
      }
      const over = this.overBudget(prepared);
      if (over) return this.end(used, over, said, finish);
      const outLeft = Math.min(limitOf(budget.tokensOut) - this.total.out, turn ? limitOf(turn.budget.tokensOut) - turn.usage.out : Number.POSITIVE_INFINITY);
      const request = requestOf(this.callSpec, prepared, Math.min(budget.callTokensOut, outLeft), settings);
      // Kept while the call is made, so keeping it never holds the call up; a prompt that can't be kept is left off the record.
      const kept = turn?.trace?.prompt(this.id, request).catch(() => undefined) ?? Promise.resolve(undefined);
      const scope = this.scope(signal, true);
      const sentAt = this.now();
      let reply: ModelReply;
      this.live = this.watched ? { text: "", reasoning: "", sentAt: null } : null;
      try {
        reply = await this.session.send(prepared, request, scope.signal);
      } catch (error) {
        this.closeLive();
        const prompt = await kept;
        if (error instanceof ToolsRefused) {
          // The connection takes no native tools: the same round again, with them as text, the refusal on the record.
          this.record({ kind: "tools_refused", reason: error.message, ms: this.now() - sentAt, at: this.now(), ...(prompt !== undefined ? { prompt } : {}) });
          this.session.refuseNativeTools(error.message);
          continue;
        }
        const stop = this.why(error, scope.signal);
        // A failure that passes is the call's to make again, as often as Settings allow. Never a call
        // a limit or a cancel stopped (`why` reads those first), and never once any of the answer was
        // sent on: that can't be taken back, and a second try would write after it.
        if (stop.code !== "failed" || this.sentOn || retried >= settings.loop.retries || !isTransient(error)) return this.end(used, stop, said, finish, prompt);
        retried += 1;
        // The call is over, so its own deadline ends here; the wait keeps the agent's and the turn's.
        scope.clear();
        this.record({ kind: "retry", reason: errorText(error), attempt: retried, of: settings.loop.retries, waitMs: settings.loop.retryWaitMs, ms: this.now() - sentAt, at: this.now(), ...(prompt !== undefined ? { prompt } : {}) });
        const stopped = await this.pause(settings.loop.retryWaitMs, signal);
        if (stopped) return this.end(used, stopped, said, finish);
        continue;
      } finally {
        scope.clear();
      }
      this.closeLive();
      retried = 0;
      const prompt = await kept;
      addCall(reply.usage, reply.ms, this.total, used, ...(turn ? [turn.usage] : []));
      turn?.trace?.usage(this.id, reply.usage, { ...this.total });
      said = reply.text;
      finish = reply.finishReason;
      this.record({
        kind: "answer",
        text: reply.text,
        ...(reply.reasoning ? { reasoning: reply.reasoning } : {}),
        calls: reply.calls.map((c) => ({ id: c.id, name: c.name, args: c.args })),
        written: reply.written,
        tools: prepared.names.size === 0 ? "none" : prepared.textTools ? "text" : "native",
        ...(prepared.names.size > 0 ? { offered: { tools: prepared.names.size, tokens: this.offeredTokens } } : {}),
        usage: reply.usage,
        model: reply.model,
        finishReason: reply.finishReason,
        ms: reply.ms,
        at: this.now(),
        ...(prompt !== undefined ? { prompt } : {}),
      });
      if (reply.calls.length === 0) {
        this.answered = true;
        this.conversation.push({ role: "assistant", content: reply.text });
        return { status: "answered", text: reply.text, finish, usage: { ...used } };
      }
      // No round runs once the time it would run in is gone.
      const stop = this.roundStop(reply.calls, repeat) ?? this.timeUp();
      if (stop) {
        // The calls aren't run, so the model's turn goes on record as what it said.
        if (reply.text !== "") this.conversation.push({ role: "assistant", content: reply.text });
        return this.end(used, stop, said, finish);
      }
      this.total.toolTurns += 1;
      used.toolTurns += 1;
      if (turn) turn.usage.toolTurns += 1;
      const tools = this.scope(signal, false);
      let results: ToolResult[];
      try {
        results = await this.runCalls(reply.calls, tools.signal);
      } finally {
        tools.clear();
      }
      const encoding = reply.written ? TEXT_TURNS : NATIVE_TURNS;
      this.conversation.push(encoding.assistant(reply), encoding.results(results, this.deps.texts));
      if (tools.signal.aborted) return this.end(used, this.why(tools.signal.reason, tools.signal), said, finish);
      if (this.ending !== null) {
        const text = this.ending;
        this.ending = null;
        this.answered = true;
        return { status: "answered", text, finish, usage: { ...used } };
      }
    }
  }

  /** The agent's or the turn's time, run out before a call. */
  private timeUp(): AgentStop | null {
    const now = this.now();
    if (now - (this.startedAt ?? now) >= limitOf(this.spec.budget.wallMs)) return new AgentStop("wall_time", { id: TEXT.stop.wallTime });
    const turn = this.deps.turn;
    if (turn && now - turn.startedAt >= limitOf(turn.budget.wallMs)) return new AgentStop("turn_time", { id: TEXT.stop.turnTime });
    return null;
  }

  /** A call its prompt's estimate, or the tokens already spent, put past a budget. A limit a stop names is one that was passed, so it is always a number: no limit never stops a call. */
  private overBudget(p: PreparedCall): AgentStop | null {
    const { budget } = this.spec;
    const turn = this.deps.turn;
    const { texts } = this.deps;
    if (p.estimate > limitOf(budget.callTokensIn)) return new AgentStop("call_tokens_in", { id: TEXT.stop.callTokensIn, vars: { tokens: texts.counted(p.estimate, TEXT.word.token), limit: String(budget.callTokensIn) } });
    if (this.total.in + p.estimate > limitOf(budget.tokensIn)) return new AgentStop("tokens_in", { id: TEXT.stop.tokensIn, vars: { limit: String(budget.tokensIn) } });
    if (this.total.out >= limitOf(budget.tokensOut)) return new AgentStop("tokens_out", { id: TEXT.stop.tokensOut, vars: { tokens: texts.counted(limitOf(budget.tokensOut), TEXT.word.token) } });
    if (turn && turn.usage.in + p.estimate > limitOf(turn.budget.tokensIn)) return new AgentStop("turn_tokens_in", { id: TEXT.stop.turnTokensIn, vars: { limit: String(turn.budget.tokensIn) } });
    if (turn && turn.usage.out >= limitOf(turn.budget.tokensOut)) return new AgentStop("turn_tokens_out", { id: TEXT.stop.turnTokensOut, vars: { tokens: texts.counted(limitOf(turn.budget.tokensOut), TEXT.word.token) } });
    return null;
  }

  /** Why a round of calls isn't run: the loop detector, or the agent's or the turn's rounds spent. */
  private roundStop(calls: readonly AgentCall[], repeat: LoopRun): AgentStop | null {
    const { settings, turn } = this.deps;
    for (const call of calls) {
      // A tool whose state changed since the call before is asked something new, whatever its arguments.
      const state = this.tools.get(call.name)?.state?.() ?? null;
      const same = repeat.call !== null && repeat.call.name === call.name && jsonEqual(repeat.call.args, call.args) && repeat.state === state;
      repeat.times = same ? repeat.times + 1 : 1;
      repeat.call = call;
      repeat.state = state;
      if (repeat.times >= settings.loop.repeats) return new AgentStop("loop", { id: TEXT.stop.loop, vars: { tool: call.name, times: this.deps.texts.counted(repeat.times, TEXT.word.time) } });
    }
    if (this.total.toolTurns >= limitOf(this.spec.budget.toolTurns)) return new AgentStop("tool_turns", { id: TEXT.stop.toolTurns, vars: { rounds: this.deps.texts.counted(limitOf(this.spec.budget.toolTurns), TEXT.word.round) } });
    if (turn && turn.usage.toolTurns >= limitOf(turn.budget.toolTurns)) return new AgentStop("turn_tool_turns", { id: TEXT.stop.turnToolTurns, vars: { rounds: this.deps.texts.counted(limitOf(turn.budget.toolTurns), TEXT.word.round) } });
    return null;
  }

  /**
   * The signal a call (`call`) or a round's tool runs go with: ended by `cancel`, by the send's own
   * signal, and by each deadline left: the agent's time, the turn's and, for a call, its own. The
   * deadlines wait on the host's clock, and `clear` ends their waits once the call or the round is over.
   */
  private scope(signal: AbortSignal | undefined, call: boolean): { signal: AbortSignal; clear(): void } {
    const { clock } = this.deps.host;
    const sources: AbortSignal[] = [this.controller.signal, ...(signal ? [signal] : [])];
    const over = new AbortController();
    const deadline = (left: number, stop: AgentStop): void => {
      const ms = timerMs(left);
      if (ms === null) return;
      const ends = new AbortController();
      clock.sleep(ms, over.signal).then(
        () => ends.abort(stop),
        () => undefined,
      );
      sources.push(ends.signal);
    };
    const now = this.now();
    const turn = this.deps.turn;
    deadline(limitOf(this.spec.budget.wallMs) - (now - (this.startedAt ?? now)), new AgentStop("wall_time", { id: TEXT.stop.wallTime }));
    if (turn) deadline(limitOf(turn.budget.wallMs) - (now - turn.startedAt), new AgentStop("turn_time", { id: TEXT.stop.turnTime }));
    if (call) deadline(limitOf(this.spec.budget.callMs), new AgentStop("call_time", { id: TEXT.stop.callTime }));
    return { signal: AbortSignal.any(sources), clear: () => over.abort() };
  }

  /**
   * The wait before a call is made again, on the host's clock. A cancel, the send's own signal, and
   * the agent's and the turn's time end it early: it then gives what stopped it.
   */
  private async pause(ms: number, signal: AbortSignal | undefined): Promise<AgentStop | null> {
    const wait = this.scope(signal, false);
    try {
      wait.signal.throwIfAborted();
      if (ms > 0) await this.deps.host.clock.sleep(ms, wait.signal);
      return null;
    } catch (error) {
      return this.why(error, wait.signal);
    } finally {
      wait.clear();
    }
  }

  /** What stopped a call: a refusal or a deadline (as thrown, or as the signal's reason), a cancel, or a failure. */
  private why(error: unknown, signal: AbortSignal): AgentStop {
    if (error instanceof AgentStop) return error;
    if (signal.aborted) return signal.reason instanceof AgentStop ? signal.reason : new AgentStop("cancelled", { id: TEXT.stop.cancelled });
    return new AgentStop("failed", { id: TEXT.stop.failed, vars: { error: errorText(error) } });
  }

  /** The run stopped: its transcript says why, in the user's words for the stop, with the prompt of the call that was under way, if one was. */
  private end(used: AgentUsage, stop: AgentStop, said = "", finish?: string, prompt?: string): AgentReply {
    const status = STATUS[stop.code] ?? "refused";
    const reason = this.text(stop.text.id, stop.text.vars);
    this.record({ kind: "stop", status, code: stop.code, reason, at: this.now(), ...(prompt !== undefined ? { prompt } : {}) });
    return { status, text: said, code: stop.code, reason, ...(finish !== undefined ? { finish } : {}), usage: { ...used } };
  }

  /** A round's calls, as many at once as the budget lets, results in the calls' order. */
  private async runCalls(calls: readonly AgentCall[], signal: AbortSignal): Promise<ToolResult[]> {
    const { budget } = this.spec;
    const results: ToolResult[] = [];
    let next = 0;
    const worker = async (): Promise<void> => {
      while (next < calls.length) {
        const at = next++;
        const call = calls[at];
        if (call) results[at] = await this.runCall(call, at < limitOf(budget.callTools), signal);
      }
    };
    await Promise.all(Array.from({ length: Math.min(budget.concurrency, calls.length) }, worker));
    return results;
  }

  /** One call's result: its tool's outcome (a failure as one), or, past Tool calls per answer (`allowed` false), a note that it wasn't run. */
  private async runCall(call: AgentCall, allowed: boolean, signal: AbortSignal): Promise<ToolResult> {
    const t0 = this.now();
    const tool = this.tools.get(call.name);
    let outcome: ToolOutcome;
    if (!allowed) outcome = { text: this.text(TEXT.runtime.tooManyCalls, { limit: String(this.spec.budget.callTools), tools: this.deps.texts.noun(limitOf(this.spec.budget.callTools), TEXT.word.tool), name: call.name }), error: true };
    else if (!tool) outcome = { text: this.text(TEXT.runtime.unknownTool, { name: call.name, tools: [...this.tools.keys()].join(", ") }), error: true };
    else {
      try {
        outcome = await tool.run(call.args, { signal, agentId: this.id, role: this.spec.role, callId: call.id });
      } catch (error) {
        outcome = { text: this.text(TEXT.runtime.toolFailed, { name: call.name, error: errorText(error) }), error: true };
      }
    }
    // What ends the send is the answer, never a result the model reads on from: it isn't clipped.
    const ends = outcome.end === true && outcome.error !== true;
    const kept = call.name === SCRATCH_READ || ends ? null : this.clip(outcome.text);
    const text = kept?.text ?? outcome.text;
    this.record({ kind: "result", callId: call.id, name: call.name, text, error: outcome.error === true, ...(kept ? { scratch: kept.handle } : {}), ms: this.now() - t0, at: this.now() });
    if (ends) this.ending = outcome.text;
    return { call, text, error: outcome.error === true };
  }

  /** A result past Tool results clipped past: its start for the model, the whole in scratch. */
  private clip(text: string): { text: string; handle: string } | null {
    const max = this.deps.settings.loop.clipChars;
    if (text.length <= max) return null;
    const shown = cutAt(text, max);
    const handle = `s${this.scratch.size + 1}`;
    this.scratch.set(handle, text);
    return { text: `${text.slice(0, shown)}\n${this.text(TEXT.runtime.clipped, { shown: String(shown), total: String(text.length), handle })}`, handle };
  }

  /** The built-in `scratch_read`: the next part of a clipped result, at most Tool results clipped past at a time. */
  private scratchRead(): AgentTool {
    const max = this.deps.settings.loop.clipChars;
    return {
      name: SCRATCH_READ,
      description: this.text(TEXT.runtime.scratchRead),
      parameters: {
        type: "object",
        properties: {
          handle: { type: "string", description: this.text(TEXT.runtime.scratchHandle) },
          offset: { type: "integer", minimum: 0, description: this.text(TEXT.runtime.scratchOffset) },
          length: { type: "integer", minimum: 1, maximum: max, description: this.text(TEXT.runtime.scratchLength, { max: String(max) }) },
        },
        required: ["handle"],
      },
      run: async (args: JsonObject) => {
        const handle = typeof args.handle === "string" ? args.handle : "";
        const whole = this.scratch.get(handle);
        if (whole === undefined) return { text: this.text(TEXT.runtime.scratchMissing, { handle, handles: [...this.scratch.keys()].join(", ") || this.text(TEXT.session.none) }), error: true };
        // An offset or length that isn't a whole number reads as none: the start, and as much as one read returns.
        const from = Math.min(Math.max(0, wholeArg(args.offset) ?? 0), whole.length);
        const length = Math.min(Math.max(1, wholeArg(args.length) ?? max), max);
        const to = cutAt(whole, Math.min(whole.length, from + length));
        return { text: this.text(TEXT.runtime.scratchPart, { handle, from: String(from), to: String(to), total: String(whole.length), text: whole.slice(from, to) }) };
      },
    };
  }
}
