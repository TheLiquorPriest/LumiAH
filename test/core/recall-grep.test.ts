// A search by pattern can never hold the process (the review's H1; DESIGN §24.6). Three layers,
// each tested here: only patterns of a class that cannot run away are run; a line is matched in
// pieces of bounded length; and a search gives way between pieces, ends when its agent is stopped,
// and stops with a plain answer once it has taken longer than Settings allow.

import { describe, expect, test } from "bun:test";
import type { JsonObject } from "../../src/core/ports";
import { type GrepBound, grepTexts, type LineMatch, lineMatch } from "../../src/core/recall/answers";
import { defaultSettings } from "../../src/core/settings";
import { Texts } from "../../src/core/texts";
import { CHAT_TOOLS } from "../../src/core/tools/chat";
import { LORE_TOOLS } from "../../src/core/tools/lore";
import type { Pager } from "../../src/core/tools/paging";
import { CHAT, harbour, RecallHost, type Rig, START, toolRig } from "./recall-support";

const PAGER: Pager = { tool: "chat_grep", texts: new Texts({}), pageChars: 4000, pageItems: 10, lineChars: 300 };
const PIECE = defaultSettings().recall.grep.pieceChars;

/** A pattern as a grep would run it: the test of a line, or why it is refused. */
function matchOf(pattern: string, pieceChars = PIECE): LineMatch | string {
  const match = lineMatch(PAGER, pattern, true, pieceChars);
  return "text" in match ? match.text : match;
}

/** Whether a line holds the pattern, searched a piece at a time as `grepTexts` does. */
function holds(pattern: string, line: string, pieceChars = PIECE): { at: number; length: number } | null {
  const match = matchOf(pattern, pieceChars);
  if (typeof match === "string") throw new Error(`refused: ${match}`);
  for (let n = 0; n < match.pieces(line); n++) {
    const found = match.find(line, n);
    if (found) return found;
  }
  return null;
}

/** The longest any one piece of `line` took to match, in milliseconds. */
function slowestPiece(match: LineMatch, line: string): number {
  let slowest = 0;
  for (let n = 0; n < match.pieces(line); n++) {
    const t0 = performance.now();
    match.find(line, n);
    slowest = Math.max(slowest, performance.now() - t0);
  }
  return slowest;
}

const NESTED = "it repeats a group";
const MANY = "it can match in too many ways";
const BACK = "it uses a back-reference or a look-behind";

