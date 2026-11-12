// Search by meaning (DESIGN §24.5): a vector for each lore entry and each chat message, kept in the
// user's storage by the text's hash so an unchanged text is never embedded twice, made in the
// background under a daily cap, and searched beside the words.
//
// What is fixed here is what the rest of §24 calls: `Meaning.search` gives, for each query, the
// texts closest to it in meaning; `Meaning.status` says how much is embedded and what it cost; and
// `Meaning.settled` resolves once nothing is being embedded. Lumiverse is the embedder: the host's
// `recall.embeddings` port makes the vectors on the user's own embedding connection.
//
// How the vectors are kept. Each owner (a chat, a world book) has its own, apart for each embedding
// space (the connection, its model and its dimensions: vectors of two models can't be compared), in
// 256 small documents by the start of the text's hash, so a turn's two new messages rewrite two of
// them and never the chat's whole set. A vector is one signed byte a component, the bytes written
// as text. A search reads the documents its texts fall in once, and compares from memory after.
//
// One loop embeds what has no vector yet, a batch at a time, and holds each batch against the
// tokens embedded in the last 24 hours. That count is kept in the store too, by the hour, so the cap
// holds across restarts.
//
// One process writes these documents (paths.ts). Each is written whole from what memory holds of
// it, and only once it was read, so a write never loses what the store held.

import { wholeCut } from "../lexical";
import { docKey } from "../paths";
import type { HarnessHost, JsonValue } from "../ports";
import { isRecord } from "../ports";
import type { Settings } from "../settings";
import { errorText, limitOf, tokensOf } from "../util";
import { EMBED_BATCH_MAX, EMBED_TEXT_MAX, type EmbedderInfo, type EmbeddingsPort } from "./ports";
import type { EmbedStatus } from "./shapes";

/** Whose texts a set of vectors is: a chat's messages, or a world book's entries. Vectors are kept apart for each. */
export type MeaningOwner = { kind: "chat"; id: string } | { kind: "book"; id: string };

/** A text that may be embedded: its key among its owner's (a message's id, an entry's id), the hash its vector is kept under (it changes whenever the text does), and the text, already cut to what Settings embed. */
export interface MeaningText {
  key: string;
  hash: string;
  text: string;
}

/** An owner with its texts as they stand now. */
export interface MeaningGroup {
  owner: MeaningOwner;
  texts: readonly MeaningText[];
}

/** A text close to a query in meaning: its key, and how close, from -1 to 1. */
export interface MeaningMatch {
  key: string;
  similarity: number;
}

/**
 * What a search by meaning found: for each query, in the order given, the closest texts, the closest
 * first, none below Settings' least similarity and no more than Settings' matches a query. `state`:
 * `on` where vectors were searched (the lists may still be empty: nothing is embedded yet, or
 * nothing is close), `off` where Settings switch search by meaning off, `none` where the user has no
 * embedding connection.
 */
export interface MeaningFound {
  state: "on" | "off" | "none";
  matches: MeaningMatch[][];
}

export interface MeaningSearch {
  groups: readonly MeaningGroup[];
  queries: readonly string[];
  /** Only keys this takes are matched. */
  keep?: (key: string) => boolean;
  settings: Readonly<Settings>;
  signal?: AbortSignal;
}

export interface MeaningStatusInput {
  /** The world books that apply to the chat, each with its entries. */
  lore: readonly MeaningGroup[];
  /** The chat's messages; null for a status about no chat's messages. */
  chat: MeaningGroup | null;
  settings: Readonly<Settings>;
  /** Have what waits for a vector embedded now, in the background, under the daily cap. */
  start?: boolean;
}

const nothing = (state: MeaningFound["state"], queries: readonly string[]): MeaningFound => ({ state, matches: queries.map(() => []) });

// ---------------------------------------------------------------- a vector as stored

/**
 * The alphabet a stored vector's bytes are written in, six bits to a character: base64's, without
 * its padding, since a document says how long its vectors are. A stored format, so fixed.
 */
const ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";

/** The six bits of each character of the alphabet, by its code; -1 for any other character. */
const SIX = new Int8Array(128).fill(-1);
for (let at = 0; at < ALPHABET.length; at++) SIX[ALPHABET.charCodeAt(at)] = at;

/** The largest value a stored component takes. Not a setting: a component is one signed byte, which is the stored format. */
const BYTE_MAX = 127;

/**
 * A vector as memory holds it: its components as stored, and one over their length, so its dot
 * product with a query of unit length is the cosine of the two.
 */
interface Kept {
  q: Int8Array;
  inv: number;
}

/**
 * What is kept for a text the embedder gave no direction (a vector of zeros): no component. It
 * stands for the text all the same, so the text is never embedded again, and it matches no query.
 */
const NOTHING: Kept = { q: new Int8Array(0), inv: 0 };

/** Stored components with their length worked out; null where they are all zero, which no vector that was stored is. */
function keptOf(q: Int8Array): Kept | null {
  let sum = 0;
  for (let at = 0; at < q.length; at++) sum += q[at] * q[at];
  return sum > 0 ? { q, inv: 1 / Math.sqrt(sum) } : null;
}

/**
 * A vector as it is kept. Only its direction counts for a cosine, so its length is given up, and
 * it is stored at the scale that uses a byte best: its largest component at 127. (Brought to unit
 * length first, a component of a 1,536-dimension vector would be about three steps of a byte.)
 */
function quantize(vector: readonly number[]): Kept {
  let most = 0;
  for (const c of vector) most = Math.max(most, Math.abs(c));
  if (most === 0) return NOTHING;
  const scale = BYTE_MAX / most;
  const q = new Int8Array(vector.length);
  for (let at = 0; at < vector.length; at++) q[at] = Math.round(vector[at] * scale);
  return keptOf(q) ?? NOTHING;
}

/** A query's vector at unit length; null for one with no direction. */
function unit(vector: readonly number[]): Float32Array | null {
  let sum = 0;
  for (const c of vector) sum += c * c;
  if (!(sum > 0) || !Number.isFinite(sum)) return null;
  const inv = 1 / Math.sqrt(sum);
  return Float32Array.from(vector, (c) => c * inv);
}

/** How close a kept vector is to a query of unit length and the same dimensions, from -1 to 1. */
function cosine(query: Float32Array, kept: Kept): number {
  const { q } = kept;
  let sum = 0;
  for (let at = 0; at < q.length; at++) sum += query[at] * q[at];
  return sum * kept.inv;
}

