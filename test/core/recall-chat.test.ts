// The history tools (DESIGN §24.4) from where an agent stands: chat_about, chat_search, chat_grep,
// chat_read and chat_around over a chat's own messages, the citation every printed message carries,
// what becomes of a citation once the chat changed, the page no answer passes whatever a call's
// arguments are, and the corpus that is kept between runs. chat_outline has a file of its own.

import { describe, expect, test } from "bun:test";
import type { JsonObject, PathMessage } from "../../src/core/ports";
import { citationsIn, namedMessage } from "../../src/core/recall/cite";
import { Recall, recallOf } from "../../src/core/recall/recall";
import { CHAT_TOOLS } from "../../src/core/tools/chat";
import { CHAT, DAY, FakeEmbedder, harbour, pages, RecallHost, type Rig, START, toolRig } from "./recall-support";

const rigOf = (host: RecallHost, options: Parameters<typeof toolRig>[2] = {}): Promise<Rig> => toolRig(host, CHAT_TOOLS, options);

/** A chat of `count` messages a minute apart, Mara and Joss by turns; `say` gives each one's text. */
function chatOf(count: number, say: (i: number) => string, host = new RecallHost()): RecallHost {
  for (let i = 0; i < count; i++) host.sayAt(CHAT, i % 2 === 0 ? "user" : "assistant", say(i), START + i * 60_000);
  return host;
}

/** The numbers of the messages an answer cites, in the order it prints them. */
const cited = (text: string): number[] => citationsIn(text).map((c) => c.index);

/** The line of an answer that cites message `index`. */
function lineOf(text: string, index: number): string {
  const line = text.split("\n").find((l) => l.includes(`[#${index} `));
  if (line === undefined) throw new Error(`no line cites #${index} in:\n${text}`);
  return line;
}

/** A tool's answer, which a test expects not to be an error. */
async function ok(rig: Rig, name: string, args: JsonObject): Promise<string> {
  const out = await rig.run(name, args);
  if (out.error) throw new Error(`${name} failed: ${out.text}`);
  return out.text;
}

/** A tool's answer, which a test expects to be an error. */
async function refused(rig: Rig, name: string, args: JsonObject): Promise<string> {
  const out = await rig.run(name, args);
  if (!out.error) throw new Error(`${name} answered: ${out.text}`);
  return out.text;
}

describe("the history tools", () => {
  test("are offered from coarse to exact wherever the run has a chat", async () => {
    const host = harbour();
    expect((await rigOf(host)).offered()).toEqual(["chat_outline", "chat_about", "chat_search", "chat_grep", "chat_read", "chat_around"]);
    expect((await rigOf(host, { chatId: "", turn: null, runId: "side-1" })).offered()).toEqual([]);
  });

  test("describe every argument in the user's texts", async () => {
    const rig = await rigOf(harbour(), { texts: { "tool.chat_search.speaker": "Whose messages to search." } });
    for (const tool of rig.tools.values()) {
      const properties = tool.parameters.properties as Record<string, { description: string }>;
      for (const [name, schema] of Object.entries(properties)) expect(`${tool.name}.${name}: ${schema.description}`).toMatch(/: \S/);
    }
    expect((rig.tools.get("chat_search")?.parameters.properties as Record<string, { description: string }>).speaker?.description).toBe("Whose messages to search.");
  });

  test("print every message with a citation that reads back to it", async () => {
    const host = harbour();
    const rig = await rigOf(host);
    const path = await host.chat.path(CHAT);
    const answers = [
      await ok(rig, "chat_read", { from: 0, to: 11 }),
      await ok(rig, "chat_around", { message: 6 }),
      await ok(rig, "chat_grep", { text: "the" }),
      await ok(rig, "chat_search", { queries: ["brass key", "ledger", "Okoro lighthouse"] }),
      await ok(rig, "chat_about", { names: ["Okoro", "brass key", "Ilse", "the brass keys"] }),
    ];
    for (const answer of answers) {
      const citations = citationsIn(answer);
      expect(citations.length).toBeGreaterThan(0);
      for (const citation of citations) {
        const named = namedMessage(citation.text);
        expect(named?.hash).toBe(citation.hash);
        expect(path[named?.index ?? -1]?.hash.startsWith(citation.hash)).toBe(true);
      }
    }
    // Each message read, each line found and each hit is one printed message: none goes without.
    const [read, around, grep, search, about] = answers as [string, string, string, string, string];
    expect(cited(read)).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11]);
    expect(cited(around)).toEqual([3, 4, 5, 6, 7, 8, 9]);
    for (const line of grep.split("\n").filter((l) => l.startsWith("- "))) expect(citationsIn(line)).toHaveLength(1);
    for (const line of search.split("\n").filter((l) => l.startsWith("- "))) expect(citationsIn(line)).toHaveLength(1);
    for (const line of about.split("\n").filter((l) => /^(- |First: |Latest: )/.test(l))) expect(citationsIn(line)).toHaveLength(1);
  });

  test("answer a chat with no message yet by saying so", async () => {
    const rig = await rigOf(new RecallHost());
    const calls: [string, JsonObject][] = [
      ["chat_outline", {}],
      ["chat_about", { names: ["Okoro"] }],
      ["chat_search", { queries: ["key"] }],
      ["chat_grep", { text: "key" }],
      ["chat_read", { from: 0 }],
      ["chat_around", { message: 0 }],
    ];
    for (const [name, args] of calls) {
      const out = await rig.run(name, args);
      expect(out.error).toBeUndefined();
      expect(out.text).toBe("This chat has no messages before this reply, so there is nothing to read here. Work from the request.");
    }
  });
});

