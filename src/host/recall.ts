// What the lore and history tools read of a chat and its world books beyond the chat and lore ports
// (DESIGN §24): every book that applies with every entry of it and where it applies from, and a range
// of the chat's messages with when each was sent. The extension's backend serves these over Spindle
// (extension/backend/recall.ts, beside what only it reaches: embeddings, the Memory Cortex, databanks,
// web search, the chat's book); the runtime runs them over its copy of chat and lore
// (PI-BUILD-PLAN §4.5). A chat is read only when it is the user's (refused `not_found` otherwise,
// another's in the same words as one that isn't there).

import type { LoreBookRead, LoreBookSource, TimedMessage } from "../core/recall/ports";
import type { ChatReader } from "./chat";
import type { Lore } from "./lore";
import type { HostChat, LoreReads } from "./rows";

/** The strings of a list, none empty; nothing for anything else. */
export const strings = (value: unknown): string[] => (Array.isArray(value) ? value.filter((s): s is string => typeof s === "string" && s !== "") : []);

export interface RecallReadsDeps {
  chats: ChatReader;
  /** Which world books apply to a chat. */
  lore: Lore;
  now(): number;
}

export class RecallReads {
  constructor(
    private readonly host: { lore: LoreReads },
    private readonly deps: RecallReadsDeps,
  ) {}

  /**
   * `RecallLorePort.read`: every book that applies to the chat (`Lore.books` says which, and in what
   * order), each with every entry of it. A book whose stamp is the one the caller holds for it
   * comes with `entries` null.
   *
   * Lumiverse stamps a book when it or any entry of it changes, to the second. So a stamp says that
   * nothing changed since only once its second is over: a change later in the same second carries
   * the same one. Until then a book is given whole with no stamp (0), which a caller never holds
   * against a later read.
   */
  async lore(userId: string, chatId: string, known: Readonly<Record<string, number>> = {}): Promise<LoreBookRead[]> {
    const chat = await this.deps.chats.own(userId, chatId);
    const [books, sources] = await Promise.all([this.deps.lore.books(userId, chat), this.sources(userId, chat)]);
    const read = await Promise.all(
      books.map(async (book): Promise<LoreBookRead | null> => {
        // The stamp is read before the entries: a change between the two reads moves the book's stamp past the one given here, so the entries are read again next time.
        const record = await this.host.lore.record(book.id, userId);
        if (record === null) return null;
        const over = record.updatedAt > 0 && this.deps.now() >= (Math.floor(record.updatedAt / 1000) + 1) * 1000;
        const stamp = over ? record.updatedAt : 0;
        // What extensions keep on an entry is no part of what the lore tools read of it.
        const entries = stamp > 0 && known[book.id] === stamp ? null : (await this.host.lore.records(book.id, userId)).map(({ extensions: _kept, ...entry }) => entry);
        return { id: record.id, name: record.name, description: record.description, source: sources.get(record.id) ?? null, updatedAt: stamp, entries };
      }),
    );
    return read.filter((book): book is LoreBookRead => book !== null);
  }

  /**
   * Where each book attached somewhere the chat reads from applies from. A book attached at several
   * places is said as Lumiverse says it, by the narrowest: a character's before a persona's before
   * the chat's own before one switched on for every chat. The persona is the user's active one:
   * which persona the chat's last turn was assembled for isn't known here. So a book that applies
   * through another persona, or only because Lumiverse activated an entry of it, has no source.
   */
  private async sources(userId: string, chat: HostChat): Promise<Map<string, LoreBookSource>> {
    const { lore } = this.host;
    const [ofCharacter, ofPersona, global] = await Promise.all([
      chat.characterId !== null ? lore.ofCharacter(chat.characterId, userId).catch((): string[] => []) : [],
      lore.ofPersona(null, userId).catch(() => null),
      lore.global(userId).catch((): string[] => []),
    ]);
    const out = new Map<string, LoreBookSource>();
    // The widest first, so a narrower one stands over it.
    for (const id of global) out.set(id, "global");
    for (const id of strings(chat.metadata.chat_world_book_ids)) out.set(id, "chat");
    if (ofPersona !== null) out.set(ofPersona, "persona");
    for (const id of ofCharacter) out.set(id, "character");
    return out;
  }

  /** `RecallChatPort.messages`: as `ChatReader.messages`, each message with when it was sent. */
  async messages(userId: string, chatId: string, from: number, to: number): Promise<TimedMessage[]> {
    await this.deps.chats.own(userId, chatId);
    return (await this.deps.chats.range(chatId, from, to)).map((m) => ({ id: m.id, index: m.index, role: m.role, name: m.name, swipeId: m.swipeId, content: m.content, at: m.at }));
  }
}
