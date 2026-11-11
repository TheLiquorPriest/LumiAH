// The stand-in backend's workspace and guidance, asked directly: each request answers, keeps what
// the page changes, refuses what the real one would in words that say what to do, and the made-up
// data holds what Live's and Sessions' fixtures point at.

import { describe, expect, test } from "bun:test";
import { fakeHash, STORED_CHANGES } from "../../dev/preview/fixtures";
import { hashOf, MOCK_AGENTS, type MockCtx, Refusal } from "../../dev/preview/mock/ctx";
import { workspaceMock } from "../../dev/preview/mock/workspace";
import { UI_VERSION, type JsonObject, type UiRequestOf, type UiRequests, type UiState } from "../../src/shared/ui";

type Requests = "lah.ws.list" | "lah.ws.read" | "lah.ws.write" | "lah.ws.move" | "lah.ws.delete" | "lah.ws.pin" | "lah.ws.history" | "lah.ws.changes" | "lah.guidance.get" | "lah.guidance.set";

const T0 = Date.UTC(2026, 10, 10, 9, 0, 0);
const MARA = "chat-mara";

/** The mock's part with a clock the test turns and settings the test sets. */
function world(options: { ready?: boolean; settings?: JsonObject } = {}) {
  let now = T0;
  let timers: { at: number; fn: () => void }[] = [];
  const texts = new Map<string, string>();
  const state: Pick<UiState, "settings"> = { settings: { values: options.settings ?? {}, defaults: {}, schema: {} } };
  const ctx: MockCtx = {
    now: () => now,
    later: (fn, ms) => {
      const timer = { at: now + ms, fn };
      timers.push(timer);
      return () => {
        timers = timers.filter((t) => t !== timer);
      };
    },
    ready: options.ready ?? true,
    // The part reads the settings alone.
    state: () => state as UiState,
    push: () => {},
    blobs: {
      put: (text) => {
        const hash = hashOf(text);
        texts.set(hash, text);
        return hash;
      },
      set: (hash, text) => void texts.set(hash, text),
      get: (hash) => texts.get(hash),
    },
    play: () => null,
    stop: () => false,
    pause: () => false,
    settings: () => {},
    keep: () => "",
  };
  const handlers = workspaceMock(ctx);
  const ask = async <K extends Requests>(type: K, body: UiRequests[K]["body"]): Promise<UiRequests[K]["result"]> => {
    // The table is keyed by the request's type, which TypeScript can't follow through the lookup.
    const handler = handlers[type] as (r: UiRequestOf<K>) => UiRequests[K]["result"] | Promise<UiRequests[K]["result"]>;
    return handler({ lah: UI_VERSION, type, reqId: "test", ...body } as UiRequestOf<K>);
  };
  const pass = (ms: number): void => {
    now += ms;
    const due = timers.filter((t) => t.at <= now);
    timers = timers.filter((t) => t.at > now);
    for (const timer of due) timer.fn();
  };
  return { ask, pass, blob: (hash: string) => texts.get(hash) };
}

/** The refusal a request met; fails where it was answered. */
async function refused(asked: Promise<unknown>): Promise<Refusal> {
  try {
    await asked;
  } catch (error) {
    if (error instanceof Refusal) return error;
    throw error;
  }
  throw new Error("the request was answered, and should have been refused");
}

