// The runtime's road for asks (`POST /x/ask`, src/runtime/asks.ts): only the relay's secret opens
// it, compared without saying anything of it; a probe carrying no secret is answered with a proof
// bound to it; every refusal is in fixed words that say nothing of the request; an ask is done once,
// whichever road brings it; an answer too large for Lumiverse's proxy is kept for the link. And the
// runtime's HTTP to Lumiverse is held to its Lumiverse wait.

import { describe, expect, test } from "bun:test";
import { linkedBackendOf } from "../../src/link/frames";
import type { JsonObject, JsonValue } from "../../src/link/json";
import { PROBE_HEADER, PROXY_MAX_BYTES, roadProof, TOO_LARGE_STATUS } from "../../src/link/road";
import { OpRefused } from "../../src/link/work";
import { AskDesk } from "../../src/runtime/asks";
import { type HttpReply, timedHttp } from "../../src/runtime/lumiverse";

const SECRET = "a".repeat(64);
const RELAY = "relay-mara";

/** A desk whose answers a test scripts, counting each op it was asked to do. */
function desk(answer: (op: string, args: JsonObject) => Promise<JsonValue> = async () => ({ files: [] })) {
  const done: string[] = [];
  const logs: string[] = [];
  const asks = new AskDesk({
    relay: RELAY,
    secret: () => SECRET,
    now: () => Date.now(),
    log: (text) => void logs.push(text),
    knows: (op) => op !== "nothing.here",
    answer: async (op, args) => {
      done.push(op);
      return answer(op, args);
    },
  });
  return { asks, done, logs };
}

const ask = (body: unknown, headers: Record<string, string> = { Authorization: `Bearer ${SECRET}` }): Request => new Request("http://127.0.0.1:7871/x/ask", { method: "POST", headers: { "Content-Type": "application/json", ...headers }, body: JSON.stringify(body) });
const BODY = { ask: "0123456789abcdef", op: "workspace.list", args: { area: "user", secretWord: "kestrel" }, where: { relay: RELAY } };

describe("the bearer", () => {
  test("only the relay's secret opens the road, and a refusal says nothing of what was asked", async () => {
    const { asks, done } = desk();
    const shown: Record<string, string>[] = [{}, { Authorization: "Bearer lah_" + "0".repeat(64) }, { Authorization: `Bearer ${SECRET}x` }, { Authorization: `Basic ${SECRET}` }];
    for (const headers of shown) {
      const res = await asks.fetch(ask(BODY, headers));
      expect(res.status).toBe(401);
      const text = await res.text();
      expect(text).not.toContain("kestrel");
      expect(text).not.toContain("workspace.list");
      expect(text).not.toContain(SECRET);
    }
    expect(done).toEqual([]);
    const ok = await asks.fetch(ask(BODY));
    expect(ok.status).toBe(200);
    expect(await ok.json()).toMatchObject({ value: { files: [] }, refusal: null });
    expect(done).toEqual(["workspace.list"]);
  });

  test("anything but an ask it answers is refused in fixed words: another method, an op it has no name for, an ask for another runtime, a body that isn't one", async () => {
    const { asks, done } = desk();
    const get = await asks.fetch(new Request("http://127.0.0.1:7871/x/ask", { method: "GET", headers: { Authorization: `Bearer ${SECRET}` } }));
    expect(get.status).toBe(405);
    const unknown = await asks.fetch(ask({ ...BODY, op: "nothing.here" }));
    expect(unknown.status).toBe(400);
    expect(await unknown.text()).not.toContain("nothing.here");
    expect((await asks.fetch(ask({ ...BODY, where: { relay: "relay-other" } }))).status).toBe(409);
    expect((await asks.fetch(ask({ ...BODY, ask: "not hex" }))).status).toBe(400);
    expect(done).toEqual([]);
  });
});

describe("the probe", () => {
  test("a nonce, with no secret, is answered with a proof only the secret's holder can make", async () => {
    const { asks, done } = desk();
    const nonce = "f".repeat(32);
    const res = await asks.fetch(new Request("http://127.0.0.1:7871/x/ask", { method: "POST", headers: { [PROBE_HEADER]: nonce }, body: "{}" }));
    expect(res.status).toBe(200);
    const { proof } = (await res.json()) as { proof: string };
    expect(proof).toBe(await roadProof(SECRET, RELAY, nonce));
    expect(proof).not.toBe(await roadProof("b".repeat(64), RELAY, nonce));
    expect(proof).not.toContain(SECRET);
    expect((await asks.fetch(new Request("http://127.0.0.1:7871/x/ask", { method: "POST", headers: { [PROBE_HEADER]: "not-a-nonce" }, body: "{}" }))).status).toBe(400);
    expect(done).toEqual([]);
  });
});

