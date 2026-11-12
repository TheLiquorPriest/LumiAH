// The runtime's copy of chat and lore (PI-BUILD-PLAN §4.5), against a made-up Lumiverse and the
// extension's own host over it: read whole once, kept current by Lumiverse's events as the extension
// forwards them, read again (never patched by guess) when the link reopened, when a message was put in
// before others, when a book changed as a whole, when an event can't be applied and when the check
// before use disagrees; one read for everyone who wants a chat while it is read, and what was heard
// meanwhile applied to it once; the extension's host for whatever the copy can't vouch for, with that
// answer not kept; the mounting extension's own entries; lore declined; a memory budget; one user's rows
// only; and the state a page shows. Each answer is held against the extension's own host's answer for
// the same Lumiverse. Every chat, book, name and text here is invented.

import { afterEach, describe, expect, test } from "bun:test";
import type { JsonValue } from "../../../src/core/ports";
import { Chats } from "../../../src/extension/backend/chat";
import { Lore } from "../../../src/extension/backend/reads";
import { KEEP_CHARS } from "../../../src/runtime/copy";
import { createHttpSource } from "../../../src/runtime/copy/http";
import { linkedBackendOf } from "../../../src/link/frames";
import { transportWait } from "../../../src/link/waits";
import { INSERTED } from "../../../src/runtime/copy/kept";
import type { CopySource } from "../../../src/runtime/copy/source";
import { Lumiverse, type MessageRow } from "./lumiverse";
import { type CopyRig, LUMIAH, OTHER, restoreSpindle, rigCopy, USER } from "./rig";

afterEach(restoreSpindle);

const lines = (n: number, from = 0): string[] => Array.from({ length: n }, (_, i) => `Line ${from + i} of the harbour log.`);

/** How many times a chat was read whole: its first page asked for. */
const wholeReads = (lumiverse: Lumiverse, chatId: string): number => lumiverse.asked.filter((p) => p === `/api/v1/chats/${chatId}/messages?limit=1000&offset=0`).length;
/** How many times a chat was checked before use: its newest message asked for. */
const checks = (lumiverse: Lumiverse, chatId: string): number => lumiverse.asked.filter((p) => p === `/api/v1/chats/${chatId}/messages?tail=true&limit=1`).length;
/** How many times a book was asked for whole. */
const bookReads = (lumiverse: Lumiverse, bookId: string): number => lumiverse.asked.filter((p) => p.startsWith(`/api/v1/world-books/${bookId}?`)).length;

/** A chat of a user's question, a reply and an aside, and the rig over it, the chat read once. */
async function harbour(rig: CopyRig = rigCopy()) {
  const { lumiverse } = rig;
  const chat = lumiverse.newChat(USER, { metadata: { chat_world_book_ids: ["book-quay"] } });
  const asked = lumiverse.say(chat.id, "Who keeps the harbour light now?", { user: true });
  const reply = lumiverse.say(chat.id, "Ilse does, since the storm.");
  const aside = lumiverse.say(chat.id, "(Gulls circle the lamp.)", { name: "Narrator", extra: { spindle_role: "system" } });
  rig.forward();
  await rig.copy.chats.messages(chat.id);
  return { ...rig, chat, asked, reply, aside };
}

/** The copy's answers for a chat, held against the extension's host's. */
async function same(rig: CopyRig, chatId: string): Promise<void> {
  expect(await rig.copy.chats.messages(chatId)).toEqual(await rig.host.chats.messages(chatId));
  expect(await rig.copy.chats.get(chatId, USER)).toEqual(await rig.host.chats.get(chatId, USER));
}

describe("a chat is read whole once, then kept by Lumiverse's events", () => {
  test("read whole the first time it is wanted; every read after that is answered from the copy", async () => {
    const rig = rigCopy();
    const chat = rig.lumiverse.newChat(USER);
    rig.lumiverse.imported(chat.id, lines(5));

    await same(rig, chat.id);
    expect(await rig.copy.chats.messages(chat.id, { tail: 2 })).toEqual(await rig.host.chats.messages(chat.id, { tail: 2 }));
    expect(await rig.copy.chats.messages(chat.id, { from: 1, count: 3 })).toEqual(await rig.host.chats.messages(chat.id, { from: 1, count: 3 }));

    expect(rig.lumiverse.asked).toEqual([`/api/v1/chats/${chat.id}?messages=false`, `/api/v1/chats/${chat.id}/messages?limit=1000&offset=0`]);
    expect(rig.fellBack).toEqual([]);
  });

  test("reads that come while the chat is read wait for that one read", async () => {
    const rig = rigCopy();
    const chat = rig.lumiverse.newChat(USER);
    rig.lumiverse.imported(chat.id, lines(2500));

    const [got, all, tail] = await Promise.all([rig.copy.chats.get(chat.id, USER), rig.copy.chats.messages(chat.id), rig.copy.chats.messages(chat.id, { tail: 3 })]);

    expect(got).toEqual(await rig.host.chats.get(chat.id, USER));
    expect(all).toHaveLength(2500);
    expect(tail.map((m) => m.content)).toEqual(lines(3, 2497));
    expect(wholeReads(rig.lumiverse, chat.id)).toBe(1);
  });

  test("every change Lumiverse tells of is applied as told, with nothing read again", async () => {
    const rig = await harbour();
    const { lumiverse, chat, asked, reply, aside } = rig;
    const reads = lumiverse.asked.length;
    const changes: (() => void)[] = [
      () => lumiverse.say(chat.id, "The gulls came back at dawn."),
      () => lumiverse.edit(asked.id, "Who keeps the harbour light, now that the storm is over?"),
      // Hidden or shown, a message gets no new revision.
      () => lumiverse.hide([aside.id], true),
      () => lumiverse.addSwipe(reply.id, "Nobody keeps it; it keeps itself."),
      () => lumiverse.showSwipe(reply.id, 0),
      () => lumiverse.editSwipe(reply.id, 1, "Nobody keeps it, they say; it keeps itself."),
      () => lumiverse.setOwn(reply.id, LUMIAH, { v: 1, swipes: { "0": { generationId: "gen-3" } } }),
      () => lumiverse.hide([aside.id], false),
      () => lumiverse.remove(asked.id),
      () => lumiverse.changeChat(chat.id, { name: "Harbour, after the storm", metadata: { pinned: true } }),
    ];
    for (const change of changes) {
      change();
      rig.forward();
      await same(rig, chat.id);
    }
    expect(await rig.copy.chats.swipe(chat.id, reply.id, 1)).toBe("Nobody keeps it, they say; it keeps itself.");
    expect(lumiverse.asked.length).toBe(reads);
    expect(rig.fellBack).toEqual([]);
  });

  test("what is heard while the chat is read is applied to the read once it lands, in order, once", async () => {
    const rig = rigCopy();
    const { lumiverse } = rig;
    const chat = lumiverse.newChat(USER);
    const rows = lumiverse.imported(chat.id, lines(1500));
    const third = rows[2]?.id ?? "";
    // While the second page is read, the first page's third message is edited twice and hidden: the first page holds none of it.
    lumiverse.whileAsked(/offset=999/, () => {
      lumiverse.edit(third, "Edited once.");
      lumiverse.edit(third, "Edited twice.");
      lumiverse.hide([third], true);
      rig.forward();
    });

    const all = await rig.copy.chats.messages(chat.id);

    expect(all[2]).toMatchObject({ content: "Edited twice.", hidden: true });
    expect(all).toEqual(await rig.host.chats.messages(chat.id));
    expect(wholeReads(lumiverse, chat.id)).toBe(1);
  });

  test("a message sent while the chat is read, which the read holds already, is held once", async () => {
    const rig = rigCopy();
    const { lumiverse } = rig;
    const chat = lumiverse.newChat(USER);
    lumiverse.imported(chat.id, lines(3));
    lumiverse.whileAsked(/offset=0/, () => {
      lumiverse.say(chat.id, "A late line.");
      rig.forward();
    });

    const all = await rig.copy.chats.messages(chat.id);

    expect(all.map((m) => m.content)).toEqual([...lines(3), "A late line."]);
    expect(all).toEqual(await rig.host.chats.messages(chat.id));
  });
});

