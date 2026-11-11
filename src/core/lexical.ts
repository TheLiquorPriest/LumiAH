// A lexical index: pieces of text, ranked by BM25 against a query's words. It answers a search an
// agent asked for (`chat_search`, `lore_search`) and orders what an agent is shown; it never decides
// what anyone reads. Deterministic: the same pieces and query rank the same.
//
// It reads every script. Words written apart are found as words, with a few English endings off. A
// script that writes no space between its words (Japanese, Chinese, Thai) or hangs endings on them
// (Korean) is found by pairs of neighbouring characters too, so a word inside a clause is found
// whether or not the platform has a word segmenter; where it has one, the longer words it finds are
// indexed as well. No piece, line or excerpt is ever cut inside a character.
//
// A key's pieces can be replaced and removed, so one index is kept between turns and only what
// changed is read again (DESIGN §24.6). A key may have head fields beside its text (a lore entry's
// title and its keys), each counted with a weight the search names.

import { cutAt } from "./util";

/**
 * Words too common to tell pieces apart. Not a setting: it is the index's vocabulary, not a limit,
 * and a search for one of these words alone is what `chat_grep` and `lore_grep` are for.
 */
const STOP = new Set(
  "a an and are as at be been but by for from had has have he her hers him his i if in into is it its me my of on or our she so than that the their them then there they this to too was we were what when where which who whom why will with you your".split(" "),
);

/** A word's plain stem: a few English endings off, so "boats" finds "boat" and "sold" stays itself. */
function stem(word: string): string {
  if (word.length > 5 && word.endsWith("ing")) return word.slice(0, -3);
  if (word.length > 4 && word.endsWith("ed")) return word.slice(0, -2);
  if (word.length > 4 && word.endsWith("es")) return word.slice(0, -2);
  if (word.length > 3 && word.endsWith("s") && !word.endsWith("ss")) return word.slice(0, -1);
  return word;
}

/** A stretch of letters, digits and the marks that sit on them: an apostrophe ends it, so "l'homme" is found by "homme" and "Ilse's" by "Ilse". */
const WORD = /[\p{L}\p{N}\p{M}]+/gu;

/**
 * A character of a script whose words aren't written apart, or take their endings without a space:
 * a stretch of them is indexed by its pairs of neighbours. The long vowel mark belongs to the kana
 * it follows. Not a setting: like the stop words, it is how the index reads.
 */
const RUN_CHAR = "\\p{sc=Han}\\p{sc=Hiragana}\\p{sc=Katakana}\\p{sc=Hangul}\\p{sc=Thai}\\p{sc=Lao}\\p{sc=Khmer}\\p{sc=Myanmar}ー";
const HAS_RUN = new RegExp(`[${RUN_CHAR}]`, "u");
const RUNS = new RegExp(`[${RUN_CHAR}]+|[^${RUN_CHAR}]+`, "gu");

/** A character that can be a word by itself: an ideograph, or a Hangul syllable ("배", a boat). It is indexed alone as well as in its pairs. */
const IDEOGRAPH = /[\p{sc=Han}\p{sc=Hangul}]/u;

/**
 * The platform's word segmenter, where it has one: it finds the words of a stretch written without
 * spaces by dictionary, the script's own whatever the locale; the locale is fixed all the same, so a
 * text gives the same words wherever the runtime's stands.
 */
const SEGMENTER = typeof Intl !== "undefined" && typeof Intl.Segmenter === "function" ? new Intl.Segmenter("en", { granularity: "word" }) : null;

/** What a text is read for: to be indexed, or as a query. A query of several characters isn't looked up by each ideograph alone, which would find every text that shares one. */
export type TokenMode = "index" | "query";

