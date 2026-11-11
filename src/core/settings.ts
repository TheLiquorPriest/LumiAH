// The core's settings (DESIGN §3.3): every limit the core keeps and every choice it makes, each with
// its default, as one JSON object the user's own values are merged over. `SETTINGS_SCHEMA` is its
// JSON Schema, written by hand in the keywords the Settings page builds its forms from
// (src/shared/ui.ts says which): the same schema checks a value the user sets (`checkSettings`) and
// reads the settings as stored (`settingsOf`), so the page offers exactly what the core takes.
//
// A setting that may be none (no limit, the connection's own) holds null. A stored value the schema
// refuses reads as its default, and a key the schema doesn't have is left out, so settings written
// by another build never break a turn.

import type { OwnedField } from "./agents";
import type { JsonObject, JsonValue, ModelEffort, ToolTier } from "./ports";
import { isRecord } from "./ports";
import { defaultRecallSettings, RECALL_SETTINGS_SCHEMA, type RecallSettings } from "./recall/settings";
import { STORY_DEFAULTS, type StorySetting } from "./story";
import { FAMILY, TOOL } from "./text-def";
import { hasOwn, type Limit, TIMER_MAX_MS } from "./util";

/**
 * One agent's budget: each call, everything its calls send and write, its rounds of tool calls, its
 * time, the messages it may be sent after its first answer, and how many of its tool calls run at
 * once. Null is no limit.
 */
export interface AgentBudget {
  /** The prompt one call may send, in tokens, as estimated before it is sent. */
  callTokensIn: Limit;
  /** What one call may write (`max_tokens`), its reasoning included. */
  callTokensOut: number;
  /** How long one call may take, in milliseconds. */
  callMs: Limit;
  /** Tool calls one answer may make; those past it are refused. */
  callTools: Limit;
  /** Tokens the agent's calls send in all. */
  tokensIn: Limit;
  /** Tokens they write in all. */
  tokensOut: Limit;
  /** Rounds of tool calls: answers that call tools. */
  toolTurns: Limit;
  /** How long the agent may work from its first message, in milliseconds. */
  wallMs: Limit;
  /** Messages it may be sent after its first answer. */
  revisions: number;
  /** Its tool calls run at once, at most. */
  concurrency: number;
}

/** Every agent of one turn together: the turn's tokens, rounds of tool calls and time. */
export interface TurnBudget {
  tokensIn: Limit;
  tokensOut: Limit;
  toolTurns: Limit;
  wallMs: Limit;
}

/** A connection's throttle: requests sent and tokens sent and written, per minute, and its calls under way at once. Null is off. */
export interface ConnectionThrottle {
  requestsPerMinute: Limit;
  tokensPerMinute: Limit;
  atOnce: Limit;
}

/** A model's price, in US dollars per million tokens: sent, read from the cache, and written. */
export interface ModelPrice {
  in: number;
  cachedIn: number;
  out: number;
}

/**
 * How an agent's tools are offered to its model: natively where the connection takes them and as
 * text once it refused them (`auto`), always natively (a connection that refuses them fails the
 * call), or always as text in the prompt, for a model that calls tools better when it writes them.
 */
export type ToolCalls = "auto" | "native" | "text";

/** What an agent definition runs with: its connection and model (null: see the definition), its effort, the tools it is given and how they are offered, and its budget. */
export interface AgentSettings {
  connectionId: string | null;
  model: string | null;
  effort: ModelEffort;
  tools: string[];
  toolCalls: ToolCalls;
  budget: AgentBudget;
}

/** Where the main agent's brief goes among the messages Lumiverse assembled. */
export type BriefPlace = "before_last_user" | "end" | "start";

