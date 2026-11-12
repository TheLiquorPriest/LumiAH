// Real folders for the runtimes a test starts: a runtime keeps its connections, its keys and its
// working store in a folder of its own (`RuntimeDeps.dir`), on the disk. Each is a new temporary
// folder, and every one made is removed when the test process ends.

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const made: string[] = [];

process.once("exit", () => {
  for (const dir of made.splice(0)) rmSync(dir, { recursive: true, force: true });
});

/** A new empty folder that only this account may enter, removed when the tests end. */
export function tempFolder(): string {
  const dir = mkdtempSync(join(tmpdir(), "lumiah-runtime-"));
  made.push(dir);
  return dir;
}
