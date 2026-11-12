// The runtime's copy of chat and lore (PI-BUILD-PLAN §4.5): the read side of the extension's own host
// ports for chats and world books (`BackendHost["chats"]`, `["lore"]`), answered from rows kept in the
// runtime, in the very shapes that host gives, so the backend's path, range and recall logic can run
// here over it unchanged.
//
// A chat or a book is read whole from the source the first time it is wanted; after that Lumiverse's
// events, as the extension forwards them, keep it current. It is read again, never patched by guess:
// when the link to the extension reopened (events may have been missed), when a message was put in
// before others (every later one moved, and Lumiverse tells of none of them), when a book changed as a
// whole, when an event says something the copy can't apply, and when the cheap check before use (the
// chat's count and its newest message) finds the chat not as held, which catches the changes Lumiverse
// makes without an event at a chat's end. A read that comes while a chat is being read waits for that
// read, and an event that comes meanwhile is applied to it once it lands, in order, once.
//
// Whatever the copy can't vouch for goes to the fallback (the extension's own host, over the link), and
// that answer isn't kept: a chat not read yet while the source is down, a check that failed, a chat too
// large to keep, a read the extension itself may not make (the user didn't grant the permission
// Lumiverse puts it under: the copy reads with the user's own session, which nothing gates). What the
// copy doesn't keep at all goes there as well: the user's list of chats, a character's name, Sovereign
// Hand, which books a character, a persona or every chat has, and an entry of a book it doesn't hold.
//
// One user's rows only: the session the source reads with decides whose, an event that names another
// user is passed over, and a chat whose owner isn't the session's user is never kept.

import type { JsonValue, LogLevel } from "../../core/ports";
import type { BackendHost, HostBookEntry, HostChat, HostMessage } from "../../extension/backend/spindle";
import { isRecord } from "../../link/json";
import { applyToBook, applyToChat, type BookCopy, bookCopyOf, type ChatCopy, chatCopyOf, differs, type Heard, signatureOf } from "./kept";
import { bookOnly, entryOnly } from "./rows";
import type { CopySource, SourceMessage } from "./source";

/** The read side of the extension's own host port for chats. */
export type ChatReads = Pick<BackendHost["chats"], "get" | "messages" | "swipe" | "list" | "characterName" | "sovereignHand">;
/** The extension's own host port for world books, which only reads. */
export type LoreReads = BackendHost["lore"];

export interface HostReads {
  chats: ChatReads;
  lore: LoreReads;
}

/** One of Lumiverse's events as an extension receives it. */
export interface LumiverseEvent {
  /** Lumiverse's name for it: `MESSAGE_SENT`, `WORLD_BOOK_CHANGED`, … */
  name: string;
  payload: unknown;
  /** The user it is of, where Lumiverse said. */
  userId?: string | null;
}

export interface HostCopyDeps {
  /** Where the rows are read from. */
  source: CopySource;
  /** Where a read goes that the copy can't vouch for or doesn't keep: the extension's own host, over the link. */
  fallback: HostReads;
  /** The user whose session the source reads with: the only one whose rows are kept. */
  userId: string;
  /** The extension whose entry in a message's extension metadata is its own: LumiAH's, or the one it is built into. */
  identifier: string;
  /** Whether the extension holds a permission now (`chats`, `chat_mutation`, `world_books`). */
  granted(permission: string): boolean;
  /**
   * Set where the mounting extension keeps its own entry on each message elsewhere than on the
   * message: the entries of a chat's messages, by message id (a message it doesn't name has none).
   * Read once a chat is served, and kept until `ownChanged` says they changed.
   */
  own?: (chatId: string) => Promise<ReadonlyMap<string, JsonValue>>;
  /** The mounting extension declines lore: the lore side answers that there is none, as its host does. */
  declinesLore?: boolean;
  /** The most characters kept, chats and books together; `KEEP_CHARS` when not set. */
  keepChars?: () => number;
  /** How long a check before use holds, in ms: a chat checked no longer ago than that is used as held; `CHECK_MS` when not set. */
  checkMs?: number;
  now(): number;
  log(level: LogLevel, message: string): void;
}

