// LumiAH beside an extension that has LumiAH built into its own backend (DESIGN §21), in one
// Lumiverse and on one machine: each is set up by the line its own Runtime page shows, and has a
// runtime, a port, a config, a loopback connection and a key of its own. A reply is answered by the
// extension whose connection the chat generates on and by no other: the other one's interceptor
// sees the generation and leaves it as it is, its runtime is asked nothing, and it keeps nothing.
// A chat one of them answers shows in the other's pages as that one's, with no switch of its own,
// until the user takes it over there.
//
// The core's place in the runtimes is taken by a harness that does of a turn what crosses the link
// (a model call on the user's own connection, a body stored, the reply, a record to anchor): what
// the core makes of a turn is its own tests' to check.

import { afterEach, describe, expect, test } from "bun:test";
import { textHash } from "../../src/core/hash";
import type { AgentUsage } from "../../src/core/ports";
import { type Backend, type BackendOptions, createBackend } from "../../src/extension/backend/backend";
import { lumiah } from "../../src/runtime/cli";
import { configOf, type RuntimeConfig } from "../../src/runtime/config";
import type { Runtime, RuntimeDeps } from "../../src/runtime/runtime";
import { startLine } from "../../src/shared/ui";
import { FakeHost, toolCall } from "../support/fake-host";
import { FakeLumiverse, FakePage, type Generated, UiFailure } from "../support/fake-lumiverse";
import { HOME, machine } from "../support/machine";
import { runtimeFrom, until, USER } from "../support/rig";

const USAGE: AgentUsage = { calls: 1, toolTurns: 0, in: 10, cachedIn: 0, out: 5, reasoningOut: 0, estimated: false, ms: 1 };

const answering: RuntimeDeps["harness"] = (host) => ({
  async answer(turn, sink, signal) {
    const said = await host.models.call({ messages: [{ role: "user", content: "Answer the chat's latest message." }], maxTokens: 64, connectionId: null, model: null }, signal);
    // Kept as the core keeps a blob: under the hash of its own text.
    const text = `${turn.generationId}\n${said.content}`;
    const segment = await textHash(text);
    await host.blobs.put(segment, text);
    sink.content(said.content);
    sink.done("stop", USAGE);
    return { status: "done", record: { v: 1, generationId: turn.generationId, kind: turn.kind, at: 2, path: "", segment, usage: USAGE }, reply: said.content, usage: USAGE };
  },
});

/** One of the two extensions as installed: its view of Lumiverse, its backend, a page of the user's, and its runtime as its Runtime page's line set it up. */
interface Installed {
  host: FakeHost;
  backend: Backend;
  page: FakePage;
  config: RuntimeConfig;
  runtime: Runtime;
  /** How many requests Lumiverse made of its loopback endpoint. */
  requests: number;
  /** Its loopback key, and the connection its runtime put the key in. */
  key: string;
  connection: { id: string; name: string };
}

interface Both {
  lumiverse: FakeLumiverse;
  lumiah: Installed;
  lantern: Installed;
  /** What the two `up` lines said. */
  said: string[];
  /** A new chat with these messages, Mara's first, switched on in one extension's pages. */
  chat(side: Installed, ...texts: string[]): Promise<string>;
  /** One generation as Lumiverse runs it: on the connection the chat generates on, at that connection's address, with the key Lumiverse holds for it. */
  generate(chatId: string): Promise<Generated>;
}

const closers: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const close of closers.splice(0)) await close();
});

/** The user's Custom connections, as their Connections list shows them. */
const custom = (it: Both) => it.lumiah.host.connectionList.filter((c) => c.provider === "custom").map((c) => ({ name: c.name, url: c.url, model: c.model }));

/** A main agent's one step: it briefs the writer at once. */
const briefing = (brief: string, id: string) => ({ toolCalls: [toolCall("write_reply", { brief }, id)] });

