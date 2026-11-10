// Core's ports (DESIGN §4.2): the one object, the host, through which the core reaches the world, and
// the shapes that cross it. The runtime implements the host over the link; tests implement it in
// memory. A host serves one user, the one the runtime signed in as, so no port takes a user id.
//
// Also here, because the caller and the live session view read them: a turn as the runtime hands it
// to the core (`TurnRequest`), where the reply goes (`ReplySink`), the record a turn leaves for the
// caller to anchor on the reply's message (`TurnRecord`), and the trace every agent's work goes to
// (`TraceEvent`, with the transcript entries, agent starts and usage it carries).
//
// Nothing in this file is behaviour: types, and core's one guard for outside data (core imports
// nothing from outside `src/core`).

// ---------------------------------------------------------------- JSON

export type JsonValue = string | number | boolean | null | JsonValue[] | { [key: string]: JsonValue };
export type JsonObject = { [key: string]: JsonValue };

/** A plain object (not null, not an array): its fields are still to be checked. */
export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

// ---------------------------------------------------------------- model calls

/**
 * A part of a model message: text, a tool call the model made, a tool's result going back, or media
 * the request carried (an image, audio or video, passed on as it came). `cache` marks a cache
 * breakpoint after the part, which only a provider that takes explicit breakpoints reads.
 */
export type ModelPart =
  | { type: "text"; text: string; cache?: true }
  | { type: "tool_use"; id: string; name: string; input: JsonObject; thoughtSignature?: string; cache?: true }
  | { type: "tool_result"; toolUseId: string; content: string; isError?: true; cache?: true }
  | { type: "media"; media: "image" | "audio" | "video"; data: string; mimeType: string; cache?: true };

/** A provider's thinking block (Anthropic's signed `thinking`, or `redacted_thinking`), sent back verbatim after a tool call. */
export interface ModelThinkingBlock {
  type: "thinking" | "redacted_thinking";
  thinking?: string;
  signature?: string;
  data?: string;
}

/**
 * A message of a model call. `content` is its text; a tool turn or a message with media goes as
 * `parts` instead, and then `content` renders them as text, for logs and estimates. An assistant turn
 * carries what its model gave of its reasoning, sent back as given on the next call: the reasoning
 * text (DeepSeek's `reasoning_content`, which a thinking model must be sent again after a tool call),
 * Anthropic's thinking blocks and OpenRouter's `reasoning_details`.
 */
export interface ModelMessage {
  role: "system" | "user" | "assistant";
  content: string;
  parts?: ModelPart[];
  reasoning?: string;
  thinkingBlocks?: ModelThinkingBlock[];
  reasoningDetails?: JsonObject[];
}

/**
 * How hard a model reasons on a call, as Lumiverse's per-request reasoning override takes it:
 * `inherit` leaves it to the connection's reasoning binding, else the user's Lumiverse setting; `off`
 * turns reasoning off; `auto` lets the model choose (alias models that pick their own); the rest ask
 * for that effort, which the host maps to each provider's own field.
 */
export type ModelEffort = "inherit" | "off" | "auto" | "minimal" | "low" | "medium" | "high" | "max" | "xhigh";

/** Sampling parameters by the names Lumiverse's generation call takes; each one left out is the connection's own. */
export interface SamplingParams {
  temperature?: number;
  top_p?: number;
  top_k?: number;
  min_p?: number;
  frequency_penalty?: number;
  presence_penalty?: number;
  repetition_penalty?: number;
  seed?: number;
  stop?: string[];
}

/**
 * A tool a call offers: its parameters as a JSON Schema. `cache` marks a cache breakpoint after it:
 * the tools up to it are one cached prefix, read first, whatever follows them.
 */
export interface ModelTool {
  name: string;
  description: string;
  parameters: JsonObject;
  cache?: true;
}

/** A tool call the model made, its arguments parsed; `thoughtSignature`, Google's, goes back with it. */
export interface ModelToolCall {
  callId: string;
  name: string;
  args: JsonObject;
  thoughtSignature?: string;
}

