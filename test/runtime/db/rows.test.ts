// The database reader gives the very rows the HTTP source gives (PI-BUILD-PLAN §4.6): one set of
// invented rows is served by the made-up Lumiverse over its HTTP routes and, copied into a database
// file, read by the reader, and the two reads are held against each other whole. The messages carry
// what Lumiverse keeps on a message: swipes with the shown one's text, per-swipe extras, hidden, the
// system role, times in seconds and in milliseconds, entries of several extensions, rows from older
// Lumiverses, bad JSON, JSON of shapes Lumiverse never writes but reads all the same, a shown swipe out
// of range, gaps in the places and two messages at one place. A row Lumiverse itself can't read fails
// both ways. Every chat, book, name and text here is invented.

import { afterEach, describe, expect, test } from "bun:test";
import { Lumiverse } from "../copy/lumiverse";
import { bookRows, chatRows, httpSource, LUMIAH, lumiverseFile, mirror, reader, removeFiles, USER } from "./rig";

afterEach(removeFiles);

/** When the narrator's aside was sent: a time Lumiverse kept in milliseconds. */
const ASIDE_AT = Date.UTC(2026, 10, 12, 8, 59, 30);

/**
 * The harbour chat: a user's question; a reply of three swipes showing the second, with per-swipe
 * extras and the entries of LumiAH, another extension and Lumiverse's saved preset contexts; a hidden
 * system aside kept in milliseconds; a reply whose shown swipe is out of range; rows whose swipes and
 * whose extras aren't JSON; and a row from an older Lumiverse with its extras at the top.
 */
function harbour(lumiverse: Lumiverse) {
  const chat = lumiverse.newChat(USER, { id: "chat-harbour", characterId: "char-joss", metadata: { chat_world_book_ids: ["book-quay"], pinned: { by: "Mara" } } });
  const asked = lumiverse.say(chat.id, "Who keeps the harbour light now?", { user: true });
  const answer = lumiverse.say(chat.id, "Ilse does, since the storm.", {
    swipes: ["Nobody, since the storm.", "Ilse does, since the storm.", "The light keeps itself."],
    swipeId: 1,
    extra: {
      reasoningBySwipe: ["", "She took the keys from the drowned keeper.", "A ghost story."],
      tokenCountBySwipe: [5, 7, 4],
      variableStateBySwipe: [{ spindle_metadata: { preset_contexts: ["p0"] } }, null, null],
      spindle_metadata: { [LUMIAH]: { v: 1, swipes: { "1": { generationId: "gen-7" } } }, lantern_ext: { mood: "wary" }, preset_contexts: ["ctx-a"] },
    },
  });
  const aside = lumiverse.say(chat.id, "(The narrator steps aside.)", { name: "Narrator", sentAt: ASIDE_AT, extra: { spindle_role: "system", hidden: true } });
  const outOfRange = lumiverse.say(chat.id, "The tide turns.", { swipes: ["The tide turns.", "The tide holds."] });
  outOfRange.swipe_id = 5;
  const badSwipes = lumiverse.say(chat.id, "Gulls on the mole.", { swipes: ["Gulls on the mole.", "Terns on the mole."], swipeId: 1 });
  badSwipes.swipes = '["Gulls on the mole.", "Terns on';
  const badExtra = lumiverse.say(chat.id, "The bell rings twice.", { user: true });
  badExtra.extra = '{"hidden": true, "spindle_metadata": ';
  const legacy = lumiverse.say(chat.id, "A lamp from the old days.", {
    extra: { reasoning: "Before swipes kept their own.", tokenCount: 12, generationMetrics: { ms: 900 }, hidden: true, spindle_metadata: { [LUMIAH]: { v: 0 } } },
  });
  return { chat, asked, answer, aside, outOfRange, badSwipes, badExtra, legacy };
}

/** A chat whose places have gaps (messages deleted) and two messages at one place, in more pages than one. */
function quay(lumiverse: Lumiverse) {
  const chat = lumiverse.newChat(USER, { id: "chat-quay", name: "The quay" });
  const rows = lumiverse.imported(chat.id, Array.from({ length: 9 }, (_, i) => `Stone ${i} of the quay.`));
  lumiverse.remove(rows[2]?.id ?? "");
  lumiverse.remove(rows[6]?.id ?? "");
  // A message stored after the others but at the place of the fourth: Lumiverse lists it after it.
  const twin = lumiverse.say(chat.id, "Another stone where the fourth lies.");
  twin.index_in_chat = rows[3]?.index_in_chat ?? 0;
  return { chat, rows, twin };
}

