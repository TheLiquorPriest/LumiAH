// The runtime's agents run on the runtime's own connections (docs/RUNTIME.md, "Connections"): each
// agent on the connection, model and effort its settings name (or the extension LumiAH is built
// into chooses), else on the runtime's default; one whose connection is gone runs on the default;
// with no connection at all a reply is refused before anything of it starts. A connection's key
// crosses the link once, on its way to the runtime, and nothing that crosses, is logged or is stored
// outside the runtime's secrets holds any of it. The pages keep a runtime's connections and
// sign-ins through the twelve requests of the page contract, each answered as it is typed, and only
// for the user's own runtimes. Each test runs the real runtime, its model layer and the real backend
// over the fake Lumiverse, with scripted providers behind the layer.

import { afterEach, describe, expect, test } from "bun:test";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { goneWords } from "../../src/extension/frontend/connections-model";
import type { LinkRequests } from "../../src/link/contract";
import type { Runtime } from "../../src/runtime/runtime";
import { addConnectionWords } from "../../src/shared/connections";
import type { ConnectionsView } from "../../src/shared/ui";
import { toolCall } from "../support/fake-host";
import { FakeLumiverse, type FakePage, UiFailure } from "../support/fake-lumiverse";
import { MAIN, type SeedConnection } from "../support/models";
import { BUILD, FAST, type Rig, rig, runtimeFrom, until } from "../support/rig";

let r: Rig | null = null;
const others: Runtime[] = [];
let realFetch: typeof globalThis.fetch | null = null;
afterEach(async () => {
  if (realFetch !== null) globalThis.fetch = realFetch;
  realFetch = null;
  for (const runtime of others.splice(0)) {
    runtime.shutdown();
    await runtime.close();
  }
  await r?.close();
  r = null;
});

const SECOND: SeedConnection = { id: "conn-second", name: "Second", provider: "anthropic", model: "model-second", key: "sk-ant-made-up-second-0123456789abcdef" };

/** Each agent's setting of `key` set to `value`. */
const agentSetting = (role: string, key: string, value: string | null) => ({ path: ["core", "agents", role, key], value });

/** The connection each model call named, in order; null: the runtime's default. */
const named = (it: Rig): (string | null)[] => it.host.calls.map((c) => (c.kind === "call" ? c.request.connectionId : "passed"));

/** A main agent that briefs the writer at once, and the writer's reply. */
const BRIEFED = [{ toolCalls: [toolCall("write_reply", { brief: "Okoro keeps the light." })] }, "Okoro keeps it now."];

/** What a page's request was refused with. */
async function refusal(asked: Promise<unknown>): Promise<{ code: string; message: string }> {
  const error = await asked.then(
    () => null,
    (e: unknown) => e,
  );
  if (!(error instanceof UiFailure)) throw new Error("the request was answered, not refused");
  return { code: error.error.code, message: error.error.message };
}

