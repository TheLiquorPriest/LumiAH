// What a tool is (DESIGN §4.1, §13), and the registry tools written in code are kept in (§1: an
// extension that runs beside the core registers its own beside the core's).
//
// A tool as an agent holds it is built for one agent of one run: its description and its arguments'
// are the user's texts as they stand then, and what it reads is the run's own (the chat as the run
// reads it, the lore that applies, the main agent's earlier turns, the workspace as that agent may
// use it). So the registry keeps definitions, each of which builds its tool from the run's
// environment (`ToolEnv`).

import type { ActivatedLore, AgentRef, ChatMessage, FileChange, HarnessHost, JobDue, JobLane, JobView, JobWhen, JsonObject, LoreBook, LoreEntry, PathMessage, RunKind, ToolTier, TurnRequest } from "./ports";
import type { ReplyTool } from "./extension";
import type { LoreChange } from "./recall/shapes";
import type { Book } from "./book";
import type { LexicalIndex } from "./lexical";
import type { SessionSegment } from "./sessions";
import type { Settings } from "./settings";
import type { Skill } from "./skills";
import type { StorySource } from "./story";
import type { Texts } from "./texts";
import type { WorkspaceView } from "./workspace";

/** What a tool's run gets besides its arguments: a signal that ends when the agent is cancelled or its time runs out, and who called (`as`: which instance of its definition the caller is, where whoever started it said). */
export interface ToolCtx {
  signal: AbortSignal;
  agentId: string;
  role: string;
  callId: string;
  as?: string;
}

/**
 * The reply as a turn lets its agents write it themselves (`reply_write`, and `delegate`'s
 * `to_reply`), in place of a writer: released once, whole, it streams to the user, and the reply is
 * all of it.
 *
 * - `tool`: `reply_write` as the extension that claims the chat offers it (`ChatClaim.replyTool`,
 *   checked); null for the core's own, which takes the reply's text.
 * - `refused`: why nothing can be released now, in words for the model (the turn has ended; the
 *   writer is at work on it; the turn's reply went out already; another agent's answer is about to
 *   go out as it, so wait for that); null where it can.
 * - `write`: one `reply_write` call from the agent `ctx` names, with its arguments, once the
 *   extension lets it go (§21 `releasing`, which gives the text where the tool is the extension's),
 *   in the order the calls came: the text that went out, else why nothing did. The extension is told
 *   of what went out (`released`).
 * - `hold`: the reply held for one sub-agent's answer (`agent`), never asked about, so `refused`
 *   says so to every other agent meanwhile (`ReplyHand`).
 */
export interface ReplyStream {
  tool: ReplyTool | null;
  refused(): string | null;
  write(args: JsonObject, ctx: ToolCtx): Promise<{ released: string } | { refused: string }>;
  hold(agent: AgentRef): ReplyHand;
}

/**
 * The turn's reply held for one sub-agent's answer as it streams in (`delegate`'s `to_reply`):
 * `stream` appends what the answer brings (false where it went nowhere: the turn was stopped, or the
 * hand-on has ended); `end` lets the reply go once the hand-on's call has ended, and the extension
 * is told of all that streamed. Nothing streams after `end`: what that agent says later
 * (`agent_message`) is for the agent that started it to read, never the reply.
 */
export interface ReplyHand {
  stream(text: string): boolean;
  end(): void;
}

/**
 * What a tool gives back for the model: its text, and whether that's a failure. `end` ends the send
 * once the round's results are in, answered with this text and no further call (`write_reply`, whose
 * text is the reply). `files` names the workspace files the call changed, for the trace.
 */
export interface ToolOutcome {
  text: string;
  error?: true;
  end?: true;
  files?: FileChange[];
  /** What the call did to the lore the writer sees (`write_reply`, §24.3), for the trace. */
  lore?: LoreChange;
}