describe("the patterns a grep runs", () => {
  test("each of the review's patterns is refused before it is compiled, with what to write instead", () => {
    // Every one of these took time that doubled with each word of an ordinary line, or fifteen seconds for one line of 800 characters.
    const reviewed: [pattern: string, why: string][] = [
      ["(.|\\s)*zzz", NESTED],
      ["(\\w|\\d)*!", NESTED],
      ["(a|aa)*c", NESTED],
      ["(\\w{0,99}){0,99}!", NESTED],
      ["(a?){0,99}b", NESTED],
      ["\\w*\\w*\\w*!", MANY],
    ];
    for (const [pattern, why] of reviewed) {
      const t0 = performance.now();
      const refused = matchOf(pattern);
      expect(performance.now() - t0).toBeLessThan(50);
      expect(typeof refused).toBe("string");
      expect(refused).toContain(`“${pattern}” can't be used as a pattern: ${why}`);
      expect(refused).toContain("Give plain text without regex, or a simpler expression.");
    }
  });

  test("the class: a repeat follows one character or class, an alternative holds one repeat without bound, and the optional and bounded parts beside it combine in few ways", () => {
    const run = ["brass\\s+key", "Okoro|Ilse|Brann", "colou?r", "\\bkey\\b", "[A-Z][a-z]+ said", "\\d{2,4} coins", "key.*strongbox", "(?:the )?brass key", "^Mara", "ledger\\.$", "(key|ledger) of the (mill|coast)", "(Mara|Joss|Ilse|Brann|Okoro).*(key|ledger|strongbox)", "\\p{Lu}\\p{Ll}+", "a{3}b{2,5}", "\\w{0,99}\\w{0,99}!", "(?<who>Mara|Joss) nods", "(?=.*key)ledger", "[(a+)+]x", "x\\(a+\\)\\+", "ke+y|le+dger|stro+ngbox"];
    for (const pattern of run) expect([pattern, typeof matchOf(pattern)]).toEqual([pattern, "object"]);

    const refused: [pattern: string, why: string][] = [
      // A repeat of a group, whatever the group holds and however the repeat is written.
      ["(ab)+", NESTED],
      ["(a|b)*c", NESTED],
      ["(?:x+)+y", NESTED],
      ["(a+)+b", NESTED],
      ["(a+)+$", NESTED],
      ["(key){2}", NESTED],
      ["(?:ab){1,3}", NESTED],
      ["(?<n>ab)*", NESTED],
      // More than one repeat without bound in one alternative, also where a group or a look-ahead holds one of them.
      [".*key.*lock", MANY],
      ["\\w+\\s+\\w+", MANY],
      ["a{2,}b{3,}", MANY],
      ["(a*|b)c*d", MANY],
      ["(?=.*key).*ledger", MANY],
      ["x|\\d+\\s*y", MANY],
      // Optional and bounded parts that combine in too many ways: beside a repeat without bound, and without one.
      ["a?a?a?a?a?a?a?a*!", MANY],
      ["(a|b|c|d|e|f|g|h|i)(j|k|l|m|n|o|p|q|r).*z", MANY],
      ["\\w{0,99}\\w{0,99}\\w{0,99}!", MANY],
      [`${"a?".repeat(40)}${"a".repeat(40)}`, MANY],
      // Looking back.
      ["(a)\\1", BACK],
      ["(?<n>a)\\k<n>", BACK],
      ["(?<=the )key", BACK],
      ["(?<!the )key", BACK],
    ];
    for (const [pattern, why] of refused) expect([pattern, String(matchOf(pattern)).includes(why)]).toEqual([pattern, true]);
    // What the engine itself can't compile is refused in its words, and a pattern longer than a line unread.
    expect(matchOf("[a-")).toContain("“[a-” can't be used as a pattern: ");
    expect(matchOf("key)")).toContain("can't be used as a pattern: ");
    expect(matchOf(`k${"e".repeat(400)}y`)).toContain("it is longer than 300 characters (Line length)");
    // How much the bounded parts may combine without a repeat rests on the piece's length, which is a setting: a shorter piece takes less.
    expect(typeof matchOf("\\w{0,99}\\w{0,99}!", 100)).toBe("string");
  });

  test("what the class lets through is matched in bounded time on the text that is worst for it", () => {
    // Each line is a dozen pieces long: what is bounded is one piece, however long the line.
    const worst: [pattern: string, line: string][] = [
      ["\\w*!", "a".repeat(12_000)],
      ["\\w*\\d", "a".repeat(12_000)],
      [".*zzz", "a ".repeat(6000)],
      ["a*aaaaaaaab", "a".repeat(12_000)],
      ["\\w{0,99}\\w{0,99}!", "a".repeat(12_000)],
      ["(Mara|Joss|Ilse|Brann|Okoro).*(key|ledger|strongbox)", "Mara Joss Ilse Brann Okoro ke ledge strongbo ".repeat(300)],
      ["(a|ab|abc|abcd).*(x|xy)", "abcd".repeat(3000)],
      ["a?a?a?a?a?a*!", "a".repeat(12_000)],
      ["x*", "y".repeat(12_000)],
    ];
    const times: Record<string, number> = {};
    for (const [pattern, line] of worst) {
      const match = matchOf(pattern);
      if (typeof match === "string") throw new Error(`refused: ${match}`);
      expect(match.pieces(line)).toBeGreaterThan(10);
      times[pattern] = Math.round(slowestPiece(match, line));
    }
    // One piece is some milliseconds, some tens at worst: far under the time a search works before it gives way would need to be to matter.
    for (const [pattern, ms] of Object.entries(times)) expect([pattern, ms < 400]).toEqual([pattern, true]);
  });
});

