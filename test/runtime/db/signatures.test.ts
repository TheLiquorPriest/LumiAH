// What the database reader says cheaply (PI-BUILD-PLAN §4.6): a chat's signature (its count, its newest
// message and a fingerprint of the whole chat) and a book's, which move with every change Lumiverse
// makes to what the copy holds of them, the changes it tells of nowhere included, and stay as they are
// with any other; and whether anything at all changed in the file since a mark it gave. Then the copy
// over the reader, which catches a change in a chat's middle that no event told of, and the copy's
// source that hands over to HTTP when the reader turns itself off. Every chat, book, name and text here
// is invented.

import { afterEach, describe, expect, test } from "bun:test";
import { createHostCopy, type HostReads } from "../../../src/runtime/copy";
import type { CopySource } from "../../../src/runtime/copy/source";
import { type DbSource, preferDatabase } from "../../../src/runtime/db";
import { Lumiverse } from "../copy/lumiverse";
import { bookRows, chatRows, httpSource, LUMIAH, lumiverseFile, mirror, reader, removeFiles, USER } from "./rig";

afterEach(removeFiles);

const lines = (n: number): string[] => Array.from({ length: n }, (_, i) => `Line ${i} of the harbour log.`);

/** A chat of the user's, its last message a reply of two swipes, in a file Lumiverse has open. */
function harbour() {
  const lumiverse = new Lumiverse();
  const chat = lumiverse.newChat(USER, { metadata: { ltcm_config_hash: "a1" } });
  const rows = lumiverse.imported(chat.id, lines(6));
  const reply = lumiverse.say(chat.id, "Ilse does, since the storm.", { swipes: ["Ilse does, since the storm.", "Nobody, since the storm."] });
  const file = lumiverseFile();
  mirror(lumiverse, file);
  return { lumiverse, chat, rows, reply, file };
}

/** A book of the user's with three entries, in a file Lumiverse has open. */
function quay() {
  const lumiverse = new Lumiverse();
  const book = lumiverse.newBook(USER, { metadata: { lumibooks_summary: { at: "a1" } } });
  const entries = ["Tide", "Keeper", "Bollard"].map((name, i) => lumiverse.addEntry(book.id, { comment: name, content: `The ${name.toLowerCase()} of the quay.`, order: 10 * (i + 1) }));
  const file = lumiverseFile();
  mirror(lumiverse, file);
  return { lumiverse, book, entries, file };
}

describe("a chat's signature", () => {
  test("is its count, its newest message as the read gives it, and the read's own fingerprint", async () => {
    const { chat, file } = harbour();
    const { db } = reader(file.path);

    const read = await db.readChat(chat.id);
    const signature = await db.chatSignature(chat.id);

    expect(signature).toEqual({ count: 7, last: read?.messages.at(-1)?.row ?? null, fingerprint: read?.fingerprint ?? "" });
    expect(signature?.last).toMatchObject({ content: "Ilse does, since the storm.", swipes: 2 });
  });

  test("moves with every change Lumiverse makes to what the copy holds, the ones it tells of nowhere included", async () => {
    const { lumiverse, chat, rows, reply, file } = harbour();
    const id = (i: number): string => rows[i]?.id ?? "";
    const { db } = reader(file.path);
    let seen = (await db.chatSignature(chat.id))?.fingerprint;
    // Each a write as Lumiverse makes it: the ones that say "no event" or "no new revision" are what HTTP can't see in a chat's middle.
    const changes: [string, () => void][] = [
      ["an extra written in the middle, with no event and no new revision", () => lumiverse.patchExtra(id(2), { reasoningBySwipe: ["Counting the lamp's turns."] })],
      ["messages hidden all at once, with no new revision", () => lumiverse.hide([id(1), id(3)], true)],
      ["messages imported, with no event", () => lumiverse.imported(chat.id, ["An old log.", "An older log."])],
      ["a message put in before others, the later ones moved up a place with no event of their own", () => lumiverse.insertBefore(id(1), "A gull lands on the lamp.")],
      ["a message deleted in the middle", () => lumiverse.remove(id(4))],
      ["a reply's other swipe shown, with no new revision", () => Object.assign(lumiverse.message(reply.id), { swipe_id: 1, content: "Nobody, since the storm." })],
      ["the user's messages given a name of the same length, with no event for any message", () => lumiverse.reattribute(chat.id, "Ilse")],
      ["the chat's metadata rewritten in place, its length and its stamp the same", () => Object.assign(lumiverse.chats.get(chat.id) ?? {}, { metadata: { ltcm_config_hash: "b2" } })],
      ["the extension's own entry written on an older message", () => lumiverse.setOwn(id(0), LUMIAH, { v: 2 })],
    ];
    for (const [what, change] of changes) {
      change();
      mirror(lumiverse, file);
      const now = await db.chatSignature(chat.id);
      expect({ what, moved: now?.fingerprint !== seen }).toEqual({ what, moved: true });
      expect({ what, read: (await db.readChat(chat.id))?.fingerprint }).toEqual({ what, read: now?.fingerprint });
      seen = now?.fingerprint;
    }
  });

  test("stays as it is while nothing the copy holds of the chat changed", async () => {
    const { lumiverse, chat, rows, file } = harbour();
    const other = lumiverse.newChat(USER);
    const book = lumiverse.newBook(USER);
    file.writer.run("ALTER TABLE messages ADD COLUMN parent_message_id TEXT");
    mirror(lumiverse, file);
    const { db } = reader(file.path);
    const before = await db.chatSignature(chat.id);

    lumiverse.say(other.id, "Another chat goes on.");
    lumiverse.addEntry(book.id, { comment: "Tide", content: "The quay floods." });
    mirror(lumiverse, file);
    file.writer.query("UPDATE messages SET parent_message_id = ? WHERE id = ?").run(rows[0]?.id ?? "", rows[1]?.id ?? "");
    file.writer.query("PRAGMA wal_checkpoint(TRUNCATE)").get();

    expect(await db.chatSignature(chat.id)).toEqual(before);
  });
});

