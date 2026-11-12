// The copy's source read straight from Lumiverse's database file, for a runtime on the machine Lumiverse
// runs on (PI-BUILD-PLAN §4.6). It gives the very rows the HTTP source gives for the same Lumiverse rows
// (./rows.ts), and says what HTTP can't: a fingerprint of a whole chat that moves with the changes
// Lumiverse tells of nowhere, and whether anything in the file changed at all (`pragma data_version`).
//
// Read-only, and only reading: the file is opened read-only, and the reader runs SELECTs and the
// read-only pragmas `schema_version`, `data_version` and `table_info`, nothing else. No write, no
// checkpoint, no pragma that sets anything, no attached database. Lumiverse writes the file from several
// processes in WAL mode and checkpoints it every few seconds, so each read is one short statement, a page
// of a long chat with the runtime's other work let run between pages, or a few statements in one short
// read transaction; never one long transaction, which would hold Lumiverse's checkpoints back. Pages may
// straddle a change: they then stand only if the chat (or book) is still as they read it, and are read
// again from the start otherwise.
//
// Every statement is scoped to the runtime's user through the owning table, every value bound: another
// user's chat or book, or one with no owner, reads as none. Before its first statement, and again
// whenever the file's schema changes, the reader checks the tables and columns it reads (./schema.ts).
// A difference there, a file that is gone, one the runtime may not read, or one that isn't a database
// turns the reader off for good: every call then rejects with the one sentence that says why, and
// `preferDatabase` hands the copy to its other source. A file locked by another connection is asked
// again a few times, then that one read fails and the reader stays on. Nothing read is kept between
// calls: each call asks the file as it is.

import { Database } from "bun:sqlite";
import { accessSync, closeSync, constants, openSync, readSync, type Stats, statSync } from "node:fs";
import { basename } from "node:path";
import { textHash } from "../../core/hash";
import type { LogLevel } from "../../core/ports";
import type { HostBookRecord, HostMessage } from "../../extension/backend/spindle";
import type { ChatSignature, CopySource, SourceBook, SourceChanges, SourceChat, SourceEntry, SourceMessage } from "../copy/source";
import { type BookHead, bookFrom, type Cell, type ChatHead, chatFrom, type EntryRow, entryFrom, type MessageRow, messageFrom, Unreadable } from "./rows";
import { columnsOf, differenceOf } from "./schema";

/** Rows read in one statement of a long read: Lumiverse's own page. */
export const PAGE = 1000;
/** How many times a statement is tried while another connection holds the file locked. */
export const TRIES = 4;
/** The wait before the second try of a locked statement, in ms, doubled for each try after. */
export const RETRY_MS = 25;
/** How many times a chat or a book that changed while it was read is read from the start. */
export const REREADS = 3;

export interface DbSourceDeps {
  /** Lumiverse's database file: `lumiverse.db` in Lumiverse's data folder. */
  path: string;
  /** The user the runtime reads as: the only one whose chats and books are read. */
  userId: string;
  /** The extension whose entry in a message's extension metadata is its own. */
  identifier: string;
  /** Waits before a locked statement is tried again. */
  sleep(ms: number): Promise<void>;
  now(): number;
  log(level: LogLevel, message: string): void;
  /** Rows read in one statement; `PAGE` when not said. */
  page?: number;
  /** Tries of a statement while the file is locked; `TRIES` when not said. */
  tries?: number;
  /** The wait before the second try, doubled for each try after; `RETRY_MS` when not said. */
  retryMs?: number;
  /** Reads from the start of a chat or a book that changed while it was read; `REREADS` when not said. */
  rereads?: number;
  /** Runs between two pages of one read, so the runtime's other work goes on meanwhile; one turn of the event loop when not said. */
  pause?: () => Promise<void>;
}

/** One call that read the file, as a page shows it. */
export interface DbRead {
  /** When it began (the runtime's clock, ms). */
  at: number;
  /** What it read: `chat <id>`, `world book <id>`, their signatures, or the file's change counter. */
  what: string;
  /** Rows read, every page and every read again counted. */
  rows: number;
  /** Characters of text read. */
  chars: number;
  /** How long it took, in ms. */
  ms: number;
  /** `read`, `none such`, or `failed: ` and why. */
  outcome: string;
}

