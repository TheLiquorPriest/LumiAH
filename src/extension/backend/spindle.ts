// The only file of the backend that touches the `spindle` global (DESIGN §1). Everything else talks to
// `BackendHost`, the interface it implements, so the tests run the whole backend against a fake.
//
// What crosses here is already in LumiAH's own shapes: a model call takes the core's `ModelRequest`
// and gives its `ModelResult`; a chat's messages come with only this extension's own metadata; an
// event comes decoded. Where the running Lumiverse differs from the published types, the difference
// is read here and nowhere else.

import type { ChatGetMessagesOptionsDTO, GenerationReasoningOverrideDTO, GenerationRequestDTO, LlmMessageDTO, LlmMessagePartDTO, SpindleAPI, StreamChunkDTO, ToolSchemaDTO, WorldBookEntryDTO } from "lumiverse-spindle-types";
import type { ChatRole, JsonObject, JsonValue, ModelDelta, ModelEffort, ModelMessage, ModelRequest, ModelResult, ModelThinkingBlock, ModelTool, ModelToolCall } from "../../core/ports";
import type { DatabankDocument, EmbedderInfo, MemoryArc, MemoryEntity, MemoryEntityBrief, MemoryHit, MemoryRelation, WebResult } from "../../core/recall/ports";
import type { PassedMessage, PassedTool } from "../../link/contract";
import { EXTENSION_IDENTIFIER } from "../../link/contract";
import { isRecord, toJson, toJsonObject } from "../../link/json";

declare const spindle: SpindleAPI;

// ---------------------------------------------------------------- what the backend sees of Lumiverse

/** The kinds of generation Lumiverse runs; one LumiAH has no name for (its `quiet`) is `other`. */
export type HostGenerationType = "normal" | "regenerate" | "swipe" | "continue" | "impersonate" | "other";

export interface GenerationStarted {
  generationId: string;
  chatId: string;
  userId: string | null;
  type: HostGenerationType;
  /** The message the reply is written to: a new reply's staged message, the message a swipe, regenerate or continue goes on; null where Lumiverse makes it only as it saves the reply. */
  targetMessageId: string | null;
  /** The swipe that takes the reply; null when Lumiverse didn't say. */
  targetSwipeId: number | null;
}

export interface GenerationEnded {
  generationId: string;
  chatId: string;
  userId: string | null;
  /** The saved message; null when the generation failed. */
  messageId: string | null;
  /** The text this generation wrote, as Lumiverse says it; null where it doesn't (a failure, an older Lumiverse). */
  content: string | null;
  error: string | null;
}

export interface GenerationStopped {
  generationId: string;
  chatId: string;
  userId: string | null;
}

export interface SwipeChanged {
  chatId: string;
  userId: string | null;
  messageId: string;
  action: "added" | "updated" | "deleted" | "navigated";
  /** The swipe the change concerns: for `deleted`, the slot that is gone (the later ones moved down by one). */
  swipeId: number;
}

/** A message of an assembled prompt as the interceptor reads it. */
export interface PromptMessage {
  role: ChatRole;
  /** Its text: its text parts joined, when it has parts. */
  text: string;
  /** It came from the chat's history. */
  history: boolean;
  /** Lumiverse put it in the prompt as a World Info entry of its own (one a preset's macro puts inside a block has no message of its own, and isn't flagged). */
  lore?: true;
  /** The chat message it came from and that message's place in the chat, where Lumiverse says. */
  sourceId?: string;
  sourceIndex?: number;
}

/** A World Info entry Lumiverse activated for a prompt: which, of which book, and how it got there (a key matched, or a match by meaning with its score), where Lumiverse says. */
export interface ActivatedInfo {
  entryId: string;
  bookId: string | null;
  title: string;
  how?: "key" | "vector";
  score?: number;
}

export interface InterceptorInput {
  chatId: string;
  userId: string;
  /** The generation's id, where Lumiverse's context names it; null on one that doesn't (its start event names it then). */
  generationId: string | null;
  type: HostGenerationType;
  /** A prompt preview: nothing is generated. */
  dryRun: boolean;
  connectionId: string | null;
  presetId: string | null;
  personaId: string | null;
  /** The World Info entries Lumiverse activated for this prompt. */
  activated: ActivatedInfo[];
  messages: PromptMessage[];
  /** Ends when Lumiverse stops waiting for the interceptor: the generation was stopped, or the interceptor's time ran out. Absent on a Lumiverse that gives none. */
  signal?: AbortSignal;
  /** When Lumiverse stops waiting for the interceptor, by this machine's clock, where its context says; absent: the manifest's `interceptorTimeoutMs` from the moment of the call. */
  deadlineAt?: number;
}

/**
 * A place in a prompt the interceptor rewrote: a message that came, by its place among those that
 * came, kept exactly as Lumiverse made it (its parts, its name, its marks); or a message put in.
 * `label` names a message put in for Lumiverse's Prompt Breakdown, where the user can read it.
 */
export type PromptSlot = { keep: number } | { role: ChatRole; text: string; label?: string };

/**
 * What the interceptor does to the prompt: the places of the messages to leave out, and parameters
 * to add to the request's body; or, with `messages`, the prompt whole as it is to be sent (`omit`
 * isn't read then).
 */
export interface InterceptorVerdict {
  omit?: number[];
  parameters?: Record<string, JsonValue>;
  messages?: PromptSlot[];
}

export interface HostConnection {
  id: string;
  name: string;
  provider: string;
  url: string;
  model: string;
  isDefault: boolean;
  metadata: JsonObject;
}

export interface HostChat {
  id: string;
  name: string;
  characterId: string | null;
  metadata: JsonObject;
}

/** A chat message with the swipe it shows and what LumiAH keeps on it. */
export interface HostMessage {
  id: string;
  /** Its place in the chat, from 0. */
  index: number;
  role: ChatRole;
  name: string;
  swipeId: number;
  /** How many swipes it has. */
  swipes: number;
  /** The text of the swipe it shows. */
  content: string;
  /** The user hid it from the prompt: Lumiverse's own mark on the message, which its prompt assembly passes over. False where Lumiverse doesn't say. */
  hidden: boolean;
  /** LumiAH's own entry in the message's extension metadata; null when it has none. */
  own: JsonValue | null;
  /** When it was sent, in milliseconds since 1970; null where Lumiverse has no time for it. */
  at: number | null;
}

export interface HostBook {
  id: string;
  name: string;
  description: string;
}

export interface HostBookEntry {
  id: string;
  bookId: string;
  title: string;
  keys: string[];
  secondaryKeys: string[];
  content: string;
  enabled: boolean;
  constant: boolean;
}

/** A world book as the lore and history tools read it (DESIGN §24): with what its makers keep on it, and when it last changed. */
export interface HostBookRecord extends HostBook {
  /** The book's own metadata: where an extension marks a book it made (LumiBooks marks a chat's book with the chat). */
  metadata: JsonObject;
  /** When the book or any entry of it last changed, in milliseconds since 1970, as Lumiverse stamps it: to the second. 0 where it has no stamp. */
  updatedAt: number;
}

/** An entry with the state Lumiverse keeps on it beside its text, and what extensions keep on it. */
export interface HostEntryRecord extends HostBookEntry {
  /** Lumiverse may activate it by a vector match as well as by its keys. */
  vectorized: boolean;
  /** Its keys are regular expressions, not words. */
  regex: boolean;
  /** As whose message it goes into the prompt; null: as the preset's World Info marker has it. */
  role: ChatRole | null;
  /** Its order among the entries put in one place: the lower comes first. */
  order: number;
  /** When it last changed, in milliseconds since 1970; 0 where Lumiverse has no stamp. */
  updatedAt: number;
  /** What extensions keep on the entry, each under its own key. */
  extensions: JsonObject;
}

/** A databank of the user's, as Lumiverse keeps it. */
export interface HostDatabank {
  id: string;
  name: string;
  description: string;
  scope: "global" | "character" | "chat";
  /** The character or the chat it is scoped to; null for a global one. */
  scopeId: string | null;
  /** Switched on in Lumiverse: one that is off applies to no chat. */
  enabled: boolean;
  /** How many documents it holds. */
  documents: number;
}

export interface HostPresetBlock {
  id: string;
  name: string;
  role: ChatRole;
  content: string;
  enabled: boolean;
  /** Where Lumiverse puts something of its own (`chat_history`, `world_info_before`, …); null for a block the preset's author wrote. */
  marker: string | null;
}

/** A request passed through as it came: its messages and its tools, whole, and every parameter of its body. */
export interface PassRequest {
  connectionId: string | null;
  messages: PassedMessage[];
  tools: PassedTool[];
  parameters: JsonObject;
}

/** An MCP server the user set up in Lumiverse, as much of it as an extension may see: where it connects to and its secrets never leave Lumiverse. */
export interface HostMcpServer {
  id: string;
  name: string;
  /** Switched on in Lumiverse: one that is off connects to nothing. */
  enabled: boolean;
  createdAt: number;
}