/** Stored components as text: three bytes to four characters of the alphabet. */
function encode(q: Int8Array): string {
  const n = q.length;
  let out = "";
  let at = 0;
  for (; at + 2 < n; at += 3) {
    const a = q[at] & 255;
    const b = q[at + 1] & 255;
    const c = q[at + 2] & 255;
    out += ALPHABET[a >> 2] + ALPHABET[((a & 3) << 4) | (b >> 4)] + ALPHABET[((b & 15) << 2) | (c >> 6)] + ALPHABET[c & 63];
  }
  if (at < n) {
    const a = q[at] & 255;
    const b = at + 1 < n ? q[at + 1] & 255 : 0;
    out += ALPHABET[a >> 2] + ALPHABET[((a & 3) << 4) | (b >> 4)];
    if (at + 1 < n) out += ALPHABET[(b & 15) << 2];
  }
  return out;
}

/** The components a stored text holds; null where it isn't `dims` of them in the alphabet. */
function decode(text: string, dims: number): Int8Array | null {
  if (text.length !== Math.ceil((dims * 4) / 3)) return null;
  const q = new Int8Array(dims);
  let at = 0;
  let held = 0;
  let bits = 0;
  for (let i = 0; i < text.length; i++) {
    const code = text.charCodeAt(i);
    const six = code < 128 ? SIX[code] : -1;
    if (six < 0) return null;
    held = (held << 6) | six;
    bits += 6;
    if (bits < 8) continue;
    bits -= 8;
    // A byte from 128 up is a component below zero: the array it goes into is of signed bytes.
    q[at++] = held >> bits;
    held &= (1 << bits) - 1;
  }
  return q;
}

/**
 * The vectors an embedding call gave, checked: one for each text, each of numbers, all of one
 * length. A provider made them, so anything else fails the call.
 */
function vectorsOf(result: unknown, count: number): number[][] {
  const vectors: unknown = isRecord(result) ? result.vectors : null;
  if (!Array.isArray(vectors) || vectors.length !== count) throw new Error(`the embedder gave ${Array.isArray(vectors) ? vectors.length : "no"} vectors for ${count} texts`);
  const first: unknown = vectors[0];
  const dims = Array.isArray(first) ? first.length : 0;
  for (const vector of vectors as unknown[]) {
    if (dims === 0 || !Array.isArray(vector) || vector.length !== dims || !vector.every((c) => typeof c === "number" && Number.isFinite(c))) throw new Error("the embedder gave a vector that isn't one (numbers, as many for every text)");
  }
  return vectors as number[][];
}

// ---------------------------------------------------------------- where vectors are kept

/** Where the vectors and the count of what was embedded are kept in the host's store. Stored paths, so fixed. */
const VECTORS = "recall/vectors";
const EMBEDDED = "recall/embedded.json";

/**
 * The space an embedding connection's vectors are in, as a part of their path: the connection, its
 * model, and the dimensions it is set to (`own` where it leaves them to the model), joined by `.`.
 * Vectors of two spaces are never compared. The name is one the extension's storage takes (the
 * link's `DOC_PATH`: letters, digits, `.`, `_` and `-`, 128 at most): in each id, every character
 * but a letter, a digit or `-` is written as `_` and the two hex digits of each of its UTF-8 bytes,
 * so no id holds a `.` and two that differ never read the same; a name longer than the storage takes
 * is cut, and ends with `_h` and a hash of it whole, which no name written whole holds. A stored
 * format, so fixed. (Before, the parts were joined by `~`, which the storage refuses: nothing was
 * ever stored under such a name, and nothing reads one.)
 */
function spaceOf(info: EmbedderInfo): string {
  const { dimensions } = info;
  const name = `${spacePart(info.id)}.${spacePart(info.model)}.${typeof dimensions === "number" && Number.isSafeInteger(dimensions) && dimensions > 0 ? dimensions : "own"}`;
  return name.length <= SPACE_CHARS ? name : `${name.slice(0, SPACE_CHARS - 18)}_h${fnv64(name)}`;
}

/** The most characters a name in a stored path may have (the link's `DOC_PATH`). */
const SPACE_CHARS = 128;

const SPACE_KEPT = /[A-Za-z0-9-]/;

/** An id as a part of a space's name: letters, digits and `-` as they are, every other character as `_` and its UTF-8 bytes in hex. */
function spacePart(id: string): string {
  let out = "";
  for (const char of id) {
    if (SPACE_KEPT.test(char)) out += char;
    else for (const byte of new TextEncoder().encode(char)) out += `_${byte.toString(16).padStart(2, "0")}`;
  }
  return out;
}

/** FNV-1a, 64 bits, of a text's UTF-8, in 16 hex digits: what tells two long names apart once they are cut. */
function fnv64(text: string): string {
  let h = 0xcbf29ce484222325n;
  for (const byte of new TextEncoder().encode(text)) h = ((h ^ BigInt(byte)) * 0x100000001b3n) & 0xffffffffffffffffn;
  return h.toString(16).padStart(16, "0");
}

const HEX_START = /^[0-9a-f]{2}/;

/**
 * Which of an owner's documents a hash's vector is kept in: the hash's first two characters, so an
 * owner has 256 at most. A hash that isn't the core's own lower-case hex is spread over the same
 * 256 by its characters (FNV-1a, whose two numbers these are), so a path never rests on what a host
 * calls a hash. A stored format, so fixed.
 */
function shardOf(hash: string): string {
  if (HEX_START.test(hash)) return hash.slice(0, 2);
  let h = 0x811c9dc5;
  for (let at = 0; at < hash.length; at++) h = Math.imul(h ^ hash.charCodeAt(at), 0x01000193);
  return (h & 255).toString(16).padStart(2, "0");
}

/** One document's vectors, by hash: all of one length (`dims`; 0 while it holds none). */
interface Shard {
  dims: number;
  vectors: Map<string, Kept>;
}

/**
 * A stored document of vectors, read. It is outside data: what isn't such a document reads as an
 * empty one, and an entry is skipped where it isn't a vector of the document's dimensions (a text
 * cut short, a character of no alphabet, a hash of another document), so its text is embedded
 * again and the document written whole.
 */
