// The link (DESIGN §6): what the runtime (src/runtime) and the extension backend
// (src/extension/backend) say to each other. The runtime is a client of Lumiverse like any other: it
// signs in as the user, finds the extension, opens the event socket as a widget session and sends
// the requests below as SPINDLE_BACKEND_MSG frames. Each is answered by its `id` with exactly one
// `result` or `error` frame, sent to the runtime's own session (`sendToFrontend(…, { frontendSessionId })`).
// The extension pushes to that session too: a stream's chunks, a turn to stop, settings that changed,
// a relay secret rotated, a loopback connection to make.
//
// Rules both ends keep:
// - Every frame carries `link: LINK`, so neither end mistakes it for the frontend's messages
//   (src/shared/ui.ts), which travel the same channel.
// - Every request but `register` carries the relay's secret. The extension refuses one without a
//   valid secret (`forbidden`), and takes the frame's session as where that runtime's pushes go
//   from then on, so a runtime that reconnected is found on its new session. A `register` may show
//   the secret its runtime already holds: it then keeps the registration and binds no session.
// - `hello` says the link version both ways; a mismatch is refused in words that name which side
//   to update (`versionWords`).
// - A stream (a model call's answer, a passthrough's) is named by the runtime before it asks, so no
//   chunk can arrive for a stream it doesn't know. Its chunks are numbered from 1 with no gap; the
//   extension keeps them until they are acknowledged; the runtime reorders, drops duplicates, asks
//   `stream.resend` after a gap, and acknowledges in batches and always the terminal chunk
//   (stream.ts holds both ends' bookkeeping).
// - A stream ends with exactly one terminal chunk: `done` (the whole answer) or `error`.
// - A runtime carries only its own account's turns: a loopback key or a turn's tag of another user
//   is refused.
// - A frame too large for Lumiverse's socket crosses in parts (parts.ts), either way.
// - The reads and writes of the core's ports (`blob.*`, `doc.*`, `chat.*`, `lore.*`, `preset.*`,
//   `connections.*`, `model.call`, `trace.push`, `recall.*`, `book.read`) carry the ports' own
//   shapes (src/core/ports.ts, src/core/recall/ports.ts), so the two can't drift apart.
// - A notice is what the runtime tells the extension without waiting for an answer: a model's
//   answer as it arrives, for the live view. It has no id and no secret. The extension takes one
//   only from a session a hello bound to a runtime, in the order they were sent; one that is lost
//   is not sent again.

import type { ActivatedLore, ApprovalAsk, BlobInfo, ChatBook, ChatInfo, ChatMessage, ConnectionInfo, ConnectionProfile, JobView, LoreBook, LoreEntry, ModelRequest, ModelResult, PathMessage, PresetBlock, RemoteTool, RemoteToolCall, RequestSource, StoredAnchor, TraceDelta, TraceRecord, TurnKind, TurnRecord } from "../core/ports";
import type { ActivatedEntry, Databank, DatabankDocument, EmbedderInfo, LoreBookRead, MemoryArc, MemoryEntity, MemoryEntityBrief, MemoryHit, TimedMessage, WebResult } from "../core/recall/ports";
import type { JsonObject, JsonValue } from "./json";

export type { TurnKind } from "../core/ports";

/** The level of this contract: `hello` says it both ways, and each end refuses another. */
export const LINK_VERSION = 1;

/** The key every frame of the link carries, with this value. */
export const LINK = "lumiah-link";

/** LumiAH's identifier in Lumiverse (`spindle.json`): how the runtime finds the extension, and the key of the records it writes in a message's extension metadata. */
export const EXTENSION_IDENTIFIER = "lumi_ah";

/** The model LumiAH's own runtime lists at `GET /v1/models`, and its loopback connection names. */
export const MODEL_ID = "lumiah";

/**
 * The model the loopback connection of an extension names, and its runtime lists: LumiAH's own, or
 * one that says which extension LumiAH is built into (DESIGN §21). Both ends derive it from the
 * extension's identifier, so a user with LumiAH and such an extension has two loopback connections
 * that neither backend and neither runtime takes for the other's.
 */
