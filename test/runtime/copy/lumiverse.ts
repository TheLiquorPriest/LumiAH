// A made-up Lumiverse for the tests of the runtime's copy of chat and lore: its rows as its database
// keeps them; the shapes it sends them in (its HTTP routes' pages, its events' payloads, Spindle's
// `chat.getMessages` and world book calls); and the changes it makes, each with the event Lumiverse
// sends for it, or none where Lumiverse sends none. The mappers follow Lumiverse's own
// (`rowToMessage` and its lean form, `rowToChat`, `rowToBook`, `rowToEntry`, the Spindle reshape and
// DTOs), and so do the pages' counts and the world books' ETags: the tests that one row comes out the
// same through every shape rest on them. Every chat, book, name and text here is invented.

import type { LumiverseEvent } from "../../../src/runtime/copy";
import type { SessionFetch } from "../../../src/runtime/copy/http";

type Obj = Record<string, unknown>;

export interface MessageRow {
  id: string;
  chat_id: string;
  index_in_chat: number;
  is_user: 0 | 1;
  name: string;
  content: string;
  send_date: number;
  swipe_id: number;
  swipes: string;
  extra: string;
  parent_message_id: string | null;
  branch_id: string | null;
  created_at: number;
  swipe_dates: string;
  revision: number;
}

export interface ChatRow {
  id: string;
  user_id: string;
  character_id: string | null;
  name: string;
  metadata: Obj;
  created_at: number;
  updated_at: number;
}

export interface BookRow {
  id: string;
  user_id: string;
  name: string;
  description: string;
  folder: string;
  metadata: string;
  created_at: number;
  updated_at: number;
}

export interface EntryRow {
  id: string;
  world_book_id: string;
  uid: string;
  key: string;
  keysecondary: string;
  content: string;
  comment: string;
  role: string | null;
  order_value: number;
  constant: 0 | 1;
  disabled: 0 | 1;
  use_regex: 0 | 1;
  vectorized: 0 | 1;
  vector_index_status: string;
  extensions: string;
  revision: number;
  folder: string;
  tags: string;
  created_at: number;
  updated_at: number;
}

/** The per-swipe arrays Lumiverse keeps in a message's extra, and the key it projects the shown swipe's value to. */
const PER_SWIPE: Readonly<Record<string, string>> = {
  reasoningBySwipe: "reasoning",
  reasoningDurationBySwipe: "reasoningDuration",
  tokenCountBySwipe: "tokenCount",
  generationMetricsBySwipe: "generationMetrics",
  generationOutcomeBySwipe: "generationOutcome",
  usageBySwipe: "usage",
  reasoningCarrierBySwipe: "reasoningCarrier",
  promptActivationBySwipe: "promptActivation",
};
const SWIPE_ARRAYS = [...Object.keys(PER_SWIPE), "variableStateBySwipe"];

const parse = (text: string, otherwise: unknown): unknown => {
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return otherwise;
  }
};
const isObj = (v: unknown): v is Obj => typeof v === "object" && v !== null && !Array.isArray(v);
/** Two ids in the order SQLite sorts text by default (`BINARY`: their bytes in UTF-8), as Lumiverse's `ORDER BY ..., id` lists them. */
const byBytes = (a: string, b: string): number => Buffer.compare(Buffer.from(a, "utf8"), Buffer.from(b, "utf8"));

/** What a message's `swipes` parses to: a list nearly always, but whatever the JSON holds, as Lumiverse keeps it (a row stored as JSON text gives a string). */
type Swipes = { length: number } & Record<number, unknown>;

/** Lumiverse's `rowToMessage`: the row, its JSON parsed, its extra projected for the shown swipe. */
export function rowToMessage(row: MessageRow): Obj {
  const swipes = parse(row.swipes, [row.content ?? ""]) as Swipes;
  // Lumiverse sizes the per-swipe extras by the count before anything else, so a row whose swipes are JSON `null` fails here, as it fails there.
  const count = swipes.length;
  const extra = { ...((parse(row.extra, {}) as Obj | null) ?? {}) };
  const bag = extra.spindle_metadata;
  // Saved preset contexts are kept one per swipe (`normalizeSpindleMessageMetadata`).
  if (isObj(bag) && Array.isArray(bag.preset_contexts)) {
    const contexts = bag.preset_contexts as unknown[];
    extra.spindle_metadata = { ...bag, preset_contexts: Array.from({ length: Math.max(1, count) }, (_, i) => contexts[i] ?? null) };
  }
  for (const [array, key] of Object.entries(PER_SWIPE)) {
    const value = Array.isArray(extra[array]) ? (extra[array] as unknown[])[row.swipe_id] : null;
    if (value !== null && value !== undefined) extra[key] = value;
    else delete extra[key];
  }
  return { ...row, is_user: !!row.is_user, swipes, swipe_dates: parse(row.swipe_dates || "[]", []), extra, parent_message_id: row.parent_message_id || null, branch_id: row.branch_id || null };
}