describe("a line longer than a piece", () => {
  /** A line of `chars` characters of filler words with `put` written over it at the places given. */
  function lineWith(chars: number, put: Record<number, string>): string {
    let line = "the tide comes in and the nets are hung to dry ".repeat(Math.ceil(chars / 47)).slice(0, chars);
    for (const [at, text] of Object.entries(put)) line = line.slice(0, Number(at)) + text + line.slice(Number(at) + text.length);
    return line;
  }

  test("is matched a piece at a time, each overlapping the last by half: a match is found wherever it stands, across two pieces too", () => {
    const match = matchOf("brass\\s+key");
    if (typeof match === "string") throw new Error(match);
    expect(match.pieces("a short line")).toBe(1);
    expect(match.pieces("x".repeat(PIECE))).toBe(1);
    // Pieces of 2,000 that step by 1,000: a line of 10,000 is nine of them.
    expect(match.pieces("x".repeat(10_000))).toBe(9);
    for (const at of [0, 990, 995, 1000, 1996, 2000, 2995, 5000, 8999, 9991]) {
      const line = lineWith(10_000, { [at]: "brass key" });
      expect([at, holds("brass\\s+key", line)]).toEqual([at, { at, length: 9 }]);
    }
    expect(holds("brass\\s+key", lineWith(10_000, {}))).toBeNull();
    // The piece's length is a setting; whatever it is, nothing is cut inside a character.
    const wide = `${"🌊".repeat(700)}brass key${"🌊".repeat(700)}`;
    for (const piece of [100, 101, 500, 2000]) expect([piece, holds("brass\\s+key", wide, piece)]).toEqual([piece, { at: 1400, length: 9 }]);
    expect(holds("🌊🌊$", wide, 100)).toEqual({ at: wide.length - 4, length: 4 });
  });

  test("its start, its end and its word edges are the line's own, never a piece's", () => {
    // "tide" at a piece's start is not at the line's.
    const mid = lineWith(10_000, { 3000: "tide" });
    expect(holds("^tide", mid)).toBeNull();
    expect(holds("^the tide", mid)).toEqual({ at: 0, length: 8 });
    // "moon" where a piece ends is not at the line's end; at the line's end it is.
    for (const at of [1996, 1997, 2997, 3996]) expect([at, holds("moon$", lineWith(10_000, { [at]: "moon" }))]).toEqual([at, null]);
    expect(holds("moon$", lineWith(10_000, { 9996: "moon" }))).toEqual({ at: 9996, length: 4 });
    // A word's middle at a piece's edge is no word's edge: "key" in "monkey" and in "keys".
    for (const at of [997, 1997, 2997]) expect([at, holds("\\bkey", lineWith(10_000, { [at]: "monkey" }))]).toEqual([at, null]);
    for (const at of [997, 1997, 1998, 2997, 2998]) expect([at, holds("key\\b", lineWith(10_000, { [at]: "keys " }))]).toEqual([at, null]);
    expect(holds("\\bkey\\b", lineWith(10_000, { 2996: " key " }))).toEqual({ at: 2997, length: 3 });
  });
});

/** A clock that moves as it is read, a millisecond a look, and that counts each time a search gives way. `onWay`: what happens while it has given way. */
function ticking(host: RecallHost, onWay: (ways: number) => void = () => undefined): { ways: () => number; looks: () => number } {
  let now = host.clock.now();
  let ways = 0;
  let looks = 0;
  host.clock.now = () => {
    looks++;
    return ++now;
  };
  host.clock.sleep = (_ms, signal) => {
    ways++;
    onWay(ways);
    return signal.aborted ? Promise.reject(signal.reason) : Promise.resolve();
  };
  return { ways: () => ways, looks: () => looks };
}

/** A chat of `count` messages of two lines each. */
function longChat(count: number): RecallHost {
  const host = new RecallHost();
  for (let i = 0; i < count; i++) host.sayAt(CHAT, i % 2 ? "assistant" : "user", `Message ${i}: the tide is ${i % 7 === 0 ? "out" : "in"}.\nThe nets are hung to dry.`, START + i * 60_000);
  return host;
}

