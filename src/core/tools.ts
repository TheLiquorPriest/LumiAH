// What a tool is (DESIGN §4.1, §13), and the registry tools written in code are kept in (§1: an
// extension that runs beside the core registers its own beside the core's).
//
// A tool as an agent holds it is built for one agent of one run: its description and its arguments'
// are the user's texts as they stand then, and what it reads is the run's own (the chat as the run
// reads it, the lore that applies, the main agent's earlier turns, the workspace as that agent may
// use it). So the registry keeps definitions, each of which builds its tool from the run's
// environment (`ToolEnv`).

import type { ActivatedLore, AgentRef, ChatMessage, FileChange, HarnessHost, JobView, JobWhen, JsonObject, LoreBook, LoreEntry, PathMessage, RunKind, ToolTier, TurnRequest } from "./ports";
import type { LoreChange } from "./recall/shapes";
import type { Book } from "./book";
import type { LexicalIndex } from "./lexical";
import type { SessionSegment } from "./sessions";
import type { Settings } from "./settings";
import type { Skill } from "./skills";
import type { Texts } from "./texts";
import type { WorkspaceView } from "./workspace";

/** What a tool's run gets besides its arguments: a signal that ends when the agent is cancelled or its time runs out, and who called. */
export interface ToolCtx {
  signal: AbortSignal;
  agentId: string;
  role: string;
  callId: string;
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

/** Starting and continuing sub-agents (§14), as the run offers it to one agent. Each answers with what the model is told. */
export interface Delegation {
  /** The definitions this agent may delegate to. */
  agents(): readonly DelegateChoice[];
  start(input: { agent: string; task: string; files: readonly string[] }, ctx: ToolCtx): Promise<ToolOutcome>;
  message(input: { handle: string; text: string }, ctx: ToolCtx): Promise<ToolOutcome>;
}

/** A job as `job_read` gives it: the job, its task whole, and its report whole once it has one. */
export interface JobRead {
  job: JobView;
  task: string;
  report: string | null;
}

/** What an agent's `job_start` call asks for: an agent and a task, or a job to start again in their place. */
export type JobStart = { agent: string; task: string; when: JobWhen } | { again: string; when: JobWhen };

/** What came of starting a job: the job, or why it wasn't started, in words for whoever asked. */
export type JobStarted = JobView | { refused: string };

/** Jobs (§15), as the run offers them to one agent. */
export interface JobTools {
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
  lore: LoreView;
  /** The main agent's earlier turns on the path this run reads, oldest first. */
  past: readonly PastTurn[];
  /** Hands the writer a brief and has it write the reply; absent where no writer writes this run's reply. */
  writeReply?: (brief: string, ctx: ToolCtx) => Promise<ToolOutcome>;
  /** The workspace as this agent may use it (§11). */
  workspace?: WorkspaceView;
  /** The skills it may load (§13). */
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
