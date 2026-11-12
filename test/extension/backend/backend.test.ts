// The extension backend over a fake Lumiverse (DESIGN §7): what the prompt interceptor does to a
// prompt, the settings and their pushes to the pages, the per-chat switch, the secrets as they are
// stored, the chat's path as it is read, and the records on a reply's swipes.

import { afterEach, describe, expect, test } from "bun:test";
import { TEXT_DEFS } from "../../../src/core/texts";
import type { InterceptorInput, PromptMessage } from "../../../src/extension/backend/spindle";
import { UiFailure } from "../../support/fake-lumiverse";
import { toolCall } from "../../support/fake-host";
import { type Rig, rig, until, USER } from "../../support/rig";

let r: Rig | null = null;
afterEach(() => {
  r?.close();
  r = null;
});

/** A prompt as Lumiverse hands one to the interceptor: a system message, then `turns` messages of the chat's history. */
function prompt(turns: number): PromptMessage[] {
  const history = Array.from({ length: turns }, (_, i): PromptMessage => ({ role: i % 2 === 0 ? "user" : "assistant", text: `message ${i}`, history: true, sourceId: `m${i}`, sourceIndex: i }));
  return [{ role: "system", text: "You are Joss.", history: false }, ...history];
}

function intercept(it: Rig, input: Partial<InterceptorInput> & { chatId: string; messages: PromptMessage[] }) {
  const interceptor = it.host.interceptor;
  if (interceptor === null) throw new Error("no interceptor was registered");
  return interceptor.handler({ userId: USER, generationId: null, type: "normal", dryRun: false, connectionId: null, presetId: null, personaId: null, activated: [], ...input });
}

describe("the prompt interceptor", () => {
  test("is registered to run last, and never to fail a generation: Lumiverse passes over one that isn't required, and the prompt goes on as it came", async () => {
    const it = (r = await rig());
    expect(it.host.interceptor?.options).toEqual({ priority: Number.MAX_SAFE_INTEGER, types: ["normal", "regenerate", "swipe", "continue"], required: false });
  });

  test("leaves a prompt on any other connection as it is", async () => {
    const it = (r = await rig());
    const chatId = await it.setUp();
    expect(await intercept(it, { chatId, connectionId: "conn-main", messages: prompt(6) })).toEqual({});
  });

  test("on the loopback leaves out the history past the cutoff and tags the generation", async () => {
    const it = (r = await rig());
    const chatId = await it.setUp();
    await it.page.request("lah.settings.set", { set: [{ path: ["transport", "history", "count"], value: 2 }], reset: [] });
    const loopback = it.host.connectionList.find((c) => c.model === "lumiah");
    it.host.emit.started({ generationId: "gen-1", chatId, userId: USER, type: "normal", targetMessageId: null, targetSwipeId: null });

    const verdict = await intercept(it, { chatId, connectionId: loopback?.id ?? "", messages: prompt(6) });

    // Places 1 to 4 are the four oldest history messages; the system message and the latest two stay.
    expect(verdict.omit).toEqual([1, 2, 3, 4]);
    expect(typeof verdict.parameters?.lumiah_turn).toBe("string");
    // Every message is kept when the user says so.
    await it.page.request("lah.settings.set", { set: [{ path: ["transport", "history", "keep"], value: "all" }], reset: [] });
    it.host.emit.started({ generationId: "gen-2", chatId, userId: USER, type: "normal", targetMessageId: null, targetSwipeId: null });
    expect((await intercept(it, { chatId, connectionId: loopback?.id ?? "", messages: prompt(6) })).omit).toEqual([]);
  });

  test("shows a prompt preview the cutoff and gives it no tag", async () => {
    const it = (r = await rig());
    const chatId = await it.setUp();
    const loopback = it.host.connectionList.find((c) => c.model === "lumiah");
    const verdict = await intercept(it, { chatId, connectionId: loopback?.id ?? "", dryRun: true, messages: prompt(50) });
    expect(verdict.omit).toHaveLength(10);
    expect(verdict.parameters).toBeUndefined();
  });

  test("refuses a prompt whose generation it can't tell, so nothing goes out untagged", async () => {
    const it = (r = await rig());
    const chatId = await it.setUp();
    const loopback = it.host.connectionList.find((c) => c.model === "lumiah");
    expect(intercept(it, { chatId, connectionId: loopback?.id ?? "", messages: prompt(2) })).rejects.toThrow("LumiAH couldn't tell which generation this prompt belongs to");
  });
});

