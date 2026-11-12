// The runtime's reads of chats and world books, composed (src/runtime/reads.ts), on their own: a
// runtime's `createChatData` over a link and an HTTP to Lumiverse made up for each test. The extension's
// answers over the link are LumiAH's backend's own (`CopyFeed` and the shared logic of src/host/) over
// the same made-up Lumiverse (copy/lumiverse.ts) whose routes the runtime reads. What a test here checks
// is what a user, or an extension that builds LumiAH in, would notice: what a read answers, what
// crossed to the extension for it, what was asked of Lumiverse and how, and what Runtime → Chat data
// says. Every chat, book, name and text is made up.

import { afterEach, describe, expect, test } from "bun:test";
import type { JsonValue } from "../../src/core/ports";
import { CopyFeed } from "../../src/extension/backend/copy";
import { type BackendHost, createSpindleHost } from "../../src/extension/backend/spindle";
import { ChatReader, OWN_ANCHORS } from "../../src/host/chat";
import { Lore } from "../../src/host/lore";
import { RecallReads } from "../../src/host/recall";
import { LinkRefused } from "../../src/host/refused";
import type { ActivatedInfo, LoreReads } from "../../src/host/rows";
import { type CopyOffer, LINK } from "../../src/link/contract";
import { RUNTIME_DEFAULTS, type RuntimeTuning } from "../../src/link/settings";
import { LinkError } from "../../src/runtime/connection";
import { createHttpSource } from "../../src/runtime/copy/http";
import { DatabaseOff, type DbSource } from "../../src/runtime/db";
import type { RuntimeLink } from "../../src/runtime/link";
import { type Http, type HttpRequest, loginAgain } from "../../src/runtime/lumiverse";
import { type ChatData, type CoreReads, createChatData } from "../../src/runtime/reads";
import type { SettingsOwner } from "../../src/shared/timeouts";
import { Lumiverse } from "./copy/lumiverse";
import { LUMIAH, restoreSpindle, USER } from "./copy/rig";
import { until } from "../support/rig";

const scope = globalThis as Record<string, unknown>;
const BASE = "http://127.0.0.1:7860";
const TOKEN = "session-token-mara";
/** The runtime's memory limit, as the page is given it beside the copy's own cap. */
const MEMORY = { limit: "none set", note: null };
/** What LumiAH's backend tells the copy on hello: LumiAH on its own, its records on the messages. */
const OFFER: CopyOffer = { identifier: LUMIAH, granted: ["chats", "chat_mutation", "world_books"], ownElsewhere: false, declinesLore: false, records: { under: null }, database: null, told: 0 };

afterEach(() => {
  restoreSpindle();
});

/** A runtime's chat data over the made-up Lumiverse, and what a test reads and steers of it. */
interface Runtime {
  data: ChatData;
  /** The same reads as the extension answers them over the link, the road taken without a copy. */
  viaLink: CoreReads;
  /** Every request the runtime made of Lumiverse over HTTP, as it made it. */
  requests: HttpRequest[];
  /** Every request that crossed to the extension, by its type: a read of the extension's host by its member too (`host.read chats.get`), and the link road's own reads by theirs (`chat.path`). */
  crossed: string[];
  /** Lumiverse's side of the runtime's session: the token it takes, whether it says whose session that is, and the routes it answers with a redirect. */
  lumiverse: { token: string; sessionFails: boolean; moved: RegExp | null };
  /** The link: down while `up` is false, when every request fails. */
  link: { up: boolean };
  /** The extension's side: the lists of world books that attach books to a chat, the chat's latest generation it heard, and whether its `turn.lore` carries the lists (false: a backend from before them). */
  extension: { global: string[]; active: string | null; personas: Map<string, string>; characters: Map<string, string[]>; turn: { personaId: string | null; activated: ActivatedInfo[] } | undefined; lists: boolean };
  /** The runtime's clock, in ms: the test moves it. */
  clock: { now: number };
  /** A hello: what the copy may read, as the extension said on it. */
  hello(offer?: Partial<CopyOffer>): void;
  /** Hands the copy, as numbered pushes, every event Lumiverse sent since the last time; those at the places in `lose` are lost on the way, their numbers spent. */
  forward(lose?: readonly number[]): void;
  /** How many pushes the extension has numbered so far. */
  told(): number;
}

