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
// The loop detector stops an agent once it has made the same call with the same arguments a
// setting's number of times in a row and got the same result each time, each on what it acts on as
// the one before found it: a tool whose arguments name something by where it stands now
// (`AgentTool.state`) makes a new call once that changed. The same call made more than once in one
// answer is run once, and of one answer's calls that would end the send only the first is run. A
// tool result past a setting's length (or past the length its tool reads whole, `AgentTool.wholeChars`,
// where that is more) reaches the model clipped, and one past the room left in the agent's next call
// under Prompt per call is cut to that room; either way the whole is kept as a blob (in the agent's
// own memory where it has no blob store) for the built-in `scratch_read`. Cancel goes through the
// signals the host's calls take: the handle's own, a send's, and each deadline's. Once one of them
// has ended a round, no call of it that had not begun is started.

import { approvalAnswerOf } from "./approval";
import type { Blobs } from "./blobs";
import type { AgentStarted, AgentStatus, AgentStopCode, AgentUsage, ApprovalAnswer, ApprovalAsk, CallUsage, HarnessHost, JsonObject, ModelDelta, ModelEffort, ModelMessage, ModelRequest, ModelTool, SamplingParams, TranscriptEntry } from "./ports";
import { type AgentAccounts, type AgentCall, AgentStop, type CallSpec, isTransient, type ModelReply, NATIVE_TURNS, type PreparedCall, ProviderSession, requestOf, TEXT_TURNS, type ToolResult, ToolsRefused, type ToolTurnEncoding } from "./provider";
import type { AgentBudget, Settings, ToolCalls, TurnBudget } from "./settings";
import { SCRATCH_READ, TEXT, type Texts } from "./texts";
import type { AgentTool, ToolOutcome } from "./tools";
import { addCall, countedIn, emptyUsage, messageText, parseUsage, priced, toolTokens } from "./usage";
import { cutAt, errorText, jsonEqual, type Limit, limitOf, timerMs, tokensOf, wholeArg } from "./util";

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
  /** How its tools are offered to its model; absent: natively, and as text once its connection refused them. */
  toolCalls?: ToolCalls;
  /**
   * Its calls are made whatever a cap from outside the run says (`AgentTurn.limits`): the writer's
   * call of the reply the user waits for. A cap stops agents' work, never that reply. Such a call
   * still holds its place against the caps and is recorded as every call is.
   */
  uncapped?: true;
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
  /** Told as each of its model calls comes back: the answer's text, and how many tool calls it made (none: it is the agent's answer). */
  onCall?: (answer: { text: string; calls: number }) => void;
  /** The agent that started it, and what for, as the trace tells it. */
  parent?: string;
  task?: string;
  /** Which instance of its definition it is, where whoever started it said (`as`, §14): its tools are told it with the rest of who called. */
  as?: string;
  /**
   * What the user said to it since it last looked (DESIGN §18): asked at the start of each round,
   * and whatever it gives joins the conversation there, marked as the user's. Absent: nobody talks
   * to this agent while it works.
   */
  notes?: () => string[];
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
  /** The conversation as the model has it after its opening: what it took up, each message it was sent, its answers and their results. A new agent given it as its history goes on from here. */
  messages(): ModelMessage[];
  usage(): AgentUsage;
}

/**
 * Hears everything a run's agents do, for the live view and the run's transcript: each agent as it
 * starts work, every step of its transcript as it is made, what each call spent (and on which
 * connection and model), and when it finishes a message. `prompt` keeps a call's exact request and
 * gives its blob's hash (nothing while Settings keep none). `delta` is for the live view alone: a
 * piece of the answer of an agent's call under way (`call`: counted from 1 as its `answer` entries
 * are), never part of the transcript.
 */
export interface AgentTrace {
  start(agent: AgentStarted): void;
  entry(agentId: string, entry: TranscriptEntry): void;
  usage(agentId: string, call: CallUsage, agent: AgentUsage, on: { connection: string; model: string }): void;
  idle(agentId: string, spent: AgentUsage): void;
  prompt(agentId: string, request: ModelRequest): Promise<string | undefined>;
  delta(agentId: string, call: number, piece: { text?: string; reasoning?: string }): void;
}

/** The texts a run's own budget stops its agents with: a turn's, or a job's, each in its own words. */
export interface RunWords {
  tokensIn: string;
  tokensOut: string;
  toolTurns: string;
  time: string;
}

const TURN_WORDS: RunWords = { tokensIn: TEXT.stop.turnTokensIn, tokensOut: TEXT.stop.turnTokensOut, toolTurns: TEXT.stop.turnToolTurns, time: TEXT.stop.turnTime };

/**
 * How soon a time limit is looked at again while the time it counts stands still (the run is held,
 * or a call waits for the user's word). Fixed, not a setting: it limits nothing; it only keeps a
 * held agent with a moment left from waking every moment, and the most it can add to a limit is
 * itself, once.
 */
const STILL_MS = 250;

/**
 * A run's agents together (a turn's, a job's, a side session turn's): what they have spent against
 * the run's budget, and its time from when it began; `trace` hears everything they do. The user may
 * hold the run (DESIGN §18): every agent of it then waits at the start of its next round until the
 * run is let go, and the time it is held doesn't count against any time limit.
 */
export class AgentTurn {
  /** What the run's agents have spent together. */
  readonly usage = emptyUsage();
  /**
   * A cap from outside the run's own budget (spend, §20), asked before every call of its agents
   * about that call: its prompt as estimated, and its model. What stops the call; or the hold the
   * call has on the cap while it is under way, so that agents at work at once never pass it
   * together, let go once the call is on the record. `always`: the call is made whatever the cap
   * says (`AgentSpec.uncapped`), and is only held.
   */
  limits: ((call: { estimate: number; model: string; always: boolean }) => AgentStop | (() => void) | null) | null = null;
  /** Told when an agent of the run comes to rest on the user's hold: by then what it has done is whole, so whoever keeps the run's session keeps it now (§22). */
  onHeld: (() => void) | null = null;
  private pausedAt: number | null = null;
  private pausedFor = 0;
  private waiting: (() => void)[] = [];

  constructor(
    readonly budget: TurnBudget,
    readonly startedAt: number,
    readonly trace: AgentTrace | null = null,
    readonly words: RunWords = TURN_WORDS,
  ) {}

