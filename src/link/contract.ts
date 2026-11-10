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
//   from then on, so a runtime that reconnected is found on its new session.
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
//   `connections.*`, `model.call`, `trace.push`) carry the ports' own shapes (src/core/ports.ts), so
//   the two can't drift apart.
// - A notice is what the runtime tells the extension without waiting for an answer: a model's
//   answer as it arrives, for the live view. It has no id and no secret. The extension takes one
//   only from a session a hello bound to a runtime, in the order they were sent; one that is lost
//   is not sent again.

import type { ActivatedLore, ChatMessage, ConnectionInfo, ConnectionProfile, LoreBook, LoreEntry, ModelMessage, ModelRequest, ModelResult, ModelTool, PathMessage, PresetBlock, RequestSource, TraceDelta, TraceRecord, TurnKind, TurnRecord } from "../core/ports";
import type { JsonObject, JsonValue } from "./json";

export type { TurnKind } from "../core/ports";

/** The level of this contract: `hello` says it both ways, and each end refuses another. */
export const LINK_VERSION = 1;

/** The key every frame of the link carries, with this value. */
export const LINK = "lumiah-link";

/** LumiAH's identifier in Lumiverse (`spindle.json`): how the runtime finds the extension, and the key of the records it writes in a message's extension metadata. */
export const EXTENSION_IDENTIFIER = "lumi_ah";

/** The model the runtime lists at `GET /v1/models`, and the loopback connection names. */
export const MODEL_ID = "lumiah";

/** The body parameter the prompt interceptor sets on a generation it tags; the runtime takes it out before the body goes on. */
export const TAG_PARAM = "lumiah_turn";

/** What a loopback key starts with, so one pasted in the wrong place is recognised. */
export const KEY_PREFIX = "lah_";

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

/** The user's settings and texts: the settings whole with defaults filled in, and the texts the user replaced, by id. */
export interface SettingsSnapshot {
  revision: number;
  values: JsonObject;
  texts: Record<string, string>;
}

/** How a turn's record was taken: written on the reply's message now, written once Lumiverse saves the reply, or not written (the reply's message is gone). */
export type Anchoring = "now" | "on_save" | "never";

// ---------------------------------------------------------------- stream chunks

/**
 * A piece of a stream: the answer's text and the model's reasoning as they are written, then exactly
 * one terminal chunk, `done` with the whole answer as Lumiverse's generation API gave it, or `error`
 * with the provider's or Lumiverse's own words.
 */
export type StreamChunk =
  | { kind: "content"; text: string }
  | { kind: "reasoning"; text: string }
  | { kind: "done"; result: ModelResult }
  | { kind: "error"; message: string; code: string };

/** Whether a chunk ends its stream. */
export function terminal(chunk: StreamChunk): boolean {
  return chunk.kind === "done" || chunk.kind === "error";
}

// ---------------------------------------------------------------- requests and their results

/** Each request's fields (beside the envelope: `link`, `type`, `id`) and its result. */
export interface LinkRequests {
  /** `up` registers its runtime with the user's own session: the extension mints its secret (kept only as a hash), and a later register of the same name replaces it. */
  register: { fields: { name: string; build: string; host: string; listen: string; port: number }; result: { relay: string; secret: string; model: string; user: string } };
  /** On every socket the runtime opens: binds its pushes to this session and resumes its open streams from the chunk after `seq`. `lost`: the streams the extension no longer holds (it restarted). `settings`: the user's settings' revision now. */
  hello: { fields: { secret: string; version: number; build: string; report: RuntimeReport; open: OpenStream[] }; result: { relay: string; version: number; build: string; lost: string[]; settings: number } };
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
   * answered on `stream`. `parameters` is every field of the request's body but its messages, tools,
   * model and stream flags, as Lumiverse sent them.
   */
  passthrough: { fields: { secret: string; key: string; stream: string; connection: string | null; messages: ModelMessage[]; tools: ModelTool[]; parameters: JsonObject }; result: { accepted: true } };
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

/** Stop a turn: the user pressed Stop, in the live view or in Lumiverse. */
export interface StopPush {
  link: typeof LINK;
  type: "stop";
  turn: string;
  why: string;
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
 */
export interface ConnectionPush {
  link: typeof LINK;
  type: "connection";
  ref: string;
  key: string;
}

export type LinkPush = ChunkPush | StopPush | SettingsPush | SecretPush | ConnectionPush;

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
 * again (from the extension's build), or LumiAH in Lumiverse's Extensions tab.
 */
export function versionWords(runtime: number, extension: number): string {
  if (runtime < extension) return `This runtime speaks link version ${runtime} and LumiAH ${extension}: update the runtime by running its start line on LumiAH's Runtime page again.`;
  return `This runtime speaks link version ${runtime} and LumiAH ${extension}: update LumiAH in Lumiverse (Extensions → LumiAH → Update), then restart the runtime.`;
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