/** Lumiverse's `rowToMessageLight`: as many slots as the swipes have, null but the shown one, the per-swipe arrays gone. Swipes stored as JSON text become a list of that many slots, the shown one holding one letter. */
export function rowToMessageLight(row: MessageRow): Obj {
  const message = rowToMessage(row);
  const swipes = message.swipes as Swipes;
  if (swipes.length > 1) {
    const shown = row.swipe_id >= 0 && row.swipe_id < swipes.length ? row.swipe_id : 0;
    const light: unknown[] = new Array(swipes.length).fill(null);
    light[shown] = swipes[shown] ?? null;
    message.swipes = light;
  }
  const extra = message.extra as Obj;
  for (const key of SWIPE_ARRAYS) delete extra[key];
  return message;
}

/** Spindle's `chat.getMessages` reshape (`handleChatGetMessages`) of a message Lumiverse read. */
export function spindleMessage(m: Obj, options: { includeExtra: boolean; ownKey?: string }): Obj {
  const rawExtra = (m.extra || {}) as Obj;
  const role = m.is_user ? "user" : rawExtra.spindle_role === "system" ? "system" : "assistant";
  const { spindle_metadata, ...extra } = rawExtra;
  let metadata = typeof spindle_metadata === "object" && spindle_metadata ? (spindle_metadata as Obj) : undefined;
  if (options.ownKey !== undefined) metadata = metadata && Object.hasOwn(metadata, options.ownKey) ? { [options.ownKey]: metadata[options.ownKey] } : undefined;
  return {
    id: m.id,
    chat_id: m.chat_id,
    index_in_chat: m.index_in_chat,
    is_user: m.is_user,
    name: m.name,
    role,
    content: m.content,
    send_date: m.send_date,
    ...(options.includeExtra ? { extra } : {}),
    hidden: rawExtra.hidden === true,
    metadata,
    swipe_id: typeof m.swipe_id === "number" && Number.isFinite(m.swipe_id) ? m.swipe_id : 0,
    swipes: Array.isArray(m.swipes) ? m.swipes.slice() : [],
    swipe_dates: Array.isArray(m.swipe_dates) ? [...(m.swipe_dates as unknown[])] : [],
    parent_message_id: m.parent_message_id,
    branch_id: m.branch_id,
    created_at: m.created_at,
  };
}

/** Lumiverse's `rowToChat`. */
export const rowToChat = (row: ChatRow): Obj => ({ ...row, metadata: { ...row.metadata } });

/** Lumiverse's `rowToBook`. */
export const rowToBook = (row: BookRow): Obj => ({ id: row.id, name: row.name, description: row.description, folder: row.folder ?? "", metadata: JSON.parse(row.metadata) as unknown, created_at: row.created_at, updated_at: row.updated_at });

/** The prompt markers an entry may be pinned beside (Lumiverse's `VALID_WI_MARKERS`): any other names none. */
const WI_MARKERS: Record<string, true> = { chat_history: true, world_info_before: true, world_info_after: true, char_description: true, char_personality: true, persona_description: true, scenario: true, dialogue_examples: true, main_prompt: true, enhance_definitions: true, jailbreak: true, nsfw_prompt: true };

/** A string trimmed, or null for anything else and for an empty one. */
const trimmed = (value: unknown): string | null => (typeof value === "string" && value.trim() !== "" ? value.trim() : null);

/** Lumiverse's `rowToEntry`: JSON parsed, flags as booleans, and the keys it manages itself taken out of `extensions` under either of their spellings (`splitManagedEntryExtensions`). */
export function rowToEntry(row: EntryRow): Obj {
  const stored = JSON.parse(row.extensions) as unknown;
  const extensions = (stored === null || typeof stored !== "object" ? {} : JSON.parse(JSON.stringify(stored))) as Obj;
  const outlet = trimmed(extensions.outlet_name ?? extensions.outletName);
  const marker = trimmed(extensions.wi_marker ?? extensions.wiMarker)?.toLowerCase() ?? null;
  const side = trimmed(extensions.wi_marker_side ?? extensions.wiMarkerSide)?.toLowerCase() ?? null;
  for (const key of ["outlet_name", "outletName", "wi_marker", "wiMarker", "wi_marker_side", "wiMarkerSide"]) delete extensions[key];
  const tags = parse(row.tags, []);
  return {
    ...row,
    folder: row.folder.trim(),
    tags: Array.isArray(tags) ? [...new Set(tags.map(trimmed).filter((tag): tag is string => tag !== null))] : [],
    outlet_name: outlet,
    wi_marker: marker !== null && WI_MARKERS[marker] === true ? marker : null,
    wi_marker_side: side === "before" || side === "after" ? side : null,
    key: JSON.parse(row.key) as unknown,
    keysecondary: JSON.parse(row.keysecondary) as unknown,
    role: row.role || null,
    constant: !!row.constant,
    disabled: !!row.disabled,
    use_regex: !!row.use_regex,
    vectorized: !!row.vectorized,
    extensions,
  };
}

