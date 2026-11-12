// The runtime's copy of chat and lore (PI-BUILD-PLAN §4.5): the read side of the extension's own host
// ports for chats and world books (`BackendHost["chats"]`, `["lore"]`), answered from rows kept in the
// runtime, in the very shapes that host gives, so the backend's path, range and recall logic can run
// here over it unchanged.
//
// A chat or a book is read whole from the source the first time it is wanted; after that Lumiverse's
// events, as the extension forwards them, keep it current. It is read again, never patched by guess:
// when the link to the extension went down or reopened (events may have been missed), when a message
// was put in before others (every later one moved, and Lumiverse tells of none of them), when a book
// changed as a whole, when an event says something the copy can't apply, and when the cheap check
// before use finds the chat not as held. Over HTTP that check sees the chat's count, its newest message
// and its own row, which catches what Lumiverse changes without an event at a chat's end and in its
// metadata; a change without an event to an older message stays unseen until the chat is read again,
// and the state says so of each chat. A book is never kept on events alone where the source can't say
// whether it changed (HTTP): Lumiverse changes some entries with no event, so a book is read whole
// again once the check's time has passed. While the link is down, a chat whose check can't see all of
// it is read whole again instead of checked. A read that comes while a chat is being read waits for
// that read, and an event that comes meanwhile is applied to it once it lands, in order, once.
//
// Whatever the copy can't vouch for goes to the fallback (the extension's own host, over the link), and
// that answer isn't kept: a chat not read yet while the source is down, a read or a check that failed
// or was given up for want of an answer, a chat too large to keep, a read the extension itself may not
// make (the user didn't grant the permission Lumiverse puts it under: the copy reads with the user's
// own session, which nothing gates). So does a read a route of the source didn't answer as the source
// expects (`Unanswered`): Lumiverse's HTTP routes are no interface it promises to keep, so their "not
// found" says nothing of a chat or a book, which only the fallback may say isn't there; the state
// counts those apart, by route and what it answered. What the copy doesn't keep at all goes to the
// fallback as well: the user's list of chats, a character's name, Sovereign Hand, which books a
// character, a persona or every chat has, and an entry of a book it doesn't hold.
//
// One user's rows only: the session the source reads with decides whose, an event that names another
// user is passed over, and a chat whose owner isn't the session's user is never kept.

import type { JsonValue, LogLevel } from "../../core/ports";
import type { ChatReads, HostBookEntry, HostChat, HostMessage, HostReads, LoreReads } from "../../host/rows";
import { isRecord } from "../../link/json";
import { applyToBook, applyToChat, type BookCopy, bookCopyOf, type ChatCopy, chatCopyOf, differs, type Heard, sightOf, tailOf } from "./kept";
import { bookOnly, entryOnly } from "./rows";
import { type CopySource, type SourceMessage, Unanswered } from "./source";

export type { ChatReads, HostReads, LoreReads } from "../../host/rows";

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
  /**
   * How long a check before use holds, in ms: a chat or a book checked or read no longer ago than that
   * is used as held. A book from a source that can't say whether it changed (HTTP) is read whole again
   * once it has passed, as that source has no cheaper word on it. `CHECK_MS` when not set.
   */
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
  /**
   * What that last word from the source looked at (a read whole, or the check before use), and what it
   * could not see, which only events told of since: null when it saw all a reader is given.
   */
  check: { saw: string; missed: string | null };
  /** Why it is to be read again before it is next used; null: it is current. */
  stale: string | null;
}

export interface CopyNote {
  at: number;
  what: "chat" | "book";
  id: string;
  why: string;
}

/** A read sent to the fallback because a route of the source didn't answer as the source expects: which route, what it answered, and until when the source asks it nothing (null: it asks it again at the next read). */
export interface RouteNote extends CopyNote {
  route: string;
  status: number;
  until: number | null;
}

