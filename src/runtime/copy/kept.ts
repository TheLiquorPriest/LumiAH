// A chat and a world book as the runtime's copy keeps them, and what one of Lumiverse's events does to
// each (PI-BUILD-PLAN §4.5). An event is applied only where what it says is certain: a message comes
// whole in every message event, an entry whole in its event. Where it isn't (a message put in before
// others, which moves every later one with no word of them; a change to a message the copy doesn't
// hold; a book changed as a whole), the answer is why the chat or the book is to be read again, and
// nothing is applied.
//
// Lumiverse's events and the copy's reads travel different roads (the events through the extension,
// the reads straight to Lumiverse), so an event may tell of a change a read already holds. Applied
// again, a message or an entry would go back to what it was before: one whose revision is older than
// the one held is left as it is.

import type { HostBookRecord, HostChat } from "../../extension/backend/spindle";
import { isRecord } from "../../link/json";
import { chatOf, entryChars, entryOf, jsonChars, messageChars, messageOf, sameMessage } from "./rows";
import type { ChatSignature, SourceBook, SourceChat, SourceEntry, SourceMessage } from "./source";

/** What was heard about a kept chat or book: one of Lumiverse's events, or a reason of the copy's own to read it again. */
export type Heard = { name: string; payload: Record<string, unknown> } | { stale: string };

export interface ChatCopy {
  chat: HostChat;
  /** When Lumiverse last changed the chat itself; news of the chat older than that is older news. */
  updatedAt: number | null;
  /** The source's fingerprint of the chat as read; null where it makes none. */
  fingerprint: string | null;
  /** In chat order. */
  messages: SourceMessage[];
  byId: Map<string, SourceMessage>;
  chars: number;
}

export interface BookCopy {
  /** The book as the source last read it whole: a later read hands it back, and the source answers with it when the book is still so. */
  read: SourceBook;
  book: HostBookRecord;
  /** In the book's order: by `order`, then by id, as Lumiverse lists them. */
  entries: SourceEntry[];
  byId: Map<string, SourceEntry>;
  chars: number;
}

export const INSERTED = "a message was put in before others, which moves every later one, and Lumiverse tells of none of them";

const chatChars = (chat: HostChat): number => chat.name.length + jsonChars(chat.metadata);

const bookChars = (book: HostBookRecord): number => book.name.length + book.description.length + jsonChars(book.metadata);

export function chatCopyOf(read: SourceChat): ChatCopy {
  // In the host's order: by the place in the chat, two at one place as Lumiverse listed them.
  const messages = [...read.messages].sort((a, b) => a.row.index - b.row.index);
  let chars = chatChars(read.chat);
  for (const m of messages) chars += messageChars(m);
  return { chat: read.chat, updatedAt: read.updatedAt, fingerprint: read.fingerprint ?? null, messages, byId: new Map(messages.map((m) => [m.row.id, m])), chars };
}

export function bookCopyOf(read: SourceBook): BookCopy {
  let chars = bookChars(read.book);
  for (const e of read.entries) chars += entryChars(e.row);
  return { read, book: read.book, entries: [...read.entries], byId: new Map(read.entries.map((e) => [e.row.id, e])), chars };
}

/** How the kept chat stands, as a source says how a chat stands: its fingerprint the one it was read with. */
export function signatureOf(copy: ChatCopy): ChatSignature {
  return { count: copy.messages.length, last: copy.messages.at(-1)?.row ?? null, ...(copy.fingerprint !== null ? { fingerprint: copy.fingerprint } : {}) };
}

/**
 * How the source's word on a chat differs from the copy's, in words; null when it doesn't. A
 * fingerprint changes with what events told of too, so a chat it is compared on is read again after
 * any change: a source makes one only where a read costs little.
 */
export function differs(held: ChatSignature, now: ChatSignature): string | null {
  if (held.count !== now.count) return `the check before use found ${now.count} messages in the chat where the copy holds ${held.count}`;
  if (held.last === null || now.last === null) {
    if (held.last !== now.last) return "the check before use found another newest message";
  } else if (!sameMessage(held.last, now.last)) return held.last.id === now.last.id ? "the check before use found the newest message changed with no word from Lumiverse" : "the check before use found another newest message";
  if (now.fingerprint !== undefined && now.fingerprint !== held.fingerprint) return "the check before use found the chat changed since it was read";
  return null;
}

/** The place of a held message in the chat, found by its place number first. */
function placeOf(messages: readonly SourceMessage[], held: SourceMessage): number {
  let low = 0;
  let high = messages.length;
  while (low < high) {
    const mid = (low + high) >> 1;
    if ((messages[mid] as SourceMessage).row.index < held.row.index) low = mid + 1;
    else high = mid;
  }
  for (let at = low; at < messages.length && (messages[at] as SourceMessage).row.index === held.row.index; at++) if (messages[at] === held) return at;
  return messages.indexOf(held);
}

