// How chat_search finds (DESIGN §24.4, §24.5): each query's messages by word and by meaning, merged
// into one ranking, then grouped by where they stand in the chat. Hits near each other make one
// stretch (an exchange and what follows from it), and a stretch shows only its best hits: a scene
// that says a word in every line takes one place on the page, and the other places the word turned
// up stay in sight.

import type { ChatDoc, ChatRun } from "./chat";
import type { MeaningFound } from "./meaning";
import { mergeRanked } from "./rank";
import type { RecallRun } from "./recall";

/** A message a query found. */
export interface ChatHit {
  doc: ChatDoc;
  /** Its place in the query's ranking, from 0: the lower the better. */
  rank: number;
  /** How it was found. */
  by: readonly ("word" | "meaning")[];
  /** How close its meaning is to the query's, where it was found by that. */
  similarity?: number;
}

/** Hits that stand near each other in the chat. */
export interface ChatStretch {
  /** Every hit of it, in chat order. */
  hits: ChatHit[];
  /** Its best hits, as many as Settings show of one stretch, in chat order. */
  shown: ChatHit[];
  /** The others, in chat order: an answer counts them. */
  rest: ChatHit[];
}

/** What one query found. */
export interface ChatFound {
  query: string;
  /** How many messages it found. */
  messages: number;
  /** The stretches they make, ordered by each one's best hit, the best first. */
  stretches: ChatStretch[];
}

export interface ChatSearched {
  /** Whether meaning was searched beside the words (`MeaningFound.state`). */
  state: MeaningFound["state"];
  /** What each query found, in the order the queries were given. */
  queries: ChatFound[];
}

/** A query's hits as the stretches they make: hits no further apart than `gap` message numbers are one, and each shows its `most` best. */
function stretchesOf(hits: readonly ChatHit[], gap: number, most: number): ChatStretch[] {
  const groups: ChatHit[][] = [];
  for (const hit of [...hits].sort((a, b) => a.doc.index - b.doc.index)) {
    const group = groups.at(-1);
    const before = group?.at(-1);
    if (group && before && hit.doc.index - before.doc.index <= gap) group.push(hit);
    else groups.push([hit]);
  }
  return groups
    .map((group) => {
      const best = new Set([...group].sort((a, b) => a.rank - b.rank).slice(0, most));
      return { stretch: { hits: group, shown: group.filter((hit) => best.has(hit)), rest: group.filter((hit) => !best.has(hit)) }, rank: group.reduce((least, hit) => Math.min(least, hit.rank), Number.POSITIVE_INFINITY) };
    })
    .sort((a, b) => a.rank - b.rank)
    .map((one) => one.stretch);
}

/**
 * Searches the run's chat for each of `queries`: by word in the chat's index and, where the user has
 * an embedding connection, by meaning (one call for all the queries), the two merged for each query.
 * `keep` narrows what may be found (a range of messages, a speaker). Never rejects for want of
 * meaning: a search that can't be made by meaning is made by word.
 */
export async function searchChat(run: RecallRun, chat: ChatRun, queries: readonly string[], options: { keep?: (doc: ChatDoc) => boolean; signal?: AbortSignal } = {}): Promise<ChatSearched> {
  const { keep, signal } = options;
  const settings = run.env.settings.recall;
  // The index holds every run's messages by id: only this run's are found, and of those only the ones the call keeps.
  const kept = (id: string): boolean => {
    const doc = chat.byId(id);
    return doc !== undefined && (keep === undefined || keep(doc));
  };
  const meaning = await run.meaning("chat", queries, kept, signal);
  const gap = Math.max(0, settings.chat.stretchGap);
  const most = Math.max(1, settings.chat.stretchHits);
  return {
    state: meaning.state,
    queries: queries.map((query, q): ChatFound => {
      const ranked = mergeRanked(chat.index.search(query, { keep: kept }), meaning.matches[q] ?? [], settings.meaning);
      const hits: ChatHit[] = [];
      for (const found of ranked) {
        const doc = chat.byId(found.key);
        if (doc) hits.push({ doc, rank: hits.length, by: found.by, ...(found.similarity !== undefined ? { similarity: found.similarity } : {}) });
      }
      return { query, messages: hits.length, stretches: stretchesOf(hits, gap, most) };
    }),
  };
}