export interface CopyState {
  source: string;
  chars: { kept: number; most: number };
  chats: KeptState[];
  books: KeptState[];
  /** The chats and books found larger than all the copy may keep, at the size they were: answered by the fallback until the copy may keep that much. */
  tooLarge: { chats: { id: string; chars: number }[]; books: { id: string; chars: number }[] };
  /** The latest reads whole, the newest last: of what, why, and how each ended. */
  reads: (CopyNote & { outcome: string })[];
  /** Reads that went to the fallback because the copy couldn't vouch for its answer: how many in all, and the latest, the newest last. Those a route of the source's didn't answer as expected are under `routes` instead. */
  fallbacks: { total: number; latest: CopyNote[] };
  /** Reads that went to the fallback because a route of the source's didn't answer as the source expects (Lumiverse's routes are no interface it promises to keep): how many in all, and the latest, the newest last. */
  routes: { total: number; latest: RouteNote[] };
}

export interface HostCopy {
  readonly chats: ChatReads;
  readonly lore: LoreReads;
  /** One of Lumiverse's events, as the extension forwarded it, in the order Lumiverse sent them. */
  apply(event: LumiverseEvent): void;
  /** The link to the extension reopened: events may have been missed, so everything kept is read again before it is next used. */
  reopened(): void;
  /**
   * The link to the extension went down: from now on no event tells of a change, so everything kept is
   * read again before it is next used, and until the link reopens a chat is read whole again (not
   * checked) whenever its check before use is due, unless its source's check sees all of it.
   */
  closed(): void;
  /**
   * Something the extension told the copy never came (a number missing among its pushes): events may
   * have been missed, so everything kept is read again before it is next used. The link stays up.
   */
  lost(): void;
  /** The mounting extension's own entries on a chat's messages changed (`own`). */
  ownChanged(chatId: string): void;
  /**
   * The runtime wrote on a message through the link (a turn's record): until Lumiverse tells of that
   * write, or a read begun after it lands, the chat is the fallback's to answer, so a read never misses
   * the runtime's own write. `landed` says whether the message's own entry, as kept, already holds what
   * was written: Lumiverse's word of the write may have come before the link's answer, and then the
   * copy vouches for the chat at once.
   */
  written(chatId: string, messageId: string, landed?: (own: JsonValue | null) => boolean): void;
  /**
   * A run begins on the chat: its next use is checked against the source first, however recently it
   * was, so a message sent just before the run is in what the run reads even when Lumiverse's event of
   * it is still on its way (the check before a run). One not kept is read whole anyway.
   */
  due(chatId: string): void;
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
const CLOSED = "the link to the extension went down, so events may have been missed";
const LOST = "something the extension told the runtime never came, so events may have been missed";
const STILL_DOWN = "the link to the extension is down, so nothing tells of a change the check before use can't see";
const UNTOLD_BOOK = "Lumiverse changes some of a book's rows with no event, and the source can't say whether it did without reading the book";
const LIBRARY = "Lumiverse changed the library of world books";
const BRANCHED = "it was made as a branch of another chat";
const TOO_LARGE = "it is larger than all the copy may keep";
const AWAITED = "the runtime wrote on it, and Lumiverse hasn't told of that write yet";
const UNHEARD = "Lumiverse never told of a write the runtime made on it";
/** What a read whole sees: everything, as it was then. */
const READ_WHOLE = { saw: "all of it, read whole", missed: null };
/** What a source that said nothing changed since its last check vouches for. */
const UNCHANGED = { saw: "the source's word that nothing it reads changed since its last check", missed: null };
/** How long a write the runtime made through the link may go untold before the chat is read again instead. */
const WRITE_WAIT_MS = 2_000;
const notGranted = (permission: string): string => `the extension isn't granted the "${permission}" permission, so Lumiverse wouldn't give it this`;
const words = (error: unknown): string => (error instanceof Error ? error.message : String(error));

/** Why the copy can't answer a read; with the route that didn't answer as the source expects, where that is why. */
type Doubt = { doubt: string; route?: { route: string; status: number; until: number | null } };
/** How waiting on a read or a check ended: go round again, the user has none such, or a doubt. */
type Outcome = "again" | "none" | Doubt;

const isDoubt = (value: unknown): value is Doubt => isRecord(value) && typeof value.doubt === "string";

/** A read or a check that failed, as a doubt: words, and the route where one didn't answer as the source expects. */
function failed(words: string, error: unknown): Doubt {
  return error instanceof Unanswered ? { doubt: words, route: { route: error.route, status: error.status, until: error.until } } : { doubt: words };
}

/** The source says the user has no such chat or book now. */
const GONE = Symbol("gone");

/** What a check before use found: the kept one current (what the check saw), why it is to be read again, or that the user has none such now. */
type Checked = { saw: string; missed: string | null } | { stale: string } | typeof GONE;

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
  /** What the last read or check that found it current saw, and what it couldn't. */
  check: { saw: string; missed: string | null };
  /** Where the source stood at the last check that found it current. */
  mark: string | null;
  /** The rows the runtime wrote on through the link, untold of yet: when, and what says the row as kept holds the write (null: nothing can tell but Lumiverse's word of it). */
  written: Map<string, { at: number; landed: ((own: JsonValue | null) => boolean) | null }>;
  /** Set (the number of the `due` that set it) when a run began on it: its next use checks it first; 0 when none waits. */
  due: number;
}