export function loopbackModel(identifier: string): string {
  return identifier === EXTENSION_IDENTIFIER ? MODEL_ID : `${MODEL_ID}-${identifier}`;
}

/** Whether two base addresses are one, as a person would write either: without regard to a trailing slash or to case. */
export function sameBase(a: string, b: string): boolean {
  const at = (url: string): string => url.trim().replace(/\/+$/, "").toLowerCase();
  return at(a) === at(b);
}

/**
 * Whether a Custom connection's calls come back to the runtime at one of `bases`, for the extension
 * whose loopback model is `model`: it names that model, or it sits at one of those addresses and
 * names no other extension's. One that names another extension's loopback model is that extension's
 * even at a matching address (a port its runtime took over from one set up here before). The
 * backend (which chats it answers) and the runtime (where it puts the key) ask the same.
 */
export function loopsBack(connection: { model: string; url: string }, model: string, bases: readonly string[]): boolean {
  if (connection.model === model) return true;
  // Every extension's loopback model is LumiAH's own or starts with it (`loopbackModel`).
  if (connection.model === MODEL_ID || connection.model.startsWith(`${MODEL_ID}-`)) return false;
  return bases.some((base) => sameBase(base, connection.url));
}

/** The body parameter the prompt interceptor sets on a generation it tags; the runtime takes it out before the body goes on. */
export const TAG_PARAM = "lumiah_turn";

/** What a loopback key starts with, so one pasted in the wrong place is recognised. */
export const KEY_PREFIX = "lah_";

/**
 * A loopback key as the extension mints one: the prefix, then 256 random bits as hex. The runtime
 * refuses a request whose key isn't of this form before it reads the request's body; whether a key
 * of this form is the user's own stays the extension's to say.
 */
export const KEY_FORM = new RegExp(`^${KEY_PREFIX}[0-9a-f]{64}$`);

/** A runtime's name: one per (user, name); `up` defaults it to the Lumiverse username. */
export const RUNTIME_NAME = /^[a-z0-9][a-z0-9_-]{0,39}$/;

/** A stream's id and a request's own: 128 random bits as hex, named by the runtime. */
export const STREAM_ID = /^[0-9a-f]{32}$/;

/** A blob's key: the core's hash of its text (SHA-256, lower-case hex). */
export const BLOB_HASH = /^[0-9a-f]{64}$/;

/**
 * The largest frame either end sends whole. Lumiverse's socket closes on a larger one from a client
 * and may close a slow one it sends more to; this is its limit, not one of LumiAH's, so it can't be
 * a setting. A larger frame crosses in parts (parts.ts).
 */
export const FRAME_LIMIT = 4 * 1024 * 1024;

/**
 * Whether the runtime's origin is in its account's local-inference scheduler exclusions: `excluded`;
 * `missing` (it isn't, and adding it failed); `unavailable` (this Lumiverse has no scheduler); or
 * `unknown` (not asked yet).
 */
export type SchedulerState = "excluded" | "missing" | "unavailable" | "unknown";

/** The runtime's Lumiverse session as it last asked about it (`GET /api/auth/get-session`, daily). */
export interface SessionReport {
  /** Null: Lumiverse couldn't be asked. */
  valid: boolean | null;
  expiresAt: string | null;
  /** When it asked, in ms since the epoch; null before it has. */
  checkedAt: number | null;
}

/** What a runtime says of itself on `hello` and every `ping`, for the Runtime page. */
export interface RuntimeReport {
  name: string;
  build: string;
  /**
   * How it runs, for the Runtime page's update and sign-in lines: the Bun binary (absolute), its own
   * script (its stable copy under a unit), and the systemd user unit running it (null when none does).
   */
  runtime: { bun: string | null; script: string; unit: string | null };
  /** The machine it runs on. */
  host: string;
  /** Where Lumiverse reaches it: `http://<listen>:<port>/v1`. */
  listen: string;
  port: number;
  scheduler: SchedulerState;
  session: SessionReport;
  /** Turns it is answering now. */
  turns: number;
}