  get paused(): boolean {
    return this.pausedAt !== null;
  }

  /** Holds the run from `now`; false when it is held already. */
  pause(now: number): boolean {
    if (this.pausedAt !== null) return false;
    this.pausedAt = now;
    return true;
  }

  /** Lets the run go on; false when it wasn't held. */
  resume(now: number): boolean {
    if (this.pausedAt === null) return false;
    this.pausedFor += now - this.pausedAt;
    this.pausedAt = null;
    for (const go of this.waiting.splice(0)) go();
    return true;
  }

  /** How long the run has been held in all, up to `now`. */
  held(now: number): number {
    return this.pausedFor + (this.pausedAt === null ? 0 : now - this.pausedAt);
  }

  /** Waits while the run is held; rejects with the signal's reason when that ends first. */
  hold(signal: AbortSignal): Promise<void> {
    if (this.pausedAt === null) return Promise.resolve();
    if (signal.aborted) return Promise.reject(signal.reason);
    const { promise, resolve, reject } = Promise.withResolvers<void>();
    const go = (): void => {
      signal.removeEventListener("abort", stop);
      resolve();
    };
    const stop = (): void => {
      this.waiting = this.waiting.filter((w) => w !== go);
      reject(signal.reason);
    };
    this.waiting.push(go);
    signal.addEventListener("abort", stop, { once: true });
    this.onHeld?.();
    return promise;
  }
}

/**
 * Approval as the loop holds a call by it (DESIGN §17): whether a tool's calls wait for the user's
 * word, how long, and how to ask. `ask` is absent where there is no way to ask: a call that needs
 * a word is then refused. The run's own signal ends an ask; so does its wait running out. What an
 * ask gives is read as outside data (`approvalAnswerOf`): null, like anything else that isn't
 * exactly an approval or a refusal, is no word, and the call isn't run.
 */
export interface ApprovalGate {
  asks(tool: AgentTool): boolean;
  /** How long a held call waits, in milliseconds; null: until its run ends. */
  waitMs: Limit;
  ask?(ask: Omit<ApprovalAsk, "turn" | "chatId">, signal: AbortSignal): Promise<ApprovalAnswer | null>;
}

export interface AgentDeps {
  host: Pick<HarnessHost, "models" | "connections" | "clock" | "log">;
  settings: Readonly<Pick<Settings, "loop" | "cache" | "connections" | "prices" | "trace" | "spend">>;
  /** The user's texts: each of the loop's texts sent to a model is theirs where they have one. */
  texts: Texts;
  accounts: AgentAccounts;
  /** The run the agent works in; null outside one. */
  turn: AgentTurn | null;
  /** Absent: every call runs. */
  approval?: ApprovalGate;
  /** Where the whole of a tool result that reaches the model clipped is kept, for `scratch_read` to read back: the run's blobs. Absent: in the agent's own memory, for as long as the agent lives. */
  blobs?: Pick<Blobs, "put" | "get">;
}

export function startAgent(spec: AgentSpec, deps: AgentDeps): AgentHandle {
  return new Agent(spec, deps);
}

// ---------------------------------------------------------------- the loop

const STATUS: Readonly<Partial<Record<AgentStopCode, AgentStatus>>> = { cancelled: "cancelled", failed: "failed", loop: "stopped" };

/** A tool result's whole text as the agent holds it: the text itself, or, for one kept as a blob, the blob's hash. */
type Whole = { hash: string } | { text: string };

/** Whether two results are the same text: a blob's hash is its text's, so the same hash is the same text. A result whose whole couldn't be kept (null) is never taken for another. */
function sameWhole(a: Whole | null, b: Whole | null): boolean {
  if (a === null || b === null) return false;
  return "hash" in a ? "hash" in b && a.hash === b.hash : "text" in b && a.text === b.text;
}

/**
 * The loop detector's run, this send: the last call, its tool's state as the call found it
 * (`AgentTool.state`; null for a tool without one, and for a call that never reached its tool), what
 * came of it, and how many times in a row the same call came to the same on the same state.
 */
interface LoopRun {
  call: AgentCall | null;
  state: number | null;
  whole: Whole | null;
  error: boolean;
  times: number;
}

/**
 * A call of a round as it came out: its result as the model is sent it; what the loop detector tells
 * it from the call before it by (its tool's state as the call found it, and its result's whole
 * text); for a result the model got clipped, where the whole is kept, as the call's transcript entry
 * says it; and whether the answer had made the same call before (`again`: it was given that call's
 * result, and nothing was run for it).
 */