/** Spindle's `toWorldBookEntryDTO`, of an entry Lumiverse read. */
function spindleEntry(e: Obj): Obj {
  return {
    id: e.id,
    world_book_id: e.world_book_id,
    uid: e.uid || "",
    key: Array.isArray(e.key) ? e.key : [],
    keysecondary: Array.isArray(e.keysecondary) ? e.keysecondary : [],
    content: e.content || "",
    comment: e.comment || "",
    role: e.role || null,
    order_value: e.order_value ?? 100,
    constant: !!e.constant,
    disabled: !!e.disabled,
    use_regex: !!e.use_regex,
    vectorized: !!e.vectorized,
    extensions: typeof e.extensions === "object" && e.extensions ? e.extensions : {},
    revision: e.revision,
    created_at: e.created_at,
    updated_at: e.updated_at,
  };
}

/** A page as Lumiverse's `paginatedQuery` gives one, of rows mapped as they are listed: `limit` held between 1 and 1000, and every row counted. */
function page<R>(rows: readonly R[], map: (row: R) => Obj, url: URL): { data: Obj[]; total: number; limit: number; offset: number } {
  const asked = Number.parseInt(url.searchParams.get("limit") ?? "50", 10);
  const limit = Number.isNaN(asked) ? 50 : Math.min(Math.max(asked, 1), 1000);
  const offset = Math.max(0, Number.parseInt(url.searchParams.get("offset") ?? "0", 10) || 0);
  return { data: rows.slice(offset, offset + limit).map(map), total: rows.length, limit, offset };
}

const json = (body: unknown, status = 200, headers: Record<string, string> = {}): Response => new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json", ...headers } });

export interface SayOptions {
  user?: boolean;
  name?: string;
  swipes?: string[];
  swipeId?: number;
  extra?: Obj;
  /** When it was sent, as Lumiverse keeps it (seconds, or milliseconds on some rows); Lumiverse's clock when not given. */
  sentAt?: number;
}

export class Lumiverse {
  readonly chats = new Map<string, ChatRow>();
  readonly messages = new Map<string, MessageRow>();
  readonly books = new Map<string, BookRow>();
  readonly entries = new Map<string, EntryRow>();
  /** Every event Lumiverse sent, in order: a test forwards them to the copy, or loses some on purpose. */
  readonly emitted: LumiverseEvent[] = [];
  /** Every path asked for over HTTP, in order. */
  readonly asked: string[] = [];
  /** The most HTTP requests that were under way at once. */
  mostAtOnce = 0;
  /** Lumiverse's clock, in seconds, as it stamps its rows. */
  now = Date.UTC(2026, 10, 12, 9, 0, 0) / 1000;
  /** Moves with every change Lumiverse makes, told of or not, as a database's own change counter does. */
  version = 0;
  /** The paths of the requests the asker gave up on (their signal aborted them), in order. */
  readonly aborted: string[] = [];
  private atOnce = 0;
  private n = 0;
  private readonly failing: { match: RegExp; left: number; how: number | "network" }[] = [];
  private readonly hanging: { match: RegExp; left: number }[] = [];
  private readonly before: { match: RegExp; run: () => void }[] = [];

  private id(kind: string): string {
    return `${kind}-${++this.n}`;
  }

  private emit(name: string, payload: Obj, userId: string): void {
    this.version++;
    this.emitted.push({ name, payload, userId });
  }

  // ---------------------------------------------------------------- scripting HTTP

  /** The next `times` requests whose path matches fail: with a status, or as an unreachable server. */
  fail(match: RegExp, times: number, how: number | "network"): void {
    this.failing.push({ match, left: times, how });
  }

  /** The next `times` requests whose path matches never answer: only the asker's giving up on them (their signal) ends them. */
  hang(match: RegExp, times = 1): void {
    this.hanging.push({ match, left: times });
  }

  /** Runs once, just before the first request whose path matches is answered: a change made while a read is under way. */
  whileAsked(match: RegExp, run: () => void): void {
    this.before.push({ match, run });
  }

