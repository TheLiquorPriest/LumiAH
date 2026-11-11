// The lore tools (DESIGN §24.2) over a small invented story: an index of every entry with how it
// stands, a search of several queries that weighs titles and keys, reads of several entries in one
// call, a grep by text or by pattern, one hop along the lore's own links, everything the books hold
// on a name, and the entries the prompt holds; that no answer is longer than Answer length, whatever
// a call's arguments are; and that the lore's index is kept between runs and read again only for
// what changed (§24.6).

import { describe, expect, test } from "bun:test";
import type { ActivatedLore, JsonObject, RequestMessage } from "../../src/core/ports";
import { hitDetail, searchLore } from "../../src/core/recall/lore-search";
import { recallOf } from "../../src/core/recall/recall";
import type { Settings } from "../../src/core/settings";
import { LORE_TOOLS } from "../../src/core/tools/lore";
import { CHAT, cursorOf, harbour, pages, RecallHost, type Rig, toolRig } from "./recall-support";

const ID = {
  customs: "11111111-aaaa-4000-8000-000000000001",
  lighthouse: "11111111-bbbb-4000-8000-000000000002",
  mill: "11111111-cccc-4000-8000-000000000003",
  okoro: "22222222-aaaa-4000-8000-000000000004",
  brann: "22222222-bbbb-4000-8000-000000000005",
  ilse: "22222222-cccc-4000-8000-000000000006",
  flood: "33333333-aaaa-4000-8000-000000000007",
  heron: "44444444-aaaa-4000-8000-000000000008",
};

const WORD_ONLY = "[Search is by word here: no embedding connection is set up in Lumiverse, so words that mean the same aren't found. Search with the story's own words.]";

/** A long entry, for reads that take several pages. */
const FLOOD = [
  "The flood came in the ninth year of the harbour, on a night with no wind.",
  "The river rose behind the mill and took the millrace first, then the lower street, then the customs house steps.",
  "By morning the strongbox stood in a yard of water and the keeper would not open it for anyone.",
  "",
  "Ilse carried the ledger down from the mill wrapped in oilcloth and asked that it be locked away until the water fell.",
  "It has stayed there since, because the second key went out to the lighthouse with Okoro and has not come back.",
  "",
  "Brann lost two boats that night and blames the mill for holding the sluice shut.",
  "Nobody on the coast agrees how high the water stood, but every door on the lower street still carries its mark.",
].join("\n");

/** An entry as Lumiverse says it activated it: its own text. */
function activated(host: RecallHost, id: string): ActivatedLore {
  const entry = host.entries.find((e) => e.id === id);
  if (!entry) throw new Error(`no entry ${id}`);
  return { entryId: entry.id, bookId: entry.bookId, title: entry.title, content: entry.content };
}

/**
 * The harbour story at a turn whose request holds two entries as World Info messages: the lighthouse,
 * then Okoro, whom his book always sends. Search by meaning is switched on, as a user who chose it
 * has it (it is off until they do); this host has no embedding connection, so a run's first search
 * says that it is by word.
 */
async function turnRig(settings?: (s: Settings) => void, host: RecallHost = harbour()): Promise<Rig> {
  host.activatedLore = [activated(host, ID.lighthouse), activated(host, ID.okoro)];
  const chosen = (s: Settings): void => {
    s.recall.meaning.enabled = true;
    settings?.(s);
  };
  return toolRig(host, LORE_TOOLS, { turn: { messages: [...host.requestOf(CHAT, 12, null), host.loreMessage(ID.lighthouse), host.loreMessage(ID.okoro)] }, settings: chosen });
}

/** The ids of the entries an answer lists, in its order. */
const listedIds = (text: string): string[] => [...text.matchAll(/^- \[([^\]]+)\]/gm)].map((m) => m[1] ?? "");

