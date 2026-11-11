// chat_outline (DESIGN §24.4) from where an agent stands: the story as a table of contents, read
// from the chat's book where it has one, else from the arcs of Lumiverse's memory, else worked out
// from the messages themselves; a part opened into its smaller parts with from and to; and an
// outline that covers the whole range it was asked for, whatever its source leaves out.

import { describe, expect, test } from "bun:test";
import { type Book, readBook } from "../../src/core/book";
import type { BookEntry, ChatRole, JsonObject } from "../../src/core/ports";
import { stretchesOf } from "../../src/core/recall/outline";
import { CHAT_TOOLS } from "../../src/core/tools/chat";
import { CHAT, DAY, FakeMemory, harbour, pages, RecallHost, type Rig, START, toolRig } from "./recall-support";

const NEXT = "[Give from and to of a part to open it into its smaller parts. chat_read reads its messages; chat_about traces a name through them.]";
const LEAF = "[That part has no smaller parts: chat_read reads its messages.]";
const FROM_BOOK = "The story's outline, from the chat's book; messages no chapter covers are outlined from the chat itself.";
const FROM_ARCS = "The story's outline, from the arcs of Lumiverse's memory; messages no arc covers are outlined from the chat itself.";
const FROM_CHAT = "The story's outline, worked out from the chat itself (it has no book and no arcs): a part ends at a long gap in time, or when it is long enough.";

const rigOf = (host: RecallHost, options: Parameters<typeof toolRig>[2] = {}): Promise<Rig> => toolRig(host, CHAT_TOOLS, options);

/** chat_outline's answer, which a test expects not to be an error, as its lines. */
async function outline(rig: Rig, args: JsonObject = {}): Promise<string[]> {
  const out = await rig.run("chat_outline", args);
  if (out.error) throw new Error(`chat_outline failed: ${out.text}`);
  return out.text.split("\n");
}

/** The messages each part of an outline spans, as its lines say: "- #3 to #40 · …", or "- #52 · …" for one. */
function spans(lines: readonly string[]): [from: number, to: number][] {
  return lines.flatMap((line): [number, number][] => {
    const m = /^- #(\d+)(?: to #(\d+))? · /.exec(line);
    return m ? [[Number(m[1]), Number(m[2] ?? m[1])]] : [];
  });
}

/** A chat of `count` messages, Mara and Joss by turns; `at` says when each was sent (left out: a minute apart). */
function chatOf(count: number, at: (i: number) => number = (i) => START + i * 60_000, host = new RecallHost()): RecallHost {
  for (let i = 0; i < count; i++) host.sayAt(CHAT, i % 2 === 0 ? "user" : "assistant", said(i), at(i));
  return host;
}

/** What message `i` of such a chat says. */
const said = (i: number): string => `Watch ${i}: ${i % 2 === 0 ? "Mara" : "Joss"} trims the lamp at the mill.`;

/** How long its messages `from` to `to` are together, as a part's line counts them. */
const chars = (from: number, to: number): number => Array.from({ length: to - from + 1 }, (_, k) => said(from + k).length).reduce((sum, n) => sum + n, 0);

