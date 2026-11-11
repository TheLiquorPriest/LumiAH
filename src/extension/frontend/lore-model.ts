// What the Lore page shows (DESIGN §24.1 to §24.5), worked out from what the backend gives: each
// state's words, sign and place in the order, why an entry was in the prompt, the line that says
// how much lore a chat has, the entries by book under the filters, the searches a box asks for, how
// a hit is put and which of a line's words are marked, how a search ran, and how search by meaning
// stands. The page (pages/lore.tsx) only renders these; Live says an entry's state and why it was
// in the prompt with the same words.

import type { EmbeddingStatus, LoreBookView, LoreHit, LoreRow, LoreSearch, LoreState, LoreView, LoreWhy } from "../../shared/ui";
import { ago, count, counted, money } from "./format";
import type { IconName } from "./icons";
import type { SettingLink } from "./setting-links";

// ---------------------------------------------------------------- an entry's state

/** The states in the order the page lists them: what reached the last reply, what was kept from it, what stayed in its book, what is switched off. */
export const LORE_STATES: readonly LoreState[] = ["in_prompt", "added", "dropped", "not_in_prompt", "off"];

/** A state in a few words. */
export const LORE_STATE_WORDS: Readonly<Record<LoreState, string>> = {
  in_prompt: "In the prompt",
  added: "Added by the agent",
  dropped: "Left out of this prompt",
  not_in_prompt: "Not in the prompt",
  off: "Switched off",
};

/** A state's sign, shown with its words so the state never rests on colour alone: a tick, a plus, a cross, a book (the entry stayed in it), a power mark. */
export const LORE_STATE_ICON: Readonly<Record<LoreState, IconName>> = { in_prompt: "check", added: "plus", dropped: "close", not_in_prompt: "book", off: "power" };

/** A state's tone: what reached the reply stands out, what was kept from it warns, the rest is quiet. */
export const LORE_STATE_TONE: Readonly<Record<LoreState, "pos" | "accent" | "warn" | "neutral">> = { in_prompt: "pos", added: "accent", dropped: "warn", not_in_prompt: "neutral", off: "neutral" };

/** What a state means, said whole, for the entry that is open. `answered` is false where LumiAH has answered no reply in the chat yet. */
export function stateAbout(state: LoreState, answered: boolean): string {
  switch (state) {
    case "in_prompt":
      return "Lumiverse put it in the prompt of the last reply.";
    case "added":
      return "Lumiverse left it out of the prompt of the last reply; LumiAH's main agent added it before the reply was written.";
    case "dropped":
      return "Lumiverse put it in the prompt of the last reply; LumiAH's main agent left it out of this prompt before the reply was written. It stays in its book.";
    case "not_in_prompt":
      return answered ? "It wasn't in the prompt of the last reply." : "LumiAH hasn't answered in this chat yet. After its first reply, this says whether the entry was in the prompt.";
    case "off":
      return "It is switched off in Lumiverse.";
  }
}

/** How an entry came to be in the prompt, in plain words. */
export function whyWords(why: LoreWhy): string {
  switch (why.by) {
    case "key":
      return why.key !== null && why.key !== "" ? `a key matched: ${why.key}` : "a key matched";
    case "vector":
      return why.score !== null ? `close in meaning (${why.score.toFixed(2)})` : "close in meaning";
    case "constant":
      return "always on";
    case "unknown":
      return "Lumiverse didn't say why";
  }
}

/** What a row says after its state: how the entry came to be in the prompt. An entry the agent dropped had been in, which is said; null where nothing says how. */
export function rowWhy(row: Pick<LoreRow, "state" | "why">): string | null {
  if (row.why === undefined) return null;
  return row.state === "dropped" ? `it was in: ${whyWords(row.why)}` : whyWords(row.why);
}

/** Whether an entry in this state reached the last reply: Lumiverse put it in the prompt and it stayed, or the agent added it. */
export function reachedReply(state: LoreState): boolean {
  return state === "in_prompt" || state === "added";
}

// ---------------------------------------------------------------- a row