describe("lore_index", () => {
  test("lists every entry under its book by the id the other tools take, with its keys, its length and how it stands", async () => {
    const r = await turnRig();
    expect(r.offered()).toEqual(["lore_index", "lore_search", "lore_grep", "lore_read", "lore_related", "lore_about", "active_lore"]);
    expect(await r.run("lore_index")).toEqual({
      text: [
        "6 entries found; showing 1 to 6.",
        "Book “The Coast” [book-coast], 3 entries — Places along the shore.:",
        "- [11111111-a] The Customs House · keys: customs house, strongbox · 182 characters",
        "- [11111111-b] The Lighthouse (in the prompt) · keys: lighthouse, lamp · 135 characters",
        "- [11111111-c] The Mill (switched off) · keys: mill, millrace · 88 characters",
        "Book “People” [book-people], 3 entries:",
        "- [22222222-a] Okoro (in the prompt) (always sent) · keys: okoro, keeper · 102 characters",
        "- [22222222-b] Brann · keys: brann · 119 characters",
        "- [22222222-c] Ilse · keys: ilse, miller · 57 characters",
      ].join("\n"),
    });
  });

  test("filters by book, by state and by text in a title or a key, alone or together", async () => {
    const r = await turnRig();
    const ids = async (args: JsonObject): Promise<string[]> => listedIds((await r.run("lore_index", args)).text);
    // A book by its id, by its name in any letter case, or as an answer wrote it.
    expect(await ids({ book: "book-people" })).toEqual(["22222222-a", "22222222-b", "22222222-c"]);
    expect(await ids({ book: "the coast" })).toEqual(["11111111-a", "11111111-b", "11111111-c"]);
    expect(await ids({ book: "[book-coast]" })).toEqual(["11111111-a", "11111111-b", "11111111-c"]);
    expect(await ids({ state: "in_prompt" })).toEqual(["11111111-b", "22222222-a"]);
    expect(await ids({ state: "not_in_prompt" })).toEqual(["11111111-a", "11111111-c", "22222222-b", "22222222-c"]);
    expect(await ids({ state: "always" })).toEqual(["22222222-a"]);
    expect(await ids({ state: "off" })).toEqual(["11111111-c"]);
    // "MILL" is in a title and a key of the mill, and inside Ilse's key "miller"; no entry's text is read for it.
    expect(await ids({ text: "MILL" })).toEqual(["11111111-c", "22222222-c"]);
    expect(await ids({ text: "mill", state: "not_in_prompt", book: "People" })).toEqual(["22222222-c"]);
    // A heading counts its book's entries; the line above the list counts what the filters let through.
    expect((await r.run("lore_index", { state: "always" })).text).toBe("1 entry found; showing 1 to 1.\nBook “People” [book-people], 3 entries:\n- [22222222-a] Okoro (in the prompt) (always sent) · keys: okoro, keeper · 102 characters");
  });

  test("says what to give instead of a book or a state there isn't, and which filters let nothing through", async () => {
    const r = await turnRig();
    expect(await r.run("lore_index", { book: "Maps" })).toEqual({ text: "No book “Maps” applies to this chat. The books are: “The Coast” [book-coast], “People” [book-people]. Give one of those, or leave book out for them all.", error: true });
    expect(await r.run("lore_index", { state: "sometimes" })).toEqual({ text: "lore_index's state can be: in_prompt, not_in_prompt, always, off. “sometimes” is none of those.", error: true });
    expect(await r.run("lore_index", { text: "tavern", book: "The Coast", state: "off" })).toEqual({ text: "No entry of this chat's books matches book: The Coast, state: off, text: tavern. Leave a filter out to see more." });
  });

  test("pages by cursor, a book's heading leading the page that starts inside it", async () => {
    const r = await turnRig((s) => (s.tools.pageItems = 2));
    const all = await pages(r, "lore_index", {});
    expect(all.map((page) => page.split("\n")[0])).toEqual(["6 entries found; showing 1 to 2.", "6 entries found; showing 3 to 4.", "6 entries found; showing 5 to 6."]);
    expect(all[1]).toBe(
      [
        "6 entries found; showing 3 to 4.",
        "Book “The Coast” [book-coast], 3 entries — Places along the shore.:",
        "- [11111111-c] The Mill (switched off) · keys: mill, millrace · 88 characters",
        "Book “People” [book-people], 3 entries:",
        "- [22222222-a] Okoro (in the prompt) (always sent) · keys: okoro, keeper · 102 characters",
        '[There is more: call lore_index again with the same arguments and cursor "4".]',
      ].join("\n"),
    );
    expect(all[2]).toEndWith("- [22222222-c] Ilse · keys: ilse, miller · 57 characters\n[That is the end.]");
    expect(all.flatMap(listedIds)).toEqual(["11111111-a", "11111111-b", "11111111-c", "22222222-a", "22222222-b", "22222222-c"]);
  });

  test("in a run that answers no generation nothing is in a prompt, and active_lore isn't offered", async () => {
    const job = await toolRig(harbour(), LORE_TOOLS, { turn: null });
    expect(job.offered()).toEqual(["lore_index", "lore_search", "lore_grep", "lore_read", "lore_related", "lore_about"]);
    expect((await job.run("lore_index", { book: "People" })).text).toContain("- [22222222-a] Okoro (always sent) · keys: okoro, keeper · 102 characters");
    expect(listedIds((await job.run("lore_index", { state: "not_in_prompt" })).text)).toHaveLength(6);
    expect((await job.run("lore_index", { state: "in_prompt" })).text).toBe("No entry of this chat's books matches state: in_prompt. Leave a filter out to see more.");
  });
});