  /** HTTP as the user's session reaches Lumiverse. */
  session(userId: string): SessionFetch {
    return async (path, init) => {
      this.asked.push(path);
      this.atOnce++;
      this.mostAtOnce = Math.max(this.mostAtOnce, this.atOnce);
      try {
        // Every request takes a moment, so the ones sent together are under way together.
        await Bun.sleep(1);
        const hang = this.hanging.find((h) => h.left > 0 && h.match.test(path));
        if (hang !== undefined) {
          hang.left--;
          const { promise, reject } = Promise.withResolvers<never>();
          const gaveUp = (): void => {
            this.aborted.push(path);
            reject(new DOMException("The operation was aborted.", "AbortError"));
          };
          init.signal?.addEventListener("abort", gaveUp, { once: true });
          await promise;
        }
        const failure = this.failing.find((f) => f.left > 0 && f.match.test(path));
        if (failure !== undefined) {
          failure.left--;
          if (failure.how === "network") throw new TypeError("fetch failed: connection refused");
          return json({ error: "Internal error" }, failure.how);
        }
        const hook = this.before.findIndex((b) => b.match.test(path));
        if (hook >= 0) this.before.splice(hook, 1)[0]?.run();
        try {
          return this.route(userId, path, init.headers);
        } catch {
          // A row Lumiverse's own mapper fails on fails the whole route, as an error its server answers 500 for.
          return json({ error: "Internal Server Error" }, 500);
        }
      } finally {
        this.atOnce--;
      }
    };
  }

  private route(userId: string, path: string, headers: Record<string, string>): Response {
    const url = new URL(path, "http://lumiverse.test");
    const parts = url.pathname.split("/").filter((p) => p !== "").map(decodeURIComponent);
    if (url.pathname === "/api/auth/get-session") return json({ session: { userId, expiresAt: "2026-11-19T09:00:00.000Z" }, user: { id: userId, username: "mara" } });
    if (parts[0] !== "api" || parts[1] !== "v1") return json({ error: "Not found" }, 404);
    if (parts[2] === "chats" && parts[3] !== undefined) {
      const chat = this.chats.get(parts[3]);
      if (chat === undefined || chat.user_id !== userId) return json({ error: "Chat not found" }, 404);
      if (parts.length === 4) return json(rowToChat(chat));
      if (parts[4] === "messages" && parts.length === 5) {
        const map = url.searchParams.get("full") === "true" ? rowToMessage : rowToMessageLight;
        const rows = this.rowsOf(chat.id);
        if (url.searchParams.get("tail") === "true") {
          const limit = Math.min(Math.max(Number.parseInt(url.searchParams.get("limit") ?? "50", 10) || 50, 1), 1000);
          const tail = [...rows].sort((a, b) => b.index_in_chat - a.index_in_chat || byBytes(b.id, a.id)).slice(0, limit).reverse();
          return json({ data: tail.map(map), total: rows.length, limit, offset: Math.max(0, rows.length - tail.length) });
        }
        return json(page(rows, map, url));
      }
    }
    if (parts[2] === "world-books" && parts[3] !== undefined) {
      const book = this.books.get(parts[3]);
      if (book === undefined || book.user_id !== userId) return json({ error: "World book not found" }, 404);
      const entries = this.entriesOf(book.id);
      const listed = page(entries, rowToEntry, url);
      const signature = `${book.id}-${book.updated_at}-${entries.length}-${Math.max(0, ...entries.map((e) => e.updated_at))}-${entries.reduce((sum, e) => sum + e.revision, 0)}-${listed.limit}-${listed.offset}`;
      const tag = parts.length === 4 ? `"wb-${signature}"` : `"wb-entries-${signature}--"`;
      if (headers["If-None-Match"] === tag) return new Response(null, { status: 304, headers: { ETag: tag } });
      if (parts.length === 4) return json({ ...rowToBook(book), entries: listed }, 200, { ETag: tag });
      if (parts[4] === "entries") return json(listed, 200, { ETag: tag });
    }
    return json({ error: "Not found" }, 404);
  }

  /** A chat's messages as Lumiverse lists them: by their place, two at one place in the order they were stored. */
  rowsOf(chatId: string): MessageRow[] {
    return [...this.messages.values()].filter((m) => m.chat_id === chatId).sort((a, b) => a.index_in_chat - b.index_in_chat);
  }

  entriesOf(bookId: string): EntryRow[] {
    return [...this.entries.values()].filter((e) => e.world_book_id === bookId).sort((a, b) => a.order_value - b.order_value || byBytes(a.id, b.id));
  }

  // ---------------------------------------------------------------- Spindle, as an extension's worker reaches it

