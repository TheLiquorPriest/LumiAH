// The recall ports and a chat's book over the link (DESIGN §6, §23, §24): what a runtime's core reads
// through its host reaches Lumiverse by way of the extension and comes back in the ports' own
// shapes; and a backend from before these requests leaves each port reading as it did before
// them, or as not set up. Every book, chat, name and text here is invented.

import { afterEach, describe, expect, test } from "bun:test";
import type { AgentUsage, BookPort, HarnessHost } from "../../src/core/ports";
import type { ActivatedEntry, LoreBookRecord, RecallPorts } from "../../src/core/recall/ports";
import type { LinkRequests } from "../../src/link/contract";
import { LinkError } from "../../src/runtime/connection";
import { linkHost } from "../../src/runtime/host";
import type { AskType, RuntimeLink } from "../../src/runtime/link";
import { Streams } from "../../src/runtime/streams";
import { FAST, type Rig, rig, USER } from "../support/rig";

const USAGE: AgentUsage = { calls: 1, toolTurns: 0, in: 10, cachedIn: 0, out: 5, reasoningOut: 0, estimated: false, ms: 1 };
/** A made-up moment well before any clock a test runs by, on a whole second: a world book last changed then. */
const STAMP = Date.UTC(2024, 4, 2, 8, 0, 0);
/** When the chat's messages were sent, by the fake Lumiverse's clock. */
const SENT = Date.UTC(2024, 4, 3, 21, 15, 0);
const QUAY = "The quay is stone, laid by Ilse's grandfather.";

/** Every port and the book, as a link host always carries them. */
type Reads = Required<RecallPorts> & { book: BookPort };

/** A host's ports and its book: a missing one fails the test. */
function reads(host: HarnessHost): Reads {
  const { lore, chat, embeddings, memory, databanks, web } = host.recall ?? {};
  if (!lore || !chat || !embeddings || !memory || !databanks || !web || !host.book) throw new Error("a port is missing");
  return { lore, chat, embeddings, memory, databanks, web, book: host.book };
}

let open: Rig | null = null;
afterEach(() => {
  open?.close();
  open = null;
});