function shardFrom(raw: JsonValue | null, id: string): Shard {
  const shard: Shard = { dims: 0, vectors: new Map() };
  if (!isRecord(raw) || raw.v !== 1 || !isRecord(raw.vectors)) return shard;
  const dims = typeof raw.dims === "number" && Number.isSafeInteger(raw.dims) && raw.dims > 0 ? raw.dims : 0;
  for (const [hash, text] of Object.entries(raw.vectors)) {
    if (typeof text !== "string" || shardOf(hash) !== id) continue;
    if (text === "") {
      shard.vectors.set(hash, NOTHING);
      continue;
    }
    const q = dims > 0 ? decode(text, dims) : null;
    const kept = q && keptOf(q);
    if (!kept) continue;
    shard.vectors.set(hash, kept);
    shard.dims = dims;
  }
  return shard;
}

/**
 * One owner's vectors in one space, as far as they were read. A document is read whole the first
 * time one of its hashes is asked for, held from then on, and written whole after a vector is put
 * in it. Its documents are kept at `recall/vectors/<space>/<chat|book>/<owner>/<xx>.json`.
 */
class Owned {
  private readonly shards = new Map<string, Shard>();
  private readonly reading = new Map<string, Promise<void>>();
  /** The documents changed since they were last written. */
  private readonly changed = new Set<string>();
  private writing: Promise<void> = Promise.resolve();
  /** The chat this one was branched from: null for none (a world book has none), undefined until the host has said. */
  parent: string | null | undefined;
  /** The hashes already looked for in the chats this one was branched from. */
  readonly asked = new Set<string>();
  /** The ask it was last named in, by the count of asks: the owner unused longest is let go first. */
  used = 0;
  /** How many are reading into it or writing from it now: it isn't let go meanwhile. */
  busy = 0;
  private readonly dir: string;

  constructor(
    private readonly host: Pick<HarnessHost, "store" | "log">,
    space: string,
    readonly owner: MeaningOwner,
    readonly who: string,
  ) {
    this.dir = `${VECTORS}/${space}/${owner.kind}/${docKey(owner.id)}`;
    if (owner.kind === "book") this.parent = null;
  }

  /** Whether the document a hash falls in was read: only then is it known whether the hash has a vector. */
  ready(hash: string): boolean {
    return this.shards.has(shardOf(hash));
  }

  get(hash: string): Kept | undefined {
    return this.shards.get(shardOf(hash))?.vectors.get(hash);
  }

  /**
   * Reads the documents these hashes fall in, those not read yet, each once however many ask.
   * Never rejects: a document that can't be read is logged and stays unread, so its texts are
   * neither found nor embedded over what the store holds, and it is read again at the next ask.
   */
  async load(hashes: Iterable<string>): Promise<void> {
    const reads = new Set<Promise<void>>();
    for (const hash of hashes) {
      const id = shardOf(hash);
      if (this.shards.has(id)) continue;
      let reading = this.reading.get(id);
      if (!reading) {
        // Cleared once the read has ended, whichever way: a document that couldn't be read is read again at the next ask.
        reading = this.read(id).finally(() => this.reading.delete(id));
        this.reading.set(id, reading);
      }
      reads.add(reading);
    }
    if (reads.size > 0) await Promise.all(reads);
  }

  private async read(id: string): Promise<void> {
    const path = `${this.dir}/${id}.json`;
    try {
      this.shards.set(id, shardFrom(await this.host.store.read(path), id));
    } catch (error) {
      this.host.log("warn", `[LumiAH] the vectors at ${path} couldn't be read (${errorText(error)})`);
    }
  }

  /** Whether a vector can stand beside the ones its document holds: they are all of one length. */
  takes(hash: string, kept: Kept): boolean {
    const shard = this.shards.get(shardOf(hash));
    return shard !== undefined && (kept.q.length === 0 || shard.dims === 0 || shard.dims === kept.q.length);
  }

  /**
   * Keeps a vector in memory, where its document was read (`save` writes it). Where the document's
   * other vectors are of another length, the embedder's dimensions have changed and they can't be
   * compared any more: they go, and their texts are embedded again.
   */
  put(hash: string, kept: Kept): void {
    const id = shardOf(hash);
    const shard = this.shards.get(id);
    if (!shard) return;
    const dims = kept.q.length;
    if (dims > 0 && shard.dims !== dims) {
      for (const [other, old] of shard.vectors) if (old.q.length > 0) shard.vectors.delete(other);
      shard.dims = dims;
    }
    shard.vectors.set(hash, kept);
    this.changed.add(id);
  }

  /**
   * Writes the documents changed since the last write, each whole, one write of a document at a
   * time. Never rejects: a write that fails is logged, and its document is written again with the
   * next.
   */
  save(): Promise<void> {
    this.writing = this.writing.then(() => this.flush());
    return this.writing;
  }

  private async flush(): Promise<void> {
    const ids = [...this.changed];
    this.changed.clear();
    await Promise.all(
      ids.map(async (id) => {
        const shard = this.shards.get(id);
        if (!shard) return;
        const path = `${this.dir}/${id}.json`;
        try {
          await this.host.store.write(path, { v: 1, dims: shard.dims, vectors: Object.fromEntries([...shard.vectors].map(([hash, kept]) => [hash, encode(kept.q)])) });
        } catch (error) {
          this.changed.add(id);
          this.host.log("warn", `[LumiAH] the vectors at ${path} couldn't be kept (${errorText(error)})`);
        }
      }),
    );
  }
}

// ---------------------------------------------------------------- what was embedded, and when

/** An hour. Not a setting: the count is kept by the hour, which is a stored format. */
const HOUR_MS = 3_600_000;

/**
 * The cap's window. Not a setting: the cap is set for a day, and a day that rolls with the clock
 * has no midnight, so what was embedded is never forgotten all at once.
 */
const DAY_MS = 24 * HOUR_MS;

/** What was embedded: stored texts, the tokens of stored texts and of queries together (as estimated), and queries. */
interface Count {
  texts: number;
  tokens: number;
  queries: number;
}

const isCount = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v) && v >= 0;

/** A stored count, read: anything that isn't a number from zero up counts nothing. */
function countFrom(raw: unknown): Count {
  const of = (v: unknown): number => (isCount(v) ? v : 0);
  return isRecord(raw) ? { texts: of(raw.texts), tokens: of(raw.tokens), queries: of(raw.queries) } : { texts: 0, tokens: 0, queries: 0 };
}