describe("the settings", () => {
  test("change all together or not at all, and every page of the user hears the change under the next revision", async () => {
    const it = (r = await rig());
    const other = it.lumiverse.page();
    const before = await other.request("lah.hello", {});
    expect(before.settings.values).toMatchObject({ transport: { history: { keep: "last", count: 40 } } });

    // One good value and one the settings refuse: neither is kept.
    const refused = await it.page.request("lah.settings.set", { set: [{ path: ["transport", "history", "count"], value: 12 }, { path: ["transport", "live", "page"], value: 0 }], reset: [] }).catch((error: unknown) => error);
    expect(refused).toBeInstanceOf(UiFailure);
    expect(refused instanceof UiFailure ? refused.error : null).toMatchObject({ code: "invalid", problems: [{ path: ["transport", "live", "page"] }] });
    expect((await it.backend.settings.transport(USER)).history.count).toBe(40);

    const changed = await it.page.request("lah.settings.set", { set: [{ path: ["transport", "history", "count"], value: 12 }], reset: [] });
    expect(changed.settings.values).toMatchObject({ transport: { history: { count: 12 } } });
    await it.backend.settle();
    const push = other.pushes.find((p) => p.type === "lah.state" && p.patch.settings !== undefined);
    expect(push).toMatchObject({ type: "lah.state", rev: before.rev + 1, patch: { settings: { values: { transport: { history: { count: 12 } } } } } });

    // Reset puts the default back, and only what the user changed is stored.
    const reset = await it.page.request("lah.settings.set", { set: [], reset: [["transport", "history", "count"]] });
    expect(reset.settings.values).toMatchObject({ transport: { history: { count: 40 } } });
    expect(it.host.stored(USER, "settings.json")).toMatchObject({ own: [{ path: ["transport", "streams", "coalesceMs"], value: 0 }] });
  });

  test("keep a text of the user's own only when it still has what the text can't work without", async () => {
    const it = (r = await rig());
    const def = TEXT_DEFS.find((d) => d.vars.some((v) => v.required));
    const required = def?.vars.find((v) => v.required);
    if (def === undefined || required === undefined) throw new Error("no text with a required placeholder");
    const refused = await it.page.request("lah.text.set", { id: def.id, text: "Nothing of what it needs." }).catch((error: unknown) => error);
    expect(refused instanceof UiFailure ? refused.error.code : null).toBe("invalid");
    const mine = `Mine: ${def.vars.filter((v) => v.required).map((v) => `{{${v.name}}}`).join(" ")}`;
    const kept = await it.page.request("lah.text.set", { id: def.id, text: mine });
    expect(kept.texts.own[def.id]).toBe(mine);
    expect((await it.page.request("lah.text.reset", { id: def.id })).texts.own[def.id]).toBeUndefined();
  });

  test("pass over quietly a value kept at a setting this build took away, and leave it out of storage from the next change on", async () => {
    const it = (r = await rig());
    const stored = it.host.stored(USER, "settings.json") as { own: { path: string[]; value: unknown }[] };
    // As a build that could run a chat inside Lumiverse kept them: how near the reply its main agent was warned and how long a turn waited for its reply, and that way's own group of timings; beside them, a setting this build keeps.
    stored.own.push({ path: ["core", "reply", "warnMs"], value: 30_000 }, { path: ["core", "reply", "pendingMs"], value: 600_000 }, { path: ["transport", "builtin"], value: { marginMs: 15_000 } }, { path: ["transport", "history", "count"], value: 12 });
    it.host.files.set(`${USER}/settings.json`, JSON.stringify(stored));
    await it.restart();

    const { values } = (await it.page.request("lah.hello", {})).settings;
    for (const gone of [["core", "reply", "warnMs"], ["core", "reply", "pendingMs"], ["transport", "builtin"]]) expect(values).not.toHaveProperty(gone);
    expect(values).toMatchObject({ transport: { history: { count: 12 } } });

    // The next change is taken as any is, and what it stores holds nothing of what was taken away.
    await it.page.request("lah.settings.set", { set: [{ path: ["transport", "history", "count"], value: 20 }], reset: [] });
    await it.backend.settle();
    const after = it.host.stored(USER, "settings.json") as { own: { path: string[]; value: unknown }[] };
    expect(after.own).toEqual(expect.arrayContaining([{ path: ["transport", "streams", "coalesceMs"], value: 0 }, { path: ["transport", "history", "count"], value: 20 }]));
    expect(after.own).toHaveLength(2);
  });
});

