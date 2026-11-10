// An in-memory Lumiverse for the extension backend's tests: everything `BackendHost` asks of Spindle,
// kept in maps, with a scripted model and hooks to fire Lumiverse's events by hand. Nothing here is
// LumiAH's: it stands where Lumiverse stands. All names and texts are made up.

import type { ChatRole, JsonObject, JsonValue, ModelDelta, ModelRequest, ModelResult, ModelToolCall } from "../../src/core/ports";
import type { BackendHost, GenerationEnded, GenerationStarted, GenerationStopped, HostBook, HostBookEntry, HostChat, HostConnection, HostGenerationType, HostLogLevel, HostMessage, HostPresetBlock, InterceptorInput, InterceptorVerdict, PassRequest, SwipeChanged } from "../../src/extension/backend/spindle";

export interface FakeMessage {
  id: string;
  role: ChatRole;
  name: string;
  swipes: string[];
  swipeId: number;
  own: JsonValue | null;
}

export interface FakeChat {
  id: string;
  userId: string;
  name: string;
  characterId: string | null;
  metadata: JsonObject;
  messages: FakeMessage[];
}

/** One scripted answer: its text alone, or its parts; `error` fails the call with those words; `hang` never answers until the call's signal ends it. */
export type Answer = string | { content?: string; toolCalls?: ModelToolCall[]; reasoning?: string; finishReason?: string; usage?: JsonObject; error?: string; hang?: true; deltas?: string[] };

/** A model call as the host got it: an agent's (`call`) or a passed-through request (`pass`). */
export type MadeCall = { kind: "call"; userId: string; request: ModelRequest } | { kind: "pass"; userId: string; request: PassRequest };

export const toolCall = (name: string, args: JsonObject, callId = `call_${name}`): ModelToolCall => ({ name, args, callId });

const clone = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;

export class FakeHost implements BackendHost {
  readonly logs: { level: HostLogLevel; message: string }[] = [];
  readonly permissions = new Set(["generation", "interceptor", "generation_parameters", "chats", "chat_mutation", "world_books", "presets", "characters", "personas"]);
  readonly capabilities = new Set(["chat-lean-messages-v1", "frontend-session-routing-v1", "required-interceptors-v1"]);
  readonly install = { bun: "/opt/bun/bin/bun", dir: "/srv/lumiverse/extensions/lumi_ah/dist" };

  readonly chatList = new Map<string, FakeChat>();
  connectionList: HostConnection[] = [];
  readonly files = new Map<string, string>();
  readonly books = new Map<string, { book: HostBook; userId: string; entries: HostBookEntry[] }>();
  globalBooks: string[] = [];
  readonly presetList = new Map<string, HostPresetBlock[]>();
  /** A chat's preset binding, by chat. */
  readonly activePresets = new Map<string, { presetId: string | null; states: Record<string, boolean> }>();

  /** Every model call made, in order, and what answers them. */
  readonly calls: MadeCall[] = [];
  /** How many calls under way were ended by their signal (a cancel, a stop). */
  cancelled = 0;
  script: Answer[] | ((call: MadeCall, n: number) => Answer | Promise<Answer>) = [];
  /** Every read of a chat's messages: the chat and the range asked for (null: the whole chat). */
  readonly reads: { chatId: string; range: { from: number; count: number } | { tail: number } | null }[] = [];
  /** Everything sent to a page or a runtime. */
  readonly sent: { message: unknown; userId: string; session: string | undefined }[] = [];
  /** Where each session's messages go: a runtime's socket, or a page. */
  readonly outlets = new Map<string, { userId: string; receive(message: unknown): void }>();
  interceptor: { handler(input: InterceptorInput): Promise<InterceptorVerdict>; options: { priority: number; types: readonly HostGenerationType[]; required: boolean } } | null = null;

  private messageHandler: ((payload: unknown, userId: string, session: string | undefined) => void) | null = null;
  private readonly closedHandlers: ((session: string) => void)[] = [];
  private readonly on = {
    started: [] as ((event: GenerationStarted) => void)[],
    ended: [] as ((event: GenerationEnded) => void)[],
    stopped: [] as ((event: GenerationStopped) => void)[],
    swipe: [] as ((event: SwipeChanged) => void)[],
    chatChanged: [] as ((chatId: string, userId: string | null) => void)[],
    touched: [] as ((chatId: string, gone: boolean) => void)[],
    permission: [] as ((permission: string, granted: boolean) => void)[],
  };
  private nextId = 1;

  log = (level: HostLogLevel, message: string): void => void this.logs.push({ level, message });
  granted = (permission: string): boolean => this.permissions.has(permission);
  onPermission = (handler: (permission: string, granted: boolean) => void): void => void this.on.permission.push(handler);
  capability = (name: string): boolean => this.capabilities.has(name);