/** A tool a connected MCP server offers: its name there, what it says it does, and its arguments' JSON Schema as the server gives it. */
export interface HostMcpTool {
  name: string;
  description: string;
  parameters: JsonObject;
}

export type HostLogLevel = "info" | "warn" | "error";

/**
 * Lumiverse as the backend needs it. Every call names its user: the extension may be installed for
 * all of them. Of the gated permissions four are needed for LumiAH to work at all: `interceptor`,
 * `chats`, `generation`, and `chat_mutation`, which Lumiverse puts the reading of a chat's messages
 * under (its `handleChatGetMessages`), so no turn can be worked on without it. A member that rests
 * on any other one answers that there is nothing (null, none, false) where the user didn't grant
 * it, and never fails for its lack.
 */
export interface BackendHost {
  log(level: HostLogLevel, message: string): void;
  /** A short notice on the user's screen, in Lumiverse's own toasts, wherever they are in it: for what they must hear though no page of LumiAH's is open. */
  toast(userId: string, level: "info" | "warning" | "error", text: string): void;
  /** Closes Lumiverse's drawer for the user, so the chat shows; false where this Lumiverse has no such call. */
  closeDrawer(userId: string): Promise<boolean>;
  /** Whether a gated permission is granted now. */
  granted(permission: string): boolean;
  /** A permission was granted or revoked while the extension runs. */
  onPermission(handler: (permission: string, granted: boolean) => void): void;
  /** What this Lumiverse can do, by capability name (`spindle.host.capabilities`). */
  capability(name: string): boolean;
  /** Where this build runs from: Lumiverse's own Bun, and the directory its bundles are in; null where the worker can't say. */
  install: { bun: string | null; dir: string | null };
  /** The extension's identifier in Lumiverse (its `spindle.json`): LumiAH's own, or that of the extension LumiAH is built into. A runtime finds the extension by it. */
  identifier: string;
  /**
   * How long Lumiverse waits for this extension's interceptor before it sends the prompt on as it
   * was, in milliseconds: the manifest's `interceptorTimeoutMs` as Lumiverse holds it (from one
   * second to five minutes), else its own default, which the user may have changed.
   */
  interceptorMs: number;

  frontend: {
    /** To one page of the user's (a frontend session), or to all of them. A runtime is a session of its own. */
    send(message: unknown, userId: string, sessionId?: string): void;
    onMessage(handler: (payload: unknown, userId: string, sessionId: string | undefined) => void): void;
    /** A page went away, or a message for it found no page. */
    onClosed(handler: (sessionId: string) => void): void;
  };

  events: {
    onGenerationStarted(handler: (event: GenerationStarted) => void): void;
    onGenerationEnded(handler: (event: GenerationEnded) => void): void;
    onGenerationStopped(handler: (event: GenerationStopped) => void): void;
    onSwipe(handler: (event: SwipeChanged) => void): void;
    /** A chat's metadata changed: what the pages show of the chat may have. */
    onChatChanged(handler: (chatId: string, userId: string | null) => void): void;
    /** A chat's messages changed in any way (one sent, edited, deleted or swiped, or the chat changed whole), or the chat is gone (`gone`: Lumiverse deleted it, and says whose it was where it knows). */
    onChatTouched(handler: (chatId: string, gone: boolean, userId: string | null) => void): void;
    /** A chat was branched: the new chat holds copies of the source's messages up to the branch point, each under a new id. */
    onChatForked(handler: (fork: { sourceChatId: string; chatId: string; userId: string | null }) => void): void;
    /** The connection the user has selected in Lumiverse (`connections.active`) changed, or may have. */
    onSelectedConnection(handler: (userId: string | null) => void): void;
  };

  /**
   * Registers the one prompt interceptor. `priority`: Lumiverse runs the lowest first. `required`: a
   * failure stops the generation instead of letting the prompt go on unchanged, where this Lumiverse
   * can do that. Registered again by itself when the permission is granted later.
   */
  registerInterceptor(handler: (input: InterceptorInput) => Promise<InterceptorVerdict>, options: { priority: number; types: readonly HostGenerationType[]; required: boolean }): void;

  models: {
    /** One model call through Lumiverse's generation API on the request's connection, streamed; rejects with the provider's or Lumiverse's own words. */
    call(request: ModelRequest, userId: string, signal: AbortSignal, onDelta: (delta: ModelDelta) => void): Promise<ModelResult>;
    /** A request passed through as it came. */
    pass(request: PassRequest, userId: string, signal: AbortSignal, onDelta: (delta: ModelDelta) => void): Promise<ModelResult>;
  };

  connections: {
    /** The user's connections as Lumiverse lists them: the one changed last first, and no more than its own page of them. */
    list(userId: string): Promise<HostConnection[]>;
    get(connectionId: string, userId: string): Promise<HostConnection | null>;
    /** The connection the user has selected in Lumiverse (their active profile), by id; null when they have selected none or the one selected is gone; undefined where this Lumiverse doesn't say (a page of the user's reads it there instead). */
    active(userId: string): Promise<string | null | undefined>;
    /** The models a connection's provider lists; null where this Lumiverse can't ask. */
    models(connectionId: string, userId: string): Promise<string[] | null>;
  };

  /** The user's own storage for this extension: text files by path. */
  storage: {
    /** The file's text; null when there is none. */
    read(path: string, userId: string): Promise<string | null>;
    write(path: string, text: string, userId: string): Promise<void>;
    remove(path: string, userId: string): Promise<void>;
    /** The file's size in bytes and when it was last written (ms since the epoch); null when there is none. */
    stat(path: string, userId: string): Promise<{ bytes: number; writtenAt: number } | null>;
    /** Every file under a directory, each as its path from that directory, in no order; none when there is no such directory. */
    list(dir: string, userId: string): Promise<string[]>;
  };

  chats: {
    get(chatId: string, userId: string): Promise<HostChat | null>;
    /**
     * Sets these keys of the chat's metadata, keeping the others; a null value takes its key away.
     * Where Lumiverse writes on condition (`chat-conditional-metadata-v1`, with `chat_mutation`),
     * what another writer changes meanwhile is kept too, and the call rejects, with nothing written,
     * if the metadata never holds still for it; elsewhere such a change is lost.
     */
    patchMetadata(chatId: string, patch: Record<string, JsonValue>, userId: string): Promise<void>;
    /** The chat's messages in chat order: all of them, `count` from the `from`th, or the last `tail`. */
    messages(chatId: string, range?: { from: number; count: number } | { tail: number }): Promise<HostMessage[]>;
    /** The text of one swipe of a message, shown or not; null when there is no such message or swipe, or its text can't be read. */
    swipe(chatId: string, messageId: string, swipe: number): Promise<string | null>;
    /** Writes LumiAH's own entry in a message's extension metadata, keeping every other extension's. */
    setOwn(chatId: string, messageId: string, value: JsonValue): Promise<void>;
    /** Deletes a message of a chat. */
    deleteMessage(chatId: string, messageId: string): Promise<void>;
    /** The user's chats, `limit` of them from the `offset`th in an order that holds still, and how many they have in all. */
    list(userId: string, offset: number, limit: number): Promise<{ chats: HostChat[]; total: number }>;
    /** A character's name; null when there is no such character, or the permission to read characters isn't granted. */
    characterName(characterId: string, userId: string): Promise<string | null>;
  };

  lore: {
    /** A book of the user's; null when they have none such, or the permission to read world books isn't granted. */
    book(bookId: string, userId: string): Promise<HostBook | null>;
    /** A book's entries, in the book's order; none without that permission. */
    entries(bookId: string, userId: string): Promise<HostBookEntry[]>;
    /** One entry; null when there is none such, or without that permission. */
    entry(entryId: string, userId: string): Promise<HostBookEntry | null>;
    /** A book with what its makers keep on it and when it last changed; null as `book` is. */
    record(bookId: string, userId: string): Promise<HostBookRecord | null>;
    /** A book's entries, in the book's order, each with its state and what extensions keep on it; none as `entries` are. */
    records(bookId: string, userId: string): Promise<HostEntryRecord[]>;
    /** The books switched on for every chat; none without that permission. */
    global(userId: string): Promise<string[]>;
    /** The books attached to a character, and the one attached to a persona; none where the permission to read them isn't granted. */
    ofCharacter(characterId: string, userId: string): Promise<string[]>;
    /** The book attached to a persona (null: to the user's active persona); none where there is no such persona or the permission to read it isn't granted. */
    ofPersona(personaId: string | null, userId: string): Promise<string | null>;
  };

  presets: {
    /** The preset's blocks in order; null when there is no such preset, or the permission to read presets isn't granted. */
    blocks(presetId: string, userId: string): Promise<HostPresetBlock[] | null>;
    /** The preset a chat generates with, and the block states its binding sets over the preset's own, by block id; null when this Lumiverse can't say, or without that permission. */
    active(chatId: string, userId: string): Promise<{ presetId: string | null; states: Record<string, boolean> } | null>;
  };

