// The tools over what Lumiverse itself keeps (DESIGN §24.4): its Memory Cortex, the user's
// databanks and their web search provider. Each rests on a port the host may lack and on something
// the user may not have set up, and is offered only where both are there; what a port answers is
// outside data; and no answer is longer than Answer length, whatever is asked and whatever is held.

import { describe, expect, test } from "bun:test";
import type { MemoryHit, WebResult } from "../../src/core/recall/ports";
import { TEXT } from "../../src/core/texts";
import { DATABANK_TOOLS } from "../../src/core/tools/databanks";
import { MEMORY_TOOLS } from "../../src/core/tools/memory";
import { WEB_TOOLS } from "../../src/core/tools/web";
import { DAY, FakeDatabanks, FakeMemory, FakeWeb, harbour, pages, type RecallHost, START, toolRig } from "./recall-support";

const SOURCES = [...MEMORY_TOOLS, ...DATABANK_TOOLS, ...WEB_TOOLS];
const NAMES = ["memory_search", "memory_entity", "memory_arcs", "databank_list", "databank_search", "databank_read", "web_search"];

const TIDES = "Spring tides run highest at the new moon.\nThe harbour bar is passable two hours either side of high water.\nNeap tides leave the customs quay dry.";
const TRADE = "Salt cod goes south in autumn.\nBrass fittings come north from the foundry at the river mouth.";
const NETS = "A torn net is mended from the selvedge inward.\nTarred twine lasts two seasons.";

interface Shore {
  host: RecallHost;
  memory: FakeMemory;
  banks: FakeDatabanks;
  web: FakeWeb;
}

/** The harbour story on a host whose user has the Memory Cortex on, three databanks and a web search provider. */
function shore(): Shore {
  const host = harbour();
  const ports = host.recall;
  if (!ports) throw new Error("the fixture's host has no recall ports");
  const memory = new FakeMemory();
  const banks = new FakeDatabanks();
  const web = new FakeWeb();
  ports.memory = memory;
  ports.databanks = banks;
  ports.web = web;

  memory.hits = [
    { source: "chunk", text: "Joss confirms the brass key opens the customs house strongbox.\nOkoro has the only other.", score: 0.91234, span: [1, 3], entities: ["Joss", "Okoro"] },
    { source: "arc", text: "Mara rows to the lighthouse; Okoro says Ilse wants the ledger.", score: 0.5, span: [4, 7], entities: ["Okoro", "Ilse"] },
    { source: "chunk", text: "Brann's debt is the longest page of the ledger.", score: 0.4, span: null, entities: [] },
  ];
  memory.entitiesKnown = [
    {
      id: "ent-okoro",
      name: "Okoro",
      type: "character",
      aliases: ["the keeper"],
      description: "Keeps the lighthouse and the second key.",
      status: "active",
      facts: ["He keeps the second key on a cord around his neck.", "He was Brann's mate on the Heron.", "He owes the mill a debt."],
      mentions: 6,
      lastSeenAt: START + 8 * DAY + 6 * 60_000,
      relations: [
        { target: "Brann", type: "ally", label: "mate on the Heron", strength: 0.8, sentiment: 0.25 },
        { target: "Ilse", type: "owes", label: null, strength: 0.5, sentiment: -0.4 },
      ],
    },
    { id: "ent-brann", name: "Brann", type: "character", aliases: [], description: "", status: "unknown", facts: [], mentions: 4, lastSeenAt: null, relations: [] },
  ];
  memory.arcsMade = [
    { id: "arc-3", tier: 1, title: null, summary: "At the lighthouse Okoro says Ilse wants the ledger.", span: [4, 7], at: START + 9 * DAY },
    { id: "arc-4", tier: 1, title: null, summary: "A scene the Cortex couldn't place.", span: null, at: START + 9 * DAY },
    { id: "arc-1", tier: 1, title: null, summary: "At the harbour Joss tells Mara\nwhat the brass key opens.", span: [0, 3], at: START + 9 * DAY },
    { id: "arc-2", tier: 2, title: "The two keys", summary: "Mara learns the strongbox wants two keys and goes to find Okoro.", span: [0, 7], at: START + 9 * DAY },
  ];

  banks.banks = [
    { id: "bank-coast", name: "Coast almanac", description: "Tides and trades", scope: "global", documents: 2 },
    { id: "bank-loose", name: "Loose notes", description: "", scope: "chat", documents: 0 },
    { id: "bank-joss", name: "Joss's papers", description: "", scope: "character", documents: 2 },
  ];
  banks.add("bank-coast", "doc-tides-0001", "Tide tables", TIDES);
  banks.add("bank-coast", "doc-trade-0002", "Trade ledger", TRADE);
  banks.add("bank-joss", "doc-nets-0003", "Net mending", NETS);
  banks.docs.push({ id: "doc-chart-0004", databankId: "bank-joss", name: "Harbour chart", version: "v-0", bytes: null, status: "processing" });

  web.results = [
    { title: "Spring and neap tides", url: "https://almanac.example/tides", snippet: "Why the highest tides follow the new and the full moon.", content: "A spring tide comes twice a month,\nwhen the sun and the moon pull along one line." },
    { title: "Reading a tide table", url: "https://pilot.example/tables", snippet: "Heights, times and the datum they are measured from.", content: "A tide table gives the time and the height of each high and low water." },
    { title: "Harbour bars", url: "https://pilot.example/bars", snippet: "When a bar can be crossed." },
  ];
  return { host, memory, banks, web };
}