function countIn(into: Count, more: Count): void {
  into.texts += more.texts;
  into.tokens += more.tokens;
  into.queries += more.queries;
}

/**
 * The count of what was embedded (`recall/embedded.json`): everything since the count began, and
 * each hour of the last day, which the daily cap is held against. What this process embeds is
 * counted the moment it is, in memory; what earlier runs embedded is counted in once the document
 * was read, and nothing is written before that, so a document that couldn't be read is never
 * replaced by a count that left it out.
 */
class Ledger {
  private readonly all: Count = { texts: 0, tokens: 0, queries: 0 };
  /** The hours that embedded something, by when each began. */
  private readonly hours = new Map<number, Count>();
  private merged = false;
  private merging: Promise<boolean> | null = null;
  private changed = false;
  private writing: Promise<void> = Promise.resolve();

  constructor(private readonly host: Pick<HarnessHost, "store" | "clock" | "log">) {}

  /**
   * Whether an hour that began at `at` counts at `now`: until the whole of it is a day past, so the
   * cap holds over any 24 hours. An hour that hasn't begun counts nothing: no clock put it there.
   */
  private static within(at: number, now: number): boolean {
    return at + HOUR_MS > now - DAY_MS && at <= now;
  }

  /** Counts in what the store holds, once. False where it couldn't be read: it is read again at the next ask. */
  ready(): Promise<boolean> {
    if (this.merged) return Promise.resolve(true);
    this.merging ??= this.merge().finally(() => {
      this.merging = null;
    });
    return this.merging;
  }

  private async merge(): Promise<boolean> {
    try {
      const raw = await this.host.store.read(EMBEDDED);
      // Outside data: what isn't a count counts nothing, and only the last day's hours are taken.
      if (isRecord(raw) && raw.v === 1) {
        countIn(this.all, countFrom(raw.all));
        const now = this.host.clock.now();
        for (const hour of Array.isArray(raw.hours) ? raw.hours : []) {
          if (!isRecord(hour) || !isCount(hour.at)) continue;
          const at = Math.floor(hour.at / HOUR_MS) * HOUR_MS;
          if (Ledger.within(at, now)) countIn(this.hour(at), countFrom(hour));
        }
      }
      this.merged = true;
      return true;
    } catch (error) {
      this.host.log("warn", `[LumiAH] what has been embedded so far couldn't be read (${errorText(error)}): nothing more is embedded until it can be`);
      return false;
    }
  }

  private hour(at: number): Count {
    let hour = this.hours.get(at);
    if (!hour) this.hours.set(at, (hour = { texts: 0, tokens: 0, queries: 0 }));
    return hour;
  }

  /** Counts an embedding call that was made, at the host's clock. */
  add(more: Count): void {
    countIn(this.all, more);
    countIn(this.hour(Math.floor(this.host.clock.now() / HOUR_MS) * HOUR_MS), more);
    this.changed = true;
  }

  /** What the last 24 hours embedded. */
  day(): Count {
    const now = this.host.clock.now();
    const out: Count = { texts: 0, tokens: 0, queries: 0 };
    for (const [at, hour] of this.hours) if (Ledger.within(at, now)) countIn(out, hour);
    return out;
  }

  /** Everything embedded since the count began. */
  total(): Count {
    return { ...this.all };
  }

  /** Writes the count where it changed, one write at a time. Never rejects: a write that fails is logged, and the count is written again with the next. */
  save(): Promise<void> {
    this.writing = this.writing.then(async () => {
      if (!this.changed || !this.merged) return;
      this.changed = false;
      const now = this.host.clock.now();
      for (const at of [...this.hours.keys()]) if (at + HOUR_MS <= now - DAY_MS) this.hours.delete(at);
      const hours = [...this.hours].sort(([a], [b]) => a - b).map(([at, hour]) => ({ at, ...hour }));
      try {
        await this.host.store.write(EMBEDDED, { v: 1, all: { ...this.all }, hours });
      } catch (error) {
        this.changed = true;
        this.host.log("warn", `[LumiAH] what was embedded couldn't be kept (${errorText(error)})`);
      }
    });
    return this.writing;
  }
}

// ---------------------------------------------------------------- the search and the loop

/** A text that waits for a vector. */
interface Waiting {
  owner: MeaningOwner;
  who: string;
  hash: string;
  text: string;
}

/** An owner a batch's vector goes to, and the text it stops waiting for. */
interface Holder {
  state: Owned;
  id: string;
}

const KINDS = ["chat", "book"] as const;

/** A text there is something of to embed: Lumiverse refuses an empty one, and one of blanks alone says nothing. */
const embeddable = (text: MeaningText): boolean => text.hash !== "" && /\S/.test(text.text);

/** A text as an embedding call carries it: as given, cut only where it is longer than Lumiverse takes. */
const sendable = (text: string): string => (text.length <= EMBED_TEXT_MAX ? text : text.slice(0, wholeCut(text, EMBED_TEXT_MAX)));

/** A query as it is embedded: without the blanks around it, and no longer than a stored text is. */
function queryText(query: string, settings: Readonly<Settings>): string {
  const text = query.trim();
  const most = Math.min(EMBED_TEXT_MAX, settings.recall.meaning.textChars);
  return text.length <= most ? text : text.slice(0, wholeCut(text, most)).trimEnd();
}

/** The texts one embedding call carries: Settings', and never more than Lumiverse takes. */
const batchOf = (settings: Readonly<Settings>): number => Math.min(EMBED_BATCH_MAX, Math.max(1, Math.floor(settings.recall.meaning.batch) || 1));

/** What tokens cost in US dollars; null where Settings name no price. A price is for a million tokens, which is what the setting says and not a limit. */
const costOf = (tokens: number, usdPerMillion: number | null): number | null => (usdPerMillion === null ? null : (tokens * usdPerMillion) / 1_000_000);

/**
 * An embedding call nobody waits for any more: it took longer than Settings give a call, or its
 * caller was stopped. It was sent all the same and its provider may still answer it and charge, so
 * it counts against the day as a call that answered does.
 */
class LetGo extends Error {}