  /** The user's MCP servers, reached through Lumiverse (DESIGN §16): Lumiverse holds the connections, and applies its own rules on what a server may reach. */
  mcp: {
    /** The user's servers; none where this Lumiverse has no MCP, or the permission to use it isn't granted. */
    servers(userId: string): Promise<HostMcpServer[]>;
    /** The tools a server offers now, connecting it first when it isn't connected; rejects with why when it can't be. */
    tools(serverId: string, userId: string): Promise<HostMcpTool[]>;
    /** Calls a tool a connected server offers; its result as text. Rejects with the server's or Lumiverse's own words. Lumiverse holds `timeoutMs` between 1 and 120 seconds. */
    call(serverId: string, tool: string, args: JsonObject, timeoutMs: number, userId: string): Promise<string>;
  };

  /** The user's embedding connections (DESIGN §24.5; permission `embeddings`). */
  embeddings: {
    /** The user's main embedding connection; null when they have none or it is switched off, where this Lumiverse embeds nothing for an extension, and where the permission isn't granted. */
    connection(userId: string): Promise<EmbedderInfo | null>;
    /**
     * One vector per text, in order, on that connection. Lumiverse takes 1 to 256 texts in a call,
     * none blank, each of 8192 characters at most. Rejects with Lumiverse's or the provider's own
     * words; and, having no vector to answer with, where there is no connection to use: the one
     * member that fails for the lack of its permission.
     */
    embed(texts: readonly string[], kind: "query" | "stored", userId: string, signal?: AbortSignal): Promise<{ vectors: number[][]; model: string; dimensions: number }>;
  };

  /**
   * Lumiverse's Memory Cortex (DESIGN §24.4; permission `memories`). A chat named here is the
   * user's own: Lumiverse refuses another's. Without the permission, and on a Lumiverse that has no
   * Cortex for an extension, every member answers that there is nothing.
   */
  memory: {
    /** Whether the user has the Cortex switched on. A chat may still have it off for itself: its metadata says. */
    enabled(userId: string): Promise<boolean>;
    /** The Cortex's own ranked answer to a query over a chat's memory, in its order, `limit` at most; none where the Cortex is off for the chat. */
    search(chatId: string, query: string, options: { limit: number; entities?: readonly string[] }, userId: string): Promise<MemoryHit[]>;
    /** An entity of a chat by its name or one of its aliases, with its facts and its relations, the strongest first; null when the Cortex has none so named. */
    entity(chatId: string, name: string, userId: string): Promise<MemoryEntity | null>;
    /** The entities the Cortex has for a chat that are still in the story, the most salient first, `limit` at most. */
    entities(chatId: string, limit: number, userId: string): Promise<MemoryEntityBrief[]>;
    /** A chat's arcs, of every tier. */
    arcs(chatId: string, userId: string): Promise<MemoryArc[]>;
  };

  /** The user's databanks (DESIGN §24.4; permission `databanks`). Without the permission, and on a Lumiverse that shows an extension none, there are none and no document has text. */
  databanks: {
    /** Every databank of the user's, whatever it is scoped to. */
    list(userId: string): Promise<HostDatabank[]>;
    /** The databanks a character's card names, beside those scoped to the character; none where the permission to read characters isn't granted. */
    ofCharacter(characterId: string, userId: string): Promise<string[]>;
    /** A databank's documents; none for one that isn't the user's. */
    documents(databankId: string, userId: string): Promise<DatabankDocument[]>;
    /** A document's text as Lumiverse read it in; null when it has none yet, or the document isn't the user's. */
    content(documentId: string, userId: string): Promise<string | null>;
  };

  /** The user's own web search provider, as they set it up in Lumiverse (DESIGN §24.4; permission `web_search`). */
  web: {
    /** Whether the user has web search switched on; false where this Lumiverse has none for an extension, and where the permission isn't granted. */
    enabled(userId: string): Promise<boolean>;
    /**
     * The provider's results for a query: `count` at most, and no more than the user's own setting
     * allows. With `pages`, a result whose page Lumiverse read carries the page's text; how many
     * pages it reads is the user's setting too. None where `enabled` is false for want of the API
     * or the permission; rejects with Lumiverse's or the provider's own words.
     */
    search(query: string, options: { count: number; pages: boolean }, userId: string): Promise<WebResult[]>;
  };
}

// ---------------------------------------------------------------- reading what the host gives

function str(o: unknown, key: string): string | undefined {
  if (!isRecord(o)) return undefined;
  const v = o[key];
  return typeof v === "string" ? v : undefined;
}

function num(o: unknown, key: string): number | undefined {
  if (!isRecord(o)) return undefined;
  const v = o[key];
  return typeof v === "number" && Number.isFinite(v) ? v : undefined;
}

const strings = (v: unknown): string[] => (Array.isArray(v) ? v.filter((s): s is string => typeof s === "string") : []);

/**
 * The least number that can only be a time in milliseconds: read as seconds it is the year 5138,
 * as milliseconds 1973. A fact of the calendar, so no setting.
 */
const MILLISECONDS_FROM = 100_000_000_000;

/**
 * A time as the host keeps one, in milliseconds since 1970; null where it keeps none. Lumiverse
 * stamps in whole seconds. A chat imported from another program may carry milliseconds instead,
 * which read as seconds would lie thousands of years off: a number that large is taken as it is.
 */
function stampOf(raw: unknown): number | null {
  if (typeof raw !== "number" || !Number.isFinite(raw) || raw <= 0) return null;
  return Math.floor(raw >= MILLISECONDS_FROM ? raw : raw * 1000);
}

const GENERATION_TYPES: Readonly<Record<string, HostGenerationType>> = { normal: "normal", regenerate: "regenerate", swipe: "swipe", continue: "continue", impersonate: "impersonate" };

/** A generation's type as an event or a context names it: none named is a normal reply, one LumiAH has no name for is `other`. */
function generationType(o: unknown): HostGenerationType {
  const type = str(o, "generationType");
  return type === undefined ? "normal" : (GENERATION_TYPES[type] ?? "other");
}

/** A role as LumiAH has them: a preset block's `user_append` and `assistant_append` are the role they append to. */
function roleOf(raw: unknown): ChatRole {
  if (raw === "system") return "system";
  return typeof raw === "string" && raw.startsWith("assistant") ? "assistant" : "user";
}

/** A message's text: a string as it is, a list of parts as its text parts joined. */
function partsText(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content.map((p) => (isRecord(p) && p.type === "text" && typeof p.text === "string" ? p.text : "")).join("");
}

/**
 * A prompt message as the interceptor reads it: its role, its text, and what the host's own flags
 * say of it. The host's message is read and left as it is: it goes back to Lumiverse whole, which
 * gives the next interceptor what this one hands back and takes its own flags off before the
 * provider. `__isWorldInfoEntry` is on the running Lumiverse's messages and not in the published types.
 */
function promptMessageOf(raw: LlmMessageDTO): PromptMessage {
  const flagged = raw as LlmMessageDTO & Record<string, unknown>;
  const index = flagged.sourceIndexInChat;
  const id = flagged.sourceMessageId;
  return { role: raw.role, text: partsText(raw.content), history: flagged.__isChatHistory === true, ...(flagged.__isWorldInfoEntry === true ? { lore: true as const } : {}), ...(typeof id === "string" ? { sourceId: id } : {}), ...(typeof index === "number" ? { sourceIndex: index } : {}) };
}

/** A chat message as the host gives one (`getMessages`); null when it isn't one. */
function messageOf(raw: unknown, identifier: string): HostMessage | null {
  const id = str(raw, "id");
  if (!isRecord(raw) || id === undefined) return null;
  const swipes = Array.isArray(raw.swipes) ? raw.swipes : [];
  const swipeId = num(raw, "swipe_id") ?? 0;
  const shown = swipes[swipeId];
  const metadata = isRecord(raw.metadata) ? raw.metadata : isRecord(raw.extra) && isRecord(raw.extra.spindle_metadata) ? raw.extra.spindle_metadata : {};
  const own = metadata[identifier];
  return {
    id,
    index: num(raw, "index_in_chat") ?? 0,
    role: raw.role === "system" || raw.role === "assistant" || raw.role === "user" ? raw.role : raw.is_user === true ? "user" : "assistant",
    name: str(raw, "name") ?? "",
    swipeId,
    swipes: Math.max(1, swipes.length),
    // The host keeps the shown swipe's text as `content` too; a lean read leaves the other swipes' slots null.
    content: str(raw, "content") ?? (typeof shown === "string" ? shown : ""),
    hidden: raw.hidden === true,
    own: own === undefined ? null : toJson(own),
    at: stampOf(raw.send_date) ?? stampOf(raw.created_at),
  };
}

/** A world book entry as the host gives one. */
function entryOf(e: WorldBookEntryDTO): HostBookEntry {
  return { id: e.id, bookId: e.world_book_id, title: e.comment, keys: [...e.key], secondaryKeys: [...(e.keysecondary ?? [])], content: e.content, enabled: !e.disabled, constant: e.constant };
}