/** A stream the runtime is still reading, with the last chunk it holds in order (0 before any). */
export interface OpenStream {
  stream: string;
  seq: number;
}

/**
 * A history message of the assembled prompt as the interceptor saw it: a mark of its text
 * (`contentMark`) and the chat message it came from. Lumiverse sends the provider no word of where a
 * message came from, so the runtime finds each in the request's body by its mark.
 */
export interface SourceMark {
  mark: string;
  source: RequestSource;
}

/** The turn a tagged request belongs to, as the extension knows it (DESIGN §2 step 4). */
export interface TurnFacts {
  /** The turn's id: its generation's. */
  turn: string;
  user: string;
  chat: string;
  generation: string;
  kind: TurnKind;
  /**
   * The message and swipe the reply writes: a new reply's staged message, a regenerate's or a
   * swipe's new swipe, a continue's continued swipe. `message` is null for a new reply Lumiverse
   * makes its message for only when it saves it (edit and send): the record is anchored then.
   */
  target: { message: string | null; swipe: number };
  /** The preset the prompt was assembled with; null when none. */
  preset: string | null;
  /** The prompt's messages whose source the interceptor could tell, in the prompt's order. */
  sources: SourceMark[];
  /** The settings' revision now: the runtime reads them again (`settings.get`) when it holds another. */
  settings: number;
}

/**
 * The user's settings and texts: the settings whole with defaults filled in, the texts the user
 * replaced, by id, and their own definitions as stored (their agents and skills, and what they
 * switched off: DESIGN §13), which the core reads and checks itself.
 */
export interface SettingsSnapshot {
  revision: number;
  values: JsonObject;
  texts: Record<string, string>;
  definitions?: JsonValue;
}

/** How a turn's record was taken: written on the reply's message now, written once Lumiverse saves the reply, or not written (the reply's message is gone). */
export type Anchoring = "now" | "on_save" | "never";

// ---------------------------------------------------------------- stream chunks

/**
 * A piece of a stream: the answer's text and the model's reasoning as they are written, then exactly
 * one terminal chunk: `done` with the whole answer as Lumiverse's generation API gave it; `value`
 * with the outcome of something else that takes its time (a tool that ran in the extension, the
 * user's answer to an approval), which rides a stream so it survives a reconnect and can be given
 * up like a call; or `error` with the provider's, the tool's or Lumiverse's own words.
 */
export type StreamChunk =
  | { kind: "content"; text: string }
  | { kind: "reasoning"; text: string }
  | { kind: "done"; result: ModelResult }
  | { kind: "value"; value: JsonValue }
  | { kind: "error"; message: string; code: string };

/** Whether a chunk ends its stream. */
export function terminal(chunk: StreamChunk): boolean {
  return chunk.kind === "done" || chunk.kind === "value" || chunk.kind === "error";
}

// ---------------------------------------------------------------- a request passed through

/**
 * A part of a passed-through message, as Lumiverse's generation call carries one: text, media as
 * its data (an image, audio or video, base64), a tool call the model made, or a tool's result
 * going back. `cacheControl` is the part's cache breakpoint, as the request gave it.
 */
export type PassedPart =
  | { type: "text"; text: string; cacheControl?: JsonObject }
  | { type: "media"; media: "image" | "audio" | "video"; data: string; mimeType: string; cacheControl?: JsonObject }
  | { type: "tool_use"; id: string; name: string; input: JsonObject }
  | { type: "tool_result"; toolUseId: string; content: string; cacheControl?: JsonObject };

/**
 * A message of a request passed through (one with no tag): everything of it that Lumiverse's
 * generation call has a place for. Its content is its text as it came, or its parts where the
 * request gave parts, tool calls or tool results. `name` is the participant's name; `prefix` marks
 * an assistant message the model is to continue (`prefix: true` or `partial: true` in the request,
 * `partial` to Lumiverse); `reasoning` and `reasoningDetails` are an assistant turn's reasoning,
 * sent back as the model gave it (`reasoning_content`, `reasoning_details`). What a request holds
 * beyond these the runtime refuses the request for (runtime/openai.ts): nothing is dropped.
 */
