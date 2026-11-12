// The fake Lumiverse's chats, messages and world books (fake-host.ts) as Lumiverse's own database
// keeps them, and the events Lumiverse sends as they change: what the runtime's copy of chat and lore
// reads over HTTP (fake-lumiverse.ts) and from a database file (the reader's tests), and hears of
// through the extension. One mapping from the fake's rows serves the extension's host, the HTTP routes
// and the file alike, and every change to those rows is told as the event Lumiverse sends for it,
// however a test or the fake makes the change: so what the extension's host answers and what the copy
// reads can't drift apart.
//
// The rows are watched: a chat, a message or a book is handed out as a view through which every change,
// at any depth, is noted; on the next turn of the event loop each changed chat and book is compared
// with what was last told of it, and what differs is told. A test that wants a change Lumiverse makes
// with no event makes it in `quietly`.

import type { JsonValue } from "../../src/core/ports";
import { type BookRow, type ChatRow, type EntryRow, type MessageRow, rowToChat, rowToMessage } from "../runtime/copy/lumiverse";
import type { FakeBook, FakeChat, FakeEntry, FakeMessage } from "./fake-host";

/** A time in milliseconds as Lumiverse stamps it: in seconds, unless only milliseconds can say it (the copy reads both as Lumiverse writes both). */
export function stamped(ms: number | null | undefined): number {
  if (ms === null || ms === undefined || ms <= 0) return 0;
  return ms >= 100_000_000_000 ? ms : ms / 1000;
}

/** A message of the fake's as Lumiverse's database row: its place in the chat is its place in the list, as the fake's host gives it. */
export function messageRow(chatId: string, m: FakeMessage, index: number, revision: number): MessageRow {
  const extra: Record<string, JsonValue> = { spindle_metadata: JSON.parse(JSON.stringify(m.metadata)) as Record<string, JsonValue> };
  if (m.role === "system") extra.spindle_role = "system";
  const at = stamped(m.at);
  return { id: m.id, chat_id: chatId, index_in_chat: index, is_user: m.role === "user" ? 1 : 0, name: m.name, content: m.swipes[m.swipeId] ?? "", send_date: at, swipe_id: m.swipeId, swipes: JSON.stringify(m.swipes), extra: JSON.stringify(extra), parent_message_id: null, branch_id: null, created_at: at, swipe_dates: "[]", revision };
}

/** A chat of the fake's as Lumiverse's row, stamped as it was last changed. */
export function chatRow(chat: FakeChat, updatedAt: number): ChatRow {
  return { id: chat.id, user_id: chat.userId, character_id: chat.characterId, name: chat.name, metadata: JSON.parse(JSON.stringify(chat.metadata)) as Record<string, unknown>, created_at: 0, updated_at: updatedAt };
}

/** A world book of the fake's as Lumiverse's row. */
export function bookRow(book: FakeBook): BookRow {
  return { id: book.book.id, user_id: book.userId, name: book.book.name, description: book.book.description, folder: "", metadata: JSON.stringify(book.metadata ?? {}), created_at: 0, updated_at: stamped(book.updatedAt) };
}

/** An entry of the fake's as Lumiverse's row, with Lumiverse's defaults where the test set nothing (as the fake's host gives them). */
export function entryRow(e: FakeEntry): EntryRow {
  return {
    id: e.id,
    world_book_id: e.bookId,
    uid: "",
    key: JSON.stringify(e.keys),
    keysecondary: JSON.stringify(e.secondaryKeys),
    content: e.content,
    comment: e.title,
    role: e.role ?? null,
    order_value: e.order ?? 100,
    constant: e.constant ? 1 : 0,
    disabled: e.enabled ? 0 : 1,
    use_regex: e.regex === true ? 1 : 0,
    vectorized: e.vectorized === true ? 1 : 0,
    vector_index_status: "",
    extensions: JSON.stringify(e.extensions ?? {}),
    revision: 1,
    folder: "",
    tags: "[]",
    created_at: 0,
    updated_at: stamped(e.updatedAt),
  };
}