/**
 * The tide tables: rows whose JSON Lumiverse never writes in these shapes but reads all the same.
 * Swipes stored as JSON text (Lumiverse's lean form makes a slot of each letter, the shown one holding
 * its letter), as a JSON object, or as a number; and extras stored as a JSON list.
 */
function tables(lumiverse: Lumiverse) {
  const chat = lumiverse.newChat(USER, { id: "chat-tables", name: "The tide tables" });
  const lettered = lumiverse.say(chat.id, "The ebb leaves the boats aground.");
  Object.assign(lettered, { swipes: '"Ebb"', swipe_id: 1 });
  const shapeless = lumiverse.say(chat.id, "The flood lifts them again.");
  shapeless.swipes = '{"0": "The flood lifts them again."}';
  const counted = lumiverse.say(chat.id, "Seven bells.");
  counted.swipes = "7";
  const listed = lumiverse.say(chat.id, "The keeper writes the tide table.");
  listed.extra = '["hidden"]';
  return { chat, lettered, shapeless, counted, listed };
}

describe("one Lumiverse row comes out of the file as it comes over HTTP", () => {
  test("every message of a chat, whole: swipes, shown text, hidden, role, times, own entry, and Lumiverse's fallbacks for bad rows", async () => {
    const lumiverse = new Lumiverse();
    const story = harbour(lumiverse);
    const file = lumiverseFile();
    mirror(lumiverse, file);

    const fromFile = await reader(file.path).db.readChat(story.chat.id);
    const overHttp = await httpSource(lumiverse).readChat(story.chat.id);

    expect(chatRows(fromFile)).toEqual(chatRows(overHttp));
    // And what those rows say, so the sameness isn't of empty reads.
    const sent = lumiverse.now * 1000;
    expect(fromFile?.chat).toEqual({ id: "chat-harbour", name: "Harbour", characterId: "char-joss", metadata: { chat_world_book_ids: ["book-quay"], pinned: { by: "Mara" } } });
    expect(fromFile?.owner).toBe(USER);
    expect(fromFile?.updatedAt).toBe(sent);
    expect(fromFile?.messages.map((m) => m.row)).toEqual([
      { id: story.asked.id, index: 0, role: "user", name: "Mara", swipeId: 0, swipes: 1, content: "Who keeps the harbour light now?", hidden: false, own: null, at: sent },
      { id: story.answer.id, index: 1, role: "assistant", name: "Joss", swipeId: 1, swipes: 3, content: "Ilse does, since the storm.", hidden: false, own: { v: 1, swipes: { "1": { generationId: "gen-7" } } }, at: sent },
      { id: story.aside.id, index: 2, role: "system", name: "Narrator", swipeId: 0, swipes: 1, content: "(The narrator steps aside.)", hidden: true, own: null, at: ASIDE_AT },
      { id: story.outOfRange.id, index: 3, role: "assistant", name: "Joss", swipeId: 5, swipes: 2, content: "The tide turns.", hidden: false, own: null, at: sent },
      { id: story.badSwipes.id, index: 4, role: "assistant", name: "Joss", swipeId: 1, swipes: 1, content: "Gulls on the mole.", hidden: false, own: null, at: sent },
      { id: story.badExtra.id, index: 5, role: "user", name: "Mara", swipeId: 0, swipes: 1, content: "The bell rings twice.", hidden: false, own: null, at: sent },
      { id: story.legacy.id, index: 6, role: "assistant", name: "Joss", swipeId: 0, swipes: 1, content: "A lamp from the old days.", hidden: true, own: { v: 0 }, at: sent },
    ]);
    // The lean read's texts: the shown swipe's alone (the first's where the shown one is out of range), and a list that isn't JSON read as the message's own text.
    expect(fromFile?.messages.map((m) => m.texts)).toEqual([
      ["Who keeps the harbour light now?"],
      [null, "Ilse does, since the storm.", null],
      ["(The narrator steps aside.)"],
      ["The tide turns.", null],
      ["Gulls on the mole."],
      ["The bell rings twice."],
      ["A lamp from the old days."],
    ]);
    expect(fromFile?.messages.map((m) => m.revision)).toEqual(overHttp?.messages.map((m) => m.revision) ?? []);
  });

  test("rows whose JSON is of shapes Lumiverse never writes: swipes as JSON text, an object or a number, extras as a list", async () => {
    const lumiverse = new Lumiverse();
    const { chat, lettered, shapeless, counted, listed } = tables(lumiverse);
    const file = lumiverseFile();
    mirror(lumiverse, file);

    const fromFile = await reader(file.path).db.readChat(chat.id);

    expect(chatRows(fromFile)).toEqual(chatRows(await httpSource(lumiverse).readChat(chat.id)));
    const sent = lumiverse.now * 1000;
    expect(fromFile?.messages.map((m) => m.row)).toEqual([
      { id: lettered.id, index: 0, role: "assistant", name: "Joss", swipeId: 1, swipes: 3, content: "The ebb leaves the boats aground.", hidden: false, own: null, at: sent },
      { id: shapeless.id, index: 1, role: "assistant", name: "Joss", swipeId: 0, swipes: 1, content: "The flood lifts them again.", hidden: false, own: null, at: sent },
      { id: counted.id, index: 2, role: "assistant", name: "Joss", swipeId: 0, swipes: 1, content: "Seven bells.", hidden: false, own: null, at: sent },
      { id: listed.id, index: 3, role: "assistant", name: "Joss", swipeId: 0, swipes: 1, content: "The keeper writes the tide table.", hidden: false, own: null, at: sent },
    ]);
    // What a letter in the shown slot stands for is the copy's own rule (held against HTTP's above): here, only that there are three slots. Swipes of no list give no texts.
    expect(fromFile?.messages[0]?.texts).toHaveLength(3);
    expect(fromFile?.messages.slice(1).map((m) => m.texts)).toEqual([[], [], ["The keeper writes the tide table."]]);
  });

  test("an extension LumiAH is built into reads its own entry, not LumiAH's", async () => {
    const lumiverse = new Lumiverse();
    const story = harbour(lumiverse);
    const file = lumiverseFile();
    mirror(lumiverse, file);

    const fromFile = await reader(file.path, { identifier: "lantern_ext" }).db.readChat(story.chat.id);

    expect(chatRows(fromFile)).toEqual(chatRows(await httpSource(lumiverse, "lantern_ext").readChat(story.chat.id)));
    expect(fromFile?.messages[1]?.row.own).toEqual({ mood: "wary" });
  });

  test("gaps in the places and two messages at one place, read in pages, in Lumiverse's own order", async () => {
    const lumiverse = new Lumiverse();
    const { chat, rows, twin } = quay(lumiverse);
    const file = lumiverseFile();
    mirror(lumiverse, file);

    const fromFile = await reader(file.path, { page: 2 }).db.readChat(chat.id);

    expect(chatRows(fromFile)).toEqual(chatRows(await httpSource(lumiverse).readChat(chat.id)));
    expect(fromFile?.messages.map((m) => m.row.index)).toEqual([0, 1, 3, 3, 4, 5, 7, 8]);
    expect(fromFile?.messages.map((m) => m.row.id).slice(2, 4)).toEqual([rows[3]?.id, twin.id]);
  });

  test("a chat's cheap signature: the count, the newest message and the chat's own row, as HTTP gives them, and a fingerprint besides", async () => {
    const lumiverse = new Lumiverse();
    const story = harbour(lumiverse);
    const file = lumiverseFile();
    mirror(lumiverse, file);

    const fromFile = await reader(file.path).db.chatSignature(story.chat.id);
    const overHttp = await httpSource(lumiverse).chatSignature(story.chat.id);

    expect(fromFile).toEqual(overHttp === null ? null : { ...overHttp, fingerprint: expect.any(String) });
    expect(fromFile?.last?.id).toBe(story.legacy.id);
    expect(fromFile?.chat?.metadata).toEqual({ chat_world_book_ids: ["book-quay"], pinned: { by: "Mara" } });
  });

  test("a world book and its entries, in the book's order across pages, with the fields Lumiverse splits out of an entry's extensions under either spelling", async () => {
    const lumiverse = new Lumiverse();
    const book = lumiverse.newBook(USER, { id: "book-quay", name: "The quay", description: "Stones and tides.", metadata: { lumibooks_summary: { messages: [] } } });
    lumiverse.addEntry(book.id, { comment: "Spring tide", content: "The quay floods at spring tide.", key: ["tide", "flood"], order: 50, extensions: { outlet_name: "weather", wi_marker: "after", lumibooks: { tier: 1 } } });
    const keeper = lumiverse.addEntry(book.id, { comment: "The keeper", content: "Ilse keeps the light.", order: 100, extensions: { outletName: "keepers", wiMarker: "world_info_before", wiMarkerSide: "Before", wi_marker_side: "after", kept: { by: "Ilse" } } });
    Object.assign(keeper, { role: "assistant", use_regex: 1, vectorized: 1, disabled: 1, constant: 1, keysecondary: '["lamp"]' });
    // Four at one order, told apart by their ids as text ("entry-11" before "entry-5"), one of them stamped by Lumiverse in milliseconds.
    for (const name of ["Bollard", "Capstan", "Anchor"]) lumiverse.addEntry(book.id, { comment: name, content: `The ${name.toLowerCase()} on the quay.`, order: 70 });
    const late = lumiverse.addEntry(book.id, { comment: "Lantern", content: "A lantern on the last bollard.", order: 70 });
    late.updated_at = Date.UTC(2026, 10, 12, 8, 0, 0);
    const file = lumiverseFile();
    mirror(lumiverse, file);

    const fromFile = await reader(file.path, { page: 2 }).db.readBook(book.id, null);
    const overHttp = await httpSource(lumiverse).readBook(book.id, null);

    expect(bookRows(fromFile)).toEqual(bookRows(overHttp));
    expect(fromFile?.book).toEqual({ id: "book-quay", name: "The quay", description: "Stones and tides.", metadata: { lumibooks_summary: { messages: [] } }, updatedAt: lumiverse.now * 1000 });
    expect(fromFile?.entries.map((e) => e.row.title)).toEqual(["Spring tide", "Lantern", "Bollard", "Capstan", "Anchor", "The keeper"]);
    expect(fromFile?.entries[0]?.row.extensions).toEqual({ lumibooks: { tier: 1 } });
    expect(fromFile?.entries.at(-1)?.row.extensions).toEqual({ kept: { by: "Ilse" } });
    expect(fromFile?.entries.at(-1)?.row).toMatchObject({ role: "assistant", regex: true, vectorized: true, enabled: false, constant: true, secondaryKeys: ["lamp"] });
    expect(fromFile?.entries[1]?.row.updatedAt).toBe(Date.UTC(2026, 10, 12, 8, 0, 0));
  });
});