export class Meaning {
  /** The vectors read so far, by space and owner. */
  private readonly owned = new Map<string, Owned>();
  /** The texts that wait for a vector, in the order they came, by owner and hash. */
  private readonly waiting = new Map<string, Waiting>();
  /** The waiting texts of a call the loop let go, by owner and hash: the loop passes them over until the next search or status asks for it, so one call that never answers holds up nothing behind it and isn't sent again by itself. */
  private readonly heldBack = new Set<string>();
  /** The dimensions of the vectors the embedder last gave, by space. */
  private readonly dims = new Map<string, number>();
  /** The vectors of the queries asked last, by space and text, the last asked at the end: a search that is paged asks the same query again. As many as one embedding call carries are kept. */
  private readonly queried = new Map<string, Float32Array>();
  private readonly ledger: Ledger;
  /** The loop, while it runs. */
  private working: Promise<void> | null = null;
  /** Something asked for the loop while it ran: it looks once more before it rests. */
  private again = false;
  /** The settings of the last search or status: the loop's batch, cap and estimate are theirs, and it stops once they switch search by meaning off. */
  private settings: Readonly<Settings> | null = null;
  /** How many searches and statuses there have been: what an owner's last use is told by. */
  private asks = 0;

  constructor(private readonly host: Pick<HarnessHost, "recall" | "store" | "clock" | "log" | "chat">) {
    this.ledger = new Ledger(host);
  }

  /**
   * The texts of `groups` closest in meaning to each query. Texts that have no vector yet are
   * embedded in the background, under the daily cap, and found by a later search: this one searches
   * the vectors there are. Never rejects: where the embedder fails, the search finds nothing by
   * meaning and the log says why.
   */
  async search(input: MeaningSearch): Promise<MeaningFound> {
    const { queries, signal } = input;
    this.settings = input.settings;
    if (!input.settings.recall.meaning.enabled) return nothing("off", queries);
    const port = this.host.recall?.embeddings;
    if (!port) return nothing("none", queries);
    try {
      const info = await port.connection();
      if (!info) return nothing("none", queries);
      return { state: "on", matches: await this.closest(port, spaceOf(info), input) };
    } catch (error) {
      // A search its caller stopped didn't fail.
      if (!signal?.aborted) this.host.log("warn", `[LumiAH] search by meaning failed (${errorText(error)}): this search finds nothing by meaning`);
      return nothing("on", queries);
    }
  }

  /** How much of a chat and its lore is embedded, and what embedding has cost. Never rejects: what couldn't be read is logged and counts nothing. */
  async status(input: MeaningStatusInput): Promise<EmbedStatus> {
    const { settings } = input;
    const meaning = settings.recall.meaning;
    this.settings = settings;
    const groups = input.chat ? [...input.lore, input.chat] : [...input.lore];
    // A text of nothing is none to embed: it is left out of both counts, so what is embedded can reach the total.
    const total = (list: readonly MeaningGroup[]): number => list.reduce((n, group) => n + group.texts.filter(embeddable).length, 0);
    const lore = { embedded: 0, total: total(input.lore) };
    const messages = { embedded: 0, total: input.chat ? total([input.chat]) : 0 };
    // What has no vector, by hash: a text two owners share is sent once. Every text, until the vectors there are were read.
    const lacks = new Map<string, string>();
    for (const group of groups) for (const text of group.texts) if (embeddable(text)) lacks.set(text.hash, text.text);
    let connection: EmbedStatus["connection"] = null;
    try {
      await this.ledger.ready();
      const info = (await this.host.recall?.embeddings?.connection()) ?? null;
      if (info) {
        connection = { id: info.id, name: info.name, model: info.model, dimensions: info.dimensions };
        const space = spaceOf(info);
        const stamp = ++this.asks;
        const start = input.start === true && meaning.enabled;
        const states = await Promise.all(groups.map((group) => this.held(space, group, stamp, meaning.enabled)));
        lacks.clear();
        groups.forEach((group, at) => {
          const state = states[at];
          const count = group === input.chat ? messages : lore;
          const lacking: MeaningText[] = [];
          for (const text of group.texts) {
            if (!embeddable(text)) continue;
            if (this.fits(space, state.get(text.hash))) count.embedded++;
            else {
              lacking.push(text);
              lacks.set(text.hash, text.text);
            }
          }
          if (start) {
            this.unqueue(state, group);
            this.queue(state, lacking);
          }
        });
        this.trim(settings);
        if (start) this.start();
      }
    } catch (error) {
      this.host.log("warn", `[LumiAH] how much is embedded couldn't be read (${errorText(error)})`);
    }
    const day = this.ledger.day();
    const all = this.ledger.total();
    return {
      connection,
      enabled: meaning.enabled,
      lore,
      messages,
      pending: lore.total - lore.embedded + (messages.total - messages.embedded),
      pendingTokens: [...lacks.values()].reduce((n, text) => n + tokensOf(sendable(text), settings.loop.charsPerToken), 0),
      working: this.working !== null,
      today: { texts: day.texts, tokens: day.tokens, cost: costOf(day.tokens, meaning.usdPerMillion), cap: meaning.tokensPerDay },
      all: { texts: all.texts, tokens: all.tokens, cost: costOf(all.tokens, meaning.usdPerMillion) },
    };
  }

  /** Resolves once nothing is being embedded and nothing waits that the daily cap still allows. */
  async settled(): Promise<void> {
    while (this.working) await this.working;
  }

  // ---------------------------------------------------------------- the search