interface RuntimeOptions {
  /** The extension's `own.read`: the records an extension LumiAH is built into keeps of a chat's messages elsewhere. Absent: LumiAH's own backend, which refuses it. */
  own?: (chatId: string) => Promise<Record<string, JsonValue>>;
  /** The database reader the runtime opens on a file the offer names. */
  database?: () => DbSource;
  tuning?: Partial<RuntimeTuning>;
  /** Whose Settings hold the runtime's waits. */
  owner?: SettingsOwner;
}

function runtimeOver(made: Lumiverse, options: RuntimeOptions = {}): Runtime {
  scope.spindle = made.spindle(LUMIAH);
  const spindle = createSpindleHost(LUMIAH);
  const crossed: string[] = [];
  const requests: HttpRequest[] = [];
  const lumiverse = { token: TOKEN, sessionFails: false, moved: null as RegExp | null };
  const link = { up: true };
  const clock = { now: Date.UTC(2026, 10, 12, 9, 0, 0) };
  const extension: Runtime["extension"] = { global: [], active: null, personas: new Map(), characters: new Map(), turn: undefined, lists: true };
  // The extension's host: the made-up Lumiverse's Spindle, with the lists of books that attach books to a chat as the test sets them.
  const lore: LoreReads = {
    book: (bookId, userId) => spindle.lore.book(bookId, userId),
    entries: (bookId, userId) => spindle.lore.entries(bookId, userId),
    entry: (entryId, userId) => spindle.lore.entry(entryId, userId),
    record: (bookId, userId) => spindle.lore.record(bookId, userId),
    records: (bookId, userId) => spindle.lore.records(bookId, userId),
    global: async () => [...extension.global],
    ofPersona: async (personaId) => (personaId === null ? extension.active : (extension.personas.get(personaId) ?? null)),
    ofCharacter: async (characterId) => [...(extension.characters.get(characterId) ?? [])],
  };
  const host = new Proxy(spindle, { get: (target, key) => (key === "lore" ? lore : Reflect.get(target, key, target)) }) as BackendHost;
  const chats = new ChatReader(host, async () => ({ chats: 0, ms: 0 }), Date.now, OWN_ANCHORS);
  const turns = { ofChat: () => extension.turn as never };
  const feed = new CopyFeed(host, { relays: { push: () => false }, registry: { read: async () => ({ relays: {} }) } as never, chats, turns, declinesLore: false, records: { under: null }, name: "LumiAH" });
  const lored = (): Lore => new Lore(host, { persona: () => extension.turn?.personaId, activatedBooks: () => [] });

  /** One request as the link carries it: refused in the extension's words and code, as an error frame is. */
  const answered = async <T>(work: () => Promise<T>): Promise<T> => {
    try {
      return await work();
    } catch (error) {
      if (error instanceof LinkRefused) throw new Error(error.message, { cause: new LinkError(error.code, error.message) });
      throw error;
    }
  };
  const answer = async (type: string, fields: Record<string, unknown>): Promise<unknown> => {
    switch (type) {
      case "host.read":
        return feed.read(USER, fields.port, fields.method, fields.args);
      case "own.read": {
        const read = options.own;
        if (read === undefined) return feed.own(USER, fields.chat);
        await chats.own(USER, String(fields.chat));
        return { entries: await read(String(fields.chat)) };
      }
      case "turn.lore": {
        if (extension.lists) return feed.turnLore(USER, fields.chat, fields.character);
        const turn = extension.turn;
        return turn === undefined ? { activated: [] } : { persona: turn.personaId, activated: turn.activated };
      }
    }
    throw new LinkRefused("bad_request", `There is no link request ${type}.`);
  };
  const runtimeLink: RuntimeLink = {
    get up() {
      return link.up;
    },
    out: null,
    refused: null,
    backendName: "LumiAH",
    request: (async (type: string, fields: Record<string, unknown>) => {
      crossed.push(type === "host.read" ? `host.read ${String(fields.port)}.${String(fields.method)}` : type);
      if (!link.up) throw new Error("The link to the extension is down.");
      return answered(() => answer(type, fields));
    }) as RuntimeLink["request"],
    notify: () => undefined,
  };
  const overLink = <T>(type: string, work: () => Promise<T>): Promise<T> => {
    crossed.push(type);
    if (!link.up) return Promise.reject(new Error("The link to the extension is down."));
    return answered(work);
  };
  const viaLink: CoreReads = {
    chat: {
      path: (chatId) => overLink("chat.path", () => chats.path(USER, chatId)),
      messages: (chatId, from, to) => overLink("chat.messages", () => chats.messages(USER, chatId, from, to)),
    },
    lore: {
      books: (chatId) => overLink("lore.books", async () => lored().books(USER, await chats.own(USER, chatId))),
      entries: (bookId) => overLink("lore.entries", () => lored().entries(USER, bookId)),
    },
    recall: {
      lore: { read: (chatId, known) => overLink("recall.lore.read", () => new RecallReads(host, { chats, lore: lored(), now: Date.now }).lore(USER, chatId, known)) },
      chat: { messages: (chatId, from, to) => overLink("recall.chat.messages", () => new RecallReads(host, { chats, lore: lored(), now: Date.now }).messages(USER, chatId, from, to)) },
    },
  };

  // Lumiverse's HTTP as the runtime reaches it: the session's routes of the made-up Lumiverse, behind its check of the bearer.
  const session = made.session(USER);
  const http: Http = async (request) => {
    requests.push(request);
    const path = request.url.slice(BASE.length);
    if (request.headers.Authorization !== `Bearer ${lumiverse.token}`) return { status: 401, header: () => null, text: JSON.stringify({ error: "Unauthorized" }) };
    if (path === "/api/auth/get-session" && lumiverse.sessionFails) return { status: 503, header: () => null, text: "" };
    if (lumiverse.moved?.test(path) === true) return { status: 302, header: (name) => (name.toLowerCase() === "location" ? `https://elsewhere.example${path}` : null), text: "" };
    const reply = await session(path, { headers: request.headers, ...(request.signal !== undefined ? { signal: request.signal } : {}) });
    const text = await reply.text();
    return { status: reply.status, header: (name) => reply.headers.get(name), text };
  };

  const tuning: RuntimeTuning = { ...RUNTIME_DEFAULTS, reconnectMaxMs: 20, ...options.tuning };
  const data = createChatData({
    link: runtimeLink,
    viaLink,
    base: BASE,
    credentials: () => ({ username: "mara", token: TOKEN, savedAt: 0 }),
    http,
    now: () => clock.now,
    tuning: () => tuning,
    log: () => undefined,
    pathKeeping: async () => ({ chats: 16, ms: 5 * 60_000 }),
    owner: () => options.owner ?? { name: "LumiAH" },
    sleep: async () => undefined,
    ...(options.database !== undefined ? { database: options.database } : {}),
  });
  let seq = 0;
  let forwarded = 0;
  return {
    data,
    viaLink,
    requests,
    crossed,
    lumiverse,
    link,
    extension,
    clock,
    hello(offer = {}) {
      // What Lumiverse sent before the hello is covered by what the copy reads again from it.
      forwarded = made.emitted.length;
      data.copied({ ...OFFER, ...offer, told: seq });
    },
    forward(lose = []) {
      made.emitted.slice(forwarded).forEach((event, i) => {
        // One Lumiverse says is nobody's goes nowhere, as the extension has it: it is numbered for no one.
        if (typeof event.userId !== "string") return;
        seq++;
        if (!lose.includes(i)) data.news({ link: LINK, type: "event", seq, name: event.name, payload: event.payload as JsonValue, userId: event.userId });
      });
      forwarded = made.emitted.length;
    },
    told: () => seq,
  };
}

