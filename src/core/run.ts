// A run (DESIGN §4, §11 to §18): what a turn that answers a generation, a job's run and a turn of a
// side session have in common. Each is one or more agents at work under one budget, with one trace.
//
// A run reads everything the user may have changed when it starts: their settings and texts, their
// definitions merged with the extension's and the core's own (§13), the tools that run in the
// extension, what the extension supplies for the run's chat (§21), and the guidance its agents are
// given (§12). Then every agent of the run is started the same way (`Run.agent`): its definition's
// instructions under the guidance, the skills it may load, its tools built for it, the workspace as
// it may use it, and the files pinned for it. That is the one place an agent's prompt is put
// together, so the main agent, a sub-agent, a job's agent and a side session's are told the same
// things in the same order.

import type { AgentDefinition, AgentRegistry, ResolvedAgent } from "./agents";
import { approvalGate, ChatApprovals } from "./approval";
import type { Areas } from "./areas";
import type { Blobs } from "./blobs";
import { type Book, readBook } from "./book";
import type { CompactionMemo } from "./compaction";
import { type Definitions, mergeDefinitions } from "./definitions";
import { Delegator } from "./delegation";
import type { AgentModelAsk, ChatClaim, HarnessExtension, ReplyTool } from "./extension";
import { type GuidanceRead, guidanceGuard, guidancePrefix, readGuidance } from "./guidance";
import type { Jobs } from "./jobs";
import { type AgentDeps, type AgentHandle, AgentTurn, type RunWords, startAgent } from "./loop";
import type { AgentRef, AgentUsage, ChatInfo, FileChange, HarnessHost, JsonObject, ModelDelta, ModelEffort, ModelMessage, RecordJob, RemoteTool, SamplingParams, TraceEvent, TurnRequest, TurnStatus, WorkspaceArea } from "./ports";
import { isRecord } from "./ports";
import type { AgentAccounts } from "./provider";
import { type RecallRun, recallOf } from "./recall/recall";
import type { Sessions } from "./sessions";
import { type AgentBudget, isEffort, type SettingPlace, type Settings, settingPlaceOf, settingsOf, type TurnBudget } from "./settings";
import type { SkillRegistry } from "./skills";
import type { Spend } from "./spend";
import { type StoryHolds, storyHolds, storyWordOf } from "./story";
import { TEXT, TOOL, type Texts, textDef, textsOf } from "./texts";
import type { AgentTool, ChatView, DelegateChoice, JobStarted, JobTools, LoreView, PastTurn, ReplyStream, RunInfo, ToolEnv, ToolOutcome, ToolRegistry } from "./tools";
import { TurnTrace } from "./transcript";
import { addUsage, countedIn, priced } from "./usage";
import { clip, errorText, hasOwn, type Limit, limitOf, timerMs } from "./util";
import { type AreaAccess, pinnedFiles, showPath, versionOf, type Workspace, type WorkspaceView } from "./workspace";

// ---------------------------------------------------------------- what a harness keeps across runs

/** What the host keeps for the user, as stored: their settings, their own texts by id, and their own definitions (§13). */
export interface StoredState {
  values: unknown;
  texts: unknown;
  definitions?: unknown;
}

export interface HarnessOptions {
  /**
   * The user's settings, texts and definitions as stored, read at the start of every run: the
   * core's settings object (whole or in part: the core fills in its defaults), the user's own texts
   * by id, and their own definitions. So whatever the user changed holds from the next run on.
   */
  settings(): Promise<StoredState>;
  /** What the extension that builds LumiAH into itself supplies (§21). */
  extension?: HarnessExtension;
  /**
   * Whose harness this is: the user every call of the extension's is said to be for. A turn says its
   * own (`TurnRequest.userId`), which stands for that turn. Without either, the extension is told
   * no user (`""`): enough where its backend serves one user, as behind a runtime's link.
   */
  userId?: string;
  /**
   * Where the user changes one of the core's settings, as the words of a limit or a wait of the
   * core's name it: its own name (`title`) with where it is shown (`path`: its place in the core's
   * section, `["extension", "waitMs"]`; `trail`: the groups that lead to it). The runtime says it as
   * its own waits do: "Wait for the extension (LumiAH's Settings → Timeouts → Tools and
   * approvals)", "Tool results clipped past (LumiAH's Settings → The agent loop)". Absent: the title
   * with Settings and the trail.
   */
  place?: SettingPlace;
}

/** What a harness keeps across runs. */
export interface Shared {
  host: HarnessHost;
  options: HarnessOptions;
  /** What is written in code: the core's own tools, agent definitions and skills, and whatever was registered beside them. `core` names the core's own. */
  tools: ToolRegistry;
  agents: AgentRegistry;
  skills: SkillRegistry;
  core: { agents: ReadonlySet<string>; skills: ReadonlySet<string>; tools: ReadonlySet<string> };
  accounts: AgentAccounts;
  blobs: Blobs;
  sessions: Sessions;
  memo: CompactionMemo;
  workspace: Workspace;
  areas: Areas;
  spend: Spend;
  jobs: Jobs;
  /** The runs under way, by id: what the user talks to, holds and lets go (§18). */
  runs: Map<string, Run>;
  /** The settings of the run read last: what the memory limits and the caps are read from between runs. */
  latest: Settings;
}

// ---------------------------------------------------------------- the extension, asked

/** Why an ask of the extension has no answer: its call failed (`error`, in its own words), or its wait of `ms` ran out. */
export type Unanswered = { error: string } | { ms: number };

/**
 * One call of the extension's, waited for no longer than Settings allow: its answer, or why there
 * is none. An extension adds to a run and never holds one.
 */