describe("a chat is read again, never patched by guess", () => {
  test("when a message is put in before others: every later one moved", async () => {
    const rig = await harbour();
    rig.lumiverse.insertBefore(rig.reply.id, "(A bell rings.)");
    rig.forward();

    await same(rig, rig.chat.id);
    expect((await rig.copy.chats.messages(rig.chat.id)).map((m) => m.index)).toEqual([0, 1, 2, 3]);
    expect(wholeReads(rig.lumiverse, rig.chat.id)).toBe(2);
    expect(rig.copy.state().chats[0]?.read.why).toBe(INSERTED);
  });

  test("when the link reopened: what was missed meanwhile is caught, in chats and books", async () => {
    const rig = await harbour();
    const book = rig.lumiverse.newBook(USER, { id: "book-quay" });
    const tide = rig.lumiverse.addEntry(book.id, { comment: "Tide", content: "The quay floods at spring tide." });
    rig.forward();
    await rig.copy.lore.records(book.id, USER);
    rig.lumiverse.edit(rig.reply.id, "Ilse does, and has since the storm.");
    rig.lumiverse.updateEntry(tide.id, { content: "The quay floods at every spring tide." });
    rig.lose();

    rig.copy.reopened();

    await same(rig, rig.chat.id);
    expect(await rig.copy.lore.records(book.id, USER)).toEqual(await rig.host.lore.records(book.id, USER));
    expect(rig.copy.state().chats[0]?.read.why).toBe("the link to the extension reopened, so events may have been missed");
    expect(rig.copy.state().books[0]?.read.why).toBe("the link to the extension reopened, so events may have been missed");
  });

  test("when an event tells of a message the copy doesn't hold", async () => {
    const rig = await harbour();
    // Imported with no event: the copy doesn't know of it yet, then Lumiverse tells of an edit to it.
    const [late] = rig.lumiverse.imported(rig.chat.id, ["An imported line."]);
    rig.lumiverse.edit(late?.id ?? "", "An imported line, edited.");
    rig.forward();

    await same(rig, rig.chat.id);
    expect(wholeReads(rig.lumiverse, rig.chat.id)).toBe(2);
    expect(rig.copy.state().chats[0]?.read.why).toBe("Lumiverse changed a message the copy doesn't hold");
  });

  test("when Lumiverse gives the user's messages to another persona all at once", async () => {
    const rig = await harbour();
    rig.lumiverse.reattribute(rig.chat.id, "Mara of the Quay");
    rig.forward();

    await same(rig, rig.chat.id);
    expect((await rig.copy.chats.messages(rig.chat.id))[0]?.name).toBe("Mara of the Quay");
  });

  test("when the check before use finds more messages than held: an import tells of none", async () => {
    const rig = await harbour();
    rig.lumiverse.imported(rig.chat.id, lines(2));

    // The check before use holds for a moment: the reads of one step of a run cost one check.
    expect(await rig.copy.chats.messages(rig.chat.id)).toHaveLength(3);
    expect(checks(rig.lumiverse, rig.chat.id)).toBe(0);

    rig.clock.now += 1_000;
    await same(rig, rig.chat.id);
    expect(checks(rig.lumiverse, rig.chat.id)).toBe(1);
    expect(wholeReads(rig.lumiverse, rig.chat.id)).toBe(2);
    expect(rig.copy.state().chats[0]?.read.why).toBe("the check before use found 5 messages in the chat where the copy holds 3");
  });

  test("when the check before use finds the newest message changed with no word of it", async () => {
    const rig = await harbour();
    rig.lumiverse.patchExtra(rig.aside.id, { hidden: true });

    rig.clock.now += 1_000;
    await same(rig, rig.chat.id);
    expect(wholeReads(rig.lumiverse, rig.chat.id)).toBe(2);
    expect(rig.copy.state().chats[0]?.read.why).toBe("the check before use found the newest message changed with no word from Lumiverse");
  });

  test("a check that finds the chat as held costs two small requests at once, and no read", async () => {
    const rig = await harbour();
    rig.clock.now += 5_000;

    await same(rig, rig.chat.id);
    expect(checks(rig.lumiverse, rig.chat.id)).toBe(1);
    expect(rig.lumiverse.asked.filter((p) => p === `/api/v1/chats/${rig.chat.id}?messages=false`)).toHaveLength(2);
    expect(wholeReads(rig.lumiverse, rig.chat.id)).toBe(1);
  });

  test("when the check before use finds the chat's own fields changed with no word of them: Lumiverse writes some of its metadata with no event", async () => {
    const rig = await harbour();
    rig.lumiverse.stampChat(rig.chat.id, "ltcm_config_hash", "b2");

    // Within the check's time, the chat is used as held.
    expect((await rig.copy.chats.get(rig.chat.id, USER))?.metadata).toEqual({ chat_world_book_ids: ["book-quay"] });
    rig.clock.now += 1_000;
    await same(rig, rig.chat.id);
    expect((await rig.copy.chats.get(rig.chat.id, USER))?.metadata).toEqual({ chat_world_book_ids: ["book-quay"], ltcm_config_hash: "b2" });
    expect(rig.copy.state().chats[0]?.read.why).toBe("the check before use found the chat's own fields changed with no word from Lumiverse");
  });
});