describe("agents on the runtime's connections", () => {
  test("two agents of one turn each run on the connection, model and effort their settings name, else on the runtime's default: as the layer was asked, and as each provider was sent", async () => {
    const it = (r = await rig({ connections: [MAIN, SECOND] }));
    const chatId = await it.setUp();
    await it.page.request("lah.settings.set", { set: [agentSetting("main", "model", "model-main-mini"), agentSetting("main", "effort", "low"), agentSetting("writer", "connectionId", SECOND.id), agentSetting("writer", "model", "model-second-large"), agentSetting("writer", "effort", "high")], reset: [] });
    it.host.script = BRIEFED;

    const out = await it.generate(chatId);
    expect(out.error).toBeNull();
    expect(out.content).toBe("Okoro keeps it now.");
    // The main agent names no connection, so it ran on the default, with its own model and effort; the writer on its own connection, its model and effort as set.
    expect(it.host.calls.map((c) => (c.kind === "call" ? [c.request.connectionId, c.request.model, c.request.effort] : null))).toEqual([
      [null, "model-main-mini", "low"],
      [SECOND.id, "model-second-large", "high"],
    ]);
    // Each provider was sent its call on that connection's key.
    expect(it.host.providerCalls.map((c) => [c.provider, c.model, c.reasoning, c.key])).toEqual([
      [MAIN.provider, "model-main-mini", "low", MAIN.key],
      [SECOND.provider, "model-second-large", "high", SECOND.key],
    ]);
    // Each agent's calls went in a session of its own, which ended with the run.
    const sessions = it.host.providerCalls.map((c) => c.sessionId);
    expect(new Set(sessions).size).toBe(2);
    await until(() => sessions.every((s) => s !== null && it.host.endedSessions.includes(s)), "each agent's session ended");
  });

  test("the extension LumiAH is built into chooses an agent's connection, model and effort over the agent's own settings", async () => {
    const asked: string[] = [];
    const extension = {
      name: "Harbour Play",
      agentModel: async (ask: { definition: string }) => {
        asked.push(ask.definition);
        return ask.definition === "writer" ? { connectionId: SECOND.id, model: "model-second-chosen", effort: "max" as const } : null;
      },
    };
    const it = (r = await rig({ connections: [MAIN, SECOND], backend: { extension } }));
    const chatId = await it.setUp();
    await it.page.request("lah.settings.set", { set: [agentSetting("writer", "connectionId", MAIN.id), agentSetting("writer", "model", "model-main-writer"), agentSetting("writer", "effort", "low")], reset: [] });
    it.host.script = BRIEFED;

    const out = await it.generate(chatId);
    expect(out.error).toBeNull();
    expect(asked).toEqual(["main", "writer"]);
    // The main agent was left to its settings; the writer ran where the extension said, whatever its settings named.
    expect(it.host.calls.map((c) => (c.kind === "call" ? [c.request.connectionId, c.request.model, c.request.effort] : null))).toEqual([
      [null, null, "inherit"],
      [SECOND.id, "model-second-chosen", "max"],
    ]);
    expect(it.host.providerCalls[1]).toMatchObject({ provider: SECOND.provider, model: "model-second-chosen", key: SECOND.key });
  });

  test("one whose connection is gone runs on the runtime's default, and the page's picker says so", async () => {
    const it = (r = await rig({ connections: [MAIN] }));
    const chatId = await it.setUp();
    await it.page.request("lah.settings.set", { set: [agentSetting("main", "connectionId", "conn-gone")], reset: [] });
    it.host.script = BRIEFED;

    const out = await it.generate(chatId);
    expect(out.error).toBeNull();
    // The main agent's call named the default it ran on instead; the writer names none, so it ran there too.
    expect(named(it)).toEqual([MAIN.id, null]);
    expect(it.host.providerCalls.map((c) => [c.model, c.key])).toEqual([
      ["model-main", MAIN.key],
      ["model-main", MAIN.key],
    ]);
    // The picker that holds the gone id says where the agent runs now, from the runtime's own list.
    const view = await it.page.request("lah.connections.list", {});
    expect(goneWords("conn-gone", { view, linked: true, runtimes: 1, failed: null, reading: false, chat: false })).toBe("None of the runtime's connections has this id now, so it runs on the default connection, Main. Pick one here to choose again.");
  });

  test("with no connection at all, a reply is refused in plain words before anything of it starts, which say how to add one or copy the ones used in Lumiverse", async () => {
    const it = (r = await rig({ connections: [] }));
    const chatId = await it.setUp();
    it.host.script = ["Never asked."];

    const out = await it.generate(chatId);
    expect(out.error?.message ?? "").toContain("has no connection to call a model on");
    expect(out.error?.message ?? "").toContain(addConnectionWords("LumiAH's Runtime page, under Connections"));
    expect(it.host.calls).toHaveLength(0);
    expect(it.host.providerCalls).toHaveLength(0);
  });
});

/** Every file under `dir`, by its path, with its text. */
function filesUnder(dir: string): [string, string][] {
  return readdirSync(dir).flatMap((name): [string, string][] => {
    const path = join(dir, name);
    return statSync(path).isDirectory() ? filesUnder(path) : [[path, readFileSync(path, "utf8")]];
  });
}

