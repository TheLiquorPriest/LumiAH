// The rest of what the core's ports read and write through the extension (DESIGN §4.2): the blobs and
// the small documents, kept in the user's own storage; the world books that apply to a chat and their
// entries; and the active preset's blocks, each switched as it is for the chat.

import type { JsonValue, LoreBook, LoreEntry, PresetBlock } from "../../core/ports";
import { BLOB_HASH } from "../../link/contract";
import { LinkRefused } from "./errors";
import type { BackendHost, HostChat } from "./spindle";

/** Where a blob is kept: by its hash, under its first two characters so no directory holds them all. */
const blobPath = (hash: string): string => `blobs/${hash.slice(0, 2)}/${hash}`;

/** A document's path: names of letters, digits, `.`, `_` and `-`, joined by `/`, none of them `.` or `..`. A format, not a limit: a path is a name the code gives, and no name it gives grows with use. */
const DOC_PATH = /^(?!.*(?:^|\/)\.{1,2}(?:\/|$))[A-Za-z0-9._-]{1,128}(?:\/[A-Za-z0-9._-]{1,128}){0,7}$/;

export class Storage {
  constructor(private readonly host: Pick<BackendHost, "storage">) {}

  private static hash(hash: unknown): string {
    if (typeof hash !== "string" || !BLOB_HASH.test(hash)) throw new LinkRefused("bad_request", "A blob is named by its SHA-256 hash, in lower-case hex.");
    return hash;
  }

  private static path(path: unknown): string {
    if (typeof path !== "string" || !DOC_PATH.test(path)) throw new LinkRefused("bad_request", "A document's path is names of letters, digits, '.', '_' and '-' joined by '/'.");
    return `docs/${path}`;
  }

  /** The text stored under a hash; null when none is. */
  blob(userId: string, hash: unknown): Promise<string | null> {
    return this.host.storage.read(blobPath(Storage.hash(hash)), userId);
  }

  /** Stores a text under the hash the core computed for it. Storing the same hash again writes the same text. */
  async putBlob(userId: string, hash: unknown, text: unknown): Promise<void> {
    if (typeof text !== "string") throw new LinkRefused("bad_request", "A blob is text.");
    await this.host.storage.write(blobPath(Storage.hash(hash)), text, userId);
  }

  /** A stored blob's size in bytes; null when none is stored. */
  blobSize(userId: string, hash: string): Promise<number | null> {
    return this.host.storage.size(blobPath(Storage.hash(hash)), userId);
  }

  /** The document at a path; null when there is none, or it isn't JSON. */
  async doc(userId: string, path: unknown): Promise<JsonValue | null> {
    const text = await this.host.storage.read(Storage.path(path), userId);
    if (text === null) return null;
    try {
      return JSON.parse(text) as JsonValue;
    } catch {
      return null;
    }
  }

  async putDoc(userId: string, path: unknown, doc: unknown): Promise<void> {
    if (doc === undefined) throw new LinkRefused("bad_request", "A document needs a value.");
    await this.host.storage.write(Storage.path(path), JSON.stringify(doc), userId);
  }

  async removeDoc(userId: string, path: unknown): Promise<void> {
    await this.host.storage.remove(Storage.path(path), userId);
  }
}

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
    private readonly host: Pick<BackendHost, "lore">,
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

export class Presets {
  constructor(private readonly host: Pick<BackendHost, "presets">) {}

  /**
   * `preset.blocks`: a preset's blocks in order, none for a preset that isn't there. For a chat, each
   * block is on or off as the chat's preset binding has it, when the preset is the one the chat
   * generates with: Lumiverse puts a block in the prompt by that, not by the preset's own switch.
   */
  async blocks(userId: string, presetId: unknown, chatId: string | null): Promise<PresetBlock[]> {
    if (typeof presetId !== "string" || presetId === "") throw new LinkRefused("bad_request", "A preset is named by its id.");
    const blocks = await this.host.presets.blocks(presetId, userId);
    if (blocks === null) return [];
    const active = chatId === null ? null : await this.host.presets.active(chatId, userId).catch(() => null);
    const states = active !== null && active.presetId === presetId ? active.states : {};
    return blocks.map((b) => ({ id: b.id, name: b.name, role: b.role, kind: b.marker === null ? "instruction" : "marker", marker: b.marker, content: b.content, enabled: states[b.id] ?? b.enabled }));
  }
}