describe("lore_search", () => {
  test("each hit shows how the entry stands, where its words matched and its best lines", async () => {
    const r = await turnRig();
    expect(await r.run("lore_search", { queries: ["lighthouse"] })).toEqual({
      text: [
        "“lighthouse”: 2 entries found; showing 1 to 2.",
        "- [11111111-b] The Lighthouse (in the prompt) · book “The Coast” · 135 characters · matched title, keys, text: lighthouse",
        "    line 1: The lighthouse stands on the point, an hour's row from the harbour.",
        "- [22222222-a] Okoro (in the prompt) (always sent) · book “People” · 102 characters · matched text: lighthouse",
        "    line 1: Okoro keeps the lighthouse and owes the mill a debt.",
        WORD_ONLY,
      ].join("\n"),
    });
    // The lines shown are the ones that hold the query's words, wherever they stand in the entry.
    expect((await r.run("lore_search", { queries: ["ledger flood"], book: "The Coast" })).text).toBe(
      ["“ledger flood”: 2 entries found; showing 1 to 2.", "- [11111111-a] The Customs House · book “The Coast” · 182 characters · matched text: ledger, flood", "    line 3: Ilse's ledger has been locked in it since the flood.", "- [11111111-c] The Mill (switched off) · book “The Coast” · 88 characters · matched text: flood", "    line 2: Its wheel has not turned since the flood."].join("\n"),
    );
  });

  test("a word in a title or a key counts for more than one in the text, as Settings weigh them", async () => {
    // An entry that is about the ship by its title and its key alone, beside two that speak of her in passing.
    const withHeron = (): RecallHost => {
      const host = harbour();
      host.addEntry("book-coast", ID.heron, "The Heron", ["heron"], "Brann's ship. She went down off the point with her cargo.");
      return host;
    };
    const r = await toolRig(withHeron(), LORE_TOOLS, { turn: null });
    const found = (await r.run("lore_search", { queries: ["heron"] })).text;
    expect(found).toStartWith("“heron”: 3 entries found; showing 1 to 3.\n- [44444444] The Heron · book “The Coast” · 57 characters · matched title, keys: heron\n    line 1: Brann's ship. She went down off the point with her cargo.\n");
    expect(listedIds(found).slice(1).sort()).toEqual(["22222222-a", "22222222-b"]);
    // Weighed below the text, a title and a key no longer carry it past the entries that say the word.
    const flat = await toolRig(withHeron(), LORE_TOOLS, { turn: null, settings: (s) => (s.recall.lore = { ...s.recall.lore, titleWeight: 0.1, keyWeight: 0.1 }) });
    expect(listedIds((await flat.run("lore_search", { queries: ["heron"] })).text).at(-1)).toBe("44444444");
  });

  test("several queries in one call are each answered on their own, and a hit a query above showed is listed once", async () => {
    const r = await turnRig();
    // That search is by word is said once in a run: with its first search.
    expect((await r.run("lore_search", { query: "lamp" })).text).toEndWith(WORD_ONLY);
    expect(await r.run("lore_search", { queries: ["ledger debts", "strongbox keys", "tavern"] })).toEqual({
      text: [
        "“ledger debts”: 4 entries found; showing 1 to 3.",
        "- [22222222-c] Ilse · book “People” · 57 characters · matched text: ledger, debt",
        "    line 1: Ilse runs the mill and keeps the coast's ledger of debts.",
        "- [22222222-b] Brann · book “People” · 119 characters · matched text: ledger, debt",
        "    line 2: His debt is the longest page in Ilse's ledger.",
        "- [22222222-a] Okoro (in the prompt) (always sent) · book “People” · 102 characters · matched text: debt",
        "    line 1: Okoro keeps the lighthouse and owes the mill a debt.",
        "(1 more: call lore_search with this query alone to page through them.)",
        "“strongbox keys”: 3 entries found; showing 1 to 3.",
        // The customs house matched the first query too, but past what that query showed: it is shown here whole.
        "- [11111111-a] The Customs House · book “The Coast” · 182 characters · matched keys, text: strongbox, key",
        "    line 2: Its strongbox takes two keys turned at once: the brass key and the keeper's.",
        "- [22222222-b] Brann: listed above",
        "- [11111111-b] The Lighthouse (in the prompt) · book “The Coast” · 135 characters · matched text: key",
        "    line 2: Okoro keeps it, and keeps the second key on a cord around his neck.",
        "No lore entry matches “tavern”. Try fewer or other words, lore_about for a name, or lore_index to see what the books hold.",
      ].join("\n"),
    });
  });

  test("a call carries as many queries as Settings allow, and says which it didn't run", async () => {
    const r = await turnRig((s) => (s.recall.lore.queries = 2));
    const answer = (await r.run("lore_search", { queries: ["lamp", "millrace", "heron", "oars"], query: "ledger" })).text;
    expect(answer.split("\n").filter((line) => line.startsWith("“"))).toEqual(["“lamp”: 1 entry found; showing 1 to 1.", "“millrace”: 1 entry found; showing 1 to 1."]);
    expect(answer).toEndWith(`[One call carries 2 at most; the rest weren't run: heron; oars; ledger. Call again with those.]\n${WORD_ONLY}`);
    expect(await r.run("lore_search")).toEqual({ text: "lore_search needs queries: What to look for: one query or several, each answered on its own. Names and rare words find the most. Call it again with queries.", error: true });
  });

  test("one query pages by cursor; a cursor it didn't give is refused", async () => {
    const r = await turnRig((s) => (s.tools.pageItems = 1));
    const all = await pages(r, "lore_search", { queries: ["debt"] });
    expect(all.map((page) => page.split("\n")[0])).toEqual(["“debt”: 3 entries found; showing 1 to 1.", "“debt”: 3 entries found; showing 2 to 2.", "“debt”: 3 entries found; showing 3 to 3."]);
    expect(all.flatMap(listedIds)).toEqual(["22222222-c", "22222222-a", "22222222-b"]);
    expect(cursorOf(all[0] ?? "")).toBe("1");
    expect(all[2]).toEndWith("[That is the end.]");
    const refused = "isn't a cursor lore_search gave. Pass the cursor exactly as the last answer wrote it, or leave it out to start at the beginning.";
    expect(await r.run("lore_search", { queries: ["debt"], cursor: "9" })).toEqual({ text: `“9” ${refused}`, error: true });
    // Several queries have no page to read on from.
    expect(await r.run("lore_search", { queries: ["debt", "key"], cursor: "1" })).toEqual({ text: `“1” ${refused}`, error: true });
  });

  test("says once in a run that search is by word, and never where Settings switch meaning off", async () => {
    const r = await turnRig();
    // The error for a cursor carries no note, so the note is still owed.
    expect((await r.run("lore_search", { queries: ["lamp"], cursor: "7" })).error).toBe(true);
    expect((await r.run("lore_search", { queries: ["lamp"] })).text).toEndWith(WORD_ONLY);
    // A word found in a key alone: the hit shows where the entry starts.
    expect((await r.run("lore_search", { queries: ["lamp"] })).text).toBe("“lamp”: 1 entry found; showing 1 to 1.\n- [11111111-b] The Lighthouse (in the prompt) · book “The Coast” · 135 characters · matched keys: lamp\n    line 1: The lighthouse stands on the point, an hour's row from the harbour.");
    const off = await turnRig((s) => (s.recall.meaning.enabled = false));
    expect((await off.run("lore_search", { queries: ["lamp"] })).text).not.toContain("Search is by word");
  });

  test("merges what the queries mean with what their words find, asking for the meaning of a whole call once", async () => {
    const r = await turnRig();
    const run = recallOf(r.env);
    // What search by meaning would find, where the user has an embedding connection: the seam the search merges at.
    const asked: string[][] = [];
    run.meaning = async (_what, queries) => {
      asked.push([...queries]);
      return { state: "on", matches: queries.map((query) => (query === "lantern" ? [{ key: ID.lighthouse, similarity: 0.82 }] : [{ key: ID.okoro, similarity: 0.9 }, { key: ID.ilse, similarity: 0.41 }])) };
    };
    expect((await r.run("lore_search", { queries: ["lantern", "keeper"] })).text).toBe(
      [
        "“lantern”: 1 entry found; showing 1 to 1.",
        "- [11111111-b] The Lighthouse (in the prompt) · book “The Coast” · 135 characters · matched by meaning (0.82)",
        "    line 1: The lighthouse stands on the point, an hour's row from the harbour.",
        "“keeper”: 3 entries found; showing 1 to 3.",
        "- [22222222-a] Okoro (in the prompt) (always sent) · book “People” · 102 characters · matched keys: keeper; also by meaning (0.90)",
        "    line 1: Okoro keeps the lighthouse and owes the mill a debt.",
        "- [11111111-a] The Customs House · book “The Coast” · 182 characters · matched text: keeper",
        "    line 2: Its strongbox takes two keys turned at once: the brass key and the keeper's.",
        "- [22222222-c] Ilse · book “People” · 57 characters · matched by meaning (0.41)",
        "    line 1: Ilse runs the mill and keeps the coast's ledger of debts.",
      ].join("\n"),
    );
    expect(asked).toEqual([["lantern", "keeper"]]);
  });

  test("searchLore and hitDetail give the Lore page the same hits as plain data", async () => {
    const r = await turnRig();
    const run = recallOf(r.env);
    const { meaning, found } = await searchLore(run, ["lighthouse", "keeper"], { keep: (doc) => doc.book.id === "book-people" });
    expect(meaning).toBe("none");
    expect(found.map(({ query, hits }) => ({ query, hits: hits.map((hit) => ({ id: hit.doc.short, by: hit.by, scored: hit.score > 0 })) }))).toEqual([
      { query: "lighthouse", hits: [{ id: "22222222-a", by: ["word"], scored: true }] },
      { query: "keeper", hits: [{ id: "22222222-a", by: ["word"], scored: true }] },
    ]);
    const okoro = found[1]?.hits[0]?.doc;
    if (!okoro) throw new Error("the search found no entry");
    expect(hitDetail(okoro, "the keeper of the lighthouse, Okoro", r.settings)).toEqual({ fields: ["title", "key", "text"], words: ["keeper", "lighthouse", "okoro"], lines: [{ line: 1, text: "Okoro keeps the lighthouse and owes the mill a debt." }] });
  });
});