/** An entry's title; one without (Lumiverse's title is a comment the author may leave empty) goes by its first key. */
export function entryTitle(row: Pick<LoreRow, "title" | "keys">): string {
  const title = row.title.trim();
  return title !== "" ? title : (row.keys[0] ?? "Untitled entry");
}

/** A row's line under its state: its keys (what Lumiverse brings it into the prompt by) and its size. The size is in tokens, an estimate, as Lumiverse counts a prompt. */
export function rowSub(row: Pick<LoreRow, "keys" | "tokens">): string {
  return `${row.keys.length > 0 ? `Keys: ${row.keys.join(", ")}` : "No keys"} · ${counted(row.tokens, "token")}`;
}

/** A fact of the entry that is open: what it is, and what it says. */
export interface LoreFact {
  label: string;
  value: string;
}

/** How Lumiverse brings an entry into a prompt, from what it keeps on the entry. It says nothing of when: Lumiverse has more rules than these. */
function comesInWords(row: Pick<LoreRow, "enabled" | "constant" | "vectorized" | "keys">): string {
  if (!row.enabled) return "Switched off: Lumiverse leaves it out of every prompt.";
  if (row.constant) return "Always on: Lumiverse puts it in every prompt.";
  if (row.vectorized) return row.keys.length > 0 ? "Lumiverse brings it in by its keys, or when what is said is close to it in meaning." : "Lumiverse brings it in when what is said is close to it in meaning.";
  return row.keys.length > 0 ? "Lumiverse brings it in by its keys." : "It has no keys, so Lumiverse doesn't bring it in by itself.";
}

/** The facts of the entry that is open: its book, its keys, its size, and how Lumiverse brings it in. */
export function entryFacts(row: LoreRow, book: string | null): LoreFact[] {
  return [
    ...(book !== null ? [{ label: "Book", value: book }] : []),
    { label: "Keys", value: row.keys.length > 0 ? row.keys.join(", ") : "None" },
    ...(row.secondaryKeys.length > 0 ? [{ label: "Secondary keys", value: row.secondaryKeys.join(", ") }] : []),
    { label: "Size", value: `${counted(row.chars, "character")}, about ${counted(row.tokens, "token")}` },
    { label: "In Lumiverse", value: comesInWords(row) },
  ];
}

// ---------------------------------------------------------------- what is there

/** The page's first line: how much lore the chat has, and how much of it reached the last reply. Before LumiAH's first reply in the chat only the first is known. */
export function countsLine(view: Pick<LoreView, "books" | "entries" | "last">, now: number): string {
  const there = `${counted(view.entries.length, "entry", "entries")} in ${counted(view.books.length, "book")}.`;
  if (view.last === null) return there;
  const reached = view.entries.filter((e) => reachedReply(e.state)).length;
  return `${there} ${reached === 0 ? "None" : count(reached)} reached the last reply, ${ago(now, view.last.at)}.`;
}

// ---------------------------------------------------------------- the entries, filtered

/** What the list shows: entries in one state (null: any), of one book (null: every book). */
export interface LoreFilter {
  state: LoreState | null;
  book: string | null;
}

export const NO_LORE_FILTER: LoreFilter = { state: null, book: null };

/** What the page keeps while the user is on another page: the words in the search box and the filters, so a way to Settings and back loses neither. */
export interface LoreKept {
  box: string;
  filter: LoreFilter;
}

export const START_LORE_KEPT: LoreKept = { box: "", filter: NO_LORE_FILTER };

export function isFiltered(filter: LoreFilter): boolean {
  return filter.state !== null || filter.book !== null;
}

type Listed = Pick<LoreView, "books" | "entries">;

/** The books the entries are of: the chat's, then one for each book an entry names that Lumiverse didn't list (so no entry goes unshown). */
function booksOf(view: Listed): LoreBookView[] {
  const known = new Set(view.books.map((b) => b.id));
  const unlisted = [...new Set(view.entries.map((e) => e.bookId).filter((id) => !known.has(id)))];
  return [...view.books, ...unlisted.map((id) => ({ id, name: "A book Lumiverse didn't name", description: "", entries: view.entries.filter((e) => e.bookId === id).length }))];
}