/** Where the watched rows tell what happened to them: every extension installed hears the same. */
export interface Telling {
  /** One of Lumiverse's events, with its payload and whose it is. */
  event(name: string, payload: Record<string, unknown>, userId: string): void;
  /** What Spindle makes of a chat event for an extension (`onChatTouched`): the chat changed, or is gone. */
  touched(chatId: string, gone: boolean, userId: string | null): void;
}

/** What was last told of a chat: its own row, and each message's row by id in the chat's order. */
interface ChatTold {
  chat: string;
  order: string[];
  messages: Map<string, { text: string; swipes: number; shown: number }>;
}

/** A map whose entries are handed out as views of what was put in, and whose puts and removals are told. */
class Watched<V extends object> extends Map<string, V> {
  hooks: { put(key: string, value: V, before: V | undefined): V; removed(key: string, value: V): void } | null = null;

  override set(key: string, value: V): this {
    if (this.hooks === null) return super.set(key, value);
    return super.set(key, this.hooks.put(key, value, super.get(key)));
  }

  override delete(key: string): boolean {
    const held = super.get(key);
    const gone = super.delete(key);
    if (gone && held !== undefined) this.hooks?.removed(key, held);
    return gone;
  }
}

type Views = WeakMap<object, object>;

export class RowWatch {
  /** The users' chats, by id: each handed out as a view. */
  readonly chats: Map<string, FakeChat>;
  /** Lumiverse's stamp of each chat as it was last changed (a count of changes, read as seconds), and each message's revision. */
  private readonly stamps = new Map<string, number>();
  private readonly revisions = new WeakMap<object, number>();
  private version = 0;
  private readonly told = new Map<string, ChatTold>();
  private readonly booksTold = new WeakMap<Map<string, FakeBook>, Map<string, string>>();
  private readonly dirtyChats = new Set<string>();
  private readonly dirtyBooks = new Map<Map<string, FakeBook>, Set<string>>();
  private queued = false;
  private quiet = 0;
  private readonly views = { chats: new WeakMap() as Views, lists: new WeakMap() as Views, messages: new WeakMap() as Views, deep: new WeakMap() as Views };
  /** The object each view shows. */
  private readonly raws = new WeakMap<object, object>();

  constructor(private readonly telling: Telling) {
    const chats = new Watched<FakeChat>();
    chats.hooks = {
      put: (id, value, before) => {
        const raw = this.rawOf(value);
        if (before === undefined) {
          // A chat made: Lumiverse tells of none, and the copy reads it whole when it is first wanted.
          this.told.set(id, this.snapshot(raw));
          this.stamps.set(id, ++this.version);
        } else this.chatChanged(id);
        return this.chatView(raw);
      },
      removed: (id, value) => {
        this.told.delete(id);
        this.dirtyChats.delete(id);
        // The copy hears of it as Lumiverse tells it; what Spindle makes of a deletion for an extension (`onChatTouched` with `gone`, and whose chat it was) is the test's own to say.
        if (this.quiet === 0) this.telling.event("CHAT_DELETED", { id }, value.userId);
      },
    };
    this.chats = chats;
  }

  /** One extension's world books, by id, watched: each extension's host keeps its own. */
  books(): Map<string, FakeBook> {
    const books = new Watched<FakeBook>();
    const told = new Map<string, string>();
    this.booksTold.set(books, told);
    books.hooks = {
      put: (id, value, before) => {
        const raw = this.rawOf(value);
        if (before === undefined) told.set(id, JSON.stringify(raw));
        else this.bookChanged(books, id);
        return this.deepView(raw, () => this.bookChanged(books, id));
      },
      removed: (id, value) => {
        told.delete(id);
        this.dirtyBooks.get(books)?.delete(id);
        if (this.quiet === 0) this.telling.event("WORLD_BOOK_DELETED", { id }, value.userId);
      },
    };
    return books;
  }