  /** The `spindle` global of an extension's worker, for `createSpindleHost`: what it reads of chats and world books. */
  spindle(identifier: string, granted: (permission: string) => boolean = () => true): unknown {
    const chatDto = (row: ChatRow): Obj => ({ id: row.id, character_id: row.character_id, name: row.name || "", metadata: row.metadata, created_at: row.created_at, updated_at: row.updated_at });
    const userOf = (userId: string | undefined): string => {
      if (userId === undefined) throw new Error("userId is required for operator-scoped extensions");
      return userId;
    };
    const bookFor = (bookId: string, userId: string | undefined): BookRow | null => {
      const book = this.books.get(bookId);
      return book !== undefined && book.user_id === userOf(userId) ? book : null;
    };
    return {
      host: { capabilities: { "chat-lean-messages-v1": 1 } },
      permissions: { has: granted, onChanged: () => undefined },
      log: { info: () => undefined, warn: () => undefined, error: () => undefined },
      chats: {
        get: async (chatId: string, userId?: string) => {
          if (!granted("chats")) throw new Error("Permission denied: chats");
          const chat = this.chats.get(chatId);
          return chat !== undefined && chat.user_id === userOf(userId) ? chatDto(chat) : null;
        },
      },
      chat: {
        getMessages: async (chatId: string, options: { light?: boolean; includeExtra?: boolean; ownMetadataOnly?: boolean; limit?: number; offset?: number; tail?: number } = {}) => {
          if (!granted("chat_mutation")) throw new Error("Permission denied: chat_mutation");
          if (!this.chats.has(chatId)) throw new Error("Chat not found");
          const map = options.light === true ? rowToMessageLight : rowToMessage;
          const rows = this.rowsOf(chatId);
          const picked =
            options.tail !== undefined
              ? [...rows].sort((a, b) => b.index_in_chat - a.index_in_chat || byBytes(b.id, a.id)).slice(0, options.tail).reverse()
              : options.limit !== undefined
                ? rows.slice(options.offset ?? 0, (options.offset ?? 0) + options.limit)
                : rows;
          return picked.map((row) => spindleMessage(map(row), { includeExtra: options.includeExtra !== false, ...(options.ownMetadataOnly === true ? { ownKey: identifier } : {}) }));
        },
      },
      world_books: {
        get: async (bookId: string, userId?: string) => {
          const book = bookFor(bookId, userId);
          if (book === null) return null;
          const read = rowToBook(book);
          return { id: read.id, name: read.name || "", description: read.description || "", metadata: read.metadata, created_at: read.created_at, updated_at: read.updated_at };
        },
        entries: {
          list: async (bookId: string, options: { limit?: number; offset?: number; userId?: string }) => {
            const book = bookFor(bookId, options.userId);
            const all = book === null ? [] : this.entriesOf(book.id).map((e) => spindleEntry(rowToEntry(e)));
            const limit = Math.min(options.limit || 50, 200);
            const offset = options.offset || 0;
            return { data: all.slice(offset, offset + limit), total: all.length };
          },
          get: async (entryId: string, userId?: string) => {
            const entry = this.entries.get(entryId);
            return entry !== undefined && bookFor(entry.world_book_id, userId) !== null ? spindleEntry(rowToEntry(entry)) : null;
          },
        },
      },
    };
  }

  // ---------------------------------------------------------------- chats

  newChat(userId: string, options: { id?: string; name?: string; characterId?: string | null; metadata?: Obj } = {}): ChatRow {
    const row: ChatRow = { id: options.id ?? this.id("chat"), user_id: userId, character_id: options.characterId ?? null, name: options.name ?? "Harbour", metadata: options.metadata ?? {}, created_at: this.now, updated_at: this.now };
    this.chats.set(row.id, row);
    return row;
  }

  private row(chatId: string, index: number, text: string, options: SayOptions): MessageRow {
    const swipes = options.swipes ?? [text];
    return {
      id: this.id("msg"),
      chat_id: chatId,
      index_in_chat: index,
      is_user: options.user === true ? 1 : 0,
      name: options.name ?? (options.user === true ? "Mara" : "Joss"),
      content: text,
      send_date: options.sentAt ?? this.now,
      swipe_id: options.swipeId ?? 0,
      swipes: JSON.stringify(swipes),
      extra: JSON.stringify(options.extra ?? {}),
      parent_message_id: null,
      branch_id: null,
      created_at: this.now,
      swipe_dates: JSON.stringify(swipes.map(() => this.now)),
      revision: 1,
    };
  }

  private next(chatId: string): number {
    return Math.max(-1, ...this.rowsOf(chatId).map((m) => m.index_in_chat)) + 1;
  }

  private chatOwner(chatId: string): string {
    const chat = this.chats.get(chatId);
    if (chat === undefined) throw new Error(`no chat ${chatId}`);
    return chat.user_id;
  }

  /** A message sent at the chat's end (`MESSAGE_SENT`). */
  say(chatId: string, text: string, options: SayOptions = {}): MessageRow {
    const row = this.row(chatId, this.next(chatId), text, options);
    this.messages.set(row.id, row);
    this.emit("MESSAGE_SENT", { chatId, message: rowToMessage(row) }, this.chatOwner(chatId));
    return row;
  }

