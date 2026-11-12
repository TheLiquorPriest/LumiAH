// The database reader's dealings with the file itself (PI-BUILD-PLAN §4.6): it only reads (the file's
// bytes and its -wal are as they were after every kind of read, and a file nobody may write is read
// all the same); it holds nothing between reads, so Lumiverse's checkpoints go through between two
// reads and between two pages of one; it checks the tables and columns it reads before its first read
// and whenever the schema changes; it reads one user's rows; it waits out a lock a few times; a long
// chat read in pages stands only if it didn't change meanwhile; and it turns itself off, saying why,
// where the file is gone, may not be read, or isn't a database. Every chat, book, name and text here is
// invented.

import { Database } from "bun:sqlite";
import { afterEach, describe, expect, test } from "bun:test";
import { chmodSync, mkdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { DatabaseOff, type DbSource } from "../../../src/runtime/db";
import { columnsOf, READ_COLUMNS } from "../../../src/runtime/db/schema";
import { Lumiverse } from "../copy/lumiverse";
import { chatRows, httpSource, lumiverseFile, mirror, OTHER, reader, removeFiles, SCHEMA, USER } from "./rig";

afterEach(removeFiles);

/** The runtime's clock as the tests' reader has it. */
const NOW = Date.UTC(2026, 10, 12, 9, 30, 0);

const lines = (n: number, from = 0): string[] => Array.from({ length: n }, (_, i) => `Line ${from + i} of the harbour log.`);

const sha = (path: string): string => new Bun.CryptoHasher("sha256").update(readFileSync(path)).digest("hex");

/** A chat of the user's with `n` messages, in a file Lumiverse has open. */
function harbour(n = 5) {
  const lumiverse = new Lumiverse();
  const chat = lumiverse.newChat(USER);
  const rows = lumiverse.imported(chat.id, lines(n));
  const file = lumiverseFile();
  mirror(lumiverse, file);
  return { lumiverse, chat, rows, file };
}

/** What every call of the reader rejects with, each in turn. */
async function everyCall(db: DbSource, chatId: string, bookId: string): Promise<unknown[]> {
  const settled = (call: Promise<unknown>): Promise<unknown> => call.catch((error: unknown) => error);
  return Promise.all([settled(db.readChat(chatId)), settled(db.chatSignature(chatId)), settled(db.readBook(bookId, null)), settled(db.bookSignature(bookId, null)), settled(db.changedSince(null))]);
}

/** Lumiverse's connection takes the file for itself until `letGo`: in WAL mode, a connection holding the file exclusively. */
function holdAlone(writer: Database): void {
  writer.run("PRAGMA locking_mode = EXCLUSIVE");
  writer.query("UPDATE chats SET name = name").run();
}

function letGo(writer: Database): void {
  writer.run("PRAGMA locking_mode = NORMAL");
  writer.query("SELECT count(*) FROM chats").get();
}

describe("it only reads", () => {
  test("every kind of read leaves the database file and its -wal as they were, byte for byte", async () => {
    const lumiverse = new Lumiverse();
    const chat = lumiverse.newChat(USER);
    lumiverse.imported(chat.id, lines(30));
    const theirs = lumiverse.newChat(OTHER);
    lumiverse.say(theirs.id, "Not Mara's.");
    const broken = lumiverse.newChat(USER);
    lumiverse.say(broken.id, "A row Lumiverse can't read.").swipes = "null";
    const book = lumiverse.newBook(USER);
    lumiverse.addEntry(book.id, { comment: "Tide", content: "The quay floods at spring tide." });
    const file = lumiverseFile();
    mirror(lumiverse, file);
    const wal = `${file.path}-wal`;
    // What Lumiverse wrote is still in the -wal, which is where a careless reader would write too.
    expect(statSync(wal).size).toBeGreaterThan(0);
    const before = { db: sha(file.path), wal: sha(wal), walMode: statSync(wal).mode, dbMode: statSync(file.path).mode };

    const { db } = reader(file.path, { page: 7 });
    const first = await db.changedSince(null);
    expect(await db.readChat(chat.id)).not.toBeNull();
    expect(await db.readChat(theirs.id)).toBeNull();
    expect(await db.readChat("chat-nowhere")).toBeNull();
    expect(await db.chatSignature(chat.id)).not.toBeNull();
    expect(await db.readChat(broken.id).catch((error: unknown) => error)).toBeInstanceOf(Error);
    const held = await db.readBook(book.id, null);
    expect(await db.readBook(book.id, held)).toBe(held);
    expect(await db.bookSignature(book.id, held)).toBe(held?.signature ?? "");
    expect((await db.changedSince(first.mark)).changed).toBe(false);
    db.describe();
    db.close();

    expect({ db: sha(file.path), wal: sha(wal), walMode: statSync(wal).mode, dbMode: statSync(file.path).mode }).toEqual(before);
  });

  test("with Lumiverse killed and what it wrote left in the -wal, the reader reads it and leaves the file and its -wal as they were, even as the last to let go", async () => {
    const { lumiverse, chat, file } = harbour(3);
    file.writer.close();
    // Lumiverse in a process of its own writes one more message and is killed before it can close the file.
    const said = lumiverse.say(chat.id, "The lamp goes out.");
    const write = `const { Database } = require("bun:sqlite"); const db = new Database(${JSON.stringify(file.path)});
      db.query("INSERT INTO messages (id, chat_id, index_in_chat, name, content, send_date, swipes, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)")
        .run(${JSON.stringify([said.id, said.chat_id, said.index_in_chat, said.name, said.content, said.send_date, said.swipes, said.created_at])});
      process.kill(process.pid, "SIGKILL");`;
    expect(Bun.spawnSync([process.execPath, "-e", write]).signalCode).toBe("SIGKILL");
    const wal = `${file.path}-wal`;
    expect(statSync(wal).size).toBeGreaterThan(0);
    const before = { db: sha(file.path), wal: sha(wal) };
    const { db } = reader(file.path);

    expect(chatRows(await db.readChat(chat.id))).toEqual(chatRows(await httpSource(lumiverse).readChat(chat.id)));
    db.close();

    expect({ db: sha(file.path), wal: sha(wal) }).toEqual(before);
  });

  test("a file nobody may write, with its -wal and -shm, in a folder nobody may write, is read all the same", async () => {
    const { lumiverse, chat, file } = harbour();
    for (const path of [file.path, `${file.path}-wal`, `${file.path}-shm`]) chmodSync(path, 0o444);
    chmodSync(file.folder, 0o555);
    const { db } = reader(file.path);

    expect(chatRows(await db.readChat(chat.id))).toEqual(chatRows(await httpSource(lumiverse).readChat(chat.id)));
    expect(db.describe()).toMatchObject({ on: true, open: true, why: null });
  });

  test("it holds the file only while it reads: Lumiverse's checkpoint between two reads empties the -wal", async () => {
    const { lumiverse, chat, file } = harbour();
    const { db } = reader(file.path);
    const mark = await db.changedSince(null);
    await db.readChat(chat.id);

    lumiverse.say(chat.id, "A gull lands on the lamp.");
    mirror(lumiverse, file);
    expect(file.writer.query("PRAGMA wal_checkpoint(TRUNCATE)").get()).toEqual({ busy: 0, log: 0, checkpointed: 0 });
    expect(statSync(`${file.path}-wal`).size).toBe(0);

    const again = await db.readChat(chat.id);
    expect(chatRows(again)).toEqual(chatRows(await httpSource(lumiverse).readChat(chat.id)));
    expect(again?.messages.at(-1)?.row.content).toBe("A gull lands on the lamp.");
    expect((await db.changedSince(mark.mark)).changed).toBe(true);
  });

  test("close() lets go of the file: Lumiverse can then hold it alone, and every call after rejects", async () => {
    const { chat, file } = harbour();
    const { db } = reader(file.path);
    await db.readChat(chat.id);

    file.writer.run("PRAGMA locking_mode = EXCLUSIVE");
    expect(() => file.writer.query("UPDATE chats SET name = 'The harbour at dusk'").run()).toThrow("database is locked");
    db.close();
    file.writer.query("UPDATE chats SET name = 'The harbour at dusk'").run();
    letGo(file.writer);

    expect(await db.readChat(chat.id).catch((error: unknown) => error)).toMatchObject({ message: "The database reader was closed." });
    expect(db.describe()).toMatchObject({ on: false, open: false, why: "The database reader was closed." });
  });
});

describe("the tables and columns it reads", () => {
  test("the schema file the tests build from declares the very columns the reader reads, with the types it reads them as", () => {
    const declared = columnsOf(lumiverseFile().writer);
    expect(Object.fromEntries([...declared].map(([table, columns]) => [table, Object.fromEntries(columns)]))).toEqual(READ_COLUMNS);
  });

  test("a file as Lumiverse makes it is read, and a column Lumiverse added that the reader doesn't read is no difference", async () => {
    const { lumiverse, chat, file } = harbour();
    file.writer.run("ALTER TABLE messages ADD COLUMN parent_message_id TEXT; ALTER TABLE world_books ADD COLUMN folder TEXT NOT NULL DEFAULT ''");
    const { db } = reader(file.path);

    expect(chatRows(await db.readChat(chat.id))).toEqual(chatRows(await httpSource(lumiverse).readChat(chat.id)));
    expect(db.describe().schema).toEqual({ checkedAt: NOW, matches: true, difference: null });
  });

  test("a column it reads gone turns it off: every call rejects with one sentence naming the table and the column", async () => {
    const { chat, file } = harbour();
    file.writer.run("ALTER TABLE messages DROP COLUMN revision");
    const { db, logs } = reader(file.path);

    const why = `The database reader is off: table "messages" in Lumiverse's database has no column "revision".`;
    const rejected = await everyCall(db, chat.id, "book-quay");
    for (const error of rejected) {
      expect(error).toBeInstanceOf(DatabaseOff);
      expect(error).toMatchObject({ message: why });
    }
    expect(db.describe()).toMatchObject({ on: false, why, open: false, schema: { checkedAt: NOW, matches: false, difference: `table "messages" in Lumiverse's database has no column "revision"` } });
    expect(logs).toEqual([`warn: [database reader] ${why}`]);
  });

  test("a column it reads declared with another type, or a table it reads gone, turns it off naming it", async () => {
    const retyped = lumiverseFile({ schema: SCHEMA.replace("swipe_id INTEGER NOT NULL DEFAULT 0", "swipe_id TEXT NOT NULL DEFAULT '0'") });
    expect(await reader(retyped.path).db.readChat("chat-1").catch((error: unknown) => error)).toMatchObject({
      message: `The database reader is off: column "swipe_id" of table "messages" in Lumiverse's database is declared TEXT where the reader reads it as INTEGER.`,
    });

    const bookless = lumiverseFile();
    bookless.writer.run("DROP TABLE world_books");
    expect(await reader(bookless.path).db.readBook("book-1", null).catch((error: unknown) => error)).toMatchObject({ message: `The database reader is off: Lumiverse's database has no table "world_books".` });
  });

  test("the schema changing under it is checked again before its next read: a column added is no matter, a column it reads dropped turns it off", async () => {
    const { chat, file } = harbour();
    const { db } = reader(file.path);
    await db.readChat(chat.id);

    file.writer.run("ALTER TABLE chats ADD COLUMN pinned INTEGER NOT NULL DEFAULT 0");
    expect(await db.readChat(chat.id)).not.toBeNull();
    expect(db.describe().on).toBe(true);

    file.writer.run("ALTER TABLE world_book_entries DROP COLUMN vectorized");
    expect(await db.readChat(chat.id).catch((error: unknown) => error)).toBeInstanceOf(DatabaseOff);
    expect(db.describe().why).toBe(`The database reader is off: table "world_book_entries" in Lumiverse's database has no column "vectorized".`);
  });
});

describe("one user's rows", () => {
  test("another user's chat or book, one with no owner, and ids made to look like SQL all read as none", async () => {
    const lumiverse = new Lumiverse();
    const mine = lumiverse.newChat(USER);
    lumiverse.say(mine.id, "Mara's.");
    const theirs = lumiverse.newChat(OTHER);
    lumiverse.say(theirs.id, "Ilse's.");
    const myBook = lumiverse.newBook(USER);
    lumiverse.addEntry(myBook.id, { comment: "Tide", content: "Mara's tide." });
    const theirBook = lumiverse.newBook(OTHER);
    lumiverse.addEntry(theirBook.id, { comment: "Lamp", content: "Ilse's lamp." });
    const file = lumiverseFile();
    mirror(lumiverse, file);
    file.writer.run(`INSERT INTO chats (id, name) VALUES ('chat-nobody', 'Nobody''s');
      INSERT INTO messages (id, chat_id, index_in_chat, content) VALUES ('msg-nobody', 'chat-nobody', 0, 'Nobody''s.');
      INSERT INTO world_books (id, name) VALUES ('book-nobody', 'Nobody''s');
      INSERT INTO world_book_entries (id, world_book_id, content) VALUES ('entry-nobody', 'book-nobody', 'Nobody''s.');`);
    const { db } = reader(file.path);

    for (const id of [theirs.id, "chat-nobody", "chat-nowhere", `${theirs.id}' OR '1'='1`, "' OR user_id IS NULL OR '"]) {
      expect(await db.readChat(id)).toBeNull();
      expect(await db.chatSignature(id)).toBeNull();
    }
    for (const id of [theirBook.id, "book-nobody", "book-nowhere", `${theirBook.id}' OR '1'='1`]) {
      expect(await db.readBook(id, null)).toBeNull();
      expect(await db.bookSignature(id, null)).toBeNull();
    }
    expect((await db.readChat(mine.id))?.messages.map((m) => m.row.content)).toEqual(["Mara's."]);
    expect((await db.readBook(myBook.id, null))?.entries.map((e) => e.row.content)).toEqual(["Mara's tide."]);
  });
});

describe("a file another connection holds locked", () => {
  test("is asked again after a short wait, doubled each time, and read once it is let go", async () => {
    const { lumiverse, chat, file } = harbour();
    holdAlone(file.writer);
    const waits: number[] = [];
    const { db } = reader(file.path, {
      sleep: async (ms) => {
        waits.push(ms);
        if (waits.length === 2) letGo(file.writer);
      },
    });

    expect(chatRows(await db.readChat(chat.id))).toEqual(chatRows(await httpSource(lumiverse).readChat(chat.id)));
    expect(waits).toEqual([25, 50]);
  });

  test("locked through every try, that one read fails in plain words; the reader stays on and reads once the file is free", async () => {
    // Lumiverse's own file is in WAL mode, where a reader is refused only in rare moments (a recovery
    // after a crash, a connection holding the file alone); a file in rollback mode refuses readers
    // whenever a writer holds it, which makes that moment easy to make.
    const lumiverse = new Lumiverse();
    const chat = lumiverse.newChat(USER);
    lumiverse.imported(chat.id, lines(3));
    const file = lumiverseFile({ journal: "delete" });
    mirror(lumiverse, file);
    const { db, waits } = reader(file.path);
    await db.readChat(chat.id);

    file.writer.run("BEGIN EXCLUSIVE");
    file.writer.query("UPDATE chats SET name = 'The harbour at night' WHERE id = ?").run(chat.id);
    const failed = await db.readChat(chat.id).catch((error: unknown) => error);

    expect(failed).toBeInstanceOf(Error);
    expect(failed).not.toBeInstanceOf(DatabaseOff);
    expect(failed).toMatchObject({ message: `Lumiverse's database stayed locked by another connection through 4 tries while the runtime read chat ${chat.id}; it reads it again next time.` });
    expect(waits).toEqual([25, 50, 100]);
    expect(db.describe()).toMatchObject({ on: true, why: null });
    file.writer.run("COMMIT");
    expect((await db.readChat(chat.id))?.chat.name).toBe("The harbour at night");
  });
});

describe("a file it can't read", () => {
  test("no file at its path turns it off, saying so, and every call rejects alike", async () => {
    const file = lumiverseFile();
    const missing = join(file.folder, "elsewhere.db");
    const { db, logs } = reader(missing);

    const why = `The database reader is off: there is no file at ${missing} (Lumiverse's database was moved or deleted).`;
    for (const error of await everyCall(db, "chat-1", "book-1")) expect(error).toMatchObject({ name: "DatabaseOff", message: why });
    expect(db.describe()).toMatchObject({ on: false, why, open: false });
    expect(logs).toEqual([`warn: [database reader] ${why}`]);
  });

  test("the file taken away after it was read turns it off at the next read", async () => {
    const { chat, file } = harbour();
    const { db } = reader(file.path);
    await db.readChat(chat.id);
    for (const path of [file.path, `${file.path}-wal`, `${file.path}-shm`]) rmSync(path);

    expect(await db.readChat(chat.id).catch((error: unknown) => error)).toMatchObject({ name: "DatabaseOff", message: `The database reader is off: there is no file at ${file.path} (Lumiverse's database was moved or deleted).` });
  });

  // Permissions bind every user but root, which reads anything: run as root, there is nothing to see here.
  test.skipIf(process.getuid?.() === 0)("a file the runtime may not read, or whose -shm it may not read, turns it off naming the file", async () => {
    const unreadable = harbour();
    chmodSync(unreadable.file.path, 0o000);
    expect(await reader(unreadable.file.path).db.readChat(unreadable.chat.id).catch((error: unknown) => error)).toMatchObject({
      name: "DatabaseOff",
      message: `The database reader is off: the runtime isn't allowed to read ${unreadable.file.path} (EACCES).`,
    });

    const hidden = harbour();
    chmodSync(`${hidden.file.path}-shm`, 0o000);
    expect(await reader(hidden.file.path).db.readChat(hidden.chat.id).catch((error: unknown) => error)).toMatchObject({
      name: "DatabaseOff",
      message: `The database reader is off: the runtime isn't allowed to read ${hidden.file.path}-shm (EACCES).`,
    });
  });

  test("a file that isn't a database, or a folder at its path, turns it off saying so", async () => {
    const file = lumiverseFile();
    const text = join(file.folder, "notes.db");
    writeFileSync(text, "Tides, gulls and the lamp: notes, not a database.".repeat(4));
    expect(await reader(text).db.readChat("chat-1").catch((error: unknown) => error)).toMatchObject({ name: "DatabaseOff", message: `The database reader is off: ${text} isn't a SQLite database.` });

    const folder = join(file.folder, "lumiverse-old.db");
    mkdirSync(folder);
    expect(await reader(folder).db.readChat("chat-1").catch((error: unknown) => error)).toMatchObject({ name: "DatabaseOff", message: `The database reader is off: ${folder} isn't a SQLite database but a folder.` });
  });

  test("while Lumiverse is stopped and its -wal and -shm are gone, a read fails and the reader stays on; it reads once Lumiverse runs again", async () => {
    const { lumiverse, chat, file } = harbour();
    file.writer.close();
    // Lumiverse's last connection checkpointed the file as it closed: the side files hold nothing now.
    rmSync(`${file.path}-wal`, { force: true });
    rmSync(`${file.path}-shm`, { force: true });
    const { db } = reader(file.path);

    const failed = await db.readChat(chat.id).catch((error: unknown) => error);
    expect(failed).not.toBeInstanceOf(DatabaseOff);
    expect(failed).toMatchObject({ message: "Lumiverse's database can't be read now: lumiverse.db-wal isn't beside it, as when Lumiverse isn't running, and the reader doesn't make it." });
    expect(db.describe()).toMatchObject({ on: true, open: false });
    expect(statSync(`${file.path}-wal`, { throwIfNoEntry: false })).toBeUndefined();

    const running = new Database(file.path);
    try {
      running.query("SELECT count(*) FROM chats").get();
      expect(chatRows(await db.readChat(chat.id))).toEqual(chatRows(await httpSource(lumiverse).readChat(chat.id)));
    } finally {
      db.close();
      running.close();
    }
  });

  test("another database put at its path is opened afresh and read, and a mark given before says it changed", async () => {
    const first = new Lumiverse();
    const old = first.newChat(USER, { id: "chat-old" });
    first.imported(old.id, lines(2));
    const oldFile = lumiverseFile({ journal: "delete" });
    mirror(first, oldFile);
    const second = new Lumiverse();
    const fresh = second.newChat(USER, { id: "chat-new" });
    second.imported(fresh.id, lines(3, 10));
    const newFile = lumiverseFile({ journal: "delete" });
    mirror(second, newFile);
    const { db } = reader(oldFile.path);
    const mark = await db.changedSince(null);
    expect(await db.readChat(old.id)).not.toBeNull();

    renameSync(newFile.path, oldFile.path);

    expect((await db.changedSince(mark.mark)).changed).toBe(true);
    expect(await db.readChat(old.id)).toBeNull();
    expect(chatRows(await db.readChat(fresh.id))).toEqual(chatRows(await httpSource(second).readChat(fresh.id)));
  });
});

describe("a long chat read in pages", () => {
  test("a message put in before others by another connection between two pages: the read starts again and gives the chat as it is after", async () => {
    const { lumiverse, chat, rows, file } = harbour(7);
    let pauses = 0;
    const { db } = reader(file.path, {
      page: 3,
      pause: async () => {
        if (pauses++ > 0) return;
        lumiverse.insertBefore(rows[1]?.id ?? "", "A gull lands on the lamp.");
        mirror(lumiverse, file);
      },
    });

    const read = await db.readChat(chat.id);

    expect(chatRows(read)).toEqual(chatRows(await httpSource(lumiverse).readChat(chat.id)));
    expect(read?.messages.map((m) => m.row.index)).toEqual([0, 1, 2, 3, 4, 5, 6, 7]);
    expect(read?.messages[1]?.row.content).toBe("A gull lands on the lamp.");
    expect(read?.fingerprint).toBe((await db.chatSignature(chat.id))?.fingerprint ?? "");
    // Two pauses in the read that saw the change, two in the one after it.
    expect(pauses).toBe(4);
  });

  test("a message deleted between two pages: the read starts again", async () => {
    const { lumiverse, chat, rows, file } = harbour(7);
    let pauses = 0;
    const { db } = reader(file.path, {
      page: 3,
      pause: async () => {
        if (pauses++ > 0) return;
        lumiverse.remove(rows[5]?.id ?? "");
        mirror(lumiverse, file);
      },
    });

    const read = await db.readChat(chat.id);

    expect(chatRows(read)).toEqual(chatRows(await httpSource(lumiverse).readChat(chat.id)));
    expect(read?.messages).toHaveLength(6);
  });

  test("a change elsewhere in the file between two pages is no reason to read again", async () => {
    const { lumiverse, chat, file } = harbour(7);
    const other = lumiverse.newChat(USER);
    let pauses = 0;
    const { db } = reader(file.path, {
      page: 3,
      pause: async () => {
        pauses++;
        lumiverse.say(other.id, `Elsewhere ${pauses}.`);
        mirror(lumiverse, file);
      },
    });

    expect(chatRows(await db.readChat(chat.id))).toEqual(chatRows(await httpSource(lumiverse).readChat(chat.id)));
    expect(pauses).toBe(2);
  });

  test("a chat that keeps changing while it is read isn't given", async () => {
    const { lumiverse, chat, rows, file } = harbour(7);
    let pauses = 0;
    const { db } = reader(file.path, {
      page: 3,
      // Each time, a message already read gets an extra written with no event and no new revision.
      pause: async () => {
        lumiverse.patchExtra(rows[0]?.id ?? "", { mood: "restless".repeat(++pauses) });
        mirror(lumiverse, file);
      },
    });

    expect(await db.readChat(chat.id).catch((error: unknown) => error)).toMatchObject({ message: `Chat ${chat.id} kept changing while it was read (3 times), so it wasn't kept.` });
    expect(db.describe().on).toBe(true);
  });

  test("Lumiverse's checkpoint between two pages of one read finds no read held", async () => {
    const { lumiverse, chat, file } = harbour(7);
    const checkpoints: unknown[] = [];
    const { db } = reader(file.path, {
      page: 3,
      pause: async () => {
        checkpoints.push(file.writer.query("PRAGMA wal_checkpoint(TRUNCATE)").get());
      },
    });

    expect(chatRows(await db.readChat(chat.id))).toEqual(chatRows(await httpSource(lumiverse).readChat(chat.id)));
    expect(checkpoints).toEqual([
      { busy: 0, log: 0, checkpointed: 0 },
      { busy: 0, log: 0, checkpointed: 0 },
    ]);
  });

  test("ten thousand messages are read within a sensible time, and so is their signature", async () => {
    const file = lumiverseFile();
    file.writer.run("INSERT INTO chats (id, user_id, name, metadata, updated_at) VALUES ('chat-long', 'user-mara', 'The long watch', '{}', 1762938000)");
    const insert = file.writer.query("INSERT INTO messages (id, chat_id, index_in_chat, is_user, name, content, send_date, swipe_id, swipes, extra, created_at) VALUES (?, 'chat-long', ?, ?, ?, ?, ?, ?, ?, ?, ?)");
    file.writer.transaction(() => {
      for (let i = 0; i < 10_000; i++) {
        const text = `Watch ${i}: the lamp turns, the tide comes in over the quay stones, and the gulls settle. `.repeat(3);
        const user = i % 2 === 0;
        const swipes = user ? [text] : [text, `${text} (again)`];
        const extra = user ? {} : { reasoningBySwipe: ["The keeper counts the turns.".repeat(20), null], tokenCountBySwipe: [80, 82], spindle_metadata: { lumi_ah: { v: 1, n: i } } };
        insert.run(`msg-${i}`, i, user ? 1 : 0, user ? "Mara" : "Joss", text, 1_762_938_000 + i, 0, JSON.stringify(swipes), JSON.stringify(extra), 1_762_938_000 + i);
      }
    })();
    const { db } = reader(file.path);

    let started = performance.now();
    const read = await db.readChat("chat-long");
    const readMs = performance.now() - started;
    started = performance.now();
    const signature = await db.chatSignature("chat-long");
    const signatureMs = performance.now() - started;

    expect(read?.messages).toHaveLength(10_000);
    expect(read?.messages.at(-1)?.row).toMatchObject({ index: 9_999, role: "assistant", swipes: 2, own: { v: 1, n: 9_999 } });
    expect(signature).toEqual({ count: 10_000, last: read?.messages.at(-1)?.row ?? null, fingerprint: read?.fingerprint ?? "" });
    expect(readMs).toBeLessThan(3_000);
    expect(signatureMs).toBeLessThan(1_000);
  });
});

describe("rows Lumiverse itself can't read", () => {
  test("a message Lumiverse fails on fails its chat's read, naming it; the reader stays on", async () => {
    const { lumiverse, chat, rows, file } = harbour();
    const message = lumiverse.message(rows[2]?.id ?? "");
    message.swipes = "null";
    mirror(lumiverse, file);
    const { db } = reader(file.path);

    expect(await db.readChat(chat.id).catch((error: unknown) => error)).toMatchObject({
      message: `Lumiverse itself can't read message ${message.id} of chat ${chat.id} (its swipes are null), so the chat isn't read from its database either.`,
    });
    expect(db.describe().on).toBe(true);
  });

  test("an entry Lumiverse fails on fails its book's read, naming it", async () => {
    const lumiverse = new Lumiverse();
    const book = lumiverse.newBook(USER);
    const entry = lumiverse.addEntry(book.id, { comment: "Tide", content: "The quay floods." });
    entry.key = "[tide";
    const file = lumiverseFile();
    mirror(lumiverse, file);

    expect(await reader(file.path).db.readBook(book.id, null).catch((error: unknown) => error)).toMatchObject({
      message: `Lumiverse itself can't read entry ${entry.id} of world book ${book.id} (its keys aren't JSON), so the book isn't read from its database either.`,
    });
  });
});

describe("what a page is shown", () => {
  test("where the file is, whether the reader is on, its check of the schema, and its last read and check", async () => {
    const { chat, file } = harbour(4);
    const { db } = reader(file.path);
    expect(db.describe()).toEqual({ path: file.path, on: true, why: null, open: false, schema: { checkedAt: null, matches: null, difference: null }, lastRead: null, lastCheck: null });

    await db.readChat(chat.id);
    await db.chatSignature(chat.id);
    await db.readChat("chat-nowhere");

    const state = db.describe();
    expect(state).toMatchObject({ path: file.path, on: true, why: null, open: true, schema: { checkedAt: NOW, matches: true, difference: null } });
    expect(state.lastRead).toMatchObject({ at: NOW, what: "chat chat-nowhere", rows: 0, chars: 0, outcome: "none such" });
    expect(state.lastCheck).toMatchObject({ at: NOW, what: `chat ${chat.id}'s signature`, rows: 5, outcome: "read" });
    await db.readChat(chat.id);
    expect(db.describe().lastRead).toMatchObject({ what: `chat ${chat.id}`, rows: 5, outcome: "read" });
    expect(db.describe().lastRead?.chars).toBeGreaterThan(4 * "Line 0 of the harbour log.".length);
  });
});
