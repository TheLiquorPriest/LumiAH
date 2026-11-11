// Citations (DESIGN §24.4, §24.7): how a message is named to a tool and read back by the check. A
// reference is read in one pass and refused past a short length, whatever a model sends (the
// review's H2); a citation holds only where the message at its number has its hash, and a hash
// found elsewhere is a wrong number only where exactly one message has it (M2).

import { describe, expect, test } from "bun:test";
import { textHash } from "../../src/core/hash";
import { checkCitation, CITE_CHARS, citationsIn, citeOf, namedMessage, placesOf } from "../../src/core/recall/cite";
import { CHAT_TOOLS } from "../../src/core/tools/chat";
import { harbour, toolRig } from "./recall-support";

const HASH = "a3f9c27e51aab3f09d1e6c0777b0d41c0c2e9a51a3f9c27e51aab3f09d1e6c07";

function timed<T>(work: () => T): { ms: number; value: T } {
  const t0 = performance.now();
  const value = work();
  return { ms: performance.now() - t0, value };
}

describe("a message named to a tool", () => {
  test("by its number, or by its citation with or without brackets", () => {
    expect(namedMessage(412)).toEqual({ index: 412, hash: null });
    expect(namedMessage("412")).toEqual({ index: 412, hash: null });
    expect(namedMessage(" #412 ")).toEqual({ index: 412, hash: null });
    expect(namedMessage("[#412 a3f9c27e]")).toEqual({ index: 412, hash: "a3f9c27e" });
    expect(namedMessage("#412 A3F9C27E")).toEqual({ index: 412, hash: "a3f9c27e" });
    expect(namedMessage("[ # 412   a3f9c27e ]")).toEqual({ index: 412, hash: "a3f9c27e" });
    // A whole hash is a citation too, and names the same message.
    expect(namedMessage(`[#412 ${HASH}]`)).toEqual({ index: 412, hash: HASH });
    expect(citeOf(412, HASH)).toBe("#412 a3f9c27e");
    expect(CITE_CHARS).toBe(8);
  });

  test("nothing else names one: fewer than eight hex characters, a number past nine digits, words", () => {
    for (const given of ["[#412 a3f9]", "#412 a3f9c27", "1234567890", "-1", "4.5", "the fourth", "", "[#412 a3f9c27e] and more", "#412 zzzzzzzz", null, undefined, {}, 4.5, -1, Number.NaN]) expect(namedMessage(given)).toBeNull();
  });

  test("is read in one pass and refused past a short length, however many blanks a model sends (H2)", async () => {
    // The review's probe: `[` and blanks, then something that is no number. Read side by side, two runs of optional space made this take the square of the blanks.
    const times: number[] = [];
    for (const blanks of [2_000, 32_000, 1_000_000]) {
      const { ms, value } = timed(() => namedMessage(`[${" ".repeat(blanks)}x`));
      expect(value).toBeNull();
      times.push(ms);
    }
    // And blanks around a real number, which no trimming may hide: a reference is short or it is none.
    const padded = timed(() => namedMessage(`${" ".repeat(1_000_000)}412`));
    expect(padded.value).toBeNull();
    times.push(padded.ms);
    for (const ms of times) expect(ms).toBeLessThan(50);
    // The longest citation there is still names its message; the longest text read, when it names nothing, is read in no time.
    expect(namedMessage(`[#123456789 ${HASH}]`)).toEqual({ index: 123456789, hash: HASH });
    const worst = timed(() => namedMessage(`[${" ".repeat(94)}x`));
    expect(worst.value).toBeNull();
    expect(worst.ms).toBeLessThan(50);

    // Through the tools that take a message: the answer comes at once, says what to give, and stays within Answer length.
    const rig = await toolRig(harbour(), CHAT_TOOLS);
    await rig.run("chat_read", { from: "0" });
    for (const [tool, args] of [
      ["chat_read", { from: `[${" ".repeat(250_000)}x` }],
      ["chat_around", { message: `[${" ".repeat(250_000)}x` }],
      ["chat_grep", { text: "key", from: `[${" ".repeat(250_000)}x` }],
    ] as const) {
      const t0 = performance.now();
      const answer = await rig.run(tool, args);
      expect(performance.now() - t0).toBeLessThan(250);
      expect(answer.error).toBe(true);
      expect(answer.text.length).toBeLessThanOrEqual(rig.settings.tools.pageChars);
    }
  });

  test("every citation of a text is read, with as much of the hash as it carries", () => {
    expect(citationsIn(`- The crossing. [#120 a3f9c27e] [#159 77B0D41C] and [#7 ${HASH}], not [#8 a3f9] nor [9 a3f9c27e]`)).toEqual([
      { text: "[#120 a3f9c27e]", index: 120, hash: "a3f9c27e" },
      { text: "[#159 77B0D41C]", index: 159, hash: "77b0d41c" },
      { text: `[#7 ${HASH}]`, index: 7, hash: HASH },
    ]);
  });
});

