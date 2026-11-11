// A story's book (DESIGN §23): a chat's LumiBooks book read as a tree with its coverage of the chat,
// and the two tools the agents read it by. Both are worked out by code: no test here scripts a model
// answer, and none is asked for. The books, the chats and every name in them are invented, in the
// forms LumiBooks keeps: its own book for a chat, a summaries lorebook it exports, and a book that
// has nothing but its labels.

import { describe, expect, test } from "bun:test";
import { type Book, type BookNode, readBook } from "../../src/core/book";
import { createHarness } from "../../src/core/harness";
import type { BookEntry, JsonObject } from "../../src/core/ports";
import { defaultSettings, type Settings } from "../../src/core/settings";
import { Texts } from "../../src/core/texts";
import type { AgentTool, ToolEnv, ToolOutcome } from "../../src/core/tools";
import { BOOK_TOOLS } from "../../src/core/tools/book";
import { chatView, loreView } from "../../src/core/views";
import { call, lumibooksHash, MemoryHost, runTurn, WRITER } from "./support/host";

const CHAT = "chat-1";

/** A world book entry's id whose first group is `short`: the id the tools show it by. */
const idOf = (short: string): string => `${short}-0000-4000-8000-000000000000`;

const LONG = `3rd Summary Chapter Containing 3 Prior Turns\n\n${"Ilse counts the boats as they come in past the quay. ".repeat(30).trim()}`;

/**
 * The book of a chat of twenty-four messages, in the order LumiBooks wrote it: a chapter every few
 * messages, an arc once two chapters stand, a volume over the arcs. Each entry: the start of its id,
 * its tier, its label, the first and last message it summarizes, and its text.
 */
const WRITTEN: readonly [short: string, tier: number, label: string, span: [number, number], text: string][] = [
  ["ch000001", 1, "#1 - A Knock at the Mill", [0, 2], "1st Summary Chapter Containing 3 Prior Turns\n\nMara knocks at the mill and finds the lamp dark."],
  ["ch000002", 1, "#2 - Who Keeps the Lamp", [3, 5], "2nd Summary Chapter Containing 3 Prior Turns\n\nJoss says Okoro kept the lamp until the flood."],
  ["arc00001", 2, "Arc #1 - The Key", [0, 5], "Arc #1 Summary Containing 2 Prior Chapters and 6 Prior Turns\n\nMara learns the lamp went dark with the flood, and that Ilse holds the key."],
  ["ch000003", 1, "#3 - The Boats Come In", [6, 8], LONG],
  ["ch000004", 1, "#4 - Brann's Nets", [9, 11], "4th Summary Chapter Containing 3 Prior Turns\n\nBrann mends nets by the quay and will not speak of Okoro."],
  ["arc00002", 2, "Arc #2 - The Flood", [6, 11], "Arc #2 Summary Containing 2 Prior Chapters and 6 Prior Turns\n\nIlse and Brann each tell half of what the flood took."],
  ["vol00001", 3, "Vol #1 - The Dark Lamp", [0, 11], "1st Summary VOLUME Containing 2 Prior Arcs and 12 Prior Turns\n\nMara comes to the mill, finds the lamp dark, and pieces the flood together from Joss, Ilse and Brann."],
  ["ch000005", 1, "#5 - The Key Changes Hands", [12, 14], "5th Summary Chapter Containing 3 Prior Turns\n\nIlse gives Mara the key to the lamp room."],
  ["ch000006", 1, "#6 - Up the Stair", [15, 17], "6th Summary Chapter Containing 3 Prior Turns\n\nMara and Joss climb to the lamp room."],
  ["arc00003", 2, "Arc #3 - The Lamp Room", [12, 17], "Arc #3 Summary Containing 2 Prior Chapters and 6 Prior Turns\n\nWith Ilse's key, Mara and Joss reach the lamp room."],
  ["vol00002", 3, "Vol #2 - The Climb", [12, 17], "2nd Summary VOLUME Containing 1 Prior Arc and 6 Prior Turns\n\nThe key changes hands and the lamp room is opened."],
  ["ch000007", 1, "#7 - Oil and Wick", [18, 19], "7th Summary Chapter Containing 2 Prior Turns\n\nOkoro's oil is still in the can."],
];

