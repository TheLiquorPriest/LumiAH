// The page's end of the messages with the backend: each request answered by its own id, a failure
// in the backend's words, the state kept current by the pushes, and the live pushes handed on.

import { describe, expect, test } from "bun:test";
import { MockBackend } from "../../dev/preview/mock-backend";
import { sampleSettings } from "../../dev/preview/sections";
import { type Channel, UiClient, UiRequestError } from "../../src/extension/frontend/client";
import { type BackendToFrontend, type ChatView, type FrontendToBackend, type UiState, UI_VERSION } from "../../src/shared/ui";

/** A channel whose other end is the test: what the page sent, and a way to answer it. */
function wire(timeoutMs = 1000, hello?: () => { active?: string | null }) {
  const sent: FrontendToBackend[] = [];
  let handler: (payload: unknown) => void = () => {};
  const channel: Channel = {
    send: (payload) => void sent.push(payload),
    subscribe: (h) => {
      handler = h;
      return () => {
        handler = () => {};
      };
    },
  };
  const client = new UiClient(channel, { timeoutMs: () => timeoutMs, ...(hello ? { hello } : {}) });
  return { client, sent, deliver: (message: unknown) => handler(message), last: () => sent.at(-1) as FrontendToBackend };
}

/** A whole state, as the backend's hello answers it. */
function stateOf(rev: number): UiState {
  let state: UiState | null = null;
  const settled = sampleSettings();
  const backend = new MockBackend(() => {}, { scenario: "ready", turn: "none", sections: settled.sections, texts: settled.texts, delay: 0, page: 50, fail: new Set(), now: () => 0, later: (fn) => (fn(), () => {}) });
  state = { ...backend.state, rev };
  return state;
}

const result = (reqId: string, request: string, body: unknown): unknown => ({ lah: UI_VERSION, type: "lah.result", reqId, request, body });

describe("requests", () => {
  test("a request goes out in an envelope and resolves with the result that names its id", async () => {
    const w = wire();
    const asked = w.client.request("lah.chat.get", { chatId: "chat-mara" });
    expect(w.last()).toMatchObject({ lah: UI_VERSION, type: "lah.chat.get", chatId: "chat-mara" });
    const chat: ChatView = { chatId: "chat-mara", name: "Mara at the harbour", on: true, since: 1, place: "builtin", connection: null };
    w.deliver(result(w.last().reqId, "lah.chat.get", { chat }));
    expect(await asked).toEqual({ chat });
  });

  test("two requests under way are each answered by their own id, in whatever order the answers come", async () => {
    const w = wire();
    const first = w.client.request("lah.blob.get", { hash: "a" });
    const firstId = w.last().reqId;
    const second = w.client.request("lah.blob.get", { hash: "b" });
    const secondId = w.last().reqId;
    expect(firstId).not.toBe(secondId);
    w.deliver(result(secondId, "lah.blob.get", { text: "second" }));
    w.deliver(result(firstId, "lah.blob.get", { text: "first" }));
    expect(await first).toEqual({ text: "first" });
    expect(await second).toEqual({ text: "second" });
  });

  test("a refusal rejects with the backend's code, its words, and each value it refused", async () => {
    const w = wire();
    const asked = w.client.request("lah.settings.set", { set: [{ path: ["sample", "history", "count"], value: 0 }], reset: [] });
    w.deliver({ lah: UI_VERSION, type: "lah.error", reqId: w.last().reqId, code: "invalid", message: "Not saved: It can't be under 1.", problems: [{ path: ["sample", "history", "count"], message: "It can't be under 1." }] });
    const error = await asked.catch((e: unknown) => e);
    expect(error).toBeInstanceOf(UiRequestError);
    expect(error).toMatchObject({ code: "invalid", message: "Not saved: It can't be under 1.", problems: [{ path: ["sample", "history", "count"], message: "It can't be under 1." }] });
  });

  test("a request nothing answers fails in time, saying so", async () => {
    const w = wire(15);
    const error = await w.client.request("lah.hello", {}).catch((e: unknown) => e);
    expect(error).toMatchObject({ code: "timeout" });
    // An answer that comes after all is no one's.
    w.deliver(result(w.last().reqId, "lah.hello", stateOf(1)));
    expect(w.client.state.get()).toBeNull();
  });

  test("messages that aren't LumiAH's, or speak another version, are left alone", async () => {
    const w = wire(15);
    const asked = w.client.request("lah.blob.get", { hash: "a" }).catch((e: unknown) => e);
    w.deliver({ type: "lre.result", reqId: w.last().reqId, body: { text: "another extension's" } });
    w.deliver({ lah: UI_VERSION + 1, type: "lah.result", reqId: w.last().reqId, request: "lah.blob.get", body: { text: "a later build's" } });
    w.deliver("not even an object");
    expect(await asked).toMatchObject({ code: "timeout" });
  });

  test("a page that has closed asks nothing more, and what it was waiting for fails", async () => {
    const w = wire();
    const pending = w.client.request("lah.blob.get", { hash: "a" }).catch((e: unknown) => e);
    w.client.dispose();
    expect(await pending).toMatchObject({ code: "closed" });
    expect(await w.client.request("lah.hello", {}).catch((e: unknown) => e)).toMatchObject({ code: "closed" });
  });
});

