// The copy's rows are the extension's own (PI-BUILD-PLAN §4.5): one Lumiverse row read over HTTP (a
// lean page), heard in an event (the whole row) and given by Spindle's `chat.getMessages` to the
// extension's own host comes out as the same row, with its swipes, the shown swipe's text, hidden, its
// role, its time, the extension's own entry, and whatever per-swipe extras Lumiverse keeps beside it,
// even for swipes an old import stored as JSON text. So do a chat, a world book and its entries, with
// the keys Lumiverse manages itself taken out of an entry's extensions under either spelling. Every
// chat, book, name and text here is invented.

import { afterEach, describe, expect, test } from "bun:test";
import type { HostMessage } from "../../../src/extension/backend/spindle";
import { isRecord } from "../../../src/link/json";
import { createHttpSource } from "../../../src/runtime/copy/http";
import { messageOf } from "../../../src/runtime/copy/rows";
import { Lumiverse } from "./lumiverse";
import { LUMIAH, restoreSpindle, rigCopy, USER } from "./rig";

afterEach(restoreSpindle);

/** When the narrator's aside was sent: a time Lumiverse kept in milliseconds. */
const ASIDE_AT = Date.UTC(2026, 10, 12, 8, 59, 30);

/**
 * A chat with a user's message, a reply of three swipes showing the second with every per-swipe extra,
 * a hidden system aside, and a line whose swipes are stored as JSON text (as an old import can leave
 * them), which Lumiverse's lean form spreads into one slot per letter.
 */
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
  const lettered = lumiverse.say(chat.id, "Gulls over the mole.");
  lettered.swipes = JSON.stringify("Gulls over the mole.");
  // Shown in bulk: an edit event carrying the row as it is stored now.
  lumiverse.hide([lettered.id], false);
  return { chat, asked, answer, aside, lettered };
}

describe("a message is the same row however it reached the copy", () => {
  test("through a lean HTTP page, its event and Spindle's own call", async () => {
    const lumiverse = new Lumiverse();
    const { chat, asked, answer, aside, lettered } = story(lumiverse);
    const { host, copy } = rigCopy({ lumiverse });

    const viaSpindle = await host.chats.messages(chat.id);
    const read = await createHttpSource({ fetch: lumiverse.session(USER), identifier: LUMIAH, sleep: async () => undefined }).readChat(chat.id);
    const viaHttp = read?.messages.map((m) => m.row);
    // Each message as the last event of it carried it.
    const heard = new Map<string, HostMessage>();
    for (const e of lumiverse.emitted) {
      const row = messageOf(isRecord(e.payload) ? e.payload.message : null, LUMIAH)?.row;
      if (row !== undefined) heard.set(row.id, row);
    }
    const viaEvents = [...heard.values()];

    expect(viaHttp).toEqual(viaSpindle);
    expect(viaEvents).toEqual(viaSpindle);
    expect(await copy.chats.messages(chat.id)).toEqual(viaSpindle);
    // And what that row says, so the sameness isn't of three empty rows.
    const sent = lumiverse.now * 1000;
    expect(viaSpindle).toEqual([
      { id: asked.id, index: 0, role: "user", name: "Mara", swipeId: 0, swipes: 1, content: "Who keeps the harbour light now?", hidden: false, own: null, at: sent },
      { id: answer.id, index: 1, role: "assistant", name: "Joss", swipeId: 1, swipes: 3, content: "Ilse does, since the storm.", hidden: false, own: { v: 1, swipes: { "1": { generationId: "gen-7" } } }, at: sent },
      { id: aside.id, index: 2, role: "system", name: "Narrator", swipeId: 0, swipes: 1, content: "(The narrator steps aside.)", hidden: true, own: null, at: ASIDE_AT },
      // One slot per letter of the text, as Lumiverse's lean form gives it.
      { id: lettered.id, index: 3, role: "assistant", name: "Joss", swipeId: 0, swipes: 20, content: "Gulls over the mole.", hidden: false, own: null, at: sent },
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
    const { chat, answer, lettered } = story(lumiverse);
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

    // Swipes stored as JSON text: the lean page's slot holds a letter, not that swipe's text, so the host answers, with the message's text.
    expect(await rig.copy.chats.swipe(chat.id, lettered.id, 0)).toBe("Gulls over the mole.");
    expect(await rig.host.chats.swipe(chat.id, lettered.id, 0)).toBe("Gulls over the mole.");
    expect(rig.fellBack).toEqual([`chats.swipe ${chat.id}`, `chats.swipe ${chat.id}`]);
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
  /** A book whose entries carry what Lumiverse splits out of an entry's extensions, under either spelling, and what it keeps there. */
  function quay(lumiverse: Lumiverse) {
    const book = lumiverse.newBook(USER, { id: "book-quay", name: "The quay", description: "Stones and tides.", metadata: { lumibooks_summary: { messages: [] } } });
    const tide = lumiverse.addEntry(book.id, { comment: "Spring tide", content: "The quay floods at spring tide.", key: ["tide", "flood"], order: 50, extensions: { outlet_name: "weather", lumibooks: { tier: 1 } } });
    const keeper = lumiverse.addEntry(book.id, { comment: "The keeper", content: "Ilse keeps the light.", order: 100 });
    const keeperRow = lumiverse.entries.get(keeper.id);
    if (keeperRow !== undefined) Object.assign(keeperRow, { role: "assistant", use_regex: 1, vectorized: 1, disabled: 1 });
    lumiverse.addEntry(book.id, { comment: "The mole", content: "The mole shelters the boats.", order: 150, extensions: { outletName: " harbour ", wiMarker: "Chat_History", wiMarkerSide: "BEFORE", lumibooks: { tier: 2 } } });
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
    expect((await copy.lore.records(book.id, USER)).map((e) => e.title)).toEqual(["Spring tide", "The keeper", "The mole"]);
    // What Lumiverse keeps of each entry's extensions: its own keys gone under either spelling, an extension's kept.
    expect((await copy.lore.records(book.id, USER)).map((e) => e.extensions)).toEqual([{ lumibooks: { tier: 1 } }, {}, { lumibooks: { tier: 2 } }]);
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