export async function extensionAnswer<T>(shared: Pick<Shared, "host">, waitMs: Limit, call: () => Promise<T>): Promise<{ answer: T } | { unanswered: Unanswered }> {
  const over = new AbortController();
  const ms = timerMs(limitOf(waitMs));
  const late = ms === null ? null : shared.host.clock.sleep(ms, over.signal).then(() => ({ unanswered: { ms } }));
  // The wait that lost the race is ended below and rejects with nobody waiting on it.
  late?.catch(() => undefined);
  try {
    const answered = call().then((answer) => ({ answer }));
    return await (late ? Promise.race([answered, late]) : answered);
  } catch (error) {
    return { unanswered: { error: errorText(error) } };
  } finally {
    over.abort();
  }
}

/** Why an ask of the extension has no answer, as the log says it. */
export function unansweredLog(why: Unanswered): string {
  return "ms" in why ? `no answer in ${why.ms} ms (Wait for the extension)` : why.error;
}

/**
 * One call of the extension's that the run can do without: its answer, or `fallback` when it fails
 * or doesn't come in time, with a line in the log.
 */
export async function askExtension<T>(shared: Pick<Shared, "host" | "options">, what: string, waitMs: Limit, call: (() => Promise<T>) | undefined, fallback: T): Promise<T> {
  if (!call) return fallback;
  const got = await extensionAnswer(shared, waitMs, call);
  if ("answer" in got) return got.answer;
  shared.host.log("warn", `[LumiAH] ${shared.options.extension?.name ?? "the extension"} gave no ${what} (${unansweredLog(got.unanswered)}): the run goes on without it`);
  return fallback;
}

/** How long a wait was, as the words of one that ran out say it: "4 seconds", "500 ms". */
function waitWords(ms: number): string {
  if (ms < 1000) return `${ms} ms`;
  const seconds = Math.round(ms / 100) / 10;
  return `${seconds} second${seconds === 1 ? "" : "s"}`;
}

/** Wait for the extension, as the user is told where to change it. */
function extensionWait(options: Pick<HarnessOptions, "place">): string {
  return settingPlaceOf(undefined, options.place)(["extension", "waitMs"]);
}

/**
 * What the user reads of an ask of the extension's that got no answer, in their texts: `late` where
 * its wait ran out (with how long it was and where that wait is changed), `failed` where it failed
 * (with its error). `vars` fill the rest of either.
 */
export function unansweredWords(input: { why: Unanswered; late: string; failed: string; texts: Texts; options: Pick<HarnessOptions, "extension" | "place">; vars?: Readonly<Record<string, string>> }): string {
  const { why, texts, options } = input;
  const vars = { extension: options.extension?.name ?? "The extension", ...input.vars };
  return "ms" in why ? texts.render(input.late, { ...vars, wait: waitWords(why.ms), setting: extensionWait(options) }) : texts.render(input.failed, { ...vars, error: why.error });
}

/** Why the extension's agents and skills are missing from a run, in the user's words: what a run's live view is told, and why a job or a conversation whose agent is the extension's doesn't start. */
export function agentsMissing(why: Unanswered, texts: Texts, options: Pick<HarnessOptions, "extension" | "place">): string {
  return unansweredWords({ why, late: TEXT.progress.agentsLate, failed: TEXT.progress.agentsUnread, texts, options });
}

/** Why a run about a chat doesn't start when the extension never said whether it answers that chat itself: run as one of LumiAH's own, the chat could be answered wrongly. */
export function claimMissing(why: Unanswered, texts: Texts, options: Pick<HarnessOptions, "extension" | "place">): string {
  return unansweredWords({ why, late: TEXT.progress.claimLate, failed: TEXT.progress.claimUnread, texts, options });
}

const TIERS: readonly string[] = ["read", "write", "external"];

/** The tools that run in the extension, as its port lists them now: outside data, so one that isn't a tool is left out, a length it reads whole that isn't one is left off, and a port that fails gives none. */
async function remoteTools(host: Pick<HarnessHost, "tools" | "log">, chatId: string): Promise<RemoteTool[]> {
  if (!host.tools) return [];
  let listed: unknown;
  try {
    listed = await host.tools.list(chatId);
  } catch (error) {
    host.log("warn", `[LumiAH] the extension's tools couldn't be listed (${errorText(error)}): this run has none of them`);
    return [];
  }
  return (Array.isArray(listed) ? listed : []).flatMap((tool: unknown): RemoteTool[] => {
    const ok = isRecord(tool) && typeof tool.name === "string" && tool.name !== "" && typeof tool.family === "string" && typeof tool.tier === "string" && TIERS.includes(tool.tier) && typeof tool.description === "string" && isRecord(tool.parameters) && (tool.source === "extension" || tool.source === "user");
    if (!ok) {
      host.log("warn", `[LumiAH] a tool the extension listed isn't one (${isRecord(tool) && typeof tool.name === "string" && tool.name !== "" ? tool.name : "no name"}): it isn't offered`);
      return [];
    }
    if (tool.wholeChars === undefined || (Number.isSafeInteger(tool.wholeChars) && (tool.wholeChars as number) > 0)) return [tool as unknown as RemoteTool];
    host.log("warn", `[LumiAH] the extension's tool ${tool.name} names a length it reads whole that isn't a whole number of characters: its answers are clipped as any tool's`);
    const rest: Record<string, unknown> = { ...tool };
    delete rest.wholeChars;
    return [rest as unknown as RemoteTool];
  });
}

/**
 * What the extension answered for a chat, read: outside data, so anything that isn't a claim's is
 * left out. Null stays null: the chat isn't claimed. A `reply_write` of its own that can't be
 * offered is left out, with why in the log: the core's own then stands in the chat.
 */
