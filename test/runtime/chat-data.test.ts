// The runtime's own copy of chat and lore, wired in (PI-BUILD-PLAN §4.5, §4.6; src/runtime/reads.ts), end
// to end on the rig: Lumiverse's rows read over its routes as the runtime's user (or from its database
// file where the operator switched the reader on), kept current by the events the extension forwards,
// and checked before each run; whatever the copy can't vouch for asked of the extension. What a run reads
// is checked against what Lumiverse holds, and, where the rig asks both roads, against what the
// extension answers over the link. Every chat, book, name and text is made up.

import { afterEach, describe, expect, test } from "bun:test";
import type { AgentUsage, ChatMessage, HarnessHost, LoreBook, PathMessage } from "../../src/core/ports";
import { chatDataLines } from "../../src/extension/frontend/chat-data-model";
import type { LinkRequestType } from "../../src/link/contract";
import { isRecord } from "../../src/link/json";
import type { UiRequestType } from "../../src/shared/ui";
import { createDbSource, type DbSource } from "../../src/runtime/db";
import type { RuntimeDeps } from "../../src/runtime/runtime";
import { BODIES } from "../frontend/bodies";
import { type LumiverseFile, lumiverseFile, removeFiles } from "./db/rig";
import { toolCall, type FakeHost } from "../support/fake-host";
import type { FakeLumiverse } from "../support/fake-lumiverse";
import { chatData, copyHolds, holding, sent } from "../support/copy-reads";
import { type Rig, type RigOptions, rig, until, USER } from "../support/rig";

const USAGE: AgentUsage = { calls: 1, toolTurns: 0, in: 10, cachedIn: 0, out: 5, reasoningOut: 0, estimated: false, ms: 1 };

const opened: Rig[] = [];
afterEach(async () => {
  for (const it of opened.splice(0)) await it.close();
  removeFiles();
});

async function started(options: RigOptions = {}): Promise<Rig> {
  const it = await rig(options);
  opened.push(it);
  return it;
}

/** What one run read of its chat and its lore. */
interface Seen {
  path: PathMessage[];
  messages: ChatMessage[];
  books: LoreBook[];
}

/** A harness whose every run reads its chat's message list, its messages and its books, as the core does, and answers "Noted.". */
function seeing(seen: Seen[]): RuntimeDeps["harness"] {
  return (host) => ({
    answer: async (turn, sink) => {
      const path = await host.chat.path(turn.chatId);
      const messages = await host.chat.messages(turn.chatId, 0, 1_000_000);
      const books = await host.lore.books(turn.chatId);
      seen.push({ path, messages, books });
      sink.content("Noted.");
      sink.done("stop", USAGE);
      return { status: "done", record: null, reply: "Noted.", usage: USAGE };
    },
  });
}

/** A harness that keeps its host for the test to read and write through as the core does, and answers every run "Noted." with no record of its own. */
function noting(held: { host: HarnessHost | null }): RuntimeDeps["harness"] {
  return (host) => {
    held.host = host;
    return {
      answer: async (_turn, sink) => {
        sink.content("Noted.");
        sink.done("stop", USAGE);
        return { status: "done", record: null, reply: "Noted.", usage: USAGE };
      },
    };
  };
}

/** The ids of the link requests of one type the runtime sent the extension: their answers carry the same. */
function requestIds(lumiverse: FakeLumiverse, type: LinkRequestType): Set<string> {
  const ids = new Set<string>();
  for (const frame of lumiverse.frames) {
    if (frame.to !== "lumiverse") continue;
    const wire: unknown = JSON.parse(frame.text);
    const data = isRecord(wire) && isRecord(wire.payload) ? wire.payload : null;
    if (isRecord(data) && data.type === type && typeof data.id === "string") ids.add(data.id);
  }
  return ids;
}

/** The reads of chats and world books the core makes, as they cross the link (the copy's own crossings among them). */
const READS: readonly string[] = ["chat.path", "chat.messages", "chat.info", "lore.books", "lore.entries", "lore.activated", "recall.lore.read", "recall.lore.activated", "recall.chat.messages", "book.read", "host.read", "own.read", "turn.lore"];
const isRead = (type: string): boolean => READS.includes(type.split(" ")[0] ?? "");
/** A crossing that reads a chat's messages: the reads the copy is there to answer. */
const ofChat = (type: string): boolean => ["chat.path", "chat.messages", "recall.chat.messages", "host.read chats.messages", "host.read chats.get"].includes(type);

/** A chat's messages as the run saw them: role and text. */
const texts = (messages: readonly ChatMessage[]): string[] => messages.map((m) => `${m.role}: ${m.content}`);

/** Waits until the runtime's copy holds the chat, read whole from Lumiverse. */
async function kept(it: Rig, chatId: string): Promise<void> {
  await copyHolds(it, (state) => state.road === "copy" && state.chats.some((c) => c.id === chatId), "the copy to hold the chat");
}

describe("a message added, edited, swiped and deleted in Lumiverse", () => {
  test("reaches the next run from the runtime's own copy, with no read of the chat over the link", async () => {
    const seen: Seen[] = [];
    const it = await started({ harness: seeing(seen), reads: "copy" });
    const chatId = await it.setUp();
    const first = await it.generate(chatId);
    expect(texts(seen[0]?.messages ?? [])).toEqual(["user: Who keeps the harbour light now?", "assistant: "]);
    await kept(it, chatId);

    // Between the runs, as Lumiverse does them, each with its event: a message sent, the first one edited, the reply swiped to a new text, a stray message sent and deleted.
    it.host.say(chatId, "user", "And before him?");
    const [asked] = it.host.chatList.get(chatId)?.messages ?? [];
    if (asked === undefined) throw new Error("the chat lost its first message");
    asked.swipes[0] = "Who keeps the light?";
    const reply = it.host.message(chatId, first.messageId ?? "");
    reply.swipes.push("Ilse kept it, before the flood.");
    reply.swipeId = 1;
    const stray = it.host.say(chatId, "assistant", "A line sent by mistake.");
    const messages = it.host.chatList.get(chatId)?.messages ?? [];
    messages.splice(messages.indexOf(stray), 1);

    const from = it.lumiverse.frames.length;
    await it.generate(chatId);
    expect(texts(seen[1]?.messages ?? [])).toEqual(["user: Who keeps the light?", "assistant: Ilse kept it, before the flood.", "user: And before him?", "assistant: "]);
    expect(seen[1]?.path.map((m) => [m.role, m.swipeId])).toEqual([
      ["user", 0],
      ["assistant", 1],
      ["user", 0],
      ["assistant", 0],
    ]);
    // The run's reads of the chat crossed no link: the copy answered them.
    expect(sent(it.lumiverse, from).filter(ofChat)).toEqual([]);
    const state = await chatData(it);
    expect(state.road).toBe("copy");
    expect(state.source).toBe("http");
    expect(state.fallbacks.total).toBe(0);
  });
});

