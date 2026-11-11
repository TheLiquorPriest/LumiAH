// One ranking from two (DESIGN §24.2, §24.4, §24.5): what a search found by its words and what it
// found by its meaning. Each finds what the other misses, so a hit either found is kept, and one
// both found leads.

import type { Settings } from "../settings";
import type { MeaningMatch } from "./meaning";

/** A hit of the merged ranking: how it was found, its score among the hits (the higher the better), and how close its meaning is where it was found by that. */
export interface Ranked {
  key: string;
  score: number;
  by: ("word" | "meaning")[];
  similarity?: number;
}

/**
 * Merges matches by word (`words`, the best first, each with its score) and matches by meaning into
 * one ranking, the best first. Each side is brought to the same scale, from 0 to 1 (a word match
 * against the best word match; a match by meaning by how far it stands above Settings' least
 * similarity), and Settings weigh the two. Without a match by meaning the words' own order stands.
 * A tie keeps the words' order, then the meanings'.
 */
export function mergeRanked(words: readonly { key: string; score: number }[], meaning: readonly MeaningMatch[], settings: Readonly<Settings["recall"]["meaning"]>): Ranked[] {
  if (meaning.length === 0) return words.map((w) => ({ key: w.key, score: w.score, by: ["word"] }));
  const weight = Math.min(1, Math.max(0, settings.weight));
  const best = words.reduce((most, w) => Math.max(most, w.score), 0) || 1;
  const span = Math.max(1e-9, 1 - settings.floor);
  const merged = new Map<string, Ranked & { order: number }>();
  words.forEach((w, order) => merged.set(w.key, { key: w.key, score: (1 - weight) * (w.score / best), by: ["word"], order }));
  meaning.forEach((m, at) => {
    const part = weight * Math.min(1, Math.max(0, (m.similarity - settings.floor) / span));
    const known = merged.get(m.key);
    if (known) {
      known.score += part;
      known.by.push("meaning");
      known.similarity = m.similarity;
    } else merged.set(m.key, { key: m.key, score: part, by: ["meaning"], similarity: m.similarity, order: words.length + at });
  });
  return [...merged.values()].sort((a, b) => b.score - a.score || a.order - b.order).map(({ order: _order, ...hit }) => hit);
}
