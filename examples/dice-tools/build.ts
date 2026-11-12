// `bun run build`: the extension's three bundles in dist/. LumiAH's runtime goes first. Built from
// the package's own source, it is the program a user runs beside Lumiverse for this extension (the
// lines on its Runtime page name `--extension dice_tools`), and it updates itself from this very
// file. Its sha256 and size go into the backend, which offers the file to a runtime on another
// build. Every constant is put in when the bundle is made (`--define`), never read at run time:
// Lumiverse's install scan refuses a backend that reads the environment. And no bundle takes a file
// from outside this folder, so a bundle holds the same code wherever it is built.

import { createHash } from "node:crypto";
import { readFileSync, rmSync } from "node:fs";
import { isAbsolute, relative, resolve } from "node:path";

/** This build of the extension, and of the runtime it ships: the Runtime page says when a runtime runs another. */
const BUILD = "dice-tools-0.1.0";

/** Packages a bundle asks for that this folder leaves uninstalled on purpose: `supports-color`, which a library under the runtime's Google SDK asks for only to colour its own debug lines, and does without. Bun would otherwise take it from any `node_modules` above this folder. */
const LEFT_OUT = ["supports-color"];

/** Bundles `entry` to `out`, with each of `constants` put in as `process.env.<name>`, and fails if it took a file from outside this folder. */
function bundle(entry: string, out: string, target: "bun" | "browser", constants: Record<string, string>, flags: string[] = []): void {
  const defines = Object.entries(constants).flatMap(([name, value]) => ["--define", `process.env.${name}=${JSON.stringify(value)}`]);
  const left = LEFT_OUT.flatMap((name) => ["--external", name]);
  const meta = `${out}.meta.json`;
  const run = Bun.spawnSync([process.execPath, "build", entry, "--outfile", out, "--target", target, ...flags, ...left, `--metafile=${meta}`, ...defines], { stdout: "inherit", stderr: "inherit" });
  if (run.exitCode !== 0) throw new Error(`build: ${entry} failed`);
  const inputs = Object.keys(JSON.parse(readFileSync(meta, "utf8")).inputs as Record<string, unknown>);
  rmSync(meta);
  const outside = inputs.filter((path) => {
    const from = relative(".", resolve(path));
    return from.startsWith("..") || isAbsolute(from);
  });
  if (outside.length > 0) throw new Error(`build: ${out} took ${outside.join(", ")} from outside this folder: install it here, or add it to LEFT_OUT if nothing needs it`);
}

// The runtime, as LumiAH builds its own. It carries its model layer (pi-ai) inside it, which is why
// package.json pins pi-ai as LumiAH pins it. `--ignore-dce-annotations` is LumiAH's own flag for
// this bundle (its scripts/bundle-flags.ts says why): without it Bun's bundler leaves some of
// pi-ai's modules unstarted, and the runtime fails at the end of an agent's session.
bundle("node_modules/lumi-ah/src/runtime/main.ts", "dist/lumiah.js", "bun", { LAH_BUILD_ID: BUILD }, ["--ignore-dce-annotations"]);
// It must start under the Bun that built it.
if (Bun.spawnSync([process.execPath, "dist/lumiah.js", "--version"]).exitCode !== 0) throw new Error("build: dist/lumiah.js doesn't start");
const runtime = readFileSync("dist/lumiah.js");
bundle("src/backend.ts", "dist/backend.js", "bun", { LAH_BUILD_ID: BUILD, LAH_RUNTIME_SHA256: createHash("sha256").update(runtime).digest("hex"), LAH_RUNTIME_SIZE: String(runtime.length) });
bundle("src/frontend.ts", "dist/frontend.js", "browser", {}, ["--minify"]);