// Lumiverse tells of a record the runtime writes on a message (the extension's write emits its event)
// and the link answers the write: two roads, either first. The copy never answers from before a write it
// knows of, and once it holds the write it answers at once, whichever came first.
describe("a record the runtime writes on a message", () => {
  /** How many times the chat was read whole over Lumiverse's routes: its first page asked for. */
  const wholeReads = (it: Rig, chatId: string): number => it.lumiverse.asked.filter((a) => a.line === `GET /api/v1/chats/${chatId}/messages?limit=1000&offset=0`).length;

  for (const first of ["Lumiverse's word of it", "the link's answer"] as const) {
    test(`with ${first} first: once both came, the chat is answered from the copy, record and all, with no read over the link and none read whole again`, async () => {
      const held: { host: HarnessHost | null } = { host: null };
      const it = await started({ harness: noting(held), reads: "copy" });
      const chatId = await it.setUp();
      const reply = await it.generate(chatId);
      const messageId = reply.messageId ?? "";
      const host = held.host as HarnessHost;
      await host.chat.path(chatId);
      await kept(it, chatId);
      const record = { v: 1, generationId: reply.generationId, kind: "new", at: 1_700_000_000_000, path: "p-harbour", segment: "s".repeat(64) };
      const heard = (await chatData(it)).events.heard;

      // The other one held back until the first has come.
      it.lumiverse.holds = first === "the link's answer" ? (frame) => frame.type === "event" : (frame) => frame.type === "result" && requestIds(it.lumiverse, "chat.anchor").has(String(frame.id));
      const writing = host.chat.anchor(chatId, messageId, 0, record);
      if (first === "the link's answer") expect(await writing).toBe(true);
      else await copyHolds(it, (state) => state.events.heard > heard, "Lumiverse's word of the write");
      it.lumiverse.holds = () => false;
      it.lumiverse.letGo();
      expect(await writing).toBe(true);
      await copyHolds(it, (state) => state.events.heard > heard, "Lumiverse's word of the write");

      const from = it.lumiverse.frames.length;
      const whole = wholeReads(it, chatId);
      const path = await host.chat.path(chatId);
      expect(path.find((m) => m.id === messageId)?.anchor).toEqual(record);
      expect((await host.chat.messages(chatId, 0, 10)).map((m) => m.id)).toEqual(path.map((m) => m.id));
      expect(sent(it.lumiverse, from).filter(ofChat)).toEqual([]);
      expect(wholeReads(it, chatId)).toBe(whole);
      expect((await chatData(it)).fallbacks.latest.filter((f) => f.why === "the runtime wrote on it, and Lumiverse hasn't told of that write yet")).toEqual([]);
    });
  }

  test("until Lumiverse tells of it, the chat is the extension's to answer: a read never misses the runtime's own write", async () => {
    const held: { host: HarnessHost | null } = { host: null };
    const it = await started({ harness: noting(held), reads: "copy" });
    const chatId = await it.setUp();
    const reply = await it.generate(chatId);
    const messageId = reply.messageId ?? "";
    const host = held.host as HarnessHost;
    await host.chat.path(chatId);
    await kept(it, chatId);
    const record = { v: 1, generationId: reply.generationId, kind: "new", at: 1_700_000_000_000, path: "p-harbour", segment: "s".repeat(64) };

    it.lumiverse.holds = (frame) => frame.type === "event";
    expect(await host.chat.anchor(chatId, messageId, 0, record)).toBe(true);
    const from = it.lumiverse.frames.length;
    expect((await host.chat.path(chatId)).find((m) => m.id === messageId)?.anchor).toEqual(record);
    expect(sent(it.lumiverse, from).filter(ofChat).length).toBeGreaterThan(0);
    expect((await chatData(it)).fallbacks.latest.at(-1)?.why).toBe("the runtime wrote on it, and Lumiverse hasn't told of that write yet");
    it.lumiverse.holds = () => false;
    it.lumiverse.letGo();
  });
});

describe("changes Lumiverse makes with no event", () => {
  test("at the chat's end or to the chat's own fields are caught by the check before a run, however soon the run comes", async () => {
    const seen: Seen[] = [];
    const it = await started({ harness: seeing(seen), reads: "copy" });
    const chatId = await it.setUp();
    const first = await it.generate(chatId);
    await kept(it, chatId);
    it.host.books.set("book-quay", { book: { id: "book-quay", name: "The quay", description: "" }, userId: USER, entries: [{ id: "entry-steps", bookId: "book-quay", title: "The steps", keys: ["steps"], secondaryKeys: [], content: "Worn smooth by the tide.", enabled: true, constant: false }] });

    // The reply rewritten in place and the chat given a world book, both with no word of either: the run that follows at once sees both.
    it.host.quietly(() => {
      it.host.message(chatId, first.messageId ?? "").swipes[0] = "Okoro does, and quietly.";
      const chat = it.host.chatList.get(chatId);
      if (chat !== undefined) chat.metadata.chat_world_book_ids = ["book-quay"];
    });
    await it.generate(chatId, { type: "continue" });
    expect(texts(seen[1]?.messages ?? [])).toEqual(["user: Who keeps the harbour light now?", "assistant: Okoro does, and quietly."]);
    expect(seen[1]?.books).toEqual([{ id: "book-quay", name: "The quay", description: "" }]);

    // A message put at the end with no word of it: the count tells.
    it.host.quietly(() => it.host.say(chatId, "assistant", "And the lamp burned all night."));
    await it.generate(chatId, { type: "continue" });
    expect(texts(seen[2]?.messages ?? []).at(-1)).toBe("assistant: And the lamp burned all night.");
    expect((await chatData(it)).chats.find((c) => c.id === chatId)?.read.why).toBe("the check before use found 3 messages in the chat where the copy holds 2");
  });

  test("before the newest message is seen over Lumiverse's routes only once the chat is read again, and the page says so", async () => {
    const seen: Seen[] = [];
    const it = await started({ harness: seeing(seen), reads: "copy" });
    const chatId = await it.setUp();
    await it.generate(chatId);
    await kept(it, chatId);
    it.host.quietly(() => {
      const [asked] = it.host.chatList.get(chatId)?.messages ?? [];
      if (asked !== undefined) asked.name = "Mara of the quay";
    });
    await it.generate(chatId, { type: "continue" });
    // Lumiverse's own reattribution of user messages in bulk is such a change: over HTTP the check sees the newest message and the chat's fields alone.
    expect(seen[1]?.path[0]?.name).toBe("Mara");
    expect((await chatData(it)).chats[0]?.check).toEqual({ saw: "the number of messages, the newest message and the chat's own fields", missed: "a change Lumiverse makes with no event to a message before the newest (user messages renamed in bulk by persona, an extension's entry or hidden written in place) isn't seen until the chat is read again" });
  });
});