/** The filter as it holds for this chat: a book the chat doesn't have (one chosen in another chat) filters nothing. */
export function filterFor(view: Listed, filter: LoreFilter): LoreFilter {
  return filter.book !== null && !booksOf(view).some((b) => b.id === filter.book) ? { ...filter, book: null } : filter;
}

/** A book's entries as the list shows them, and how many the book has in all. */
export interface LoreGroup {
  book: LoreBookView;
  rows: LoreRow[];
}

/**
 * The entries by book, under the filters. In each book the entries that reached the last reply come
 * first, then those kept from it, then the rest, then those switched off; entries of one state keep
 * the book's own order. Unfiltered, every book shows, an empty one too; filtered, only the books
 * that have something to show.
 */
export function groupsOf(view: Listed, filter: LoreFilter): LoreGroup[] {
  const { state, book } = filterFor(view, filter);
  const rank = (row: LoreRow): number => LORE_STATES.indexOf(row.state);
  return booksOf(view)
    .filter((b) => book === null || b.id === book)
    .map((b) => ({ book: b, rows: view.entries.filter((e) => e.bookId === b.id && (state === null || e.state === state)).sort((a, z) => rank(a) - rank(z)) }))
    .filter((g) => g.rows.length > 0 || !isFiltered({ state, book }));
}

/** A choice of the state filter: its words, its sign, and how many entries it shows. `state` null is every state. */
export interface StateChip {
  state: LoreState | null;
  label: string;
  icon: IconName | null;
  count: number;
  pressed: boolean;
}

/** The state filter's choices, counted within the book chosen: every state that has an entry, and the one pressed even when it has none (it must stay there to be let go). */
export function stateChips(view: Listed, filter: LoreFilter): StateChip[] {
  const { state, book } = filterFor(view, filter);
  const within = view.entries.filter((e) => book === null || e.bookId === book);
  const chips: StateChip[] = [{ state: null, label: "All", icon: null, count: within.length, pressed: state === null }];
  for (const s of LORE_STATES) {
    const n = within.filter((e) => e.state === s).length;
    if (n > 0 || s === state) chips.push({ state: s, label: LORE_STATE_WORDS[s], icon: LORE_STATE_ICON[s], count: n, pressed: s === state });
  }
  return chips;
}

/** The book filter's choices, each with how many entries it shows under the state chosen. `value` "" is every book. */
export function bookChoices(view: Listed, filter: LoreFilter): { value: string; label: string }[] {
  const { state } = filterFor(view, filter);
  const within = view.entries.filter((e) => state === null || e.state === state);
  return [{ value: "", label: `All books (${count(within.length)})` }, ...booksOf(view).map((b) => ({ value: b.id, label: `${b.name} (${count(within.filter((e) => e.bookId === b.id).length)})` }))];
}

/** What stands where the rows would when the filters leave none. */
export function nothingWords(view: Listed, filter: LoreFilter): string {
  const { state, book } = filterFor(view, filter);
  const name = book !== null ? booksOf(view).find((b) => b.id === book)?.name : undefined;
  const where = name !== undefined ? `“${name}”` : "this chat's books";
  if (state === null) return `There are no entries in ${where}.`;
  const words = LORE_STATE_WORDS[state];
  return `No entry of ${where} is ${words.charAt(0).toLowerCase()}${words.slice(1)}.`;
}

// ---------------------------------------------------------------- the search

/** The searches a box asks for: one, or several separated by ";", each with its spaces put right; blank ones and repeats are left out. */
export function queriesOf(box: string): string[] {
  const out: string[] = [];
  for (const part of box.split(";")) {
    const query = part.trim().replace(/\s+/g, " ");
    if (query !== "" && !out.some((q) => q.toLowerCase() === query.toLowerCase())) out.push(query);
  }
  return out;
}

/** Where Settings keep search by meaning, as the links the pages lead by: its switch (which opens its section), its daily limit and the price of its model. */
export const MEANING_SETTINGS: Readonly<Record<"enabled" | "cap" | "price", SettingLink>> = { enabled: "meaningSwitch", cap: "meaningCap", price: "meaningPrice" };

/** Where Lumiverse keeps its embedding connection, in words: no page of LumiAH's can open it. */
const IN_LUMIVERSE = "Set one in Lumiverse's settings, under Embeddings.";

