// Search in every script (DESIGN §24.2, §24.4, §24.6): a script that writes no space between its
// words is found by a word inside a clause; nothing is ever cut inside a character or between a
// character and the marks that belong to it; and the index one chat keeps between turns takes a
// text replaced or removed without being built again.

import { describe, expect, test } from "bun:test";
import { bestLines, excerptOf, heldTerms, LexicalIndex, piecesOf, queryTerms, tokenize, wholeCut } from "../../src/core/lexical";

/** A surrogate that stands alone: what a text cut inside a character begins or ends with. */
const LONE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/;

const found = <K>(index: LexicalIndex<K>, query: string): K[] => index.search(query).map((hit) => hit.key);

describe("a script written without spaces", () => {
  test("a Japanese clause is found by a word inside it, wherever the word stands", () => {
    const index = new LexicalIndex<string>(600);
    // "Mara hid the brass key under the floor of the lighthouse." / "Joss is mending the net at the harbour." / "The key is in the mill."
    index.add("a", "マラは真鍮の鍵を灯台の床下に隠した。");
    index.add("b", "ジョスは港で網を繕っている。");
    index.add("c", "鍵は水車小屋にある。");
    // brass; lighthouse; under the floor: each in the middle of the clause, none set off by a space.
    expect({ brass: found(index, "真鍮"), lighthouse: found(index, "灯台"), floor: found(index, "床下") }).toEqual({ brass: ["a"], lighthouse: ["a"], floor: ["a"] });
    // key: one ideograph, a word by itself, in two texts.
    expect(new Set(found(index, "鍵"))).toEqual(new Set(["a", "c"]));
    // A name in katakana no dictionary knows, and a longer query that asks in a sentence.
    expect(found(index, "ジョス")).toEqual(["b"]);
    expect(found(index, "真鍮の鍵はどこ")[0]).toBe("a");
    // A query of several characters isn't looked up by each ideograph alone: "harbour key" shares no pair with the clause about the net.
    expect(found(index, "図書館")).toEqual([]);
  });

  test("Chinese, Thai and Korean are found by a word of theirs, and a text of mixed scripts by each part", () => {
    const index = new LexicalIndex<string>(600);
    // "Ilse keeps the ledger of the whole coast's debts." / "Okoro keeps the lighthouse." / "Brann sold the boat yesterday." / "trending on SNS"
    index.add("zh", "伊尔莎保管着整个海岸的债务账本。");
    index.add("th", "โอโคโรดูแลประภาคาร");
    index.add("ko", "브란은 어제 배를 팔았다.");
    index.add("mixed", "灯台がSNSで話題になった。");
    expect({ ledger: found(index, "账本"), debts: found(index, "债务") }).toEqual({ ledger: ["zh"], debts: ["zh"] });
    // lighthouse, inside a Thai sentence written with no space at all.
    expect(found(index, "ประภาคาร")).toEqual(["th"]);
    // boat: Korean hangs the object's ending on the word ("배를"), and the bare syllable, a word by itself, still finds it.
    expect(found(index, "배")).toEqual(["ko"]);
    expect(found(index, "어제")).toEqual(["ko"]);
    expect(found(index, "팔았다")).toEqual(["ko"]);
    // The Latin part of a mixed clause is a word like any other; so is the part after it.
    expect(found(index, "sns")).toEqual(["mixed"]);
    expect(found(index, "話題")).toEqual(["mixed"]);
  });

  test("full-width letters and digits are the letters and digits they stand for", () => {
    const index = new LexicalIndex<string>(600);
    index.add("a", "ＭＡＲＡは１２番の桟橋にいる。");
    expect(found(index, "mara")).toEqual(["a"]);
    expect(found(index, "12")).toEqual(["a"]);
    expect(tokenize("Ｌａｍｐ")).toEqual(["lamp"]);
  });

  test("a query's words are each looked up once, in the query's order", () => {
    expect(queryTerms("the brass key, the brass key")).toEqual(["brass", "key"]);
    expect(queryTerms("真鍮の鍵")).toContain("真鍮");
    // A single ideograph asked alone is looked up as itself.
    expect(queryTerms("鍵")).toEqual(["鍵"]);
  });
});