/** Waits until the runtime reads from its copy: the offer heard and whose session it holds known. */
async function copying(it: Runtime): Promise<void> {
  await until(() => it.data.state(MEMORY).road === "copy", "the copy to be built");
}

/** A chat of Mara's with two messages. */
function harbour(lumiverse: Lumiverse, name = "Harbour light"): { chatId: string; first: string } {
  const chat = lumiverse.newChat(USER, { name });
  const first = lumiverse.say(chat.id, "Who keeps the harbour light now?", { user: true });
  lumiverse.say(chat.id, "Okoro keeps it.");
  return { chatId: chat.id, first: first.id };
}

const contents = async (it: Runtime, chatId: string): Promise<string[]> => (await it.data.reads.chat.messages(chatId, 0, 100)).map((m) => m.content);

describe("the runtime's session with Lumiverse", () => {
  test("asks with the bearer alone, never an Origin or a Cookie, and follows no redirect: a read whose route moved goes to the extension, which answers it", async () => {
    const lumiverse = new Lumiverse();
    const one = harbour(lumiverse);
    const other = harbour(lumiverse, "The quay");
    const it = runtimeOver(lumiverse);
    it.hello();
    await copying(it);
    expect(await contents(it, one.chatId)).toEqual(["Who keeps the harbour light now?", "Okoro keeps it."]);
    expect(it.crossed).toEqual([]);

    // Lumiverse answers its routes with a redirect elsewhere.
    it.lumiverse.moved = /^\/api\/v1\//;
    expect(await contents(it, other.chatId)).toEqual(["Who keeps the harbour light now?", "Okoro keeps it."]);
    expect(it.crossed).toContain("host.read chats.messages");
    const moved = it.data.state(MEMORY).routes.latest.at(-1)?.why;
    expect(moved).toContain(`a redirect to https://elsewhere.example/api/v1/chats/${other.chatId}`);
    expect(moved).toContain("which the runtime doesn't follow");

    expect(it.requests.length).toBeGreaterThan(2);
    for (const request of it.requests) {
      expect(request.method).toBe("GET");
      expect(request.url.startsWith(`${BASE}/api/`)).toBe(true);
      expect(Object.keys(request.headers).map((name) => name.toLowerCase())).not.toContainAnyValues(["origin", "cookie"]);
      expect(request.headers.Authorization).toBe(`Bearer ${TOKEN}`);
    }
  });

  test("expired: a read goes to the extension and is answered there, never taken for a chat that isn't there, and the page says the sign-in needs renewing", async () => {
    const lumiverse = new Lumiverse();
    const one = harbour(lumiverse);
    const other = harbour(lumiverse, "The quay");
    const it = runtimeOver(lumiverse);
    it.hello();
    await copying(it);
    await contents(it, one.chatId);

    // Lumiverse no longer takes the runtime's session.
    it.lumiverse.token = "a session Lumiverse ended";
    expect(await contents(it, other.chatId)).toEqual(["Who keeps the harbour light now?", "Okoro keeps it."]);
    expect(it.crossed).toContain("host.read chats.messages");
    const state = it.data.state(MEMORY);
    expect(state.signIn).toBe(loginAgain(BASE));
    expect(state.fallbacks.latest.at(-1)?.why).toContain("The runtime's Lumiverse session is no longer valid");
    // Only the extension says a chat isn't there.
    await expect(it.data.reads.chat.messages("chat-nowhere", 0, 10)).rejects.toThrow("There is no such chat in this account.");

    // Signed in again: Lumiverse is read again, and the page no longer asks for it.
    it.lumiverse.token = TOKEN;
    const third = harbour(lumiverse, "The fish market");
    const from = it.crossed.length;
    expect(await contents(it, third.chatId)).toEqual(["Who keeps the harbour light now?", "Okoro keeps it."]);
    expect(it.crossed.slice(from)).toEqual([]);
    expect(it.data.state(MEMORY).signIn).toBeNull();
  });

  test("whose it is not known yet: every read goes over the link, the page says why, and the copy reads once Lumiverse says", async () => {
    const lumiverse = new Lumiverse();
    const one = harbour(lumiverse);
    const it = runtimeOver(lumiverse);
    it.lumiverse.sessionFails = true;
    it.hello();
    // Asking: until Lumiverse answers, the extension answers.
    expect(it.data.state(MEMORY).why).toBe("The runtime is asking Lumiverse whose session it holds: until it knows, chats and world books are read through LumiAH.");
    expect(await contents(it, one.chatId)).toEqual(["Who keeps the harbour light now?", "Okoro keeps it."]);
    expect(it.crossed).toEqual(["chat.messages"]);
    await until(() => it.data.state(MEMORY).why.startsWith("The runtime couldn't ask Lumiverse"), "the session's user not found out");
    expect(it.data.state(MEMORY)).toMatchObject({ road: "link", why: expect.stringContaining("so chats and world books are read through LumiAH until it can.") });
    expect(await it.data.reads.chat.path(one.chatId)).toHaveLength(2);
    expect(it.crossed).toEqual(["chat.messages", "chat.path"]);

    // Lumiverse says again: a read asks once more (not more often than the longest reconnect wait), and the copy answers from then on.
    it.lumiverse.sessionFails = false;
    it.clock.now += 25;
    await contents(it, one.chatId);
    await copying(it);
    const from = it.crossed.length;
    expect(await contents(it, one.chatId)).toEqual(["Who keeps the harbour light now?", "Okoro keeps it."]);
    expect(it.crossed.slice(from)).toEqual([]);
  });
});