describe("chat_outline from the chat's book", () => {
  /** A world book entry's id whose first group is `short`: the id the tools show it by. */
  const idOf = (short: string): string => `${short}-0000-4000-8000-000000000000`;

  /**
   * The book of a chat of twenty-four messages, as LumiBooks wrote it: seven chapters, two arcs over
   * the first four of them and a volume over the arcs. Each entry: the start of its id, its tier, its
   * label, and the first and the last message it summarizes. Messages 20 to 23 are in no chapter yet.
   */
  const WRITTEN: readonly [short: string, tier: number, label: string, span: [number, number]][] = [
    ["ch000001", 1, "#1 - A Knock at the Mill", [0, 2]],
    ["ch000002", 1, "#2 - Who Keeps the Lamp", [3, 5]],
    ["arc00001", 2, "Arc #1 - The Key", [0, 5]],
    ["ch000003", 1, "#3 - The Boats Come In", [6, 8]],
    ["ch000004", 1, "#4 - Brann's Nets", [9, 11]],
    ["arc00002", 2, "Arc #2 - The Flood", [6, 11]],
    ["vol00001", 3, "Vol #1 - The Dark Lamp", [0, 11]],
    ["ch000005", 1, "#5 - The Key Changes Hands", [12, 14]],
    ["ch000006", 1, "#6 - Up the Stair", [15, 17]],
    ["ch000007", 1, "#7 - Oil and Wick", [18, 19]],
  ];

  /** The chat was written over three days: a night passes before message 8, and another before message 22. */
  const sentAt = (i: number): number => START + (i >= 22 ? 2 * DAY : i >= 8 ? DAY : 0) + i * 60_000;

  async function withBook(more: BookEntry[] = []): Promise<{ host: RecallHost; book: Book }> {
    const host = chatOf(24, sentAt);
    const ids = (await host.chat.path(CHAT)).map((m) => m.id);
    const entries = WRITTEN.map(([short, tier, label, [from, to]]): BookEntry => ({ id: idOf(short), comment: `${label} (msgs ${from + 1}-${to + 1})`, content: `${label}: a summary of messages ${from} to ${to}.`, extensions: { lumibooks: { chatId: CHAT, tier, msgIds: ids.slice(from, to + 1), firstMsgIdx: from, lastMsgIdx: to } } }));
    host.storyBooks.set(CHAT, { entries: [...entries, ...more], kept: [] });
    const book = await readBook(host, CHAT);
    if (!book) throw new Error("the chat has no book");
    return { host, book };
  }

  test("lists the top of the book, and outlines the tail no chapter covers from the chat itself", async () => {
    const { host, book } = await withBook();
    const rig = await rigOf(host, { book });
    expect(await outline(rig)).toEqual([
      `${FROM_BOOK} Messages #0 to #23 (24 messages) in 6 parts:`,
      "- #0 to #11 · 2026-03-04 to 2026-03-05 · 12 messages · volume: Vol #1 - The Dark Lamp · book_read vol00001",
      "- #12 to #14 · 2026-03-05 · 3 messages · chapter: #5 - The Key Changes Hands · book_read ch000005",
      "- #15 to #17 · 2026-03-05 · 3 messages · chapter: #6 - Up the Stair · book_read ch000006",
      "- #18 to #19 · 2026-03-05 · 2 messages · chapter: #7 - Oil and Wick · book_read ch000007",
      // No chapter holds these yet: they are outlined as the chat's own stretches, which break at the night between them.
      `- #20 to #21 · 2026-03-05 · 2 messages, ${chars(20, 21)} characters · Mara (1), Joss (1) · opens: ${said(20)}`,
      `- #22 to #23 · 2026-03-06 · 2 messages, ${chars(22, 23)} characters · Mara (1), Joss (1) · opens: ${said(22)}`,
      NEXT,
    ]);
  });

  test("opens an entry into the entries under it, as far down as the book goes", async () => {
    const { host, book } = await withBook();
    const rig = await rigOf(host, { book });
    // The volume opens into its arcs.
    expect(await outline(rig, { from: 0, to: 11 })).toEqual([
      `${FROM_BOOK} Messages #0 to #11 (12 messages) in 2 parts:`,
      "- #0 to #5 · 2026-03-04 · 6 messages · arc: Arc #1 - The Key · book_read arc00001",
      "- #6 to #11 · 2026-03-04 to 2026-03-05 · 6 messages · arc: Arc #2 - The Flood · book_read arc00002",
      NEXT,
    ]);
    // An arc opens into its chapters: the volume and the arc both span the range, and the smallest is opened.
    expect(await outline(rig, { from: 0, to: 5 })).toEqual([
      `${FROM_BOOK} Messages #0 to #5 (6 messages) in 2 parts:`,
      "- #0 to #2 · 2026-03-04 · 3 messages · chapter: #1 - A Knock at the Mill · book_read ch000001",
      "- #3 to #5 · 2026-03-04 · 3 messages · chapter: #2 - Who Keeps the Lamp · book_read ch000002",
      NEXT,
    ]);
    // A chapter of one sitting has nothing smaller: its own line, and where to go from there.
    expect(await outline(rig, { from: 0, to: 2 })).toEqual([`${FROM_BOOK} Messages #0 to #2 (3 messages) in 1 part:`, "- #0 to #2 · 2026-03-04 · 3 messages · chapter: #1 - A Knock at the Mill · book_read ch000001", LEAF]);
    expect(await outline(rig, { from: 1, to: 1 })).toEqual([`${FROM_BOOK} Messages #1 (1 message) in 1 part:`, "- #0 to #2 · 2026-03-04 · 3 messages · chapter: #1 - A Knock at the Mill · book_read ch000001", LEAF]);
    // A chapter written over two sittings opens into them.
    expect(await outline(rig, { from: 6, to: 8 })).toEqual([
      `${FROM_BOOK} Messages #6 to #8 (3 messages) in 2 parts:`,
      `- #6 to #7 · 2026-03-04 · 2 messages, ${chars(6, 7)} characters · Mara (1), Joss (1) · opens: ${said(6)}`,
      `- #8 · 2026-03-05 · 1 message, ${chars(8, 8)} characters · Mara (1) · opens: ${said(8)}`,
      NEXT,
    ]);
  });

  test("covers the whole of any range: the entries inside it, and the chat's own stretches between them", async () => {
    const { host, book } = await withBook();
    const rig = await rigOf(host, { book });
    // A range that reaches across two arcs lists both, each with all it spans.
    expect(spans(await outline(rig, { from: 4, to: 7 }))).toEqual([
      [0, 5],
      [6, 11],
    ]);
    // Across the volume's end: the volume, then the chapter after it.
    expect(spans(await outline(rig, { from: 10, to: 13 }))).toEqual([
      [0, 11],
      [12, 14],
    ]);
    // Across the book's end: the last chapter, then messages no chapter covers.
    expect(await outline(rig, { from: 19, to: 21 })).toEqual([
      `${FROM_BOOK} Messages #19 to #21 (3 messages) in 2 parts:`,
      "- #18 to #19 · 2026-03-05 · 2 messages · chapter: #7 - Oil and Wick · book_read ch000007",
      `- #20 to #21 · 2026-03-05 · 2 messages, ${chars(20, 21)} characters · Mara (1), Joss (1) · opens: ${said(20)}`,
      NEXT,
    ]);
    // Past the book: the chat itself, down to a stretch that opens no further.
    expect(spans(await outline(rig, { from: 20 }))).toEqual([
      [20, 21],
      [22, 23],
    ]);
    expect(await outline(rig, { from: 22, to: 23 })).toEqual([`${FROM_BOOK} Messages #22 to #23 (2 messages) in 1 part:`, `- #22 to #23 · 2026-03-06 · 2 messages, ${chars(22, 23)} characters · Mara (1), Joss (1) · opens: ${said(22)}`, LEAF]);
    // Whatever the range, no message of it is left out.
    for (const [from, to] of [
      [0, 23],
      [2, 9],
      [5, 6],
      [11, 22],
      [17, 23],
    ] as const) {
      const listed = spans(await outline(rig, { from, to }));
      for (let i = from; i <= to; i++) expect(listed.some(([a, b]) => a <= i && i <= b)).toBe(true);
    }
  });

  test("leaves out an entry carried over from another chat, and pages a long book by cursor", async () => {
    const root: BookEntry = { id: idOf("root0001"), comment: "[Root] #1 - Before the Mill", content: "Mara came north by boat.", extensions: { lumibooks: { chatId: CHAT, tier: 1, msgIds: [], firstMsgIdx: -1, lastMsgIdx: -1, isRoot: true } } };
    const { host, book } = await withBook([root]);
    expect(book.nodes[0]?.span).toBeNull();
    const rig = await rigOf(host, { book, settings: (s) => (s.tools.pageItems = 4) });
    const read = await pages(rig, "chat_outline", {});
    expect(read).toHaveLength(2);
    expect(read.join("\n")).not.toContain("Before the Mill");
    // Every page says what the outline is of, and ends with what to call next.
    for (const page of read) {
      expect(page.startsWith(`${FROM_BOOK} Messages #0 to #23 (24 messages) in 6 parts:\n`)).toBe(true);
      expect(page.endsWith(NEXT)).toBe(true);
    }
    expect(read[0]?.split("\n").at(-2)).toBe('[There is more: call chat_outline again with the same arguments and cursor "4".]');
    expect(read[1]?.split("\n").at(-2)).toBe("[That is the end.]");
    expect(read.flatMap((page) => spans(page.split("\n")))).toEqual([
      [0, 11],
      [12, 14],
      [15, 17],
      [18, 19],
      [20, 21],
      [22, 23],
    ]);
  });

  test("cuts a reader's stretches at the top of the book, and at a chapter under it only late in a stretch", async () => {
    const { host, book } = await withBook();
    // A stretch may hold all twenty-four messages: each ends where an entry at the top of the book does.
    expect(await outline(await rigOf(host, { book }), { stretches: true })).toEqual([
      "5 stretches of at most 60 messages or 36,000 characters each:",
      `- #0 to #11 · 12 messages, ${chars(0, 11)} characters`,
      `- #12 to #14 · 3 messages, ${chars(12, 14)} characters`,
      `- #15 to #17 · 3 messages, ${chars(15, 17)} characters`,
      `- #18 to #19 · 2 messages, ${chars(18, 19)} characters`,
      // No chapter holds these: the night between them ends no stretch that isn't full.
      `- #20 to #23 · 4 messages, ${chars(20, 23)} characters`,
    ]);
    // Eight messages a stretch: the first would end inside the third chapter, and ends where the second arc begins instead.
    const small = await rigOf(host, { book, runId: "gen-small", settings: (s) => (s.recall.chronicle.stretchMessages = 8) });
    const cut = await outline(small, { stretches: true });
    expect(cut[0]).toBe("6 stretches of at most 8 messages or 36,000 characters each:");
    expect(spans(cut)).toEqual([
      [0, 5],
      [6, 11],
      [12, 14],
      [15, 17],
      [18, 19],
      [20, 23],
    ]);
    // Five: a chapter that begins at the fourth of five messages is too early to end at; one that begins at the fifth is not.
    const smaller = await rigOf(host, { book, runId: "gen-smaller", settings: (s) => (s.recall.chronicle.stretchMessages = 5) });
    expect(spans(await outline(smaller, { stretches: true })).slice(0, 3)).toEqual([
      [0, 4],
      [5, 8],
      [9, 11],
    ]);
  });
});