/** Adds the index words of a stretch written with no space between its words. */
function addRun(run: string, mode: TokenMode, out: string[]): void {
  const chars = [...run];
  if (chars.length === 1) {
    if (IDEOGRAPH.test(run)) out.push(run);
    return;
  }
  // The segmenter's longer words rank a text that holds the whole word above one that shares a pair of its characters. A word of two characters is one of the pairs below.
  if (SEGMENTER) for (const part of SEGMENTER.segment(run)) if (part.isWordLike && part.segment.length > 2 && [...part.segment].length > 2) out.push(part.segment);
  for (let i = 0; i + 1 < chars.length; i++) out.push(`${chars[i]}${chars[i + 1]}`);
  if (mode === "index") for (const c of chars) if (IDEOGRAPH.test(c)) out.push(c);
}

/** Adds the index word of a stretch written apart from its neighbours: stemmed, a common word or a single letter left out. */
function addWord(word: string, out: string[]): void {
  if (word.length < 2 || STOP.has(word)) return;
  out.push(stem(word));
}

/** Text that needs no folding: plain ASCII, which most of what is indexed is. */
const ASCII = /^[\x00-\x7f]*$/;

/**
 * A text's index words, in order: lower case, compatibility forms folded (a full-width letter is the
 * letter), stemmed, common words and single letters left out; a stretch of a script written without
 * spaces by its pairs of characters, its ideographs and its longer words.
 */
export function tokenize(text: string, mode: TokenMode = "index"): string[] {
  const out: string[] = [];
  const folded = (ASCII.test(text) ? text : text.normalize("NFKC")).toLowerCase();
  for (const m of folded.matchAll(WORD)) {
    const word = m[0];
    if (!HAS_RUN.test(word)) addWord(word, out);
    // A stretch may mix scripts ("SNSで話題"): each part is read as its script is.
    else {
      for (const part of word.match(RUNS) ?? []) {
        if (HAS_RUN.test(part)) addRun(part, mode, out);
        else addWord(part, out);
      }
    }
  }
  return out;
}

/** A query's words as the index looks them up, each once, in the order the query has them. */
export function queryTerms(query: string): string[] {
  return [...new Set(tokenize(query, "query"))];
}

/**
 * A cut at `at` or before, so it never splits a character or what a reader sees as one: not inside a
 * surrogate pair, and not before a mark or a joiner that belongs to the character before it.
 */
export function wholeCut(text: string, at: number): number {
  let cut = cutAt(text, Math.max(0, Math.min(text.length, at)));
  // A few steps at most: a character carries only so many marks, and a text of marks alone must still be cut somewhere.
  for (let steps = 0; steps < 8 && cut > 0 && cut < text.length; steps++) {
    const next = text.codePointAt(cut) ?? 0;
    const joins = next === 0x200d || text.charCodeAt(cut - 1) === 0x200d || (next >= 0xfe00 && next <= 0xfe0f) || /\p{M}/u.test(String.fromCodePoint(next));
    if (!joins) break;
    cut = cutAt(text, cut - 1);
  }
  return cut;
}

/** A piece of a text: where it starts and ends in it. */
export interface Piece {
  start: number;
  end: number;
}

/** What ends a sentence, with how many characters the end takes: a stop and the space after it, or a full-width stop, which no space follows. */
const SENTENCE_ENDS: readonly [mark: string, length: number][] = [[". ", 2], ["! ", 2], ["? ", 2], ["。", 1], ["！", 1], ["？", 1]];

/** Cuts `text` into a piece every `size` characters or so, at paragraph, then sentence, bounds, and never inside a character. */
export function piecesOf(text: string, size: number): Piece[] {
  const out: Piece[] = [];
  const most = Math.max(1, size);
  let start = 0;
  while (start < text.length) {
    let end = Math.min(text.length, start + most);
    if (end < text.length) {
      const para = text.lastIndexOf("\n", end);
      let sentence = -1;
      for (const [mark, length] of SENTENCE_ENDS) {
        const at = text.lastIndexOf(mark, end - length);
        if (at >= 0) sentence = Math.max(sentence, at + length);
      }
      if (para > start + most / 3) end = para + 1;
      else if (sentence > start + most / 3) end = sentence;
      else {
        // Where no paragraph or sentence ends, the cut is by length: before a character it would split, or after it where the piece has room for no other.
        const cut = wholeCut(text, end);
        end = cut > start ? cut : Math.min(text.length, start + ((text.codePointAt(start) ?? 0) > 0xffff ? 2 : 1));
      }
    }
    out.push({ start, end });
    start = end;
  }
  return out;
}