describe("what the copy is told, and what it isn't", () => {
  test("a push missing from the numbering, or a ping's count past the last one heard, has everything held read again", async () => {
    const lumiverse = new Lumiverse();
    const one = harbour(lumiverse);
    const it = runtimeOver(lumiverse);
    it.hello();
    await copying(it);
    await contents(it, one.chatId);

    // An edit of the first message, its push lost on the way; the next push comes one past it.
    lumiverse.edit(one.first, "Who keeps the light?");
    lumiverse.say(one.chatId, "Still there?", { user: true });
    it.forward([0]);
    expect(await contents(it, one.chatId)).toEqual(["Who keeps the light?", "Okoro keeps it.", "Still there?"]);
    expect(it.data.state(MEMORY).events).toMatchObject({ gaps: 1, lastGap: { why: "push 1 of LumiAH's never reached the runtime" } });

    // A push older than the last one heard is news already covered: no gap.
    it.data.news({ link: LINK, type: "own", seq: 1, chat: one.chatId });
    expect(it.data.state(MEMORY).events.gaps).toBe(1);

    // The last push lost, with none after it: the ping's count shows it.
    lumiverse.edit(one.first, "Who keeps the lamp?");
    it.forward([0]);
    it.data.told(it.told());
    expect(await contents(it, one.chatId)).toEqual(["Who keeps the lamp?", "Okoro keeps it.", "Still there?"]);
    expect(it.data.state(MEMORY).events).toMatchObject({ gaps: 2, lastGap: { why: "push 3 of LumiAH's never reached the runtime" } });
    expect(it.crossed).toEqual([]);
  });

  test("the link going down: nothing tells the copy of a change, so it reads Lumiverse again before using what it holds; the link up again has it read again too", async () => {
    const lumiverse = new Lumiverse();
    const one = harbour(lumiverse);
    const it = runtimeOver(lumiverse);
    it.hello();
    await copying(it);
    await contents(it, one.chatId);

    it.link.up = false;
    it.data.tick();
    expect(it.data.state(MEMORY).chats.find((c) => c.id === one.chatId)?.stale).toBe("the link to the extension went down, so events may have been missed");
    // Lumiverse's word of an edit can't reach the runtime now.
    lumiverse.edit(one.first, "Who keeps the light?");
    it.forward([0]);
    expect(await contents(it, one.chatId)).toEqual(["Who keeps the light?", "Okoro keeps it."]);
    expect(it.crossed).toEqual([]);

    // Up again: the hello has what is held read again, an edit made in between among it.
    lumiverse.edit(one.first, "Who keeps the lamp?");
    it.forward([0]);
    it.link.up = true;
    it.hello();
    expect(it.data.state(MEMORY).chats.find((c) => c.id === one.chatId)?.stale).toBe("the link to the extension reopened, so events may have been missed");
    expect(await contents(it, one.chatId)).toEqual(["Who keeps the lamp?", "Okoro keeps it."]);
    expect(it.crossed).toEqual([]);
  });
});