export interface ModelRequest {
  messages: ModelMessage[];
  /** What the call may write, its reasoning included. */
  maxTokens: number;
  /** The connection the call goes on; null: the user's default connection. */
  connectionId: string | null;
  /** Overrides the connection's model for this call; null: the connection's own. */
  model: string | null;
  /** Tools the model may call instead of answering; absent: none. */
  tools?: ModelTool[];
  /** The model may call one tool per answer at most (the connection takes no parallel tool calls). */
  parallelToolCalls?: false;
  /** Absent: `inherit`. */
  effort?: ModelEffort;
  /** With an effort of the call's own, the model's thinking comes back as text (`summarized`); absent: the host's default. */
  thinkingDisplay?: "summarized";
  /** Absent: every one is the connection's own. */
  params?: SamplingParams;
  /** Asks the provider for its token usage: only then does an OpenAI-compatible stream report it. */
  usage?: true;
  /** Takes the answer as the provider streams it, each delta handed to the call's `onDelta`; the result is the same whole answer. */
  stream?: true;
}

/** A piece of a streaming call's answer as it arrives: its text, or its reasoning. */
export interface ModelDelta {
  content?: string;
  reasoning?: string;
}

export interface ModelResult {
  /** The answer's text; for a streamed call, every delta's text together. */
  content: string;
  /** How the call ended, as the provider said: `stop`, `tool_calls`, `length`, `max_tokens`, … */
  finishReason: string;
  /** The model that answered, when the host says. */
  model?: string;
  /** Present when the model called tools natively. */
  toolCalls?: ModelToolCall[];
  /** The model's reasoning text, when the provider gave it. */
  reasoning?: string;
  /** Reasoning carriers to send back on the next call after a tool call, when the host passes them. */
  thinkingBlocks?: ModelThinkingBlock[];
  reasoningDetails?: JsonObject[];
  /** The provider's usage as Lumiverse passed it: `prompt_tokens`, `completion_tokens`, `total_tokens`, and in `provider_raw` the provider's own fields (its cache counts, reasoning tokens, cost). */
  usage?: JsonObject;
}

export interface ModelsPort {
  /**
   * One model call. A call with `stream` hands each delta to `onDelta` as it arrives. The signal ends
   * the call: it rejects with the signal's reason. A failed call rejects with an `Error` whose message
   * is the provider's or Lumiverse's own words, status included where there was one ("503: …"). The
   * loop reads two things from them: a refusal of native tools, which it asks again with the tools
   * as text; and a failure that passes (a timeout, a rate limit, a 5xx, a stream that dropped),
   * which it makes again as Settings allow.
   */
  call(request: ModelRequest, signal: AbortSignal, onDelta?: (delta: ModelDelta) => void): Promise<ModelResult>;
}

// ---------------------------------------------------------------- connections

/** A connection as the user's list has it. */
export interface ConnectionInfo {
  id: string;
  name: string;
  provider: string;
  /** Its own model; null when it names none. */
  model: string | null;
  /** It is a loopback connection: a call on it would come back to the runtime, so no agent may use it. */
  loopback: boolean;
}

/**
 * A connection as the loop needs it: its explicit cache breakpoints (null where the provider takes
 * none; else the most a request may hold, the provider's own limit, and those the connection's own
 * prompt caching adds to every request on it: one after the leading system messages, one on the last
 * message, one on the last tool, and one for its automatic mode), and whether it takes several tool
 * calls in one answer.
 */
export interface ConnectionProfile extends ConnectionInfo {
  cache: { limit: number; system: boolean; lastMessage: boolean; tools: boolean; automatic: boolean } | null;
  parallelTools: boolean;
}

export interface ConnectionsPort {
  list(): Promise<ConnectionInfo[]>;
  /** One connection (null: the user's default); null when there is no such connection. */
  get(connectionId: string | null): Promise<ConnectionProfile | null>;
}

// ---------------------------------------------------------------- blobs and documents

/**
 * Text stored once by its hash, never changed. The core computes every hash (`textHash`: SHA-256 of
 * the text's UTF-8, in lower-case hex) and checks what it reads against it, so the store only keeps
 * and returns text by key. A put of a hash already stored writes the same text again.
 */
export interface BlobsPort {
  put(hash: string, text: string): Promise<void>;
  /** The text under `hash`; null when none is stored. */
  get(hash: string): Promise<string | null>;
}

/** Small JSON documents by path (`a/b.json`), each read and written whole. */
export interface StorePort {
  /** The document at `path`; null when there is none. */
  read(path: string): Promise<JsonValue | null>;
  write(path: string, value: JsonValue): Promise<void>;
  remove(path: string): Promise<void>;
}

// ---------------------------------------------------------------- the chat

export type ChatRole = "user" | "assistant" | "system";

/**
 * A message of the chat's active path, without its text: its id, its place in the chat
 * (`index_in_chat`, from 0), whose it is, the swipe it shows, and that swipe's length and hash
 * (`textHash` of its text, so a changed text changes it), and LumiAH's anchor for that swipe: the
 * record stored under LumiAH's key in the message's extension metadata for the swipe shown, as
 * stored (the core checks it), or null when it has none.
 */