describe("an area as it stands", () => {
  test("the main chat's area has notes and files outside them, each measured in characters", async () => {
    const w = world();
    const view = await w.ask("lah.ws.list", { chatId: MARA, area: "chat" });
    const paths = view.files.map((f) => f.path);
    expect(paths).toContain("notes/ledger.md");
    expect(paths).toContain("notes/timeline.md");
    expect(paths.filter((p) => !p.startsWith("notes/")).length).toBeGreaterThanOrEqual(2);
    for (const file of view.files) expect((await w.ask("lah.ws.read", { chatId: MARA, area: "chat", path: file.path })).text.length).toBe(file.chars);
    expect(view.chars).toBe(view.files.reduce((n, f) => n + f.chars, 0));
    expect(view.basis).toEqual({ messageId: "msg-0043", swipe: 0, index: 43 });
    expect(view.agents).toEqual([...MOCK_AGENTS]);
    expect(view.limits.fileChars).toBeGreaterThan(0);
  });

  test("the other two areas hold what the fixtures name, and the user's is the same with no chat", async () => {
    const w = world();
    const learned = await w.ask("lah.ws.list", { chatId: MARA, area: "learned" });
    expect(learned.files.map((f) => f.path)).toEqual(["GUIDANCE.md", "people/okoro.md"]);
    expect(learned.files.find((f) => f.path === "people/okoro.md")?.hash).toBe(fakeHash("ws:okoro:1"));
    const mine = await w.ask("lah.ws.list", { chatId: null, area: "user" });
    expect(mine.files.map((f) => f.path)).toEqual(["GUIDANCE.md", "style/prose.md"]);
    expect(await w.ask("lah.ws.list", { chatId: "chat-brann", area: "user" })).toEqual(mine);
    expect((await w.ask("lah.ws.list", { chatId: "chat-brann", area: "chat" })).files).toEqual([]);
  });

  test("the bounds are the ones Settings hold", async () => {
    const w = world({ settings: { workspace: { fileChars: 50, files: 9, areaChars: 5000, pinChars: 70 } } });
    expect((await w.ask("lah.ws.list", { chatId: null, area: "user" })).limits).toEqual({ fileChars: 50, files: 9, areaChars: 5000, pinChars: 70 });
  });

  test("an area of a chat can't be read without the chat", async () => {
    expect((await refused(world().ask("lah.ws.list", { chatId: null, area: "chat" }))).code).toBe("invalid");
  });
});

describe("a file and its versions", () => {
  test("the ledger stands at the version Live's turns wrote, and each version's text is read by its hash", async () => {
    const w = world();
    const place = { chatId: MARA, area: "chat" as const, path: "notes/ledger.md" };
    const now = await w.ask("lah.ws.read", place);
    expect(now.file.hash).toBe(fakeHash("ws:ledger:3"));
    expect(now.version).toBe(now.file.hash);
    const { versions } = await w.ask("lah.ws.history", place);
    expect(versions.map((v) => v.hash)).toEqual([fakeHash("ws:ledger:3"), fakeHash("ws:ledger:2"), fakeHash("ws:ledger:1")]);
    expect(versions.map((v) => v.at)).toEqual([...versions.map((v) => v.at)].sort((a, b) => b - a));
    const texts: string[] = [];
    for (const v of versions) {
      const read = await w.ask("lah.ws.read", { ...place, version: v.hash ?? "" });
      // A version's read names the version, and says how the file stands whichever was asked for.
      expect(read.version).toBe(v.hash ?? "");
      expect(read.file).toEqual(now.file);
      expect(read.text.length).toBe(v.chars);
      texts.push(read.text);
    }
    expect(texts[0]).toBe(now.text);
    expect(texts[1]).toEndWith("Okoro signed it on the first (#38).");
    expect(texts[2]).toEndWith("Kept in the harbour office.");
  });

  test("a version the file doesn't keep is refused, with how many it keeps", async () => {
    const w = world();
    const place = { chatId: MARA, area: "chat" as const, path: "notes/ledger.md" };
    const no = await refused(w.ask("lah.ws.read", { ...place, version: fakeHash("ws:nothing") }));
    expect(no.code).toBe("not_found");
    expect(no.message).toBe("notes/ledger.md has no such version among the 3 it keeps (Versions kept): it may have been dropped since the page listed them.");
    // Another file's version is none of this one's.
    const other = await w.ask("lah.ws.read", { chatId: MARA, area: "chat", path: "people/joss.md" });
    expect((await refused(w.ask("lah.ws.read", { ...place, version: other.file.hash }))).code).toBe("not_found");
  });

  test("the version the turn under way wrote is the ledger's once its result's link asks for it", async () => {
    const w = world();
    const place = { chatId: MARA, area: "chat" as const, path: "notes/ledger.md" };
    w.pass(30_000);
    const read = await w.ask("lah.ws.read", { ...place, version: fakeHash("ws:ledger:4") });
    expect(read.text).toContain("Ilse holds the night key");
    expect(read.file).toMatchObject({ hash: fakeHash("ws:ledger:4"), by: { who: "agent", role: "archivist" }, at: T0 + 30_000 });
    expect((await w.ask("lah.ws.history", place)).versions.map((v) => v.hash)).toEqual([fakeHash("ws:ledger:4"), fakeHash("ws:ledger:3"), fakeHash("ws:ledger:2"), fakeHash("ws:ledger:1")]);
    expect((await w.ask("lah.ws.read", place)).text).toBe(read.text);
  });

  test("no version's text is among the stored texts lah.blob.get gives", async () => {
    const w = world();
    const ledger = await w.ask("lah.ws.read", { chatId: MARA, area: "chat", path: "notes/ledger.md" });
    const { file } = await w.ask("lah.ws.write", { chatId: null, area: "user", path: "style/dialogue.md", text: "Short lines. No speeches.", base: null });
    expect(w.blob(ledger.file.hash)).toBeUndefined();
    expect(w.blob(file.hash)).toBeUndefined();
  });

  test("a file that isn't there is refused, and a path never written has no history", async () => {
    const w = world();
    const no = await refused(w.ask("lah.ws.read", { chatId: MARA, area: "chat", path: "notes/nothing.md" }));
    expect(no.code).toBe("not_found");
    expect(no.message).toBe("There is no file notes/nothing.md: it may have been moved or deleted since the page read it.");
    expect((await w.ask("lah.ws.history", { chatId: MARA, area: "chat", path: "notes/nothing.md" })).versions).toEqual([]);
  });

  test("a file moved by an earlier turn left a history that ends in a deletion, and no version of it is read at the old path", async () => {
    const w = world();
    const place = { chatId: MARA, area: "chat" as const, path: "harbour-office.md" };
    const { versions } = await w.ask("lah.ws.history", place);
    expect(versions[0]?.hash).toBeNull();
    const was = versions[1]?.hash;
    if (!was) throw new Error("the made-up data lacks the moved file's version at its old path");
    const no = await refused(w.ask("lah.ws.read", { ...place, version: was }));
    expect(no.code).toBe("not_found");
    expect(no.message).toBe("There is no file harbour-office.md: it may have been moved or deleted since the page read it.");
    // The file it became keeps that version, and gives its text.
    expect((await w.ask("lah.ws.read", { ...place, path: "places/harbour-office.md", version: was })).text).toStartWith("# The harbour office");
  });
});

