// An in-memory Lumiverse for the extension backend's tests: everything `BackendHost` asks of Spindle,
// kept in maps, with hooks to fire Lumiverse's events by hand, and the script a test's models answer
// from (the runtime's own model layer calls them: models.ts). Nothing here is LumiAH's: it stands
// where Lumiverse and the providers stand. All names and texts are made up.
//
// One host is one extension's view of that Lumiverse. A test of two extensions installed together
// makes the second host beside the first: both see the same chats, messages and connections and
// are told of the same generations, and each keeps its own identifier, storage, permissions,
// sessions and entry on a message, as Lumiverse keeps them apart.

import type { Message } from "@earendil-works/pi-ai";
import type { ChatRole, JsonObject, JsonValue, ModelRequest, ModelToolCall } from "../../src/core/ports";
import type { DatabankDocument, EmbedderInfo, MemoryArc, MemoryEntity, MemoryEntityBrief, MemoryHit, WebResult } from "../../src/core/recall/ports";
import type { BackendHost, CorsReply, GenerationEnded, GenerationStarted, GenerationStopped, HostBook, HostBookEntry, HostBookRecord, HostChat, HostConnection, HostDatabank, HostEntryRecord, HostGenerationType, HostLogLevel, HostMcpServer, HostMcpTool, HostMessage, HostPresetBlock, InterceptorInput, InterceptorVerdict, SwipeChanged } from "../../src/extension/backend/spindle";
import type { PassedRequest } from "../../src/runtime/openai";
import { isRecord } from "../../src/link/json";
import { RowWatch } from "./rows";

/** A made-up MCP server: what it offers, whether it connects, and what answers a call of each tool. */
export interface FakeMcpServer {
  server: HostMcpServer;
  tools: HostMcpTool[];
  /** Why it can't be connected; absent: it connects. */
  down?: string;
  run(tool: string, args: JsonObject): string | Promise<string>;
}

/** A made-up world book entry: what `HostBookEntry` has, and whatever more of it a test sets; the rest reads as Lumiverse's own defaults for a new entry. */
export type FakeEntry = HostBookEntry & Partial<Omit<HostEntryRecord, keyof HostBookEntry>>;

/** A made-up world book: whose it is, its entries in the book's order and, where a test sets them, what its makers keep on it and when it last changed (in milliseconds; Lumiverse keeps it to the second). */
export interface FakeBook {
  book: HostBook;
  userId: string;
  entries: FakeEntry[];
  metadata?: JsonObject;
  updatedAt?: number;
}

/** A made-up embedding connection of a user's. An extension embeds on the main one alone. */
export interface FakeEmbedder {
  userId: string;
  connection: EmbedderInfo;
  main: boolean;
  enabled: boolean;
}

/** What the Memory Cortex holds of a chat, made up: what a query may find (the fake gives the best scored first), its entities and its arcs. */
export interface FakeCortex {
  hits: MemoryHit[];
  entities: MemoryEntity[];
  arcs: MemoryArc[];
}

/** A made-up databank: whose it is, and the rest as Lumiverse keeps it (how many documents it holds is counted). */
export interface FakeDatabank extends Omit<HostDatabank, "documents"> {
  userId: string;
}

/** A made-up document of a databank: whose it is, and its text, which can be read once Lumiverse has read it in (`ready`). */
export interface FakeDocument extends DatabankDocument {
  userId: string;
  text: string;
}

/** A user's web search as set up in Lumiverse, made up: whether it is on, the most results a search gives and the most pages it reads, what every search finds (a result's `page` is its page's text), and the words it fails with when it does. */
export interface FakeWebSearch {
  enabled: boolean;
  maxResults: number;
  maxPages: number;
  results: (Omit<WebResult, "content"> & { page?: string })[];
  fails?: string;
}

export interface FakeMessage {
  id: string;
  role: ChatRole;
  name: string;
  swipes: string[];
  swipeId: number;
  /** What each extension keeps on it, by the extension's identifier (Lumiverse's `extra.spindle_metadata`). */
  metadata: Record<string, JsonValue>;
  /** The entry of the extension this Lumiverse was made with first: LumiAH's, where it is the only one. */
  readonly own: JsonValue | null;
  /** When it was sent, by the fake's clock, in milliseconds; null: Lumiverse has no time for it. */
  at: number | null;
}

export interface FakeChat {
  id: string;
  userId: string;
  name: string;
  characterId: string | null;
  metadata: JsonObject;
  messages: FakeMessage[];
}

/**
 * One scripted answer: its text alone, or its parts; `error` fails the call with those words; `hang`
 * never answers until the call's signal ends it. `waits`: what its stream waits on as it goes, the
 * first after its reasoning, the next after each piece of its text, so a test sees each piece arrive
 * while the call is still under way.
 */