function claimOf(raw: unknown, extension: HarnessExtension | undefined, host: Pick<HarnessHost, "log">): ChatClaim | null {
  if (!isRecord(raw)) return null;
  const guidance = isRecord(raw.guidance) && typeof raw.guidance.name === "string" ? raw.guidance : null;
  const story = storyWordOf(raw.story);
  const replyTool = raw.replyTool === undefined || raw.replyTool === null ? null : replyToolOf(raw.replyTool, extension?.releasing !== undefined);
  if (typeof replyTool === "string") host.log("warn", `[LumiAH] ${extension?.name ?? "the extension"}'s claim gives reply_write a description and arguments of its own that can't be offered (${replyTool}): reply_write takes the reply's text in this chat, as without them`);
  return {
    ...(typeof raw.mainAgent === "string" ? { mainAgent: raw.mainAgent } : {}),
    ...(guidance && typeof guidance.path === "string" ? { guidance: { name: guidance.name as string, path: guidance.path } } : guidance && typeof guidance.text === "string" ? { guidance: { name: guidance.name as string, text: guidance.text } } : {}),
    ...(Array.isArray(raw.withdraw) ? { withdraw: raw.withdraw.filter((name): name is string => typeof name === "string") } : {}),
    ...(Object.keys(story).length > 0 ? { story } : {}),
    ...(raw.request === "whole" || raw.request === "newest" ? { request: raw.request } : {}),
    ...(raw.reply === "released" ? { reply: "released" as const } : {}),
    ...(replyTool !== null && typeof replyTool !== "string" ? { replyTool } : {}),
  };
}

/**
 * A claim's own `reply_write` (`ChatClaim.replyTool`), read: outside data a model is offered, so it
 * stands only where it can't break the call that offers it: a description, and arguments that are
 * a JSON Schema of type object (each property a schema; only those named required), as JSON says
 * them. Without the extension's `releasing`, nothing would give the text that goes out. Else why
 * not, for the log.
 */
function replyToolOf(raw: unknown, releases: boolean): ReplyTool | string {
  if (!releases) return "it has no releasing to give the text that goes out";
  if (!isRecord(raw) || typeof raw.description !== "string" || raw.description.trim() === "") return "it has no description";
  let parameters: unknown;
  try {
    // Taken as JSON, as the model is sent it: what JSON can't say (a function, a value that holds itself) is no schema.
    parameters = JSON.parse(JSON.stringify(raw.parameters) ?? "null");
  } catch (error) {
    return `its arguments can't be written as JSON (${errorText(error)})`;
  }
  if (!isRecord(parameters) || parameters.type !== "object") return "its arguments aren't a JSON Schema of type object";
  const { properties, required } = parameters;
  if (properties !== undefined && (!isRecord(properties) || !Object.values(properties).every((schema) => isRecord(schema)))) return "its arguments' properties aren't each a schema";
  if (required !== undefined && (!Array.isArray(required) || !required.every((name) => typeof name === "string" && isRecord(properties) && hasOwn(properties, name)))) return "it requires an argument it doesn't describe";
  // What JSON gave back is JSON throughout.
  return { description: raw.description, parameters: parameters as JsonObject };
}

// ---------------------------------------------------------------- what a run reads when it starts

/** What a run works with: whose it is, the user's settings and texts as they stand, the definitions merged from their three sources, the run's chat, what the extension supplies for it, and what counts as the chat's story (§24.4). */
export interface Setup {
  userId: string;
  settings: Settings;
  texts: Texts;
  definitions: Definitions;
  chat: ChatInfo | null;
  claim: ChatClaim | null;
  story: StoryHolds;
  /**
   * The extension's asks that got no answer for this run, with why. Without its definitions the run
   * has none of its agents and skills: it goes on only where none of them is needed, and its live
   * view says they are missing. Without its claim nobody knows whether the extension answers the
   * chat itself: a run about that chat doesn't start (`claimMissing`).
   */
  unanswered: { definitions?: Unanswered; claim?: Unanswered };
}

/**
 * Reads what a run about `chatId` works with (`""`: about no chat), for the user the harness serves
 * or the one a turn names. Rejects when the user's settings can't be read: running on the defaults
 * would call models the user didn't choose.
 */
