// Who holds the mirror (PI-BUILD-PLAN §4.4 and its log, 12 Nov 17:52Z): the extension decides, at
// each hello (backend/mirror.ts, the real one, on the bench: rig.ts `linked`), and one runtime at a
// time keeps a working copy; any other works straight on the mirror. The review's sequences for its
// findings 1 and 2; two runtimes taking turns; one gone silent that comes back after another took the
// mirror; the extension started again; a copy restored from a backup; another runtime's changes
// reaching the holder's next read, told at once or on its next hello; letting the mirror go; and a
// crash at each step of taking the mirror and of losing it.

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { cp, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { textHash } from "../../../src/core/hash";
import type { JsonValue } from "../../../src/core/ports";
import { type Bench, bench, cleanUp, Cut, cutDisk, files, holderRelay, holding, type Linked, linked, markCount, open, outcome, stopping, until } from "./rig";

let b: Bench;
/** Another machine's folder, and a backup's. */
let elsewhere: string;
let backup: string;
const started: Linked[] = [];
const run = (runtime: Linked): Linked => {
  started.push(runtime);
  return runtime;
};

beforeEach(async () => {
  b = await bench();
  elsewhere = await mkdtemp(join(tmpdir(), "lumiah-store-elsewhere-"));
  backup = await mkdtemp(join(tmpdir(), "lumiah-store-backup-"));
});

afterEach(async () => {
  for (const runtime of started.splice(0)) await runtime.store.close();
  await cleanUp(b);
  await rm(elsewhere, { recursive: true, force: true });
  await rm(backup, { recursive: true, force: true });
});

const warnings = (): string[] => b.logs.filter((line) => line.level === "warn").map((line) => line.message);

describe("one runtime at a time keeps a copy", () => {
  test("review finding 1: one linked while another holds the mirror works straight on the storage; neither writes over the other's newer save, each reads the other's, and nothing either saves is dropped", async () => {
    const path = "jobs/all.json";
    const a = run(await linked(b, "relay-a"));
    await a.store.store.write(path, { by: "A", n: 1 });
    await a.store.settle();
    const two = run(await linked(b, "relay-b", { dir: elsewhere, owner: "runtime two" }));
    expect(two.store.state()).toMatchObject({ mode: "direct", holder: "relay-a", takeover: null });

    await two.store.store.write(path, { by: "B", n: 2 });
    expect(b.mirror.doc(path)).toEqual({ by: "B", n: 2 });
    // The extension told the holder of it as it took it: the holder's next read is the storage's.
    expect(await a.store.store.read(path)).toEqual({ by: "B", n: 2 });
    await a.store.store.write(path, { by: "A", n: 3 });
    await a.store.settle();
    expect(b.mirror.doc(path)).toEqual({ by: "A", n: 3 });
    expect(await two.store.store.read(path)).toEqual({ by: "A", n: 3 });

    // Two minutes go by, both heard from, each saving what only it saves: neither takes the mirror from the other, nor drops a thing.
    await a.store.store.write("chats/c1/a-only.json", { by: "A" });
    await two.store.store.write("chats/c1/b-only.json", { by: "B" });
    for (let n = 0; n < 4; n++) {
      b.clock.advance(30_000);
      await b.arbiter.mirrors.pinged("reader", "relay-a");
    }
    expect(await two.hello()).toMatchObject({ held: false, holder: "relay-a" });
    await a.store.settle();
    expect([b.mirror.doc("chats/c1/a-only.json"), b.mirror.doc("chats/c1/b-only.json")]).toEqual([{ by: "A" }, { by: "B" }]);
    expect(a.store.state()).toMatchObject({ mode: "held", waiting: 0, takeover: null, lost: null });
    expect(two.store.state()).toMatchObject({ mode: "direct", lost: null });
    expect(warnings()).toEqual([]);
  });

  test("two runtimes taking turns: each save, removal and stored text of one is what the other reads next", async () => {
    const a = run(await linked(b, "relay-a"));
    const two = run(await linked(b, "relay-b", { dir: elsewhere }));
    const path = "chats/c1/session.json";
    for (let n = 1; n <= 6; n += 2) {
      await a.store.store.write(path, { turns: n });
      await a.store.settle();
      expect(await two.store.store.read(path)).toEqual({ turns: n });
      await two.store.store.write(path, { turns: n + 1 });
      expect(await a.store.store.read(path)).toEqual({ turns: n + 1 });
    }
    // A removal by the one without a copy reaches the holder's next read too, of a document and of a stored text.
    const text = "A segment of the second turn.";
    const hash = await textHash(text);
    await a.store.blobs.put(hash, text);
    await a.store.settle();
    expect(await a.store.blobs.get(hash)).toBe(text);
    await two.store.store.remove(path);
    await two.store.blobs.remove([hash]);
    expect(await a.store.store.read(path)).toBeNull();
    expect(await a.store.blobs.get(hash)).toBeNull();
    expect(b.mirror.took.filter((change) => change === `write ${path}`)).toHaveLength(6);
    expect(warnings()).toEqual([]);
  });

  test("review finding 1: a runtime silent past the link's allowance loses the mirror to the next one that says hello; back, what it saved and hadn't sent reaches the storage first, but for a path the other saved after it (dropped, named, counted, and a settle told), and it works straight on the storage, never asking for the mirror again", async () => {
    const path = "chats/c1/session.json";
    const own = "chats/c1/learned.json";
    const a = run(await linked(b, "relay-a"));
    await a.store.store.write(path, { turns: 1 });
    await a.store.settle();
    // Its link goes (the machine sleeps): what it saves is acknowledged, and waits on its disk.
    a.drop();
    await a.store.store.write(path, { turns: 2 });
    await a.store.store.write(own, { learned: 1 });

    // Not yet past the allowance: another runtime that says hello now works without a copy.
    b.clock.advance(60_000);
    const early = run(await linked(b, "relay-c", { dir: backup }));
    expect(early.store.state().mode).toBe("direct");
    b.clock.advance(60_001);
    const two = run(await linked(b, "relay-b", { dir: elsewhere, owner: "runtime two" }));
    await two.store.settle();
    expect(two.store.state()).toMatchObject({ mode: "held", takeover: { from: "runtime one", dropped: 0 } });
    expect(await two.store.store.read(path)).toEqual({ turns: 1 });
    // Saved after runtime one's save of the same path: the later stands.
    await two.store.store.write(path, { turns: 3 });
    await two.store.settle();

    // A settle that waits for what it saved meanwhile is told what became of it.
    const waited = outcome(a.store.settle());
    expect(await a.hello()).toMatchObject({ held: false, holder: "relay-b" });
    expect(await waited).toContain(path);
    expect(b.mirror.doc(path)).toEqual({ turns: 3 });
    expect(b.mirror.doc(own)).toEqual({ learned: 1 });
    // The holder was told of it as the storage took it: its next read is the storage's.
    expect(await two.store.store.read(own)).toEqual({ learned: 1 });
    expect(await a.store.store.read(path)).toEqual({ turns: 3 });
    expect(a.store.state()).toMatchObject({ mode: "direct", holder: "relay-b", waiting: 0, lost: { to: "relay-b", dropped: 1 } });
    expect(a.store.state().refused.map((one) => one.name)).toEqual([path]);
    expect(warnings().filter((line) => line.includes(path) && line.includes("dropped"))).toHaveLength(1);
    expect(warnings().filter((line) => line.includes(own) && line.includes("dropped"))).toEqual([]);
    expect(await outcome(a.store.settle())).toBe("done");

    // It saves straight on the storage now, and the holder reads that next.
    await a.store.store.write(path, { turns: 4 });
    expect(await two.store.store.read(path)).toEqual({ turns: 4 });
    // Never again in this process: the holder silent past the allowance, it still doesn't ask.
    expect((await a.store.ask())?.asks).toBe(false);
    b.clock.advance(200_000);
    expect(await a.hello()).toMatchObject({ held: false });
    expect(holderRelay(b)).toBe("relay-b");
    await a.store.close();
    expect((await files(b.dir)).filter((file) => file.includes("/journal/") || file.includes("/docs/"))).toEqual([]);
  });

  test("review finding 1, the second road: a runtime off past the allowance with saves unsent starts again without the mirror, sends them straight before anything else (but for a path another runtime saved after them), and holds the mirror again later with nothing of either lost", async () => {
    const path = "chats/c1/session.json";
    const own = "chats/c1/learned.json";
    const a = run(await linked(b, "relay-a"));
    await a.store.store.write(path, { turns: 1 });
    await a.store.settle();
    a.drop();
    await a.store.store.write(path, { turns: 2 });
    await a.store.store.write(own, { learned: 1 });
    // The process stops: its journal holds both.
    await a.store.close();
    b.clock.advance(120_001);
    const two = run(await linked(b, "relay-b", { dir: elsewhere, owner: "runtime two" }));
    await two.store.store.write(path, { turns: 3 });
    await two.store.settle();

    const again = run(await linked(b, "relay-a"));
    expect(again.store.state().mode).toBe("direct");
    expect(await again.store.store.read(own)).toEqual({ learned: 1 });
    expect([b.mirror.doc(path), b.mirror.doc(own)]).toEqual([{ turns: 3 }, { learned: 1 }]);
    expect(again.store.state().refused.map((one) => one.name)).toEqual([path]);
    expect(warnings().filter((line) => line.includes(path) && line.includes("dropped"))).toHaveLength(1);
    // The first settle after it is told; the next isn't held up by it.
    expect(await outcome(again.store.settle())).toContain(path);
    expect(await outcome(again.store.settle())).toBe("done");

    // Given the mirror again (runtime two lets it go): it throws its copy away for the storage's.
    await two.store.release();
    expect(await again.hello()).toMatchObject({ held: true });
    await again.store.settle();
    expect(again.store.state()).toMatchObject({ mode: "held", waiting: 0, takeover: { from: "runtime two", dropped: 0 } });
    expect(await again.store.store.read(path)).toEqual({ turns: 3 });
    expect(await again.store.store.read(own)).toEqual({ learned: 1 });
    expect([b.mirror.doc(path), b.mirror.doc(own)]).toEqual([{ turns: 3 }, { learned: 1 }]);
  });

  test("review finding 2: the holder's save of a path, unsent while its link was down, gives way to another runtime's later save of it: the later stands, the holder's is dropped, named and told to a settle, and its copy reads the later one", async () => {
    const path = "chats/c1/session.json";
    const a = run(await linked(b, "relay-a"));
    const two = run(await linked(b, "relay-b", { dir: elsewhere }));
    await a.store.store.write(path, { n: 0 });
    await a.store.settle();
    await two.store.store.write(path, { n: 1 });
    a.drop();
    await a.store.store.write(path, { n: 2 });
    b.clock.advance(10_000);
    await two.store.store.write(path, { n: 3 });
    const waited = outcome(a.store.settle());
    expect(await a.hello()).toMatchObject({ held: true });
    // Its sender tries again after its wait.
    b.clock.advance(1_000);
    expect(await waited).toContain(path);
    expect(b.mirror.doc(path)).toEqual({ n: 3 });
    expect(await a.store.store.read(path)).toEqual({ n: 3 });
    expect(a.store.state()).toMatchObject({ mode: "held", waiting: 0, lost: null });
    expect(a.store.state().refused.map((one) => one.name)).toEqual([path]);
    expect(warnings().filter((line) => line.includes(path) && line.includes("dropped"))).toHaveLength(1);
    expect(await outcome(a.store.settle())).toBe("done");
  });

  test("a runtime on its own never gives way to itself: its saves of one path made while its link was down, and one made while the first was being sent, reach the storage in the order made, the last standing, and nothing is refused", async () => {
    const path = "chats/c1/session.json";
    const a = run(await linked(b, "relay-a"));
    await a.store.store.write(path, { n: 1 });
    await a.store.settle();
    a.drop();
    for (let n = 2; n <= 3; n++) {
      b.clock.advance(5_000);
      await a.store.store.write(path, { n });
    }
    await a.hello();
    const sending = holding(b.mirror, (what) => what === `write ${path}`);
    const settled = a.store.settle();
    await sending.reached;
    b.clock.advance(5_000);
    await a.store.store.write(path, { n: 4 });
    sending.go();
    await settled;
    await a.store.settle();
    expect(b.mirror.doc(path)).toEqual({ n: 4 });
    expect(b.mirror.took.filter((change) => change === `write ${path}`)).toHaveLength(3);
    expect(a.store.state()).toMatchObject({ mode: "held", waiting: 0, refused: [], lost: null });
    // Its link was down, and the log says so: nothing was refused or dropped.
    expect(warnings().filter((line) => line.includes("dropped") || line.includes("refused"))).toEqual([]);
  });

  test("the same copy, started again (an update, a crash), holds the mirror again at once and carries on: another runtime waits the allowance", async () => {
    const path = "chats/c1/session.json";
    const a = run(await linked(b, "relay-a"));
    await a.store.store.write(path, { turns: 1 });
    await a.store.settle();
    // Killed: its link goes, it never closes, its journal holds a change.
    a.drop();
    await a.store.store.write(path, { turns: 2 });
    await a.store.close();
    const again = run(await linked(b, "relay-a"));
    await again.store.settle();
    expect(again.store.state()).toMatchObject({ mode: "held", takeover: null, waiting: 0 });
    expect(b.mirror.doc(path)).toEqual({ turns: 2 });
    expect(holderRelay(b)).toBe("relay-a");
  });

  test("a copy restored from a backup is behind the mark's count: thrown away for the storage's, under a new id", async () => {
    const path = "chats/c1/session.json";
    const a = run(await linked(b, "relay-a", { limits: () => ({ markMs: 0 }) }));
    await a.store.store.write(path, { turns: 1 });
    await a.store.settle();
    await until(() => markCount(b) === 1, "the mark to count the first change");
    await cp(b.dir, backup, { recursive: true });
    await a.store.store.write(path, { turns: 2 });
    await a.store.settle();
    await a.store.release();
    await a.store.close();
    expect(b.mirror.doc("mirror.json")).toMatchObject({ count: 2 });

    await rm(b.dir, { recursive: true, force: true });
    await cp(backup, b.dir, { recursive: true });
    const restored = run(await linked(b, "relay-a"));
    expect(await restored.store.store.read(path)).toEqual({ turns: 2 });
    expect(restored.store.state().takeover).toMatchObject({ dropped: 0 });
    expect(b.logs.some((line) => line.message.includes("has taken more from this runtime's copy than the copy holds"))).toBe(true);
  });

  test("let go as its runtime stops (the storage holding everything), the mirror is the next runtime's at once", async () => {
    const a = run(await linked(b, "relay-a"));
    await a.store.store.write("chats/c1/session.json", { turns: 1 });
    await a.store.settle();
    await a.store.release();
    expect(a.store.state().mode).toBe("direct");
    expect(holderRelay(b)).toBeNull();
    const two = run(await linked(b, "relay-b", { dir: elsewhere, owner: "runtime two" }));
    await two.store.settle();
    expect(two.store.state()).toMatchObject({ mode: "held", takeover: { from: "runtime one" } });
    expect(await two.store.store.read("chats/c1/session.json")).toEqual({ turns: 1 });
  });

  test("a holder whose link was down while another runtime saved drops what its copy holds at its next hello: its next read is the storage's", async () => {
    const path = "chats/c1/learned.json";
    const a = run(await linked(b, "relay-a"));
    const two = run(await linked(b, "relay-b", { dir: elsewhere }));
    await a.store.store.write(path, { learned: 1 });
    await a.store.settle();
    expect(await a.store.store.read(path)).toEqual({ learned: 1 });
    a.drop();
    await two.store.store.write(path, { learned: 2 });
    expect(await a.hello()).toMatchObject({ held: true, dropped: { all: true } });
    expect(await a.store.store.read(path)).toEqual({ learned: 2 });
    // Its copy took the count: the next hello drops nothing.
    expect(await a.hello()).not.toHaveProperty("dropped");
  });

  test("the extension started again holds the mirror for the runtime that held it: another's hello first doesn't take it, the holder's does, and past the allowance with no word from the holder another may", async () => {
    const a = run(await linked(b, "relay-a"));
    await a.store.store.write("chats/c1/session.json", { turns: 1 });
    await a.store.settle();
    b.arbiter.restart();
    const two = run(await linked(b, "relay-b", { dir: elsewhere }));
    expect(two.store.state().mode).toBe("direct");
    expect(await a.hello()).toMatchObject({ held: true });
    expect(a.store.state()).toMatchObject({ mode: "held", lost: null });

    // Started again, and the holder never says hello (it stopped meanwhile): past the allowance from the start, the next runtime that says hello holds it.
    b.arbiter.restart();
    await a.store.close();
    b.clock.advance(120_001);
    const three = run(await linked(b, "relay-c", { dir: backup, owner: "runtime three" }));
    await three.store.settle();
    expect(three.store.state()).toMatchObject({ mode: "held", takeover: { from: "runtime one" } });
  });
});

/** What the storage holds before a run: the holder before (`relay-x`) saved one document, and its copy is the mark's. */
const BEFORE = { path: "chats/c1/session.json", value: { turns: 7 } };

/** How many changes a run makes, cut nowhere. */
async function changesOf(run: (b: Bench, cut: Cut) => Promise<void>): Promise<number> {
  const at = await bench();
  try {
    const cut = new Cut(Number.POSITIVE_INFINITY);
    await run(at, cut);
    return cut.changes;
  } finally {
    await cleanUp(at);
  }
}

/** A disk and a storage that stop at the cut, for a runtime of `relay` on `dir`. */
function cutAt(at: Bench, cut: Cut): void {
  at.mirror.hold = async (what) => {
    if (/^(write|remove|put|drop) /.test(what)) await cut.change();
    else await cut.look();
  };
}

/** Taking: a runtime whose old copy is stale (another held the mirror since, and its journal names a change it never sent) is given the mirror. */
async function taking(at: Bench, cut: Cut): Promise<void> {
  const old = open(at, { limits: () => ({ markMs: Number.MAX_SAFE_INTEGER }) });
  await old.settle();
  at.mirror.down = "the extension isn't linked";
  await old.store.write("chats/c1/unsent.json", { saved: "here" });
  await old.close();
  at.mirror.down = null;
  // Another copy holds the storage now: its mark, and what it saved.
  at.mirror.docs.set("mirror.json", JSON.stringify({ v: 1, kind: "mirror", copy: "f".repeat(32), count: 3, owner: "relay-x", at: at.clock.now() }));
  at.mirror.docs.set(BEFORE.path, JSON.stringify(BEFORE.value));
  cutAt(at, cut);
  const s = open(at, { disk: cutDisk(cut), limits: () => ({ markMs: Number.MAX_SAFE_INTEGER }) });
  await Promise.race([s.settle(), cut.died]);
}

/** Losing: the holder, its sends held back, saves twice, then hears another runtime holds the mirror, and sends them straight. What the run cuts in is the loss: the steps before it are its set-up. */
async function losing(at: Bench, cut: Cut): Promise<void> {
  cut.armed = false;
  cutAt(at, cut);
  const s = open(at, { disk: cutDisk(cut), limits: () => ({ markMs: Number.MAX_SAFE_INTEGER }) });
  await s.settle();
  at.mirror.down = "the extension isn't linked";
  await Promise.all([s.store.write("chats/c1/a.json", { n: 1 }), s.store.write("chats/c1/b.json", { n: 2 })]);
  at.mirror.docs.set("mirror.json", JSON.stringify({ v: 1, kind: "mirror", copy: "f".repeat(32), count: 0, owner: "relay-x", at: at.clock.now() }));
  at.mirror.down = null;
  cut.armed = true;
  s.heard({ held: false, holder: "relay-x", gen: 0 });
  await Promise.race([s.settle().then(() => s.close()), cut.died]);
}

/** Started again on its folder, normally, and given the mirror (relay-x let it go): it opens, what its old copy never sent is in the storage, and it reads what the storage holds. */
async function startAgain(at: Bench, saved: Record<string, JsonValue>): Promise<void> {
  at.mirror.hold = null;
  at.mirror.down = null;
  const s = open(at);
  await s.settle();
  for (const [path, value] of Object.entries(saved)) {
    expect(at.mirror.doc(path)).toEqual(value);
    expect(await s.store.read(path)).toEqual(value);
  }
  expect(await s.store.read(BEFORE.path)).toEqual(at.mirror.doc(BEFORE.path));
  expect((await files(at.dir)).filter((file) => file.includes("/journal/") || file.includes("/tmp/"))).toEqual([]);
  expect(s.state()).toMatchObject({ mode: "held", waiting: 0 });
  await s.close();
}

const TAKING = await changesOf(taking);
const LOSING = await changesOf(losing);

describe("a crash", () => {
  test("taking the mirror and losing it each make changes on the disk or in the storage, each a place to cut", () => {
    expect(TAKING).toBeGreaterThan(4);
    expect(LOSING).toBeGreaterThan(4);
  });

  for (let n = 0; n <= TAKING; n += 1) {
    test(`taking the mirror, cut before change ${n}: started again, what the old copy hadn't sent reaches the storage`, async () => {
      const at = await bench();
      try {
        const cut = new Cut(n);
        await taking(at, cut);
        await startAgain(at, { "chats/c1/unsent.json": { saved: "here" } });
      } finally {
        await cleanUp(at);
      }
    });
  }

  for (let n = 0; n <= LOSING; n += 1) {
    test(`losing the mirror, cut before change ${n}: started again, what it hadn't sent reaches the storage`, async () => {
      const at = await bench();
      try {
        const cut = new Cut(n);
        await losing(at, cut);
        await startAgain(at, { "chats/c1/a.json": { n: 1 }, "chats/c1/b.json": { n: 2 } });
      } finally {
        await cleanUp(at);
      }
    });
  }
});
