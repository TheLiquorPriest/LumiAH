// A chat's own choice of what counts as its story (DESIGN §24.4), on the whole backend over a fake
// Lumiverse: kept beside the chat's switch, read from a document an earlier build saved without it,
// the word of the extension that answers the chat shown over it, and Lumiverse's Sovereign Hand
// shown as not told.

import { afterEach, describe, expect, test } from "bun:test";
import type { BackendExtension } from "../../../src/extension/backend/extension";
import { isRecord } from "../../../src/link/json";
import { type Rig, rig, USER } from "../../support/rig";

let it: Rig | undefined;
afterEach(() => {
  it?.close();
  it = undefined;
});

/** The user's chats.json as stored. */
function chatsDoc(rigged: Rig): Record<string, unknown> {
  const doc = rigged.host.stored(USER, "chats.json");
  if (!isRecord(doc)) throw new Error("the user has no chats.json");
  return doc;
}

describe("a chat's own choice of what counts as its story", () => {
  test("a document saved before the choice existed reads as none, the chat still on; a choice is kept beside the switch, and taken back whole", async () => {
    const rigged = await rig();
    it = rigged;
    const chatId = await rigged.setUpBuiltin();
    // The document as an earlier build wrote it: the switch, and no story.
    const saved = chatsDoc(rigged);
    rigged.host.files.set(`${USER}/chats.json`, JSON.stringify({ v: 1, on: saved.on, ran: saved.ran }));
    await rigged.restart();

    const first = (await rigged.page.request("lah.chat.story.get", { chatId })).story;
    expect(first.chosen).toEqual({});
    expect(first.claimed).toBeNull();
    // This Lumiverse doesn't tell extensions whether Sovereign Hand is on: following it, everyone's messages are the story.
    expect(first.sovereignHand).toBeNull();
    expect(first.holds).toEqual({ source: { hidden: "leave_out", from: "everyone", newest: "directive" }, by: { hidden: "user", from: "user", newest: "user" }, sovereignHand: null });
    expect((await rigged.page.request("lah.chat.get", { chatId })).chat.on).toBe(true);

    const chosen = (await rigged.page.request("lah.chat.story.set", { chatId, story: { hidden: "include", from: "replies" } })).story;
    expect(chosen.holds.source).toEqual({ hidden: "include", from: "replies", newest: "directive" });
    expect(chosen.holds.by).toEqual({ hidden: "chat", from: "chat", newest: "user" });
    const stored = chatsDoc(rigged);
    expect(stored.story).toEqual({ [chatId]: { hidden: "include", from: "replies" } });
    expect(isRecord(stored.on) ? Object.keys(stored.on) : []).toEqual([chatId]);

    const back = (await rigged.page.request("lah.chat.story.set", { chatId, story: {} })).story;
    expect(back.chosen).toEqual({});
    expect(chatsDoc(rigged).story).toEqual({});
  });

  test("the word of the extension that answers the chat is shown, and holds over the chat's own choice", async () => {
    const extension: BackendExtension = { name: "Tide keeper", claim: async () => ({ story: { from: "replies" } }) };
    const rigged = await rig({ backend: { extension } });
    it = rigged;
    const chatId = await rigged.setUpBuiltin();
    const view = (await rigged.page.request("lah.chat.story.set", { chatId, story: { from: "everyone", newest: "leave_out" } })).story;
    expect(view.claimed).toEqual({ by: "Tide keeper", story: { from: "replies" } });
    expect(view.chosen).toEqual({ from: "everyone", newest: "leave_out" });
    expect(view.holds.source).toEqual({ hidden: "leave_out", from: "replies", newest: "leave_out" });
    expect(view.holds.by).toEqual({ hidden: "user", from: "claim", newest: "chat" });
  });
});