export interface Settings {
  reply: {
    /** Who writes the reply: a separate writer from the main agent's brief, or the main agent itself. */
    writer: "writer" | "main";
    briefAt: BriefPlace;
    briefRole: "system" | "user";
    /** What happens when the main agent stops short of a brief: the writer writes from the request alone, or the turn fails. */
    withoutBrief: "write" | "fail";
    /** Whether a turn writes progress lines into the reply's thinking block. */
    progress: boolean;
    /** A progress line's length at most, in characters. */
    progressChars: number;
    /** Whether the writer is given the guidance the agents are given (§12), beside the brief. Off: the writer's call is the prompt as it came with the brief alone (§3.2), and the main agent carries what matters. */
    writerGuidance: boolean;
    /** Where Lumiverse's own generation writes the reply (§25): how long before the reply is due the main agent is warned, in milliseconds; null: it isn't. */
    warnMs: Limit;
    /** Where Lumiverse's own generation writes the reply (§25): how long a turn waits for its reply to be written before it is given up, in milliseconds; null: as long as it takes. */
    pendingMs: Limit;
  };
  /** What counts as a chat's story (§24.4): the user's setting, which a chat's own choice and the claiming extension's word stand over. */
  story: StorySetting;
  /** Each agent definition's settings, by its id. */
  agents: Record<string, AgentSettings>;
  turn: TurnBudget;
  loop: {
    /** The loop detector: the same tool call on the same state this many times in a row stops the agent. */
    repeats: number;
    /** A tool result longer than this, in characters, reaches the model clipped; the rest waits in scratch. */
    clipChars: number;
    /** While off, a call that offers tools goes with reasoning off, for a connection that can't take a model's thinking back after a tool call. */
    thinkingInToolLoops: boolean;
    /** Every call takes its answer as the provider streams it. */
    stream: boolean;
    /** Characters per token, for estimates made before a provider reports its own count. */
    charsPerToken: number;
    /** How many times a call that failed in passing (a timeout, a rate limit, a provider's 5xx, a stream that dropped) is made again; 0 for never. */
    retries: number;
    /** How long to wait before each of them, in milliseconds. */
    retryWaitMs: number;
    /** A call isn't made with less room for its answer than this, in tokens: an agent whose answer tokens are that close to spent stops instead of writing an answer that would be cut. */
    answerFloor: number;
    /** An agent is told when it has this many rounds of tool calls left; 0 for never. */
    warnRounds: number;
    /** A call its answer room cut before it gave anything usable (all of it thinking) is made again once, with its room times this. */
    cutRoomFactor: number;
    /** The most answer room that second go has, in tokens. */
    cutRoomTokens: number;
  };
  cache: {
    /** Explicit cache breakpoints, where the provider takes them. */
    breakpoints: boolean;
    /** Heads every agent's prompt when not empty, so a provider's cached prompt no longer matches. */
    key: string;
  };
  connections: {
    /** Calls under way at once on a connection whose throttle sets none. */
    atOnce: Limit;
    /** Per connection, by its id. */
    throttles: Record<string, ConnectionThrottle>;
    /** How long a connection's model that refused native tools is sent them as text before native tools are tried again, in minutes; null: until the runtime restarts. */
    toolRefusalMinutes: Limit;
  };
  /** Per model, by its name: what cost is worked out from where a provider reports none. */
  prices: Record<string, ModelPrice>;
  session: {
    /** The main agent's notes are summarized once they pass this many tokens. */
    summarizeAtTokens: Limit;
    /** The latest turns that stay whole after a summary. */
    keepTurns: number;
    /** How long a summary may be, in tokens, as its instructions ask. */
    summaryTokens: number;
    /** How much of each tool result a receipt keeps, in characters. */
    receiptChars: number;
    /** How much of each tool call's arguments a receipt keeps, in characters. */
    receiptArgChars: number;
    /** After a rollback the notes aren't summarized again until they have grown by this many tokens, or the user asks for it. */
    rollbackMarginTokens: number;
  };
  tools: {
    /** The most characters one tool answer holds. */
    pageChars: number;
    /** The most hits or lines one page of a search or a listing shows. */
    pageItems: number;
    /** A line a grep found is shown at most this long, around what it found. */
    lineChars: number;
    /** A search hit's excerpt, in characters at most. */
    excerptChars: number;
    /** A text is indexed for search in pieces of about this many characters. */
    pieceChars: number;
    /** Messages read from the chat in one request to the host. */
    chatBatch: number;
    /** How many of the main agent's latest turns a past_turn grep without a reply reads. */
    grepTurns: number;
  };
  keep: {
    /** Each model call's exact prompt is stored, for the live view and the Sessions page. */
    prompts: boolean;
    /** Each turn's transcript is stored, for the Sessions page. */
    transcripts: boolean;
    /** Characters of stored texts kept in memory once read. */
    blobChars: number;
    /** Summaries kept in memory, so a swipe of a turn that summarized makes no second call. */
    summaries: number;
    /** How long a call's stored prompt is kept, in days; null: for good. */
    promptDays: Limit;
    /** How long a run's stored transcript is kept, in days; null: for good. */
    transcriptDays: Limit;
    /** How long the turns a summary replaced are kept after it, so it can still be rolled back, in days; null: for good. */
    spanDays: Limit;
    /** A stored text younger than this, in hours, is never swept: a run still under way hasn't yet written what refers to it. */
    graceHours: number;
  };
  trace: {
    /** While a call's answer streams, the live view is sent what arrived at most once in this many milliseconds; 0 for never. */
    deltaMs: number;
  };
  workspace: {
    /** A file's length at most, in characters. */
    fileChars: number;
    /** The files one area holds at most. */
    files: number;
    /** The length of an area's files together at most, in characters. */
    areaChars: number;
    /** A path's length at most, in characters. */
    pathChars: number;
    /** The earlier versions of a file its history keeps. */
    versions: number;
    /** The pinned files put in one agent's context, in characters at most in all. */
    pinChars: number;
    /** An agent may pin and unpin files in the user's own area (`~/`), whose pins reach every chat. Off: pins there are the user's, on the Workspace page. */
    agentsPinUser: boolean;
  };
  guidance: {
    /** One level's guidance at most, in characters: a longer file is given cut. */
    chars: number;
    /** An agent may write the chat's level (`learned/GUIDANCE.md`). The user's and the middle level are never an agent's to write. */
    agentsEdit: boolean;
  };
  skills: {
    /** The list of skills an agent is told of, in characters at most. */
    listChars: number;
  };
  delegation: {
    /** How deep delegation goes: 0 for none, 1 for the agent a run starts with alone, 2 for the agents it starts too, and so on. A job's agent stands one deeper than the agent that started the job (0 where the user did), and what it delegates counts on from there. */
    depth: number;
    /** Sub-agents at work at once in one run. */
    atOnce: number;
    /** Sub-agents one run may start in all. */
    perRun: Limit;
    /** What a sub-agent may be given: no tool the agent that starts it doesn't hold itself, or whatever its own definition names. */
    grant: "own" | "definition";
    /** The files a task names are given with it, in characters at most in all. */
    fileChars: number;
    /** The most characters `as` may hold in a `delegate` or `job_start` call: which instance of a definition an agent is. */
    asChars: number;
    /** A sub-agent whose answer goes to the reply (`delegate`'s `to_reply`): the text of each of its model calls is held until it is this long or the call ends without a tool call, then it streams. Text of a call that ends in tool calls before that is never sent. */
    replyHoldChars: number;
  };
  jobs: {
    /** Off: no job is started and none runs. */
    enabled: boolean;
    /** Jobs running at once. */
    atOnce: number;
    /** Jobs the agents of one run may start. */
    perRun: Limit;
    /** What one job's agents may spend together. */
    budget: TurnBudget;
    /** The tokens all jobs may send and write in any 24 hours. */
    tokensPerDay: Limit;
    /** A job's task at most, in characters. */
    taskChars: number;
    /** How much of a finished job's report the main agent is told at its next turn, and a list shows, in characters. */
    openingChars: number;
    /** How long a job that ends waits for the record of the turn it belongs to to be saved, in milliseconds, before that turn counts as off the path. */
    recordWaitMs: number;
    /** A job's own agents may start jobs: each such job may spend no more than is left of the one that started it, and what it spends counts against that one's too. Off: only a turn's or a side session's agents and the user start jobs. */
    chain: boolean;
    /** Sub-agents the agents of one job's run may start in all; null: no limit of its own, since its allowance bounds it. A turn's are bound by `delegation.perRun`. */
    delegations: Limit;
    /** How long a turn waits at its start for the jobs due by it (`job_start`'s `due`), in milliseconds; those still running then are named to its main agent. */
    dueWaitMs: number;
  };
  approval: {
    /** For each tier of tool: its calls run, or wait for the user's word. */
    tiers: Record<ToolTier, ApprovalRule>;
    /** Per tool, by its name, over its tier's. */
    tools: Record<string, ApprovalRule>;
    /** How long a held call waits for the user, in milliseconds; null: until the run ends. */
    waitMs: Limit;
  };
  spend: {
    /** The tokens every agent may send and write in any 24 hours. */
    tokensPerDay: Limit;
    /** What every agent's calls may cost in any 24 hours, in US dollars. */
    costPerDay: Limit;
    /**
     * What a prompt token read again from a provider's cache counts as against every limit on
     * prompt tokens (an agent's, a turn's, a job's, a day's): a share of a token, from 0 to 1. Most
     * providers bill such a token at about a tenth, and a long run re-reads its own conversation at
     * every call, so counted in full the limits would stop work that cost next to nothing.
     */
    cachedWeight: number;
  };
  extension: {
    /** How long the core waits for one answer of the extension that runs beside it, in milliseconds; null: as long as it takes. */
    waitMs: Limit;
  };
  /** Lore and history (§24): what the agents are told of the prompt, their lore and chat tools, the lore the writer sees, search by meaning and the chronicle. */
  recall: RecallSettings;
}

/** What happens to a tool's call (DESIGN §17): it runs, or it is held for the user's word. */
export type ApprovalRule = "allow" | "ask";

/** The agent definitions the core ships. */
export const AGENT = { main: "main", writer: "writer", summarizer: "summarizer" } as const;

/** Their ids: the three a turn can't do without, so none of them can be switched off or removed. */
export const CORE_AGENTS: readonly string[] = Object.values(AGENT);

/**
 * What an agent's tools name to be given every tool that isn't built in: an extension's own tools,
 * and the tools of the MCP servers the user switched on for agents, those added later too. A stored
 * name, so fixed. No built-in tool is part of it, whatever its tier: a built-in that acts outside
 * LumiAH is given to an agent by its own name, when the user chooses to.
 */
export const ADDED_TOOLS = "@added";

