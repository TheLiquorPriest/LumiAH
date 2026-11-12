// An extension that builds LumiAH into itself (DESIGN §21) and the runtime's copy of chat and lore
// (PI-BUILD-PLAN §4.5; src/runtime/reads.ts), end to end on the rig. One keeps LumiAH's record of each
// message in a ledger of its own, which its host puts in as each message's own entry, says when that
// ledger changes, and gives LumiAH no lore, as LumiRPEngine does: the copy reads the same messages and
// records as that host gives. Another keeps the records on the messages in a form of its own, which only
// its backend reads: a chat's message list then goes over the link. Every chat, name and text is made up.

import { afterEach, describe, expect, test } from "bun:test";
import type { HarnessHost, JsonObject, JsonValue } from "../../src/core/ports";
import type { BackendOptions } from "../../src/extension/backend/backend";
import { type AnchorCodec, OWN_ANCHORS } from "../../src/extension/backend/chat";
import type { LoreReads } from "../../src/host/rows";
import { isRecord } from "../../src/link/json";
import { chatData, copyHolds, holding, sent } from "../support/copy-reads";
import { type FakeHost, toolCall } from "../support/fake-host";
import { type Rig, rig, until, USER } from "../support/rig";

let r: Rig | null = null;
afterEach(async () => {
  await r?.close();
  r = null;
});

const IDENTITY = { identifier: "lamp_room", name: "Lamp Room", connectionName: "Lamp Room loopback" };

/** How many link pushes of a kind the runtime's socket carried to it. */
function pushes(it: Rig, type: string): number {
  return it.lumiverse.frames.filter((frame) => {
    if (frame.to !== "runtime") return false;
    const wire: unknown = JSON.parse(frame.text);
    const data = isRecord(wire) && isRecord(wire.payload) ? wire.payload.data : null;
    return isRecord(data) && data.type === type;
  }).length;
}

/**
 * A mounting extension that keeps LumiAH's record of each message in a ledger of its own, by chat and
 * message, in LumiAH's own form (`{ v: 1, swipes }`, which its codec says, `reads`): its host's
 * `chats.messages` puts each message's entry in as its own, its `chats.setOwn` writes the ledger and no
 * message, it says whenever the ledger changes, and its host gives LumiAH no lore.
 */
function ledgered(): { options: BackendOptions; mount: (host: FakeHost) => FakeHost; ledger: Map<string, Record<string, JsonValue>>; changed(chatId: string, userId: string | null): void } {
  const ledger = new Map<string, Record<string, JsonValue>>();
  const listeners: ((chatId: string, userId: string | null) => void)[] = [];
  const changed = (chatId: string, userId: string | null): void => {
    for (const listener of listeners) listener(chatId, userId);
  };
  const anchor: AnchorCodec = { reads: { under: null }, read: OWN_ANCHORS.read, write: OWN_ANCHORS.write, swipeDeleted: OWN_ANCHORS.swipeDeleted };
  const mount = (host: FakeHost): FakeHost => {
    const chats: FakeHost["chats"] = {
      ...host.chats,
      messages: async (chatId, range) => (await host.chats.messages(chatId, range)).map((m) => ({ ...m, own: structuredClone(ledger.get(chatId)?.[m.id] ?? null) })),
      setOwn: async (chatId, messageId, value) => {
        const records = { ...(ledger.get(chatId) ?? {}) };
        if (value === null) delete records[messageId];
        else records[messageId] = structuredClone(value);
        ledger.set(chatId, records);
        changed(chatId, host.chatList.get(chatId)?.userId ?? null);
      },
    };
    const lore: LoreReads = { book: async () => null, entries: async () => [], entry: async () => null, record: async () => null, records: async () => [], global: async () => [], ofCharacter: async () => [], ofPersona: async () => null };
    return new Proxy(host, { get: (target, key) => (key === "chats" ? chats : key === "lore" ? lore : Reflect.get(target, key, target)) });
  };
  return {
    ledger,
    changed,
    mount,
    options: { identity: IDENTITY, anchor, ownElsewhere: { read: async (chatId) => structuredClone(ledger.get(chatId) ?? {}), onChanged: (listener) => void listeners.push(listener) }, declinesLore: true },
  };
}

