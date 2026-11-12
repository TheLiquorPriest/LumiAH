// The disk as the working store uses it (store/index.ts): whole files, each made durable before the
// call that wrote it returns, and a rename that puts a written file in place at once, so a reader
// sees the old file or the new one and a crash leaves one of the two. The store builds every change
// out of these, in an order that a crash between any two of them can't turn into a loss; a test hands
// it a disk that stops between two of them, as a process that dies there would.

import { mkdir, open, readdir, readFile, rename, rm, stat, utimes } from "node:fs/promises";
import { dirname } from "node:path";

export interface Disk {
  /** A file's text (UTF-8); null when there is none. */
  read(path: string): Promise<string | null>;
  /** Writes a file whole and waits until it is on the disk. Not at once: a reader may see it half written, so the store writes a file of its own and `rename`s it into place. */
  write(path: string, text: string): Promise<void>;
  /** Puts a file in another's place at once and waits until the move is on the disk. */
  rename(from: string, to: string): Promise<void>;
  /** Removes a file; one that isn't there is passed over. */
  remove(path: string): Promise<void>;
  /** Removes a folder and everything in it; one that isn't there is passed over. */
  removeAll(path: string): Promise<void>;
  /** What a folder holds, by name; empty when there is no such folder. */
  entries(path: string): Promise<{ name: string; folder: boolean }[]>;
  /** A file's size in bytes and when it was last written or used (ms); null when there is none. */
  stat(path: string): Promise<{ bytes: number; at: number } | null>;
  /** Notes that a file was used at `at` (ms), so the order of use outlives a restart; a file that isn't there is passed over. */
  touch(path: string, at: number): Promise<void>;
  /** Makes a folder, and those above it that are missing. */
  mkdir(path: string): Promise<void>;
}

/** Whether a call failed for want of the file: none there, a folder in its place, or a file where a folder of its path should be. */
function missing(error: unknown): boolean {
  const code = error instanceof Error ? (error as NodeJS.ErrnoException).code : undefined;
  return code === "ENOENT" || code === "ENOTDIR" || code === "EISDIR";
}

/** Waits until the names in a folder (a file renamed into it) are on the disk. A filesystem that can't sync a folder (some network ones) has done what it can by then. */
async function syncFolder(path: string): Promise<void> {
  const folder = await open(path, "r");
  try {
    await folder.sync();
  } catch {
    // Nothing more can be asked of such a filesystem: the rename itself has happened.
  } finally {
    await folder.close();
  }
}

/** The runtime's own disk, through Node's file system. Files and folders are the user's alone (0600, 0700): they hold their chats' documents. */
export function nodeDisk(): Disk {
  return {
    async read(path) {
      try {
        return await readFile(path, "utf8");
      } catch (error) {
        if (missing(error)) return null;
        throw error;
      }
    },
    async write(path, text) {
      const file = await open(path, "w", 0o600);
      try {
        await file.writeFile(text, "utf8");
        await file.sync();
      } finally {
        await file.close();
      }
    },
    async rename(from, to) {
      await rename(from, to);
      await syncFolder(dirname(to));
    },
    async remove(path) {
      await rm(path, { force: true });
    },
    async removeAll(path) {
      await rm(path, { recursive: true, force: true });
    },
    async entries(path) {
      try {
        return (await readdir(path, { withFileTypes: true })).map((entry) => ({ name: entry.name, folder: entry.isDirectory() }));
      } catch (error) {
        if (missing(error)) return [];
        throw error;
      }
    },
    async stat(path) {
      try {
        const found = await stat(path);
        return found.isFile() ? { bytes: found.size, at: found.mtimeMs } : null;
      } catch (error) {
        if (missing(error)) return null;
        throw error;
      }
    },
    async touch(path, at) {
      try {
        await utimes(path, at / 1000, at / 1000);
      } catch (error) {
        if (!missing(error)) throw error;
      }
    },
    async mkdir(path) {
      await mkdir(path, { recursive: true, mode: 0o700 });
    },
  };
}
