// Which connection a chat generates on (DESIGN §2, §8: "which chats LumiAH answers"). LumiAH answers
// a chat exactly when that connection is its loopback, so it must pick the one Lumiverse picks: the
// chat's own, else the connection the user has selected there, else their default, else the first
// listed. A call that names no connection is another matter: Lumiverse runs it on the default alone.

import { describe, expect, test } from "bun:test";
import { createBackend } from "../../../src/extension/backend/backend";
import { Connections } from "../../../src/extension/backend/connections";
import type { InterceptorVerdict } from "../../../src/extension/backend/spindle";
import { TAG_PARAM } from "../../../src/link/contract";
import { FakeHost } from "../../support/fake-host";
import { FakePage } from "../../support/fake-lumiverse";

const USER = "user-mara";
const MAIN = { id: "conn-main", name: "Main", loopback: false };
const LOOPBACK = { id: "conn-loop", name: "LumiAH", loopback: true };
const OTHER = { id: "conn-other", name: "Other", loopback: false };

/** The extension backend over a fake Lumiverse: a default connection, LumiAH's loopback and a third, a chat that pins none, and a page of the user's. */
function start() {
  const host = new FakeHost();
  const backend = createBackend(host, { now: () => 1_000_000, later: () => () => undefined, build: "test-build" });
  host.addConnection({ id: MAIN.id, name: MAIN.name, provider: "openai", model: "model-main", isDefault: true });
  host.addConnection({ id: LOOPBACK.id, name: LOOPBACK.name, provider: "custom", url: "http://127.0.0.1:7871/v1", model: "lumiah" });
  host.addConnection({ id: OTHER.id, name: OTHER.name });
  const chat = host.addChat(USER, "Harbour light");
  host.say(chat.id, "user", "Who keeps the harbour light now?");
  const page = new FakePage(host, USER);
  /** The connection the pages show the chat generating on. */
  const shown = async (): Promise<unknown> => (await page.request("lah.chat.get", { chatId: chat.id })).chat.connection;
  /** A reply's prompt in the chat, on a Lumiverse whose context names no connection: what the interceptor does to it. */
  const intercept = (generationId: string): Promise<InterceptorVerdict> => {
    host.emit.started({ generationId, chatId: chat.id, userId: USER, type: "normal", targetMessageId: null, targetSwipeId: null });
    const interceptor = host.interceptor;
    if (interceptor === null) throw new Error("the backend registered no interceptor");
    return interceptor.handler({ chatId: chat.id, userId: USER, generationId, type: "normal", dryRun: false, connectionId: null, presetId: null, personaId: null, activated: [], messages: [{ role: "user", text: "Who keeps the harbour light now?", history: true }] });
  };
  return { host, backend, chat, page, shown, intercept };
}

describe("a chat with no connection of its own", () => {
  test("follows the connection selected in Lumiverse, not the default", async () => {
    const { host, shown } = start();
    // None selected: the default.
    expect(await shown()).toEqual(MAIN);
    host.select(USER, LOOPBACK.id);
    expect(await shown()).toEqual(LOOPBACK);
    host.select(USER, OTHER.id);
    expect(await shown()).toEqual(OTHER);
    // A selection whose connection is gone is none.
    host.connectionList = host.connectionList.filter((c) => c.id !== OTHER.id);
    expect(await shown()).toEqual(MAIN);
  });

  test("is answered from the first reply after the loopback is selected, and no longer once another is", async () => {
    const { host, intercept } = start();
    expect(await intercept("gen-1")).toEqual({});
    host.select(USER, LOOPBACK.id);
    expect(typeof (await intercept("gen-2")).parameters?.[TAG_PARAM]).toBe("string");
    host.select(USER, OTHER.id);
    expect(await intercept("gen-3")).toEqual({});
  });

  test("generates on the first connection Lumiverse lists when none is selected and none is the default", async () => {
    const host = new FakeHost();
    createBackend(host, { now: () => 1_000_000, later: () => () => undefined, build: "test-build" });
    host.addConnection({ id: OTHER.id, name: OTHER.name });
    host.addConnection({ id: LOOPBACK.id, name: LOOPBACK.name, provider: "custom", url: "http://127.0.0.1:7871/v1", model: "lumiah" });
    const chat = host.addChat(USER, "Brann's ledger");
    expect((await new FakePage(host, USER).request("lah.chat.get", { chatId: chat.id })).chat.connection).toEqual(OTHER);
  });

  test("goes by what the user's page read where Lumiverse doesn't say which connection is selected, and by Lumiverse's own word where it does", async () => {
    const { host, page, shown, intercept } = start();
    // A Lumiverse from before it showed an extension the selection.
    host.capabilities.delete("connection-organization-v1");
    host.select(USER, LOOPBACK.id);
    expect(await shown()).toEqual(MAIN);
    expect(await intercept("gen-1")).toEqual({});

    // The page says hello with what it read there: the chat goes by it at once.
    await page.request("lah.hello", { active: LOOPBACK.id });
    expect(await shown()).toEqual(LOOPBACK);
    expect(typeof (await intercept("gen-2")).parameters?.[TAG_PARAM]).toBe("string");
    // A hello that says nothing of it changes nothing; one that says none is selected does.
    await page.request("lah.hello", {});
    expect(await shown()).toEqual(LOOPBACK);
    await page.request("lah.hello", { active: null });
    expect(await shown()).toEqual(MAIN);

    // Where Lumiverse says it itself, a page's older word doesn't stand against it.
    await page.request("lah.hello", { active: LOOPBACK.id });
    host.capabilities.add("connection-organization-v1");
    host.select(USER, OTHER.id);
    expect(await shown()).toEqual(OTHER);
  });
});

describe("a chat with a connection of its own", () => {
  test("generates on it whatever is selected, and on the selected one once its own is gone", async () => {
    const { host, chat, shown } = start();
    host.select(USER, LOOPBACK.id);
    chat.metadata.connection_profile_id = OTHER.id;
    expect(await shown()).toEqual(OTHER);
    chat.metadata.connection_profile_id = "conn-deleted";
    expect(await shown()).toEqual(LOOPBACK);
  });
});

describe("a call that names no connection", () => {
  test("goes on the default connection, as Lumiverse runs it, whatever is selected", async () => {
    const { host } = start();
    const connections = new Connections(host, { model: "lumiah", bases: async () => [], serialTools: async () => [] });
    host.select(USER, LOOPBACK.id);
    expect(await connections.profile(USER, null)).toMatchObject({ id: MAIN.id, loopback: false });
    expect(await connections.isLoopback(USER, null)).toBe(false);
  });
});