describe("lore_read", () => {
  test("reads several entries whole in one call, by the short id, the id in its brackets or the id whole", async () => {
    const r = await turnRig();
    expect(await r.run("lore_read", { ids: ["11111111-c", "[22222222-c] Ilse", ID.okoro] })).toEqual({
      text: [
        "[11111111-c] The Mill (switched off) (book “The Coast”) · keys: mill, millrace · characters 0 to 88 of 88:",
        "The mill stands where the river meets the sea.",
        "Its wheel has not turned since the flood.",
        "",
        "[22222222-c] Ilse (book “People”) · keys: ilse, miller · characters 0 to 57 of 57:",
        "Ilse runs the mill and keeps the coast's ledger of debts.",
        "",
        "[22222222-a] Okoro (in the prompt) (always sent) (book “People”) · keys: okoro, keeper · characters 0 to 102 of 102:",
        "Okoro keeps the lighthouse and owes the mill a debt.",
        "He was Brann's mate on the Heron before she sank.",
      ].join("\n"),
    });
    // One id alone is taken too, and an entry named twice is read once.
    expect((await r.run("lore_read", { id: "22222222-c", ids: [ID.ilse] })).text).toBe("[22222222-c] Ilse (book “People”) · keys: ilse, miller · characters 0 to 57 of 57:\nIlse runs the mill and keeps the coast's ledger of debts.");
  });

  test("a long read comes a page at a time, and the pages give every text back whole", async () => {
    const host = harbour();
    host.addEntry("book-coast", ID.flood, "The Flood", ["flood", "high water"], FLOOD);
    const r = await turnRig((s) => (s.tools.pageChars = 420), host);
    const ids = ["33333333", "11111111-a", "99999999", "22222222-b", "22222222-c"];
    const all = await pages(r, "lore_read", { ids });
    expect(all.length).toBeGreaterThan(4);
    for (const page of all) expect(page.length).toBeLessThanOrEqual(420);
    // Each part is framed with the characters it holds: put back together by the id its frame names, each starting where the last ended.
    const read = new Map<string, string>();
    for (const page of all) {
      for (const frame of page.matchAll(/^\[([^\]]+)\] .* · characters (\d+) to (\d+) of \d+:\n/gm)) {
        const id = frame[1] ?? "";
        const start = (frame.index ?? 0) + frame[0].length;
        expect({ id, from: Number(frame[2]) }).toEqual({ id, from: (read.get(id) ?? "").length });
        read.set(id, `${read.get(id) ?? ""}${page.slice(start, start + Number(frame[3]) - Number(frame[2]))}`);
      }
    }
    expect([...read.keys()]).toEqual(["33333333", "11111111-a", "22222222-b", "22222222-c"]);
    expect(read.get("33333333")).toBe(FLOOD);
    for (const id of [ID.customs, ID.brann, ID.ilse]) expect([...read.values()]).toContain(host.entries.find((e) => e.id === id)?.content ?? "");
    expect(all.at(-1)).toEndWith("[That is the end.]");
    // The id that names no entry is said once, with the page the read starts on.
    expect(all[0]).toStartWith("[Not read: 99999999: no lore entry goes by that id.]\n[33333333] The Flood (book “The Coast”) · keys: flood, high water · characters 0 to ");
    expect(all.slice(1).filter((page) => page.includes("Not read"))).toEqual([]);
    // A cursor names the entry by its place in the call and where in its text the next page starts.
    expect(cursorOf(all[0] ?? "")).toMatch(/^1:\d+$/);
    expect((await r.run("lore_read", { ids, cursor: "5:0" })).error).toBe(true);
  });

  test("one id that names no entry, or several, is answered with what to give instead", async () => {
    const r = await turnRig();
    expect(await r.run("lore_read", { ids: ["99999999"] })).toEqual({ text: "There is no lore entry 99999999 in the books that apply to this chat. Take an id from the request's index, lore_index or a lore search, written as it gives it.", error: true });
    expect(await r.run("lore_read", { id: "2222" })).toEqual({ text: "2222 names several entries: [22222222-a] Okoro, [22222222-b] Brann, [22222222-c] Ilse. Give more of the id.", error: true });
    expect(await r.run("lore_read")).toEqual({ text: "lore_read needs ids: The entries' ids, as the index and the lore searches give them. Call it again with ids.", error: true });
  });

  test("among several ids, the ones that name an entry are read and the others are said with why", async () => {
    const r = await turnRig();
    expect(await r.run("lore_read", { ids: ["22222222-c", "99999999", "2222"] })).toEqual({
      text: ["[Not read: 99999999: no lore entry goes by that id; 2222: it names several entries ([22222222-a] Okoro, [22222222-b] Brann, [22222222-c] Ilse): give more of the id.]", "[22222222-c] Ilse (book “People”) · keys: ilse, miller · characters 0 to 57 of 57:", "Ilse runs the mill and keeps the coast's ledger of debts."].join("\n"),
    });
    expect(await r.run("lore_read", { ids: ["99999999", "88888888"] })).toEqual({ text: "[Not read: 99999999: no lore entry goes by that id; 88888888: no lore entry goes by that id.]", error: true });
    // More ids than one call carries: the first are read, the rest named.
    const two = await turnRig((s) => (s.recall.lore.reads = 2));
    expect((await two.run("lore_read", { ids: ["22222222-c", "22222222-b", "11111111-a", "11111111-b"] })).text).toEndWith("His debt is the longest page in Ilse's ledger.\n[One call carries 2 at most; the rest weren't run: 11111111-a; 11111111-b. Call again with those.]");
  });
});