describe("writes are versioned", () => {
  test("a new file is kept, and making it twice is refused", async () => {
    const w = world();
    const body = { chatId: null, area: "user" as const, path: "style/dialogue.md", text: "Short lines. No speeches.", base: null };
    const { file } = await w.ask("lah.ws.write", body);
    expect(file).toMatchObject({ path: "style/dialogue.md", chars: 25, by: { who: "user" }, pins: [] });
    expect((await w.ask("lah.ws.read", { chatId: null, area: "user", path: "style/dialogue.md" })).text).toBe("Short lines. No speeches.");
    expect((await w.ask("lah.ws.list", { chatId: null, area: "user" })).files.map((f) => f.path)).toContain("style/dialogue.md");
    const again = await refused(w.ask("lah.ws.write", body));
    expect(again.code).toBe("conflict");
    expect(again.message).toContain("Read it again");
  });

  test("a write based on the current version makes a new one; one based on an older is refused", async () => {
    const w = world();
    const place = { chatId: MARA, area: "chat" as const, path: "people/joss.md" };
    const before = await w.ask("lah.ws.read", place);
    const { file } = await w.ask("lah.ws.write", { ...place, text: `${before.text}\n- Lights the lamp at five.`, base: before.file.hash });
    expect(file.hash).not.toBe(before.file.hash);
    expect(file.pins).toEqual(before.file.pins);
    const { versions } = await w.ask("lah.ws.history", place);
    expect(versions.slice(0, 2).map((v) => v.hash)).toEqual([file.hash, before.file.hash]);
    const stale = await refused(w.ask("lah.ws.write", { ...place, text: "Mine.", base: before.file.hash }));
    expect(stale.code).toBe("conflict");
    expect(stale.message).toContain("Read it again");
    expect((await w.ask("lah.ws.read", place)).file.hash).toBe(file.hash);
  });

  test("the bounds and an unsound path are refused with what to change", async () => {
    const w = world({ settings: { workspace: { fileChars: 40, files: 3, areaChars: 100_000, pathChars: 30 } } });
    const long = await refused(w.ask("lah.ws.write", { chatId: null, area: "user", path: "long.md", text: "x".repeat(41), base: null }));
    expect(long.code).toBe("invalid");
    expect(long.problems?.[0]?.message).toContain("40 characters at most");
    await w.ask("lah.ws.write", { chatId: null, area: "user", path: "third.md", text: "three", base: null });
    const full = await refused(w.ask("lah.ws.write", { chatId: null, area: "user", path: "fourth.md", text: "four", base: null }));
    expect(full.problems?.[0]?.message).toContain("all the files Settings allow");
    for (const path of ["../out.md", "/root.md", "a//b.md", `${"n".repeat(31)}.md`]) expect((await refused(w.ask("lah.ws.write", { chatId: null, area: "user", path, text: "x", base: null }))).code).toBe("invalid");
    const under = await refused(w.ask("lah.ws.write", { chatId: null, area: "user", path: "style", text: "x", base: null }));
    expect(under.message).toContain("~/style/prose.md is in the way");
  });

  test("a job writes the timeline again four seconds after the page first reads it", async () => {
    const w = world();
    const place = { chatId: MARA, area: "chat" as const, path: "notes/timeline.md" };
    const first = await w.ask("lah.ws.read", place);
    w.pass(3900);
    expect((await w.ask("lah.ws.read", place)).file.hash).toBe(first.file.hash);
    w.pass(100);
    const met = await refused(w.ask("lah.ws.write", { ...place, text: `${first.text}\n- mine`, base: first.file.hash }));
    expect(met.code).toBe("conflict");
    const theirs = await w.ask("lah.ws.read", place);
    expect(theirs.file.by).toMatchObject({ who: "job", role: "archivist" });
    expect(theirs.text).toContain("#47");
    // Keeping one's own text is a write based on theirs; the job doesn't write a second time.
    const kept = await w.ask("lah.ws.write", { ...place, text: `${first.text}\n- mine`, base: theirs.file.hash });
    w.pass(60_000);
    expect((await w.ask("lah.ws.read", place)).file.hash).toBe(kept.file.hash);
  });

  test("the history keeps as many earlier versions as Settings say, and a dropped one is read no more", async () => {
    const w = world({ settings: { workspace: { versions: 2 } } });
    const place = { chatId: null, area: "user" as const, path: "count.md" };
    const hashes: string[] = [];
    for (const text of ["one", "two", "three", "four"]) hashes.push((await w.ask("lah.ws.write", { ...place, text, base: hashes.at(-1) ?? null })).file.hash);
    expect((await w.ask("lah.ws.history", place)).versions.map((v) => v.hash)).toEqual(hashes.slice(1).reverse());
    expect((await w.ask("lah.ws.read", { ...place, version: hashes[1] ?? "" })).text).toBe("two");
    const dropped = await refused(w.ask("lah.ws.read", { ...place, version: hashes[0] ?? "" }));
    expect(dropped.code).toBe("not_found");
    expect(dropped.message).toBe("~/count.md has no such version among the 3 it keeps (Versions kept): it may have been dropped since the page listed them.");
  });

  test("restoring a version writes its text as the newest one, and the others are still listed", async () => {
    const w = world();
    const place = { chatId: MARA, area: "chat" as const, path: "notes/ledger.md" };
    const before = (await w.ask("lah.ws.history", place)).versions;
    const oldest = before.at(-1)?.hash;
    if (!oldest) throw new Error("the made-up data lacks an earlier version of the ledger");
    w.pass(60_000);
    // The old version's read says how the file stands, and the write is based on that.
    const old = await w.ask("lah.ws.read", { ...place, version: oldest });
    const { file } = await w.ask("lah.ws.write", { ...place, text: old.text, base: old.file.hash });
    expect(file).toMatchObject({ chars: old.text.length, by: { who: "user" }, at: T0 + 60_000 });
    const after = (await w.ask("lah.ws.history", place)).versions;
    expect(after[0]?.hash).toBe(file.hash);
    expect(after.slice(1)).toEqual(before);
    expect(await w.ask("lah.ws.read", place)).toEqual({ file, text: old.text, version: file.hash });
    // Nothing is lost: each version there before is read as it was.
    for (const v of before) expect((await w.ask("lah.ws.read", { ...place, version: v.hash ?? "" })).text.length).toBe(v.chars);
    // A second restore based on the same read meets the first, as any write would.
    expect((await refused(w.ask("lah.ws.write", { ...place, text: old.text, base: old.file.hash }))).code).toBe("conflict");
  });
});

