// Runtime → Connections and the pickers, worked out without a browser: what a save sends (a key and
// a header's value in that one request alone, never in a draft, and taken out of any words that
// come back), what a change of provider or address takes away, what the form shows for a provider,
// what an agent on a connection that is gone runs on, what removing one asks, which of Lumiverse's
// connections can be copied and as what, and what a sign-in says.

import { describe, expect, test } from "bun:test";
import { PROVIDERS } from "../../dev/preview/mock/connections";
import {
  agentsOn,
  beforeWords,
  canCall,
  type ConnectionDraft,
  copyRows,
  copyTicked,
  draftOf,
  draftProblems,
  formShape,
  goneWords,
  type KnownConnections,
  keysWanted,
  listedRuntime,
  lossWords,
  modelsAsk,
  modelsConnection,
  moves,
  newDraft,
  NO_SECRETS,
  noneWords,
  openable,
  pickerLabel,
  removeAsk,
  saveBody,
  secretsOf,
  signInLine,
  signsWords,
  testWords,
  unlistedWords,
  wantedOn,
  wantWords,
  whoseWords,
  withAuth,
  withoutSecrets,
  withProvider,
} from "../../src/extension/frontend/connections-model";
import { addConnectionWords } from "../../src/shared/connections";
import type { ConnectionsView, LumiverseConnection, RuntimeConnection } from "../../src/shared/ui";

const KEY = "sk-ant-api03-preview-only-9f2c";

const claude: RuntimeConnection = { id: "rc-claude", name: "Claude", provider: "anthropic", auth: "key", model: "claude-sonnet-4-5", default: true, key: { set: true, last4: "9f2c" } };
const local: RuntimeConnection = { id: "rc-local", name: "Local llama", provider: "openai-compatible", auth: "none", baseUrl: "http://127.0.0.1:8080/v1", api: "openai-completions", model: "llama-local", default: false, key: null };
const proxy: RuntimeConnection = { id: "rc-proxy", name: "Proxy", provider: "openai-compatible", auth: "key", baseUrl: "https://proxy.example.com/v1", default: false, key: { set: true, last4: null }, headers: [{ name: "X-Proxy-Key", set: true }] };

const view = (connections: RuntimeConnection[] = [claude, local], chosen: string | null = "rc-claude"): ConnectionsView => ({ connections: connections.map((c) => ({ ...c, default: c.id === chosen })), default: chosen, providers: PROVIDERS, relay: { id: "relay-1", name: "mara" } });
const known = (over: Partial<KnownConnections> = {}): KnownConnections => ({ view: view(), linked: true, runtimes: 1, chat: false, failed: null, reading: false, ...over });
const shapeOf = (draft: ConnectionDraft) => formShape(draft, view());