/** A held message as an event now gives it whole; why the chat is to be read again where that can't be done. */
function replaced(copy: ChatCopy, held: SourceMessage, now: SourceMessage): string | null {
  if (now.row.index !== held.row.index) return "a message changed its place in the chat";
  if (held.revision !== null && now.revision !== null && now.revision < held.revision) return null;
  copy.messages[placeOf(copy.messages, held)] = now;
  copy.byId.set(now.row.id, now);
  copy.chars += messageChars(now) - messageChars(held);
  return null;
}

/** Applies a chat event to a kept chat: null when it is applied (or there is nothing to apply), else why the chat is to be read again. */
export function applyToChat(copy: ChatCopy, name: string, payload: Record<string, unknown>, identifier: string): string | null {
  switch (name) {
    case "MESSAGE_DELETED": {
      const id = payload.messageId;
      if (typeof id !== "string") return "an event of a deleted message named no message";
      const held = copy.byId.get(id);
      // A message the copy doesn't hold is gone from it already.
      if (held === undefined) return null;
      copy.messages.splice(placeOf(copy.messages, held), 1);
      copy.byId.delete(id);
      copy.chars -= messageChars(held);
      return null;
    }
    case "MESSAGE_SENT": {
      if (payload.inserted === true) return INSERTED;
      const message = messageOf(payload.message, identifier);
      if (message === null) return "an event of a sent message carried no message the copy could read";
      const held = copy.byId.get(message.row.id);
      if (held !== undefined) return replaced(copy, held, message);
      const last = copy.messages.at(-1);
      if (last !== undefined && message.row.index <= last.row.index) return "a message was added among the others, not after them";
      copy.messages.push(message);
      copy.byId.set(message.row.id, message);
      copy.chars += messageChars(message);
      return null;
    }
    case "MESSAGE_EDITED":
    case "MESSAGE_SWIPED":
    case "SWIPE_EDITED": {
      const message = messageOf(payload.message, identifier);
      if (message === null) return "an event of a changed message carried no message the copy could read";
      const held = copy.byId.get(message.row.id);
      if (held === undefined) return "Lumiverse changed a message the copy doesn't hold";
      return replaced(copy, held, message);
    }
    case "CHAT_CHANGED": {
      // Lumiverse sends the chat as it is after the change, except when it gives the chat's user messages to another persona all at once.
      if (!isRecord(payload.chat)) return "Lumiverse changed the chat's own messages together, with no word of each";
      const read = chatOf(payload.chat);
      if (read === null) return "an event of a changed chat carried no chat the copy could read";
      if (read.updatedAt !== null && copy.updatedAt !== null && read.updatedAt < copy.updatedAt) return null;
      copy.chars += chatChars(read.chat) - chatChars(copy.chat);
      copy.chat = read.chat;
      copy.updatedAt = read.updatedAt ?? copy.updatedAt;
      return null;
    }
    default:
      return `an event the copy can't apply to a chat (${name})`;
  }
}

/** Applies a world book event to a kept book: null when it is applied, else why the book is to be read again. */
export function applyToBook(copy: BookCopy, name: string, payload: Record<string, unknown>): string | null {
  switch (name) {
    case "WORLD_BOOK_ENTRY_CHANGED": {
      const entry = entryOf(payload.entry);
      if (entry === null || entry.row.bookId !== copy.book.id) return "an event of a changed entry carried no entry of this book";
      const held = copy.byId.get(entry.row.id);
      if (held !== undefined && held.revision !== null && entry.revision !== null && entry.revision < held.revision) return null;
      if (held !== undefined) {
        copy.entries.splice(copy.entries.indexOf(held), 1);
        copy.chars -= entryChars(held.row);
      }
      // Lumiverse lists a book's entries by their order, then by id.
      const at = copy.entries.findIndex((e) => e.row.order > entry.row.order || (e.row.order === entry.row.order && e.row.id > entry.row.id));
      copy.entries.splice(at < 0 ? copy.entries.length : at, 0, entry);
      copy.byId.set(entry.row.id, entry);
      copy.chars += entryChars(entry.row);
      // Lumiverse stamps the book with the very time it stamps the entry with (createEntry, updateEntry).
      if (entry.row.updatedAt > copy.book.updatedAt) copy.book = Object.freeze({ ...copy.book, updatedAt: entry.row.updatedAt });
      return null;
    }
    case "WORLD_BOOK_ENTRY_DELETED":
      // Lumiverse stamps the book anew and the event carries no time: the stamp the lore tools go by is only to be had from the book.
      return "an entry of the book was deleted";
    case "WORLD_BOOK_CHANGED":
      return "Lumiverse changed the book as a whole";
    default:
      return `an event the copy can't apply to a book (${name})`;
  }
}