describe("two messages at one place", () => {
  /** A chat of nine messages whose last two share a place: the later stored sorts first by id ("msg-10" before "msg-9"). */
  function twins(rig: CopyRig) {
    const chat = rig.lumiverse.newChat(USER);
    const rows = rig.lumiverse.imported(chat.id, lines(9));
    const [ninth, tenth] = [rows[7], rows[8]] as [MessageRow, MessageRow];
    tenth.index_in_chat = ninth.index_in_chat;
    return { chat, ninth, tenth };
  }

  test("come as the host gives them: a whole chat or a range as Lumiverse stored them, a tail by id", async () => {
    const rig = rigCopy();
    const { chat, ninth, tenth } = twins(rig);
    expect(tenth.id < ninth.id).toBe(true);

    await same(rig, chat.id);
    for (const tail of [1, 2, 3, 9, 20]) expect(await rig.copy.chats.messages(chat.id, { tail })).toEqual(await rig.host.chats.messages(chat.id, { tail }));
    for (const [from, count] of [[6, 2], [7, 1], [8, 1], [0, 9]] as const) expect(await rig.copy.chats.messages(chat.id, { from, count })).toEqual(await rig.host.chats.messages(chat.id, { from, count }));
    // What those orders are, so the sameness isn't of two empty lists.
    expect((await rig.copy.chats.messages(chat.id, { tail: 2 })).map((m) => m.id)).toEqual([tenth.id, ninth.id]);
    expect((await rig.copy.chats.messages(chat.id)).slice(-2).map((m) => m.id)).toEqual([ninth.id, tenth.id]);
  });

  test("at the newest place, the check before use agrees with the copy whichever of the two the source names: no read again", async () => {
    const rig = rigCopy();
    const { chat } = twins(rig);
    await rig.copy.chats.messages(chat.id);

    for (let i = 0; i < 3; i++) {
      rig.clock.now += 1_000;
      await same(rig, chat.id);
    }
    expect(checks(rig.lumiverse, chat.id)).toBe(3);
    expect(wholeReads(rig.lumiverse, chat.id)).toBe(1);
  });
});

/**
 * A source as the database reader will be: the HTTP source's rows, a mark that moves with every change
 * Lumiverse makes (its `data_version`), and a fingerprint of a whole chat from what only its tables
 * show (each message's revision and the length of its extras).
 */
function databaseLike(lumiverse: Lumiverse): CopySource {
  const http = createHttpSource({ fetch: lumiverse.session(USER), identifier: LUMIAH, sleep: async () => undefined });
  const fingerprint = (chatId: string): string => lumiverse.rowsOf(chatId).map((m) => `${m.revision}:${m.extra.length}`).join(",");
  return {
    ...http,
    kind: "database",
    async readChat(id) {
      const print = fingerprint(id);
      const read = await http.readChat(id);
      return read === null ? null : { ...read, fingerprint: print };
    },
    async chatSignature(id) {
      const now = await http.chatSignature(id);
      return now === null ? null : { ...now, fingerprint: fingerprint(id) };
    },
    changedSince: async (mark) => ({ changed: mark === null ? null : mark !== String(lumiverse.version), mark: String(lumiverse.version) }),
  };
}

describe("a source that can say more than HTTP can", () => {
  test("one that says nothing changed spares the check before use", async () => {
    const rig = await harbour(rigCopy({ source: ({ lumiverse }) => databaseLike(lumiverse) }));
    rig.clock.now += 1_000;
    await same(rig, rig.chat.id);
    rig.clock.now += 1_000;
    await same(rig, rig.chat.id);
    rig.clock.now += 1_000;
    await same(rig, rig.chat.id);

    expect(checks(rig.lumiverse, rig.chat.id)).toBe(1);
    expect(rig.copy.state().chats[0]?.from).toBe("database");
  });

  test("one that fingerprints a chat catches a change in its middle that Lumiverse tells of nowhere", async () => {
    const rig = await harbour(rigCopy({ source: ({ lumiverse }) => databaseLike(lumiverse) }));
    rig.lumiverse.patchExtra(rig.asked.id, { hidden: true });
    rig.clock.now += 1_000;

    await same(rig, rig.chat.id);
    expect((await rig.copy.chats.messages(rig.chat.id))[0]?.hidden).toBe(true);
    expect(rig.copy.state().chats[0]?.read.why).toBe("the check before use found the chat changed since it was read");
  });
});