describe("chat_read and chat_around", () => {
  test("read one message, a run of them, and a message named by its citation", async () => {
    const host = harbour();
    const rig = await rigOf(host);
    const path = await host.chat.path(CHAT);
    const cite = (i: number): string => `[#${i} ${path[i]?.hash.slice(0, 8)}]`;
    expect(await ok(rig, "chat_read", { from: 3 })).toBe(`Chat messages #3 to #3 (1 asked for):\n${cite(3)} Joss · 2026-03-04 09:06, characters 0 to 89 of 89:\nHe turns it over twice. "It opens the customs house strongbox. Okoro has the only other."`);
    const run = await ok(rig, "chat_read", { from: 2, to: 4 });
    expect(run.startsWith("Chat messages #2 to #4 (3 asked for):\n")).toBe(true);
    expect(cited(run)).toEqual([2, 3, 4]);
    expect(run).toContain(`${cite(4)} Mara · 2026-03-05 09:00, characters 0 to 59 of 59:\nThe next morning I row out to the lighthouse to find Okoro.`);
    // A citation names the same message as its number, however it is written; the two ends may come either way round.
    expect(await ok(rig, "chat_read", { from: cite(3) })).toBe(await ok(rig, "chat_read", { from: 3 }));
    expect(await ok(rig, "chat_read", { from: `#3 ${path[3]?.hash.slice(0, 12)}` })).toBe(await ok(rig, "chat_read", { from: "3" }));
    expect(await ok(rig, "chat_read", { from: cite(4), to: cite(2) })).toBe(run);
  });

  test("page a long read by a cursor that reads on inside a message", async () => {
    const text = (i: number): string => Array.from({ length: 80 }, (_, k) => `Line ${k} of message ${i}: Ilse counts the boats as they come in past the quay.`).join("\n");
    const host = chatOf(3, text);
    const rig = await rigOf(host);
    const read = await pages(rig, "chat_read", { from: 0, to: 2 });
    expect(read.length).toBeGreaterThan(2);
    const parts = new Map<number, string>();
    for (const page of read) {
      expect(page.length).toBeLessThanOrEqual(rig.settings.tools.pageChars);
      expect(page.startsWith("Chat messages #0 to #2 (3 asked for):\n")).toBe(true);
      for (const m of page.matchAll(/^\[#(\d+) [0-9a-f]{8}\] \S+ · [^,\n]+, characters (\d+) to (\d+) of (\d+):\n/gm)) {
        const [index, from, to, chars] = [Number(m[1]), Number(m[2]), Number(m[3]), Number(m[4])];
        expect(chars).toBe(text(index).length);
        // Each part starts where the one before it ended.
        expect(from).toBe((parts.get(index) ?? "").length);
        parts.set(index, (parts.get(index) ?? "") + page.slice(m.index + m[0].length, m.index + m[0].length + to - from));
      }
    }
    expect([...parts.keys()]).toEqual([0, 1, 2]);
    for (const [index, whole] of parts) expect(whole).toBe(text(index));
    expect(read.at(-1)?.endsWith("[That is the end.]")).toBe(true);
    expect((await refused(rig, "chat_read", { from: 0, to: 2, cursor: "7:0" })).startsWith("“7:0” isn't a cursor chat_read gave.")).toBe(true);
  });

  test("say what to give for a message the chat lacks and an argument that names none", async () => {
    const rig = await rigOf(harbour());
    expect(await refused(rig, "chat_read", {})).toBe("chat_read needs from: The first message to read, by its number or its citation. Call it again with from.");
    expect((await refused(rig, "chat_read", { from: "the start" })).startsWith("chat_read needs from: ")).toBe(true);
    expect(await refused(rig, "chat_read", { from: 40 })).toBe("There is no chat message #40: this turn reads messages #0 to #11. Give a number in that range.");
    expect(await refused(rig, "chat_read", { from: 3, to: 40 })).toBe("There is no chat message #40: this turn reads messages #0 to #11. Give a number in that range.");
    expect(await refused(rig, "chat_read", { from: 3, to: "the end" })).toBe("“the end” names no message. Give its number (412) or its citation ([#412 a3f9c27e]).");
    expect(await refused(rig, "chat_around", {})).toBe("chat_around needs message: The message, by its number (412) or its citation ([#412 a3f9c27e]). Call it again with message.");
    expect(await refused(rig, "chat_around", { message: "five" })).toBe("“five” names no message. Give its number (412) or its citation ([#412 a3f9c27e]).");
    expect(await refused(rig, "chat_around", { message: -1 })).toBe("“-1” names no message. Give its number (412) or its citation ([#412 a3f9c27e]).");
    expect(await refused(rig, "chat_around", { message: 12 })).toBe("There is no chat message #12: this turn reads messages #0 to #11. Give a number in that range.");
  });

  test("read around a message, as many each side as the call or Settings say", async () => {
    const host = harbour();
    const rig = await rigOf(host);
    const around = await ok(rig, "chat_around", { message: 5 });
    expect(around.startsWith("Chat messages #2 to #8 (7 asked for):\n")).toBe(true);
    expect(cited(around)).toEqual([2, 3, 4, 5, 6, 7, 8]);
    expect(cited(await ok(rig, "chat_around", { message: "#5", before: 0, after: 1 }))).toEqual([5, 6]);
    expect(cited(await ok(rig, "chat_around", { message: 5, before: 1, after: 0 }))).toEqual([4, 5]);
    // The chat's ends bound it: nothing stands before the first message or after the last.
    expect(cited(await ok(rig, "chat_around", { message: 0 }))).toEqual([0, 1, 2, 3]);
    expect(cited(await ok(rig, "chat_around", { message: 11, before: 2, after: 50 }))).toEqual([9, 10, 11]);
    const wide = await rigOf(host, { runId: "gen-wide", settings: (s) => (s.recall.chat.around = 1) });
    expect(cited(await ok(wide, "chat_around", { message: 5 }))).toEqual([4, 5, 6]);
  });

  test("check a citation against the chat as it stands, and say what was compared: it reads otherwise, its number is wrong, the chat has no such number, several read as cited", async () => {
    const host = harbour();
    const before = await host.chat.path(CHAT);
    const cite = (path: readonly PathMessage[], i: number): string => `[#${i} ${path[i]?.hash.slice(0, 8)}]`;
    const [five, nine, eleven] = [cite(before, 5), cite(before, 9), cite(before, 11)];
    // LumiAH keeps no record of a chat changing: no answer says that one did.
    const changed = /\bchanged\b|no longer|says something else|\bis gone\b|\bmoved\b|\bnow\b/i;
    // A citation that holds reads as its number does.
    const first = await rigOf(host, { runId: "gen-1" });
    expect(await ok(first, "chat_around", { message: five, before: 0, after: 0 })).toBe(await ok(first, "chat_around", { message: 5, before: 0, after: 0 }));

    // The message at the cited number reads otherwise (here it was edited). It is read all the same, and the answer says what rested on the cited text has to be looked at again.
    host.edit(CHAT, before[5]?.id ?? "", "Okoro is asleep in the lamp room. The ledger lies open beside him.");
    const edited = await rigOf(host, { runId: "gen-2" });
    const now = await host.chat.path(CHAT);
    expect(cite(now, 5)).not.toBe(five);
    for (const answer of [await ok(edited, "chat_around", { message: five, before: 0, after: 0 }), await ok(edited, "chat_read", { from: five })]) {
      expect(answer.startsWith(`[${five} doesn't hold: message #5 doesn't read as cited, and no message of the chat reads as cited. It is read as it stands (${cite(now, 5)}); what rested on the cited text has to be checked again.]\nChat messages #5 to #5 (1 asked for):\n${cite(now, 5)} Joss`)).toBe(true);
      expect(answer.endsWith("Okoro is asleep in the lamp room. The ledger lies open beside him.")).toBe(true);
      expect(answer.split("\n")[0]).not.toMatch(changed);
    }
    // The citation of the message as it stands holds, and says nothing.
    expect((await ok(edited, "chat_read", { from: cite(now, 5) })).startsWith("Chat messages #5 to #5")).toBe(true);

    // Only the number is wrong: exactly one other message reads as cited (here one before it was deleted). That message is read.
    host.remove(CHAT, before[1]?.id ?? "");
    const shifted = await rigOf(host, { runId: "gen-3" });
    const after = await host.chat.path(CHAT);
    const wrong = `[${nine}: message #9 doesn't read as cited, and exactly one message of the chat does: #8 (${cite(after, 8)}), which is read here.]`;
    const moved = await ok(shifted, "chat_around", { message: nine, before: 1, after: 0 });
    expect(moved.startsWith(`${wrong}\nChat messages #7 to #8 (2 asked for):\n`)).toBe(true);
    expect(moved.endsWith(`Ilse wipes flour from her hands. "Every debt on this coast. Brann's is the longest page."`)).toBe(true);
    const range = await ok(shifted, "chat_read", { from: nine, to: 9 });
    expect(range.startsWith(`${wrong}\nChat messages #8 to #9 (2 asked for):\n`)).toBe(true);
    expect(wrong).not.toMatch(changed);

    // The chat has no message at the cited number, and none reads as cited (here the cited message was deleted).
    host.remove(CHAT, before[11]?.id ?? "");
    const cut = await rigOf(host, { runId: "gen-4" });
    const calls: [string, JsonObject][] = [
      ["chat_around", { message: eleven }],
      ["chat_read", { from: eleven }],
      ["chat_read", { from: 0, to: eleven }],
    ];
    for (const [name, args] of calls) expect(await refused(cut, name, args)).toBe(`${eleven} doesn't hold: the chat has no message #11, and no message of the chat reads as cited. This turn reads messages #0 to #9.`);

    // Several messages read as cited (two with the same text have the same hash): none of them is taken for the one meant.
    host.sayAt(CHAT, "user", "Continue.", START + 9 * DAY);
    host.sayAt(CHAT, "user", "Continue.", START + 9 * DAY + 60_000);
    const twice = await rigOf(host, { runId: "gen-5" });
    const last = await host.chat.path(CHAT);
    const same = last[10]?.hash.slice(0, 8);
    const several = "and several messages read as cited (#10, #11), so which was meant can't be told: cite the one you read by its own number";
    expect((await ok(twice, "chat_read", { from: `[#3 ${same}]` })).startsWith(`[[#3 ${same}] doesn't hold: message #3 doesn't read as cited, ${several}. It is read as it stands (${cite(last, 3)}); what rested on the cited text has to be checked again.]\nChat messages #3 to #3 (1 asked for):\n${cite(last, 3)} `)).toBe(true);
    expect(await refused(twice, "chat_read", { from: `[#40 ${same}]` })).toBe(`[#40 ${same}] doesn't hold: the chat has no message #40, ${several}. This turn reads messages #0 to #11.`);
    // Cited at its own number, each of the two holds.
    expect((await ok(twice, "chat_read", { from: cite(last, 11) })).startsWith("Chat messages #11 to #11")).toBe(true);
  });
});

describe("chat_grep", () => {
  /** A chat whose messages have several lines, so a line's number means something. */
  const verses = (): RecallHost => {
    const host = new RecallHost();
    host.sayAt(CHAT, "user", "Mara ties up the skiff.\nThe TIDE is on the turn.\nShe leaves the oars in the boat.", START);
    host.sayAt(CHAT, "assistant", "Joss watches the tide come in.\n\n\"Leave the oars,\" he says. \"Nobody steals at high tide.\"", START + 60_000);
    host.sayAt(CHAT, "user", "\"Then I'll leave the key as well.\"", START + 120_000);
    host.sayAt(CHAT, "assistant", "Ilse laughs from the sea wall. \"The tides don't keep keys, Mara.\"", START + 180_000, "Ilse");
    return host;
  };

  test("finds every line that holds a text, in any letter case, oldest first", async () => {
    const rig = await rigOf(verses());
    const found = (await ok(rig, "chat_grep", { text: "tide" })).split("\n");
    expect(found[0]).toBe("4 lines found; showing 1 to 4.");
    // Each line under its message's citation, with its number in the message.
    expect(found.slice(1).map((line) => line.replace(/ [0-9a-f]{8}\]/, "]"))).toEqual([
      "- [#0] Mara, line 2: The TIDE is on the turn.",
      "- [#1] Joss, line 1: Joss watches the tide come in.",
      '- [#1] Joss, line 3: "Leave the oars," he says. "Nobody steals at high tide."',
      "- [#3] Ilse, line 1: Ilse laughs from the sea wall. \"The tides don't keep keys, Mara.\"",
    ]);
  });

  test("takes a regular expression, a range and a speaker", async () => {
    const rig = await rigOf(verses());
    expect(cited(await ok(rig, "chat_grep", { text: "\\bkeys?\\b", regex: true }))).toEqual([2, 3]);
    expect(cited(await ok(rig, "chat_grep", { text: "^she\\b", regex: true }))).toEqual([0]);
    expect(cited(await ok(rig, "chat_grep", { text: "oars" }))).toEqual([0, 1]);
    expect(cited(await ok(rig, "chat_grep", { text: "oars", from: 1 }))).toEqual([1]);
    expect(cited(await ok(rig, "chat_grep", { text: "oars", to: 0 }))).toEqual([0]);
    expect(cited(await ok(rig, "chat_grep", { text: "tide", from: 1, to: 2 }))).toEqual([1, 1]);
    // A speaker is a name as the chat shows it, in any letter case, or a role.
    expect(cited(await ok(rig, "chat_grep", { text: "tide", speaker: "joss" }))).toEqual([1, 1]);
    expect(cited(await ok(rig, "chat_grep", { text: "tide", speaker: "ILSE" }))).toEqual([3]);
    expect(cited(await ok(rig, "chat_grep", { text: "tide", speaker: "user" }))).toEqual([0]);
    expect(cited(await ok(rig, "chat_grep", { text: "tide", speaker: "assistant", to: 2 }))).toEqual([1, 1]);
    expect(await refused(rig, "chat_grep", { text: "tide", speaker: "Brann" })).toBe("Nobody in this chat speaks as “Brann”. Its speakers are: Mara (2 messages), Joss (1 message), Ilse (1 message). Give one of those, or user or assistant.");
    expect(await refused(rig, "chat_grep", { text: "tide", from: 9 })).toBe("No message lies between #9 and #3: this turn reads messages #0 to #3.");
    expect(await refused(rig, "chat_grep", { text: "tide", from: "soon" })).toBe("“soon” names no message. Give its number (412) or its citation ([#412 a3f9c27e]).");
  });

  test("says what to try when nothing holds the text, and refuses a pattern that could run away", async () => {
    const rig = await rigOf(verses());
    const nothing = await rig.run("chat_grep", { text: "zeppelin" });
    expect(nothing.error).toBeUndefined();
    expect(nothing.text).toBe("No line of this chat holds “zeppelin”. Try a shorter piece of it, or chat_search for the words in any order.");
    // The speaker speaks, but not in the range: nothing is found there, which is no error.
    expect((await ok(rig, "chat_grep", { text: "tide", speaker: "Ilse", to: 1 })).startsWith("No line of this chat holds “tide”.")).toBe(true);
    expect((await refused(rig, "chat_grep", { text: "(a+)+b", regex: true })).startsWith("“(a+)+b” can't be used as a pattern: ")).toBe(true);
    expect(await refused(rig, "chat_grep", {})).toBe("chat_grep needs text: The text to find, as written; letter case doesn't matter. Call it again with text.");
  });

  test("shows a long line around what it found, and pages by cursor", async () => {
    const host = chatOf(30, (i) => `${"Brann mends his nets by the quay and says nothing at all. ".repeat(8)}The anchor chain number ${i} lies coiled at his feet. ${"Okoro waits for the tide. ".repeat(12)}`);
    const rig = await rigOf(host);
    const read = await pages(rig, "chat_grep", { text: "anchor chain" });
    expect(read.length).toBeGreaterThan(1);
    expect(read.flatMap(cited)).toEqual(Array.from({ length: 30 }, (_, i) => i));
    for (const page of read) {
      expect(page.length).toBeLessThanOrEqual(rig.settings.tools.pageChars);
      for (const line of page.split("\n").filter((l) => l.startsWith("- "))) {
        expect(line).toMatch(/…[^…]*The anchor chain number \d+ lies coiled[^…]*…$/);
        expect(line.length).toBeLessThanOrEqual(rig.settings.tools.lineChars + 40);
      }
    }
  });
});

describe("chat_search", () => {
  test("answers several queries each on its own, and says once a run that search is by word", async () => {
    // Search by meaning switched on, and no embedding connection set up: the run's first search says that it is by word.
    const rig = await rigOf(harbour(), { settings: (s) => (s.recall.meaning.enabled = true) });
    const answer = await ok(rig, "chat_search", { queries: ["brass key", "ledger strongbox", "zeppelin"] });
    const lines = answer.split("\n");
    expect(lines[0]).toBe("“brass key”: 5 messages in 1 stretch; showing stretches 1 to 1, the best first.");
    expect(lines).toContain("“ledger strongbox”: 4 messages in 1 stretch; showing stretches 1 to 1, the best first.");
    // A query that finds nothing says what to try next, and the others are answered all the same.
    expect(lines).toContain("No message of this chat matches “zeppelin”. Try fewer or other words (names and rare words find the most), chat_about for a name, or chat_grep for an exact phrase.");
    expect(lines.at(-1)).toBe("[Search is by word here: no embedding connection is set up in Lumiverse, so words that mean the same aren't found. Search with the story's own words.]");
    // A hit shows who wrote it, how long it is and its best lines, each with its number in the message.
    expect(answer).toContain(`${lineOf(answer, 0)}\n    line 1: I walk down to the harbour at dusk. The brass key is heavy in my coat.`);
    expect(lineOf(answer, 0)).toMatch(/^- \[#0 [0-9a-f]{8}\] Mara, 70 characters$/);
    // One query alone, as a model writes it when it has one.
    const one = await ok(rig, "chat_search", { query: "lighthouse" });
    expect(one).not.toContain("Search is by word here");
    expect(one.split("\n")[0]).toBe("“lighthouse”: 1 message in 1 stretch; showing stretches 1 to 1, the best first.");
    expect(one.split("\n")[1]).toBe("#4 · 2026-03-05 · 1 hit:");
    expect(cited(one)).toEqual([4]);
    expect(await refused(rig, "chat_search", {})).toBe("chat_search needs queries: What to look for: one query or several, each answered on its own. Names and rare words find the most. Call it again with queries.");
    expect((await refused(rig, "chat_search", { queries: ["key", "ledger"], cursor: "1" })).startsWith("“1” isn't a cursor chat_search gave.")).toBe(true);
  });

  test("groups hits by stretch, so one exchange doesn't fill the page", async () => {
    // A long exchange about the lantern, and two places far from it where it comes up once.
    const say = (i: number): string => {
      if (i >= 10 && i <= 25) return `Joss holds the lantern higher. "Look, Mara, mark ${i} on the lantern's glass, and the lantern oil is low."`;
      if (i === 40) return "Ilse asks whether anyone has seen her lantern since the flood.";
      if (i === 55) return "Brann admits he sold the lantern to Okoro for a coil of rope.";
      return `Mara counts the gulls on the quay, and gets to ${i}.`;
    };
    const rig = await rigOf(chatOf(60, say));
    const answer = await ok(rig, "chat_search", { queries: ["lantern"] });
    expect(answer.length).toBeLessThanOrEqual(rig.settings.tools.pageChars);
    const lines = answer.split("\n");
    expect(lines[0]).toBe("“lantern”: 18 messages in 3 stretches; showing stretches 1 to 3, the best first.");
    // The exchange is one stretch: its best two hits in chat order, and the rest counted with their numbers.
    const at = lines.indexOf("#10 to #25 · 2026-03-04 · 16 hits:");
    expect(at).toBeGreaterThan(0);
    const shown = cited(lines.slice(at, at + 7).join("\n"));
    expect(shown).toHaveLength(2);
    expect(shown[0]).toBeLessThan(shown[1] ?? 0);
    const more = lines.find((line) => line.startsWith("  and 14 more here: "));
    expect(more).toBeDefined();
    const counted = Array.from({ length: 16 }, (_, k) => k + 10).filter((i) => !shown.includes(i));
    expect([...(more ?? "").matchAll(/#(\d+)(?: to #(\d+))?/g)].flatMap((m) => Array.from({ length: Number(m[2] ?? m[1]) - Number(m[1]) + 1 }, (_, k) => Number(m[1]) + k))).toEqual(counted);
    // The two other places are stretches of their own, and are shown beside it.
    expect(lines).toContain("#40 · 2026-03-04 · 1 hit:");
    expect(lines).toContain("#55 · 2026-03-04 · 1 hit:");
    expect(lineOf(answer, 40)).toMatch(/^- \[#40 [0-9a-f]{8}\] Mara, 62 characters$/);
    expect(cited(answer).sort((a, b) => a - b)).toEqual([...shown, 40, 55]);
    // How far apart hits may stand and still be one stretch, and how many of one are shown, are Settings.
    const tight = await rigOf(chatOf(60, say), { settings: (s) => Object.assign(s.recall.chat, { stretchGap: 0, stretchHits: 1 }) });
    expect((await ok(tight, "chat_search", { queries: ["lantern"] })).split("\n")[0]).toBe("“lantern”: 18 messages in 18 stretches; showing stretches 1 to 10, the best first.");
  });

  test("filters by range and by who spoke", async () => {
    const rig = await rigOf(harbour(), { settings: (s) => (s.recall.chat.stretchGap = 0) });
    const all = await ok(rig, "chat_search", { queries: ["key"] });
    expect(cited(all).sort((a, b) => a - b)).toEqual([0, 1, 2, 7, 11]);
    expect(cited(await ok(rig, "chat_search", { queries: ["key"], from: 2, to: 7 })).sort((a, b) => a - b)).toEqual([2, 7]);
    expect(cited(await ok(rig, "chat_search", { queries: ["key"], from: "[#7 00000000]" })).sort((a, b) => a - b)).toEqual([7, 11]);
    expect(cited(await ok(rig, "chat_search", { queries: ["key"], speaker: "Joss" })).sort((a, b) => a - b)).toEqual([1, 7, 11]);
    expect(cited(await ok(rig, "chat_search", { queries: ["key"], speaker: "user" })).sort((a, b) => a - b)).toEqual([0, 2]);
    expect(cited(await ok(rig, "chat_search", { queries: ["key"], speaker: "mara", from: 1 }))).toEqual([2]);
    expect((await ok(rig, "chat_search", { queries: ["key"], speaker: "mara", from: 3 })).startsWith("No message of this chat matches “key”.")).toBe(true);
    expect(await refused(rig, "chat_search", { queries: ["key"], speaker: "Okoro" })).toBe("Nobody in this chat speaks as “Okoro”. Its speakers are: Mara (6 messages), Joss (6 messages). Give one of those, or user or assistant.");
    expect(await refused(rig, "chat_search", { queries: ["key"], from: 50 })).toBe("No message lies between #50 and #11: this turn reads messages #0 to #11.");
  });

  test("pages one query to its end by cursor", async () => {
    // The anchor comes up in every eighth message: each is a stretch of its own.
    const rig = await rigOf(chatOf(200, (i) => (i % 8 === 0 ? `Okoro checks the anchor before the tide, for the ${i}th time.` : `Mara counts the gulls on the quay, and gets to ${i}.`)));
    const read = await pages(rig, "chat_search", { queries: ["anchor"] });
    expect(read).toHaveLength(3);
    expect(read.map((page) => page.split("\n")[0])).toEqual([
      "“anchor”: 25 messages in 25 stretches; showing stretches 1 to 10, the best first.",
      "“anchor”: 25 messages in 25 stretches; showing stretches 11 to 20, the best first.",
      "“anchor”: 25 messages in 25 stretches; showing stretches 21 to 25, the best first.",
    ]);
    for (const page of read) expect(page.length).toBeLessThanOrEqual(rig.settings.tools.pageChars);
    expect(read.flatMap(cited).sort((a, b) => a - b)).toEqual(Array.from({ length: 25 }, (_, k) => k * 8));
    expect(read.at(-1)?.endsWith("[That is the end.]")).toBe(true);
    expect((await refused(rig, "chat_search", { queries: ["anchor"], cursor: "25" })).startsWith("“25” isn't a cursor chat_search gave.")).toBe(true);
  });

  test("says how a message was found where it holds none of the query's words", async () => {
    const host = harbour();
    const path = await host.chat.path(CHAT);
    const rig = await rigOf(host, { settings: (s) => (s.recall.chat.stretchGap = 0) });
    // What search by meaning finds is its own slice's to test: here its matches are given, to see what chat_search makes of them.
    const kept: boolean[] = [];
    const calls: string[][] = [];
    recallOf(rig.env).meaning = async (_what, queries, keep) => {
      calls.push([...queries]);
      kept.push(keep?.(path[4]?.id ?? "") ?? true, keep?.(path[5]?.id ?? "") ?? true, keep?.("m-unknown") ?? true);
      return { state: "on", matches: queries.map(() => [{ key: path[4]?.id ?? "", similarity: 0.82 }]) };
    };
    const answer = await ok(rig, "chat_search", { queries: ["customs house strongbox", "ledger"], speaker: "Mara" });
    // One call carries every query, and only the messages the filters keep may match.
    expect(calls).toEqual([["customs house strongbox", "ledger"]]);
    expect(kept).toEqual([true, false, false]);
    expect(lineOf(answer, 4)).toMatch(/^- \[#4 [0-9a-f]{8}\] Mara, 59 characters · matched by meaning \(0\.82\)$/);
    // A message the words found says nothing of how: its lines show the words.
    expect(lineOf(answer, 8)).toMatch(/^- \[#8 [0-9a-f]{8}\] Mara, 60 characters$/);
    // Meaning was searched, so nothing says that search is by word.
    expect(answer).not.toContain("Search is by word here");
  });

  test("finds by meaning what holds none of the query's words, where the user has an embedding connection", async () => {
    const host = harbour();
    if (!host.recall) throw new Error("the host has no recall port");
    // An embedder for which a beacon is a lighthouse and to paddle is to row.
    host.recall.embeddings = new FakeEmbedder([
      ["lighthouse", "beacon", "lamp"],
      ["row", "oars", "paddle"],
    ]);
    const rig = await rigOf(host, {
      settings: (s) => {
        s.recall.chat.stretchGap = 0;
        s.recall.meaning.enabled = true;
      },
    });
    // The first search has the chat's messages embedded behind it; once that is done, a search finds by them.
    await rig.run("chat_search", { queries: ["paddle to the beacon"] });
    await Recall.of(host).meaning.settled();
    const answer = await ok(rig, "chat_search", { queries: ["paddle to the beacon"] });
    expect(cited(answer)).toContain(4);
    expect(lineOf(answer, 4)).toMatch(/^- \[#4 [0-9a-f]{8}\] Mara, 59 characters · matched by meaning \(\d\.\d\d\)$/);
    expect(answer).toContain("    line 1: The next morning I row out to the lighthouse to find Okoro.");
    expect(answer).not.toContain("Search is by word here");
    // The filters hold for what meaning finds as for what the words find.
    const joss = cited(await ok(rig, "chat_search", { queries: ["paddle to the beacon"], speaker: "Joss" }));
    expect(joss.length).toBeGreaterThan(0);
    for (const index of joss) expect(index % 2).toBe(1);
  });
});

describe("chat_about", () => {
  test("gives a name's trail: how often, its first and latest mention, and its lines between", async () => {
    const rig = await rigOf(harbour());
    const path = await rig.host.chat.path(CHAT);
    const cite = (i: number): string => `[#${i} ${path[i]?.hash.slice(0, 8)}]`;
    expect(await ok(rig, "chat_about", { names: ["Okoro"] })).toBe(
      [
        "“Okoro”: 5 mentions in 5 messages, #3 to #11.",
        `First: - ${cite(3)} Joss · 2026-03-04 09:06: He turns it over twice. "It opens the customs house strongbox. Okoro has the only other."`,
        `Latest: - ${cite(11)} Joss · 2026-03-12 09:00: She nods slowly. "Bring the brass key. I'll bring Okoro, willing or not."`,
        "Most telling lines between them, in order:",
        `- ${cite(4)} Mara · 2026-03-05 09:00: The next morning I row out to the lighthouse to find Okoro.`,
        `- ${cite(5)} Joss · 2026-03-05 09:00: Okoro is trimming the lamp. He doesn't turn around. "Ilse sent you. She wants the ledger."`,
        `- ${cite(7)} Joss · 2026-03-05 09:00: "The ledger is in the strongbox," Okoro says. "And the strongbox wants two keys turned at once."`,
        "[chat_around reads around a line; chat_search with from and to searches one part of the trail.]",
      ].join("\n"),
    );
    // A phrase is traced as a name is, in any letter case; a lone name is read as a list of one.
    const key = await ok(rig, "chat_about", { name: "BRASS KEY" });
    expect(key.split("\n")[0]).toBe("“BRASS KEY”: 3 mentions in 3 messages, #0 to #11.");
    expect(cited(key)).toEqual([0, 11, 2]);
    // Two mentions have nothing between them.
    expect((await ok(rig, "chat_about", { names: ["Heron"] })).split("\n")[0]).toBe("“Heron” appears in one message (1 mention):");
    expect(await ok(rig, "chat_about", { names: ["strongbox"], to: 6 })).toBe(`“strongbox” appears in one message (1 mention):\n- ${cite(3)} Joss · 2026-03-04 09:06: He turns it over twice. "It opens the customs house strongbox. Okoro has the only other."`);
    const two = (await ok(rig, "chat_about", { names: ["Ilse"], to: 8 })).split("\n");
    expect(two[0]).toBe("“Ilse”: 2 mentions in 2 messages, #5 to #8.");
    expect(two.slice(3, 5)).toEqual(["Most telling lines between them, in order:", "(none)"]);
  });

  test("picks a message's line by how often it holds the name, and spreads the lines over the whole trail", async () => {
    // The tiller is named in every third message, each time in the same words but for two: message 30 names it three times on its second line, and message 72 says the most beside it.
    const say = (i: number): string => {
      if (i === 30) return "Mara looks astern.\nThe tiller, the tiller! Joss has let go of the tiller.\nThe tiller swings.";
      if (i === 72) return "Ilse splices a new rope to the tiller while Okoro bails with a bucket.";
      return i % 3 === 0 ? "Joss keeps a hand on the tiller." : "The gulls follow the boat.";
    };
    const rig = await rigOf(chatOf(120, say), { settings: (s) => (s.recall.chat.trail = 6) });
    const answer = await ok(rig, "chat_about", { names: ["tiller"] });
    const lines = answer.split("\n");
    // 40 messages name it; one of them four times.
    expect(lines[0]).toBe("“tiller”: 43 mentions in 40 messages, #0 to #117.");
    expect(lines[1]).toMatch(/^First: - \[#0 [0-9a-f]{8}\] Mara · 2026-03-04 09:00: Joss keeps a hand on the tiller\.$/);
    expect(lines[2]).toMatch(/^Latest: - \[#117 [0-9a-f]{8}\] Joss · 2026-03-04 10:57: Joss keeps a hand on the tiller\.$/);
    // Six lines in all: the first, the latest, and one from each quarter of the 38 mentions between (messages 3 to 27, 30 to 57, 60 to 84, 87 to 114).
    // A quarter gives the line that holds the name most often (30), else the one that says the most (72), else its first (3, 87).
    expect(cited(lines.slice(4, -1).join("\n"))).toEqual([3, 30, 72, 87]);
    expect(lineOf(answer, 30)).toMatch(/: The tiller, the tiller! Joss has let go of the tiller\.$/);
    expect(lineOf(answer, 72)).toMatch(/: Ilse splices a new rope to the tiller while Okoro bails with a bucket\.$/);
    // Fewer lines still reach from one end of the trail to the other.
    const short = await rigOf(chatOf(120, say), { settings: (s) => (s.recall.chat.trail = 3) });
    expect(cited(await ok(short, "chat_about", { names: ["tiller"] }))).toEqual([0, 117, 30]);
  });

  test("says when no message holds a name as written, with the closest by its words", async () => {
    const rig = await rigOf(harbour());
    // "mill" is no part of "miller", and a name's words apart aren't the name.
    const none = await rig.run("chat_about", { names: ["the brass keys"] });
    expect(none.error).toBeUndefined();
    const lines = none.text.split("\n");
    expect(lines[0]).toBe("No message of this chat holds “the brass keys” as written. The closest by its words:");
    // A few of the messages that hold its words, the closest first: each of these holds "brass key".
    expect(lines).toHaveLength(1 + rig.settings.recall.chat.stretchHits);
    for (const index of cited(none.text)) expect([0, 2, 11]).toContain(index);
    expect(lines[1]).toMatch(/^- \[#2 [0-9a-f]{8}\] Mara · 2026-03-04 09:04: "Brann swears a lot of things\." I show him the brass key\.$/);
    expect(await ok(rig, "chat_about", { names: ["zeppelin"] })).toBe("No message of this chat holds “zeppelin” as written.");
    expect((await ok(rig, "chat_about", { names: ["mil"] })).startsWith("No message of this chat holds “mil” as written.")).toBe(true);
    expect((await ok(rig, "chat_about", { names: ["mill"] })).split("\n")[0]).toBe("“mill” appears in one message (1 mention):");
    expect(await refused(rig, "chat_about", {})).toBe("chat_about needs names: The names or phrases to trace, each as the chat writes it. Call it again with names.");
    expect(await refused(rig, "chat_about", { names: ["Okoro"], from: 30 })).toBe("No message lies between #30 and #11: this turn reads messages #0 to #11.");
  });

  test("gives several names each a trail of their own, within one page", async () => {
    const host = chatOf(240, (i) => `Watch ${i}: ${["Brann", "Okoro", "Ilse"][i % 3]} ${"hauls on the wet line and curses the weather, the tide and the gulls. ".repeat(5)}`);
    const rig = await rigOf(host);
    const answer = await ok(rig, "chat_about", { names: ["Brann", "Okoro", "Ilse", "Heron"] });
    expect(answer.length).toBeLessThanOrEqual(rig.settings.tools.pageChars);
    const heads = answer.split("\n").filter((line) => line.startsWith("“") || line.startsWith("No message"));
    expect(heads).toEqual(["“Brann”: 80 mentions in 80 messages, #0 to #237.", "“Okoro”: 80 mentions in 80 messages, #1 to #238.", "“Ilse”: 80 mentions in 80 messages, #2 to #239.", "No message of this chat holds “Heron” as written."]);
    // Each trail keeps its first and its latest mention, however little room it has.
    for (const [first, latest] of [
      [0, 237],
      [1, 238],
      [2, 239],
    ] as const) {
      expect(lineOf(answer, first).startsWith("First: ")).toBe(true);
      expect(lineOf(answer, latest).startsWith("Latest: ")).toBe(true);
    }
    // More names than one call carries: the rest are named, not dropped in silence.
    const many = await ok(rig, "chat_about", { names: ["Brann", "Okoro", "Ilse", "Mara", "Joss", "Heron", "gulls", "tide"] });
    expect(many.length).toBeLessThanOrEqual(rig.settings.tools.pageChars);
    expect(many.split("\n").at(-1)).toBe("[One call carries 6 at most; the rest weren't run: gulls; tide. Call again with those.]");
  });
});

describe("Answer length", () => {
  test("holds for every tool, whatever the arguments are", async () => {
    const LONG = "the brass key and the ledger of debts ".repeat(140).slice(0, 5000);
    const DENSE = "x".repeat(5000);
    // Long messages, so a page is also full where the arguments are short.
    const host = chatOf(80, (i) => `Watch ${i}: ${"Okoro turns the brass key in the strongbox and reads the ledger of debts aloud. ".repeat(12)}\n${"Brann says nothing. ".repeat(40)}`);
    const rig = await rigOf(host);
    const { pageChars } = rig.settings.tools;
    const calls: [string, JsonObject][] = [];
    for (const long of [LONG, DENSE]) {
      calls.push(
        ["chat_outline", { from: long }],
        ["chat_outline", { to: long }],
        ["chat_outline", { cursor: long }],
        ["chat_about", { names: [long] }],
        ["chat_about", { names: [long, `${long}a`, `${long}b`, `${long}c`, `${long}d`, `${long}e`, `${long}f`, `${long}g`] }],
        ["chat_about", { name: long, from: long }],
        ["chat_about", { names: ["Okoro", long, "brass key", "ledger", "Brann", "strongbox"] }],
        ["chat_search", { queries: [long] }],
        ["chat_search", { queries: [long, `${long}a`, `${long}b`, `${long}c`, `${long}d`, `${long}e`, `${long}f`, `${long}g`] }],
        ["chat_search", { query: long, from: long }],
        ["chat_search", { queries: ["key"], speaker: long }],
        ["chat_search", { queries: ["key"], cursor: long }],
        ["chat_search", { queries: ["key", long] }],
        ["chat_grep", { text: long }],
        ["chat_grep", { text: long, regex: true }],
        ["chat_grep", { text: "key", speaker: long }],
        ["chat_grep", { text: "key", cursor: long }],
        ["chat_grep", { text: "key", to: long }],
        ["chat_read", { from: long }],
        ["chat_read", { from: 0, to: long }],
        ["chat_read", { from: 0, cursor: long }],
        ["chat_around", { message: long }],
        ["chat_around", { message: 3, cursor: long }],
        ["chat_around", { message: 3, before: long, after: long }],
      );
    }
    calls.push(
      ["chat_outline", {}],
      ["chat_outline", { from: 0, to: 39 }],
      ["chat_about", { names: ["Okoro", "brass key", "ledger", "Brann", "strongbox", "debts"] }],
      ["chat_about", { names: ["Okoro"] }],
      ["chat_search", { queries: ["brass key", "ledger of debts", "Brann", "strongbox", "Okoro", "aloud"] }],
      ["chat_search", { queries: ["brass key"] }],
      ["chat_grep", { text: "ledger" }],
      ["chat_grep", { text: "led.er", regex: true }],
      ["chat_read", { from: 0, to: 79 }],
      ["chat_around", { message: 40, before: 40, after: 40 }],
    );
    for (const [name, args] of calls) {
      const out = await rig.run(name, args);
      expect(`${name}: ${out.text.length <= pageChars}`).toBe(`${name}: true`);
      expect(out.text.length).toBeGreaterThan(0);
    }
    // A small page holds as well, and still moves on.
    const small = await rigOf(host, { runId: "gen-small", settings: (s) => (s.tools.pageChars = 900) });
    for (const [name, args] of calls) expect(`${name}: ${(await small.run(name, args)).text.length <= 900}`).toBe(`${name}: true`);
    const read = await pages(small, "chat_read", { from: 0, to: 1 });
    expect(read.length).toBeGreaterThan(3);
    for (const page of read) expect(page.length).toBeLessThanOrEqual(900);
    // So does the smallest page Settings allow, which has no room for some answers' own headings.
    const least = await rigOf(host, { runId: "gen-least", settings: (s) => (s.tools.pageChars = 200) });
    for (const [name, args] of calls) expect(`${name}: ${(await least.run(name, args)).text.length <= 200}`).toBe(`${name}: true`);
  });
});

describe("the chat's index", () => {
  test("is kept between runs: a later run reads only the messages that are new or changed", async () => {
    const host = harbour();
    // Which messages are asked of the host, as the ranges it is asked for.
    const asked: [from: number, to: number][] = [];
    const port = host.recall?.chat;
    if (!port || !host.recall) throw new Error("the host has no recall port");
    host.recall.chat = { messages: (chatId, from, to) => (asked.push([from, to]), port.messages(chatId, from, to)) };
    const path = await host.chat.path(CHAT);

    const first = await rigOf(host, { runId: "gen-1" });
    expect(host.messageReads).toBe(0);
    expect(cited(await ok(first, "chat_search", { queries: ["trimming"] }))).toEqual([5]);
    const corpus = Recall.of(host).corpora(CHAT, first.settings).chat;
    expect(corpus.indexed).toBe(12);
    expect(asked).toEqual([[0, 12]]);
    // Every tool of the run reads the chat it read once.
    await ok(first, "chat_read", { from: 0, to: 11 });
    await ok(first, "chat_about", { names: ["Okoro"] });
    await ok(first, "chat_outline", {});
    expect(host.messageReads).toBe(1);

    // A message is edited and one is added: the next run reads those two, and searches the chat as it stands.
    host.edit(CHAT, path[5]?.id ?? "", "Okoro is asleep in the lamp room. The ledger lies open beside him.");
    host.sayAt(CHAT, "user", "I count the anchors on the quay while we wait for dark.", START + 9 * DAY);
    const second = await rigOf(host, { runId: "gen-2" });
    expect(cited(await ok(second, "chat_search", { queries: ["anchors"] }))).toEqual([12]);
    expect(asked.slice(1)).toEqual([
      [5, 6],
      [12, 13],
    ]);
    expect(corpus.indexed).toBe(14);
    expect((await ok(second, "chat_search", { queries: ["trimming"] })).startsWith("No message of this chat matches “trimming”.")).toBe(true);
    expect(cited(await ok(second, "chat_search", { queries: ["asleep"] }))).toEqual([5]);

    // A message is deleted: the ones after it move down a number, and none of them is read again.
    host.remove(CHAT, path[0]?.id ?? "");
    const third = await rigOf(host, { runId: "gen-3" });
    expect(cited(await ok(third, "chat_search", { queries: ["asleep"] }))).toEqual([4]);
    expect((await ok(third, "chat_read", { from: 0 })).endsWith(`Joss looks up from the nets. "You kept it, then. Brann swore that key went down with the Heron."`)).toBe(true);
    expect((await ok(third, "chat_search", { queries: ["dusk"] })).startsWith("No message of this chat matches “dusk”.")).toBe(true);
    expect(asked).toHaveLength(3);
    expect(corpus.indexed).toBe(14);
    expect(host.messageReads).toBe(3);
  });

  test("reads a message that changed under the run as it stands, cited by its own words", async () => {
    const host = harbour();
    const before = await host.chat.path(CHAT);
    // The run's path is read, and then the message is edited before the run reads the chat.
    const rig = await rigOf(host);
    host.edit(CHAT, before[5]?.id ?? "", "Okoro is asleep in the lamp room. The ledger lies open beside him.");
    const now = await host.chat.path(CHAT);
    const read = await ok(rig, "chat_read", { from: 5 });
    expect(read.endsWith("Okoro is asleep in the lamp room. The ledger lies open beside him.")).toBe(true);
    expect(citationsIn(read).map((c) => c.hash)).toEqual([now[5]?.hash.slice(0, 8) ?? ""]);
    // The citation the path promised is one the message doesn't read as, and is told so.
    expect((await ok(rig, "chat_read", { from: `[#5 ${before[5]?.hash.slice(0, 8)}]` })).startsWith(`[[#5 ${before[5]?.hash.slice(0, 8)}] doesn't hold: message #5 doesn't read as cited`)).toBe(true);
  });

  test("keeps a job's run to its own messages, and a turn's to those before the reply", async () => {
    const host = harbour();
    const all = await rigOf(host, { runId: "job-1", turn: null });
    expect(cited(await ok(all, "chat_grep", { text: "Okoro, willing" }))).toEqual([11]);
    // A turn that answers message 11 reads the chat up to it: `toolRig` reads the whole path, so the reply is cut from it here.
    const path = await host.chat.path(CHAT);
    const turn = await rigOf(host, { runId: "gen-1" });
    turn.env.chat = { ...turn.env.chat, path: async () => path.slice(0, 11) };
    expect((await ok(turn, "chat_grep", { text: "Okoro, willing" })).startsWith("No line of this chat holds")).toBe(true);
    expect(await refused(turn, "chat_read", { from: 11 })).toBe("There is no chat message #11: this turn reads messages #0 to #10. Give a number in that range.");
    expect((await ok(turn, "chat_search", { queries: ["willing"] })).startsWith("No message of this chat matches “willing”.")).toBe(true);
    // The job's run, asked again, still reads all twelve.
    expect(cited(await ok(all, "chat_search", { queries: ["willing"] }))).toEqual([11]);
  });
});