  /** Changes made in `change` are told of by no event, as some of Lumiverse's own are not; what was changed before is told first. */
  quietly<T>(change: () => T): T {
    this.flush();
    this.quiet++;
    try {
      return change();
    } finally {
      // Taken as told, with nothing said.
      this.flush();
      this.quiet--;
    }
  }

  /** A chat's rows as Lumiverse's database holds them now; null for a chat there isn't. */
  chatRows(chatId: string): { chat: ChatRow; messages: MessageRow[] } | null {
    const view = this.chats.get(chatId);
    if (view === undefined) return null;
    const raw = this.rawOf(view);
    return { chat: chatRow(raw, this.stamps.get(chatId) ?? 0), messages: raw.messages.map((m, i) => messageRow(chatId, this.rawOf(m), i, this.revisions.get(this.rawOf(m)) ?? 1)) };
  }

  /** A book's rows as Lumiverse's database holds them now, from one extension's books; null for a book there isn't. */
  bookRows(books: Map<string, FakeBook>, bookId: string): { book: BookRow; entries: EntryRow[] } | null {
    const view = books.get(bookId);
    if (view === undefined) return null;
    const raw = this.rawOf(view);
    return { book: bookRow(raw), entries: raw.entries.map((e) => entryRow(this.rawOf(e))) };
  }

  /** The object a view shows, or the value itself. */
  rawOf<T>(value: T): T {
    return typeof value === "object" && value !== null ? ((this.raws.get(value) as T | undefined) ?? value) : value;
  }

  private cached<T extends object>(views: Views, raw: T, make: () => T): T {
    const held = views.get(raw);
    if (held !== undefined) return held as T;
    const view = make();
    views.set(raw, view);
    this.raws.set(view, raw);
    return view;
  }

  private deepened<T>(value: T, changed: () => void): T {
    return typeof value === "object" && value !== null ? (this.deepView(value, changed) as T) : value;
  }

  private deepView<T extends object>(raw: T, changed: () => void): T {
    return this.cached(this.views.deep, raw, () => new Proxy(raw, this.handler(changed, (value) => this.deepened(value, changed))));
  }

  /** A view's traps: every value read through `wrap`, every change told to `changed`. */
  private handler<T extends object>(changed: () => void, wrap: (value: unknown, key: string | symbol, target: T) => unknown): ProxyHandler<T> {
    return {
      get: (target, key, receiver) => wrap(Reflect.get(target, key, receiver), key, target),
      set: (target, key, value) => {
        const done = Reflect.set(target, key, this.rawOf(value));
        changed();
        return done;
      },
      deleteProperty: (target, key) => {
        const done = Reflect.deleteProperty(target, key);
        changed();
        return done;
      },
      defineProperty: (target, key, descriptor) => {
        const done = Reflect.defineProperty(target, key, descriptor);
        changed();
        return done;
      },
    };
  }

  private chatView(raw: FakeChat): FakeChat {
    const changed = (): void => this.chatChanged(raw.id);
    return this.cached(this.views.chats, raw, () => new Proxy(raw, this.handler<FakeChat>(changed, (value, key, target) => (key === "messages" && Array.isArray(value) ? this.listView(value as FakeMessage[], target.id) : this.deepened(value, changed)))));
  }

  private listView(raw: FakeMessage[], chatId: string): FakeMessage[] {
    return this.cached(this.views.lists, raw, () => new Proxy(raw, this.handler<FakeMessage[]>(() => this.dirty(chatId), (value) => (typeof value === "object" && value !== null ? this.messageView(value as FakeMessage, chatId) : value))));
  }

  private messageView(raw: FakeMessage, chatId: string): FakeMessage {
    const changed = (): void => {
      this.revisions.set(raw, (this.revisions.get(raw) ?? 1) + 1);
      this.dirty(chatId);
    };
    return this.cached(this.views.messages, raw, () => new Proxy(raw, this.handler<FakeMessage>(changed, (value) => this.deepened(value, changed))));
  }