describe("changes Lumiverse makes without an event", () => {
  test("extras of a swipe written with no event leave the host's rows as they were: nothing is read", async () => {
    const rig = await harbour();
    rig.lumiverse.patchExtra(rig.reply.id, { reasoningBySwipe: ["The keys were in the drowned man's coat."], tokenCountBySwipe: [12] });
    rig.clock.now += 1_000;

    await same(rig, rig.chat.id);
    expect(wholeReads(rig.lumiverse, rig.chat.id)).toBe(1);
  });

  test("a branch: the chat branched from stays as held, and the branch is read whole when first wanted", async () => {
    const rig = await harbour();
    const fork = rig.lumiverse.branch(rig.chat.id, rig.reply.id);
    rig.forward();

    await same(rig, rig.chat.id);
    await same(rig, fork.id);
    expect((await rig.copy.chats.messages(fork.id)).map((m) => m.content)).toEqual(["Who keeps the harbour light now?", "Ilse does, since the storm."]);
    expect(wholeReads(rig.lumiverse, rig.chat.id)).toBe(1);
    expect(wholeReads(rig.lumiverse, fork.id)).toBe(1);
  });

  test("a chat deleted with its messages, which Lumiverse tells of as one event: the copy is dropped", async () => {
    const rig = await harbour();
    rig.lumiverse.deleteChat(rig.chat.id);
    rig.forward();

    expect(rig.copy.state().chats).toEqual([]);
    expect(await rig.copy.chats.get(rig.chat.id, USER)).toBeNull();
    expect(await rig.copy.chats.swipe(rig.chat.id, rig.reply.id, 0)).toBeNull();
  });

  test("an entry's vector index written with no event leaves the book's rows as they were, though the book is read again once the check's time has passed", async () => {
    const rig = rigCopy();
    const book = rig.lumiverse.newBook(USER);
    const tide = rig.lumiverse.addEntry(book.id, { comment: "Tide", content: "The quay floods at spring tide." });
    await rig.copy.lore.records(book.id, USER);
    rig.lumiverse.indexed(tide.id);
    rig.clock.now += 5_000;

    expect(await rig.copy.lore.records(book.id, USER)).toEqual(await rig.host.lore.records(book.id, USER));
    expect(bookReads(rig.lumiverse, book.id)).toBe(2);
  });
});

describe("a world book", () => {
  async function quay(rig: CopyRig = rigCopy()) {
    const book = rig.lumiverse.newBook(USER, { id: "book-quay", name: "The quay" });
    const tide = rig.lumiverse.addEntry(book.id, { comment: "Tide", content: "The quay floods at spring tide.", order: 10 });
    const keeper = rig.lumiverse.addEntry(book.id, { comment: "Keeper", content: "Ilse keeps the light.", order: 20 });
    rig.forward();
    await rig.copy.lore.records(book.id, USER);
    return { ...rig, book, tide, keeper };
  }

  async function sameBook(rig: CopyRig, bookId: string): Promise<void> {
    expect(await rig.copy.lore.records(bookId, USER)).toEqual(await rig.host.lore.records(bookId, USER));
    expect(await rig.copy.lore.record(bookId, USER)).toEqual(await rig.host.lore.record(bookId, USER));
  }

  test("changed as a whole (a bulk edit, a batch): read again", async () => {
    const rig = await quay();
    rig.lumiverse.now += 2;
    rig.lumiverse.bulk(rig.book.id, (entries) => {
      for (const e of entries) e.content = `${e.content} (checked)`;
    });
    rig.forward();

    await sameBook(rig, rig.book.id);
    expect(bookReads(rig.lumiverse, rig.book.id)).toBe(2);
    expect(rig.copy.state().books[0]?.read.why).toBe("Lumiverse changed the book as a whole");
  });

  test("an entry deleted: read again, its stamp with it", async () => {
    const rig = await quay();
    rig.lumiverse.now += 2;
    rig.lumiverse.deleteEntry(rig.tide.id);
    rig.forward();

    await sameBook(rig, rig.book.id);
    expect(await rig.copy.lore.entry(rig.tide.id, USER)).toBeNull();
  });

  test("the library changed: every book is read again", async () => {
    const rig = await quay();
    rig.lumiverse.library(USER, () => undefined);
    rig.forward();

    await sameBook(rig, rig.book.id);
    expect(bookReads(rig.lumiverse, rig.book.id)).toBe(2);
    expect(rig.copy.state().books[0]?.read.why).toBe("Lumiverse changed the library of world books");
  });

  test("a deleted book is dropped", async () => {
    const rig = await quay();
    rig.lumiverse.deleteBook(rig.book.id);
    rig.forward();

    expect(rig.copy.state().books).toEqual([]);
    expect(await rig.copy.lore.book(rig.book.id, USER)).toBeNull();
    expect(await rig.copy.lore.entries(rig.book.id, USER)).toEqual([]);
  });

  test("changed by Lumiverse with no event (an extension's namespace in an entry, the book made vectorized): read whole again once the check's time has passed", async () => {
    const rig = await quay();
    rig.lumiverse.setExtension(rig.tide.id, "lumibooks", { tier: 2 });

    // Within the check's time, the book is used as held.
    expect((await rig.copy.lore.records(rig.book.id, USER))[0]?.extensions).toEqual({});
    rig.clock.now += 1_000;
    await sameBook(rig, rig.book.id);
    expect((await rig.copy.lore.records(rig.book.id, USER))[0]?.extensions).toEqual({ lumibooks: { tier: 2 } });
    expect(rig.copy.state().books[0]?.read.why).toBe("Lumiverse changes some of a book's rows with no event, and the source can't say whether it did without reading the book");

    rig.lumiverse.now += 1;
    rig.lumiverse.convertToVectorized(rig.book.id);
    rig.clock.now += 1_000;
    await sameBook(rig, rig.book.id);
    expect((await rig.copy.lore.records(rig.book.id, USER)).map((e) => e.vectorized)).toEqual([true, true]);
    expect(bookReads(rig.lumiverse, rig.book.id)).toBe(3);
  });

  test("renamed twice in one second: the second rename is read too, though Lumiverse's ETag can't tell the two apart", async () => {
    const rig = await quay();
    rig.lumiverse.renameBook(rig.book.id, "The old quay");
    rig.forward();
    expect((await rig.copy.lore.book(rig.book.id, USER))?.name).toBe("The old quay");

    rig.lumiverse.renameBook(rig.book.id, "The new quay");
    rig.forward();
    await sameBook(rig, rig.book.id);
    expect((await rig.copy.lore.book(rig.book.id, USER))?.name).toBe("The new quay");
  });
});