const ctxOf = (signal: AbortSignal) => ({ signal, agentId: "agent_test", role: "main", callId: "c1" });

describe("a search gives way, and stops at its time", () => {
  test("between pieces it gives way once it has worked for Settings' time, so a long search holds nothing", async () => {
    const host = longChat(400);
    const rig = await toolRig(host, CHAT_TOOLS, { settings: (s) => Object.assign(s.recall.grep, { ms: 60_000, sliceMs: 10 }) });
    await rig.run("chat_read", { from: "0" });
    const clock = ticking(host);
    const answer = await rig.run("chat_grep", { text: "tide is out" });
    expect(answer.error).toBeUndefined();
    expect(answer.text.split("\n")[0]).toBe("58 lines found; showing 1 to 10.");
    // 800 lines, a look at the clock after each, a millisecond a look: it gave way every ten milliseconds or so.
    expect(clock.ways()).toBeGreaterThan(60);
    expect(clock.ways()).toBeLessThan(90);
    // A pattern goes the same way.
    const before = clock.ways();
    expect((await rig.run("chat_grep", { text: "tide is (out|in)\\.", regex: true })).text.split("\n")[0]).toBe("400 lines found; showing 1 to 10.");
    expect(clock.ways() - before).toBeGreaterThan(60);
  });

  test("a Stop during a long search ends it: nothing more is searched", async () => {
    const host = longChat(400);
    const rig = await toolRig(host, CHAT_TOOLS, { settings: (s) => Object.assign(s.recall.grep, { ms: 60_000, sliceMs: 10 }) });
    await rig.run("chat_read", { from: "0" });
    const stop = new AbortController();
    // The user stops the turn while the search has given way for the third time.
    const clock = ticking(host, (ways) => {
      if (ways === 3) stop.abort(new Error("the turn was stopped"));
    });
    await expect(rig.tools.get("chat_grep")?.run({ text: "tide is (out|in)\\.", regex: true }, ctxOf(stop.signal))).rejects.toThrow("the turn was stopped");
    expect(clock.ways()).toBe(3);
    // About thirty of the 800 lines were looked at, and none after the stop.
    const looked = clock.looks();
    expect(looked).toBeLessThan(60);
    // The call has ended with the stop's reason, so no search is left to look at the clock; and a call whose agent was stopped already searches nothing.
    await expect(rig.tools.get("chat_grep")?.run({ text: "tide" }, ctxOf(stop.signal))).rejects.toThrow("the turn was stopped");
    expect(clock.looks()).toBe(looked);
  });

  test("a search that takes longer than Settings allow stops and says so, in the chat and in the lore", async () => {
    const host = longChat(400);
    for (let i = 0; i < 300; i++) host.addEntry("book-coast", `44444444-0000-4000-8000-${String(i).padStart(12, "0")}`, `Tide table ${i}`, ["tide"], `High water at the point on day ${i}.\nLow water six hours on.`);
    host.addBook("book-coast", "The Coast");
    const rig = await toolRig(host, [...CHAT_TOOLS, ...LORE_TOOLS], { settings: (s) => Object.assign(s.recall.grep, { ms: 120, sliceMs: 10 }) });
    await rig.run("chat_read", { from: "0" });
    await rig.run("lore_index", {});
    ticking(host);
    const chat = await rig.run("chat_grep", { text: "strongbox" });
    expect(chat.error).toBe(true);
    expect(chat.text).toMatch(/^The search was stopped: it took longer than 120 ms \(Time for one search\) and had gone through \d+ of 400 messages\. Narrow it to fewer of them, give plain text instead of a pattern, or a simpler pattern\.$/);
    const lore = await rig.run("lore_grep", { text: "water (six|seven)", regex: true });
    expect(lore.error).toBe(true);
    expect(lore.text).toMatch(/^The search was stopped: it took longer than 120 ms \(Time for one search\) and had gone through \d+ of 300 entries\./);
    // Narrowed as the answer says, it is answered.
    const narrowed = await rig.run("chat_grep", { text: "tide is out", from: 0, to: 20 });
    expect(narrowed.error).toBeUndefined();
    expect(narrowed.text.split("\n")[0]).toBe("3 lines found; showing 1 to 3.");
  });

  test("grepTexts itself: every line in order, late with how far it came, and the signal's reason where it was stopped", async () => {
    const match = matchOf("tide");
    if (typeof match === "string") throw new Error(match);
    let now = 0;
    const bound = (ms: number, signal = new AbortController().signal): GrepBound => ({ clock: { now: () => ++now, sleep: async () => undefined }, signal, ms, sliceMs: 5 });
    const texts = ["The tide is in.\nNothing here.\nHigh TIDE at noon.", "No word of it.", "tide"];
    expect(await grepTexts(texts, match, bound(1000))).toEqual([
      { key: 0, line: 1, text: "The tide is in.", at: 4, length: 4 },
      { key: 0, line: 3, text: "High TIDE at noon.", at: 5, length: 4 },
      { key: 2, line: 1, text: "tide", at: 0, length: 4 },
    ]);
    // Three milliseconds: the clock is looked at once at the start and once a piece, so the fourth piece is the second text's.
    expect(await grepTexts(texts, match, bound(3))).toEqual({ late: true, searched: 1 });
    const stopped = new AbortController();
    stopped.abort(new Error("stopped"));
    await expect(grepTexts(texts, match, bound(1000, stopped.signal))).rejects.toThrow("stopped");
  });
});