/** The reader as a page shows it. */
export interface DbState {
  path: string;
  on: boolean;
  /** Why it is off, in one sentence; null while it is on. */
  why: string | null;
  /** Whether it holds the file open now. */
  open: boolean;
  /** The check of the tables and columns it reads: when it last ran, and its finding (`matches` null: not run yet). */
  schema: { checkedAt: number | null; matches: boolean | null; difference: string | null };
  /** The last read of a whole chat or book. */
  lastRead: DbRead | null;
  /** The last cheap check: a chat's or a book's signature, or whether anything changed. */
  lastCheck: DbRead | null;
}

export interface DbSource extends CopySource {
  readonly kind: "database";
  describe(): DbState;
  /** Lets go of the file. Every call after rejects. */
  close(): void;
}

/** The reader is off for good: every call rejects with this, its message the one sentence saying why. */
export class DatabaseOff extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DatabaseOff";
  }
}

const CLOSED = "The database reader was closed.";

/** How SQLite's file starts. */
const MAGIC = new TextEncoder().encode("SQLite format 3\0");

/** Why the file can't be read: for good (gone, not to be read, not a database), or for now (Lumiverse stopped). */
class FileTrouble extends Error {
  constructor(
    message: string,
    readonly lasting: boolean,
  ) {
    super(message);
  }
}

const errorCode = (error: unknown): string => (error instanceof Error && "code" in error && typeof error.code === "string" ? error.code : "");
const words = (error: unknown): string => (error instanceof Error ? error.message : String(error));

/** Why the file can't be found or looked at: missing for good, a folder the runtime may not look in for good, anything else for now. */
function statTrouble(path: string, error: unknown): FileTrouble {
  const code = errorCode(error);
  if (code === "ENOENT" || code === "ENOTDIR") return new FileTrouble(`The database reader is off: there is no file at ${path} (Lumiverse's database was moved or deleted).`, true);
  if (code === "EACCES" || code === "EPERM") return new FileTrouble(`The database reader is off: the runtime isn't allowed to look at ${path} (${code}).`, true);
  return new FileTrouble(`Lumiverse's database at ${path} couldn't be looked at just now (${words(error)}).`, false);
}

/** The first bytes of the file: SQLite's header. */
function headerOf(path: string): Uint8Array {
  const fd = openSync(path, "r");
  try {
    const head = new Uint8Array(100);
    return head.subarray(0, readSync(fd, head, 0, head.length, 0));
  } finally {
    closeSync(fd);
  }
}

/**
 * Why the file can't be opened for reading now, from a look at it and its side files; null when it
 * can. A database in WAL mode is read through its `-wal` and `-shm` beside it, which Lumiverse makes
 * when it opens the file: a reader that only reads may not make them, so while they are missing it
 * doesn't open the file (SQLite would make them, or fail, as built).
 */
function troubleWith(path: string, file: Stats): FileTrouble | null {
  if (!file.isFile()) return new FileTrouble(`The database reader is off: ${path} isn't a SQLite database but a ${file.isDirectory() ? "folder" : "special file"}.`, true);
  let head: Uint8Array;
  try {
    head = headerOf(path);
  } catch (error) {
    const code = errorCode(error);
    return code === "EACCES" || code === "EPERM" ? new FileTrouble(`The database reader is off: the runtime isn't allowed to read ${path} (${code}).`, true) : statTrouble(path, error);
  }
  if (head.length < 100 || MAGIC.some((byte, i) => head[i] !== byte)) return new FileTrouble(`The database reader is off: ${path} isn't a SQLite database.`, true);
  if (head[18] !== 2 && head[19] !== 2) return null;
  for (const side of ["-wal", "-shm"]) {
    try {
      accessSync(path + side, constants.R_OK);
    } catch (error) {
      if (errorCode(error) === "ENOENT") return new FileTrouble(`Lumiverse's database can't be read now: ${basename(path)}${side} isn't beside it, as when Lumiverse isn't running, and the reader doesn't make it.`, false);
      return new FileTrouble(`The database reader is off: the runtime isn't allowed to read ${path}${side} (${errorCode(error) || words(error)}).`, true);
    }
  }
  return null;
}

