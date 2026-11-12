// The runtime's working store (PI-BUILD-PLAN §4.4): the core's documents and blobs on the runtime's
// own disk, with the extension's storage as the durable mirror. What a user of the store sees: reads
// answered from the disk, else from the mirror and kept; writes acknowledged once on the disk and in
// the journal, reaching the mirror behind them, the last of a path winning; `settle()` as a barrier;
// listings with what the mirror hasn't had laid over them; upkeep's blobs; the room for blobs; the
// state a page shows; and the copies of different users kept apart.

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { textHash } from "../../../src/core/hash";
import { isRecord } from "../../../src/core/ports";
import { type Disk, nodeDisk } from "../../../src/runtime/store/disk";
import type { WorkingStore } from "../../../src/runtime/store/index";
import { type Bench, bench, cleanUp, files, holding, IDENTITY, listed, Mirror, open, outcome, Refused, stopping, until } from "./rig";

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
    const tries = (): number[] => b.mirror.calls.filter((call) => call.what === `write ${path}` && call.at > failedAt).map((call) => call.at);

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

  test("settle says so in plain words when the mirror can't be reached in time, naming the wait's setting and where it is changed, and the writes still reach it later", async () => {
    // The Storage wait set short, in the Settings of an extension that builds LumiAH in and says where they are shown.
    const s = keep(open(b, { limits: () => ({ waitMs: 2_000 }), waitsOwner: () => ({ name: "LumiRPEngine", settingsAt: "LumiRPEngine's Harness tab → System → Settings" }) }));
    await s.settle();
    b.mirror.down = "the extension isn't linked";
    await s.store.write("jobs/all.json", { jobs: [] });
    const settled = s.settle();
    await until(() => s.state().lastError !== null, "the first try to fail");
    b.clock.advance(2_000);
    await expect(settled).rejects.toThrow("The extension's storage hasn't taken everything the runtime saved within 2 s (the extension isn't linked). Nothing is lost: it waits on the runtime's disk and is sent again, less often while it fails, until the storage takes it. It waits as long as Storage wait (LumiRPEngine's Harness tab → System → Settings → Timeouts → The copy and the store) says.");

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
    // The failed round left them in the order 4, 5, 3 (the first to fail goes behind the others): once the mirror held 4, room was made with it, 3 still not held; after that nothing was past the room.
    expect(await onDisk()).toEqual([hashes[3], hashes[5]].sort());
    expect(await s.blobs.get(hashes[1])).toBe(texts[1]);
  });
});