describe("whatever the copy can't vouch for goes to the extension's host, and isn't kept", () => {
  test("a chat not read yet while Lumiverse can't be reached; read whole once it can be", async () => {
    const rig = rigCopy();
    const chat = rig.lumiverse.newChat(USER);
    rig.lumiverse.imported(chat.id, lines(4));
    rig.lumiverse.fail(/messages\?limit=1000&offset=0/, 3, "network");

    expect(await rig.copy.chats.messages(chat.id)).toEqual(await rig.host.chats.messages(chat.id));
    expect(rig.fellBack).toEqual([`chats.messages ${chat.id}`]);
    expect(rig.copy.state().chats).toEqual([]);
    expect(rig.copy.state().fallbacks).toEqual({ total: 1, latest: [{ at: rig.clock.now, what: "chat", id: chat.id, why: `reading it failed: Lumiverse couldn't be reached (fetch failed: connection refused) when it was asked for chat ${chat.id}'s messages, 3 times.` }] });
    expect(rig.logs).toHaveLength(1);

    await same(rig, chat.id);
    expect(rig.fellBack).toHaveLength(1);
    expect(rig.copy.state().chats.map((c) => c.id)).toEqual([chat.id]);
  });

  test("a check before use that fails: the host answers, and the chat is checked again next time", async () => {
    const rig = await harbour();
    rig.lumiverse.fail(/tail=true/, 3, 503);
    rig.clock.now += 1_000;

    expect(await rig.copy.chats.messages(rig.chat.id)).toEqual(await rig.host.chats.messages(rig.chat.id));
    expect(rig.fellBack).toEqual([`chats.messages ${rig.chat.id}`]);
    expect(rig.copy.state().chats.map((c) => c.id)).toEqual([rig.chat.id]);

    await same(rig, rig.chat.id);
    expect(rig.fellBack).toHaveLength(1);
    expect(wholeReads(rig.lumiverse, rig.chat.id)).toBe(1);
  });

  test("a chat to be read again while Lumiverse can't be reached is never answered as it was held", async () => {
    const rig = await harbour();
    rig.lumiverse.insertBefore(rig.reply.id, "(A bell rings.)");
    rig.forward();
    rig.lumiverse.fail(/messages\?limit=1000&offset=0/, 3, 500);

    expect(await rig.copy.chats.messages(rig.chat.id)).toEqual(await rig.host.chats.messages(rig.chat.id));
    expect(rig.copy.state().fallbacks.latest[0]?.why).toStartWith("reading it again failed: Lumiverse answered 500");
    expect(rig.copy.state().chats[0]?.stale).toBe(INSERTED);

    await same(rig, rig.chat.id);
    expect(rig.copy.state().chats[0]?.stale).toBeNull();
  });

  test("a read the extension isn't allowed: its host answers as it would, and nothing is read", async () => {
    const rig = await harbour();
    const book = rig.lumiverse.newBook(USER);
    rig.lumiverse.addEntry(book.id, { comment: "Tide", content: "The quay floods at spring tide." });
    const asked = rig.lumiverse.asked.length;
    rig.granted.delete("world_books");
    rig.granted.delete("chat_mutation");

    expect(await rig.copy.lore.records(book.id, USER)).toEqual([]);
    expect(await rig.copy.lore.book(book.id, USER)).toBeNull();
    await expect(rig.copy.chats.messages(rig.chat.id)).rejects.toThrow("Permission denied: chat_mutation");
    expect(rig.lumiverse.asked.length).toBe(asked);
    expect(rig.copy.state().fallbacks.latest.map((f) => f.why)).toEqual([
      'the extension isn\'t granted the "world_books" permission, so Lumiverse wouldn\'t give it this',
      'the extension isn\'t granted the "world_books" permission, so Lumiverse wouldn\'t give it this',
      'the extension isn\'t granted the "chat_mutation" permission, so Lumiverse wouldn\'t give it this',
    ]);
  });

  test("what the copy doesn't keep is the host's to answer: the chat list, a book's place, an entry of a book not held", async () => {
    const rig = await harbour();
    const book = rig.lumiverse.newBook(USER);
    const tide = rig.lumiverse.addEntry(book.id, { comment: "Tide", content: "The quay floods at spring tide." });

    expect(await rig.copy.lore.entry(tide.id, USER)).toEqual(await rig.host.lore.entry(tide.id, USER));
    expect(await rig.copy.chats.sovereignHand(rig.chat.id, USER)).toBeNull();
    expect(rig.fellBack).toEqual([`lore.entry ${tide.id}`, `chats.sovereignHand ${rig.chat.id}`]);
    expect(rig.copy.state().fallbacks.total).toBe(0);
  });

  test("a write the runtime made through the link: the host answers for the chat until Lumiverse tells of it", async () => {
    const rig = await harbour();
    rig.copy.written(rig.chat.id, rig.reply.id);
    rig.lumiverse.setOwn(rig.reply.id, LUMIAH, { v: 1, swipes: { "0": { generationId: "gen-4" } } });

    expect(await rig.copy.chats.messages(rig.chat.id)).toEqual(await rig.host.chats.messages(rig.chat.id));
    expect(rig.fellBack).toEqual([`chats.messages ${rig.chat.id}`]);
    expect(rig.copy.state().fallbacks.latest[0]?.why).toBe("the runtime wrote on it, and Lumiverse hasn't told of that write yet");

    rig.forward();
    await same(rig, rig.chat.id);
    expect(rig.fellBack).toHaveLength(1);
    expect(wholeReads(rig.lumiverse, rig.chat.id)).toBe(1);
  });

  test("a write Lumiverse never tells of: the chat is read again, and a read begun after the write holds it", async () => {
    const rig = await harbour();
    rig.copy.written(rig.chat.id, rig.reply.id);
    rig.lumiverse.setOwn(rig.reply.id, LUMIAH, { v: 1, swipes: { "0": { generationId: "gen-5" } } });
    rig.lose();
    rig.clock.now += 2_000;

    await same(rig, rig.chat.id);
    expect(rig.fellBack).toEqual([]);
    expect(rig.copy.state().chats[0]?.read.why).toBe("Lumiverse never told of a write the runtime made on it");

    rig.copy.written(rig.chat.id, rig.asked.id);
    rig.lumiverse.edit(rig.asked.id, "Who keeps the light, now?");
    rig.lose();
    rig.copy.reopened();
    rig.clock.now += 1;
    await same(rig, rig.chat.id);
    expect(rig.fellBack).toEqual([]);
  });

  test("a read Lumiverse never answers holds no reader for ever: once its deadline passed, every reader waiting on it goes to the extension's host", async () => {
    // A short deadline on the real clock: the request never answers, so nothing races it.
    const rig = rigCopy({ requestMs: 30 });
    const chat = rig.lumiverse.newChat(USER);
    rig.lumiverse.imported(chat.id, lines(4));
    rig.lumiverse.hang(/messages\?limit=1000&offset=0/);

    const [all, last] = await Promise.all([rig.copy.chats.messages(chat.id), rig.copy.chats.messages(chat.id, { tail: 1 })]);

    expect(all).toEqual(await rig.host.chats.messages(chat.id));
    expect(last).toEqual(await rig.host.chats.messages(chat.id, { tail: 1 }));
    const why = `reading it failed: Lumiverse didn't answer within 30 ms when it was asked for chat ${chat.id}'s messages, so the runtime gave up on it. ${transportWait(["runtime", "copyReadMs"], linkedBackendOf(undefined))} says how long each of the runtime's reads of chat data waits.`;
    expect(rig.fellBack).toEqual([`chats.messages ${chat.id}`, `chats.messages ${chat.id}`]);
    expect(rig.copy.state().fallbacks.latest.map((f) => f.why)).toEqual([why, why]);
    expect(rig.lumiverse.aborted).toEqual([`/api/v1/chats/${chat.id}/messages?limit=1000&offset=0`]);

    // Read afresh when next wanted, and kept.
    await same(rig, chat.id);
    expect(rig.copy.state().chats.map((c) => c.id)).toEqual([chat.id]);
  });
});