  private async closest(port: EmbeddingsPort, space: string, input: MeaningSearch): Promise<MeaningMatch[][]> {
    const { settings, queries, keep, signal } = input;
    const stamp = ++this.asks;
    const states = await Promise.all(input.groups.map((group) => this.held(space, group, stamp, true)));
    this.trim(settings);
    const have: { text: MeaningText; state: Owned; kept: Kept }[] = [];
    input.groups.forEach((group, at) => {
      const state = states[at];
      const lacking: MeaningText[] = [];
      for (const text of group.texts) {
        if (!embeddable(text)) continue;
        const kept = state.get(text.hash);
        if (!this.fits(space, kept)) lacking.push(text);
        else if (kept.q.length > 0 && (!keep || keep(text.key))) have.push({ text, state, kept });
      }
      this.unqueue(state, group);
      this.queue(state, lacking);
    });
    this.start();
    const asked = queries.map((query) => queryText(query, settings));
    const distinct = [...new Set(asked.filter((query) => query !== ""))];
    // A query is embedded only where there is a vector to compare it with.
    if (have.length === 0 || distinct.length === 0) return queries.map(() => []);
    const vectors = await this.queryVectors(port, space, distinct, settings, signal);
    const { floor } = settings.recall.meaning;
    const lists = distinct.map((): MeaningMatch[] => []);
    const stale = new Map<Owned, MeaningText[]>();
    for (const { text, state, kept } of have) {
      if (!this.fits(space, kept)) {
        // The queries came back in other dimensions than this vector was made in: its text is embedded again.
        const texts = stale.get(state);
        if (texts) texts.push(text);
        else stale.set(state, [text]);
        continue;
      }
      for (let at = 0; at < vectors.length; at++) {
        const vector = vectors[at];
        if (!vector || vector.length !== kept.q.length) continue;
        const similarity = Math.max(-1, Math.min(1, cosine(vector, kept)));
        if (similarity >= floor) lists[at].push({ key: text.key, similarity });
      }
    }
    for (const [state, texts] of stale) this.queue(state, texts);
    if (stale.size > 0) this.start();
    const most = Math.max(0, Math.floor(settings.recall.meaning.matches));
    const best = lists.map((list) => {
      // The sort keeps the groups' order where two are as close.
      list.sort((a, b) => b.similarity - a.similarity);
      const out: MeaningMatch[] = [];
      const seen = new Set<string>();
      for (const match of list) {
        if (out.length >= most) break;
        if (seen.has(match.key)) continue;
        seen.add(match.key);
        out.push(match);
      }
      return out;
    });
    return asked.map((query) => (query === "" ? [] : best[distinct.indexOf(query)].map((match) => ({ ...match }))));
  }

  /**
   * One embedding call, held to Settings' time for a call. At that time, and when the caller's own
   * signal ends (`outer`: its round of tool calls was stopped), the call is let go whether or not
   * the port answers its signal: the signal it was given ends, nobody waits for it any more, and
   * this rejects with a `LetGo`. Until then it resolves or rejects as the port's call does.
   */
  private async timed(port: EmbeddingsPort, texts: readonly string[], kind: "query" | "stored", settings: Readonly<Settings>, outer?: AbortSignal): Promise<unknown> {
    outer?.throwIfAborted();
    const ms = Math.max(1, settings.recall.meaning.callMs);
    const over = new AbortController();
    const stopped = Promise.withResolvers<never>();
    const stop = (): void => stopped.reject(new LetGo(errorText(outer?.reason)));
    outer?.addEventListener("abort", stop, { once: true });
    const call = port.embed(texts, kind, over.signal);
    const timer = this.host.clock.sleep(ms, over.signal).then(() => {
      throw new LetGo(`no answer in ${ms} ms (Time per embedding call)`);
    });
    // Whichever of the three loses is answered by nobody: it may still reject, and that is nothing to report.
    for (const one of [call, timer, stopped.promise]) one.catch(() => undefined);
    try {
      return await Promise.race([call, timer, stopped.promise]);
    } finally {
      outer?.removeEventListener("abort", stop);
      over.abort(new Error("the embedding call was let go"));
    }
  }

  /**
   * The vectors of queries, at unit length, in the order given; null for a query the embedder gave
   * no direction, and for one the day's cap has no room for, which isn't sent. Those asked before in
   * the space come from memory and cost nothing; the others are embedded in one call (in as many as
   * it takes, where they are more than one call carries). Queries count against the day's cap as
   * stored texts do: a query is sent only while the day has room for it, and a smaller one behind
   * one that doesn't fit may still go. Each call is held to Settings' time for a call (`timed`).
   */
  private async queryVectors(port: EmbeddingsPort, space: string, texts: readonly string[], settings: Readonly<Settings>, signal?: AbortSignal): Promise<(Float32Array | null)[]> {
    const found = new Map<string, Float32Array | null>();
    const asked: string[] = [];
    for (const text of texts) {
      const id = `${space}\n${text}`;
      const known = this.queried.get(id);
      if (known && known.length === this.dims.get(space)) {
        this.queried.delete(id);
        this.queried.set(id, known);
        found.set(text, known);
      } else asked.push(text);
    }
    const cost = (text: string): number => tokensOf(text, settings.loop.charsPerToken);
    // Without what earlier runs embedded the cap can't be held: no query is sent until it was read.
    const fresh: string[] = [];
    if (asked.length > 0 && (await this.ledger.ready())) {
      let room = limitOf(settings.recall.meaning.tokensPerDay) - this.ledger.day().tokens;
      for (const text of asked) {
        if (cost(text) > room) continue;
        room -= cost(text);
        fresh.push(text);
      }
    }
    const most = batchOf(settings);
    try {
      for (let from = 0; from < fresh.length; from += most) {
        const batch = fresh.slice(from, from + most);
        const sent = { texts: 0, tokens: batch.reduce((n, text) => n + cost(text), 0), queries: batch.length };
        const result = await this.timed(port, batch, "query", settings, signal).catch((error: unknown) => {
          if (error instanceof LetGo) this.ledger.add(sent);
          throw error;
        });
        this.ledger.add(sent);
        const vectors = vectorsOf(result, batch.length);
        this.dims.set(space, vectors[0].length);
        batch.forEach((text, at) => {
          const vector = unit(vectors[at]);
          found.set(text, vector);
          if (vector) this.queried.set(`${space}\n${text}`, vector);
        });
      }
    } finally {
      for (const id of this.queried.keys()) {
        if (this.queried.size <= most) break;
        this.queried.delete(id);
      }
      if (fresh.length > 0) await this.ledger.save();
    }
    return texts.map((text) => found.get(text) ?? null);
  }

  // ---------------------------------------------------------------- the vectors in memory

  /** An owner's vectors in a space: those held, or a new holder that has read nothing yet. */
  private state(space: string, owner: MeaningOwner): Owned {
    const who = `${owner.kind}:${owner.id}`;
    const key = `${space}\n${who}`;
    let state = this.owned.get(key);
    if (!state) {
      state = new Owned(this.host, space, owner, who);
      // As lately used as the owner's vectors of another space: the user changed their embedding connection, and the loop fills this one before any search asks for it.
      for (const other of this.owned.values()) if (other.who === who) state.used = Math.max(state.used, other.used);
      this.owned.set(key, state);
    }
    return state;
  }

