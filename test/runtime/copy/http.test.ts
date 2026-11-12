// The copy's HTTP source (PI-BUILD-PLAN §4.5): a chat read in pages of 1000, a few at once, each page
// after the first starting on the row the one before ended on, each page that fails asked for again,
// and the chat given only once its pages fit together (the same count, the same row at each boundary,
// no row twice); a world book read the same way, each page with the book's own row, and always read
// whole, never asked whether it changed since; a request given up once its deadline passed; the cheap
// signatures; and the session's own user. Every chat, book, name and text here is invented.

import { describe, expect, test } from "bun:test";
import { linkedBackendOf } from "../../../src/link/frames";
import { transportWait } from "../../../src/link/waits";
import { LiveError } from "../../../src/runtime/lumiverse";
import { createHttpSource, type HttpSourceDeps, PAUSE_AFTER, PAUSE_MS, REQUEST_MS, type SessionFetch, sessionUser } from "../../../src/runtime/copy/http";
import { Unanswered } from "../../../src/runtime/copy/source";
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

/** Every page of a chat's messages after the first, wherever it starts. */
const laterPage = /messages\?limit=1000&offset=[1-9]/;

describe("a chat read whole", () => {
  test("in pages of 1000, each after the first starting on the last row of the one before, no more than the bound at once, every message in its place", async () => {
    const lumiverse = new Lumiverse();
    const chat = lumiverse.newChat(USER);
    lumiverse.imported(chat.id, lines(4500));
    const { source: http } = source(lumiverse, { parallel: 2 });

    const read = await http.readChat(chat.id);

    expect(read?.messages.map((m) => m.row.content)).toEqual(lines(4500));
    expect(read?.messages.map((m) => m.row.index)).toEqual(lines(4500).map((_, i) => i));
    expect(read?.owner).toBe(USER);
    expect(offsets(lumiverse, chat.id).sort((a, b) => a - b)).toEqual([0, 999, 1998, 2997, 3996]);
    // The chat and its first page go together; then two pages at once, never more.
    expect(lumiverse.mostAtOnce).toBe(2);
  });

  test("a page that fails is asked for again, after a wait that doubles", async () => {
    const lumiverse = new Lumiverse();
    const chat = lumiverse.newChat(USER);
    lumiverse.imported(chat.id, lines(1500));
    lumiverse.fail(laterPage, 1, 503);
    lumiverse.fail(laterPage, 1, "network");
    const { source: http, waits } = source(lumiverse);

    const read = await http.readChat(chat.id);

    expect(read?.messages).toHaveLength(1500);
    expect(waits).toEqual([250, 500]);
  });

  test("a page that keeps failing fails the read, in words that say so", async () => {
    const lumiverse = new Lumiverse();
    const chat = lumiverse.newChat(USER);
    lumiverse.imported(chat.id, lines(1500));
    lumiverse.fail(laterPage, 3, 502);
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
    lumiverse.whileAsked(laterPage, () => lumiverse.say(chat.id, "A gull lands on the light."));
    const { source: http } = source(lumiverse);

    const read = await http.readChat(chat.id);

    expect(read?.messages).toHaveLength(1501);
    expect(read?.messages.at(-1)?.row.content).toBe("A gull lands on the light.");
    expect(offsets(lumiverse, chat.id)).toEqual([0, 999, 0, 999]);
  });

  test("a message deleted before a page boundary while another is sent: read again, never given holding the deleted one and missing the one that slid across", async () => {
    const lumiverse = new Lumiverse();
    const chat = lumiverse.newChat(USER);
    const rows = lumiverse.imported(chat.id, lines(2000));
    // While the second page is asked for, a message of the first goes and one comes at the end: every page still counts 2000, and no id comes twice.
    lumiverse.whileAsked(laterPage, () => {
      lumiverse.remove(rows[10]?.id ?? "");
      lumiverse.say(chat.id, "A gull lands on the light.");
    });
    const { source: http } = source(lumiverse);

    const read = await http.readChat(chat.id);

    expect(read?.messages.map((m) => m.row.id)).toEqual(lumiverse.rowsOf(chat.id).map((m) => m.id));
    expect(read?.messages.map((m) => m.row.content)).toContain(lines(2000)[1000]);
    expect(offsets(lumiverse, chat.id)).toEqual([0, 999, 1998, 0, 999, 1998]);
  });

  test("a message put in before others and another deleted while the pages are read: the boundary's row is the same message at another place, so it is read again", async () => {
    const lumiverse = new Lumiverse();
    const chat = lumiverse.newChat(USER);
    const rows = lumiverse.imported(chat.id, lines(2000));
    // One in, one out, both before the boundary: the same message ends the first page and starts the second, every page counts 2000, but every place after the new one moved up.
    lumiverse.whileAsked(laterPage, () => {
      lumiverse.insertBefore(rows[5]?.id ?? "", "(A bell rings.)");
      lumiverse.remove(rows[20]?.id ?? "");
    });
    const { source: http } = source(lumiverse);

    const read = await http.readChat(chat.id);

    expect(read?.messages.map((m) => [m.row.id, m.row.index])).toEqual(lumiverse.rowsOf(chat.id).map((m) => [m.id, m.index_in_chat]));
    expect(offsets(lumiverse, chat.id)).toEqual([0, 999, 1998, 0, 999, 1998]);
  });

  test("a chat that keeps changing while it is read isn't given", async () => {
    const lumiverse = new Lumiverse();
    const chat = lumiverse.newChat(USER);
    lumiverse.imported(chat.id, lines(1500));
    for (let i = 0; i < 3; i++) lumiverse.whileAsked(laterPage, () => lumiverse.say(chat.id, `Gull ${i}.`));
    const { source: http } = source(lumiverse);

    const failed = await http.readChat(chat.id).catch((error: unknown) => error);

    expect(failed).toMatchObject({ message: `Chat ${chat.id} kept changing while it was read (3 times), so it wasn't kept.` });
  });

  test("no such chat, and another user's chat, are no answer: Lumiverse's route said 404, which says nothing of the chat, so the read fails naming the route and what it answered", async () => {
    const lumiverse = new Lumiverse();
    const theirs = lumiverse.newChat(OTHER);
    lumiverse.say(theirs.id, "Not Mara's.");
    const { source: http, waits } = source(lumiverse);

    for (const read of [() => http.readChat("chat-nowhere"), () => http.readChat(theirs.id), () => http.chatSignature(theirs.id)]) {
      const failed = await read().catch((error: unknown) => error);
      expect(failed).toBeInstanceOf(Unanswered);
      // The chat's row and its messages are asked together: either may be the one that said so first.
      expect(["GET /api/v1/chats/:id", "GET /api/v1/chats/:id/messages"]).toContain((failed as Unanswered).route);
      expect(failed).toMatchObject({ status: 404, until: null, message: expect.stringContaining("which the runtime doesn't take for an answer of GET /api/v1/chats/:id") });
    }
    // Nothing a second try changes: none was tried again.
    expect(waits).toEqual([]);
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

  test("its cheap signature: how many messages, the newest as the host gives it, and the chat's own row", async () => {
    const lumiverse = new Lumiverse();
    const chat = lumiverse.newChat(USER, { metadata: { ltcm_config_hash: "a1" } });
    lumiverse.imported(chat.id, lines(3));
    const newest = lumiverse.say(chat.id, "The light turns.", { extra: { hidden: true } });
    const { source: http } = source(lumiverse);

    const signature = await http.chatSignature(chat.id);
    const read = await http.readChat(chat.id);

    expect(signature?.count).toBe(4);
    expect(signature?.last).toEqual(read?.messages.at(-1)?.row ?? null);
    expect(signature?.last).toMatchObject({ id: newest.id, index: 3, hidden: true, content: "The light turns." });
    expect(signature?.chat).toEqual(read?.chat);
    expect(signature?.chat?.metadata).toEqual({ ltcm_config_hash: "a1" });
  });
});

describe("a world book read whole", () => {
  /** A book of `n` entries, each at its own order, made with no events. */
  function stones(lumiverse: Lumiverse, n: number) {
    const book = lumiverse.newBook(USER);
    const made = Array.from({ length: n }, (_, i) => lumiverse.addEntry(book.id, { comment: `Stone ${i}`, content: `Stone ${i} of the quay.`, order: i * 2 }, true));
    // Every page after the first, wherever it starts and whichever route it comes by.
    const later = new RegExp(`world-books/${book.id}(/entries)?\\?limit=1000&offset=[1-9]`);
    return { book, made, later };
  }

  test("with more than a page of entries, in the book's order", async () => {
    const lumiverse = new Lumiverse();
    const book = lumiverse.newBook(USER);
    for (let i = 0; i < 2300; i++) lumiverse.addEntry(book.id, { comment: `Stone ${i}`, content: `Stone ${i} of the quay.`, order: 2300 - i }, true);
    const { source: http } = source(lumiverse);

    const read = await http.readBook(book.id, null);

    expect(read?.entries).toHaveLength(2300);
    expect(read?.entries.slice(0, 2).map((e) => e.row.title)).toEqual(["Stone 2299", "Stone 2298"]);
    expect(read?.entries.map((e) => e.row.id)).toEqual(lumiverse.entriesOf(book.id).map((e) => e.id));
    expect(read?.book).toMatchObject({ id: book.id, name: "The harbour" });
    expect(read?.signature).toStartWith(`"wb-${book.id}-`);
  });

  test("an entry deleted before a page boundary while another is made: read again, never given holding the deleted one and missing the one that slid across", async () => {
    const lumiverse = new Lumiverse();
    const { book, made, later } = stones(lumiverse, 2000);
    lumiverse.whileAsked(later, () => {
      lumiverse.deleteEntry(made[10]?.id ?? "");
      lumiverse.addEntry(book.id, { comment: "Lantern", content: "A lantern on the last bollard.", order: 9000 });
    });
    const { source: http } = source(lumiverse);

    const read = await http.readBook(book.id, null);

    expect(read?.entries.map((e) => e.row.id)).toEqual(lumiverse.entriesOf(book.id).map((e) => e.id));
    expect(read?.entries.map((e) => e.row.title)).toContain("Stone 1000");
  });

  test("a change that keeps every boundary in place shows in the book's own row, which every page must give alike", async () => {
    const lumiverse = new Lumiverse();
    const { book, made, later } = stones(lumiverse, 2000);
    // An entry of the first page goes and another takes its order a second later: every row after it stays where it was, and only the book's stamp tells.
    lumiverse.whileAsked(later, () => {
      lumiverse.now += 1;
      lumiverse.deleteEntry(made[10]?.id ?? "");
      lumiverse.addEntry(book.id, { comment: "Lantern", content: "A lantern on the last bollard.", order: 20 });
    });
    const { source: http } = source(lumiverse);

    const read = await http.readBook(book.id, null);

    expect(read?.entries.map((e) => e.row.id)).toEqual(lumiverse.entriesOf(book.id).map((e) => e.id));
    expect(read?.entries.map((e) => e.row.title)).toContain("Lantern");
    expect(read?.book.updatedAt).toBe(lumiverse.now * 1000);
  });

  test("always read whole, never asked whether it changed since: Lumiverse's ETag misses a namespace write and a second change in the same second", async () => {
    const lumiverse = new Lumiverse();
    const book = lumiverse.newBook(USER, { name: "The quay" });
    const tide = lumiverse.addEntry(book.id, { comment: "Tide", content: "The quay floods at spring tide." });
    const { source: http } = source(lumiverse);
    const held = await http.readBook(book.id, null);

    // An extension's namespace written into an entry: no stamp, no revision, so the ETag says nothing changed.
    lumiverse.setExtension(tide.id, "lumibooks", { tier: 2 });
    expect(await http.bookSignature(book.id, held)).toBe(held?.signature ?? "");
    const after = await http.readBook(book.id, held);
    expect(after?.entries[0]?.row.extensions).toEqual({ lumibooks: { tier: 2 } });

    // Two renames in one second: the second leaves the ETag as the first left it.
    lumiverse.renameBook(book.id, "The old quay");
    const renamed = await http.readBook(book.id, after ?? null);
    lumiverse.renameBook(book.id, "The new quay");
    expect(await http.bookSignature(book.id, renamed)).toBe(renamed?.signature ?? "");
    expect((await http.readBook(book.id, renamed))?.book.name).toBe("The new quay");
  });

  test("no such book, and another user's book, are no answer: the read fails naming the route and what it answered", async () => {
    const lumiverse = new Lumiverse();
    const theirs = lumiverse.newBook(OTHER);
    const { source: http } = source(lumiverse);

    for (const read of [() => http.readBook("book-nowhere", null), () => http.readBook(theirs.id, null), () => http.bookSignature(theirs.id, null)]) {
      const failed = await read().catch((error: unknown) => error);
      expect(failed).toBeInstanceOf(Unanswered);
      expect(failed).toMatchObject({ route: "GET /api/v1/world-books/:id", status: 404, until: null });
    }
  });
});

// Lumiverse's HTTP routes are no interface it promises to keep: a release may move or change them, a
// test bed may serve none of them. An answer the source doesn't expect says nothing of a chat or a book.
describe("a route that doesn't answer as the source expects", () => {
  test("a status it doesn't expect, a redirect and a body it can't read are no answer, each named with its route; none is tried again, and the route is read from once it answers", async () => {
    const lumiverse = new Lumiverse();
    const chat = lumiverse.newChat(USER);
    lumiverse.imported(chat.id, lines(3));
    const { source: http, waits } = source(lumiverse);

    lumiverse.fail(/\/messages\?limit=/, 1, 410);
    expect(await http.readChat(chat.id).catch((error: unknown) => error)).toMatchObject({ route: "GET /api/v1/chats/:id/messages", status: 410, until: null });
    lumiverse.fail(/\?messages=false/, 1, 302);
    expect(await http.readChat(chat.id).catch((error: unknown) => error)).toMatchObject({ route: "GET /api/v1/chats/:id", status: 302, message: expect.stringContaining("a redirect to another address, which the runtime doesn't follow: it would drop the runtime's sign-in") });
    // Answered as a success, but not with a page.
    lumiverse.fail(/\/messages\?tail=true/, 1, 200);
    expect(await http.chatSignature(chat.id).catch((error: unknown) => error)).toMatchObject({ route: "GET /api/v1/chats/:id/messages", status: 200, message: expect.stringContaining("Lumiverse answered something that isn't a page when it was asked for chat") });
    const book = lumiverse.newBook(USER);
    lumiverse.fail(/world-books/, 1, 200);
    expect(await http.readBook(book.id, null).catch((error: unknown) => error)).toMatchObject({ route: "GET /api/v1/world-books/:id", status: 200, message: expect.stringContaining("isn't a world book") });

    expect(waits).toEqual([]);
    expect((await http.readChat(chat.id))?.messages.map((m) => m.row.content)).toEqual(lines(3));
    expect((await http.readBook(book.id, null))?.book.id).toBe(book.id);
  });

  test(`one that didn't answer for ${PAUSE_AFTER} different chats in a row is asked nothing for a while, its reads failing at once; then it is asked again, and read from once it answers`, async () => {
    const lumiverse = new Lumiverse();
    const mine = lumiverse.newChat(USER);
    lumiverse.imported(mine.id, lines(2));
    const clock = { now: Date.UTC(2026, 10, 12, 9, 0, 0) };
    // A chat's row and its messages are asked together, and a read that failed on one leaves the other under way: each read here waits until both answered, so the clock moves only between them.
    const session = lumiverse.session(USER);
    const underWay = new Set<Promise<Response>>();
    const fetch: SessionFetch = (path, init) => {
      const asking = session(path, init);
      underWay.add(asking);
      void asking.then(
        () => underWay.delete(asking),
        () => underWay.delete(asking),
      );
      return asking;
    };
    const { source: http } = source(lumiverse, { fetch, now: () => clock.now, pauseMs: 30_000 });
    const missing = async (chatId: string): Promise<unknown> => {
      const failed = await http.readChat(chatId).catch((error: unknown) => error);
      await Promise.allSettled([...underWay]);
      return failed;
    };

    // One chat not found again and again is Lumiverse's word on that chat, not on its route.
    for (let i = 0; i < PAUSE_AFTER + 1; i++) expect(await missing("chat-gone")).toMatchObject({ status: 404, until: null });
    expect((await http.readChat(mine.id))?.messages).toHaveLength(2);
    // A route that answers between two that didn't starts the count again.
    for (let i = 1; i < PAUSE_AFTER; i++) await missing(`chat-gone-${i}`);
    expect((await http.readChat(mine.id))?.messages).toHaveLength(2);
    for (let i = 1; i < PAUSE_AFTER; i++) expect(await missing(`chat-lost-${i}`)).toMatchObject({ until: null });
    expect(await missing(`chat-lost-${PAUSE_AFTER}`)).toMatchObject({ status: 404, until: clock.now + 30_000 });

    // Asked nothing while the while lasts: a read fails at once, with no request, saying why.
    const asked = lumiverse.asked.length;
    clock.now += 29_000;
    const paused = await missing(mine.id);
    expect(paused).toBeInstanceOf(Unanswered);
    expect(paused).toMatchObject({ route: "GET /api/v1/chats/:id", status: 404, until: clock.now + 1_000, message: `Lumiverse's GET /api/v1/chats/:id answered 404 for ${PAUSE_AFTER} different chats in a row, so the runtime asks it nothing for 30 seconds, and the extension is asked instead` });
    expect(await http.chatSignature(mine.id).catch((error: unknown) => error)).toBeInstanceOf(Unanswered);
    expect(lumiverse.asked.length).toBe(asked);
    // Its world books' route answers as ever.
    const book = lumiverse.newBook(USER);
    expect((await http.readBook(book.id, null))?.book.id).toBe(book.id);

    // Once the while is over it is asked again: answering, it is read from, and its count starts again.
    clock.now += 1_000;
    expect((await http.readChat(mine.id))?.messages).toHaveLength(2);
    expect(await missing("chat-lost-again")).toMatchObject({ until: null });
    expect(PAUSE_MS).toBe(60_000);
  });

  test("one that still doesn't answer once its while is over is asked nothing for another while at once", async () => {
    const lumiverse = new Lumiverse();
    const clock = { now: Date.UTC(2026, 10, 12, 9, 0, 0) };
    const { source: http } = source(lumiverse, { now: () => clock.now, pauseMs: 10_000 });
    for (let i = 0; i < PAUSE_AFTER; i++) await http.readBook(`book-lost-${i}`, null).catch(() => undefined);
    clock.now += 10_000;
    const asked = lumiverse.asked.length;
    expect(await http.readBook("book-lost-0", null).catch((error: unknown) => error)).toMatchObject({ route: "GET /api/v1/world-books/:id", status: 404, until: clock.now + 10_000 });
    expect(lumiverse.asked.length).toBe(asked + 1);
    expect(await http.readBook("book-lost-1", null).catch((error: unknown) => error)).toMatchObject({ message: expect.stringContaining(`answered 404 for ${PAUSE_AFTER} different world books in a row`) });
    expect(lumiverse.asked.length).toBe(asked + 1);
  });
});

// The deadline is the source's own timer on the real clock, against a request that can never answer:
// nothing races it, so a short real deadline (30 ms) is the test's whole wait, and no fake clock reaches
// the made-up Lumiverse's own request timing.
describe("a request that never answers", () => {
  test("is given up once its deadline passed: the read fails at once, saying so, and the request is aborted", async () => {
    const lumiverse = new Lumiverse();
    const chat = lumiverse.newChat(USER);
    lumiverse.imported(chat.id, lines(3));
    lumiverse.hang(/messages\?limit=1000&offset=0/);
    const { source: http, waits } = source(lumiverse, { requestMs: 30 });

    const failed = await http.readChat(chat.id).catch((error: unknown) => error);

    expect(failed).toBeInstanceOf(LiveError);
    expect(failed).toMatchObject({ problem: "timeout", message: `Lumiverse didn't answer within 30 ms when it was asked for chat ${chat.id}'s messages, so the runtime gave up on it. ${transportWait(["runtime", "copyReadMs"], linkedBackendOf(undefined))} says how long each of the runtime's reads of chat data waits.` });
    expect(lumiverse.aborted).toEqual([`/api/v1/chats/${chat.id}/messages?limit=1000&offset=0`]);
    // Not asked again: whoever waits on the read goes to the extension's host instead.
    expect(waits).toEqual([]);
    expect(await http.readChat(chat.id)).toMatchObject({ messages: expect.any(Array) });
  });

  test("a book's and a check's requests have the same deadline, 15 s when not said", async () => {
    const lumiverse = new Lumiverse();
    const chat = lumiverse.newChat(USER);
    const book = lumiverse.newBook(USER);
    lumiverse.hang(/world-books/);
    lumiverse.hang(/tail=true/);
    const { source: http } = source(lumiverse, { requestMs: 30 });

    expect(await http.readBook(book.id, null).catch((error: unknown) => error)).toMatchObject({ problem: "timeout" });
    expect(await http.chatSignature(chat.id).catch((error: unknown) => error)).toMatchObject({ problem: "timeout" });
    expect(REQUEST_MS).toBe(15_000);
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
