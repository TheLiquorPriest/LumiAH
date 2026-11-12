// The link's handshake (DESIGN §6: "the link is versioned"): each end says its version on hello, and
// a mismatch is refused in plain words that name which side to update, wherever it is noticed: by
// the extension (an older or newer runtime), or by the runtime (an extension that answers another
// version). A runtime the extension doesn't know is refused too. And a request asked while the link
// is down, which goes once it is back, with what it says worked out as it leaves.

import { afterEach, describe, expect, test } from "bun:test";
import { isRecord } from "../../src/core/ports";
import { LINK, LINK_VERSION, type LinkRequests, type RuntimeReport, versionWords } from "../../src/link/contract";
import type { Runtime } from "../../src/runtime/runtime";
import { FakeHost } from "../support/fake-host";
import { FakeLumiverse } from "../support/fake-lumiverse";
import { BUILD, PORT, type Rig, rig, runtimeFor, until, USER } from "../support/rig";

let r: Rig | null = null;
let alone: Runtime | null = null;
afterEach(async () => {
  await r?.close();
  r = null;
  await alone?.close();
  alone = null;
});

const report = (name: string, build: string): RuntimeReport => ({ name, build, runtime: { bun: "/opt/bun/bin/bun", script: "/home/mara/.local/share/lumiah/lumiah.js", unit: `lumiah-${name}.service` }, host: "harbour-box", listen: "127.0.0.1", port: 7872, scheduler: "unknown", session: { valid: true, expiresAt: null, checkedAt: null }, turns: 0 });

describe("a hello", () => {
  test("of the extension's own link version is answered, and the Runtime page shows the runtime linked", async () => {
    const it = (r = await rig());
    await it.runtime.link.connect();
    expect(it.runtime.link.up).toBe(true);
    expect(it.runtime.link.hello).toMatchObject({ version: LINK_VERSION, build: BUILD });
    const state = await it.page.request("lah.hello", {});
    expect(state.runtime.relays).toHaveLength(1);
    expect(state.runtime.relays[0]).toMatchObject({ name: "mara", link: "linked", problem: null, build: BUILD, update: false, url: `http://127.0.0.1:${PORT}/v1` });
    // The lines the page offers are whole: Lumiverse's own Bun, this extension's copy of the runtime.
    expect(state.runtime.start.service).toBe("/opt/bun/bin/bun /srv/lumiverse/extensions/lumi_ah/dist/lumiah.js up --url {{url}} --systemd");
  });

  test("from a runtime of an older link version is refused by the extension, in words that say to update the runtime", async () => {
    const it = (r = await rig());
    const registered = await it.lumiverse.raw({ type: "register", name: "old", build: "older-build", host: "harbour-box", listen: "127.0.0.1", port: 7872 });
    if (registered.type !== "result") throw new Error("register failed");
    const { secret } = registered.body as LinkRequests["register"]["result"];

    const hello = await it.lumiverse.raw({ type: "hello", secret, version: LINK_VERSION - 1, build: "older-build", report: report("old", "older-build"), open: [] });

    expect(hello).toEqual({ type: "error", code: "version", message: versionWords(LINK_VERSION - 1, LINK_VERSION) });
    expect(versionWords(LINK_VERSION - 1, LINK_VERSION)).toContain("update the runtime by running its start line on LumiAH's Runtime page again");
    // The Runtime page says the same of that runtime, and that its build differs.
    const state = await it.page.request("lah.hello", {});
    const old = state.runtime.relays.find((relay) => relay.name === "old");
    expect(old).toMatchObject({ link: "refused", problem: versionWords(LINK_VERSION - 1, LINK_VERSION), update: true });
  });

  test("with a secret the extension doesn't know is refused, and so is every request after it", async () => {
    const it = (r = await rig());
    const hello = await it.lumiverse.raw({ type: "hello", secret: "f".repeat(64), version: LINK_VERSION, build: BUILD, report: report("ghost", BUILD), open: [] });
    expect(hello).toMatchObject({ type: "error", code: "forbidden" });
    const read = await it.lumiverse.raw({ type: "settings.get", secret: "f".repeat(64) });
    expect(read).toMatchObject({ type: "error", code: "forbidden", message: expect.stringContaining("run its start line on LumiAH's Runtime page again") });
  });

  test("answered by an extension of a newer link version is refused by the runtime, in words that say to update LumiAH's side or the runtime", async () => {
    // An extension that speaks the next version and didn't refuse the hello itself.
    const host = new FakeHost();
    const lumiverse = new FakeLumiverse(host, USER);
    host.frontend.onMessage((payload, userId, session) => {
      if (!isRecord(payload) || payload.link !== LINK || payload.type !== "hello" || typeof payload.id !== "string") return;
      host.frontend.send({ link: LINK, type: "result", id: payload.id, body: { relay: "relay-1", version: LINK_VERSION + 1, build: "newer-build", lost: [], settings: 0 } }, userId, session);
    });
    const logs: string[] = [];
    const runtime = (alone = runtimeFor(lumiverse, { relay: "relay-1", secret: "a".repeat(64) }, logs));

    await expect(runtime.link.connect()).rejects.toThrow(versionWords(LINK_VERSION, LINK_VERSION + 1));

    expect(runtime.link.up).toBe(false);
    expect(runtime.link.refused).toBe(versionWords(LINK_VERSION, LINK_VERSION + 1));
    expect(runtime.link.refused).toContain("update the runtime by running its start line on LumiAH's Runtime page again");
    expect(logs).toContain(versionWords(LINK_VERSION, LINK_VERSION + 1));
    // Lumiverse's Test of the loopback connection gets the same words, not a timeout.
    const models = await runtime.fetch(new Request(`http://127.0.0.1:${PORT}/v1/models`, { headers: { authorization: "Bearer lah_any", host: `127.0.0.1:${PORT}` } }));
    expect(models.status).toBe(503);
    const body: unknown = await models.json();
    expect(isRecord(body) && isRecord(body.error) ? body.error.message : null).toBe(versionWords(LINK_VERSION, LINK_VERSION + 1));
  });
});

