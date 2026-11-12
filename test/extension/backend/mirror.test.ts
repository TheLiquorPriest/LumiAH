// Which runtime holds each user's mirror, as the extension decides it (backend/mirror.ts): what it
// keeps, what it refuses and in what words, whom it tells of what, and for whom. How the runtimes'
// stores take its word is in test/runtime/store/holder.test.ts.

import { describe, expect, test } from "bun:test";
import type { LinkPush, MirrorAsk } from "../../../src/link/contract";
import { Mirrors } from "../../../src/extension/backend/mirror";
import type { Caller } from "../../../src/extension/backend/relays";
import { LinkRefused } from "../../../src/host/refused";

const ID = (n: number): string => n.toString(16).padStart(32, "0");

/** The extension's part, over storage kept in memory and a clock that moves when told; what it pushes, to which session. */
function arbiter() {
  const files = new Map<string, string>();
  const pushed: { session: string; push: LinkPush }[] = [];
  let now = 1_700_000_000_000;
  const storage = {
    read: async (path: string, userId: string) => files.get(`${userId}/${path}`) ?? null,
    write: async (path: string, text: string, userId: string) => void files.set(`${userId}/${path}`, text),
    remove: async (path: string, userId: string) => void files.delete(`${userId}/${path}`),
    stat: async () => null,
    list: async () => [],
  };
  const made = (): Mirrors => new Mirrors({ storage, log: () => undefined }, { now: () => now, quietMs: async () => 120_000, send: (push, _userId, session) => void pushed.push({ session, push }), name: "LumiAH" });
  return {
    files,
    pushed,
    mirrors: made(),
    restart() {
      this.mirrors = made();
    },
    advance(ms: number) {
      now += ms;
    },
  };
}

const caller = (userId: string, relay: string, session: string): Caller => ({ userId, relay: { id: relay, name: relay, secret: "", build: "", host: "", listen: "127.0.0.1", port: 1, registeredAt: 0, report: null }, session });
const ask = (copy: number, process: number, more: Partial<MirrorAsk> = {}): MirrorAsk => ({ copy: ID(copy), process: ID(process), asks: true, seen: 0, ...more });
const done = async (): Promise<void> => undefined;