describe("move, delete and pin", () => {
  test("a moved file keeps its text and its pins, and the old path is gone", async () => {
    const w = world();
    const from = { chatId: MARA, area: "chat" as const, path: "people/joss.md" };
    const before = await w.ask("lah.ws.read", from);
    const { file } = await w.ask("lah.ws.move", { chatId: MARA, area: "chat", from: from.path, to: "people/innkeeper.md", base: before.file.hash });
    expect(file).toMatchObject({ path: "people/innkeeper.md", hash: before.file.hash });
    const after = await w.ask("lah.ws.read", { ...from, path: "people/innkeeper.md" });
    expect(after.text).toBe(before.text);
    expect(after.file.pins).toEqual(before.file.pins);
    expect((await refused(w.ask("lah.ws.read", from))).code).toBe("not_found");
    expect((await w.ask("lah.ws.history", from)).versions[0]?.hash).toBeNull();
  });

  test("a move onto a file, from an older version, or of nothing is refused", async () => {
    const w = world();
    const joss = (await w.ask("lah.ws.read", { chatId: MARA, area: "chat", path: "people/joss.md" })).file;
    const taken = await refused(w.ask("lah.ws.move", { chatId: MARA, area: "chat", from: "people/joss.md", to: "people/brann.md", base: joss.hash }));
    expect(taken.code).toBe("conflict");
    expect(taken.message).toContain("people/brann.md is in the way");
    expect((await refused(w.ask("lah.ws.move", { chatId: MARA, area: "chat", from: "people/joss.md", to: "people/j.md", base: fakeHash("older") }))).code).toBe("conflict");
    expect((await refused(w.ask("lah.ws.move", { chatId: MARA, area: "chat", from: "people/nobody.md", to: "people/j.md", base: joss.hash }))).code).toBe("not_found");
    expect((await refused(w.ask("lah.ws.move", { chatId: MARA, area: "chat", from: "people/joss.md", to: "../j.md", base: joss.hash }))).code).toBe("invalid");
  });

  test("a deleted file is gone from the area, its history says so, none of its versions is read, and its text can be written back", async () => {
    const w = world();
    const place = { chatId: MARA, area: "chat" as const, path: "people/brann.md" };
    const before = await w.ask("lah.ws.read", place);
    expect((await refused(w.ask("lah.ws.delete", { ...place, base: fakeHash("older") }))).code).toBe("conflict");
    expect(await w.ask("lah.ws.delete", { ...place, base: before.file.hash })).toEqual({ deleted: true });
    expect((await w.ask("lah.ws.list", { chatId: MARA, area: "chat" })).files.map((f) => f.path)).not.toContain("people/brann.md");
    expect((await refused(w.ask("lah.ws.delete", { ...place, base: before.file.hash }))).code).toBe("not_found");
    const { versions } = await w.ask("lah.ws.history", place);
    expect(versions.map((v) => v.hash)).toEqual([null, before.file.hash]);
    // A version's text is read from its file: with the file gone, every read of it is refused.
    for (const version of [undefined, before.file.hash]) {
      const no = await refused(w.ask("lah.ws.read", { ...place, ...(version !== undefined ? { version } : {}) }));
      expect(no.code).toBe("not_found");
      expect(no.message).toBe("There is no file people/brann.md: it may have been moved or deleted since the page read it.");
    }
    // A write over a file that is gone is a conflict; putting it back is a write of a new file.
    expect((await refused(w.ask("lah.ws.write", { ...place, text: "x", base: before.file.hash }))).code).toBe("conflict");
    expect((await w.ask("lah.ws.write", { ...place, text: before.text, base: null })).file.hash).toBe(before.file.hash);
  });

  test("a pin is one agent definition's, and stays through a write", async () => {
    const w = world();
    const place = { chatId: MARA, area: "chat" as const, path: "notes/ledger.md" };
    expect((await w.ask("lah.ws.pin", { ...place, agent: "main", on: true })).file.pins).toEqual(["main"]);
    expect((await w.ask("lah.ws.pin", { ...place, agent: "archivist", on: true })).file.pins).toEqual(["main", "archivist"]);
    expect((await w.ask("lah.ws.pin", { ...place, agent: "main", on: true })).file.pins).toEqual(["main", "archivist"]);
    expect((await w.ask("lah.ws.pin", { ...place, agent: "main", on: false })).file.pins).toEqual(["archivist"]);
    const read = await w.ask("lah.ws.read", place);
    expect((await w.ask("lah.ws.write", { ...place, text: `${read.text}\n- more`, base: read.file.hash })).file.pins).toEqual(["archivist"]);
    expect((await refused(w.ask("lah.ws.pin", { ...place, agent: "scribe", on: true }))).code).toBe("not_found");
    expect((await refused(w.ask("lah.ws.pin", { ...place, path: "notes/nothing.md", agent: "main", on: true }))).code).toBe("not_found");
  });
});