/** How a search ran, said plainly: by word and by meaning, or by word only and why, with the setting that would change it where LumiAH has one. */
export function ranWords(meaning: LoreSearch["meaning"]): { words: string; setting: SettingLink | null } {
  switch (meaning) {
    case "on":
      return { words: "Searched by word and by meaning.", setting: null };
    case "off":
      return { words: "Searched by word only: search by meaning is switched off. Its switch is under the list of entries.", setting: MEANING_SETTINGS.enabled };
    case "none":
      return { words: `Searched by word only: Lumiverse has no embedding connection, the model search by meaning needs. ${IN_LUMIVERSE}`, setting: null };
  }
}

/** A stretch of letters, digits and the marks that sit on them: a word, as the agents' search reads one. */
const WORD = /[\p{L}\p{N}\p{M}]+/gu;

/**
 * The endings the agents' search takes off a word before it compares, so "boats" finds "boat". Not
 * a setting: it mirrors how that search reads words, and here it only decides what is marked and
 * how a matched word is spelled back.
 */
const ENDINGS: readonly string[] = ["", "s", "es", "ed", "ing"];

/** A character of a script written without spaces between its words: there the search matches inside a stretch, so its finds are marked wherever they stand. */
const UNSPACED = /[\p{sc=Han}\p{sc=Hiragana}\p{sc=Katakana}\p{sc=Hangul}\p{sc=Thai}\p{sc=Lao}\p{sc=Khmer}\p{sc=Myanmar}]/u;

/** Whether two words are one word to the search: the same, or one is the other with an ending the search takes off. */
function sameWord(a: string, b: string): boolean {
  const [short, long] = a.length <= b.length ? [a, b] : [b, a];
  return long.startsWith(short) && ENDINGS.includes(long.slice(short.length));
}

/** A matched word as the user typed it: the search names a word with its ending off ("tabl" for "tables"), which reads as a slip. */
function typedWord(word: string, query: string): string {
  const lower = word.toLowerCase();
  const typed = [...query.matchAll(WORD)].map((m) => m[0]);
  return typed.find((t) => t.toLowerCase() === lower) ?? typed.find((t) => sameWord(t.toLowerCase(), lower)) ?? word;
}

const FIELD_WORDS: Readonly<Record<LoreHit["fields"][number], string>> = { title: "title", key: "keys", text: "text" };

/** "title", "title and keys", "title, keys and text". */
function listed(words: readonly string[]): string {
  return words.length <= 1 ? (words[0] ?? "") : `${words.slice(0, -1).join(", ")} and ${words.at(-1) ?? ""}`;
}

/** Why a hit matched, in plain words: which of its parts hold which of the query's words, and whether it is close in meaning. */
export function matchWords(hit: Pick<LoreHit, "by" | "fields" | "words" | "similarity">, query: string): string {
  const parts: string[] = [];
  if (hit.by.includes("word")) {
    // The fields in the order they weigh, whatever order the search names them in.
    const fields = (["title", "key", "text"] as const).filter((f) => hit.fields.includes(f)).map((f) => FIELD_WORDS[f]);
    const words = [...new Set(hit.words.map((w) => typedWord(w, query)))];
    // "its title holds", "its keys hold", "its title and keys hold".
    const hold = fields.length === 1 && fields[0] !== "keys" ? "holds" : "hold";
    const where = fields.length > 0 ? `its ${listed(fields)} ${hold}` : "it holds";
    parts.push(words.length > 0 ? `${where}: ${words.join(", ")}` : `${where} the words`);
  }
  if (hit.by.includes("meaning")) {
    const close = hit.similarity !== undefined ? `close in meaning (${hit.similarity.toFixed(2)})` : "close in meaning";
    parts.push(parts.length > 0 ? `also ${close}` : close);
  }
  return parts.length > 0 ? parts.join("; ") : "it matched";
}

/** A piece of a line: marked where it is one of the words a search matched. */
export interface MarkedPiece {
  text: string;
  hit: boolean;
}

/**
 * A line cut where the words a search matched stand, for marking. A word of the line counts when it
 * is a matched word, with or without an ending the search takes off, whatever its case; "key" marks
 * "keys" and leaves "keyhole". In a script written without spaces a matched word is marked wherever
 * it stands.
 */
