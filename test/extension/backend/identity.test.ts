// Who a backend is in Lumiverse (DESIGN §21; src/extension/backend/identity.ts): what an extension
// that builds LumiAH into itself names of itself, which connections each of the two takes for its
// own loopback, and where the extension's records sit in its own entry on a message.

import { describe, expect, test } from "bun:test";
import { createBackend } from "../../../src/extension/backend/backend";
import { identityOf } from "../../../src/extension/backend/identity";
import { isRecord } from "../../../src/link/json";
import { FakeHost } from "../../support/fake-host";
import { FakeLumiverse, FakePage } from "../../support/fake-lumiverse";
import { USER } from "../../support/rig";

/** Nothing these tests do waits on a backend's own timers, so it is given none. */
const ENV = { now: () => Date.now(), later: () => () => undefined, build: "test-build" };

const RECORD = { v: 1, generationId: "gen-1", kind: "new" };

/** A runtime of the user's registered with the host's backend, at `port` on this machine: what it was told. */
async function registered(host: FakeHost, port: number): Promise<unknown> {
  return new FakeLumiverse(host, USER).raw({ type: "register", name: "mara", build: "test-build", host: "harbour-box", listen: "127.0.0.1", port });
}

/** Which of the user's connections the backend's pages show as its loopback, by id. */
async function loopbacks(host: FakeHost): Promise<string[]> {
  const state = await new FakePage(host, USER).request("lah.hello", {});
  return state.connections.filter((c) => c.loopback).map((c) => c.id);
}

describe("a backend's identity", () => {
  test("is LumiAH's own unless the extension names another, and an extension that names only its identifier goes by it", () => {
    expect(identityOf()).toEqual({ identifier: "lumi_ah", name: "LumiAH", connectionName: "LumiAH", anchorKey: "lumi_ah" });
    expect(identityOf({ identifier: "other_ext" })).toEqual({ identifier: "other_ext", name: "other_ext", connectionName: "other_ext", anchorKey: "other_ext" });
    expect(identityOf({ identifier: "other_ext", name: "Lantern", anchorKey: "harness" })).toEqual({ identifier: "other_ext", name: "Lantern", connectionName: "Lantern", anchorKey: "harness" });
  });

  test("says where its Settings are shown only when the extension says, and its runtime is told so: a timeout's words there name that place", async () => {
    const at = "Lantern's Harness tab → System → Settings";
    expect(identityOf({ identifier: "other_ext", name: "Lantern", settingsAt: at })).toEqual({ identifier: "other_ext", name: "Lantern", connectionName: "Lantern", anchorKey: "other_ext", settingsAt: at });
    const told = async (identity: { name: string; settingsAt?: string }): Promise<unknown> => {
      const host = new FakeHost("other_ext");
      createBackend(host, ENV, { identity });
      const answer = await registered(host, 7871);
      return isRecord(answer) && isRecord(answer.body) ? answer.body.backend : undefined;
    };
    expect(await told({ name: "Lantern", settingsAt: at })).toEqual({ name: "Lantern", connection: "Lantern", settingsAt: at });
    expect(await told({ name: "Lantern" })).toEqual({ name: "Lantern", connection: "Lantern" });
  });
});