describe("its state", () => {
  test("says how many paths wait, since when the mirror is behind, why, and what the disk holds", async () => {
    const s = keep(open(b));
    await s.settle();
    await until(() => !s.state().counting, "the count at the start");
    expect(s.state()).toEqual({ open: true, mode: "held", holder: null, lost: null, waiting: 0, behindSince: null, lastError: null, lastSent: null, bytes: 0, counting: false, takeover: null, refused: [] });

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

describe("a change the mirror refuses for good", () => {
  test("leaves the journal and the working copy at once: the settle that waited for it is told in the mirror's words, the state and the log say so, and the others aren't held up", async () => {
    const s = keep(open(b, { refusedForGood: (error) => error instanceof Refused }));
    await s.settle();
    const big = "A transcript longer than the extension puts together.";
    const hash = await textHash(big);
    const rule = "That frame is larger than the extension puts together.";
    b.mirror.refuses = (what) => (what === `put ${hash}` ? rule : null);
    await s.store.write("chats/c1/session.json", { turns: 1 });
    await s.blobs.put(hash, big);
    await s.store.write("chats/c1/learned.json", { learned: 2 });

    const told = await outcome(s.settle());
    expect(told).toBe(`The extension's storage refused the stored text ${hash} for good (${rule}), so the runtime dropped it too: the storage keeps what it had.`);
    // The others reached the mirror; the refused one was tried once, and is gone from the journal and the disk.
    expect(b.mirror.doc("chats/c1/session.json")).toEqual({ turns: 1 });
    expect(b.mirror.doc("chats/c1/learned.json")).toEqual({ learned: 2 });
    expect(b.mirror.calls.filter((call) => call.what === `put ${hash}`)).toHaveLength(1);
    expect((await files(b.dir)).filter((file) => file.includes("/journal/") || file.endsWith(hash))).toEqual([]);
    expect(s.state()).toMatchObject({ waiting: 0, behindSince: null, refused: [{ name: hash, doc: false, words: told, at: b.clock.now() }] });
    expect(b.logs).toContainEqual({ level: "warn", message: `the runtime's store: ${told}` });
    // Read again, it is what the mirror holds: nothing. A settle from now on isn't held up by it.
    expect(await s.blobs.get(hash)).toBeNull();
    expect(await outcome(s.settle())).toBe("done");

    // A failure that passes is no refusal: it waits in the journal and goes once the mirror can take it.
    b.mirror.down = "the extension isn't linked";
    await s.store.write("chats/c1/learned.json", { learned: 3 });
    await until(() => s.state().lastError !== null, "a try to fail");
    expect(s.state()).toMatchObject({ waiting: 1, refused: [{ name: hash }] });
    b.mirror.down = null;
    await s.settle();
    expect(b.mirror.doc("chats/c1/learned.json")).toEqual({ learned: 3 });
  });

  test("of a document changed again while it was sent is tried again with the new text", async () => {
    const s = keep(open(b, { refusedForGood: (error) => error instanceof Refused }));
    await s.settle();
    const gate = holding(b.mirror, (what) => what === "write chats/c1/session.json");
    b.mirror.refuses = (what) => (what === "write chats/c1/session.json" && b.mirror.calls.filter((call) => call.what === what).length === 1 ? "That document is larger than the extension takes." : null);
    await s.store.write("chats/c1/session.json", { turns: "too many" });
    const settled = outcome(s.settle());
    await gate.reached;
    await s.store.write("chats/c1/session.json", { turns: 2 });
    b.mirror.hold = null;
    gate.go();
    // The settle asked before the second write waited for the first, which the mirror refused; the second goes as a change of its own.
    expect(await settled).toBe("The extension's storage refused the document chats/c1/session.json for good (That document is larger than the extension takes.), and keeps what it had: the runtime sends it the change made since.");
    await s.settle();
    expect(b.mirror.doc("chats/c1/session.json")).toEqual({ turns: 2 });
    expect(await s.store.read("chats/c1/session.json")).toEqual({ turns: 2 });
    expect(s.state()).toMatchObject({ waiting: 0, refused: [{ name: "chats/c1/session.json", doc: true }] });
  });
});

describe("what the review found", () => {
  /** A disk that fails the calls `fails` picks, with the error a disk gives (`code`), as a full disk or a path too long for it does. */
  const failing = (fails: (method: string, path: string) => string | null): Disk => {
    const base = nodeDisk();
    const check = (method: string, path: string): void => {
      const code = fails(method, path);
      if (code !== null) throw Object.assign(new Error(`${code}: the disk refused ${method}`), { code });
    };
    return {
      ...base,
      write: async (path, text) => (check("write", path), base.write(path, text)),
      rename: async (from, to) => (check("rename", to), base.rename(from, to)),
      stat: async (path) => (check("stat", path), base.stat(path)),
    };
  };

  test("a blob put again while the mirror removes it reaches the mirror again", async () => {
    const s = keep(open(b));
    const text = "A segment upkeep thinks nothing names.";
    const hash = await textHash(text);
    await s.blobs.put(hash, text);
    await s.settle();
    const gate = holding(b.mirror, (what) => what.startsWith("drop "));
    const removing = s.blobs.remove([hash]);
    await gate.reached;
    // The core puts it again while the mirror's removal is under way: the put is taken, and goes to the mirror.
    await s.blobs.put(hash, text);
    await until(() => b.mirror.took.filter((t) => t === `put ${hash}`).length === 2, "the second put to reach the mirror");
    gate.go();
    await removing;
    await s.settle();
    expect(b.mirror.stored.get(hash)?.text).toBe(text);
    expect(s.state().waiting).toBe(0);
  });

  test("with the disk full, what the mirror gives is still the answer, and the log says it couldn't be kept", async () => {
    let full = false;
    const s = keep(open(b, { disk: failing((method) => (full && method === "write" ? "ENOSPC" : null)) }));
    await s.settle();
    const text = "A transcript only the mirror holds.";
    const hash = await textHash(text);
    b.mirror.docs.set("chats/c1/session.json", JSON.stringify({ turns: 4 }));
    b.mirror.stored.set(hash, { text, at: 0 });
    full = true;
    expect(await s.store.read("chats/c1/session.json")).toEqual({ turns: 4 });
    expect(await s.blobs.get(hash)).toBe(text);
    expect(b.logs.filter((l) => l.level === "warn" && l.message.includes("couldn't keep") && l.message.includes("ENOSPC"))).toHaveLength(2);
  });

  test("a write the disk refuses leaves nothing in the journal, and an entry whose file the disk can't show is dropped at the start, not left to keep the store shut", async () => {
    const long = "chats/c1/a-name-the-disk-takes-as-too-long.json";
    const s = keep(open(b, { disk: failing((method, path) => (method === "rename" && path.endsWith(long) ? "ENAMETOOLONG" : null)) }));
    await s.settle();
    expect(await outcome(s.store.write(long, { n: 1 }))).toContain("ENAMETOOLONG");
    expect(s.state().waiting).toBe(0);
    expect((await files(b.dir)).filter((file) => file.includes("/journal/"))).toEqual([]);

    // A change left waiting in the journal (the mirror was away), whose file the disk then can't show.
    b.mirror.down = "the extension isn't linked";
    await s.store.write("chats/c1/session.json", { turns: 1 });
    await s.close();
    b.mirror.down = null;
    const again = keep(open(b, { disk: failing((method, path) => (method === "stat" && path.endsWith("chats/c1/session.json") ? "EIO" : null)) }));
    await again.store.write("chats/c1/learned.json", { learned: 1 });
    await again.settle();
    expect(b.mirror.doc("chats/c1/learned.json")).toEqual({ learned: 1 });
    expect(b.logs.some((l) => l.level === "warn" && l.message.includes("dropped d.") && l.message.includes("EIO"))).toBe(true);
    expect(again.state().waiting).toBe(0);
  });

  test("a disk that won't take a file's time costs no save", async () => {
    // A mount whose files belong to another owner lets the store write and rename, and refuses the time.
    const refusing: Disk = { ...nodeDisk(), touch: () => Promise.reject(Object.assign(new Error("EPERM: operation not permitted, utime"), { code: "EPERM" })) };
    const path = "chats/c1/session.json";
    const s = keep(open(b, { disk: refusing }));
    await s.store.write(path, { turns: 1 });
    await s.store.write("chats/c1/gone.json", { turns: 0 });
    await s.store.remove("chats/c1/gone.json");
    expect(await s.store.read(path)).toEqual({ turns: 1 });
    await s.settle();
    expect(b.mirror.doc(path)).toEqual({ turns: 1 });
    expect(b.mirror.doc("chats/c1/gone.json")).toBeNull();
    expect(s.state().waiting).toBe(0);
    expect(b.logs.some((l) => l.level === "warn" && l.message.includes(path) && l.message.includes("EPERM"))).toBe(true);
  });

  test("forgetting a chat takes away the folders it left empty", async () => {
    const s = keep(open(b));
    await s.store.write("chats/c1/session.json", { turns: 1 });
    await s.store.write("chats/c1/area/root.json", { files: [] });
    await s.store.write("chats/c2/session.json", { turns: 2 });
    await s.settle();
    expect(await s.forget("c1")).toEqual({ documents: 2 });
    const [copy = ""] = readdirSync(b.dir);
    expect(existsSync(join(b.dir, copy, "docs/chats/c1"))).toBe(false);
    expect(existsSync(join(b.dir, copy, "docs/chats/c2/session.json"))).toBe(true);
    // A path put there again after is put in a folder made again.
    await s.store.write("chats/c1/session.json", { turns: 9 });
    expect(await s.store.read("chats/c1/session.json")).toEqual({ turns: 9 });
  });

  test("a path the mirror doesn't take for now holds back no other: a change of another goes at once, not after the first one's wait", async () => {
    const s = keep(open(b));
    await s.settle();
    b.mirror.refuses = (what) => (what === "write chats/c1/huge.json" ? "the extension is busy with that one" : null);
    await s.store.write("chats/c1/huge.json", { big: true });
    // Its tries fail, alone, and the waits between them grow.
    for (let n = 0; n < 4; n++) {
      const tries = b.mirror.calls.filter((c) => c.what === "write chats/c1/huge.json").length;
      await until(() => b.mirror.calls.filter((c) => c.what === "write chats/c1/huge.json").length > tries, "another try");
      b.clock.advance(60_000);
    }
    await s.store.write("chats/c1/session.json", { turns: 3 });
    await until(() => b.mirror.doc("chats/c1/session.json") !== null, "the other change to reach the mirror without the clock moving");
    expect(s.state()).toMatchObject({ waiting: 1 });
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
