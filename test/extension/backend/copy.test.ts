// What the extension tells and answers the runtime's copy of chat and lore (PI-BUILD-PLAN §4.5): Lumiverse's
// events forwarded to the user's own runtimes and no one else's, numbered so a lost one shows; what the
// copy may read, said on hello and again when it changes; the reads it asks of the extension's own host,
// each for the runtime's own user; a mounting extension's records kept elsewhere; and the persona and
// activated entries of a chat's latest generation. Two users share the Lumiverse here, each with a
// runtime of their own. Every chat, name and text is made up.

import { afterEach, describe, expect, test } from "bun:test";
import type { JsonValue } from "../../../src/core/ports";
import type { BackendOptions } from "../../../src/extension/backend/backend";
import { LINK, LINK_VERSION } from "../../../src/link/contract";
import { isRecord } from "../../../src/link/json";
import type { Runtime } from "../../../src/runtime/runtime";
import { FakeLumiverse } from "../../support/fake-lumiverse";
import { BUILD, type Rig, rig, runtimeFor, until, USER } from "../../support/rig";

const ILSE = "user-ilse";

let open: Rig | null = null;
const others: Runtime[] = [];
afterEach(async () => {
  for (const runtime of others.splice(0)) {
    runtime.shutdown();
    await runtime.close();
  }
  await open?.close();
  open = null;
});

/** A second user of the same Lumiverse, with a runtime of her own linked to the same extension. */
async function ilse(it: Rig): Promise<{ lumiverse: FakeLumiverse; runtime: Runtime; secret: string }> {
  const lumiverse = new FakeLumiverse(it.host, ILSE);
  lumiverse.token = "session-token-ilse";
  const registered = await lumiverse.raw({ type: "register", name: "ilse", build: BUILD, host: "mill-box", listen: "127.0.0.1", port: 7872 }, ILSE);
  const body = registered.type === "result" ? registered.body : null;
  if (!isRecord(body) || typeof body.relay !== "string" || typeof body.secret !== "string") throw new Error("ilse's runtime couldn't register");
  const runtime = runtimeFor(lumiverse, { relay: body.relay, secret: body.secret }, []);
  others.push(runtime);
  await runtime.link.connect();
  return { lumiverse, runtime, secret: body.secret };
}

/** Every link frame of a kind a runtime's socket carried to it, in order. */
function pushed(lumiverse: FakeLumiverse, type: string): Record<string, unknown>[] {
  return lumiverse.frames.flatMap((frame) => {
    if (frame.to !== "runtime") return [];
    const sent: unknown = JSON.parse(frame.text);
    const data = isRecord(sent) && isRecord(sent.payload) ? sent.payload.data : null;
    return isRecord(data) && data.type === type ? [data] : [];
  });
}

/** The events a runtime's socket carried of the made-up chats these tests name (the rig's own chat is told of too, as its rows change). */
function about(lumiverse: FakeLumiverse, chats: readonly string[]): Record<string, unknown>[] {
  return pushed(lumiverse, "event").filter((push) => isRecord(push.payload) && chats.includes(String(push.payload.chatId)));
}

/** A message as Lumiverse's events carry one (`rowToMessage`), as far as a test needs it. */
const row = (chatId: string, id: string, index: number, content: string): Record<string, JsonValue> => ({ id, chat_id: chatId, index_in_chat: index, is_user: true, name: "Mara", content, swipes: [content], swipe_id: 0, extra: {}, send_date: 1_700_000_000, created_at: 1_700_000_000, revision: 1 });