/** The tools the main agent is given unless the user says otherwise: every one the core has that keeps to the user's own data, and every tool the user added (`ADDED_TOOLS`), so a server switched on for agents is one the main agent can use with nothing else to set. */
export const MAIN_TOOLS: readonly string[] = [
  TOOL.chatSearch,
  TOOL.chatGrep,
  TOOL.chatRead,
  TOOL.bookOutline,
  TOOL.bookRead,
  TOOL.loreIndex,
  TOOL.loreSearch,
  TOOL.loreGrep,
  TOOL.loreRead,
  TOOL.activeLore,
  TOOL.presetInstructions,
  TOOL.pastTurn,
  TOOL.workspaceList,
  TOOL.workspaceRead,
  TOOL.workspaceGrep,
  TOOL.workspaceWrite,
  TOOL.workspaceEdit,
  TOOL.workspaceMove,
  TOOL.workspaceDelete,
  TOOL.workspacePin,
  TOOL.skillLoad,
  TOOL.delegate,
  TOOL.agentMessage,
  TOOL.jobStart,
  TOOL.jobList,
  TOOL.jobRead,
  TOOL.jobCancel,
  TOOL.writeReply,
  // Lore and history (§24). `web_search` is not among them: it sends words of the story to the user's search provider, so an agent holds it only where the user gives it by name.
  TOOL.chatOutline,
  TOOL.chatAbout,
  TOOL.chatAround,
  TOOL.loreRelated,
  TOOL.loreAbout,
  TOOL.chronicleCheck,
  TOOL.memorySearch,
  TOOL.memoryEntity,
  TOOL.memoryArcs,
  TOOL.databankList,
  TOOL.databankSearch,
  TOOL.databankRead,
  ADDED_TOOLS,
];

/** The tools the summarizer is given unless the user says otherwise: enough to read what it is asked to summarize, and nothing that changes anything. */
export const SUMMARIZER_TOOLS: readonly string[] = [TOOL.chatSearch, TOOL.chatGrep, TOOL.chatRead, TOOL.bookOutline, TOOL.bookRead, TOOL.loreSearch, TOOL.loreRead, TOOL.workspaceList, TOOL.workspaceRead, TOOL.workspaceGrep];

/** Every tool and every family of tools the core has: what an agent may be given where no more is registered (`@family` gives every tool of a family, those added to it later too). `reply_write` is nobody's by default: it is given by name, to the main agent or an extension's agent that releases the reply itself. */
export const CORE_TOOLS: readonly string[] = [...MAIN_TOOLS, TOOL.webSearch, TOOL.replyWrite, ...Object.values(FAMILY).map((family) => `@${family}`)];

/** A new user's settings. */
export function defaultSettings(): Settings {
  const unlimited = { callTokensIn: null, callMs: null, callTools: null, tokensIn: null, tokensOut: null, wallMs: null };
  return {
    // A separate writer writes, so the user's preset governs the prose as it does without LumiAH: for the same reason the writer isn't given the agents' guidance unless the user says so.
    // Built in, Lumiverse waits five minutes at most for an extension before a reply: a minute's warning leaves the main agent a round to brief in. A reply that hasn't been written ten minutes after the hand-over isn't coming.
    reply: { writer: "writer", briefAt: "before_last_user", briefRole: "system", withoutBrief: "write", progress: true, progressChars: 160, writerGuidance: false, warnMs: 60_000, pendingMs: 600_000 },
    // A message the user hid from the prompt was hidden for a reason; whose messages are the story is Lumiverse's Sovereign Hand's to say until the user says otherwise.
    story: { ...STORY_DEFAULTS },
    agents: {
      // Room in each answer for a reasoning model's thinking and a brief; enough rounds to look things up without wandering.
      [AGENT.main]: { connectionId: null, model: null, effort: "inherit", tools: [...MAIN_TOOLS], toolCalls: "auto", budget: { ...unlimited, callTokensOut: 16_000, toolTurns: 24, revisions: 2, concurrency: 4 } },
      // The writer's answer room is the request's own; this one stands only for a request that names none.
      [AGENT.writer]: { connectionId: null, model: null, effort: "inherit", tools: [], toolCalls: "auto", budget: { ...unlimited, callTokensOut: 8192, toolTurns: 8, revisions: 1, concurrency: 4 } },
      // A summary within Summary length, with room for a reasoning model's thinking before it; rounds enough to read what another agent asks it to summarize.
      [AGENT.summarizer]: { connectionId: null, model: null, effort: "inherit", tools: [...SUMMARIZER_TOOLS], toolCalls: "auto", budget: { ...unlimited, callTokensOut: 16_000, toolTurns: 12, revisions: 1, concurrency: 4 } },
    },
    // No turn-wide limit: each agent's own limits stand.
    turn: { tokensIn: null, tokensOut: null, toolTurns: null, wallMs: null },
    // An answer of fewer tokens than the floor is cut before it says anything; two rounds' warning is one to finish reading and one to answer.
    // An answer cut while it was all thinking gets one more go with twice the room: enough for a strong reasoning model that thought at length, at most 64,000 tokens so one call never runs away.
    loop: { repeats: 3, clipChars: 6000, thinkingInToolLoops: true, stream: true, charsPerToken: 3.2, retries: 2, retryWaitMs: 2000, answerFloor: 256, warnRounds: 2, cutRoomFactor: 2, cutRoomTokens: 64_000 },
    cache: { breakpoints: true, key: "" },
    // An hour is long enough not to pay for a refused call on every turn, and short enough that a connection whose model changed gets its native tools back.
    connections: { atOnce: null, throttles: {}, toolRefusalMinutes: 60 },
    prices: {},
    // A quarter of Summarize past: a rollback holds for several turns, and the notes still don't grow without end.
    // A call's arguments are kept as long as its result: a written file or a long brief is then in the notes by its start, and past_turn reads it whole.
    session: { summarizeAtTokens: 32_000, keepTurns: 3, summaryTokens: 6000, receiptChars: 600, receiptArgChars: 600, rollbackMarginTokens: 8000 },
    // A page fits under Tool results clipped past with its framing, so a tool's answer is paged, not clipped.
    tools: { pageChars: 4000, pageItems: 10, lineChars: 300, excerptChars: 400, pieceChars: 600, chatBatch: 200, grepTurns: 40 },
    // Prompts are most of what is stored, and are read only while a turn is fresh; transcripts longer; the turns a summary replaced for good, so a rollback always works.
    keep: { prompts: true, transcripts: true, blobChars: 4_000_000, summaries: 32, promptDays: 30, transcriptDays: 90, spanDays: null, graceHours: 24 },
    // Five times a second reads as writing, and is few enough frames for the link.
    trace: { deltaMs: 200 },
    // Room for notes and reference files, small enough that an index is cheap to write on every change.
    // A pin in ~/ reaches every chat, so it is the user's to set unless they say otherwise.
    workspace: { fileChars: 200_000, files: 400, areaChars: 4_000_000, pathChars: 200, versions: 10, pinChars: 12_000, agentsPinUser: false },
    guidance: { chars: 8000, agentsEdit: false },
    skills: { listChars: 4000 },
    // Two deep: the agent a run starts with, and the agents it starts. So a job the main agent starts (the chronicler's) may hand parts of its work on, and whoever takes them hands nothing further. A few at a time, and nobody gives away what it doesn't hold.
    // `as` names an instance (an entity's id), so 200 characters is room to spare. A sub-agent's text is held for its first 200 characters: what a model writes before a tool call is a line or two, and past that it is the answer.
    delegation: { depth: 2, atOnce: 3, perRun: 12, grant: "own", fileChars: 12_000, asChars: 200, replyHoldChars: 200 },
    // A job runs unattended, so each has a ceiling of its own: enough for a long look through a chat, not for running away. Its sub-agents are bounded by that ceiling, not counted.
    // A turn waits a minute at most for the jobs due by it: long enough for a digest, short enough that the user isn't left waiting on one that has stalled.
    jobs: { enabled: true, atOnce: 1, perRun: 3, budget: { tokensIn: 600_000, tokensOut: 60_000, toolTurns: 60, wallMs: 900_000 }, tokensPerDay: 3_000_000, taskChars: 4000, openingChars: 600, recordWaitMs: 120_000, chain: true, delegations: null, dueWaitMs: 60_000 },
    // Every tier runs without a word. A tool that acts outside LumiAH is one the user set up in Lumiverse and switched on for agents, or installed with an extension: that was their word, and Lumiverse's own tool calling asks no more. Asking first is one switch, by tier or by tool.
    approval: { tiers: { read: "allow", write: "allow", external: "allow" }, tools: {}, waitMs: 300_000 },
    // A cached re-read at a tenth of a token: about what providers bill it at.
    spend: { tokensPerDay: null, costPerDay: null, cachedWeight: 0.1 },
    extension: { waitMs: 10_000 },
    recall: defaultRecallSettings(),
  };
}