  /**
   * An owner's vectors for the texts of its group as they stand now: read from the store where they
   * weren't yet, and, for a chat branched from another (`take`), with the vectors of the chats it
   * came from for the texts it shares with them. Where the host couldn't tell whether a chat was
   * branched, its `parent` stays undefined, and its texts wait for no vector until it can.
   */
  private async held(space: string, group: MeaningGroup, stamp: number, take: boolean): Promise<Owned> {
    const state = this.state(space, group.owner);
    state.used = Math.max(state.used, stamp);
    state.busy++;
    try {
      const hashes = group.texts.filter(embeddable).map((text) => text.hash);
      await state.load(hashes);
      if (take && typeof (await this.parentOf(state)) === "string") {
        const lacking = hashes.filter((hash) => state.ready(hash) && !state.get(hash) && !state.asked.has(hash));
        if (lacking.length > 0) await this.inherit(space, state, lacking);
      }
    } finally {
      state.busy--;
    }
    return state;
  }

  /**
   * Whether a kept vector stands for its text in a space: it is of the dimensions the embedder last
   * gave there (of any, before it gave one), or it marks a text that embedded to nothing.
   */
  private fits(space: string, kept: Kept | undefined): kept is Kept {
    return kept !== undefined && (kept.q.length === 0 || (this.dims.get(space) ?? kept.q.length) === kept.q.length);
  }

  /** The chat a chat was branched from: null for none, undefined where the host couldn't say (it is asked again at the next ask). */
  private async parentOf(state: Owned): Promise<string | null | undefined> {
    if (state.parent !== undefined) return state.parent;
    try {
      const from = (await this.host.chat.info?.(state.owner.id))?.branchedFrom;
      state.parent = typeof from === "string" && from !== "" && from !== state.owner.id ? from : null;
    } catch (error) {
      this.host.log("warn", `[LumiAH] the chat ${state.owner.id} was branched from couldn't be read (${errorText(error)}): its texts wait to be embedded until it can be`);
    }
    return state.parent;
  }

  /**
   * A branch takes the vectors of the chats it came from, for the hashes it shares with them and
   * has no vector for: its messages up to the branch are theirs, so nothing of them is embedded
   * again. The vectors are copied into the branch's own documents: it stays whole when the chat it
   * came from is deleted. Each hash is looked for once. Where the way back couldn't be followed (a
   * chat the host couldn't tell the origin of, a document that couldn't be read), the branch's own
   * origin counts as not told: its texts wait, and the way is followed again at the next ask.
   */
  private async inherit(space: string, state: Owned, hashes: readonly string[]): Promise<void> {
    let left = [...hashes];
    let from = state;
    let took = false;
    let followed = true;
    // A chat is asked once: what the host says of where chats came from is outside data, and may go round.
    const seen = new Set([state.owner.id]);
    while (left.length > 0) {
      const parent = await this.parentOf(from);
      if (parent === undefined) followed = false;
      if (typeof parent !== "string" || seen.has(parent)) break;
      seen.add(parent);
      const source = this.state(space, { kind: "chat", id: parent });
      source.busy++;
      try {
        await source.load(left);
        const still: string[] = [];
        for (const hash of left) {
          const kept = source.get(hash);
          if (this.fits(space, kept) && state.takes(hash, kept)) {
            state.put(hash, kept);
            took = true;
          } else {
            still.push(hash);
            if (!source.ready(hash)) followed = false;
          }
        }
        left = still;
      } finally {
        source.busy--;
      }
      from = source;
    }
    if (followed) for (const hash of hashes) state.asked.add(hash);
    else state.parent = undefined;
    if (took) await state.save();
  }

  /**
   * Lets go of the vectors of the owners unused longest, so memory holds those of as many chats as
   * Settings keep (`recall.chat.kept`) and of the books as many searches of the lore named: the
   * books of one search were named together and go together. An owner's vectors of a space other
   * than the one last asked for go too. The texts of an owner let go stop waiting: its next search
   * queues them again.
   */
  private trim(settings: Readonly<Settings>): void {
    const most = Math.max(1, settings.recall.chat.kept);
    const latest = new Map<string, number>();
    for (const state of this.owned.values()) latest.set(state.who, Math.max(latest.get(state.who) ?? 0, state.used));
    for (const kind of KINDS) {
      const uses = [...new Set([...this.owned.values()].filter((state) => state.owner.kind === kind).map((state) => latest.get(state.who) ?? 0))].sort((a, b) => b - a);
      const oldest = uses.length > most ? uses[most - 1] : 0;
      for (const [key, state] of this.owned) {
        if (state.owner.kind !== kind || state.busy > 0) continue;
        const last = latest.get(state.who) ?? 0;
        if (last < oldest || state.used < last) this.owned.delete(key);
      }
    }
    const kept = new Set<string>();
    for (const state of this.owned.values()) kept.add(state.who);
    for (const [id, item] of this.waiting) if (!kept.has(item.who)) this.waiting.delete(id);
  }

  // ---------------------------------------------------------------- the loop

  /**
   * Has texts of an owner wait for a vector, each once. They wait in the order of their hashes, so
   * a batch's vectors fall into few of the owner's documents: a long chat's first embedding then
   * writes each document about once, and not once a batch. Two kinds wait for none, since they may
   * have a vector after all: a text whose document couldn't be read, and the texts of a chat whose
   * origin the host couldn't tell.
   */
  private queue(state: Owned, texts: MeaningText[]): void {
    if (state.parent === undefined) return;
    texts.sort((a, b) => (a.hash < b.hash ? -1 : a.hash > b.hash ? 1 : 0));
    for (const text of texts) {
      const id = `${state.who}\n${text.hash}`;
      if (state.ready(text.hash) && !this.waiting.has(id)) this.waiting.set(id, { owner: state.owner, who: state.who, hash: text.hash, text: text.text });
    }
  }

  /**
   * An owner's waiting texts that its group no longer holds wait no more: a message the story leaves
   * out now (§24.4), or one that changed, is never embedded for it. Asked wherever a group is queued.
   */
  private unqueue(state: Owned, group: MeaningGroup): void {
    const now = new Set(group.texts.map((text) => text.hash));
    for (const [id, item] of this.waiting) if (item.who === state.who && !now.has(item.hash)) this.waiting.delete(id);
  }

