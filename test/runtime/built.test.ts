// The runtime's code as its bundle holds it, not as the other tests run it. They run the sources,
// where every module a file imports has started before the file does. A bundle is another program:
// Bun's bundler starts some modules lazily, and one the bundle never starts leaves the functions
// it exports with nothing behind them. This builds with the flags the build gives the runtime's
// bundle (scripts/bundle-flags.ts) and runs what it built in a process of its own.

import { expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { LEFT_OUT, RUNTIME_FLAGS } from "../../scripts/bundle-flags";

const ROOT = resolve(import.meta.dir, "../..");

/** Bundles `source` as the runtime is bundled and runs it; what it printed, and what it said went wrong. */
function built(source: string): { out: string; err: string; code: number | null } {
  const scratch = mkdtempSync(join(tmpdir(), "lumiah-built-"));
  try {
    const entry = join(scratch, "entry.ts");
    const bundle = join(scratch, "entry.js");
    writeFileSync(entry, source);
    const made = Bun.spawnSync([process.execPath, "build", entry, "--outfile", bundle, "--target", "bun", ...RUNTIME_FLAGS, ...LEFT_OUT.flatMap((name) => ["--external", name])], { cwd: ROOT, stdout: "pipe", stderr: "pipe" });
    if (made.exitCode !== 0) return { out: "", err: made.stderr.toString(), code: made.exitCode };
    const ran = Bun.spawnSync([process.execPath, bundle, scratch], { cwd: scratch, stdout: "pipe", stderr: "pipe" });
    return { out: ran.stdout.toString().trim(), err: ran.stderr.toString().trim(), code: ran.exitCode };
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}

test("an agent's session ends cleanly on a runtime that has called no provider yet", () => {
  // The model layer exactly as the runtime makes it, and the one thing a turn's end asks of it. A runtime whose connections are all of one provider never loads the others' code: whatever that code would have started must not be needed to end a session.
  const ran = built(
    [
      `import { createModelLayer } from ${JSON.stringify(join(ROOT, "src/runtime/models/index.ts"))};`,
      "const layer = createModelLayer({ dir: process.argv[2] ?? '.', now: () => Date.now(), id: () => crypto.randomUUID(), uuid: () => crypto.randomUUID(), log: () => {}, fetch, setTimeout, clearTimeout, caching: () => ({}), passConnection: async () => null, env: {} });",
      'layer.models.ended?.("a session");',
      'console.log("ended");',
      "process.exit(0);",
    ].join("\n"),
  );
  expect(ran).toEqual({ out: "ended", err: "", code: 0 });
}, 60_000);