describe("a connection's key", () => {
  test("never comes back to a page: the list names each connection and the runtime it is on", async () => {
    const it = (r = await rig({ connections: [MAIN, SECOND] }));
    await it.setUp();
    const listed = await it.page.request("lah.connections.list", {});
    expect(listed.connections.map((c) => c.id).sort()).toEqual([MAIN.id, SECOND.id].sort());
    expect(listed.relay).toEqual({ id: it.registration.relay, name: "mara" });
    const words = JSON.stringify(listed);
    for (const key of [MAIN.key, SECOND.key]) expect(words).not.toContain(key);
  });

  test("crosses the link once, in the request that takes it to the runtime: nothing else that crosses, nothing logged and nothing stored outside the runtime's secrets holds any of it", async () => {
    // A key of letters, digits and dashes, mixed case, as a provider gives one.
    const KEY = "sk-Qv7mTzR4wXhK9pLc2NbYdF6sJeGu8A";
    const it = (r = await rig({ connections: [] }));
    const chatId = await it.setUp();

    // Saved with its key, listed, tested, and made the default the agents run on.
    const saved = await it.page.request("lah.connections.save", { connection: { name: "Harbour", provider: "openai", auth: "key", model: "model-harbour" }, key: KEY });
    expect(saved.saved.key).toEqual({ set: true, last4: KEY.slice(-4) });
    expect((await it.page.request("lah.connections.list", {})).default).toBe(saved.saved.id);
    expect((await it.page.request("lah.connections.test", { id: saved.saved.id })).test).toMatchObject({ ok: true, model: "model-harbour" });
    // Used for a turn: every call went to the provider signed with it.
    it.host.script = BRIEFED;
    const out = await it.generate(chatId);
    expect(out).toMatchObject({ error: null, content: "Okoro keeps it now." });
    expect(it.host.providerCalls.map((c) => c.key)).toEqual([KEY, KEY, KEY]);
    await it.mirrored();

    // Any part of it longer than the last four characters a page is shown.
    const parts = Array.from({ length: KEY.length - 4 }, (_, i) => KEY.slice(i, i + 5));
    const holds = (text: string): boolean => parts.some((part) => text.includes(part));
    // On Lumiverse's socket, either way: the one frame is the save, on its way from the extension to the runtime.
    const carrying = it.lumiverse.frames.filter((f) => holds(f.text));
    expect(carrying.map((f) => f.to)).toEqual(["runtime"]);
    expect(JSON.parse(carrying[0]?.text ?? "{}")).toMatchObject({ event: "SPINDLE_FRONTEND_MSG", payload: { data: { type: "ask", op: "connections.save" } } });
    // Nothing the backend sent the page, and nothing the page holds.
    expect(it.host.sent.filter((s) => s.session === it.page.session && holds(JSON.stringify(s.message)))).toEqual([]);
    expect(it.page.pushes.filter((p) => holds(JSON.stringify(p)))).toEqual([]);
    // Nothing either end logged.
    expect(it.logs.filter(holds)).toEqual([]);
    expect(it.host.logs.filter((l) => holds(l.message))).toEqual([]);
    // Nothing in the extension's storage: its settings, the turn's trace, its transcripts, its blobs.
    expect([...it.host.files].filter(([, text]) => holds(text)).map(([path]) => path)).toEqual([]);
    // On the runtime's disk, its secrets file alone holds it.
    expect(filesUnder(it.dir).filter(([, text]) => holds(text)).map(([path]) => path)).toEqual([join(it.dir, "secrets.json")]);
  });
});

/** Joss: a second user of the same Lumiverse, with a runtime of his own and a connection on it. */
async function joss(it: Rig): Promise<{ page: FakePage; relay: string }> {
  const lumiverse = new FakeLumiverse(it.host, "user-joss");
  const registered = await lumiverse.raw({ type: "register", name: "joss", build: BUILD, host: "joss-box", listen: "127.0.0.1", port: 7872 });
  if (registered.type !== "result") throw new Error(`register failed: ${registered.message}`);
  const { relay, secret } = registered.body as LinkRequests["register"]["result"];
  const own: SeedConnection = { id: "conn-joss", name: "Joss's own", provider: "openai", model: "model-joss", key: "sk-made-up-joss-0123456789abcdef" };
  const runtime = runtimeFrom({ name: "joss", base: lumiverse.base, extension: lumiverse.host.identifier, listen: "127.0.0.1", port: 7872, relay, secret, session: { username: "joss", token: lumiverse.token, savedAt: 0 }, tuning: FAST }, lumiverse, [], { connections: [own] });
  others.push(runtime);
  await runtime.link.connect();
  return { page: lumiverse.page(), relay };
}

