// What upkeep and a branch read of the store and the chats (DESIGN §11, §20): every blob stored,
// the documents under a prefix, every record LumiAH holds on a swipe, and the chat itself (its
// character, and the chat it was branched from). Each is one user's own, read a page at a time.
// And a user's own documents (DESIGN §7), which are written one at a time for that user alone.

import { describe, expect, test } from "bun:test";
import type { BlobInfo, StoredAnchor } from "../../../src/core/ports";
import { Chats } from "../../../src/extension/backend/chat";
import { UserDocs } from "../../../src/extension/backend/docs";
import { LinkRefused } from "../../../src/extension/backend/errors";
import { Storage } from "../../../src/extension/backend/reads";
import { isRecord } from "../../../src/link/json";
import { FakeHost } from "../../support/fake-host";

const USER = "user-mara";
/** A blob's key under a pair of leading characters. The store keeps text by key and never checks it against the text: the core does. */
const hash = (pair: string, n: number): string => `${pair}${String(n).padStart(62, "0")}`;

describe("the store, as upkeep reads it", () => {
  test("lists every blob of the user's once, a page per pair of leading characters, and removes those named", async () => {
    const host = new FakeHost();
    const storage = new Storage(host);
    await storage.putBlob(USER, hash("00", 1), "Low tide.");
    await storage.putBlob(USER, hash("00", 2), "Ilse closed the lamp room.");
    await storage.putBlob(USER, hash("ff", 3), "High tide at Okoro's Quay.");
    await storage.putBlob("user-joss", hash("00", 4), "Joss's own.");

    const read = async (): Promise<{ blobs: BlobInfo[]; pages: number }> => {
      const blobs: BlobInfo[] = [];
      let cursor: string | null = null;
      let pages = 0;
      do {
        const page: { blobs: BlobInfo[]; next: string | null } = await storage.blobs(USER, cursor);
        blobs.push(...page.blobs);
        cursor = page.next;
        pages++;
      } while (cursor !== null);
      return { blobs, pages };
    };
    const all = await read();
    expect(all.pages).toBe(256);
    expect(all.blobs.map((b) => [b.hash, b.bytes]).sort()).toEqual([
      [hash("00", 1), "Low tide.".length],
      [hash("00", 2), "Ilse closed the lamp room.".length],
      [hash("ff", 3), "High tide at Okoro's Quay.".length],
    ]);
    expect(all.blobs.every((b) => Number.isFinite(b.at))).toBe(true);

    // One that isn't stored is passed over.
    await storage.removeBlobs(USER, [hash("00", 1), hash("ee", 9)]);
    expect((await read()).blobs.map((b) => b.hash).sort()).toEqual([hash("00", 2), hash("ff", 3)]);
    expect(await storage.blob("user-joss", hash("00", 4))).toBe("Joss's own.");
    await expect(storage.blobs(USER, "zz")).rejects.toBeInstanceOf(LinkRefused);
    await expect(storage.removeBlobs(USER, ["../registry.json"])).rejects.toBeInstanceOf(LinkRefused);
  });

  test("lists the documents under a prefix, at any depth, and nothing outside the documents", async () => {
    const host = new FakeHost();
    const storage = new Storage(host);
    for (const path of ["chats/chat-1/jobs.json", "chats/chat-1/area/gen-1.json", "chats/chat-2/jobs.json", "spend/2031-04-02/09.json", "sides.json"]) await storage.putDoc(USER, path, { v: 1 });
    await storage.putBlob(USER, hash("00", 1), "Not a document.");

    expect((await storage.docs(USER, "chats/chat-1/")).sort()).toEqual(["chats/chat-1/area/gen-1.json", "chats/chat-1/jobs.json"]);
    // A prefix may end inside a name: the days of one year.
    expect(await storage.docs(USER, "spend/2031-")).toEqual(["spend/2031-04-02/09.json"]);
    expect((await storage.docs(USER, "")).sort()).toEqual(["chats/chat-1/area/gen-1.json", "chats/chat-1/jobs.json", "chats/chat-2/jobs.json", "sides.json", "spend/2031-04-02/09.json"]);
    expect(await storage.docs(USER, "nowhere/")).toEqual([]);
    expect(await storage.docs("user-joss", "")).toEqual([]);
    await expect(storage.docs(USER, "../registry.json")).rejects.toBeInstanceOf(LinkRefused);
  });
});