describe("the state every page holds", () => {
  test("hello brings the whole state, and the page is ready", async () => {
    const w = wire();
    const syncing = w.client.sync();
    expect(w.client.connection.get()).toBe("connecting");
    w.deliver(result(w.last().reqId, "lah.hello", stateOf(4)));
    await syncing;
    expect(w.client.connection.get()).toBe("ready");
    expect(w.client.state.get()?.rev).toBe(4);
  });

  test("a hello nothing answers leaves a page that never had the state saying it failed", async () => {
    const w = wire(10);
    await w.client.sync();
    expect(w.client.connection.get()).toBe("failed");
  });

  test("a push with the next revision replaces the parts it carries and leaves the rest", async () => {
    const w = wire();
    const syncing = w.client.sync();
    w.deliver(result(w.last().reqId, "lah.hello", stateOf(4)));
    await syncing;
    const before = w.client.state.get();
    const push: BackendToFrontend = { lah: UI_VERSION, type: "lah.state", rev: 5, patch: { running: [{ stream: "chat-mara", chatId: "chat-mara", turn: "t", kind: "new", startedAt: 9, paused: false }] } };
    w.deliver(push);
    expect(w.client.state.get()?.rev).toBe(5);
    expect(w.client.state.get()?.running).toHaveLength(1);
    expect(w.client.state.get()?.chats).toBe(before?.chats as UiState["chats"]);
  });

  test("a push out of step makes the page say hello again rather than guess", async () => {
    const w = wire();
    const syncing = w.client.sync();
    w.deliver(result(w.last().reqId, "lah.hello", stateOf(4)));
    await syncing;
    const hellos = (): number => w.sent.filter((m) => m.type === "lah.hello").length;
    expect(hellos()).toBe(1);
    w.deliver({ lah: UI_VERSION, type: "lah.state", rev: 9, patch: { running: [] } });
    expect(w.client.state.get()?.rev).toBe(4);
    expect(hellos()).toBe(2);
    w.deliver(result(w.last().reqId, "lah.hello", stateOf(9)));
    await Promise.resolve();
    await Promise.resolve();
    expect(w.client.state.get()?.rev).toBe(9);
  });

  test("a request's own result shows at once, before the push that follows it", async () => {
    const w = wire();
    const syncing = w.client.sync();
    w.deliver(result(w.last().reqId, "lah.hello", stateOf(4)));
    await syncing;
    w.client.patch({ key: { set: false, print: null, at: null } });
    expect(w.client.state.get()?.key.set).toBe(false);
    // The push that says the same then follows on in order.
    w.deliver({ lah: UI_VERSION, type: "lah.state", rev: 5, patch: { key: { set: false, print: null, at: null } } });
    expect(w.client.state.get()?.rev).toBe(5);
  });
});

describe("live pushes and coming back", () => {
  test("a live push reaches every view that listens, with its chat: a turn's changes, and what a call in flight sent", () => {
    const w = wire();
    const heard: string[] = [];
    const off = w.client.onLive((stream, change) => heard.push(`${stream}:${"delta" in change ? `delta ${change.delta.text ?? ""}` : "view" in change ? "view" : `${change.events.length} events`}`));
    w.deliver({ lah: UI_VERSION, type: "lah.live", stream: "chat-mara", change: { turn: "t", events: [], ended: null } });
    w.deliver({ lah: UI_VERSION, type: "lah.live.delta", stream: "chat-mara", delta: { turn: "t", agentId: "main-1", call: 1, text: "The door", before: { text: 0, reasoning: 0 }, at: 5 } });
    off();
    w.deliver({ lah: UI_VERSION, type: "lah.live", stream: "chat-mara", change: { turn: "t", events: [], ended: null } });
    expect(heard).toEqual(["chat-mara:0 events", "chat-mara:delta The door"]);
  });

  test("each hello tells the backend what only a page knows of Lumiverse, read anew each time", async () => {
    let active: string | null = "conn-deepseek";
    const w = wire(1000, () => ({ active }));
    const first = w.client.sync();
    expect(w.last()).toMatchObject({ type: "lah.hello", active: "conn-deepseek" });
    w.deliver(result(w.last().reqId, "lah.hello", stateOf(1)));
    await first;
    // The user made another profile active in Lumiverse (here: none), then came back to the page.
    active = null;
    w.client.resync();
    expect(w.last()).toMatchObject({ type: "lah.hello", active: null });
  });

  test("a page that was away says hello again and tells its open views to read themselves again", () => {
    const w = wire();
    let again = 0;
    w.client.onBack(() => {
      again += 1;
    });
    w.client.resync();
    expect(again).toBe(1);
    expect(w.sent.filter((m) => m.type === "lah.hello").length).toBe(1);
  });
});
