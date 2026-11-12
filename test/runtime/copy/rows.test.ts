// The copy's rows are the extension's own (PI-BUILD-PLAN §4.5): one Lumiverse row read over HTTP (a
// lean page), heard in an event (the whole row) and given by Spindle's `chat.getMessages` to the
// extension's own host comes out as the same row, with its swipes, the shown swipe's text, hidden, its
// role, its time, the extension's own entry, and whatever per-swipe extras Lumiverse keeps beside it.
// So do a chat, a world book and its entries. Every chat, book, name and text here is invented.

import { afterEach, describe, expect, test } from "bun:test";
import { isRecord } from "../../../src/link/json";
import { createHttpSource } from "../../../src/runtime/copy/http";
import { messageOf } from "../../../src/runtime/copy/rows";
import { Lumiverse } from "./lumiverse";
import { LUMIAH, restoreSpindle, rigCopy, USER } from "./rig";

afterEach(restoreSpindle);

/** When the narrator's aside was sent: a time Lumiverse kept in milliseconds. */
const ASIDE_AT = Date.UTC(2026, 10, 12, 8, 59, 30);

/** A chat with a user's message, a reply of three swipes showing the second with every per-swipe extra, and a hidden system aside. */
function story(lumiverse: Lumiverse) {
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
  return { chat, asked, answer, aside };
}

describe("a message is the same row however it reached the copy", () => {
  test("through a lean HTTP page, its event and Spindle's own call", async () => {
    const lumiverse = new Lumiverse();
    const { chat, asked, answer, aside } = story(lumiverse);
    const { host, copy } = rigCopy({ lumiverse });

    const viaSpindle = await host.chats.messages(chat.id);
    const read = await createHttpSource({ fetch: lumiverse.session(USER), identifier: LUMIAH, sleep: async () => undefined }).readChat(chat.id);
    const viaHttp = read?.messages.map((m) => m.row);
    const viaEvents = lumiverse.emitted.map((e) => messageOf(isRecord(e.payload) ? e.payload.message : null, LUMIAH)?.row);

    expect(viaHttp).toEqual(viaSpindle);
    expect(viaEvents).toEqual(viaSpindle);
    expect(await copy.chats.messages(chat.id)).toEqual(viaSpindle);
    // And what that row says, so the sameness isn't of three empty rows.
    const sent = lumiverse.now * 1000;
    expect(viaSpindle).toEqual([
      { id: asked.id, index: 0, role: "user", name: "Mara", swipeId: 0, swipes: 1, content: "Who keeps the harbour light now?", hidden: false, own: null, at: sent },
      { id: answer.id, index: 1, role: "assistant", name: "Joss", swipeId: 1, swipes: 3, content: "Ilse does, since the storm.", hidden: false, own: { v: 1, swipes: { "1": { generationId: "gen-7" } } }, at: sent },
      { id: aside.id, index: 2, role: "system", name: "Narrator", swipeId: 0, swipes: 1, content: "(The narrator steps aside.)", hidden: true, own: null, at: ASIDE_AT },
    ]);
  });

  test("an extension that builds LumiAH in reads its own entry, not LumiAH's", async () => {
    const lumiverse = new Lumiverse();
    const { chat, answer } = story(lumiverse);
    lumiverse.setOwn(answer.id, "lantern_ext", { v: 1, swipes: { "1": { generationId: "gen-9" } } });
    const { host, copy } = rigCopy({ lumiverse, identifier: "lantern_ext" });

    const rows = await copy.chats.messages(chat.id);

    expect(rows).toEqual(await host.chats.messages(chat.id));
    expect(rows[1]?.own).toEqual({ v: 1, swipes: { "1": { generationId: "gen-9" } } });
  });

  test("a swipe's text: the shown one from the page, the others once an event carried them whole", async () => {
    const lumiverse = new Lumiverse();
    const { chat, answer } = story(lumiverse);
    const rig = rigCopy({ lumiverse });
    rig.lose();
    const shown = await rig.copy.chats.swipe(chat.id, answer.id, 1);
    expect(shown).toBe("Ilse does, since the storm.");
    expect(rig.fellBack).toEqual([]);

    // A lean page carries no other swipe's text: the extension's host answers, and the copy keeps nothing of it.
    expect(await rig.copy.chats.swipe(chat.id, answer.id, 0)).toBe("Nobody, since the storm.");
    expect(rig.fellBack).toEqual([`chats.swipe ${chat.id}`]);

    lumiverse.editSwipe(answer.id, 2, "The light keeps itself, they say.");
    rig.forward();
    for (const swipe of [0, 1, 2, 3]) expect(await rig.copy.chats.swipe(chat.id, answer.id, swipe)).toBe(await rig.host.chats.swipe(chat.id, answer.id, swipe));
    expect(rig.fellBack).toEqual([`chats.swipe ${chat.id}`]);
  });

  test("a chat as the host gives it, and its messages by place", async () => {
    const lumiverse = new Lumiverse();
    const { chat } = story(lumiverse);
    const { host, copy } = rigCopy({ lumiverse });

    expect(await copy.chats.get(chat.id, USER)).toEqual(await host.chats.get(chat.id, USER));
    expect(await copy.chats.messages(chat.id, { from: 1, count: 5 })).toEqual(await host.chats.messages(chat.id, { from: 1, count: 5 }));
    expect(await copy.chats.messages(chat.id, { tail: 2 })).toEqual(await host.chats.messages(chat.id, { tail: 2 }));
    expect(await copy.chats.messages(chat.id, { from: 7, count: 2 })).toEqual([]);
  });
});