describe("a book's signature", () => {
  test("is the read's own, and a book read again unchanged is the read held, its entries not read again", async () => {
    const { book, file } = quay();
    const { db } = reader(file.path);

    const held = await db.readBook(book.id, null);
    expect(await db.bookSignature(book.id, held)).toBe(held?.signature ?? "");
    expect(await db.readBook(book.id, held)).toBe(held);
    expect(db.describe().lastRead).toMatchObject({ what: `world book ${book.id}`, chars: 0, outcome: "read" });
  });

  test("moves with every change to what the copy holds of a book, and stays with any other", async () => {
    const { lumiverse, book, entries, file } = quay();
    const other = lumiverse.newBook(USER);
    const id = (i: number): string => entries[i]?.id ?? "";
    file.writer.run("ALTER TABLE world_book_entries ADD COLUMN vector_index_status TEXT NOT NULL DEFAULT 'not_enabled'");
    const { db } = reader(file.path);
    let seen = await db.bookSignature(book.id, null);

    const changes: [string, () => void][] = [
      ["an entry's text changed", () => lumiverse.updateEntry(id(0), { content: "The quay floods at every spring tide." })],
      ["the entries reordered all at once", () => lumiverse.bulk(book.id, (rows) => rows.forEach((row, i) => Object.assign(row, { order_value: 100 - i })))],
      ["an entry deleted", () => lumiverse.deleteEntry(id(1))],
      ["an entry made", () => lumiverse.addEntry(book.id, { comment: "Lantern", content: "A lantern on the last bollard." })],
      ["the book's metadata rewritten in place, its length and its stamp the same", () => Object.assign(lumiverse.books.get(book.id) ?? {}, { metadata: JSON.stringify({ lumibooks_summary: { at: "b2" } }) })],
      ["an entry's keys rewritten in place, with no new revision", () => Object.assign(lumiverse.entries.get(id(2)) ?? {}, { key: JSON.stringify(["dollard"]) })],
    ];
    for (const [what, change] of changes) {
      change();
      mirror(lumiverse, file);
      const now = await db.bookSignature(book.id, null);
      expect({ what, moved: now !== seen }).toEqual({ what, moved: true });
      expect({ what, read: (await db.readBook(book.id, null))?.signature }).toEqual({ what, read: now });
      seen = now;
    }

    lumiverse.addEntry(other.id, { comment: "Elsewhere", content: "Another book." });
    mirror(lumiverse, file);
    file.writer.query("UPDATE world_book_entries SET vector_index_status = 'indexed' WHERE world_book_id = ?").run(book.id);
    expect(await db.bookSignature(book.id, null)).toBe(seen);
  });
});

describe("whether anything changed in the file", () => {
  test("since nothing it may have; since its own mark, no, its own reads included, until another connection writes", async () => {
    const { lumiverse, chat, file } = harbour();
    const { db } = reader(file.path);

    const first = await db.changedSince(null);
    expect(first.changed).toBe(true);
    await db.readChat(chat.id);
    await db.chatSignature(chat.id);
    const second = await db.changedSince(first.mark);
    expect(second).toEqual({ changed: false, mark: first.mark });

    lumiverse.say(chat.id, "A gull lands on the lamp.");
    mirror(lumiverse, file);
    const third = await db.changedSince(second.mark);
    expect(third.changed).toBe(true);
    expect(third.mark).not.toBe(second.mark);
  });

  test("a mark another reader gave says nothing about this one: it may have changed", async () => {
    const { file } = harbour();
    const one = reader(file.path).db;
    const another = reader(file.path).db;

    const mark = (await one.changedSince(null)).mark;
    expect(await another.changedSince(null)).toMatchObject({ changed: true });

    expect((await another.changedSince(mark)).changed).toBe(true);
  });
});