/** An agent definition's settings: the user's, else `fallback` (the definition's own defaults). */
export function agentSettings(settings: Readonly<Settings>, id: string, fallback: AgentSettings): AgentSettings {
  return hasOwn(settings.agents, id) ? (settings.agents[id] ?? fallback) : fallback;
}

// ---------------------------------------------------------------- the schema

// A setting's own bounds below (its least, its most, its longest) are fixed values that can't be
// settings: each keeps a setting from breaking what it sets (a page of no characters, a loop detector
// that stops the first call), and a bound that could be set would need a bound of its own.
const limit = (title: string, description: string, unit: string, minimum = 1): JsonObject => ({ title, description, type: ["integer", "null"], minimum, "x-unit": unit, "x-none": "No limit" });
const whole = (title: string, description: string, minimum: number, unit?: string, maximum?: number): JsonObject => ({ title, description, type: "integer", minimum, ...(maximum !== undefined ? { maximum } : {}), ...(unit !== undefined ? { "x-unit": unit } : {}) });
const flag = (title: string, description: string): JsonObject => ({ title, description, type: "boolean" });
const choice = (title: string, description: string, options: readonly [value: string, title: string, description?: string][]): JsonObject => ({ title, description, type: "string", oneOf: options.map(([value, name, about]) => ({ const: value, title: name, ...(about !== undefined ? { description: about } : {}) })) });

const EFFORTS: readonly [ModelEffort, string, string?][] = [
  ["inherit", "As the connection has it", "The connection's own reasoning setting, else yours in Lumiverse."],
  ["off", "Off"],
  ["auto", "Set by the model", "For a model that chooses its own effort."],
  ["minimal", "Minimal"],
  ["low", "Low"],
  ["medium", "Medium"],
  ["high", "High"],
  ["xhigh", "Extra high"],
  ["max", "Maximum"],
];

/** Whether a value is a model effort the settings take: what an extension answers for an agent's model is outside data. */
export function isEffort(value: unknown): value is ModelEffort {
  return EFFORTS.some(([effort]) => effort === value);
}

const TOOL_CALLS: readonly [ToolCalls, string, string][] = [
  ["auto", "Native, else as text", "Native tool calls where the connection takes them. Once it refuses them, the tools are described in the prompt and the model writes its calls; native calls are tried again after a time (Connections)."],
  ["native", "Native only", "Always native tool calls. A connection that refuses them fails the call."],
  ["text", "As text", "The tools are described in the prompt and the model writes its calls: for a model that calls tools better that way."],
];

const BUDGET_SCHEMA: JsonObject = {
  title: "Budget",
  description: "What this agent may spend on one message it is sent. A limit that stops it says so in the live view.",
  type: "object",
  properties: {
    callTokensIn: limit("Prompt per call", "The most one call may send, in tokens, as estimated before it is sent. A call past it isn't made.", "tokens"),
    callTokensOut: whole("Answer per call", "The most one call may write, its reasoning included (max_tokens). The writer's is the request's own where the request names one.", 1, "tokens"),
    callMs: limit("Time per call", "How long one call may take before it is given up.", "ms"),
    callTools: limit("Tool calls per answer", "The most tools one answer may call. Calls past it aren't run, and the model is told.", "calls"),
    tokensIn: limit("Prompt tokens per agent", "The most all of its calls may send.", "tokens"),
    tokensOut: limit("Answer tokens per agent", "The most all of its calls may write.", "tokens"),
    toolTurns: limit("Tool rounds per agent", "The most answers that call tools. Past it the agent is stopped.", "rounds", 0),
    wallMs: limit("Time per agent", "How long it may work from the moment it is sent its first message.", "ms"),
    revisions: whole("Revisions", "Messages it may be sent after its first answer.", 0, "messages"),
    concurrency: whole("Tool calls at once", "How many of one answer's tool calls run at the same time.", 1, "calls"),
  },
};

function agentSchema(title: string, description: string, noConnection: string, noModel: string, tools: readonly string[], toolsOwned = false): JsonObject {
  return {
    title,
    description,
    type: "object",
    properties: {
      connectionId: { title: "Connection", description: "The connection its calls go on. Never the loopback connection: its calls would come back to LumiAH.", type: ["string", "null"], format: "connection", "x-none": noConnection },
      model: { title: "Model", description: "A model of that connection to use instead of the connection's own.", type: ["string", "null"], format: "model", "x-none": noModel },
      effort: choice("Effort", "How hard its model reasons on each call.", EFFORTS),
      toolCalls: choice("Tool calls", "How its tools are offered to its model.", TOOL_CALLS),
      // Tools an extension keeps as its agent's own are its to set: shown, never read from what is stored (`read`).
      tools: toolsOwned
        ? { title: "Tools", description: "Its tools belong to the extension. You change them on that extension's own pages, not here.", type: "array", items: { type: "string" }, readOnly: true }
        : { title: "Tools", description: "The tools it is given: each by its name, or @family for every tool of a family, those added to it later too. @added is every tool you added: those of the MCP servers you switched on for agents, and an extension's. scratch_read comes with any of them, for results that come back clipped.", type: "array", items: { type: "string", enum: [...tools] }, uniqueItems: true },
      budget: BUDGET_SCHEMA,
    },
  };
}

const price = (title: string, description: string): JsonObject => ({ title, description, type: "number", minimum: 0, "x-unit": "USD per million tokens" });

/**
 * What a schema is written for beyond the core's own: every tool an agent may be given (each tool
 * the run has, and each family), and every agent definition the run has, each with what it runs
 * with by default: an extension's and the user's own, and any of the core's three that one of
 * theirs stands over; and, for an extension's, the fields it keeps as its own (`owns`).
 */
export interface SettingsScope {
  tools: readonly string[];
  agents: readonly { id: string; label: string; note: string; defaults: AgentSettings; owns?: readonly OwnedField[] }[];
}

const CORE_SCOPE: SettingsScope = { tools: CORE_TOOLS, agents: [] };

const RULES: readonly [ApprovalRule, string, string][] = [
  ["allow", "Run", "The call runs at once."],
  ["ask", "Ask me", "The call waits for you: approve it once, approve the tool for this chat, or refuse it with a reason the agent is given."],
];

