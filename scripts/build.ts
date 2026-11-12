// `bun run build`: the three bundles in dist/, stamped with one build id: the source commit's short
// SHA, marked when the sources have uncommitted changes (their code isn't the commit's, and the
// runtime and the extension compare ids to say when one of them is out of date), or the time when
// there is no git to ask. The id reaches the code as `process.env.LAH_BUILD_ID`, replaced at build
// time, so no bundle reads the environment: Lumiverse's install scan refuses a backend that does.
//
// The runtime is bundled first. Its sha256 and size go into dist/runtime.json, and into the
// backend the same way the id does (`process.env.LAH_RUNTIME_SHA256`, `process.env.LAH_RUNTIME_SIZE`):
// the extension offers the runtime that file as an update, and a runtime takes it only when the
// file it reads hashes to that sha256.

import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

const ROOT = resolve(import.meta.dir, "..");
const seconds = Math.floor(Date.now() / 1000);

function git(args: readonly string[]): string | null {
  const run = Bun.spawnSync(["git", ...args], { cwd: ROOT, stdout: "pipe", stderr: "ignore" });
  return run.exitCode === 0 ? run.stdout.toString().trim() : null;
}

const sha = git(["rev-parse", "--short=8", "HEAD"]);
const dirty = sha !== null && (git(["status", "--porcelain", "--", "src", "package.json", "bun.lock"]) ?? "") !== "";
const id = sha === null ? String(seconds) : dirty ? `${sha}-dirty.${seconds}` : sha;

/** Bundles `entry` to `out`, with the build id and each of `constants` replaced into it as `process.env.<name>`. */
function bundle(entry: string, out: string, target: "bun" | "browser", flags: readonly string[] = [], constants: Readonly<Record<string, string>> = {}): void {
  const defines = Object.entries({ LAH_BUILD_ID: id, ...constants }).flatMap(([name, value]) => ["--define", `process.env.${name}=${JSON.stringify(value)}`]);
  const run = Bun.spawnSync([process.execPath, "build", entry, "--outfile", out, "--target", target, ...flags, ...defines], { cwd: ROOT, stdout: "inherit", stderr: "inherit" });
  if (run.exitCode !== 0) {
    console.error(`build: ${entry} failed`);
    process.exit(1);
  }
}

bundle("src/runtime/main.ts", "dist/lumiah.js", "bun");

// The runtime must start under the Bun that built it.
const version = Bun.spawnSync([process.execPath, "dist/lumiah.js", "--version"], { cwd: ROOT, stdout: "pipe", stderr: "inherit" });
if (version.exitCode !== 0) {
  console.error("build: dist/lumiah.js --version failed");
  process.exit(1);
}

const runtime = readFileSync(resolve(ROOT, "dist/lumiah.js"));
const built = { build: id, file: "lumiah.js", sha256: createHash("sha256").update(runtime).digest("hex"), size: runtime.length };
writeFileSync(resolve(ROOT, "dist/runtime.json"), `${JSON.stringify(built, null, 2)}\n`);

bundle("src/extension/backend/main.ts", "dist/backend.js", "bun", [], { LAH_RUNTIME_SHA256: built.sha256, LAH_RUNTIME_SIZE: String(built.size) });
// Only the page's bundle is minified: every page load fetches it. The backend and the runtime stay
// readable, for the install scan and for stack traces.
bundle("src/extension/frontend/main.tsx", "dist/frontend.js", "browser", ["--minify"]);

console.log(version.stdout.toString().trim());
console.log(`runtime ${built.sha256} (${built.size} bytes)`);