async function both(): Promise<Both> {
  const lumiverse = new FakeLumiverse(new FakeHost(), USER);
  const m = machine(lumiverse, { env: { LUMIVERSE_USERNAME: "mara", LUMIVERSE_PASSWORD: "a made-up password" } });
  // The agents' own connection: the user's default.
  lumiverse.host.addConnection({ id: "conn-main", name: "Main", provider: "openai", model: "model-main", isDefault: true });

  const install = async (host: FakeHost, options: BackendOptions, configName: string): Promise<Installed> => {
    // Nothing here waits on a backend's own timers (a key that goes unanswered), so it is given none.
    const backend = createBackend(host, { now: () => Date.now(), later: () => () => undefined, build: "test-build" }, options);
    const page = new FakePage(host, USER);

    // The line its own Runtime page shows, run as it stands on the machine Lumiverse runs on: the extension's own Bun and copy of the runtime, then `up` and its options.
    const line = (await page.request("lah.hello", {})).runtime.start.foreground;
    if (line === null) throw new Error("the page has no start line");
    const [bun = "", self = "", ...argv] = startLine(line, lumiverse.base).split(" ");
    if ((await lumiah(argv, { ...m.io, bun, self, harness: answering })) !== 0) throw new Error(`up failed: ${m.err.join("\n")}`);
    const path = `${HOME}/.config/lumiah/${configName}.json`;
    const config = configOf(m.files.get(path)?.text ?? null, path);

    // What `lumiah serve` then runs from that config. Its clockwork (pings, a stalled call given up) is left unrun: nothing here goes quiet or gets lost.
    const runtime = runtimeFrom(config, lumiverse, [], { harness: answering });
    closers.push(async () => {
      runtime.shutdown();
      await runtime.close();
    });
    await runtime.link.connect();
    const minted = await page.request("lah.key", { op: "mint" });
    if (minted.key === null || minted.connection === null) throw new Error("the runtime put the key in no connection");
    return { host, backend, page, config, runtime, requests: 0, key: minted.key, connection: minted.connection };
  };

  const own = await install(lumiverse.host, {}, "mara");
  const lantern = await install(new FakeHost("other_ext", lumiverse.host), { identity: { name: "Lantern", connectionName: "Lantern loopback" } }, "mara-other_ext");
  const sides = [own, lantern];
  const started = async (side: Installed, texts: string[]): Promise<string> => {
    const chat = side.host.addChat(USER, "Harbour light");
    texts.forEach((text, i) => side.host.say(chat.id, i % 2 === 0 ? "user" : "assistant", text));
    await side.page.request("lah.chat.set", { chatId: chat.id, on: true });
    return chat.id;
  };
  return {
    lumiverse,
    lumiah: own,
    lantern,
    said: m.out,
    chat: (side, ...texts) => started(side, texts),
    generate(chatId) {
      const pin = lumiverse.host.chatList.get(chatId)?.metadata.connection_profile_id;
      const connection = lumiverse.host.connectionList.find((c) => c.id === pin);
      if (connection === undefined) throw new Error("the chat generates on no connection");
      const port = Number(new URL(connection.url).port);
      const serving = sides.find((side) => side.config.port === port);
      if (serving === undefined) throw new Error(`no runtime serves on ${port}`);
      const fetch = (request: Request): Promise<Response> => {
        serving.requests++;
        return serving.runtime.fetch(request);
      };
      return lumiverse.generate(fetch, chatId, { key: lumiverse.keys.get(connection.id) ?? "", port });
    },
  };
}