/** A chat or a book the copy keeps, as its state says it. */
export interface KeptState {
  id: string;
  /** The source its rows were read from. */
  from: string;
  /** Its messages, or its entries. */
  rows: number;
  chars: number;
  /** When it was last read whole, and why. */
  read: { at: number; why: string };
  /** When it was last found current, by a read or a check. */
  checkedAt: number;
  /** Why it is to be read again before it is next used; null: it is current. */
  stale: string | null;
}

export interface CopyNote {
  at: number;
  what: "chat" | "book";
  id: string;
  why: string;
}

export interface CopyState {
  source: string;
  chars: { kept: number; most: number };
  chats: KeptState[];
  books: KeptState[];
  /** The latest reads whole, the newest last: of what, why, and how each ended. */
  reads: (CopyNote & { outcome: string })[];
  /** Reads that went to the fallback because the copy couldn't vouch for its answer: how many in all, and the latest, the newest last. */
  fallbacks: { total: number; latest: CopyNote[] };
}

export interface HostCopy {
  readonly chats: ChatReads;
  readonly lore: LoreReads;
  /** One of Lumiverse's events, as the extension forwarded it, in the order Lumiverse sent them. */
  apply(event: LumiverseEvent): void;
  /** The link to the extension reopened: events may have been missed, so everything kept is read again before it is next used. */
  reopened(): void;
  /** The mounting extension's own entries on a chat's messages changed (`own`). */
  ownChanged(chatId: string): void;
  /**
   * The runtime wrote on a message through the link (a turn's record): until Lumiverse tells of that
   * write, or a read begun after it lands, the chat is the fallback's to answer, so a read never misses
   * the runtime's own write.
   */
  written(chatId: string, messageId: string): void;
  state(): CopyState;
}

/** The most characters kept when `keepChars` isn't set: a few long chats and their books. */
export const KEEP_CHARS = 32_000_000;
/** How long a check before use holds when `checkMs` isn't set: the several reads of one step of a run cost one check. */
export const CHECK_MS = 1_000;
/** How many of the latest reads and fallbacks the state lists. */
const NOTED = 20;
/** The most messages the host gives for one `tail` read: Lumiverse's own cap. */
const TAIL_MOST = 1000;
/** How many times one read goes round (a read, a check, a read again after what was heard meanwhile) before it gives up. */
const ROUNDS = 8;

const NOT_KEPT = "it wasn't kept";
const REOPENED = "the link to the extension reopened, so events may have been missed";
const LIBRARY = "Lumiverse changed the library of world books";
const BRANCHED = "it was made as a branch of another chat";
const TOO_LARGE = "it is larger than all the copy may keep";
const AWAITED = "the runtime wrote on it, and Lumiverse hasn't told of that write yet";
const UNHEARD = "Lumiverse never told of a write the runtime made on it";
/** How long a write the runtime made through the link may go untold before the chat is read again instead. */
const WRITE_WAIT_MS = 2_000;
const notGranted = (permission: string): string => `the extension isn't granted the "${permission}" permission, so Lumiverse wouldn't give it this`;
const words = (error: unknown): string => (error instanceof Error ? error.message : String(error));

/** Why the copy can't answer a read. */
type Doubt = { doubt: string };
/** How waiting on a read or a check ended: go round again, the user has none such, or a doubt. */
type Outcome = "again" | "none" | Doubt;

const isDoubt = (value: unknown): value is Doubt => isRecord(value) && typeof value.doubt === "string";

/** The source says the user has no such chat or book now. */
const GONE = Symbol("gone");

/** The row an event is of: the message's or the entry's id; null for one of a chat or a book as a whole. */
function rowOf(heard: Heard): string | null {
  if ("stale" in heard) return null;
  const { payload } = heard;
  const row = typeof payload.messageId === "string" ? payload.messageId : isRecord(payload.message) ? payload.message.id : isRecord(payload.entry) ? payload.entry.id : undefined;
  return typeof row === "string" ? row : null;
}