describe("the per-chat switch and the secrets", () => {
  test("on pins the chat to the loopback connection and off puts back the connection it had; with no loopback connection yet, on is refused in words that say how to get one", async () => {
    const it = (r = await rig());
    it.host.addConnection({ id: "conn-other", name: "Other" });
    const chat = it.host.addChat(USER, "Ilse's ledger");
    chat.metadata.connection_profile_id = "conn-other";

    // No key minted yet, so no loopback connection: there is nothing to pin the chat to.
    const early = await it.page.request("lah.chat.set", { chatId: chat.id, on: true }).catch((error: unknown) => error);
    expect(early instanceof UiFailure ? early.error : null).toMatchObject({ code: "unavailable", message: "There is no runtime to answer this chat yet. Start one with its line on LumiAH's Runtime page and mint its key there, then switch the chat on." });
    expect(chat.metadata.connection_profile_id).toBe("conn-other");
    expect((await it.page.request("lah.chat.get", { chatId: chat.id })).chat).toMatchObject({ on: false, connection: { id: "conn-other", loopback: false } });

    await it.setUp();
    const loopback = it.host.connectionList.find((c) => c.model === "lumiah");
    const on = await it.page.request("lah.chat.set", { chatId: chat.id, on: true });
    expect(on.chat).toMatchObject({ on: true, connection: { id: loopback?.id, loopback: true } });
    expect(chat.metadata.connection_profile_id).toBe(loopback?.id ?? "");

    const off = await it.page.request("lah.chat.set", { chatId: chat.id, on: false });
    expect(off.chat).toMatchObject({ on: false, since: null, connection: { id: "conn-other", loopback: false } });
    expect(chat.metadata.connection_profile_id).toBe("conn-other");

    // A page of an earlier build that still names a place to run the chat in is heard as asking for it on: the runtime is the one place.
    const stale: { chatId: string; on: boolean } = Object.assign({ chatId: chat.id, on: true }, { place: "builtin" });
    expect((await it.page.request("lah.chat.set", stale)).chat).toMatchObject({ on: true, connection: { id: loopback?.id, loopback: true } });

    // A chat an earlier build switched on to run inside Lumiverse was never pinned: it reads as off, and switching it on pins it.
    const old = it.host.addChat(USER, "Okoro's log");
    old.metadata.connection_profile_id = "conn-other";
    const kept = it.host.stored(USER, "chats.json") as { on: Record<string, unknown> };
    kept.on[old.id] = { since: 1, place: "builtin", prior: null, priorModel: null };
    it.host.files.set(`${USER}/chats.json`, JSON.stringify(kept));
    await it.restart();
    expect((await it.page.request("lah.chat.get", { chatId: old.id })).chat).toMatchObject({ on: false, since: null, connection: { id: "conn-other", loopback: false } });
    expect((await it.page.request("lah.chat.set", { chatId: old.id, on: true })).chat).toMatchObject({ on: true, connection: { id: loopback?.id, loopback: true } });
    expect(old.metadata.connection_profile_id).toBe(loopback?.id ?? "");

    // Another account's chat is no chat at all.
    const theirs = it.host.addChat("user-brann", "Brann's stall");
    const refused = await it.page.request("lah.chat.get", { chatId: theirs.id }).catch((error: unknown) => error);
    expect(refused instanceof UiFailure ? refused.error.code : null).toBe("not_found");
  });

  test("the loopback key and a runtime's secret are stored only as hashes, and the key is shown once", async () => {
    const it = (r = await rig());
    await it.setUp();
    const stored = JSON.stringify(it.host.stored(USER, "registry.json"));
    expect(it.key).toStartWith("lah_");
    expect(stored).not.toContain(it.key);
    expect(stored).toContain('"hash"');
    // The key went into the loopback connection the runtime made, and nowhere the pages can read it back.
    const loopback = it.host.connectionList.find((c) => c.model === "lumiah");
    expect(it.lumiverse.keys.get(loopback?.id ?? "")).toBe(it.key);
    const state = await it.page.request("lah.hello", {});
    expect(state.key).toMatchObject({ set: true });
    expect(JSON.stringify(state)).not.toContain(it.key);

    // A new key replaces it at once: the old one admits nothing.
    const again = await it.page.request("lah.key", { op: "mint" });
    expect(again.key).not.toBe(it.key);
    expect(await it.backend.registry.keyIs(USER, it.key)).toBe(false);
    expect(it.lumiverse.keys.get(loopback?.id ?? "")).toBe(again.key ?? "");
  });

  test("a rotated relay secret reaches the runtime over its link, and a forgotten runtime is refused", async () => {
    const it = (r = await rig());
    await it.runtime.link.connect();
    const relay = (await it.page.request("lah.hello", {})).runtime.relays[0]?.id ?? "";
    const before = JSON.stringify(it.host.stored(USER, "registry.json"));

    await it.page.request("lah.relay", { op: "rotate", relay });
    await it.backend.settle();
    expect(JSON.stringify(it.host.stored(USER, "registry.json"))).not.toBe(before);
    await until(() => it.logs.some((line) => line.includes("rotated this runtime's secret")), "the runtime to take the new secret");
    // The runtime goes on with the new one.
    expect(await it.runtime.link.request("settings.get", {}, 1_000)).toMatchObject({ revision: expect.any(Number) });

    const after = await it.page.request("lah.relay", { op: "forget", relay });
    expect(after.runtime.relays).toEqual([]);
    expect(it.runtime.link.request("settings.get", {}, 1_000)).rejects.toThrow("LumiAH doesn't know this runtime");
  });
});

