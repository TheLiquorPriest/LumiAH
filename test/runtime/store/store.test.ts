// The runtime's working store (PI-BUILD-PLAN §4.4): the core's documents and blobs on the runtime's
// own disk, with the extension's storage as the durable mirror. What a user of the store sees: reads
// answered from the disk, else from the mirror and kept; writes acknowledged once on the disk and in
// the journal, reaching the mirror behind them, the last of a path winning; `settle()` as a barrier;
// listings with what the mirror hasn't had laid over them; upkeep's blobs; the room for blobs; the
// state a page shows; and the copies of different users kept apart.

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { join } from "node:path";
import { textHash } from "../../../src/core/hash";
import { isRecord } from "../../../src/core/ports";
import type { WorkingStore } from "../../../src/runtime/store/index";
import { type Bench, bench, cleanUp, files, holding, IDENTITY, listed, Mirror, open, stopping, until } from "./rig";

let b: Bench;
const opened: WorkingStore[] = [];
const keep = (store: WorkingStore): WorkingStore => {
  opened.push(store);
  return store;
};

beforeEach(async () => {
  b = await bench();
});

afterEach(async () => {
  for (const store of opened.splice(0)) await store.close();
  await cleanUp(b);
});

const readsOf = (path: string): number => b.mirror.reads.filter((read) => read === path).length;

describe("reading", () => {
  test("a document the working copy lacks is read from the mirror once, and kept from then on", async () => {
    const path = "chats/c1/session.json";
    b.mirror.docs.set(path, JSON.stringify({ asked: 3 }));
    const s = keep(open(b));
    expect(await s.store.read(path)).toEqual({ asked: 3 });
    b.mirror.down = "the extension isn't linked";
    expect(await s.store.read(path)).toEqual({ asked: 3 });
    expect(readsOf(path)).toBe(1);
  });

  test("a document the mirror doesn't have is remembered as absent until the runtime starts again, or it is written", async () => {
    const path = "chats/c1/approvals.json";
    const first = open(b);
    expect(await first.store.read(path)).toBeNull();
    expect(await first.store.read(path)).toBeNull();
    expect(readsOf(path)).toBe(1);
    await first.close();

    const again = keep(open(b));
    expect(await again.store.read(path)).toBeNull();
    expect(readsOf(path)).toBe(2);
    await again.store.write(path, { tools: ["web_search"] });
    expect(await again.store.read(path)).toEqual({ tools: ["web_search"] });
  });

  test("a blob is handed out only when it matches its hash, whether the disk or the mirror holds it", async () => {
    const text = "Brann holds the lighthouse key.";
    const hash = await textHash(text);
    b.mirror.stored.set(hash, { text: "Okoro holds it.", at: 0 });
    const s = keep(open(b));
    expect(await s.blobs.get(hash)).toBeNull();
    expect(b.logs.some((line) => line.level === "warn" && line.message.includes(hash))).toBe(true);

    b.mirror.stored.set(hash, { text, at: 0 });
    expect(await s.blobs.get(hash)).toBe(text);
    const kept = (await files(b.dir)).find((path) => path.endsWith(`/blobs/${hash.slice(0, 2)}/${hash}`));
    if (kept === undefined) throw new Error("the blob wasn't kept on the disk");
    await Bun.write(join(b.dir, kept), "damaged on the disk");
    expect(await s.blobs.get(hash)).toBe(text);
    expect(await Bun.file(join(b.dir, kept)).text()).toBe(text);
  });

  test("a large blob reaches the mirror whole, and a runtime without it reads it back and keeps it", async () => {
    const text = `${"é".repeat(3 * 1024 * 1024)} and the last line of a long transcript`;
    const hash = await textHash(text);
    const s = open(b);
    await s.blobs.put(hash, text);
    await s.settle();
    expect(b.mirror.stored.get(hash)?.text).toBe(text);
    await s.close();

    const fresh = keep(open(b, { identity: { ...IDENTITY, user: "reader-elsewhere" }, owner: "runtime two" }));
    expect(await fresh.blobs.get(hash)).toBe(text);
    b.mirror.down = "the extension isn't linked";
    expect(await fresh.blobs.get(hash)).toBe(text);
  });
});