const failing = (why: string) => async (): Promise<never> => {
  throw new Error(why);
};

describe("memory_search", () => {
  test("answers each query on its own with what the Cortex gave", async () => {
    const { host, memory } = shore();
    const rig = await toolRig(host, SOURCES);
    const out = await rig.run("memory_search", { queries: ["brass key", "ledger", "tide tables"], entities: ["Okoro"] });
    expect(out.error).toBeUndefined();
    expect(out.text).toBe(
      [
        "“brass key”: 1 memory from Lumiverse's memory, the best first.",
        "- chunk #1 to #3 · score 0.91 · Joss, Okoro: Joss confirms the brass key opens the customs house strongbox. Okoro has the only other.",
        "“ledger”: 2 memories from Lumiverse's memory, the best first.",
        "- arc #4 to #7 · score 0.50 · Okoro, Ilse: Mara rows to the lighthouse; Okoro says Ilse wants the ledger.",
        "- chunk · score 0.40: Brann's debt is the longest page of the ledger.",
        "Lumiverse's memory gave nothing for “tide tables”. chat_search and chat_about search the messages themselves.",
      ].join("\n"),
    );
    expect(memory.searches).toEqual([
      { query: "brass key", limit: 8, entities: ["Okoro"] },
      { query: "ledger", limit: 8, entities: ["Okoro"] },
      { query: "tide tables", limit: 8, entities: ["Okoro"] },
    ]);
  });

  test("takes one query as a model writes one, asks for as many memories as Settings say, and names the queries past the limit", async () => {
    const { host, memory } = shore();
    const rig = await toolRig(host, SOURCES, {
      settings: (s) => {
        s.recall.chat.queries = 2;
        s.recall.memory.hits = 1;
      },
    });
    const one = await rig.run("memory_search", { query: "ledger" });
    expect(one.text).toBe("“ledger”: 1 memory from Lumiverse's memory, the best first.\n- arc #4 to #7 · score 0.50 · Okoro, Ilse: Mara rows to the lighthouse; Okoro says Ilse wants the ledger.");
    expect(memory.searches).toEqual([{ query: "ledger", limit: 1 }]);
    const many = await rig.run("memory_search", { queries: ["ledger", "brass key", "the Heron", "the mill"] });
    expect(memory.searches.map((s) => s.query)).toEqual(["ledger", "ledger", "brass key"]);
    expect(many.text).toContain("[One call carries 2 at most; the rest weren't run: the Heron; the mill. Call again with those.]");
    const none = await rig.run("memory_search", {});
    expect(none.error).toBe(true);
    expect(none.text).toContain("memory_search needs queries");
  });

  test("shares the page between its queries, and counts the memories that didn't fit", async () => {
    const { host, memory } = shore();
    memory.hits = Array.from({ length: 8 }, (_, i): MemoryHit => ({ source: "chunk", text: `Entry ${i} of the ledger: ${"a debt owed to the mill, ".repeat(40)}`, score: 1 - i / 10, span: [i, i], entities: ["Ilse"] }));
    const rig = await toolRig(host, SOURCES, { settings: (s) => (s.tools.pageChars = 2400) });
    const { pageChars } = rig.settings.tools;
    const two = await rig.run("memory_search", { queries: ["ledger", "debt"] });
    expect(two.text.length).toBeLessThanOrEqual(pageChars);
    expect(two.text).toContain("“ledger”: 8 memories");
    expect(two.text).toContain("“debt”: 8 memories");
    expect(two.text.match(/more: call memory_search with this query alone/g)?.length).toBe(2);
    const alone = await rig.run("memory_search", { queries: ["ledger"] });
    expect(alone.text.length).toBeLessThanOrEqual(pageChars);
    const shown = alone.text.split("\n").filter((line) => line.startsWith("- chunk")).length;
    expect(shown).toBeGreaterThan(two.text.split("\n").filter((line) => line.startsWith("- chunk")).length / 2);
    expect(alone.text).toContain(`(${8 - shown} more didn't fit this answer`);
  });
});