/** What tells a kept chat from a kept book. */
interface Kind<C> {
  what: "chat" | "book";
  /** It read whole and made a copy; null when the user has none such; `refused`: why it isn't to be kept. */
  read(id: string, held: C | null): Promise<C | null | { refused: string }>;
  /**
   * Whether a kept one is still as the source has it. `changed` is the source's own word on whether
   * anything changed (false never reaches here); `down`: the link to the extension is down, so no
   * event tells of what the check can't see.
   */
  check(id: string, copy: C, changed: boolean | null, down: boolean): Promise<Checked>;
  apply(copy: C, name: string, payload: Record<string, unknown>): string | null;
  rows(copy: C): number;
  /** Whether the copy holds a row whose own entry `landed` says holds a write of the runtime's. */
  holds(copy: C, row: string, landed: (own: JsonValue | null) => boolean): boolean;
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
  /** Whether the link to the extension is down: no event comes until it reopens. */
  down(): boolean;
  /** A read whole ended: what it was of, why it was made, and how it ended; `route`: it failed because a route of the source didn't answer as expected, which the state counts apart. */
  noted(what: "chat" | "book", id: string, why: string, outcome: string, route?: boolean): void;
  /** One is no longer kept: deleted, let go, or found not the user's. */
  dropped(id: string): void;
}

/** The kept chats, or the kept books: their reads, checks, events and memory. */
class Shelf<C extends { chars: number }> {
  readonly slots = new Map<string, Slot<C>>();
  /** The ones found larger than all the copy may keep, at the size they were. */
  private readonly large = new Map<string, number>();
  /** How many times a run began on one of them (`due`): a read or a check begun after the latest that set a slot's `due` clears it. */
  private dues = 0;

  constructor(
    private readonly kind: Kind<C>,
    private readonly env: ShelfEnv,
  ) {}

  get what(): "chat" | "book" {
    return this.kind.what;
  }

  /** The copy, current: read whole or checked as needed. Null: the user has none such. A doubt: the copy can't vouch for it now. */
  async vouch(id: string): Promise<C | null | Doubt> {
    // Set once a read or a check this call waited on found it current: used then as it is, however long that took.
    let fresh = false;
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
        if (slot.due === 0 && (fresh || this.env.now() - slot.checkedAt < this.env.checkMs)) {
          this.env.memory.used(this, id);
          return slot.copy;
        }
        outcome = await this.check(id, slot);
      } else outcome = await this.read(id, slot ?? this.open(id));
      if (outcome === "none") return null;
      if (isDoubt(outcome)) return outcome;
      fresh = true;
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