/** Answers pi-ai's request to Anthropic's token endpoint, the one request a sign-in sends, with tokens good for an hour; any other request fails, as nothing here may reach the network. */
function anthropicTokens(): void {
  realFetch = globalThis.fetch;
  const answer = async (input: string | URL | Request): Promise<Response> => {
    const url = input instanceof Request ? input.url : String(input);
    if (url !== "https://platform.claude.com/v1/oauth/token") throw new Error(`no network in a test: ${url}`);
    return Response.json({ access_token: "sk-ant-oat01-made-up-access", refresh_token: "sk-ant-ort01-made-up-refresh", expires_in: 3600 });
  };
  // A stand-in for the global fetch, as pi-ai's sign-in flows call it: the one member they use is the call.
  const scripted = answer as typeof globalThis.fetch;
  globalThis.fetch = scripted;
}

describe("the page requests about a runtime's connections", () => {
  test("list, save (and save under a given id), default, test, models and remove are each answered as the page contract types them, never with a key or a header's value", async () => {
    const it = (r = await rig({ connections: [MAIN] }));
    await it.setUp();
    const relay = { id: it.registration.relay, name: "mara" };
    const ask = { relay: it.registration.relay };

    const listed = await it.page.request("lah.connections.list", ask);
    expect(listed).toEqual({ connections: [{ id: MAIN.id, name: MAIN.name, provider: MAIN.provider, auth: "key", model: MAIN.model, default: true, key: { set: true, last4: MAIN.key.slice(-4) } }], default: MAIN.id, providers: expect.arrayContaining([expect.objectContaining({ id: "anthropic", auth: ["key", "signin"] }), expect.objectContaining({ id: "openai-compatible", needsBaseUrl: true })]), relay });

    // A new one, its key and a header's value with it; a copy of one of Lumiverse's under that one's id.
    const made = await it.page.request("lah.connections.save", { ...ask, connection: { name: "Gateway", provider: "openai-compatible", auth: "key", baseUrl: "https://gateway.example/v1", model: "served-model", headers: { "X-Gateway-Token": "gw-made-up-0123456789" } }, key: "sk-made-up-gateway-0123456789" });
    expect(made.saved).toMatchObject({ name: "Gateway", provider: "openai-compatible", baseUrl: "https://gateway.example/v1", headers: [{ name: "X-Gateway-Token", set: true }], default: false, key: { set: true, last4: "6789" } });
    const copied = await it.page.request("lah.connections.save", { ...ask, connection: { id: "conn-lumiverse-claude", name: "Claude", provider: "anthropic", auth: "key", model: "claude-sonnet-4-5" }, create: true });
    expect(copied.saved).toMatchObject({ id: "conn-lumiverse-claude", key: { set: false, last4: null } });
    expect(copied.view.connections.map((c) => c.id)).toEqual([MAIN.id, made.saved.id, "conn-lumiverse-claude"]);
    expect(copied.view.relay).toEqual(relay);
    const words = JSON.stringify([made, copied]);
    for (const secret of ["sk-made-up-gateway-0123456789", "gw-made-up-0123456789"]) expect(words).not.toContain(secret);

    expect(await it.page.request("lah.connections.default", { ...ask, id: made.saved.id })).toMatchObject({ default: made.saved.id, relay });
    expect((await it.page.request("lah.connections.test", { ...ask, id: MAIN.id })).test).toEqual({ ok: true, ms: expect.any(Number), model: "model-main" });
    // The models of a connection, and of a provider before any connection of it is saved.
    expect((await it.page.request("lah.connections.models", { ...ask, provider: "anthropic" })).models).toEqual(expect.arrayContaining([expect.objectContaining({ id: "claude-sonnet-4-5" })]));
    expect((await it.page.request("lah.connections.models", { ...ask, connectionId: "conn-lumiverse-claude" })).models).toEqual(expect.arrayContaining([expect.objectContaining({ id: "claude-sonnet-4-5" })]));

    // Removing the default leaves none, until another is chosen.
    const removed = await it.page.request("lah.connections.remove", { ...ask, id: made.saved.id });
    expect(removed).toMatchObject({ default: null, relay });
    expect(removed.connections.map((c) => c.id)).toEqual([MAIN.id, "conn-lumiverse-claude"]);
  });

  test("a sign-in is begun, looked at, ended and finished as typed, and its tokens never cross the link", async () => {
    anthropicTokens();
    const it = (r = await rig({ connections: [MAIN] }));
    await it.setUp();
    await it.page.request("lah.connections.save", { connection: { name: "Claude account", provider: "anthropic", auth: "signin", model: "claude-sonnet-4-5" } });

    const first = await it.page.request("lah.signin.start", { provider: "anthropic" });
    expect(new URL(first.url).host).toBe("claude.ai");
    expect(first.note).toContain("the way Claude Code sends them");
    expect(await it.page.request("lah.signin.state", { provider: "anthropic" })).toEqual({ provider: "anthropic", signedIn: false, until: null, flow: first.flow, ended: null });
    expect(await it.page.request("lah.signin.cancel", { flow: first.flow })).toEqual({ cancelled: true });
    const cancelled = await it.page.request("lah.signin.state", { provider: "anthropic" });
    expect(cancelled).toMatchObject({ signedIn: false, until: null, flow: null });
    expect(cancelled.ended).not.toBeNull();

    // Begun again and finished with the code Anthropic's page shows.
    const second = await it.page.request("lah.signin.start", { provider: "anthropic" });
    const finished = await it.page.request("lah.signin.finish", { flow: second.flow, code: `code-from-the-page#${new URL(second.url).searchParams.get("state")}` });
    expect(finished.state).toEqual({ provider: "anthropic", signedIn: true, until: expect.any(Number), flow: null, ended: null });
    expect(finished.state.until).toBeGreaterThan(Date.now());
    expect(finished.view.connections.find((c) => c.provider === "anthropic")?.signedIn).toBe(true);
    const out = await it.page.request("lah.signin.out", { provider: "anthropic" });
    expect(out.state).toEqual({ provider: "anthropic", signedIn: false, until: null, flow: null, ended: null });
    expect(out.view.connections.find((c) => c.provider === "anthropic")?.signedIn).toBe(false);

    expect(it.lumiverse.frames.filter((f) => f.text.includes("made-up-access") || f.text.includes("made-up-refresh"))).toEqual([]);
  });

  test("Copy from Lumiverse lists Lumiverse's connections but the loopbacks, never with a key, and needs no runtime", async () => {
    const it = (r = await rig({ connections: [MAIN] }));
    await it.setUp();
    it.host.addConnection({ id: "conn-proxy", name: "Proxy", provider: "custom", url: "https://proxy.example/v1", model: "served-model" });
    it.runtime.shutdown();
    await it.runtime.close();
    await until(() => !it.backend.relays.isLinked("user-mara", it.registration.relay), "the runtime's link to be gone");

    const { connections } = await it.page.request("lah.connections.lumiverse", {});
    expect(connections).toEqual([
      { id: "conn-main", name: "Main", provider: "openai", baseUrl: "https://models.example/v1", model: "model-main" },
      { id: "conn-proxy", name: "Proxy", provider: "custom", baseUrl: "https://proxy.example/v1", model: "served-model" },
    ]);
  });

  test("reach only the user's own runtimes: another user's page neither reads nor changes this runtime's connections", async () => {
    const it = (r = await rig({ connections: [MAIN] }));
    await it.setUp();
    const other = await joss(it);

    // Each page, naming no runtime, reaches its own user's.
    expect(await it.page.request("lah.connections.list", {})).toMatchObject({ relay: { id: it.registration.relay, name: "mara" }, connections: [{ id: MAIN.id }] });
    const his: ConnectionsView = await other.page.request("lah.connections.list", {});
    expect(his).toMatchObject({ relay: { id: other.relay, name: "joss" }, connections: [{ id: "conn-joss" }] });

    // Naming the other's runtime, each is refused as if it weren't there, and nothing changes in it.
    const theirs = { relay: it.registration.relay };
    for (const asked of [other.page.request("lah.connections.list", theirs), other.page.request("lah.connections.save", { ...theirs, connection: { name: "Taken", provider: "openai", auth: "key" }, key: "sk-made-up-taken-0123456789" }), other.page.request("lah.connections.remove", { ...theirs, id: MAIN.id }), other.page.request("lah.signin.start", { ...theirs, provider: "anthropic" })]) {
      expect(await refusal(asked)).toEqual({ code: "unavailable", message: expect.stringContaining("That runtime isn't linked now.") });
    }
    expect(await refusal(it.page.request("lah.connections.list", { relay: other.relay }))).toMatchObject({ code: "unavailable" });
    expect((await it.page.request("lah.connections.list", {})).connections.map((c) => c.id)).toEqual([MAIN.id]);
  });
});