describe("a key typed into the form", () => {
  test("goes in the save request once, trimmed, and is in no draft", () => {
    const draft = newDraft(view());
    const before = JSON.stringify(draft);
    const body = saveBody(draft, shapeOf(draft), { key: `  ${KEY}\n`, headers: new Map() });
    expect(body.key).toBe(KEY);
    expect(JSON.stringify(body).split(KEY).length - 1).toBe(1);
    // The draft the page keeps has no place for a key, and saving puts none in it.
    expect(JSON.stringify(draft)).toBe(before);
    expect(JSON.stringify(draft)).not.toContain(KEY);
    expect(Object.keys(draft)).not.toContain("key");
  });

  test("left empty keeps the stored key; taking it away sends null; a connection that signs no other way than its account or nothing sends none", () => {
    const kept = draftOf(claude);
    expect("key" in saveBody(kept, shapeOf(kept), NO_SECRETS)).toBe(false);
    const cleared = { ...kept, clearKey: true };
    expect(saveBody(cleared, shapeOf(cleared), NO_SECRETS).key).toBeNull();
    // A key typed for a connection set to sign in, or to need none, never leaves the page.
    for (const auth of ["signin", "none"] as const) {
      const other = withAuth(draftOf(auth === "signin" ? claude : local), auth);
      const body = saveBody(other, shapeOf(other), { key: KEY, headers: new Map() });
      expect("key" in body).toBe(false);
      expect(JSON.stringify(body)).not.toContain(KEY);
    }
  });

  test("is taken out of whatever words come back, as are the headers' values", () => {
    const typed = { key: KEY, headers: new Map([["X-Proxy-Key", "proxy-secret-value"]]) };
    const words = withoutSecrets(`401: invalid x-api-key ${KEY} (authentication_error); header proxy-secret-value refused`, secretsOf(typed));
    expect(words).not.toContain(KEY);
    expect(words).not.toContain("proxy-secret-value");
    expect(words).toContain("401: invalid x-api-key");
    // Nothing typed, nothing taken out; and a stray few characters are no secret to hunt for.
    expect(withoutSecrets("A key can't be empty.", secretsOf({ key: "", headers: new Map() }))).toBe("A key can't be empty.");
    expect(withoutSecrets("abc abc", ["abc"])).toBe("abc abc");
  });

  test("a header's value goes once, a header kept keeps its stored value, one left out goes, and headers left alone aren't sent", () => {
    const draft: ConnectionDraft = { ...draftOf(proxy), headers: [{ name: "X-Proxy-Key", known: true, set: true }, { name: "X-Org", known: false, set: false }] };
    const body = saveBody(draft, shapeOf(draft), { key: "", headers: new Map([["X-Org", "harbour"]]) });
    expect(body.connection.headers).toEqual({ "X-Proxy-Key": null, "X-Org": "harbour" });
    const none: ConnectionDraft = { ...draft, headers: [] };
    expect(saveBody(none, shapeOf(none), NO_SECRETS).connection.headers).toBeNull();
    const untouched = draftOf(proxy);
    expect("headers" in saveBody(untouched, shapeOf(untouched), NO_SECRETS).connection).toBe(false);
  });
});

describe("what a save sends and what it takes away", () => {
  test("a connection whole: its address and API where its provider takes them, nothing it doesn't", () => {
    const draft: ConnectionDraft = { ...draftOf(local), name: "  Local llama  ", model: " llama-local " };
    expect(saveBody(draft, shapeOf(draft), NO_SECRETS)).toEqual({ connection: { id: "rc-local", name: "Local llama", provider: "openai-compatible", auth: "none", baseUrl: "http://127.0.0.1:8080/v1", api: "openai-completions", model: "llama-local", effort: null } });
    // A sign-in calls the provider's own address, and a provider with one API is asked for none.
    const signin = withAuth({ ...draftOf(claude), baseUrl: "https://proxy.example.com" }, "signin");
    expect(saveBody(signin, shapeOf(signin), NO_SECRETS).connection).toMatchObject({ auth: "signin", baseUrl: null, api: null });
  });

  test("a new provider or a new address's origin forgets the key unless one is typed with it, and every header value it doesn't give again; the form says so first", () => {
    const none = { key: false, headers: new Set<string>() };
    const moved = withProvider(draftOf(claude), view(), "openai");
    expect(lossWords(claude, moved, none)).toContain("its key");
    expect(lossWords(claude, moved, { ...none, key: true })).toBeNull();
    const elsewhere = { ...draftOf(proxy), baseUrl: "https://other.example.com/v1" };
    expect(lossWords(proxy, elsewhere, none)).toContain("its key and the value of X-Proxy-Key");
    // A key typed with the change keeps the connection signed; a header's value is the old server's, and goes unless it is typed again too.
    expect(lossWords(proxy, elsewhere, { ...none, key: true })).toContain("forgets the value of X-Proxy-Key");
    const retyped: ConnectionDraft = { ...elsewhere, headers: [{ name: "X-Proxy-Key", known: true, set: true }] };
    expect(lossWords(proxy, retyped, { key: true, headers: new Set(["X-Proxy-Key"]) })).toBeNull();
    // A header taken away with the change is no loss to warn of.
    expect(lossWords(proxy, { ...elsewhere, headers: [] }, { ...none, key: true })).toBeNull();
    // The same server under another path is the same origin: nothing goes.
    expect(moves(proxy, { ...draftOf(proxy), baseUrl: "https://proxy.example.com/v2" })).toBe(false);
    expect(lossWords(proxy, { ...draftOf(proxy), baseUrl: "https://proxy.example.com/v2" }, none)).toBeNull();
    // A connection that stops signing with a key forgets it, typed or not.
    expect(lossWords(claude, withAuth(draftOf(claude), "signin"), { ...none, key: true })).toContain("stops signing with a key");
    expect(lossWords(null, newDraft(view()), none)).toBeNull();
  });
});