/** An entry as LumiBooks keeps it in its own book for a chat: the chat, the messages it summarizes by id, where they stood, and its label with them counted from 1. */
function own(ids: readonly string[], [short, tier, label, [from, to], text]: (typeof WRITTEN)[number]): BookEntry {
  return { id: idOf(short), comment: `${label} (msgs ${from + 1}-${to + 1})`, content: text, extensions: { lumibooks: { chatId: CHAT, tier, msgIds: ids.slice(from, to + 1), firstMsgIdx: from, lastMsgIdx: to, title: label.replace(/^.*? - /, "") } } };
}

/** Entries that are no part of the tree: one LumiBooks let go of, which keeps none of its marks; one with no text; and one it wrote for another chat. */
const LOOSE: BookEntry[] = [
  { id: idOf("loose001"), comment: "[orphaned] #9 - A Page Torn Out", content: "Brann burned it.", extensions: {} },
  { id: idOf("blank001"), comment: "#8 - Nothing Yet", content: "  ", extensions: { lumibooks: { chatId: CHAT, tier: 1, msgIds: [], firstMsgIdx: 20, lastMsgIdx: 21 } } },
  { id: idOf("other001"), comment: "#1 - Another Shore (msgs 21-22)", content: "Ilse sails for the far shore.", extensions: { lumibooks: { chatId: "chat-9", tier: 1, msgIds: [], firstMsgIdx: 20, lastMsgIdx: 21 } } },
];

/** What the tools read of an entry's text: its length. */
function chars(short: string): number {
  const text = WRITTEN.find((entry) => entry[0] === short)?.[4];
  if (text === undefined) throw new Error(`no entry ${short}`);
  return text.length;
}

/** A chat of `messages` messages with the book above, as far as the chat reaches; with `kept`, the book also keeps LumiBooks' hash of every message it summarized, as they stand now. */
async function rig(options: { messages?: number; kept?: boolean } = {}) {
  const host = new MemoryHost();
  const ids: string[] = [];
  const roles = ["user", "assistant"] as const;
  const said = (i: number): string => `Message ${i}: the lamp at the mill burns ${i % 3 === 0 ? "low" : "bright"}.`;
  for (let i = 0; i < (options.messages ?? 24); i++) ids.push(host.say(CHAT, roles[i % 2] ?? "user", said(i)));
  const kept: { index: number; hash: string }[] = [];
  if (options.kept) for (let i = 0; i < Math.min(20, ids.length); i++) kept.push({ index: i, hash: await lumibooksHash(roles[i % 2] ?? "user", said(i)) });
  host.storyBooks.set(CHAT, { entries: [...WRITTEN.map((entry) => own(ids, entry)), ...LOOSE], kept });
  return { host, ids };
}

/** A book the test is sure is there. */
async function bookOf(host: MemoryHost): Promise<Book> {
  const book = await readBook(host, CHAT);
  if (!book) throw new Error("the chat has no book");
  return book;
}

/** A tree as a test compares it: each entry's short id, what it is, its title, the messages it spans, and the entries under it. */
const shape = (node: BookNode): unknown => [node.short, node.level, node.title, node.span, node.children.map(shape)];

/** The book tools as one run builds them, over `book` (none: a chat without one). */
async function toolsOf(host: MemoryHost, book: Book | null, change: (s: Settings) => void = () => undefined) {
  const settings = defaultSettings();
  change(settings);
  const env: ToolEnv = {
    host,
    run: { id: "run-1", kind: "new", chatId: CHAT },
    settings,
    texts: new Texts(),
    agent: "main",
    depth: 0,
    chat: chatView(host, CHAT, await host.chat.path(CHAT), settings.tools),
    lore: loreView(host, { chatId: CHAT, generationId: "gen-1" }, settings.tools),
    past: [],
    ...(book ? { book } : {}),
  };
  const built = new Map(BOOK_TOOLS.flatMap((d) => d.build(env) ?? []).map((t): [string, AgentTool] => [t.name, t]));
  const run = (name: string, args: JsonObject = {}): Promise<ToolOutcome> => {
    const tool = built.get(name);
    if (!tool) throw new Error(`no tool ${name}`);
    return tool.run(args, { signal: new AbortController().signal, agentId: "agent_test", role: "main", callId: "c1" });
  };
  return { built, run };
}