describe("a row Lumiverse itself can't read", () => {
  test("fails its chat's or its book's read over HTTP and from the file alike; the file's words name the row, and the reader stays on", async () => {
    const lumiverse = new Lumiverse();
    const chats: { id: string; why: string }[] = [];
    const nulled = lumiverse.newChat(USER, { id: "chat-nulled" });
    lumiverse.say(nulled.id, "The lamp is lit.");
    const gutters = lumiverse.say(nulled.id, "The lamp gutters.");
    gutters.swipes = "null";
    chats.push({ id: nulled.id, why: `Lumiverse itself can't read message ${gutters.id} of chat ${nulled.id} (its swipes are null), so the chat isn't read from its database either.` });
    // Swipes stored as an object that claims more slots than any list may hold.
    const boasting = lumiverse.newChat(USER, { id: "chat-boasting" });
    const boast = lumiverse.say(boasting.id, "Every swipe the sea ever made.");
    boast.swipes = '{"length": 5000000000}';
    chats.push({ id: boasting.id, why: `Lumiverse itself can't read message ${boast.id} of chat ${boasting.id} (its swipes claim a length no list of them can have), so the chat isn't read from its database either.` });
    const books: { id: string; why: string }[] = [];
    for (const [field, stored, said] of [
      ["key", "[tide", "its keys aren't JSON"],
      ["keysecondary", "lamp", "its secondary keys aren't JSON"],
      ["extensions", "{", "its extensions aren't JSON"],
    ] as const) {
      const book = lumiverse.newBook(USER);
      lumiverse.addEntry(book.id, { comment: "Sound", content: "An entry Lumiverse reads." });
      const broken = lumiverse.addEntry(book.id, { comment: "Broken", content: "An entry it can't." });
      Object.assign(broken, { [field]: stored });
      books.push({ id: book.id, why: `Lumiverse itself can't read entry ${broken.id} of world book ${book.id} (${said}), so the book isn't read from its database either.` });
    }
    const unlabelled = lumiverse.newBook(USER);
    unlabelled.metadata = "{";
    books.push({ id: unlabelled.id, why: `Lumiverse itself can't read world book ${unlabelled.id} (its metadata isn't JSON), so the book isn't read from its database either.` });
    const file = lumiverseFile();
    mirror(lumiverse, file);
    const { db } = reader(file.path);
    const http = httpSource(lumiverse);

    for (const { id, why } of chats) {
      expect(await http.readChat(id).catch((error: unknown) => error)).toBeInstanceOf(Error);
      expect(await http.chatSignature(id).catch((error: unknown) => error)).toBeInstanceOf(Error);
      expect(await db.readChat(id).catch((error: unknown) => error)).toMatchObject({ message: why });
      expect(await db.chatSignature(id).catch((error: unknown) => error)).toMatchObject({ message: why });
    }
    for (const { id, why } of books) {
      expect(await http.readBook(id, null).catch((error: unknown) => error)).toBeInstanceOf(Error);
      expect(await db.readBook(id, null).catch((error: unknown) => error)).toMatchObject({ message: why });
    }
    expect(db.describe()).toMatchObject({ on: true, why: null });
  });
});
