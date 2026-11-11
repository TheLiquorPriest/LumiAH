// The lexical index (`lexical.ts`) beyond text written with spaces between its words: a script that
// writes none is found by its words, and no piece or excerpt is ever cut inside a character.

import { describe, expect, test } from "bun:test";
import { excerptOf, LexicalIndex, tokenize } from "../../src/core/lexical";

/** A surrogate that stands alone: what a text cut inside a character begins or ends with. */
const LONE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/;

describe("a search by words", () => {
  test("finds a Japanese sentence and a Chinese one by a word of theirs, and not by a word they lack", () => {
    const index = new LexicalIndex<string>(600);
    // "Yesterday Mara mended the old net at the harbour."
    index.add("ja", "マラは昨日、港で古い網を直した。");
    // "The mill stands where the river meets the sea; its wheel has not turned since the flood."
    index.add("zh", "磨坊在河流入海的地方，轮子从洪水以后就没有转过。");
    index.add("en", "Okoro mended the old net by the harbour yesterday.");
    const found = (query: string): string[] => index.search(query).map((hit) => hit.key);
    // yesterday; net, a word of one character; the name, which no dictionary knows.
    expect({ yesterday: found("昨日"), net: found("網"), name: found("マラ") }).toEqual({ yesterday: ["ja"], net: ["ja"], name: ["ja"] });
    // flood; river; mill, as a longer query words it.
    expect({ flood: found("洪水"), river: found("河流"), asked: found("磨坊在哪里") }).toEqual({ flood: ["zh"], river: ["zh"], asked: ["zh"] });
    // library; lighthouse.
    expect({ library: found("図書館"), lighthouse: found("灯塔") }).toEqual({ library: [], lighthouse: [] });
    expect(found("harbour nets")).toEqual(["en"]);
  });

  test("finds an English text as before, the words the segmenter runs together among them", () => {
    expect(tokenize("The boats' nets; word.Next and 3.14, Ilse's lamp.")).toEqual(["boat", "net", "word", "next", "14", "ilse", "lamp"]);
    const index = new LexicalIndex<string>(600);
    index.add("a", "The boats came back at dusk with empty nets.");
    index.add("b", "Brann mended the sail.Next to it he drew the snake_case mark, twice.");
    index.add("c", "A boat without nets is only a hull.");
    const found = (query: string): string[] => index.search(query).map((hit) => hit.key);
    expect(new Set(found("boat nets"))).toEqual(new Set(["a", "c"]));
    expect({ next: found("next"), snake: found("snake"), mending: found("mending sails") }).toEqual({ next: ["b"], snake: ["b"], mending: ["b"] });
    expect(found("the and of")).toEqual([]);
  });
});

describe("a cut", () => {
  test("of a piece or an excerpt never falls inside a character", () => {
    // No sentence ends in it, so its pieces are cut by length, and the cut at 300 would fall inside the emoji.
    const text = `${"nets ".repeat(59)}buoy😀${" float".repeat(40)}`;
    expect(text.codePointAt(299)).toBe(0x1f600);
    const index = new LexicalIndex<number>(300);
    index.add(0, text);
    const [buoy] = index.search("buoy");
    const [float] = index.search("float");
    if (!buoy || !float) throw new Error("a word of the text found none of its pieces");
    // The first piece stops before the emoji, and the second starts on it.
    expect([buoy.piece, float.piece]).toEqual([
      { start: 0, end: 299 },
      { start: 299, end: text.length },
    ]);
    const shown = [buoy.piece, float.piece].flatMap((piece) => [10, 40, 400].map((max) => excerptOf(text, piece, max)));
    expect(shown.filter((part) => LONE.test(part))).toEqual([]);
    expect(excerptOf(text, float.piece, 20)).toBe("😀 float float float…");
  });

  test("of an excerpt keeps the emoji at either end whole, or leaves it out", () => {
    const text = `${"a".repeat(29)}😀 and the tide`;
    // Thirty characters would end on half of the emoji.
    expect(excerptOf(text, { start: 0, end: text.length }, 30)).toBe(`${"a".repeat(29)}…`);
    expect(excerptOf(text, { start: 0, end: text.length }, 31)).toBe(`${"a".repeat(29)}😀…`);
    // A piece that starts on the emoji's second half shows the emoji.
    expect(excerptOf(text, { start: 30, end: text.length }, 40)).toBe("😀 and the tide");
  });

  test("of a piece too small for a character takes the character whole", () => {
    const index = new LexicalIndex<number>(1);
    index.add(0, "😀😀");
    expect(index.count).toBe(2);
  });
});