describe("the form for a provider", () => {
  test("a new connection starts on the first provider, named after it; another provider keeps what it takes and renames a draft still named after the last", () => {
    const fresh = newDraft(view());
    expect(fresh).toMatchObject({ id: null, provider: "anthropic", auth: "key", name: "Anthropic" });
    const moved = withProvider({ ...fresh, auth: "signin", model: "claude-sonnet-4-5" }, view(), "deepseek");
    expect(moved).toMatchObject({ provider: "deepseek", name: "DeepSeek", auth: "key", model: "" });
    expect(withProvider({ ...fresh, name: "Work account" }, view(), "openai").name).toBe("Work account");
    // A provider the runtime doesn't offer changes nothing.
    expect(withProvider(fresh, view(), "bedrock")).toBe(fresh);
  });

  test("an address is needed for a compatible server, may be given to a named provider (a proxy), and isn't taken by a sign-in", () => {
    expect(shapeOf(withProvider(newDraft(view()), view(), "openai-compatible"))).toMatchObject({ address: "needed", apis: ["openai-completions", "openai-responses"], signIn: null });
    expect(shapeOf(newDraft(view()))).toMatchObject({ address: "optional", apis: null, auths: ["key", "signin"] });
    expect(shapeOf(withAuth(newDraft(view()), "signin"))).toMatchObject({ address: "none", signIn: "anthropic" });
  });

  test("what is wrong before it is sent: no name, no address where one is needed, an address that isn't one or holds a password, a header with no name, twice, or new without a value", () => {
    const compatible = withProvider(newDraft(view()), view(), "openai-compatible");
    const check = (draft: ConnectionDraft, valued: string[] = []) => draftProblems(draft, shapeOf(draft), new Set(valued));
    expect(check({ ...compatible, name: " " })).toMatchObject({ name: "Give the connection a name.", address: "Give the server's address." });
    expect(check({ ...compatible, baseUrl: "ftp://files.example.com" }).address).toBe("Give an http or https address.");
    expect(check({ ...compatible, baseUrl: "nonsense" }).address).toContain("isn't an address");
    expect(check({ ...compatible, baseUrl: "https://user:secret@proxy.example.com/v1" }).address).toContain("Leave the name and password out");
    expect(check({ ...compatible, baseUrl: "http://127.0.0.1:8080/v1" })).toEqual({ name: null, address: null, headers: null });
    expect(check({ ...compatible, baseUrl: "http://127.0.0.1:8080/v1", headers: [{ name: "", known: false, set: false }] }).headers).toBe("Give each header a name.");
    expect(check({ ...compatible, baseUrl: "http://127.0.0.1:8080/v1", headers: [{ name: "X-A", known: true, set: true }, { name: "x-a", known: false, set: false }] }, ["x-a"]).headers).toBe("Each header may be named once.");
    expect(check({ ...compatible, baseUrl: "http://127.0.0.1:8080/v1", headers: [{ name: "X-Org", known: false, set: false }] }).headers).toBe("Type a value for X-Org.");
    expect(check({ ...compatible, baseUrl: "http://127.0.0.1:8080/v1", headers: [{ name: "X-Org", known: false, set: false }] }, ["X-Org"]).headers).toBeNull();
  });

  test("the models offered come from the connection as saved, else from the provider's own list; a new compatible server has none to offer yet", () => {
    const kept = draftOf(local);
    expect(modelsAsk(kept, local, shapeOf(kept))).toEqual({ connectionId: "rc-local" });
    const readdressed = { ...kept, baseUrl: "http://127.0.0.1:9090/v1" };
    expect(modelsAsk(readdressed, local, shapeOf(readdressed))).toBeNull();
    const fresh = newDraft(view());
    expect(modelsAsk(fresh, null, shapeOf(fresh))).toEqual({ provider: "anthropic" });
  });
});