describe("the chats, as the core reads them", () => {
  test("say what a chat is: its character, and the chat it was branched from", async () => {
    const host = new FakeHost();
    const chats = new Chats(host, async () => ({ chats: 8, ms: 60_000 }), () => Date.now());
    const chat = host.addChat(USER, "Harbour light");
    expect(await chats.info(USER, chat.id)).toEqual({ id: chat.id, name: "Harbour light", characterId: null, characterName: null, branchedFrom: null });

    chat.characterId = "char-ilse";
    chat.metadata.branched_from = "chat-before";
    host.characters.set("char-ilse", "Ilse");
    expect(await chats.info(USER, chat.id)).toEqual({ id: chat.id, name: "Harbour light", characterId: "char-ilse", characterName: "Ilse", branchedFrom: "chat-before" });
    // Another account's chat is no chat.
    expect(await chats.info("user-joss", chat.id)).toBeNull();
  });

  test("give every record on every swipe of every message, one chat a page", async () => {
    const host = new FakeHost();
    const chats = new Chats(host, async () => ({ chats: 8, ms: 60_000 }), () => Date.now());
    const first = host.addChat(USER, "Harbour light");
    host.say(first.id, "user", "Who keeps the harbour light now?");
    const reply = host.say(first.id, "assistant", "Okoro keeps it now.");
    const second = host.addChat(USER, "Brann's ledger");
    const closing = host.say(second.id, "assistant", "The ledger is closed.");
    host.addChat(USER, "An empty chat");
    const theirs = host.addChat("user-joss", "Joss's log");
    const entry = host.say(theirs.id, "assistant", "Nothing to report.");
    expect(await chats.anchor(USER, first.id, reply.id, 0, { v: 1, generationId: "gen-1" })).toBe(true);
    expect(await chats.anchor(USER, second.id, closing.id, 0, { v: 1, generationId: "gen-2" })).toBe(true);
    expect(await chats.anchor("user-joss", theirs.id, entry.id, 0, { v: 1, generationId: "gen-3" })).toBe(true);

    const all: StoredAnchor[] = [];
    let cursor: string | null = null;
    let pages = 0;
    do {
      const page: { anchors: StoredAnchor[]; next: string | null } = await chats.anchors(USER, cursor);
      all.push(...page.anchors);
      cursor = page.next;
      pages++;
    } while (cursor !== null);
    expect(pages).toBe(3);
    expect(all).toEqual([
      { chatId: first.id, messageId: reply.id, swipeId: 0, anchor: { v: 1, generationId: "gen-1" } },
      { chatId: second.id, messageId: closing.id, swipeId: 0, anchor: { v: 1, generationId: "gen-2" } },
    ]);
    await expect(chats.anchors(USER, "not-a-page")).rejects.toBeInstanceOf(LinkRefused);
  });
});

describe("a user's own documents", () => {
  /** A document kind over a fake Lumiverse whose storage holds Mara's writes back until the test lets them go. */
  function ledgers() {
    const host = new FakeHost();
    const gate = Promise.withResolvers<void>();
    const write = host.storage.write;
    host.storage.write = async (path, text, userId) => {
      if (userId === USER) await gate.promise;
      await write(path, text, userId);
    };
    const docs = new UserDocs<{ lines: string[] }>(
      host,
      "ledger.json",
      (raw) => (isRecord(raw) && Array.isArray(raw.lines) ? { lines: raw.lines.filter((line): line is string => typeof line === "string") } : null),
      () => ({ lines: [] }),
    );
    return { host, docs, release: () => gate.resolve() };
  }

  test("a slow write of one account's doesn't hold up another account's", async () => {
    const { host, docs, release } = ledgers();
    const hers = docs.change(USER, (doc) => {
      doc.lines.push("Low tide.");
    });
    const his = docs.change("user-joss", (doc) => {
      doc.lines.push("Joss's own.");
    });

    // Joss's write is done while Mara's still waits on storage. The fake storage answers without a timer, so one turn of the event loop is all a write that nothing holds needs.
    let written = false;
    void his.then(() => {
      written = true;
    });
    const turn = Promise.withResolvers<void>();
    setImmediate(turn.resolve);
    await turn.promise;
    expect(written).toBe(true);
    expect(host.stored("user-joss", "ledger.json")).toEqual({ lines: ["Joss's own."] });
    expect(host.stored(USER, "ledger.json")).toBeNull();

    release();
    await hers;
    expect(host.stored(USER, "ledger.json")).toEqual({ lines: ["Low tide."] });
  });

  test("one with a write under way is never let go for room, so a change made behind many accounts' reads isn't written over", async () => {
    const { host, docs, release } = ledgers();
    const first = docs.change(USER, (doc) => {
      doc.lines.push("Low tide.");
    });
    // More accounts read theirs than are kept in memory at once.
    for (let n = 0; n < 300; n++) await docs.get(`user-${n}`);

    // Mara's, read again before her write landed, is the one with her change in it, not the stored text from before.
    expect((await docs.get(USER)).lines).toEqual(["Low tide."]);
    const second = docs.change(USER, (doc) => {
      doc.lines.push("High tide.");
    });
    release();
    await Promise.all([first, second]);
    expect(host.stored(USER, "ledger.json")).toEqual({ lines: ["Low tide.", "High tide."] });
  });
});