describe("chat_outline from the arcs of Lumiverse's memory", () => {
  /** The harbour chat with arcs over its first two sittings: a larger arc, two scenes under it (one untitled), and one the host can't place. */
  function withArcs(): { host: RecallHost; memory: FakeMemory } {
    const host = harbour();
    const memory = new FakeMemory();
    memory.arcsMade = [
      { id: "arc-nets", tier: 1, title: "At the nets", summary: "Joss knows the key.\nBrann swore it was lost with the Heron.", span: [0, 3], at: START },
      { id: "arc-lamp", tier: 1, title: null, summary: "Okoro   names what Ilse wants: the ledger, locked in the strongbox.", span: [4, 7], at: START + DAY },
      { id: "arc-key", tier: 2, title: "The key comes back", summary: "Mara brings the brass key to the harbour and learns what it opens.", span: [0, 7], at: START + DAY },
      { id: "arc-lost", tier: 1, title: "A loose end", summary: "Never placed in the chat.", span: null, at: START },
    ];
    if (!host.recall) throw new Error("the host has no recall port");
    host.recall.memory = memory;
    return { host, memory };
  }

  test("lists the largest arcs, each with how its summary opens, and the rest of the chat after them", async () => {
    const { host } = withArcs();
    const rig = await rigOf(host);
    expect(await outline(rig)).toEqual([
      `${FROM_ARCS} Messages #0 to #11 (12 messages) in 2 parts:`,
      "- #0 to #7 · 2026-03-04 to 2026-03-05 · 8 messages · arc: The key comes back · Mara brings the brass key to the harbour and learns what it opens.",
      "- #8 to #11 · 2026-03-12 · 4 messages, 280 characters · Mara (2), Joss (2) · opens: A week later, at the mill, I ask Ilse what the ledger holds.",
      NEXT,
    ]);
    // An arc opens into the arcs under it; one without a title is named by how its summary opens, on one line.
    expect(await outline(rig, { from: 0, to: 7 })).toEqual([
      `${FROM_ARCS} Messages #0 to #7 (8 messages) in 2 parts:`,
      "- #0 to #3 · 2026-03-04 · 4 messages · arc: At the nets · Joss knows the key. Brann swore it was lost with the Heron.",
      "- #4 to #7 · 2026-03-05 · 4 messages · arc: Okoro names what Ilse wants: the ledger, locked in the strongbox.",
      NEXT,
    ]);
    expect(await outline(rig, { from: 4, to: 7 })).toEqual([`${FROM_ARCS} Messages #4 to #7 (4 messages) in 1 part:`, "- #4 to #7 · 2026-03-05 · 4 messages · arc: Okoro names what Ilse wants: the ledger, locked in the strongbox.", LEAF]);
    expect((await outline(rig)).join("\n")).not.toContain("A loose end");
  });

  test("gives way to the book where the chat has one, and to the chat itself where the user has the memory off", async () => {
    const { host, memory } = withArcs();
    const ids = (await host.chat.path(CHAT)).map((m) => m.id);
    host.storyBooks.set(CHAT, { entries: [{ id: "ch000001-0000-4000-8000-000000000000", comment: "#1 - The Brass Key (msgs 1-4)", content: "Mara shows Joss the key.", extensions: { lumibooks: { chatId: CHAT, tier: 1, msgIds: ids.slice(0, 4), firstMsgIdx: 0, lastMsgIdx: 3 } } }], kept: [] });
    const book = await readBook(host, CHAT);
    if (!book) throw new Error("the chat has no book");
    const both = await outline(await rigOf(host, { book, runId: "gen-book" }));
    expect(both[0]).toBe(`${FROM_BOOK} Messages #0 to #11 (12 messages) in 3 parts:`);
    expect(both[1]).toBe("- #0 to #3 · 2026-03-04 · 4 messages · chapter: #1 - The Brass Key · book_read ch000001");
    memory.on = false;
    expect((await outline(await rigOf(host, { runId: "gen-off" })))[0]).toBe(`${FROM_CHAT} Messages #0 to #11 (12 messages) in 3 parts:`);
  });
});