/** The agents' part of the schema: the core's three definitions, then every other the run has (an extension's, the user's own). An agent may be given any tool there is; one that has nothing to offer it (`write_reply`, anywhere but the main agent) isn't built for it. */
function agentsSchema(scope: SettingsScope): JsonObject {
  return {
    title: "Agents",
    description: "What each agent runs with. What it is and what it is told are its definition's.",
    type: "object",
    properties: {
      [AGENT.main]: agentSchema("Main agent", "Works out what each reply needs, with tools, then briefs the writer or writes the reply itself.", "Your default connection", "The connection's own", scope.tools),
      [AGENT.writer]: agentSchema("Writer", "Writes the reply from the prompt Lumiverse assembled and the main agent's brief. Its sampling and answer length are your preset's. It has no tools unless you give it some; with tools, whatever it writes beside its calls is part of the reply.", "Your default connection", "The connection's own", scope.tools),
      [AGENT.summarizer]: agentSchema("Summarizer", "Summarizes the main agent's notes once they grow past Summarize past (that call takes no tools), and whatever another agent delegates to it. With no connection of its own it runs where the main agent does.", "The main agent's", "The main agent's, or its own connection's", scope.tools),
      ...Object.fromEntries(scope.agents.filter((a) => !CORE_AGENTS.includes(a.id)).map((a) => [a.id, agentSchema(a.label, a.note, "Your default connection", "The connection's own", scope.tools, a.owns?.includes("tools") === true)])),
    },
  };
}