export interface LexicalHit<K> {
  key: K;
  piece: Piece;
  score: number;
}

export interface SearchOptions<K> {
  /** Only keys this takes are found. */
  keep?: (key: K) => boolean;
  /** How much a word counts in each head field, against 1 in the text: one per head, in order. A head without one counts 1. */
  weights?: readonly number[];
}

/** BM25's two constants, at the values the ranking is usually run with. Not settings: they shape the ranking, and no limit hangs on them. */
const K1 = 1.2;
const B = 0.75;

/**
 * How many removed pieces the index carries before it is packed again, and never fewer than it has
 * live ones: packing reads every posting, so it is worth it only once half of them are dead. Not a
 * setting: it trades a little memory for time, and bounds neither.
 */
const PACK_AT = 64;

function countsOf(words: readonly string[]): Map<string, number> {
  const counts = new Map<string, number>();
  for (const w of words) counts.set(w, (counts.get(w) ?? 0) + 1);
  return counts;
}

/**
 * Each piece under a key (a message, a lore entry), ranked by BM25. `size`: about how many characters
 * one piece holds. `heads`: how many head fields a key may have beside its text.
 */
export class LexicalIndex<K> {
  private readonly termIds = new Map<string, number>();
  /** Per term, for each piece that holds it: the piece's slot, how often its text holds the term, and how often each head does. */
  private postings: number[][] = [];
  /** Per term, how many live pieces hold it. */
  private readonly holders: number[] = [];
  private slotKey: K[] = [];
  private alive: boolean[] = [];
  private slotStart: number[] = [];
  private slotEnd: number[] = [];
  private slotLength: number[] = [];
  private slotTerms: number[][] = [];
  private readonly slotsOf = new Map<K, number[]>();
  private live = 0;
  private dead = 0;
  private totalLength = 0;
  private readonly stride: number;

  constructor(
    private readonly size: number,
    private readonly heads = 0,
  ) {
    this.stride = 2 + heads;
  }

  /** How many pieces it holds. */
  get count(): number {
    return this.live;
  }

  /** How many keys it holds. */
  get keys(): number {
    return this.slotsOf.size;
  }

  has(key: K): boolean {
    return this.slotsOf.has(key);
  }

  private termId(word: string): number {
    let id = this.termIds.get(word);
    if (id === undefined) {
      id = this.postings.length;
      this.termIds.set(word, id);
      this.postings.push([]);
      this.holders.push(0);
    }
    return id;
  }

  /** Indexes `text` under `key`, with its head fields, in place of what the key held. */
  add(key: K, text: string, heads: readonly string[] = []): void {
    if (this.slotsOf.has(key)) this.remove(key);
    const headCounts = heads.slice(0, this.heads).map((head) => countsOf(tokenize(head)));
    const pieces = piecesOf(text, this.size);
    // A key with no text is still found by its heads.
    if (pieces.length === 0) pieces.push({ start: 0, end: 0 });
    const slots: number[] = [];
    for (const piece of pieces) {
      const words = tokenize(text.slice(piece.start, piece.end));
      const rows = new Map<string, number[]>();
      const row = (word: string): number[] => {
        let r = rows.get(word);
        if (!r) rows.set(word, (r = new Array<number>(1 + this.heads).fill(0)));
        return r;
      };
      for (const [word, n] of countsOf(words)) row(word)[0] = n;
      headCounts.forEach((counts, h) => {
        for (const [word, n] of counts) row(word)[1 + h] = n;
      });
      const slot = this.alive.length;
      const terms: number[] = [];
      for (const [word, counts] of rows) {
        const id = this.termId(word);
        terms.push(id);
        (this.postings[id] as number[]).push(slot, ...counts);
        this.holders[id] = (this.holders[id] ?? 0) + 1;
      }
      this.slotKey.push(key);
      this.alive.push(true);
      this.slotStart.push(piece.start);
      this.slotEnd.push(piece.end);
      this.slotLength.push(words.length);
      this.slotTerms.push(terms);
      this.totalLength += words.length;
      this.live++;
      slots.push(slot);
    }
    this.slotsOf.set(key, slots);
  }

