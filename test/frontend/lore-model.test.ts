// What the Lore page shows: each state's words and sign, why an entry was in the prompt, the line
// that says what is there, the entries by book under the filters, the searches a box asks for, how a
// hit is put and marked, how a search ran, and how search by meaning stands.

import { describe, expect, test } from "bun:test";
import {
  bookChoices,
  countsLine,
  entryFacts,
  entryTitle,
  foundWords,
  groupsOf,
  limitForAll,
  LORE_STATE_ICON,
  LORE_STATE_WORDS,
  LORE_STATES,
  markWords,
  matchWords,
  MEANING_SETTINGS,
  meaningOf,
  NO_LORE_FILTER,
  noHitsWords,
  nothingWords,
  sendsWords,
  queriesOf,
  ranWords,
  rowSub,
  rowWhy,
  stateAbout,
  stateChips,
  whyWords,
} from "../../src/extension/frontend/lore-model";
import type { EmbeddingStatus, LoreHit, LoreRow, LoreView } from "../../src/shared/ui";

const T0 = Date.UTC(2026, 10, 10, 9, 0, 0);
const row = (over: Partial<LoreRow>): LoreRow => ({ entryId: "lore-okoro", short: "lore-oko", bookId: "book-people", title: "Okoro", keys: ["Okoro", "audit"], secondaryKeys: [], chars: 102, tokens: 26, enabled: true, constant: false, vectorized: false, state: "not_in_prompt", ...over });
const BOOKS = [
  { id: "book-harbour", name: "The harbour town", description: "Places of the town.", entries: 4 },
  { id: "book-people", name: "People of the pier", description: "Who is who.", entries: 2 },
];
const ENTRIES: LoreRow[] = [
  row({ entryId: "lore-tide-tables", bookId: "book-harbour", title: "Old tide tables", keys: ["tide tables"], enabled: false, state: "off" }),
  row({ entryId: "lore-long-pier", bookId: "book-harbour", title: "The long pier", keys: ["long pier"] }),
  row({ entryId: "lore-night-key", bookId: "book-harbour", title: "The night key", keys: ["night key"], state: "added" }),
  row({ entryId: "lore-harbour-office", bookId: "book-harbour", title: "The harbour office", keys: ["harbour office"], state: "in_prompt", why: { by: "key", key: "harbour office" } }),
  row({}),
  row({ entryId: "lore-joss", title: "Joss", keys: ["landlord"], state: "dropped", why: { by: "vector", score: 0.71 } }),
];
const VIEW: Pick<LoreView, "books" | "entries" | "last"> = { books: BOOKS, entries: ENTRIES, last: { generationId: "turn-0043", at: T0 - 3 * 60_000 } };
const ids = (rows: readonly LoreRow[]): string[] => rows.map((r) => r.entryId);
const status = (over: Partial<EmbeddingStatus>): EmbeddingStatus => ({ connection: { id: "embed-local", name: "Local embeddings", model: "embed-small", dimensions: 768 }, enabled: true, lore: { embedded: 22, total: 31 }, messages: { embedded: 31, total: 48 }, pending: 26, pendingTokens: 5200, working: false, today: { texts: 663, tokens: 132_600, cost: null, cap: 2_000_000 }, all: { texts: 2480, tokens: 496_000, cost: null }, ...over });
const hit = (over: Partial<LoreHit>): Pick<LoreHit, "by" | "fields" | "words" | "similarity"> => ({ by: ["word"], fields: ["title", "key"], words: ["night", "key"], ...over });