  readonly frontend = {
    send: (message: unknown, userId: string, session?: string): void => {
      // As on the wire: what can't be JSON doesn't cross.
      const wire = clone(message);
      this.sent.push({ message: wire, userId, session });
      const to = session !== undefined ? [this.outlets.get(session)] : [...this.outlets.values()].filter((o) => o.userId === userId);
      for (const outlet of to) if (outlet !== undefined && outlet.userId === userId) queueMicrotask(() => outlet.receive(wire));
    },
    onMessage: (handler: (payload: unknown, userId: string, session: string | undefined) => void): void => {
      this.messageHandler = handler;
    },
    onClosed: (handler: (session: string) => void): void => void this.closedHandlers.push(handler),
  };

  /** A page or a runtime sends the backend a message, as Lumiverse hands it on. */
  deliver(payload: unknown, userId: string, session: string | undefined): void {
    const wire = clone(payload);
    queueMicrotask(() => this.messageHandler?.(wire, userId, session));
  }

  /** A session's socket closed. */
  closeSession(session: string): void {
    this.outlets.delete(session);
    for (const handler of this.closedHandlers) handler(session);
  }

  readonly events = {
    onGenerationStarted: (handler: (event: GenerationStarted) => void): void => void this.on.started.push(handler),
    onGenerationEnded: (handler: (event: GenerationEnded) => void): void => void this.on.ended.push(handler),
    onGenerationStopped: (handler: (event: GenerationStopped) => void): void => void this.on.stopped.push(handler),
    onSwipe: (handler: (event: SwipeChanged) => void): void => void this.on.swipe.push(handler),
    onChatChanged: (handler: (chatId: string, userId: string | null) => void): void => void this.on.chatChanged.push(handler),
    onChatTouched: (handler: (chatId: string, gone: boolean) => void): void => void this.on.touched.push(handler),
  };

  /** Lumiverse's events, fired by hand. */
  readonly emit = {
    started: (event: GenerationStarted): void => this.on.started.forEach((h) => h(event)),
    ended: (event: GenerationEnded): void => this.on.ended.forEach((h) => h(event)),
    stopped: (event: GenerationStopped): void => this.on.stopped.forEach((h) => h(event)),
    swipe: (event: SwipeChanged): void => this.on.swipe.forEach((h) => h(event)),
    chatChanged: (chatId: string, userId: string | null): void => this.on.chatChanged.forEach((h) => h(chatId, userId)),
    touched: (chatId: string, gone = false): void => this.on.touched.forEach((h) => h(chatId, gone)),
  };

  registerInterceptor(handler: (input: InterceptorInput) => Promise<InterceptorVerdict>, options: { priority: number; types: readonly HostGenerationType[]; required: boolean }): void {
    this.interceptor = { handler, options };
  }

  private async answer(call: MadeCall, stream: boolean, signal: AbortSignal, onDelta: (delta: ModelDelta) => void): Promise<ModelResult> {
    const n = this.calls.length;
    this.calls.push(clone(call));
    signal.throwIfAborted();
    const scripted = typeof this.script === "function" ? await this.script(call, n) : this.script[n];
    if (scripted === undefined) throw new Error(`no answer scripted for call ${n + 1}`);
    const answer = typeof scripted === "string" ? { content: scripted } : scripted;
    if (answer.hang) {
      const { promise, reject } = Promise.withResolvers<never>();
      const ended = (): void => {
        this.cancelled++;
        reject(signal.reason instanceof Error ? signal.reason : new Error("aborted"));
      };
      if (signal.aborted) ended();
      else signal.addEventListener("abort", ended, { once: true });
      return promise;
    }
    const content = answer.content ?? "";
    if (stream) {
      if (answer.reasoning) onDelta({ reasoning: answer.reasoning });
      for (const piece of answer.deltas ?? (content === "" ? [] : (content.match(/\S+\s*/g) ?? [content]))) onDelta({ content: piece });
    }
    if (answer.error !== undefined) throw new Error(answer.error);
    return {
      content,
      finishReason: answer.finishReason ?? (answer.toolCalls?.length ? "tool_calls" : "stop"),
      model: "scripted-model",
      ...(answer.toolCalls?.length ? { toolCalls: answer.toolCalls } : {}),
      ...(answer.reasoning !== undefined ? { reasoning: answer.reasoning } : {}),
      usage: answer.usage ?? { prompt_tokens: 120, completion_tokens: 30, total_tokens: 150 },
    };
  }

  readonly models = {
    call: (request: ModelRequest, userId: string, signal: AbortSignal, onDelta: (delta: ModelDelta) => void): Promise<ModelResult> => this.answer({ kind: "call", userId, request }, true, signal, onDelta),
    pass: (request: PassRequest, userId: string, signal: AbortSignal, onDelta: (delta: ModelDelta) => void): Promise<ModelResult> => this.answer({ kind: "pass", userId, request }, true, signal, onDelta),
  };

  readonly connections = {
    list: async (_userId: string): Promise<HostConnection[]> => clone(this.connectionList),
    get: async (connectionId: string, _userId: string): Promise<HostConnection | null> => clone(this.connectionList.find((c) => c.id === connectionId) ?? null),
    models: async (connectionId: string, _userId: string): Promise<string[] | null> => [`${connectionId}-model-a`, `${connectionId}-model-b`],
  };