  /**
   * The runtime wrote on a row of it through the link: until Lumiverse tells of that write, or a read
   * begun after it lands, the fallback answers for it. Where the row as kept already holds the write
   * (Lumiverse's word of it came before the link's answer), nothing waits.
   */
  wrote(id: string, row: string, landed: ((own: JsonValue | null) => boolean) | null): void {
    const slot = this.slots.get(id);
    if (slot === undefined) return;
    if (landed !== null && slot.reading === null && slot.copy !== null && slot.stale === null && this.kind.holds(slot.copy, row, landed)) {
      slot.written.delete(row);
      return;
    }
    slot.written.set(row, { at: this.env.now(), landed });
  }

  /** A run begins on it: its next use checks it first, whenever it was last found current. Set while its first read is under way too: that read may have begun before what the run must see, and it answers the run only where it began after this. */
  due(id: string): void {
    const slot = this.slots.get(id);
    if (slot !== undefined) slot.due = ++this.dues;
  }

  /** Why a kept one can't be answered from for a write of the runtime's own not told of yet; null when it can. A write the row as kept holds is told of; one untold of for too long has it read again. */
  private awaited(slot: Slot<C>): string | null {
    if (slot.written.size === 0) return null;
    const now = this.env.now();
    const copy = slot.copy as C;
    for (const [row, write] of slot.written) {
      if (write.landed !== null && this.kind.holds(copy, row, write.landed)) {
        slot.written.delete(row);
        continue;
      }
      if (now - write.at < WRITE_WAIT_MS) continue;
      slot.written.clear();
      slot.stale = UNHEARD;
      return null;
    }
    return slot.written.size === 0 ? null : AWAITED;
  }

  /**
   * An event applied: a write of the runtime's own on its row is heard. Where what was written can be
   * told, only the row holding it says so: Lumiverse's word of an earlier change to the row (the reply
   * saved, before the record was written on it) is no word of the write.
   */
  private told(slot: Slot<C>, heard: Heard): void {
    const row = rowOf(heard);
    if (row === null) return;
    const write = slot.written.get(row);
    if (write !== undefined && (write.landed === null || (slot.copy !== null && this.kind.holds(slot.copy, row, write.landed)))) slot.written.delete(row);
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
    for (const [id, slot] of this.slots) if (slot.copy !== null) out.push({ id, from: slot.from, rows: this.kind.rows(slot.copy), chars: slot.copy.chars, read: { ...slot.read }, checkedAt: slot.checkedAt, check: { ...slot.check }, stale: slot.stale });
    return out;
  }

  /** The ones found larger than all the copy may keep, at the size they were: their reads go to the fallback until the copy may keep that much. */
  tooLarge(): { id: string; chars: number }[] {
    return [...this.large].map(([id, chars]) => ({ id, chars }));
  }