describe("the database reader", () => {
  test("turning itself off in the middle of a read: that read goes to the extension, and the next ones read Lumiverse over HTTP", async () => {
    const lumiverse = new Lumiverse();
    const one = harbour(lumiverse);
    const other = harbour(lumiverse, "The quay");
    const third = harbour(lumiverse, "The fish market");
    // A reader of Lumiverse's file, made up over the same rows: on until a look finds the file changed under it.
    const rows = createHttpSource({ fetch: lumiverse.session(USER), identifier: LUMIAH, sleep: async () => undefined });
    // What a Lumiverse update did to the file, which the reader finds at its next look and turns itself off for.
    const file = { changed: null as string | null };
    const off = { why: null as string | null };
    const looked = <T>(work: () => Promise<T>): Promise<T> => {
      off.why ??= file.changed;
      return off.why !== null ? Promise.reject(new DatabaseOff(off.why)) : work();
    };
    const path = "/srv/lumiverse/data/lumiverse.db";
    const db: DbSource = {
      kind: "database",
      readChat: (chatId) => looked(() => rows.readChat(chatId)),
      readBook: (bookId, held) => looked(() => rows.readBook(bookId, held)),
      chatSignature: (chatId) => looked(() => rows.chatSignature(chatId)),
      bookSignature: (bookId, held) => looked(async () => (await rows.readBook(bookId, held))?.signature ?? null),
      changedSince: (mark) => looked(async () => ({ changed: mark !== String(lumiverse.version), mark: String(lumiverse.version) })),
      describe: () => ({ path, on: off.why === null, why: off.why, open: off.why === null, schema: { checkedAt: null, matches: true, difference: null }, lastRead: null, lastCheck: null }),
      close: () => undefined,
    };
    const it = runtimeOver(lumiverse, { database: () => db });
    it.hello({ database: path });
    await copying(it);
    expect(await contents(it, one.chatId)).toEqual(["Who keeps the harbour light now?", "Okoro keeps it."]);
    expect(it.data.state(MEMORY).chats.find((c) => c.id === one.chatId)?.from).toBe("database");

    // A Lumiverse update renamed a column it reads: its next look, in the middle of a read, finds that.
    file.changed = 'Lumiverse\'s table messages has no column "revision" any more';
    expect(await contents(it, other.chatId)).toEqual(["Who keeps the harbour light now?", "Okoro keeps it."]);
    expect(it.crossed.some((type) => type.startsWith("host.read chats."))).toBe(true);
    const state = it.data.state(MEMORY);
    expect(state.fallbacks.latest.some((f) => f.why.includes("the database reader turned itself off"))).toBe(true);
    expect(state.reader).toMatchObject({ on: false, why: file.changed });
    expect(state.sourceWhy).toContain("the database reader is off");

    const from = it.crossed.length;
    const asked = it.requests.length;
    expect(await contents(it, third.chatId)).toEqual(["Who keeps the harbour light now?", "Okoro keeps it."]);
    expect(it.crossed.slice(from)).toEqual([]);
    expect(it.requests.slice(asked).some((r) => r.url.includes(`/api/v1/chats/${third.chatId}`))).toBe(true);
    expect(it.data.state(MEMORY).chats.find((c) => c.id === third.chatId)?.from).toBe("http");
  });
});