describe("LumiAH and an extension that has LumiAH built in, installed together", () => {
  test("each has a runtime, a port, a loopback connection and a key of its own", async () => {
    const it = await both();
    expect(it.lumiah.config).toMatchObject({ name: "mara", extension: "lumi_ah", port: 7871 });
    expect(it.lantern.config).toMatchObject({ name: "mara-other_ext", extension: "other_ext", port: 7872 });
    expect(it.lantern.config.secret).not.toBe(it.lumiah.config.secret);

    // Each `up` made its connection under its extension's name, and the first key went into that one: no second was made.
    expect(it.said.join("\n")).toContain('Added the connection "Lantern loopback" to Lumiverse');
    expect(custom(it)).toEqual([
      { name: "LumiAH", url: "http://127.0.0.1:7871/v1", model: "lumiah" },
      { name: "Lantern loopback", url: "http://127.0.0.1:7872/v1", model: "lumiah-other_ext" },
    ]);
    expect(it.lumiah.connection.name).toBe("LumiAH");
    expect(it.lantern.connection.name).toBe("Lantern loopback");
    expect(it.lumiverse.keys.get(it.lumiah.connection.id)).toBe(it.lumiah.key);
    expect(it.lumiverse.keys.get(it.lantern.connection.id)).toBe(it.lantern.key);
    expect(it.lantern.key).not.toBe(it.lumiah.key);

    // Each one's pages take only its own connection for a loopback.
    const loopbacks = async (side: Installed) => (await side.page.request("lah.hello", {})).connections.filter((c) => c.loopback).map((c) => c.name);
    expect(await loopbacks(it.lumiah)).toEqual(["LumiAH"]);
    expect(await loopbacks(it.lantern)).toEqual(["Lantern loopback"]);

    // A user who deleted the extension's connection gets it made again under its name with the next key, and LumiAH's keeps its own key.
    it.lumiverse.host.connectionList = it.lumiverse.host.connectionList.filter((c) => c.id !== it.lantern.connection.id);
    const again = await it.lantern.page.request("lah.key", { op: "mint" });
    expect(again.connection?.name).toBe("Lantern loopback");
    expect(custom(it)).toEqual([
      { name: "LumiAH", url: "http://127.0.0.1:7871/v1", model: "lumiah" },
      { name: "Lantern loopback", url: "http://127.0.0.1:7872/v1", model: "lumiah-other_ext" },
    ]);
    expect(it.lumiverse.keys.get(again.connection?.id ?? "")).toBe(again.key ?? "");
    expect(it.lumiverse.keys.get(it.lumiah.connection.id)).toBe(it.lumiah.key);
  });

  test("a chat switched on in LumiAH is answered by LumiAH alone, and its record is kept under LumiAH's key", async () => {
    const it = await both();
    // The other extension keeps one message of a prompt it answers: a prompt it leaves alone keeps them all.
    await it.lantern.backend.settings.change(USER, [{ path: ["transport", "history", "count"], value: 1 }], []);
    const chatId = await it.chat(it.lumiah, "Who keeps the harbour light now?", "Ilse did, last I heard.", "And this spring?");
    it.lumiah.host.script = ["Okoro keeps it now."];
    // What each runtime keeps reaches its own extension's storage behind it: each is looked at once its runtime's store has sent it everything.
    const mirrored = (): Promise<unknown> => Promise.all([it.lumiah.runtime.store.settle(), it.lantern.runtime.store.settle()]);
    await mirrored();
    const kept = [...it.lantern.host.files.keys()];

    const out = await it.generate(chatId);
    await mirrored();

    expect(out).toMatchObject({ status: 200, error: null, content: "Okoro keeps it now." });
    expect(it.lumiah.backend.turns.ofChat(USER, chatId)?.turn).toBe(out.generationId);
    expect(it.lumiah.host.calls).toHaveLength(1);
    // The other extension tagged nothing and cut nothing; its runtime was asked nothing; it called no model and stored nothing.
    expect(it.lantern.backend.turns.ofChat(USER, chatId)).toBeUndefined();
    expect(out.body.messages).toHaveLength(4);
    expect({ lumiah: it.lumiah.requests, lantern: it.lantern.requests }).toEqual({ lumiah: 1, lantern: 0 });
    expect(it.lantern.host.calls).toEqual([]);
    expect([...it.lantern.host.files.keys()]).toEqual(kept);
    // The record goes on the reply once the extension's storage holds what it names.
    await until(() => it.lumiah.host.message(chatId, out.messageId ?? "").metadata.lumi_ah !== undefined, "LumiAH's record on the reply");
    expect([...it.lumiah.host.files.keys()].some((path) => path.startsWith(`${USER}/blobs/`))).toBe(true);

    const reply = it.lumiah.host.message(chatId, out.messageId ?? "");
    await until(() => reply.metadata.lumi_ah !== undefined, "LumiAH's record on the reply");
    expect(reply.metadata).toEqual({ lumi_ah: { v: 1, swipes: { "0": expect.objectContaining({ generationId: out.generationId, kind: "new" }) } } });
  });

  test("a chat switched on in the extension is answered by the extension alone, and its record is kept under the extension's key", async () => {
    const it = await both();
    await it.lumiah.backend.settings.change(USER, [{ path: ["transport", "history", "count"], value: 1 }], []);
    const chatId = await it.chat(it.lantern, "Who sells Okoro his lamp oil?", "Brann used to.", "And now?");
    it.lantern.host.script = ["Brann still does, every market day."];
    const mirrored = (): Promise<unknown> => Promise.all([it.lumiah.runtime.store.settle(), it.lantern.runtime.store.settle()]);
    await mirrored();
    const kept = [...it.lumiah.host.files.keys()];

    const out = await it.generate(chatId);
    await mirrored();

    expect(out).toMatchObject({ status: 200, error: null, content: "Brann still does, every market day." });
    expect(it.lantern.backend.turns.ofChat(USER, chatId)?.turn).toBe(out.generationId);
    expect(it.lantern.host.calls).toHaveLength(1);
    expect(it.lumiah.backend.turns.ofChat(USER, chatId)).toBeUndefined();
    expect(out.body.messages).toHaveLength(4);
    expect({ lumiah: it.lumiah.requests, lantern: it.lantern.requests }).toEqual({ lumiah: 0, lantern: 1 });
    expect(it.lumiah.host.calls).toEqual([]);
    expect([...it.lumiah.host.files.keys()]).toEqual(kept);
    await until(() => it.lantern.host.message(chatId, out.messageId ?? "").metadata.other_ext !== undefined, "the extension's record on the reply");
    expect([...it.lantern.host.files.keys()].some((path) => path.startsWith(`${USER}/blobs/`))).toBe(true);

    const reply = it.lantern.host.message(chatId, out.messageId ?? "");
    await until(() => reply.metadata.other_ext !== undefined, "the extension's record on the reply");
    expect(reply.metadata).toEqual({ other_ext: { v: 1, swipes: { "0": expect.objectContaining({ generationId: out.generationId, kind: "new" }) } } });
    // What LumiAH's own pages and reads see of that message is none of it.
    expect(reply.own).toBeNull();
  });

  test("a chat one of them answers is no chat the other can switch on", async () => {
    const it = await both();
    const chatId = await it.chat(it.lumiah, "Who keeps the harbour light now?");
    expect((await it.lantern.page.request("lah.chat.get", { chatId })).chat).toMatchObject({ on: false, other: { identifier: "lumi_ah", name: "LumiAH" } });
    const refused = await it.lantern.page.request("lah.chat.set", { chatId, on: true }).catch((error: unknown) => error);
    expect(refused instanceof UiFailure ? refused.error.message : null).toContain("LumiAH answers this chat.");
    // The chat still generates on LumiAH's loopback, and LumiAH still answers it.
    it.lumiah.host.script = ["Okoro keeps it now."];
    expect((await it.generate(chatId)).content).toBe("Okoro keeps it now.");
    expect(it.lantern.host.calls).toEqual([]);

    // Switched off in LumiAH, the chat is the extension's to switch on: from then on LumiAH's pages show it as the extension's, and the extension's runtime answers its replies.
    await it.lumiah.page.request("lah.chat.set", { chatId, on: false });
    expect((await it.lantern.page.request("lah.chat.set", { chatId, on: true })).chat).toMatchObject({ on: true, connection: { id: it.lantern.connection.id, loopback: true } });
    expect((await it.lumiah.page.request("lah.chat.get", { chatId })).chat).toMatchObject({ on: false, other: { identifier: "other_ext", name: "Lantern" } });
    it.lumiverse.host.say(chatId, "user", "And who kept it before him?");
    it.lantern.host.script = ["Ilse kept it before him."];
    expect((await it.generate(chatId)).content).toBe("Ilse kept it before him.");
    expect([it.lumiah.host.calls.length, it.lantern.host.calls.length]).toEqual([1, 1]);
  });

  test("a request with the other one's key is refused, in words that name the page to mint a key on", async () => {
    const it = await both();
    const ask = (side: Installed, key: string) => it.lumiverse.post(side.runtime.fetch, { model: "lumiah", messages: [{ role: "user", content: "Who keeps the light?" }] }, { key, port: side.config.port });
    expect((await ask(it.lantern, it.lumiah.key)).error?.message).toBe("The key in the loopback connection isn't this account's loopback key. Mint a new one on Lantern's Runtime page: your linked runtime puts it in the connection.");
    expect((await ask(it.lumiah, it.lantern.key)).error?.message).toBe("The key in the loopback connection isn't this account's loopback key. Mint a new one on LumiAH's Runtime page: your linked runtime puts it in the connection.");
    expect([...it.lumiah.host.calls, ...it.lantern.host.calls]).toEqual([]);
  });

  test("the extension's Runtime page shows its own runtime, its own lines and its own name", async () => {
    const it = await both();
    const state = await it.lantern.page.request("lah.hello", {});
    expect(state.runtime.model).toBe("lumiah-other_ext");
    expect(state.runtime.start).toEqual({
      service: "/opt/bun/bin/bun /srv/lumiverse/extensions/other_ext/dist/lumiah.js up --url {{url}} --extension other_ext --systemd",
      foreground: "/opt/bun/bin/bun /srv/lumiverse/extensions/other_ext/dist/lumiah.js up --url {{url}} --extension other_ext",
      missing: [],
    });
    expect(state.runtime.relays).toHaveLength(1);
    expect(state.runtime.relays[0]).toMatchObject({
      name: "mara-other_ext",
      link: "linked",
      url: "http://127.0.0.1:7872/v1",
      lines: { update: "/opt/bun/bin/bun /srv/lumiverse/extensions/other_ext/dist/lumiah.js up --name mara-other_ext --extension other_ext", login: "/opt/bun/bin/bun /home/mara/.local/share/lumiah/lumiah.js login --name mara-other_ext" },
    });

    // LumiAH's own page shows LumiAH's runtime, and names no extension.
    const own = await it.lumiah.page.request("lah.hello", {});
    expect(own.runtime.model).toBe("lumiah");
    expect(own.runtime.start.service).toBe("/opt/bun/bin/bun /srv/lumiverse/extensions/lumi_ah/dist/lumiah.js up --url {{url}} --systemd");
    expect(own.runtime.relays.map((r) => ({ name: r.name, update: r.lines.update }))).toEqual([{ name: "mara", update: "/opt/bun/bin/bun /srv/lumiverse/extensions/lumi_ah/dist/lumiah.js up --name mara" }]);

    // What keeps it from working on any reply is said in its own name, and sends the user to its own entry in Lumiverse.
    it.lantern.host.permissions.delete("interceptor");
    const lacking = (await it.lantern.page.request("lah.hello", {})).permissions.find((p) => p.id === "interceptor");
    expect(lacking).toEqual({ id: "interceptor", needed: true, what: "see a reply's prompt before it is sent", without: "no reply is worked on", todo: "Grant it in Lumiverse (Extensions → Lantern → Permissions)." });
  });

  test("a chat one of them answers is taken over by the other at the user's word: the other's mark goes, and the chat is pinned to the other's runtime, which remembers the connection it had", async () => {
    const it = await both();
    // A chat the user had pinned to a connection of their own, then switched on in the extension.
    it.lumiah.host.addConnection({ id: "conn-own", name: "Own", provider: "openai", model: "model-own" });
    const chat = it.lantern.host.addChat(USER, "Harbour light");
    it.lantern.host.say(chat.id, "user", "Who keeps the harbour light now?");
    chat.metadata.connection_profile_id = "conn-own";
    expect((await it.lantern.page.request("lah.chat.set", { chatId: chat.id, on: true })).chat).toMatchObject({ on: true, connection: { id: it.lantern.connection.id } });

    // LumiAH shows it as the extension's and won't switch it on beside it; the refusal says how to take it.
    expect((await it.lumiah.page.request("lah.chat.get", { chatId: chat.id })).chat).toMatchObject({ on: false, other: { identifier: "other_ext", name: "Lantern" } });
    const refused = await it.lumiah.page.request("lah.chat.set", { chatId: chat.id, on: true }).catch((error: unknown) => error);
    expect(refused instanceof UiFailure ? refused.error : null).toMatchObject({ code: "unavailable", message: expect.stringContaining("take the chat over here") });

    // Taken over: the extension's mark is gone, and the chat is pinned to LumiAH's own loopback connection, so LumiAH's runtime answers it.
    const taken = (await it.lumiah.page.request("lah.chat.takeover", { chatId: chat.id })).chat;
    expect(taken).toMatchObject({ on: true, connection: { id: it.lumiah.connection.id, loopback: true } });
    expect(taken.other).toBeUndefined();
    expect(Object.keys(chat.metadata).filter((key) => key.startsWith("lumiah_chat_"))).toEqual(["lumiah_chat_lumi_ah"]);
    expect(chat.metadata.connection_profile_id).toBe(it.lumiah.connection.id);
    // The extension, still installed, now shows the chat as LumiAH's and works on none of its replies.
    expect((await it.lantern.page.request("lah.chat.get", { chatId: chat.id })).chat).toMatchObject({ on: false, other: { identifier: "lumi_ah", name: "LumiAH" } });
    it.lumiah.host.script = ["Okoro keeps it now."];
    const out = await it.generate(chat.id);
    expect(out.content).toBe("Okoro keeps it now.");
    expect({ lumiah: it.lumiah.requests, lantern: it.lantern.requests }).toEqual({ lumiah: 1, lantern: 0 });
    expect(it.lumiah.host.calls).toHaveLength(1);
    expect(it.lantern.host.calls).toEqual([]);
    // Switched off in LumiAH, the chat gets back the connection it had before either pinned it.
    expect((await it.lumiah.page.request("lah.chat.set", { chatId: chat.id, on: false })).chat).toMatchObject({ on: false, connection: { id: "conn-own", loopback: false } });

    // A mark left by an extension that is no longer installed is taken the same way: nobody is there to switch it off in.
    const orphan = it.lumiah.host.addChat(USER, "Brann's ledger");
    orphan.metadata.lumiah_chat_gone_ext = { v: 1, chat: orphan.id, name: "Old Lantern", since: 1 };
    expect((await it.lumiah.page.request("lah.chat.get", { chatId: orphan.id })).chat).toMatchObject({ on: false, other: { identifier: "gone_ext", name: "Old Lantern" } });
    expect((await it.lumiah.page.request("lah.chat.takeover", { chatId: orphan.id })).chat).toMatchObject({ on: true, connection: { id: it.lumiah.connection.id, loopback: true } });
    expect(Object.keys(orphan.metadata).filter((key) => key.startsWith("lumiah_chat_"))).toEqual(["lumiah_chat_lumi_ah"]);
  });
});
