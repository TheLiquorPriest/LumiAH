// The programs lumiah runs (systemctl, loginctl, getent, id; Bun, for a new build's version), as
// Node runs them. A program named without a path is found in the system's own folders and never
// through PATH: a folder in PATH that another account can write would otherwise choose the program
// that runs as this account, and `getent` runs inside the very check that refuses such files.

import { execFile } from "node:child_process";
import { existsSync } from "node:fs";

/** Where a system keeps its own programs, in the order they are looked for. */
export const SYSTEM_FOLDERS: readonly string[] = ["/usr/bin", "/bin", "/usr/sbin", "/sbin"];

/** A program's file: an absolute path as it is, else the first of the system's folders that holds it; null when none does. */
export function programPath(command: string, exists: (path: string) => boolean): string | null {
  if (command.startsWith("/") || /^[A-Za-z]:[\\/]/.test(command)) return command;
  for (const folder of SYSTEM_FOLDERS) if (exists(`${folder}/${command}`)) return `${folder}/${command}`;
  return null;
}

/** How a program that was run ended: what it said, its exit code (127: it couldn't be run, or it didn't end by itself), the signal that ended it where something other than this process's own time limit did, and whether that time limit ended it (`late`). */
export interface Ran {
  code: number;
  out: string;
  err: string;
  signal?: string;
  late?: true;
}

/** Runs a program with `env` over this process's environment, for at most `timeoutMs` when given; what it said and how it ended. */
export function runProgram(command: string, args: readonly string[], env?: Readonly<Record<string, string>>, timeoutMs?: number): Promise<Ran> {
  const file = programPath(command, existsSync);
  if (file === null) return Promise.resolve({ code: 127, out: "", err: `${command} isn't in ${SYSTEM_FOLDERS.join(", ")}` });
  const { promise, resolve } = Promise.withResolvers<Ran>();
  execFile(file, [...args], { encoding: "utf8", ...(env !== undefined ? { env: { ...process.env, ...env } } : {}), ...(timeoutMs !== undefined ? { timeout: timeoutMs } : {}) }, (error, out, err) => {
    const code = error === null ? 0 : typeof error.code === "number" ? error.code : 127;
    const why = error !== null && error.killed === true ? `${command} was ended after ${Math.round((timeoutMs ?? 0) / 1000)} seconds` : error !== null && typeof error.code !== "number" ? error.message : "";
    const signal = error !== null && error.killed !== true && typeof error.signal === "string" ? error.signal : undefined;
    resolve({ code, out, err: err || why, ...(signal !== undefined ? { signal } : {}), ...(error !== null && error.killed === true ? { late: true as const } : {}) });
  });
  return promise;
}
