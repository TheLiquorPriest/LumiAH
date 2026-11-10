// What a turn's tools read of the chat and its lore (`ChatView`, `LoreView`), each read from the host
// the first time a tool asks and kept for the turn: a turn that never searches the chat reads none of
// its text, and one that searches it five times reads it once.

import { excerptOf, LexicalIndex, type Piece } from "./lexical";
import type { ActivatedLore, ChatMessage, HarnessHost, LoreBook, PathMessage } from "./ports";
import type { Settings } from "./settings";
import type { ChatView, LoreItem, LoreView } from "./tools";

/** A value made on first ask and kept: every later ask gets the same promise. */
function once<T>(make: () => Promise<T>): () => Promise<T> {
  let made: Promise<T> | undefined;
  return () => (made ??= make());
}

/**
 * The chat as a turn reads it: the messages of the active path before the reply (`before`, which the
 * turn's session walk already read), their text read from the host a batch at a time.
 */
export function chatView(host: Pick<HarnessHost, "chat">, chatId: string, before: readonly PathMessage[], settings: Readonly<Settings["tools"]>): ChatView {
  const messages = once(async (): Promise<readonly ChatMessage[]> => {
    const first = before[0];
    const last = before.at(-1);
    if (!first || !last) return [];
    // The path the turn reads is the one its session walked: a message that joined the chat since isn't the turn's.
    const wanted = new Set(before.map((m) => m.id));
    const out: ChatMessage[] = [];
    for (let from = first.index; from <= last.index; from += settings.chatBatch) {
      const batch = await host.chat.messages(chatId, from, Math.min(last.index + 1, from + settings.chatBatch));
      for (const m of batch) if (wanted.has(m.id)) out.push(m);
    }
    return out;
  });
  const index = once(async () => {
    const built = new LexicalIndex<number>(settings.pieceChars);
    (await messages()).forEach((m, at) => built.add(at, m.content));
    return built;
  });
  return { path: async () => before, messages, index };
}

/**
 * The shortest start of each id, at least `least` characters, that no other id of the list starts
 * with: what an agent reads an entry by. An id that is the start of another keeps its whole length.
 */
export function shortIds(ids: readonly string[], least: number): string[] {
  return ids.map((id) => {
    let length = Math.min(id.length, least);
    while (length < id.length && ids.some((other) => other !== id && other.startsWith(id.slice(0, length)))) length++;
    return id.slice(0, length);
  });
}

/**
 * Where an entry's short id starts: a host's ids are UUIDs, whose first group is eight characters.
 * Not a setting: the id grows from there until it names one entry, so nothing is limited by it.
 */
const SHORT_ID = 8;

/** A lore entry's text as a search reads it: its title, its keys and what it holds. */
function loreText(item: LoreItem): string {
  return [item.entry.title, [...item.entry.keys, ...item.entry.secondaryKeys].join(", "), item.entry.content].filter((part) => part !== "").join("\n");
}

/**
 * A search hit's excerpt of an entry: the piece that matched, less the title and keys that lead the
 * entry's search text (the answer names those already); the entry's opening when the match was in
 * them alone.
 */
export function loreExcerpt(item: LoreItem, piece: Piece, max: number): string {
  const { content } = item.entry;
  const head = loreText(item).length - content.length;
  const start = Math.max(0, piece.start - head);
  const end = piece.end - head;
  return excerptOf(content, end > start ? { start, end } : { start: 0, end: content.length }, max);
}

/** The lore that applies to a turn's chat: its books, every entry of them, and what Lumiverse activated for the generation. */
export function loreView(host: Pick<HarnessHost, "lore">, turn: { chatId: string; generationId: string }, settings: Readonly<Settings["tools"]>): LoreView {
  const books = once((): Promise<readonly LoreBook[]> => host.lore.books(turn.chatId));
  const items = once(async (): Promise<readonly LoreItem[]> => {
    const read = await Promise.all((await books()).map(async (book) => ({ book, entries: await host.lore.entries(book.id) })));
    const all = read.flatMap(({ book, entries }) => entries.map((entry) => ({ entry, book })));
    const short = shortIds(all.map((x) => x.entry.id), SHORT_ID);
    return all.map((x, i) => ({ ...x, short: short[i] ?? x.entry.id }));
  });
  const index = once(async () => {
    const built = new LexicalIndex<number>(settings.pieceChars);
    (await items()).forEach((item, at) => built.add(at, loreText(item)));
    return built;
  });
  const activated = once((): Promise<readonly ActivatedLore[]> => host.lore.activated(turn.chatId, turn.generationId));
  return { books, items, index, activated };
}