  /** Takes a key's pieces out. */
  remove(key: K): void {
    const slots = this.slotsOf.get(key);
    if (!slots) return;
    for (const slot of slots) {
      this.alive[slot] = false;
      this.totalLength -= this.slotLength[slot] ?? 0;
      for (const id of this.slotTerms[slot] ?? []) this.holders[id] = (this.holders[id] ?? 1) - 1;
      this.slotTerms[slot] = [];
      this.live--;
      this.dead++;
    }
    this.slotsOf.delete(key);
    if (this.dead >= PACK_AT && this.dead > this.live) this.pack();
  }

  /** Drops the removed pieces from every posting and numbers the live ones anew, in the order they were added. */
  private pack(): void {
    const to = new Array<number>(this.alive.length).fill(-1);
    let next = 0;
    this.alive.forEach((alive, slot) => {
      if (alive) to[slot] = next++;
    });
    const keep = <T>(list: readonly T[]): T[] => list.filter((_, slot) => this.alive[slot]);
    this.postings = this.postings.map((list) => {
      const kept: number[] = [];
      for (let i = 0; i < list.length; i += this.stride) {
        const slot = to[list[i] as number] as number;
        if (slot < 0) continue;
        kept.push(slot);
        for (let j = 1; j < this.stride; j++) kept.push(list[i + j] as number);
      }
      return kept;
    });
    this.slotKey = keep(this.slotKey);
    this.slotStart = keep(this.slotStart);
    this.slotEnd = keep(this.slotEnd);
    this.slotLength = keep(this.slotLength);
    this.slotTerms = keep(this.slotTerms);
    this.alive = new Array<boolean>(next).fill(true);
    for (const [key, slots] of this.slotsOf) this.slotsOf.set(key, slots.map((slot) => to[slot] as number));
    this.dead = 0;
  }

  /** How often each key's text holds one index word (a word as `tokenize` gives it), over all its pieces; heads aren't counted. */
  occurrences(term: string): Map<K, number> {
    const found = new Map<K, number>();
    const id = this.termIds.get(term);
    const list = id === undefined ? undefined : this.postings[id];
    if (!list) return found;
    for (let i = 0; i < list.length; i += this.stride) {
      const slot = list[i] as number;
      const n = list[i + 1] as number;
      if (!this.alive[slot] || n === 0) continue;
      const key = this.slotKey[slot] as K;
      found.set(key, (found.get(key) ?? 0) + n);
    }
    return found;
  }

  /** The best piece of each key matching `query`, best first; keys that tie stay in the order they were added. */
  search(query: string, options: SearchOptions<K> = {}): LexicalHit<K>[] {
    const words = queryTerms(query);
    if (words.length === 0 || this.live === 0) return [];
    const avg = this.totalLength / this.live || 1;
    const { keep, weights } = options;
    const kept = new Map<K, boolean>();
    const scores = new Float64Array(this.alive.length);
    const touched: number[] = [];
    for (const word of words) {
      const id = this.termIds.get(word);
      if (id === undefined) continue;
      const list = this.postings[id] as number[];
      const df = this.holders[id] ?? 0;
      if (df <= 0) continue;
      const idf = Math.log(1 + (this.live - df + 0.5) / (df + 0.5));
      for (let i = 0; i < list.length; i += this.stride) {
        const slot = list[i] as number;
        if (!this.alive[slot]) continue;
        if (keep) {
          const key = this.slotKey[slot] as K;
          let ok = kept.get(key);
          if (ok === undefined) kept.set(key, (ok = keep(key)));
          if (!ok) continue;
        }
        let tf = list[i + 1] as number;
        for (let h = 0; h < this.heads; h++) {
          const n = list[i + 2 + h] as number;
          if (n > 0) tf += n * (weights?.[h] ?? 1);
        }
        if (tf <= 0) continue;
        if (scores[slot] === 0) touched.push(slot);
        scores[slot] = (scores[slot] as number) + (idf * tf * (K1 + 1)) / (tf + K1 * (1 - B + (B * (this.slotLength[slot] ?? 0)) / avg));
      }
    }
    // Each key's best piece; a tie between pieces, or between keys, goes to the one added first.
    const best = new Map<K, { slot: number; score: number }>();
    for (const slot of touched) {
      const score = scores[slot] as number;
      const key = this.slotKey[slot] as K;
      const known = best.get(key);
      if (!known || score > known.score || (score === known.score && slot < known.slot)) best.set(key, { slot, score });
    }
    return [...best.entries()].sort((a, b) => b[1].score - a[1].score || a[1].slot - b[1].slot).map(([key, b]) => ({ key, piece: { start: this.slotStart[b.slot] ?? 0, end: this.slotEnd[b.slot] ?? 0 }, score: b.score }));
  }
}

