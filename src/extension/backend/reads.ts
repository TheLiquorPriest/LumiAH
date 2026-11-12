// The rest of what the core's ports read and write through the extension (DESIGN §4.2): the blobs and
// the small documents, kept in the user's own storage; the world books that apply to a chat and their
// entries, read as the runtime reads them over its copy (host/lore.ts); and the active preset's
// blocks, each switched as it is for the chat.

import type { BlobInfo, JsonValue, PresetBlock } from "../../core/ports";
import { BLOB_HASH, DOC_PATH, DOC_PREFIX } from "../../link/contract";
import { LinkRefused } from "./errors";
import type { BackendHost } from "./spindle";

export { Lore, type LoreDeps } from "../../host/lore";

/** Where a blob is kept: by its hash, under its first two characters so no directory holds them all. */
const blobPath = (hash: string): string => `blobs/${hash.slice(0, 2)}/${hash}`;

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
  async blobSize(userId: string, hash: string): Promise<number | null> {
    return (await this.host.storage.stat(blobPath(Storage.hash(hash)), userId))?.bytes ?? null;
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

  /**
   * `doc.list`: the path of every document under a prefix (`chats/abc/`), at any depth. A prefix
   * that ends inside a name lists the documents whose paths start with it.
   */
  async docs(userId: string, prefix: unknown): Promise<string[]> {
    if (typeof prefix !== "string" || !DOC_PREFIX.test(prefix)) throw new LinkRefused("bad_request", "A documents' prefix is names of letters, digits, '.', '_' and '-' joined by '/'.");
    const cut = prefix.lastIndexOf("/");
    const dir = cut < 0 ? "" : prefix.slice(0, cut);
    const found = await this.host.storage.list(dir === "" ? "docs" : `docs/${dir}`, userId);
    return found.map((rel) => (dir === "" ? rel : `${dir}/${rel}`)).filter((path) => path.startsWith(prefix));
  }

  /**
   * `blob.list`: every blob stored, a page at a time. Blobs are kept under the first two characters
   * of their hashes, and a page is the blobs under one such pair, so the listing holds still while
   * it is read and no page grows with the store beyond one part in 256 of it. `cursor` is the pair
   * the page before named as next; null for the first.
   */
  async blobs(userId: string, cursor: unknown): Promise<{ blobs: BlobInfo[]; next: string | null }> {
    const at = cursor === null || cursor === undefined ? 0 : typeof cursor === "string" && /^[0-9a-f]{2}$/.test(cursor) ? Number.parseInt(cursor, 16) : -1;
    if (at < 0) throw new LinkRefused("bad_request", "That page of the stored blobs isn't one LumiAH gave.");
    const pair = at.toString(16).padStart(2, "0");
    const blobs: BlobInfo[] = [];
    for (const name of await this.host.storage.list(`blobs/${pair}`, userId)) {
      if (!BLOB_HASH.test(name)) continue;
      const stat = await this.host.storage.stat(blobPath(name), userId);
      if (stat !== null) blobs.push({ hash: name, bytes: stat.bytes, at: stat.writtenAt });
    }
    return { blobs, next: at < 255 ? (at + 1).toString(16).padStart(2, "0") : null };
  }

  /** `blob.remove`: removes blobs by their hashes; one that isn't stored is passed over. */
  async removeBlobs(userId: string, hashes: unknown): Promise<void> {
    if (!Array.isArray(hashes)) throw new LinkRefused("bad_request", "The blobs to remove are named by their hashes.");
    for (const hash of hashes) await this.host.storage.remove(blobPath(Storage.hash(hash)), userId);
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
