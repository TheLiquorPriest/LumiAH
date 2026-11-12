// The copy's HTTP source (PI-BUILD-PLAN §4.5): a chat read in pages of 1000, a few at once, each page
// that fails asked for again, and the chat given only once it was read whole with every page agreeing
// on the count; a world book read with its ETag, so one that didn't change costs an empty answer; the
// cheap signatures; and the session's own user. Every chat, book, name and text here is invented.

import { describe, expect, test } from "bun:test";
import { LiveError } from "../../../src/runtime/lumiverse";
import { createHttpSource, type HttpSourceDeps, sessionUser } from "../../../src/runtime/copy/http";
import { Lumiverse } from "./lumiverse";
import { LUMIAH, OTHER, USER } from "./rig";

function source(lumiverse: Lumiverse, options: Partial<HttpSourceDeps> = {}) {
  const waits: number[] = [];
  const made = createHttpSource({
    fetch: lumiverse.session(USER),
    identifier: LUMIAH,
    sleep: async (ms) => {
      waits.push(ms);
    },
    ...options,
  });
  return { source: made, waits };
}

const lines = (n: number, from = 0): string[] => Array.from({ length: n }, (_, i) => `Line ${from + i} of the harbour log.`);

/** The pages of a chat's messages that were asked for, by their offsets. */
const offsets = (lumiverse: Lumiverse, chatId: string): number[] =>
  lumiverse.asked.filter((p) => p.startsWith(`/api/v1/chats/${chatId}/messages?limit=`)).map((p) => Number(new URL(p, "http://x").searchParams.get("offset")));

describe("a chat read whole", () => {
  test("in pages of 1000, no more than the bound at once, every message in its place", async () => {
    const lumiverse = new Lumiverse();
    const chat = lumiverse.newChat(USER);
    lumiverse.imported(chat.id, lines(4500));
    const { source: http } = source(lumiverse, { parallel: 2 });

    const read = await http.readChat(chat.id);

    expect(read?.messages.map((m) => m.row.content)).toEqual(lines(4500));
    expect(read?.messages.map((m) => m.row.index)).toEqual(lines(4500).map((_, i) => i));
    expect(read?.owner).toBe(USER);
    expect(offsets(lumiverse, chat.id).sort((a, b) => a - b)).toEqual([0, 1000, 2000, 3000, 4000]);
    // The chat and its first page go together; then two pages at once, never more.
    expect(lumiverse.mostAtOnce).toBe(2);
  });

  test("a page that fails is asked for again, after a wait that doubles", async () => {
    const lumiverse = new Lumiverse();
    const chat = lumiverse.newChat(USER);
    lumiverse.imported(chat.id, lines(1500));
    lumiverse.fail(/offset=1000/, 1, 503);
    lumiverse.fail(/offset=1000/, 1, "network");
    const { source: http, waits } = source(lumiverse);

    const read = await http.readChat(chat.id);

    expect(read?.messages).toHaveLength(1500);
    expect(waits).toEqual([250, 500]);
  });

  test("a page that keeps failing fails the read, in words that say so", async () => {
    const lumiverse = new Lumiverse();
    const chat = lumiverse.newChat(USER);
    lumiverse.imported(chat.id, lines(1500));
    lumiverse.fail(/offset=1000/, 3, 502);
    const { source: http, waits } = source(lumiverse);

    const failed = await http.readChat(chat.id).catch((error: unknown) => error);

    expect(failed).toBeInstanceOf(LiveError);
    expect(failed).toMatchObject({ problem: "unreachable", message: `Lumiverse answered 502 when it was asked for chat ${chat.id}'s messages, 3 times.` });
    expect(waits).toEqual([250, 500]);
  });

  test("a chat that changed between two pages is read again from the start", async () => {
    const lumiverse = new Lumiverse();
    const chat = lumiverse.newChat(USER);
    lumiverse.imported(chat.id, lines(1500));
    // A message comes while the second page is asked for: the pages disagree on the count.
    lumiverse.whileAsked(/offset=1000/, () => lumiverse.say(chat.id, "A gull lands on the light."));
    const { source: http } = source(lumiverse);

    const read = await http.readChat(chat.id);

    expect(read?.messages).toHaveLength(1501);
    expect(read?.messages.at(-1)?.row.content).toBe("A gull lands on the light.");
    expect(offsets(lumiverse, chat.id)).toEqual([0, 1000, 0, 1000]);
  });

  test("a chat that keeps changing while it is read isn't given", async () => {
    const lumiverse = new Lumiverse();
    const chat = lumiverse.newChat(USER);
    lumiverse.imported(chat.id, lines(1500));
    for (let i = 0; i < 3; i++) lumiverse.whileAsked(/offset=1000/, () => lumiverse.say(chat.id, `Gull ${i}.`));
    const { source: http } = source(lumiverse);

    const failed = await http.readChat(chat.id).catch((error: unknown) => error);

    expect(failed).toMatchObject({ message: `Chat ${chat.id} kept changing while it was read (3 times), so it wasn't kept.` });
  });

  test("no such chat, and another user's chat, read as none", async () => {
    const lumiverse = new Lumiverse();
    const theirs = lumiverse.newChat(OTHER);
    lumiverse.say(theirs.id, "Not Mara's.");
    const { source: http } = source(lumiverse);

    expect(await http.readChat("chat-nowhere")).toBeNull();
    expect(await http.readChat(theirs.id)).toBeNull();
    expect(await http.chatSignature(theirs.id)).toBeNull();
  });

  test("a session that ended fails the read at once, saying how to sign in again", async () => {
    const lumiverse = new Lumiverse();
    const chat = lumiverse.newChat(USER);
    lumiverse.fail(/./, 5, 401);
    const { source: http, waits } = source(lumiverse);

    const failed = await http.readChat(chat.id).catch((error: unknown) => error);

    expect(failed).toMatchObject({ problem: "login", message: expect.stringContaining("lumiah login") });
    expect(waits).toEqual([]);
  });

  test("its cheap signature: how many messages, and the newest as the host gives it", async () => {
    const lumiverse = new Lumiverse();
    const chat = lumiverse.newChat(USER);
    lumiverse.imported(chat.id, lines(3));
    const newest = lumiverse.say(chat.id, "The light turns.", { extra: { hidden: true } });
    const { source: http } = source(lumiverse);

    const signature = await http.chatSignature(chat.id);

    expect(signature?.count).toBe(4);
    expect(signature?.last).toEqual((await http.readChat(chat.id))?.messages.at(-1)?.row ?? null);
    expect(signature?.last).toMatchObject({ id: newest.id, index: 3, hidden: true, content: "The light turns." });
  });
});