describe("a runtime's core reads lore and history through the link", () => {
  test("each port for the runtime's own user, in the port's own shapes", async () => {
    const held: { host: HarnessHost | null; activated: ActivatedEntry[] | null } = { host: null, activated: null };
    const it = await rig({
      harness: (host, _settings, _extension, place) => {
        if (place === "runtime") held.host = host;
        return {
          // A reply's turn asks how Lumiverse activated the lore in its prompt, as the core does once a turn.
          answer: async (turn, sink) => {
            held.activated = await reads(host).lore.activated(turn.chatId, turn.generationId);
            sink.content("Okoro keeps it now.");
            sink.done("stop", USAGE);
            return { status: "done", record: null, reply: "Okoro keeps it now.", usage: USAGE };
          },
        };
      },
    });
    open = it;
    it.host.now = () => SENT;
    const chatId = await it.setUp();
    if (held.host === null) throw new Error("the runtime made no harness");
    const ports = reads(held.host);
    for (const permission of ["embeddings", "memories", "databanks", "web_search"]) it.host.permissions.add(permission);
    const chat = it.host.chatList.get(chatId);
    if (chat === undefined) throw new Error("the chat is gone");
    chat.characterId = "char-okoro";

    // Lore: a book of the chat's own, with an entry's state beside its text.
    it.host.books.set("book-coast", {
      book: { id: "book-coast", name: "The Coast", description: "Places along the shore." },
      userId: USER,
      updatedAt: STAMP,
      entries: [{ id: "e-quay", bookId: "book-coast", title: "The Quay", keys: ["quay"], secondaryKeys: ["harbour"], content: QUAY, enabled: true, constant: true, vectorized: true, regex: false, role: "system", order: 5, updatedAt: STAMP }],
    });
    chat.metadata.chat_world_book_ids = ["book-coast"];
    const coast: LoreBookRecord = { id: "book-coast", name: "The Coast", description: "Places along the shore.", source: "chat", updatedAt: STAMP };
    expect(await ports.lore.read(chatId)).toEqual([{ ...coast, entries: [{ id: "e-quay", bookId: "book-coast", title: "The Quay", keys: ["quay"], secondaryKeys: ["harbour"], content: QUAY, enabled: true, constant: true, vectorized: true, regex: false, role: "system", order: 5, updatedAt: STAMP }] }]);
    // The stamp the runtime holds crosses with the ask: a book that still has it comes without its entries.
    expect(await ports.lore.read(chatId, { "book-coast": STAMP })).toEqual([{ ...coast, entries: null }]);

    // How Lumiverse activated the lore of a generation's prompt, asked while the reply is written.
    const replied = await it.generate(chatId, { lore: [{ entryId: "e-quay", bookId: "book-coast", title: "The Quay", text: QUAY, how: "vector", score: 0.82 }] });
    expect(replied.content).toBe("Okoro keeps it now.");
    expect(held.activated).toEqual([{ entryId: "e-quay", bookId: "book-coast", title: "The Quay", how: "vector", score: 0.82, content: QUAY }]);

    // The chat's messages, each with when it was sent.
    expect((await ports.chat.messages(chatId, 0, 1)).map((m) => [m.index, m.role, m.content, m.at])).toEqual([[0, "user", "Who keeps the harbour light now?", SENT]]);

    // Embeddings on the user's main connection.
    it.host.embedders.push({ userId: USER, main: true, enabled: true, connection: { id: "emb-main", name: "Harbour embeddings", model: "embed-large", dimensions: null } });
    expect(await ports.embeddings.connection()).toEqual({ id: "emb-main", name: "Harbour embeddings", model: "embed-large", dimensions: null });
    expect(await ports.embeddings.embed(["the quay at dawn", "Okoro's lamp"], "stored")).toEqual({ vectors: [it.host.embedText("the quay at dawn", "stored"), it.host.embedText("Okoro's lamp", "stored")], model: "embed-large", dimensions: 3 });
    // A call outside Lumiverse's bounds is refused by the extension, in its words.
    await expect(ports.embeddings.embed(["the quay", " "], "query")).rejects.toThrow("text 2 of this call isn't so.");

    // Lumiverse's Memory Cortex.
    it.host.cortexOn.add(USER);
    it.host.cortex.set(chatId, {
      hits: [{ source: "arc", text: "The flood: Okoro takes over the light.", score: 0.83, span: [0, 7], entities: ["Okoro"] }],
      entities: [{ id: "ent-okoro", name: "Okoro", type: "character", aliases: ["the keeper"], description: "Keeps the harbour light.", status: "active", facts: ["Keeps the second key on a cord."], mentions: 12, lastSeenAt: null, relations: [{ target: "Ilse", type: "ally", label: null, strength: 0.4, sentiment: 0.5 }] }],
      arcs: [{ id: "arc-1", tier: 1, title: null, summary: "The river takes the mill wheel.", span: null, at: STAMP }],
    });
    expect(await ports.memory.enabled(chatId)).toBe(true);
    expect(await ports.memory.search(chatId, "who keeps the light", { limit: 3, entities: ["Okoro"] })).toEqual([{ source: "arc", text: "The flood: Okoro takes over the light.", score: 0.83, span: [0, 7], entities: ["Okoro"] }]);
    expect(it.host.cortexQueries).toEqual([{ userId: USER, chatId, query: "who keeps the light", limit: 3, entities: ["Okoro"] }]);
    expect(await ports.memory.entity(chatId, "the keeper")).toEqual({ id: "ent-okoro", name: "Okoro", type: "character", aliases: ["the keeper"], description: "Keeps the harbour light.", status: "active", facts: ["Keeps the second key on a cord."], mentions: 12, lastSeenAt: null, relations: [{ target: "Ilse", type: "ally", label: null, strength: 0.4, sentiment: 0.5 }] });
    expect(await ports.memory.entity(chatId, "Brann")).toBeNull();
    expect(await ports.memory.entities(chatId, 5)).toEqual([{ name: "Okoro", type: "character", mentions: 12 }]);
    expect(await ports.memory.arcs(chatId)).toEqual([{ id: "arc-1", tier: 1, title: null, summary: "The river takes the mill wheel.", span: null, at: STAMP }]);

    // The databanks that apply to the chat, a databank's documents, a document's text.
    it.host.databankList.push({ id: "bank-almanac", name: "Almanac", description: "Tides and moons.", scope: "global", scopeId: null, enabled: true, userId: USER });
    it.host.documentList.push({ id: "doc-tides", databankId: "bank-almanac", name: "Tide tables", version: "h1:10", bytes: 2048, status: "ready", userId: USER, text: "High water at Okoro's Quay: 06:10 and 18:40." });
    expect(await ports.databanks.list(chatId)).toEqual([{ id: "bank-almanac", name: "Almanac", description: "Tides and moons.", scope: "global", documents: 1 }]);
    expect(await ports.databanks.documents("bank-almanac")).toEqual([{ id: "doc-tides", databankId: "bank-almanac", name: "Tide tables", version: "h1:10", bytes: 2048, status: "ready" }]);
    expect(await ports.databanks.content("doc-tides")).toBe("High water at Okoro's Quay: 06:10 and 18:40.");
    expect(await ports.databanks.content("doc-moons")).toBeNull();

    // The user's own web search provider.
    it.host.webSearches.set(USER, { enabled: true, maxResults: 5, maxPages: 1, results: [{ title: "Tide tables", url: "https://tides.example/harbour", snippet: "High water at 06:10.", page: "High water at Okoro's Quay: 06:10 and 18:40." }] });
    expect(await ports.web.enabled()).toBe(true);
    expect(await ports.web.search("tides at the harbour", { count: 3, pages: true })).toEqual([{ title: "Tide tables", url: "https://tides.example/harbour", snippet: "High water at 06:10.", content: "High water at Okoro's Quay: 06:10 and 18:40." }]);
    // A search whose caller gave up is let go at once, and never asked.
    const gone = new AbortController();
    gone.abort(new Error("the run was stopped"));
    await expect(ports.web.search("tides", { count: 3, pages: false }, gone.signal)).rejects.toThrow("the run was stopped");
    expect(it.host.webQueries).toEqual([{ userId: USER, query: "tides at the harbour", count: 3, pages: true }]);

    // The chat's book, which LumiBooks keeps as a world book of the chat.
    it.host.books.set("book-story", {
      book: { id: "book-story", name: "LumiBooks: Harbour light", description: "" },
      userId: USER,
      metadata: { lumibooks_chat_id: chatId },
      entries: [{ id: "ch-1", bookId: "book-story", title: "#1 - The Light (msgs 1-1)", keys: [], secondaryKeys: [], content: "Mara asks who keeps the harbour light.", enabled: false, constant: false, extensions: { lumibooks: { chatId, tier: 1, msgIds: [chat.messages[0]?.id ?? ""], firstMsgIdx: 0, lastMsgIdx: 0, model: "summary-model" } } }],
    });
    expect(await ports.book.read(chatId)).toBeNull();
    chat.metadata.lumibooks_book_id = "book-story";
    expect(await ports.book.read(chatId)).toEqual({ entries: [{ id: "ch-1", comment: "#1 - The Light (msgs 1-1)", content: "Mara asks who keeps the harbour light.", extensions: { lumibooks: { chatId, tier: 1, msgIds: [chat.messages[0]?.id ?? ""], firstMsgIdx: 0, lastMsgIdx: 0 } } }], hashes: [] });

    // A runtime reads for its own user alone: another user's chat is refused as one that isn't there, whichever port asks.
    const theirs = it.host.addChat("user-joss", "The mill");
    it.host.say(theirs.id, "user", "Is the wheel turning?");
    for (const read of [() => ports.chat.messages(theirs.id, 0, 1), () => ports.lore.read(theirs.id), () => ports.memory.enabled(theirs.id), () => ports.databanks.list(theirs.id), () => ports.book.read(theirs.id)]) await expect(read()).rejects.toThrow("There is no such chat in this account.");

    // A permission taken back while the runtime runs: the port reads as not set up from the next ask on.
    for (const permission of ["embeddings", "memories", "databanks", "web_search"]) it.host.permissions.delete(permission);
    expect([await ports.embeddings.connection(), await ports.memory.enabled(chatId), await ports.databanks.list(chatId), await ports.web.enabled()]).toEqual([null, false, [], false]);

    // What a runtime's reading of an older backend rests on: a request the backend doesn't know is refused in these words, as every build so far has refused one. The name is no request of the contract, so the type is told otherwise.
    const unknown = "recall.tides" as "recall.embedder";
    const refused: unknown = await it.runtime.link.request(unknown, {}, 1_000).catch((error: unknown) => error);
    expect(refused).toBeInstanceOf(LinkError);
    expect(refused).toMatchObject({ code: "bad_request", message: "There is no link request recall.tides: update LumiAH in Lumiverse, or the runtime, so both are the same build." });
  });
});