  /** Whether a text waits that the day's cap still allows, as far as the count is known. A text of a call the loop let go waits for the next ask, not for the loop. */
  private allowed(): boolean {
    const settings = this.settings;
    if (!settings || !settings.recall.meaning.enabled || this.waiting.size === 0) return false;
    const room = limitOf(settings.recall.meaning.tokensPerDay) - this.ledger.day().tokens;
    for (const [id, item] of this.waiting) if (!this.heldBack.has(id) && tokensOf(sendable(item.text), settings.loop.charsPerToken) <= room) return true;
    return false;
  }

  /**
   * Starts the loop where it rests and something waits that the cap allows. Nothing waits for it:
   * `settled` does. `asked`: a search or a status asks for it, so the texts of a call the loop let
   * go are tried again; the loop's own second look doesn't try them.
   */
  private start(asked = true): void {
    if (this.working) {
      this.again = true;
      return;
    }
    if (asked) this.heldBack.clear();
    if (!this.allowed()) return;
    this.working = this.work()
      .catch((error: unknown) => this.host.log("warn", `[LumiAH] embedding stopped (${errorText(error)})`))
      .then(() => {
        this.working = null;
        // What was asked for after the loop last looked is looked at now. A batch that failed is not: it waits for the next ask.
        if (this.again) {
          this.again = false;
          this.start(false);
        }
      });
  }

  /**
   * The loop: one embedding call at a time, each of the texts that wait, as many as a call carries
   * and the day's cap allows, until none is left that it allows. A call that fails is logged and
   * ends the loop: its texts wait for the next search or status that starts it. A call that doesn't
   * answer within Settings' time for a call is let go and logged, and the loop goes on with the
   * texts behind it: the texts of that call wait for the next ask as well.
   */
  private async work(): Promise<void> {
    for (;;) {
      this.again = false;
      const settings = this.settings;
      const port = this.host.recall?.embeddings;
      if (!settings || !settings.recall.meaning.enabled || !port || this.waiting.size === 0) return;
      const batch = new Map<string, Holder[]>();
      const texts: string[] = [];
      try {
        // Without what earlier runs embedded the cap can't be held: nothing is embedded until it was read.
        if (!(await this.ledger.ready())) return;
        const info = await port.connection();
        if (!info) return;
        const space = spaceOf(info);
        await this.take(space, settings, batch, texts);
        if (texts.length === 0) return;
        const sent = { texts: texts.length, tokens: texts.reduce((n, text) => n + tokensOf(text, settings.loop.charsPerToken), 0), queries: 0 };
        const result = await this.timed(port, texts, "stored", settings).catch((error: unknown) => {
          if (!(error instanceof LetGo)) throw error;
          return error;
        });
        // A call that answered was paid for, whatever it answered; one that was let go was sent, and may be.
        this.ledger.add(sent);
        if (result instanceof LetGo) {
          this.host.log("warn", `[LumiAH] embedding ${texts.length} texts got ${result.message}: they wait for the next search, and embedding goes on with the rest`);
          for (const holders of batch.values()) for (const { id } of holders) this.heldBack.add(id);
          continue;
        }
        const vectors = vectorsOf(result, texts.length);
        this.dims.set(space, vectors[0].length);
        const changed = new Set<Owned>();
        let at = 0;
        for (const [hash, holders] of batch) {
          const kept = quantize(vectors[at++]);
          for (const { state, id } of holders) {
            state.put(hash, kept);
            changed.add(state);
            this.waiting.delete(id);
          }
        }
        await Promise.all([...changed].map((state) => state.save()));
      } catch (error) {
        this.host.log("warn", texts.length > 0 ? `[LumiAH] embedding ${texts.length} texts failed (${errorText(error)}): they wait for the next search` : `[LumiAH] the embedding connection couldn't be read (${errorText(error)}): what waits is embedded after the next search`);
        // To the back of the line: a text the embedder refuses then holds up its own batch, and not every batch behind it.
        for (const holders of batch.values()) {
          for (const { id } of holders) {
            const item = this.waiting.get(id);
            if (!item) continue;
            this.waiting.delete(id);
            this.waiting.set(id, item);
          }
        }
        return;
      } finally {
        for (const holders of batch.values()) for (const { state } of holders) state.busy--;
        await this.ledger.save();
        this.trim(settings);
      }
    }
  }

  /**
   * The next batch: the texts that wait, in the order they came, that have no vector in the space
   * and that the day's cap allows, as many as one call carries. A text that would pass the cap
   * waits, and a smaller one behind it may go. A text another owner waits for too is embedded once.
   * Each owner taken from is held (`busy`) until the caller lets it go.
   */
  private async take(space: string, settings: Readonly<Settings>, batch: Map<string, Holder[]>, texts: string[]): Promise<void> {
    // What the store holds is read first, so nothing is embedded that has a vector there (after a restart, or in a space the texts weren't queued for).
    const unread = new Map<Owned, string[]>();
    for (const item of this.waiting.values()) {
      const state = this.state(space, item.owner);
      if (state.ready(item.hash)) continue;
      const hashes = unread.get(state);
      if (hashes) hashes.push(item.hash);
      else unread.set(state, [item.hash]);
    }
    await Promise.all(
      [...unread].map(async ([state, hashes]) => {
        state.busy++;
        try {
          await state.load(hashes);
        } finally {
          state.busy--;
        }
      }),
    );
    const most = batchOf(settings);
    let room = limitOf(settings.recall.meaning.tokensPerDay) - this.ledger.day().tokens;
    for (const [id, item] of this.waiting) {
      // A text of a call the loop let go: it waits for the next ask.
      if (this.heldBack.has(id)) continue;
      const state = this.state(space, item.owner);
      // A document that couldn't be read: its texts wait, since they may have vectors there.
      if (!state.ready(item.hash)) continue;
      if (this.fits(space, state.get(item.hash))) {
        this.waiting.delete(id);
        continue;
      }
      const same = batch.get(item.hash);
      if (same) {
        state.busy++;
        same.push({ state, id });
        continue;
      }
      if (batch.size >= most) continue;
      const text = sendable(item.text);
      const tokens = tokensOf(text, settings.loop.charsPerToken);
      if (tokens > room) continue;
      room -= tokens;
      state.busy++;
      batch.set(item.hash, [{ state, id }]);
      texts.push(text);
    }
  }
}
