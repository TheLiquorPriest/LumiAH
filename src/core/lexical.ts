// A lexical index: pieces of text, ranked by BM25 against a query's words. It answers a search an
// agent asked for (`chat_search`, `lore_search`); it never decides what anyone reads. Deterministic:
// the same pieces and query rank the same.

/**
 * Words too common to tell pieces apart. Not a setting: it is the index's vocabulary, not a limit,
 * and a search for one of these words alone is what `chat_grep` and `lore_grep` are for.
 */
const STOP = new Set(
  "a an and are as at be been but by for from had has have he her hers him his i if in into is it its me my of on or our she so than that the their them then there they this to too was we were what when where which who whom why will with you your".split(" "),
);

/** A word's plain stem: lower case, a few English endings off, so "boats" finds "boat" and "sold" stays itself. */
function stem(word: string): string {
  if (word.length > 5 && word.endsWith("ing")) return word.slice(0, -3);
  if (word.length > 4 && word.endsWith("ed")) return word.slice(0, -2);
  if (word.length > 4 && word.endsWith("es")) return word.slice(0, -2);
  if (word.length > 3 && word.endsWith("s") && !word.endsWith("ss")) return word.slice(0, -1);
  return word;
}

/** A text's index words, in order: letters and digits, lower case, stemmed, common words and single letters left out. */
export function tokenize(text: string): string[] {
  const out: string[] = [];
  for (const m of text.toLowerCase().matchAll(/[\p{L}\p{N}]+(?:'[\p{L}]+)?/gu)) {
    const word = m[0].replace(/'s$/u, "");
    if (word.length < 2 || STOP.has(word)) continue;
    out.push(stem(word));
  }
  return out;
}

/** A piece of a text: where it starts and ends in it. */
export interface Piece {
  start: number;
  end: number;
}

/** Cuts `text` into a piece every `size` characters or so, at paragraph, then sentence, bounds. */
function piecesOf(text: string, size: number): Piece[] {
  const out: Piece[] = [];
  const most = Math.max(1, size);
  let start = 0;
  while (start < text.length) {
    let end = Math.min(text.length, start + most);
    if (end < text.length) {
      const para = text.lastIndexOf("\n", end);
      const sentence = Math.max(text.lastIndexOf(". ", end), text.lastIndexOf("! ", end), text.lastIndexOf("? ", end));
      if (para > start + most / 3) end = para + 1;
      else if (sentence > start + most / 3) end = sentence + 2;
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

/** BM25's two constants, at the values the ranking is usually run with. Not settings: they shape the ranking, and no limit hangs on them. */
const K1 = 1.2;
const B = 0.75;

/** Each piece under a key (a message, a lore entry), ranked by BM25. Built once for what a turn reads, so nothing is ever removed from it. */
export class LexicalIndex<K> {
  private readonly entries: { key: K; piece: Piece; length: number }[] = [];
  private readonly postings = new Map<string, number[]>();
  private totalLength = 0;

  /** `size`: about how many characters one piece holds. */
  constructor(private readonly size: number) {}

  /** How many pieces it holds. */
  get count(): number {
    return this.entries.length;
  }

  /** Indexes `text` under `key`. */
  add(key: K, text: string): void {
    for (const piece of piecesOf(text, this.size)) {
      const words = tokenize(text.slice(piece.start, piece.end));
      const counts = new Map<string, number>();
      for (const w of words) counts.set(w, (counts.get(w) ?? 0) + 1);
      const id = this.entries.length;
      this.entries.push({ key, piece, length: words.length });
      this.totalLength += words.length;
      for (const [w, n] of counts) {
        const list = this.postings.get(w);
        if (list) list.push(id, n);
        else this.postings.set(w, [id, n]);
      }
    }
  }

  /** The best piece of each key matching `query`, best first; keys that tie stay in the order they were added. */
  search(query: string): LexicalHit<K>[] {
    const words = [...new Set(tokenize(query))];
    const live = this.entries.length;
    if (words.length === 0 || live === 0) return [];
    const avg = this.totalLength / live || 1;
    const scores = new Map<number, number>();
    for (const w of words) {
      const list = this.postings.get(w);
      if (!list) continue;
      const df = list.length / 2;
      const idf = Math.log(1 + (live - df + 0.5) / (df + 0.5));
      for (let i = 0; i < list.length; i += 2) {
        const id = list[i] as number;
        const entry = this.entries[id];
        if (!entry) continue;
        const tf = list[i + 1] as number;
        const score = (idf * tf * (K1 + 1)) / (tf + K1 * (1 - B + (B * entry.length) / avg));
        scores.set(id, (scores.get(id) ?? 0) + score);
      }
    }
    // Each key's best piece; a tie between pieces, or between keys, goes to the one added first.
    const best = new Map<K, { hit: LexicalHit<K>; id: number }>();
    for (const [id, score] of scores) {
      const entry = this.entries[id];
      if (!entry) continue;
      const known = best.get(entry.key);
      if (!known || score > known.hit.score || (score === known.hit.score && id < known.id)) best.set(entry.key, { hit: { key: entry.key, piece: entry.piece, score }, id });
    }
    return [...best.values()].sort((a, b) => b.hit.score - a.hit.score || a.id - b.id).map((b) => b.hit);
  }
}

/** A piece cut to about `max` characters at a word bound, as a hit's excerpt on one line. */
export function excerptOf(text: string, piece: Piece, max: number): string {
  let stop = Math.min(piece.end, piece.start + Math.max(1, max));
  if (stop < piece.end) {
    const space = text.lastIndexOf(" ", stop);
    if (space > piece.start + max / 2) stop = space;
  }
  const cut = text.slice(piece.start, stop).replace(/\s+/g, " ").trim();
  return stop < piece.end ? `${cut}…` : cut;
}