/** The same with the state the host keeps on it and what extensions keep on it. A field an older host doesn't name reads as unset. */
function entryRecordOf(e: WorldBookEntryDTO): HostEntryRecord {
  const role: unknown = e.role;
  return {
    ...entryOf(e),
    vectorized: e.vectorized === true,
    regex: e.use_regex === true,
    role: role === "system" || role === "user" || role === "assistant" ? role : null,
    order: num(e, "order_value") ?? 0,
    updatedAt: stampOf(e.updated_at) ?? 0,
    extensions: toJsonObject(e.extensions),
  };
}

/** A run of chat messages as the Cortex names one, by the first and the last one's number in the chat; null where it names none. */
function spanOf(first: unknown, last: unknown): [number, number] | null {
  return typeof first === "number" && typeof last === "number" && Number.isSafeInteger(first) && Number.isSafeInteger(last) && first >= 0 && last >= first ? [first, last] : null;
}

/** Something the Cortex gave for a query (its `CortexMemoryDTO`); null when it isn't one. */
function memoryHitOf(raw: unknown): MemoryHit | null {
  if (!isRecord(raw) || typeof raw.content !== "string") return null;
  const range: unknown[] = Array.isArray(raw.messageRange) ? raw.messageRange : [];
  // The Cortex fills a run it doesn't know with zeros, which reads as the chat's first message alone: given as not known, since a wrong place sends an agent to the wrong message.
  const span = range[0] === 0 && range[1] === 0 ? null : spanOf(range[0], range[1]);
  return { source: raw.source === "consolidation" ? "arc" : "chunk", text: raw.content, score: num(raw, "finalScore") ?? 0, span, entities: strings(raw.entityNames) };
}

// ---------------------------------------------------------------- a model call as the host takes it

/**
 * A call's effort as the host's per-request reasoning override: none for `inherit` (the connection's
 * reasoning binding, else the user's setting, stands), the off-switch for `off`, else that effort,
 * which the host maps to the provider's own field, with how the model's thinking shows when
 * `display` says (`summarized`: its text comes back).
 */
export function reasoningOverride(effort: ModelEffort | undefined, display?: "summarized"): GenerationReasoningOverrideDTO | undefined {
  if (effort === undefined || effort === "inherit") return undefined;
  return effort === "off" ? { source: "off" } : { source: "custom", apiReasoning: true, effort, ...(display ? { thinkingDisplay: display } : {}) };
}

/**
 * A message as the host takes it (`LlmMessageDTO`): its text, or its parts with each breakpoint as
 * an ephemeral `cache_control`, and an assistant turn's reasoning carriers, sent back as the model
 * gave them. A message with no parts and no carriers goes as `{role, content}`.
 */
export function messageDTO(m: ModelMessage): LlmMessageDTO {
  const cache = (on: true | undefined) => (on ? { cache_control: { type: "ephemeral" } } : {});
  const content =
    m.parts?.map((p): LlmMessagePartDTO => {
      if (p.type === "text") return { type: "text", text: p.text, ...cache(p.cache) };
      if (p.type === "tool_use") return { type: "tool_use", id: p.id, name: p.name, input: p.input, ...(p.thoughtSignature !== undefined ? { thought_signature: p.thoughtSignature } : {}), ...cache(p.cache) };
      if (p.type === "tool_result") return { type: "tool_result", tool_use_id: p.toolUseId, content: p.content, ...(p.isError ? { is_error: true } : {}), ...cache(p.cache) };
      return { type: p.media, data: p.data, mime_type: p.mimeType, ...cache(p.cache) };
    }) ?? m.content;
  return {
    role: m.role,
    content,
    ...(m.reasoning !== undefined ? { reasoning_content: m.reasoning } : {}),
    ...(m.thinkingBlocks ? { thinking_blocks: m.thinkingBlocks } : {}),
    ...(m.reasoningDetails ? { reasoning_details: m.reasoningDetails } : {}),
  };
}

/**
 * A tool as the host takes it (`ToolSchemaDTO`), its breakpoint as an ephemeral `cache_control`: the
 * host passes it on, and its Anthropic provider sends it on the tool; the published DTO doesn't name
 * the field.
 */
export function toolDTO(t: ModelTool): ToolSchemaDTO {
  return { name: t.name, description: t.description, parameters: t.parameters, ...(t.cache ? { cache_control: { type: "ephemeral" } } : {}) };
}

/**
 * A passed-through message as the host takes it (`LlmMessageDTO`): its text or its parts, its name,
 * its mark as a prefix the model continues (`partial`), its cache breakpoints as the request gave
 * them, and an assistant turn's reasoning. Each goes on only where the message has it, so a plain
 * message goes as `{role, content}`.
 */
export function passedMessageDTO(m: PassedMessage): LlmMessageDTO {
  const cache = (control: JsonObject | undefined) => (control !== undefined ? { cache_control: control } : {});
  const content =
    typeof m.content === "string"
      ? m.content
      : m.content.map((p): LlmMessagePartDTO => {
          if (p.type === "text") return { type: "text", text: p.text, ...cache(p.cacheControl) };
          if (p.type === "tool_use") return { type: "tool_use", id: p.id, name: p.name, input: p.input };
          if (p.type === "tool_result") return { type: "tool_result", tool_use_id: p.toolUseId, content: p.content, ...cache(p.cacheControl) };
          return { type: p.media, data: p.data, mime_type: p.mimeType, ...cache(p.cacheControl) };
        });
  return {
    role: m.role,
    content,
    ...(m.name !== undefined ? { name: m.name } : {}),
    ...(m.prefix ? { partial: true } : {}),
    ...cache(m.cacheControl),
    ...(m.reasoning !== undefined ? { reasoning_content: m.reasoning } : {}),
    ...(m.reasoningDetails ? { reasoning_details: m.reasoningDetails } : {}),
  };
}

/**
 * A passed-through request's tool as the host takes it (`ToolSchemaDTO`), with `strict` where the
 * request said it: the host hands a tool on as it came, and its OpenAI-compatible providers send
 * `strict` with the function; the published DTO doesn't name the field.
 */
export function passedToolDTO(t: PassedTool): ToolSchemaDTO {
  return { name: t.name, description: t.description, parameters: t.parameters, ...(t.strict !== undefined ? { strict: t.strict } : {}) };
}

function thinkingBlock(raw: unknown): ModelThinkingBlock | null {
  const type = str(raw, "type");
  if (type !== "thinking" && type !== "redacted_thinking") return null;
  const thinking = str(raw, "thinking");
  const signature = str(raw, "signature");
  const data = str(raw, "data");
  return { type, ...(thinking !== undefined ? { thinking } : {}), ...(signature !== undefined ? { signature } : {}), ...(data !== undefined ? { data } : {}) };
}

/** The host's whole answer (a stream's `done` chunk) as a model result: the usage as the provider gave it, untouched. */
export function modelResult(raw: unknown): ModelResult {
  // `tool_calls` (`ToolCallDTO[]`): a call without a name is dropped; arguments that aren't an object read as none.
  const calls = isRecord(raw) && Array.isArray(raw.tool_calls) ? raw.tool_calls : [];
  const toolCalls: ModelToolCall[] = calls.flatMap((c, i) => {
    if (!isRecord(c) || typeof c.name !== "string") return [];
    const signature = str(c, "thought_signature");
    return [{ name: c.name, args: toJsonObject(c.args), callId: str(c, "call_id") ?? `call_${i}`, ...(signature !== undefined ? { thoughtSignature: signature } : {}) }];
  });
  const model = str(raw, "model");
  const thought = str(raw, "reasoning");
  const blocks = isRecord(raw) && Array.isArray(raw.thinking_blocks) ? raw.thinking_blocks.flatMap((b) => thinkingBlock(b) ?? []) : [];
  const details = isRecord(raw) && Array.isArray(raw.reasoning_details) ? raw.reasoning_details.filter(isRecord).map(toJsonObject) : [];
  return {
    content: str(raw, "content") ?? "",
    finishReason: str(raw, "finish_reason") ?? "",
    ...(model ? { model } : {}),
    ...(toolCalls.length > 0 ? { toolCalls } : {}),
    ...(thought ? { reasoning: thought } : {}),
    ...(blocks.length > 0 ? { thinkingBlocks: blocks } : {}),
    ...(details.length > 0 ? { reasoningDetails: details } : {}),
    ...(isRecord(raw) && isRecord(raw.usage) ? { usage: toJsonObject(raw.usage) } : {}),
  };
}

/**
 * A streamed call's answer (`generate.quietStream`): its pieces as they come, then its end, `done`,
 * which holds the whole answer. The call's signal ends the wait at once, whether or not Lumiverse has
 * answered the cancel the stream sends it; the stream is let go of either way, which after a cancel
 * tells Lumiverse again.
 */
