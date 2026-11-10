// The core's settings (DESIGN §3.3): every limit the core keeps and every choice it makes, each with
// its default, as one JSON object the user's own values are merged over. `SETTINGS_SCHEMA` is its
// JSON Schema, written by hand in the keywords the Settings page builds its forms from
// (src/shared/ui.ts says which): the same schema checks a value the user sets (`checkSettings`) and
// reads the settings as stored (`settingsOf`), so the page offers exactly what the core takes.
//
// A setting that may be none (no limit, the connection's own) holds null. A stored value the schema
// refuses reads as its default, and a key the schema doesn't have is left out, so settings written
// by another build never break a turn.

import type { JsonObject, JsonValue, ModelEffort } from "./ports";
import { isRecord } from "./ports";
import { TOOL } from "./texts";
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

/** What an agent definition runs with: its connection and model (null: see the definition), its effort, the tools it is given, and its budget. */
export interface AgentSettings {
  connectionId: string | null;
  model: string | null;
  effort: ModelEffort;
  tools: string[];
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
  };
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
  };
  trace: {
    /** While a call's answer streams, the live view is sent what arrived at most once in this many milliseconds; 0 for never. */
    deltaMs: number;
  };
}

/** The agent definitions the core ships. */
export const AGENT = { main: "main", writer: "writer", summarizer: "summarizer" } as const;

/** The tools the main agent is given unless the user says otherwise: every base tool. */
export const MAIN_TOOLS: readonly string[] = [TOOL.chatSearch, TOOL.chatGrep, TOOL.chatRead, TOOL.loreIndex, TOOL.loreSearch, TOOL.loreGrep, TOOL.loreRead, TOOL.activeLore, TOOL.presetInstructions, TOOL.pastTurn, TOOL.writeReply];

/** A new user's settings. */
export function defaultSettings(): Settings {
  const unlimited = { callTokensIn: null, callMs: null, callTools: null, tokensIn: null, tokensOut: null, wallMs: null };
  return {
    // A separate writer writes, so the user's preset governs the prose as it does without LumiAH.
    reply: { writer: "writer", briefAt: "before_last_user", briefRole: "system", withoutBrief: "write", progress: true, progressChars: 160 },
    agents: {
      // Room in each answer for a reasoning model's thinking and a brief; enough rounds to look things up without wandering.
      [AGENT.main]: { connectionId: null, model: null, effort: "inherit", tools: [...MAIN_TOOLS], budget: { ...unlimited, callTokensOut: 16_000, toolTurns: 24, revisions: 2, concurrency: 4 } },
      // The writer's answer room is the request's own; this one stands only for a request that names none.
      [AGENT.writer]: { connectionId: null, model: null, effort: "inherit", tools: [], budget: { ...unlimited, callTokensOut: 8192, toolTurns: 8, revisions: 1, concurrency: 4 } },
      // A summary within Summary length, with room for a reasoning model's thinking before it.
      [AGENT.summarizer]: { connectionId: null, model: null, effort: "inherit", tools: [], budget: { ...unlimited, callTokensOut: 16_000, toolTurns: 4, revisions: 0, concurrency: 1 } },
    },
    // No turn-wide limit: each agent's own limits stand.
    turn: { tokensIn: null, tokensOut: null, toolTurns: null, wallMs: null },
    loop: { repeats: 3, clipChars: 6000, thinkingInToolLoops: true, stream: true, charsPerToken: 3.2, retries: 2, retryWaitMs: 2000 },
    cache: { breakpoints: true, key: "" },
    connections: { atOnce: null, throttles: {} },
    prices: {},
    session: { summarizeAtTokens: 32_000, keepTurns: 3, summaryTokens: 6000, receiptChars: 600 },
    // A page fits under Tool results clipped past with its framing, so a tool's answer is paged, not clipped.
    tools: { pageChars: 4000, pageItems: 10, lineChars: 300, excerptChars: 400, pieceChars: 600, chatBatch: 200, grepTurns: 40 },
    keep: { prompts: true, transcripts: true, blobChars: 4_000_000, summaries: 32 },
    // Five times a second reads as writing, and is few enough frames for the link.
    trace: { deltaMs: 200 },
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

function agentSchema(title: string, description: string, noConnection: string, noModel: string, tools: readonly string[]): JsonObject {
  return {
    title,
    description,
    type: "object",
    properties: {
      connectionId: { title: "Connection", description: "The connection its calls go on. Never the loopback connection: its calls would come back to LumiAH.", type: ["string", "null"], format: "connection", "x-none": noConnection },
      model: { title: "Model", description: "A model of that connection to use instead of the connection's own.", type: ["string", "null"], format: "model", "x-none": noModel },
      effort: choice("Effort", "How hard its model reasons on each call.", EFFORTS),
      tools: { title: "Tools", description: "The tools it is given. scratch_read comes with any of them, for results that come back clipped.", type: "array", items: { type: "string", enum: [...tools] }, uniqueItems: true },
      budget: BUDGET_SCHEMA,
    },
  };
}

const price = (title: string, description: string): JsonObject => ({ title, description, type: "number", minimum: 0, "x-unit": "USD per million tokens" });

/**
 * What a schema is written for beyond the core's own: every tool an agent may be given (each tool in
 * the harness's registry), and the agent definitions an extension registered, each with what it runs
 * with by default.
 */
export interface SettingsScope {
  tools: readonly string[];
  agents: readonly { id: string; label: string; note: string; defaults: AgentSettings }[];
}

const CORE_SCOPE: SettingsScope = { tools: MAIN_TOOLS, agents: [] };

/** The agents' part of the schema: the core's three definitions, then an extension's. An agent may be given any tool there is; one that has nothing to offer it (`write_reply`, anywhere but the main agent) isn't built for it. */
function agentsSchema(scope: SettingsScope): JsonObject {
  return {
    title: "Agents",
    description: "What each agent runs with. Its instructions are among the texts.",
    type: "object",
    properties: {
      [AGENT.main]: agentSchema("Main agent", "Works out what each reply needs, with tools, then briefs the writer or writes the reply itself.", "Your default connection", "The connection's own", scope.tools),
      [AGENT.writer]: agentSchema("Writer", "Writes the reply from the prompt Lumiverse assembled and the main agent's brief. Its sampling and answer length are your preset's. It has no tools unless you give it some; with tools, whatever it writes beside its calls is part of the reply.", "Your default connection", "The connection's own", scope.tools),
      [AGENT.summarizer]: agentSchema("Summarizer", "Summarizes the main agent's notes once they grow past Summarize past. With no connection of its own it runs where the main agent does.", "The main agent's", "The main agent's, or its own connection's", scope.tools),
      ...Object.fromEntries(scope.agents.map((a) => [a.id, agentSchema(a.label, a.note, "Your default connection", "The connection's own", scope.tools)])),
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
      },
    },
    trace: {
      title: "The live view",
      type: "object",
      properties: {
        deltaMs: whole("Live answer every", "While a model's answer streams, the live view is sent what has arrived at most once in this long, so you watch it being written. 0 turns it off: the view then shows each answer once it is whole.", 0, "ms"),
      },
    },
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
 * doesn't have is a problem and is left out. Absent, a value is its fallback and no problem.
 */
function read(schema: JsonObject, fallback: JsonValue, value: unknown, path: (string | number)[], problems: SettingsProblem[]): JsonValue {
  if (value === undefined) return clone(fallback);
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
  for (const a of scope.agents) defaults.agents[a.id] ??= a.defaults;
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