  readonly storage = {
    read: async (path: string, userId: string): Promise<string | null> => this.files.get(`${userId}/${path}`) ?? null,
    write: async (path: string, text: string, userId: string): Promise<void> => void this.files.set(`${userId}/${path}`, text),
    remove: async (path: string, userId: string): Promise<void> => void this.files.delete(`${userId}/${path}`),
    size: async (path: string, userId: string): Promise<number | null> => {
      const text = this.files.get(`${userId}/${path}`);
      return text === undefined ? null : new TextEncoder().encode(text).length;
    },
  };

  private row(m: FakeMessage, index: number): HostMessage {
    return { id: m.id, index, role: m.role, name: m.name, swipeId: m.swipeId, swipes: m.swipes.length, content: m.swipes[m.swipeId] ?? "", own: clone(m.own) };
  }

  readonly chats = {
    get: async (chatId: string, userId: string): Promise<HostChat | null> => {
      const chat = this.chatList.get(chatId);
      return chat !== undefined && chat.userId === userId ? { id: chat.id, name: chat.name, characterId: chat.characterId, metadata: clone(chat.metadata) } : null;
    },
    patchMetadata: async (chatId: string, patch: Record<string, JsonValue>, userId: string): Promise<void> => {
      const chat = this.chatList.get(chatId);
      if (chat === undefined || chat.userId !== userId) throw new Error(`chat ${chatId} not found`);
      for (const [key, value] of Object.entries(patch)) {
        if (value === null) delete chat.metadata[key];
        else chat.metadata[key] = clone(value);
      }
      this.emit.chatChanged(chatId, userId);
    },
    messages: async (chatId: string, range?: { from: number; count: number } | { tail: number }): Promise<HostMessage[]> => {
      this.reads.push({ chatId, range: range ?? null });
      const rows = (this.chatList.get(chatId)?.messages ?? []).map((m, i) => this.row(m, i));
      if (range === undefined) return rows;
      return "tail" in range ? rows.slice(-range.tail) : rows.slice(range.from, range.from + range.count);
    },
    setOwn: async (chatId: string, messageId: string, value: JsonValue): Promise<void> => {
      const message = this.chatList.get(chatId)?.messages.find((m) => m.id === messageId);
      if (message === undefined) throw new Error(`message ${messageId} not found`);
      message.own = clone(value);
      this.emit.touched(chatId);
    },
  };

  readonly lore = {
    book: async (bookId: string, userId: string): Promise<HostBook | null> => {
      const held = this.books.get(bookId);
      return held !== undefined && held.userId === userId ? clone(held.book) : null;
    },
    entries: async (bookId: string, _userId: string): Promise<HostBookEntry[]> => clone(this.books.get(bookId)?.entries ?? []),
    entry: async (entryId: string, _userId: string): Promise<HostBookEntry | null> => {
      for (const held of this.books.values()) {
        const entry = held.entries.find((e) => e.id === entryId);
        if (entry !== undefined) return clone(entry);
      }
      return null;
    },
    global: async (_userId: string): Promise<string[]> => [...this.globalBooks],
    ofCharacter: async (_characterId: string, _userId: string): Promise<string[]> => [],
    ofPersona: async (_personaId: string | null, _userId: string): Promise<string | null> => null,
  };

  readonly presets = {
    blocks: async (presetId: string, _userId: string): Promise<HostPresetBlock[] | null> => clone(this.presetList.get(presetId) ?? null),
    active: async (chatId: string, _userId: string): Promise<{ presetId: string | null; states: Record<string, boolean> } | null> => clone(this.activePresets.get(chatId) ?? null),
  };

  // ---------------------------------------------------------------- what the tests set up

  addChat(userId: string, name: string, id = `chat-${this.nextId++}`): FakeChat {
    const chat: FakeChat = { id, userId, name, characterId: null, metadata: {}, messages: [] };
    this.chatList.set(id, chat);
    return chat;
  }

  /** Adds a message to the end of a chat. */
  say(chatId: string, role: ChatRole, text: string, name = role === "user" ? "Mara" : "Joss"): FakeMessage {
    const chat = this.chatList.get(chatId);
    if (chat === undefined) throw new Error(`no chat ${chatId}`);
    const message: FakeMessage = { id: `m${this.nextId++}`, role, name, swipes: [text], swipeId: 0, own: null };
    chat.messages.push(message);
    this.emit.touched(chatId);
    return message;
  }

  message(chatId: string, messageId: string): FakeMessage {
    const message = this.chatList.get(chatId)?.messages.find((m) => m.id === messageId);
    if (message === undefined) throw new Error(`no message ${messageId} in ${chatId}`);
    return message;
  }

  addConnection(connection: Partial<HostConnection> & { id: string }): HostConnection {
    const made: HostConnection = { name: connection.id, provider: "openai", url: "https://models.example/v1", model: "model-a", isDefault: false, metadata: {}, ...connection };
    this.connectionList.push(made);
    return made;
  }

  /** The text of a file in a user's storage, parsed; null when there is none. */
  stored(userId: string, path: string): unknown {
    const text = this.files.get(`${userId}/${path}`);
    return text === undefined ? null : JSON.parse(text);
  }
}