/** The cursor an answer ends with, or null when it has none. */
const cursorOf = (text: string): string | null => /cursor "([^"]+)"\.\]$/.exec(text)?.[1] ?? null;

/** Every page of a tool's answer to `args`, read by following each page's cursor. */
async function pages(run: (name: string, args?: JsonObject) => Promise<ToolOutcome>, name: string, args: JsonObject): Promise<string[]> {
  const out: string[] = [];
  let cursor: string | null = null;
  do {
    const page: ToolOutcome = await run(name, cursor === null ? args : { ...args, cursor });
    expect(page.error).toBeUndefined();
    out.push(page.text);
    cursor = cursorOf(page.text);
  } while (cursor !== null && out.length < 100);
  return out;
}

describe("the tree", () => {
  test("comes out in the chat's order, each entry under the one that sums it up, with the messages it spans", async () => {
    const r = await rig();
    const book = await bookOf(r.host);
    expect(book.nodes.map(shape)).toEqual([
      [
        "vol00001",
        "volume",
        "Vol #1 - The Dark Lamp",
        [0, 11],
        [
          ["arc00001", "arc", "Arc #1 - The Key", [0, 5], [["ch000001", "chapter", "#1 - A Knock at the Mill", [0, 2], []], ["ch000002", "chapter", "#2 - Who Keeps the Lamp", [3, 5], []]]],
          ["arc00002", "arc", "Arc #2 - The Flood", [6, 11], [["ch000003", "chapter", "#3 - The Boats Come In", [6, 8], []], ["ch000004", "chapter", "#4 - Brann's Nets", [9, 11], []]]],
        ],
      ],
      // A volume and its one arc span the same messages: the arc is under the volume, and its chapters under the arc.
      ["vol00002", "volume", "Vol #2 - The Climb", [12, 17], [["arc00003", "arc", "Arc #3 - The Lamp Room", [12, 17], [["ch000005", "chapter", "#5 - The Key Changes Hands", [12, 14], []], ["ch000006", "chapter", "#6 - Up the Stair", [15, 17], []]]]]],
      // The latest chapter isn't in an arc yet: it stands at the top.
      ["ch000007", "chapter", "#7 - Oil and Wick", [18, 19], []],
    ]);
    // Each entry is read by its id, and is as long as its text.
    const volume = book.nodes[0];
    expect(volume?.id).toBe(idOf("vol00001"));
    expect(volume?.chars).toBe(chars("vol00001"));
    expect(book.contents.get(idOf("ch000003"))).toBe(LONG);
    // What is no part of the tree isn't in the book.
    expect([...book.contents.keys()].sort()).toEqual(WRITTEN.map((entry) => idOf(entry[0])).sort());
  });

  test("an entry spans its messages where they stand now: a message deleted before them moves them", async () => {
    const r = await rig();
    r.host.remove(CHAT, r.ids[1] ?? "");
    const book = await bookOf(r.host);
    const arc = book.nodes[0]?.children[0];
    expect([book.nodes[0]?.span, arc?.span, arc?.children.map((c) => c.span)]).toEqual([[0, 10], [0, 4], [[0, 1], [2, 4]]]);
    expect(book.nodes.at(-1)?.span).toEqual([17, 18]);
    expect(book.coverage).toEqual({ messages: 23, covered: 19, uncovered: { count: 4, runs: [[19, 22]] }, changed: null });
  });

  test("an entry carried over from another chat leads the tree and spans none of this chat's messages", async () => {
    const r = await rig();
    const stored = r.host.storyBooks.get(CHAT);
    // LumiBooks numbers what it carried over downwards from -1, and keeps the ids of the other chat's messages on it.
    stored?.entries.push(
      { id: idOf("root0002"), comment: "[Root] #9 - The Night Before", content: "Joss locks the mill for the night.", extensions: { lumibooks: { tier: 1, isRoot: true, msgIds: ["elsewhere-3"], firstMsgIdx: -1, lastMsgIdx: -1 } } },
      { id: idOf("root0001"), comment: "[Root] Arc #1 - Before the Quay", content: "Mara walks the coast road to the mill.", extensions: { lumibooks: { tier: 2, isRoot: true, msgIds: ["elsewhere-1", "elsewhere-2"], firstMsgIdx: -2, lastMsgIdx: -2 } } },
    );
    const book = await bookOf(r.host);
    expect(book.nodes.slice(0, 3).map(shape)).toEqual([["root0001", "arc", "[Root] Arc #1 - Before the Quay", null, []], ["root0002", "chapter", "[Root] #9 - The Night Before", null, []], expect.arrayContaining(["vol00001"])]);
    expect(book.coverage).toEqual({ messages: 24, covered: 20, uncovered: { count: 4, runs: [[20, 23]] }, changed: null });
    const t = await toolsOf(r.host, book);
    expect((await t.run("book_outline")).text).toContain("\n- [root0001] arc: [Root] Arc #1 - Before the Quay · from before this chat · 38 characters\n");
  });
});