export async function readSetup(shared: Shared, chatId: string, userId: string = shared.options.userId ?? ""): Promise<Setup> {
  const { host, options } = shared;
  const stored = await options.settings();
  const extension = options.extension;
  // How long the extension is waited for is a setting too, so it is read before anything is asked of it; and so is the user's word on the story, which the claim is told.
  const early = settingsOf(stored.values);
  const { waitMs } = early.extension;
  let chat: ChatInfo | null = null;
  if (chatId !== "") {
    try {
      chat = (await host.chat.info?.(chatId)) ?? null;
    } catch (error) {
      host.log("warn", `[LumiAH] the chat ${chatId} couldn't be read (${errorText(error)}): this run has no character's guidance, and no choice of the chat's own on what counts as its story`);
    }
  }
  const asked: ChatInfo = chat ?? { id: chatId, name: "", characterId: null, characterName: null, branchedFrom: null };
  // What counts as the story without the extension's word: the chat's own choice over the user's setting, Lumiverse's Sovereign Hand where they follow it. What the host says of either is outside data.
  const chosen = storyWordOf(chat?.story);
  const sovereignHand = typeof chat?.sovereignHand === "boolean" ? chat.sovereignHand : null;
  const below = storyHolds({ chat: chosen, user: early.story, sovereignHand });
  const [own, claimed, remote] = await Promise.all([
    extension?.definitions ? extensionAnswer<unknown>(shared, waitMs, () => extension.definitions?.({ userId, chatId: chatId === "" ? null : chatId }) ?? Promise.resolve({})) : { answer: {} },
    chatId !== "" && extension?.claim ? extensionAnswer<unknown>(shared, waitMs, () => extension.claim?.({ userId, chatId, chat: asked, story: below.source, sovereignHand }) ?? Promise.resolve(null)) : { answer: null },
    remoteTools(host, chatId),
  ]);
  const name = extension?.name ?? "the extension";
  const unanswered: Setup["unanswered"] = {};
  if ("unanswered" in own) {
    unanswered.definitions = own.unanswered;
    host.log("warn", `[LumiAH] ${name} gave no definitions (${unansweredLog(own.unanswered)}): this run has none of its agents and skills`);
  }
  if ("unanswered" in claimed) {
    unanswered.claim = claimed.unanswered;
    host.log("warn", `[LumiAH] ${name} gave no answer for the chat ${chatId} (${unansweredLog(claimed.unanswered)}): nobody knows whether it answers the chat itself, so this run doesn't start`);
  }
  const supplied = "answer" in own && isRecord(own.answer) ? own.answer : {};
  const claim = "answer" in claimed ? claimOf(claimed.answer, extension, host) : null;
  const definitions = mergeDefinitions(
    {
      code: { agents: shared.agents.all(), skills: shared.skills.all(), tools: shared.tools.all() },
      core: shared.core,
      extension: { agents: Array.isArray(supplied.agents) ? supplied.agents : [], skills: Array.isArray(supplied.skills) ? supplied.skills : [] },
      remote,
      user: stored.definitions,
      claim,
    },
    host,
  );
  const settings = settingsOf(stored.values, definitions.scope());
  shared.latest = settings;
  const story = claim?.story ? storyHolds({ claim: claim.story, chat: chosen, user: early.story, sovereignHand }) : below;
  // Every text that tells of a limit names its setting where this run's user changes it: an agent's own budget among this run's agents too.
  return { userId, settings, texts: textsOf(stored.texts, settingPlaceOf(definitions.scope(), shared.options.place)), definitions, chat, claim, story, unanswered };
}

/** An agent definition's instructions as they are sent: the user's text for a definition that names one of the core's, else its own. */
export function instructionsOf(definition: AgentDefinition, texts: Texts): string {
  return definition.text !== undefined && textDef(definition.text) ? texts.render(definition.text) : definition.instructions;
}

const choiceOf = (d: AgentDefinition): DelegateChoice => ({ id: d.id, name: d.name, description: d.description });

// ---------------------------------------------------------------- a run

/** What a run is, from its first moment: its id and kind, its budget and the words its budget stops with, and what its trace says it is the work of. */
export interface RunStart {
  info: RunInfo;
  budget: TurnBudget;
  words?: RunWords;
  startedAt: number;
  /** The message a turn's reply goes to. */
  messageId: string | null;
  /** The job this is the run of, or the side session this is a turn of. */
  job?: string;
  side?: string;
  /** The generation a turn answers. */
  turn?: TurnRequest;
  /** Hears every event of the run's trace as it is made. */
  heard?: (event: TraceEvent) => void;
  /** What earlier runs of the same work spent and how long they worked (a job carried on, §22): it counts against this run's budget from its first call. */
  spent?: { usage: AgentUsage; workedMs: number };
  /** Told when the user holds the run and when they let it go. */
  held?: (paused: boolean) => void;
}

/** What a run's agents read and write, once that is known: the chat and its lore, the workspace's areas, the main agent's earlier turns, and the turn a job started from this run belongs to. */
export interface Equipment {
  chat: ChatView;
  lore: LoreView;
  areas: Readonly<Record<WorkspaceArea, AreaAccess | null>>;
  past: readonly PastTurn[];
  basis: string | null;
}

/** How one agent of a run is started. */
export interface AgentStart {
  /** How deep it stands: 0 for the agent the run starts with, 1 for one that agent started, and so on. */
  depth: number;
  parent?: string;
  task?: string;
  /** Its instructions, in place of its definition's. */
  system?: string;
  /** What follows its instructions for this kind of run (a side session says what it is). */
  about?: string;
  history?: readonly ModelMessage[];
  params?: SamplingParams;
  onDelta?: (delta: ModelDelta) => void;
  budget?: AgentBudget;
  /** The earlier turns `past_turn` reads, where they aren't the run's own. */
  past?: readonly PastTurn[];
  writeReply?: ToolEnv["writeReply"];
  /** The tools it may hold at most: one its definition names and this doesn't is left out (§14: what the agent that starts it may grant). */
  grant?: ReadonlySet<string>;
  /** It takes no tools, whatever its settings say (the summary of the main agent's notes is one call). */
  toolless?: true;
  /** Nothing of LumiAH's is added to what it is sent: no guidance, no list of skills, no pinned files. For a call whose prompt is somebody else's to write (the writer's is the user's preset's). */
  plain?: true;
  /** What the user says to the run reaches this agent (§18). */
  notes?: true;
  /** It is the run's main agent: the one the run starts with (a turn's main agent, a job's agent, a side session's). */
  main?: true;
  /** Its calls are made whatever the caps on a day's spend say (`AgentSpec.uncapped`): the writer's call of the reply the user waits for. */
  uncapped?: true;
  /** Told as each of its model calls comes back (`AgentSpec.onCall`). */
  onCall?: (answer: { text: string; calls: number }) => void;
  /** Which instance of its definition it is (`delegate`'s or `job_start`'s `as`). */
  as?: string;
  /** How it stands, as the extension is asked its model (`AgentModelAsk.standing`); absent: a job's agent in a job's run, else an agent the run starts itself. */
  standing?: AgentModelAsk["standing"];
  /** Who started it, as the extension is asked its model: the agent that delegated to it or started its job, or the user who started its job. */
  by?: AgentRef | "user";
  /** Its answer streams into the reply (`to_reply`): it writes the reply as its answer, so it is given no reply of its own to write besides. */
  replying?: true;
}

