// How lumiah writes a file that holds what matters (its config with the runtime's session and
// secret, its installed copy, its unit), and how it runs a program, on the machine's own disk and
// programs: a file is written as a new one, never through whatever someone else left at its name,
// with its mode from the start; a program named without a path is the system's own, never one a
// folder in PATH puts first.

import { afterEach, describe, expect, test } from "bun:test";
import { chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { writeAnew } from "../../../src/runtime/update/files";
import { programPath, runProgram, SYSTEM_FOLDERS } from "../../../src/runtime/update/programs";

let dir: string | null = null;
afterEach(() => {
  if (dir !== null) rmSync(dir, { recursive: true, force: true });
  dir = null;
});

function folder(): string {
  dir = realpathSync(mkdtempSync(join(tmpdir(), "lumiah-files-")));
  return dir;
}

describe("a file written anew", () => {
  test("is a new file with exactly its mode, whatever was left at its name", () => {
    const at = folder();
    const path = join(at, "mara.json.4242.tmp");
    // Left by a crash, or made by someone else first: open to everyone.
    writeFileSync(path, "what was there");
    chmodSync(path, 0o666);
    writeAnew(path, '{"secret":"a"}', 0o600);
    expect(readFileSync(path, "utf8")).toBe('{"secret":"a"}');
    expect(statSync(path).mode & 0o777).toBe(0o600);
  });

  test("never writes through a link someone put at its name: the file the link leads to stays as it was", () => {
    const at = folder();
    const theirs = join(at, "theirs.txt");
    writeFileSync(theirs, "someone else's file");
    const path = join(at, "lumiah.js.mara.tmp");
    symlinkSync(theirs, path);
    writeAnew(path, new TextEncoder().encode("// LumiAH's runtime\n"), 0o644);
    expect(readFileSync(theirs, "utf8")).toBe("someone else's file");
    expect(lstatSync(path).isSymbolicLink()).toBe(false);
    expect(readFileSync(path, "utf8")).toBe("// LumiAH's runtime\n");
  });

  test("fails rather than write into a folder at its name", () => {
    const at = folder();
    const path = join(at, "mara.json.4242.tmp");
    mkdirSync(path);
    expect(() => writeAnew(path, "text", 0o600)).toThrow();
    expect(statSync(path).isDirectory()).toBe(true);
  });
});

describe("a program lumiah runs", () => {
  test("named without a path is found in the system's own folders only, in their order; an absolute one is taken as it is", () => {
    const on = new Set(["/bin/systemctl", "/usr/bin/systemctl", "/sbin/getent"]);
    expect(programPath("systemctl", (path) => on.has(path))).toBe("/usr/bin/systemctl");
    expect(programPath("getent", (path) => on.has(path))).toBe("/sbin/getent");
    expect(programPath("loginctl", (path) => on.has(path))).toBeNull();
    expect(programPath("/opt/bun/bin/bun", () => false)).toBe("/opt/bun/bin/bun");
    expect(SYSTEM_FOLDERS).toEqual(["/usr/bin", "/bin", "/usr/sbin", "/sbin"]);
  });

  test("is never one that a folder in PATH puts first", async () => {
    const at = folder();
    const mark = join(at, "ran");
    // A folder in PATH another account could write, holding a program of the same name.
    for (const name of ["getent", "id"]) {
      writeFileSync(join(at, name), `#!/bin/sh\necho planted > ${JSON.stringify(mark)}\n`);
      chmodSync(join(at, name), 0o755);
    }
    const env = { PATH: `${at}:${process.env.PATH ?? ""}` };
    await runProgram("getent", ["group", "0"], env);
    const id = await runProgram("id", ["-u"], env);
    expect(existsSync(mark)).toBe(false);
    // The system's own `id` answered.
    expect(id.code).toBe(0);
    expect(id.out.trim()).toBe(String(process.getuid?.() ?? ""));
  });

  test("not in the system's folders isn't run, and says where it was looked for", async () => {
    expect(await runProgram("no-such-program-of-lumiah", [])).toEqual({ code: 127, out: "", err: "no-such-program-of-lumiah isn't in /usr/bin, /bin, /usr/sbin, /sbin" });
  });
});