describe("Lumiverse's events, for the runtime's copy", () => {
  test("each reaches the runtimes of the user it is of and no one else's, in the order heard and numbered, and one Lumiverse says is nobody's goes nowhere", async () => {
    const it = (open = await rig());
    await it.setUp();
    const her = await ilse(it);
    const named = ["chat-harbour", "chat-mill"];

    it.host.emit.lumiverse("MESSAGE_SENT", { chatId: "chat-harbour", message: row("chat-harbour", "m-1", 0, "Who keeps the light?") }, USER);
    it.host.emit.lumiverse("MESSAGE_SENT", { chatId: "chat-mill", message: row("chat-mill", "m-9", 0, "The wheel is turning.") }, ILSE);
    it.host.emit.lumiverse("MESSAGE_EDITED", { chatId: "chat-harbour", message: row("chat-harbour", "m-1", 0, "Who keeps the harbour light?") }, USER);
    it.host.emit.lumiverse("WORLD_BOOK_ENTRY_DELETED", { id: "entry-1", worldBookId: "book-1" }, null);
    // A Lumiverse event the copy has no use for isn't forwarded at all.
    it.host.emit.lumiverse("CHARACTER_EDITED", { id: "char-1" }, USER);
    await it.backend.settle();
    await until(() => about(it.lumiverse, named).length === 2 && about(her.lumiverse, named).length === 1, "the events at each runtime");

    const mara = about(it.lumiverse, named);
    // The payload goes as Lumiverse sent it.
    expect(mara).toMatchObject([
      { name: "MESSAGE_SENT", userId: USER, payload: { chatId: "chat-harbour", message: row("chat-harbour", "m-1", 0, "Who keeps the light?") } },
      { name: "MESSAGE_EDITED", userId: USER, payload: { chatId: "chat-harbour", message: row("chat-harbour", "m-1", 0, "Who keeps the harbour light?") } },
    ]);
    expect(about(her.lumiverse, named)).toMatchObject([{ name: "MESSAGE_SENT", userId: ILSE, payload: { chatId: "chat-mill" } }]);
    // Nothing of Mara's ever reached Ilse's socket, nor the other way.
    expect(her.lumiverse.frames.some((f) => f.text.includes("chat-harbour"))).toBe(false);
    expect(it.lumiverse.frames.some((f) => f.text.includes("chat-mill"))).toBe(false);
    // Numbered one after another for each runtime on its own.
    expect(mara[1]?.seq).toBe(Number(mara[0]?.seq) + 1);
  });

  test("a runtime's ping says how many it has been sent, so a push lost on the way shows as a gap", async () => {
    const it = (open = await rig());
    await it.setUp();
    it.host.emit.lumiverse("MESSAGE_DELETED", { chatId: "chat-harbour", messageId: "m-1" }, USER);
    await it.backend.settle();
    await until(() => about(it.lumiverse, ["chat-harbour"]).length === 1, "the event");
    const sent = Number(about(it.lumiverse, ["chat-harbour"])[0]?.seq);

    // The next one is lost on the way: Lumiverse dropped it.
    it.lumiverse.filter = (frame) => frame.type !== "event";
    it.host.emit.lumiverse("MESSAGE_DELETED", { chatId: "chat-harbour", messageId: "m-2" }, USER);
    await it.backend.settle();
    expect(about(it.lumiverse, ["chat-harbour"])).toHaveLength(1);
    expect(await it.lumiverse.raw({ type: "ping", secret: it.registration.secret, report: it.runtime.link.report(), streams: [], turns: [] })).toMatchObject({ type: "result", body: { told: sent + 1 } });
  });
});

describe("what the copy may read, said on hello", () => {
  test("names the extension whose entry on a message is its own and the permissions its reads rest on, with nothing kept elsewhere, no lore declined and no database file for LumiAH on its own", async () => {
    const it = (open = await rig());
    await it.setUp();
    const hello = await it.lumiverse.raw({ type: "hello", secret: it.registration.secret, version: LINK_VERSION, build: BUILD, report: it.runtime.link.report(), open: [] });
    expect(hello).toEqual({ type: "result", body: expect.objectContaining({ copy: { identifier: "lumi_ah", granted: ["chats", "chat_mutation", "world_books"], ownElsewhere: false, declinesLore: false, records: { under: null }, database: null, told: expect.any(Number) } }) });
  });

  test("a permission revoked is told to every runtime that said hello, each in its own count; one the copy's reads don't rest on is no news", async () => {
    const it = (open = await rig());
    await it.setUp();
    const her = await ilse(it);
    it.host.grant("world_books", false);
    await it.backend.settle();
    await until(() => pushed(it.lumiverse, "copy").length === 1 && pushed(her.lumiverse, "copy").length === 1, "the new offer at each runtime");
    for (const lumiverse of [it.lumiverse, her.lumiverse]) expect(pushed(lumiverse, "copy")).toMatchObject([{ seq: expect.any(Number), offer: { identifier: "lumi_ah", granted: ["chats", "chat_mutation"], ownElsewhere: false, declinesLore: false, records: { under: null }, database: null } }]);
    it.host.grant("presets", false);
    await it.backend.settle();
    expect(pushed(it.lumiverse, "copy")).toHaveLength(1);
  });
});