  private open(id: string): Slot<C> {
    const slot: Slot<C> = { copy: null, reading: null, checking: null, heard: [], stale: null, read: { at: 0, why: "" }, from: this.env.source.kind, checkedAt: 0, check: READ_WHOLE, mark: null, written: new Map(), due: 0 };
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
    const asOf = this.dues;
    let read: C | null | { refused: string };
    try {
      read = await this.kind.read(id, held);
    } catch (error) {
      slot.reading = null;
      // What was heard meanwhile is in Lumiverse's rows, which the next read takes whole.
      slot.heard = [];
      // Never kept, or let go meanwhile: nothing is left to keep a place for.
      if (slot.copy === null && this.slots.get(id) === slot) this.drop(id);
      this.env.noted(this.kind.what, id, why, `failed: ${words(error)}`, error instanceof Unanswered);
      return failed(`${held === null ? "reading it" : "reading it again"} failed: ${words(error)}`, error);
    }
    // Set aside synchronously with taking what was heard, so nothing heard from here on waits for a read that already landed.
    slot.reading = null;
    // Deleted, or let go, while it was read: what was read isn't kept.
    if (this.slots.get(id) !== slot) return "again";
    if (read === null || "refused" in read) {
      this.drop(id);
      this.env.noted(this.kind.what, id, why, read === null ? "the user has none such" : `not kept: ${read.refused}`);
      // Only the source's own word that there is none such says so; one it read but won't keep is the fallback's to answer.
      return read === null ? "none" : { doubt: read.refused };
    }
    slot.copy = read;
    slot.stale = null;
    slot.read = { at, why };
    slot.from = this.env.source.kind;
    slot.checkedAt = at;
    slot.check = READ_WHOLE;
    // A run that began before this read did is answered by it.
    if (slot.due <= asOf) slot.due = 0;
    // A write the runtime made before this read began is in it.
    for (const [row, write] of slot.written) if (write.at < at) slot.written.delete(row);
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
    let found: Checked;
    let mark: string | null;
    const asOf = this.dues;
    try {
      const changes = await this.env.source.changedSince(slot.mark);
      mark = changes.mark;
      found = changes.changed === false ? UNCHANGED : await this.kind.check(id, copy, changes.changed, this.env.down());
    } catch (error) {
      slot.checking = null;
      return failed(`the check before use failed: ${words(error)}`, error);
    }
    slot.checking = null;
    // Deleted, let go or read again meanwhile: whoever waits goes round again.
    if (this.slots.get(id) !== slot || slot.copy !== copy) return "again";
    if (found === GONE) {
      this.drop(id);
      return "none";
    }
    if ("stale" in found) {
      slot.stale ??= found.stale;
      return "again";
    }
    slot.checkedAt = this.env.now();
    slot.check = found;
    slot.mark = mark;
    if (slot.due <= asOf) slot.due = 0;
    return "again";
  }
}