/** Writes the fake Lumiverse's rows into the database file as they stand: a row there already is updated in place, a new one added, one gone deleted. */
function mirror(host: FakeHost, file: LumiverseFile): void {
  const db = file.writer;
  db.transaction(() => {
    const chat = db.query(`INSERT INTO chats (id, user_id, character_id, name, metadata, updated_at) VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT(id) DO UPDATE SET user_id = excluded.user_id, character_id = excluded.character_id, name = excluded.name, metadata = excluded.metadata, updated_at = excluded.updated_at`);
    const message = db.query(
      `INSERT INTO messages (id, chat_id, index_in_chat, is_user, name, content, send_date, swipe_id, swipes, extra, created_at, revision) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(id) DO UPDATE SET chat_id = excluded.chat_id, index_in_chat = excluded.index_in_chat, is_user = excluded.is_user, name = excluded.name, content = excluded.content, send_date = excluded.send_date, swipe_id = excluded.swipe_id, swipes = excluded.swipes, extra = excluded.extra, created_at = excluded.created_at, revision = excluded.revision`,
    );
    const book = db.query(`INSERT INTO world_books (id, user_id, name, description, metadata, updated_at) VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT(id) DO UPDATE SET user_id = excluded.user_id, name = excluded.name, description = excluded.description, metadata = excluded.metadata, updated_at = excluded.updated_at`);
    const entry = db.query(
      `INSERT INTO world_book_entries (id, world_book_id, key, keysecondary, content, comment, role, order_value, constant, disabled, use_regex, vectorized, extensions, revision, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(id) DO UPDATE SET world_book_id = excluded.world_book_id, key = excluded.key, keysecondary = excluded.keysecondary, content = excluded.content, comment = excluded.comment, role = excluded.role, order_value = excluded.order_value, constant = excluded.constant, disabled = excluded.disabled, use_regex = excluded.use_regex, vectorized = excluded.vectorized, extensions = excluded.extensions, revision = excluded.revision, updated_at = excluded.updated_at`,
    );
    const messages: string[] = [];
    for (const chatId of host.chatList.keys()) {
      const rows = host.rows.chatRows(chatId);
      if (rows === null) continue;
      const c = rows.chat;
      chat.run(c.id, c.user_id, c.character_id, c.name, JSON.stringify(c.metadata), c.updated_at);
      for (const m of rows.messages) {
        messages.push(m.id);
        message.run(m.id, m.chat_id, m.index_in_chat, m.is_user, m.name, m.content, m.send_date, m.swipe_id, m.swipes, m.extra, m.created_at, m.revision);
      }
    }
    const entries: string[] = [];
    for (const bookId of host.books.keys()) {
      const rows = host.rows.bookRows(host.books, bookId);
      if (rows === null) continue;
      const b = rows.book;
      book.run(b.id, b.user_id, b.name, b.description, b.metadata, b.updated_at);
      for (const e of rows.entries) {
        entries.push(e.id);
        entry.run(e.id, e.world_book_id, e.key, e.keysecondary, e.content, e.comment, e.role, e.order_value, e.constant, e.disabled, e.use_regex, e.vectorized, e.extensions, e.revision, e.updated_at);
      }
    }
    const gone = (table: string, ids: Iterable<string>): void => void db.query(`DELETE FROM ${table} WHERE id NOT IN (SELECT value FROM json_each(?))`).run(JSON.stringify([...ids]));
    gone("messages", messages);
    gone("chats", host.chatList.keys());
    gone("world_book_entries", entries);
    gone("world_books", host.books.keys());
  })();
}

/** The database reader over a file that holds what the fake Lumiverse holds at each of its reads, as Lumiverse's own file always does. */
function readerOver(file: LumiverseFile, host: () => FakeHost, opened: { reader: DbSource | null; frozen?: boolean }): NonNullable<RuntimeDeps["database"]> {
  return (target) => {
    const db = createDbSource({ ...target, sleep: (ms) => Bun.sleep(ms), now: () => Date.now(), log: () => undefined });
    const current = async <T>(read: () => Promise<T>): Promise<T> => {
      if (opened.frozen !== true) mirror(host(), file);
      return read();
    };
    const reader: DbSource = {
      kind: "database",
      readChat: (chatId) => current(() => db.readChat(chatId)),
      readBook: (bookId, held) => current(() => db.readBook(bookId, held)),
      chatSignature: (chatId) => current(() => db.chatSignature(chatId)),
      bookSignature: (bookId, held) => current(() => db.bookSignature(bookId, held)),
      changedSince: (mark) => current(() => db.changedSince(mark)),
      describe: () => db.describe(),
      close: () => db.close(),
    };
    opened.reader = reader;
    return reader;
  };
}