describe("the list and the pickers", () => {
  test("a connection says how it signs: its key's last characters, a sign-in, or none, and whether it can call", () => {
    expect(signsWords(claude)).toBe("Key ending in 9f2c");
    expect(signsWords({ ...claude, key: { set: false, last4: null } })).toContain("No key yet");
    expect(signsWords({ ...claude, auth: "signin", key: null, signedIn: false })).toBe("Not signed in: sign in with your Claude account");
    expect(signsWords(local)).toContain("No key");
    expect(canCall({ ...claude, key: { set: false, last4: null } })).toBe(false);
    expect(canCall({ ...claude, auth: "signin", key: null, signedIn: true })).toBe(true);
    expect(pickerLabel(claude, view())).toBe("Claude · Anthropic · claude-sonnet-4-5");
  });

  test("an agent on a connection that is gone runs on the default, which the picker names, and its models are the default's", () => {
    expect(goneWords("conn-from-lumiverse", known())).toContain("runs on the default connection, Claude");
    expect(goneWords("conn-from-lumiverse", known({ view: view([claude, local], null) }))).toContain("no default connection");
    expect(goneWords("rc-local", known())).toBeNull();
    expect(goneWords(null, known())).toBeNull();
    // While the runtime's list isn't known, nothing is said of an id.
    expect(goneWords("conn-from-lumiverse", known({ view: null }))).toBeNull();
    expect(modelsConnection("conn-from-lumiverse", known())).toBeNull();
    expect(modelsConnection("rc-local", known())).toBe("rc-local");
    expect(modelsConnection("conn-from-lumiverse", known({ view: null }))).toBe("conn-from-lumiverse");
    expect(noneWords("Your default connection", known())).toBe("Your default connection (now Claude)");
  });

  test("a picker says why it lists nothing, and whose connections it lists where several runtimes are linked", () => {
    expect(unlistedWords(known({ view: null, linked: false }))).toContain("once a runtime is linked");
    expect(unlistedWords(known({ view: null, failed: "The runtime didn't answer." }))).toContain("The runtime didn't answer.");
    expect(unlistedWords(known())).toBeNull();
    expect(whoseWords(known())).toBeNull();
    expect(whoseWords(known({ runtimes: 2 }))).toContain("These are the connections of mara, the runtime heard from last");
    expect(whoseWords(known({ runtimes: 2, chat: true }))).toContain("These are the connections of mara, the runtime that plays the open chat");
    expect(whoseWords(known({ runtimes: 2, chat: true, shown: true }))).toContain("These are the connections of mara, the runtime that plays this chat");
  });

  test("a page about a chat lists the connections of the runtime that plays the chat it shows; a page about no chat, of the one that plays the open chat; else of the runtime heard from last", () => {
    const chats = [
      { chatId: "chat-mara", runtime: { id: "relay-laptop", name: "laptop" } },
      { chatId: "chat-joss", runtime: { id: "relay-desk", name: "desk" } },
      // Switched off, or played by a runtime that isn't linked now: no runtime plays it.
      { chatId: "chat-ilse" },
    ];
    // Live showing a chat other than the one open in Lumiverse: that chat's runtime, not the open chat's.
    expect(listedRuntime(chats, "chat-joss", "chat-mara")).toEqual({ relay: "relay-desk", shown: true });
    expect(listedRuntime(chats, "chat-mara", "chat-joss")).toEqual({ relay: "relay-laptop", shown: true });
    // Settings and Agents are about no chat: the open chat's runtime.
    expect(listedRuntime(chats, undefined, "chat-joss")).toEqual({ relay: "relay-desk", shown: false });
    // No runtime plays the chat, the page shows none, or none is open: the runtime heard from last (null).
    expect(listedRuntime(chats, "chat-ilse", "chat-mara")).toEqual({ relay: null, shown: false });
    expect(listedRuntime(chats, null, "chat-mara")).toEqual({ relay: null, shown: false });
    expect(listedRuntime(chats, undefined, null)).toEqual({ relay: null, shown: false });
    expect(listedRuntime(chats, "chat-gone", null)).toEqual({ relay: null, shown: false });
  });

  test("an agent whose connection the chat's runtime doesn't have runs on that runtime's default, and the page says whose list it is where several runtimes are linked", () => {
    // The desk runtime has only its own connection: an id of the laptop's is gone there.
    const desk: ConnectionsView = { ...view([{ ...local, id: "rc-desk", name: "Desk llama" }], "rc-desk"), relay: { id: "relay-desk", name: "desk" } };
    const onDesk = known({ view: desk, runtimes: 2, chat: true, shown: true });
    expect(goneWords("rc-claude", onDesk)).toBe("None of the runtime's connections has this id now, so it runs on the default connection, Desk llama. Pick one here to choose again.");
    expect(modelsConnection("rc-claude", onDesk)).toBeNull();
    expect(wantedOn(onDesk)).toBe("This is about desk, the runtime that plays this chat: each runtime keeps connections of its own.");
    expect(wantedOn({ ...onDesk, runtimes: 1 })).toBeNull();
    expect(wantedOn(known({ runtimes: 2 }))).toBe("This is about mara, the runtime heard from last: each runtime keeps connections of its own.");
  });

  test("Home, Live and the section say when the agents have nothing to run on", () => {
    expect(wantWords(view([], null))?.title).toBe("No connection yet");
    // The same words as a reply refused for want of one, the section's empty list and a picker with nothing to pick: add one, or copy the ones used in Lumiverse.
    expect(wantWords(view([], null))?.text).toEndWith(addConnectionWords());
    expect(addConnectionWords()).toContain("Copy from Lumiverse");
    expect(wantWords(view([claude, local], null))?.title).toBe("No default connection");
    expect(wantWords(view())).toBeNull();
  });
});