/** An agent of a run, started: its handle, what leads its first message (the files pinned for it; empty for none), the workspace as it holds it, and the tools it was given. */
export interface StartedAgent {
  agent: AgentHandle;
  lead: string;
  view: WorkspaceView;
  held: ReadonlySet<string>;
}

export class Run {
  readonly info: RunInfo;
  /** Whose run it is, as the extension is told. */
  readonly userId: string;
  readonly settings: Settings;
  readonly texts: Texts;
  readonly definitions: Definitions;
  readonly chat: ChatInfo | null;
  readonly claim: ChatClaim | null;
  /** The extension's asks that got no answer for this run, with why (`Setup.unanswered`). */
  readonly unanswered: Setup["unanswered"];
  /** What counts as the chat's story for this run (§24.4): every agent of it reads the chat as this says. */
  readonly story: StoryHolds;
  readonly startedAt: number;
  readonly trace: TurnTrace;
  readonly agents: AgentTurn;
  readonly deps: AgentDeps;
  /** The jobs this run's agents started, as a turn's record lists them. A job that ends while the run is under way is written here. */
  readonly jobs: RecordJob[] = [];
  /** The workspace files its agents' tool calls changed, in the order they did. */
  readonly wrote: FileChange[] = [];
  /** The request the run answers, as its first agent reads it: what a sub-agent whose definition is given the request gets with its task. `newest`: only the user's newest message of it (`ChatClaim.request`). */
  request: { count: string; text: string; newest?: true } | null = null;
  /** The levels of guidance its agents are given. */
  guidance: readonly GuidanceRead[] = [];
  /** The reply as the turn lets its agents write it themselves (`reply_write`, `to_reply`); null for a run that writes no reply (a job's, a side session's). The turn sets it before its first agent starts. */
  reply: ReplyStream | null = null;

  private equipment: Equipment | null = null;
  /** The chat's book (§23), read once when the run is equipped; null where the chat has none. */
  private book: Book | null = null;
  /** The run's view of the lore and the chat (§24), made when the run is equipped: every tool of the run reads through the same one. */
  recall: RecallRun | null = null;
  private prefix: string[] = [];
  private guard: WorkspaceView["guard"] = () => null;
  /** What the user said to the run since its first agent last looked. */
  private readonly said: string[] = [];
  /** Its first agent reads no notes now: what the user says would reach nobody. */
  private deaf = false;
  /** Each agent's definition, by the agent's id: a call's spend is recorded under it. */
  private readonly roles = new Map<string, string>();
  /** Each agent it started with the agents over it, from the run's main agent down to itself, by the agent's id: what an agent it starts has above it. */
  private readonly lines = new Map<string, readonly AgentRef[]>();
  private readonly delegator: Delegator;
  /** The extension's hooks that nothing waits for, one after another in the order they were made. */
  private hooks: Promise<unknown> = Promise.resolve();

  constructor(
    readonly shared: Shared,
    setup: Setup,
    private readonly start: RunStart,
  ) {
    const { host } = shared;
    this.info = start.info;
    this.userId = setup.userId;
    this.settings = setup.settings;
    this.texts = setup.texts;
    this.definitions = setup.definitions;
    this.chat = setup.chat;
    this.claim = setup.claim;
    this.unanswered = setup.unanswered;
    this.story = setup.story;
    this.startedAt = start.startedAt;
    this.trace = new TurnTrace(host, { turn: this.info.id, chatId: this.info.chatId }, shared.blobs, this.settings.keep.prompts, (event) => this.hear(event));
    // Work carried on counts what it spent before: its time as if it had started that much earlier, its tokens and rounds as already used.
    this.agents = new AgentTurn(start.budget, start.startedAt - (start.spent?.workedMs ?? 0), this.trace, start.words);
    if (start.spent) addUsage(this.agents.usage, start.spent.usage);
    this.trace.turn = this.agents;
    const job = this.info.kind === "job";
    // A cap on a day's spend is asked about each call before it is made, with its prompt as estimated and that prompt's cost where the user priced its model; the call then holds that much against the caps while it is under way. A call that is made whatever they say only holds.
    this.agents.limits = (call) => {
      const cost = priced({ in: call.estimate, cachedIn: 0, out: 0, reasoningOut: 0, estimated: [] }, [call.model], this.settings.prices).cost ?? 0;
      const asked = { job, tokens: call.estimate, cost };
      return (call.always ? null : shared.spend.refusal({ ...asked, texts: this.texts })) ?? shared.spend.hold(asked);
    };
    const approved = this.info.chatId === "" ? null : new ChatApprovals(host, this.info.chatId);
    this.approved = approved;
    this.deps = { host, settings: this.settings, texts: this.texts, accounts: shared.accounts, turn: this.agents, approval: approvalGate(host, this.settings, this.info, approved) };
    this.delegator = new Delegator(this);
    shared.runs.set(this.info.id, this);
    this.trace.emit({
      kind: "turn_started",
      turn: this.info.id,
      chatId: this.info.chatId,
      generation: this.info.kind,
      messageId: start.messageId,
      ...(start.job !== undefined ? { job: start.job } : {}),
      ...(start.side !== undefined ? { side: start.side } : {}),
      at: start.startedAt,
    });
    // A run that goes on without the extension's agents and skills says so where the user watches it, and why: not only in the log.
    const missing = setup.unanswered.definitions;
    if (missing !== undefined) this.trace.emit({ kind: "notice", text: agentsMissing(missing, this.texts, shared.options), at: start.startedAt });
  }

  private readonly approved: ChatApprovals | null;