async function streamedAnswer(stream: AsyncGenerator<StreamChunkDTO, void, void>, signal: AbortSignal, onDelta: (delta: ModelDelta) => void): Promise<unknown> {
  type Step = IteratorResult<StreamChunkDTO, void>;
  let wait: PromiseWithResolvers<Step> | null = null;
  const abort = (): void => wait?.reject(new DOMException("Generation aborted", "AbortError"));
  signal.addEventListener("abort", abort, { once: true });
  try {
    for (;;) {
      wait = Promise.withResolvers<Step>();
      if (signal.aborted) abort();
      else stream.next().then(wait.resolve, wait.reject);
      const step = await wait.promise;
      if (step.done) throw new Error("The model's stream ended without its answer");
      const chunk = step.value;
      if (chunk.type === "done") return chunk;
      if (chunk.token !== "") onDelta(chunk.type === "reasoning" ? { reasoning: chunk.token } : { content: chunk.token });
    }
  } finally {
    signal.removeEventListener("abort", abort);
    void stream.return(undefined).catch(() => undefined);
  }
}

async function generate(input: GenerationRequestDTO, signal: AbortSignal, onDelta: (delta: ModelDelta) => void): Promise<ModelResult> {
  // Always streamed on Lumiverse's side, so a long answer's connection is never idle and a gateway never cuts it.
  return modelResult(await streamedAnswer(spindle.generate.quietStream(input), signal, onDelta));
}

// ---------------------------------------------------------------- the host

/** Reads a file that may not be there: the read itself, and only once it fails, whether the file is there (the host fails a read of a missing one), so a missing file reads as none and any other failure stands. */
async function readOrNull(path: string, userId: string): Promise<string | null> {
  try {
    return await spindle.userStorage.read(path, userId);
  } catch (error) {
    if (!(await spindle.userStorage.exists(path, userId))) return null;
    throw error;
  }
}

/** The most rows one list call of the host gives: its own cap, so no setting of LumiAH's can raise it. */
const HOST_PAGE = 200;
/** The most messages one lean read gives: the host's own cap. */
const MESSAGE_PAGE = 1000;
/** The most MCP servers one list call gives: the host's own cap. */
const MCP_PAGE = 100;
/**
 * How many times a chat's metadata is read and written on condition before the write is given up.
 * Fixed, since no setting could mean anything here: a try fails only when another writer's change
 * lands in the moment between its read and its write, so several in a row are a writer that never
 * stops, and going on would only spin beside it.
 */
const METADATA_TRIES = 4;

/**
 * Lumiverse's own bounds on an interceptor's time and its default for a manifest that names none
 * (its `spindle-settings.service`): the host's, so none is a setting of LumiAH's.
 */
const INTERCEPTOR_MS = { min: 1_000, max: 300_000, unnamed: 10_000 } as const;

/** The time Lumiverse gives this extension's interceptor: what the manifest asks for, held within Lumiverse's bounds; its default where the manifest asks for none. */
export function interceptorTime(asked: unknown): number {
  return typeof asked === "number" && Number.isFinite(asked) ? Math.min(INTERCEPTOR_MS.max, Math.max(INTERCEPTOR_MS.min, Math.floor(asked))) : INTERCEPTOR_MS.unnamed;
}

/**
 * Lumiverse, for the backend. `identifier` is the identifier of the extension this runs in: LumiAH's
 * own, or the identifier of the extension LumiAH is built into, whose entry in a message's extension
 * metadata is then the one LumiAH's records live in (Lumiverse lets an extension write only its own).
 */