describe("memory_entity", () => {
  test("gives what the Cortex recorded of an entity, by its name or an alias", async () => {
    const { host } = shore();
    const rig = await toolRig(host, SOURCES);
    const out = await rig.run("memory_entity", { name: "the keeper" });
    expect(out.error).toBeUndefined();
    expect(out.text).toBe(
      [
        "Okoro (character, active) · the keeper · 6 mentions · 2026-03-12 09:06",
        "Keeps the lighthouse and the second key.",
        "Facts (3/3):",
        "- He keeps the second key on a cord around his neck.",
        "- He was Brann's mate on the Heron.",
        "- He owes the mill a debt.",
        "Relations (2/2):",
        "- ally Brann: mate on the Heron (strength 0.80, sentiment 0.25)",
        "- owes Ilse (strength 0.50, sentiment -0.40)",
      ].join("\n"),
    );
  });

  test("shows as many facts and relations as Settings say, and says of how many", async () => {
    const { host } = shore();
    const rig = await toolRig(host, SOURCES, {
      settings: (s) => {
        s.recall.memory.facts = 2;
        s.recall.memory.relations = 0;
      },
    });
    const none = rig.env.texts.render(TEXT.recall.none);
    const out = await rig.run("memory_entity", { name: "Okoro" });
    expect(out.text).toContain("Facts (2/3):\n- He keeps the second key on a cord around his neck.\n- He was Brann's mate on the Heron.\nRelations (0/2):");
    expect(out.text.endsWith(`Relations (0/2):\n${none}`)).toBe(true);
    const bare = await rig.run("memory_entity", { name: "Brann" });
    expect(bare.text).toBe(`Brann (character, unknown) · 4 mentions\n${none}\nFacts (0/0):\n${none}\nRelations (0/0):\n${none}`);
  });

  test("lists the entities for a name it doesn't know, and without a name", async () => {
    const { host, memory } = shore();
    const rig = await toolRig(host, SOURCES);
    const unknown = await rig.run("memory_entity", { name: "Mara" });
    expect(unknown.error).toBe(true);
    expect(unknown.text).toBe("Lumiverse's memory has no entity “Mara”. It knows: Okoro (character, 6 mentions), Brann (character, 4 mentions).");
    const all = await rig.run("memory_entity");
    expect(all.error).toBeUndefined();
    expect(all.text).toBe("The entities Lumiverse's memory has recorded for this chat, the most salient first (2 entities):\nOkoro (character, 6 mentions)\nBrann (character, 4 mentions)");
    memory.entitiesKnown = [];
    expect((await rig.run("memory_entity")).text).toBe("Lumiverse's memory has recorded no entity for this chat yet.");
  });
});

describe("memory_arcs", () => {
  test("lists the arcs by where each starts, the higher tier first, with when their messages were sent", async () => {
    const { host } = shore();
    const rig = await toolRig(host, SOURCES);
    const out = await rig.run("memory_arcs");
    expect(out.text).toBe(
      [
        "4 arcs found; showing 1 to 4.",
        "- #0 to #7 · 2026-03-04 to 2026-03-05 · tier 2 · The two keys: Mara learns the strongbox wants two keys and goes to find Okoro.",
        "- #0 to #3 · 2026-03-04 · tier 1: At the harbour Joss tells Mara what the brass key opens.",
        "- #4 to #7 · 2026-03-05 · tier 1: At the lighthouse Okoro says Ilse wants the ledger.",
        `- ${rig.env.texts.render(TEXT.recall.none)} · tier 1: A scene the Cortex couldn't place.`,
      ].join("\n"),
    );
  });

  test("pages by cursor, and says when the Cortex has made none", async () => {
    const { host, memory } = shore();
    const rig = await toolRig(host, SOURCES, { settings: (s) => (s.tools.pageItems = 3) });
    const read = await pages(rig, "memory_arcs", {});
    expect(read).toHaveLength(2);
    expect(read[0]).toContain("4 arcs found; showing 1 to 3.");
    expect(read[1]).toContain("4 arcs found; showing 4 to 4.");
    expect(read[1]).toContain("[That is the end.]");
    const bad = await rig.run("memory_arcs", { cursor: "9" });
    expect(bad.error).toBe(true);

    memory.arcsMade = [];
    const later = await toolRig(host, SOURCES, { runId: "gen-later" });
    expect((await later.run("memory_arcs")).text).toBe("Lumiverse's memory has made no arc of this chat yet. chat_outline gives the story's parts.");
  });
});

