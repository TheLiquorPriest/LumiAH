// `docs/EXTENDING.md` says every code block of its is taken from `examples/`. This holds it to that:
// each fenced block of code (js, ts, json) must stand, line for line, in one of the examples' files,
// whatever it is indented by there. An example that changes without its walk-through fails here.

import { describe, expect, test } from "bun:test";
import { resolve } from "node:path";

const ROOT = resolve(import.meta.dir, "../..");
const SOURCES = ["examples/mcp-tide-table/tide-table.js", "examples/dice-tools/src/dice.ts", "examples/dice-tools/src/backend.ts", "examples/dice-tools/src/frontend.ts", "examples/dice-tools/build.ts", "examples/dice-tools/spindle.json", "examples/dice-tools/package.json"];

/** A text's lines without their indentation, blank lines left out. */
const linesOf = (text: string): string[] =>
  text
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line !== "");

/** Whether `block` stands in `file` as one run of lines. */
function standsIn(block: readonly string[], file: readonly string[]): boolean {
  for (let at = 0; at + block.length <= file.length; at++) if (block.every((line, i) => file[at + i] === line)) return true;
  return false;
}

describe("docs/EXTENDING.md", () => {
  test("every block of code in it is in one of the examples, as it stands there", async () => {
    const doc = await Bun.file(resolve(ROOT, "docs/EXTENDING.md")).text();
    const files = await Promise.all(SOURCES.map(async (path) => linesOf(await Bun.file(resolve(ROOT, path)).text())));
    const blocks = [...doc.matchAll(/^```(js|ts|json)\n([\s\S]*?)^```$/gm)].map((found) => found[2] ?? "");
    expect(blocks.length).toBeGreaterThan(10);
    const astray = blocks.filter((block) => !files.some((file) => standsIn(linesOf(block), file))).map((block) => block.split("\n")[0]);
    expect(astray).toEqual([]);
  });

  test("names only files and pages there are", async () => {
    const doc = await Bun.file(resolve(ROOT, "docs/EXTENDING.md")).text();
    for (const path of ["examples/mcp-tide-table/README.md", "examples/dice-tools/README.md", "test/examples/dice-tools.test.ts", "test/runtime/mounting.test.ts", "docs/RUNTIME.md"]) expect([path, await Bun.file(resolve(ROOT, path)).exists()]).toEqual([path, true]);
    expect(doc).toContain("test/examples/dice-tools.test.ts");
    expect(doc).toContain("test/runtime/mounting.test.ts");
  });
});