interface RoundCall {
  result: ToolResult;
  state: number | null;
  whole: Whole | null;
  scratch?: string;
  again?: true;
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
  /** The results that went to the model clipped or cut, by handle: where the whole of each is kept, and how much of it one `scratch_read` gives (as much as its tool gives whole). */
  private readonly scratch = new Map<string, { whole: Whole; per: number }>();
  /** The room the round's results have left in the agent's next call, in characters, where Prompt per call limits it (`roomOf`); endless where it doesn't. */
  private room = Number.POSITIVE_INFINITY;
  /** Its start on the trace (`begin`), asked for by its first message; null before that. */
  private started: Promise<void> | null = null;
  private startedAt: number | null = null;
  /** How long the run had been held when this agent started: time it was held before then isn't this agent's to subtract. */
  private heldBefore = 0;
  /**
   * How long its calls have waited for the user's word (DESIGN §17): that time isn't the agent's own
   * either. Calls of one round wait together, so it is the time during which at least one waited:
   * the waits that ended, and the one under way since `waitingSince` while `waiting` calls wait.
   */
  private waited = 0;
  private waiting = 0;
  private waitingSince = 0;
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
  /** How many characters of an answer and of reasoning the call under way has streamed: what an estimate of a call that brought no answer is made from. */
  private brought = { text: 0, reasoning: 0 };

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
            this.brought.text += delta.content?.length ?? 0;
            this.brought.reasoning += delta.reasoning?.length ?? 0;
            this.piece(delta);
          }
        : undefined;
    // The agent's calls are one session of the provider's prompt cache, let go when its run ends.
    this.callSpec = { connectionId: spec.connectionId, model: spec.model, effort: spec.effort, system: spec.system, prefix: spec.prefix, cache: { ...settings.cache, session: this.id }, ...(spec.toolCalls !== undefined ? { toolCalls: spec.toolCalls } : {}), ...(spec.params ? { params: spec.params } : {}), ...(streamed ? { onDelta: streamed } : {}) };
    this.session = new ProviderSession(deps, this.callSpec);
    this.conversation = [...(spec.history ?? [])];
    for (const tool of spec.tools) this.tools.set(tool.name, tool);
    // An agent with tools gets scratch_read, for the results that come back clipped; it takes its name over any tool of the spec's.
    if (this.tools.size > 0) this.tools.set(SCRATCH_READ, this.scratchRead());
    this.offered = [...this.tools.values()].map((t) => ({ name: t.name, description: t.description, parameters: t.parameters }));
    this.offeredTokens = toolTokens(this.offered, settings.loop.charsPerToken);
  }

  private now(): number {
    return this.deps.host.clock.now();
  }

  /**
   * The agent's start on the trace, before anything of its work: its connection is read first, so
   * the start names the connection its calls go on, by its id and its name, and the one its
   * settings name where that is none of the host's and the default stands in. Where no connection
   * can be read, the start names what its settings name, and its first call's stop says why.
   */
  private async begin(): Promise<void> {
    const { spec } = this;
    let on: Pick<AgentStarted, "connectionId" | "connectionName" | "gone"> = { connectionId: spec.connectionId };
    try {
      const profile = await this.session.connect();
      const gone = this.session.gone;
      on = { connectionId: profile.id, connectionName: profile.name, ...(gone !== null ? { gone } : {}) };
    } catch {
      // Not lost: the first call takes this read, its failure too, and its stop says why.
    }
    this.deps.turn?.trace?.start({ id: this.id, role: spec.role, ...on, model: this.session.model, effort: spec.effort, system: spec.system, prefix: [...spec.prefix], history: spec.history?.length ?? 0, ...(spec.parent !== undefined ? { parent: spec.parent } : {}), ...(spec.task !== undefined ? { task: spec.task } : {}), ...(spec.as !== undefined ? { as: spec.as } : {}), at: this.now() });
  }

  private text(id: string, vars: Readonly<Record<string, string>> = {}): string {
    return this.deps.texts.render(id, vars);
  }

  /** One of this agent's own budget settings, named with where it is changed: what its stops and cuts say. */
  private budgetSetting(key: keyof AgentBudget): string {
    return this.deps.texts.setting(["agents", this.spec.role, "budget", key]);
  }

  send(text: string, signal?: AbortSignal): Promise<AgentReply> {
    return this.work(text, signal);
  }

  run(signal?: AbortSignal): Promise<AgentReply> {
    return this.work(null, signal);
  }

  /** One message's work: the message joins the conversation (none for `run`), and the loop runs on it. */
  private async work(text: string | null, signal: AbortSignal | undefined): Promise<AgentReply> {
    // Its start is on the trace before anything of its work is.
    if (this.deps.turn?.trace) await (this.started ??= this.begin());
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
    if (this.startedAt === null) {
      this.startedAt = this.now();
      this.heldBefore = this.deps.turn?.held(this.startedAt) ?? 0;
    }
    if (text !== null) {
      // Its first message says how many rounds of tool calls it has, so it can plan its work to end within them.
      const sent = this.entries.length === 0 ? `${text}${this.budgetLine()}` : text;
      this.conversation.push({ role: "user", content: sent });
      this.record({ kind: "message", text: sent, at: this.now() });
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

  messages(): ModelMessage[] {
    return [...this.conversation];
  }

  usage(): AgentUsage {
    return { ...this.total };
  }

  /** Calls the model and runs the tools it calls until it answers or a limit stops it. */
  private async loop(used: AgentUsage, signal: AbortSignal | undefined): Promise<AgentReply> {
    const { budget } = this.spec;
    const { turn, settings } = this.deps;
    const repeat: LoopRun = { call: null, state: null, whole: null, error: false, times: 0 };
    let said = "";
    let finish: string | undefined;
    // How many times the call under way was made again: a call that answers starts the count afresh.
    let retried = 0;
    // The room of the call made again after one its room cut while it was all thinking; null for a call's own.
    let room: number | null = null;
    for (;;) {
      // The user holds the run: nothing of this agent's goes on until they let it go.
      if (turn?.paused) {
        const stopped = await this.heldUp(turn, signal);
        if (stopped) return this.end(used, stopped, said, finish);
      }
      this.takeNotes();
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
      // The caps on a day's spend are asked about this call, with its prompt as estimated, and it holds that much against them until it is on the record.
      const cap = turn?.limits?.({ estimate: prepared.estimate, model: prepared.model, always: this.spec.uncapped === true }) ?? null;
      if (cap instanceof AgentStop) return this.end(used, cap, said, finish);
      const outLeft = Math.min(limitOf(budget.tokensOut) - this.total.out, turn ? limitOf(turn.budget.tokensOut) - turn.usage.out : Number.POSITIVE_INFINITY);
      const request = requestOf(this.callSpec, prepared, Math.min(room ?? budget.callTokensOut, outLeft), settings);
      // Kept while the call is made, so keeping it never holds the call up; a prompt that can't be kept is left off the record.
      const kept = turn?.trace?.prompt(this.id, request).catch(() => undefined) ?? Promise.resolve(undefined);
      const scope = this.scope(signal, true);
      const sentAt = this.now();
      let reply: ModelReply;
      this.live = this.watched ? { text: "", reasoning: "", sentAt: null } : null;
      this.brought = { text: 0, reasoning: 0 };
      const made = this.session.made;
      try {
        reply = await this.session.send(prepared, request, scope.signal);
      } catch (error) {
        this.closeLive();
        // A call that reached its connection is on the record whatever came of it; one that never did (its connection's throttle refused it, or its wait there was ended) spent nothing.
        if (this.session.made > made) this.unanswered(prepared);
        cap?.();
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
      turn?.trace?.usage(this.id, reply.usage, { ...this.total }, { connection: prepared.connection, model: reply.model });
      cap?.();
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
      this.spec.onCall?.({ text: reply.text, calls: reply.calls.length });
      // Its room cut it before it gave anything usable (no text, no whole tool call): it was all thinking. That call counted against every budget as it was; it is made again once with more room, the model told to think briefly and act. Cut so again, it ends as a cut answer does.
      if (cutShort(reply.finishReason) && reply.text.trim() === "" && reply.calls.length === 0 && room === null) {
        room = Math.min(Math.ceil(request.maxTokens * settings.loop.cutRoomFactor), settings.loop.cutRoomTokens);
        const told = this.text(TEXT.runtime.cutThinking);
        this.tell(told);
        this.record({ kind: "notice", text: told, at: this.now() });
        continue;
      }
      room = null;
      if (reply.calls.length === 0) {
        this.answered = true;
        this.conversation.push({ role: "assistant", content: reply.text });
        return { status: "answered", text: reply.text, finish, usage: { ...used } };
      }
      // No round runs once the time it would run in is gone.
      const stop = this.roundStop() ?? this.timeUp();
      if (stop) {
        // The calls aren't run, so the model's turn goes on record as what it said.
        if (reply.text !== "") this.conversation.push({ role: "assistant", content: reply.text });
        return this.end(used, stop, said, finish);
      }
      this.total.toolTurns += 1;
      used.toolTurns += 1;
      if (turn) turn.usage.toolTurns += 1;
      const encoding = reply.written ? TEXT_TURNS : NATIVE_TURNS;
      this.room = this.roomOf(prepared, encoding, reply);
      const tools = this.scope(signal, false);
      let round: RoundCall[];
      try {
        round = await this.runCalls(reply.calls, tools.signal);
      } finally {
        tools.clear();
      }
      this.conversation.push(
        encoding.assistant(reply),
        encoding.results(
          round.map((ran) => ran.result),
          this.deps.texts,
        ),
      );
      if (tools.signal.aborted) return this.end(used, this.why(tools.signal.reason, tools.signal), said, finish);
      if (this.ending !== null) {
        const text = this.ending;
        this.ending = null;
        this.answered = true;
        return { status: "answered", text, finish, usage: { ...used } };
      }
      // The detector is asked once the round's results are known: only they tell a look at what changes by itself from a model going round.
      const looped = this.looped(round, repeat);
      if (looped) return this.end(used, looped, said, finish);
      // It goes on to another call: with few rounds left, the results say how many.
      this.warnRounds();
    }
  }

  /** How long the agent has worked, by its own clock: from its first message, less the time the user held the run and the time its calls waited for the user's word. */
  private spent(now: number): number {
    const waited = this.waited + (this.waiting > 0 ? now - this.waitingSince : 0);
    return now - (this.startedAt ?? now) - ((this.deps.turn?.held(now) ?? 0) - this.heldBefore) - waited;
  }

  /** Waits out the user's hold on the run; what ended the wait instead, where something did. */
  private async heldUp(turn: AgentTurn, signal: AbortSignal | undefined): Promise<AgentStop | null> {
    const ends = AbortSignal.any([this.controller.signal, ...(signal ? [signal] : [])]);
    try {
      await turn.hold(ends);
      return null;
    } catch (error) {
      return this.why(error, ends);
    }
  }

  /**
   * What the user said since its last round joins the conversation where the model reads on from,
   * marked as theirs. After a round of tool calls the conversation ends on the results, which are
   * the user's turn of it: the note goes with them, so no two user messages follow one another.
   */
  private takeNotes(): void {
    for (const note of this.spec.notes?.() ?? []) {
      this.tell(this.text(TEXT.agents.note, { text: note }));
      this.record({ kind: "note", text: note, at: this.now() });
    }
  }

  /** Something for the model to read where it reads on from: with a round's results where the conversation ends on them, else as a message of its own. */
  private tell(text: string): void {
    const last = this.conversation.at(-1);
    if (last?.role === "user") this.conversation[this.conversation.length - 1] = { ...last, content: `${last.content}\n\n${text}`, ...(last.parts ? { parts: [...last.parts, { type: "text", text }] } : {}) };
    else this.conversation.push({ role: "user", content: text });
  }

  /** The rounds of tool calls it has left: its own, or its run's where those are fewer; infinite where neither is limited. */
  private roundsLeft(): number {
    const turn = this.deps.turn;
    return Math.max(0, Math.min(limitOf(this.spec.budget.toolTurns) - this.total.toolTurns, turn ? limitOf(turn.budget.toolTurns) - turn.usage.toolTurns : Number.POSITIVE_INFINITY));
  }

  /** What ends its first message: how many rounds of tool calls it has. Nothing for an agent without tools, or without a limit on its rounds. */
  private budgetLine(): string {
    const rounds = this.roundsLeft();
    return this.tools.size === 0 || !Number.isFinite(rounds) ? "" : `\n\n${this.text(TEXT.runtime.budget, { rounds: this.deps.texts.counted(rounds, TEXT.word.round) })}`;
  }

  /** What a round's results end with once the agent has as few rounds left as Settings say: how many; null before then. */
  private roundsNotice(): string | null {
    const left = this.roundsLeft();
    const { warnRounds } = this.deps.settings.loop;
    if (warnRounds <= 0 || left > warnRounds) return null;
    return left === 0 ? this.text(TEXT.runtime.roundsSpent) : this.text(TEXT.runtime.roundsLeft, { rounds: this.deps.texts.counted(left, TEXT.word.round) });
  }

  /**
   * After a round: once it has as few rounds left as Settings say, it is told how many, with the
   * round's results, so its work ends in an answer instead of at the limit. The transcript holds
   * what it was told.
   */
  private warnRounds(): void {
    const text = this.roundsNotice();
    if (text === null) return;
    this.tell(text);
    this.record({ kind: "notice", text, at: this.now() });
  }

  /**
   * The room a round's results have in the agent's next call, in characters, where Prompt per call
   * limits its prompt: what is left once the prompt just sent, the answer that made the calls, the
   * results' own framing and the line the round may end with (`roundsNotice`) are counted. Endless
   * where Prompt per call is not limited. A result past what is left is cut to it (`clip`), so a
   * long answer never leaves the next call one that isn't made.
   */
  private roomOf(p: PreparedCall, encoding: ToolTurnEncoding, reply: ModelReply): number {
    const window = limitOf(this.spec.budget.callTokensIn);
    if (!Number.isFinite(window)) return Number.POSITIVE_INFINITY;
    const { charsPerToken } = this.deps.settings.loop;
    // Framed as failures, the longer way a result goes back as text.
    const framing = messageText(encoding.results(reply.calls.map((call) => ({ call, text: "", error: true })), this.deps.texts)).length;
    // The line joins the results after a blank line.
    const line = this.roundsNotice();
    const notice = line === null ? 0 : line.length + 2;
    // Each message's estimate is rounded up on its own: the answer and the results take a token each at most past their characters.
    const after = p.estimate + tokensOf(messageText(encoding.assistant(reply)), charsPerToken) + 2;
    return Math.max(0, Math.floor((window - after) * charsPerToken) - framing - notice);
  }

  /** The agent's or the run's time, run out before a call or a round. */
  private timeUp(): AgentStop | null {
    const now = this.now();
    if (this.spent(now) >= limitOf(this.spec.budget.wallMs)) return new AgentStop("wall_time", { id: TEXT.stop.wallTime, vars: { setting: this.budgetSetting("wallMs") } });
    const turn = this.deps.turn;
    if (turn && now - turn.startedAt - turn.held(now) >= limitOf(turn.budget.wallMs)) return new AgentStop("turn_time", { id: turn.words.time });
    return null;
  }

  /**
   * A call its prompt's estimate, or the tokens already spent, put past a budget, or that a cap from
   * outside the run refuses. A limit a stop names is one that was passed, so it is always a number:
   * no limit never stops a call.
   */
  private overBudget(p: PreparedCall): AgentStop | null {
    const { budget } = this.spec;
    const turn = this.deps.turn;
    const { texts } = this.deps;
    if (p.estimate > limitOf(budget.callTokensIn)) return new AgentStop("call_tokens_in", { id: TEXT.stop.callTokensIn, vars: { tokens: texts.counted(p.estimate, TEXT.word.token), limit: String(budget.callTokensIn), setting: this.budgetSetting("callTokensIn") } });
    // What was read again from a provider's cache counts at its weight; this call's own prompt in full, since what of it will be cached isn't known yet.
    const { cachedWeight } = this.deps.settings.spend;
    const weight = String(cachedWeight);
    const own = countedIn(this.total, cachedWeight) + p.estimate;
    if (own > limitOf(budget.tokensIn)) return new AgentStop("tokens_in", { id: TEXT.stop.tokensIn, vars: { limit: String(budget.tokensIn), counted: String(own), weight } });
    // An answer written in the last few tokens of a budget would be cut before it said anything: the agent stops here and says why.
    const floor = Math.min(this.deps.settings.loop.answerFloor, budget.callTokensOut);
    const ownLeft = limitOf(budget.tokensOut) - this.total.out;
    if (ownLeft <= 0) return new AgentStop("tokens_out", { id: TEXT.stop.tokensOut, vars: { tokens: texts.counted(limitOf(budget.tokensOut), TEXT.word.token) } });
    if (ownLeft < floor) return new AgentStop("tokens_out", { id: TEXT.stop.answerRoom, vars: { left: texts.counted(ownLeft, TEXT.word.token), floor: String(floor) } });
    const all = turn ? countedIn(turn.usage, cachedWeight) + p.estimate : 0;
    if (turn && all > limitOf(turn.budget.tokensIn)) return new AgentStop("turn_tokens_in", { id: turn.words.tokensIn, vars: { limit: String(turn.budget.tokensIn), counted: String(all), weight } });
    const runLeft = turn ? limitOf(turn.budget.tokensOut) - turn.usage.out : Number.POSITIVE_INFINITY;
    if (turn && runLeft <= 0) return new AgentStop("turn_tokens_out", { id: turn.words.tokensOut, vars: { tokens: texts.counted(limitOf(turn.budget.tokensOut), TEXT.word.token) } });
    if (runLeft < floor) return new AgentStop("turn_tokens_out", { id: TEXT.stop.answerRoom, vars: { left: texts.counted(runLeft, TEXT.word.token), floor: String(floor) } });
    return null;
  }

  /**
   * A call that was made and brought no answer (it failed, it was stopped, its time ran out, its
   * connection refused its tools) goes on the spend record as every call does (§20): its provider
   * may bill it, and reported nothing. So what it spent is the runtime's own estimate, marked as
   * one: its prompt as estimated before it was sent, and whatever of an answer had streamed by
   * then. The agent's and the run's own budgets count the calls that answered; the record of
   * spend and the caps on a day's spend count every call made.
   */
  private unanswered(p: PreparedCall): void {
    const { settings, turn } = this.deps;
    const { charsPerToken } = settings.loop;
    const estimate = { in: p.estimate, out: Math.ceil(this.brought.text / charsPerToken), reasoningOut: Math.ceil(this.brought.reasoning / charsPerToken) };
    turn?.trace?.usage(this.id, priced(parseUsage(undefined, null, estimate), [p.model], settings.prices), { ...this.total }, { connection: p.connection, model: p.model });
  }

  /** Why a round of calls isn't run: the agent's or the turn's rounds spent. */
  private roundStop(): AgentStop | null {
    const { turn } = this.deps;
    if (this.total.toolTurns >= limitOf(this.spec.budget.toolTurns)) return new AgentStop("tool_turns", { id: TEXT.stop.toolTurns, vars: { rounds: this.deps.texts.counted(limitOf(this.spec.budget.toolTurns), TEXT.word.round), setting: this.budgetSetting("toolTurns") } });
    if (turn && turn.usage.toolTurns >= limitOf(turn.budget.toolTurns)) return new AgentStop("turn_tool_turns", { id: turn.words.toolTurns, vars: { rounds: this.deps.texts.counted(limitOf(turn.budget.toolTurns), TEXT.word.round) } });
    return null;
  }

  /**
   * The loop detector, after a round. A call is the one before it made again when it names the same
   * tool with the same arguments, found the tool's state as that one did (a tool whose state changed
   * is asked something new, whatever its arguments) and came to the same result: a look at something
   * that changes by itself (a job under way) is told from a model going round only by what it gave.
   * At Settings' number of the same call in a row the agent stops. A call the answer made more than
   * once was run once, and counts once.
   */
  private looped(round: readonly RoundCall[], repeat: LoopRun): AgentStop | null {
    for (const { result, state, whole, again } of round) {
      if (again) continue;
      const { call, error } = result;
      const same = repeat.call !== null && repeat.call.name === call.name && jsonEqual(repeat.call.args, call.args) && repeat.state === state && repeat.error === error && sameWhole(repeat.whole, whole);
      repeat.times = same ? repeat.times + 1 : 1;
      repeat.call = call;
      repeat.state = state;
      repeat.whole = whole;
      repeat.error = error;
      if (repeat.times >= this.deps.settings.loop.repeats) return new AgentStop("loop", { id: TEXT.stop.loop, vars: { tool: call.name, times: this.deps.texts.counted(repeat.times, TEXT.word.time) } });
    }
    return null;
  }

  /**
   * The signal a call (`call`) or a round's tool runs go with: ended by `cancel`, by the send's own
   * signal, and by each deadline left: the agent's time, the run's and, for a call, its own. The
   * deadlines wait on the host's clock, and
   * `clear` ends their waits once the call or the round is over. The agent's time and the run's
   * leave out the time the user held the run and the time a call waited for their word, so when
   * such a deadline's wait is over the time left is worked out again, and whatever is left is
   * waited out too: a hold or an ask that outlasts the time the agent had never ends its work.
   */
  private scope(signal: AbortSignal | undefined, call: boolean): { signal: AbortSignal; clear(): void } {
    const { clock } = this.deps.host;
    const sources: AbortSignal[] = [this.controller.signal, ...(signal ? [signal] : [])];
    const over = new AbortController();
    const turn = this.deps.turn;
    const deadline = (left: () => number, stop: AgentStop): void => {
      if (timerMs(left()) === null) return;
      const ends = new AbortController();
      sources.push(ends.signal);
      const arm = (): void => {
        const ms = timerMs(left()) ?? 0;
        // While the run is held or a call waits, the time left stands still: it is looked at again no sooner than `STILL_MS`.
        const still = this.waiting > 0 || turn?.paused === true;
        clock.sleep(still ? Math.max(ms, STILL_MS) : ms, over.signal).then(
          () => (left() > 0 ? arm() : ends.abort(stop)),
          () => undefined,
        );
      };
      arm();
    };
    deadline(() => limitOf(this.spec.budget.wallMs) - this.spent(this.now()), new AgentStop("wall_time", { id: TEXT.stop.wallTime, vars: { setting: this.budgetSetting("wallMs") } }));
    if (turn) {
      deadline(() => {
        const now = this.now();
        return limitOf(turn.budget.wallMs) - (now - turn.startedAt - turn.held(now));
      }, new AgentStop("turn_time", { id: turn.words.time }));
    }
    if (call) {
      const until = this.now() + limitOf(this.spec.budget.callMs);
      deadline(() => until - this.now(), new AgentStop("call_time", { id: TEXT.stop.callTime }));
    }
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

  /**
   * A tool's run, or the round's end where that comes first: a stop and the time limits end a round
   * at once, whatever a tool that doesn't heed its signal still does. A run so left behind goes on
   * by itself and what it gives is dropped.
   */
  private raced<T>(work: Promise<T>, signal: AbortSignal): Promise<T> {
    const { promise, resolve, reject } = Promise.withResolvers<T>();
    const stop = (): void => reject(signal.reason);
    if (signal.aborted) stop();
    else signal.addEventListener("abort", stop, { once: true });
    work.then(resolve, reject).finally(() => signal.removeEventListener("abort", stop));
    return promise;
  }

  /**
   * A round's calls, as many at once as the budget lets, results in the calls' order. A call the
   * answer made before (the same tool, the same arguments) isn't run again: a model that writes one
   * call twice asked one thing, and each is given the result of the first. And of the answer's
   * calls to tools whose result ends the send (`AgentTool.ends`) only the first is run: a second
   * would leave the agent's work ended twice over, or by a mix of the two.
   */
  private async runCalls(calls: readonly AgentCall[], signal: AbortSignal): Promise<RoundCall[]> {
    const { budget } = this.spec;
    // Where the first call the same as each stands: its own place, for a call made once.
    const first = calls.map((call) => calls.findIndex((other) => other.name === call.name && jsonEqual(other.args, call.args)));
    // The calls to run, in the answer's order: Tool calls per answer counts these, and `ended` is the call before one that already ends the send.
    const todo: { at: number; call: AgentCall; allowed: boolean; ended: AgentCall | null }[] = [];
    let ender: AgentCall | null = null;
    for (const [at, call] of calls.entries()) {
      if (first[at] !== at) continue;
      const ends = this.tools.get(call.name)?.ends === true;
      todo.push({ at, call, allowed: todo.length < limitOf(budget.callTools), ended: ends ? ender : null });
      if (ends) ender ??= call;
    }
    const round: RoundCall[] = [];
    let next = 0;
    const worker = async (): Promise<void> => {
      for (let one = todo[next++]; one; one = todo[next++]) round[one.at] = await this.runCall(one.call, one, signal);
    };
    await Promise.all(Array.from({ length: Math.min(budget.concurrency, todo.length) }, worker));
    for (const [at, call] of calls.entries()) {
      const same = round[first[at] ?? at];
      if (first[at] === at || !same) continue;
      // On the record under its own id, as every call's result is. Nothing was run for it: it took no time and changed no file.
      this.record({ kind: "result", callId: call.id, name: call.name, text: same.result.text, error: same.result.error, ...(same.scratch !== undefined ? { scratch: same.scratch } : {}), ms: 0, at: this.now() });
      round[at] = { ...same, result: { ...same.result, call }, again: true };
    }
    return round;
  }

  /** What a call the round's end overtook before it began is given for its result: that it wasn't run, and what ended the round. */
  private notBegun(call: AgentCall, stop: AgentStop): ToolOutcome {
    return { text: this.text(TEXT.runtime.notRun, { name: call.name, reason: this.text(stop.text.id, stop.text.vars) }), error: true };
  }

  /**
   * One call's result: its tool's outcome (a failure as one); a note that it wasn't run, for a call
   * past Tool calls per answer (`allowed` false), for one after the answer's first call that ends
   * the send (`ended`: that call), and for one the round's end overtook before it began; or, for a
   * call Settings hold for the user's word, why it wasn't run when that word was no, or never came.
   */
  private async runCall(call: AgentCall, how: { allowed: boolean; ended: AgentCall | null }, signal: AbortSignal): Promise<RoundCall> {
    const t0 = this.now();
    const tool = this.tools.get(call.name);
    let outcome: ToolOutcome;
    let state: number | null = null;
    let begun = false;
    // The round is over already (the run was stopped, a time limit passed) and this call had not begun, waiting for its place among the calls at once: nothing of it is started.
    if (signal.aborted) outcome = this.notBegun(call, this.why(signal.reason, signal));
    else if (!how.allowed) outcome = { text: this.text(TEXT.runtime.tooManyCalls, { limit: String(this.spec.budget.callTools), tools: this.deps.texts.noun(limitOf(this.spec.budget.callTools), TEXT.word.tool), name: call.name }), error: true };
    else if (!tool) outcome = { text: this.text(TEXT.runtime.unknownTool, { name: call.name, tools: [...this.tools.keys()].join(", ") }), error: true };
    else if (how.ended) outcome = { text: this.text(TEXT.runtime.oneEnding, { name: call.name, first: how.ended.name }), error: true };
    else {
      try {
        const refused = await this.heldCall(tool, call, signal);
        if (refused) outcome = refused;
        // Read again after whatever the call waited for and before its tool is asked anything: no tool is left to read the signal for itself, and one that changes something would change it after the stop.
        else if (signal.aborted) outcome = this.notBegun(call, this.why(signal.reason, signal));
        else {
          state = tool.state?.() ?? null;
          begun = true;
          outcome = await this.raced(tool.run(call.args, { signal, agentId: this.id, role: this.spec.role, callId: call.id, ...(this.spec.as !== undefined ? { as: this.spec.as } : {}) }), signal);
        }
      } catch (error) {
        const stopped = signal.aborted ? this.why(error, signal) : null;
        // A call the round's end overtook while it waited for the user's word never began. A run it overtook (the turn was stopped, a time limit passed) says that, not what the abandoned run may yet throw.
        outcome = stopped && !begun ? this.notBegun(call, stopped) : { text: this.text(TEXT.runtime.toolFailed, { name: call.name, error: stopped ? this.text(stopped.text.id, stopped.text.vars) : errorText(error) }), error: true };
      }
    }
    // What ends the send is the answer, never a result the model reads on from: it isn't clipped, and takes no room. scratch_read's part is never more than one read, which it keeps within the room left.
    const ends = outcome.end === true && outcome.error !== true;
    if (call.name === SCRATCH_READ) this.room = Math.max(0, this.room - outcome.text.length);
    const kept = call.name === SCRATCH_READ || ends ? null : await this.clip(outcome.text, tool?.wholeChars, signal);
    const text = kept?.text ?? outcome.text;
    const error = outcome.error === true;
    const scratch = kept?.scratch !== undefined ? { scratch: kept.scratch } : {};
    this.record({ kind: "result", callId: call.id, name: call.name, text, error, ...scratch, ...(outcome.files && outcome.files.length > 0 ? { files: outcome.files } : {}), ...(outcome.lore ? { lore: outcome.lore } : {}), ms: this.now() - t0, at: this.now() });
    if (ends) this.ending = outcome.text;
    return { result: { call, text, error }, state, whole: kept ? kept.whole : { text }, ...scratch };
  }

  /**
   * Approval (DESIGN §17): a call Settings hold waits here for the user's word, no longer than
   * Settings allow. Null: it may run (it needed no word, or got one). Else what the model is told
   * in its place. The ask and how it ended are steps of the agent's transcript, which is all the
   * live view needs to show the card and take it down.
   */
  private async heldCall(tool: AgentTool, call: AgentCall, signal: AbortSignal): Promise<ToolOutcome | null> {
    const gate = this.deps.approval;
    if (!gate?.asks(tool)) return null;
    if (!gate.ask) return { text: this.text(TEXT.approval.noWay, { tool: tool.name }), error: true };
    const at = this.now();
    const until = gate.waitMs === null ? null : at + gate.waitMs;
    const tier = tool.tier ?? "read";
    this.record({ kind: "approval_asked", callId: call.id, tool: tool.name, tier, args: call.args, until, at });
    // The wait's own end: its bound, on the host's clock, beside whatever ends the round.
    const late = new AbortController();
    const over = new AbortController();
    const wait = timerMs(limitOf(gate.waitMs));
    if (wait !== null) {
      this.deps.host.clock.sleep(wait, over.signal).then(
        () => late.abort(),
        () => undefined,
      );
    }
    // Calls of one round wait together: the agent's clock stops while at least one does.
    if (this.waiting++ === 0) this.waitingSince = at;
    const closed = (decision: "once" | "chat" | "refused" | "timed_out", reason?: string): void => {
      this.record({ kind: "approval", callId: call.id, decision, ...(reason !== undefined && reason !== "" ? { reason } : {}), ms: this.now() - at, at: this.now() });
    };
    try {
      const answer = approvalAnswerOf(await gate.ask({ agentId: this.id, role: this.spec.role, callId: call.id, tool: tool.name, tier, args: call.args, at, until }, AbortSignal.any([signal, late.signal])));
      // Only an approval runs the call. What came back as neither that nor a refusal is nobody's word: the call isn't run on it, and the agent is told so.
      if (answer === null) {
        closed("refused", this.text(TEXT.approval.unreadWhy));
        return { text: this.text(TEXT.approval.unread, { tool: tool.name }), error: true };
      }
      if (answer.decision === "once" || answer.decision === "chat") {
        closed(answer.decision);
        return null;
      }
      const reason = answer.reason?.trim() ?? "";
      closed("refused", reason);
      return { text: this.text(TEXT.approval.refused, { tool: tool.name, reason: reason === "" ? "" : this.text(TEXT.approval.refusedReason, { reason }) }), error: true };
    } catch (error) {
      // The round ended while it waited (the run was stopped, the agent cancelled, its time ran out): the agent's stop says so, and the call has no word of its own.
      if (signal.aborted) throw error;
      if (late.signal.aborted) {
        closed("timed_out");
        return { text: this.text(TEXT.approval.timedOut, { tool: tool.name, seconds: String(Math.round((gate.waitMs ?? 0) / 1000)) }), error: true };
      }
      // The ask itself failed (its port, the link under it): nobody gave their word, so the call isn't run, the card comes down, and the agent is told why.
      closed("refused", errorText(error));
      return { text: this.text(TEXT.approval.failed, { tool: tool.name, error: errorText(error) }), error: true };
    } finally {
      over.abort();
      if (--this.waiting === 0) this.waited += this.now() - this.waitingSince;
    }
  }

  /**
   * A result past what reaches the model whole (Tool results clipped past, or what its tool gives
   * whole where that is more), or past the room the round's results have left in the agent's next
   * call (`roomOf`): its start for the model, in the words for whichever cut it, and the whole kept
   * for `scratch_read`: as a blob where the agent has a blob store, so that no result stays in
   * memory however long it is, else in the agent's own memory. A whole the store wouldn't take
   * isn't kept at all: the model is told so with the start. The room is taken before the store is
   * waited for, so calls of one round that end together never take the same room twice. The
   * round's signal ends the wait for the store, as it ends a tool's run.
   */
  private async clip(text: string, wholeChars: number | undefined, signal: AbortSignal): Promise<{ text: string; whole: Whole | null; scratch?: string } | null> {
    const max = Math.max(wholeChars ?? 0, this.deps.settings.loop.clipChars);
    const room = this.room;
    if (text.length <= max && text.length <= room) {
      this.room = room - text.length;
      return null;
    }
    const total = String(text.length);
    // What each cut's words say beside the sizes: a clip, how much one scratch_read gives of this result (its own length, `per` below); a cut to the room, the agent's own Prompt per call.
    const said = (id: string): Record<string, string> => (id === TEXT.runtime.clipped ? { per: String(max) } : { setting: this.budgetSetting("callTokensIn") });
    // The words after the start take room too: measured as long as they can be, with a handle longer than any.
    const words = (id: string): number => this.text(id, { shown: total, total, handle: "s000000", ...said(id) }).length + 1;
    // Clipped at its own length where that and its words fit the room; else cut to the room, with the words that say so.
    const fits = text.length > max && max + words(TEXT.runtime.clipped) <= room;
    const id = fits ? TEXT.runtime.clipped : TEXT.runtime.windowCut;
    const shown = cutAt(text, fits ? max : Math.max(0, room - words(TEXT.runtime.windowCut)));
    this.room = Math.max(0, room - shown - words(id));
    const sizes = { shown: String(shown), total };
    const start = shown > 0 ? `${text.slice(0, shown)}\n` : "";
    const { blobs } = this.deps;
    let whole: Whole = { text };
    if (blobs) {
      try {
        // Not kept in memory once written (`kept` false): the store gives it back if the model reads on.
        whole = { hash: await this.raced(blobs.put(text, false), signal) };
      } catch (error) {
        const stopped = signal.aborted ? this.why(error, signal) : null;
        if (!stopped) this.deps.host.log("warn", `[LumiAH] the whole of a clipped tool result couldn't be stored (${errorText(error)}): the model has its start alone`);
        return { text: `${start}${this.text(TEXT.runtime.clippedLost, { ...sizes, error: stopped ? this.text(stopped.text.id, stopped.text.vars) : errorText(error) })}`, whole: null };
      }
    }
    // The handle is taken in the same step as its whole is kept, after the store answered: two results clipped at once never share one.
    const handle = `s${this.scratch.size + 1}`;
    this.scratch.set(handle, { whole, per: max });
    return { text: `${start}${this.text(id, { ...sizes, handle, ...said(id) })}`, whole, scratch: "hash" in whole ? whole.hash : handle };
  }

  /**
   * The built-in `scratch_read`: the next part of a clipped or cut result, at most as much at a time
   * as the tool it came from gives whole (Tool results clipped past, for most), and never more than
   * the room the round's results have left. That most is each result's own, so its clipped words say
   * it (`per`); the tool states no maximum of its own, since none would hold for every result.
   */
  private scratchRead(): AgentTool {
    return {
      name: SCRATCH_READ,
      description: this.text(TEXT.runtime.scratchRead),
      parameters: {
        type: "object",
        properties: {
          handle: { type: "string", description: this.text(TEXT.runtime.scratchHandle) },
          offset: { type: "integer", minimum: 0, description: this.text(TEXT.runtime.scratchOffset) },
          length: { type: "integer", minimum: 1, description: this.text(TEXT.runtime.scratchLength, { max: String(this.deps.settings.loop.clipChars) }) },
        },
        required: ["handle"],
      },
      run: async (args: JsonObject) => {
        const handle = typeof args.handle === "string" ? args.handle : "";
        const kept = this.scratch.get(handle);
        if (kept === undefined) return { text: this.text(TEXT.runtime.scratchMissing, { handle, handles: [...this.scratch.keys()].join(", ") || this.text(TEXT.session.none) }), error: true };
        // A whole kept as a blob is read back from the store at each read: nothing of it stays with the agent between two.
        const whole = "text" in kept.whole ? kept.whole.text : ((await this.deps.blobs?.get(kept.whole.hash)) ?? null);
        if (whole === null) return { text: this.text(TEXT.runtime.scratchLost, { handle }), error: true };
        // An offset or length that isn't a whole number reads as none: the start, and as much as one read returns.
        const from = Math.min(Math.max(0, wholeArg(args.offset) ?? 0), whole.length);
        const total = String(whole.length);
        const room = this.room - this.text(TEXT.runtime.scratchPart, { handle, from: total, to: total, total, text: "" }).length;
        if (room < 1 && from < whole.length) return { text: this.text(TEXT.runtime.scratchFull, { handle, setting: this.budgetSetting("callTokensIn") }) };
        const length = Math.min(Math.max(1, wholeArg(args.length) ?? kept.per), kept.per, room);
        const to = cutAt(whole, Math.min(whole.length, from + length));
        return { text: this.text(TEXT.runtime.scratchPart, { handle, from: String(from), to: String(to), total, text: whole.slice(from, to) }) };
      },
    };
  }
}