describe("writing", () => {
  test("a write is acknowledged once it is on the disk and in the journal, before the mirror has it", async () => {
    const path = "chats/c1/session.json";
    const held = holding(b.mirror, (what) => what === `write ${path}`);
    const s = keep(open(b));
    await s.store.write(path, { asked: 1 });
    await held.reached;
    expect(b.mirror.doc(path)).toBeNull();
    expect(s.state().waiting).toBe(1);
    const onDisk = await files(b.dir);
    expect(onDisk.filter((file) => /\/journal\/d\.[0-9a-f]{64}$/.test(file))).toHaveLength(1);
    expect(onDisk.some((file) => file.endsWith(`/docs/${path}`))).toBe(true);
    expect(await s.store.read(path)).toEqual({ asked: 1 });

    held.go();
    await s.settle();
    expect(b.mirror.doc(path)).toEqual({ asked: 1 });
    expect(s.state().waiting).toBe(0);
    expect((await files(b.dir)).some((file) => file.includes("/journal/"))).toBe(false);
  });

  test("writes to one document keep their order, and only the last reaches a mirror that was away", async () => {
    const path = "spend/2026-11-12/07.json";
    const s = keep(open(b));
    await s.settle();
    b.mirror.down = "the extension isn't linked";
    await Promise.all(Array.from({ length: 100 }, (_, n) => s.store.write(path, { calls: n })));
    expect(await s.store.read(path)).toEqual({ calls: 99 });

    b.mirror.down = null;
    await s.settle();
    expect(b.mirror.doc(path)).toEqual({ calls: 99 });
    expect(b.mirror.took.filter((change) => change === `write ${path}`)).toHaveLength(1);
  });

  test("a read while a write is under way sees the old text or the new, never a mix", async () => {
    const path = "chats/c1/learned.json";
    b.mirror.docs.set(path, JSON.stringify({ files: 1 }));
    const stop = stopping();
    const s = keep(open(b, { disk: stop.disk }));
    expect(await s.store.read(path)).toEqual({ files: 1 });

    stop.arm("rename", `/docs/${path}`);
    const writing = s.store.write(path, { files: 2 });
    await stop.reached;
    expect(await s.store.read(path)).toEqual({ files: 1 });
    stop.go();
    await writing;
    expect(await s.store.read(path)).toEqual({ files: 2 });
  });

  test("a removal racing a write: the one asked last wins, here and in the mirror", async () => {
    const s = keep(open(b));
    await Promise.all([s.store.write("pending/g1.json", { n: 1 }), s.store.remove("pending/g1.json")]);
    expect(await s.store.read("pending/g1.json")).toBeNull();
    await Promise.all([s.store.remove("pending/g2.json"), s.store.write("pending/g2.json", { n: 2 })]);
    expect(await s.store.read("pending/g2.json")).toEqual({ n: 2 });

    // A removal asked while the write is on its way to the mirror reaches the mirror after it.
    const held = holding(b.mirror, (what) => what === "write pending/g3.json");
    await s.store.write("pending/g3.json", { n: 3 });
    await held.reached;
    await s.store.remove("pending/g3.json");
    expect(await s.store.read("pending/g3.json")).toBeNull();
    held.go();
    await s.settle();

    expect(b.mirror.doc("pending/g1.json")).toBeNull();
    expect(b.mirror.doc("pending/g2.json")).toEqual({ n: 2 });
    expect(b.mirror.doc("pending/g3.json")).toBeNull();
    expect(b.mirror.took.filter((change) => change.endsWith(" pending/g3.json"))).toEqual(["write pending/g3.json", "remove pending/g3.json"]);
  });

  test("what the extension's storage would refuse is refused at once, in its words", async () => {
    const s = keep(open(b));
    const path = "A document's path is names of letters, digits, '.', '_' and '-' joined by '/'.";
    await expect(s.store.write("chats/../escape.json", {})).rejects.toThrow(path);
    await expect(s.store.read("chats/a%2Fb.json")).rejects.toThrow(path);
    await expect(s.store.write("a/b/c/d/e/f/g/h/i.json", {})).rejects.toThrow(path);
    await expect(s.store.list("../")).rejects.toThrow("A documents' prefix is names of letters, digits, '.', '_' and '-' joined by '/'.");
    await expect(s.blobs.put("ABC", "text")).rejects.toThrow("A blob is named by its SHA-256 hash, in lower-case hex.");
    await expect(s.store.write("mirror.json", {})).rejects.toThrow("mirror.json is where the runtime notes which runtime keeps the extension's storage");
    // Eight names deep is as deep as a path goes, as in the extension's storage.
    await s.store.write("a/b/c/d/e/f/g/h.json", { deep: true });
    await s.settle();
    expect(b.mirror.doc("a/b/c/d/e/f/g/h.json")).toEqual({ deep: true });
  });
});