export interface PathMessage {
  id: string;
  index: number;
  role: ChatRole;
  name: string;
  swipeId: number;
  chars: number;
  hash: string;
  anchor: JsonValue | null;
}

/** A message of the active path with the text of the swipe it shows. */
export interface ChatMessage {
  id: string;
  index: number;
  role: ChatRole;
  name: string;
  swipeId: number;
  content: string;
}

export interface ChatPort {
  /** The chat's active path, oldest first. */
  path(chatId: string): Promise<PathMessage[]>;
  /** The active path's messages whose `index` is `from` or more and less than `to`, oldest first. */
  messages(chatId: string, from: number, to: number): Promise<ChatMessage[]>;
  /**
   * Writes LumiAH's record for one swipe of a message that is there, in place of the one it holds;
   * false when the message or the swipe is gone. A turn's own record doesn't come this way: `answer`
   * returns it, and its caller anchors it once Lumiverse has saved the reply. This is for a record
   * that changes afterwards (a rollback marks the record of the turn whose compaction it undoes).
   */
  anchor(chatId: string, messageId: string, swipeId: number, record: JsonValue): Promise<boolean>;
}

// ---------------------------------------------------------------- lore and the preset

/** A world book that applies to the chat (the chat's, its character's, its persona's, or a global one). */
export interface LoreBook {
  id: string;
  name: string;
  description: string;
}

/** An entry of a world book, as stored. `title` is its comment; `enabled` false: switched off. */
export interface LoreEntry {
  id: string;
  bookId: string;
  title: string;
  keys: string[];
  secondaryKeys: string[];
  content: string;
  enabled: boolean;
  constant: boolean;
}

/** An entry Lumiverse activated for this generation, with the text it put in the prompt. */
export interface ActivatedLore {
  entryId: string;
  bookId: string;
  title: string;
  content: string;
}

export interface LorePort {
  /** The world books that apply to the chat. */
  books(chatId: string): Promise<LoreBook[]>;
  /** A book's entries, in the book's order. */
  entries(bookId: string): Promise<LoreEntry[]>;
  /** The entries Lumiverse activated for the generation. */
  activated(chatId: string, generationId: string): Promise<ActivatedLore[]>;
}

/**
 * A block of the active preset: an instruction (text the preset author wrote, which the reply must
 * achieve) or a marker (where Lumiverse puts something of its own: the chat history, World Info, the
 * character's description; `marker` names which). `content` is the block's text as stored, its
 * macros unfilled; `enabled` false: switched off, so it isn't in the prompt.
 */
export interface PresetBlock {
  id: string;
  name: string;
  role: ChatRole;
  kind: "instruction" | "marker";
  marker: string | null;
  content: string;
  enabled: boolean;
}

export interface PresetPort {
  /** The preset's blocks, in order; none for a preset that isn't there. */
  blocks(presetId: string): Promise<PresetBlock[]>;
}

// ---------------------------------------------------------------- the turn

/** What kind of generation a turn answers. */
export type TurnKind = "new" | "regenerate" | "swipe" | "continue";

/**
 * Where a message of the assembled prompt came from, where the extension could tell: a message of
 * the chat's history (its id and `index_in_chat`), or a block of the preset (its id).
 */
export type RequestSource = { kind: "history"; messageId: string; index: number } | { kind: "block"; blockId: string };

export interface RequestMessage extends ModelMessage {
  source?: RequestSource;
}

/**
 * A turn, as the runtime hands it to the core: whose it is, the chat, the generation's id and kind,
 * the message and swipe it writes (for a new reply, the empty message Lumiverse made for it, or null
 * where Lumiverse makes the reply's message only as it saves it, so the reply comes after every
 * message of the path; for a regenerate or a swipe, the new swipe; for a continue, the swipe it
 * continues), the preset the prompt was assembled from, the assembled messages as Lumiverse sent
 * them, and the request's own sampling parameters and answer room.
 */
export interface TurnRequest {
  userId: string;
  chatId: string;
  generationId: string;
  kind: TurnKind;
  target: { messageId: string | null; swipeId: number };
  presetId: string | null;
  messages: RequestMessage[];
  params: SamplingParams;
  /** The answer room the request asks for; null when it names none. */
  maxTokens: number | null;
}

/**
 * Where a turn's reply goes. `progress` lines and `reasoning` go to the reply's thinking block,
 * `content` is the reply's text. A turn ends with exactly one `done` (with the finish reason and the
 * turn's usage) or one `error`; nothing follows it.
 */