describe("who holds the mirror", () => {
  test("is kept in the user's storage before the hello is answered, per user: each user's first runtime holds that user's", async () => {
    const it = arbiter();
    expect(await it.mirrors.hello(caller("mara", "relay-a", "s1"), ask(1, 2), null)).toEqual({ held: true, holder: null, gen: 0 });
    expect(JSON.parse(it.files.get("mara/mirror-holder.json") ?? "null")).toEqual({ v: 1, holder: { relay: "relay-a", copy: ID(1), process: ID(2), owner: "relay-a" }, gen: 0 });
    expect(await it.mirrors.hello(caller("joss", "relay-j", "s2"), ask(3, 4), null)).toMatchObject({ held: true });
    expect(await it.mirrors.hello(caller("mara", "relay-b", "s3"), ask(5, 6), null)).toEqual({ held: false, holder: "relay-a", gen: 0 });
    // A runtime that keeps no copy, or doesn't ask, is told who holds it, and nothing changes.
    expect(await it.mirrors.hello(caller("mara", "relay-c", "s4"), null, null)).toEqual({ held: false, holder: "relay-a", gen: 0 });
    expect(await it.mirrors.hello(caller("mara", "relay-a", "s5"), ask(1, 9, { asks: false }), null)).toMatchObject({ held: false });
  });

  test("refuses for good, in words that say what happened, a write of a copy whose process doesn't hold the mirror; takes a runtime's own write and tells the holder of each path, never of a blob stored again", async () => {
    const it = arbiter();
    await it.mirrors.hello(caller("mara", "relay-a", "s1"), ask(1, 2), null);
    await it.mirrors.hello(caller("mara", "relay-b", "s2"), ask(3, 4), null);
    const refused = await it.mirrors.write(caller("mara", "relay-b", "s2"), ID(4), { docs: ["jobs/all.json"], blobs: [] }, done).then(
      () => null,
      (error: unknown) => error,
    );
    expect(refused).toBeInstanceOf(LinkRefused);
    expect(refused).toMatchObject({ code: "conflict", message: "Another runtime (relay-a) keeps LumiAH's storage now, so LumiAH takes nothing from this runtime's own copy of it: this runtime reads and writes the storage directly from now on." });
    await expect(it.mirrors.write(caller("mara", "relay-b", "s2"), undefined, { docs: ["mirror.json"], blobs: [] }, done)).rejects.toMatchObject({ code: "bad_request" });

    it.pushed.length = 0;
    let applied = 0;
    await it.mirrors.write(caller("mara", "relay-b", "s2"), undefined, { docs: ["jobs/all.json"], blobs: [] }, async () => void applied++);
    await it.mirrors.write(caller("mara", "relay-b", "s2"), undefined, { docs: [], blobs: [] }, async () => void applied++);
    await it.mirrors.write(caller("mara", "relay-a", "s1"), ID(2), { docs: ["sides.json"], blobs: [] }, async () => void applied++);
    expect(applied).toBe(3);
    expect(it.pushed).toEqual([{ session: "s1", push: { link: "lumiah-link", type: "mirror", held: true, holder: null, gen: 0, dropped: { docs: ["jobs/all.json"], blobs: [], all: false } } }]);
  });

  test("a holder that may have missed being told (its link went after a push, or was down for a change) is told to drop everything at its next hello, once", async () => {
    const it = arbiter();
    await it.mirrors.hello(caller("mara", "relay-a", "s1"), ask(1, 2), null);
    await it.mirrors.hello(caller("mara", "relay-b", "s2"), ask(3, 4), null);
    await it.mirrors.write(caller("mara", "relay-b", "s2"), undefined, { docs: ["jobs/all.json"], blobs: [] }, done);
    it.mirrors.sessionClosed("s1");
    await it.mirrors.settle();
    const back = await it.mirrors.hello(caller("mara", "relay-a", "s5"), ask(1, 2), null);
    expect(back).toEqual({ held: true, holder: null, gen: 1, dropped: { docs: [], blobs: [], all: true } });
    expect(await it.mirrors.hello(caller("mara", "relay-a", "s6"), ask(1, 2, { seen: 1 }), null)).toEqual({ held: true, holder: null, gen: 1 });
  });

  test("started again, it holds the mirror for the runtime that held it: another's hello within the allowance doesn't take it, the holder's does; a hello moving it tells the others", async () => {
    const it = arbiter();
    await it.mirrors.hello(caller("mara", "relay-a", "s1"), ask(1, 2), null);
    it.restart();
    expect(await it.mirrors.hello(caller("mara", "relay-b", "s2"), ask(3, 4), null)).toMatchObject({ held: false, holder: "relay-a" });
    // Its own write before its hello is taken: the kept record names its process.
    await it.mirrors.write(caller("mara", "relay-a", "s1"), ID(2), { docs: ["jobs/all.json"], blobs: [] }, done);
    expect(await it.mirrors.hello(caller("mara", "relay-a", "s1"), ask(1, 2), null)).toMatchObject({ held: true });
    // Started again on its folder (another process, the same copy): at once, and the others are told.
    it.pushed.length = 0;
    expect(await it.mirrors.hello(caller("mara", "relay-a", "s7"), ask(1, 8), null)).toMatchObject({ held: true });
    expect(it.pushed.map((one) => one.session).sort()).toEqual(["s1", "s2"]);
    expect(it.pushed[0]?.push).toMatchObject({ type: "mirror", held: false, holder: "relay-a" });
    it.advance(120_001);
    expect(await it.mirrors.hello(caller("mara", "relay-b", "s2"), ask(3, 4), null)).toMatchObject({ held: true });
    expect(await it.mirrors.release(caller("mara", "relay-a", "s7"), ID(8))).toBe(false);
    expect(await it.mirrors.release(caller("mara", "relay-b", "s2"), ID(4))).toBe(true);
    expect(JSON.parse(it.files.get("mara/mirror-holder.json") ?? "null")).toMatchObject({ holder: null });
  });

  test("refuses as superseded, and doesn't do, a working copy's write of a document made before another runtime's later write of it, as it knows them while it runs; one with no age, one of the same runtime's, and one after it starts again are done as they come", async () => {
    const it = arbiter();
    const path = "chats/c1/session.json";
    const applied: string[] = [];
    const write = (relay: string, session: string, mark: string | undefined, what: string, ago?: number): Promise<string> =>
      it.mirrors.write(caller("mara", relay, session), mark, { docs: [path], blobs: [] }, async () => void applied.push(what), ago).then(
        () => "done",
        (error: unknown) => (error instanceof LinkRefused ? error.code : String(error)),
      );
    await it.mirrors.hello(caller("mara", "relay-a", "s1"), ask(1, 2), null);
    await it.mirrors.hello(caller("mara", "relay-b", "s2"), ask(3, 4), null);
    // The holder's change made 30 s ago, another runtime's save 10 s ago: the holder's gives way.
    it.advance(20_000);
    expect(await write("relay-b", "s2", undefined, "b at 20 s")).toBe("done");
    it.advance(10_000);
    expect(await write("relay-a", "s1", ID(2), "a made at 0 s", 30_000)).toBe("superseded");
    // Made after it, the holder's stands; and its own older change never gives way to it.
    expect(await write("relay-a", "s1", ID(2), "a made at 25 s", 5_000)).toBe("done");
    expect(await write("relay-a", "s1", ID(2), "a made at 22 s", 8_000)).toBe("done");
    // A write that says no age is made now, as before.
    expect(await write("relay-b", "s2", undefined, "b now")).toBe("done");
    expect(await write("relay-a", "s1", undefined, "a now")).toBe("done");
    // A runtime that lost the mirror writes what it hadn't sent as its own: given way where another's later save stands.
    expect(await write("relay-b", "s2", undefined, "b made at 1 s", 29_000)).toBe("superseded");
    // Started again, it knows of no write: one made long before is done.
    it.restart();
    expect(await write("relay-b", "s2", undefined, "b made at 2 s, after a restart", 28_000)).toBe("done");
    expect(applied).toEqual(["b at 20 s", "a made at 25 s", "a made at 22 s", "b now", "a now", "b made at 2 s, after a restart"]);
  });
});