  /** The guidance its agents are given, each level as their instructions hold it (§12): what the writer is given beside the brief where Settings say so. */
  guidanceLines(): readonly string[] {
    return this.prefix;
  }

  /**
   * Gives the run what its agents read and write, reads the guidance they are given and the tools
   * the user approved for the chat, and tells the extension the run begins: nothing of the run has
   * been sent to a model yet, and nothing is until the extension answered or its wait ran out.
   */
  async equip(equipment: Equipment): Promise<void> {
    const { settings, texts, shared } = this;
    this.equipment = equipment;
    const [guidance, book] = await Promise.all([
      readGuidance({ areas: equipment.areas, chat: this.chat, claim: this.claim, texts, pathChars: settings.workspace.pathChars, log: shared.host.log }),
      readBook(shared.host, this.info.chatId),
      this.approved?.load(),
    ]);
    this.guidance = guidance;
    this.book = book;
    // What the user has set up of what the lore and history tools rest on (§24) is read before any tool is built.
    this.recall = recallOf({ host: shared.host, run: this.info, ...(this.start.turn ? { turn: this.start.turn } : {}), settings, texts, chat: equipment.chat, story: this.story.source, ...(book ? { book } : {}) });
    await this.recall.ready();
    this.prefix = guidancePrefix(guidance, settings, texts);
    this.guard = guidanceGuard(guidance, settings, texts);
    const extension = shared.options.extension;
    await askExtension(shared, "answer to a run beginning", settings.extension.waitMs, extension?.runBegan ? () => extension.runBegan?.({ userId: this.userId, chatId: this.info.chatId, turn: this.info.id, kind: this.info.kind, story: this.story.source }) ?? Promise.resolve() : undefined, undefined);
  }

  private equipped(): Equipment {
    if (!this.equipment) throw new Error("the run has nothing to work with yet");
    return this.equipment;
  }

  /** The workspace's areas as this run has them. */
  get areas(): Readonly<Record<WorkspaceArea, AreaAccess | null>> {
    return this.equipped().areas;
  }

  // ---------------------------------------------------------------- the trace

  private hear(event: TraceEvent): void {
    if (event.kind === "agent_started") this.roles.set(event.agent.id, event.agent.role);
    if (event.kind === "agent_entry" && event.entry.kind === "result" && event.entry.files) this.wrote.push(...event.entry.files);
    if (event.kind === "usage" && event.connection !== undefined && event.model !== undefined) {
      const { call } = event;
      const { info, start } = this;
      this.shared.spend.add({
        at: event.at,
        run: info.id,
        kind: info.kind,
        chatId: info.chatId,
        ...(start.job !== undefined ? { job: start.job } : {}),
        ...(start.side !== undefined ? { side: start.side } : {}),
        agent: this.roles.get(event.agentId) ?? "",
        agentId: event.agentId,
        connection: event.connection,
        model: event.model,
        in: call.in,
        cachedIn: call.cachedIn,
        out: call.out,
        reasoningOut: call.reasoningOut,
        ...(call.cost !== undefined ? { cost: call.cost } : {}),
        estimated: call.estimated.length > 0,
      });
    }
    this.start.heard?.(event);
  }

  /** The run ended: its trace says how, the agents its agents started are let go, each agent's session of the provider's prompt cache ends, and what it spent is written. */
  close(ended: { status: TurnStatus; reason?: string; at: number }, usage: AgentUsage): void {
    this.trace.emit({ kind: "turn_ended", status: ended.status, ...(ended.reason !== undefined ? { reason: ended.reason } : {}), usage, at: ended.at });
    this.delegator.close();
    for (const agent of this.lines.keys()) this.shared.host.models.ended?.(agent);
    this.shared.runs.delete(this.info.id);
    this.shared.spend.flush().catch((error: unknown) => this.shared.host.log("warn", `[LumiAH] what the run spent couldn't be written (${errorText(error)})`));
  }

  /** A hook of the extension's that nothing waits for: called after those before it, and bounded like every call of its. */
  hook(what: string, call: (() => Promise<void>) | undefined): void {
    if (!call) return;
    this.hooks = this.hooks.then(() => askExtension(this.shared, what, this.settings.extension.waitMs, call, undefined));
  }

  // ---------------------------------------------------------------- the user, while it works (§18)

  /**
   * Something the user says to the run: its first agent receives it at the start of its next round.
   * False when that agent reads no more notes now (`quiet`): the note would reach nobody.
   */
  say(text: string): boolean {
    if (this.deaf) return false;
    this.said.push(text);
    return true;
  }

  /** The run's first agent is past its rounds for now (the writer is writing its reply), or back at them. */
  quiet(on: boolean): void {
    this.deaf = on;
  }

  /** Holds every agent of the run at its next round; false when it is held already. */
  pause(): boolean {
    const at = this.shared.host.clock.now();
    if (!this.agents.pause(at)) return false;
    this.trace.emit({ kind: "turn_paused", at });
    this.start.held?.(true);
    return true;
  }

  /** Lets a held run go on; false when it wasn't held. */
  resume(): boolean {
    const at = this.shared.host.clock.now();
    if (!this.agents.resume(at)) return false;
    this.trace.emit({ kind: "turn_resumed", at });
    this.start.held?.(false);
    return true;
  }

  // ---------------------------------------------------------------- an agent of the run

  /** How `id` runs in this run; undefined when there is no such definition, or it is switched off. */
  resolve(id: string): ResolvedAgent | undefined {
    return this.definitions.resolve(id, this.settings);
  }