describe("chat_outline worked out from the chat itself", () => {
  test("breaks at the long gaps in time, and says of each part who speaks and how it opens", async () => {
    const rig = await rigOf(harbour());
    expect(await outline(rig)).toEqual([
      `${FROM_CHAT} Messages #0 to #11 (12 messages) in 3 parts:`,
      "- #0 to #3 · 2026-03-04 · 4 messages, 312 characters · Mara (2), Joss (2) · opens: I walk down to the harbour at dusk. The brass key is heavy in my coat.",
      "- #4 to #7 · 2026-03-05 · 4 messages, 290 characters · Mara (2), Joss (2) · opens: The next morning I row out to the lighthouse to find Okoro.",
      "- #8 to #11 · 2026-03-12 · 4 messages, 280 characters · Mara (2), Joss (2) · opens: A week later, at the mill, I ask Ilse what the ledger holds.",
      NEXT,
    ]);
    // How long a gap breaks it is a setting: nine days hold the whole chat in one part, which then opens no further.
    const patient = await rigOf(harbour(), { settings: (s) => (s.recall.chat.gapMinutes = 9 * 24 * 60) });
    expect(await outline(patient)).toEqual([
      `${FROM_CHAT} Messages #0 to #11 (12 messages) in 1 part:`,
      "- #0 to #11 · 2026-03-04 to 2026-03-12 · 12 messages, 882 characters · Mara (6), Joss (6) · opens: I walk down to the harbour at dusk. The brass key is heavy in my coat.",
      LEAF,
    ]);
  });

  test("opens a part with from and to, down to one stretch", async () => {
    const rig = await rigOf(harbour());
    expect(await outline(rig, { from: 4, to: 7 })).toEqual([`${FROM_CHAT} Messages #4 to #7 (4 messages) in 1 part:`, "- #4 to #7 · 2026-03-05 · 4 messages, 290 characters · Mara (2), Joss (2) · opens: The next morning I row out to the lighthouse to find Okoro.", LEAF]);
    // A range of its own breaks where the chat does.
    expect(spans(await outline(rig, { from: 2, to: 9 }))).toEqual([
      [2, 3],
      [4, 7],
      [8, 9],
    ]);
    expect(spans(await outline(rig, { from: "[#6 00000000]" }))).toEqual([
      [6, 7],
      [8, 11],
    ]);
    expect(spans(await outline(rig, { to: 5 }))).toEqual([
      [0, 3],
      [4, 5],
    ]);
    const none = await rig.run("chat_outline", { from: 30 });
    expect(none.error).toBe(true);
    expect(none.text).toBe("No message lies between #30 and #11: this turn reads messages #0 to #11.");
    expect((await rig.run("chat_outline", { cursor: "9" })).error).toBe(true);
  });

  test("ends a part when it is long enough, where the host gives no times", async () => {
    const host = new RecallHost();
    for (let i = 0; i < 12; i++) host.say(CHAT, i % 2 === 0 ? "user" : "assistant", `Watch ${i}: the tide turns.`);
    const rig = await rigOf(host, { settings: (s) => (s.recall.chat.stretchMessages = 5) });
    expect(await outline(rig)).toEqual([
      `${FROM_CHAT} Messages #0 to #11 (12 messages) in 3 parts:`,
      "- #0 to #4 · 5 messages, 120 characters · Mara (3), Joss (2) · opens: Watch 0: the tide turns.",
      "- #5 to #9 · 5 messages, 120 characters · Joss (3), Mara (2) · opens: Watch 5: the tide turns.",
      "- #10 to #11 · 2 messages, 50 characters · Mara (1), Joss (1) · opens: Watch 10: the tide turns.",
      NEXT,
    ]);
  });

  test("names the three who speak most in a part, and shows how a long opening starts", async () => {
    const host = new RecallHost();
    const cast: [ChatRole, string][] = [["user", "Mara"], ["assistant", "Ilse"], ["assistant", "Brann"], ["assistant", "Ilse"], ["assistant", "Okoro"], ["assistant", "Ilse"], ["assistant", "Brann"], ["assistant", "Joss"], ["assistant", "Ilse"], ["assistant", "Brann"]];
    // The first message opens after blank space, over two lines, and goes on far past what a part's line shows of it.
    const lines = cast.map(([, name], i) => (i === 0 ? `  The flood came in the night,\nand took the lower street.\n\n${"Ilse counts the boats as they come in past the quay. ".repeat(20)}` : `${name} bails.`));
    cast.forEach(([role, name], i) => host.sayAt(CHAT, role, lines[i] ?? "", START + i * 60_000, name));
    const rig = await rigOf(host, { settings: (s) => (s.recall.chat.openingChars = 60) });
    const [, part] = await outline(rig);
    const total = lines.reduce((sum, line) => sum + line.length, 0);
    expect(part).toBe(`- #0 to #9 · 2026-03-04 · 10 messages, ${total} characters · Ilse (4), Brann (3), Mara (1) · opens: The flood came in the night, and took the lower…`);
  });

  test("merges more stretches than a page lists into that many parts of about equal size", async () => {
    // A hundred messages in stretches of five are twenty stretches: a page lists ten parts, each two stretches.
    const even = await rigOf(chatOf(100), { settings: (s) => (s.recall.chat.stretchMessages = 5) });
    const parts = await outline(even);
    expect(parts[0]).toBe(`${FROM_CHAT} Messages #0 to #99 (100 messages) in 10 parts:`);
    expect(spans(parts)).toEqual(Array.from({ length: 10 }, (_, k): [number, number] => [k * 10, k * 10 + 9]));
    expect(parts.at(-1)).toBe(NEXT);
    // A merged part opens into its stretches, and a stretch opens no further.
    expect(await outline(even, { from: 10, to: 19 })).toEqual([
      `${FROM_CHAT} Messages #10 to #19 (10 messages) in 2 parts:`,
      `- #10 to #14 · 2026-03-04 · 5 messages, ${chars(10, 14)} characters · Mara (3), Joss (2) · opens: ${said(10)}`,
      `- #15 to #19 · 2026-03-04 · 5 messages, ${chars(15, 19)} characters · Joss (3), Mara (2) · opens: ${said(15)}`,
      NEXT,
    ]);
    expect((await outline(even, { from: 10, to: 14 })).at(-1)).toBe(LEAF);
    // Stretches that don't divide evenly still make as many parts as a page lists, none of them far from its share, and nothing is left out.
    const uneven = await rigOf(chatOf(100), { settings: (s) => (s.recall.chat.stretchMessages = 7) });
    const listed = spans(await outline(uneven));
    expect(listed).toHaveLength(10);
    expect(listed[0]?.[0]).toBe(0);
    expect(listed.at(-1)?.[1]).toBe(99);
    listed.forEach(([from, to], i) => {
      if (i > 0) expect(from).toBe((listed[i - 1]?.[1] ?? -2) + 1);
      expect(to - from + 1).toBeGreaterThanOrEqual(7);
      expect(to - from + 1).toBeLessThanOrEqual(14);
    });
    // How many parts a page lists is Hits per page.
    const few = await rigOf(chatOf(100), {
      settings: (s) => {
        s.recall.chat.stretchMessages = 5;
        s.tools.pageItems = 4;
      },
    });
    expect(spans(await outline(few))).toEqual([
      [0, 24],
      [25, 49],
      [50, 74],
      [75, 99],
    ]);
  });

  test("stays within Answer length, and pages where its parts pass a page", async () => {
    const host = new RecallHost();
    for (let i = 0; i < 60; i++) host.sayAt(CHAT, i % 2 === 0 ? "user" : "assistant", `Watch ${i}: ${"Okoro reads the ledger of debts aloud while the tide comes in. ".repeat(6)}`, START + i * DAY);
    // Every message is a sitting of its own: sixty stretches, merged into ten parts, on a page too short for ten.
    const rig = await rigOf(host, { settings: (s) => (s.tools.pageChars = 1200) });
    const read = await pages(rig, "chat_outline", {});
    expect(read.length).toBeGreaterThan(1);
    for (const page of read) expect(page.length).toBeLessThanOrEqual(1200);
    expect(read.flatMap((page) => spans(page.split("\n")))).toEqual(Array.from({ length: 10 }, (_, k): [number, number] => [k * 6, k * 6 + 5]));
  });
});