describe("settling", () => {
  test("settle waits for what was written before it, and not for what came after", async () => {
    const s = keep(open(b));
    await s.settle();
    const held = holding(b.mirror, (what) => what === "write sides.json");
    await s.store.write("sides/s1.json", { id: "s1" });
    const settled = s.settle();
    const after = s.store.write("sides.json", { sides: ["s1"] });
    await settled;
    expect(b.mirror.doc("sides/s1.json")).toEqual({ id: "s1" });
    expect(b.mirror.doc("sides.json")).toBeNull();
    await after;
    held.go();
    await s.settle();
    expect(b.mirror.doc("sides.json")).toEqual({ sides: ["s1"] });
  });

  test("the mirror failing and coming back: each try waits longer than the last, and nothing written is lost", async () => {
    const path = "chats/c1/session.json";
    const s = keep(open(b));
    await s.settle();
    b.mirror.down = "the extension isn't linked";
    const failedAt = b.clock.now();
    await s.store.write(path, { asked: 1 });
    await until(() => s.state().lastError !== null, "the first try to fail");
    const tries = (): number[] => b.mirror.calls.filter((call) => call.what === "read mirror.json" && call.at > failedAt).map((call) => call.at);

    // A try only ever begins when a timer runs, and none runs before the second is up.
    b.clock.advance(999);
    expect(tries()).toEqual([]);
    for (const [n, wait] of [1_000 - 999, 2_000, 4_000].entries()) {
      b.clock.advance(wait);
      // The next wait is set once the try has failed: only then may the clock move on.
      await until(() => tries().length === n + 1 && s.state().lastError?.at === b.clock.now(), `try ${n + 2} to fail`);
    }
    expect(tries()).toEqual([failedAt + 1_000, failedAt + 3_000, failedAt + 7_000]);

    b.mirror.down = null;
    b.clock.advance(8_000);
    await s.settle();
    expect(b.mirror.doc(path)).toEqual({ asked: 1 });
    expect(s.state()).toMatchObject({ waiting: 0, behindSince: null, lastError: { words: "the extension isn't linked" }, lastSent: b.clock.now() });
    expect(b.logs.some((line) => line.message === "the extension's storage can be reached again")).toBe(true);
  });

  test("settle says so in plain words when the mirror can't be reached in time, and the writes still reach it later", async () => {
    const setting = "Settings, Timeouts, Saving to the extension's storage";
    const s = keep(open(b, { waitSetting: setting }));
    await s.settle();
    b.mirror.down = "the extension isn't linked";
    await s.store.write("jobs/all.json", { jobs: [] });
    const settled = s.settle();
    await until(() => s.state().lastError !== null, "the first try to fail");
    b.clock.advance(60_000);
    await expect(settled).rejects.toThrow(`The extension's storage hasn't taken everything the runtime saved within 60 s (the extension isn't linked). Nothing is lost: it waits on the runtime's disk and goes to the storage as soon as it can be reached. It waits as long as ${setting} says.`);

    b.mirror.down = null;
    await s.settle();
    expect(b.mirror.doc("jobs/all.json")).toEqual({ jobs: [] });
  });
});

describe("listing, and upkeep's blobs", () => {
  test("a listing is the mirror's, with the changes it hasn't had laid over it", async () => {
    for (const path of ["chats/c1/a.json", "chats/c1/b.json", "chats/c2/a.json"]) b.mirror.docs.set(path, "{}");
    const s = keep(open(b));
    await s.settle();
    const held = holding(b.mirror, (what) => what.startsWith("write ") || what.startsWith("remove "));
    await s.store.write("chats/c1/c.json", { n: 1 });
    await s.store.remove("chats/c1/a.json");
    expect((await s.store.list("chats/c1/")).sort()).toEqual(["chats/c1/b.json", "chats/c1/c.json"]);
    expect((await s.store.list("")).sort()).toEqual(["chats/c1/b.json", "chats/c1/c.json", "chats/c2/a.json"]);

    held.go();
    await s.settle();
    expect([...b.mirror.docs.keys()].sort()).toEqual(["chats/c1/b.json", "chats/c1/c.json", "chats/c2/a.json", "mirror.json"]);
    expect((await s.store.list("chats/")).sort()).toEqual(["chats/c1/b.json", "chats/c1/c.json", "chats/c2/a.json"]);
  });

  test("upkeep's listing waits for the mirror, and a blob stored again is as fresh to its grace as one stored now", async () => {
    const text = "a segment of a session";
    const hash = await textHash(text);
    const s = keep(open(b));
    const first = b.clock.now();
    await s.blobs.put(hash, text);
    expect((await listed(s.blobs)).find((blob) => blob.hash === hash)?.at).toBe(first);

    b.clock.advance(25 * 3_600_000);
    await s.blobs.put(hash, text);
    expect((await listed(s.blobs)).find((blob) => blob.hash === hash)?.at).toBe(first + 25 * 3_600_000);
  });

  test("the sweep's removal takes blobs from the working copy and the mirror, but not one stored again meanwhile", async () => {
    const [gone, fresh] = ["what nothing names any more", "what a run under way just stored"];
    const [goneHash, freshHash] = [await textHash(gone), await textHash(fresh)];
    const stop = stopping();
    const s = keep(open(b, { disk: stop.disk }));
    await s.blobs.put(goneHash, gone);
    await s.blobs.put(freshHash, fresh);
    await s.settle();

    stop.arm("remove", `/blobs/${goneHash.slice(0, 2)}/${goneHash}`);
    const held = holding(b.mirror, (what) => what === `put ${freshHash}`);
    const removing = s.blobs.remove([goneHash, freshHash]);
    await stop.reached;
    await s.blobs.put(freshHash, fresh);
    stop.go();
    await removing;
    expect(b.mirror.stored.has(goneHash)).toBe(false);
    expect(b.mirror.stored.has(freshHash)).toBe(true);
    expect(b.mirror.took).not.toContain(`drop ${freshHash}`);

    held.go();
    await s.settle();
    const onDisk = await files(b.dir);
    expect(onDisk.some((file) => file.endsWith(`/${goneHash}`))).toBe(false);
    expect(onDisk.some((file) => file.endsWith(`/${freshHash}`))).toBe(true);
    expect(await s.blobs.get(freshHash)).toBe(fresh);
    expect(await s.blobs.get(goneHash)).toBeNull();
  });
});