/** Switches the reader on as this Lumiverse's operator, for a file where Lumiverse keeps its database, and waits until the runtime reads from it. */
async function readerOn(it: Rig, file: LumiverseFile): Promise<void> {
  it.host.roles.set(USER, "operator");
  it.host.databaseFile = file.path;
  expect(await it.page.request("lah.runtime.database", { on: true })).toEqual({ database: { operator: true, on: true, path: file.path } });
  await copyHolds(it, (state) => state.source === "database", "the runtime to read Lumiverse's file");
}

/** One script of runs and Lumiverse's changes between them; what each run read. */
async function played(it: Rig, seen: Seen[]): Promise<Seen[]> {
  const chatId = await it.setUp();
  it.host.books.set("book-quay", { book: { id: "book-quay", name: "The quay", description: "Its stones and steps." }, userId: USER, entries: [{ id: "entry-steps", bookId: "book-quay", title: "The steps", keys: ["steps"], secondaryKeys: [], content: "Worn smooth by the tide.", enabled: true, constant: false }] });
  const chat = it.host.chatList.get(chatId);
  if (chat === undefined) throw new Error("no chat");
  chat.metadata.chat_world_book_ids = ["book-quay"];
  const first = await it.generate(chatId);
  it.host.say(chatId, "user", "And before him?");
  it.host.message(chatId, first.messageId ?? "").swipes[0] = "Okoro does.";
  const book = it.host.books.get("book-quay");
  book?.entries.push({ id: "entry-bollard", bookId: "book-quay", title: "The bollard", keys: ["bollard"], secondaryKeys: [], content: "Iron, older than the light.", enabled: true, constant: false });
  await it.generate(chatId);
  const reply = it.host.chatList.get(chatId)?.messages.at(-1);
  reply?.swipes.push("Ilse kept it.");
  if (reply !== undefined) reply.swipeId = 1;
  await it.generate(chatId, { type: "continue" });
  return seen;
}

describe("the direct database reader", () => {
  test("a runtime with the reader on and one with it off give the same answers, each the same as the extension's over the link", async () => {
    const off: Seen[] = [];
    const without = await started({ harness: seeing(off), reads: "both" });
    await without.runtime.link.connect();
    await played(without, off);

    const on: Seen[] = [];
    const file = lumiverseFile();
    const held: { reader: DbSource | null } = { reader: null };
    let it: Rig | null = null;
    const withReader = await started({ harness: seeing(on), reads: "both", database: readerOver(file, () => (it as Rig).host, held) });
    it = withReader;
    await withReader.runtime.link.connect();
    await readerOn(withReader, file);
    await played(withReader, on);

    expect(without.differences).toEqual([]);
    expect(withReader.differences).toEqual([]);
    expect(on).toEqual(off);
    expect(on.map((s) => texts(s.messages))).toEqual([
      ["user: Who keeps the harbour light now?", "assistant: "],
      ["user: Who keeps the harbour light now?", "assistant: Okoro does.", "user: And before him?", "assistant: "],
      ["user: Who keeps the harbour light now?", "assistant: Okoro does.", "user: And before him?", "assistant: Ilse kept it."],
    ]);
    const state = await chatData(withReader);
    expect(state.source).toBe("database");
    expect(state.reader).toMatchObject({ on: true, path: file.path, schema: { matches: true } });
    expect(state.chats[0]?.from).toBe("database");
    expect((await chatData(without)).chats[0]?.from).toBe("http");
  });

  test("its fingerprint catches a change before the newest message that Lumiverse tells of nowhere", async () => {
    const seen: Seen[] = [];
    const file = lumiverseFile();
    const held: { reader: DbSource | null } = { reader: null };
    let it: Rig | null = null;
    it = await started({ harness: seeing(seen), reads: "both", database: readerOver(file, () => (it as Rig).host, held) });
    await it.runtime.link.connect();
    await readerOn(it, file);
    const chatId = await it.setUp();
    await it.generate(chatId);
    await kept(it, chatId);
    const host = it.host;
    host.quietly(() => {
      const [asked] = host.chatList.get(chatId)?.messages ?? [];
      if (asked !== undefined) asked.name = "Mara of the quay";
    });
    await it.generate(chatId, { type: "continue" });
    expect(seen[1]?.path[0]?.name).toBe("Mara of the quay");
    expect(it.differences).toEqual([]);
    expect((await chatData(it)).chats[0]?.read.why).toBe("the check before use found the chat changed since it was read");
  });

  test("turning itself off in the middle of a read: that read goes to the extension, and the next ones read Lumiverse over its routes", async () => {
    const seen: Seen[] = [];
    const file = lumiverseFile();
    const held: { reader: DbSource | null; frozen?: boolean } = { reader: null };
    let it: Rig | null = null;
    it = await started({ harness: seeing(seen), reads: "both", database: readerOver(file, () => (it as Rig).host, held) });
    await it.runtime.link.connect();
    await readerOn(it, file);
    const chatId = await it.setUp();
    await it.generate(chatId);
    held.frozen = true;
    // A Lumiverse update renames a column the reader reads: the reader turns itself off at its next look.
    file.writer.run("ALTER TABLE messages RENAME COLUMN revision TO edits");
    await it.generate(chatId, { type: "continue" });
    expect(texts(seen[1]?.messages ?? [])).toEqual(["user: Who keeps the harbour light now?", "assistant: Noted."]);
    expect(it.differences).toEqual([]);
    const state = await chatData(it);
    expect(state.fallbacks.latest.some((f) => f.why.includes("the database reader turned itself off"))).toBe(true);
    expect(state.source).toBe("http");
    expect(state.reader?.on).toBe(false);
    expect(state.reader?.why).toContain('no column "revision"');
    await it.generate(chatId, { type: "continue" });
    expect((await chatData(it)).fallbacks.total).toBe(state.fallbacks.total);
  });

  test("can't be switched on by a user who isn't the operator, by any request a page or a runtime of theirs can send", async () => {
    const it = await started();
    await it.setUp();
    it.host.databaseFile = "/srv/lumiverse/data/lumiverse.db";
    await expect(it.page.request("lah.runtime.database", { on: true })).rejects.toThrow("Only this Lumiverse's operator can switch the database reader on or off.");
    expect((await it.page.request("lah.runtime.chatdata", { relay: it.registration.relay })).database).toEqual({ operator: false, on: false, path: null });

    // Every request the link knows, from her own runtime's session, each with whatever it would carry to switch the reader on.
    const LINK_TYPES: Record<LinkRequestType, true> = {
      register: true, hello: true, ping: true, models: true, "turn.begin": true, "turn.commit": true, "stream.ack": true, "stream.cancel": true, "settings.get": true, "trace.push": true, "setup.connection": true, "blob.get": true, "blob.put": true, "doc.get": true, "doc.put": true, "doc.remove": true, "chat.path": true, "chat.messages": true, "chat.anchor": true, "lore.books": true, "lore.entries": true, "lore.activated": true, "preset.blocks": true, "tools.list": true, "tool.call": true, "approval.ask": true, "extension.call": true, "blob.list": true, "blob.remove": true, "mirror.release": true, "doc.list": true, "chat.info": true, "chat.anchors": true, "job.changed": true, "ask.answer": true, "recall.lore.read": true, "recall.lore.activated": true, "recall.chat.messages": true, "recall.embedder": true, "recall.embed": true, "recall.memory.enabled": true, "recall.memory.search": true, "recall.memory.entity": true, "recall.memory.entities": true, "recall.memory.arcs": true, "recall.databanks.list": true, "recall.databanks.documents": true, "recall.databanks.content": true, "recall.web.enabled": true, "recall.web.search": true, "book.read": true, "host.read": true, "own.read": true, "turn.lore": true,
    };
    const switching = { on: true, database: "/srv/lumiverse/data/lumiverse.db", path: "/srv/lumiverse/data/lumiverse.db", operator: true, role: "operator" };
    const answers: Promise<unknown>[] = Object.keys(LINK_TYPES).map((type) => it.lumiverse.raw({ type, secret: it.registration.secret, ...switching, doc: { v: 1, on: true } }).catch(() => undefined));
    // Every request a page knows, each with its own body and the same; the two that would unlink her runtime last.
    const last: UiRequestType[] = ["lah.relay", "lah.key"];
    const pages = (Object.keys(BODIES) as UiRequestType[]).filter((type) => !last.includes(type));
    answers.push(...pages.map((type) => it.page.request(type, { ...(BODIES[type] as object), ...switching } as never).catch(() => undefined)));
    await it.backend.settle();
    // The switch is as it shipped, off; every offer of what to read her runtime was sent names no file, and hers reads none.
    expect(it.host.stored(USER, "database.json")).toBeNull();
    const offers = it.lumiverse.frames.filter((f) => f.to === "runtime" && f.text.includes('"granted"')).map((f) => f.text);
    expect(offers.length).toBeGreaterThan(0);
    for (const offer of offers) expect(offer).toContain('"database":null');
    expect((await it.page.request("lah.runtime.chatdata", { relay: it.registration.relay })).database).toEqual({ operator: false, on: false, path: null });
    expect((await chatData(it)).reader).toBeNull();
    for (const type of last) void it.page.request(type, { ...(BODIES[type] as object), ...switching } as never).catch(() => undefined);
    await it.backend.settle();
    expect(it.host.stored(USER, "database.json")).toBeNull();
  });
});