describe("a citation against the chat as it stands (M2)", () => {
  const hashes = new Map<number, string>([
    [0, `11111111${"0".repeat(56)}`],
    [1, `22222222${"0".repeat(56)}`],
    [2, `33333333${"0".repeat(56)}`],
    // Two messages with the same text have the same hash.
    [3, `44444444${"0".repeat(56)}`],
    [4, `44444444${"0".repeat(56)}`],
  ]);
  const places = placesOf(hashes);

  test("it holds only where the message at its number has its hash", () => {
    expect(checkCitation({ index: 1, hash: "22222222" }, hashes, places)).toEqual({ state: "ok" });
    // One of two messages with the same text, cited at its own number, holds.
    expect(checkCitation({ index: 4, hash: "44444444" }, hashes, places)).toEqual({ state: "ok" });
    // A hash shorter than a citation carries holds nowhere, whoever passes it.
    expect(checkCitation({ index: 1, hash: "2222" }, hashes, places).state).toBe("changed");
  });

  test("a hash exactly one other message has is a wrong number; one several have names them; one none has is found nowhere", () => {
    expect(checkCitation({ index: 0, hash: "22222222" }, hashes, places)).toEqual({ state: "moved", now: 1 });
    expect(checkCitation({ index: 900, hash: "33333333" }, hashes, places)).toEqual({ state: "moved", now: 2 });
    expect(checkCitation({ index: 0, hash: "44444444" }, hashes, places)).toEqual({ state: "changed", several: [3, 4] });
    expect(checkCitation({ index: 900, hash: "44444444" }, hashes, places)).toEqual({ state: "gone", several: [3, 4] });
    expect(checkCitation({ index: 0, hash: "abcdef01" }, hashes, places)).toEqual({ state: "changed", several: [] });
    expect(checkCitation({ index: 900, hash: "abcdef01" }, hashes, places)).toEqual({ state: "gone", several: [] });
  });

  test("in a chat of 5,000 messages no made-up citation passes, and none of a message whose text is another's now", async () => {
    // The review's probe P3b. With four characters of the hash, one made-up citation in fourteen passed as "the same message at another number".
    const chat = new Map<number, string>();
    for (let i = 0; i < 5000; i++) chat.set(i, await textHash(`Message ${i}: the tide table for day ${i} of the season.`));
    const among = placesOf(chat);
    let passed = 0;
    for (let k = 0; k < 20_000; k++) {
      // Hashes nobody copied from a message: twenty thousand of them, spread over all there are.
      const made = Math.imul(k + 1, 0x9e3779b1) >>> 0;
      const state = checkCitation({ index: 9_999_999, hash: made.toString(16).padStart(8, "0") }, chat, among).state;
      if (state === "ok" || state === "moved") passed++;
    }
    expect(passed).toBe(0);
    // A citation of a message whose text was replaced never holds on by another message's hash.
    let held = 0;
    for (let i = 0; i < 400; i++) {
      const was = chat.get(i) ?? "";
      const edited = new Map(chat).set(i, "0".repeat(64));
      if (checkCitation({ index: i, hash: was.slice(0, CITE_CHARS) }, edited, placesOf(edited)).state !== "changed") held++;
    }
    expect(held).toBe(0);
  });
});