describe("the reads the copy asks of the extension's own host", () => {
  test("are answered for the runtime's own user, whatever user the host is asked for, and a chat's messages only for a chat of that user's", async () => {
    const it = (open = await rig());
    const chatId = await it.setUp();
    it.host.say(chatId, "assistant", "Okoro keeps it now.");
    const theirs = it.host.addChat(ILSE, "The mill");
    it.host.say(theirs.id, "user", "The wheel is turning.");
    it.host.books.set("book-harbour", { book: { id: "book-harbour", name: "The harbour", description: "" }, userId: USER, entries: [{ id: "entry-lamp", bookId: "book-harbour", title: "The lamp", keys: ["lamp"], secondaryKeys: [], content: "Lit at dusk.", enabled: true, constant: false }] });
    it.host.books.set("book-mill", { book: { id: "book-mill", name: "The mill", description: "" }, userId: ILSE, entries: [] });
    const read = async (port: "chats" | "lore", method: string, args: JsonValue[]): Promise<JsonValue> => (await it.runtime.link.request("host.read", { port, method, args }, 5_000)).value;

    expect(await read("chats", "get", [chatId])).toMatchObject({ id: chatId, name: "Harbour light" });
    expect(await read("chats", "get", [theirs.id])).toBeNull();
    expect(await read("chats", "messages", [chatId, null])).toMatchObject([{ content: "Who keeps the harbour light now?" }, { content: "Okoro keeps it now." }]);
    expect(await read("chats", "messages", [chatId, { tail: 1 }])).toMatchObject([{ content: "Okoro keeps it now." }]);
    // Another user's chat by its id alone: refused in the words for no chat at all, and nothing of it read.
    const reads = it.host.reads.length;
    await expect(read("chats", "messages", [theirs.id, null])).rejects.toThrow("There is no such chat in this account.");
    await expect(read("chats", "swipe", [theirs.id, theirs.messages[0]?.id ?? "", 0])).rejects.toThrow("There is no such chat in this account.");
    expect(it.host.reads.slice(reads).filter((r) => r.chatId === theirs.id)).toEqual([]);
    expect(await read("chats", "list", [0, 10])).toMatchObject({ total: 1, chats: [{ id: chatId }] });
    expect(await read("lore", "book", ["book-harbour"])).toEqual({ id: "book-harbour", name: "The harbour", description: "" });
    expect(await read("lore", "book", ["book-mill"])).toBeNull();
    expect(await read("lore", "records", ["book-mill"])).toEqual([]);
    expect(await read("lore", "entries", ["book-harbour"])).toMatchObject([{ title: "The lamp" }]);
    // A read the host has no member for is refused as malformed.
    await expect(read("chats", "setOwn", [chatId, "m1", null])).rejects.toThrow("There is no read chats.setOwn");
  });

  test("the persona and the entries Lumiverse activated for a chat's latest generation, for the user's own chat alone, with the lists of world books the chat's lore is read with", async () => {
    const it = (open = await rig());
    const chatId = await it.setUp();
    it.host.globalBooks = ["book-tides"];
    it.host.personaBook = "book-mara";
    it.host.characterBooks.set("char-joss", ["book-joss", "book-quay"]);
    const lists = { global: ["book-tides"], active: "book-mara", character: [] };
    // No generation of the chat heard since the extension started.
    expect(await it.runtime.link.request("turn.lore", { chat: chatId }, 5_000)).toEqual({ activated: [], books: lists });
    // The character the runtime names: its books come with the rest.
    expect(await it.runtime.link.request("turn.lore", { chat: chatId, character: "char-joss" }, 5_000)).toEqual({ activated: [], books: { ...lists, character: ["book-joss", "book-quay"] } });
    it.host.script = ["The lamp is lit at dusk."];
    await it.generate(chatId, { lore: [{ entryId: "entry-lamp", bookId: "book-harbour", title: "The lamp", text: "Lit at dusk.", how: "key" }] });
    expect(await it.runtime.link.request("turn.lore", { chat: chatId }, 5_000)).toEqual({ persona: null, activated: [{ entryId: "entry-lamp", bookId: "book-harbour", title: "The lamp", how: "key" }], books: lists });
    // A list the extension isn't allowed to read is none.
    it.host.permissions.delete("personas");
    expect((await it.runtime.link.request("turn.lore", { chat: chatId }, 5_000)).books?.active).toBeNull();
    // Another user hears nothing of Mara's chat's generation.
    const her = await ilse(it);
    const hers = await her.runtime.link.request("turn.lore", { chat: chatId }, 5_000);
    expect(hers.activated).toEqual([]);
    expect("persona" in hers).toBe(false);
  });
});