describe("an entry's state", () => {
  test("each state has its words and a sign of its own, so none rests on colour alone", () => {
    expect(LORE_STATES.map((s) => LORE_STATE_WORDS[s])).toEqual(["In the prompt", "Added by the agent", "Left out of this prompt", "Not in the prompt", "Switched off"]);
    expect(new Set(LORE_STATES.map((s) => LORE_STATE_ICON[s])).size).toBe(LORE_STATES.length);
  });

  test("why an entry was in the prompt is said in plain words", () => {
    expect(whyWords({ by: "key", key: "harbour office" })).toBe("a key matched: harbour office");
    expect(whyWords({ by: "key", key: null })).toBe("a key matched");
    expect(whyWords({ by: "vector", score: 0.71 })).toBe("close in meaning (0.71)");
    expect(whyWords({ by: "vector", score: null })).toBe("close in meaning");
    expect(whyWords({ by: "constant" })).toBe("always on");
    expect(whyWords({ by: "unknown" })).toBe("Lumiverse didn't say why");
  });

  test("a row says why after its state; one the agent dropped says it had been in", () => {
    expect(rowWhy(row({ state: "in_prompt", why: { by: "constant" } }))).toBe("always on");
    expect(rowWhy(row({ state: "dropped", why: { by: "vector", score: 0.71 } }))).toBe("it was in: close in meaning (0.71)");
    expect(rowWhy(row({ state: "added" }))).toBeNull();
  });

  test("the entry open says what its state means, and before LumiAH's first reply that none is known yet", () => {
    expect(stateAbout("added", true)).toContain("main agent added it");
    expect(stateAbout("not_in_prompt", true)).toBe("It wasn't in the prompt of the last reply.");
    expect(stateAbout("not_in_prompt", false)).toContain("hasn't answered in this chat yet");
  });

  test("a row's line gives its keys and its size; an untitled entry goes by its first key", () => {
    expect(rowSub(row({}))).toBe("Keys: Okoro, audit · 26 tokens");
    expect(rowSub(row({ keys: [], tokens: 1 }))).toBe("No keys · 1 token");
    expect(entryTitle(row({ title: "  " }))).toBe("Okoro");
    expect(entryTitle(row({ title: "", keys: [] }))).toBe("Untitled entry");
  });

  test("the entry open lists its book, keys, size and how Lumiverse brings it in", () => {
    const facts = entryFacts(row({ secondaryKeys: ["ledger"], vectorized: true }), "People of the pier");
    expect(facts.map((f) => f.label)).toEqual(["Book", "Keys", "Secondary keys", "Size", "In Lumiverse"]);
    expect(facts[3]?.value).toBe("102 characters, about 26 tokens");
    expect(facts[4]?.value).toContain("close to it in meaning");
    expect(entryFacts(row({ constant: true, keys: [] }), null).map((f) => f.value)).toEqual(["None", "102 characters, about 26 tokens", "Always on: Lumiverse puts it in every prompt."]);
    expect(entryFacts(row({ enabled: false }), null).at(-1)?.value).toContain("Switched off");
  });
});

describe("what is there", () => {
  test("the first line counts the entries and books, and how many reached the last reply", () => {
    expect(countsLine(VIEW, T0)).toBe("6 entries in 2 books. 2 reached the last reply, 3 min ago.");
    expect(countsLine({ ...VIEW, entries: ENTRIES.filter((e) => e.state === "off") }, T0)).toBe("1 entry in 2 books. None reached the last reply, 3 min ago.");
    // Before LumiAH's first reply in the chat nothing is known of a reply.
    expect(countsLine({ books: [BOOKS[0]].flatMap((b) => (b ? [b] : [])), entries: [row({})], last: null }, T0)).toBe("1 entry in 1 book.");
  });

  test("the entries come by book, those that reached the last reply or were kept from it first", () => {
    const groups = groupsOf(VIEW, NO_LORE_FILTER);
    expect(groups.map((g) => g.book.name)).toEqual(["The harbour town", "People of the pier"]);
    expect(ids(groups[0]?.rows ?? [])).toEqual(["lore-harbour-office", "lore-night-key", "lore-long-pier", "lore-tide-tables"]);
    expect(ids(groups[1]?.rows ?? [])).toEqual(["lore-joss", "lore-okoro"]);
  });

  test("an entry of a book Lumiverse didn't list still shows, under a book of its own", () => {
    const groups = groupsOf({ books: BOOKS, entries: [...ENTRIES, row({ entryId: "lore-stray", bookId: "book-gone" })] }, NO_LORE_FILTER);
    expect(ids(groups.at(-1)?.rows ?? [])).toEqual(["lore-stray"]);
  });
});