describe("a world book read whole", () => {
  test("with more than a page of entries, in the book's order", async () => {
    const lumiverse = new Lumiverse();
    const book = lumiverse.newBook(USER);
    for (let i = 0; i < 2300; i++) lumiverse.addEntry(book.id, { comment: `Stone ${i}`, content: `Stone ${i} of the quay.`, order: 2300 - i }, true);
    const { source: http } = source(lumiverse);

    const read = await http.readBook(book.id, null);

    expect(read?.entries).toHaveLength(2300);
    expect(read?.entries.slice(0, 2).map((e) => e.row.title)).toEqual(["Stone 2299", "Stone 2298"]);
    expect(read?.book).toMatchObject({ id: book.id, name: "The harbour" });
    expect(read?.signature).toStartWith(`"wb-${book.id}-`);
  });

  test("a book that didn't change since it was read costs one empty answer, and gives back the read held", async () => {
    const lumiverse = new Lumiverse();
    const book = lumiverse.newBook(USER);
    lumiverse.addEntry(book.id, { comment: "Tide", content: "The quay floods at spring tide." });
    const { source: http } = source(lumiverse);
    const held = await http.readBook(book.id, null);
    const asked = lumiverse.asked.length;

    expect(await http.readBook(book.id, held)).toBe(held);
    expect(lumiverse.asked.length).toBe(asked + 1);
    expect(await http.bookSignature(book.id, held)).toBe(held?.signature ?? "");

    lumiverse.now += 3;
    lumiverse.addEntry(book.id, { comment: "Keeper", content: "Ilse keeps the light." });
    const again = await http.readBook(book.id, held);
    expect(again).not.toBe(held);
    expect(again?.entries.map((e) => e.row.title)).toEqual(["Tide", "Keeper"]);
    expect(again?.entries).toHaveLength(2);
    expect(await http.bookSignature(book.id, held)).not.toBe(held?.signature);
  });

  test("no such book reads as none", async () => {
    const lumiverse = new Lumiverse();
    const theirs = lumiverse.newBook(OTHER);
    const { source: http } = source(lumiverse);

    expect(await http.readBook("book-nowhere", null)).toBeNull();
    expect(await http.readBook(theirs.id, null)).toBeNull();
    expect(await http.bookSignature(theirs.id, null)).toBeNull();
  });
});

describe("what else the source says", () => {
  test("it can't tell whether anything changed in general", async () => {
    const { source: http } = source(new Lumiverse());
    expect(await http.changedSince(null)).toEqual({ changed: null, mark: null });
  });

  test("the session's own user", async () => {
    const lumiverse = new Lumiverse();
    expect(await sessionUser(lumiverse.session(USER))).toBe(USER);
    lumiverse.fail(/get-session/, 1, 401);
    expect(await sessionUser(lumiverse.session(USER)).catch((error: unknown) => error)).toMatchObject({ problem: "login" });
  });
});