/** The settings' JSON Schema, for the core's own tools and agents. `default` on a table's row says what a new row starts with. */
export const SETTINGS_SCHEMA: JsonObject = {
  title: "LumiAH",
  type: "object",
  properties: {
    reply: {
      title: "The reply",
      description: "Who writes the reply, and how the main agent's brief reaches the writer.",
      type: "object",
      properties: {
        writer: choice("Who writes the reply", "A separate writer keeps your preset in charge of the prose. The main agent writing it itself saves a call.", [
          ["writer", "The writer", "The main agent hands a brief to the writer, whose call is the prompt Lumiverse assembled with the brief put in."],
          ["main", "The main agent", "The main agent's final answer is the reply. There is no second call."],
        ]),
        briefAt: choice("Where the brief goes", "Where the brief is put among the messages Lumiverse assembled.", [
          ["before_last_user", "Before your last message", "Just before the last message of yours in the prompt, so whatever your preset puts after it stays last."],
          ["end", "At the end", "After every message of the prompt."],
          ["start", "At the start", "Before every message of the prompt."],
        ]),
        briefRole: choice("The brief is sent as", "Whose message the brief is.", [
          ["system", "A system message"],
          ["user", "A user message"],
        ]),
        withoutBrief: choice("If the main agent stops short", "What happens when a limit or a failed call stops the main agent before its brief.", [
          ["write", "Write the reply anyway", "The writer writes from the prompt Lumiverse assembled alone, as it would without LumiAH, and the thinking block says why."],
          ["fail", "Fail the turn", "No reply is written, and the error says why."],
        ]),
        progress: flag("Progress lines", "Write what the main agent is doing into the reply's thinking block as it works."),
        progressChars: whole("Progress line length", "The most characters one progress line holds.", 20, "characters"),
        writerGuidance: flag("Give the writer your guidance", "Put the guidance your agents are given (yours, the character's, the chat's) beside the brief in the writer's prompt. Off, the writer is sent the prompt as Lumiverse assembled it with the brief alone, and the main agent carries into the brief what of your guidance bears on the prose."),
        warnMs: { ...limit("Warn before the reply is due", "Where Lumiverse's own generation writes the reply, it waits only so long for LumiAH. This long before that time is up, the main agent is told to brief the writer with what it has.", "ms", 0), "x-none": "No warning" },
        pendingMs: { ...limit("Give up a reply that isn't written", "Where Lumiverse's own generation writes the reply: how long a turn waits for that reply before it is given up, with no record of it kept.", "ms"), "x-none": "As long as it takes" },
      },
    },
    story: {
      title: "What counts as the story",
      description: "Which of a chat's messages the agents read as its story. A chat can choose otherwise on Home, and an extension that answers a chat may set it there.",
      type: "object",
      properties: {
        hidden: choice("Messages you hid", "Messages you hid from the prompt in Lumiverse.", [
          ["leave_out", "Leave out", "The agents never read them, and their answers say how many were left out."],
          ["include", "Read them", "The agents read them like any other message."],
        ]),
        from: choice("Whose messages", "Whose messages are the story.", [
          ["lumiverse", "As Lumiverse", "Only the model's replies while Sovereign Hand is on in Lumiverse, everyone's while it is off. Where Lumiverse doesn't say, everyone's."],
          ["everyone", "Everyone's", "Your messages and the model's replies."],
          ["replies", "Replies only", "Only the model's replies. Your messages are directions to the model, not part of the story."],
        ]),
        newest: choice("Your newest message", "With only the model's replies: what the main agent is given of your newest message.", [
          ["directive", "As direction", "It is given to the main agent as the direction for the reply."],
          ["leave_out", "Leave out", "It isn't given: your preset already carries it."],
        ]),
      },
    },
    agents: agentsSchema(CORE_SCOPE),
    turn: {
      title: "The turn",
      description: "What every agent of one turn may spend together.",
      type: "object",
      properties: {
        tokensIn: limit("Prompt tokens per turn", "The most all of a turn's calls may send.", "tokens"),
        tokensOut: limit("Answer tokens per turn", "The most all of a turn's calls may write.", "tokens"),
        toolTurns: limit("Tool rounds per turn", "The most answers that call tools, over every agent of the turn.", "rounds", 0),
        wallMs: limit("Time per turn", "How long a turn's agents may work from the moment the turn starts.", "ms"),
      },
    },
    loop: {
      title: "The agent loop",
      type: "object",
      properties: {
        repeats: whole("Loop detector", "An agent that makes the same tool call, on the same state, this many times in a row is stopped.", 2, "calls"),
        clipChars: whole("Tool results clipped past", "A tool result longer than this reaches the model clipped; scratch_read reads the rest.", 200, "characters"),
        thinkingInToolLoops: flag("Thinking in tool loops", "Let a model reason on calls that offer tools. Turn it off for a connection that fails when a reasoning model's thinking must be sent back after a tool call."),
        stream: flag("Streaming", "Take every answer as the provider streams it, so a long answer's connection is never idle. The writer's reply streams either way."),
        charsPerToken: { title: "Characters per token", description: "For token estimates made before a provider reports its own count: budgets, and the length of the main agent's notes.", type: "number", minimum: 1, maximum: 8 },
        retries: whole("Retries", "A model call that fails in passing (a timeout, a rate limit, a provider error in the 500s, a stream that drops) is made again up to this many times, each shown in the live view. Never once part of the reply has reached you, and never a call one of your own limits stopped. 0 turns retries off.", 0, "retries"),
        retryWaitMs: whole("Wait before a retry", "How long to wait before a failed call is made again. The agent's and the turn's time limits still run while it waits.", 0, "ms", TIMER_MAX_MS),
        answerFloor: whole("Least answer room", "A call isn't made with less room for its answer than this. An agent whose answer tokens (its own, or its turn's) are that close to spent stops and says so, instead of writing an answer that would be cut.", 1, "tokens"),
        warnRounds: whole("Rounds left warning", "An agent is told when it has this many rounds of tool calls left, so it can finish with what it has. 0 for never.", 0, "rounds"),
        cutRoomFactor: whole("More room after a cut answer", "When a model's answer runs out of room while it is still thinking, before it writes anything or calls a tool, the call is made once more with its room times this, and the model is told to think briefly and act. 1 gives it the same room.", 1, "times"),
        cutRoomTokens: whole("Most room after a cut answer", "The most answer room that second go may have.", 1, "tokens"),
      },
    },
    cache: {
      title: "Prompt caching",
      type: "object",
      properties: {
        breakpoints: flag("Cache breakpoints", "Mark the stable start of each agent's prompt for providers that take explicit cache breakpoints, within the provider's limit."),
        key: { title: "Cache key", description: "Text put at the head of every agent's prompt. Change it to make a provider's cached prompts miss; leave it empty to send none. The writer's prompt is your preset's alone and never carries it.", type: "string", maxLength: 64 },
      },
    },
    connections: {
      title: "Connections",
      description: "How fast agents may call each connection.",
      type: "object",
      properties: {
        atOnce: limit("Calls at once", "Calls under way at once on any connection whose own throttle sets none. A call past it waits.", "calls"),
        toolRefusalMinutes: limit("Native tools tried again after", "A connection's model that refused native tools is sent them as text for this long; then native tools are tried again. None: until the runtime restarts.", "minutes"),
        throttles: {
          title: "Throttles",
          description: "Per connection. A call past a limit waits for the minute to have room.",
          type: "object",
          "x-keys": "connection",
          additionalProperties: {
            type: "object",
            default: { requestsPerMinute: null, tokensPerMinute: null, atOnce: null },
            properties: {
              requestsPerMinute: limit("Requests per minute", "The most calls sent in any one minute.", "requests"),
              tokensPerMinute: limit("Tokens per minute", "The most tokens sent and written in any one minute.", "tokens"),
              atOnce: limit("Calls at once", "Calls under way at once on this connection.", "calls"),
            },
          },
        },
      },
    },
    prices: {
      title: "Prices",
      description: "Per model. Where a provider reports no cost, a call's cost is worked out from these and shown as an estimate.",
      type: "object",
      "x-keys": "model",
      additionalProperties: {
        type: "object",
        default: { in: 0, cachedIn: 0, out: 0 },
        properties: {
          in: price("Prompt", "What a million tokens sent cost."),
          cachedIn: price("Cached prompt", "What a million tokens read from the provider's cache cost."),
          out: price("Answer", "What a million tokens written cost."),
        },
      },
    },
    session: {
      title: "The main agent's notes",
      description: "What the main agent carries from turn to turn, and when it is summarized.",
      type: "object",
      properties: {
        summarizeAtTokens: limit("Summarize past", "Once the notes pass this many tokens, the older turns are summarized. The summarized turns are kept, so a rollback on the Sessions page brings them back.", "tokens"),
        keepTurns: whole("Recent turns kept whole", "The latest turns that stay as they are after a summary.", 0, "turns"),
        summaryTokens: whole("Summary length", "How long a summary may be, as its instructions ask.", 100, "tokens"),
        receiptChars: whole("Receipt length", "How much of each tool result the notes keep of a past turn. past_turn reads the whole.", 0, "characters"),
        receiptArgChars: whole("Receipt length: arguments", "How much of each tool call's arguments the notes keep of a past turn: a file it wrote or a long brief is kept by its start. past_turn reads the whole.", 0, "characters"),
        rollbackMarginTokens: whole("After a rollback", "Once you roll a summary back, the notes aren't summarized again until they have grown by this many tokens since, or you ask for it on the Sessions page.", 0, "tokens"),
      },
    },
    tools: {
      title: "Tool answers",
      description: "How much one tool answer holds. A longer one comes in pages, each naming the cursor for the next.",
      type: "object",
      properties: {
        pageChars: whole("Answer length", "The most characters one tool answer holds. Keep it under Tool results clipped past, so answers are paged and not clipped.", 200, "characters"),
        pageItems: whole("Hits per page", "The most hits or lines one page of a search or a listing shows.", 1, "items"),
        lineChars: whole("Line length", "A line a grep found is shown at most this long, around what it found.", 40, "characters"),
        excerptChars: whole("Excerpt length", "A search hit's excerpt, at most.", 40, "characters"),
        pieceChars: whole("Search piece", "A text is indexed for search in pieces of about this size; a hit shows the piece that matched best.", 100, "characters"),
        chatBatch: whole("Chat read batch", "Messages read from the chat in one request to Lumiverse.", 1, "messages"),
        grepTurns: whole("Turns a grep reads", "How many of the main agent's latest turns past_turn searches when no reply is named.", 1, "turns"),
      },
    },
    keep: {
      title: "What is kept",
      type: "object",
      properties: {
        prompts: flag("Exact prompts", "Store each model call's exact prompt, for the live view and the Sessions page."),
        transcripts: flag("Transcripts", "Store each turn's transcript, for the Sessions page."),
        blobChars: whole("Texts in memory", "Characters of stored texts the runtime keeps in memory once read.", 0, "characters"),
        summaries: whole("Summaries in memory", "Summaries the runtime remembers, so a swipe of a turn that summarized makes no second call.", 0, "summaries"),
        promptDays: limit("Prompts kept for", "How long a model call's exact prompt is kept. After it the sweep removes it, and the live view and the Sessions page no longer show that call's prompt.", "days"),
        transcriptDays: limit("Transcripts kept for", "How long a turn's, a job's or a side session's transcript is kept. After it the sweep removes it, and the Sessions page shows that turn without its steps.", "days"),
        spanDays: limit("Summarized turns kept for", "How long the turns a summary replaced are kept after it. After it the sweep removes them, and that summary can no longer be rolled back.", "days"),
        graceHours: whole("Sweep leaves alone", "A stored text younger than this is never swept: a turn or a job still at work hasn't yet written what refers to it.", 1, "hours"),
      },
    },
    trace: {
      title: "The live view",
      type: "object",
      properties: {
        deltaMs: whole("Live answer every", "While a model's answer streams, the live view is sent what has arrived at most once in this long, so you watch it being written. 0 turns it off: the view then shows each answer once it is whole.", 0, "ms"),
      },
    },
    workspace: {
      title: "The workspace",
      description: "The files agents keep: the chat's own, which follow the story as your swipes and edits do; learned/, kept with the chat whatever path it takes; and ~/, yours, shared by all your chats.",
      type: "object",
      properties: {
        fileChars: whole("File length", "The most characters one file holds. A longer write is refused, and the agent is told to split it.", 1000, "characters"),
        files: whole("Files per area", "The most files one area holds.", 1, "files"),
        areaChars: whole("Area size", "The most characters an area's files hold together.", 1000, "characters"),
        pathChars: whole("Path length", "The most characters a file's path holds.", 20, "characters"),
        versions: whole("Versions kept", "How many earlier versions of a file its history keeps. An older one can be compared with and restored on the Workspace page.", 0, "versions"),
        pinChars: whole("Pinned files in context", "The most characters of pinned files an agent is given each turn. Past it the rest are named, with how to read them.", 0, "characters"),
        agentsPinUser: flag("Agents may pin your own files", "Let an agent pin and unpin files in ~/, your own area. A file pinned there is put in the agent's context in every chat, so off, only you pin there, on the Workspace page."),
      },
    },
    guidance: {
      title: "Guidance",
      description: "Markdown every agent is given as part of its instructions: yours (~/GUIDANCE.md), the character's or the one an extension names, and the chat's (learned/GUIDANCE.md), in that order. The writer and a summary of notes are given none.",
      type: "object",
      properties: {
        chars: whole("Guidance length", "The most characters of one level an agent is given. A longer file is given cut, and says so.", 100, "characters"),
        agentsEdit: flag("Agents may edit the chat's guidance", "Let an agent write learned/GUIDANCE.md. Yours and the middle level are never an agent's to write."),
      },
    },
    skills: {
      title: "Skills",
      type: "object",
      properties: {
        listChars: whole("Skill list length", "The most characters the list of skills takes in an agent's instructions. Past it the rest are left out of the list; skill_load still loads them.", 100, "characters"),
      },
    },
    delegation: {
      title: "Delegation",
      description: "An agent handing a task to another agent, which works in a session of its own.",
      type: "object",
      properties: {
        depth: whole("Depth", "How deep delegation goes. 0: no agent delegates. 1: only the agent a turn starts with. 2: the agents it starts may delegate too. A job's agent stands one deeper than the agent that started the job (you start one at 0), so at 2 a job the main agent starts may delegate, and the agents it hands tasks to may not.", 0, "levels"),
        atOnce: whole("Sub-agents at once", "How many sub-agents work at the same time in one turn. One started past it waits.", 1, "agents"),
        perRun: limit("Sub-agents per turn", "The most sub-agents one turn may start in all.", "agents"),
        grant: choice("What a sub-agent may be given", "The tools a sub-agent gets are those of its own definition, within this. The agent of a job that an agent starts is given its tools by the same rule.", [
          ["own", "No more than its starter holds", "A tool the agent that starts it doesn't have is left out, so delegating, or starting a job, never reaches further than the agent could itself."],
          ["definition", "Whatever its definition names", "Its definition alone decides."],
        ]),
        fileChars: whole("Files given with a task", "The most characters of the files a task names that are given with it. Past it the rest are named, with how to read them.", 0, "characters"),
        asChars: whole("Instance name length", "The most characters of as in delegate and job_start: which one of the many an agent stands for, such as a character. A longer one is refused.", 1, "characters"),
        replyHoldChars: whole("Hold before a handed-on reply streams", "When an agent hands the reply to another (to_reply in delegate), each of that agent's answers is held until it is this long or ends without a tool call, then it streams. So the line or two it writes before a tool call is never sent; what streamed is never taken back. 0 streams everything at once.", 0, "characters"),
      },
    },
    jobs: {
      title: "Jobs",
      description: "An agent's work that goes on after the reply. Only an agent's job_start call or you, on the Jobs page, start one.",
      type: "object",
      properties: {
        enabled: flag("Jobs", "Off: no job is started, and none that waits is run."),
        atOnce: whole("Jobs at once", "How many jobs run at the same time. One past it waits its turn.", 1, "jobs"),
        perRun: limit("Jobs per turn", "The most jobs the agents of one turn may start.", "jobs", 0),
        budget: {
          title: "Each job",
          description: "What the agents of one job may spend together.",
          type: "object",
          properties: {
            tokensIn: limit("Prompt tokens per job", "The most all of a job's calls may send.", "tokens"),
            tokensOut: limit("Answer tokens per job", "The most all of a job's calls may write.", "tokens"),
            toolTurns: limit("Tool rounds per job", "The most answers that call tools, over every agent of the job.", "rounds", 0),
            wallMs: limit("Time per job", "How long a job may work from the moment it starts to run.", "ms"),
          },
        },
        tokensPerDay: limit("Job tokens per day", "The most tokens all jobs may send and write in any 24 hours. A job that would pass it is stopped, and says so.", "tokens"),
        taskChars: whole("Task length", "The most characters a job's task holds. A longer one is refused: the agent is told to put the details in a workspace file.", 100, "characters"),
        openingChars: whole("Report opening", "How much of a finished job's report the main agent is told at its next turn, and the Jobs page lists. job_read reads the whole.", 40, "characters"),
        recordWaitMs: whole("Wait for a turn to be saved", "A job that ends just as its turn does waits this long for Lumiverse to save that turn's reply before it takes the turn as gone from the chat.", 0, "ms", TIMER_MAX_MS),
        chain: flag("Jobs may start jobs", "A job's own agents are offered job_start. A job so started may spend no more than is left of the one that started it, and what it spends counts against that one's allowance too. Off: only the agents of a turn or a side session, and you, start jobs."),
        delegations: limit("Delegations per job", "The most sub-agents the agents of one job may start in all. None: no limit of its own, since what a job may spend bounds it. Sub-agents per turn bounds a turn's.", "agents"),
        dueWaitMs: whole("Wait for jobs due", "How long a turn waits at its start for the jobs started as due by it (due in job_start). The main agent is told of any still running.", 0, "ms", TIMER_MAX_MS),
      },
    },
    approval: {
      title: "Approval",
      description: "Which tool calls wait for your word. A tool's tier says what it may touch: read changes nothing; write changes what LumiAH keeps (workspace files, jobs); external acts outside LumiAH (an extension's tools, MCP servers). As it ships none waits: an MCP server's tools are called once you switch the server on for agents. Choose Ask first for a tier, or for one tool, to approve each call.",
      type: "object",
      properties: {
        tiers: {
          title: "By tier",
          type: "object",
          properties: {
            read: choice("Read tools", "Tools that change nothing.", RULES),
            write: choice("Write tools", "Tools that change what LumiAH keeps.", RULES),
            external: choice("External tools", "Tools that act outside LumiAH.", RULES),
          },
        },
        tools: { title: "By tool", description: "Per tool, over its tier's.", type: "object", "x-keys": "tool", additionalProperties: { ...choice("Calls of this tool", "What happens to a call of it.", RULES), default: "ask" } },
        waitMs: { ...limit("Wait for your word", "How long a held call waits. When it runs out the call is refused, and the agent is told why.", "ms"), "x-none": "Until the turn ends" },
      },
    },
    spend: {
      title: "Spend",
      description: "Caps on what every agent together may spend. A cap that is reached refuses the next model call, in words that name it.",
      type: "object",
      properties: {
        tokensPerDay: limit("Tokens per day", "The most tokens every agent's calls may send and write in any 24 hours, a cached re-read counted at its weight.", "tokens"),
        costPerDay: { title: "Cost per day", description: "The most every agent's calls may cost in any 24 hours. A call whose cost isn't known (its provider reports none and its model has no price) counts as nothing.", type: ["number", "null"], minimum: 0, "x-unit": "USD", "x-none": "No limit" },
        cachedWeight: { title: "What a cached re-read counts as", description: "Against every limit on prompt tokens (per agent, per turn, per job, per day), a prompt token read again from the provider's cache counts as this share of a token, since most providers bill it at about a tenth. Set 1 to count it in full. Spend and every page still show the true counts.", type: "number", minimum: 0, maximum: 1, "x-unit": "of a token" },
      },
    },
    extension: {
      title: "The extension beside LumiAH",
      type: "object",
      properties: {
        waitMs: { ...limit("Wait for the extension", "How long a turn waits for one answer of an extension that builds LumiAH into itself (its definitions, its claim on a chat, its rewrite of the writer's request, its hooks). Past it the turn goes on without that answer.", "ms"), "x-none": "As long as it takes" },
      },
    },
    recall: RECALL_SETTINGS_SCHEMA,
  },
};