describe("the filters", () => {
  test("a state and a book each narrow the list, and a book left with nothing isn't shown", () => {
    expect(groupsOf(VIEW, { state: "dropped", book: null }).map((g) => [g.book.id, ids(g.rows)])).toEqual([["book-people", ["lore-joss"]]]);
    expect(groupsOf(VIEW, { state: null, book: "book-harbour" }).map((g) => g.rows.length)).toEqual([4]);
    expect(groupsOf(VIEW, { state: "added", book: "book-people" })).toEqual([]);
  });

  test("the state chips count what each shows within the book chosen; a state with nothing is left out unless it is the one pressed", () => {
    expect(stateChips(VIEW, NO_LORE_FILTER).map((c) => `${c.label} ${c.count}${c.pressed ? "*" : ""}`)).toEqual(["All 6*", "In the prompt 1", "Added by the agent 1", "Left out of this prompt 1", "Not in the prompt 2", "Switched off 1"]);
    expect(stateChips(VIEW, { state: "added", book: "book-people" }).map((c) => `${c.label} ${c.count}${c.pressed ? "*" : ""}`)).toEqual(["All 2", "Added by the agent 0*", "Left out of this prompt 1", "Not in the prompt 1"]);
  });

  test("the book choices count what each shows under the state chosen", () => {
    expect(bookChoices(VIEW, { state: "not_in_prompt", book: null })).toEqual([
      { value: "", label: "All books (2)" },
      { value: "book-harbour", label: "The harbour town (1)" },
      { value: "book-people", label: "People of the pier (1)" },
    ]);
  });

  test("filtered to nothing, the page says what there is none of", () => {
    expect(nothingWords(VIEW, { state: "added", book: "book-people" })).toBe("No entry of “People of the pier” is added by the agent.");
    expect(nothingWords(VIEW, { state: "off", book: null })).toBe("No entry of this chat's books is switched off.");
  });

  test("a book chosen in another chat filters nothing here", () => {
    expect(groupsOf(VIEW, { state: null, book: "book-watch" }).length).toBe(2);
    expect(stateChips(VIEW, { state: null, book: "book-watch" })[0]?.count).toBe(6);
  });
});

describe("the search box", () => {
  test("holds one search, or several separated by a semicolon; blanks and repeats are left out", () => {
    expect(queriesOf("  night   key ")).toEqual(["night key"]);
    expect(queriesOf("night key; who signed the ledger ;; Night Key;")).toEqual(["night key", "who signed the ledger"]);
    expect(queriesOf(" ; ")).toEqual([]);
  });

  test("how the search ran is said plainly, with the setting that would change it", () => {
    expect(ranWords("on")).toEqual({ words: "Searched by word and by meaning.", setting: null });
    expect(ranWords("off")).toEqual({ words: "Searched by word only: search by meaning is switched off. Its switch is under the list of entries.", setting: MEANING_SETTINGS.enabled });
    // The way to it is one of the pages' links, which a test of their own holds to a setting that exists.
    expect(MEANING_SETTINGS.enabled).toBe("meaningSwitch");
    const none = ranWords("none");
    expect(none.words).toContain("Lumiverse has no embedding connection");
    expect(none.words).toContain("under Embeddings");
    expect(none.setting).toBeNull();
  });
});