export interface PassedMessage {
  role: "system" | "user" | "assistant";
  content: string | PassedPart[];
  name?: string;
  prefix?: true;
  cacheControl?: JsonObject;
  reasoning?: string;
  reasoningDetails?: JsonObject[];
}

/** A tool a passed-through request offers: a function, its parameters as a JSON Schema, and `strict` where the request said it. */
export interface PassedTool {
  name: string;
  description: string;
  parameters: JsonObject;
  strict?: boolean;
}

// ---------------------------------------------------------------- requests and their results

/** Each request's fields (beside the envelope: `link`, `type`, `id`) and its result. */
export interface LinkRequests {
  /**
   * `up` registers its runtime with the user's own session: the extension mints its secret (kept
   * only as a hash), and a later register of the same name replaces it. Unless that one shows the
   * secret the registration has (`secret`: what `up` holds of a runtime it set up before): then the
   * registration stands, its secret is answered back, and where its pushes go is left alone, so a
   * runtime still answering with that secret isn't cut off before `up` restarts it. `model`: the
   * model its loopback connection names; `backend`: who it registered with (absent from a backend
   * from before it could say: LumiAH's own).
   */
  register: { fields: { name: string; build: string; host: string; listen: string; port: number; secret?: string }; result: { relay: string; secret: string; model: string; user: string; backend?: LinkedBackend } };
  /** On every socket the runtime opens: binds its pushes to this session and resumes its open streams from the chunk after `seq`. `lost`: the streams the extension no longer holds (it restarted). `settings`: the user's settings' revision now. `backend`: who it is linked to. */
  hello: { fields: { secret: string; version: number; build: string; report: RuntimeReport; open: OpenStream[] }; result: { relay: string; version: number; build: string; lost: string[]; settings: number; extension?: ExtensionOffer | null; backend?: LinkedBackend } };
  /** The heartbeat, naming the streams the runtime reads and the turns it answers: the streams the extension no longer holds end at once, and a turn its runtime no longer names is over. */
  ping: { fields: { secret: string; report: RuntimeReport; streams: string[]; turns: string[] }; result: { lost: string[] } };
  /** `GET /v1/models` (the connection's model list and its Test): whether the key is the user's loopback key. */
  models: { fields: { secret: string; key: string }; result: { models: { id: string }[] } };
  /** A tagged request: the tag checked and spent, answered with the turn. `request` is the runtime's own id for it: asked again (after a reconnect), it answers as before; another request with the same tag is refused. */
  "turn.begin": { fields: { secret: string; key: string; tag: string; request: string }; result: TurnFacts };
  /**
   * The turn's record, to write on the reply's message: at once when Lumiverse has saved the reply,
   * else when it does. The chat and the target are the turn's own (`TurnFacts`), said again so the
   * record finds its message even when the extension started again while the turn ran.
   */
  "turn.commit": { fields: { secret: string; turn: string; chat: string; target: { message: string | null; swipe: number }; record: TurnRecord }; result: { anchoring: Anchoring } };
  /**
   * An untagged request: run as given on `connection` (the writer's; null: the user's default),
   * answered on `stream`. Its messages and tools are whole (`PassedMessage`, `PassedTool`);
   * `parameters` is every field of the request's body but its messages, tools, model and stream
   * flags, as Lumiverse sent them.
   */
  passthrough: { fields: { secret: string; key: string; stream: string; connection: string | null; messages: PassedMessage[]; tools: PassedTool[]; parameters: JsonObject }; result: { accepted: true } };
  /** One model call of an agent, answered on `stream`. `turn` names the turn it serves, so Lumiverse's Stop ends it; null outside one. */
  "model.call": { fields: { secret: string; stream: string; turn: string | null; request: ModelRequest }; result: { accepted: true } };
  /** The runtime holds every chunk of `stream` through `seq`. `done`: the stream is over and forgotten. */
  "stream.ack": { fields: { secret: string; stream: string; seq: number }; result: { done: boolean } };
  /** A gap: push the stream's chunks again from `from`. `last`: the last chunk the extension holds; null when it holds none. */
  "stream.resend": { fields: { secret: string; stream: string; from: number }; result: { last: number | null } };
  /** The runtime gave a stream up before its terminal chunk (its caller cancelled it). */
  "stream.cancel": { fields: { secret: string; stream: string; reason: string }; result: { cancelled: boolean } };
  /** The user's settings and texts now. */
  "settings.get": { fields: { secret: string }; result: SettingsSnapshot };
  /** Trace records, in the order the trace port delivered them, for the live buffer. One a turn's buffer holds already (sent again after a reconnect) counts once. */
  "trace.push": { fields: { secret: string; records: TraceRecord[] }; result: { taken: number } };
  /** What became of a `connection` push: the loopback connection the runtime made or put the key in, or why it couldn't. */
  "setup.connection": { fields: { secret: string; ref: string; connection: { id: string; name: string } | null; problem: string | null }; result: { taken: true } };
  "blob.get": { fields: { secret: string; hash: string }; result: { text: string | null } };
  "blob.put": { fields: { secret: string; hash: string; text: string }; result: { stored: true } };
  "doc.get": { fields: { secret: string; path: string }; result: { doc: JsonValue | null } };
  "doc.put": { fields: { secret: string; path: string; doc: JsonValue }; result: { written: true } };
  "doc.remove": { fields: { secret: string; path: string }; result: { removed: true } };
  /** The chat's active path, oldest first, each message with its anchor for the swipe it shows. */
  "chat.path": { fields: { secret: string; chat: string }; result: { messages: PathMessage[] } };
  /** The active path's messages whose index is `from` or more and less than `to`, with their text. */
  "chat.messages": { fields: { secret: string; chat: string; from: number; to: number }; result: { messages: ChatMessage[] } };
  /** A record written over the one a message holds for a swipe (a rollback's mark); false when the message or the swipe is gone. */
  "chat.anchor": { fields: { secret: string; chat: string; message: string; swipe: number; record: JsonValue }; result: { written: boolean } };
  /** The world books that apply to the chat. */
  "lore.books": { fields: { secret: string; chat: string }; result: { books: LoreBook[] } };
  "lore.entries": { fields: { secret: string; book: string }; result: { entries: LoreEntry[] } };
  /** The entries Lumiverse activated for a generation. */
  "lore.activated": { fields: { secret: string; chat: string; generation: string }; result: { entries: ActivatedLore[] } };
  /** A preset's blocks, in order, each switched on or off as it is for `chat` (a chat's preset binding may set its own over the preset's); null: as the preset has them. */
  "preset.blocks": { fields: { secret: string; preset: string; chat: string | null }; result: { blocks: PresetBlock[] } };
  "connections.list": { fields: { secret: string }; result: { connections: ConnectionInfo[] } };
  /** One connection (null: the user's default). */
  "connections.get": { fields: { secret: string; connection: string | null }; result: { profile: ConnectionProfile | null } };
  /** The tools that run in the extension, as they stand for a chat (`""`: none): the extension's own, and those of the MCP servers the user left on (DESIGN §13, §16). */
  "tools.list": { fields: { secret: string; chat: string }; result: { tools: RemoteTool[] } };
  /** Runs one of them, answered on `stream` with one `value` chunk: `{ text, error? }`. `turn` is the run it serves, so the run's stop ends it. */
  "tool.call": { fields: { secret: string; stream: string; call: RemoteToolCall }; result: { accepted: true } };
  /** Holds a tool call for the user's word (§17), answered on `stream` with one `value` chunk: the `ApprovalAnswer`. The runtime cancels the stream when the wait runs out or the run stops, which takes the ask down. */
  "approval.ask": { fields: { secret: string; stream: string; ask: ApprovalAsk }; result: { accepted: true } };
  /** One member of what the extension supplies to the core (§21), run in its backend: what it answered (null where it answers nothing); `supplied` false when it has no such member. */
  "extension.call": { fields: { secret: string; member: ExtensionMember; arg: JsonValue }; result: { supplied: boolean; value: JsonValue } };
  /** Every blob stored, a page at a time, for upkeep (§20). `cursor`: the `next` of the page before; null for the first. */
  "blob.list": { fields: { secret: string; cursor: string | null }; result: { blobs: BlobInfo[]; next: string | null } };
  "blob.remove": { fields: { secret: string; hashes: string[] }; result: { removed: true } };
  /** The path of every document under a prefix, at any depth. */
  "doc.list": { fields: { secret: string; prefix: string }; result: { paths: string[] } };
  /** The chat itself; null when the user has no such chat. */
  "chat.info": { fields: { secret: string; chat: string }; result: { chat: ChatInfo | null } };
  /** Every record LumiAH holds on a swipe of a message, in every chat of the user's, a page at a time, for upkeep. */
  "chat.anchors": { fields: { secret: string; cursor: string | null }; result: { anchors: StoredAnchor[]; next: string | null } };
  /** A job was queued, or changed (it began, was paused or resumed, or ended): for the pages' lists, and to tell the user when one finishes or needs them (§15). */
  "job.changed": { fields: { secret: string; job: JobView }; result: { taken: true } };
  /** What the runtime answered to an `ask` push: its value (null where the op gives none), or what refused it: one of the pages' error codes (`internal` for a failure of the runtime's own), words the page shows, and what was wrong with a value where the core says. */
  "ask.answer": { fields: { secret: string; ask: string; value: JsonValue; refusal: { code: string; message: string; problems?: JsonValue } | null }; result: { taken: true } };
  // What the lore and history tools read beyond `lore.*` and `chat.*` (DESIGN §24): each member of
  // the core's `RecallPorts`, and a chat's book (§23), for the runtime's own user. A backend from
  // before them knows none of these requests and says so; the runtime then reads what the older
  // requests give, and takes what has no older request as not set up.
  /** Every world book that applies to the chat, each with every entry and its state. `known`: the stamp the runtime holds for each book it read before, by book; a book that still has that stamp comes with `entries` null. */
  "recall.lore.read": { fields: { secret: string; chat: string; known: Record<string, number> }; result: { books: LoreBookRead[] } };
  /** How Lumiverse activated each entry it put in a generation's prompt. */
  "recall.lore.activated": { fields: { secret: string; chat: string; generation: string }; result: { entries: ActivatedEntry[] } };
  /** As `chat.messages`, each message with when it was sent. */
  "recall.chat.messages": { fields: { secret: string; chat: string; from: number; to: number }; result: { messages: TimedMessage[] } };
  /** The user's main embedding connection; null when they have none to embed on. */
  "recall.embedder": { fields: { secret: string }; result: { connection: EmbedderInfo | null } };
  /** One vector per text, in order, on that connection: `EMBED_BATCH_MAX` texts at most, none blank, each of `EMBED_TEXT_MAX` characters at most. */
  "recall.embed": { fields: { secret: string; texts: string[]; kind: "query" | "stored" }; result: { vectors: number[][]; model: string; dimensions: number } };
  /** Whether Lumiverse's Memory Cortex is on for the chat. */
  "recall.memory.enabled": { fields: { secret: string; chat: string }; result: { enabled: boolean } };
  /** The Cortex's own ranked answer to a query over the chat's memory, `limit` at most; `entities`: only what names one of them (none: everything). */
  "recall.memory.search": { fields: { secret: string; chat: string; query: string; limit: number; entities: string[] }; result: { hits: MemoryHit[] } };
  /** What the Cortex has of an entity of the chat's, by its name or an alias; null when it has none so named. */
  "recall.memory.entity": { fields: { secret: string; chat: string; name: string }; result: { entity: MemoryEntity | null } };
  "recall.memory.entities": { fields: { secret: string; chat: string; limit: number }; result: { entities: MemoryEntityBrief[] } };
  "recall.memory.arcs": { fields: { secret: string; chat: string }; result: { arcs: MemoryArc[] } };
  /** The databanks that apply to the chat and are switched on. */
  "recall.databanks.list": { fields: { secret: string; chat: string }; result: { databanks: Databank[] } };
  "recall.databanks.documents": { fields: { secret: string; databank: string }; result: { documents: DatabankDocument[] } };
  /** A document's text; null when it has none to read. */
  "recall.databanks.content": { fields: { secret: string; document: string }; result: { text: string | null } };
  /** Whether the user has a web search provider switched on. */
  "recall.web.enabled": { fields: { secret: string }; result: { enabled: boolean } };
  /** The provider's results for a query, `count` at most; `pages`: with each page's text where Lumiverse read it. */
  "recall.web.search": { fields: { secret: string; query: string; count: number; pages: boolean }; result: { results: WebResult[] } };
  /** The chat's LumiBooks book; null when it has none. */
  "book.read": { fields: { secret: string; chat: string }; result: { book: ChatBook | null } };
}

