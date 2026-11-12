// Where the runtime's copy of chat and lore reads from (PI-BUILD-PLAN §4.5, §4.6): Lumiverse's HTTP
// routes as the runtime's signed-in user (http.ts), and the database file read directly where the
// owner allows it. A source does four things: it reads a chat whole, it reads a world book whole, it
// says cheaply how either stands now, and, where it can, whether anything at all changed since it last
// said. When to ask is the copy's to decide (index.ts).
//
// Every row a source gives is already in the shape the extension's own host gives for the same
// Lumiverse row (`createSpindleHost`, rows.ts), so the copy never tells one source from another. A
// source reads only its user's rows: over HTTP the session decides whose, and a source that reads
// the file itself must scope every read to that user.

import type { HostBookRecord, HostChat, HostEntryRecord, HostMessage } from "../../host/rows";

/** A message as a source gives it: the row the extension's host gives, with what the copy keeps beside it. */
export interface SourceMessage {
  row: HostMessage;
  /**
   * Each swipe's text where the source gave it, by the swipe's place; null for one it didn't. A
   * lean read gives the shown swipe's text alone, an event gives every one.
   */
  texts: readonly (string | null)[];
  /** Lumiverse's revision of the message where the source says it: news of an older revision than the one held is older news. */
  revision: number | null;
}

/** A chat read whole. */
export interface SourceChat {
  chat: HostChat;
  /** Whose chat it is, as Lumiverse keeps it; null where the source didn't say. The copy keeps only its own user's. */
  owner: string | null;
  /** When Lumiverse last changed the chat itself, as it stamps it; null where the source didn't say. */
  updatedAt: number | null;
  /** Every message, in chat order. */
  messages: SourceMessage[];
  /**
   * The source's own fingerprint of the whole chat as read, where it can make one that shows what
   * Lumiverse changes without an event anywhere in a chat (the database reader: its revisions and the
   * length of its messages' extras). HTTP makes none.
   */
  fingerprint?: string;
}

/** An entry as a source gives it: the row the extension's host gives, and Lumiverse's revision of it. */
export interface SourceEntry {
  row: HostEntryRecord;
  /** Lumiverse's revision of the entry where the source says it: news of an older revision than the one held is older news. */
  revision: number | null;
}

/** A world book read whole. */
export interface SourceBook {
  book: HostBookRecord;
  /** Every entry, in the book's order. */
  entries: SourceEntry[];
  /** The book's signature as read (over HTTP, Lumiverse's ETag for it); null where the source gave none. */
  signature: string | null;
}

/** How a chat stands now, cheaply: how many messages it has, and its newest one as the host gives it. */
export interface ChatSignature {
  count: number;
  /** A message at the chat's newest place: where two share it, whichever the source's own rule picks (Lumiverse's tail picks the greater id). */
  last: HostMessage | null;
  /** The chat's own row now, where the source reads it for the signature: Lumiverse writes some keys of a chat's metadata with no event. */
  chat?: HostChat;
  /** The chat's fingerprint now, as `SourceChat.fingerprint`: another than the one read has the chat read again. */
  fingerprint?: string;
}

/** Whether anything a source reads changed since a mark it gave. */
export interface SourceChanges {
  /** True: something may have; false: nothing did; null: the source can't tell (HTTP can't). */
  changed: boolean | null;
  /** Where the source stands now, to be given back next time; null where it can't tell. */
  mark: string | null;
}

/**
 * The source can't answer a read: one of its routes answered other than as the source expects (a
 * status it doesn't take for an answer, "not found" among them, or a body it can't read), or the
 * source asks that route nothing for a while because it kept doing so. Lumiverse's HTTP routes are no
 * interface it promises to keep, so such an answer says nothing of the chat or the book: the read goes
 * to the fallback, whose answer alone may say there is no such one.
 */
export class Unanswered extends Error {
  constructor(
    /** The route, as `GET /api/v1/chats/:id`. */
    readonly route: string,
    /** What it answered: its status (200 for a body the source can't read). */
    readonly status: number,
    /** Until when the source asks that route nothing; null: it asks it again at the next read. */
    readonly until: number | null,
    message: string,
  ) {
    super(message);
    this.name = "Unanswered";
  }
}

export interface CopySource {
  /** Where its rows come from, in the words the copy's state uses: `http`, `database`. */
  readonly kind: string;
  /**
   * The chat read whole; null when the user has no such chat, which only a source that reads
   * Lumiverse's own tables may say (the database reader). Rejects when it can't be read whole and
   * consistent, and with `Unanswered` where a route didn't answer as expected.
   */
  readChat(chatId: string): Promise<SourceChat | null>;
  /**
   * The book read whole; null when the user has no such book, as `readChat` says. Rejects when it
   * can't be read whole and consistent. `held` is the copy's last read of it: a source that can tell
   * for certain the book is still as held answers with `held` itself. HTTP can't (Lumiverse's ETag
   * misses some writes), so it always reads.
   */
  readBook(bookId: string, held: SourceBook | null): Promise<SourceBook | null>;
  /** How the chat stands now; null when the user has no such chat, as `readChat` says. */
  chatSignature(chatId: string): Promise<ChatSignature | null>;
  /**
   * The book's signature now, to compare with `SourceBook.signature`; null when the user has no such
   * book, as `readChat` says. `held` lets a source answer without reading the book again. Asked only
   * of a source whose `changedSince` can tell: the copy takes it as its word that every row of the
   * book is as held.
   */
  bookSignature(bookId: string, held: SourceBook | null): Promise<string | null>;
  /**
   * Whether anything this source reads may have changed since `mark` (null: since nothing). Cheap:
   * asked before a kept chat or book is used. A source that can't tell (null) has a kept book read
   * whole again instead of checked, as no cheap answer of its can vouch for every row of a book.
   */
  changedSince(mark: string | null): Promise<SourceChanges>;
}