describe("lore_grep", () => {
  test("finds every line that holds the text, in any letter case, with its entry and line number", async () => {
    const r = await turnRig();
    expect(await r.run("lore_grep", { text: "SINCE THE FLOOD" })).toEqual({ text: ["2 lines found; showing 1 to 2.", "- [11111111-a] The Customs House, line 3: Ilse's ledger has been locked in it since the flood.", "- [11111111-c] The Mill, line 2: Its wheel has not turned since the flood."].join("\n") });
    expect((await r.run("lore_grep", { text: "okoro", book: "book-coast" })).text).toBe("1 line found; showing 1 to 1.\n- [11111111-b] The Lighthouse, line 2: Okoro keeps it, and keeps the second key on a cord around his neck.");
    expect(await r.run("lore_grep", { text: "tavern" })).toEqual({ text: "No line of the lore holds “tavern”. Try a shorter piece of it, or lore_search for the words in any order." });
    const paged = await turnRig((s) => (s.tools.pageItems = 3));
    const all = await pages(paged, "lore_grep", { text: "the" });
    expect(all.map((page) => page.split("\n")[0])).toEqual(["12 lines found; showing 1 to 3.", "12 lines found; showing 4 to 6.", "12 lines found; showing 7 to 9.", "12 lines found; showing 10 to 12."]);
  });

  test("takes a regular expression where the call asks, and refuses one that could run away or can't be read", async () => {
    const r = await turnRig();
    expect((await r.run("lore_grep", { text: "k(ey|eeper)s?\\b", regex: true })).text).toBe(
      ["3 lines found; showing 1 to 3.", "- [11111111-a] The Customs House, line 2: Its strongbox takes two keys turned at once: the brass key and the keeper's.", "- [11111111-b] The Lighthouse, line 2: Okoro keeps it, and keeps the second key on a cord around his neck.", "- [22222222-b] Brann, line 1: Brann was master of the Heron. He says the brass key went down with her."].join("\n"),
    );
    // As plain text the same characters are in no line.
    expect((await r.run("lore_grep", { text: "k(ey|eeper)s?\\b" })).text).toStartWith("No line of the lore holds");
    expect(await r.run("lore_grep", { text: "(a+)+$", regex: true })).toEqual({ text: "“(a+)+$” can't be used as a pattern: it repeats a group, which can take very long to match: put a repeat (*, +, {n,m}) after one character or one class only, as in [a-z]+ or \\d{2,4}, and write alternatives without a repeat around them. Give plain text without regex, or a simpler expression.", error: true });
    const unread = await r.run("lore_grep", { text: "([", regex: true });
    expect(unread.error).toBe(true);
    expect(unread.text).toStartWith("“([” can't be used as a pattern: ");
    expect(unread.text).toEndWith(" Give plain text without regex, or a simpler expression.");
  });
});

describe("lore_related", () => {
  test("goes one hop along the lore's own links, both ways, each with the line that makes the link", async () => {
    const r = await turnRig();
    expect(await r.run("lore_related", { id: "22222222-a" })).toEqual({
      text: [
        "[22222222-a] Okoro (in the prompt) (always sent) (book “People”, 102 characters).",
        // What Okoro's own text names, by the line of it that does.
        "It mentions 3 entries:",
        "- [11111111-b] The Lighthouse (in the prompt) · 135 characters · “the lighthouse”, line 1: Okoro keeps the lighthouse and owes the mill a debt.",
        "- [11111111-c] The Mill (switched off) · 88 characters · “the mill”, line 1: Okoro keeps the lighthouse and owes the mill a debt.",
        "- [22222222-b] Brann · 119 characters · “brann”, line 2: He was Brann's mate on the Heron before she sank.",
        // What names Okoro by his title or a key, by the line of the other entry that does.
        "Mentioned by 2 entries:",
        "- [11111111-a] The Customs House · 182 characters · “keeper”, line 2: Its strongbox takes two keys turned at once: the brass key and the keeper's.",
        "- [11111111-b] The Lighthouse (in the prompt) · 135 characters · “okoro”, line 2: Okoro keeps it, and keeps the second key on a cord around his neck.",
      ].join("\n"),
    });
    expect((await r.run("lore_related", { id: "11111111-a" })).text).toEndWith("Mentioned by 0 entries:\n(none)");
  });

  test("lists as many links each way as Settings allow and counts the rest", async () => {
    const r = await turnRig((s) => (s.recall.lore.links = 1));
    expect((await r.run("lore_related", { id: ID.okoro })).text).toBe(
      [
        "[22222222-a] Okoro (in the prompt) (always sent) (book “People”, 102 characters).",
        "It mentions 3 entries:",
        "- [11111111-b] The Lighthouse (in the prompt) · 135 characters · “the lighthouse”, line 1: Okoro keeps the lighthouse and owes the mill a debt.",
        "(and 2 more: lore_grep finds every line that holds the name)",
        "Mentioned by 2 entries:",
        "- [11111111-a] The Customs House · 182 characters · “keeper”, line 2: Its strongbox takes two keys turned at once: the brass key and the keeper's.",
        "(and 1 more: lore_grep finds every line that holds the name)",
      ].join("\n"),
    );
    // A page too short for every link drops lines with a count, never a part of one.
    const short = await turnRig((s) => (s.tools.pageChars = 560));
    const answer = (await short.run("lore_related", { id: ID.okoro })).text;
    expect(answer.length).toBeLessThanOrEqual(560);
    expect(answer.split("\n").filter((line) => line.startsWith("(and "))).toEqual(["(and 2 more: lore_grep finds every line that holds the name)", "(and 1 more: lore_grep finds every line that holds the name)"]);
    expect(await r.run("lore_related", { id: "99999999" })).toEqual({ text: "There is no lore entry 99999999 in the books that apply to this chat. Take an id from the request's index, lore_index or a lore search, written as it gives it.", error: true });
    expect((await r.run("lore_related", { id: "1111" })).text).toBe("1111 names several entries: [11111111-a] The Customs House, [11111111-b] The Lighthouse, [11111111-c] The Mill. Give more of the id.");
  });
});