describe("the room for blobs", () => {
  test("past its room, blobs the mirror holds go, the one used longest ago first; one it doesn't hold yet stays", async () => {
    const texts = ["blob-one-1", "blob-two-2", "blob-thr-3", "blob-fou-4", "blob-fiv-5", "blob-six-6"];
    const hashes = await Promise.all(texts.map((text) => textHash(text)));
    const onDisk = async (): Promise<string[]> =>
      (await files(b.dir))
        .filter((file) => file.includes("/blobs/"))
        .map((file) => file.slice(file.lastIndexOf("/") + 1))
        .sort();
    const s = keep(open(b, { limits: () => ({ blobBytes: 25 }) }));
    await s.blobs.put(hashes[0], texts[0]);
    await s.blobs.put(hashes[1], texts[1]);
    await s.settle();
    expect(await s.blobs.get(hashes[0])).toBe(texts[0]);
    await s.blobs.put(hashes[2], texts[2]);
    await s.settle();
    expect(await onDisk()).toEqual([hashes[0], hashes[2]].sort());

    b.mirror.down = "the extension isn't linked";
    for (const n of [3, 4, 5]) await s.blobs.put(hashes[n], texts[n]);
    expect(await onDisk()).toEqual([hashes[3], hashes[4], hashes[5]].sort());
    expect(s.state().bytes).toBe(30);

    b.mirror.down = null;
    await s.settle();
    expect(await onDisk()).toEqual([hashes[4], hashes[5]].sort());
    expect(await s.blobs.get(hashes[1])).toBe(texts[1]);
  });
});

describe("its state", () => {
  test("says how many paths wait, since when the mirror is behind, why, and what the disk holds", async () => {
    const s = keep(open(b));
    await s.settle();
    await until(() => !s.state().counting, "the count at the start");
    expect(s.state()).toEqual({ open: true, waiting: 0, behindSince: null, lastError: null, lastSent: null, bytes: 0, counting: false, takeover: null });

    b.mirror.down = "the extension isn't linked";
    const since = b.clock.now();
    const doc = { asked: 1 };
    await s.store.write("chats/c1/session.json", doc);
    b.clock.advance(5_000);
    const text = "a prompt";
    await s.blobs.put(await textHash(text), text);
    await until(() => s.state().lastError !== null, "a try to fail");
    expect(s.state()).toMatchObject({ open: true, waiting: 2, behindSince: since, lastError: { words: "the extension isn't linked" }, bytes: Buffer.byteLength(JSON.stringify(doc)) + Buffer.byteLength(text) });

    b.mirror.down = null;
    await s.settle();
    expect(s.state()).toMatchObject({ waiting: 0, behindSince: null, lastSent: b.clock.now() });
  });
});

describe("identities", () => {
  test("the working copies of different users are kept apart, each beside a note of whose it is", async () => {
    const theirs = new Mirror(b.clock);
    const mine = keep(open(b));
    const other = keep(open(b, { identity: { ...IDENTITY, user: "someone-else" }, remote: { store: theirs.store, blobs: theirs.blobs } }));
    await mine.store.write("workspace/user.json", { mine: true });
    expect(await other.store.read("workspace/user.json")).toBeNull();
    await mine.settle();
    expect(b.mirror.doc("workspace/user.json")).toEqual({ mine: true });
    expect(theirs.doc("workspace/user.json")).toBeNull();

    const notes = (await files(b.dir)).filter((file) => file.endsWith("/identity.json"));
    expect(notes).toHaveLength(2);
    const users = await Promise.all(
      notes.map(async (note) => {
        const held: unknown = JSON.parse(await Bun.file(join(b.dir, note)).text());
        return isRecord(held) ? held.user : null;
      }),
    );
    expect(users.sort()).toEqual(["reader", "someone-else"]);
  });
});