export interface ReplySink {
  progress(text: string): void;
  reasoning(text: string): void;
  content(text: string): void;
  done(finish: string, usage: AgentUsage): void;
  error(message: string, code?: string): void;
}

/**
 * The record a turn leaves (DESIGN §5), which the caller anchors on the turn's target swipe once
 * Lumiverse has saved it: the turn (its generation's id and kind, and when it ended), the path hash
 * chained over the messages before the reply, what the turn spent, and the hashes of its bodies,
 * each a blob (`BlobsPort`): the turn's session segment, its transcript (absent while Settings keep
 * none), and the compaction summary it made, if it made one.
 *
 * With a summary: `kept` names the segments of the turns before this one that stay whole after it,
 * oldest first, and `folded` says how many turns it took in. The turns a summary replaced stay on
 * their own records, which nothing removes, so a rollback writes only `rolledBack` (when it was
 * made): the session then reads past this summary as if it had never been made.
 */
export interface TurnRecord {
  v: 1;
  generationId: string;
  kind: TurnKind;
  at: number;
  path: string;
  segment: string;
  transcript?: string;
  summary?: string;
  kept?: string[];
  folded?: number;
  rolledBack?: number;
  usage: AgentUsage;
}

/** How a turn ended: its reply written, failed, or stopped by its signal. */
export type TurnStatus = "done" | "failed" | "stopped";

/**
 * What `answer` gives back: how the turn ended (and why, where it didn't finish), its record to
 * anchor (null when no reply was written, so there is no message to anchor it on, or its bodies
 * couldn't be stored), the reply's text as sent, and the turn's usage.
 */
export interface TurnResult {
  status: TurnStatus;
  reason?: string;
  record: TurnRecord | null;
  reply: string;
  usage: AgentUsage;
}

// ---------------------------------------------------------------- usage

/** A count a call's provider didn't report, which holds the runtime's estimate instead. */
export type UsageField = "in" | "cachedIn" | "out" | "reasoningOut" | "cost";

/** One call's tokens: `in` (of which `cachedIn` read from the cache, `cacheWrite` written to it) and `out` (of which `reasoningOut` reasoning), and its cost in US dollars where the provider said or a price setting gives it. */
export interface CallUsage {
  in: number;
  cachedIn: number;
  cacheWrite?: number;
  out: number;
  reasoningOut: number;
  /** The counts the provider didn't report, which hold the runtime's estimate. */
  estimated: UsageField[];
  cost?: number;
}

/** An agent's usage so far, a turn's, or one send's: its calls and rounds of tool calls, its tokens, how long its calls took, and its cost where every call's was known. */
export interface AgentUsage {
  calls: number;
  toolTurns: number;
  in: number;
  cachedIn: number;
  cacheWrite?: number;
  out: number;
  reasoningOut: number;
  /** Some of the counts are the runtime's estimate. */
  estimated: boolean;
  ms: number;
  cost?: number;
}

// ---------------------------------------------------------------- the trace

/** How a send ended: an answer, a limit refusing, the loop detector, a cancel, or a failed call. */
export type AgentStatus = "answered" | "refused" | "stopped" | "cancelled" | "failed";

/** Why an agent stopped short of an answer. */
export type AgentStopCode =
  | "revisions"
  | "busy"
  | "call_tokens_in"
  | "tokens_in"
  | "tokens_out"
  | "tool_turns"
  | "turn_tokens_in"
  | "turn_tokens_out"
  | "turn_tool_turns"
  | "call_time"
  | "wall_time"
  | "turn_time"
  | "throttle"
  | "connection"
  | "loop"
  | "cancelled"
  | "failed";

/** The tools a call was offered (natively or as text, `scratch_read` among them): how many, and their definitions' tokens as estimated. */
export interface OfferedTools {
  tools: number;
  tokens: number;
}

/** A tool call a model made: its id (the provider's, or one the runtime gave a call written as text), its tool and its arguments. */
export interface ToolCallView {
  id: string;
  name: string;
  args: JsonObject;
}

/**
 * One step of an agent's work: a message it was sent, a model's answer (its reasoning where the model
 * gave it, its tool calls), a call its connection refused for its native tools (asked again with them
 * as text), a call that failed in passing and is made again (`retry`: which try this is of how many
 * Settings allow, the failure's own words, and how long it waits first), a tool's result, or its
 * stop. `prompt` names the blob of that call's exact request (`readCallPrompt`): on an answer, on a
 * refusal, on a retry, and on a stop that ended a call under way (one that failed, timed out or was
 * cancelled); absent while Settings keep no prompts.
 */