describe("the link to the extension going down", () => {
  test("everything kept is read again first, and while the link stays down a chat is read whole whenever its check is due: no event tells of a change before its newest message", async () => {
    const rig = await harbour();
    rig.copy.closed();
    await same(rig, rig.chat.id);
    expect(wholeReads(rig.lumiverse, rig.chat.id)).toBe(2);
    expect(rig.copy.state().chats[0]?.read.why).toBe("the link to the extension went down, so events may have been missed");

    // An edit in the middle of the chat, whose event never comes while the link is down.
    rig.lumiverse.edit(rig.asked.id, "Who keeps the light, now that the storm is over?");
    rig.lose();
    rig.clock.now += 1_000;
    await same(rig, rig.chat.id);
    expect(wholeReads(rig.lumiverse, rig.chat.id)).toBe(3);
    expect(checks(rig.lumiverse, rig.chat.id)).toBe(0);
    expect(rig.copy.state().chats[0]?.read.why).toBe("the link to the extension is down, so nothing tells of a change the check before use can't see");

    // Up again: read once more for what was missed meanwhile, then kept by events and checked as before.
    rig.copy.reopened();
    await same(rig, rig.chat.id);
    rig.clock.now += 1_000;
    await same(rig, rig.chat.id);
    expect(wholeReads(rig.lumiverse, rig.chat.id)).toBe(4);
    expect(checks(rig.lumiverse, rig.chat.id)).toBe(1);
  });

  test("a source whose check sees the whole chat is still checked, not read, while the link is down, and sees an edit in the middle", async () => {
    const rig = await harbour(rigCopy({ source: ({ lumiverse }) => databaseLike(lumiverse) }));
    rig.copy.closed();
    await same(rig, rig.chat.id);
    rig.clock.now += 1_000;
    await same(rig, rig.chat.id);
    expect(wholeReads(rig.lumiverse, rig.chat.id)).toBe(2);
    expect(checks(rig.lumiverse, rig.chat.id)).toBe(1);

    rig.lumiverse.edit(rig.asked.id, "Who keeps the light, now that the storm is over?");
    rig.lose();
    rig.clock.now += 1_000;
    await same(rig, rig.chat.id);
    expect(rig.copy.state().chats[0]?.read.why).toBe("the check before use found the chat changed since it was read");
  });
});

describe("the mounting extension's own entries kept elsewhere than on the message", () => {
  test("taken from it once, read again when it says they changed", async () => {
    const records = new Map<string, JsonValue>();
    let reads = 0;
    const rig = rigCopy({
      identifier: "lantern_ext",
      own: async () => {
        reads++;
        return new Map(records);
      },
    });
    const { chat, reply } = await harbour(rig);
    records.set(reply.id, { v: 1, swipes: { "0": { generationId: "gen-1" } } });

    // Read once with the chat: what it holds since is not seen until it says so.
    expect((await rig.copy.chats.messages(chat.id)).map((m) => m.own)).toEqual([null, null, null]);
    rig.copy.ownChanged(chat.id);
    expect((await rig.copy.chats.messages(chat.id)).map((m) => m.own)).toEqual([null, { v: 1, swipes: { "0": { generationId: "gen-1" } } }, null]);
    await rig.copy.chats.messages(chat.id, { tail: 1 });
    expect(reads).toBe(2);
  });

  test("entries that can't be read send the read to the host", async () => {
    const rig = rigCopy({
      identifier: "lantern_ext",
      own: async () => {
        throw new Error("the ledger is closed");
      },
    });
    const chat = rig.lumiverse.newChat(USER);
    rig.lumiverse.imported(chat.id, lines(2));

    expect(await rig.copy.chats.messages(chat.id)).toEqual(await rig.host.chats.messages(chat.id));
    expect(rig.copy.state().fallbacks.latest[0]?.why).toBe("the extension's own entries on its messages couldn't be read: the ledger is closed");
  });
});