export type LinkRequestType = keyof LinkRequests;

/** A request as it crosses: its envelope and its fields. */
export type LinkRequest = { [K in LinkRequestType]: { link: typeof LINK; type: K; id: string } & LinkRequests[K]["fields"] }[LinkRequestType];

export type LinkRequestOf<K extends LinkRequestType> = Extract<LinkRequest, { type: K }>;

/** Why the extension refused a request. `version`: the two ends speak different link versions. */
export type LinkErrorCode = "bad_request" | "forbidden" | "not_found" | "conflict" | "unavailable" | "version" | "too_large" | "internal";

export interface LinkResultFrame {
  link: typeof LINK;
  type: "result";
  id: string;
  body: unknown;
}

export interface LinkErrorFrame {
  link: typeof LINK;
  type: "error";
  id: string;
  code: LinkErrorCode;
  message: string;
}

// ---------------------------------------------------------------- pushes

/** A chunk of a stream, to the runtime's session. */
export interface ChunkPush {
  link: typeof LINK;
  type: "chunk";
  stream: string;
  seq: number;
  chunk: StreamChunk;
}

/** Where the user pressed Stop: in LumiAH's live view, or in Lumiverse (its own Stop, which the extension hears). */
export type StopBy = "live" | "lumiverse";

/**
 * Stop a turn: the user pressed Stop. `why` is what the turn's end then says. `by` says where: a
 * reply stopped from the live view is one Lumiverse still generates, so the runtime asks Lumiverse
 * to stop it as its own Stop does. Optional so builds from before it still read each other's stop:
 * an older runtime ignores it, and an older extension's push without it only ends the turn.
 */