describe("a turn's change set", () => {
  test("each stored reply that changed files answers as many as Sessions says", async () => {
    const w = world();
    const of = async (index: number, swipe: number) => (await w.ask("lah.ws.changes", { chatId: MARA, messageId: `msg-${String(index).padStart(4, "0")}`, swipe })).changes;
    expect(await of(43, 0)).toHaveLength(STORED_CHANGES[43] ?? -1);
    expect(await of(41, 1)).toHaveLength(STORED_CHANGES[41] ?? -1);
    const moved = await of(37, 0);
    expect(moved).toHaveLength(STORED_CHANGES[37] ?? -1);
    // A move is one file gone and one there with the same body.
    const gone = moved.find((c) => c.after === null);
    const there = moved.find((c) => c.before === null);
    expect(gone?.before).toBe(there?.after ?? "");
    // Each side of a change is a version its file gives.
    for (const change of await of(43, 0)) for (const hash of [change.before, change.after]) if (hash !== null) expect((await w.ask("lah.ws.read", { chatId: MARA, area: change.area, path: change.path, version: hash })).version).toBe(hash);
    expect(await of(35, 0)).toEqual([]);
    expect((await w.ask("lah.ws.changes", { chatId: "chat-brann", messageId: "msg-0043", swipe: 0 })).changes).toEqual([]);
  });
});