export function markWords(text: string, words: readonly string[]): MarkedPiece[] {
  const wanted = [...new Set(words.map((w) => w.toLowerCase()).filter((w) => w !== ""))];
  if (wanted.length === 0 || text === "") return [{ text, hit: false }];
  const spans: [number, number][] = [];
  for (const m of text.matchAll(WORD)) {
    const word = m[0].toLowerCase();
    if (wanted.some((w) => sameWord(w, word))) spans.push([m.index, m.index + m[0].length]);
  }
  const lower = text.toLowerCase();
  // Lower case is the same length for all but a few letters; where it isn't, places in it aren't places in the text, and those finds go unmarked.
  if (lower.length === text.length) {
    for (const w of wanted) {
      if (!UNSPACED.test(w)) continue;
      for (let at = lower.indexOf(w); at !== -1; at = lower.indexOf(w, at + w.length)) spans.push([at, at + w.length]);
    }
  }
  spans.sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  const out: MarkedPiece[] = [];
  let from = 0;
  for (const [start, end] of spans) {
    // A find inside one already marked adds nothing; one that runs past it lengthens the mark.
    if (end <= from) continue;
    const begin = Math.max(start, from);
    const last = out.at(-1);
    if (begin === from && last?.hit) last.text += text.slice(begin, end);
    else {
      if (begin > from) out.push({ text: text.slice(from, begin), hit: false });
      out.push({ text: text.slice(begin, end), hit: true });
    }
    from = end;
  }
  if (from < text.length) out.push({ text: text.slice(from), hit: false });
  return out;
}

type Answered = LoreSearch["queries"][number];

/** How much a query found, in words; null where it found nothing (the page then says what to try). */
export function foundWords(answer: Pick<Answered, "total" | "hits">): string | null {
  if (answer.total === 0 || answer.hits.length === 0) return null;
  const found = `${counted(answer.total, "entry", "entries")} found`;
  return answer.hits.length < answer.total ? `${found}, the best ${count(answer.hits.length)} shown` : found;
}

/** What stands where a query's hits would when it found none: that it found none, and what to try. */
export function noHitsWords(query: string): string {
  return `Nothing in this chat's books matches “${query}”. Try fewer words, or other words.`;
}

/** The limit that shows every hit of every query of a search; null when all of them show already. */
export function limitForAll(search: LoreSearch): number | null {
  const most = Math.max(0, ...search.queries.filter((q) => q.hits.length < q.total).map((q) => q.total));
  return most > 0 ? most : null;
}

// ---------------------------------------------------------------- search by meaning

/** How search by meaning stands for a chat: no connection to embed with; switched off; embedding now; everything embedded; the day's limit reached with texts still waiting; texts waiting that could be embedded now. */
export type MeaningStanding = "none" | "off" | "working" | "done" | "capped" | "waiting";

export interface MeaningView {
  standing: MeaningStanding;
  icon: IconName;
  tone: "neutral" | "accent" | "pos" | "warn";
  /** How it stands, in a sentence or two. */
  words: string;
  /** How many entries and messages are embedded, of how many; null where the chat has neither, or nothing can be embedded and nothing is. */
  embedded: string | null;
  /** The model that embeds, with its connection's name; null without a connection. */
  model: string | null;
  /** What the last 24 hours came to against the daily limit (`fraction` of it, from 0 to 1; null: no limit), and what it has come to in all; null where nothing was ever embedded and nothing can be. */
  spent: { today: string; fraction: number | null; reached: boolean; all: string } | null;
  /** Whether a cost shows: false where something was spent, or could be, and no price is set. */
  priced: boolean;
  /** Whether texts wait that can be embedded now. */
  canEmbed: boolean;
  /**
   * The one switch for search by meaning (off until the user switches it on), with what it sends and
   * to whom, said before it is pressed: this chat's texts leave for the embedding model's provider.
   * Null where Lumiverse has no embedding connection: there is nothing to send to.
   */
  toggle: { on: boolean; sends: string } | null;
}