describe("an extension that builds LumiAH in", () => {
  test("whose records kept elsewhere can't be read now: the chat is read through it, records and all, the page says why, and the copy reads them once they can be", async () => {
    const lumiverse = new Lumiverse();
    const one = harbour(lumiverse);
    const reply = lumiverse.rowsOf(one.chatId).at(-1)?.id ?? "";
    // The extension's host gives the reply LumiAH's record for its swipe, kept in its ledger.
    const record = { v: 1, generationId: "gen-okoro", kind: "new" };
    lumiverse.setOwn(reply, LUMIAH, { v: 1, swipes: { "0": record } });
    let readable = false;
    const it = runtimeOver(lumiverse, {
      own: async () => {
        if (!readable) throw new LinkRefused("unavailable", "The lamp room's ledger can't be read now.");
        return { [reply]: { v: 1, swipes: { "0": record } } };
      },
    });
    it.hello({ ownElsewhere: true });
    await copying(it);

    expect((await it.data.reads.chat.path(one.chatId)).map((m) => m.anchor)).toEqual([null, record]);
    expect(it.crossed).toContain("own.read");
    expect(it.crossed).toContain("host.read chats.messages");
    expect(it.data.state(MEMORY).fallbacks.latest.at(-1)?.why).toContain("the extension's own entries on its messages couldn't be read: The lamp room's ledger can't be read now.");

    readable = true;
    const from = it.crossed.length;
    expect((await it.data.reads.chat.path(one.chatId)).map((m) => m.anchor)).toEqual([null, record]);
    expect(it.crossed.slice(from)).toEqual(["own.read"]);
  });
});