export interface AgentTool {
  name: string;
  description: string;
  /** Its arguments' JSON Schema, hand-written. */
  parameters: JsonObject;
  /** What it may touch, which approval is decided by (§17); absent: `read`. */
  tier?: ToolTier;
  /**
   * What its calls act on, as a number that changes whenever that does, for a tool whose arguments
   * name something by where it stands now: once it changed, the same arguments ask something else,
   * so the loop detector takes a call the same as the one before it for a repeat only while this is
   * the same too.
   */
  state?(): number;
  /**
   * Its result may end the agent's send (`ToolOutcome.end`, as `write_reply`'s does). Of one answer's
   * calls to such tools the loop runs the first alone: a later one isn't run, and says so in its own
   * result, so the send is never ended by two calls or by a mix of what each was given.
   */
  ends?: true;
  /**
   * How much of its answer, in characters, reaches the model whole: for a tool that bounds its own
   * answer by a setting and is meant to be read in one go (a long read the model asked for). Up to
   * it the answer isn't clipped at Tool results clipped past, nor left in scratch; past it, it is
   * clipped here, and `scratch_read` gives the rest as much at a time. Absent, or below Tool results
   * clipped past: that setting, as for any tool. Either way an answer the room left in the agent's
   * prompt (Prompt per call) can't hold is cut to that room, and says so.
   */
  wholeChars?: number;
  run(args: JsonObject, ctx: ToolCtx): Promise<ToolOutcome>;
}

/** The chat as one run reads it: every message of the active path before the reply (all of it, for a run that writes no reply), read once and kept for the run. */
export interface ChatView {
  /** The messages before the reply, oldest first, without their text. */
  path(): Promise<readonly PathMessage[]>;
  /** The same messages with their text. */
  messages(): Promise<readonly ChatMessage[]>;
  /** Their text indexed for search, by each message's place in `messages()`. */
  index(): Promise<LexicalIndex<number>>;
}

/** A lore entry as the tools name it: the entry, its book, and the short id an agent reads it by. */
export interface LoreItem {
  /** The shortest start of the entry's id that names it alone among the entries that apply. */
  short: string;
  entry: LoreEntry;
  book: LoreBook;
}

/** The lore that applies to the run's chat, read once and kept for the run. */
export interface LoreView {
  books(): Promise<readonly LoreBook[]>;
  /** Every entry of every book that applies, in the books' order. */
  items(): Promise<readonly LoreItem[]>;
  /** The entries' titles, keys and text indexed for search, by each entry's place in `items()`. */
  index(): Promise<LexicalIndex<number>>;
  /** The entries Lumiverse activated for this generation; none for a run that answers no generation. */
  activated(): Promise<readonly ActivatedLore[]>;
}

/** An earlier turn of the main agent's on the path this turn reads: the reply it was for, its segment's hash, and its work in full. */
export interface PastTurn {
  reply: number;
  hash: string;
  segment: SessionSegment;
}

/** The run a tool is built for: its id (the trace's `turn`), what it is the work of, and its chat (`""` for a side session about none). */
export interface RunInfo {
  id: string;
  kind: RunKind;
  chatId: string;
}

/** An agent definition as an agent choosing whom to hand a task reads it. */
export interface DelegateChoice {
  id: string;
  name: string;
  description: string;
}

/** Starting and continuing sub-agents (§14), as the run offers it to one agent. Each answers with what the model is told. `as` is offered where an extension builds LumiAH in; `toReply` where this agent may hand the reply on (it may write the reply itself). */
export interface Delegation {
  /** The definitions this agent may delegate to. */
  agents(): readonly DelegateChoice[];
  offersAs: boolean;
  toReply: boolean;
  start(input: { agent: string; task: string; files: readonly string[]; as?: string; toReply?: boolean }, ctx: ToolCtx): Promise<ToolOutcome>;
  message(input: { handle: string; text: string }, ctx: ToolCtx): Promise<ToolOutcome>;
}

/** A job as `job_read` gives it: the job, its task whole, and its report whole once it has one. */
export interface JobRead {
  job: JobView;
  task: string;
  report: string | null;
}

/** What an agent's `job_start` call asks for: an agent and a task, or a job to start again in their place; with which instance its agent is, its lane among waiting jobs, and whether the next turn waits for it. */
export type JobStart = ({ agent: string; task: string } | { again: string }) & { when: JobWhen; as?: string; lane?: JobLane; due?: JobDue };