  /** Messages imported at the chat's end all at once (`bulkInsertMessages`): no event. */
  imported(chatId: string, texts: readonly string[]): MessageRow[] {
    this.version++;
    const first = this.next(chatId);
    return texts.map((text, i) => {
      const row = this.row(chatId, first + i, text, { user: i % 2 === 0 });
      this.messages.set(row.id, row);
      return row;
    });
  }

  /** A message put in before another (`MESSAGE_SENT` with `inserted`): every later one moves up a place, with no event of its own. */
  insertBefore(messageId: string, text: string, options: SayOptions = {}): MessageRow {
    const at = this.message(messageId);
    for (const m of this.rowsOf(at.chat_id)) {
      if (m.index_in_chat < at.index_in_chat) continue;
      m.index_in_chat++;
      m.revision++;
    }
    const row = this.row(at.chat_id, at.index_in_chat - 1, text, options);
    this.messages.set(row.id, row);
    this.emit("MESSAGE_SENT", { chatId: at.chat_id, message: rowToMessage(row), inserted: true }, this.chatOwner(at.chat_id));
    return row;
  }

  message(messageId: string): MessageRow {
    const row = this.messages.get(messageId);
    if (row === undefined) throw new Error(`no message ${messageId}`);
    return row;
  }

  /** A message's text edited (`MESSAGE_EDITED`): its shown swipe's text with it. */
  edit(messageId: string, text: string): void {
    const row = this.message(messageId);
    const swipes = JSON.parse(row.swipes) as string[];
    swipes[row.swipe_id] = text;
    row.swipes = JSON.stringify(swipes);
    row.content = text;
    row.revision++;
    this.emit("MESSAGE_EDITED", { chatId: row.chat_id, message: rowToMessage(row) }, this.chatOwner(row.chat_id));
  }

  /** Messages hidden or shown (`bulkSetHidden`): an edit event each, and no new revision. */
  hide(messageIds: readonly string[], hidden: boolean): void {
    for (const id of messageIds) {
      const row = this.message(id);
      row.extra = JSON.stringify({ ...(JSON.parse(row.extra) as Obj), hidden });
      this.emit("MESSAGE_EDITED", { chatId: row.chat_id, message: rowToMessage(row) }, this.chatOwner(row.chat_id));
    }
  }

  /** An extension's own entry written on a message (`updateMessage` with `ownMetadata`): an edit event. */
  setOwn(messageId: string, identifier: string, value: unknown): void {
    const row = this.message(messageId);
    const extra = JSON.parse(row.extra) as Obj;
    extra.spindle_metadata = { ...((extra.spindle_metadata as Obj | undefined) ?? {}), [identifier]: value };
    row.extra = JSON.stringify(extra);
    row.revision++;
    this.emit("MESSAGE_EDITED", { chatId: row.chat_id, message: rowToMessage(row) }, this.chatOwner(row.chat_id));
  }

  /** A message's extra written with no event and no new revision (`patchMessageExtra`). */
  patchExtra(messageId: string, patch: Obj): void {
    const row = this.message(messageId);
    row.extra = JSON.stringify({ ...(JSON.parse(row.extra) as Obj), ...patch });
    this.version++;
  }

  /** A swipe added and shown (`MESSAGE_SWIPED`, `added`). */
  addSwipe(messageId: string, text: string): void {
    const row = this.message(messageId);
    const swipes = JSON.parse(row.swipes) as string[];
    swipes.push(text);
    row.swipes = JSON.stringify(swipes);
    row.swipe_dates = JSON.stringify(swipes.map(() => this.now));
    const previous = row.swipe_id;
    row.swipe_id = swipes.length - 1;
    row.content = text;
    row.revision++;
    this.emit("MESSAGE_SWIPED", { chatId: row.chat_id, message: rowToMessage(row), action: "added", swipeId: row.swipe_id, previousSwipeId: previous }, this.chatOwner(row.chat_id));
  }

  /** Another swipe shown (`MESSAGE_SWIPED`, `navigated`). */
  showSwipe(messageId: string, swipe: number): void {
    const row = this.message(messageId);
    const swipes = JSON.parse(row.swipes) as string[];
    const previous = row.swipe_id;
    row.swipe_id = swipe;
    row.content = swipes[swipe] ?? "";
    row.revision++;
    this.emit("MESSAGE_SWIPED", { chatId: row.chat_id, message: rowToMessage(row), action: "navigated", swipeId: swipe, previousSwipeId: previous }, this.chatOwner(row.chat_id));
  }

  /** One swipe's text edited (`MESSAGE_EDITED`, then `SWIPE_EDITED`). */
  editSwipe(messageId: string, swipe: number, text: string): void {
    const row = this.message(messageId);
    const swipes = JSON.parse(row.swipes) as string[];
    swipes[swipe] = text;
    row.swipes = JSON.stringify(swipes);
    if (swipe === row.swipe_id) row.content = text;
    row.revision++;
    const owner = this.chatOwner(row.chat_id);
    this.emit("MESSAGE_EDITED", { chatId: row.chat_id, message: rowToMessage(row) }, owner);
    this.emit("SWIPE_EDITED", { chatId: row.chat_id, message: rowToMessage(row), previousSwipeId: row.swipe_id }, owner);
  }

