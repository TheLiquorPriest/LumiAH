// `bun run build`: the three bundles in dist/, stamped with one build id: the source commit's short
// SHA, marked when the sources have uncommitted changes (their code isn't the commit's, and the
// runtime and the extension compare ids to say when one of them is out of date), or the time when
// there is no git to ask. The id reaches the code as `process.env.LAH_BUILD_ID`, replaced at build
// time, so no bundle reads the environment: Lumiverse's install scan refuses a backend that does.

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

function bundle(entry: string, out: string, target: "bun" | "browser"): void {
  const run = Bun.spawnSync([process.execPath, "build", entry, "--outfile", out, "--target", target, "--define", `process.env.LAH_BUILD_ID=${JSON.stringify(id)}`], { cwd: ROOT, stdout: "inherit", stderr: "inherit" });
  if (run.exitCode !== 0) {
    console.error(`build: ${entry} failed`);
    process.exit(1);
  }
}

bundle("src/extension/backend/main.ts", "dist/backend.js", "bun");
bundle("src/extension/frontend/main.tsx", "dist/frontend.js", "browser");
bundle("src/runtime/main.ts", "dist/lumiah.js", "bun");

// The runtime must start under the Bun that built it.
const version = Bun.spawnSync([process.execPath, "dist/lumiah.js", "--version"], { cwd: ROOT, stdout: "pipe", stderr: "inherit" });
if (version.exitCode !== 0) {
  console.error("build: dist/lumiah.js --version failed");
  process.exit(1);
}
console.log(version.stdout.toString().trim());