export type TranscriptEntry =
  | { kind: "message"; text: string; at: number }
  | { kind: "answer"; text: string; reasoning?: string; calls: ToolCallView[]; written: boolean; tools: "native" | "text" | "none"; offered?: OfferedTools; usage: CallUsage; model: string; finishReason: string; ms: number; at: number; prompt?: string }
  | { kind: "tools_refused"; reason: string; ms: number; at: number; prompt?: string }
  | { kind: "retry"; reason: string; attempt: number; of: number; waitMs: number; ms: number; at: number; prompt?: string }
  | { kind: "result"; callId: string; name: string; text: string; error: boolean; scratch?: string; ms: number; at: number }
  | { kind: "stop"; status: AgentStatus; code: AgentStopCode; reason: string; at: number; prompt?: string };

/** An agent starting work: its id and role, its connection, model and effort, what it is told first, how many messages of a conversation it takes up, and who started it. */
export interface AgentStarted {
  id: string;
  role: string;
  connectionId: string | null;
  model: string | null;
  effort: ModelEffort;
  system: string;
  prefix: string[];
  history: number;
  /** The agent that started it; none for the turn's main agent. */
  parent?: string;
  /** What it was started for, in a few words. */
  task?: string;
  at: number;
}

/**
 * What the main agent carries into a turn (DESIGN §5): the session segments it read, their tokens as
 * estimated, whether a summary stands for the turns before them, the replies whose notes were dropped
 * because an earlier message changed (by their chat index), the blobs it names that the store couldn't
 * give, the compaction the turn made of it, and a compaction a rollback undid that it read past (the
 * summary's hash).
 */
export interface SessionTrace {
  turns: number;
  tokens: number;
  summary: boolean;
  dropped: number[];
  missing: number;
  compacted?: { folded: number; kept: number; summary: string };
  rolledBack?: { summary: string };
}

/** Everything a turn's agents do, as the live session view renders it. */
export type TraceEvent =
  | { kind: "turn_started"; turn: string; chatId: string; generation: TurnKind; messageId: string | null; at: number }
  | { kind: "session"; session: SessionTrace; at: number }
  | { kind: "agent_started"; agent: AgentStarted }
  | { kind: "agent_entry"; agentId: string; entry: TranscriptEntry }
  | { kind: "usage"; agentId: string; call: CallUsage; agent: AgentUsage; turn: AgentUsage; at: number }
  | { kind: "agent_idle"; agentId: string; spent: AgentUsage; at: number }
  | { kind: "turn_ended"; status: TurnStatus; reason?: string; usage: AgentUsage; at: number };

/** A trace event with its turn and chat, numbered from 1 within its turn with no gap. */
export interface TraceRecord {
  turn: string;
  chatId: string;
  seq: number;
  event: TraceEvent;
}

/** A piece of a streaming call's answer for the live view only: what arrived since the last one. Never stored, never numbered; the call's `answer` entry replaces it. */
export interface TraceDelta { turn: string; chatId: string; agentId: string; call: number; text?: string; reasoning?: string; at: number }

export interface TracePort {
  /** One event: delivered in order, never answered. */
  event(record: TraceRecord): void;
  /**
   * A piece of a streaming call's answer, in order, every piece before its call's closing entry.
   * `call` is the agent's model call counted from 1, the same count its `answer` entries follow: a
   * call that failed and is made again keeps its number. Optional, so a host without it still fits.
   */
  delta?(delta: TraceDelta): void;
}

// ---------------------------------------------------------------- time and diagnostics

export interface ClockPort {
  now(): number;
  /** Waits `ms`; rejects with the signal's reason when it ends first. */
  sleep(ms: number, signal: AbortSignal): Promise<void>;
}

export type LogLevel = "debug" | "info" | "warn" | "error";

export interface LogPort {
  (level: LogLevel, message: string): void;
}

// ---------------------------------------------------------------- the host

/**
 * The host. A port a later slice adds (a workspace, jobs, guidance files, skills, MCP servers) joins
 * as an optional member, so a host written for this slice still fits.
 */
export interface HarnessHost {
  models: ModelsPort;
  connections: ConnectionsPort;
  blobs: BlobsPort;
  store: StorePort;
  chat: ChatPort;
  lore: LorePort;
  preset: PresetPort;
  trace: TracePort;
  clock: ClockPort;
  log: LogPort;
}
