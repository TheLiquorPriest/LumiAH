// The asks' own road (PI-BUILD-PLAN §4.7): a page's request reaches the runtime through Lumiverse's
// proxy to its loopback server once the extension holds `cors_proxy` and the address has proved it
// is the runtime, so it doesn't wait behind the large frames the link's socket carries; else, and
// whenever the road fails, it goes over the link. The secret goes as a bearer to a proved address
// only, and nowhere else. Each crossing is in the timing log, read whole in one request.

import { describe, expect, test } from "bun:test";
import type { RoadsView } from "../../../src/shared/ui";
import { ProxyRoad } from "../../../src/extension/backend/proxy";
import type { CorsReply } from "../../../src/extension/backend/spindle";
import { roadProof } from "../../../src/link/road";
import { TRANSPORT_DEFAULTS, type TransportSettings } from "../../../src/link/settings";
import type { OpenSocket } from "../../../src/runtime/connection";
import type { FakeLumiverse } from "../../support/fake-lumiverse";
import { type Rig, rig, until, USER } from "../../support/rig";

const BASE = "http://127.0.0.1:7871";

/**
 * Lumiverse's socket to the runtime, busy: what goes to the runtime crosses in order at `perMs`
 * characters a millisecond, so a small frame waits behind the large ones before it, as on a link
 * that carries a reply's or a job's traffic.
 */
function busySocket(perMs: number) {
  return (lumiverse: FakeLumiverse) => {
    const openSocket: OpenSocket = (url, events) => {
      let free = 0;
      return lumiverse.openSocket(url, {
        message: (text) => {
          const now = Date.now();
          free = Math.max(now, free) + text.length / perMs;
          setTimeout(() => events.message(text), free - now);
        },
        close: (code, reason) => events.close(code, reason),
      });
    };
    return { http: lumiverse.http, openSocket };
  };
}

/** Large frames for the runtime's session, ahead of whatever is sent after them. */
function fill(r: Rig, frames: number, chars: number): void {
  for (let i = 0; i < frames; i++) r.host.frontend.send({ noise: "x".repeat(chars) }, USER);
}

/** A page's request, and what it came to: its answer, or the words it was refused in; and how long it took. */
async function timed(r: Rig): Promise<{ ms: number; answer: unknown; refused: string | null }> {
  const started = Date.now();
  const out = await r.page.request("lah.runtime.store", { relay: r.registration.relay }).then(
    (answer) => ({ answer, refused: null }),
    (error: unknown) => ({ answer: null, refused: error instanceof Error ? error.message : String(error) }),
  );
  return { ms: Date.now() - started, ...out };
}

/** Waits until the road reaches the rig's runtime. */
async function onTheRoad(r: Rig): Promise<void> {
  for (let i = 0; i < 500; i++) {
    if ((await r.backend.road.open(USER, r.registration.relay)) !== null) return;
    await Bun.sleep(2);
  }
  throw new Error("the road never reached the runtime");
}

async function linked(options: Parameters<typeof rig>[0] = {}): Promise<Rig> {
  const r = await rig(options);
  await r.runtime.link.connect();
  await until(() => r.backend.relays.isLinked(USER, r.registration.relay), "the runtime to link");
  return r;
}