describe("a hit", () => {
  test("says which of its parts hold which words", () => {
    expect(matchWords(hit({}), "night key")).toBe("its title and keys hold: night, key");
    expect(matchWords(hit({ fields: ["text"] }), "night key")).toBe("its text holds: night, key");
    expect(matchWords(hit({ fields: ["key"], words: ["audit"] }), "audit")).toBe("its keys hold: audit");
    expect(matchWords(hit({ fields: ["text", "key", "title"], words: ["key"] }), "key")).toBe("its title, keys and text hold: key");
  });

  test("says when it is close in meaning, alone or beside its words", () => {
    expect(matchWords(hit({ by: ["meaning"], fields: [], words: [], similarity: 0.82 }), "innkeeper")).toBe("close in meaning (0.82)");
    expect(matchWords(hit({ by: ["word", "meaning"], fields: ["text"], words: ["ledger"], similarity: 0.57 }), "the ledger")).toBe("its text holds: ledger; also close in meaning (0.57)");
    expect(matchWords(hit({ by: ["meaning"], fields: [], words: [] }), "innkeeper")).toBe("close in meaning");
  });

  test("names a matched word as it was typed, though the search names it with its ending off", () => {
    expect(matchWords(hit({ fields: ["title"], words: ["tide", "tabl"] }), "Old tide tables")).toBe("its title holds: tide, tables");
    expect(matchWords(hit({ fields: ["text"], words: ["okoro", "sign"] }), "Okoro signed")).toBe("its text holds: Okoro, signed");
  });

  test("its lines mark the matched words, with or without an ending, whatever their case, and no longer word that only starts alike", () => {
    expect(markWords("The night key opens it. Keys are few; the keyhole is new.", ["night", "key"])).toEqual([
      { text: "The ", hit: false },
      { text: "night", hit: true },
      { text: " ", hit: false },
      { text: "key", hit: true },
      { text: " opens it. ", hit: false },
      { text: "Keys", hit: true },
      { text: " are few; the keyhole is new.", hit: false },
    ]);
    expect(markWords("since the autumn storms", ["storm"]).filter((p) => p.hit).map((p) => p.text)).toEqual(["storms"]);
    expect(markWords("Old tide tables", ["tabl"]).filter((p) => p.hit).map((p) => p.text)).toEqual(["tables"]);
  });

  test("a line with nothing matched is one unmarked piece, and a script without spaces is marked inside a stretch", () => {
    expect(markWords("Joss keeps the tavern.", [])).toEqual([{ text: "Joss keeps the tavern.", hit: false }]);
    expect(markWords("Joss keeps the tavern.", ["ledger"])).toEqual([{ text: "Joss keeps the tavern.", hit: false }]);
    expect(markWords("港の事務所は六時に閉まる", ["事務"])).toEqual([
      { text: "港の", hit: false },
      { text: "事務", hit: true },
      { text: "所は六時に閉まる", hit: false },
    ]);
  });

  test("a query says how much it found, and what to try when it found nothing", () => {
    const hits = [0, 1, 2].map((): LoreHit => ({ entryId: "e", short: "e", bookId: "b", book: "B", title: "T", chars: 1, state: "off", constant: false, score: 1, by: ["word"], fields: ["text"], words: [], lines: [] }));
    expect(foundWords({ total: 3, hits })).toBe("3 entries found");
    expect(foundWords({ total: 1, hits: hits.slice(0, 1) })).toBe("1 entry found");
    expect(foundWords({ total: 14, hits })).toBe("14 entries found, the best 3 shown");
    expect(foundWords({ total: 0, hits: [] })).toBeNull();
    expect(noHitsWords("zeppelin")).toBe("Nothing in this chat's books matches “zeppelin”. Try fewer words, or other words.");
    // Showing every hit takes the limit of the query that found the most.
    expect(limitForAll({ meaning: "on", queries: [{ query: "a", total: 14, hits }, { query: "b", total: 3, hits }] })).toBe(14);
    expect(limitForAll({ meaning: "on", queries: [{ query: "b", total: 3, hits }] })).toBeNull();
  });
});

