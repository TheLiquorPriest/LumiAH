// An agent's words as a reader sees them: the markdown agents write is read into headings, lists
// and paragraphs, and a notice or a row gets a first line with no marks in it.

import { describe, expect, test } from "bun:test";
import { inlineOf, plainLine, plainWords, proseOf } from "../../src/extension/frontend/prose-model";

const REPORT = "Stopped at my budget, with replies #1 to #31 read.\n\n## What I did\n- Wrote **learned/story.md**: who is who.\n- Started the roster as a job of its own.\n\n## What is left\n1. Replies #32 to #47.\n2. Not verified: when the lock was changed.";

describe("an agent's text as prose", () => {
  test("a report reads as an opening, headings and lists, not as marks", () => {
    const blocks = proseOf(REPORT);
    expect(blocks.map((b) => b.kind)).toEqual(["para", "heading", "list", "heading", "list"]);
    expect(blocks[1]).toEqual({ kind: "heading", level: 2, inline: [{ text: "What I did" }] });
    expect(blocks[2]).toMatchObject({ kind: "list", ordered: false, items: [[{ text: "Wrote " }, { strong: "learned/story.md" }, { text: ": who is who." }], [{ text: "Started the roster as a job of its own." }]] });
    expect(blocks[4]).toMatchObject({ kind: "list", ordered: true });
  });

  test("bold, italic and code are read within a line; a citation and a lone star stay as written", () => {
    expect(inlineOf("Brann holds the *only* key `notes/ledger.md` [#40 5bac]")).toEqual([{ text: "Brann holds the " }, { em: "only" }, { text: " key " }, { code: "notes/ledger.md" }, { text: " [#40 5bac]" }]);
    expect(inlineOf("2 * 3 is six")).toEqual([{ text: "2 * 3 is six" }]);
    expect(inlineOf("a_file_name.md")).toEqual([{ text: "a_file_name.md" }]);
  });

  test("a paragraph keeps its lines apart, and a block of code is kept as written", () => {
    expect(proseOf("Joss wiped the counter.\nThen he looked up.")).toEqual([{ kind: "para", lines: [[{ text: "Joss wiped the counter." }], [{ text: "Then he looked up." }]] }]);
    expect(proseOf("Before\n```\n# not a heading\n- not a list\n```\nAfter").map((b) => (b.kind === "code" ? b.text : b.kind))).toEqual(["para", "# not a heading\n- not a list", "para"]);
    expect(proseOf("")).toEqual([]);
  });
});

describe("a text in one line", () => {
  test("the first line of words, with no marks", () => {
    expect(plainLine(REPORT)).toBe("Stopped at my budget, with replies #1 to #31 read.");
    expect(plainLine("## What I did\n- Wrote the file.")).toBe("What I did");
    expect(plainLine("\n\n- **Done**: the roster.")).toBe("Done: the roster.");
    expect(plainLine("  \n")).toBe("");
  });

  test("a sentence that quotes a report loses the marks and the line breaks, not the words", () => {
    expect(plainWords('The job "Start the timeline" finished: ## What I did\n- Wrote **14 lines**, one a reply.')).toBe('The job "Start the timeline" finished: What I did Wrote 14 lines, one a reply.');
  });
});
