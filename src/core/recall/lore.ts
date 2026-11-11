// A chat's lore as §24 reads it (DESIGN §24.2, §24.6): every entry of every world book that applies,
// with its state, indexed for search by title, keys and text. One is kept for a chat between turns
// and brought up to date at the start of each run: an entry that didn't change is neither read into
// the index again nor given a new id, so the common turn pays for a comparison and nothing else.
//
// Lumiverse is the data surface: the entries are read through the host's recall port where it has
// one (every book in one call, with each entry's state), else through `LorePort`, which knows less
// of an entry. Nothing here is stored.

import { LexicalIndex } from "../lexical";
import type { HarnessHost } from "../ports";
import { isRecord } from "../ports";
import type { LoreBookRead, LoreBookRecord, LoreRecord } from "./ports";

/** An entry as the tools name it: the entry, its book, and the short id an agent reads it by. */
export interface LoreDoc {
  entry: LoreRecord;
  book: LoreBookRecord;
  /** The shortest start of the entry's id that names it alone among the entries that apply. */
  short: string;
  /** Its text in lower case, made the first time a link is looked for in it. */
  lower?: string;
}

/**
 * Where an entry's short id starts: a host's ids are UUIDs, whose first group is eight characters.
 * Not a setting: the id grows from there until it names one entry, so nothing is limited by it.
 */
const SHORT_ID = 8;

/** The head fields an entry is indexed with beside its text, in the order a search weighs them: its title, then its keys. */
export const LORE_HEADS = 2;

const strings = (value: unknown): string[] => (Array.isArray(value) ? value.filter((v): v is string => typeof v === "string") : []);

/** An entry as the host gave it, read: outside data, so what isn't there reads as empty and a flag that isn't one as unset. Null for one without an id. */
function entryOf(raw: unknown, bookId: string): LoreRecord | null {
  if (!isRecord(raw) || typeof raw.id !== "string" || raw.id === "") return null;
  const role = raw.role === "system" || raw.role === "user" || raw.role === "assistant" ? raw.role : null;
  return {
    id: raw.id,
    bookId,
    title: typeof raw.title === "string" ? raw.title : "",
    keys: strings(raw.keys),
    secondaryKeys: strings(raw.secondaryKeys),
    content: typeof raw.content === "string" ? raw.content : "",
    // An entry is on unless the host says it is off.
    enabled: raw.enabled !== false,
    constant: raw.constant === true,
    vectorized: raw.vectorized === true,
    regex: raw.regex === true,
    role,
    order: typeof raw.order === "number" && Number.isFinite(raw.order) ? raw.order : 0,
    updatedAt: typeof raw.updatedAt === "number" && Number.isFinite(raw.updatedAt) ? raw.updatedAt : 0,
  };
}

const sameList = (a: readonly string[], b: readonly string[]): boolean => a.length === b.length && a.every((v, i) => v === b[i]);

/** Whether two readings of an entry say the same of it: then its index, its links and its vector all stand. */
function sameEntry(a: LoreRecord, b: LoreRecord): boolean {
  return a.content === b.content && a.title === b.title && a.enabled === b.enabled && a.constant === b.constant && a.vectorized === b.vectorized && a.regex === b.regex && a.role === b.role && a.order === b.order && a.bookId === b.bookId && sameList(a.keys, b.keys) && sameList(a.secondaryKeys, b.secondaryKeys);
}

/** The shortest start of each id, `SHORT_ID` characters at least, that no other id of the list starts with. Sorted neighbours share the longest starts, so each id is compared with two others, whatever the list's length. */
function shortIds(ids: readonly string[]): Map<string, string> {
  const sorted = [...ids].sort();
  const shared = (a: string, b: string | undefined): number => {
    if (b === undefined) return 0;
    let n = 0;
    while (n < a.length && n < b.length && a[n] === b[n]) n++;
    return n;
  };
  return new Map(sorted.map((id, i) => [id, id.slice(0, Math.min(id.length, Math.max(SHORT_ID, shared(id, sorted[i - 1]) + 1, shared(id, sorted[i + 1]) + 1)))]));
}

/** An entry's keys as one text: its head field in the index, and what the tools show. */
export function keysOf(entry: LoreRecord): string[] {
  return [...entry.keys, ...entry.secondaryKeys];
}

/**
 * The id a reference to an entry holds, as a model may copy one from an answer: in its brackets
 * (with or without the title that follows them), or with its book before a slash.
 */
export function refId(ref: string): string {
  const text = ref.trim();
  const inner = /^\[([^\]]*)\]/.exec(text)?.[1] ?? text;
  return (inner.split("/").at(-1) ?? "").trim().replace(/^\[|\]$/g, "").trim();
}

export class LoreCorpus {
  /** The entries' text by entry id, each with its title and its keys as heads. */
  index: LexicalIndex<string>;
  /** Every entry of every book that applies, in the books' order. */
  docs: LoreDoc[] = [];
  books: LoreBookRecord[] = [];
  /** Moves whenever an entry's words changed, an entry came or one went: what is worked out from them is good until it does. */
  version = 0;
  private byId = new Map<string, LoreDoc>();
  private last: { run: string; done: Promise<void> } | null = null;