describe("the coverage", () => {
  test("finds the messages no chapter covers, and can't tell a change in a book that keeps no hashes", async () => {
    const r = await rig();
    expect((await bookOf(r.host)).coverage).toEqual({ messages: 24, covered: 20, uncovered: { count: 4, runs: [[20, 23]] }, changed: null });
  });

  test("finds the messages that changed since they were summarized, by the hashes LumiBooks kept", async () => {
    const r = await rig({ kept: true });
    expect((await bookOf(r.host)).coverage).toEqual({ messages: 24, covered: 20, uncovered: { count: 4, runs: [[20, 23]] }, changed: { count: 0, runs: [] } });
    r.host.edit(CHAT, r.ids[4] ?? "", "Message 4: the lamp at the mill is out.");
    r.host.edit(CHAT, r.ids[13] ?? "", "Message 13: Ilse keeps the key after all.");
    r.host.edit(CHAT, r.ids[14] ?? "", "Message 14: Mara goes home without it.");
    // A changed message is still one a chapter covers: it is the chapter that is out of date.
    expect((await bookOf(r.host)).coverage).toEqual({ messages: 24, covered: 20, uncovered: { count: 4, runs: [[20, 23]] }, changed: { count: 3, runs: [[4, 4], [13, 14]] } });
  });

  test("says so of a chat the book covers to its last message", async () => {
    const r = await rig({ messages: 20, kept: true });
    expect((await bookOf(r.host)).coverage).toEqual({ messages: 20, covered: 20, uncovered: { count: 0, runs: [] }, changed: { count: 0, runs: [] } });
  });

  test("reads a summaries lorebook, which names its messages by their places and keeps a hash of each", async () => {
    const host = new MemoryHost();
    const said = ["The wheel at the mill stands still.", "Mara asks Joss why.", "Joss says the race is choked with flood wood.", "Mara fetches a pole from the loft.", "Brann wades in to help.", "The wheel turns a quarter and stops.", "Ilse brings oil for the night.", "Mara lights the lamp."];
    const ids = said.map((text, i) => host.say(CHAT, i % 2 === 0 ? "assistant" : "user", text));
    const kept = await Promise.all(said.slice(0, 7).map(async (text, i) => ({ index: i, hash: await lumibooksHash(i % 2 === 0 ? "assistant" : "user", text) })));
    host.storyBooks.set(CHAT, {
      kept,
      entries: [
        { id: "0", comment: "Vol #1 - The Still Wheel (msgs 1-4)", content: "Flood wood has stopped the mill wheel, and Mara sets about clearing it.", extensions: { lumibooks_summary: { tier: 3, messageIndices: [0, 1, 2, 3] } } },
        { id: "1", comment: "Arc #2 - Clearing the Race (msgs 5-6)", content: "Brann helps, and the wheel moves a little.", extensions: { lumibooks_summary: { tier: 2, messageIndices: [4, 5] } } },
        { id: "2", comment: "#5 - Oil for the Night (msgs 7-7)", content: "Ilse brings lamp oil.", extensions: { lumibooks_summary: { tier: 1, messageIndices: [6] } } },
      ],
    });
    const before = await bookOf(host);
    expect(before.nodes.map(shape)).toEqual([["0", "volume", "Vol #1 - The Still Wheel", [0, 3], []], ["1", "arc", "Arc #2 - Clearing the Race", [4, 5], []], ["2", "chapter", "#5 - Oil for the Night", [6, 6], []]]);
    expect(before.coverage).toEqual({ messages: 8, covered: 7, uncovered: { count: 1, runs: [[7, 7]] }, changed: { count: 0, runs: [] } });
    host.edit(CHAT, ids[2] ?? "", "Joss says the sluice gate has rusted shut.");
    host.edit(CHAT, ids[5] ?? "", "The wheel does not move at all.");
    expect((await bookOf(host)).coverage).toEqual({ messages: 8, covered: 7, uncovered: { count: 1, runs: [[7, 7]] }, changed: { count: 2, runs: [[2, 2], [5, 5]] } });
  });

  test("reads a book that keeps nothing but its labels by what they open with and the messages they count", async () => {
    const host = new MemoryHost();
    for (let i = 0; i < 8; i++) host.say(CHAT, i % 2 === 0 ? "user" : "assistant", `Message ${i}.`);
    const entry = (id: string, comment: string): BookEntry => ({ id, comment, content: `What ${comment} holds.`, extensions: {} });
    host.storyBooks.set(CHAT, { kept: [], entries: [entry("d", "#3 - The Coast Road (msgs 5-6)"), entry("b", "#1 - The Boat (msgs 1-2)"), entry("a", "Arc #1 - The Tide Comes In (msgs 1-4)"), entry("c", "#2 - The Net Loft (msgs 3-4)"), entry("e", "Notes for Brann")] });
    const book = await bookOf(host);
    expect(book.nodes.map(shape)).toEqual([["a", "arc", "Arc #1 - The Tide Comes In", [0, 3], [["b", "chapter", "#1 - The Boat", [0, 1], []], ["c", "chapter", "#2 - The Net Loft", [2, 3], []]]], ["d", "chapter", "#3 - The Coast Road", [4, 5], []]]);
    expect(book.coverage).toEqual({ messages: 8, covered: 6, uncovered: { count: 2, runs: [[6, 7]] }, changed: null });
  });
});