describe("an extension that keeps LumiAH's records elsewhere", () => {
  /** A mounting extension that keeps each chat's records in a ledger of its own, by chat and message, says when they change, and gives LumiAH no lore. */
  function ledgered(): { options: BackendOptions; ledger: Map<string, Record<string, JsonValue>>; changed(chatId: string, userId: string | null): void } {
    const ledger = new Map<string, Record<string, JsonValue>>();
    const listeners: ((chatId: string, userId: string | null) => void)[] = [];
    return {
      ledger,
      changed: (chatId, userId) => {
        for (const listener of listeners) listener(chatId, userId);
      },
      options: {
        identity: { identifier: "lamp_room", name: "Lamp Room", connectionName: "Lamp Room loopback" },
        ownElsewhere: { read: async (chatId) => ledger.get(chatId) ?? {}, onChanged: (listener) => void listeners.push(listener) },
        declinesLore: true,
      },
    };
  }

  test("says so on hello, gives a chat's records to the chat's own user alone, and tells only that user's runtimes when they change", async () => {
    const lamp = ledgered();
    const it = (open = await rig({ backend: lamp.options }));
    const chatId = await it.setUp();
    const message = it.host.chatList.get(chatId)?.messages[0]?.id ?? "";
    lamp.ledger.set(chatId, { [message]: { v: 1, swipes: { "0": { v: 1, generationId: "gen-1" } } } });
    const hello = await it.lumiverse.raw({ type: "hello", secret: it.registration.secret, version: LINK_VERSION, build: BUILD, report: it.runtime.link.report(), open: [] });
    expect(hello).toMatchObject({ type: "result", body: { copy: { identifier: "lamp_room", ownElsewhere: true, declinesLore: true, database: null } } });
    // The raw hello took the runtime's pushes to its own session: the runtime says hello again.
    await it.runtime.link.connect();

    expect(await it.runtime.link.request("own.read", { chat: chatId }, 5_000)).toEqual({ entries: { [message]: { v: 1, swipes: { "0": { v: 1, generationId: "gen-1" } } } } });
    const her = await ilse(it);
    await expect(her.runtime.link.request("own.read", { chat: chatId }, 5_000)).rejects.toThrow("There is no such chat in this account.");

    const before = { mara: pushed(it.lumiverse, "own").length, ilse: pushed(her.lumiverse, "own").length };
    lamp.changed(chatId, USER);
    // Whose chat it is unsaid: found among the users with a runtime here, and only its own user's told.
    lamp.changed(chatId, null);
    await it.backend.settle();
    await until(() => pushed(it.lumiverse, "own").length === before.mara + 2, "both changes at Mara's runtime");
    expect(pushed(it.lumiverse, "own").slice(before.mara)).toMatchObject([{ chat: chatId }, { chat: chatId }]);
    expect(pushed(her.lumiverse, "own")).toHaveLength(before.ilse);
  });

  test("LumiAH on its own refuses `own.read`: its records are on the messages", async () => {
    const it = (open = await rig());
    const chatId = await it.setUp();
    await expect(it.runtime.link.request("own.read", { chat: chatId }, 5_000)).rejects.toThrow("LumiAH keeps LumiAH's records on the messages themselves");
  });
});

describe("the direct database reader's switch", () => {
  test("is the operator's alone: anyone else is refused and shown neither the switch nor the file, only the operator's runtimes are told of the file, and one whose operator is no more is told it no longer holds", async () => {
    const it = (open = await rig());
    await it.setUp();
    it.host.databaseFile = "/srv/lumiverse/data/lumiverse.db";
    const her = await ilse(it);
    // Ilse is this Lumiverse's operator; Mara is a user of it.
    it.host.roles.set(ILSE, "operator");

    await expect(it.page.request("lah.runtime.database", { on: true })).rejects.toThrow("Only this Lumiverse's operator can switch the database reader on or off.");
    const asOperator = her.lumiverse.page(ILSE);
    expect(await asOperator.request("lah.runtime.database", { on: true })).toEqual({ database: { operator: true, on: true, path: "/srv/lumiverse/data/lumiverse.db" } });
    await it.backend.settle();
    await until(() => pushed(her.lumiverse, "copy").length === 1, "the file told to the operator's runtime");
    expect(pushed(her.lumiverse, "copy")).toMatchObject([{ offer: { database: "/srv/lumiverse/data/lumiverse.db" } }]);
    // Nothing of it reached the other user's runtime, nor is the file named on the wire to her.
    expect(pushed(it.lumiverse, "copy")).toEqual([]);
    expect(it.lumiverse.frames.some((f) => f.text.includes("lumiverse.db"))).toBe(false);
    // Mara's own runtime says hello: no file for her.
    expect(await it.lumiverse.raw({ type: "hello", secret: it.registration.secret, version: LINK_VERSION, build: BUILD, report: it.runtime.link.report(), open: [] })).toMatchObject({ type: "result", body: { copy: { database: null } } });

    // Ilse is the operator no more: her runtime is told at its next ping that the file is no longer its to read.
    it.host.roles.set(ILSE, "admin");
    // Her runtime's next ping, on its own socket.
    const session = [...her.lumiverse.sockets.keys()][0] ?? "";
    it.host.deliver({ link: LINK, id: "ping-now", type: "ping", secret: her.secret, report: her.runtime.link.report(), streams: [], turns: [] }, ILSE, session);
    await until(() => pushed(her.lumiverse, "copy").length === 2, "the file taken back at the next ping");
    expect(pushed(her.lumiverse, "copy")[1]).toMatchObject({ offer: { database: null } });
    // And a page of hers is shown no switch and no file.
    await expect(asOperator.request("lah.runtime.database", { on: false })).rejects.toThrow("Only this Lumiverse's operator");
  });
});