  constructor(
    private readonly host: Pick<HarnessHost, "lore" | "recall">,
    private readonly chatId: string,
    private pieceChars: number,
  ) {
    this.index = new LexicalIndex<string>(pieceChars, LORE_HEADS);
  }

  /**
   * Brings the corpus up to date with the books, once for each run: every tool call of a run, and
   * what the run's main agent is told of the prompt, read the lore as it stood when the run first
   * asked. A read that fails is tried again by the next call.
   */
  sync(run: string, pieceChars: number): Promise<void> {
    if (this.last?.run === run) return this.last.done;
    const before = this.last?.done.catch(() => undefined) ?? Promise.resolve();
    const done = before.then(() => this.read(pieceChars));
    const held = { run, done };
    this.last = held;
    done.catch(() => {
      if (this.last === held) this.last = null;
    });
    return done;
  }

  get(id: string): LoreDoc | undefined {
    return this.byId.get(id);
  }

  /**
   * The entries `ref` names: one by its whole id, by the short id the tools show, or by the start of
   * its id; several when the start names more than one.
   */
  named(ref: string): LoreDoc[] {
    const id = refId(ref);
    if (id === "") return [];
    const exact = this.byId.get(id) ?? this.docs.find((doc) => doc.short === id);
    return exact ? [exact] : this.docs.filter((doc) => doc.entry.id.startsWith(id));
  }

  /** The books and their entries as the host has them now: through the recall port, which may say a book didn't change, else through `LorePort`, a request for each book. */
  private async fromHost(): Promise<LoreBookRead[]> {
    const port = this.host.recall?.lore;
    if (port) {
      const known: Record<string, number> = {};
      for (const doc of this.docs) if (doc.book.updatedAt > 0) known[doc.book.id] = doc.book.updatedAt;
      return port.read(this.chatId, known);
    }
    const books = await this.host.lore.books(this.chatId);
    return Promise.all(books.map(async (book): Promise<LoreBookRead> => ({ id: book.id, name: book.name, description: book.description, source: null, updatedAt: 0, entries: (await this.host.lore.entries(book.id)).map((e) => ({ ...e, vectorized: false, regex: false, role: null, order: 0, updatedAt: 0 })) })));
  }

  private async read(pieceChars: number): Promise<void> {
    if (pieceChars !== this.pieceChars) {
      // Search piece changed: every entry is cut anew.
      this.pieceChars = pieceChars;
      this.index = new LexicalIndex<string>(pieceChars, LORE_HEADS);
      this.docs = [];
      this.byId = new Map();
    }
    const read: unknown = await this.fromHost();
    const kept = new Map<string, LoreDoc[]>();
    for (const doc of this.docs) {
      const list = kept.get(doc.book.id);
      if (list) list.push(doc);
      else kept.set(doc.book.id, [doc]);
    }
    const next: LoreDoc[] = [];
    const books: LoreBookRecord[] = [];
    const seen = new Set<string>();
    let changed = false;
    for (const raw of Array.isArray(read) ? read : []) {
      // A book a host lists twice (it applies from two places) is one book.
      if (!isRecord(raw) || typeof raw.id !== "string" || books.some((known) => known.id === raw.id)) continue;
      const source = raw.source === "character" || raw.source === "persona" || raw.source === "chat" || raw.source === "global" ? raw.source : null;
      const book: LoreBookRecord = { id: raw.id, name: typeof raw.name === "string" ? raw.name : raw.id, description: typeof raw.description === "string" ? raw.description : "", source, updatedAt: typeof raw.updatedAt === "number" && Number.isFinite(raw.updatedAt) ? raw.updatedAt : 0 };
      books.push(book);
      // A book the host says didn't change keeps the entries it was last read with.
      if (!Array.isArray(raw.entries)) {
        for (const doc of kept.get(book.id) ?? []) {
          if (seen.has(doc.entry.id)) continue;
          seen.add(doc.entry.id);
          doc.book = book;
          next.push(doc);
        }
        continue;
      }
      for (const given of raw.entries) {
        const entry = entryOf(given, book.id);
        if (!entry || seen.has(entry.id)) continue;
        seen.add(entry.id);
        const was = this.byId.get(entry.id);
        if (was && sameEntry(was.entry, entry)) {
          was.entry = entry;
          was.book = book;
          next.push(was);
          continue;
        }
        this.index.add(entry.id, entry.content, [entry.title, keysOf(entry).join(", ")]);
        changed = true;
        next.push({ entry, book, short: "" });
      }
    }
    for (const doc of this.docs) {
      if (seen.has(doc.entry.id)) continue;
      this.index.remove(doc.entry.id);
      changed = true;
    }
    if (changed || next.length !== this.docs.length) {
      const short = shortIds(next.map((doc) => doc.entry.id));
      for (const doc of next) doc.short = short.get(doc.entry.id) ?? doc.entry.id;
      this.version++;
    }
    this.docs = next;
    this.books = books;
    this.byId = new Map(next.map((doc) => [doc.entry.id, doc]));
  }
}