describe("the rig's compare mode", () => {
  test("plays turns while messages are added, edited, swiped and deleted and a world book changes between them, every read answered alike by the copy and over the link", async () => {
    const held: { host: HarnessHost | null } = { host: null };
    const it = await started({ harness: holding(held), reads: "both" });
    const chatId = await it.setUp();
    it.host.books.set("book-quay", { book: { id: "book-quay", name: "The quay", description: "" }, userId: USER, updatedAt: Date.UTC(2024, 4, 2, 8, 0, 0), entries: [{ id: "entry-steps", bookId: "book-quay", title: "The steps", keys: ["steps"], secondaryKeys: [], content: "Worn smooth by the tide.", enabled: true, constant: false }] });
    const chat = it.host.chatList.get(chatId);
    if (chat === undefined) throw new Error("no chat");
    chat.metadata.chat_world_book_ids = ["book-quay"];
    it.host.script = [{ toolCalls: [toolCall("write_reply", { brief: "Okoro keeps the light." }, "c1")] }, "Okoro keeps it now.", { toolCalls: [toolCall("write_reply", { brief: "Ilse, before him." }, "c2")] }, "Ilse did, before him.", { toolCalls: [toolCall("write_reply", { brief: "Brann, once." }, "c3")] }, "Brann kept it once."];
    const first = await it.generate(chatId);
    await until(() => it.host.message(chatId, first.messageId ?? "").own !== null, "the first reply's record");
    const reads = async (): Promise<void> => {
      const host = held.host;
      if (host === null) throw new Error("no harness host");
      await host.chat.path(chatId);
      await host.chat.messages(chatId, 0, 100);
      await host.lore.books(chatId);
      await host.lore.entries("book-quay");
      await host.recall?.lore?.read(chatId);
      await host.recall?.chat?.messages(chatId, 0, 100);
    };
    await reads();

    // Lumiverse's changes between the turns: a message sent, an older one edited, a stray one sent and deleted, the book's entry rewritten and another added.
    it.host.say(chatId, "user", "And before him?");
    it.host.message(chatId, chat.messages[0]?.id ?? "").swipes[0] = "Who keeps the light?";
    const stray = it.host.say(chatId, "assistant", "A line sent by mistake.");
    chat.messages.splice(chat.messages.indexOf(stray), 1);
    const book = it.host.books.get("book-quay");
    if (book === undefined) throw new Error("no book");
    if (book.entries[0] !== undefined) book.entries[0].content = "Worn smooth, and slick at low tide.";
    book.entries.push({ id: "entry-bollard", bookId: "book-quay", title: "The bollard", keys: ["bollard"], secondaryKeys: [], content: "Iron, older than the light.", enabled: true, constant: false });
    await reads();
    const second = await it.generate(chatId);
    await until(() => it.host.message(chatId, second.messageId ?? "").own !== null, "the second reply's record");
    await reads();

    // The reply swiped: a new swipe written by the next turn, and its record beside the first's.
    const swiped = await it.generate(chatId, { type: "swipe" });
    await until(() => JSON.stringify(it.host.message(chatId, swiped.messageId ?? "").own).includes(swiped.generationId), "the swipe's record");
    await reads();

    expect(it.differences).toEqual([]);
    // The copy answered them: it holds the chat and the book, read over Lumiverse's routes.
    const state = await chatData(it);
    expect(state.road).toBe("copy");
    expect(state.chats.map((c) => c.id)).toContain(chatId);
    expect(state.books.map((b) => b.id)).toEqual(["book-quay"]);
    expect(it.lumiverse.asked.some((a) => a.line.startsWith(`GET /api/v1/chats/${chatId}/messages`))).toBe(true);
  });

  test("a chat's books by its character, the user's persona and every chat: their lists come with what the extension heard of the chat's turn, none crossing on its own, and the books are answered alike", async () => {
    const held: { host: HarnessHost | null } = { host: null };
    const it = await started({ harness: holding(held), reads: "both" });
    const chatId = await it.setUp();
    for (const [id, name] of [["book-joss", "Joss"], ["book-mara", "Mara"], ["book-tides", "The tides"]] as const) it.host.books.set(id, { book: { id, name, description: "" }, userId: USER, updatedAt: Date.UTC(2024, 4, 2, 8, 0, 0), entries: [{ id: `entry-${id}`, bookId: id, title: name, keys: [name.toLowerCase()], secondaryKeys: [], content: `${name}, of the harbour.`, enabled: true, constant: false }] });
    const chat = it.host.chatList.get(chatId);
    if (chat === undefined) throw new Error("no chat");
    chat.characterId = "char-joss";
    it.host.characterBooks.set("char-joss", ["book-joss"]);
    it.host.personaBook = "book-mara";
    it.host.globalBooks = ["book-tides"];
    await copyHolds(it, (state) => state.road === "copy", "the copy to be offered");
    const host = held.host as HarnessHost;
    const from = it.lumiverse.frames.length;

    expect((await host.lore.books(chatId)).map((b) => b.id)).toEqual(["book-joss", "book-mara", "book-tides"]);
    expect((await host.recall?.lore?.read(chatId))?.map((b) => [b.id, b.source])).toEqual([["book-joss", "character"], ["book-mara", "persona"], ["book-tides", "global"]]);
    expect(it.differences).toEqual([]);
    const lists = ["host.read lore.global", "host.read lore.ofPersona", "host.read lore.ofCharacter"];
    expect(sent(it.lumiverse, from).filter((type) => lists.includes(type))).toEqual([]);
    expect(sent(it.lumiverse, from).filter((type) => type === "turn.lore")).toEqual(["turn.lore", "turn.lore"]);
  });
});

