// The stand-in backend's connections and sign-ins (dev/preview/mock/connections.ts), which the
// preview and these pages' tests run against: a runtime's book answered for the runtime a request
// names or the one heard from last, refused in words while none is linked; a key sent kept nowhere
// (no answer ever carries it, only that one is set and its last four characters); what a save takes
// away and refuses as the runtime does; and a sign-in from its address to signed in and out.

import { describe, expect, test } from "bun:test";
import { MockBackend, type MockOptions } from "../../dev/preview/mock-backend";
import { sampleSettings } from "../../dev/preview/sections";
import { type Channel, UiClient } from "../../src/extension/frontend/client";
import { inputOf } from "../../src/extension/frontend/connections-model";
import type { UiRequests, UiRequestType } from "../../src/shared/ui";

const T0 = Date.UTC(2026, 10, 12, 9, 0, 0);
const KEY = "sk-preview-never-kept-anywhere-5e6f";

/** A page and the stand-in joined by a channel, on a clock the test turns, with every message that reached the page kept to look into. */
function world(over: Partial<MockOptions> = {}) {
  let now = T0;
  let timers: { at: number; fn: () => void }[] = [];
  let toPage: (payload: unknown) => void = () => {};
  const heard: string[] = [];
  const settled = sampleSettings();
  const backend = new MockBackend(
    (payload) => {
      heard.push(JSON.stringify(payload));
      toPage(structuredClone(payload));
    },
    {
      scenario: "ready",
      turn: "none",
      sections: settled.sections,
      texts: settled.texts,
      delay: 0,
      page: 6,
      fail: new Set(),
      now: () => now,
      later: (fn, ms) => {
        const timer = { at: now + ms, fn };
        timers.push(timer);
        return () => {
          timers = timers.filter((t) => t !== timer);
        };
      },
      ...over,
    },
  );
  const channel: Channel = {
    send: (payload) => backend.receive(structuredClone(payload)),
    subscribe: (handler) => {
      toPage = handler;
      return () => {
        toPage = () => {};
      };
    },
  };
  const client = new UiClient(channel, { timeoutMs: () => 60_000 });
  const pass = async (): Promise<void> => {
    for (;;) {
      for (let i = 0; i < 20; i += 1) await Promise.resolve();
      const due = timers.filter((t) => t.at <= now).sort((a, b) => a.at - b.at)[0];
      if (!due) break;
      timers = timers.filter((t) => t !== due);
      due.fn();
    }
  };
  const ask = async <K extends UiRequestType>(type: K, body: UiRequests[K]["body"]): Promise<UiRequests[K]["result"]> => {
    const asked = client.request(type, body);
    asked.catch(() => {});
    await pass();
    return asked;
  };
  return { backend, ask, heard };
}

const outcome = (p: Promise<unknown>): Promise<unknown> => p.then((value) => value, (e: unknown) => e);

describe("whose connections", () => {
  test("a set-up runtime's are read, named after it, with the providers it offers and its default", async () => {
    const w = world();
    const view = await w.ask("lah.connections.list", {});
    expect(view.relay).toEqual({ id: "relay-1", name: "mara" });
    expect(view.default).toBe("conn-deepseek");
    expect(view.connections.map((c) => [c.id, c.default])).toEqual([
      ["conn-deepseek", true],
      ["rc-claude", false],
      ["rc-local", false],
    ]);
    expect(view.providers.map((p) => p.id)).toContain("openai-compatible");
  });

  test("with no runtime linked each request is refused in words that say what to do; once one links, its book is read, empty at first", async () => {
    const w = world({ scenario: "fresh" });
    expect(await outcome(w.ask("lah.connections.list", {}))).toMatchObject({ code: "unavailable", message: expect.stringContaining("none is linked now") });
    expect(await outcome(w.ask("lah.signin.state", { provider: "openai" }))).toMatchObject({ code: "unavailable" });
    // Lumiverse's own list needs no runtime: the extension answers it itself.
    expect((await w.ask("lah.connections.lumiverse", {})).connections.length).toBeGreaterThan(0);
    w.backend.linkRuntime();
    expect(await w.ask("lah.connections.list", {})).toMatchObject({ connections: [], default: null, relay: { id: "relay-1" } });
  });

  test("a chat switched on and played by a linked runtime names it, so the pickers list that runtime's connections; one switched off, or on its own connection, names none", async () => {
    const w = world();
    const state = await w.ask("lah.hello", {});
    expect(state.chats.find((c) => c.chatId === "chat-mara")?.runtime).toEqual({ id: "relay-1", name: "mara" });
    expect(state.chats.find((c) => c.chatId === "chat-okoro")?.runtime).toBeUndefined();
    expect((await w.ask("lah.chat.set", { chatId: "chat-mara", on: false })).chat.runtime).toBeUndefined();
    expect((await w.ask("lah.chat.set", { chatId: "chat-mara", on: true })).chat.runtime).toEqual({ id: "relay-1", name: "mara" });
  });

  test("a request that names a runtime not linked now is refused", async () => {
    const w = world();
    expect(await outcome(w.ask("lah.connections.list", { relay: "relay-9" }))).toMatchObject({ code: "unavailable", message: expect.stringContaining("isn't linked now") });
  });
});