describe("guidance", () => {
  test("a chat's agents are given three levels in order; with no chat only the user's shows", async () => {
    const w = world();
    const view = await w.ask("lah.guidance.get", { chatId: MARA });
    expect(view.levels.map((l) => l.id)).toEqual(["user", "middle", "chat"]);
    expect(view.levels[1]).toMatchObject({ label: "Joss's", editable: true });
    for (const level of view.levels) expect(level.text.length).toBeGreaterThan(0);
    expect(view.limit).toBeGreaterThan(0);
    expect(view.agentsEdit).toBe(false);
    expect((await w.ask("lah.guidance.get", { chatId: null })).levels.map((l) => l.id)).toEqual(["user"]);
  });

  test("the user's and the chat's levels are the workspace's files", async () => {
    const w = world();
    const view = await w.ask("lah.guidance.get", { chatId: MARA });
    expect((await w.ask("lah.ws.read", { chatId: null, area: "user", path: "GUIDANCE.md" })).file.hash).toBe(view.levels[0]?.hash ?? "");
    const chat = view.levels[2];
    const saved = await w.ask("lah.guidance.set", { chatId: MARA, level: "chat", text: "Joss never lies to Mara, though he leaves things out.", base: chat?.hash ?? null });
    expect(saved.levels[2]).toMatchObject({ text: "Joss never lies to Mara, though he leaves things out.", by: { who: "user" } });
    expect((await w.ask("lah.ws.read", { chatId: MARA, area: "learned", path: "GUIDANCE.md" })).text).toBe("Joss never lies to Mara, though he leaves things out.");
    const stale = await refused(w.ask("lah.guidance.set", { chatId: MARA, level: "chat", text: "Mine.", base: chat?.hash ?? null }));
    expect(stale.code).toBe("conflict");
    expect(stale.message).toContain("Read it again");
  });

  test("the middle level is the character's: kept, versioned, and another chat's is its own", async () => {
    const w = world();
    const middle = (await w.ask("lah.guidance.get", { chatId: MARA })).levels[1];
    const saved = await w.ask("lah.guidance.set", { chatId: MARA, level: "middle", text: "Joss pours before he answers.", base: middle?.hash ?? null });
    expect(saved.levels[1]?.text).toBe("Joss pours before he answers.");
    expect((await refused(w.ask("lah.guidance.set", { chatId: MARA, level: "middle", text: "Mine.", base: middle?.hash ?? null }))).code).toBe("conflict");
    expect((await w.ask("lah.guidance.get", { chatId: "chat-brann" })).levels[1]).toMatchObject({ label: "Brann's" });
  });

  test("a level the page may not edit says why, and a write to it is refused in those words", async () => {
    const w = world();
    const locked = (await w.ask("lah.guidance.get", { chatId: "chat-okoro" })).levels[1];
    expect(locked?.editable).toBe(false);
    expect(locked?.locked).toBeDefined();
    const no = await refused(w.ask("lah.guidance.set", { chatId: "chat-okoro", level: "middle", text: "x", base: locked?.hash ?? null }));
    expect(no.code).toBe("forbidden");
    expect(no.message).toBe(locked?.locked ?? "");
  });

  test("the bound and whether agents may edit follow Settings", async () => {
    const view = await world({ settings: { guidance: { chars: 120, agentsEdit: true } } }).ask("lah.guidance.get", { chatId: MARA });
    expect(view).toMatchObject({ limit: 120, agentsEdit: true });
  });
});