export type Answer = string | { content?: string; toolCalls?: ModelToolCall[]; reasoning?: string; finishReason?: string; usage?: JsonObject; error?: string; hang?: true; deltas?: string[]; waits?: Promise<void>[] };

/** A model call as the runtime's model layer was asked it: an agent's (`call`), or a request passed through (`pass`) with the connection the writer names (null: none). */
export type MadeCall = { kind: "call"; userId: string; request: ModelRequest } | { kind: "pass"; userId: string; request: PassedRequest & { connectionId: string | null } };

/** What a provider was sent for a call: who it went to, the model, the key it was signed with, how it was asked to reason, cache and answer, and the messages as pi-ai handed them on (the system prompt and the tools among them). */
export interface ProviderCall {
  provider: string;
  model: string;
  api: string;
  /** The key the call carried; null: none (a sign-in, or a server that takes none). */
  key: string | null;
  reasoning: string | null;
  sessionId: string | null;
  cacheRetention: string | null;
  maxTokens: number | null;
  messages: Message[];
}

export const toolCall = (name: string, args: JsonObject, callId = `call_${name}`): ModelToolCall => ({ name, args, callId });

const clone = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;

/** An entry as `HostBookEntry` has it, without what a test set beside. */
function plain(e: FakeEntry): HostBookEntry {
  return clone({ id: e.id, bookId: e.bookId, title: e.title, keys: e.keys, secondaryKeys: e.secondaryKeys, content: e.content, enabled: e.enabled, constant: e.constant });
}

/** What every extension installed in one Lumiverse sees alike: the users' chats with their messages, their connections, and each other, since what happens to a chat is told to all of them. */
class Shared {
  readonly hosts: FakeHost[] = [];
  /** Lumiverse's rows as its database keeps them, watched: every change to a chat, a message or a world book is told to every extension as the event Lumiverse sends for it (rows.ts). */
  readonly rows = new RowWatch({
    event: (name, payload, userId) => {
      for (const host of this.hosts) host.emit.lumiverse(name, payload, userId);
    },
    touched: (chatId, gone, userId) => {
      for (const host of this.hosts) host.emit.touched(chatId, gone, userId);
    },
  });
  readonly chats = this.rows.chats;
  connections: HostConnection[] = [];
  /** The connection each user has selected (Lumiverse's active profile), by user. */
  readonly selected = new Map<string, string>();
  nextId = 1;
}

export class FakeHost implements BackendHost {
  readonly logs: { level: HostLogLevel; message: string }[] = [];
  readonly permissions = new Set(["generation", "interceptor", "generation_parameters", "chats", "chat_mutation", "world_books", "presets", "characters", "personas"]);
  readonly capabilities = new Set(["chat-lean-messages-v1", "frontend-session-routing-v1", "required-interceptors-v1", "connection-organization-v1", "embeddings-v1"]);
  readonly install: { bun: string; dir: string };
  /** The identifier of the extension the backend runs in: LumiAH's own unless a test mounts LumiAH in another. */
  identifier: string;
  /** How long this Lumiverse waits for the extension's interceptor: five minutes, as LumiAH's manifest asks; a test of the deadline sets its own. */
  interceptorMs = 300_000;
  private readonly shared: Shared;

  readonly chatList: Map<string, FakeChat>;
  /** The characters' names, by id. */
  readonly characters = new Map<string, string>();
  readonly files = new Map<string, string>();
  /** This extension's view of the users' world books, watched as the chats are. */
  readonly books: Map<string, FakeBook>;
  globalBooks: string[] = [];
  /** The world books attached to each character, by character, and the one attached to the user's persona. */
  readonly characterBooks = new Map<string, string[]>();
  personaBook: string | null = null;
  readonly presetList = new Map<string, HostPresetBlock[]>();
  /** A chat's preset binding, by chat. */
  readonly activePresets = new Map<string, { presetId: string | null; states: Record<string, boolean> }>();