interface Slot<C> {
  copy: C | null;
  /** The read whole under way, which everyone who wants it waits for. */
  reading: Promise<Outcome> | null;
  /** The check before use under way, likewise. */
  checking: Promise<Outcome> | null;
  /** What was heard while it was read, applied to the read in order once it lands. */
  heard: Heard[];
  /** Why it is to be read again before it is next used. */
  stale: string | null;
  read: { at: number; why: string };
  from: string;
  checkedAt: number;
  /** Where the source stood at the last check that found it current. */
  mark: string | null;
  /** The rows the runtime wrote on through the link, untold of yet, and when. */
  written: Map<string, number>;
}

/** What tells a kept chat from a kept book. */
interface Kind<C> {
  what: "chat" | "book";
  /** It read whole and made a copy; null when the user has none such; `refused`: why it isn't to be kept. */
  read(id: string, held: C | null): Promise<C | null | { refused: string }>;
  /** Whether a kept one is still as the source has it: null when it is, why not when it isn't. `changed` is the source's own word on whether anything changed. */
  check(id: string, copy: C, changed: boolean | null): Promise<string | null | typeof GONE>;
  apply(copy: C, name: string, payload: Record<string, unknown>): string | null;
  rows(copy: C): number;
}

/** One kept thing as the memory holds it: of which kind, and how it is let go. */
interface Evictable {
  readonly what: "chat" | "book";
  evict(id: string): void;
}

/** What the copy keeps, chats and books together, by how recently each was used, held to a number of characters. */
class Memory {
  private readonly held = new Map<string, { shelf: Evictable; id: string; chars: number }>();
  total = 0;

  constructor(readonly most: () => number) {}

  /** Keeps one at its size, as used now when `used`; lets the least recently used others go until all fits. */
  hold(shelf: Evictable, id: string, chars: number, used: boolean): void {
    const key = `${shelf.what}\u0000${id}`;
    const old = this.held.get(key);
    if (old !== undefined) {
      this.total -= old.chars;
      if (used) this.held.delete(key);
      else old.chars = chars;
    }
    if (old === undefined || used) this.held.set(key, { shelf, id, chars });
    this.total += chars;
    for (const [other, item] of this.held) {
      if (this.total <= this.most()) break;
      if (other === key) continue;
      this.held.delete(other);
      this.total -= item.chars;
      item.shelf.evict(item.id);
    }
  }

  used(shelf: Evictable, id: string): void {
    const key = `${shelf.what}\u0000${id}`;
    const item = this.held.get(key);
    if (item === undefined) return;
    this.held.delete(key);
    this.held.set(key, item);
  }

  forget(shelf: Evictable, id: string): void {
    const key = `${shelf.what}\u0000${id}`;
    const item = this.held.get(key);
    if (item === undefined) return;
    this.held.delete(key);
    this.total -= item.chars;
  }
}

interface ShelfEnv {
  source: CopySource;
  memory: Memory;
  checkMs: number;
  now(): number;
  /** A read whole ended: what it was of, why it was made, and how it ended. */
  noted(what: "chat" | "book", id: string, why: string, outcome: string): void;
  /** One is no longer kept: deleted, let go, or found not the user's. */
  dropped(id: string): void;
}

/** The kept chats, or the kept books: their reads, checks, events and memory. */
class Shelf<C extends { chars: number }> {
  readonly slots = new Map<string, Slot<C>>();
  /** The ones found larger than all the copy may keep, at the size they were. */
  private readonly large = new Map<string, number>();

  constructor(
    private readonly kind: Kind<C>,
    private readonly env: ShelfEnv,
  ) {}

  get what(): "chat" | "book" {
    return this.kind.what;
  }

