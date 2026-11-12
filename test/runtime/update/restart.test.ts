// How a runtime no unit runs hands its process to its successor: where the system can replace a
// process's program, the successor is this very process (so a terminal, launchd or a container
// keeps watching the same process); elsewhere it is started on its own, and this process leaves.
// When no successor starts, the runtime says so, with the line that starts it.

import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { handOver, nodeProcess, type ProcessControl, type Successor } from "../../../src/runtime/update/restart";

const NEXT: Successor = { command: "/opt/bun/bin/bun", args: ["/home/mara/.local/share/lumiah/lumiah.js", "serve", "--config", "/home/mara/.config/lumiah/mara.json"] };

/** A process that records what it is asked: replaced (where `execve` is given), a program started beside it, its exit. */
function processOn(platform: string, change: { execve?: ProcessControl["execve"]; spawn?: ProcessControl["spawn"] } = {}) {
  const asked: string[] = [];
  const control: ProcessControl = {
    platform,
    env: { HOME: "/home/mara", PATH: "/usr/bin", UNSET: undefined },
    execve:
      change.execve === undefined
        ? (file, args, env) => {
            asked.push(`execve ${file} ${args.join(" ")} (${Object.keys(env).join(", ")})`);
          }
        : change.execve,
    spawn:
      change.spawn ??
      (async (command, args) => {
        asked.push(`spawn ${command} ${args.join(" ")}`);
      }),
    exit: (code) => void asked.push(`exit ${code}`),
  };
  return { asked, control };
}

let dir: string | null = null;
afterEach(() => {
  if (dir !== null) rmSync(dir, { recursive: true, force: true });
  dir = null;
});

describe("handing the runtime's process to its successor", () => {
  test("replaces this process's program where the system can, with the same environment, and nothing else is done", async () => {
    const { asked, control } = processOn("darwin");
    await handOver(NEXT, control);
    expect(asked).toEqual([`execve /opt/bun/bin/bun /opt/bun/bin/bun ${NEXT.args.join(" ")} (HOME, PATH)`]);
  });

  test("on Windows, which has no such thing, starts the successor on its own and leaves", async () => {
    const { asked, control } = processOn("win32");
    await handOver(NEXT, control);
    expect(asked).toEqual([`spawn /opt/bun/bin/bun ${NEXT.args.join(" ")}`, "exit 0"]);
  });

  test("where replacing the program fails, starts the successor beside it and leaves", async () => {
    const { asked, control } = processOn("linux", {
      execve: () => {
        throw new Error("E2BIG: argument list too long, execve");
      },
    });
    await handOver(NEXT, control);
    expect(asked).toEqual([`spawn /opt/bun/bin/bun ${NEXT.args.join(" ")}`, "exit 0"]);
  });

  test("where no successor starts, stays, and says why with the line that starts it", async () => {
    const { asked, control } = processOn("win32", {
      spawn: async () => {
        throw new Error("spawn /opt/bun/bin/bun ENOENT");
      },
    });
    await expect(handOver(NEXT, control)).rejects.toThrow(`The runtime couldn't start its new build (spawn /opt/bun/bin/bun ENOENT). Start it with: /opt/bun/bin/bun ${NEXT.args.join(" ")}`);
    expect(asked).toEqual([]);
  });

  test("the machine's own way starts a successor that runs on its own, and says when one can't start", async () => {
    dir = realpathSync(mkdtempSync(join(tmpdir(), "lumiah-successor-")));
    const mark = join(dir, "started");
    await nodeProcess().spawn(process.execPath, ["-e", `require("node:fs").writeFileSync(${JSON.stringify(mark)}, String(process.pid))`]);
    // The successor is cut loose from this process, which keeps no handle to await: the mark it writes on the disk once it runs is looked for until it shows.
    for (let waited = 0; !existsSync(mark) && waited < 200; waited++) await Bun.sleep(25);
    expect(Number(readFileSync(mark, "utf8"))).not.toBe(process.pid);

    await expect(nodeProcess().spawn(join(dir, "no-such-bun"), [])).rejects.toMatchObject({ code: "ENOENT" });
  });
});
