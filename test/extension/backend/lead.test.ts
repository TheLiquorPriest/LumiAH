// Who leads a chat's replies, as the pages read it (`lah.chat.lead.get`), on the whole backend over a
// fake Lumiverse: the agent the claim of the extension that answers the chat names, and whether the
// reply is only what the agents release; nothing where it doesn't claim the chat, or there is no such
// extension; and, where its claim gave no answer, why, never a quiet "nobody claims it".

import { afterEach, describe, expect, test } from "bun:test";
import type { ChatClaim } from "../../../src/core/extension";
import type { BackendExtension } from "../../../src/extension/backend/extension";
import { type Rig, rig } from "../../support/rig";

let it: Rig | undefined;
afterEach(async () => {
  await it?.close();
  it = undefined;
});

describe("who leads a chat's replies, as the pages read it", () => {
  test("the agent the claim names and whether the reply is only what is released; nothing where the chat isn't claimed; the extension's error where its claim failed", async () => {
    let answer: () => Promise<ChatClaim | null> = async () => ({ mainAgent: "author", reply: "released" });
    const extension: BackendExtension = { name: "Tide keeper", claim: () => answer() };
    const rigged = await rig({ backend: { extension } });
    it = rigged;
    const chatId = await rigged.setUp();
    const lead = async () => (await rigged.page.request("lah.chat.lead.get", { chatId })).lead;
    expect(await lead()).toEqual({ by: "Tide keeper", lead: "author", released: true });
    // A claim that names no lead leaves LumiAH's main agent to lead, and the writer to write.
    answer = async () => ({ withdraw: ["lore_grep"] });
    expect(await lead()).toEqual({ by: "Tide keeper", lead: null, released: false });
    answer = async () => null;
    expect(await lead()).toBeNull();
    answer = () => Promise.reject(new Error("the harbour office is shut"));
    expect(await lead()).toMatchObject({ by: "Tide keeper", unanswered: expect.stringContaining("the harbour office is shut") });
  });

  test("with no extension that claims chats, nobody claims the chat: LumiAH's main agent leads", async () => {
    const rigged = await rig();
    it = rigged;
    const chatId = await rigged.setUp();
    expect((await rigged.page.request("lah.chat.lead.get", { chatId })).lead).toBeNull();
  });
});