describe("a busy link", () => {
  test("with the link's socket held busy by large frames, an ask on the proxy road answers in time, and the same ask over the link alone doesn't", async () => {
    // Real time, on purpose: what is shown is a queue on a socket, which only real time fills and drains.
    const r = await linked({ wire: busySocket(100) });
    try {
      await r.backend.settings.change(USER, [{ path: ["transport", "pages", "askMs"], value: 1_000 }], []);
      // Over the link alone: the ask waits behind 1.6 seconds of frames, and is given up at the Runtime wait, which its words name.
      fill(r, 4, 40_000);
      const alone = await timed(r);
      expect(alone.refused).toBe("The runtime didn't answer within 1 second. It may be busy or restarting: try again in a moment. Runtime wait (LumiAH's Settings → Timeouts → Waiting for the runtime) says how long a page waits for it.");
      expect(r.host.corsed).toEqual([]);
      // Granted while it runs: the address is proved, then the road is taken, and the same ask answers at once behind the same frames.
      r.host.grant("cors_proxy", true);
      await onTheRoad(r);
      fill(r, 4, 40_000);
      const proxied = await timed(r);
      expect(proxied.refused).toBeNull();
      expect(proxied.ms).toBeLessThan(1_000);
      expect(proxied.answer).toMatchObject({ state: { waiting: 0 } });
      const asks = r.host.corsed.filter((c) => c.headers.Authorization !== undefined);
      expect(asks.map((c) => c.url)).toEqual([`${BASE}/x/ask`]);
      expect(asks[0]?.headers.Authorization).toBe(`Bearer ${r.registration.secret}`);
      // The probe carried no secret; no address, body or log holds it.
      for (const c of r.host.corsed) {
        expect(c.url).not.toContain(r.registration.secret);
        expect(c.body).not.toContain(r.registration.secret);
      }
      expect(JSON.stringify([r.host.logs, r.logs, r.backend.timings.all()])).not.toContain(r.registration.secret);
      // The page's two asks, as the log keeps them (the settings' own check asks the runtime too).
      expect(r.backend.timings.all().filter((row) => row.op === "store.state").map((row) => [row.op, row.road, row.outcome])).toEqual([
        ["store.state", "link", "timeout"],
        ["store.state", "proxy", "ok"],
      ]);
    } finally {
      await r.close();
    }
  });
});

describe("which road", () => {
  test("without the permission every ask goes over the link and the Runtime page says what granting it does; granted, the page says the proxy; taken away, the link again at once", async () => {
    const r = await linked();
    try {
      expect((await timed(r)).answer).toMatchObject({ state: { waiting: 0 } });
      expect(r.host.corsed).toEqual([]);
      const before = (await r.page.request("lah.hello", { active: null })) as { runtime: { road: RoadsView } };
      expect(before.runtime.road.granted).toBe(false);
      expect(before.runtime.road.offer).toContain('Granting LumiAH the permission "cors_proxy"');
      r.host.grant("cors_proxy", true);
      await onTheRoad(r);
      expect((await timed(r)).answer).toMatchObject({ state: { waiting: 0 } });
      const after = (await r.page.request("lah.hello", { active: null })) as { runtime: { road: RoadsView } };
      expect(after.runtime.road).toMatchObject({ granted: true, offer: null, relays: { [r.registration.relay]: { road: "proxy", why: null } } });
      r.host.grant("cors_proxy", false);
      const asked = r.host.corsed.length;
      expect((await timed(r)).answer).toMatchObject({ state: { waiting: 0 } });
      expect(r.host.corsed.length).toBe(asked);
    } finally {
      await r.close();
    }
  });

  test("an ask that may wait longer than the proxy's 30 seconds goes over the link", async () => {
    const r = await linked();
    try {
      r.host.grant("cors_proxy", true);
      await onTheRoad(r);
      await r.backend.settings.change(USER, [{ path: ["transport", "pages", "askMs"], value: 45_000 }], []);
      const asked = r.host.corsed.length;
      expect((await timed(r)).answer).toMatchObject({ state: { waiting: 0 } });
      expect(r.host.corsed.length).toBe(asked);
      expect(r.backend.timings.all().at(-1)).toMatchObject({ op: "store.state", road: "link", outcome: "ok" });
    } finally {
      await r.close();
    }
  });
});

describe("when the road fails", () => {
  test("the ask goes over the link once and is answered; the failure is remembered, so the next asks don't try the road, and the page says why", async () => {
    const r = await linked();
    try {
      r.host.grant("cors_proxy", true);
      await onTheRoad(r);
      r.host.servers.delete(BASE);
      expect((await timed(r)).answer).toMatchObject({ state: { waiting: 0 } });
      expect(await r.backend.road.open(USER, r.registration.relay)).toBeNull();
      const asked = r.host.corsed.length;
      expect((await timed(r)).answer).toMatchObject({ state: { waiting: 0 } });
      expect(r.host.corsed.length).toBe(asked);
      const view = (await r.page.request("lah.hello", { active: null })) as { runtime: { road: RoadsView } };
      expect(view.runtime.road.relays[r.registration.relay]).toMatchObject({ road: "link", why: expect.stringContaining("The faster road failed (Unable to connect") });
    } finally {
      await r.close();
    }
  });

  test("past the proxy road's own wait the ask goes over the link as well, and the first answer is taken", async () => {
    const r = await linked();
    try {
      r.host.grant("cors_proxy", true);
      await onTheRoad(r);
      await r.backend.settings.change(USER, [{ path: ["transport", "pages", "proxyMs"], value: 1_000 }], []);
      // The proxy brings the runtime's answer back only after 2.5 seconds.
      const served = r.host.servers.get(BASE);
      r.host.servers.set(BASE, async (request) => {
        const answer = await served?.(request);
        await Bun.sleep(2_500);
        return answer ?? new Response(null, { status: 502 });
      });
      const out = await timed(r);
      expect(out.answer).toMatchObject({ state: { waiting: 0 } });
      expect(out.ms).toBeGreaterThanOrEqual(1_000);
      expect(out.ms).toBeLessThan(2_500);
      expect(r.backend.timings.all().at(-1)).toMatchObject({ op: "store.state", road: "link", outcome: "ok" });
    } finally {
      await r.close();
    }
  });
});