// ---------------------------------------------------------------- reading and checking

/** A value the settings refused: where it is, and why. */
export interface SettingsProblem {
  path: (string | number)[];
  message: string;
}

/** The types a schema node takes, "null" among them for a setting that may be none. */
function typesOf(schema: JsonObject): string[] {
  const type = schema.type;
  return Array.isArray(type) ? type.filter((t): t is string => typeof t === "string") : typeof type === "string" ? [type] : [];
}

/** The values a node's `enum`, or its `oneOf` of constants, allows; null when it has neither. */
function allowed(schema: JsonObject): JsonValue[] | null {
  if (Array.isArray(schema.enum)) return schema.enum;
  if (Array.isArray(schema.oneOf)) return schema.oneOf.flatMap((option) => (isRecord(option) && option.const !== undefined ? [option.const as JsonValue] : []));
  return null;
}

function clone<T extends JsonValue>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

/**
 * `value` read against `schema`: itself where the schema takes it, else `fallback` with the reason in
 * `problems`. An object is read key by key, so one bad value costs only itself; a key the schema
 * doesn't have is a problem and is left out. Absent, a value is its fallback and no problem; so is
 * one at a setting the schema marks `readOnly` (another's to set: an extension's agent's own tools).
 */
function read(schema: JsonObject, fallback: JsonValue, value: unknown, path: (string | number)[], problems: SettingsProblem[]): JsonValue {
  if (value === undefined || schema.readOnly === true) return clone(fallback);
  const refuse = (message: string): JsonValue => {
    problems.push({ path, message });
    return clone(fallback);
  };
  const types = typesOf(schema);
  if (value === null) return types.includes("null") ? null : refuse("It can't be none.");
  if (types.includes("object")) {
    if (!isRecord(value)) return refuse("It must be a group of settings.");
    const out: JsonObject = {};
    if (isRecord(schema.properties)) {
      const base = isRecord(fallback) ? fallback : {};
      for (const [key, node] of Object.entries(schema.properties)) if (isRecord(node)) out[key] = read(node as JsonObject, (base[key] ?? null) as JsonValue, value[key], [...path, key], problems);
      for (const key of Object.keys(value)) if (!hasOwn(schema.properties, key)) problems.push({ path: [...path, key], message: "There is no such setting." });
      return out;
    }
    const row = isRecord(schema.additionalProperties) ? (schema.additionalProperties as JsonObject) : null;
    if (!row) return refuse("It can't be set.");
    for (const [key, item] of Object.entries(value)) {
      if (key.trim() === "") problems.push({ path: [...path, key], message: "A row needs a name." });
      else out[key] = read(row, (row.default ?? null) as JsonValue, item, [...path, key], problems);
    }
    return out;
  }
  if (types.includes("array")) {
    if (!Array.isArray(value)) return refuse("It must be a list.");
    const items = isRecord(schema.items) ? (schema.items as JsonObject) : {};
    const choices = allowed(items);
    const out: JsonValue[] = [];
    value.forEach((item: unknown, i) => {
      if (typeof item !== "string") problems.push({ path: [...path, i], message: "It must be text." });
      else if (choices && !choices.includes(item)) problems.push({ path: [...path, i], message: `It must be one of: ${choices.join(", ")}.` });
      else if (schema.uniqueItems === true && out.includes(item)) problems.push({ path: [...path, i], message: "It is listed twice." });
      else out.push(item);
    });
    return out;
  }
  if (types.includes("boolean")) return typeof value === "boolean" ? value : refuse("It must be on or off.");
  if (types.includes("integer") || types.includes("number")) {
    if (typeof value !== "number" || !Number.isFinite(value)) return refuse("It must be a number.");
    if (types.includes("integer") && !Number.isSafeInteger(value)) return refuse("It must be a whole number.");
    if (typeof schema.minimum === "number" && value < schema.minimum) return refuse(`It must be at least ${schema.minimum}.`);
    if (typeof schema.maximum === "number" && value > schema.maximum) return refuse(`It must be at most ${schema.maximum}.`);
    return value;
  }
  if (types.includes("string")) {
    if (typeof value !== "string") return refuse("It must be text.");
    const choices = allowed(schema);
    if (choices && !choices.includes(value)) return refuse(`It must be one of: ${choices.join(", ")}.`);
    if (typeof schema.maxLength === "number" && value.length > schema.maxLength) return refuse(`It must be at most ${schema.maxLength} characters.`);
    return value;
  }
  return refuse("It can't be set.");
}

