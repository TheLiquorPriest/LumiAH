// The world books that apply to a chat, and their entries, as the core's `lore` port reads them
// (DESIGN §4.2): read by the extension's backend over Spindle, and by the runtime over its copy of
// chat and lore (PI-BUILD-PLAN §4.5).

import type { LoreBook, LoreEntry } from "../core/ports";
import { LinkRefused } from "./refused";
import type { HostChat, LoreReads } from "./rows";

/** The ids a chat's metadata lists under a key, as text. */
function ids(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((id): id is string => typeof id === "string" && id !== "") : [];
}

export interface LoreDeps {
  /** The persona of the chat's latest turn, where Lumiverse said (undefined: no turn is known for the chat; null: it had none). */
  persona(userId: string, chatId: string): string | null | undefined;
  /** The books of the entries Lumiverse activated for the chat's latest turn. */
  activatedBooks(userId: string, chatId: string): string[];
}

export class Lore {
  constructor(
    private readonly host: { lore: LoreReads },
    private readonly deps: LoreDeps,
  ) {}

  /**
   * `lore.books`: the world books that apply to a chat: the chat's own, its character's, its
   * persona's, the ones switched on for every chat, and the book of any entry Lumiverse activated
   * for the chat's latest turn (whatever attached it), each once, in that order.
   */
  async books(userId: string, chat: HostChat): Promise<LoreBook[]> {
    const { lore } = this.host;
    const persona = this.deps.persona(userId, chat.id);
    const wanted = [
      ...ids(chat.metadata.chat_world_book_ids),
      ...(chat.characterId !== null ? await lore.ofCharacter(chat.characterId, userId).catch(() => []) : []),
      // The persona the chat's latest turn was assembled for; with no turn known for the chat (the extension started since), the user's active persona stands in.
      persona === null ? null : await lore.ofPersona(persona ?? null, userId).catch(() => null),
      ...(await lore.global(userId).catch(() => [])),
      ...this.deps.activatedBooks(userId, chat.id),
    ];
    const out: LoreBook[] = [];
    const seen = new Set<string>();
    for (const id of wanted) {
      if (id === null || seen.has(id)) continue;
      seen.add(id);
      const book = await lore.book(id, userId).catch(() => null);
      if (book !== null) out.push({ id: book.id, name: book.name, description: book.description });
    }
    return out;
  }

  /** `lore.entries`: a book's entries, in the book's order; none for a book that isn't the user's. */
  async entries(userId: string, bookId: unknown): Promise<LoreEntry[]> {
    if (typeof bookId !== "string" || bookId === "") throw new LinkRefused("bad_request", "A world book is named by its id.");
    if ((await this.host.lore.book(bookId, userId)) === null) return [];
    return (await this.host.lore.entries(bookId, userId)).map((e) => ({ id: e.id, bookId: e.bookId, title: e.title, keys: e.keys, secondaryKeys: e.secondaryKeys, content: e.content, enabled: e.enabled, constant: e.constant }));
  }
}