/** What the switch for search by meaning sends, and to which model: said under it whichever way it stands. */
export function sendsWords(status: Pick<EmbeddingStatus, "connection" | "enabled" | "pending" | "pendingTokens">): string | null {
  const { connection, enabled, pending, pendingTokens } = status;
  if (connection === null) return null;
  const to = `your embedding model, ${connection.model} (the connection “${connection.name}” in Lumiverse)`;
  if (enabled) return `On: this chat's lore entries and messages are sent to ${to} as they come. Switched off, nothing more is sent; what is embedded is kept.`;
  const now = pending > 0 ? `${counted(pending, "text")} now, about ${counted(pendingTokens, "token")}, and each new entry and message after` : "each new entry and message from then on";
  return `Off: nothing is sent. Switching it on sends this chat's lore entries and messages to ${to}: ${now}. Its provider sees those texts and charges for them.`;
}

const MEANING_SIGN: Readonly<Record<MeaningStanding, Pick<MeaningView, "icon" | "tone">>> = {
  none: { icon: "info", tone: "neutral" },
  off: { icon: "power", tone: "neutral" },
  working: { icon: "hourglass", tone: "accent" },
  done: { icon: "check", tone: "pos" },
  capped: { icon: "alert", tone: "warn" },
  waiting: { icon: "clock", tone: "neutral" },
};

/** Search by meaning as the page says it (§24.5). */
export function meaningOf(status: EmbeddingStatus): MeaningView {
  const { connection, enabled, lore, messages, pending, working, today, all } = status;
  const reached = today.cap !== null && today.tokens >= today.cap;
  const standing: MeaningStanding = connection === null ? "none" : !enabled ? "off" : working ? "working" : pending === 0 ? "done" : reached ? "capped" : "waiting";
  const wait = `${counted(pending, "text")} ${pending === 1 ? "waits" : "wait"}`;
  const words: Readonly<Record<MeaningStanding, string>> = {
    none: `Not set up: Lumiverse has no embedding connection, so every search is by word. ${IN_LUMIVERSE}`,
    off: "Switched off: every search is by word, and nothing is sent to be embedded.",
    working: pending > 0 ? `Embedding now: ${wait}.` : "Embedding now.",
    done: lore.total + messages.total === 0 ? "This chat has nothing to embed yet." : "Everything is embedded: a search finds by word and by meaning.",
    capped: `Today's limit is reached: ${wait} until the last 24 hours make room.`,
    waiting: `${wait} to be embedded (entries and messages). That happens in the background as agents work; you can have it done now.`,
  };
  const parts = [...(lore.total > 0 ? [`${count(lore.embedded)} of ${counted(lore.total, "entry", "entries")}`] : []), ...(messages.total > 0 ? [`${count(messages.embedded)} of ${counted(messages.total, "message")}`] : [])];
  const nothingYet = lore.embedded + messages.embedded === 0 && (standing === "none" || standing === "off");
  const cost = (usd: number | null): string => (usd !== null ? `, ${money(usd)}` : "");
  const used = all.texts > 0 || today.texts > 0;
  return {
    standing,
    ...MEANING_SIGN[standing],
    words: words[standing],
    embedded: parts.length > 0 && !nothingYet ? `Embedded: ${parts.join(", ")}.` : null,
    model: connection !== null ? `${connection.model} (${connection.name})` : null,
    spent:
      connection !== null || used
        ? {
            today: today.cap !== null ? `The last 24 hours: ${count(today.tokens)} of ${counted(today.cap, "token")} a day, in ${counted(today.texts, "text")}${cost(today.cost)}.` : `The last 24 hours: ${counted(today.tokens, "token")} in ${counted(today.texts, "text")}${cost(today.cost)}. No daily limit is set.`,
            // A limit of nothing is reached before anything is embedded.
            fraction: today.cap === null ? null : today.cap === 0 ? 1 : Math.min(1, today.tokens / today.cap),
            reached,
            all: `In all: ${counted(all.tokens, "token")} in ${counted(all.texts, "text")}${cost(all.cost)}.`,
          }
        : null,
    priced: today.cost !== null || all.cost !== null,
    canEmbed: standing === "waiting",
    toggle: connection !== null ? { on: enabled, sends: sendsWords(status) ?? "" } : null,
  };
}