describe("databank_list", () => {
  test("lists each databank's documents under its heading, an empty databank where the list passes it", async () => {
    const { host } = shore();
    const rig = await toolRig(host, SOURCES);
    const out = await rig.run("databank_list");
    expect(out.text).toBe(
      [
        "4 documents found; showing 1 to 4.",
        "Databank “Coast almanac” [bank-coast] (global), 2 documents — Tides and trades:",
        `- [doc-tides-0001] Tide tables · ${TIDES.length} B`,
        `- [doc-trade-0002] Trade ledger · ${TRADE.length} B`,
        "Databank “Loose notes” [bank-loose] (chat), 0 documents:",
        "Databank “Joss's papers” [bank-joss] (character), 2 documents:",
        `- [doc-nets-0003] Net mending · ${NETS.length} B`,
        "- [doc-chart-0004] Harbour chart [processing]",
      ].join("\n"),
    );
  });

  test("leads each page with the databank its first document is of", async () => {
    const { host, banks } = shore();
    const rig = await toolRig(host, SOURCES, { settings: (s) => (s.tools.pageItems = 1) });
    const read = await pages(rig, "databank_list", {});
    expect(read).toHaveLength(4);
    expect(read[1]?.split("\n").slice(0, 3)).toEqual(["4 documents found; showing 2 to 2.", "Databank “Coast almanac” [bank-coast] (global), 2 documents — Tides and trades:", `- [doc-trade-0002] Trade ledger · ${TRADE.length} B`]);
    expect(read[2]).toContain("Databank “Loose notes” [bank-loose] (chat), 0 documents:\nDatabank “Joss's papers” [bank-joss] (character), 2 documents:\n- [doc-nets-0003]");
    expect(read[3]).toContain("Databank “Joss's papers” [bank-joss] (character), 2 documents:\n- [doc-chart-0004] Harbour chart [processing]");

    banks.docs = [];
    const empty = await rig.run("databank_list");
    expect(empty.text.split("\n")).toEqual(["Databank “Coast almanac” [bank-coast] (global), 0 documents — Tides and trades:", "Databank “Loose notes” [bank-loose] (chat), 0 documents:", "Databank “Joss's papers” [bank-joss] (character), 0 documents:"]);
  });
});

describe("databank_search", () => {
  test("finds documents by the words of their text and their name, and names the ones it couldn't search", async () => {
    const { host } = shore();
    const rig = await toolRig(host, SOURCES);
    const out = await rig.run("databank_search", { queries: ["spring tides at the new moon", "twine", "the Heron"] });
    expect(out.error).toBeUndefined();
    expect(out.text).toBe(
      [
        "“spring tides at the new moon”: 1 document found; showing 1 to 1.",
        `- [doc-tides-0001] Tide tables (databank “Coast almanac”, ${TIDES.length} characters)`,
        "    line 1: Spring tides run highest at the new moon.",
        "    line 3: Neap tides leave the customs quay dry.",
        "“twine”: 1 document found; showing 1 to 1.",
        `- [doc-nets-0003] Net mending (databank “Joss's papers”, ${NETS.length} characters)`,
        "    line 2: Tarred twine lasts two seasons.",
        "No databank document matches “the Heron”. databank_list lists what there is.",
        "[Not searched: [doc-chart-0004] Harbour chart. They are past Documents read in, or Lumiverse hasn't finished reading them; databank_read still reads one.]",
      ].join("\n"),
    );
    const byName = await rig.run("databank_search", { query: "ledger" });
    expect(byName.text).toContain("“ledger”: 1 document found; showing 1 to 1.\n- [doc-trade-0002] Trade ledger");
  });

  test("pages one query's hits by cursor", async () => {
    const { host, banks } = shore();
    for (let i = 0; i < 5; i++) banks.add("bank-loose", `doc-log-${i}`, `Watch log ${i}`, `Night ${i}: the lamp was trimmed and the fog bell rung.`);
    const rig = await toolRig(host, SOURCES, { settings: (s) => (s.tools.pageItems = 2) });
    const read = await pages(rig, "databank_search", { queries: ["fog bell"] });
    expect(read).toHaveLength(3);
    expect(read[0]).toContain("“fog bell”: 5 documents found; showing 1 to 2.");
    expect(read[2]).toContain("showing 5 to 5.");
    const found = read.join("\n").match(/doc-log-\d/g) ?? [];
    expect([...new Set(found)].sort()).toEqual(["doc-log-0", "doc-log-1", "doc-log-2", "doc-log-3", "doc-log-4"]);
  });

  test("reads a document's text once for each version it has, over two runs", async () => {
    const { host, banks } = shore();
    const first = await toolRig(host, SOURCES);
    await Promise.all([first.run("databank_search", { queries: ["tides"] }), first.run("databank_search", { queries: ["twine"] })]);
    await first.run("databank_search", { queries: ["brass"] });
    expect([...banks.reads]).toEqual([
      ["doc-tides-0001", 1],
      ["doc-trade-0002", 1],
      ["doc-nets-0003", 1],
    ]);

    const second = await toolRig(host, SOURCES, { runId: "gen-later" });
    expect((await second.run("databank_search", { queries: ["twine"] })).text).toContain("doc-nets-0003");
    expect([...banks.reads.values()]).toEqual([1, 1, 1]);

    // The net-mending notes are rewritten, the trade ledger is taken away, and the chart is read in at last.
    const nets = banks.docs.find((d) => d.id === "doc-nets-0003");
    if (!nets) throw new Error("the fixture lost a document");
    nets.version = "v-rewritten";
    banks.texts.set("doc-nets-0003", "Cork floats are cut from the bark in spring.");
    banks.docs = banks.docs.filter((d) => d.id !== "doc-trade-0002");
    const chart = banks.docs.find((d) => d.id === "doc-chart-0004");
    if (!chart) throw new Error("the fixture lost a document");
    chart.status = "ready";
    banks.texts.set("doc-chart-0004", "The bar lies a cable north of the lighthouse point.");

    const third = await toolRig(host, SOURCES, { runId: "gen-last" });
    const out = await third.run("databank_search", { queries: ["cork floats", "twine", "brass fittings", "cable north"] });
    expect(out.text).toContain("“cork floats”: 1 document found");
    expect(out.text).toContain("No databank document matches “twine”.");
    expect(out.text).toContain("No databank document matches “brass fittings”.");
    expect(out.text).toContain("- [doc-chart-0004] Harbour chart");
    expect(out.text).not.toContain("Not searched");
    expect(banks.reads.get("doc-tides-0001")).toBe(1);
    expect(banks.reads.get("doc-trade-0002")).toBe(1);
    expect(banks.reads.get("doc-nets-0003")).toBe(2);
    expect(banks.reads.get("doc-chart-0004")).toBe(1);
  });

  test("reads documents in the list's order up to Documents read in, and says which it didn't search", async () => {
    const { host, banks } = shore();
    const rig = await toolRig(host, SOURCES, { settings: (s) => (s.recall.databanks.indexChars = TIDES.length + 10) });
    const out = await rig.run("databank_search", { queries: ["tides", "twine"] });
    expect(out.text).toContain("“tides”: 1 document found");
    expect(out.text).toContain("No databank document matches “twine”.");
    expect(out.text).toContain("[Not searched: [doc-trade-0002] Trade ledger; [doc-nets-0003] Net mending; [doc-chart-0004] Harbour chart.");
    // The document that didn't fit was read to learn that; the ones after it weren't read at all, and a later call reads none again.
    expect([...banks.reads]).toEqual([
      ["doc-tides-0001", 1],
      ["doc-trade-0002", 1],
    ]);
    await rig.run("databank_search", { queries: ["brass"] });
    expect([...banks.reads.values()]).toEqual([1, 1]);
    // What it didn't search can still be read.
    expect((await rig.run("databank_read", { id: "doc-nets-0003" })).text).toContain("Tarred twine lasts two seasons.");
  });
});