/** The file open, and what was found of it. */
interface Open {
  db: Database;
  /** Which opening this is: a change counter of one opening says nothing about another's. */
  generation: number;
  /** The file opened, told apart from one put at its path later. */
  dev: number;
  ino: number;
  /** The schema version its columns were checked at; null before they were. */
  schema: number | null;
}

/** How much one call read: rows and characters of text. */
interface Tally {
  rows: number;
  chars: number;
}

const length = (cell: Cell): number => (typeof cell === "string" ? cell.length : 0);

// The statements. A chat's messages are in Lumiverse's order: by place, two at one place in the order
// they were stored (Lumiverse's own index lists them so). A long read pages through that order from
// where its last page ended, never by an offset, so rows that come or go meanwhile can't shift a page.
const VERSIONS = "SELECT (SELECT schema_version FROM pragma_schema_version) AS schema, (SELECT data_version FROM pragma_data_version) AS data";
const CHAT = "SELECT id, user_id, character_id, name, metadata, updated_at FROM chats WHERE id = ? AND user_id = ?";
const MESSAGE = `m.rowid AS at, m.id, m.index_in_chat, m.is_user, m.name, m.content, m.send_date, m.swipe_id, m.swipes, m.extra, m.created_at, m.revision,
  octet_length(m.content) AS content_bytes, octet_length(m.swipes) AS swipes_bytes, octet_length(m.extra) AS extra_bytes`;
const OF_CHAT = "FROM messages m JOIN chats c ON c.id = m.chat_id WHERE m.chat_id = ? AND c.user_id = ?";
const MESSAGES_FIRST = `SELECT ${MESSAGE} ${OF_CHAT} ORDER BY m.index_in_chat, m.rowid LIMIT ?`;
const MESSAGES_AFTER = `SELECT ${MESSAGE} ${OF_CHAT} AND m.index_in_chat >= ? AND (m.index_in_chat > ? OR m.rowid > ?) ORDER BY m.index_in_chat, m.rowid LIMIT ?`;
const NEWEST = `SELECT ${MESSAGE} ${OF_CHAT} ORDER BY m.index_in_chat DESC, m.rowid DESC LIMIT 1`;
/** What a chat's fingerprint holds of each message, in `messagePrint`'s order: all but its text, swipes and extras, which it holds by their length in bytes. */
const MESSAGE_PRINTS = `SELECT m.rowid, m.id, m.index_in_chat, m.is_user, m.name, m.send_date, m.swipe_id, m.created_at, m.revision,
  octet_length(m.content), octet_length(m.swipes), octet_length(m.extra) ${OF_CHAT} ORDER BY m.index_in_chat, m.rowid`;
const BOOK = "SELECT id, user_id, name, description, metadata, updated_at FROM world_books WHERE id = ? AND user_id = ?";
const ENTRY = `e.id, e.world_book_id, e.key, e.keysecondary, e.content, e.comment, e.role, e.order_value, e.constant, e.disabled, e.use_regex, e.vectorized,
  e.extensions, e.revision, e.updated_at, octet_length(e.content) AS content_bytes, octet_length(e.extensions) AS extensions_bytes`;
const OF_BOOK = "FROM world_book_entries e JOIN world_books w ON w.id = e.world_book_id WHERE e.world_book_id = ? AND w.user_id = ?";
const ENTRIES_FIRST = `SELECT ${ENTRY} ${OF_BOOK} ORDER BY e.order_value, e.id LIMIT ?`;
const ENTRIES_AFTER = `SELECT ${ENTRY} ${OF_BOOK} AND e.order_value >= ? AND (e.order_value > ? OR e.id > ?) ORDER BY e.order_value, e.id LIMIT ?`;
/** What a book's signature holds of each entry, in `entryPrint`'s order: all it says but its content and extensions, which it holds by their length in bytes. */
const ENTRY_PRINTS = `SELECT e.id, e.comment, e.key, e.keysecondary, e.role, e.order_value, e.constant, e.disabled, e.use_regex, e.vectorized, e.revision, e.updated_at,
  octet_length(e.content), octet_length(e.extensions) ${OF_BOOK} ORDER BY e.order_value, e.id`;