describe("crossings to the extension of one turn's chat and lore reads", () => {
  /** A chat of `n` messages, Mara's and Joss's in turn, each a line of about 200 characters, with Joss for its character; switched on to run in the runtime. Joss, Mara's persona and every chat each have a world book. */
  async function longChat(it: Rig, n: number): Promise<string> {
    const chatId = await it.setUp();
    const line = "The tide came in over the steps and the lamp was lit at dusk, as it is every night of the year, by whoever keeps the harbour light. ".repeat(2).slice(0, 200);
    it.host.quietly(() => {
      for (let i = 1; i < n; i++) it.host.say(chatId, i % 2 === 0 ? "user" : "assistant", `${i}: ${line}`);
      const chat = it.host.chatList.get(chatId);
      if (chat !== undefined) chat.characterId = "char-joss";
      for (const [id, name] of [["book-joss", "Joss"], ["book-mara", "Mara"], ["book-tides", "The tides"]] as const) it.host.books.set(id, { book: { id, name, description: "" }, userId: USER, updatedAt: Date.UTC(2024, 4, 2, 8, 0, 0), entries: [{ id: `entry-${id}`, bookId: id, title: name, keys: [name.toLowerCase()], secondaryKeys: [], content: `${name}, of the harbour.`, enabled: true, constant: false }] });
    });
    it.host.characterBooks.set("char-joss", ["book-joss"]);
    it.host.personaBook = "book-mara";
    it.host.globalBooks = ["book-tides"];
    return chatId;
  }

  /** The chat and lore reads that crossed the link during one turn, the chat's first since the runtime started, as the core reads them for a reply. */
  async function counted(road: "copy" | "link", n: number): Promise<{ crossings: number; types: Record<string, number> }> {
    const it = await started({ reads: road });
    const chatId = await longChat(it, n);
    it.host.script = [{ toolCalls: [toolCall("write_reply", { brief: "Okoro." }, "c1")] }, "Okoro keeps it."];
    if (road === "copy") await copyHolds(it, (state) => state.road === "copy", "the copy to be offered");
    const from = it.lumiverse.frames.length;
    const reply = await it.generate(chatId);
    expect(reply.content).toBe("Okoro keeps it.");
    const types: Record<string, number> = {};
    for (const type of sent(it.lumiverse, from)) if (isRead(type)) types[type] = (types[type] ?? 0) + 1;
    // The copy read from Lumiverse the books that apply to the chat: its character's and every chat's (Lumiverse said the turn's prompt had no persona, so the persona's book isn't one).
    if (road === "copy") expect((await chatData(it)).books.map((b) => b.id).sort()).toEqual(["book-joss", "book-tides"]);
    return { crossings: Object.values(types).reduce((sum, k) => sum + k, 0), types };
  }

  test("for a chat of 20 messages and one of 2,000, with the copy and without it", async () => {
    const short = { copy: await counted("copy", 20), link: await counted("link", 20) };
    const long = { copy: await counted("copy", 2_000), link: await counted("link", 2_000) };
    // With the copy, nothing of the chat or its books crosses, nor any list of the books that apply to it (they come with the turn's lore): what does is what the extension alone knows (the chat's story choice, its book, the lore active for the turn). Without it, the path crosses whole: 20 messages or 2,000.
    for (const { copy } of [short, long]) expect(Object.keys(copy.types).filter(ofChat)).toEqual([]);
    const copied = { "chat.info": 3, "book.read": 1, "turn.lore": 1, "recall.lore.activated": 1 };
    const linked = { "chat.info": 3, "chat.path": 1, "book.read": 1, "recall.lore.read": 1, "recall.lore.activated": 1 };
    expect({ short, long }).toEqual({ short: { copy: { crossings: 6, types: copied }, link: { crossings: 7, types: linked } }, long: { copy: { crossings: 6, types: copied }, link: { crossings: 7, types: linked } } });
  }, 60_000);
});