/** A count as an answer writes it: "34,200". */
const grouped = (n: number): string => n.toLocaleString("en-US");

/** A stretch as its line says it: its first and last message, how many messages and how many characters. */
function stretchLines(lines: readonly string[]): { from: number; to: number; messages: number; chars: number }[] {
  return lines.flatMap((line) => {
    const m = /^- #(\d+)(?: to #(\d+))? · (\d+) messages?, ([\d,]+) characters$/.exec(line);
    return m ? [{ from: Number(m[1]), to: Number(m[2] ?? m[1]), messages: Number(m[3]), chars: Number((m[4] ?? "").replaceAll(",", "")) }] : [];
  });
}

describe("stretchesOf: messages cut into the stretches readers are given", () => {
  /** `count` messages numbered from 0, each `chars` long. */
  const even = (count: number, chars = 10): { index: number; chars: number }[] => Array.from({ length: count }, (_, index) => ({ index, chars }));
  const cut = (...args: Parameters<typeof stretchesOf>): [number, number][] => stretchesOf(...args).map((s): [number, number] => [s.from, s.to]);

  test("packs messages until the next would pass the most messages, or the most characters", () => {
    expect(stretchesOf(even(10), { messages: 4, chars: 1000 })).toEqual([
      { from: 0, to: 3, messages: 4, chars: 40 },
      { from: 4, to: 7, messages: 4, chars: 40 },
      { from: 8, to: 9, messages: 2, chars: 20 },
    ]);
    // Thirty-five characters hold three messages of ten; thirty hold three as well, exactly.
    expect(stretchesOf(even(7), { messages: 100, chars: 35 })).toEqual([
      { from: 0, to: 2, messages: 3, chars: 30 },
      { from: 3, to: 5, messages: 3, chars: 30 },
      { from: 6, to: 6, messages: 1, chars: 10 },
    ]);
    expect(cut(even(7), { messages: 100, chars: 30 })).toEqual([
      [0, 2],
      [3, 5],
      [6, 6],
    ]);
    expect(stretchesOf([], { messages: 4, chars: 1000 })).toEqual([]);
  });

  test("gives a message longer than a stretch may be a stretch of its own", () => {
    const messages = [10, 10, 500, 10, 10].map((chars, index) => ({ index, chars }));
    expect(stretchesOf(messages, { messages: 60, chars: 50 })).toEqual([
      { from: 0, to: 1, messages: 2, chars: 20 },
      { from: 2, to: 2, messages: 1, chars: 500 },
      { from: 3, to: 4, messages: 2, chars: 20 },
    ]);
  });

  test("never crosses a top-level part, and ends where a smaller part begins only in a stretch's last third", () => {
    const most = { messages: 30, chars: 1_000_000 };
    expect(cut(even(40), most, { top: [25] })).toEqual([
      [0, 24],
      [25, 39],
    ]);
    // A smaller part that begins after twenty of thirty messages ends the stretch; one that begins after nineteen doesn't.
    expect(cut(even(40), most, { inner: [20] })).toEqual([
      [0, 19],
      [20, 39],
    ]);
    expect(cut(even(40), most, { inner: [19] })).toEqual([
      [0, 29],
      [30, 39],
    ]);
    // Of several that begin in the last third, the last: the stretch is as full as it can end well.
    expect(cut(even(40), most, { inner: [22, 27] })).toEqual([
      [0, 26],
      [27, 39],
    ]);
    // A stretch that ends with the messages ends there, whatever begins late in it.
    expect(cut(even(30), most, { inner: [25] })).toEqual([[0, 29]]);
    // A part named by a number no message has begins at the next message there is; one past the last begins nothing.
    const sparse = [0, 1, 2, 10, 11, 12].map((index) => ({ index, chars: 10 }));
    expect(cut(sparse, most, { top: [5] })).toEqual([
      [0, 2],
      [10, 12],
    ]);
    expect(cut(sparse, most, { top: [13], inner: [40] })).toEqual([[0, 12]]);
  });

  test("puts every message in exactly one stretch, whatever the lengths and the parts", () => {
    // The same numbers every run: a generator with a fixed start.
    let seed = 7;
    const next = (below: number): number => {
      seed = (seed * 1103515245 + 12345) % 2147483648;
      return seed % below;
    };
    const messages = Array.from({ length: 2000 }, (_, index) => ({ index, chars: next(40) === 0 ? 9000 : 1 + next(3000) }));
    const top = Array.from({ length: 12 }, () => next(2000));
    const inner = Array.from({ length: 100 }, () => next(2000));
    const most = { messages: 25, chars: 5000 };
    const stretches = stretchesOf(messages, most, { top, inner });
    expect(stretches[0]?.from).toBe(0);
    expect(stretches.at(-1)?.to).toBe(1999);
    stretches.forEach((s, i) => {
      // No gap and no overlap: each begins at the message after the one before it ended at.
      if (i > 0) expect(s.from).toBe((stretches[i - 1]?.to ?? -2) + 1);
      expect(s.messages).toBe(s.to - s.from + 1);
      expect(s.chars).toBe(messages.slice(s.from, s.to + 1).reduce((sum, m) => sum + m.chars, 0));
      expect(s.messages).toBeLessThanOrEqual(most.messages);
      if (s.messages > 1) expect(s.chars).toBeLessThanOrEqual(most.chars);
      for (const part of top) expect(s.from < part && part <= s.to).toBe(false);
    });
  });

  test("cuts five thousand messages in well under half a second", () => {
    const messages = Array.from({ length: 5000 }, (_, index) => ({ index, chars: 200 + ((index * 37) % 900) }));
    const top = Array.from({ length: 50 }, (_, k) => k * 100);
    const inner = Array.from({ length: 500 }, (_, k) => k * 10);
    const began = performance.now();
    const stretches = stretchesOf(messages, { messages: 60, chars: 36_000 }, { top, inner });
    expect(performance.now() - began).toBeLessThan(500);
    expect(stretches.reduce((sum, s) => sum + s.messages, 0)).toBe(5000);
  });
});

