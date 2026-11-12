// The working store and its mirror (PI-BUILD-PLAN §4.4): the mark in the extension's storage that
// says whose working copy it mirrors and how many changes it took from it, checked when the runtime
// is given the mirror (who holds it, and what happens around that: holder.test.ts); the forgetting
// of a deleted chat, from the working copy and from the mirror; and closing, which leaves nothing
// half done and the rest for the next start.

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { cp, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { WorkingStore } from "../../../src/runtime/store/index";
import { type Bench, bench, cleanUp, files, holding, linked, markCount, open, outcome, until } from "./rig";

let b: Bench;
/** Another machine's folder: a second runtime of the same user keeps its copy there. */
let elsewhere: string;
const opened: WorkingStore[] = [];
const keep = (store: WorkingStore): WorkingStore => {
  opened.push(store);
  return store;
};

beforeEach(async () => {
  b = await bench();
  elsewhere = await mkdtemp(join(tmpdir(), "lumiah-store-elsewhere-"));
});

afterEach(async () => {
  for (const store of opened.splice(0)) await store.close();
  await cleanUp(b);
  await rm(elsewhere, { recursive: true, force: true });
});

describe("the mark", () => {
  test("a runtime that finds its own mark carries on with its copy, and sends what it hadn't", async () => {
    const first = open(b);
    await first.settle();
    b.mirror.down = "the extension isn't linked";
    await first.store.write("chats/c1/session.json", { asked: 1 });
    await first.close();

    b.mirror.down = null;
    const again = keep(open(b));
    await again.settle();
    expect(b.mirror.doc("chats/c1/session.json")).toEqual({ asked: 1 });
    expect(again.state().takeover).toBeNull();
    expect(b.mirror.doc("mirror.json")).toMatchObject({ v: 1, kind: "mirror", owner: "runtime one" });
  });

  test("a runtime that finds another's mark throws its copy away, reads the mirror afresh and takes the mark; what it hadn't sent goes to the mirror, but an older change of a path the other runtime saved after it never lands over that save", async () => {
    const path = "chats/c1/session.json";
    const jobs = "jobs/all.json";
    const unsent = "chats/c1/learned.json";
    const one = await linked(b, "relay-a");
    await one.store.store.write(path, { asked: 1 });
    await one.store.store.write(jobs, { jobs: ["j1"] });
    await one.store.settle();
    // Its link goes, and it stops with two changes unsent: one of a path the next runtime saves after it.
    one.drop();
    await one.store.store.write(path, { asked: 2 });
    await one.store.store.write(unsent, { learned: 1 });
    await one.store.close();
    b.clock.advance(120_001);

    const two = await linked(b, "relay-b", { dir: elsewhere, owner: "runtime two" });
    keep(two.store);
    expect(await two.store.store.read(path)).toEqual({ asked: 1 });
    await two.store.store.write(path, { asked: 3 });
    await two.store.store.write(jobs, { jobs: ["j2"] });
    await two.store.settle();
    expect(two.store.state().takeover).toMatchObject({ from: "runtime one", dropped: 0 });
    await two.store.release();

    const back = await linked(b, "relay-a");
    keep(back.store);
    expect(await outcome(back.store.settle())).toContain(path);
    expect(back.store.state().takeover).toMatchObject({ from: "runtime two", dropped: 0 });
    expect([b.mirror.doc(path), b.mirror.doc(unsent)]).toEqual([{ asked: 3 }, { learned: 1 }]);
    // What its copy held of the mirror is gone: it reads runtime two's saves.
    expect([await back.store.store.read(path), await back.store.store.read(jobs)]).toEqual([{ asked: 3 }, { jobs: ["j2"] }]);
    expect(b.mirror.doc("mirror.json")).toMatchObject({ owner: "runtime one" });
    expect(b.logs.some((line) => line.level === "warn" && line.message.includes("is kept by another runtime (runtime two"))).toBe(true);
  });

  test("a copy the mirror took more from than the copy holds (a backup, or a copy elsewhere) is thrown away for the mirror's, under a new id", async () => {
    const path = "chats/c1/session.json";
    const first = open(b, { limits: () => ({ markMs: 0 }) });
    await first.store.write(path, { asked: 1 });
    await first.settle();
    await cp(b.dir, elsewhere, { recursive: true });
    await first.store.write(path, { asked: 2 });
    await first.settle();
    await until(() => markCount(b) === 2, "the mark to count both changes");
    await first.close();

    const copied = keep(open(b, { dir: elsewhere, owner: "runtime two" }));
    expect(await copied.store.read(path)).toEqual({ asked: 2 });
    expect(copied.state().takeover).toMatchObject({ from: "runtime one", dropped: 0 });
    expect(b.logs.some((line) => line.message.includes("has taken more from this runtime's copy than the copy holds"))).toBe(true);
    expect(b.mirror.doc("mirror.json")).toMatchObject({ owner: "runtime two", count: 0 });
  });

  test("a mirror that lost its mark while this copy holds something: the copy is thrown away for the mirror's", async () => {
    const path = "chats/c1/session.json";
    const first = open(b);
    await first.store.write(path, { asked: 1 });
    await first.settle();
    await first.close();
    b.mirror.docs.delete("mirror.json");
    b.mirror.docs.set(path, JSON.stringify({ asked: 9 }));

    const again = keep(open(b));
    expect(await again.store.read(path)).toEqual({ asked: 9 });
    expect(again.state().takeover).toMatchObject({ from: null, dropped: 0 });
  });

  test("operations wait until the mirror has been reached once, and say why in plain words when it can't be", async () => {
    b.mirror.down = "the extension isn't linked";
    const s = keep(open(b));
    const reading = s.store.read("workspace/user.json");
    await until(() => s.state().lastError !== null, "the first try");
    expect(s.state().open).toBe(false);
    b.clock.advance(60_000);
    await expect(reading).rejects.toThrow(
      "The runtime's store hasn't reached the extension's storage since it was given it (the extension isn't linked), so it can't yet tell whether the copy it holds is still the one the extension keeps. Try again once the runtime is linked.",
    );

    b.mirror.down = null;
    b.clock.advance(60_000);
    await until(() => s.state().open, "the store to open");
    expect(await s.store.read("workspace/user.json")).toBeNull();
  });

  test("an operation that waits out the Storage wait (for the extension's word, for the copy to be checked, or for what a copy lost hadn't sent) names that setting and where it is changed", async () => {
    const owner = { name: "LumiRPEngine", settingsAt: "LumiRPEngine's Harness tab → System → Settings" };
    const limits = (): { waitMs: number } => ({ waitMs: 2_000 });
    const lost = keep(open(b, { limits, waitsOwner: () => owner }));
    await lost.settle();
    b.mirror.down = "the extension isn't linked";
    await lost.store.write("chats/c1/session.json", { turns: 1 });
    lost.heard({ held: false, holder: "runtime two", gen: 0 });
    const unsaid = keep(open(b, { dir: elsewhere, word: "none", limits, waitsOwner: () => owner }));
    const given = keep(open(b, { dir: `${elsewhere}/given`, limits, waitsOwner: () => owner }));
    const waits = [lost, unsaid, given].map((s) => outcome(s.store.read("workspace/user.json")));
    b.clock.advance(2_000);
    for (const words of await Promise.all(waits)) {
      expect(words).toContain("Storage wait");
      expect(words).toContain(owner.settingsAt);
    }
  });
});

describe("forgetting a chat", () => {
  test("removes the chat's documents from the working copy and the mirror, and nothing of another chat's", async () => {
    const stored: Record<string, unknown> = {
      "chats/c1/learned.json": { v: 1 },
      "chats/c1/area/root.json": { v: 1 },
      "chats/c10/learned.json": { v: 1 },
      "recall/vectors/space-1/chat/c1/0a.json": { vectors: 1 },
      "recall/vectors/space-1/chat/c2/0a.json": { vectors: 1 },
      "recall/vectors/space-1/book/c1/0a.json": { vectors: 1 },
    };
    for (const [path, doc] of Object.entries(stored)) b.mirror.docs.set(path, JSON.stringify(doc));
    const s = keep(open(b));
    // The working copy holds one of the chat's documents the mirror has lost since, and one the mirror hasn't had yet.
    expect(await s.store.read("chats/c1/learned.json")).toEqual({ v: 1 });
    b.mirror.docs.delete("chats/c1/learned.json");
    const held = holding(b.mirror, (what) => what === "write chats/c1/approvals.json");
    await s.store.write("chats/c1/approvals.json", { tools: ["web_search"] });
    await held.reached;

    const forgetting = s.forget("c1");
    held.go();
    expect(await forgetting).toEqual({ documents: 4 });
    expect([...b.mirror.docs.keys()].sort()).toEqual(["chats/c10/learned.json", "mirror.json", "recall/vectors/space-1/book/c1/0a.json", "recall/vectors/space-1/chat/c2/0a.json"]);
    expect((await files(b.dir)).filter((file) => file.includes("/docs/chats/c1/") || file.includes("/journal/"))).toEqual([]);
    expect(await s.store.read("chats/c1/approvals.json")).toBeNull();
    expect(await s.store.read("chats/c10/learned.json")).toEqual({ v: 1 });
  });

  test("while the mirror can't be reached, the chat leaves the working copy at once and the mirror once it is back", async () => {
    b.mirror.docs.set("chats/c1/learned.json", "{}");
    const s = keep(open(b));
    expect(await s.store.read("chats/c1/learned.json")).toEqual({});
    b.mirror.down = "the extension isn't linked";
    await expect(s.forget("c1")).rejects.toThrow("the extension isn't linked");
    expect(await s.store.read("chats/c1/learned.json")).toBeNull();

    b.mirror.down = null;
    await s.settle();
    expect(b.mirror.doc("chats/c1/learned.json")).toBeNull();
    expect(await s.forget("c1")).toEqual({ documents: 0 });
  });
});

describe("closing", () => {
  test("close finishes what was under way on the disk, begins nothing more, and leaves the rest for the next start", async () => {
    const s = open(b);
    await s.settle();
    b.mirror.down = "the extension isn't linked";
    await s.store.write("chats/c1/session.json", { asked: 1 });
    // Their outcomes are taken as they come: each ends only once the store closes.
    const waiting = outcome(s.settle());
    const writing = outcome(s.store.write("jobs/all.json", { jobs: ["j1"] }));
    await s.close();
    expect(await waiting).toBe("The runtime's store closed before the extension's storage had everything: what it hadn't sent waits on the runtime's disk and goes there when the runtime starts again.");
    expect(await writing).toBe("The runtime's store is closed: the runtime is stopping.");
    await expect(s.store.read("chats/c1/session.json")).rejects.toThrow("The runtime's store is closed: the runtime is stopping.");

    const onDisk = await files(b.dir);
    expect(onDisk.filter((file) => file.includes("/tmp/"))).toEqual([]);
    expect(onDisk.filter((file) => file.includes("/journal/"))).toHaveLength(1);
    expect(onDisk.some((file) => file.endsWith("/docs/jobs/all.json"))).toBe(false);

    b.mirror.down = null;
    const again = keep(open(b));
    await again.settle();
    expect(b.mirror.doc("chats/c1/session.json")).toEqual({ asked: 1 });
    expect(b.mirror.doc("jobs/all.json")).toBeNull();
  });

  test("close doesn't wait on a send the mirror holds, and changes nothing on the disk when it lands", async () => {
    const path = "chats/c1/session.json";
    const s = open(b);
    await s.settle();
    const held = holding(b.mirror, (what) => what === `write ${path}`);
    await s.store.write(path, { asked: 1 });
    await held.reached;
    await s.close();
    const before = await files(b.dir);
    expect(before.filter((file) => file.includes("/journal/"))).toHaveLength(1);
    held.go();
    await until(() => b.mirror.took.includes(`write ${path}`), "the held send to land");
    expect(await files(b.dir)).toEqual(before);

    b.mirror.hold = null;
    const again = keep(open(b));
    await again.settle();
    // Sent again: only the runtime that saw it land could have known it did.
    expect(b.mirror.took.filter((change) => change === `write ${path}`)).toHaveLength(2);
    expect((await files(b.dir)).filter((file) => file.includes("/journal/"))).toEqual([]);
  });
});