/** A fallback for the copy that fails the test whenever it is asked: every read here is the reader's. */
const NO_FALLBACK = new Proxy(
  {},
  {
    get: (_, port) =>
      new Proxy(
        {},
        {
          get: (__, method) => async () => {
            throw new Error(`the copy asked its fallback (${String(port)}.${String(method)})`);
          },
        },
      ),
  },
) as HostReads;

function copyOver(source: CopySource, clock: { now: number }) {
  return createHostCopy({ source, fallback: NO_FALLBACK, userId: USER, identifier: LUMIAH, granted: () => true, now: () => clock.now, log: () => undefined });
}

describe("the copy over the reader", () => {
  test("catches a change in a chat's middle that no event told of at its check before use, and reads the chat again", async () => {
    const { lumiverse, chat, rows, file } = harbour();
    const { db } = reader(file.path);
    const clock = { now: Date.UTC(2026, 10, 12, 9, 30, 0) };
    const copy = copyOver(db, clock);
    await copy.chats.messages(chat.id);

    lumiverse.patchExtra(rows[2]?.id ?? "", { hidden: true });
    mirror(lumiverse, file);
    clock.now += 1_000;
    const now = await copy.chats.messages(chat.id);

    expect(now).toEqual((await httpSource(lumiverse).readChat(chat.id))?.messages.map((m) => m.row) ?? []);
    expect(now[2]?.hidden).toBe(true);
    expect(copy.state().chats[0]).toMatchObject({ from: "database", read: { why: "the check before use found the chat changed since it was read" } });
  });

  test("a file that says nothing changed spares the check before use its signature", async () => {
    const { chat, file } = harbour();
    const { db } = reader(file.path);
    const clock = { now: Date.UTC(2026, 10, 12, 9, 30, 0) };
    const copy = copyOver(db, clock);
    await copy.chats.messages(chat.id);

    clock.now += 1_000;
    await copy.chats.messages(chat.id);
    expect(db.describe().lastCheck?.what).toBe(`chat ${chat.id}'s signature`);
    clock.now += 1_000;
    await copy.chats.messages(chat.id);
    expect(db.describe().lastCheck?.what).toBe("the file's change counter");
  });
});

describe("the copy's source where the reader may be used", () => {
  test("reads from the reader while it is on, from HTTP once it turned itself off, and the page can say why", async () => {
    const { lumiverse, chat, file } = harbour();
    const { db } = reader(file.path);
    const http = httpSource(lumiverse);
    const source = preferDatabase(() => db, http);

    expect(source.kind).toBe("database");
    const fromFile = await source.readChat(chat.id);
    // Nothing went over HTTP for it.
    expect(lumiverse.asked).toEqual([]);
    expect(chatRows(fromFile)).toEqual(chatRows(await http.readChat(chat.id)));

    file.writer.run("ALTER TABLE messages DROP COLUMN revision");
    const asked = lumiverse.asked.length;
    const read = await source.readChat(chat.id);

    expect(lumiverse.asked.length).toBeGreaterThan(asked);
    expect(read).toEqual(await http.readChat(chat.id));
    expect(source.kind).toBe("http");
    expect(db.describe()).toMatchObject({ on: false, why: `The database reader is off: table "messages" in Lumiverse's database has no column "revision".` });
  });

  test("with no reader (the owner's switch off), or a closed one, it is HTTP's", async () => {
    const { lumiverse, chat, file } = harbour();
    const http = httpSource(lumiverse);
    let db: DbSource | null = null;
    const source = preferDatabase(() => db, http);

    expect(source.kind).toBe("http");
    expect(await source.changedSince(null)).toEqual({ changed: null, mark: null });

    db = reader(file.path).db;
    expect(source.kind).toBe("database");
    expect((await source.changedSince(null)).changed).toBe(true);

    db.close();
    expect(source.kind).toBe("http");
    expect(bookRows(await source.readBook("book-nowhere", null))).toBeNull();
    expect(chatRows(await source.readChat(chat.id))).toEqual(chatRows(await http.readChat(chat.id)));
  });

  test("any other failure of the reader is that one call's: it isn't handed to HTTP", async () => {
    const lumiverse = new Lumiverse();
    const chat = lumiverse.newChat(USER);
    lumiverse.imported(chat.id, lines(2));
    const file = lumiverseFile({ journal: "delete" });
    mirror(lumiverse, file);
    const { db } = reader(file.path, { tries: 1 });
    const source = preferDatabase(() => db, httpSource(lumiverse));
    await source.readChat(chat.id);

    file.writer.run("BEGIN EXCLUSIVE");
    file.writer.query("UPDATE chats SET name = 'Locked' WHERE id = ?").run(chat.id);
    try {
      expect(await source.readChat(chat.id).catch((error: unknown) => error)).toMatchObject({ message: expect.stringContaining("stayed locked by another connection") });
      expect(lumiverse.asked).toEqual([]);
      expect(source.kind).toBe("database");
    } finally {
      file.writer.run("COMMIT");
    }
  });
});