/** The messages a host read gives for a range: all of them, `count` from the `from`th, or the last `tail` (picked and listed as the host's tail is). */
function cut(messages: readonly SourceMessage[], range: { from: number; count: number } | { tail: number } | undefined): readonly SourceMessage[] {
  if (range === undefined) return messages;
  if ("tail" in range) return tailOf(messages, Math.max(1, Math.min(TAIL_MOST, range.tail)));
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
  const unanswered: RouteNote[] = [];
  let unansweredTotal = 0;
  /** The link to the extension is down: `closed()` until `reopened()`. */
  let down = false;

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
    down: () => down,
    noted(what, id, why, outcome, route) {
      note(reads, { at: deps.now(), what, id, why, outcome });
      // A route that didn't answer as expected is logged where the state's count of them starts again (`fellBack`), not at every read it fails.
      if (outcome.startsWith("failed") && route !== true) deps.log("warn", `[copy] reading ${what} ${id} (${why}) ${outcome}`);
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
      async check(id, copy, _changed, linkDown) {
        // Only events tell of a change the check can't see (one to an older message, where the source makes no fingerprint): with none coming, the chat is read whole instead.
        if (linkDown && copy.fingerprint === null) return { stale: STILL_DOWN };
        const now = await deps.source.chatSignature(id);
        if (now === null) return GONE;
        const why = differs(copy, now);
        return why === null ? sightOf(now) : { stale: why };
      },
      apply: (copy, name, payload) => applyToChat(copy, name, payload, deps.identifier),
      rows: (copy) => copy.messages.length,
      holds(copy, row, landed) {
        const message = copy.byId.get(row);
        return message !== undefined && landed(message.row.own);
      },
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
        // Lumiverse changes some of a book's rows with no event (an entry's extensions written by namespace, `vectorized` set by converting the book or by a data import), and a source that can't say whether anything changed (HTTP: Lumiverse's ETag misses some writes) has no cheap word that sees them: the book is read whole again.
        if (changed === null) return { stale: UNTOLD_BOOK };
        const now = await deps.source.bookSignature(id, copy.read);
        if (now === null) return GONE;
        return now === copy.read.signature ? { saw: "the source's signature of the whole book", missed: null } : { stale: "the check before use found the book changed" };
      },
      apply: applyToBook,
      rows: (copy) => copy.entries.length,
      // The runtime writes on no book.
      holds: () => false,
    },
    env(),
  );

  /** A read the copy can't vouch for, answered by the fallback, and not kept: counted apart where a route of the source didn't answer as expected. */
  function fellBack<T>(what: "chat" | "book", id: string, why: string | Doubt, viaLink: () => Promise<T>): Promise<T> {
    const at = deps.now();
    if (typeof why === "string" || why.route === undefined) {
      fellBackTotal++;
      note(fallbacks, { at, what, id, why: typeof why === "string" ? why : why.doubt });
      return viaLink();
    }
    const { route, status, until } = why.route;
    const before = unanswered.at(-1);
    if (before === undefined || before.route !== route || before.status !== status) deps.log("warn", `[copy] Lumiverse's ${route} answered ${status}, which the copy doesn't take for an answer, so its reads go to the extension instead: ${why.doubt}`);
    unansweredTotal++;
    note(unanswered, { at, what, id, why: why.doubt, route, status, until });
    return viaLink();
  }

  /** The chat, current: the copy of it; null: the user has none such; a doubt: why the copy can't answer. */
  async function chatNow(chatId: string, permission: string): Promise<ChatCopy | null | Doubt> {
    if (!deps.granted(permission)) return { doubt: notGranted(permission) };
    return chats.vouch(chatId);
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
      if (isDoubt(now)) return fellBack("chat", chatId, now, viaLink);
      return now?.chat ?? null;
    },
    async messages(chatId, range) {
      const viaLink = (): Promise<HostMessage[]> => deps.fallback.chats.messages(chatId, range);
      if (chatId === "") return viaLink();
      const now = await chatNow(chatId, "chat_mutation");
      if (isDoubt(now)) return fellBack("chat", chatId, now, viaLink);
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
      if (isDoubt(now)) return fellBack("chat", chatId, now, viaLink);
      if (now === null) return null;
      const message = now.byId.get(messageId);
      if (message === undefined) return null;
      const text = message.texts[swipe];
      // The shown swipe's slot is taken as that swipe's text only where it is the message's text too.
      if (typeof text === "string" && (swipe !== message.row.swipeId || text === message.row.content)) return text;
      // Where they differ, a lean row can't tell an edit that drifted them apart from swipes stored as JSON text (its slot holds one letter), and the host answers either from the whole row.
      if (typeof text === "string") return fellBack("chat", chatId, "its shown swipe's text differs from the message's text, and only the whole row says which the host gives", viaLink);
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
    if (isDoubt(now)) return fellBack("book", bookId, now, viaLink);
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
      if (isDoubt(now)) return fellBack("book", holder, now, viaLink);
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

  /** Events may have been missed: everything kept is read again before it is next used, and the mounting extension's own entries are asked for again. */
  function missed(why: string): void {
    chats.hearAll({ stale: why });
    books.hearAll({ stale: why });
    for (const held of owns.values()) {
      held.map = null;
      held.reading = null;
      held.turn++;
    }
  }

  return {
    chats: chatReads,
    lore: deps.declinesLore === true ? NO_LORE : loreReads,
    apply,
    reopened() {
      down = false;
      missed(REOPENED);
    },
    closed() {
      down = true;
      missed(CLOSED);
    },
    lost: () => missed(LOST),
    written: (chatId, messageId, landed) => chats.wrote(chatId, messageId, landed ?? null),
    due: (chatId) => chats.due(chatId),
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
      tooLarge: { chats: chats.tooLarge(), books: books.tooLarge() },
      reads: [...reads],
      fallbacks: { total: fellBackTotal, latest: [...fallbacks] },
      routes: { total: unansweredTotal, latest: [...unanswered] },
    }),
  };
}