/** A message read in a page as `MESSAGE_PRINTS` gives it. */
const messagePrint = (m: MessageRow): Cell[] => [m.at, m.id, m.index_in_chat, m.is_user, m.name, m.send_date, m.swipe_id, m.created_at, m.revision, m.content_bytes, m.swipes_bytes, m.extra_bytes];

/** An entry read in a page as `ENTRY_PRINTS` gives it. */
const entryPrint = (e: EntryRow): Cell[] => [e.id, e.comment, e.key, e.keysecondary, e.role, e.order_value, e.constant, e.disabled, e.use_regex, e.vectorized, e.revision, e.updated_at, e.content_bytes, e.extensions_bytes];

/** A fingerprint of a chat or a book: its own row and every row of it, as one hash. */
async function printOf(head: readonly Cell[], prints: readonly (readonly unknown[])[]): Promise<string> {
  return `db:${await textHash(JSON.stringify([head, prints]))}`;
}

const chatPrint = (head: ChatHead, prints: readonly (readonly unknown[])[]): Promise<string> => printOf([head.name, head.character_id, head.metadata, head.updated_at], prints);
const bookPrint = (head: BookHead, prints: readonly (readonly unknown[])[]): Promise<string> => printOf([head.name, head.description, head.metadata, head.updated_at], prints);

/** The words for a row Lumiverse's own mapper fails on: the read fails as Lumiverse's HTTP route fails for it. */
function refusal(error: unknown, what: string, whole: string): Error {
  if (!(error instanceof Unreadable)) return error instanceof Error ? error : new Error(String(error));
  return new Error(`Lumiverse itself can't read ${what} (${error.message}), so ${whole} isn't read from its database either.`);
}