describe("lore_about", () => {
  test("gives the entries titled or keyed with a name, then the entries whose text mentions it", async () => {
    const r = await turnRig();
    expect(await r.run("lore_about", { name: "Okoro" })).toEqual({
      text: [
        "“Okoro” in the lore.",
        "Titled or keyed with it (1 entry):",
        "- [22222222-a] Okoro (in the prompt) (always sent) · keys: okoro, keeper · 102 characters",
        "Mentioning it (1 entry):",
        "- [11111111-b] The Lighthouse (in the prompt) · 135 characters · “okoro”, line 2: Okoro keeps it, and keeps the second key on a cord around his neck.",
      ].join("\n"),
    });
    // A name is a word of its own: "mill" is the mill's title and key, and isn't found inside Ilse's key "miller".
    expect((await r.run("lore_about", { name: "MILL" })).text).toBe(
      [
        "“MILL” in the lore.",
        "Titled or keyed with it (1 entry):",
        "- [11111111-c] The Mill (switched off) · keys: mill, millrace · 88 characters",
        "Mentioning it (2 entries):",
        "- [22222222-a] Okoro (in the prompt) (always sent) · 102 characters · “mill”, line 1: Okoro keeps the lighthouse and owes the mill a debt.",
        "- [22222222-c] Ilse · 57 characters · “mill”, line 1: Ilse runs the mill and keeps the coast's ledger of debts.",
      ].join("\n"),
    );
  });

  test("finds a phrase no entry is named for, and says so when the books hold nothing on a name", async () => {
    const r = await turnRig();
    expect((await r.run("lore_about", { name: "the  brass key" })).text).toBe(
      [
        "“the  brass key” in the lore.",
        "Titled or keyed with it (0 entries):",
        "(none)",
        "Mentioning it (2 entries):",
        "- [11111111-a] The Customs House · 182 characters · “the brass key”, line 2: Its strongbox takes two keys turned at once: the brass key and the keeper's.",
        "- [22222222-b] Brann · 119 characters · “the brass key”, line 1: Brann was master of the Heron. He says the brass key went down with her.",
      ].join("\n"),
    );
    expect(await r.run("lore_about", { name: "the tavern" })).toEqual({ text: "The lore holds nothing on “the tavern” as written: no entry is titled or keyed with it, and none mentions it. lore_search finds by words in any order; chat_about traces a name through the chat." });
    expect(await r.run("lore_about", { name: " " })).toEqual({ text: "lore_about needs name: The name, as the lore writes it. Call it again with name.", error: true });
    const one = await turnRig((s) => (s.recall.lore.links = 1));
    expect((await one.run("lore_about", { name: "mill" })).text).toEndWith("Mentioning it (2 entries):\n- [22222222-a] Okoro (in the prompt) (always sent) · 102 characters · “mill”, line 1: Okoro keeps the lighthouse and owes the mill a debt.\n(and 1 more: lore_grep finds every line that holds the name)");
  });
});

describe("active_lore", () => {
  test("lists the entries the prompt holds in the request's order, each with the text the request has of it", async () => {
    const host = harbour();
    const brann = activated(host, ID.brann);
    host.activatedLore = [brann, activated(host, ID.okoro), activated(host, ID.lighthouse)];
    // Okoro and the lighthouse are messages of their own; a preset's macro put Brann inside a block, which comes first.
    const block: RequestMessage = { role: "system", content: `World notes.\n${brann.content}\nEnd of notes.`, source: { kind: "block", blockId: "b-notes" } };
    const r = await toolRig(host, LORE_TOOLS, { turn: { messages: [block, ...host.requestOf(CHAT, 12, null), host.loreMessage(ID.lighthouse), host.loreMessage(ID.okoro)] } });
    expect(await r.run("active_lore")).toEqual({
      text: [
        "3 entries found; showing 1 to 3.",
        "- [11111111-b] The Lighthouse (book “The Coast”, 135 characters): The lighthouse stands on the point, an hour's row from the harbour. Okoro keeps it, and keeps the second key on a cord around his neck.",
        "- [22222222-a] Okoro (book “People”, 102 characters): Okoro keeps the lighthouse and owes the mill a debt. He was Brann's mate on the Heron before she sank.",
        "- [22222222-b] Brann (book “People”, 119 characters): Brann was master of the Heron. He says the brass key went down with her. His debt is the longest page in Ilse's ledger.",
      ].join("\n"),
    });
    // The index marks the same three.
    expect(listedIds((await r.run("lore_index", { state: "in_prompt" })).text)).toEqual(["11111111-b", "22222222-a", "22222222-b"]);
    const paged = await toolRig(host, LORE_TOOLS, { runId: "gen-paged", turn: { messages: [block, host.loreMessage(ID.lighthouse), host.loreMessage(ID.okoro)] }, settings: (s) => (s.tools = { ...s.tools, pageItems: 2, excerptChars: 40 }) });
    expect(await pages(paged, "active_lore", {})).toEqual([
      ["3 entries found; showing 1 to 2.", "- [11111111-b] The Lighthouse (book “The Coast”, 135 characters): The lighthouse stands on the point, an …", "- [22222222-a] Okoro (book “People”, 102 characters): Okoro keeps the lighthouse and owes the…", '[There is more: call active_lore again with the same arguments and cursor "2".]'].join("\n"),
      ["3 entries found; showing 3 to 3.", "- [22222222-b] Brann (book “People”, 119 characters): Brann was master of the Heron. He says …", "[That is the end.]"].join("\n"),
    ]);
  });

  test("says so where the prompt holds none", async () => {
    const r = await toolRig(harbour(), LORE_TOOLS);
    expect(await r.run("active_lore")).toEqual({ text: "Lumiverse activated no lore entry for this reply. lore_search and lore_index reach the books that apply." });
  });

  test("an entry Lumiverse activated whose text the request doesn't show isn't told as in the prompt: it is named apart (M8)", async () => {
    const host = harbour();
    host.activatedLore = [activated(host, ID.lighthouse), activated(host, ID.brann)];
    const r = await toolRig(host, LORE_TOOLS, { turn: { messages: [...host.requestOf(CHAT, 12, null), host.loreMessage(ID.lighthouse)] } });
    const apart = "[Activated by Lumiverse, but their text is not in the request, so the writer doesn't have them: [22222222-b] Brann.]";
    const active = (await r.run("active_lore")).text.split("\n");
    expect(active).toContain(apart);
    expect(active.filter((line) => line.startsWith("- ["))).toEqual(["- [11111111-b] The Lighthouse (book “The Coast”, 135 characters): The lighthouse stands on the point, an hour's row from the harbour. Okoro keeps it, and keeps the second key on a cord around his neck."]);
    // The lists that say how each entry stands don't call it in the prompt either.
    expect(listedIds((await r.run("lore_index", { state: "in_prompt" })).text)).toEqual(["11111111-b"]);
    expect((await r.run("lore_index", { state: "not_in_prompt" })).text).toContain("[22222222-b] Brann");
    // Where the request shows none of what Lumiverse activated, that is the whole answer.
    const none = harbour();
    none.activatedLore = [activated(none, ID.brann)];
    expect(await (await toolRig(none, LORE_TOOLS)).run("active_lore")).toEqual({ text: apart });
  });
});