describe("the runtime's sign-in to Lumiverse", () => {
  test("expired: a read isn't taken for a chat that isn't there, it goes to the extension, and the page says the sign-in needs renewing", async () => {
    const seen: Seen[] = [];
    const it = await started({ harness: seeing(seen), reads: "copy" });
    const chatId = await it.setUp();
    await it.generate(chatId);
    await kept(it, chatId);
    // Lumiverse no longer takes the runtime's session.
    it.lumiverse.token = "a session Lumiverse ended";
    it.host.say(chatId, "user", "Still there?");
    await it.generate(chatId);
    expect(texts(seen[1]?.messages ?? [])).toEqual(["user: Who keeps the harbour light now?", "assistant: Noted.", "user: Still there?", "assistant: "]);
    const state = await chatData(it);
    expect(state.signIn).toBe("The runtime's Lumiverse session for http://127.0.0.1:7860 is no longer valid (it expired, or was signed out). Sign it in again: lumiah login");
    expect(state.fallbacks.latest.at(-1)?.why).toContain("The runtime's Lumiverse session is no longer valid");
  });
});

// Lumiverse's HTTP routes are no interface it promises to keep: a release may move or change them, and a
// test bed may serve none of them. Their "not found" says nothing of a chat; only the link's answer may.
describe("Lumiverse's own routes not answering as the runtime expects", () => {
  /** A request to a route the copy reads: a chat's row or messages, a world book. */
  const copyRoute = (asked: { line: string }): boolean => /^GET \/api\/v1\/(chats|world-books)\//.test(asked.line);

  test("a Lumiverse that serves none of them still plays whole turns with the right answers, through the extension, the page says why, and the chat is read from them once they answer", async () => {
    const seen: Seen[] = [];
    const it = await started({ harness: seeing(seen), reads: "copy" });
    it.lumiverse.serves = () => false;
    const chatId = await it.setUp();
    await it.generate(chatId);
    it.host.say(chatId, "user", "And before him?");
    const from = it.lumiverse.frames.length;
    await it.generate(chatId);

    expect(texts(seen[0]?.messages ?? [])).toEqual(["user: Who keeps the harbour light now?", "assistant: "]);
    expect(texts(seen[1]?.messages ?? [])).toEqual(["user: Who keeps the harbour light now?", "assistant: Noted.", "user: And before him?", "assistant: "]);
    expect(seen[1]?.path.map((m) => m.role)).toEqual(["user", "assistant", "user", "assistant"]);
    // Lumiverse's routes were asked and said 404; the extension answered every read of the chat.
    expect(it.lumiverse.asked.some(copyRoute)).toBe(true);
    expect(sent(it.lumiverse, from).filter(ofChat).length).toBeGreaterThan(0);
    const state = await chatData(it);
    expect(state.road).toBe("copy");
    // Nothing kept, and nothing kept as gone.
    expect(state.chats).toEqual([]);
    expect(state.fallbacks.total).toBe(0);
    expect(state.routes.total).toBeGreaterThan(0);
    expect(state.routes.latest.at(-1)).toMatchObject({ what: "chat", id: chatId, status: 404, until: null });
    const said = chatDataLines(state, Date.now(), "LumiAH").find((line) => line.text.startsWith("Lumiverse's own routes aren't answering as the runtime expects"));
    expect(said?.tone).toBe("warn");
    expect(said?.text).toContain(`went to LumiAH instead, the slower way. The latest, `);
    expect(said?.text).toContain(`answered 404 for chat ${chatId}.`);

    // Served again: the next run's reads are the copy's, with no read of the chat through the extension.
    it.lumiverse.serves = () => true;
    await it.generate(chatId, { type: "continue" });
    await kept(it, chatId);
    const again = it.lumiverse.frames.length;
    await it.generate(chatId, { type: "continue" });
    expect(texts(seen[3]?.messages ?? [])).toEqual(["user: Who keeps the harbour light now?", "assistant: Noted.", "user: And before him?", "assistant: Noted.Noted."]);
    expect(sent(it.lumiverse, again).filter(ofChat)).toEqual([]);
  });

  test("one that says 404 for one chat alone, another user's: its reads go to the extension, which says there is no such chat, and the user's own is still read from the copy", async () => {
    const held: { host: HarnessHost | null } = { host: null };
    const it = await started({ harness: holding(held), reads: "both" });
    const chatId = await it.setUp();
    const theirs = it.host.addChat("user-ilse", "Ilse's harbour");
    it.host.say(theirs.id, "user", "Not Mara's to read.");
    await copyHolds(it, (state) => state.road === "copy", "the copy to be offered");
    const host = held.host as HarnessHost;

    // Both roads asked, and both say so in the extension's words.
    await expect(host.chat.path(theirs.id)).rejects.toThrow("There is no such chat in this account.");
    await expect(host.chat.messages(theirs.id, 0, 10)).rejects.toThrow("There is no such chat in this account.");
    await expect(host.lore.books(theirs.id)).rejects.toThrow("There is no such chat in this account.");
    expect((await host.chat.messages(chatId, 0, 10)).map((m) => m.content)).toEqual(["Who keeps the harbour light now?"]);
    expect(it.differences).toEqual([]);

    const state = await chatData(it);
    expect(state.routes.total).toBeGreaterThan(0);
    for (const note of state.routes.latest) expect(note).toMatchObject({ what: "chat", id: theirs.id, status: 404, until: null });
    expect(state.chats.map((c) => c.id)).toEqual([chatId]);
  });

  test("one that didn't answer for several different chats in a row is asked nothing for a while, its reads going straight to the extension, and read from again once it answers", async () => {
    const held: { host: HarnessHost | null } = { host: null };
    const it = await started({ harness: holding(held), reads: "copy", routePauseMs: 400 });
    const chatId = await it.setUp();
    const others = ["The quay", "The lamp room", "The fish market"].map((name) => {
      const chat = it.host.addChat(USER, name);
      it.host.say(chat.id, "user", `A line about ${name.toLowerCase()}.`);
      return chat.id;
    });
    await copyHolds(it, (state) => state.road === "copy", "the copy to be offered");
    const host = held.host as HarnessHost;

    it.lumiverse.serves = () => false;
    // Each read right, through the extension.
    for (const [i, other] of others.entries()) expect((await host.chat.messages(other, 0, 10)).map((m) => m.content)).toEqual([`A line about ${["the quay", "the lamp room", "the fish market"][i]}.`]);
    const paused = (await chatData(it)).routes.latest.at(-1);
    expect(paused).toMatchObject({ status: 404, until: expect.any(Number) });
    expect(paused?.why).toContain("different chats in a row, so the runtime asks it nothing for 400 ms");
    // While that lasts, a read asks none of Lumiverse's routes.
    const asked = it.lumiverse.asked.filter(copyRoute).length;
    expect((await host.chat.messages(chatId, 0, 10)).map((m) => m.content)).toEqual(["Who keeps the harbour light now?"]);
    expect(it.lumiverse.asked.filter(copyRoute).length).toBe(asked);
    expect(chatDataLines(await chatData(it), Date.now(), "LumiAH").at(-1)?.text).toContain("the runtime asks that route nothing and reads everything it would give through LumiAH");

    // Served again, and once the while is over the copy reads from them and keeps the chat. The rig's runtime keeps the platform's clock, which no test can move, so the while is waited out for real: the whole of its 400 ms from here, when every route it counted against had already answered.
    it.lumiverse.serves = () => true;
    await Bun.sleep(400);
    expect((await host.chat.messages(chatId, 0, 10)).map((m) => m.content)).toEqual(["Who keeps the harbour light now?"]);
    expect(it.lumiverse.asked.filter(copyRoute).length).toBeGreaterThan(asked);
    expect((await chatData(it)).chats.find((c) => c.id === chatId)?.from).toBe("http");
  });
});