describe("the greps through their tools", () => {
  async function rigOf(): Promise<Rig> {
    return toolRig(harbour(), [...CHAT_TOOLS, ...LORE_TOOLS]);
  }

  test("a pattern of the class finds its lines; one that isn't is refused by both tools, in an answer within Answer length", async () => {
    const rig = await rigOf();
    expect((await rig.run("chat_grep", { text: "brass\\s+key", regex: true })).text.split("\n")[0]).toBe("3 lines found; showing 1 to 3.");
    expect((await rig.run("lore_grep", { text: "two keys? turned", regex: "true" })).text.split("\n")[0]).toBe("1 line found; showing 1 to 1.");
    for (const tool of ["chat_grep", "lore_grep"]) {
      for (const pattern of ["(.|\\s)*zzz", "\\w*\\w*\\w*!", "(a+)+b"]) {
        const t0 = performance.now();
        const refused = await rig.run(tool, { text: pattern, regex: true });
        expect(performance.now() - t0).toBeLessThan(250);
        expect(refused.error).toBe(true);
        expect(refused.text).toContain("can't be used as a pattern");
        expect(refused.text.length).toBeLessThanOrEqual(rig.settings.tools.pageChars);
      }
    }
    // The same text without regex is plain text, and is looked for as written.
    expect((await rig.run("chat_grep", { text: "(a+)+b" })).text).toBe("No line of this chat holds “(a+)+b”. Try a shorter piece of it, or chat_search for the words in any order.");
  });

  test("the tools say in their own argument what a pattern may be", async () => {
    const rig = await rigOf();
    for (const tool of ["chat_grep", "lore_grep"]) {
      const regex = (rig.tools.get(tool)?.parameters.properties as Record<string, { description: string }>).regex?.description ?? "";
      expect(regex).toContain("a repeat (*, +, {n,m}) follows one character or class, never a group");
    }
  });

  test("a chat of 5,000 messages is searched by text and by pattern in a fraction of a second", async () => {
    const host = longChat(5000);
    const rig = await toolRig(host, CHAT_TOOLS);
    await rig.run("chat_read", { from: "0" });
    const asks: JsonObject[] = [{ text: "tide is out" }, { text: "tide is (out|in)\\.", regex: true }, { text: "Message \\d{1,4}7: .*out", regex: true }];
    for (const args of asks) {
      const t0 = performance.now();
      const answer = await rig.run("chat_grep", args);
      expect(performance.now() - t0).toBeLessThan(500);
      expect(answer.error).toBeUndefined();
      expect(answer.text).toMatch(/^\d+ lines found; showing 1 to 10\.\n/);
    }
  });
});