describe("the timing log", () => {
  test("one request reads both ends whole: the asks this extension sent, the requests the runtime's link sent; sizes and times, nothing of what crossed", async () => {
    const r = await linked();
    try {
      await timed(r);
      const page = await r.page.request("lah.timings.get", {});
      expect(page.extension.ops.map((o) => [o.op, o.road, o.count])).toContainEqual(["store.state", "link", 1]);
      expect(page.runtimes).toHaveLength(1);
      expect(page.runtimes[0]?.timings?.ops.map((o) => o.op)).toContain("hello");
      expect(page.runtimes[0]?.timings?.ops.find((o) => o.op === "hello")?.workMs).not.toBeNull();
      expect(JSON.stringify(page)).not.toContain(r.registration.secret);
      // Its own read crossed once: one ask of the runtime, however many rows it holds.
      expect(r.backend.timings.all().filter((row) => row.op === "timings.read")).toHaveLength(1);
    } finally {
      await r.close();
    }
  });
});

describe("the road's check of an address", () => {
  /** A road whose proxy is `cors`, to a runtime that says it listens at `listen`. */
  function roadTo(listen: string, cors: (url: string, init: { headers: Record<string, string>; body: string }) => Promise<CorsReply>) {
    const calls: { url: string; headers: Record<string, string> }[] = [];
    const road = new ProxyRoad({
      host: {
        granted: () => true,
        cors: async (url, init) => {
          calls.push({ url, headers: init.headers });
          return cors(url, init);
        },
      },
      declined: new Set(),
      address: async () => ({ listen, port: 7871 }),
      transport: async (): Promise<TransportSettings> => TRANSPORT_DEFAULTS,
      now: () => Date.now(),
      nonce: () => "0".repeat(32),
      isLinked: () => true,
      changed: () => undefined,
      name: "LumiAH",
    });
    return { road, calls };
  }

  test("a runtime that says it listens on another machine's address is never probed: the link carries its asks", async () => {
    const { road, calls } = roadTo("192.168.1.20", async () => ({ status: 200, headers: {}, body: "{}" }));
    road.heard(USER, "relay-1", "session-1", "s".repeat(64));
    expect(await road.open(USER, "relay-1")).toBeNull();
    expect(calls).toEqual([]);
    expect((await road.view(USER, [{ id: "relay-1", linked: true }])).relays["relay-1"]?.why).toContain("not on a loopback address");
  });

  test("whatever answers at the address without the proof is not the runtime: the secret is never sent there", async () => {
    const { road, calls } = roadTo("127.0.0.1", async () => ({ status: 200, headers: {}, body: JSON.stringify({ proof: await roadProof("another secret", "relay-1", "0".repeat(32)) }) }));
    road.heard(USER, "relay-1", "session-1", "s".repeat(64));
    const why = async (): Promise<string | null | undefined> => (await road.view(USER, [{ id: "relay-1", linked: true }])).relays["relay-1"]?.why;
    // The probe settles in its own time: the page says it is checking until it has.
    for (let i = 0; i < 200 && (await why())?.startsWith("Checking") !== false; i++) await Bun.sleep(1);
    expect(await road.open(USER, "relay-1")).toBeNull();
    expect(calls.length).toBeGreaterThan(0);
    for (const call of calls) expect(JSON.stringify(call)).not.toContain("s".repeat(64));
    expect(await why()).toContain("didn't prove it is this runtime");
  });
});
