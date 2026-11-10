// The core's boundary (DESIGN §1): core imports nothing outside `src/core/`, and uses no Node or Bun
// API beyond what both a worker and a process have. This fails the moment a file under `src/core`
// reaches for anything else. The extension backend bundles parts of the core, so what Lumiverse's
// install scan refuses in a backend is refused here too.

import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";

const ROOT = resolve(import.meta.dir, "../..");
const CORE = join(ROOT, "src/core");

function files(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => (entry.isDirectory() ? files(join(dir, entry.name)) : entry.name.endsWith(".ts") ? [join(dir, entry.name)] : []));
}

/** Every module a source file names: an `import … from` or `export … from` statement, a bare `import "…"`, and `import("…")`. */
function specifiers(source: string): string[] {
  const statements = /^\s*(?:import|export)\b[^;]*?\bfrom\s*["']([^"']+)["']/gm;
  const bare = /^\s*import\s*["']([^"']+)["']/gm;
  const dynamic = /\bimport\s*\(\s*["']([^"']+)["']\s*\)/g;
  return [statements, bare, dynamic].flatMap((pattern) => [...source.matchAll(pattern)].map((m) => m[1] ?? ""));
}

/** A source file without its comments: what it says about a thing it doesn't use is no use of it. */
function code(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
}

const sources = files(CORE).map((path) => ({ path: relative(ROOT, path), dir: dirname(path), source: readFileSync(path, "utf8") }));

describe("src/core", () => {
  test("has the files this test reads", () => {
    expect(sources.length).toBeGreaterThan(15);
    expect(sources.map((s) => s.path)).toContain("src/core/harness.ts");
  });

  test("imports nothing outside src/core", () => {
    const outside = sources.flatMap((s) =>
      specifiers(s.source)
        .filter((spec) => !spec.startsWith(".") || relative(CORE, resolve(s.dir, spec)).startsWith(".."))
        .map((spec) => `${s.path} imports ${spec}`),
    );
    expect(outside).toEqual([]);
  });

  test("uses no Node or Bun API, and nothing Lumiverse's install scan refuses in a backend", () => {
    const refused: [what: string, pattern: RegExp][] = [
      ["Bun", /\bBun\./],
      ["process", /\bprocess\./],
      ["require", /\brequire\s*\(/],
      ["a node: module", /["']node:/],
      ["Buffer", /\bBuffer\./],
      ["eval", /\beval\s*\(/],
      ["the Function constructor", /Function\(/],
      ["a network call", /\bfetch\s*\(/],
    ];
    const used = sources.flatMap((s) => refused.filter(([, pattern]) => pattern.test(code(s.source))).map(([what]) => `${s.path} uses ${what}`));
    expect(used).toEqual([]);
  });

  test("is typechecked without Node's or Bun's types", () => {
    const config = JSON.parse(readFileSync(join(ROOT, "tsconfig.core.json"), "utf8")) as { compilerOptions: { types: string[]; lib: string[] }; include: string[] };
    expect(config.compilerOptions.types).toEqual([]);
    expect(config.compilerOptions.lib).not.toContain("DOM");
    expect(config.include).toEqual(["src/core"]);
  });
});