export interface StopPush {
  link: typeof LINK;
  type: "stop";
  turn: string;
  why: string;
  by?: StopBy;
}

/** The user's settings or texts changed: the runtime reads them again before it next needs them. */
export interface SettingsPush {
  link: typeof LINK;
  type: "settings";
  revision: number;
}

/** The user rotated this runtime's relay secret on the Runtime page: the runtime keeps the new one, and the old one no longer works. */
export interface SecretPush {
  link: typeof LINK;
  type: "secret";
  relay: string;
  secret: string;
}

/**
 * First-time setup, and every new loopback key: the runtime puts the key in the user's loopback
 * connection with its own Lumiverse session, making the connection when there is none (Spindle gives
 * an extension no way to), and says what it did by `ref` (`setup.connection`). It never keeps the key.
 * `name`: what to call a connection it makes (absent: as the last hello said, else LumiAH's own).
 */
export interface ConnectionPush {
  link: typeof LINK;
  type: "connection";
  ref: string;
  key: string;
  name?: string;
}

/**
 * Something a page asked for that the core does where it runs: the runtime holds the harness, and
 * is the one writer of what the core keeps (DESIGN §4), so a file the user edits, a job they start
 * or a list they read is asked of it (`op` and `args`: ops.ts). The runtime answers with
 * `ask.answer`, naming `ask`.
 */