  /** Starts an agent of the run as `resolved` runs. */
  async agent(resolved: ResolvedAgent, how: AgentStart): Promise<StartedAgent> {
    const { settings, texts, shared, info, start } = this;
    const equipment = this.equipped();
    const { definition } = resolved;
    // Its id is known only once it started, and its tools are built before: its writes are recorded under the author set just below.
    const view: WorkspaceView = { author: { who: "agent", id: "", role: definition.id }, role: definition.id, areas: equipment.areas, guard: this.guard };
    const held = new Set<string>();
    const names = how.toolless ? [] : this.definitions.names(resolved.tools).filter((name) => !how.grant || how.grant.has(name));
    // The reply is the run's main agent's to write, and any agent's an extension's definition names reply_write for (the user's in place of one it supplies counts): never a user's own agent's, nor another of the core's.
    const sourced = this.definitions.sourced(definition.id);
    const reply = !how.toolless && !how.replying && this.reply !== null && (how.main === true || sourced?.source === "extension" || sourced?.over === "extension") ? this.reply : null;
    const delegation = how.toolless ? undefined : this.delegator.for({ definition: definition.id, depth: how.depth, held, view, ...(reply !== null && names.includes(TOOL.replyWrite) ? { reply } : {}) });
    const jobs = how.toolless ? undefined : this.jobTools({ held, depth: how.depth });
    const skills = this.definitions.skills();
    // The agents over it: those over the agent that started it, and that agent. One the run started itself has nobody above.
    const above = how.parent !== undefined ? (this.lines.get(how.parent) ?? []) : [];
    const env: ToolEnv = {
      host: shared.host,
      run: info,
      ...(start.turn ? { turn: start.turn } : {}),
      settings,
      texts,
      agent: definition.id,
      depth: how.depth,
      standing: { main: how.main === true, above },
      chat: equipment.chat,
      story: this.story.source,
      lore: equipment.lore,
      past: how.past ?? equipment.past,
      ...(how.writeReply ? { writeReply: how.writeReply } : {}),
      ...(reply !== null ? { reply } : {}),
      workspace: view,
      skills,
      ...(delegation ? { delegation } : {}),
      ...(jobs ? { jobs } : {}),
      ...(this.book ? { book: this.book } : {}),
    };
    const tools: AgentTool[] = this.definitions.build(names, env);
    for (const tool of tools) held.add(tool.name);
    const own = how.system ?? instructionsOf(definition, texts);
    const system = [own, how.about ?? "", !how.plain && held.has(TOOL.skillLoad) ? this.skillList(definition.id) : ""].filter((part) => part !== "").join("\n\n");
    // The extension may say which model this agent runs on (§21); asked only where it supplies the hook, so a run without it starts its agents as it always did.
    const chosen = shared.options.extension?.agentModel ? await this.modelOf({ definition: definition.id, as: how.as ?? null, standing: how.standing ?? (info.kind === "job" ? "job" : "turn"), by: how.by ?? null }) : {};
    const agent = startAgent(
      {
        role: definition.id,
        connectionId: chosen.connectionId ?? resolved.connectionId,
        // A connection the extension chose runs its own model unless it named one: the definition's was chosen for another connection.
        model: chosen.model ?? (chosen.connectionId !== undefined ? null : resolved.model),
        effort: chosen.effort ?? resolved.effort,
        system,
        prefix: how.plain ? [] : this.prefix,
        tools,
        toolCalls: resolved.toolCalls,
        budget: how.budget ?? resolved.budget,
        ...(how.history ? { history: how.history } : {}),
        ...(how.params ? { params: how.params } : {}),
        ...(how.onDelta ? { onDelta: how.onDelta } : {}),
        ...(how.onCall ? { onCall: how.onCall } : {}),
        ...(how.uncapped ? { uncapped: true as const } : {}),
        ...(how.parent !== undefined ? { parent: how.parent } : {}),
        ...(how.task !== undefined ? { task: how.task } : {}),
        ...(how.as !== undefined ? { as: how.as } : {}),
        ...(how.notes ? { notes: () => this.said.splice(0) } : {}),
      },
      this.deps,
    );
    view.author = info.kind === "job" ? { who: "job", id: info.id, role: definition.id } : { who: "agent", id: agent.id, role: definition.id };
    this.lines.set(agent.id, [...above, { agentId: agent.id, role: definition.id, ...(how.as !== undefined ? { as: how.as } : {}) }]);
    return { agent, lead: how.plain ? "" : await this.pinned(view), view, held };
  }

  /** The agent an agent of the run is, as another is told of it; undefined for none of this run's. */
  ref(agentId: string): AgentRef | undefined {
    return this.lines.get(agentId)?.at(-1);
  }

  /** What the extension says an agent runs on (§21), read: outside data, so only a connection or a model that is a name, and an effort the settings take, stand; anything else leaves the definition's own. */
  private async modelOf(ask: Pick<AgentModelAsk, "definition" | "as" | "standing" | "by">): Promise<{ connectionId?: string; model?: string; effort?: ModelEffort }> {
    const { shared, settings, info } = this;
    const extension = shared.options.extension;
    const answer: unknown = await askExtension<unknown>(shared, "agent's model", settings.extension.waitMs, extension?.agentModel ? () => extension.agentModel?.({ userId: this.userId, chatId: info.chatId, turn: info.id, kind: info.kind, ...ask }) ?? Promise.resolve(null) : undefined, null);
    if (!isRecord(answer)) return {};
    return {
      ...(typeof answer.connectionId === "string" && answer.connectionId !== "" ? { connectionId: answer.connectionId } : {}),
      ...(typeof answer.model === "string" && answer.model !== "" ? { model: answer.model } : {}),
      ...(isEffort(answer.effort) ? { effort: answer.effort } : {}),
    };
  }