describe("removing a connection", () => {
  const settings = {
    schema: { type: "object", properties: { core: { type: "object", properties: { agents: { type: "object", properties: { main: { title: "Main agent", type: "object" }, archivist: { title: "Archivist", type: "object" } } } } } } },
    values: { core: { agents: { main: { connectionId: "rc-local" }, archivist: { connectionId: "rc-local" }, writer: { connectionId: null } } } },
  };

  test("says which agents run on it, where they go, and that its key goes with it", () => {
    expect(agentsOn("rc-local", settings)).toEqual(["Main agent", "Archivist"]);
    const ask = removeAsk(local, view(), settings);
    expect(ask.title).toBe("Remove Local llama?");
    expect(ask.message).toContain("Main agent and Archivist run on it now, and would run on Claude, the default,");
    expect(removeAsk({ ...claude, default: true }, view(), settings).message).toContain("It is the default");
    expect(removeAsk({ ...claude, default: true }, view(), settings).message).toContain("Its key is forgotten with it.");
    expect(removeAsk({ ...claude, default: true }, view([claude]), null).message).toContain("It is your only connection");
    expect(removeAsk(proxy, view([claude, proxy]), settings).message).toContain("No agent runs on it now.");
  });
});

describe("copying Lumiverse's connections", () => {
  const lumiverse = (provider: string, baseUrl: string | null, id = `conn-${provider}`): LumiverseConnection => ({ id, name: provider, provider, baseUrl, model: "m" });

  test("each becomes the runtime's under its own id and without its key: the same provider where the runtime offers it, else an OpenAI-compatible server at its address", () => {
    const rows = copyRows([lumiverse("custom", "http://127.0.0.1:7861/v1", "conn-loopback"), lumiverse("deepseek", "https://api.deepseek.com/v1/"), lumiverse("anthropic", "https://proxy.example.com/anthropic"), lumiverse("custom", "http://127.0.0.1:8080/v1"), lumiverse("nanogpt", null), lumiverse("mystery", "https://mystery.example.com/v1")], new Set(["conn-loopback"]), view());
    // The loopback points at the runtime itself: it is never offered.
    expect(rows.map((r) => r.id)).toEqual(["conn-deepseek", "conn-anthropic", "conn-custom", "conn-nanogpt", "conn-mystery"]);
    expect(rows.map((r) => r.input)).toEqual([
      // Lumiverse's own address for the provider is no address of the copy's.
      { id: "conn-deepseek", name: "deepseek", provider: "deepseek", auth: "key", baseUrl: null, api: null, model: "m", effort: null },
      { id: "conn-anthropic", name: "anthropic", provider: "anthropic", auth: "key", baseUrl: "https://proxy.example.com/anthropic", api: null, model: "m", effort: null },
      { id: "conn-custom", name: "custom", provider: "openai-compatible", auth: "key", baseUrl: "http://127.0.0.1:8080/v1", api: null, model: "m", effort: null },
      { id: "conn-nanogpt", name: "nanogpt", provider: "openai-compatible", auth: "key", baseUrl: "https://nano-gpt.com/api/v1", api: null, model: "m", effort: null },
      { id: "conn-mystery", name: "mystery", provider: "openai-compatible", auth: "key", baseUrl: "https://mystery.example.com/v1", api: null, model: "m", effort: null },
    ]);
    expect(JSON.stringify(rows)).not.toContain("key\":\"");
  });

  test("what can't be copied says why, one the runtime has already is left as it is, and the rest start ticked", () => {
    const rows = copyRows([lumiverse("custom", null), lumiverse("bedrock", null), lumiverse("mystery", null), lumiverse("anthropic", null, "rc-claude"), lumiverse("groq", null)], new Set(), view());
    expect(rows.map((r) => [r.id, r.input === null, r.there])).toEqual([
      ["conn-custom", true, false],
      ["conn-bedrock", true, false],
      ["conn-mystery", true, false],
      ["rc-claude", false, true],
      ["conn-groq", false, false],
    ]);
    expect(rows[0]?.why).toContain("names no address");
    expect(rows[1]?.why).toBe("The runtime offers no Amazon Bedrock connection.");
    expect(rows[2]?.why).toContain('doesn\'t know the provider "mystery"');
    expect(rows[3]?.why).toBe("The runtime has it already.");
    expect([...copyTicked(rows)]).toEqual(["conn-groq"]);
  });

  test("the keys asked for afterwards are those of the copies that sign with one and have none, in the order copied", () => {
    const copied = view([claude, { ...claude, id: "conn-b", key: { set: false, last4: null } }, { ...local, id: "conn-c" }, { ...claude, id: "conn-d", key: { set: false, last4: null } }]);
    expect(keysWanted(copied, ["conn-d", "conn-c", "conn-b", "conn-gone"])).toEqual(["conn-d", "conn-b"]);
  });
});