describe("before anything is set up", () => {
  test("nothing is kept: the areas are empty and no level is written", async () => {
    const w = world({ ready: false });
    for (const area of ["chat", "learned", "user"] as const) expect(await w.ask("lah.ws.list", { chatId: MARA, area })).toMatchObject({ files: [], chars: 0, basis: null });
    expect((await w.ask("lah.ws.changes", { chatId: MARA, messageId: "msg-0043", swipe: 0 })).changes).toEqual([]);
    const view = await w.ask("lah.guidance.get", { chatId: MARA });
    expect(view.levels.map((l) => l.hash)).toEqual([null, null, null]);
    // What the page writes is kept all the same.
    const saved = await w.ask("lah.guidance.set", { chatId: MARA, level: "user", text: "Be brief.", base: null });
    expect(saved.levels[0]?.text).toBe("Be brief.");
  });
});

describe("the contract's sequence", () => {
  test("each request succeeds in turn, ten seconds apart", async () => {
    const w = world();
    const files = (await w.ask("lah.ws.list", { chatId: MARA, area: "chat" })).files.filter((f) => !f.path.startsWith("notes/"));
    const [moved, deleted] = files;
    if (!moved || !deleted) throw new Error("the made-up data lacks two files outside notes/");
    w.pass(10_000);
    await w.ask("lah.ws.read", { chatId: MARA, area: "chat", path: "notes/ledger.md" });
    w.pass(10_000);
    await w.ask("lah.ws.write", { chatId: null, area: "user", path: "style/dialogue.md", text: "Short lines.", base: null });
    w.pass(10_000);
    await w.ask("lah.ws.move", { chatId: MARA, area: "chat", from: moved.path, to: `${moved.path}.moved`, base: moved.hash });
    w.pass(10_000);
    await w.ask("lah.ws.delete", { chatId: MARA, area: "chat", path: deleted.path, base: deleted.hash });
    w.pass(10_000);
    await w.ask("lah.ws.pin", { chatId: MARA, area: "chat", path: "notes/ledger.md", agent: "main", on: true });
    w.pass(10_000);
    expect((await w.ask("lah.ws.history", { chatId: MARA, area: "chat", path: "notes/ledger.md" })).versions.length).toBeGreaterThan(0);
    w.pass(10_000);
    expect((await w.ask("lah.ws.changes", { chatId: MARA, messageId: "msg-0043", swipe: 0 })).changes).toHaveLength(3);
    w.pass(10_000);
    const level = (await w.ask("lah.guidance.get", { chatId: MARA })).levels.find((l) => l.id === "chat");
    if (!level) throw new Error("the chat's level is missing");
    w.pass(10_000);
    const saved = await w.ask("lah.guidance.set", { chatId: MARA, level: "chat", text: "Joss never lies to Mara, though he leaves things out.", base: level.hash });
    expect(saved.levels.find((l) => l.id === "chat")?.hash).not.toBe(level.hash);
  });
});