// ---------------------------------------------------------------- the lore's own links (§24.2)

/** An ideograph: a name of one such character is a name; one of any other single character isn't. */
const IDEOGRAPH = /\p{sc=Han}/u;

/** A letter or a digit: what a name must not run into at either end to stand as a word of its own. */
const WORD_CHAR = /[\p{L}\p{N}]/u;

/** A character of a script written without spaces: a name that ends in one is found wherever it stands, since nothing sets a word apart there. */
const UNSPACED = /[\p{sc=Han}\p{sc=Hiragana}\p{sc=Katakana}\p{sc=Thai}\p{sc=Lao}\p{sc=Khmer}\p{sc=Myanmar}]/u;

/**
 * The names an entry goes by, in lower case: its title and its keys, each once. A key that is a
 * regular expression is no name, and neither is one of a single letter. Secondary keys narrow when
 * an entry activates and name nothing, so they are left out.
 */
export function namesOf(entry: LoreRecord): string[] {
  const names = new Set<string>();
  for (const raw of [entry.title, ...(entry.regex ? [] : entry.keys)]) {
    const name = raw.replace(/\s+/g, " ").trim().toLowerCase();
    if (name.length >= 2 || IDEOGRAPH.test(name)) names.add(name);
  }
  return [...names];
}

/** The character that ends before `at`, a surrogate pair whole. */
function charBefore(text: string, at: number): string {
  const unit = text.charCodeAt(at - 1);
  return unit >= 0xdc00 && unit <= 0xdfff && at >= 2 ? text.slice(at - 2, at) : text.slice(at - 1, at);
}

/**
 * Where `name` (in lower case) stands in `lower` as a word or a phrase of its own, from `from` on;
 * -1 where it doesn't. "mill" isn't found in "miller": a name that starts or ends with a letter
 * must not run into another there, except in a script that writes no space between its words.
 */
export function findName(lower: string, name: string, from = 0): number {
  if (name === "") return -1;
  const first = String.fromCodePoint(name.codePointAt(0) ?? 0);
  const last = charBefore(name, name.length);
  const boundBefore = WORD_CHAR.test(first) && !UNSPACED.test(first);
  const boundAfter = WORD_CHAR.test(last) && !UNSPACED.test(last);
  for (let at = lower.indexOf(name, from); at >= 0; at = lower.indexOf(name, at + 1)) {
    const end = at + name.length;
    if (boundBefore && at > 0 && WORD_CHAR.test(charBefore(lower, at))) continue;
    if (boundAfter && end < lower.length && WORD_CHAR.test(String.fromCodePoint(lower.codePointAt(end) ?? 0))) continue;
    return at;
  }
  return -1;
}

/** How often `name` stands in `lower` as a word or a phrase of its own. */
export function countName(lower: string, name: string): number {
  let n = 0;
  for (let at = findName(lower, name); at >= 0; at = findName(lower, name, at + name.length)) n++;
  return n;
}

/** An entry's text in lower case, kept on it once made. */
export function lowerOf(doc: LoreDoc): string {
  return (doc.lower ??= doc.entry.content.toLowerCase());
}

/** A link between two entries: the other entry, the name it was found by, and where in the text that holds it. */
export interface LoreLink {
  doc: LoreDoc;
  by: string;
  at: number;
}

/** The entries `doc`'s text mentions: each other entry whose title or one of whose keys stands in it, by the first of its names found, in the books' order. */
export function mentionsOf(corpus: LoreCorpus, doc: LoreDoc): LoreLink[] {
  const lower = lowerOf(doc);
  const links: LoreLink[] = [];
  for (const other of corpus.docs) {
    if (other === doc) continue;
    for (const name of namesOf(other.entry)) {
      const at = findName(lower, name);
      if (at < 0) continue;
      links.push({ doc: other, by: name, at });
      break;
    }
  }
  return links;
}

/** The entries whose text mentions `names` (an entry's own, or a name asked for): each by the first name found in it, in the books' order. `except` is left out. */
export function mentionedBy(corpus: LoreCorpus, names: readonly string[], except?: LoreDoc): LoreLink[] {
  const links: LoreLink[] = [];
  for (const other of corpus.docs) {
    if (other === except) continue;
    const lower = lowerOf(other);
    for (const name of names) {
      const at = findName(lower, name);
      if (at < 0) continue;
      links.push({ doc: other, by: name, at });
      break;
    }
  }
  return links;
}

/** The line of `text` that holds the character at `at`: its number, from 1, and its words. */
export function lineAt(text: string, at: number): { line: number; text: string } {
  const start = text.lastIndexOf("\n", at - 1) + 1;
  const end = text.indexOf("\n", at);
  let line = 1;
  for (let i = text.indexOf("\n"); i >= 0 && i < start; i = text.indexOf("\n", i + 1)) line++;
  return { line, text: text.slice(start, end < 0 ? text.length : end) };
}
