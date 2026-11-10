// The only file of the backend that touches the `spindle` global (DESIGN §1). Everything else talks to
// `BackendHost`, the interface it implements, so the tests run the whole backend against a fake.
//
// What crosses here is already in LumiAH's own shapes: a model call takes the core's `ModelRequest`
// and gives its `ModelResult`; a chat's messages come with only this extension's own metadata; an
// event comes decoded. Where the running Lumiverse differs from the published types, the difference
// is read here and nowhere else.

import type { ChatGetMessagesOptionsDTO, GenerationReasoningOverrideDTO, GenerationRequestDTO, LlmMessageDTO, LlmMessagePartDTO, SpindleAPI, StreamChunkDTO, ToolSchemaDTO } from "lumiverse-spindle-types";
import type { ChatRole, JsonObject, JsonValue, ModelDelta, ModelEffort, ModelMessage, ModelRequest, ModelResult, ModelThinkingBlock, ModelTool, ModelToolCall } from "../../core/ports";
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
  /** The chat message it came from and that message's place in the chat, where Lumiverse says. */
  sourceId?: string;
  sourceIndex?: number;
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
  activated: { entryId: string; bookId: string | null; title: string }[];
  messages: PromptMessage[];
}

/** What the interceptor does to the prompt: the places of the messages to leave out, and parameters to add to the request's body. */
export interface InterceptorVerdict {
  omit?: number[];
  parameters?: Record<string, JsonValue>;
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
  /** LumiAH's own entry in the message's extension metadata; null when it has none. */
  own: JsonValue | null;
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

export interface HostPresetBlock {
  id: string;
  name: string;
  role: ChatRole;
  content: string;
  enabled: boolean;
  /** Where Lumiverse puts something of its own (`chat_history`, `world_info_before`, …); null for a block the preset's author wrote. */
  marker: string | null;
}

/** A request passed through as it came: its messages, its tools, and every parameter of its body. */
export interface PassRequest {
  connectionId: string | null;
  messages: ModelMessage[];
  tools: ModelTool[];
  parameters: JsonObject;
}

export type HostLogLevel = "info" | "warn" | "error";

/** Lumiverse as the backend needs it. Every call names its user: the extension may be installed for all of them. */
export interface BackendHost {
  log(level: HostLogLevel, message: string): void;
  /** Whether a gated permission is granted now. */
  granted(permission: string): boolean;
  /** A permission was granted or revoked while the extension runs. */
  onPermission(handler: (permission: string, granted: boolean) => void): void;
  /** What this Lumiverse can do, by capability name (`spindle.host.capabilities`). */
  capability(name: string): boolean;
  /** Where this build runs from: Lumiverse's own Bun, and the directory its bundles are in; null where the worker can't say. */
  install: { bun: string | null; dir: string | null };

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
    /** A chat's messages changed in any way (one sent, edited, deleted or swiped, or the chat changed whole), or the chat is gone (`gone`). */
    onChatTouched(handler: (chatId: string, gone: boolean) => void): void;
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
    list(userId: string): Promise<HostConnection[]>;
    get(connectionId: string, userId: string): Promise<HostConnection | null>;
    /** The models a connection's provider lists; null where this Lumiverse can't ask. */
    models(connectionId: string, userId: string): Promise<string[] | null>;
  };

  /** The user's own storage for this extension: text files by path. */
  storage: {
    /** The file's text; null when there is none. */
    read(path: string, userId: string): Promise<string | null>;
    write(path: string, text: string, userId: string): Promise<void>;
    remove(path: string, userId: string): Promise<void>;
    /** The file's size in bytes; null when there is none. */
    size(path: string, userId: string): Promise<number | null>;
  };

  chats: {
    get(chatId: string, userId: string): Promise<HostChat | null>;
    /** Sets these keys of the chat's metadata, keeping the others; a null value takes its key away. */
    patchMetadata(chatId: string, patch: Record<string, JsonValue>, userId: string): Promise<void>;
    /** The chat's messages in chat order: all of them, `count` from the `from`th, or the last `tail`. */
    messages(chatId: string, range?: { from: number; count: number } | { tail: number }): Promise<HostMessage[]>;
    /** Writes LumiAH's own entry in a message's extension metadata, keeping every other extension's. */
    setOwn(chatId: string, messageId: string, value: JsonValue): Promise<void>;
  };