describe("search by meaning", () => {
  test("texts that wait can be embedded now, and the day's use is set against its limit", () => {
    const m = meaningOf(status({}));
    expect(m.standing).toBe("waiting");
    expect(m.canEmbed).toBe(true);
    expect(m.words).toContain("26 texts wait to be embedded");
    expect(m.embedded).toBe("Embedded: 22 of 31 entries, 31 of 48 messages.");
    expect(m.spent?.today).toBe("The last 24 hours: 132,600 of 2,000,000 tokens a day, in 663 texts.");
    expect(m.spent?.fraction).toBeCloseTo(0.0663, 4);
    expect(m.spent?.all).toBe("In all: 496,000 tokens in 2,480 texts.");
    expect(m.model).toBe("embed-small (Local embeddings)");
  });

  test("a cost shows only where a price is set", () => {
    expect(meaningOf(status({})).priced).toBe(false);
    const priced = meaningOf(status({ today: { texts: 663, tokens: 132_600, cost: 0.0027, cap: null }, all: { texts: 2480, tokens: 496_000, cost: 0.0099 } }));
    expect(priced.priced).toBe(true);
    expect(priced.spent?.today).toBe("The last 24 hours: 132,600 tokens in 663 texts, $0.0027. No daily limit is set.");
    expect(priced.spent?.fraction).toBeNull();
    expect(priced.spent?.all).toBe("In all: 496,000 tokens in 2,480 texts, $0.0099.");
  });

  test("it says how it stands: no connection, switched off, working, done, or held by the day's limit", () => {
    const none = meaningOf(status({ connection: null, lore: { embedded: 0, total: 31 }, messages: { embedded: 0, total: 48 }, today: { texts: 0, tokens: 0, cost: null, cap: 2_000_000 }, all: { texts: 0, tokens: 0, cost: null } }));
    expect([none.standing, none.canEmbed, none.embedded, none.spent]).toEqual(["none", false, null, null]);
    expect(none.words).toContain("Set one in Lumiverse's settings, under Embeddings.");
    expect(meaningOf(status({ enabled: false })).standing).toBe("off");
    expect(meaningOf(status({ working: true, pending: 1 })).words).toBe("Embedding now: 1 text waits.");
    expect(meaningOf(status({ pending: 0 })).words).toBe("Everything is embedded: a search finds by word and by meaning.");
    expect(meaningOf(status({ pending: 0, lore: { embedded: 0, total: 0 }, messages: { embedded: 0, total: 0 } })).words).toBe("This chat has nothing to embed yet.");
    const capped = meaningOf(status({ today: { texts: 9000, tokens: 2_000_000, cost: null, cap: 2_000_000 } }));
    expect([capped.standing, capped.canEmbed, capped.spent?.reached, capped.spent?.fraction]).toEqual(["capped", false, true, 1]);
  });

  test("its one switch says what it sends and to whom before it is pressed, and what it sends once on", () => {
    const off = meaningOf(status({ enabled: false }));
    expect(off.toggle).toEqual({
      on: false,
      sends: "Off: nothing is sent. Switching it on sends this chat's lore entries and messages to your embedding model, embed-small (the connection “Local embeddings” in Lumiverse): 26 texts now, about 5,200 tokens, and each new entry and message after. Its provider sees those texts and charges for them.",
    });
    expect(off.words).toBe("Switched off: every search is by word, and nothing is sent to be embedded.");
    // With nothing waiting it still says what will go.
    expect(sendsWords({ ...status({ enabled: false }), pending: 0, pendingTokens: 0 })).toContain("each new entry and message from then on");
    const on = meaningOf(status({}));
    expect(on.toggle?.on).toBe(true);
    expect(on.toggle?.sends).toBe("On: this chat's lore entries and messages are sent to your embedding model, embed-small (the connection “Local embeddings” in Lumiverse) as they come. Switched off, nothing more is sent; what is embedded is kept.");
    // Without an embedding connection there is nothing to send to, so there is no switch.
    expect(meaningOf(status({ connection: null })).toggle).toBeNull();
    expect(sendsWords(status({ connection: null }))).toBeNull();
  });
});
