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

import type { HostBookRecord, HostChat, HostEntryRecord, HostMessage } from "../../extension/backend/spindle";

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
  last: HostMessage | null;
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

export interface CopySource {
  /** Where its rows come from, in the words the copy's state uses: `http`, `database`. */
  readonly kind: string;
  /** The chat read whole; null when the user has no such chat. Rejects when it can't be read whole and consistent. */
  readChat(chatId: string): Promise<SourceChat | null>;
  /**
   * The book read whole; null when the user has no such book. `held` is the copy's last read of it:
   * a source that can tell the book is still as held answers with `held` itself.
   */
  readBook(bookId: string, held: SourceBook | null): Promise<SourceBook | null>;
  /** How the chat stands now; null when the user has no such chat. */
  chatSignature(chatId: string): Promise<ChatSignature | null>;
  /** The book's signature now, to compare with `SourceBook.signature`; null when the user has no such book. `held` lets a source answer without reading the book again. */
  bookSignature(bookId: string, held: SourceBook | null): Promise<string | null>;
  /** Whether anything this source reads may have changed since `mark` (null: since nothing). Cheap: asked before a kept chat or book is used. */
  changedSince(mark: string | null): Promise<SourceChanges>;
}
