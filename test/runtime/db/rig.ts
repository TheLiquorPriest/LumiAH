// What the database reader's tests run it on (src/runtime/db): a folder of their own holding a
// Lumiverse database built from schema.sql, in WAL mode as Lumiverse keeps it, with a connection of its
// own that writes as Lumiverse's do (left open, as Lumiverse's are, so the file keeps its `-wal` and
// `-shm`). Its rows come from the made-up Lumiverse of the copy's tests (../copy/lumiverse.ts), copied
// in as they stand, so one set of invented rows can be read both over that Lumiverse's HTTP routes and
// from the file. Every chat, book, name and text here is invented.

import { Database } from "bun:sqlite";
import { chmodSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHttpSource } from "../../../src/runtime/copy/http";
import type { CopySource, SourceBook, SourceChat } from "../../../src/runtime/copy/source";
import { createDbSource, type DbSource, type DbSourceDeps } from "../../../src/runtime/db";
import type { Lumiverse } from "../copy/lumiverse";

export const USER = "user-mara";
export const OTHER = "user-ilse";
/** LumiAH's own identifier: its entry in a message's extension metadata is the one read. */
export const LUMIAH = "lumi_ah";

/** The schema file as it is: a test that needs another schema builds one from it. */
export const SCHEMA = readFileSync(join(import.meta.dir, "schema.sql"), "utf8");

const folders: string[] = [];

/** A Lumiverse database file and the connection Lumiverse writes it with. */
export interface LumiverseFile {
  folder: string;
  path: string;
  writer: Database;
}

/**
 * A database built from schema.sql, with Lumiverse's connection to it open. In WAL mode as Lumiverse
 * keeps it, with its own checkpoints off (Lumiverse checkpoints from a process of its own, on a timer),
 * so the `-wal` holds what was written until a test checkpoints it; or in rollback mode, where a
 * writer can lock readers out.
 */
export function lumiverseFile(options: { journal?: "wal" | "delete"; schema?: string } = {}): LumiverseFile {
  const folder = mkdtempSync(join(tmpdir(), "lumiah-db-"));
  folders.push(folder);
  const path = join(folder, "lumiverse.db");
  const writer = new Database(path, { create: true });
  if (options.journal === "delete") writer.run("PRAGMA journal_mode = DELETE");
  else writer.run("PRAGMA journal_mode = WAL; PRAGMA wal_autocheckpoint = 0");
  writer.run(options.schema ?? SCHEMA);
  return { folder, path, writer };
}

/** Removes every folder the tests made, giving back any permission a test took away first. */
export function removeFiles(): void {
  for (const folder of folders.splice(0)) {
    chmodSync(folder, 0o755);
    rmSync(folder, { recursive: true, force: true });
  }
}

/**
 * Copies the made-up Lumiverse's rows into the file as they stand: a row there already is updated in
 * place (keeping where it is stored, so two messages at one place keep their order), a new one is
 * added after the others in the order it was made, and one gone is deleted.
 */
export function mirror(lumiverse: Lumiverse, file: LumiverseFile): void {
  const db = file.writer;
  db.transaction(() => {
    const chat = db.query(
      `INSERT INTO chats (id, user_id, character_id, name, metadata, updated_at) VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET user_id = excluded.user_id, character_id = excluded.character_id, name = excluded.name, metadata = excluded.metadata, updated_at = excluded.updated_at`,
    );
    for (const c of lumiverse.chats.values()) chat.run(c.id, c.user_id, c.character_id, c.name, JSON.stringify(c.metadata), c.updated_at);
    const message = db.query(
      `INSERT INTO messages (id, chat_id, index_in_chat, is_user, name, content, send_date, swipe_id, swipes, extra, created_at, revision) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET chat_id = excluded.chat_id, index_in_chat = excluded.index_in_chat, is_user = excluded.is_user, name = excluded.name, content = excluded.content,
         send_date = excluded.send_date, swipe_id = excluded.swipe_id, swipes = excluded.swipes, extra = excluded.extra, created_at = excluded.created_at, revision = excluded.revision`,
    );
    for (const m of lumiverse.messages.values()) message.run(m.id, m.chat_id, m.index_in_chat, m.is_user, m.name, m.content, m.send_date, m.swipe_id, m.swipes, m.extra, m.created_at, m.revision);
    const book = db.query(
      `INSERT INTO world_books (id, user_id, name, description, metadata, updated_at) VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET user_id = excluded.user_id, name = excluded.name, description = excluded.description, metadata = excluded.metadata, updated_at = excluded.updated_at`,
    );
    for (const b of lumiverse.books.values()) book.run(b.id, b.user_id, b.name, b.description, b.metadata, b.updated_at);
    const entry = db.query(
      `INSERT INTO world_book_entries (id, world_book_id, key, keysecondary, content, comment, role, order_value, constant, disabled, use_regex, vectorized, extensions, revision, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET world_book_id = excluded.world_book_id, key = excluded.key, keysecondary = excluded.keysecondary, content = excluded.content, comment = excluded.comment,
         role = excluded.role, order_value = excluded.order_value, constant = excluded.constant, disabled = excluded.disabled, use_regex = excluded.use_regex, vectorized = excluded.vectorized,
         extensions = excluded.extensions, revision = excluded.revision, updated_at = excluded.updated_at`,
    );
    for (const e of lumiverse.entries.values()) entry.run(e.id, e.world_book_id, e.key, e.keysecondary, e.content, e.comment, e.role, e.order_value, e.constant, e.disabled, e.use_regex, e.vectorized, e.extensions, e.revision, e.updated_at);
    const gone = (table: string, ids: Iterable<string>): void => {
      db.query(`DELETE FROM ${table} WHERE id NOT IN (SELECT value FROM json_each(?))`).run(JSON.stringify([...ids]));
    };
    gone("messages", lumiverse.messages.keys());
    gone("chats", lumiverse.chats.keys());
    gone("world_book_entries", lumiverse.entries.keys());
    gone("world_books", lumiverse.books.keys());
  })();
}

/** The reader over a file, with its waits and log kept for the test, and a clock that stands still. */
export function reader(path: string, options: Partial<DbSourceDeps> = {}): { db: DbSource; waits: number[]; logs: string[] } {
  const waits: number[] = [];
  const logs: string[] = [];
  const db = createDbSource({
    path,
    userId: USER,
    identifier: LUMIAH,
    sleep: async (ms) => {
      waits.push(ms);
    },
    now: () => Date.UTC(2026, 10, 12, 9, 30, 0),
    log: (level, message) => logs.push(`${level}: ${message}`),
    ...options,
  });
  return { db, waits, logs };
}

/** The HTTP source over the made-up Lumiverse, as the user's session reaches it. */
export const httpSource = (lumiverse: Lumiverse, identifier = LUMIAH): CopySource => createHttpSource({ fetch: lumiverse.session(USER), identifier, sleep: async () => undefined });

/** A chat read without what only the database reader makes: its fingerprint. */
export function chatRows(read: SourceChat | null): Omit<SourceChat, "fingerprint"> | null {
  if (read === null) return null;
  const { fingerprint: _, ...rows } = read;
  return rows;
}

/** A book read without the signature each source makes its own way (an ETag over HTTP). */
export function bookRows(read: SourceBook | null): Omit<SourceBook, "signature"> | null {
  if (read === null) return null;
  const { signature: _, ...rows } = read;
  return rows;
}