test("an extension that declines lore gets none from the copy, as from its host, and nothing is read", async () => {
  const rig = rigCopy({ declinesLore: true });
  const book = rig.lumiverse.newBook(USER);
  const tide = rig.lumiverse.addEntry(book.id, { comment: "Tide", content: "The quay floods at spring tide." });
  const { lore } = rig.copy;

  expect([await lore.book(book.id, USER), await lore.record(book.id, USER), await lore.entries(book.id, USER), await lore.records(book.id, USER), await lore.entry(tide.id, USER)]).toEqual([null, null, [], [], null]);
  expect([await lore.global(USER), await lore.ofCharacter("char-joss", USER), await lore.ofPersona(null, USER)]).toEqual([[], [], null]);
  expect(rig.lumiverse.asked).toEqual([]);
  expect(rig.fellBack).toEqual([]);
});

describe("what the copy keeps is held to a number of characters", () => {
  test("the least recently used goes first, and is read whole again when wanted", async () => {
    const rig = rigCopy({ keepChars: 2_500 });
    const made = ["a", "b", "c"].map(() => {
      const chat = rig.lumiverse.newChat(USER, { name: "Log" });
      rig.lumiverse.imported(chat.id, lines(30));
      return chat.id;
    });
    const [a, b, c] = made as [string, string, string];

    await rig.copy.chats.messages(a);
    await rig.copy.chats.messages(b);
    await rig.copy.chats.messages(a);
    await rig.copy.chats.messages(c);

    expect(rig.copy.state().chats.map((kept) => kept.id).sort()).toEqual([a, c].sort());
    expect(rig.copy.state().chars.kept).toBeLessThanOrEqual(2_500);
    await same(rig, b);
    expect(wholeReads(rig.lumiverse, b)).toBe(2);
  });

  test("a chat larger than all the copy may keep is the host's to answer", async () => {
    const rig = rigCopy({ keepChars: 500 });
    const chat = rig.lumiverse.newChat(USER);
    rig.lumiverse.imported(chat.id, lines(40));

    expect(await rig.copy.chats.messages(chat.id)).toEqual(await rig.host.chats.messages(chat.id));
    expect(await rig.copy.chats.messages(chat.id, { tail: 1 })).toEqual(await rig.host.chats.messages(chat.id, { tail: 1 }));

    expect(wholeReads(rig.lumiverse, chat.id)).toBe(1);
    expect(rig.copy.state().chats).toEqual([]);
    expect(rig.copy.state().fallbacks.latest.map((f) => f.why)).toEqual(["it is larger than all the copy may keep", "it is larger than all the copy may keep"]);
  });

  test("by default it keeps 32 million characters", () => {
    expect(rigCopy().copy.state().chars).toEqual({ kept: 0, most: KEEP_CHARS });
    expect(KEEP_CHARS).toBe(32_000_000);
  });
});

describe("one user's rows only", () => {
  test("an event that names another user is passed over", async () => {
    const rig = await harbour();
    rig.copy.apply({ name: "MESSAGE_DELETED", payload: { chatId: rig.chat.id, messageId: rig.reply.id }, userId: OTHER });

    expect((await rig.copy.chats.messages(rig.chat.id)).map((m) => m.id)).toContain(rig.reply.id);
  });

  test("another user's chat is none of the copy's, and a chat whose owner isn't the session's user is never kept: the extension's host answers for both", async () => {
    const lumiverse = new Lumiverse();
    const theirs = lumiverse.newChat(OTHER);
    lumiverse.imported(theirs.id, lines(2));
    const mine = lumiverse.newChat(USER);
    lumiverse.imported(mine.id, lines(2));
    const rig = rigCopy({
      lumiverse,
      source: () => {
        const http = createHttpSource({ fetch: lumiverse.session(USER), identifier: LUMIAH, sleep: async () => undefined });
        // A source that misreads whose chat it read: the copy keeps none it can't tell is the user's.
        return { ...http, readChat: async (id) => ((read) => read && { ...read, owner: id === mine.id ? OTHER : read.owner })(await http.readChat(id)) };
      },
    });

    // Lumiverse's route says 404 for another user's chat, which says nothing of the chat: the extension's host says there is none.
    expect(await rig.copy.chats.get(theirs.id, USER)).toBeNull();
    expect(await rig.copy.chats.get(mine.id, USER)).toEqual(await rig.host.chats.get(mine.id, USER));
    expect(rig.fellBack).toEqual([`chats.get ${theirs.id}`, `chats.get ${mine.id}`]);
    expect(rig.copy.state().chats).toEqual([]);
    const [unanswered, refused] = rig.copy.state().reads.map((r) => r.outcome);
    expect(unanswered).toStartWith(`failed: Lumiverse answered 404 when it was asked for chat ${theirs.id}`);
    expect(refused).toBe("not kept: it isn't the chat of the user the runtime is signed in as");
    expect(rig.copy.state().routes).toMatchObject({ total: 1, latest: [{ what: "chat", id: theirs.id, status: 404, until: null }] });
    expect(rig.copy.state().fallbacks).toMatchObject({ total: 1, latest: [{ what: "chat", id: mine.id, why: "it isn't the chat of the user the runtime is signed in as" }] });
  });
});