describe("a key sent", () => {
  test("is kept nowhere: no answer, push or later read carries it, only that one is set and its last four characters", async () => {
    const w = world();
    const saved = await w.ask("lah.connections.save", { relay: "relay-1", connection: { name: "Groq", provider: "groq", auth: "key", model: "llama-3.3-70b-versatile" }, key: ` ${KEY} ` });
    expect(saved.saved.key).toEqual({ set: true, last4: "5e6f" });
    // The first connection a book holds became its default long ago: one more changes nothing of that.
    expect(saved.view.default).toBe("conn-deepseek");
    await w.ask("lah.connections.list", {});
    await w.ask("lah.connections.test", { id: saved.saved.id });
    expect(w.heard.join("\n")).not.toContain(KEY);
    // A key too short to show any of keeps even its end to itself.
    const short = await w.ask("lah.connections.save", { connection: inputOf(saved.saved), key: "short-key" });
    expect(short.saved.key).toEqual({ set: true, last4: null });
  });

  test("a change of provider, or of the address's origin, takes the stored key away unless one comes with it, and unsets every header value it doesn't give again", async () => {
    const w = world();
    const moved = await w.ask("lah.connections.save", { connection: { id: "conn-deepseek", name: "Deepseek", provider: "openrouter", auth: "key" } });
    expect(moved.saved.key).toEqual({ set: false, last4: null });
    const proxy = await w.ask("lah.connections.save", { connection: { name: "Proxy", provider: "openai-compatible", auth: "key", baseUrl: "https://proxy.example.com/v1", headers: { "X-Proxy-Key": "proxy-header-secret" } }, key: KEY });
    expect(proxy.saved.headers).toEqual([{ name: "X-Proxy-Key", set: true }]);
    // A key brought with the change keeps the connection signed; a header's value is the old server's, and goes.
    const keyed = await w.ask("lah.connections.save", { connection: { id: proxy.saved.id, name: "Proxy", provider: "openai-compatible", auth: "key", baseUrl: "https://other.example.com/v1" }, key: KEY });
    expect(keyed.saved).toMatchObject({ key: { set: true, last4: "5e6f" }, headers: [{ name: "X-Proxy-Key", set: false }] });
    const bare = await w.ask("lah.connections.save", { connection: { id: proxy.saved.id, name: "Proxy", provider: "openai-compatible", auth: "key", baseUrl: "https://proxy.example.com/v1" } });
    expect(bare.saved).toMatchObject({ key: { set: false, last4: null }, headers: [{ name: "X-Proxy-Key", set: false }] });
    // Given again with the change, a header's value holds.
    const given = await w.ask("lah.connections.save", { connection: { id: proxy.saved.id, name: "Proxy", provider: "openai-compatible", auth: "key", baseUrl: "https://third.example.com/v1", headers: { "X-Proxy-Key": "proxy-header-secret" } }, key: KEY });
    expect(given.saved).toMatchObject({ key: { set: true }, headers: [{ name: "X-Proxy-Key", set: true }] });
    expect(w.heard.join("\n")).not.toContain("proxy-header-secret");
  });
});

