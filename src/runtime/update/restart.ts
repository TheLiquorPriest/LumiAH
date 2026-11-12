// How a runtime that no unit runs starts again on its new build. Once it has ended what it serves,
// as a stop does (each reply under way ends in words the chat shows), it hands its process to its
// successor: the same Bun, on the same file, serving the same config. Where the system can replace
// a process's program (execve, on Linux and macOS), the successor is this very process, so whatever
// watches it (a terminal, launchd, a container) sees nothing change and keeps watching it. Elsewhere
// (Windows) the successor is started on its own, and this process leaves.

import { spawn } from "node:child_process";
import { shellWord } from "../../link/contract";

/** What a runtime's successor runs: `command` (its Bun) with `args` (its file, `serve`, `--config`, its config). */
export interface Successor {
  command: string;
  args: string[];
}

/** The process as a hand-over needs it; `nodeProcess()` is the one the runtime runs in. */
export interface ProcessControl {
  platform: string;
  env: Readonly<Record<string, string | undefined>>;
  /** Replaces this process's program and keeps its id (execve(2)); null where the system has none. It returns only by throwing. */
  execve: ((file: string, args: string[], env: Record<string, string>) => void) | null;
  /** Starts a program that outlives this process; resolves once it has started. */
  spawn(command: string, args: readonly string[]): Promise<void>;
  exit(code: number): void;
}

/**
 * Hands this process to its successor. When this process becomes it, nothing after that runs here;
 * when the successor is started beside it, this process exits. It returns by throwing only, when no
 * successor could be started, in words that say why and the line that starts the runtime by hand.
 */
export async function handOver(next: Successor, process: ProcessControl): Promise<void> {
  let replacing: unknown = null;
  if (process.execve !== null && process.platform !== "win32") {
    const env: Record<string, string> = {};
    for (const [key, value] of Object.entries(process.env)) if (value !== undefined) env[key] = value;
    try {
      process.execve(next.command, [next.command, ...next.args], env);
      // Replaced: the successor runs in this process now, and nothing else is to be done.
      return;
    } catch (error) {
      // execve(2) failed and left this process as it was: the successor is started beside it instead.
      replacing = error;
    }
  }
  try {
    await process.spawn(next.command, next.args);
  } catch (error) {
    const why = [replacing, error].filter((e) => e !== null).map((e) => (e instanceof Error ? e.message : String(e)));
    throw new Error(`The runtime couldn't start its new build (${why.join("; ")}). Start it with: ${[next.command, ...next.args].map(shellWord).join(" ")}`);
  }
  process.exit(0);
}

/** The process the runtime runs in, as Node gives it. */
export function nodeProcess(): ProcessControl {
  const own = globalThis.process;
  return {
    platform: own.platform,
    env: own.env,
    execve: own.execve?.bind(own) ?? null,
    spawn(command, args) {
      const { promise, resolve, reject } = Promise.withResolvers<void>();
      // Its own process group (on Windows, its own hidden console) and nothing shared with this one: it lives on when this one exits.
      const child = spawn(command, [...args], { detached: true, stdio: "ignore", windowsHide: true });
      child.once("error", reject);
      child.once("spawn", () => {
        child.unref();
        resolve();
      });
      return promise;
    },
    exit: (code) => own.exit(code),
  };
}