  lore: {
    book(bookId: string, userId: string): Promise<HostBook | null>;
    entries(bookId: string, userId: string): Promise<HostBookEntry[]>;
    entry(entryId: string, userId: string): Promise<HostBookEntry | null>;
    /** The books switched on for every chat. */
    global(userId: string): Promise<string[]>;
    /** The books attached to a character, and the one attached to a persona; none where the permission to read them isn't granted. */
    ofCharacter(characterId: string, userId: string): Promise<string[]>;
    /** The book attached to a persona (null: to the user's active persona); none where there is no such persona or the permission to read it isn't granted. */
    ofPersona(personaId: string | null, userId: string): Promise<string | null>;
  };

  presets: {
    /** The preset's blocks in order; null when there is no such preset. */
    blocks(presetId: string, userId: string): Promise<HostPresetBlock[] | null>;
    /** The preset a chat generates with, and the block states its binding sets over the preset's own, by block id; null when this Lumiverse can't say. */
    active(chatId: string, userId: string): Promise<{ presetId: string | null; states: Record<string, boolean> } | null>;
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

/** The host's own flags on an interceptor's messages: read, then taken off, so none reaches the provider. */
const PROMPT_FLAGS = ["__isChatHistory", "__isWorldInfoEntry", "sourceMessageId", "sourceIndexInChat", "sourceMessageMetadata"] as const;

/** A prompt message as the interceptor reads it, and the message without the host's flags. */
function promptMessageOf(raw: LlmMessageDTO): { message: PromptMessage; clean: LlmMessageDTO } {
  const flagged = raw as LlmMessageDTO & Record<string, unknown>;
  const clean = { ...flagged } as Record<string, unknown>;
  for (const flag of PROMPT_FLAGS) delete clean[flag];
  const index = flagged.sourceIndexInChat;
  const id = flagged.sourceMessageId;
  return {
    message: { role: raw.role, text: partsText(raw.content), history: flagged.__isChatHistory === true, ...(typeof id === "string" ? { sourceId: id } : {}), ...(typeof index === "number" ? { sourceIndex: index } : {}) },
    clean: clean as unknown as LlmMessageDTO,
  };
}

/** A chat message as the host gives one (`getMessages`); null when it isn't one. */
function messageOf(raw: unknown): HostMessage | null {
  const id = str(raw, "id");
  if (!isRecord(raw) || id === undefined) return null;
  const swipes = Array.isArray(raw.swipes) ? raw.swipes : [];
  const swipeId = num(raw, "swipe_id") ?? 0;
  const shown = swipes[swipeId];
  const metadata = isRecord(raw.metadata) ? raw.metadata : isRecord(raw.extra) && isRecord(raw.extra.spindle_metadata) ? raw.extra.spindle_metadata : {};
  const own = metadata[EXTENSION_IDENTIFIER];
  return {
    id,
    index: num(raw, "index_in_chat") ?? 0,
    role: raw.role === "system" || raw.role === "assistant" || raw.role === "user" ? raw.role : raw.is_user === true ? "user" : "assistant",
    name: str(raw, "name") ?? "",
    swipeId,
    swipes: Math.max(1, swipes.length),
    // The host keeps the shown swipe's text as `content` too; a lean read leaves the other swipes' slots null.
    content: str(raw, "content") ?? (typeof shown === "string" ? shown : ""),
    own: own === undefined ? null : toJson(own),
  };
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

export function createSpindleHost(): BackendHost {
  const capabilities: Readonly<Record<string, number>> = spindle.host?.capabilities ?? {};
  const capability = (name: string): boolean => (capabilities[name] ?? 0) >= 1;
  const lean = capability("chat-lean-messages-v1");
  // Bundled, this module is dist/backend.js, which Lumiverse's worker imports by its absolute path: the runtime's bundle is beside it.
  const url = import.meta.url;
  const dir = url.startsWith("file://") ? decodeURIComponent(url.slice("file://".length).replace(/\/[^/]*$/, "")) : null;

  return {
    log(level, message) {
      if (level === "error") spindle.log.error(message);
      else if (level === "warn") spindle.log.warn(message);
      else spindle.log.info(message);
    },
    granted: (permission) => spindle.permissions.has(permission),
    onPermission(handler) {
      spindle.permissions.onChanged((detail) => handler(detail.permission, detail.granted));
    },
    capability,
    install: { bun: typeof process.execPath === "string" && process.execPath.startsWith("/") ? process.execPath : null, dir },

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
          handler({ generationId, chatId, userId: userId ?? null, messageId: str(p, "messageId") ?? null, error: str(p, "error") ?? null });
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
          const chatId = str(p, "chatId");
          if (chatId !== undefined) handler(chatId, userId ?? null);
        });
      },
      onChatTouched(handler) {
        // The events Lumiverse's own state revision counts as a chat's messages changing.
        for (const event of ["MESSAGE_SENT", "MESSAGE_EDITED", "MESSAGE_DELETED", "MESSAGE_SWIPED", "SWIPE_EDITED", "CHAT_CHANGED"]) {
          spindle.on(event, (p: unknown) => {
            const chatId = str(p, "chatId");
            if (chatId !== undefined) handler(chatId, false);
          });
        }
        spindle.on("CHAT_DELETED", (p: unknown) => {
          const chatId = str(p, "id") ?? str(p, "chatId");
          if (chatId !== undefined) handler(chatId, true);
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
            const read = messages.map(promptMessageOf);
            const clean = read.map((r) => r.clean);
            const ctx: unknown = context;
            const chatId = str(ctx, "chatId");
            const userId = str(ctx, "userId");
            if (chatId === undefined || userId === undefined) return clean;
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
              activated: activated.flatMap((e) => {
                const entryId = str(e, "id");
                return entryId === undefined ? [] : [{ entryId, bookId: str(e, "bookId") ?? null, title: str(e, "comment") ?? "" }];
              }),
              messages: read.map((r) => r.message),
            });
            const omit = new Set(verdict.omit ?? []);
            const sent = omit.size > 0 ? clean.filter((_, i) => !omit.has(i)) : clean;
            return verdict.parameters ? { messages: sent, parameters: verdict.parameters } : sent;
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
            messages: request.messages.map(messageDTO),
            parameters: { ...request.parameters, _include_usage: true },
            ...(request.connectionId ? { connection_id: request.connectionId } : {}),
            ...(request.tools.length > 0 ? { tools: request.tools.map(toolDTO) } : {}),
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
      async size(path, userId) {
        const stat = await spindle.userStorage.stat(path, userId);
        return stat.exists && stat.isFile ? stat.sizeBytes : null;
      },
    },

    chats: {
      async get(chatId, userId) {
        const chat = await spindle.chats.get(chatId, userId);
        return chat ? { id: chat.id, name: chat.name, characterId: typeof chat.character_id === "string" && chat.character_id !== "" ? chat.character_id : null, metadata: toJsonObject(chat.metadata) } : null;
      },
      async patchMetadata(chatId, patch, userId) {
        const chat = await spindle.chats.get(chatId, userId);
        if (!chat) throw new Error(`chat ${chatId} not found`);
        const metadata: Record<string, unknown> = { ...chat.metadata };
        for (const [key, value] of Object.entries(patch)) {
          if (value === null) delete metadata[key];
          else metadata[key] = value;
        }
        await spindle.chats.update(chatId, { metadata }, userId);
      },
      async messages(chatId, range) {
        const out: HostMessage[] = [];
        const take = (rows: readonly unknown[]): void => {
          for (const row of rows) {
            const m = messageOf(row);
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
      async setOwn(chatId, messageId, value) {
        // Only this write sets one extension's entry and leaves every other's alone; an older host can only replace the whole bag, which would race the others' writes.
        if (!lean) throw new Error("This Lumiverse can't write an extension's own entry on a message (it lacks chat-lean-messages-v1): update Lumiverse.");
        await spindle.chat.updateMessage(chatId, messageId, { ownMetadata: value });
      },
    },

    lore: {
      async book(bookId, userId) {
        const b = await spindle.world_books.get(bookId, userId);
        return b ? { id: b.id, name: b.name, description: b.description ?? "" } : null;
      },
      async entries(bookId, userId) {
        const out: HostBookEntry[] = [];
        for (let offset = 0; ; offset += HOST_PAGE) {
          const page = await spindle.world_books.entries.list(bookId, { limit: HOST_PAGE, offset, userId });
          for (const e of page.data) out.push({ id: e.id, bookId: e.world_book_id, title: e.comment, keys: [...e.key], secondaryKeys: [...(e.keysecondary ?? [])], content: e.content, enabled: !e.disabled, constant: e.constant });
          if (page.data.length < HOST_PAGE || out.length >= page.total) return out;
        }
      },
      async entry(entryId, userId) {
        const e = await spindle.world_books.entries.get(entryId, userId);
        return e ? { id: e.id, bookId: e.world_book_id, title: e.comment, keys: [...e.key], secondaryKeys: [...(e.keysecondary ?? [])], content: e.content, enabled: !e.disabled, constant: e.constant } : null;
      },
      global: (userId) => spindle.world_books.getGlobal(userId),
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
        if ((await spindle.presets.get(presetId, userId)) === null) return null;
        return (await spindle.presets.blocks.list(presetId, userId)).map((b) => ({ id: b.id, name: b.name, role: roleOf(b.role), content: b.content, enabled: b.enabled, marker: typeof b.marker === "string" && b.marker !== "" ? b.marker : null }));
      },
      async active(chatId, userId) {
        // `presets.getActive` is newer than some hosts.
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
  };
}