describe("the connection's model list", () => {
  test("is LumiAH's one model for the user's loopback key, and a refusal for any other", async () => {
    const it = (r = await rig());
    await it.setUp();
    const ask = (key: string): Promise<Response> => it.runtime.fetch(new Request(`http://127.0.0.1:${PORT}/v1/models`, { headers: { authorization: `Bearer ${key}`, host: `127.0.0.1:${PORT}` } }));
    const good: unknown = await (await ask(it.key)).json();
    expect(good).toMatchObject({ object: "list", data: [{ id: "lumiah" }] });
    const bad = await ask("lah_wrong");
    expect(bad.status).toBe(401);
  });
});

describe("a request asked while the link is down", () => {
  test("waits for the link, and its fields, given as a function, are worked out as it leaves (a document's age counts to then), not when it was asked", async () => {
    let unreachable = false;
    let tries = 0;
    const it = (r = await rig({
      wire: (lumiverse) => ({
        http: lumiverse.http,
        openSocket: (url, events) => {
          if (unreachable) {
            tries += 1;
            throw new Error("Lumiverse can't be reached");
          }
          return lumiverse.openSocket(url, events);
        },
      }),
    }));
    await it.runtime.link.connect();
    unreachable = true;
    it.lumiverse.dropSockets();
    await until(() => !it.runtime.link.up, "the link to go down");
    const worked: boolean[] = [];
    const before = tries;
    const read = it.runtime.link.request(
      "doc.get",
      () => {
        worked.push(it.runtime.link.up);
        return { path: "chats/c1/session.json" };
      },
      10_000,
    );
    await until(() => tries > before, "the link to try to come back");
    expect(worked).toEqual([]);
    unreachable = false;
    expect(await read).toMatchObject({ doc: null });
    expect(worked).toEqual([true]);
  });
});