/** What came of starting a job: the job, or why it wasn't started, in words for whoever asked. */
export type JobStarted = JobView | { refused: string };

/** Jobs (§15), as the run offers them to one agent. `offersAs`: `job_start` offers `as`, `lane` and `due`, where an extension builds LumiAH in. */
export interface JobTools {
  offersAs: boolean;
  /** The definitions a job may run as. */
  agents(): readonly DelegateChoice[];
  /**
   * Starts a job: the one way an agent starts one, called by its `job_start` call and by nothing
   * else. `refused` says why not, in words for the model. Absent where this run's agents may read
   * and cancel jobs but not start any (a job's own agents, unless Settings let jobs start jobs).
   */
  start?(input: JobStart, ctx: ToolCtx): Promise<JobStarted>;
  /** The chat's jobs, the latest first. */
  list(): Promise<JobView[]>;
  read(id: string): Promise<JobRead | null>;
  /** Cancels a job that waits or runs (`cancelled`: it did; false for one that had already ended); null when there is no such job. */
  cancel(id: string, ctx: ToolCtx): Promise<{ job: JobView; cancelled: boolean } | null>;
}

/**
 * What a tool is built from: the host, the run and, where it answers a generation, the turn; the
 * user's settings and texts as they stand; the agent definition it is built for and how deep that
 * agent stands (0: the agent the run starts with; 1: one it started; and so on); and the run's own
 * reads. A tool reads only what it needs, and has nothing to offer (`build` gives null) where what it
 * needs isn't there.
 */
export interface ToolEnv {
  host: HarnessHost;
  run: RunInfo;
  /** The generation the run answers; absent for a job's run and a side session's turn. */
  turn?: TurnRequest;
  settings: Readonly<Settings>;
  texts: Texts;
  /** The definition of the agent the tool is built for. */
  agent: string;
  depth: number;
  /** Where the agent stands in its run: whether it is the run's main agent, and the agents over it, from the main agent down to the one that started it. Absent where the tools are built outside a run's own start (a test's): no main agent, and nobody above. */
  standing?: { main: boolean; above: readonly AgentRef[] };
  chat: ChatView;
  /** What counts as the chat's story (§24.4): the chat tools read only those messages. */
  story: StorySource;
  lore: LoreView;
  /** The main agent's earlier turns on the path this run reads, oldest first. */
  past: readonly PastTurn[];
  /** Hands the writer a brief and has it write the reply; absent where no writer writes this run's reply. */
  writeReply?: (brief: string, ctx: ToolCtx) => Promise<ToolOutcome>;
  /** The reply as this agent may write it itself (`reply_write`); absent where it may not: a job's or a side session's agent, or a turn's agent that is neither its main agent nor one an extension's definition gives it to. */
  reply?: ReplyStream;
  /** The workspace as this agent may use it (§11). */
  workspace?: WorkspaceView;
  /** Every skill switched on (§13): `skill_load` offers those for `agent`, and says whom any other is for. */
  skills?: readonly Skill[];
  /** Absent where this agent may not delegate (§14: Depth). */
  delegation?: Delegation;
  /** Absent where there are no jobs: Settings switch them off, the host can't run them, or the run has no chat (§15). */
  jobs?: JobTools;
  /** The chat's LumiBooks book (§23), read once for the run; absent where the chat has none. */
  book?: Book;
}

/**
 * A tool as the registry keeps it (§13): its name, the family it sits in (what `@family` names in an
 * agent definition's tools), its tier, and how it is built for an agent of a run (null: it has
 * nothing to offer there).
 */
export interface ToolDefinition {
  name: string;
  family: string;
  tier: ToolTier;
  build(env: ToolEnv): AgentTool | null;
}

/** The tools written in code, by name: the core's, and those of an extension that runs beside it. A name registered again replaces the one before it. */
export class ToolRegistry {
  private readonly byName = new Map<string, ToolDefinition>();

  register(...definitions: readonly ToolDefinition[]): void {
    for (const d of definitions) this.byName.set(d.name, d);
  }

  has(name: string): boolean {
    return this.byName.has(name);
  }

  all(): ToolDefinition[] {
    return [...this.byName.values()];
  }
}