describe("readBook", () => {
  test("gives no book where there is none to read, and the run goes on", async () => {
    const r = await rig();
    // A run about no chat, a chat without a book, and a book with nothing in it yet.
    expect(await readBook(r.host, "")).toBeNull();
    expect(await readBook(r.host, "chat-2")).toBeNull();
    r.host.storyBooks.set("chat-3", { entries: LOOSE, kept: [] });
    expect(await readBook(r.host, "chat-3")).toBeNull();
    expect(r.host.logs).toEqual([]);
    // A port that fails: a warning, and no book.
    r.host.book = { read: () => Promise.reject(new Error("the link is down")) };
    expect(await readBook(r.host, CHAT)).toBeNull();
    expect(r.host.logs).toEqual([{ level: "warn", message: "[LumiAH] the LumiBooks book of chat chat-1 couldn't be read (the link is down): the run goes on without it" }]);
    // A host without the port.
    r.host.book = undefined;
    expect(await readBook(r.host, CHAT)).toBeNull();
  });
});

describe("the book tools", () => {
  test("are offered only where the chat has a book, as read tools of the book family", async () => {
    const r = await rig();
    expect([...(await toolsOf(r.host, null)).built.keys()]).toEqual([]);
    const t = await toolsOf(r.host, await bookOf(r.host));
    expect([...t.built.keys()]).toEqual(["book_outline", "book_read"]);
    expect(BOOK_TOOLS.map((d) => [d.name, d.family, d.tier])).toEqual([["book_outline", "book", "read"], ["book_read", "book", "read"]]);
    for (const tool of t.built.values()) {
      expect(tool.description).toContain("LumiBooks");
      expect(tool.description).toContain("chat_read");
      expect(tool.parameters.type).toBe("object");
      for (const arg of Object.values(tool.parameters.properties as Record<string, { description: string }>)) expect(arg.description.length).toBeGreaterThan(10);
    }
  });

  test("book_outline leads with the coverage, lists the tree one line an entry, and pages to the end by cursor", async () => {
    const r = await rig();
    const t = await toolsOf(r.host, await bookOf(r.host), (s) => (s.tools.pageItems = 5));
    const all = await pages(t.run, "book_outline", {});
    expect(all).toHaveLength(3);
    expect(all[0]).toBe(
      [
        "Coverage: the book covers 20 of this chat's 24 messages. No chapter covers 4 messages (#20 to #23), so the book is silent there. The book keeps no hash of the messages it summarized, so it can't tell whether any changed since.",
        "12 entries found; showing 1 to 5.",
        `- [vol00001] volume: Vol #1 - The Dark Lamp · #0 to #11 · ${chars("vol00001")} characters`,
        `  - [arc00001] arc: Arc #1 - The Key · #0 to #5 · ${chars("arc00001")} characters`,
        `    - [ch000001] chapter: #1 - A Knock at the Mill · #0 to #2 · ${chars("ch000001")} characters`,
        `    - [ch000002] chapter: #2 - Who Keeps the Lamp · #3 to #5 · ${chars("ch000002")} characters`,
        `  - [arc00002] arc: Arc #2 - The Flood · #6 to #11 · ${chars("arc00002")} characters`,
        '[There is more: call book_outline again with the same arguments and cursor "5".]',
      ].join("\n"),
    );
    // The coverage is said once, where the outline starts.
    expect(all[1]).toStartWith(`12 entries found; showing 6 to 10.\n    - [ch000003] chapter: #3 - The Boats Come In · #6 to #8 · ${LONG.length} characters\n`);
    expect(all[2]).toBe([`12 entries found; showing 11 to 12.`, `    - [ch000006] chapter: #6 - Up the Stair · #15 to #17 · ${chars("ch000006")} characters`, `- [ch000007] chapter: #7 - Oil and Wick · #18 to #19 · ${chars("ch000007")} characters`, "[That is the end.]"].join("\n"));
    const listed = all.flatMap((page) => [...page.matchAll(/^ *- \[(\w+)\]/gm)].map((m) => m[1]));
    expect(listed).toEqual(["vol00001", "arc00001", "ch000001", "ch000002", "arc00002", "ch000003", "ch000004", "vol00002", "arc00003", "ch000005", "ch000006", "ch000007"]);
  });

  test("book_outline says what changed since it was summarized, as runs of message numbers with how many there are", async () => {
    const r = await rig({ kept: true });
    for (const i of [4, 13, 14]) r.host.edit(CHAT, r.ids[i] ?? "", `Message ${i}, told another way.`);
    const t = await toolsOf(r.host, await bookOf(r.host));
    expect((await t.run("book_outline")).text).toStartWith("Coverage: the book covers 20 of this chat's 24 messages. No chapter covers 4 messages (#20 to #23), so the book is silent there. 3 messages changed since being summarized (#4, #13 to #14), so the book is out of date there.\n12 entries found; showing 1 to 10.\n");
    const whole = await rig({ messages: 20, kept: true });
    expect((await (await toolsOf(whole.host, await bookOf(whole.host))).run("book_outline")).text).toStartWith("Coverage: the book covers 20 of this chat's 20 messages. No message is without a chapter. None changed since being summarized.\n");
  });

  test("book_outline with an entry lists the entries under it alone", async () => {
    const r = await rig();
    const t = await toolsOf(r.host, await bookOf(r.host));
    expect(await t.run("book_outline", { entry: "vol00001" })).toEqual({
      text: ["[vol00001] volume: Vol #1 - The Dark Lamp · #0 to #11. The entries under it:", "2 entries found; showing 1 to 2.", `- [arc00001] arc: Arc #1 - The Key · #0 to #5 · ${chars("arc00001")} characters`, `- [arc00002] arc: Arc #2 - The Flood · #6 to #11 · ${chars("arc00002")} characters`].join("\n"),
    });
    // By the id whole, or as the outline writes it, brackets and all.
    expect((await t.run("book_outline", { entry: idOf("arc00003") })).text).toStartWith("[arc00003] arc: Arc #3 - The Lamp Room · #12 to #17. The entries under it:\n2 entries found; showing 1 to 2.\n- [ch000005] chapter:");
    expect(await t.run("book_outline", { entry: "[ch000007]" })).toEqual({ text: "[ch000007] chapter: #7 - Oil and Wick · #18 to #19. No entry is under it: book_read with entry ch000007 reads its text." });
    expect(await t.run("book_outline", { entry: "arc9" })).toEqual({ text: "There's no entry arc9 in this chat's book. book_outline without entry lists its entries, each with the id to give.", error: true });
  });

  test("book_read gives an entry's text under its heading, a long one a page at a time", async () => {
    const r = await rig();
    const book = await bookOf(r.host);
    const t = await toolsOf(r.host, book);
    expect(await t.run("book_read", { entry: "ch000001" })).toEqual({ text: `[ch000001] chapter: #1 - A Knock at the Mill · #0 to #2 · characters 0 to ${chars("ch000001")} of ${chars("ch000001")}:\n1st Summary Chapter Containing 3 Prior Turns\n\nMara knocks at the mill and finds the lamp dark.` });
    expect(await t.run("book_read", { entry: idOf("ch000001") })).toEqual(await t.run("book_read", { entry: "ch000001" }));
    const small = await toolsOf(r.host, book, (s) => (s.tools.pageChars = 600));
    const all = await pages(small.run, "book_read", { entry: "ch000003" });
    expect(all.length).toBeGreaterThan(2);
    expect(all[0]).toStartWith("[ch000003] chapter: #3 - The Boats Come In · #6 to #8 · characters 0 to ");
    expect(all.at(-1)).toEndWith("[That is the end.]");
    for (const page of all) expect(page.length).toBeLessThanOrEqual(600);
    expect(all.map((page) => page.split("\n").slice(1).join("\n").replace(/\n\[(There is more|That is the end)[^\]]*\]$/, "")).join("")).toBe(LONG);
  });

  test("book_read refuses an id that names no entry, in words that point to book_outline", async () => {
    const r = await rig();
    const t = await toolsOf(r.host, await bookOf(r.host));
    expect(await t.run("book_read", { entry: "ch000099" })).toEqual({ text: "There's no entry ch000099 in this chat's book. book_outline without entry lists its entries, each with the id to give.", error: true });
    // The start of an id that several entries share names none of them.
    expect((await t.run("book_read", { entry: "ch0000" })).error).toBe(true);
    expect(await t.run("book_read")).toEqual({ text: "book_read needs entry: The entry's id, as book_outline gives it. Call it again with entry.", error: true });
    expect(await t.run("book_read", { entry: "ch000001", cursor: "page two" })).toEqual({ text: "“page two” isn't a cursor book_read gave. Pass the cursor exactly as the last answer wrote it, or leave it out to start at the beginning.", error: true });
  });

  test("answer within Answer length, whatever they are asked and whatever the book holds", async () => {
    // A chat whose book covers every third message, under labels far longer than a line, and every message it covers has changed since: the coverage has forty runs to list of each kind.
    const host = new MemoryHost();
    const ids: string[] = [];
    for (let i = 0; i < 120; i++) ids.push(host.say(CHAT, i % 2 === 0 ? "user" : "assistant", `Message ${i}.`));
    const title = "Okoro trims the lamp while Ilse counts the boats coming in. ".repeat(40);
    const entries = ids.flatMap((id, i): BookEntry[] => (i % 3 === 0 ? [{ id: idOf(`ch${String(i).padStart(6, "0")}`), comment: `#${i / 3 + 1} - ${title}(msgs ${i + 1}-${i + 1})`, content: `Chapter ${i / 3 + 1}. ${"The tide runs out. ".repeat(i === 0 ? 100 : 2)}`, extensions: { lumibooks: { tier: 1, msgIds: [id], firstMsgIdx: i, lastMsgIdx: i } } }] : []));
    entries.push({ id: idOf("arc00001"), comment: `Arc #1 - ${title}(msgs 1-60)`, content: "The first sixty messages.", extensions: { lumibooks: { tier: 2, msgIds: ids.filter((_, i) => i < 60 && i % 3 === 0), firstMsgIdx: 0, lastMsgIdx: 59 } } });
    host.storyBooks.set(CHAT, { entries, kept: ids.flatMap((_, i) => (i % 3 === 0 ? [{ index: i, hash: "0".repeat(64) }] : [])) });
    const t = await toolsOf(host, await bookOf(host), (s) => (s.tools = { ...s.tools, pageChars: 600, pageItems: 50 }));
    // Each list of runs is clipped to what fits, after how many messages it holds in all, and neither is lost to the other.
    const [coverage = ""] = (await t.run("book_outline")).text.split("\n");
    expect(coverage).toStartWith("Coverage: the book covers 40 of this chat's 120 messages. No chapter covers 80 messages (#1 to #2, #4 to #5, ");
    expect(coverage).toContain("…), so the book is silent there. 40 messages changed since being summarized (#0, #3, #6, ");
    expect(coverage).toEndWith("…), so the book is out of date there.");
    expect(coverage.length).toBeLessThanOrEqual(300);
    const huge = "x".repeat(5000);
    const asks: [string, JsonObject][] = [
      ["book_outline", {}],
      ["book_outline", { entry: "arc00001" }],
      ["book_outline", { entry: "ch000000" }],
      ["book_outline", { entry: huge }],
      ["book_outline", { cursor: huge }],
      ["book_outline", { cursor: [huge] }],
      ["book_outline", { cursor: "9999" }],
      ["book_read", { entry: "ch000000" }],
      ["book_read", { entry: "arc00001" }],
      ["book_read", { entry: huge }],
      ["book_read", { entry: "ch000000", cursor: huge }],
      ["book_read", {}],
    ];
    for (const [name, args] of asks) {
      let cursor: string | null = null;
      let read = 0;
      do {
        const page: ToolOutcome = await t.run(name, cursor === null ? args : { ...args, cursor });
        expect({ name, args: Object.keys(args), length: page.text.length <= 600 }).toEqual({ name, args: Object.keys(args), length: true });
        cursor = cursorOf(page.text);
      } while (cursor !== null && ++read < 200);
      expect(read).toBeLessThan(200);
    }
    // Paged so, the outline still lists every entry once.
    const listed = (await pages(t.run, "book_outline", {})).flatMap((page) => [...page.matchAll(/^ *- \[(\w+)\]/gm)].map((m) => m[1]));
    expect(listed).toHaveLength(41);
    expect(new Set(listed).size).toBe(41);
  });
});

