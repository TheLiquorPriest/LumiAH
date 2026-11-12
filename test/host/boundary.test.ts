// The shared reads' boundary (PI-BUILD-PLAN §4.5): `src/host/` is imported by the extension's
// backend and by the runtime alike, so it reaches nothing either side may lack and nothing
// Lumiverse's install scan refuses in a backend: no Spindle, no filesystem, no database, no socket,
// no model library. It imports only the core, the link's plain code, and itself.

import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";

const ROOT = resolve(import.meta.dir, "../..");
const HOST = join(ROOT, "src/host");
/** Where an import from `src/host/` may lead. */
const ALLOWED = ["src/host", "src/core", "src/link"].map((dir) => join(ROOT, dir));

/** Every module a source file names: an `import … from` or `export … from` statement, a bare `import "…"`, and `import("…")`. */
function specifiers(source: string): string[] {
  const statements = /^\s*(?:import|export)\b[^;"'`=()[\]]*?\bfrom\s*["']([^"']+)["']/gm;
  const bare = /^\s*import\s*["']([^"']+)["']/gm;
  const dynamic = /\bimport\s*\(\s*["']([^"']+)["']\s*\)/g;
  return [statements, bare, dynamic].flatMap((pattern) => [...source.matchAll(pattern)].map((m) => m[1] ?? ""));
}

/** A source file without its comments: what it says about a thing it doesn't use is no use of it. */
const code = (source: string): string => source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");

const sources = readdirSync(HOST)
  .filter((name) => name.endsWith(".ts"))
  .map((name) => ({ path: `src/host/${name}`, dir: HOST, source: readFileSync(join(HOST, name), "utf8") }));

describe("src/host", () => {
  test("has the shared reads", () => {
    expect(sources.map((s) => s.path).sort()).toEqual(["src/host/chat.ts", "src/host/lore.ts", "src/host/recall.ts", "src/host/refused.ts", "src/host/rows.ts"]);
  });

  test("imports only the core, the link's plain code and itself", () => {
    const outside = sources.flatMap((s) =>
      specifiers(s.source)
        .filter((spec) => {
          if (!spec.startsWith(".")) return true;
          const target = resolve(s.dir, spec);
          return !ALLOWED.some((dir) => !relative(dir, target).startsWith(".."));
        })
        .map((spec) => `${s.path} imports ${spec}`),
    );
    expect(outside).toEqual([]);
  });

  test("leads to nothing that reaches Spindle, the disk, a database, a socket or a model library", () => {
    // What it imports of the link and the core, followed through: the link's plain code must not reach the runtime's parts either.
    const seen = new Set<string>();
    const reached: string[] = [];
    const visit = (file: string): void => {
      if (seen.has(file)) return;
      seen.add(file);
      const source = readFileSync(file, "utf8");
      for (const spec of specifiers(source)) {
        if (!spec.startsWith(".")) {
          reached.push(`${relative(ROOT, file)} imports ${spec}`);
          continue;
        }
        const target = resolve(dirname(file), spec);
        visit(target.endsWith(".ts") ? target : `${target}.ts`);
      }
    };
    for (const s of sources) visit(join(ROOT, s.path));
    expect(reached).toEqual([]);
    expect([...seen].map((file) => relative(ROOT, file)).filter((path) => !path.startsWith("src/host/") && !path.startsWith("src/core/") && !path.startsWith("src/link/"))).toEqual([]);
  });

  test("uses no Node or Bun API, no Spindle and no network", () => {
    const refused: [what: string, pattern: RegExp][] = [
      ["Bun", /\bBun\./],
      ["process", /\bprocess\./],
      ["require", /\brequire\s*\(/],
      ["a node: or bun: module", /["'](?:node|bun):/],
      ["Spindle", /\bspindle\b/],
      ["a network call", /\bfetch\s*\(/],
      ["a socket", /\bWebSocket\b/],
    ];
    const used = sources.flatMap((s) => refused.filter(([, pattern]) => pattern.test(code(s.source))).map(([what]) => `${s.path} uses ${what}`));
    expect(used).toEqual([]);
  });
});