  /** A message deleted (`MESSAGE_DELETED`). Its number is never given to another. */
  remove(messageId: string): void {
    const row = this.message(messageId);
    this.messages.delete(messageId);
    this.emit("MESSAGE_DELETED", { chatId: row.chat_id, messageId }, this.chatOwner(row.chat_id));
  }

  /** The chat's own fields changed (`CHAT_CHANGED`, with the chat as it is after). */
  changeChat(chatId: string, change: { name?: string; metadata?: Obj }): void {
    const chat = this.chats.get(chatId);
    if (chat === undefined) throw new Error(`no chat ${chatId}`);
    if (change.name !== undefined) chat.name = change.name;
    if (change.metadata !== undefined) chat.metadata = { ...chat.metadata, ...change.metadata };
    chat.updated_at = this.now;
    this.emit("CHAT_CHANGED", { chat: rowToChat(chat), changedFields: Object.keys(change) }, chat.user_id);
  }

  /** The user's messages given to another persona all at once (`CHAT_CHANGED` naming only the chat). */
  reattribute(chatId: string, name: string): void {
    const rows = this.rowsOf(chatId).filter((m) => m.is_user === 1);
    for (const m of rows) m.name = name;
    this.emit("CHAT_CHANGED", { chatId, reattributedUserMessages: rows.length }, this.chatOwner(chatId));
  }

  /** The chat deleted, its messages with it (`CHAT_DELETED` alone). */
  deleteChat(chatId: string): void {
    const owner = this.chatOwner(chatId);
    for (const m of this.rowsOf(chatId)) this.messages.delete(m.id);
    this.chats.delete(chatId);
    this.emit("CHAT_DELETED", { id: chatId }, owner);
  }

  /** A branch of the chat at a message (`CHAT_FORKED` alone): copies of the messages up to it, at their places, under new ids. */
  branch(chatId: string, atMessageId: string): ChatRow {
    const source = this.chats.get(chatId);
    if (source === undefined) throw new Error(`no chat ${chatId}`);
    const at = this.message(atMessageId);
    const fork = this.newChat(source.user_id, { name: `${source.name} (branch)`, characterId: source.character_id, metadata: { ...source.metadata, branched_from: chatId } });
    for (const m of this.rowsOf(chatId)) if (m.index_in_chat <= at.index_in_chat) this.messages.set(`${fork.id}-${m.id}`, { ...m, id: `${fork.id}-${m.id}`, chat_id: fork.id });
    this.emit("CHAT_FORKED", { sourceChatId: chatId, forkedChatId: fork.id, chat: rowToChat(fork), branchId: this.id("branch"), forkedAtMessageId: atMessageId, forkedAtMessageIndex: at.index_in_chat }, source.user_id);
    return fork;
  }

  // ---------------------------------------------------------------- world books

  newBook(userId: string, options: { id?: string; name?: string; description?: string; metadata?: Obj } = {}): BookRow {
    const row: BookRow = { id: options.id ?? this.id("book"), user_id: userId, name: options.name ?? "The harbour", description: options.description ?? "", folder: "", metadata: JSON.stringify(options.metadata ?? {}), created_at: this.now, updated_at: this.now };
    this.books.set(row.id, row);
    return row;
  }

  private book(bookId: string): BookRow {
    const book = this.books.get(bookId);
    if (book === undefined) throw new Error(`no book ${bookId}`);
    return book;
  }

  /** An entry made (`createEntry`): the book stamped with the same time as the entry, and an entry event. */
  addEntry(bookId: string, entry: { comment: string; content: string; key?: string[]; order?: number; extensions?: Obj }, quiet = false): EntryRow {
    const book = this.book(bookId);
    const row: EntryRow = {
      id: this.id("entry"),
      world_book_id: bookId,
      uid: this.id("uid"),
      key: JSON.stringify(entry.key ?? [entry.comment.toLowerCase()]),
      keysecondary: "[]",
      content: entry.content,
      comment: entry.comment,
      role: null,
      order_value: entry.order ?? 100,
      constant: 0,
      disabled: 0,
      use_regex: 0,
      vectorized: 0,
      vector_index_status: "not_enabled",
      extensions: JSON.stringify(entry.extensions ?? {}),
      revision: 1,
      folder: "",
      tags: "[]",
      created_at: this.now,
      updated_at: this.now,
    };
    this.entries.set(row.id, row);
    book.updated_at = this.now;
    if (!quiet) this.emit("WORLD_BOOK_ENTRY_CHANGED", { id: row.id, worldBookId: bookId, entry: rowToEntry(row) }, book.user_id);
    return row;
  }