describe("a world book is the same rows however it reached the copy", () => {
  /** A book whose entries carry what Lumiverse splits out of an entry's extensions, and what it keeps there. */
  function quay(lumiverse: Lumiverse) {
    const book = lumiverse.newBook(USER, { id: "book-quay", name: "The quay", description: "Stones and tides.", metadata: { lumibooks_summary: { messages: [] } } });
    const tide = lumiverse.addEntry(book.id, { comment: "Spring tide", content: "The quay floods at spring tide.", key: ["tide", "flood"], order: 50, extensions: { outlet_name: "weather", lumibooks: { tier: 1 } } });
    const keeper = lumiverse.addEntry(book.id, { comment: "The keeper", content: "Ilse keeps the light.", order: 100 });
    const keeperRow = lumiverse.entries.get(keeper.id);
    if (keeperRow !== undefined) Object.assign(keeperRow, { role: "assistant", use_regex: 1, vectorized: 1, disabled: 1 });
    return { book, tide, keeper };
  }

  test("the book, its record, its entries and their records", async () => {
    const lumiverse = new Lumiverse();
    const { book, tide } = quay(lumiverse);
    const { host, copy } = rigCopy({ lumiverse });

    expect(await copy.lore.book(book.id, USER)).toEqual(await host.lore.book(book.id, USER));
    expect(await copy.lore.record(book.id, USER)).toEqual(await host.lore.record(book.id, USER));
    expect(await copy.lore.entries(book.id, USER)).toEqual(await host.lore.entries(book.id, USER));
    expect(await copy.lore.records(book.id, USER)).toEqual(await host.lore.records(book.id, USER));
    expect(await copy.lore.entry(tide.id, USER)).toEqual(await host.lore.entry(tide.id, USER));
    expect((await copy.lore.records(book.id, USER)).map((e) => e.title)).toEqual(["Spring tide", "The keeper"]);
  });

  test("an entry's event leaves the copy as the host reads the book, its stamp included", async () => {
    const lumiverse = new Lumiverse();
    const { book, keeper } = quay(lumiverse);
    const rig = rigCopy({ lumiverse });
    rig.lose();
    await rig.copy.lore.records(book.id, USER);
    const asked = lumiverse.asked.length;

    lumiverse.now += 90;
    lumiverse.updateEntry(keeper.id, { content: "Ilse kept the light until the spring.", order: 10 });
    lumiverse.now += 5;
    lumiverse.addEntry(book.id, { comment: "The drowned keeper", content: "He gave Ilse the keys.", order: 100 });
    rig.forward();

    expect(await rig.copy.lore.records(book.id, USER)).toEqual(await rig.host.lore.records(book.id, USER));
    expect(await rig.copy.lore.record(book.id, USER)).toEqual(await rig.host.lore.record(book.id, USER));
    // Applied as heard: nothing was read again.
    expect(lumiverse.asked.length).toBe(asked);
  });
});