describe("the loopback connections of LumiAH and of an extension that has LumiAH built in", () => {
  /** Three Custom connections at one address and elsewhere, and the user's default. */
  function connections(host: FakeHost): void {
    host.addConnection({ id: "conn-lumiah", name: "LumiAH", provider: "custom", url: "http://127.0.0.1:7871/v1", model: "lumiah" });
    host.addConnection({ id: "conn-lantern", name: "Lantern", provider: "custom", url: "http://127.0.0.1:7871/v1", model: "lumiah-other_ext" });
    host.addConnection({ id: "conn-by-hand", name: "By hand", provider: "custom", url: "http://127.0.0.1:7871/v1/", model: "a-model" });
    host.addConnection({ id: "conn-moved", name: "Moved", provider: "custom", url: "http://localhost:9000/v1", model: "lumiah-other_ext" });
    host.addConnection({ id: "conn-main", name: "Main", provider: "openai", model: "model-main", isDefault: true });
  }

  test("the extension's are the ones that name its own model, or sit at its runtime's address and name no other extension's", async () => {
    const host = new FakeHost("other_ext");
    createBackend(host, ENV, { identity: { name: "Lantern", connectionName: "Lantern loopback" } });
    // The runtime is told who it registered with, and the model its connection names.
    expect(await registered(host, 7871)).toMatchObject({ type: "result", body: { model: "lumiah-other_ext", backend: { name: "Lantern", connection: "Lantern loopback" } } });
    connections(host);

    // LumiAH's own connection is LumiAH's, though it sits at the address this extension's runtime has since taken.
    expect(await loopbacks(host)).toEqual(["conn-lantern", "conn-by-hand", "conn-moved"]);
    // So a prompt on it is LumiAH's to tag: this extension leaves it as it is.
    const chat = host.addChat(USER, "Harbour light");
    const verdict = await host.interceptor?.handler({ chatId: chat.id, userId: USER, generationId: null, type: "normal", dryRun: false, connectionId: "conn-lumiah", presetId: null, personaId: null, activated: [], messages: [{ role: "user", text: "Who keeps the harbour light now?", history: true }] });
    expect(verdict).toEqual({});
  });

  test("LumiAH's are the ones that name LumiAH's model, or sit at its runtime's address and name no other extension's", async () => {
    const host = new FakeHost();
    createBackend(host, ENV);
    expect(await registered(host, 7871)).toMatchObject({ type: "result", body: { model: "lumiah", backend: { name: "LumiAH", connection: "LumiAH" } } });
    connections(host);

    expect(await loopbacks(host)).toEqual(["conn-lumiah", "conn-by-hand"]);
    const chat = host.addChat(USER, "Harbour light");
    const verdict = await host.interceptor?.handler({ chatId: chat.id, userId: USER, generationId: null, type: "normal", dryRun: false, connectionId: "conn-lantern", presetId: null, personaId: null, activated: [], messages: [{ role: "user", text: "Who keeps the harbour light now?", history: true }] });
    expect(verdict).toEqual({});
  });
});

describe("the records of an extension that has LumiAH built in", () => {
  test("are its whole entry on a message, as LumiAH's own are, unless it names a key for them", async () => {
    const host = new FakeHost("other_ext");
    const backend = createBackend(host, ENV);
    const chat = host.addChat(USER, "Harbour light");
    const reply = host.say(chat.id, "assistant", "Okoro keeps it now.");

    expect(await backend.chats.anchor(USER, chat.id, reply.id, 0, RECORD)).toBe(true);

    expect(reply.metadata).toEqual({ other_ext: { v: 1, swipes: { "0": RECORD } } });
    expect((await backend.chats.path(USER, chat.id)).at(-1)?.anchor).toEqual(RECORD);
  });

  test("sit under the key it names, beside what else it keeps on the message, through a swipe deleted", async () => {
    const host = new FakeHost("other_ext");
    const backend = createBackend(host, ENV, { identity: { anchorKey: "harness" } });
    const chat = host.addChat(USER, "Harbour light");
    const reply = host.say(chat.id, "assistant", "Okoro keeps it now.");
    reply.swipes.push("Okoro does, since the spring.");
    // What the extension itself keeps on the message.
    reply.metadata.other_ext = { mood: "wry" };
    const second = { ...RECORD, generationId: "gen-2", kind: "swipe" };

    await backend.chats.anchor(USER, chat.id, reply.id, 0, RECORD);
    await backend.chats.anchor(USER, chat.id, reply.id, 1, second);
    expect(reply.metadata).toEqual({ other_ext: { mood: "wry", harness: { v: 1, swipes: { "0": RECORD, "1": second } } } });
    expect((await backend.chats.path(USER, chat.id)).at(-1)?.anchor).toEqual(RECORD);

    // The first swipe deleted: the second's record moves down with it, and the extension's own stays.
    reply.swipes.shift();
    await backend.chats.swipeDeleted(chat.id, reply.id, 0);
    expect(reply.metadata).toEqual({ other_ext: { mood: "wry", harness: { v: 1, swipes: { "0": second } } } });
  });
});