  /** The copy, current: read whole or checked as needed. Null: the user has none such. A doubt: the copy can't vouch for it now. */
  async vouch(id: string): Promise<C | null | Doubt> {
    for (let round = 0; round < ROUNDS; round++) {
      const large = this.large.get(id);
      if (large !== undefined) {
        if (large > this.env.memory.most()) return { doubt: TOO_LARGE };
        this.large.delete(id);
      }
      const slot = this.slots.get(id);
      const busy = slot?.reading ?? slot?.checking ?? null;
      let outcome: Outcome;
      if (busy !== null) outcome = await busy;
      else if (slot !== undefined && slot.copy !== null && slot.stale === null) {
        const waited = this.awaited(slot);
        if (waited !== null) return { doubt: waited };
        if (slot.stale !== null) continue;
        if (this.env.now() - slot.checkedAt < this.env.checkMs) {
          this.env.memory.used(this, id);
          return slot.copy;
        }
        outcome = await this.check(id, slot);
      } else outcome = await this.read(id, slot ?? this.open(id));
      if (outcome === "none") return null;
      if (isDoubt(outcome)) return outcome;
    }
    return { doubt: "it kept changing while it was read" };
  }

  /** One of Lumiverse's events, or a reason to read it again: applied now, kept for the read under way, or passed over for one not kept. */
  hear(id: string, heard: Heard): void {
    const slot = this.slots.get(id);
    if (slot === undefined) return;
    if (slot.reading !== null) {
      slot.heard.push(heard);
      return;
    }
    // Nothing current to apply it to: the next read holds it.
    if (slot.copy === null || slot.stale !== null) return;
    const again = this.applied(slot.copy, heard);
    if (again !== null) slot.stale = again;
    else {
      this.told(slot, heard);
      this.fit(id, slot, false);
    }
  }

  hearAll(heard: Heard): void {
    for (const id of [...this.slots.keys()]) this.hear(id, heard);
  }

  /** The runtime wrote on a row of it through the link: until Lumiverse tells of that write, or a read begun after it lands, the fallback answers for it. */
  wrote(id: string, row: string): void {
    this.slots.get(id)?.written.set(row, this.env.now());
  }

  /** Why a kept one can't be answered from for a write of the runtime's own not told of yet; null when it can. One untold of for too long has it read again. */
  private awaited(slot: Slot<C>): string | null {
    if (slot.written.size === 0) return null;
    const now = this.env.now();
    for (const when of slot.written.values()) {
      if (now - when < WRITE_WAIT_MS) continue;
      slot.written.clear();
      slot.stale = UNHEARD;
      return null;
    }
    return AWAITED;
  }

  /** An event applied: a write of the runtime's own on its row is heard. */
  private told(slot: Slot<C>, heard: Heard): void {
    const row = rowOf(heard);
    if (row !== null) slot.written.delete(row);
  }

  /** Deleted, or found not the user's: no longer kept, and a read under way isn't kept either. */
  drop(id: string): void {
    this.large.delete(id);
    if (!this.slots.delete(id)) return;
    this.env.memory.forget(this, id);
    this.env.dropped(id);
  }

  /** Let go to make room. A read or a check under way goes on, and keeps what it reads. */
  evict(id: string): void {
    const slot = this.slots.get(id);
    if (slot === undefined) return;
    slot.copy = null;
    slot.stale = null;
    if (slot.reading !== null || slot.checking !== null) return;
    this.slots.delete(id);
    this.env.dropped(id);
  }

  /** Every copy held, current or to be read again before it is next used. */
  *held(): Iterable<[string, C]> {
    for (const [id, slot] of this.slots) if (slot.copy !== null) yield [id, slot.copy];
  }

  state(): KeptState[] {
    const out: KeptState[] = [];
    for (const [id, slot] of this.slots) if (slot.copy !== null) out.push({ id, from: slot.from, rows: this.kind.rows(slot.copy), chars: slot.copy.chars, read: { ...slot.read }, checkedAt: slot.checkedAt, stale: slot.stale });
    return out;
  }

  private open(id: string): Slot<C> {
    const slot: Slot<C> = { copy: null, reading: null, checking: null, heard: [], stale: null, read: { at: 0, why: "" }, from: this.env.source.kind, checkedAt: 0, mark: null, written: new Map() };
    this.slots.set(id, slot);
    return slot;
  }

  private applied(copy: C, heard: Heard): string | null {
    return "stale" in heard ? heard.stale : this.kind.apply(copy, heard.name, heard.payload);
  }