describe("chat_outline with stretches", () => {
  test("cuts the chat by Messages per reader, and says nothing but the stretches", async () => {
    const rig = await rigOf(chatOf(100), { settings: (s) => (s.recall.chronicle.stretchMessages = 30) });
    expect(await outline(rig, { stretches: true })).toEqual([
      "4 stretches of at most 30 messages or 36,000 characters each:",
      `- #0 to #29 · 30 messages, ${grouped(chars(0, 29))} characters`,
      `- #30 to #59 · 30 messages, ${grouped(chars(30, 59))} characters`,
      `- #60 to #89 · 30 messages, ${grouped(chars(60, 89))} characters`,
      `- #90 to #99 · 10 messages, ${chars(90, 99)} characters`,
    ]);
    // The flag written as text is the flag; without it the tool answers with the outline as before.
    expect((await outline(rig, { stretches: "true" }))[0]).toBe("4 stretches of at most 30 messages or 36,000 characters each:");
    expect((await outline(rig, { stretches: false }))[0]).toBe(`${FROM_CHAT} Messages #0 to #99 (100 messages) in 3 parts:`);
  });

  test("cuts the chat by Text per reader", async () => {
    const rig = await rigOf(chatOf(40), { settings: (s) => (s.recall.chronicle.stretchChars = 200) });
    const lines = await outline(rig, { stretches: true });
    expect(lines[0]).toBe("10 stretches of at most 60 messages or 200 characters each:");
    const cut = stretchLines(lines);
    // Each message is some forty characters: four fit two hundred, and a fifth would pass it.
    expect(cut.map((s) => [s.from, s.to])).toEqual(Array.from({ length: 10 }, (_, k) => [k * 4, k * 4 + 3]));
    for (const s of cut) {
      expect(s.chars).toBe(chars(s.from, s.to));
      expect(s.chars).toBeLessThanOrEqual(200);
      if (s.to < 39) expect(s.chars + said(s.to + 1).length).toBeGreaterThan(200);
    }
  });

  test("leaves no gap and no overlap over a whole chat, and a message too long for a stretch alone", async () => {
    const host = new RecallHost();
    // Every seventh message is longer than a stretch may be; the others differ in length.
    const texts = Array.from({ length: 90 }, (_, i) => (i % 7 === 3 ? `Watch ${i}: ${"Ilse reads the ledger aloud. ".repeat(20)}` : `Watch ${i}: ${"Brann mends a net. ".repeat(1 + (i % 5))}`));
    texts.forEach((text, i) => host.sayAt(CHAT, i % 2 === 0 ? "user" : "assistant", text, START + i * 60_000));
    const rig = await rigOf(host, { settings: (s) => (s.recall.chronicle.stretchChars = 300) });
    const cut = (await pages(rig, "chat_outline", { stretches: true })).flatMap((page) => stretchLines(page.split("\n")));
    expect(cut[0]?.from).toBe(0);
    expect(cut.at(-1)?.to).toBe(89);
    cut.forEach((s, i) => {
      if (i > 0) expect(s.from).toBe((cut[i - 1]?.to ?? -2) + 1);
      expect(s.messages).toBe(s.to - s.from + 1);
      expect(s.chars).toBe(texts.slice(s.from, s.to + 1).reduce((sum, text) => sum + text.length, 0));
      if (s.messages > 1) expect(s.chars).toBeLessThanOrEqual(300);
    });
    for (let i = 3; i < 90; i += 7) expect(cut).toContainEqual({ from: i, to: i, messages: 1, chars: texts[i]?.length ?? 0 });
  });

  test("ends a stretch at a long gap in time only late in it", async () => {
    const nightBefore = (first: number) => (i: number) => START + (i >= first ? DAY : 0) + i * 60_000;
    const late = await rigOf(chatOf(30, nightBefore(25)), { settings: (s) => (s.recall.chronicle.stretchMessages = 27) });
    expect(spans(await outline(late, { stretches: true }))).toEqual([
      [0, 24],
      [25, 29],
    ]);
    const early = await rigOf(chatOf(30, nightBefore(10)), { settings: (s) => (s.recall.chronicle.stretchMessages = 27) });
    expect(spans(await outline(early, { stretches: true }))).toEqual([
      [0, 26],
      [27, 29],
    ]);
  });

  test("cuts only the messages from and to name", async () => {
    const rig = await rigOf(chatOf(100), { settings: (s) => (s.recall.chronicle.stretchMessages = 30) });
    expect(await outline(rig, { stretches: true, from: 10, to: 49 })).toEqual(["2 stretches of at most 30 messages or 36,000 characters each:", `- #10 to #39 · 30 messages, ${grouped(chars(10, 39))} characters`, `- #40 to #49 · 10 messages, ${chars(40, 49)} characters`]);
    expect(spans(await outline(rig, { stretches: true, from: 85 }))).toEqual([[85, 99]]);
    expect(spans(await outline(rig, { stretches: true, to: "[#31 00000000]" }))).toEqual([
      [0, 29],
      [30, 31],
    ]);
    expect(await outline(rig, { stretches: true, from: 7, to: 7 })).toEqual(["1 stretch of at most 30 messages or 36,000 characters each:", `- #7 · 1 message, ${said(7).length} characters`]);
    const none = await rig.run("chat_outline", { stretches: true, from: 130 });
    expect(none.error).toBe(true);
    expect(none.text).toBe("No message lies between #130 and #99: this turn reads messages #0 to #99.");
  });

  test("pages by cursor to the last stretch", async () => {
    const rig = await rigOf(chatOf(100), { settings: (s) => (s.recall.chronicle.stretchMessages = 5) });
    const read = await pages(rig, "chat_outline", { stretches: true });
    expect(read).toHaveLength(2);
    const [first = "", second = ""] = read.map((page) => page.split("\n"));
    // Every page: the heading, its stretches, and where to read on or that it is the end.
    expect(first).toHaveLength(12);
    expect(second).toHaveLength(12);
    expect(first[0]).toBe("20 stretches of at most 5 messages or 36,000 characters each:");
    expect(second[0]).toBe(first[0]);
    expect(first.at(-1)).toBe('[There is more: call chat_outline again with the same arguments and cursor "10".]');
    expect(second.at(-1)).toBe("[That is the end.]");
    expect(read.flatMap((page) => spans(page.split("\n")))).toEqual(Array.from({ length: 20 }, (_, k): [number, number] => [k * 5, k * 5 + 4]));
    expect((await rig.run("chat_outline", { stretches: true, cursor: "20" })).error).toBe(true);
  });

  test("cuts a chat of five thousand messages in well under half a second, within Answer length", async () => {
    const rig = await rigOf(chatOf(5000));
    // The first call reads the chat for the run, as any chat tool's does: the cut is timed on the next.
    await outline(rig, { stretches: true, to: 0 });
    const began = performance.now();
    const firstPage = await outline(rig, { stretches: true });
    expect(performance.now() - began).toBeLessThan(500);
    expect(firstPage[0]).toBe("84 stretches of at most 60 messages or 36,000 characters each:");
    expect(firstPage[1]).toBe(`- #0 to #59 · 60 messages, ${grouped(chars(0, 59))} characters`);
    const read = await pages(rig, "chat_outline", { stretches: true });
    for (const page of read) expect(page.length).toBeLessThanOrEqual(rig.settings.tools.pageChars);
    const cut = read.flatMap((page) => stretchLines(page.split("\n")));
    expect(cut).toHaveLength(84);
    expect(cut.at(-1)).toEqual({ from: 4980, to: 4999, messages: 20, chars: chars(4980, 4999) });
    cut.forEach((s, i) => expect(s.from).toBe(i * 60));
  }, 30_000);
});