describe("signing in and testing", () => {
  test("before it starts, OpenAI's says its address won't load away from the runtime's machine and is to be pasted back; Anthropic's leaves the runtime to say how requests are sent", () => {
    expect(beforeWords("openai")).toContain("port 1455");
    expect(beforeWords("openai")).toContain("paste it here");
    expect(beforeWords("anthropic")).toContain("the runtime says how requests on this sign-in are sent");
  });

  test("how a sign-in stands, until when its token holds, and only an https address is opened", () => {
    const at = Date.UTC(2026, 10, 12, 18, 0, 0);
    expect(signInLine({ provider: "anthropic", signedIn: true, until: at, flow: null, ended: null })).toContain("renews it by itself");
    expect(signInLine({ provider: "openai", signedIn: false, until: null, flow: null, ended: null })).toBe("Not signed in to OpenAI.");
    expect(openable("https://claude.ai/oauth/authorize?code=true")).toBe(true);
    expect(openable("javascript:alert(1)")).toBe(false);
    expect(openable("http://localhost:1455/auth/callback")).toBe(false);
  });

  test("a test says how long it took and which model answered, or the provider's words", () => {
    expect(testWords({ ok: true, ms: 840, model: "claude-sonnet-4-5" })).toEqual({ ok: true, text: "It answered in 840 ms, as claude-sonnet-4-5." });
    expect(testWords({ ok: false, ms: 1200, error: "401: invalid x-api-key (authentication_error)" })).toEqual({ ok: false, text: "It failed after 1.2 s: 401: invalid x-api-key (authentication_error)" });
  });
});