describe("an extension that keeps LumiAH's records in a ledger of its own and gives it no lore", () => {
  test("the runtime's copy reads the same messages and records as the extension's host gives, is told whenever the ledger changes, and reads no lore", async () => {
    const lamp = ledgered();
    const held: { host: HarnessHost | null } = { host: null };
    const it = (r = await rig({ backend: lamp.options, mount: lamp.mount, harness: holding(held), reads: "both" }));
    const chatId = await it.setUp();
    it.host.script = [{ toolCalls: [toolCall("write_reply", { brief: "Okoro." }, "c1")] }, "Okoro keeps it now.", { toolCalls: [toolCall("write_reply", { brief: "Ilse, before him." }, "c2")] }, "Ilse did, before him."];
    const first = await it.generate(chatId);
    const reply = first.messageId ?? "";
    // The turn's record is in the ledger, and nothing of it is on the message.
    await until(() => lamp.ledger.get(chatId)?.[reply] !== undefined, "the reply's record in the ledger");
    expect(it.host.message(chatId, reply).own).toBeNull();
    await copyHolds(it, (state) => state.road === "copy", "the copy to be offered");
    const host = held.host as HarnessHost;
    const from = it.lumiverse.frames.length;

    // Every read asked of the copy and over the link, and the two alike.
    const path = await host.chat.path(chatId);
    expect(path.map((m) => m.role)).toEqual(["user", "assistant"]);
    expect(path[1]?.anchor).toMatchObject({ v: 1, generationId: first.generationId });
    expect((await host.chat.messages(chatId, 0, 10)).map((m) => m.content)).toEqual(["Who keeps the harbour light now?", "Okoro keeps it now."]);
    expect(await host.lore.books(chatId)).toEqual([]);
    expect(await host.recall?.lore?.read(chatId)).toEqual([]);
    expect(it.differences).toEqual([]);

    // The ledger changes by itself (its own page let go of the record) and says so: the next read has the records as its host gives them.
    const told = pushes(it, "own");
    lamp.ledger.set(chatId, {});
    lamp.changed(chatId, USER);
    await it.backend.settle();
    await until(() => pushes(it, "own") > told, "the change told to the runtime");
    const asked = it.lumiverse.frames.length;
    expect((await host.chat.path(chatId))[1]?.anchor).toBeNull();
    expect(sent(it.lumiverse, asked)).toContain("own.read");
    expect(it.differences).toEqual([]);

    // A turn the runtime runs writes its record in the ledger, and the next read has it.
    it.host.say(chatId, "user", "And before him?");
    const second = await it.generate(chatId);
    await until(() => lamp.ledger.get(chatId)?.[second.messageId ?? ""] !== undefined, "the second reply's record in the ledger");
    expect((await host.chat.path(chatId)).at(-1)?.anchor).toMatchObject({ v: 1, generationId: second.generationId });
    expect(it.differences).toEqual([]);

    // The copy answered them: it holds the chat, read from Lumiverse's routes with the records asked of the extension, and read no lore anywhere.
    const crossed = sent(it.lumiverse, from);
    expect(crossed.filter((type) => type === "turn.lore" || type.startsWith("host.read lore."))).toEqual([]);
    expect(it.lumiverse.asked.some((a) => a.line.includes("/api/v1/world-books/"))).toBe(false);
    expect(it.lumiverse.asked.some((a) => a.line.startsWith(`GET /api/v1/chats/${chatId}/messages`))).toBe(true);
    const state = await chatData(it);
    expect(state.road).toBe("copy");
    expect(state.chats.map((c) => c.id)).toContain(chatId);
    expect(state.books).toEqual([]);
  });
});

describe("an extension whose record of a message is in a form of its own", () => {
  test("has a chat's message list read through it, as only its backend reads that form: the copy answers the rest, and the page says why", async () => {
    const turnsOf = (own: JsonValue | null): JsonObject => (isRecord(own) && isRecord(own.turns) ? (own.turns as JsonObject) : {});
    // It keeps LumiAH's record of each swipe under its own `turns`, beside what else it keeps on the message, and says nothing of where the runtime might read it.
    const anchor: AnchorCodec = {
      read: (own, swipe) => (turnsOf(own)[String(swipe)] as JsonValue | undefined) ?? null,
      write: (own, swipe, record) => ({ lamp: "lit", ...(isRecord(own) ? (own as JsonObject) : {}), turns: { ...turnsOf(own), [String(swipe)]: record } }),
      swipeDeleted: () => null,
    };
    const held: { host: HarnessHost | null } = { host: null };
    const it = (r = await rig({ backend: { identity: IDENTITY, anchor }, harness: holding(held), reads: "copy" }));
    const chatId = await it.setUp();
    it.host.script = [{ toolCalls: [toolCall("write_reply", { brief: "Okoro." }, "c1")] }, "Okoro keeps it now."];
    const first = await it.generate(chatId);
    await until(() => it.host.message(chatId, first.messageId ?? "").own !== null, "the reply's record");
    await copyHolds(it, (state) => state.road === "copy", "the copy to be offered");
    const host = held.host as HarnessHost;
    const from = it.lumiverse.frames.length;

    const path = await host.chat.path(chatId);
    expect(path[1]?.anchor).toMatchObject({ v: 1, generationId: first.generationId });
    expect((await host.chat.messages(chatId, 0, 10)).map((m) => m.content)).toEqual(["Who keeps the harbour light now?", "Okoro keeps it now."]);
    // The message list crossed as the extension's backend read it; the messages themselves didn't.
    expect(sent(it.lumiverse, from).filter((type) => type === "chat.path" || type === "chat.messages")).toEqual(["chat.path"]);
    const state = await chatData(it);
    expect(state.road).toBe("copy");
    expect(state.why).toContain("A chat's message list, which carries LumiAH's records, is read through Lamp Room: it keeps them in a form only it reads.");
  });
});