describe("a route of the source that doesn't answer as expected", () => {
  test("a chat it says isn't there is the extension's to answer: nothing is kept as gone, the state counts those reads apart with the route and what it answered, the log says so once, and the chat is kept once the route answers", async () => {
    const rig = rigCopy();
    const chat = rig.lumiverse.newChat(USER);
    rig.lumiverse.imported(chat.id, lines(2));
    // The chat's own row "not found" twice, while its messages are served.
    rig.lumiverse.fail(/\?messages=false$/, 2, 404);

    expect(await rig.copy.chats.get(chat.id, USER)).toEqual(await rig.host.chats.get(chat.id, USER));
    expect(await rig.copy.chats.messages(chat.id)).toEqual(await rig.host.chats.messages(chat.id));
    expect(rig.fellBack).toEqual([`chats.get ${chat.id}`, `chats.messages ${chat.id}`]);
    const state = rig.copy.state();
    expect(state.chats).toEqual([]);
    expect(state.fallbacks.total).toBe(0);
    expect(state.routes.total).toBe(2);
    expect(state.routes.latest.map((n) => [n.what, n.id, n.route, n.status, n.until])).toEqual([
      ["chat", chat.id, "GET /api/v1/chats/:id", 404, null],
      ["chat", chat.id, "GET /api/v1/chats/:id", 404, null],
    ]);
    expect(state.routes.latest[0]?.why).toBe(`reading it failed: Lumiverse answered 404 when it was asked for chat ${chat.id}, which the runtime doesn't take for an answer of GET /api/v1/chats/:id, so the extension is asked instead`);
    expect(rig.logs.filter((line) => line.includes("which the copy doesn't take for an answer"))).toHaveLength(1);

    // Answered as expected again: read whole and kept, and answered from the copy from then on.
    await same(rig, chat.id);
    expect(rig.copy.state().chats.map((c) => c.id)).toEqual([chat.id]);
    expect(rig.fellBack).toHaveLength(2);
  });
});

test("its state says what is kept, where from, the last read and why, and the fallbacks taken", async () => {
  const rig = await harbour();
  const book = rig.lumiverse.newBook(USER, { id: "book-quay" });
  rig.lumiverse.addEntry(book.id, { comment: "Tide", content: "The quay floods at spring tide." });
  await rig.copy.lore.records(book.id, USER);
  rig.lumiverse.insertBefore(rig.reply.id, "(A bell rings.)");
  rig.forward();
  rig.lumiverse.fail(/messages\?limit=1000&offset=0/, 3, 500);
  await rig.copy.chats.messages(rig.chat.id);
  rig.clock.now += 10;
  await rig.copy.chats.messages(rig.chat.id);

  const state = rig.copy.state();

  expect(state.source).toBe("http");
  expect(state.chats).toEqual([{ id: rig.chat.id, from: "http", rows: 4, chars: expect.any(Number), read: { at: rig.clock.now, why: INSERTED }, checkedAt: rig.clock.now, check: { saw: "all of it, read whole", missed: null }, stale: null }]);
  expect(state.books).toEqual([{ id: book.id, from: "http", rows: 1, chars: expect.any(Number), read: { at: rig.clock.now - 10, why: "it wasn't kept" }, checkedAt: rig.clock.now - 10, check: { saw: "all of it, read whole", missed: null }, stale: null }]);
  expect(state.chars.kept).toBe((state.chats[0]?.chars ?? 0) + (state.books[0]?.chars ?? 0));
  expect(state.reads.map((r) => [r.what, r.why, r.outcome.startsWith("failed") ? "failed" : r.outcome])).toEqual([
    ["chat", "it wasn't kept", "kept"],
    ["book", "it wasn't kept", "kept"],
    ["chat", INSERTED, "failed"],
    ["chat", INSERTED, "kept"],
  ]);
  expect(state.fallbacks.total).toBe(1);
});

test("its state says of each chat what its last check before use saw, and what that check could not see", async () => {
  const rig = await harbour();
  expect(rig.copy.state().chats[0]?.check).toEqual({ saw: "all of it, read whole", missed: null });
  rig.clock.now += 1_000;
  await rig.copy.chats.messages(rig.chat.id);
  expect(rig.copy.state().chats[0]).toMatchObject({
    checkedAt: rig.clock.now,
    check: {
      saw: "the number of messages, the newest message and the chat's own fields",
      missed: "a change Lumiverse makes with no event to a message before the newest (user messages renamed in bulk by persona, an extension's entry or hidden written in place) isn't seen until the chat is read again",
    },
  });

  const db = await harbour(rigCopy({ source: ({ lumiverse }) => databaseLike(lumiverse) }));
  db.clock.now += 1_000;
  await db.copy.chats.messages(db.chat.id);
  expect(db.copy.state().chats[0]?.check).toEqual({ saw: "the number of messages, the newest message and the source's fingerprint of the whole chat", missed: null });
  db.clock.now += 1_000;
  await db.copy.chats.messages(db.chat.id);
  expect(db.copy.state().chats[0]?.check).toEqual({ saw: "the source's word that nothing it reads changed since its last check", missed: null });
});

test("the backend's own chat and lore logic runs over the copy unchanged, and answers as over the extension's host", async () => {
  const rig = await harbour();
  const book = rig.lumiverse.newBook(USER, { id: "book-quay" });
  rig.lumiverse.addEntry(book.id, { comment: "Tide", content: "The quay floods at spring tide." });
  const keep = async () => ({ chats: 16, ms: 300_000 });
  const now = () => rig.clock.now;
  const overHost = new Chats(rig.host, keep, now);
  const overCopy = new Chats({ chats: { ...rig.host.chats, ...rig.copy.chats }, granted: rig.host.granted }, keep, now);
  const loreDeps = { persona: () => null, activatedBooks: () => [] };

  expect(await overCopy.path(USER, rig.chat.id)).toEqual(await overHost.path(USER, rig.chat.id));
  expect(await overCopy.messages(USER, rig.chat.id, 1, 3)).toEqual(await overHost.messages(USER, rig.chat.id, 1, 3));
  expect(await overCopy.info(USER, rig.chat.id)).toEqual(await overHost.info(USER, rig.chat.id));
  const chat = await overCopy.own(USER, rig.chat.id);
  expect(await new Lore({ lore: rig.copy.lore }, loreDeps).books(USER, chat)).toEqual(await new Lore(rig.host, loreDeps).books(USER, chat));
  expect(await new Lore({ lore: rig.copy.lore }, loreDeps).entries(USER, book.id)).toEqual(await new Lore(rig.host, loreDeps).entries(USER, book.id));
});