describe("a cut", () => {
  test("never splits a character from the marks and joiners that belong to it", () => {
    // "e" with a combining acute; a family emoji joined by zero-width joiners; a flag of two regional indicators kept whole only as code points.
    const accent = `cafe\u0301 noir`;
    expect(accent.slice(0, wholeCut(accent, 4))).toBe("caf");
    expect(accent.slice(0, wholeCut(accent, 5))).toBe("cafe\u0301");
    const family = "a👨‍👩‍👧b";
    for (let at = 0; at <= family.length; at++) {
      const cut = wholeCut(family, at);
      expect(LONE.test(family.slice(0, cut))).toBe(false);
      // The joined emoji is kept whole or left out: the cut is before it or after it.
      expect([0, 1, family.length - 1, family.length]).toContain(cut);
    }
  });

  test("pieces of a text with no space and no ASCII stop end at its own full stops, and none splits a character", () => {
    const text = "マラは鍵を隠した。ジョスは網を繕った。𠮷野家は港にある。オコロは灯台を守る。".repeat(6);
    const pieces = piecesOf(text, 40);
    expect(pieces.length).toBeGreaterThan(5);
    expect(pieces.map((p) => text.slice(p.start, p.end)).join("")).toBe(text);
    for (const p of pieces) {
      const part = text.slice(p.start, p.end);
      expect(LONE.test(part)).toBe(false);
      expect(part.length).toBeLessThanOrEqual(40);
    }
    // Most pieces end where a sentence does.
    expect(pieces.filter((p) => text[p.end - 1] === "。").length).toBeGreaterThan(pieces.length / 2);
  });

  test("an excerpt and a hit's best lines are cut on code points, whatever the script", () => {
    const line = `${"𠮷".repeat(40)}鍵${"𠮷".repeat(40)}`;
    for (const max of [1, 2, 3, 7, 20, 41, 60]) expect(LONE.test(excerptOf(line, { start: 0, end: line.length }, max))).toBe(false);
    const text = `灯台の話。\n${"𠮷野は港で網を繕っている。".repeat(30)}真鍮の鍵は床下にある。${"𠮷野は港にいる。".repeat(30)}`;
    const lines = bestLines(text, queryTerms("真鍮の鍵"), 2, 60);
    expect(lines.length).toBeGreaterThan(0);
    for (const shown of lines) {
      expect(LONE.test(shown.text)).toBe(false);
      expect(shown.text.length).toBeLessThanOrEqual(61);
    }
    // The long second line is read sentence by sentence, and the sentence that holds the words is the one shown.
    expect(lines.some((shown) => shown.line === 2 && shown.text.includes("真鍮の鍵"))).toBe(true);
  });

  test("a hit with no line that holds the query's words shows where the text starts", () => {
    expect(bestLines("The mill stands by the river.\nIts wheel is still.", queryTerms("lighthouse"), 2, 80)).toEqual([{ line: 1, text: "The mill stands by the river." }]);
    expect(bestLines("", queryTerms("mill"), 2, 80)).toEqual([]);
    expect(heldTerms("The brass key turned twice.", queryTerms("brass lamp key"))).toEqual(["brass", "key"]);
  });
});

describe("an index kept between turns", () => {
  test("takes a text replaced or removed, and ranks as one built anew would", () => {
    const texts = new Map<string, string>();
    for (let i = 0; i < 300; i++) texts.set(`m${i}`, `Message ${i}: ${i % 7 === 0 ? "the brass key" : "the lamp"} at the ${i % 5 === 0 ? "mill" : "quay"}, tide ${i}.`);
    const kept = new LexicalIndex<string>(200);
    for (const [key, text] of texts) kept.add(key, text);
    // A hundred and fifty are edited, fifty removed, twenty added: more of its pieces die than live, so it packs itself on the way.
    for (let i = 0; i < 150; i++) {
      const text = `Message ${i}, edited: Okoro ${i % 3 === 0 ? "holds the brass key" : "trims the lamp"}.`;
      texts.set(`m${i}`, text);
      kept.add(`m${i}`, text);
    }
    for (let i = 250; i < 300; i++) {
      texts.delete(`m${i}`);
      kept.remove(`m${i}`);
    }
    for (let i = 300; i < 320; i++) {
      texts.set(`m${i}`, `Message ${i}: Ilse counts the brass keys.`);
      kept.add(`m${i}`, texts.get(`m${i}`) ?? "");
    }
    const fresh = new LexicalIndex<string>(200);
    for (const [key, text] of texts) fresh.add(key, text);
    expect(kept.keys).toBe(fresh.keys);
    expect(kept.count).toBe(fresh.count);
    for (const query of ["brass key", "okoro lamp", "mill tide", "ilse", "edited"]) {
      const a = kept.search(query);
      const b = fresh.search(query);
      expect(new Set(a.map((hit) => hit.key))).toEqual(new Set(b.map((hit) => hit.key)));
      // The same scores, to the rounding of sums made in another order.
      const scoreOf = new Map(b.map((hit) => [hit.key, hit.score]));
      for (const hit of a) expect(Math.abs(hit.score - (scoreOf.get(hit.key) ?? -1))).toBeLessThan(1e-9);
    }
    expect(kept.has("m260")).toBe(false);
    expect(found(kept, "tide").some((key) => Number(key.slice(1)) < 150)).toBe(false);
  });

  test("a word in a head field counts by its weight, and a key with no text is found by its heads", () => {
    const index = new LexicalIndex<string>(600, 2);
    index.add("titled", "A stone tower on the point.", ["The Lighthouse", "lamp, light"]);
    index.add("mentioned", "Okoro rows to the lighthouse and back to the lighthouse every lighthouse day.", ["Okoro", "keeper"]);
    index.add("empty", "", ["The Lighthouse Stair", ""]);
    // Counted as plain text, the entry that says the word three times leads; with the title weighed, the entries titled with it do.
    expect(index.search("lighthouse", { weights: [0, 0] }).map((hit) => hit.key)).toEqual(["mentioned"]);
    const weighed = index.search("lighthouse", { weights: [4, 3] }).map((hit) => hit.key);
    expect(weighed.slice(0, 2).sort()).toEqual(["empty", "titled"]);
    expect(weighed[2]).toBe("mentioned");
    expect(index.search("keeper", { weights: [4, 3] }).map((hit) => hit.key)).toEqual(["mentioned"]);
    // Only the text counts as an occurrence.
    expect([...index.occurrences("lighthouse")]).toEqual([["mentioned", 3]]);
    expect(index.search("lighthouse", { weights: [4, 3], keep: (key) => key !== "titled" }).map((hit) => hit.key)).not.toContain("titled");
  });
});