export function createDbSource(deps: DbSourceDeps): DbSource {
  const page = Math.max(1, Math.floor(deps.page ?? PAGE));
  const tries = Math.max(1, deps.tries ?? TRIES);
  const retryMs = deps.retryMs ?? RETRY_MS;
  const rereads = Math.max(1, deps.rereads ?? REREADS);
  const pause =
    deps.pause ??
    ((): Promise<void> => {
      const { promise, resolve } = Promise.withResolvers<void>();
      setImmediate(resolve);
      return promise;
    });
  /** This reader among every other: a mark another one gave says nothing about this one's file. */
  const self = crypto.randomUUID();

  let open: Open | null = null;
  let generation = 0;
  let off: string | null = null;
  let closed = false;
  let schema: DbState["schema"] = { checkedAt: null, matches: null, difference: null };
  let lastRead: DbRead | null = null;
  let lastCheck: DbRead | null = null;

  function release(): void {
    open?.db.close();
    open = null;
  }

  function turnOff(why: string): DatabaseOff {
    if (off === null) {
      off = why;
      release();
      deps.log("warn", `[database reader] ${why}`);
    }
    return new DatabaseOff(off);
  }

  /** The schema version and the change counter now, the columns read checked again whenever the schema changed. */
  function versions(at: Open): number {
    const now = at.db.query<{ schema: number; data: number }, []>(VERSIONS).get();
    if (now === null) throw new Error("SQLite gave no schema version.");
    if (at.schema !== now.schema) {
      const difference = differenceOf(columnsOf(at.db));
      schema = { checkedAt: deps.now(), matches: difference === null, difference };
      if (difference !== null) throw turnOff(`The database reader is off: ${difference}.`);
      at.schema = now.schema;
    }
    return now.data;
  }

  /** The file open and checked: opened first where it isn't, opened again where another file took its path. */
  function file(): Open {
    if (closed) throw new Error(CLOSED);
    if (off !== null) throw new DatabaseOff(off);
    let now: Stats;
    try {
      now = statSync(deps.path);
    } catch (error) {
      throw statTrouble(deps.path, error);
    }
    if (open !== null && (open.dev !== now.dev || open.ino !== now.ino)) release();
    if (open === null) {
      const trouble = troubleWith(deps.path, now);
      if (trouble !== null) throw trouble;
      open = { db: new Database(deps.path, { readonly: true }), generation: ++generation, dev: now.dev, ino: now.ino, schema: null };
    }
    if (open.schema === null) versions(open);
    return open;
  }

  /**
   * One statement (or one short read transaction) on the file, asked again after a short wait while
   * another connection holds the file locked. Throws in plain words; turns the reader off where the
   * file is gone, may not be read, or isn't a database.
   */
  async function step<T>(what: string, run: (at: Open) => T): Promise<T> {
    let mended = false;
    for (let tried = 1; ; ) {
      try {
        return run(file());
      } catch (error) {
        if (error instanceof DatabaseOff || closed) throw error;
        if (error instanceof FileTrouble) throw error.lasting ? turnOff(error.message) : new Error(error.message);
        const code = errorCode(error);
        if (/^SQLITE_(BUSY|LOCKED|SCHEMA)/.test(code)) {
          if (tried >= tries) throw new Error(`Lumiverse's database stayed locked by another connection through ${tries} tries while the runtime read ${what}; it reads it again next time.`);
          await deps.sleep(retryMs * 2 ** (tried - 1));
          tried++;
          continue;
        }
        if (!/^SQLITE_(CANTOPEN|IOERR|PERM|READONLY|AUTH|CORRUPT|NOTADB)/.test(code)) throw new Error(`The runtime couldn't read ${what} from Lumiverse's database (SQLite says: ${words(error)}).`);
        // The file may have been put back, or its side files taken away, under the connection: a fresh one reads it as it is now.
        release();
        if (!mended) {
          mended = true;
          continue;
        }
        if (code === "SQLITE_NOTADB") throw turnOff(`The database reader is off: SQLite says ${deps.path} isn't a database (${words(error)}).`);
        let trouble: FileTrouble | null;
        try {
          trouble = troubleWith(deps.path, statSync(deps.path));
        } catch (looked) {
          trouble = statTrouble(deps.path, looked);
        }
        if (trouble !== null) throw trouble.lasting ? turnOff(trouble.message) : new Error(trouble.message);
        throw new Error(`The runtime couldn't read ${what} from Lumiverse's database just now (SQLite says: ${words(error)}); it tries again next time.`);
      }
    }
  }

  /** Which opening of the file this is, and its change counter: where an operation begins. */
  const begin = (what: string): Promise<{ generation: number; data: number }> => step(what, (at) => ({ generation: at.generation, data: versions(at) }));

  /** A chat as it stands, in one short read transaction: its row, what its fingerprint holds of each message, and its newest message. */
  function chatNow(db: Database, chatId: string): { head: ChatHead; prints: unknown[][]; newest: MessageRow | null } | null {
    return db.transaction(() => {
      const head = db.query<ChatHead, [string, string]>(CHAT).get(chatId, deps.userId);
      if (head === null) return null;
      const prints = db.query<unknown, [string, string]>(MESSAGE_PRINTS).values(chatId, deps.userId);
      return { head, prints, newest: db.query<MessageRow, [string, string]>(NEWEST).get(chatId, deps.userId) };
    })();
  }

  /** A book as it stands, in one short read transaction: its row and what its signature holds of each entry. */
  function bookNow(db: Database, bookId: string): { head: BookHead; prints: unknown[][] } | null {
    return db.transaction(() => {
      const head = db.query<BookHead, [string, string]>(BOOK).get(bookId, deps.userId);
      if (head === null) return null;
      return { head, prints: db.query<unknown, [string, string]>(ENTRY_PRINTS).values(bookId, deps.userId) };
    })();
  }

  /** Runs one call, noting it for the page: a read of a whole chat or book, or a cheap check. */
  async function noted<T>(kind: "read" | "check", what: string, work: (tally: Tally) => Promise<T>): Promise<T> {
    const tally: Tally = { rows: 0, chars: 0 };
    const at = deps.now();
    const started = performance.now();
    const note = (outcome: string): void => {
      const read: DbRead = { at, what, rows: tally.rows, chars: tally.chars, ms: Math.round(performance.now() - started), outcome };
      if (kind === "read") lastRead = read;
      else lastCheck = read;
    };
    try {
      const out = await work(tally);
      note(out === null ? "none such" : "read");
      return out;
    } catch (error) {
      note(`failed: ${words(error)}`);
      throw error;
    }
  }

  async function readChat(chatId: string): Promise<SourceChat | null> {
    const what = `chat ${chatId}`;
    return noted("read", what, async (tally) => {
      for (let attempt = 1; ; attempt++) {
        const before = await begin(what);
        const head = await step(what, (at) => at.db.query<ChatHead, [string, string]>(CHAT).get(chatId, deps.userId));
        if (head === null) return null;
        tally.rows++;
        tally.chars += length(head.metadata);
        const prints: Cell[][] = [];
        const messages: SourceMessage[] = [];
        let refused: Error | null = null;
        let batch = await step(what, (at) => at.db.query<MessageRow, [string, string, number]>(MESSAGES_FIRST).all(chatId, deps.userId, page));
        for (;;) {
          for (const row of batch) {
            prints.push(messagePrint(row));
            tally.rows++;
            tally.chars += length(row.content) + length(row.swipes) + length(row.extra);
            if (refused !== null) continue;
            try {
              messages.push(messageFrom(row, deps.identifier));
            } catch (error) {
              refused = refusal(error, `message ${String(row.id)} of chat ${chatId}`, "the chat");
            }
          }
          const end = batch.at(-1);
          if (batch.length < page || end === undefined) break;
          await pause();
          batch = await step(what, (at) => at.db.query<MessageRow, [string, string, Cell, Cell, number, number]>(MESSAGES_AFTER).all(chatId, deps.userId, end.index_in_chat, end.index_in_chat, end.at, page));
        }
        const fingerprint = await chatPrint(head, prints);
        const after = await begin(what);
        if (after.generation !== before.generation || after.data !== before.data) {
          // The file changed while the pages were read: they stand only if the chat is now as they read it.
          const now = await step(what, (at) => chatNow(at.db, chatId));
          if (now === null) return null;
          if ((await chatPrint(now.head, now.prints)) !== fingerprint) {
            if (attempt >= rereads) throw new Error(`Chat ${chatId} kept changing while it was read (${rereads} times), so it wasn't kept.`);
            continue;
          }
        }
        if (refused !== null) throw refused;
        return { ...chatFrom(head), messages, fingerprint };
      }
    });
  }

  async function chatSignature(chatId: string): Promise<ChatSignature | null> {
    const what = `chat ${chatId}`;
    return noted("check", `${what}'s signature`, async (tally) => {
      await begin(what);
      const now = await step(what, (at) => chatNow(at.db, chatId));
      if (now === null) return null;
      tally.rows += now.prints.length + 1;
      let last: HostMessage | null = null;
      if (now.newest !== null) {
        tally.chars += length(now.newest.content) + length(now.newest.swipes) + length(now.newest.extra);
        try {
          last = messageFrom(now.newest, deps.identifier).row;
        } catch (error) {
          throw refusal(error, `message ${String(now.newest.id)} of chat ${chatId}`, "the chat");
        }
      }
      return { count: now.prints.length, last, fingerprint: await chatPrint(now.head, now.prints) };
    });
  }

  async function readBook(bookId: string, held: SourceBook | null): Promise<SourceBook | null> {
    const what = `world book ${bookId}`;
    return noted("read", what, async (tally) => {
      for (let attempt = 1; ; attempt++) {
        const before = await begin(what);
        if (attempt === 1 && held?.signature != null) {
          const now = await step(what, (at) => bookNow(at.db, bookId));
          if (now === null) return null;
          tally.rows += now.prints.length + 1;
          if ((await bookPrint(now.head, now.prints)) === held.signature) return held;
        }
        const head = await step(what, (at) => at.db.query<BookHead, [string, string]>(BOOK).get(bookId, deps.userId));
        if (head === null) return null;
        tally.rows++;
        tally.chars += length(head.metadata) + length(head.description);
        let book: HostBookRecord;
        try {
          book = bookFrom(head);
        } catch (error) {
          throw refusal(error, what, "the book");
        }
        const prints: Cell[][] = [];
        const entries: SourceEntry[] = [];
        let refused: Error | null = null;
        let batch = await step(what, (at) => at.db.query<EntryRow, [string, string, number]>(ENTRIES_FIRST).all(bookId, deps.userId, page));
        for (;;) {
          for (const row of batch) {
            prints.push(entryPrint(row));
            tally.rows++;
            tally.chars += length(row.content) + length(row.extensions) + length(row.key) + length(row.keysecondary) + length(row.comment);
            if (refused !== null) continue;
            try {
              entries.push(entryFrom(row));
            } catch (error) {
              refused = refusal(error, `entry ${String(row.id)} of world book ${bookId}`, "the book");
            }
          }
          const end = batch.at(-1);
          if (batch.length < page || end === undefined) break;
          await pause();
          batch = await step(what, (at) => at.db.query<EntryRow, [string, string, Cell, Cell, Cell, number]>(ENTRIES_AFTER).all(bookId, deps.userId, end.order_value, end.order_value, end.id, page));
        }
        const signature = await bookPrint(head, prints);
        const after = await begin(what);
        if (after.generation !== before.generation || after.data !== before.data) {
          const now = await step(what, (at) => bookNow(at.db, bookId));
          if (now === null) return null;
          if ((await bookPrint(now.head, now.prints)) !== signature) {
            if (attempt >= rereads) throw new Error(`World book ${bookId} kept changing while it was read (${rereads} times), so it wasn't kept.`);
            continue;
          }
        }
        if (refused !== null) throw refused;
        return { book, entries, signature };
      }
    });
  }

  async function bookSignature(bookId: string): Promise<string | null> {
    const what = `world book ${bookId}`;
    return noted("check", `${what}'s signature`, async (tally) => {
      await begin(what);
      const now = await step(what, (at) => bookNow(at.db, bookId));
      if (now === null) return null;
      tally.rows += now.prints.length + 1;
      return bookPrint(now.head, now.prints);
    });
  }

  async function changedSince(mark: string | null): Promise<SourceChanges> {
    return noted("check", "the file's change counter", async () => {
      // `data_version` moves whenever another connection changed the file, and this reader writes
      // nothing; it is this opening's own count, so a mark of another opening, or of another reader, says nothing.
      const now = await begin("whether anything changed");
      const at = `${self}:${now.generation}:${now.data}`;
      return { changed: mark !== at, mark: at };
    });
  }

  return {
    kind: "database",
    readChat,
    readBook,
    chatSignature,
    bookSignature,
    changedSince,
    describe: () => ({ path: deps.path, on: off === null && !closed, why: off ?? (closed ? CLOSED : null), open: open !== null, schema: { ...schema }, lastRead, lastCheck }),
    close() {
      closed = true;
      release();
    },
  };
}

