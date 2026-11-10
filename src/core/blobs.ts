// The core's blobs (DESIGN §5): a turn's session segment, a compaction's summary, a turn's transcript
// and each call's exact prompt. Each is text kept once under the hash of that text (`textHash`),
// through the host's `blobs` port, and never changed: a record that names a hash names that text for
// good, so a swipe, a regenerate or a branch that reads the same turn reads the same blob.
//
// The core computes every hash and checks what it reads against it, so a store that hands back
// something else is read as having nothing. A text read or written once is kept in memory, within a
// setting, so the next read of it (a session's segments on every turn) takes no round trip to the
// host; a blob never changes, so a kept text is never stale.

import { isHash, textHash } from "./hash";
import type { HarnessHost, JsonValue } from "./ports";
import { parseJson } from "./util";

export class Blobs {
  /** Texts read or written lately, by hash, the one used longest ago first. */
  private readonly kept = new Map<string, string>();
  private chars = 0;
  /** Puts under way, by hash: a second put of the same text waits for the first. */
  private readonly writing = new Map<string, Promise<void>>();

  constructor(
    private readonly host: Pick<HarnessHost, "blobs" | "log">,
    /** The characters of texts kept in memory (a setting, read each time so a change takes effect). */
    private readonly keep: () => number,
  ) {}

  /**
   * Stores `text` and gives its hash. A text stored before is written again: the same bytes, so a blob
   * removed meanwhile comes back whole. `kept` false for a text the core never reads back (a call's
   * prompt, a transcript): it takes no room in memory.
   */
  async put(text: string, kept = true): Promise<string> {
    const hash = await textHash(text);
    const under = this.writing.get(hash);
    if (under) {
      await under;
      return hash;
    }
    const write = this.host.blobs.put(hash, text);
    this.writing.set(hash, write);
    try {
      await write;
    } finally {
      this.writing.delete(hash);
    }
    if (kept) this.remember(hash, text);
    return hash;
  }

  /** A JSON value as a blob: its `JSON.stringify` text. */
  putJson(value: JsonValue, kept = true): Promise<string> {
    return this.put(JSON.stringify(value), kept);
  }

  /**
   * A blob's text; null when it isn't stored, the hash isn't one, or what is stored doesn't hash to
   * its address (damaged: said in the log, never handed out as if it were the blob).
   */
  async get(hash: string): Promise<string | null> {
    if (!isHash(hash)) return null;
    const known = this.kept.get(hash);
    if (known !== undefined) {
      this.remember(hash, known);
      return known;
    }
    await this.writing.get(hash)?.catch(() => undefined);
    const text = await this.host.blobs.get(hash);
    if (text === null) return null;
    if ((await textHash(text)) !== hash) {
      this.host.log("warn", `the stored blob ${hash} doesn't match its hash, so it is read as missing`);
      return null;
    }
    this.remember(hash, text);
    return text;
  }

  /** A blob read as JSON; undefined when it is missing or isn't JSON. */
  async getJson(hash: string): Promise<unknown> {
    const text = await this.get(hash);
    return text === null ? undefined : parseJson(text);
  }

  /** Keeps a text as the one used last, letting go of those used longest ago past what Settings keep; one longer than all of it isn't kept. */
  private remember(hash: string, text: string): void {
    const limit = this.keep();
    const before = this.kept.get(hash);
    if (before !== undefined) {
      this.kept.delete(hash);
      this.chars -= before.length;
    }
    if (text.length <= limit) {
      this.kept.set(hash, text);
      this.chars += text.length;
    }
    for (const [old, held] of this.kept) {
      if (this.chars <= limit) break;
      this.kept.delete(old);
      this.chars -= held.length;
    }
  }
}