describe("databank_read", () => {
  test("reads a document by its id, or by a start of it that names one alone", async () => {
    const { host } = shore();
    const rig = await toolRig(host, SOURCES);
    const whole = await rig.run("databank_read", { id: "doc-tides-0001" });
    expect(whole.text).toBe(`[doc-tides-0001] Tide tables (databank “Coast almanac”), characters 0 to ${TIDES.length} of ${TIDES.length}:\n${TIDES}`);
    expect((await rig.run("databank_read", { id: "[doc-ti]" })).text).toBe(whole.text);
    const shared = await rig.run("databank_read", { id: "doc-" });
    expect(shared.error).toBe(true);
    expect(shared.text).toBe("There is no document doc- in the databanks that apply to this chat. databank_list gives each one's id.");
    const unread = await rig.run("databank_read", { id: "doc-chart-0004" });
    expect(unread.error).toBe(true);
    expect(unread.text).toBe("Harbour chart has no text to read (processing): Lumiverse hasn't finished reading it in, or couldn't.");
    const missing = await rig.run("databank_read", {});
    expect(missing.error).toBe(true);
    expect(missing.text).toContain("databank_read needs id");
  });

  test("pages a long document, reading its text once", async () => {
    const { host, banks } = shore();
    const log = Array.from({ length: 400 }, (_, i) => `Day ${i}: high water at the bar, the wind backing west by nightfall.`).join("\n");
    banks.add("bank-loose", "doc-log-0009", "Harbour log", log);
    const rig = await toolRig(host, SOURCES);
    const read = await pages(rig, "databank_read", { id: "doc-log-0009" });
    expect(read.length).toBeGreaterThan(3);
    for (const page of read) expect(page.length).toBeLessThanOrEqual(rig.settings.tools.pageChars);
    const text = read.map((page) => page.slice(page.indexOf("\n") + 1).replace(/\n\[(There is more|That is the end)[^\n]*$/, "")).join("");
    expect(text).toBe(log);
    expect(banks.reads.get("doc-log-0009")).toBe(1);
  });
});

describe("web_search", () => {
  test("leaves the machine, so its tier is external", async () => {
    const { host } = shore();
    const rig = await toolRig(host, SOURCES);
    expect(WEB_TOOLS.map((tool) => [tool.name, tool.tier])).toEqual([["web_search", "external"]]);
    expect(rig.tools.get("web_search")?.tier).toBe("external");
    expect([...MEMORY_TOOLS, ...DATABANK_TOOLS].every((tool) => tool.tier === "read")).toBe(true);
  });

  test("gives the provider's results, and the pages' text where the call or Settings ask", async () => {
    const { host, web } = shore();
    const rig = await toolRig(host, SOURCES);
    const plain = await rig.run("web_search", { query: "spring tides" });
    expect(plain.text).toBe(
      [
        "“spring tides”: 3 results from the web.",
        "1. Spring and neap tides\n   https://almanac.example/tides\n   Why the highest tides follow the new and the full moon.",
        "2. Reading a tide table\n   https://pilot.example/tables\n   Heights, times and the datum they are measured from.",
        "3. Harbour bars\n   https://pilot.example/bars\n   When a bar can be crossed.",
      ].join("\n"),
    );
    const read = await rig.run("web_search", { query: "spring tides", pages: true });
    expect(read.text).toContain("   Why the highest tides follow the new and the full moon.\n   The page says: A spring tide comes twice a month, when the sun and the moon pull along one line.\n2. Reading a tide table");
    expect(read.text.endsWith("3. Harbour bars\n   https://pilot.example/bars\n   When a bar can be crossed.")).toBe(true);
    expect(web.searches).toEqual([
      { query: "spring tides", count: 5, pages: false },
      { query: "spring tides", count: 5, pages: true },
    ]);

    const set = await toolRig(host, SOURCES, {
      runId: "gen-later",
      settings: (s) => {
        s.recall.web.pages = true;
        s.recall.web.results = 2;
        s.recall.web.pageChars = 100;
      },
    });
    const byDefault = await set.run("web_search", { query: "tide table" });
    expect(byDefault.text).toContain("2 results from the web.");
    expect(byDefault.text).toContain("The page says: A tide table gives");
    await set.run("web_search", { query: "tide table", pages: false });
    expect(web.searches.slice(2)).toEqual([
      { query: "tide table", count: 2, pages: true },
      { query: "tide table", count: 2, pages: false },
    ]);
  });

  test("says what to do where there is no query, no result, or no provider any more", async () => {
    const { host, web } = shore();
    const rig = await toolRig(host, SOURCES);
    const missing = await rig.run("web_search", { pages: true });
    expect(missing.error).toBe(true);
    expect(missing.text).toContain("web_search needs query");
    web.results = [];
    expect(await rig.run("web_search", { query: "the Heron" })).toEqual({ text: "The web search gave nothing for “the Heron”. Try other words." });
    web.on = false;
    expect(await rig.run("web_search", { query: "the Heron" })).toEqual({ text: "No web search provider is set up in Lumiverse now, so nothing was searched.", error: true });
    expect(web.searches).toHaveLength(1);
  });

  test("keeps every result's address when the pages are long, the best result's page first", async () => {
    const { host, web } = shore();
    web.results = web.results.map((result, i): WebResult => ({ ...result, content: `Page ${i} begins. ${"The tide turns and turns again. ".repeat(900)}` }));
    // A page with room for two of the long pages, not three.
    const rig = await toolRig(host, SOURCES, { settings: (s) => (s.tools.pageChars = 4000) });
    const out = await rig.run("web_search", { query: "spring tides", pages: true });
    expect(out.text.length).toBeLessThanOrEqual(rig.settings.tools.pageChars);
    for (const result of web.results) expect(out.text).toContain(result.url);
    expect(out.text).toContain("The page says: Page 0 begins.");
    expect(out.text).not.toContain("Page 2 begins.");
  });
});

describe("what the user hasn't set up", () => {
  test("a tool is not offered where the host lacks its port", async () => {
    const { host } = shore();
    expect((await toolRig(host, SOURCES)).offered()).toEqual(NAMES);
    const ports = host.recall;
    delete ports?.memory;
    expect((await toolRig(host, SOURCES, { runId: "r2", ready: true })).offered()).toEqual(NAMES.slice(3));
    delete ports?.databanks;
    expect((await toolRig(host, SOURCES, { runId: "r3" })).offered()).toEqual(["web_search"]);
    delete ports?.web;
    expect((await toolRig(host, SOURCES, { runId: "r4", ready: true })).offered()).toEqual([]);
    delete host.recall;
    expect((await toolRig(host, SOURCES, { runId: "r5" })).offered()).toEqual([]);
  });

  test("nor where the run read that the user has it off", async () => {
    const { host, memory, banks, web } = shore();
    expect((await toolRig(host, SOURCES, { ready: true })).offered()).toEqual(NAMES);
    memory.on = false;
    expect((await toolRig(host, SOURCES, { runId: "r2", ready: true })).offered()).toEqual(NAMES.slice(3));
    banks.banks = [];
    expect((await toolRig(host, SOURCES, { runId: "r3", ready: true })).offered()).toEqual(["web_search"]);
    web.on = false;
    expect((await toolRig(host, SOURCES, { runId: "r4", ready: true })).offered()).toEqual([]);
  });

  test("where the run didn't read it, the tool is offered and says so itself", async () => {
    const { host, memory, banks, web } = shore();
    memory.on = false;
    banks.banks = [];
    web.on = false;
    const rig = await toolRig(host, SOURCES);
    expect(rig.offered()).toEqual(NAMES);
    const off = "Lumiverse's Memory Cortex is switched off for this chat, so it holds nothing to read. chat_outline, chat_about and chat_search work from the messages themselves.";
    expect(await rig.run("memory_search", { queries: ["ledger"] })).toEqual({ text: off, error: true });
    expect(await rig.run("memory_entity", { name: "Okoro" })).toEqual({ text: off, error: true });
    expect(await rig.run("memory_arcs")).toEqual({ text: off, error: true });
    expect(memory.searches).toEqual([]);
    expect(await rig.run("databank_list")).toEqual({ text: "No databank applies to this chat." });
    expect(await rig.run("databank_search", { queries: ["tides"] })).toEqual({ text: "No databank applies to this chat." });
    expect(await rig.run("databank_read", { id: "doc-tides-0001" })).toEqual({ text: "No databank applies to this chat.", error: true });
    expect((await rig.run("web_search", { query: "tides" })).text).toBe("No web search provider is set up in Lumiverse now, so nothing was searched.");
  });

  test("only the web search works without a chat", async () => {
    const { host } = shore();
    const rig = await toolRig(host, SOURCES, { chatId: "", turn: null });
    expect(rig.offered()).toEqual(["web_search"]);
    expect((await rig.run("web_search", { query: "spring tides" })).text).toContain("3 results from the web.");
  });
});

describe("a port that fails", () => {
  test("is a tool error that says what failed and what works instead", async () => {
    const { host, memory, banks, web } = shore();
    const rig = await toolRig(host, SOURCES);
    memory.search = failing("the cortex is rebuilding");
    memory.entity = failing("the cortex is rebuilding");
    memory.arcs = failing("the cortex is rebuilding");
    const cortex = "Lumiverse's memory couldn't be read (the cortex is rebuilding). chat_outline, chat_about and chat_search work from the messages themselves.";
    expect(await rig.run("memory_search", { queries: ["ledger", "brass key"] })).toEqual({ text: cortex, error: true });
    expect(await rig.run("memory_entity", { name: "Okoro" })).toEqual({ text: cortex, error: true });
    expect(await rig.run("memory_arcs")).toEqual({ text: cortex, error: true });

    banks.content = failing("the file store is locked");
    const store = await rig.run("databank_search", { queries: ["tides"] });
    expect(store.error).toBe(true);
    expect(store.text).toBe("The databanks couldn't be read (the file store is locked). Call again once; if it fails again, go on without them: lore_search and chat_search don't rest on them.");
    expect((await rig.run("databank_read", { id: "doc-tides-0001" })).text).toBe(store.text);
    banks.documents = failing("the file store is locked");
    expect(await rig.run("databank_list")).toEqual({ text: store.text, error: true });

    web.search = failing("the provider answered 503");
    expect(await rig.run("web_search", { query: "spring tides" })).toEqual({ text: "The web search failed (the provider answered 503), so nothing was found. Call again once; if it fails again, go on from what the chat, the lore and the databanks hold.", error: true });
  });

  test("a failed read leaves the index as it was: the next call reads what is missing", async () => {
    const { host, banks } = shore();
    const rig = await toolRig(host, SOURCES);
    const content = banks.content;
    banks.content = async (id: string) => (id === "doc-nets-0003" ? failing("the file store is locked")() : content(id));
    expect((await rig.run("databank_search", { queries: ["twine"] })).error).toBe(true);
    banks.content = content;
    expect((await rig.run("databank_search", { queries: ["twine"] })).text).toContain("- [doc-nets-0003] Net mending");
    expect([...banks.reads]).toEqual([
      ["doc-tides-0001", 1],
      ["doc-trade-0002", 1],
      ["doc-nets-0003", 1],
    ]);
  });

  test("an answer that isn't the port's shape is read for what holds", async () => {
    const { host, memory, banks, web } = shore();
    const rig = await toolRig(host, SOURCES);
    memory.search = async () => [null, 4, { text: 9 }, { text: "The ledger is in the strongbox.", score: "high", span: ["a", 2], entities: "Okoro" }] as unknown as MemoryHit[];
    expect((await rig.run("memory_search", { queries: ["ledger"] })).text).toBe("“ledger”: 1 memory from Lumiverse's memory, the best first.\n- chunk · score 0.00: The ledger is in the strongbox.");
    memory.entity = async () => ({ name: 7 }) as never;
    expect((await rig.run("memory_entity", { name: "Okoro" })).text).toContain("Lumiverse's memory has no entity “Okoro”.");
    banks.documents = async (id: string) => (id === "bank-coast" ? ([null, { name: "No id" }, { id: "doc-odd-0005", name: 12, bytes: "big", status: 3 }] as never) : ("none" as never));
    const listed = await rig.run("databank_list");
    expect(listed.text).toContain("1 document found; showing 1 to 1.");
    expect(listed.text).toContain("- [doc-odd-0005] ");
    web.search = async () => [{ title: 4 }, "tides", { url: "https://pilot.example/bars", title: null, snippet: "When a bar can be crossed." }] as never;
    expect((await rig.run("web_search", { query: "bars" })).text).toContain("“bars”: 1 result from the web.\n1. ");
  });
});

test("nothing is longer than Answer length, whatever is asked and whatever is held", async () => {
  const { host, memory, banks, web } = shore();
  const long = "x".repeat(5000);
  const wordy = (word: string): string => `${word} `.repeat(Math.ceil(5000 / (word.length + 1)));
  memory.hits = Array.from({ length: 8 }, (_, i): MemoryHit => ({ source: i % 2 ? "arc" : "chunk", text: wordy("ledger"), score: 0.5, span: [i, i + 1], entities: Array.from({ length: 40 }, () => wordy("Okoro")) }));
  memory.entitiesKnown = Array.from({ length: 40 }, (_, i) => ({
    id: `ent-${i}`,
    name: `Okoro ${i} ${long}`,
    type: wordy("character"),
    aliases: [long, long],
    description: wordy("keeper"),
    status: long,
    facts: Array.from({ length: 60 }, () => wordy("fact")),
    mentions: 1e9,
    lastSeenAt: START,
    relations: Array.from({ length: 30 }, () => ({ target: long, type: long, label: long, strength: 1, sentiment: -1 })),
  }));
  memory.arcsMade = Array.from({ length: 40 }, (_, i) => ({ id: `arc-${i}`, tier: 1, title: long, summary: wordy("tide"), span: [0, 11] as [number, number], at: START }));
  banks.banks = banks.banks.map((bank) => ({ ...bank, name: `${bank.name} ${long}`, description: long, scope: "global" as const }));
  for (let i = 0; i < 30; i++) banks.add("bank-loose", `doc-long-${i}-${long}`, `Log ${long}`, `${wordy("tides")}\n${wordy("twine")}`);
  web.results = Array.from({ length: 5 }, (_, i) => ({ title: long, url: `https://pilot.example/${i}/${long}`, snippet: wordy("tide"), content: wordy("spring") }));

  const rig = await toolRig(host, SOURCES);
  const { pageChars } = rig.settings.tools;
  const queries = Array.from({ length: 12 }, (_, i) => `${i} ${wordy("ledger tides twine")}`);
  const calls: [string, Record<string, unknown>][] = [
    ["memory_search", { queries, entities: [long, long] }],
    ["memory_search", { queries: [long] }],
    ["memory_search", { query: "ledger" }],
    ["memory_entity", { name: long }],
    ["memory_entity", { name: `Okoro 0 ${long}` }],
    ["memory_entity", {}],
    ["memory_arcs", {}],
    ["memory_arcs", { cursor: long }],
    ["databank_list", {}],
    ["databank_list", { cursor: long }],
    ["databank_search", { queries }],
    ["databank_search", { queries, cursor: long }],
    ["databank_search", { queries: ["tides"] }],
    ["databank_search", { queries: [long] }],
    ["databank_read", { id: long }],
    ["databank_read", { id: "doc-long-0-", cursor: long }],
    ["databank_read", { id: `doc-long-0-${long}` }],
    ["web_search", { query: long, pages: true }],
    ["web_search", { query: wordy("tides") }],
  ];
  for (const [name, args] of calls) {
    const out = await rig.run(name, args as never);
    expect({ name, args: Object.keys(args), length: out.text.length <= pageChars }).toEqual({ name, args: Object.keys(args), length: true });
    expect(out.text.length).toBeGreaterThan(0);
  }
  // A failure's own words are clipped as an argument is.
  memory.search = failing(long);
  banks.list = failing(long);
  web.search = failing(long);
  for (const [name, args] of [
    ["memory_search", { queries }],
    ["databank_list", {}],
    ["web_search", { query: long }],
  ] as const) {
    const out = await rig.run(name, args as never);
    expect(out.error).toBe(true);
    expect(out.text.length).toBeLessThanOrEqual(pageChars);
  }
});