describe("where there is no lore to read", () => {
  test("every tool says that no world book applies, and none is offered in a run about no chat", async () => {
    const host = new RecallHost();
    host.say(CHAT, "user", "I walk down to the harbour at dusk.");
    const r = await toolRig(host, LORE_TOOLS);
    const none = { text: "No world book applies to this chat, so there is no lore to read here. Work from the request." };
    for (const [name, args] of [["lore_index", {}], ["lore_search", { queries: ["mill"] }], ["lore_grep", { text: "mill" }], ["lore_read", { ids: ["11111111"] }], ["lore_related", { id: "11111111" }], ["lore_about", { name: "mill" }]] as [string, JsonObject][]) expect({ name, answer: await r.run(name, args) }).toEqual({ name, answer: none });
    // A book without an entry is listed, and has nothing to search or read.
    host.addBook("book-empty", "Sketches", "Nothing yet.");
    const empty = await toolRig(host, LORE_TOOLS, { runId: "gen-empty" });
    expect(await empty.run("lore_index")).toEqual({ text: "1 book found; showing 1 to 1.\nBook “Sketches” [book-empty], 0 entries — Nothing yet.:" });
    expect(await empty.run("lore_search", { queries: ["mill"] })).toEqual(none);
    expect((await toolRig(harbour(), LORE_TOOLS, { chatId: "" })).offered()).toEqual([]);
  });
});

describe("answers stay within Answer length", () => {
  const long = "strongbox ledger ".repeat(300).trim();
  const start = long.slice(0, 299);
  const calls: [string, JsonObject][] = [
    ["lore_index", { book: long }],
    ["lore_index", { state: long }],
    ["lore_index", { text: long }],
    ["lore_index", { text: long, state: "off", book: "people" }],
    ["lore_index", { cursor: long }],
    ["lore_search", { queries: [long] }],
    ["lore_search", { queries: [long, `${long} a`, `${long} b`, `${long} c`, `${long} d`, `${long} e`, `${long} f`, `${long} g`] }],
    ["lore_search", { queries: ["tavern", "anchor", "saddle", "orchard", "candle", "ribbon", long] }],
    ["lore_search", { queries: ["mill"], book: long }],
    ["lore_search", { queries: ["mill"], cursor: long }],
    ["lore_search", { queries: ["mill", "key", "debt", "ledger", "flood", "harbour"] }],
    ["lore_grep", { text: long }],
    ["lore_grep", { text: long, regex: true }],
    ["lore_grep", { text: "the", book: long }],
    ["lore_grep", { text: "the", cursor: long }],
    ["lore_grep", { text: "the" }],
    ["lore_read", { ids: [long] }],
    ["lore_read", { ids: [`${long}/1111`] }],
    ["lore_read", { ids: [long, `${long}/1111`, "11111111-a", `${long} 2`, `${long} 3`, `${long} 4`, `${long} 5`, `${long} 6`, `${long} 7`, `${long} 8`] }],
    ["lore_read", { ids: ["11111111-a"], cursor: long }],
    ["lore_read", { ids: ["11111111-a", "11111111-b", "22222222-a", "22222222-b"] }],
    ["lore_related", { id: long }],
    ["lore_related", { id: `${long}/1111` }],
    ["lore_related", { id: "22222222-a" }],
    ["lore_about", { name: long }],
    ["lore_about", { name: "okoro" }],
    ["active_lore", { cursor: long }],
    ["active_lore", {}],
  ];

  test("whatever a call's arguments are: 5,000 characters of each are answered within one page", async () => {
    expect(long.length).toBeGreaterThanOrEqual(5000);
    for (const pageChars of [4000, 1000, 400]) {
      const r = await turnRig((s) => (s.tools.pageChars = pageChars));
      for (const [name, args] of calls) {
        const answer = await r.run(name, args);
        expect({ pageChars, name, args: JSON.stringify(args).slice(0, 60), length: answer.text.length <= pageChars ? "within" : answer.text.length }).toEqual({ pageChars, name, args: JSON.stringify(args).slice(0, 60), length: "within" });
      }
    }
  });

  test("an argument said back gives way to what to do next, even on the shortest page Settings allow", async () => {
    const r = await turnRig();
    // At most a line of an argument is said back, and what there is keeps its place after it.
    expect(await r.run("lore_index", { book: long })).toEqual({ text: `No book “${start}…” applies to this chat. The books are: “The Coast” [book-coast], “People” [book-people]. Give one of those, or leave book out for them all.`, error: true });
    expect(await r.run("lore_read", { ids: [long] })).toEqual({ text: `There is no lore entry ${start}… in the books that apply to this chat. Take an id from the request's index, lore_index or a lore search, written as it gives it.`, error: true });
    expect(await r.run("lore_grep", { text: long, regex: true })).toEqual({ text: `“${start}…” can't be used as a pattern: it is longer than 300 characters (Line length). Give plain text without regex, or a simpler expression.`, error: true });
    // Answer length as short as it may be set, with Line length longer than it.
    const small = await turnRig((s) => (s.tools = { ...s.tools, pageChars: 200, lineChars: 300 }));
    for (const [name, args] of [["lore_index", { book: long }], ["lore_index", { state: long }], ["lore_index", { cursor: long }], ["lore_search", { queries: ["mill"], cursor: long }], ["lore_grep", { text: long }], ["lore_read", { ids: [long] }], ["lore_read", { ids: [`${long}/1111`] }], ["lore_related", { id: long }], ["lore_about", { name: long }], ["active_lore", { cursor: long }]] as [string, JsonObject][]) {
      const { text } = await small.run(name, args);
      expect({ name, length: text.length <= 200 ? "within" : text.length, whole: /\.$/.test(text) }).toEqual({ name, length: "within", whole: true });
    }
    // On a page too short for an answer's own words, the answer is cut at the page.
    for (const [name, args] of calls) expect((await small.run(name, args)).text.length).toBeLessThanOrEqual(200);
  });
});