/** A piece cut to about `max` characters at a word bound, as a hit's excerpt on one line. Neither end of it splits a character, whatever piece it is given. */
export function excerptOf(text: string, piece: Piece, max: number): string {
  const start = cutAt(text, piece.start);
  let stop = cutAt(text, Math.min(piece.end, start + Math.max(1, max)));
  if (stop < piece.end) {
    const space = text.lastIndexOf(" ", stop);
    if (space > start + max / 2) stop = space;
  }
  const cut = text.slice(start, stop).replace(/\s+/g, " ").trim();
  return stop < piece.end ? `${cut}…` : cut;
}

/** A line of a text a search shows: its number in the text, from 1, and its words, on one line. */
export interface ShownLine {
  line: number;
  text: string;
}

/** A line as it is shown: on one line, `max` characters at most, cut at a word where it is longer. */
function shownText(text: string, max: number): string {
  const flat = text.replace(/\s+/g, " ").trim();
  return excerptOf(flat, { start: 0, end: flat.length }, max);
}

/**
 * The lines of `text` that say the most of what was asked: those that hold the most of `terms` (a
 * query's words, as `queryTerms` gives them), `most` of them at most, in the text's own order. A
 * line longer than `max` characters is read sentence by sentence, and the sentence that holds the
 * most is shown. Where no line holds any (the match was in a title, or by meaning), the text's first
 * line, so a hit always shows where it starts.
 */
export function bestLines(text: string, terms: readonly string[], most: number, max: number): ShownLine[] {
  const wanted = new Set(terms);
  const scored: { line: number; order: number; text: string; score: number }[] = [];
  let first: ShownLine | null = null;
  let order = 0;
  text.split("\n").forEach((raw, i) => {
    if (raw.trim() === "") return;
    const parts = raw.length > max ? piecesOf(raw, max).map((p) => raw.slice(p.start, p.end)) : [raw];
    for (const part of parts) {
      first ??= { line: i + 1, text: shownText(part, max) };
      if (wanted.size === 0) continue;
      const held = new Set<string>();
      let hits = 0;
      for (const word of tokenize(part)) {
        if (!wanted.has(word)) continue;
        held.add(word);
        hits++;
      }
      // A line that holds more of the query's words leads; among those, the one that says them more often. Never more than nine: how often counts less than how many.
      if (held.size > 0) scored.push({ line: i + 1, order: order++, text: part, score: held.size * 10 + Math.min(hits, 9) });
    }
  });
  if (scored.length === 0) return first ? [first] : [];
  return scored
    .sort((a, b) => b.score - a.score || a.order - b.order)
    .slice(0, Math.max(1, most))
    .sort((a, b) => a.order - b.order)
    .map((s) => ({ line: s.line, text: shownText(s.text, max) }));
}

/** Which of a query's words (`terms`) a text holds, in the query's order. */
export function heldTerms(text: string, terms: readonly string[]): string[] {
  if (terms.length === 0 || text === "") return [];
  const words = new Set(tokenize(text));
  return terms.filter((term) => words.has(term));
}
