// A user's own JSON documents in user storage (DESIGN §7): the registry of their loopback key and
// runtimes, the chats LumiAH is switched on for, their settings and texts. Each is read once per user
// and kept in memory; a change rewrites the file whole, one write at a time. And the two secrets'
// arithmetic: a secret is random hex, and only its SHA-256 is ever stored.

import type { BackendHost } from "./spindle";

/** SHA-256 of a text, as hex. */
export async function sha256(text: string): Promise<string> {
  const bytes = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text)));
  return [...bytes].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/** `bits` random bits as hex: a relay's secret, a loopback key, a turn's tag. */
export function randomHex(bits: number): string {
  const bytes = crypto.getRandomValues(new Uint8Array(bits / 8));
  return [...bytes].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/** How many users' documents of one kind stay in memory at once: a document read again costs one storage read, so this bounds memory, not what is kept. Not a setting: it changes nothing a user can see. */
const USERS_KEPT = 256;

export class UserDocs<T> {
  private readonly loaded = new Map<string, Promise<T>>();
  private writing: Promise<void> = Promise.resolve();
  /** The stored text of a user's file this build couldn't read: kept aside before the first write over it. */
  private readonly unreadable = new Map<string, string>();

  /**
   * @param file The document's path in each user's storage.
   * @param read The document a stored value holds; null when it isn't one this build reads.
   * @param empty A new user's document.
   */
  constructor(
    private readonly host: Pick<BackendHost, "storage" | "log">,
    private readonly file: string,
    private readonly read: (raw: unknown) => T | null,
    private readonly empty: () => T,
  ) {}

  /**
   * The user's document, read once. A file this build can't read (not JSON, or not a document it
   * knows) reads as a new user's, and is kept aside (`<file>.bad`) before anything is written over
   * it. A read that fails is never kept: it fails the request that asked, and the next one reads
   * again, so an outage never stands for an empty document.
   */
  get(userId: string): Promise<T> {
    let loaded = this.loaded.get(userId);
    if (loaded === undefined) {
      loaded = this.host.storage.read(this.file, userId).then(
        (text) => {
          if (text === null) return this.empty();
          let doc: T | null = null;
          try {
            doc = this.read(JSON.parse(text));
          } catch {
            // Not JSON: as unreadable as a document of another kind.
          }
          if (doc !== null) return doc;
          this.unreadable.set(userId, text);
          this.host.log("warn", `[LumiAH] ${this.file} couldn't be read, so it starts afresh (the file is kept as ${this.file}.bad)`);
          return this.empty();
        },
        (error: unknown) => {
          this.loaded.delete(userId);
          throw new Error(`LumiAH couldn't read ${this.file} (${error instanceof Error ? error.message : String(error)}). Try again in a moment.`);
        },
      );
      this.loaded.set(userId, loaded);
      if (this.loaded.size > USERS_KEPT) this.loaded.delete(this.loaded.keys().next().value ?? "");
    }
    return loaded;
  }

  /** Changes the user's document and writes it, one write at a time; rejects when it couldn't be written, and the change is then undone in memory too (the next read is from storage). */
  async change<R>(userId: string, fn: (doc: T) => R): Promise<R> {
    const doc = await this.get(userId);
    const out = fn(doc);
    const text = JSON.stringify(doc);
    const write = this.writing.then(async () => {
      const unreadable = this.unreadable.get(userId);
      if (unreadable !== undefined) {
        await this.host.storage.write(`${this.file}.bad`, unreadable, userId);
        this.unreadable.delete(userId);
      }
      await this.host.storage.write(this.file, text, userId);
    });
    this.writing = write.catch(() => undefined);
    try {
      await write;
    } catch (error) {
      this.loaded.delete(userId);
      throw new Error(`LumiAH couldn't save ${this.file} (${error instanceof Error ? error.message : String(error)}). Try again in a moment.`);
    }
    return out;
  }

  /** Resolves once every write is done (tests). */
  settle(): Promise<void> {
    return this.writing;
  }
}

/** Runs one piece of work at a time per key, in the order asked: a read-modify-write of one message's metadata, or of one chat's, never interleaves with another. */
export class KeyedQueue {
  private readonly tails = new Map<string, Promise<unknown>>();

  run<R>(key: string, work: () => Promise<R>): Promise<R> {
    const run = (this.tails.get(key) ?? Promise.resolve()).then(work, work);
    const tail = run.catch(() => undefined);
    this.tails.set(key, tail);
    void tail.then(() => {
      if (this.tails.get(key) === tail) this.tails.delete(key);
    });
    return run;
  }
}
