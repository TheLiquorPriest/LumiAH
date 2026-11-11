// A search of the lore (DESIGN §24.2, §24.5): each query ranked over the entries' titles, keys and
// text, a word in a title or a key counting for more than one in the text (Settings), and what the
// query means merged in where the user has an embedding connection. `lore_search` and the Lore page
// both answer from here, so both rank alike. Nothing here asks a model.

import { bestLines, heldTerms, queryTerms, type ShownLine } from "../lexical";
import type { Settings } from "../settings";
import { lineRoom } from "./answers";
import { keysOf, type LoreDoc } from "./lore";
import type { MeaningFound } from "./meaning";
import { mergeRanked } from "./rank";
import type { RecallRun } from "./recall";

/** An entry a search found: its score among the query's hits (the higher the better), how it was found, and how close its meaning is to the query's where it was found by that. */
export interface LoreHit {
  doc: LoreDoc;
  score: number;
  by: ("word" | "meaning")[];
  similarity?: number;
}

/** What a search of several queries found: each query's hits, the best first, in the order the queries came; and whether meaning was searched (`off` by Settings, `none` without an embedding connection). */
export interface LoreFound {
  meaning: MeaningFound["state"];
  found: { query: string; hits: LoreHit[] }[];
}

/**
 * Searches the run's lore for each query. By word, each query reads the index alone; by meaning,
 * the whole call is one request to the embedder, whatever the number of its queries. `keep`: only
 * entries it takes are found.
 */
export async function searchLore(run: RecallRun, queries: readonly string[], options: { keep?: (doc: LoreDoc) => boolean; signal?: AbortSignal } = {}): Promise<LoreFound> {
  const corpus = await run.lore();
  const { lore, meaning } = run.env.settings.recall;
  const { keep, signal } = options;
  const keepId = keep
    ? (id: string): boolean => {
        const doc = corpus.get(id);
        return doc !== undefined && keep(doc);
      }
    : undefined;
  const weights = [lore.titleWeight, lore.keyWeight];
  const words = queries.map((query) => corpus.index.search(query, { weights, ...(keepId ? { keep: keepId } : {}) }));
  const meant = await run.meaning("lore", queries, keepId, signal);
  const found = queries.map((query, i) => ({
    query,
    hits: mergeRanked(words[i] ?? [], meant.matches[i] ?? [], meaning).flatMap((ranked): LoreHit[] => {
      // An entry that left the books while the embedder answered is no hit.
      const doc = corpus.get(ranked.key);
      return doc ? [{ doc, score: ranked.score, by: ranked.by, ...(ranked.similarity !== undefined ? { similarity: ranked.similarity } : {}) }] : [];
    }),
  }));
  return { meaning: meant.state, found };
}

/** Where an entry's words match a query: its title, its keys, its text. */
export type HitField = "title" | "key" | "text";

/**
 * How an entry matches a query by its words: where it holds them, which of the query's words it
 * holds (in the query's order, as the index reads them), and the lines of its text that say the
 * most of them. It reads the entry's whole text, so it is worked out for the hits an answer shows,
 * never for every hit.
 */
export function hitDetail(doc: LoreDoc, query: string, settings: Readonly<Settings>): { fields: HitField[]; words: string[]; lines: ShownLine[] } {
  const terms = queryTerms(query);
  const { entry } = doc;
  const held: [HitField, string[]][] = [
    ["title", heldTerms(entry.title, terms)],
    ["key", heldTerms(keysOf(entry).join(", "), terms)],
    ["text", heldTerms(entry.content, terms)],
  ];
  const found = new Set(held.flatMap(([, words]) => words));
  const { lines } = settings.recall.lore;
  return {
    fields: held.flatMap(([field, words]) => (words.length > 0 ? [field] : [])),
    words: terms.filter((term) => found.has(term)),
    lines: bestLines(entry.content, terms, lines, lineRoom(settings.tools.excerptChars, lines)),
  };
}
