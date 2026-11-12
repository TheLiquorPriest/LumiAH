// The disk as an update needs it, as Node gives it: what the runtime reads to check an offer, and
// how it writes a file that must never be seen part written (its installed copy, its unit).

import { chmodSync, closeSync, fsyncSync, openSync, readFileSync, realpathSync, renameSync, rmSync, statSync, writeSync } from "node:fs";
import type { UpdateFiles } from "./update";

export const nodeFiles: UpdateFiles = {
  read(path) {
    try {
      return readFileSync(path);
    } catch (error) {
      if (error instanceof Error && "code" in error && error.code === "ENOENT") return null;
      throw error;
    }
  },
  write(path, bytes, mode) {
    const fd = openSync(path, "w", mode);
    try {
      for (let at = 0; at < bytes.length; ) at += writeSync(fd, bytes, at, bytes.length - at);
      // On the disk before it is renamed into place: a crash after the rename finds the whole file there.
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
    // A file left by an earlier try keeps the mode it was made with: this one gets its own.
    chmodSync(path, mode);
  },
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