  /** Every model call the runtime's model layer was asked, in order, and what answers them. */
  readonly calls: MadeCall[] = [];
  /** What each provider was sent, in the order the calls reached them. */
  readonly providerCalls: ProviderCall[] = [];
  /** The agent sessions the core said ended, whose prompt cache the layer let go. */
  readonly endedSessions: string[] = [];
  /** How many calls under way were ended by their signal (a cancel, a stop). */
  cancelled = 0;
  script: Answer[] | ((call: MadeCall, n: number) => Answer | Promise<Answer>) = [];
  /** Every read of a chat's messages: the chat and the range asked for (null: the whole chat). */
  readonly reads: { chatId: string; range: { from: number; count: number } | { tail: number } | null }[] = [];
  /** Everything sent to a page or a runtime. */
  readonly sent: { message: unknown; userId: string; session: string | undefined }[] = [];
  /** Every toast shown, by whom it was shown to. */
  readonly toasts: { userId: string; level: "info" | "warning" | "error"; text: string }[] = [];
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
    touched: [] as ((chatId: string, gone: boolean, userId: string | null) => void)[],
    forked: [] as ((fork: { sourceChatId: string; chatId: string; userId: string | null }) => void)[],
    selected: [] as ((userId: string | null) => void)[],
    permission: [] as ((permission: string, granted: boolean) => void)[],
    lumiverse: [] as { names: readonly string[]; handler: (name: string, payload: unknown, userId: string | null) => void }[],
  };

  /** `beside`: the host of another extension installed in the same Lumiverse, whose chats, messages, connections and generations this one shares. */
  constructor(identifier = "lumi_ah", beside?: FakeHost) {
    this.shared = beside?.shared ?? new Shared();
    this.shared.hosts.push(this);
    this.identifier = identifier;
    this.install = { bun: "/opt/bun/bin/bun", dir: `/srv/lumiverse/extensions/${identifier}/dist` };
    this.chatList = this.shared.chats;
    this.books = this.shared.rows.books();
  }

  /** The extensions installed in this Lumiverse, this one among them, in the order they were installed. */
  get extensions(): readonly FakeHost[] {
    return this.shared.hosts;
  }

  /** The users' connections, the same for every extension. */
  get connectionList(): HostConnection[] {
    return this.shared.connections;
  }

  set connectionList(list: HostConnection[]) {
    this.shared.connections = list;
  }

  log = (level: HostLogLevel, message: string): void => void this.logs.push({ level, message });
  toast = (userId: string, level: "info" | "warning" | "error", text: string): void => void this.toasts.push({ userId, level, text });
  /** The users whose drawer was closed at the extension's word, in order. */
  readonly drawersClosed: string[] = [];
  closeDrawer = async (userId: string): Promise<boolean> => {
    this.drawersClosed.push(userId);
    return true;
  };
  granted = (permission: string): boolean => this.permissions.has(permission);
  onPermission = (handler: (permission: string, granted: boolean) => void): void => void this.on.permission.push(handler);
  /** An owner grants a permission, or takes it away, while the extension runs: Lumiverse tells the worker at once. */
  grant(permission: string, granted: boolean): void {
    if (granted) this.permissions.add(permission);
    else this.permissions.delete(permission);
    for (const handler of this.on.permission) handler(permission, granted);
  }

  /** What Lumiverse's proxy reaches (`spindle.cors`), by origin (`http://127.0.0.1:7871`): each a handler as Bun.serve runs one. An origin none serves is an address nothing answers on. */
  readonly servers = new Map<string, (request: Request) => Promise<Response>>();
  /** How long the proxy waits for an answer: Lumiverse's 30 seconds, unless a test of the wait sets its own. */
  corsMs = 30_000;
  /** Every request that went through the proxy: its address, its headers and its body, as they left. */
  readonly corsed: { url: string; headers: Record<string, string>; body: string }[] = [];
  /**
   * Lumiverse's proxy as an extension sees it: refused without `cors_proxy`, a path ending in `.js`
   * refused, its own User-Agent and the Host the address names added, no Origin, the answer read
   * whole within `corsMs` and refused past 25 MiB.
   */
  cors = async (url: string, init: { method: "POST"; headers: Record<string, string>; body: string }): Promise<CorsReply> => {
    if (!this.permissions.has("cors_proxy")) throw new Error("PERMISSION_DENIED: cors_proxy — CORS proxy permission not granted");
    const target = new URL(url);
    if (/\.(js|mjs|cjs|es)$/i.test(target.pathname)) throw new Error("JavaScript downloads are blocked: URL path identifies a JavaScript file");
    const headers: Record<string, string> = { ...init.headers, "User-Agent": "Lumiverse/test", Host: target.host };
    this.corsed.push({ url, headers: { ...headers }, body: init.body });
    const server = this.servers.get(target.origin);
    if (server === undefined) throw new Error("Unable to connect. Is the computer able to access the url?");
    const { promise: late, reject } = Promise.withResolvers<never>();
    const timer = setTimeout(() => reject(new Error(`Request timed out after ${this.corsMs}ms`)), this.corsMs);
    try {
      const response = await Promise.race([server(new Request(url, { method: init.method, headers, body: init.body })), late]);
      const text = await Promise.race([response.text(), late]);
      if (text.length > 25 * 1024 * 1024) throw new Error("Response too large: more than 26214400 bytes");
      const answered: Record<string, string> = {};
      response.headers.forEach((value, name) => {
        answered[name.toLowerCase()] = value;
      });
      return { status: response.status, headers: answered, body: text };
    } finally {
      clearTimeout(timer);
    }
  };
  capability = (name: string): boolean => this.capabilities.has(name);
  /** Each user's role in this Lumiverse; anyone not named is a `user`. */
  readonly roles = new Map<string, "operator" | "admin" | "user">();
  role = async (userId: string): Promise<"operator" | "admin" | "user"> => this.roles.get(userId) ?? "user";
  /** Lumiverse's database file as the extension's entry places it; none until a test says where. */
  databaseFile: string | null = null;
  database = (): string | null => this.databaseFile;

  readonly frontend = {
    send: (message: unknown, userId: string, session?: string): void => {
      // As on the wire: what can't be JSON doesn't cross.
      const wire = clone(message);
      this.sent.push({ message: wire, userId, session });
      const to = session !== undefined ? [this.outlets.get(session)] : [...this.outlets.values()].filter((o) => o.userId === userId);
      for (const outlet of to) if (outlet !== undefined && outlet.userId === userId) queueMicrotask(() => outlet.receive(wire));
    },
    // To every session of every user, as Lumiverse sends an operator's extension's message that names no user.
    everyone: (message: unknown): void => {
      const wire = clone(message);
      for (const outlet of [...this.outlets.values()]) {
        this.sent.push({ message: wire, userId: outlet.userId, session: undefined });
        queueMicrotask(() => outlet.receive(wire));
      }
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
    onChatTouched: (handler: (chatId: string, gone: boolean, userId: string | null) => void): void => void this.on.touched.push(handler),
    onChatForked: (handler: (fork: { sourceChatId: string; chatId: string; userId: string | null }) => void): void => void this.on.forked.push(handler),
    onSelectedConnection: (handler: (userId: string | null) => void): void => void this.on.selected.push(handler),
    onLumiverse: (names: readonly string[], handler: (name: string, payload: unknown, userId: string | null) => void): void => void this.on.lumiverse.push({ names, handler }),
  };

  /** Lumiverse's events, fired by hand. */
  readonly emit = {
    started: (event: GenerationStarted): void => this.on.started.forEach((h) => h(event)),
    /** `content` left out reads as Lumiverse not saying what the generation wrote. */
    ended: (event: Omit<GenerationEnded, "content"> & { content?: string | null }): void => this.on.ended.forEach((h) => h({ ...event, content: event.content ?? null })),
    stopped: (event: GenerationStopped): void => this.on.stopped.forEach((h) => h(event)),
    swipe: (event: SwipeChanged): void => this.on.swipe.forEach((h) => h(event)),
    chatChanged: (chatId: string, userId: string | null): void => this.on.chatChanged.forEach((h) => h(chatId, userId)),
    /** `gone`: Lumiverse deleted the chat, and says whose it was (`userId`). */
    touched: (chatId: string, gone = false, userId: string | null = null): void => this.on.touched.forEach((h) => h(chatId, gone, userId)),
    forked: (fork: { sourceChatId: string; chatId: string; userId: string | null }): void => this.on.forked.forEach((h) => h(fork)),
    selectedConnection: (userId: string | null): void => this.on.selected.forEach((h) => h(userId)),
    /** One of Lumiverse's own events by its name, with its payload as Lumiverse sends it, to those who hear that name. */
    lumiverse: (name: string, payload: unknown, userId: string | null): void => {
      for (const { names, handler } of this.on.lumiverse) if (names.includes(name)) handler(name, clone(payload), userId);
    },
  };

  /** Fires an event on every extension installed in this Lumiverse, this one among them: Lumiverse tells each of them what happens to a chat. */
  everywhere(fire: (emit: FakeHost["emit"]) => void): void {
    for (const host of this.shared.hosts) fire(host.emit);
  }

  registerInterceptor(handler: (input: InterceptorInput) => Promise<InterceptorVerdict>, options: { priority: number; types: readonly HostGenerationType[]; required: boolean }): void {
    this.interceptor = { handler, options };
  }

  /**
   * The extension's worker is restarted (an update, a reload, Lumiverse starting again): everything
   * a backend registered here is gone with it, and what Lumiverse and the user's storage hold stays.
   * A test then puts a new backend together over this host, as the new worker does.
   */
  reload(): void {
    this.interceptor = null;
    this.messageHandler = null;
    this.closedHandlers.length = 0;
    for (const handlers of Object.values(this.on)) handlers.length = 0;
  }

  readonly connections = {
    list: async (_userId: string): Promise<HostConnection[]> => clone(this.connectionList),
    get: async (connectionId: string, _userId: string): Promise<HostConnection | null> => clone(this.connectionList.find((c) => c.id === connectionId) ?? null),
    // What Lumiverse shows an extension of the selection: nothing, on a host from before `connection-organization-v1`.
    active: async (userId: string): Promise<string | null | undefined> => (this.capabilities.has("connection-organization-v1") ? this.selected(userId) : undefined),
    models: async (connectionId: string, _userId: string): Promise<string[] | null> => [`${connectionId}-model-a`, `${connectionId}-model-b`],
  };

  /** When each file was last written, by the fake's own clock (`now`), which a test may move. */
  readonly writtenAt = new Map<string, number>();
  now: () => number = () => Date.now();

  readonly storage = {
    read: async (path: string, userId: string): Promise<string | null> => this.files.get(`${userId}/${path}`) ?? null,
    write: async (path: string, text: string, userId: string): Promise<void> => {
      this.files.set(`${userId}/${path}`, text);
      this.writtenAt.set(`${userId}/${path}`, this.now());
    },
    remove: async (path: string, userId: string): Promise<void> => {
      this.files.delete(`${userId}/${path}`);
      this.writtenAt.delete(`${userId}/${path}`);
    },
    stat: async (path: string, userId: string): Promise<{ bytes: number; writtenAt: number } | null> => {
      const text = this.files.get(`${userId}/${path}`);
      return text === undefined ? null : { bytes: new TextEncoder().encode(text).length, writtenAt: this.writtenAt.get(`${userId}/${path}`) ?? 0 };
    },
    list: async (dir: string, userId: string): Promise<string[]> => {
      const prefix = `${userId}/${dir.replace(/\/+$/, "")}/`;
      return [...this.files.keys()].filter((path) => path.startsWith(prefix)).map((path) => path.slice(prefix.length));
    },
  };

  private row(m: FakeMessage, index: number): HostMessage {
    return { id: m.id, index, role: m.role, name: m.name, swipeId: m.swipeId, swipes: m.swipes.length, content: m.swipes[m.swipeId] ?? "", hidden: false, own: clone(m.metadata[this.identifier] ?? null), at: m.at };
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
      this.everywhere((emit) => emit.chatChanged(chatId, userId));
    },
    messages: async (chatId: string, range?: { from: number; count: number } | { tail: number }): Promise<HostMessage[]> => {
      this.reads.push({ chatId, range: range ?? null });
      const rows = (this.chatList.get(chatId)?.messages ?? []).map((m, i) => this.row(m, i));
      if (range === undefined) return rows;
      return "tail" in range ? rows.slice(-range.tail) : rows.slice(range.from, range.from + range.count);
    },
    swipe: async (chatId: string, messageId: string, swipe: number): Promise<string | null> => this.chatList.get(chatId)?.messages.find((m) => m.id === messageId)?.swipes[swipe] ?? null,
    setOwn: async (chatId: string, messageId: string, value: JsonValue): Promise<void> => {
      const message = this.chatList.get(chatId)?.messages.find((m) => m.id === messageId);
      if (message === undefined) throw new Error(`message ${messageId} not found`);
      // Its own entry, whatever the others keep there: Lumiverse lets an extension write no other's.
      if (value === null) delete message.metadata[this.identifier];
      else message.metadata[this.identifier] = clone(value);
      this.everywhere((emit) => emit.touched(chatId));
    },
    deleteMessage: async (chatId: string, messageId: string): Promise<void> => {
      const messages = this.chatList.get(chatId)?.messages ?? [];
      const at = messages.findIndex((m) => m.id === messageId);
      if (at < 0) throw new Error(`message ${messageId} not found`);
      messages.splice(at, 1);
      // Lumiverse tells every extension installed that the chat changed, whichever of them deleted the message.
      this.everywhere((emit) => emit.touched(chatId));
    },
    list: async (userId: string, offset: number, limit: number): Promise<{ chats: HostChat[]; total: number }> => {
      const mine = [...this.chatList.values()].filter((chat) => chat.userId === userId);
      return { chats: mine.slice(offset, offset + limit).map((chat) => ({ id: chat.id, name: chat.name, characterId: chat.characterId, metadata: clone(chat.metadata) })), total: mine.length };
    },
    characterName: async (characterId: string, _userId: string): Promise<string | null> => (this.permissions.has("characters") ? (this.characters.get(characterId) ?? null) : null),
    // As the Lumiverse there is now: it doesn't tell extensions whether Sovereign Hand is on.
    sovereignHand: async (_chatId: string, _userId: string): Promise<boolean | null> => null,
  };

  /** A book as held, when the permission to read world books is granted; a member without it answers that there is nothing, as Lumiverse's own does through the backend's host. */
  private held(bookId: string): FakeBook | undefined {
    return this.permissions.has("world_books") ? this.books.get(bookId) : undefined;
  }

  readonly lore = {
    book: async (bookId: string, userId: string): Promise<HostBook | null> => {
      const held = this.held(bookId);
      return held !== undefined && held.userId === userId ? clone(held.book) : null;
    },
    entries: async (bookId: string, _userId: string): Promise<HostBookEntry[]> => (this.held(bookId)?.entries ?? []).map(plain),
    entry: async (entryId: string, _userId: string): Promise<HostBookEntry | null> => {
      if (!this.permissions.has("world_books")) return null;
      for (const held of this.books.values()) {
        const entry = held.entries.find((e) => e.id === entryId);
        if (entry !== undefined) return plain(entry);
      }
      return null;
    },
    record: async (bookId: string, userId: string): Promise<HostBookRecord | null> => {
      const held = this.held(bookId);
      return held !== undefined && held.userId === userId ? clone({ ...held.book, metadata: held.metadata ?? {}, updatedAt: held.updatedAt ?? 0 }) : null;
    },
    records: async (bookId: string, userId: string): Promise<HostEntryRecord[]> => {
      const held = this.held(bookId);
      if (held === undefined || held.userId !== userId) return [];
      return held.entries.map((e) => clone({ vectorized: false, regex: false, role: null, order: 100, updatedAt: 0, extensions: {}, ...e }));
    },
    global: async (_userId: string): Promise<string[]> => (this.permissions.has("world_books") ? [...this.globalBooks] : []),
    ofCharacter: async (characterId: string, _userId: string): Promise<string[]> => (this.permissions.has("characters") ? [...(this.characterBooks.get(characterId) ?? [])] : []),
    ofPersona: async (_personaId: string | null, _userId: string): Promise<string | null> => (this.permissions.has("personas") ? this.personaBook : null),
  };

  readonly presets = {
    blocks: async (presetId: string, _userId: string): Promise<HostPresetBlock[] | null> => (this.permissions.has("presets") ? clone(this.presetList.get(presetId) ?? null) : null),
    active: async (chatId: string, _userId: string): Promise<{ presetId: string | null; states: Record<string, boolean> } | null> => (this.permissions.has("presets") ? clone(this.activePresets.get(chatId) ?? null) : null),
  };

  /** The user's MCP servers as Lumiverse holds them, and every call made of them. */
  readonly mcpServers: FakeMcpServer[] = [];
  readonly mcpCalls: { serverId: string; tool: string; args: JsonObject; timeoutMs: number; userId: string }[] = [];

  readonly mcp = {
    servers: async (_userId: string): Promise<HostMcpServer[]> => (this.permissions.has("mcp_servers") ? this.mcpServers.map((s) => clone(s.server)) : []),
    tools: async (serverId: string, _userId: string): Promise<HostMcpTool[]> => {
      const held = this.mcpServers.find((s) => s.server.id === serverId);
      if (held === undefined) throw new Error("MCP server not found");
      if (held.down !== undefined) throw new Error(held.down);
      return clone(held.tools);
    },
    call: async (serverId: string, tool: string, args: JsonObject, timeoutMs: number, userId: string): Promise<string> => {
      this.mcpCalls.push({ serverId, tool, args: clone(args), timeoutMs, userId });
      const held = this.mcpServers.find((s) => s.server.id === serverId);
      if (held === undefined || !held.server.enabled) throw new Error("MCP server not found or disabled");
      if (!held.tools.some((t) => t.name === tool)) throw new Error("MCP tool is not advertised by this server");
      return held.run(tool, args);
    },
  };

  // ---------------------------------------------------------------- what the lore and history tools read (DESIGN §24)
  //
  // Each rests on a permission a fake starts without (`embeddings`, `memories`, `databanks`,
  // `web_search`): a test grants it. Without it a member answers that there is nothing, as the
  // backend's host does over the real Lumiverse.

  /** The users' embedding connections as Lumiverse holds them, and every embed call made. */
  readonly embedders: FakeEmbedder[] = [];
  readonly embedCalls: { userId: string; texts: string[]; kind: "query" | "stored" }[] = [];
  /** How a text is embedded: a made-up vector, the same for the same text. A test of a provider that fails gives one that throws. */
  embedText: (text: string, kind: "query" | "stored") => number[] = (text, kind) => [text.length, [...text].reduce((sum, c) => (sum + c.charCodeAt(0)) % 997, 0), kind === "query" ? 1 : 0];

  /** Whether this Lumiverse embeds for the extension at all: it says so by a capability, and the permission is granted. */
  private get embeds(): boolean {
    return this.capabilities.has("embeddings-v1") && this.permissions.has("embeddings");
  }

  readonly embeddings = {
    connection: async (userId: string): Promise<EmbedderInfo | null> => {
      const main = this.embeds ? this.embedders.find((e) => e.userId === userId && e.main) : undefined;
      return main !== undefined && main.enabled ? clone(main.connection) : null;
    },
    embed: async (texts: readonly string[], kind: "query" | "stored", userId: string, signal?: AbortSignal): Promise<{ vectors: number[][]; model: string; dimensions: number }> => {
      if (!this.embeds) throw new Error('There is no embedding connection to use: this Lumiverse embeds nothing for an extension, or the "embeddings" permission isn\'t granted.');
      this.embedCalls.push({ userId, texts: [...texts], kind });
      signal?.throwIfAborted();
      // Lumiverse's own bounds on a call, refused in its own words.
      if (texts.length === 0) throw new Error("texts must be a non-empty array");
      if (texts.length > 256) throw new Error("At most 256 texts per request");
      if (texts.some((t) => t.trim() === "")) throw new Error("Each text must be a non-empty string");
      if (texts.some((t) => t.length > 8192)) throw new Error("Each text must be at most 8192 characters");
      const main = this.embedders.find((e) => e.userId === userId && e.main);
      if (main === undefined) throw new Error("Embedding connection not found");
      if (!main.enabled) throw new Error("Embedding connection is disabled");
      const vectors = texts.map((t) => this.embedText(t, kind));
      return { vectors, model: main.connection.model, dimensions: vectors[0]?.length ?? 0 };
    },
  };

  /** The users who have the Memory Cortex switched on, what it holds of each chat, and every query made of it. */
  readonly cortexOn = new Set<string>();
  readonly cortex = new Map<string, FakeCortex>();
  readonly cortexQueries: { userId: string; chatId: string; query: string; limit: number; entities: string[] }[] = [];

  /** What the Cortex holds of a chat of the user's. As Lumiverse does, it refuses a chat that isn't theirs. */
  private remembered(chatId: string, userId: string): FakeCortex {
    if (this.chatList.get(chatId)?.userId !== userId) throw new Error("Chat not found");
    return this.cortex.get(chatId) ?? { hits: [], entities: [], arcs: [] };
  }

  readonly memory = {
    enabled: async (userId: string): Promise<boolean> => this.permissions.has("memories") && this.cortexOn.has(userId),
    search: async (chatId: string, query: string, options: { limit: number; entities?: readonly string[] }, userId: string): Promise<MemoryHit[]> => {
      if (!this.permissions.has("memories")) return [];
      const held = this.remembered(chatId, userId);
      this.cortexQueries.push({ userId, chatId, query, limit: options.limit, entities: [...(options.entities ?? [])] });
      // Off for the user, or for the chat by its own metadata: Lumiverse answers nothing.
      const metadata = this.chatList.get(chatId)?.metadata ?? {};
      if (!this.cortexOn.has(userId) || metadata.temporary === true || (isRecord(metadata.cortex_settings) && metadata.cortex_settings.enabled === false)) return [];
      const named = options.entities ?? [];
      const found = held.hits.filter((hit) => named.length === 0 || hit.entities.some((name) => named.includes(name)));
      return clone(found.sort((a, b) => b.score - a.score).slice(0, Math.max(0, options.limit)));
    },
    entity: async (chatId: string, name: string, userId: string): Promise<MemoryEntity | null> => {
      if (!this.permissions.has("memories")) return null;
      const wanted = name.trim().toLowerCase();
      const found = this.remembered(chatId, userId).entities.find((e) => [e.name, ...e.aliases].some((known) => known.toLowerCase() === wanted));
      return found === undefined ? null : clone({ ...found, relations: [...found.relations].sort((a, b) => b.strength - a.strength) });
    },
    entities: async (chatId: string, limit: number, userId: string): Promise<MemoryEntityBrief[]> => {
      if (!this.permissions.has("memories")) return [];
      // As Lumiverse lists them: those still in the story, the most salient first (here, the most mentioned).
      const active = this.remembered(chatId, userId).entities.filter((e) => e.status === "active");
      return active
        .sort((a, b) => b.mentions - a.mentions)
        .slice(0, Math.max(0, limit))
        .map((e) => ({ name: e.name, type: e.type, mentions: e.mentions }));
    },
    arcs: async (chatId: string, userId: string): Promise<MemoryArc[]> => (this.permissions.has("memories") ? clone(this.remembered(chatId, userId).arcs) : []),
  };

  /** The users' databanks and their documents as Lumiverse holds them, and the databanks each character's card names, by character. */
  readonly databankList: FakeDatabank[] = [];
  readonly documentList: FakeDocument[] = [];
  readonly characterDatabanks = new Map<string, string[]>();

  readonly databanks = {
    list: async (userId: string): Promise<HostDatabank[]> => {
      if (!this.permissions.has("databanks")) return [];
      return this.databankList.filter((d) => d.userId === userId).map(({ userId: _owner, ...d }) => clone({ ...d, documents: this.documentList.filter((doc) => doc.databankId === d.id).length }));
    },
    ofCharacter: async (characterId: string, _userId: string): Promise<string[]> => (this.permissions.has("characters") ? [...(this.characterDatabanks.get(characterId) ?? [])] : []),
    documents: async (databankId: string, userId: string): Promise<DatabankDocument[]> => {
      if (!this.permissions.has("databanks")) return [];
      return this.documentList.filter((d) => d.databankId === databankId && d.userId === userId).map(({ userId: _owner, text: _text, ...d }) => clone(d));
    },
    content: async (documentId: string, userId: string): Promise<string | null> => {
      const found = this.permissions.has("databanks") ? this.documentList.find((d) => d.id === documentId && d.userId === userId) : undefined;
      // Lumiverse has a document's text only once it has read it in.
      return found !== undefined && found.status === "ready" ? found.text : null;
    },
  };

  /** Each user's web search as set up in Lumiverse, and every search made. */
  readonly webSearches = new Map<string, FakeWebSearch>();
  readonly webQueries: { userId: string; query: string; count: number; pages: boolean }[] = [];

  readonly web = {
    enabled: async (userId: string): Promise<boolean> => this.permissions.has("web_search") && this.webSearches.get(userId)?.enabled === true,
    search: async (query: string, options: { count: number; pages: boolean }, userId: string): Promise<WebResult[]> => {
      if (!this.permissions.has("web_search")) return [];
      this.webQueries.push({ userId, query, count: options.count, pages: options.pages });
      const set = this.webSearches.get(userId);
      // Lumiverse's own words for a user who has none switched on.
      if (set === undefined || !set.enabled) throw new Error("Web search is disabled");
      if (set.fails !== undefined) throw new Error(set.fails);
      // The user's own setting holds how many results a search gives, and how many of their pages are read.
      return set.results.slice(0, Math.max(0, Math.min(options.count, set.maxResults))).map(({ page, ...result }, i): WebResult => (options.pages && page !== undefined && i < set.maxPages ? { ...result, content: page } : { ...result }));
    },
  };

  // ---------------------------------------------------------------- what the tests set up

  /** A new chat of the user's, as the rows' view of it (every change made through it is told: rows.ts). */
  addChat(userId: string, name: string, id = `chat-${this.shared.nextId++}`): FakeChat {
    this.chatList.set(id, { id, userId, name, characterId: null, metadata: {}, messages: [] });
    return this.chatList.get(id) as FakeChat;
  }

  /** Adds a message to the end of a chat. */
  say(chatId: string, role: ChatRole, text: string, name = role === "user" ? "Mara" : "Joss"): FakeMessage {
    const chat = this.chatList.get(chatId);
    if (chat === undefined) throw new Error(`no chat ${chatId}`);
    const { hosts } = this.shared;
    const metadata: Record<string, JsonValue> = {};
    const message: FakeMessage = {
      id: `m${this.shared.nextId++}`,
      role,
      name,
      swipes: [text],
      swipeId: 0,
      metadata,
      at: this.now(),
      get own() {
        return metadata[hosts[0]?.identifier ?? ""] ?? null;
      },
    };
    chat.messages.push(message);
    this.everywhere((emit) => emit.touched(chatId));
    // The rows' view of it, through which a change is told.
    return this.message(chatId, message.id);
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

  /** The user selects a connection in Lumiverse (null: none), and every extension installed hears that the selection changed. */
  select(userId: string, connectionId: string | null): void {
    if (connectionId === null) this.shared.selected.delete(userId);
    else this.shared.selected.set(userId, connectionId);
    this.everywhere((emit) => emit.selectedConnection(userId));
  }

  /** The connection the user has selected, as Lumiverse itself holds it: only one that is still there. */
  selected(userId: string): string | null {
    const id = this.shared.selected.get(userId);
    return id !== undefined && this.connectionList.some((c) => c.id === id) ? id : null;
  }

  /** The rows Lumiverse's database holds, as its HTTP routes and its file give them (rows.ts). */
  get rows(): RowWatch {
    return this.shared.rows;
  }

  /** Changes Lumiverse makes and tells of by no event: what `change` does to the rows is told to no extension. */
  quietly<T>(change: () => T): T {
    return this.shared.rows.quietly(change);
  }

  /** The text of a file in a user's storage, parsed; null when there is none. */
  stored(userId: string, path: string): unknown {
    const text = this.files.get(`${userId}/${path}`);
    return text === undefined ? null : JSON.parse(text);
  }
}