/** The settings' JSON Schema for a harness whose registries hold more than the core's own (`scope`). */
export function settingsSchema(scope: SettingsScope): JsonObject {
  return { ...SETTINGS_SCHEMA, properties: { ...(SETTINGS_SCHEMA.properties as JsonObject), agents: agentsSchema(scope) } };
}

/** The schema and the defaults `scope` gives: the core's own for none. */
function shapeOf(scope: SettingsScope | undefined): { schema: JsonObject; defaults: JsonValue } {
  const defaults = defaultSettings();
  if (!scope) return { schema: SETTINGS_SCHEMA, defaults: defaults as unknown as JsonValue };
  // A definition's own values are what its agent runs with until the user sets others in Settings: one that stands over a core definition brings its own too.
  for (const a of scope.agents) defaults.agents[a.id] = a.defaults;
  return { schema: settingsSchema(scope), defaults: defaults as unknown as JsonValue };
}

/** What is wrong with `values` as settings: each value the schema refuses, where it is and why. None for settings that can be kept as they are. */
export function checkSettings(values: unknown, scope?: SettingsScope): SettingsProblem[] {
  const problems: SettingsProblem[] = [];
  const { schema, defaults } = shapeOf(scope);
  read(schema, defaults, values ?? {}, [], problems);
  return problems;
}

/**
 * The settings from `values` as stored (the user's own, whole or in part): each value the schema
 * takes, over the defaults. Anything else reads as its default.
 */
export function settingsOf(values: unknown, scope?: SettingsScope): Settings {
  const { schema, defaults } = shapeOf(scope);
  // `read` gives every key of the schema a value the schema takes, which is what `Settings` is: the
  // defaults test (test/core/settings.test.ts) holds the two together.
  return read(schema, defaults, isRecord(values) ? values : {}, [], []) as unknown as Settings;
}

// ---------------------------------------------------------------- one agent definition's own

/** What a new agent definition of the user's runs with until they say otherwise: the core's defaults for an agent that reads and answers. */
export function newAgentSettings(): AgentSettings {
  return clone(defaultSettings().agents[AGENT.summarizer] as unknown as JsonValue) as unknown as AgentSettings;
}

/** The schema of what one agent definition runs with (its connection, model, effort, tools and budget), in the settings' dialect: the form a page edits a definition's with. */
export function agentRunSchema(tools: readonly string[]): JsonObject {
  return agentSchema("Runs with", "What this agent runs with unless Settings say otherwise.", "Your default connection", "The connection's own", tools);
}

/** What `value` gives one agent definition to run with: each value the schema takes, over `fallback`; what it refuses goes to `problems`, under `path`. */
export function readAgentSettings(value: unknown, tools: readonly string[], fallback: AgentSettings, path: (string | number)[], problems: SettingsProblem[]): AgentSettings {
  return read(agentRunSchema(tools), fallback as unknown as JsonValue, isRecord(value) ? value : {}, path, problems) as unknown as AgentSettings;
}