  private chatChanged(chatId: string): void {
    this.stamps.set(chatId, ++this.version);
    this.dirty(chatId);
  }

  private dirty(chatId: string): void {
    this.dirtyChats.add(chatId);
    this.soon();
  }

  private bookChanged(books: Map<string, FakeBook>, bookId: string): void {
    let ids = this.dirtyBooks.get(books);
    if (ids === undefined) {
      ids = new Set();
      this.dirtyBooks.set(books, ids);
    }
    ids.add(bookId);
    this.soon();
  }

  private soon(): void {
    if (this.queued) return;
    this.queued = true;
    queueMicrotask(() => this.flush());
  }

  private snapshot(raw: FakeChat): ChatTold {
    const messages = new Map<string, { text: string; swipes: number; shown: number }>();
    raw.messages.forEach((view, i) => {
      const m = this.rawOf(view);
      messages.set(m.id, { text: JSON.stringify(messageRow(raw.id, m, i, 0)), swipes: m.swipes.length, shown: m.swipeId });
    });
    return { chat: JSON.stringify(chatRow(raw, 0)), order: raw.messages.map((m) => m.id), messages };
  }

  /** Tells what changed in each chat and book since it was last told of, as Lumiverse tells it. */
  private flush(): void {
    this.queued = false;
    for (const chatId of [...this.dirtyChats]) {
      this.dirtyChats.delete(chatId);
      this.tellChat(chatId);
    }
    for (const [books, ids] of [...this.dirtyBooks]) {
      this.dirtyBooks.delete(books);
      for (const id of ids) this.tellBook(books, id);
    }
  }

  private tellChat(chatId: string): void {
    const view = this.chats.get(chatId);
    const before = this.told.get(chatId);
    if (view === undefined || before === undefined) return;
    const raw = this.rawOf(view);
    const now = this.snapshot(raw);
    this.told.set(chatId, now);
    if (this.quiet > 0) return;
    const said: [string, Record<string, unknown>][] = [];
    for (const id of before.order) if (!now.messages.has(id)) said.push(["MESSAGE_DELETED", { chatId, messageId: id }]);
    // How many of the messages that were there before come after the one at hand: one new among them was put in before others.
    let older = now.order.filter((id) => before.messages.has(id)).length;
    raw.messages.forEach((view, i) => {
      const m = this.rawOf(view);
      const was = before.messages.get(m.id);
      const shown = now.messages.get(m.id);
      const message = (): Record<string, unknown> => rowToMessage(messageRow(chatId, m, i, this.revisions.get(m) ?? 1));
      if (was === undefined) said.push(["MESSAGE_SENT", { chatId, message: message(), ...(older > 0 ? { inserted: true } : {}) }]);
      else {
        older--;
        if (shown !== undefined && was.text !== shown.text) said.push([was.swipes !== shown.swipes || was.shown !== shown.shown ? "MESSAGE_SWIPED" : "MESSAGE_EDITED", { chatId, message: message() }]);
      }
    });
    if (before.chat !== now.chat) said.push(["CHAT_CHANGED", { chat: rowToChat(chatRow(raw, this.stamps.get(chatId) ?? 0)) }]);
    if (said.length === 0) return;
    for (const [name, payload] of said) this.telling.event(name, payload, raw.userId);
    this.telling.touched(chatId, false, null);
  }

  private tellBook(books: Map<string, FakeBook>, bookId: string): void {
    const told = this.booksTold.get(books);
    const view = books.get(bookId);
    if (told === undefined || view === undefined) return;
    const now = JSON.stringify(this.rawOf(view));
    const before = told.get(bookId);
    told.set(bookId, now);
    if (this.quiet > 0 || before === now) return;
    // Lumiverse tells of a change to a book's entries made in bulk with the book's own event, which has a copy read the book again.
    this.telling.event("WORLD_BOOK_CHANGED", { id: bookId }, this.rawOf(view).userId);
  }
}
