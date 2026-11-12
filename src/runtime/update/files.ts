// The disk as an update needs it, as Node gives it: what the runtime reads to check an offer, and
// how it writes a file that must never be seen part written (its installed copy, its unit). A file
// it writes is made anew, so nothing another account put at that name is ever written through: a
// stale one is removed first, and the new one is opened only if nothing has taken the name since.

import { chmodSync, closeSync, fsyncSync, openSync, readFileSync, realpathSync, renameSync, rmSync, statSync, writeSync } from "node:fs";
import type { UpdateFiles } from "./update";

/**
 * Writes a file whole, as a new file with `mode`, and flushes it to the disk. What is at `path`
 * already (a temporary file a crash left, or a file or link someone else put there) is removed, and
 * the file is then opened only as a new one (`wx`): if anything took the name in between, it fails
 * rather than write into it. The mode is set as it is made (the umask can only narrow it), then
 * made exact.
 */
export function writeAnew(path: string, data: Uint8Array | string, mode: number): void {
  rmSync(path, { force: true });
  const fd = openSync(path, "wx", mode);
  try {
    const bytes = typeof data === "string" ? new TextEncoder().encode(data) : data;
    for (let at = 0; at < bytes.length; ) at += writeSync(fd, bytes, at, bytes.length - at);
    // On the disk before it is renamed into place: a crash after the rename finds the whole file there.
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  chmodSync(path, mode);
}

export const nodeFiles: UpdateFiles = {
  read(path) {
    try {
      return readFileSync(path);
    } catch (error) {
      if (error instanceof Error && "code" in error && error.code === "ENOENT") return null;
      throw error;
    }
  },
  write: writeAnew,
  // Mode bits are POSIX's: Windows has none to keep.
  mode(path) {
    if (process.platform === "win32") return null;
    try {
      return statSync(path).mode & 0o7777;
    } catch {
      return null;
    }
  },
  rename: (from, to) => renameSync(from, to),
  remove: (path) => rmSync(path, { force: true }),
  real: (path) => realpathSync(path),
};