export function createSpindleHost(identifier: string = EXTENSION_IDENTIFIER): BackendHost {
  const capabilities: Readonly<Record<string, number>> = spindle.host?.capabilities ?? {};
  const capability = (name: string): boolean => (capabilities[name] ?? 0) >= 1;
  const lean = capability("chat-lean-messages-v1");
  // Bundled, this module is dist/backend.js, which Lumiverse's worker imports by its absolute path: the runtime's bundle is beside it.
  const url = import.meta.url;
  const dir = url.startsWith("file://") ? decodeURIComponent(url.slice("file://".length).replace(/\/[^/]*$/, "")) : null;
  // What is newer than some hosts, and gated: each as it is to be called, or null where this Lumiverse has none of it for an extension or its permission isn't granted. A member then answers that there is nothing.
  const embeddingsApi = (): SpindleAPI["embeddings"] | null => (capability("embeddings-v1") && isRecord(spindle.embeddings) && spindle.permissions.has("embeddings") ? spindle.embeddings : null);
  const memoriesApi = (): SpindleAPI["memories"] | null => (isRecord(spindle.memories) && spindle.permissions.has("memories") ? spindle.memories : null);
  const databanksApi = (): SpindleAPI["databanks"] | null => (isRecord(spindle.databanks) && spindle.permissions.has("databanks") ? spindle.databanks : null);
  const webApi = (): SpindleAPI["webSearch"] | null => (isRecord(spindle.webSearch) && spindle.permissions.has("web_search") ? spindle.webSearch : null);

  /** Every entry of a book as the host lists them, a page at a time; none without the permission to read world books. */
  async function bookEntries(bookId: string, userId: string): Promise<WorldBookEntryDTO[]> {
    if (!spindle.permissions.has("world_books")) return [];
    const out: WorldBookEntryDTO[] = [];
    for (let offset = 0; ; offset += HOST_PAGE) {
      const page = await spindle.world_books.entries.list(bookId, { limit: HOST_PAGE, offset, userId });
      out.push(...page.data);
      if (page.data.length < HOST_PAGE || out.length >= page.total) return out;
    }
  }

  return {
    log(level, message) {
      if (level === "error") spindle.log.error(message);
      else if (level === "warn") spindle.log.warn(message);
      else spindle.log.info(message);
    },
    toast(userId, level, text) {
      // Newer than some hosts: one without it shows nothing.
      if (isRecord(spindle.toast)) spindle.toast[level](text, { userId });
    },
    async closeDrawer(userId) {
      // Newer than some hosts.
      const ui: unknown = spindle.ui;
      if (!isRecord(ui) || typeof ui.closeDrawer !== "function") return false;
      await spindle.ui.closeDrawer({ userId });
      return true;
    },
    granted: (permission) => spindle.permissions.has(permission),
    onPermission(handler) {
      spindle.permissions.onChanged((detail) => handler(detail.permission, detail.granted));
    },
    capability,
    install: { bun: typeof process.execPath === "string" && process.execPath.startsWith("/") ? process.execPath : null, dir },
    identifier,
    interceptorMs: interceptorTime(spindle.manifest?.interceptorTimeoutMs),

    frontend: {
      send(message, userId, sessionId) {
        spindle.sendToFrontend(message, userId, sessionId !== undefined ? { frontendSessionId: sessionId } : undefined);
      },
      onMessage(handler) {
        spindle.onFrontendMessage(handler);
      },
      onClosed(handler) {
        spindle.on("FRONTEND_SESSION_CLOSED", (payload: unknown) => {
          const id = str(payload, "frontendSessionId");
          if (id !== undefined) handler(id);
        });
      },
    },

    events: {
      onGenerationStarted(handler) {
        spindle.on("GENERATION_STARTED", (p: unknown, userId?: string) => {
          const generationId = str(p, "generationId");
          const chatId = str(p, "chatId");
          if (generationId === undefined || chatId === undefined) return;
          handler({ generationId, chatId, userId: userId ?? null, type: generationType(p), targetMessageId: str(p, "targetMessageId") ?? null, targetSwipeId: num(p, "targetSwipeId") ?? null });
        });
      },
      onGenerationEnded(handler) {
        spindle.on("GENERATION_ENDED", (p: unknown, userId?: string) => {
          const generationId = str(p, "generationId");
          const chatId = str(p, "chatId");
          if (generationId === undefined || chatId === undefined) return;
          handler({ generationId, chatId, userId: userId ?? null, messageId: str(p, "messageId") ?? null, content: str(p, "content") ?? null, error: str(p, "error") ?? null });
        });
      },
      onGenerationStopped(handler) {
        spindle.on("GENERATION_STOPPED", (p: unknown, userId?: string) => {
          const generationId = str(p, "generationId");
          const chatId = str(p, "chatId");
          if (generationId !== undefined && chatId !== undefined) handler({ generationId, chatId, userId: userId ?? null });
        });
      },
      onSwipe(handler) {
        spindle.on("MESSAGE_SWIPED", (p: unknown, userId?: string) => {
          const chatId = str(p, "chatId");
          const message = isRecord(p) ? p.message : undefined;
          const messageId = str(message, "id");
          const action = str(p, "action");
          if (chatId === undefined || messageId === undefined || (action !== "added" && action !== "updated" && action !== "deleted" && action !== "navigated")) return;
          handler({ chatId, userId: userId ?? null, messageId, action, swipeId: num(p, "swipeId") ?? num(message, "swipe_id") ?? 0 });
        });
      },
      onChatChanged(handler) {
        spindle.on("CHAT_CHANGED", (p: unknown, userId?: string) => {
          // Lumiverse sends the chat itself, as it is after the change (`chat`); one of its paths names only the chat's id.
          const chatId = str(isRecord(p) ? p.chat : undefined, "id") ?? str(p, "chatId");
          if (chatId !== undefined) handler(chatId, userId ?? null);
        });
      },
      onChatForked(handler) {
        spindle.on("CHAT_FORKED", (p: unknown, userId?: string) => {
          const sourceChatId = str(p, "sourceChatId");
          const chatId = str(p, "forkedChatId");
          if (sourceChatId !== undefined && chatId !== undefined) handler({ sourceChatId, chatId, userId: userId ?? null });
        });
      },
      onChatTouched(handler) {
        // The events Lumiverse's own state revision counts as a chat's messages changing.
        for (const event of ["MESSAGE_SENT", "MESSAGE_EDITED", "MESSAGE_DELETED", "MESSAGE_SWIPED", "SWIPE_EDITED", "CHAT_CHANGED"]) {
          spindle.on(event, (p: unknown) => {
            // Each names its chat's id, but `CHAT_CHANGED`, which gives the chat itself.
            const chatId = str(p, "chatId") ?? str(isRecord(p) ? p.chat : undefined, "id");
            if (chatId !== undefined) handler(chatId, false, null);
          });
        }
        spindle.on("CHAT_DELETED", (p: unknown, userId?: string) => {
          const chatId = str(p, "id") ?? str(p, "chatId");
          if (chatId !== undefined) handler(chatId, true, userId ?? null);
        });
      },
      onSelectedConnection(handler) {
        // The selection is Lumiverse's `activeProfileId` setting, and a change of settings says which keys it changed.
        spindle.on("SETTINGS_UPDATED", (p: unknown, userId?: string) => {
          const keys: unknown[] = isRecord(p) ? (Array.isArray(p.keys) ? p.keys : [p.key]) : [];
          if (keys.includes("activeProfileId")) handler(userId ?? null);
        });
      },
    },

    registerInterceptor(handler, options) {
      // Lumiverse drops a registration made while `interceptor` isn't granted and never asks again, so
      // the grant registers it once more. It keeps one interceptor per extension: this one replaces it.
      let dispose: (() => void) | null = null;
      const register = (): void => {
        dispose?.();
        dispose = spindle.registerInterceptor(
          async (messages, context) => {
            const ctx: unknown = context;
            const chatId = str(ctx, "chatId");
            const userId = str(ctx, "userId");
            // What LumiAH didn't make goes back as the very objects Lumiverse gave, every field of theirs on them and none changed: Lumiverse gives the next interceptor what this one hands back, and reads its own marks on it afterwards.
            if (chatId === undefined || userId === undefined) return messages;
            const activated = isRecord(ctx) && Array.isArray(ctx.activatedWorldInfo) ? ctx.activatedWorldInfo : [];
            const verdict = await handler({
              chatId,
              userId,
              generationId: str(ctx, "generationId") ?? null,
              type: generationType(ctx),
              // The running Lumiverse's context says `dryRun`; the published types say `isDryRun`.
              dryRun: isRecord(ctx) && (ctx.dryRun === true || ctx.isDryRun === true),
              connectionId: str(ctx, "connectionId") ?? null,
              presetId: str(ctx, "presetId") ?? null,
              personaId: str(ctx, "personaId") ?? null,
              activated: activated.flatMap((e): ActivatedInfo[] => {
                const entryId = str(e, "id");
                if (entryId === undefined) return [];
                const source = str(e, "source");
                const score = num(e, "score");
                return [{ entryId, bookId: str(e, "bookId") ?? null, title: str(e, "comment") ?? "", ...(source === "keyword" ? { how: "key" as const } : source === "vector" ? { how: "vector" as const } : {}), ...(score !== undefined ? { score } : {}) }];
              }),
              messages: messages.map(promptMessageOf),
              // The worker's own signal for this call: Lumiverse ends it when the generation is stopped or the interceptor's time is up.
              ...(isRecord(ctx) && ctx.signal instanceof AbortSignal ? { signal: ctx.signal } : {}),
              ...(num(ctx, "interceptorDeadlineAt") !== undefined ? { deadlineAt: num(ctx, "interceptorDeadlineAt") } : {}),
            });
            // Lumiverse takes parameters only from an extension granted this, and says so in its log each time it takes them off: without it they are left out here.
            const parameters = verdict.parameters !== undefined && spindle.permissions.has("generation_parameters") ? verdict.parameters : undefined;
            if (verdict.messages !== undefined) {
              // The prompt as rewritten: a message that came goes back as the object it came as, one put in as its role and text. One named for the Prompt Breakdown is listed by its place in what goes back.
              const sent: LlmMessageDTO[] = [];
              const breakdown: { messageIndex: number; name: string }[] = [];
              for (const slot of verdict.messages) {
                if ("keep" in slot) {
                  const kept = messages[slot.keep];
                  if (kept !== undefined) sent.push(kept);
                  continue;
                }
                if (slot.label !== undefined) breakdown.push({ messageIndex: sent.length, name: slot.label });
                sent.push({ role: slot.role, content: slot.text });
              }
              return { messages: sent, ...(parameters ? { parameters } : {}), ...(breakdown.length > 0 ? { breakdown } : {}) };
            }
            const omit = new Set(verdict.omit ?? []);
            const sent = omit.size > 0 ? messages.filter((_, i) => !omit.has(i)) : messages;
            return parameters ? { messages: sent, parameters } : sent;
          },
          { priority: options.priority, match: { generationTypes: options.types.filter((t) => t !== "other") }, required: options.required },
        );
      };
      register();
      spindle.permissions.onChanged((detail) => {
        if (detail.permission === "interceptor" && detail.granted) register();
      });
    },

    models: {
      call(request, userId, signal, onDelta) {
        // The host merges these over the connection's preset parameters, so one left out stays the connection's own.
        const parameters: Record<string, unknown> = { ...request.params, max_tokens: request.maxTokens };
        // The host reads `parameters.model` as a per-request model override.
        if (request.model) parameters.model = request.model;
        // Only then does an OpenAI-compatible stream report usage; every provider drops the key itself.
        if (request.usage) parameters._include_usage = true;
        if (request.parallelToolCalls === false && request.tools !== undefined && request.tools.length > 0) parameters.parallel_tool_calls = false;
        const reasoning = reasoningOverride(request.effort, request.thinkingDisplay);
        return generate(
          {
            type: "quiet",
            messages: request.messages.map(messageDTO),
            parameters,
            ...(request.connectionId ? { connection_id: request.connectionId } : {}),
            ...(request.tools && request.tools.length > 0 ? { tools: request.tools.map(toolDTO) } : {}),
            ...(reasoning ? { reasoning } : {}),
            userId,
            signal,
          },
          signal,
          onDelta,
        );
      },
      pass(request, userId, signal, onDelta) {
        // Every parameter as the request's body gave it; only the usage is asked for beside them, so the answer can report it.
        return generate(
          {
            type: "quiet",
            messages: request.messages.map(passedMessageDTO),
            parameters: { ...request.parameters, _include_usage: true },
            ...(request.connectionId ? { connection_id: request.connectionId } : {}),
            ...(request.tools.length > 0 ? { tools: request.tools.map(passedToolDTO) } : {}),
            userId,
            signal,
          },
          signal,
          onDelta,
        );
      },
    },

    connections: {
      async list(userId) {
        return (await spindle.connections.list(userId)).map((c) => ({ id: c.id, name: c.name, provider: c.provider, url: c.api_url, model: c.model, isDefault: c.is_default, metadata: toJsonObject(c.metadata) }));
      },
      async get(connectionId, userId) {
        const c = await spindle.connections.get(connectionId, userId);
        return c ? { id: c.id, name: c.name, provider: c.provider, url: c.api_url, model: c.model, isDefault: c.is_default, metadata: toJsonObject(c.metadata) } : null;
      },
      async active(userId) {
        // Lumiverse keeps the selection as a setting, and shows an extension no setting: what it shows is the connections as the user arranged them, the one selected marked. Older hosts don't show that either.
        const organization = spindle.connections.organization;
        if (organization === undefined) return undefined;
        return (await organization.get({ kind: "llm", userId })).connections.find((c) => c.active)?.id ?? null;
      },
      async models(connectionId, userId) {
        // Older hosts can't list models.
        const list = spindle.connections.getModels;
        if (!list) return null;
        return (await list.call(spindle.connections, connectionId, userId)).map((m) => m.id);
      },
    },

    storage: {
      read: readOrNull,
      write: (path, text, userId) => spindle.userStorage.write(path, text, userId),
      remove: (path, userId) => spindle.userStorage.delete(path, userId),
      async stat(path, userId) {
        const stat = await spindle.userStorage.stat(path, userId);
        if (!stat.exists || !stat.isFile) return null;
        const at = Date.parse(stat.modifiedAt);
        return { bytes: stat.sizeBytes, writtenAt: Number.isFinite(at) ? at : 0 };
      },
      async list(dir, userId) {
        // The host lists a directory it doesn't have as its own failure: none, then.
        if (!(await spindle.userStorage.exists(dir, userId))) return [];
        // On Windows the host lists with its own separator; LumiAH's paths are `/` everywhere.
        return (await spindle.userStorage.list(dir, userId)).map((path) => path.replaceAll("\\", "/"));
      },
    },

    chats: {
      async get(chatId, userId) {
        const chat = await spindle.chats.get(chatId, userId);
        return chat ? { id: chat.id, name: chat.name, characterId: typeof chat.character_id === "string" && chat.character_id !== "" ? chat.character_id : null, metadata: toJsonObject(chat.metadata) } : null;
      },
      async patchMetadata(chatId, patch, userId) {
        /** The chat's metadata as it is now, and as it is to be. */
        const change = async (): Promise<{ read: Record<string, unknown>; metadata: Record<string, unknown> }> => {
          const chat = await spindle.chats.get(chatId, userId);
          if (!chat) throw new Error(`chat ${chatId} not found`);
          const metadata: Record<string, unknown> = { ...chat.metadata };
          for (const [key, value] of Object.entries(patch)) {
            if (value === null) delete metadata[key];
            else metadata[key] = value;
          }
          return { read: chat.metadata, metadata };
        };
        // The write on condition is newer than some hosts, and Lumiverse gives it only with `chat_mutation`, while a chat must still be switched off where that was revoked. Without either the metadata is replaced whole, and a change made between the read and the write is lost.
        if (!capability("chat-conditional-metadata-v1") || !spindle.permissions.has("chat_mutation")) {
          await spindle.chats.update(chatId, { metadata: (await change()).metadata }, userId);
          return;
        }
        for (let tries = 0; tries < METADATA_TRIES; tries++) {
          const { read, metadata } = await change();
          // Written only while the metadata is still what was read: null says it isn't, or that the chat is gone, which the next read tells.
          if ((await spindle.chats.compareAndSetMetadata(chatId, { expected_metadata: read, metadata }, userId)) !== null) return;
        }
        throw new Error(`Chat ${chatId}'s metadata kept changing while LumiAH wrote to it, so nothing was written: try again.`);
      },
      async messages(chatId, range) {
        const out: HostMessage[] = [];
        const take = (rows: readonly unknown[]): void => {
          for (const row of rows) {
            const m = messageOf(row, identifier);
            if (m) out.push(m);
          }
        };
        if (!lean) {
          // An older host gives every message whole, or none: the range is cut from them here.
          take(await spindle.chat.getMessages(chatId));
          out.sort((a, b) => a.index - b.index);
          if (range === undefined) return out;
          return "tail" in range ? out.slice(-range.tail) : out.slice(range.from, range.from + range.count);
        }
        // Only the shown swipe's text and LumiAH's own metadata: a long chat's reasoning and its other swipes stay where they are.
        const options: ChatGetMessagesOptionsDTO = { light: true, includeExtra: false, ownMetadataOnly: true };
        if (range !== undefined && "tail" in range) {
          take(await spindle.chat.getMessages(chatId, { ...options, tail: Math.max(1, Math.min(MESSAGE_PAGE, range.tail)) }));
          return out.sort((a, b) => a.index - b.index);
        }
        const end = range ? range.from + range.count : Number.POSITIVE_INFINITY;
        for (let offset = range?.from ?? 0; offset < end; offset += MESSAGE_PAGE) {
          const limit = Math.min(MESSAGE_PAGE, end - offset);
          const rows: unknown[] = await spindle.chat.getMessages(chatId, { ...options, limit, offset });
          take(rows);
          if (rows.length < limit) break;
        }
        return out.sort((a, b) => a.index - b.index);
      },
      async swipe(chatId, messageId, swipe) {
        /** The swipe's text where the message is among these rows: null when it has no such swipe, undefined when it isn't among them. */
        const textIn = (rows: readonly unknown[]): string | null | undefined => {
          const row = rows.find((r) => str(r, "id") === messageId);
          if (!isRecord(row)) return undefined;
          const swipes: unknown[] = Array.isArray(row.swipes) ? row.swipes : [];
          const text = swipes[swipe];
          if (typeof text === "string") return text;
          // A message that lists no swipes has one: the text it shows.
          return swipes.length === 0 && swipe === (num(row, "swipe_id") ?? 0) ? (str(row, "content") ?? null) : null;
        };
        try {
          // An older host gives every message whole, or none.
          if (!lean) return textIn(await spindle.chat.getMessages(chatId)) ?? null;
          // Whole, a message comes with every swipe's text, so only the one message is read whole. A reply is nearly always the chat's last message, which is asked for first; else its place is found by a lean read, a page at a time.
          const whole: ChatGetMessagesOptionsDTO = { includeExtra: false, ownMetadataOnly: true };
          const last = textIn(await spindle.chat.getMessages(chatId, { ...whole, tail: 1 }));
          if (last !== undefined) return last;
          for (let offset = 0; ; offset += MESSAGE_PAGE) {
            const rows: unknown[] = await spindle.chat.getMessages(chatId, { ...whole, light: true, limit: MESSAGE_PAGE, offset });
            const at = rows.findIndex((row) => str(row, "id") === messageId);
            // The chat may change between the two reads: the row read whole is the message only while it still has its id.
            if (at >= 0) return textIn(await spindle.chat.getMessages(chatId, { ...whole, limit: 1, offset: offset + at })) ?? null;
            if (rows.length < MESSAGE_PAGE) return null;
          }
        } catch {
          // The caller finishes a turn whose reply Lumiverse has already written: a read Lumiverse refuses (the chat is gone, `chat_mutation` was revoked) leaves the turn without this text and takes nothing else from it.
          return null;
        }
      },
      async setOwn(chatId, messageId, value) {
        // Only this write sets one extension's entry and leaves every other's alone; an older host can only replace the whole bag, which would race the others' writes.
        if (!lean) throw new Error("This Lumiverse can't write an extension's own entry on a message (it lacks chat-lean-messages-v1): update Lumiverse.");
        await spindle.chat.updateMessage(chatId, messageId, { ownMetadata: value });
      },
      async deleteMessage(chatId, messageId) {
        await spindle.chat.deleteMessage(chatId, messageId);
      },
      async list(userId, offset, limit) {
        const page = await spindle.chats.list({ limit, offset, userId });
        const chats = page.data.map((chat): HostChat => ({ id: chat.id, name: chat.name, characterId: typeof chat.character_id === "string" && chat.character_id !== "" ? chat.character_id : null, metadata: toJsonObject(chat.metadata) }));
        return { chats, total: typeof page.total === "number" ? page.total : offset + chats.length };
      },
      async characterName(characterId, userId) {
        if (!spindle.permissions.has("characters")) return null;
        return (await spindle.characters.get(characterId, userId))?.name ?? null;
      },
    },

    lore: {
      async book(bookId, userId) {
        if (!spindle.permissions.has("world_books")) return null;
        const b = await spindle.world_books.get(bookId, userId);
        return b ? { id: b.id, name: b.name, description: b.description ?? "" } : null;
      },
      entries: async (bookId, userId) => (await bookEntries(bookId, userId)).map(entryOf),
      async entry(entryId, userId) {
        if (!spindle.permissions.has("world_books")) return null;
        const e = await spindle.world_books.entries.get(entryId, userId);
        return e ? entryOf(e) : null;
      },
      async record(bookId, userId) {
        if (!spindle.permissions.has("world_books")) return null;
        const b = await spindle.world_books.get(bookId, userId);
        return b ? { id: b.id, name: b.name, description: b.description ?? "", metadata: toJsonObject(b.metadata), updatedAt: stampOf(b.updated_at) ?? 0 } : null;
      },
      records: async (bookId, userId) => (await bookEntries(bookId, userId)).map(entryRecordOf),
      async global(userId) {
        return spindle.permissions.has("world_books") ? spindle.world_books.getGlobal(userId) : [];
      },
      async ofCharacter(characterId, userId) {
        if (!spindle.permissions.has("characters")) return [];
        const c = await spindle.characters.get(characterId, userId);
        return c && Array.isArray(c.world_book_ids) ? c.world_book_ids.filter((id): id is string => typeof id === "string") : [];
      },
      async ofPersona(personaId, userId) {
        if (!spindle.permissions.has("personas")) return null;
        const p = personaId === null ? await spindle.personas.getActive(userId) : await spindle.personas.get(personaId, userId);
        return p?.attached_world_book_id ?? null;
      },
    },

    presets: {
      async blocks(presetId, userId) {
        if (!spindle.permissions.has("presets")) return null;
        if ((await spindle.presets.get(presetId, userId)) === null) return null;
        return (await spindle.presets.blocks.list(presetId, userId)).map((b) => ({ id: b.id, name: b.name, role: roleOf(b.role), content: b.content, enabled: b.enabled, marker: typeof b.marker === "string" && b.marker !== "" ? b.marker : null }));
      },
      async active(chatId, userId) {
        // `presets.getActive` is newer than some hosts, and gated.
        if (!spindle.permissions.has("presets")) return null;
        const presets: unknown = spindle.presets;
        const getActive = isRecord(presets) ? presets.getActive : undefined;
        if (typeof getActive !== "function") return null;
        const raw: unknown = await (getActive as (this: unknown, chatId?: string, userId?: string) => Promise<unknown>).call(presets, chatId, userId);
        if (!isRecord(raw)) return null;
        const states: Record<string, boolean> = {};
        if (isRecord(raw.block_states)) for (const [id, on] of Object.entries(raw.block_states)) if (typeof on === "boolean") states[id] = on;
        return { presetId: typeof raw.preset_id === "string" ? raw.preset_id : null, states };
      },
    },

    mcp: {
      async servers(userId) {
        // `spindle.mcp` is newer than some hosts, and gated.
        if (!isRecord(spindle.mcp) || !spindle.permissions.has("mcp_servers")) return [];
        const out: HostMcpServer[] = [];
        for (let offset = 0; ; offset += MCP_PAGE) {
          const page = await spindle.mcp.servers.list({ limit: MCP_PAGE, offset, userId });
          for (const s of page.data) out.push({ id: s.id, name: s.name, enabled: s.is_enabled, createdAt: s.created_at });
          if (page.data.length < MCP_PAGE || out.length >= page.total) return out;
        }
      },
      async tools(serverId, userId) {
        if (!isRecord(spindle.mcp)) throw new Error("This Lumiverse has no MCP servers.");
        let status = await spindle.mcp.servers.status(serverId, userId);
        if (!status.connected) status = await spindle.mcp.servers.connect(serverId, userId);
        // Lumiverse says only that the connection failed: why is in its own MCP settings, which show the server's error.
        if (!status.connected) throw new Error(status.error ?? "MCP connection failed");
        return status.tools.map((t) => ({ name: t.name, description: t.description, parameters: toJsonObject(t.input_schema) }));
      },
      call(serverId, tool, args, timeoutMs, userId) {
        if (!isRecord(spindle.mcp)) throw new Error("This Lumiverse has no MCP servers.");
        return spindle.mcp.tools.call(serverId, tool, args, { userId, timeoutMs });
      },
    },

    embeddings: {
      async connection(userId) {
        const api = embeddingsApi();
        if (api === null) return null;
        const main = (await api.listConnections({ userId })).find((c) => c.is_primary);
        // Lumiverse embeds for an extension on the main connection alone, never on a fallback: one that is switched off embeds nothing.
        return main !== undefined && main.enabled ? { id: main.id, name: main.name, model: main.model, dimensions: typeof main.dimensions === "number" ? main.dimensions : null } : null;
      },
      async embed(texts, kind, userId, signal) {
        const api = embeddingsApi();
        if (api === null) throw new Error('There is no embedding connection to use: this Lumiverse embeds nothing for an extension, or the "embeddings" permission isn\'t granted.');
        // Lumiverse's word for a text that is searched in is "passage".
        const out = await api.embed({ texts: [...texts], input_type: kind === "query" ? "query" : "passage", userId }, signal !== undefined ? { signal } : undefined);
        return { vectors: out.embeddings, model: out.model, dimensions: out.dimensions };
      },
    },

    memory: {
      async enabled(userId) {
        const api = memoriesApi();
        return api !== null && (await api.cortex.getConfig(userId)).enabled === true;
      },
      async search(chatId, query, options, userId) {
        const api = memoriesApi();
        if (api === null || options.limit < 1) return [];
        // The running Lumiverse answers null for a chat the Cortex is switched off for; the published types say it always answers.
        const found: unknown = await api.cortex.query({ chatId, queryText: query, topK: options.limit, ...(options.entities !== undefined && options.entities.length > 0 ? { entityFilter: [...options.entities] } : {}), includeConsolidations: true, includeRelationships: false, userId });
        const memories: unknown[] = isRecord(found) && Array.isArray(found.memories) ? found.memories : [];
        return memories
          .flatMap((m): MemoryHit[] => {
            const hit = memoryHitOf(m);
            return hit === null ? [] : [hit];
          })
          .slice(0, options.limit);
      },
      async entity(chatId, name, userId) {
        const api = memoriesApi();
        if (api === null) return null;
        const found = await api.entities.findByName(chatId, name, userId);
        if (!found) return null;
        // Its facts come without the marks the Cortex keeps on them for itself.
        const [facts, edges] = await Promise.all([api.entities.getFacts(found.id, userId), api.relations.forEntity(chatId, found.id, userId)]);
        // An edge names its two ends by id, and runs either way: the other end's name is read once for each.
        const ends = edges.map((edge) => ({ edge, other: edge.sourceEntityId === found.id ? edge.targetEntityId : edge.sourceEntityId }));
        const names = new Map<string, string | null>();
        await Promise.all([...new Set(ends.map((end) => end.other))].map(async (id) => void names.set(id, (await api.entities.get(id, userId))?.name ?? null)));
        const relations = ends.flatMap(({ edge, other }): MemoryRelation[] => {
          const target = names.get(other);
          // An edge whose other end is gone says nothing.
          return target ? [{ target, type: edge.relationType, label: edge.relationLabel ?? null, strength: edge.strength, sentiment: edge.sentiment }] : [];
        });
        relations.sort((a, b) => b.strength - a.strength);
        return { id: found.id, name: found.name, type: found.entityType, aliases: strings(found.aliases), description: found.description ?? "", status: found.status, facts: strings(facts), mentions: found.mentionCount, lastSeenAt: stampOf(found.lastSeenAt), relations };
      },
      async entities(chatId, limit, userId) {
        const api = memoriesApi();
        if (api === null || limit < 1) return [];
        // As Lumiverse lists them where none is asked for by name: those whose status is active, by salience.
        return (await api.entities.list(chatId, { limit, userId })).slice(0, limit).map((e) => ({ name: e.name, type: e.entityType, mentions: e.mentionCount }));
      },
      async arcs(chatId, userId) {
        const api = memoriesApi();
        if (api === null) return [];
        return (await api.consolidations.list(chatId, { userId })).map((c) => ({ id: c.id, tier: c.tier, title: c.title ?? null, summary: c.summary, span: spanOf(c.messageRangeStart, c.messageRangeEnd), at: stampOf(c.createdAt) ?? 0 }));
      },
    },

    databanks: {
      async list(userId) {
        const api = databanksApi();
        if (api === null) return [];
        const out: HostDatabank[] = [];
        for (let offset = 0; ; offset += HOST_PAGE) {
          const page = await api.list({ limit: HOST_PAGE, offset, userId });
          for (const d of page.data) out.push({ id: d.id, name: d.name, description: d.description ?? "", scope: d.scope, scopeId: d.scope_id ?? null, enabled: d.enabled === true, documents: d.document_count ?? 0 });
          if (page.data.length < HOST_PAGE || out.length >= page.total) return out;
        }
      },
      async ofCharacter(characterId, userId) {
        if (!spindle.permissions.has("characters")) return [];
        // Lumiverse keeps them on the card, under its own key of the card's extension data.
        const extensions: unknown = (await spindle.characters.get(characterId, userId))?.extensions;
        return isRecord(extensions) ? strings(extensions.databank_ids).filter((id) => id !== "") : [];
      },
      async documents(databankId, userId) {
        const api = databanksApi();
        if (api === null) return [];
        const out: DatabankDocument[] = [];
        for (let offset = 0; ; offset += HOST_PAGE) {
          const page = await api.documents.list(databankId, { limit: HOST_PAGE, offset, userId });
          // A document's version moves with its file (the hash) and with how far Lumiverse has read it in (the stamp): its text is worth reading again when either did.
          for (const d of page.data) out.push({ id: d.id, databankId: d.databank_id, name: d.name, version: `${d.content_hash}:${d.updated_at}`, bytes: typeof d.file_size === "number" && d.file_size >= 0 ? d.file_size : null, status: d.status });
          if (page.data.length < HOST_PAGE || out.length >= page.total) return out;
        }
      },
      async content(documentId, userId) {
        const api = databanksApi();
        if (api === null) return null;
        return (await api.documents.getContent(documentId, userId))?.content ?? null;
      },
    },

    web: {
      async enabled(userId) {
        const api = webApi();
        return api !== null && (await api.getSettings(userId)).enabled === true;
      },
      async search(query, options, userId) {
        const api = webApi();
        if (api === null) return [];
        const out = await api.query({ query, count: options.count, scrape: options.pages, userId });
        // The pages Lumiverse read come beside the results, each under its address.
        const pages = new Map<string, string>();
        for (const page of out.documents ?? []) if (typeof page.content === "string" && page.content !== "") pages.set(page.url, page.content);
        return out.results.slice(0, Math.max(0, options.count)).map((r): WebResult => {
          const content = pages.get(r.url);
          return { title: r.title, url: r.url, snippet: r.snippet, ...(content !== undefined ? { content } : {}) };
        });
      },
    },
  };
}