export interface AskPush {
  link: typeof LINK;
  type: "ask";
  ask: string;
  op: string;
  args: JsonObject;
}

export type LinkPush = ChunkPush | StopPush | SettingsPush | SecretPush | ConnectionPush | AskPush;

// ---------------------------------------------------------------- the extension LumiAH is built into

/** The members of what an extension supplies to the core (`HarnessExtension`), each a request over the link (`extension.call`). */
export type ExtensionMember = "definitions" | "claim" | "writerRequest" | "runBegan" | "replyWritten" | "runEnded";

export const EXTENSION_MEMBERS: readonly ExtensionMember[] = ["definitions", "claim", "writerRequest", "runBegan", "replyWritten", "runEnded"];

/** What the backend's extension supplies to the core, as the runtime is told on hello: its name, and which members it has. Null for LumiAH on its own. */
export interface ExtensionOffer {
  name: string;
  members: ExtensionMember[];
}

/**
 * Who a runtime is linked to (DESIGN §21): LumiAH's own backend, or that of an extension LumiAH is
 * built into. A runtime's command line names only the extension's identifier, so the backend says
 * the rest: on `register`, for `up`, and on every `hello`.
 */
export interface LinkedBackend {
  /** The name its pages show: where the runtime's words send the user (`<name>'s Runtime page`). */
  name: string;
  /** The name the runtime gives the loopback connection it makes. */
  connection: string;
}