  /** The skills the agent definition `agent` may load, as its instructions list them: as many as Settings give room for, and how many more there are. */
  private skillList(agent: string): string {
    const { texts } = this;
    const skills = this.definitions.skills(agent);
    if (skills.length === 0) return "";
    const lines: string[] = [];
    let used = 0;
    const room = this.settings.skills.listChars;
    for (const skill of skills) {
      const line = texts.render(TEXT.agents.skill, { id: skill.id, name: skill.name, description: skill.description });
      if (used + line.length + 1 > room) {
        // Not even the first fits: it is named as far as the room goes, so an agent that holds skill_load is never told of none.
        if (lines.length === 0) lines.push(clip(line, room));
        break;
      }
      lines.push(line);
      used += line.length + 1;
    }
    return texts.render(TEXT.agents.skills, { skills: lines.join("\n"), more: skills.length > lines.length ? texts.render(TEXT.agents.skillsMore, { count: String(skills.length - lines.length) }) : "" });
  }

  /** The files pinned for an agent, as they lead what it is sent first: each whole while Settings give room, the rest named. Empty for none, and when they can't be read (the log says why). */
  private async pinned(view: WorkspaceView): Promise<string> {
    const { texts } = this;
    try {
      const pins = await pinnedFiles(view);
      if (pins.length === 0) return "";
      let room = this.settings.workspace.pinChars;
      const files: string[] = [];
      for (const pin of pins) {
        const path = showPath(pin.area, pin.path);
        const text = pin.entry.chars <= room ? ((await view.areas[pin.area]?.text(pin.entry.hash)) ?? null) : null;
        if (text === null) files.push(texts.render(TEXT.agents.pinnedNamed, { path, chars: String(pin.entry.chars) }));
        else {
          room -= text.length;
          files.push(texts.render(TEXT.agents.file, { path, chars: String(text.length), version: versionOf(pin.entry.hash), text }));
        }
      }
      return texts.render(TEXT.agents.pinned, { files: files.join("\n\n") });
    } catch (error) {
      this.shared.host.log("warn", `[LumiAH] the pinned files couldn't be read (${errorText(error)}): the agent starts without them`);
      return "";
    }
  }

  // ---------------------------------------------------------------- jobs, as this run's agents have them (§15)

  /**
   * The job tools' side of this run, as one of its agents has them (`starter`: the tools it holds, filled once they are built, and how deep it stands); undefined where there are no jobs: Settings switch them off, the host can't run them, or the run is about no chat.
   */
  private jobTools(starter: { held: ReadonlySet<string>; depth: number }): JobTools | undefined {
    const { settings, texts, shared, info } = this;
    if (!settings.jobs.enabled || !shared.host.jobs || info.chatId === "") return undefined;
    const { basis } = this.equipped();
    const tools: JobTools = {
      // `as`, `lane` and `due` mean something only to an extension that builds LumiAH in: a harness without one offers job_start as it always did.
      offersAs: shared.options.extension !== undefined,
      agents: () => this.definitions.workers().map(choiceOf),
      list: () => shared.jobs.list(info.chatId),
      read: (id) => shared.jobs.read(info.chatId, id),
      cancel: (id, ctx) => shared.jobs.cancel(info.chatId, id, texts.render(TEXT.jobs.whyCancelledByAgent, { role: ctx.role })),
    };
    // A job's own agents start jobs only where Settings let jobs start jobs. One so started belongs to the same turn, may spend no more than is left of this one, and counts against it. Whoever starts a job, its agent is given no more than the starter holds and stands one deeper (§14).
    if (info.kind !== "job" || settings.jobs.chain) {
      // Starts still being made, counted with the jobs started: the calls of one answer run at once, and each has to find the place the one before it took.
      let starting = 0;
      tools.start = async (input, ctx): Promise<JobStarted> => {
        if (this.jobs.length + starting >= limitOf(settings.jobs.perRun)) return { refused: texts.render(TEXT.jobs.tooMany, { limit: texts.counted(settings.jobs.perRun ?? 0, TEXT.jobs.word) }) };
        const { when, as, lane, due, ...what } = input;
        starting++;
        let started: JobStarted;
        try {
          started = await shared.jobs.createJob({ chatId: info.chatId, when, what, by: { who: "agent", id: ctx.agentId, role: ctx.role }, basis, starter: { held: [...starter.held], depth: starter.depth }, ...(as !== undefined ? { as } : {}), ...(lane !== undefined ? { lane } : {}), ...(due !== undefined ? { due } : {}), ...(info.kind === "job" ? { parent: { id: info.id, left: this.left() } } : {}) }, this);
          if (!("refused" in started)) this.jobs.push({ id: started.id, agent: started.agent, state: started.state });
        } finally {
          starting--;
        }
        if ("refused" in started) return started;
        this.trace.emit({ kind: "job", job: started, at: shared.host.clock.now() });
        return started;
      };
    }
    return tools;
  }

  /** What is left of the run's own budget: each limit less what its agents have used, none where there is no limit. */
  left(): TurnBudget {
    const { budget, usage, startedAt } = this.agents;
    const now = this.shared.host.clock.now();
    const less = (limit: Limit, used: number): Limit => (limit === null ? null : Math.max(0, limit - used));
    // Prompt tokens as the limit counts them: a cached re-read at its weight.
    return { tokensIn: less(budget.tokensIn, countedIn(usage, this.settings.spend.cachedWeight)), tokensOut: less(budget.tokensOut, usage.out), toolTurns: less(budget.toolTurns, usage.toolTurns), wallMs: less(budget.wallMs, now - startedAt - this.agents.held(now)) };
  }

  /** What a tool answers, as an error, in the user's words for `id`. */
  refusal(id: string, vars: Readonly<Record<string, string>> = {}): ToolOutcome {
    return { text: this.texts.render(id, vars), error: true };
  }
}