describe("a chat as the core reads it", () => {
  test("costs one read of its messages until it changes, and its texts come by range", async () => {
    const it = (r = await rig());
    const chatId = await it.setUp();
    it.host.say(chatId, "assistant", "Okoro keeps it.");
    const whole = (): number => it.host.reads.filter((read) => read.chatId === chatId && read.range === null).length;

    const first = await it.backend.chats.path(USER, chatId);
    const again = await it.backend.chats.path(USER, chatId);
    expect(first.map((m) => m.role)).toEqual(["user", "assistant"]);
    expect(again).toEqual(first);
    expect(whole()).toBe(1);
    expect(await it.backend.chats.messages(USER, chatId, 1, 2)).toMatchObject([{ index: 1, content: "Okoro keeps it." }]);
    expect(whole()).toBe(1);

    // A new message: Lumiverse says the chat changed, and the path is read again; the unchanged messages keep their fingerprints.
    it.host.say(chatId, "user", "Since when?");
    const later = await it.backend.chats.path(USER, chatId);
    expect(whole()).toBe(2);
    expect(later.slice(0, 2).map((m) => m.hash)).toEqual(first.map((m) => m.hash));
    // An edit changes the message's fingerprint.
    it.host.message(chatId, later[1]?.id ?? "").swipes[0] = "Ilse keeps it.";
    it.host.emit.touched(chatId);
    expect((await it.backend.chats.path(USER, chatId))[1]?.hash).not.toBe(first[1]?.hash);
  });

  test("keeps one record per swipe of a reply, and moves them when a swipe is deleted", async () => {
    const it = (r = await rig());
    const chatId = await it.setUp();
    it.host.script = [{ toolCalls: [toolCall("write_reply", { brief: "Okoro." }, "c1")] }, "Okoro keeps it.", { toolCalls: [toolCall("write_reply", { brief: "Ilse." }, "c2")] }, "Ilse did, before him."];
    const first = await it.generate(chatId);
    const reply = it.host.message(chatId, first.messageId ?? "");
    await until(() => reply.own !== null, "the first swipe's record");
    const swiped = await it.generate(chatId, { type: "swipe" });
    await until(() => JSON.stringify(reply.own).includes(swiped.generationId), "the second swipe's record");

    expect(reply.own).toMatchObject({ v: 1, swipes: { "0": { generationId: first.generationId, kind: "new" }, "1": { generationId: swiped.generationId, kind: "swipe" } } });
    // The path shows the record of the swipe the chat shows.
    expect((await it.backend.chats.path(USER, chatId)).at(-1)?.anchor).toMatchObject({ generationId: swiped.generationId });

    // The first swipe is deleted: the second is now swipe 0, and its record with it.
    reply.swipes.splice(0, 1);
    reply.swipeId = 0;
    it.host.emit.swipe({ chatId, userId: USER, messageId: reply.id, action: "deleted", swipeId: 0 });
    await until(() => !JSON.stringify(reply.own).includes(first.generationId), "the deleted swipe's record to go");
    expect(reply.own).toMatchObject({ v: 1, swipes: { "0": { generationId: swiped.generationId } } });
  });
});