/**
 * The source the copy reads from where the database reader may be used: the reader while there is one
 * and it is on, `otherwise` (the HTTP source) while there is none (the owner's switch is off) or it
 * turned itself off. A call that finds the reader just turned off is asked of `otherwise` at once, so
 * the copy carries on; any other failure of the reader is that one call's. `kind` names the one read
 * from now.
 */
export function preferDatabase(reader: () => DbSource | null, otherwise: CopySource): CopySource {
  const current = (): CopySource => {
    const db = reader();
    return db !== null && db.describe().on ? db : otherwise;
  };
  async function ask<T>(call: (source: CopySource) => Promise<T>): Promise<T> {
    const source = current();
    if (source === otherwise) return call(otherwise);
    try {
      return await call(source);
    } catch (error) {
      if (error instanceof DatabaseOff) return call(otherwise);
      throw error;
    }
  }
  return {
    get kind() {
      return current().kind;
    },
    readChat: (chatId) => ask((source) => source.readChat(chatId)),
    readBook: (bookId, held) => ask((source) => source.readBook(bookId, held)),
    chatSignature: (chatId) => ask((source) => source.chatSignature(chatId)),
    bookSignature: (bookId, held) => ask((source) => source.bookSignature(bookId, held)),
    changedSince: (mark) => ask((source) => source.changedSince(mark)),
  };
}
