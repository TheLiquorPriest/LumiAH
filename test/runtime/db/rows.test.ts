// The database reader gives the very rows the HTTP source gives (PI-BUILD-PLAN §4.6): one set of
// invented rows is served by the made-up Lumiverse over its HTTP routes and, copied into a database
// file, read by the reader, and the two reads are held against each other whole. The messages carry
// what Lumiverse keeps on a message: swipes with the shown one's text, per-swipe extras, hidden, the
// system role, times in seconds and in milliseconds, entries of several extensions, rows from older
// Lumiverses, bad JSON, a shown swipe out of range, gaps in the places and two messages at one place.
// Every chat, book, name and text here is invented.

import { afterEach, describe, expect, test } from "bun:test";
import { type EntryRow, entryFrom, type MessageRow, messageFrom } from "../../../src/runtime/db/rows";
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

  test("a chat's cheap signature names the newest message and the count as HTTP does", async () => {
    const lumiverse = new Lumiverse();
    const story = harbour(lumiverse);
    const file = lumiverseFile();
    mirror(lumiverse, file);

    const fromFile = await reader(file.path).db.chatSignature(story.chat.id);
    const overHttp = await httpSource(lumiverse).chatSignature(story.chat.id);

    expect({ count: fromFile?.count, last: fromFile?.last }).toEqual({ count: overHttp?.count, last: overHttp?.last });
    expect(fromFile?.last?.id).toBe(story.legacy.id);
  });

  test("a world book and its entries, in the book's order across pages, with the fields Lumiverse splits out of an entry's extensions", async () => {
    const lumiverse = new Lumiverse();
    const book = lumiverse.newBook(USER, { id: "book-quay", name: "The quay", description: "Stones and tides.", metadata: { lumibooks_summary: { messages: [] } } });
    lumiverse.addEntry(book.id, { comment: "Spring tide", content: "The quay floods at spring tide.", key: ["tide", "flood"], order: 50, extensions: { outlet_name: "weather", wi_marker: "after", lumibooks: { tier: 1 } } });
    const keeper = lumiverse.addEntry(book.id, { comment: "The keeper", content: "Ilse keeps the light.", order: 100 });
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
    expect(fromFile?.entries.at(-1)?.row).toMatchObject({ role: "assistant", regex: true, vectorized: true, enabled: false, constant: true, secondaryKeys: ["lamp"] });
    expect(fromFile?.entries[1]?.row.updatedAt).toBe(Date.UTC(2026, 10, 12, 8, 0, 0));
  });
});

/** A message row as the reader selects one, Lumiverse's defaults where a test says nothing. */
function messageRow(row: Partial<MessageRow>): MessageRow {
  return {
    at: 1,
    id: "msg-1",
    index_in_chat: 0,
    is_user: 0,
    name: "Joss",
    content: "The light turns.",
    send_date: 1_700_000_000,
    swipe_id: 0,
    swipes: '["The light turns."]',
    extra: "{}",
    created_at: 1_700_000_000,
    revision: 1,
    content_bytes: 16,
    swipes_bytes: 20,
    extra_bytes: 2,
    ...row,
  };
}

function entryRow(row: Partial<EntryRow>): EntryRow {
  return {
    id: "entry-1",
    world_book_id: "book-1",
    key: '["tide"]',
    keysecondary: "[]",
    content: "The quay floods.",
    comment: "Tide",
    role: null,
    order_value: 100,
    constant: 0,
    disabled: 0,
    use_regex: 0,
    vectorized: 0,
    extensions: "{}",
    revision: 1,
    updated_at: 1_700_000_000,
    content_bytes: 16,
    extensions_bytes: 2,
    ...row,
  };
}

describe("rows the made-up Lumiverse has no shape for, read as Lumiverse's own mappers read them", () => {
  test("an entry's outlet and marker under their other spellings are taken out of its extensions too", () => {
    const entry = entryFrom(entryRow({ extensions: JSON.stringify({ outletName: "weather", wiMarker: "after", wiMarkerSide: "before", wi_marker_side: "after", kept: 1 }) }));
    expect(entry.row.extensions).toEqual({ kept: 1 });
  });

  test("swipes stored as a JSON text count its letters, as Lumiverse's lean form does", () => {
    const message = messageFrom(messageRow({ swipes: '"abc"', swipe_id: 1 }), LUMIAH);
    expect(message.row).toMatchObject({ swipes: 3, swipeId: 1, content: "The light turns." });
    expect(message.texts).toEqual([null, "b", null]);
  });

  test("swipes stored as a JSON object, or a number, make a message of one swipe", () => {
    expect(messageFrom(messageRow({ swipes: '{"first": "x"}' }), LUMIAH).row.swipes).toBe(1);
    expect(messageFrom(messageRow({ swipes: "7" }), LUMIAH).row.swipes).toBe(1);
  });

  test("extras that are JSON but no object say nothing of a message", () => {
    expect(messageFrom(messageRow({ extra: '["hidden"]' }), LUMIAH).row).toMatchObject({ hidden: false, role: "assistant", own: null });
    expect(messageFrom(messageRow({ extra: "true" }), LUMIAH).row).toMatchObject({ hidden: false, own: null });
  });

  test("rows Lumiverse's own mappers fail on are refused, each saying why", () => {
    expect(() => messageFrom(messageRow({ swipes: "null" }), LUMIAH)).toThrow("its swipes are null");
    expect(() => messageFrom(messageRow({ swipes: '{"length": 4000000000}' }), LUMIAH)).toThrow("its swipes claim a length no list of them can have");
    expect(() => entryFrom(entryRow({ key: "[tide" }))).toThrow("its keys aren't JSON");
    expect(() => entryFrom(entryRow({ keysecondary: "lamp" }))).toThrow("its secondary keys aren't JSON");
    expect(() => entryFrom(entryRow({ extensions: "{" }))).toThrow("its extensions aren't JSON");
  });
});