describe("a runtime linked to a backend from before the recall ports", () => {
  /** What the older requests give of a chat's lore and messages. */
  const OLDER: Partial<{ [K in AskType]: LinkRequests[K]["result"] }> = {
    "lore.books": { books: [{ id: "book-coast", name: "The Coast", description: "Places along the shore." }] },
    "lore.entries": { entries: [{ id: "e-quay", bookId: "book-coast", title: "The Quay", keys: ["quay"], secondaryKeys: [], content: QUAY, enabled: true, constant: false }] },
    "lore.activated": { entries: [{ entryId: "e-quay", bookId: "book-coast", title: "The Quay", content: QUAY }] },
    "chat.messages": { messages: [{ id: "m1", index: 0, role: "user", name: "Mara", swipeId: 0, content: "Who keeps the harbour light now?" }] },
  };

  /** A link host over a backend that knows the older requests and answers every newer one as each build so far answers a request it doesn't know. */
  function older(): { ports: Reads; asked: string[] } {
    const asked: string[] = [];
    const link: RuntimeLink = {
      up: true,
      out: null,
      refused: null,
      request: async <T extends AskType>(type: T): Promise<LinkRequests[T]["result"]> => {
        asked.push(type);
        const known = OLDER[type];
        if (known === undefined) throw new LinkError("bad_request", `There is no link request ${type}: update LumiAH in Lumiverse, or the runtime, so both are the same build.`);
        return known;
      },
      notify: () => undefined,
    };
    const host = linkHost({
      link,
      streams: new Streams(link, { now: () => 0, log: () => undefined, tuning: () => FAST }),
      id: () => "0".repeat(32),
      now: () => 0,
      tuning: () => FAST,
      log: () => undefined,
      trace: () => undefined,
      delta: () => undefined,
      turn: () => null,
      chat: () => null,
      jobQueued: () => undefined,
      jobChanged: () => undefined,
    });
    return { ports: reads(host), asked };
  }

  test("reads lore and the chat as the older requests give them, and takes everything else as not set up", async () => {
    const { ports, asked } = older();

    // Lore and the chat's messages come through the requests that backend knows, with nothing beside what those say.
    expect(await ports.lore.read("chat-harbour", { "book-coast": 5 })).toEqual([
      { id: "book-coast", name: "The Coast", description: "Places along the shore.", source: null, updatedAt: 0, entries: [{ id: "e-quay", bookId: "book-coast", title: "The Quay", keys: ["quay"], secondaryKeys: [], content: QUAY, enabled: true, constant: false, vectorized: false, regex: false, role: null, order: 0, updatedAt: 0 }] },
    ]);
    expect(await ports.lore.activated("chat-harbour", "gen-1")).toEqual([{ entryId: "e-quay", bookId: "book-coast", title: "The Quay", how: null, content: QUAY }]);
    expect(await ports.chat.messages("chat-harbour", 0, 1)).toEqual([{ id: "m1", index: 0, role: "user", name: "Mara", swipeId: 0, content: "Who keeps the harbour light now?", at: null }]);
    expect(asked).toEqual(["recall.lore.read", "lore.books", "lore.entries", "recall.lore.activated", "lore.activated", "recall.chat.messages", "chat.messages"]);

    // What a run asks at its start reads as not set up, so the tools that rest on it aren't offered, and no turn fails.
    expect(await ports.embeddings.connection()).toBeNull();
    expect(await ports.memory.enabled("chat-harbour")).toBe(false);
    expect(await ports.databanks.list("chat-harbour")).toEqual([]);
    expect(await ports.web.enabled()).toBe(false);
    expect(await ports.book.read("chat-harbour")).toBeNull();
    // And whatever else is asked of them holds nothing.
    expect(await ports.memory.search("chat-harbour", "who keeps the light", { limit: 3 })).toEqual([]);
    expect(await ports.memory.entity("chat-harbour", "Okoro")).toBeNull();
    expect(await ports.memory.entities("chat-harbour", 5)).toEqual([]);
    expect(await ports.memory.arcs("chat-harbour")).toEqual([]);
    expect(await ports.databanks.documents("bank-almanac")).toEqual([]);
    expect(await ports.databanks.content("doc-tides")).toBeNull();
    expect(await ports.web.search("tides", { count: 3, pages: false })).toEqual([]);
    // There is no vector to stand in for one: an embed says what that backend said.
    await expect(ports.embeddings.embed(["the quay"], "query")).rejects.toThrow("There is no link request recall.embed");
  });

  test("still fails a read the backend refused for another reason", async () => {
    const asked: string[] = [];
    const link: RuntimeLink = {
      up: true,
      out: null,
      refused: null,
      request: async (type) => {
        asked.push(type);
        throw new LinkError("not_found", "There is no such chat in this account.");
      },
      notify: () => undefined,
    };
    const host = linkHost({ link, streams: new Streams(link, { now: () => 0, log: () => undefined, tuning: () => FAST }), id: () => "0".repeat(32), now: () => 0, tuning: () => FAST, log: () => undefined, trace: () => undefined, delta: () => undefined, turn: () => null, chat: () => null, jobQueued: () => undefined, jobChanged: () => undefined });
    const ports = reads(host);
    await expect(ports.memory.enabled("chat-gone")).rejects.toThrow("There is no such chat in this account.");
    await expect(ports.lore.read("chat-gone")).rejects.toThrow("There is no such chat in this account.");
    await expect(ports.book.read("chat-gone")).rejects.toThrow("There is no such chat in this account.");
    // Nothing older was asked in its place.
    expect(asked).toEqual(["recall.memory.enabled", "recall.lore.read", "book.read"]);
  });
});