describe("one ask, done once", () => {
  test("the same ask sent again over the link joins it while it runs, and is answered from it once it is over", async () => {
    const called = Promise.withResolvers<void>();
    const held = Promise.withResolvers<JsonValue>();
    const { asks, done } = desk(() => {
      called.resolve();
      return held.promise;
    });
    const proxied = asks.fetch(ask({ ...BODY, op: "workspace.write" }));
    await called.promise;
    const linked = asks.run(BODY.ask, "workspace.write", {}, "link");
    held.resolve({ written: true });
    expect((await (await proxied).json()) as unknown).toMatchObject({ value: { written: true } });
    expect(await linked).toMatchObject({ value: { written: true }, refusal: null });
    expect(await asks.run(BODY.ask, "workspace.write", {}, "link")).toMatchObject({ value: { written: true } });
    expect(done).toEqual(["workspace.write"]);
  });

  test("an answer too large for the proxy is kept, and the link's ask for it is answered from it", async () => {
    const big = "x".repeat(PROXY_MAX_BYTES);
    const { asks, done } = desk(async () => ({ text: big }));
    const res = await asks.fetch(ask({ ...BODY, op: "workspace.read" }));
    expect(res.status).toBe(TOO_LARGE_STATUS);
    expect((await res.text()).length).toBeLessThan(1000);
    const again = await asks.run(BODY.ask, "workspace.read", {}, "link");
    expect(JSON.stringify(again.value).length).toBe(JSON.stringify({ text: big }).length);
    expect(done).toEqual(["workspace.read"]);
  });

  test("a refusal crosses as the core gave it, and an ask's args reach no log", async () => {
    const { asks, logs } = desk(async () => {
      throw new OpRefused("conflict", "That file changed since you read it.");
    });
    const res = await asks.fetch(ask(BODY));
    expect(await res.json()).toMatchObject({ value: null, refusal: { code: "conflict", message: "That file changed since you read it." } });
    const failing = desk(async () => {
      throw new Error("disk full");
    });
    await failing.asks.fetch(ask(BODY));
    expect(failing.logs.join("\n")).toContain("workspace.list failed: disk full");
    expect([...logs, ...failing.logs].join("\n")).not.toContain("kestrel");
  });
});

describe("the runtime's HTTP to Lumiverse", () => {
  test("each request is given up at the Lumiverse wait, in words that name it; a longer wait lets it finish", async () => {
    // A real timer, briefly: the deadline under test is the runtime's own clock, which nothing here can move by hand.
    let wait = 30;
    const slow = timedHttp(
      () => {
        const late = Promise.withResolvers<HttpReply>();
        setTimeout(() => late.resolve({ status: 200, header: () => null, text: "{}" }), 120);
        return late.promise;
      },
      () => wait,
      () => linkedBackendOf(null),
    );
    const started = Date.now();
    const failed = await slow({ method: "GET", url: "http://127.0.0.1:7860/api/v1/spindle", headers: {} }).then(
      () => null,
      (error: unknown) => (error instanceof Error ? error.message : String(error)),
    );
    expect(Date.now() - started).toBeLessThan(110);
    expect(failed).toBe("Lumiverse didn't answer within 30 ms. Lumiverse wait (LumiAH's Settings → Timeouts → The link) says how long the runtime waits for it.");
    wait = 1_000;
    expect((await slow({ method: "GET", url: "http://127.0.0.1:7860/api/v1/spindle", headers: {} })).status).toBe(200);
  });

  test("linked to an extension that shows LumiAH's Settings elsewhere, the words say where, as its hello said", async () => {
    // What the hello said of the backend, as it crossed: the words are made from it when the wait runs out (the runtime's own clock again, as above: 20 ms of it each time).
    let said: unknown = { name: "LumiRPEngine", connection: "LumiRPEngine" };
    const slow = timedHttp(
      () => new Promise<HttpReply>(() => {}),
      () => 20,
      () => linkedBackendOf(said),
    );
    const words = (): Promise<string> => slow({ method: "GET", url: "http://127.0.0.1:7860/api/v1/spindle", headers: {} }).then(
      () => "",
      (error: unknown) => (error instanceof Error ? error.message : String(error)),
    );
    expect(await words()).toBe("Lumiverse didn't answer within 20 ms. Lumiverse wait (LumiRPEngine's Settings → Timeouts → The link) says how long the runtime waits for it.");
    said = { name: "LumiRPEngine", connection: "LumiRPEngine", settingsAt: "LumiRPEngine's Harness tab → System → Settings" };
    expect(await words()).toBe("Lumiverse didn't answer within 20 ms. Lumiverse wait (LumiRPEngine's Harness tab → System → Settings → Timeouts → The link) says how long the runtime waits for it.");
  });
});