describe("the lore's index is kept between runs", () => {
  test("a later run of the same chat reads no book again while none changed, and indexes only the entry that did", async () => {
    const host = harbour();
    // Lumiverse says when each book last changed, so it can say that one didn't.
    host.bookMore.set("book-coast", { updatedAt: 1000 });
    host.bookMore.set("book-people", { updatedAt: 2000 });
    const first = await toolRig(host, LORE_TOOLS, { runId: "gen-1" });
    await first.run("lore_index");
    expect({ asked: host.loreReads, whole: host.bookReads }).toEqual({ asked: 1, whole: 2 });
    // Every call of one run reads the lore as it stood when the run first asked.
    await first.run("lore_search", { queries: ["ledger"] });
    await first.run("lore_read", { ids: ["22222222-b"] });
    expect(host.loreReads).toBe(1);

    const corpus = await recallOf(first.env).lore();
    const { index } = corpus;
    const docs = [...corpus.docs];
    const indexed: string[] = [];
    const add = index.add.bind(index);
    index.add = (key, text, heads) => {
      indexed.push(key);
      add(key, text, heads);
    };

    // The next run asks Lumiverse once, is told that neither book changed, and reads no entry.
    const second = await toolRig(host, LORE_TOOLS, { runId: "gen-2" });
    expect((await second.run("lore_search", { queries: ["ledger"] })).text).toStartWith("“ledger”: 3 entries found; showing 1 to 3.");
    expect({ asked: host.loreReads, whole: host.bookReads }).toEqual({ asked: 2, whole: 2 });
    const kept = await recallOf(second.env).lore();
    expect(kept).toBe(corpus);
    expect(kept.index).toBe(index);
    expect(kept.docs.map((doc, i) => doc === docs[i])).toEqual([true, true, true, true, true, true]);
    expect(indexed).toEqual([]);

    // One entry changes: its book is read whole, and that entry alone is indexed again.
    const brann = host.entries.find((e) => e.id === ID.brann);
    if (!brann) throw new Error("the fixture has no such entry");
    brann.content = "Brann sold the Heron's bell to pay Ilse.\nHe keeps a ferry now.";
    host.bookMore.set("book-people", { updatedAt: 3000 });
    const third = await toolRig(host, LORE_TOOLS, { runId: "gen-3" });
    expect((await third.run("lore_search", { queries: ["ferry"] })).text).toStartWith("“ferry”: 1 entry found; showing 1 to 1.\n- [22222222-b] Brann · book “People” · 62 characters · matched text: ferry\n    line 2: He keeps a ferry now.");
    expect({ asked: host.loreReads, whole: host.bookReads }).toEqual({ asked: 3, whole: 3 });
    expect(indexed).toEqual([ID.brann]);
    const now = await recallOf(third.env).lore();
    expect(now.index).toBe(index);
    expect(now.docs.map((doc, i) => doc === docs[i])).toEqual([true, true, true, true, false, true]);
    // What the entry no longer says is no longer found, and what links to it is worked out from its new text.
    expect((await third.run("lore_search", { queries: ["longest"] })).text).toBe("No lore entry matches “longest”. Try fewer or other words, lore_about for a name, or lore_index to see what the books hold.");
    expect((await third.run("lore_related", { id: "22222222-b" })).text).toContain("It mentions 1 entry:\n- [22222222-c] Ilse · 57 characters · “ilse”, line 1: Brann sold the Heron's bell to pay Ilse.");
  });

  test("an entry that came or went is indexed or forgotten, and the ids stay as short as they can be", async () => {
    const host = harbour();
    const first = await toolRig(host, LORE_TOOLS, { runId: "gen-1" });
    expect(listedIds((await first.run("lore_index", { book: "People" })).text)).toEqual(["22222222-a", "22222222-b", "22222222-c"]);
    host.entries.splice(host.entries.findIndex((e) => e.id === ID.brann), 1);
    host.addEntry("book-people", "22222222-cccc-4000-8000-00000000000f", "Mara", ["mara"], "Mara rows out to the lighthouse with the brass key.");
    const second = await toolRig(host, LORE_TOOLS, { runId: "gen-2" });
    // Two ids now share all but their last character, so each is shown whole; the others keep their short form.
    expect(listedIds((await second.run("lore_index", { book: "People" })).text)).toEqual(["22222222-a", "22222222-cccc-4000-8000-000000000006", "22222222-cccc-4000-8000-00000000000f"]);
    expect((await second.run("lore_search", { queries: ["brann"] })).text).toStartWith("“brann”: 1 entry found; showing 1 to 1.\n- [22222222-a] Okoro");
    expect((await second.run("lore_read", { ids: ["22222222-b"] })).error).toBe(true);
    expect((await second.run("lore_about", { name: "Mara" })).text).toStartWith("“Mara” in the lore.\nTitled or keyed with it (1 entry):\n- [22222222-cccc-4000-8000-00000000000f] Mara · keys: mara · 51 characters");
  });
});