  /** Holds the copy at its size: let go when it alone is larger than all the copy may keep. */
  private fit(id: string, slot: Slot<C>, used: boolean): Outcome {
    const chars = (slot.copy as C).chars;
    if (chars > this.env.memory.most()) {
      this.drop(id);
      this.large.set(id, chars);
      return { doubt: TOO_LARGE };
    }
    this.env.memory.hold(this, id, chars, used);
    return "again";
  }

  private read(id: string, slot: Slot<C>): Promise<Outcome> {
    const work = this.readNow(id, slot);
    slot.reading = work;
    return work;
  }

  private async readNow(id: string, slot: Slot<C>): Promise<Outcome> {
    const why = slot.stale ?? NOT_KEPT;
    const held = slot.copy;
    const at = this.env.now();
    let read: C | null | { refused: string };
    try {
      read = await this.kind.read(id, held);
    } catch (error) {
      slot.reading = null;
      // What was heard meanwhile is in Lumiverse's rows, which the next read takes whole.
      slot.heard = [];
      // Never kept, or let go meanwhile: nothing is left to keep a place for.
      if (slot.copy === null && this.slots.get(id) === slot) this.drop(id);
      this.env.noted(this.kind.what, id, why, `failed: ${words(error)}`);
      return { doubt: `${held === null ? "reading it" : "reading it again"} failed: ${words(error)}` };
    }
    // Set aside synchronously with taking what was heard, so nothing heard from here on waits for a read that already landed.
    slot.reading = null;
    // Deleted, or let go, while it was read: what was read isn't kept.
    if (this.slots.get(id) !== slot) return "again";
    if (read === null || "refused" in read) {
      this.drop(id);
      this.env.noted(this.kind.what, id, why, read === null ? "the user has none such" : `not kept: ${read.refused}`);
      return "none";
    }
    slot.copy = read;
    slot.stale = null;
    slot.read = { at, why };
    slot.from = this.env.source.kind;
    slot.checkedAt = at;
    // A write the runtime made before this read began is in it.
    for (const [row, when] of slot.written) if (when < at) slot.written.delete(row);
    const heard = slot.heard;
    slot.heard = [];
    for (const h of heard) {
      const again = this.applied(read, h);
      if (again === null) {
        this.told(slot, h);
        continue;
      }
      // What was heard after this is in Lumiverse's rows, which the next read takes whole.
      slot.stale = again;
      break;
    }
    const outcome = this.fit(id, slot, true);
    this.env.noted(this.kind.what, id, why, isDoubt(outcome) ? `not kept: ${outcome.doubt}` : "kept");
    return outcome;
  }

  private check(id: string, slot: Slot<C>): Promise<Outcome> {
    const work = this.checkNow(id, slot);
    slot.checking = work;
    return work;
  }

  private async checkNow(id: string, slot: Slot<C>): Promise<Outcome> {
    const copy = slot.copy as C;
    let found: string | null | typeof GONE;
    let mark: string | null;
    try {
      const changes = await this.env.source.changedSince(slot.mark);
      mark = changes.mark;
      found = changes.changed === false ? null : await this.kind.check(id, copy, changes.changed);
    } catch (error) {
      slot.checking = null;
      return { doubt: `the check before use failed: ${words(error)}` };
    }
    slot.checking = null;
    // Deleted, let go or read again meanwhile: whoever waits goes round again.
    if (this.slots.get(id) !== slot || slot.copy !== copy) return "again";
    if (found === GONE) {
      this.drop(id);
      return "none";
    }
    if (found !== null) {
      slot.stale ??= found;
      return "again";
    }
    slot.checkedAt = this.env.now();
    slot.mark = mark;
    return "again";
  }
}

/** The messages a host read gives for a range: all of them, `count` from the `from`th, or the last `tail`. */
function cut(messages: readonly SourceMessage[], range: { from: number; count: number } | { tail: number } | undefined): readonly SourceMessage[] {
  if (range === undefined) return messages;
  if ("tail" in range) return messages.slice(-Math.max(1, Math.min(TAIL_MOST, range.tail)));
  const from = Math.max(0, range.from);
  return messages.slice(from, from + Math.max(0, range.count));
}