/** LumiAH's own, which a runtime takes where a backend doesn't say who it is (one from before it could). */
export const OWN_BACKEND: LinkedBackend = { name: "LumiAH", connection: "LumiAH" };

// ---------------------------------------------------------------- notices

/**
 * What arrived of model calls under way since the last notice, in the order it arrived: each delta
 * is the text and reasoning one agent's call gained (`TraceDelta`, as the core's trace port takes
 * it). Deltas of one call that follow each other may come joined into one.
 */
export interface DeltasNotice {
  link: typeof LINK;
  type: "trace.deltas";
  deltas: TraceDelta[];
}

export type LinkNotice = DeltasNotice;

/** A piece of a frame too large to cross whole (parts.ts): the frame's text, cut into `count` pieces under one `id`. */
export interface PartFrame {
  link: typeof LINK;
  type: "part";
  id: string;
  index: number;
  count: number;
  data: string;
}

export type LinkFrame = LinkRequest | LinkResultFrame | LinkErrorFrame | LinkPush | LinkNotice | PartFrame;

/**
 * The words for a version mismatch, naming which side to update: the runtime with its start line
 * again (from the extension's build), or the extension in Lumiverse's Extensions tab. `name`: the
 * extension as its pages show it.
 */
export function versionWords(runtime: number, extension: number, name = "LumiAH"): string {
  if (runtime < extension) return `This runtime speaks link version ${runtime} and ${name} ${extension}: update the runtime by running its start line on ${name}'s Runtime page again.`;
  return `This runtime speaks link version ${runtime} and ${name} ${extension}: update ${name} in Lumiverse (Extensions → ${name} → Update), then restart the runtime.`;
}

/**
 * A mark of a prompt message that both ends compute alike: its role, its text's length and a 32-bit
 * FNV-1a hash of the text's UTF-16 units. It tells one message of a prompt from another, nothing
 * more: no secret hangs on it.
 */
export function contentMark(role: string, text: string): string {
  let hash = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return `${role.charAt(0)}${text.length.toString(36)}.${(hash >>> 0).toString(36)}`;
}

/** Where Lumiverse reaches a runtime (the loopback connection's base URL); `[::1]`-style hosts keep their brackets. */
export function runtimeBase(listen: string, port: number): string {
  const host = listen.includes(":") && !listen.startsWith("[") ? `[${listen}]` : listen;
  return `http://${host}:${port}/v1`;
}

/** A word of a shell line LumiAH prints, quoted when it needs to be. */
export function shellWord(word: string): string {
  return /^[A-Za-z0-9_./:@%+=,-]+$/.test(word) ? word : `'${word.replaceAll("'", "'\\''")}'`;
}

/** A runtime's systemd user unit, by its name. */
export function unitName(name: string): string {
  return `lumiah-${name}.service`;
}