describe("the lists of world books that attach books to a chat", () => {
  /** A chat of Mara's with Joss for its character, and a book of Joss's, of Mara's active persona, of the persona of the chat's latest generation, and one for every chat. */
  function booked(): { lumiverse: Lumiverse; chatId: string; it: Runtime } {
    const lumiverse = new Lumiverse();
    lumiverse.now = Date.UTC(2024, 4, 2, 8, 0, 0) / 1000;
    const chat = lumiverse.newChat(USER, { name: "Harbour light", characterId: "char-joss" });
    lumiverse.say(chat.id, "Who keeps the harbour light now?", { user: true });
    for (const [id, name] of [["book-joss", "Joss"], ["book-mara", "Mara"], ["book-ilse", "Ilse"], ["book-tides", "The tides"]] as const) {
      lumiverse.newBook(USER, { id, name });
      lumiverse.addEntry(id, { comment: name, content: `${name}, of the harbour.` }, true);
    }
    const it = runtimeOver(lumiverse);
    it.extension.global = ["book-tides"];
    it.extension.active = "book-mara";
    it.extension.personas.set("persona-ilse", "book-ilse");
    it.extension.characters.set("char-joss", ["book-joss"]);
    it.extension.turn = { personaId: "persona-ilse", activated: [] };
    return { lumiverse, chatId: chat.id, it };
  }

  test("come with what the extension heard of the chat's turn, none asked on its own; a backend from before them has each asked as before; the books are the extension's either way", async () => {
    const { chatId, it } = booked();
    it.hello();
    await copying(it);
    const linked = { books: await it.viaLink.lore.books(chatId), read: await it.viaLink.recall.lore.read(chatId, {}) };
    expect(linked.books.map((b) => b.id)).toEqual(["book-joss", "book-ilse", "book-tides"]);
    expect(linked.read.map((b) => [b.id, b.source])).toEqual([["book-joss", "character"], ["book-ilse", null], ["book-tides", "global"]]);

    const from = it.crossed.length;
    expect(await it.data.reads.lore.books(chatId)).toEqual(linked.books);
    expect(await it.data.reads.recall.lore.read(chatId, {})).toEqual(linked.read);
    expect(it.crossed.slice(from)).toEqual(["turn.lore", "turn.lore"]);

    it.extension.lists = false;
    const before = it.crossed.length;
    expect(await it.data.reads.lore.books(chatId)).toEqual(linked.books);
    expect(await it.data.reads.recall.lore.read(chatId, {})).toEqual(linked.read);
    expect(new Set(it.crossed.slice(before))).toEqual(new Set(["turn.lore", "host.read lore.ofCharacter", "host.read lore.ofPersona", "host.read lore.global"]));
  });
});

describe("the copy's wait for Lumiverse", () => {
  test("set short, gives a read up in words that name the wait and where it is changed, in the Settings of the extension LumiAH is built into, and the extension answers the read", async () => {
    const lumiverse = new Lumiverse();
    const one = harbour(lumiverse);
    const it = runtimeOver(lumiverse, { tuning: { copyReadMs: 30 }, owner: { name: "Lamp Room", settingsAt: "Lamp Room's Harness tab → System → Settings" } });
    it.hello();
    await copying(it);
    lumiverse.hang(/^\/api\/v1\/chats\//, 1);
    expect(await contents(it, one.chatId)).toEqual(["Who keeps the harbour light now?", "Okoro keeps it."]);
    expect(it.crossed.some((type) => type.startsWith("host.read chats."))).toBe(true);
    const why = it.data.state(MEMORY).fallbacks.latest.at(-1)?.why;
    expect(why).toContain(`Lumiverse didn't answer within 30 ms when it was asked for chat ${one.chatId}`);
    expect(why).toContain("Chat data wait (Lamp Room's Harness tab → System → Settings → Timeouts → The copy and the store) says how long each of the runtime's reads of chat data waits.");
  });
});