/** The lore side of a host whose extension declines lore: none, as that host answers. */
const NO_LORE: LoreReads = {
  book: async () => null,
  entries: async () => [],
  entry: async () => null,
  record: async () => null,
  records: async () => [],
  global: async () => [],
  ofCharacter: async () => [],
  ofPersona: async () => null,
};

export function createHostCopy(deps: HostCopyDeps): HostCopy {
  const most = deps.keepChars ?? ((): number => KEEP_CHARS);
  const memory = new Memory(most);
  const reads: (CopyNote & { outcome: string })[] = [];
  const fallbacks: CopyNote[] = [];
  let fellBackTotal = 0;

  /** The mounting extension's entries on each chat's messages, where it keeps them elsewhere (`deps.own`): read once, kept until they change. */
  const owns = new Map<string, { map: ReadonlyMap<string, JsonValue> | null; reading: Promise<ReadonlyMap<string, JsonValue>> | null; turn: number }>();

  const note = <T>(list: T[], item: T): void => {
    list.push(item);
    if (list.length > NOTED) list.shift();
  };

  const env = (): ShelfEnv => ({
    source: deps.source,
    memory,
    checkMs: deps.checkMs ?? CHECK_MS,
    now: deps.now,
    noted(what, id, why, outcome) {
      note(reads, { at: deps.now(), what, id, why, outcome });
      if (outcome.startsWith("failed")) deps.log("warn", `[copy] reading ${what} ${id} (${why}) ${outcome}`);
    },
    dropped: () => undefined,
  });

  const chats = new Shelf<ChatCopy>(
    {
      what: "chat",
      async read(id) {
        const read = await deps.source.readChat(id);
        if (read === null) return null;
        if (read.owner !== deps.userId) return { refused: "it isn't the chat of the user the runtime is signed in as" };
        return chatCopyOf(read);
      },
      async check(id, copy) {
        const now = await deps.source.chatSignature(id);
        return now === null ? GONE : differs(signatureOf(copy), now);
      },
      apply: (copy, name, payload) => applyToChat(copy, name, payload, deps.identifier),
      rows: (copy) => copy.messages.length,
    },
    { ...env(), dropped: (id) => owns.delete(id) },
  );

  const books = new Shelf<BookCopy>(
    {
      what: "book",
      async read(id, held) {
        const read = await deps.source.readBook(id, held?.read ?? null);
        return read === null ? null : bookCopyOf(read);
      },
      async check(id, copy, changed) {
        // A source that can't tell keeps a book by its events alone: every change to a book's rows comes with one, and a gap in them (the link reopened) marks every book.
        if (changed === null) return null;
        const now = await deps.source.bookSignature(id, copy.read);
        if (now === null) return GONE;
        return now === copy.read.signature ? null : "the check before use found the book changed";
      },
      apply: applyToBook,
      rows: (copy) => copy.entries.length,
    },
    env(),
  );

  /** A read the copy can't vouch for, answered by the fallback, and not kept. */
  function fellBack<T>(what: "chat" | "book", id: string, why: string, viaLink: () => Promise<T>): Promise<T> {
    fellBackTotal++;
    note(fallbacks, { at: deps.now(), what, id, why });
    return viaLink();
  }

  /** The chat, current: the copy of it; null: the user has none such; text: why the copy can't answer. */
  async function chatNow(chatId: string, permission: string): Promise<ChatCopy | null | string> {
    if (!deps.granted(permission)) return notGranted(permission);
    const now = await chats.vouch(chatId);
    return isDoubt(now) ? now.doubt : now;
  }

  function ownOf(chatId: string): Promise<ReadonlyMap<string, JsonValue>> {
    const read = deps.own as (chatId: string) => Promise<ReadonlyMap<string, JsonValue>>;
    let held = owns.get(chatId);
    if (held === undefined) {
      held = { map: null, reading: null, turn: 0 };
      owns.set(chatId, held);
    }
    if (held.map !== null) return Promise.resolve(held.map);
    if (held.reading !== null) return held.reading;
    const mine = held;
    const turn = mine.turn;
    const reading = read(chatId).then(
      (map) => {
        // Kept only while nothing said they changed since they were asked for, and the chat is still kept.
        if (mine.turn === turn && owns.get(chatId) === mine) mine.map = map;
        if (mine.reading === reading) mine.reading = null;
        return map;
      },
      (error: unknown) => {
        if (mine.reading === reading) mine.reading = null;
        throw error;
      },
    );
    mine.reading = reading;
    return reading;
  }

  const chatReads: ChatReads = {
    async get(chatId, userId) {
      const viaLink = (): Promise<HostChat | null> => deps.fallback.chats.get(chatId, userId);
      if (userId !== deps.userId || chatId === "") return viaLink();
      const now = await chatNow(chatId, "chats");
      if (typeof now === "string") return fellBack("chat", chatId, now, viaLink);
      return now?.chat ?? null;
    },
    async messages(chatId, range) {
      const viaLink = (): Promise<HostMessage[]> => deps.fallback.chats.messages(chatId, range);
      if (chatId === "") return viaLink();
      const now = await chatNow(chatId, "chat_mutation");
      if (typeof now === "string") return fellBack("chat", chatId, now, viaLink);
      // Lumiverse refuses a read of a chat that isn't there: the extension's host says so in its own words.
      if (now === null) return fellBack("chat", chatId, "the user has no such chat", viaLink);
      const rows = cut(now.messages, range);
      if (deps.own === undefined) return rows.map((m) => m.row);
      let own: ReadonlyMap<string, JsonValue>;
      try {
        own = await ownOf(chatId);
      } catch (error) {
        return fellBack("chat", chatId, `the extension's own entries on its messages couldn't be read: ${words(error)}`, viaLink);
      }
      return rows.map((m) => ({ ...m.row, own: own.get(m.row.id) ?? null }));
    },
    async swipe(chatId, messageId, swipe) {
      const viaLink = (): Promise<string | null> => deps.fallback.chats.swipe(chatId, messageId, swipe);
      if (chatId === "") return viaLink();
      const now = await chatNow(chatId, "chat_mutation");
      if (typeof now === "string") return fellBack("chat", chatId, now, viaLink);
      if (now === null) return null;
      const message = now.byId.get(messageId);
      if (message === undefined) return null;
      const text = message.texts[swipe];
      if (typeof text === "string") return text;
      // Read lean, a message comes with the text of the swipe it shows alone.
      if (text === null) return fellBack("chat", chatId, "the copy holds only the shown swipe's text of that message", viaLink);
      // A message that lists no swipes has one: the text it shows.
      return message.texts.length === 0 && swipe === message.row.swipeId ? message.row.content : null;
    },
    list: (userId, offset, limit) => deps.fallback.chats.list(userId, offset, limit),
    characterName: (characterId, userId) => deps.fallback.chats.characterName(characterId, userId),
    sovereignHand: (chatId, userId) => deps.fallback.chats.sovereignHand(chatId, userId),
  };

  /** A read of a book the copy answers when it can vouch for the book; the fallback answers otherwise. */
  async function fromBook<T>(bookId: string, userId: string, answer: (copy: BookCopy | null) => T, viaLink: () => Promise<T>): Promise<T> {
    if (userId !== deps.userId || bookId === "") return viaLink();
    if (!deps.granted("world_books")) return fellBack("book", bookId, notGranted("world_books"), viaLink);
    const now = await books.vouch(bookId);
    if (isDoubt(now)) return fellBack("book", bookId, now.doubt, viaLink);
    return answer(now);
  }

  const loreReads: LoreReads = {
    book: (bookId, userId) => fromBook(bookId, userId, (copy) => (copy === null ? null : bookOnly(copy.book)), () => deps.fallback.lore.book(bookId, userId)),
    record: (bookId, userId) => fromBook(bookId, userId, (copy) => copy?.book ?? null, () => deps.fallback.lore.record(bookId, userId)),
    entries: (bookId, userId) => fromBook(bookId, userId, (copy) => (copy === null ? [] : copy.entries.map((e) => entryOnly(e.row))), () => deps.fallback.lore.entries(bookId, userId)),
    records: (bookId, userId) => fromBook(bookId, userId, (copy) => (copy === null ? [] : copy.entries.map((e) => e.row)), () => deps.fallback.lore.records(bookId, userId)),
    async entry(entryId, userId) {
      const viaLink = (): Promise<HostBookEntry | null> => deps.fallback.lore.entry(entryId, userId);
      if (userId !== deps.userId || !deps.granted("world_books")) return viaLink();
      let holder: string | null = null;
      for (const [id, copy] of books.held()) {
        if (!copy.byId.has(entryId)) continue;
        holder = id;
        break;
      }
      if (holder === null) return viaLink();
      const now = await books.vouch(holder);
      if (isDoubt(now)) return fellBack("book", holder, now.doubt, viaLink);
      const entry = now?.byId.get(entryId);
      return entry === undefined ? viaLink() : entryOnly(entry.row);
    },
    global: (userId) => deps.fallback.lore.global(userId),
    ofCharacter: (characterId, userId) => deps.fallback.lore.ofCharacter(characterId, userId),
    ofPersona: (personaId, userId) => deps.fallback.lore.ofPersona(personaId, userId),
  };

  const str = (o: unknown, key: string): string | null => (isRecord(o) && typeof o[key] === "string" && o[key] !== "" ? (o[key] as string) : null);

  function apply(event: LumiverseEvent): void {
    if (event.userId != null && event.userId !== deps.userId) return;
    const payload = isRecord(event.payload) ? event.payload : {};
    const heard: Heard = { name: event.name, payload };
    switch (event.name) {
      case "MESSAGE_SENT":
      case "MESSAGE_EDITED":
      case "MESSAGE_DELETED":
      case "MESSAGE_SWIPED":
      case "SWIPE_EDITED": {
        const chatId = str(payload, "chatId");
        if (chatId !== null) chats.hear(chatId, heard);
        return;
      }
      case "CHAT_CHANGED": {
        const chatId = str(payload.chat, "id") ?? str(payload, "chatId");
        if (chatId !== null) chats.hear(chatId, heard);
        return;
      }
      case "CHAT_DELETED": {
        const chatId = str(payload, "id") ?? str(payload, "chatId");
        if (chatId !== null) chats.drop(chatId);
        return;
      }
      case "CHAT_FORKED": {
        // The chat branched from is as it was; the branch is a new chat whose messages came with no event.
        const branch = str(payload, "forkedChatId");
        if (branch !== null) chats.hear(branch, { stale: BRANCHED });
        return;
      }
      case "WORLD_BOOK_CHANGED": {
        const bookId = str(payload, "id");
        if (bookId !== null) books.hear(bookId, heard);
        return;
      }
      case "WORLD_BOOK_DELETED": {
        const bookId = str(payload, "id");
        if (bookId !== null) books.drop(bookId);
        return;
      }
      case "WORLD_BOOK_ENTRY_CHANGED":
      case "WORLD_BOOK_ENTRY_DELETED": {
        const bookId = str(payload, "worldBookId") ?? str(payload.entry, "world_book_id");
        if (bookId !== null) books.hear(bookId, heard);
        return;
      }
      case "WORLD_BOOK_LIBRARY_CHANGED":
        books.hearAll({ stale: LIBRARY });
        return;
    }
  }

  return {
    chats: chatReads,
    lore: deps.declinesLore === true ? NO_LORE : loreReads,
    apply,
    reopened() {
      chats.hearAll({ stale: REOPENED });
      books.hearAll({ stale: REOPENED });
      for (const held of owns.values()) {
        held.map = null;
        held.reading = null;
        held.turn++;
      }
    },
    written: (chatId, messageId) => chats.wrote(chatId, messageId),
    ownChanged(chatId) {
      const held = owns.get(chatId);
      if (held === undefined) return;
      held.map = null;
      held.reading = null;
      held.turn++;
    },
    state: () => ({
      source: deps.source.kind,
      chars: { kept: memory.total, most: most() },
      chats: chats.state(),
      books: books.state(),
      reads: [...reads],
      fallbacks: { total: fellBackTotal, latest: [...fallbacks] },
    }),
  };
}