describe("a whole turn", () => {
  test("offers the book tools to an agent whose tools name them where the chat has a book, and to none where it has none", async () => {
    const r = await rig();
    r.host.say(CHAT, "user", "I climb to the lamp room.");
    r.host.say("chat-2", "user", "Is anyone at the mill?");
    const stored: { values: Settings; texts: Record<string, string> } = { values: defaultSettings(), texts: {} };
    stored.values.agents.writer!.connectionId = WRITER;
    const harness = createHarness(r.host, { settings: async () => structuredClone(stored) });
    r.host.script = [
      { toolCalls: [call("book_outline", {}, "c1")] },
      { toolCalls: [call("write_reply", { brief: "The book ends at message 19: the last five are not in it." }, "c2")] },
      "The lamp room is cold, and the wick is dry.",
      { toolCalls: [call("write_reply", { brief: "Nobody has answered yet." }, "c3")] },
      "Only the wheel answers.",
      { toolCalls: [call("write_reply", { brief: "Keep it short." }, "c4")] },
      "The stair creaks.",
    ];
    const offered = (n: number): string[] => r.host.calls[n]?.tools?.map((t) => t.name) ?? [];
    expect((await runTurn(r.host, harness, CHAT)).result.status).toBe("done");
    // The main agent's default tools name them, and the chat has a book: they are offered beside the chat's own tools.
    expect(offered(0).slice(0, 6)).toEqual(["chat_search", "chat_grep", "chat_read", "book_outline", "book_read", "lore_index"]);
    // The call ran over the chat's book as the run read it: its answer is what the main agent's next call was sent.
    const answer = r.host.calls[1]?.messages.at(-1)?.parts?.[0];
    expect(answer?.type === "tool_result" ? answer.content : "").toStartWith("Coverage: the book covers 20 of this chat's 25 messages. No chapter covers 5 messages (#20 to #24), so the book is silent there.");
    // The writer has no tools.
    expect(offered(2)).toEqual([]);
    // A chat without a book: the same agent is offered neither.
    expect((await runTurn(r.host, harness, "chat-2")).result.status).toBe("done");
    expect(offered(3)).toContain("chat_read");
    expect(offered(3).filter((name) => name.startsWith("book_"))).toEqual([]);
    // An agent whose tools don't name them isn't offered them, whatever the chat has.
    stored.values.agents.main!.tools = ["chat_read", "write_reply"];
    expect((await runTurn(r.host, harness, CHAT)).result.status).toBe("done");
    expect(offered(5)).toEqual(["chat_read", "write_reply", "scratch_read"]);
  });
});