  /** An entry changed (`updateEntry`): a new revision, the entry and the book stamped now, and an entry event. */
  updateEntry(entryId: string, change: { content?: string; comment?: string; order?: number; disabled?: boolean }): void {
    const row = this.entries.get(entryId);
    if (row === undefined) throw new Error(`no entry ${entryId}`);
    if (change.content !== undefined) row.content = change.content;
    if (change.comment !== undefined) row.comment = change.comment;
    if (change.order !== undefined) row.order_value = change.order;
    if (change.disabled !== undefined) row.disabled = change.disabled ? 1 : 0;
    row.revision++;
    row.updated_at = this.now;
    const book = this.book(row.world_book_id);
    book.updated_at = this.now;
    this.emit("WORLD_BOOK_ENTRY_CHANGED", { id: entryId, worldBookId: book.id, entry: rowToEntry(row) }, book.user_id);
  }

  /** An entry deleted (`deleteEntry`): the book stamped, and an event that names the entry alone. */
  deleteEntry(entryId: string): void {
    const row = this.entries.get(entryId);
    if (row === undefined) throw new Error(`no entry ${entryId}`);
    this.entries.delete(entryId);
    const book = this.book(row.world_book_id);
    book.updated_at = this.now;
    this.emit("WORLD_BOOK_ENTRY_DELETED", { id: entryId, worldBookId: book.id }, book.user_id);
  }

  /** Several entries changed at once (a bulk action, a reorder, a Spindle batch): `WORLD_BOOK_CHANGED` alone. */
  bulk(bookId: string, change: (entries: EntryRow[]) => void): void {
    const book = this.book(bookId);
    const rows = this.entriesOf(bookId);
    change(rows);
    for (const row of rows) {
      row.revision++;
      row.updated_at = this.now;
    }
    book.updated_at = this.now;
    this.emit("WORLD_BOOK_CHANGED", { id: bookId, worldBook: rowToBook(book) }, book.user_id);
  }

  /** The book deleted, its entries with it. */
  deleteBook(bookId: string): void {
    const book = this.book(bookId);
    for (const e of this.entriesOf(bookId)) this.entries.delete(e.id);
    this.books.delete(bookId);
    this.emit("WORLD_BOOK_DELETED", { id: bookId }, book.user_id);
  }

  /** A library imported or migrated (`WORLD_BOOK_LIBRARY_CHANGED` alone): any book's entries may have changed. */
  library(userId: string, change: () => void): void {
    change();
    this.emit("WORLD_BOOK_LIBRARY_CHANGED", { reason: "import", imported: 1 }, userId);
  }

  /** An entry's vector index written: no stamp, no revision, no event. */
  indexed(entryId: string): void {
    const row = this.entries.get(entryId);
    if (row !== undefined) row.vector_index_status = "indexed";
    this.version++;
  }

  /** An extension's namespace in an entry's extensions written (`setEntityExtensionNamespace`: REST, Spindle `setExtension`, a batch): no stamp, no revision, no event. */
  setExtension(entryId: string, namespace: string, value: unknown): void {
    const row = this.entries.get(entryId);
    if (row === undefined) throw new Error(`no entry ${entryId}`);
    row.extensions = JSON.stringify({ ...(JSON.parse(row.extensions) as Obj), [namespace]: value });
    this.version++;
  }

  /** The book's entries made vectorized (`convertToVectorized`): each one converted and the book stamped, a new revision, and no event. */
  convertToVectorized(bookId: string): void {
    const book = this.book(bookId);
    for (const row of this.entriesOf(bookId)) {
      if (row.constant === 1 || row.disabled === 1 || row.content.trim() === "" || row.vectorized === 1) continue;
      row.vectorized = 1;
      row.vector_index_status = "pending";
      row.updated_at = this.now;
      row.revision++;
    }
    book.updated_at = this.now;
    this.version++;
  }

  /** The book renamed (`updateWorldBook`): stamped now, and `WORLD_BOOK_CHANGED`. */
  renameBook(bookId: string, name: string): void {
    const book = this.book(bookId);
    book.name = name;
    book.updated_at = this.now;
    this.emit("WORLD_BOOK_CHANGED", { id: bookId, worldBook: rowToBook(book) }, book.user_id);
  }

  /** One key of the chat's metadata written in place (the chat memory's config hash, the memory cortex's rebuild state, a databank's bindings): no stamp, no event. */
  stampChat(chatId: string, key: string, value: unknown): void {
    const chat = this.chats.get(chatId);
    if (chat === undefined) throw new Error(`no chat ${chatId}`);
    chat.metadata = { ...chat.metadata, [key]: value };
    this.version++;
  }
}