describe("what the extension tells the copy", () => {
  test("an event lost on the way is found missing by the next one's number, and everything the copy holds is read again before it is used", async () => {
    const seen: Seen[] = [];
    const it = await started({ harness: seeing(seen), reads: "copy" });
    const chatId = await it.setUp();
    await it.generate(chatId);
    await kept(it, chatId);
    // Lumiverse's socket drops the next event push: an edit of the first message, which no check would see.
    let dropped = 0;
    it.lumiverse.filter = (frame) => !(frame.type === "event" && dropped++ === 0);
    const [asked] = it.host.chatList.get(chatId)?.messages ?? [];
    if (asked !== undefined) asked.swipes[0] = "Who keeps the light?";
    await it.backend.settle();
    await until(() => dropped > 0, "the push dropped");
    it.lumiverse.filter = () => true;
    // The next push is numbered one past the one that never came. (At a ping, the count the extension says shows the same: the backend's copy tests hold that count.)
    it.host.say(chatId, "user", "Still there?");
    await copyHolds(it, (state) => state.events.gaps > 0, "the gap found");
    await it.generate(chatId);
    expect(texts(seen[1]?.messages ?? [])).toEqual(["user: Who keeps the light?", "assistant: Noted.", "user: Still there?", "assistant: "]);
    const state = await chatData(it);
    expect(state.events.gaps).toBe(1);
    expect(state.events.lastGap?.why).toBe("push 5 of LumiAH's never reached the runtime");
  });

  test("the last event lost on the way, with none after it, is found missing at the next ping by the extension's count of what it sent, and the next run reads the change", async () => {
    const seen: Seen[] = [];
    const it = await started({ harness: seeing(seen), reads: "copy", idlePingMs: 20 });
    const chatId = await it.setUp();
    await it.generate(chatId);
    await kept(it, chatId);
    // Lumiverse's socket drops the push of an edit of the first message, which no check would see; nothing is pushed after it.
    let dropped = -1;
    it.lumiverse.filter = (frame) => {
      const edit = frame.type === "event" && JSON.stringify(frame.payload).includes("Who keeps the light?");
      if (edit) dropped = it.lumiverse.frames.length;
      return !edit;
    };
    const [asked] = it.host.chatList.get(chatId)?.messages ?? [];
    if (asked !== undefined) asked.swipes[0] = "Who keeps the light?";
    await it.backend.settle();
    await until(() => dropped >= 0, "the push dropped");
    await copyHolds(it, (state) => state.events.gaps > 0, "the gap found at a ping");
    // No push came after the one dropped: the ping's answer found it.
    const numbered = it.lumiverse.frames.slice(dropped).filter((frame) => {
      const wire: unknown = JSON.parse(frame.text);
      const data = isRecord(wire) && isRecord(wire.payload) ? wire.payload.data : null;
      return frame.to === "runtime" && isRecord(data) && ["event", "own", "copy"].includes(String(data.type));
    });
    expect(numbered).toEqual([]);
    await it.generate(chatId, { type: "continue" });
    expect(texts(seen[1]?.messages ?? [])).toEqual(["user: Who keeps the light?", "assistant: Noted."]);
    const state = await chatData(it);
    expect(state.events.gaps).toBe(1);
    expect(state.events.lastGap?.why).toMatch(/^push \d+ of LumiAH's never reached the runtime$/);
  });

  test("the link going down has the copy read again what it holds, and reopening it too", async () => {
    const it = await started({ reads: "copy" });
    const chatId = await it.setUp();
    it.host.script = [{ toolCalls: [toolCall("write_reply", { brief: "Okoro." }, "c1")] }, "Okoro keeps it."];
    await it.generate(chatId);
    await kept(it, chatId);
    it.lumiverse.dropSockets();
    await until(() => !it.runtime.link.up, "the link down");
    await until(() => it.runtime.link.up, "the link up again");
    const state = await chatData(it);
    expect(state.chats.find((c) => c.id === chatId)?.stale).toMatch(/^the link to the extension (went down|reopened), so events may have been missed$/);
  });
});
