// The prompt interceptor and the chats LumiAH doesn't answer. LumiAH's interceptor is never a
// required one: Lumiverse passes over an interceptor that throws or takes too long, and the prompt
// goes on as it came. Its check ("is this connection the loopback?") asks Lumiverse, which can fail
// (a permission revoked) or hang. Nothing LumiAH does may fail or hold up a chat it doesn't answer;
// a chat a runtime answers says in words that it couldn't be tagged rather than tagging it wrongly.

import { afterEach, describe, expect, test } from "bun:test";
import type { ChatClaim } from "../../../src/core/extension";
import { TAG_PARAM } from "../../../src/link/contract";
import type { BackendOptions } from "../../../src/extension/backend/backend";
import type { InterceptorInput, InterceptorVerdict } from "../../../src/extension/backend/spindle";
import { TAGGED_TYPES } from "../../../src/extension/backend/turns";
import { type Rig, rig, USER } from "../../support/rig";

let open: Rig | null = null;
afterEach(async () => {
  await open?.close();
  open = null;
});

/** A rig whose runtime answers no turn: these tests stop at the interceptor. `backend`: what an extension that builds LumiAH in gives its backend. */
async function start(backend?: BackendOptions): Promise<{ it: Rig; chatId: string; loopback: string; intercept(input: Partial<InterceptorInput>): Promise<InterceptorVerdict> }> {
  const it = await rig({ ...(backend !== undefined ? { backend } : {}), harness: () => ({ answer: async () => ({ status: "failed", reason: "no turn is answered in this test", record: null, reply: "", usage: { calls: 0, toolTurns: 0, in: 0, cachedIn: 0, out: 0, reasoningOut: 0, estimated: false, ms: 0 } }) }) });
  open = it;
  const chatId = await it.setUp();
  const loopback = (await it.page.request("lah.hello", {})).connections.find((c) => c.loopback)?.id ?? "";
  if (loopback === "") throw new Error("setUp made no loopback connection");
  const registered = it.host.interceptor;
  if (registered === null) throw new Error("the backend registered no interceptor");
  const [type] = TAGGED_TYPES;
  if (type === undefined) throw new Error("no generation type is tagged");
  let n = 0;
  const intercept = (input: Partial<InterceptorInput>): Promise<InterceptorVerdict> =>
    registered.handler({ chatId, userId: USER, generationId: `gen-${++n}`, type, dryRun: false, connectionId: "conn-main", presetId: null, personaId: null, activated: [], messages: [{ role: "user", text: "Who keeps the harbour light now?", history: true }], ...input });
  return { it, chatId, loopback, intercept };
}

/** Lumiverse stops answering what the check asks: it refuses, or never answers. */
function breakConnections(it: Rig, how: "refuses" | "hangs"): void {
  const failing = (): Promise<never> => (how === "refuses" ? Promise.reject(new Error("Permission denied: generation")) : new Promise<never>(() => undefined));
  it.host.connections.get = failing;
  it.host.connections.list = failing;
}

describe("a chat LumiAH doesn't answer", () => {
  test("is left as it is when Lumiverse refuses the check", async () => {
    const { it, intercept } = await start();
    breakConnections(it, "refuses");
    // A connection never seen before: nothing says it is the loopback, so its reply goes on untouched.
    expect(await intercept({ connectionId: "conn-never-seen" })).toEqual({});
    expect(await intercept({ connectionId: null, chatId: it.host.addChat(USER, "Brann's ledger").id })).toEqual({});
    expect(it.host.logs.some((l) => l.level === "warn" && l.message.includes("couldn't be checked"))).toBe(true);
  });

  test("is held up no longer than the wait Settings give when Lumiverse never answers, and not at all once it is known", async () => {
    const { it, intercept } = await start();
    await it.backend.settings.change(USER, [{ path: ["transport", "tags", "checkMs"], value: 100 }], []);
    // Known from a check that worked: the next reply on it waits for nothing.
    expect(await intercept({ connectionId: "conn-main" })).toEqual({});
    breakConnections(it, "hangs");
    const waited = Promise.withResolvers<"waited">();
    const timer = setTimeout(() => waited.resolve("waited"), 50);
    expect(await Promise.race([intercept({ connectionId: "conn-main" }), waited.promise])).toEqual({});
    clearTimeout(timer);
    // Not known: the check is given its time, then the reply goes on untouched.
    const before = Date.now();
    expect(await intercept({ connectionId: "conn-never-seen" })).toEqual({});
    expect(Date.now() - before).toBeLessThan(5_000);
  });
});

describe("a chat LumiAH answers", () => {
  test("is tagged, and fails in words, not untagged, when its connection can no longer be checked", async () => {
    const { it, loopback, intercept } = await start();
    const tagged = await intercept({ connectionId: loopback });
    expect(typeof tagged.parameters?.[TAG_PARAM]).toBe("string");
    breakConnections(it, "refuses");
    await expect(intercept({ connectionId: loopback })).rejects.toThrow("couldn't check its connection now");
  });

  test("in a chat another extension leads, is stopped in words that name the wait, never passed on untagged, when its connection can no longer be checked; in one nobody claims, it is left untagged as before", async () => {
    let claim: ChatClaim | null = { mainAgent: "author", reply: "released" };
    const { it, loopback, intercept } = await start({ extension: { name: "Tide keeper", claim: async () => claim } });
    expect(typeof (await intercept({ connectionId: loopback })).parameters?.[TAG_PARAM]).toBe("string");
    breakConnections(it, "refuses");
    // Tagged with a tag that carries only the refusal: the runtime's request is answered with its words, and no writer writes the reply.
    const tag = (await intercept({ connectionId: loopback })).parameters?.[TAG_PARAM];
    expect(typeof tag).toBe("string");
    const refused = await it.backend.turns.begin(USER, "relay-harbour", it.key, tag, "request-1").catch((error: unknown) => error);
    expect(refused instanceof Error ? refused.message : null).toContain("Loopback check");
    claim = null;
    await expect(intercept({ connectionId: loopback })).rejects.toThrow("couldn't check its connection now");
  });

  test("is left to its connection alone, uncut and untagged, without the permission to set a request's parameters, and the pages say what that permission is for", async () => {
    const { it, loopback, intercept } = await start();
    it.host.permissions.delete("generation_parameters");
    expect(await intercept({ connectionId: loopback, messages: Array.from({ length: 80 }, (_, i) => ({ role: "user" as const, text: `Message ${i}`, history: true })) })).toEqual({});
    const { permissions } = await it.page.request("lah.hello", {});
    // One LumiAH can't do without: every chat it answers runs in the runtime, and the tag that leads a reply there rides on the request's parameters.
    const lacking = permissions.find((p) => p.id === "generation_parameters");
    expect(lacking).toMatchObject({ needed: true, what: "tag the replies your runtime answers", without: "no reply is worked on" });
    // And no chat can be switched on until it is granted.
    const other = it.host.addChat(USER, "Brann's ledger");
    const refused = await it.page.request("lah.chat.set", { chatId: other.id, on: true }).catch((error: unknown) => error);
    expect(String(refused)).toContain('"generation_parameters"');
  });
});