describe("what a save refuses, as the runtime does", () => {
  test("a connection with no name, of a provider not offered, signing a way its provider doesn't, a sign-in with an address, an address with a password, a compatible server with none", async () => {
    const w = world();
    const refused = async (connection: UiRequests["lah.connections.save"]["body"]["connection"]): Promise<unknown> => outcome(w.ask("lah.connections.save", { connection }));
    expect(await refused({ name: " ", provider: "groq", auth: "key" })).toMatchObject({ code: "invalid", message: "Give the connection a name." });
    expect(await refused({ name: "Bedrock", provider: "bedrock", auth: "key" })).toMatchObject({ code: "invalid" });
    expect(await refused({ name: "Groq", provider: "groq", auth: "signin" })).toMatchObject({ code: "invalid", message: "Groq connections can't use a sign-in." });
    expect(await refused({ name: "Claude", provider: "anthropic", auth: "signin", baseUrl: "https://proxy.example.com" })).toMatchObject({ code: "invalid" });
    expect(await refused({ name: "Proxy", provider: "openai-compatible", auth: "key", baseUrl: "https://user:pw@proxy.example.com/v1" })).toMatchObject({ code: "invalid" });
    expect(await refused({ name: "Local", provider: "openai-compatible", auth: "none" })).toMatchObject({ code: "invalid", message: "An OpenAI-compatible connection needs the server's address." });
  });

  test("a copy keeps the id it came with; one the runtime has already is refused, as is a change of one that is gone", async () => {
    const w = world();
    const copy = await w.ask("lah.connections.save", { connection: { id: "conn-nano", name: "NanoGPT", provider: "openai-compatible", auth: "key", baseUrl: "https://nano-gpt.com/api/v1" }, create: true });
    expect(copy.saved).toMatchObject({ id: "conn-nano", key: { set: false } });
    expect(await outcome(w.ask("lah.connections.save", { connection: { id: "conn-nano", name: "NanoGPT", provider: "openai-compatible", auth: "key", baseUrl: "https://nano-gpt.com/api/v1" }, create: true }))).toMatchObject({ code: "conflict" });
    expect(await outcome(w.ask("lah.connections.save", { connection: { id: "conn-gone", name: "Gone", provider: "groq", auth: "key" } }))).toMatchObject({ code: "not_found" });
  });

  test("removing the default leaves none, and the models offered are the provider's own, a server's own, or none for a connection that is gone", async () => {
    const w = world();
    expect(await w.ask("lah.connections.remove", { id: "conn-deepseek" })).toMatchObject({ default: null });
    expect((await w.ask("lah.connections.models", { provider: "anthropic" })).models.map((m) => m.id)).toContain("claude-sonnet-4-5");
    expect((await w.ask("lah.connections.models", { provider: "openai-compatible" })).models).toEqual([]);
    expect((await w.ask("lah.connections.models", { connectionId: "rc-local" })).models).toEqual([{ id: "llama-local", name: "llama-local" }]);
    expect(await outcome(w.ask("lah.connections.models", { connectionId: null }))).toMatchObject({ code: "not_found", message: "The runtime has no default connection." });
  });
});

describe("signing in", () => {
  test("Anthropic: the address and the runtime's note come first; a wrong code is refused in the provider's words and the flow stays open; the right one signs in, which the connections that sign with it show", async () => {
    const w = world();
    await w.ask("lah.signin.out", { provider: "anthropic" });
    expect((await w.ask("lah.connections.list", {})).connections.find((c) => c.id === "rc-claude")?.signedIn).toBe(false);
    const start = await w.ask("lah.signin.start", { provider: "anthropic" });
    expect(start.url.startsWith("https://claude.ai/")).toBe(true);
    expect(start.note).toContain("the way Claude Code sends them");
    expect(await outcome(w.ask("lah.signin.finish", { flow: start.flow, code: "not-a-code" }))).toMatchObject({ code: "invalid", message: expect.stringContaining("invalid_grant") });
    expect((await w.ask("lah.signin.state", { provider: "anthropic" })).flow).toBe(start.flow);
    const done = await w.ask("lah.signin.finish", { flow: start.flow, code: "previewcode0001#state0001" });
    expect(done.state).toMatchObject({ signedIn: true, flow: null, ended: null, until: T0 + 8 * 3_600_000 });
    expect(done.view.connections.find((c) => c.id === "rc-claude")?.signedIn).toBe(true);
  });

  test("OpenAI: a flow that finishes by itself is seen by asking, one cancelled says why it ended, and signing out forgets it", async () => {
    const w = world();
    const start = await w.ask("lah.signin.start", { provider: "openai" });
    expect(decodeURIComponent(start.url)).toContain("http://localhost:1455/");
    w.backend.finishSignIn("openai");
    expect(await w.ask("lah.signin.state", { provider: "openai" })).toMatchObject({ signedIn: true, flow: null });
    const again = await w.ask("lah.signin.start", { provider: "openai" });
    expect(await w.ask("lah.signin.cancel", { flow: again.flow })).toEqual({ cancelled: true });
    expect(await w.ask("lah.signin.state", { provider: "openai" })).toMatchObject({ flow: null, ended: "You cancelled it." });
    expect((await w.ask("lah.signin.out", { provider: "openai" })).state).toMatchObject({ signedIn: false, until: null });
  });
});
