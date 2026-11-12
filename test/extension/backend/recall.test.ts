// What the lore and history tools read of Lumiverse (DESIGN §24) and a chat's book (§23), as the
// extension gives them to the core: each port read against the fake Lumiverse, with its permission
// granted, without it, and by another user. Every book, chat, name and text here is invented.

import { describe, expect, test } from "bun:test";
import { textHash } from "../../../src/core/hash";
import type { ChatRole } from "../../../src/core/ports";
import { EMBED_BATCH_MAX, EMBED_TEXT_MAX, type RecallPorts } from "../../../src/core/recall/ports";
import { Chats } from "../../../src/extension/backend/chat";
import { LinkRefused } from "../../../src/extension/backend/errors";
import { Lore } from "../../../src/extension/backend/reads";
import { Recall } from "../../../src/extension/backend/recall";
import type { ActivatedInfo } from "../../../src/extension/backend/spindle";
import { type FakeBook, type FakeEntry, FakeHost } from "../../support/fake-host";

const MARA = "user-mara";
const JOSS = "user-joss";
/** Where the tests' clock stands, on a whole second, and how long a day is. */
const NOW = Date.UTC(2031, 2, 14, 9, 30, 0);
const DAY = 86_400_000;

/** Every port, as the backend always gives them: a missing one fails the test. */
function all(ports: RecallPorts): Required<RecallPorts> {
  const { lore, chat, embeddings, memory, databanks, web } = ports;
  if (!lore || !chat || !embeddings || !memory || !databanks || !web) throw new Error("a port is missing");
  return { lore, chat, embeddings, memory, databanks, web };
}

/** The link's code a read was refused with, as a runtime would be answered; "answered" when it wasn't refused. */
async function refusal(read: Promise<unknown>): Promise<string> {
  try {
    await read;
  } catch (error) {
    if (error instanceof LinkRefused) return error.code;
    throw error;
  }
  return "answered";
}

/** A world book entry, with whatever a test sets beside its text. */
const entry = (bookId: string, id: string, title: string, content: string, more: Partial<FakeEntry> = {}): FakeEntry => ({ id, bookId, title, keys: [title.toLowerCase()], secondaryKeys: [], content, enabled: true, constant: false, ...more });

/** LumiBooks' hash of a message: the SHA-256 of its role and its text as JSON. */
const lumibooksHash = (role: ChatRole, text: string): Promise<string> => textHash(JSON.stringify([role, text]));

/** Two users of one Lumiverse, each with a chat of their own, and the ports the backend gives each. Mara's chat is with a character. */
function rig() {
  const host = new FakeHost();
  let now = NOW;
  host.now = () => now;
  const activated = new Map<string, ActivatedInfo[]>();
  const chats = new Chats(host, async () => ({ chats: 0, ms: 0 }), () => now);
  const lore = new Lore(host, { persona: () => undefined, activatedBooks: () => [] });
  const recall = new Recall(host, { chats, lore, activated: (userId, chatId, generationId) => activated.get(`${userId}/${chatId}/${generationId}`) ?? [], now: () => now });
  const chat = host.addChat(MARA, "Harbour light", "chat-harbour");
  chat.characterId = "char-okoro";
  const theirs = host.addChat(JOSS, "The mill", "chat-mill");
  return {
    host,
    recall,
    chat,
    theirs,
    activated,
    mara: all(recall.ports(MARA)),
    joss: all(recall.ports(JOSS)),
    tick(ms: number): void {
      now += ms;
    },
  };
}

const QUAY = "The quay is stone, laid by Ilse's grandfather.";
const MILL = "The mill stands where the river meets the sea. Its wheel has not turned since the flood.";

describe("what the lore and history tools read of Lumiverse", () => {
  test("lore.read gives every book that applies to the chat with every entry's text and state, and spares the entries of a book that didn't change", async () => {
    const r = rig();
    const stamp = NOW - DAY;
    const coast = {
      book: { id: "book-coast", name: "The Coast", description: "Places along the shore." },
      userId: MARA,
      updatedAt: stamp,
      entries: [entry("book-coast", "e-quay", "The Quay", QUAY, { keys: ["quay", "^the\\s+quay$"], secondaryKeys: ["harbour"], constant: true, vectorized: true, regex: true, role: "system", order: 5, updatedAt: stamp }), entry("book-coast", "e-mill", "The Mill", MILL, { enabled: false })],
    };
    r.host.books.set("book-coast", coast);
    r.host.books.set("book-people", { book: { id: "book-people", name: "People", description: "" }, userId: MARA, updatedAt: stamp - DAY, entries: [entry("book-people", "e-okoro", "Okoro", "Okoro keeps the harbour light.")] });
    r.host.books.set("book-sails", { book: { id: "book-sails", name: "Sails", description: "" }, userId: MARA, entries: [] });
    r.host.books.set("book-tides", { book: { id: "book-tides", name: "Tides", description: "" }, userId: MARA, updatedAt: stamp, entries: [] });
    r.host.books.set("book-nets", { book: { id: "book-nets", name: "Nets", description: "" }, userId: JOSS, updatedAt: stamp, entries: [entry("book-nets", "e-nets", "Nets", "Brann mends the nets by the quay.")] });
    // The chat's own, its character's, the persona's, and those switched on for every chat. A book attached twice is said by the narrowest place.
    r.chat.metadata.chat_world_book_ids = ["book-coast", "book-nets"];
    r.host.characterBooks.set("char-okoro", ["book-people"]);
    r.host.personaBook = "book-sails";
    r.host.globalBooks = ["book-tides", "book-coast"];

    expect(await r.mara.lore.read(r.chat.id)).toEqual([
      {
        id: "book-coast",
        name: "The Coast",
        description: "Places along the shore.",
        source: "chat",
        updatedAt: stamp,
        entries: [
          { id: "e-quay", bookId: "book-coast", title: "The Quay", keys: ["quay", "^the\\s+quay$"], secondaryKeys: ["harbour"], content: QUAY, enabled: true, constant: true, vectorized: true, regex: true, role: "system", order: 5, updatedAt: stamp },
          { id: "e-mill", bookId: "book-coast", title: "The Mill", keys: ["the mill"], secondaryKeys: [], content: MILL, enabled: false, constant: false, vectorized: false, regex: false, role: null, order: 100, updatedAt: 0 },
        ],
      },
      { id: "book-people", name: "People", description: "", source: "character", updatedAt: stamp - DAY, entries: [{ id: "e-okoro", bookId: "book-people", title: "Okoro", keys: ["okoro"], secondaryKeys: [], content: "Okoro keeps the harbour light.", enabled: true, constant: false, vectorized: false, regex: false, role: null, order: 100, updatedAt: 0 }] },
      { id: "book-sails", name: "Sails", description: "", source: "persona", updatedAt: 0, entries: [] },
      { id: "book-tides", name: "Tides", description: "", source: "global", updatedAt: stamp, entries: [] },
    ]);

    // The caller holds a book's stamp: while the book still has it, its entries aren't sent again. A stamp it doesn't have, and a book that has none, come whole.
    const held = { "book-coast": stamp, "book-people": 1, "book-sails": 0 };
    const spared = async (): Promise<[string, boolean][]> => (await r.mara.lore.read(r.chat.id, held)).map((book) => [book.id, book.entries === null]);
    expect(await spared()).toEqual([["book-coast", true], ["book-people", false], ["book-sails", false], ["book-tides", false]]);

    // An entry changes: Lumiverse stamps the book again, and it comes whole.
    coast.entries[1] = entry("book-coast", "e-mill", "The Mill", "The mill wheel turns again.");
    coast.updatedAt = NOW - 60_000;
    const changed = (await r.mara.lore.read(r.chat.id, held))[0];
    expect(changed?.updatedAt).toBe(NOW - 60_000);
    expect(changed?.entries?.[1]?.content).toBe("The mill wheel turns again.");

    // A book changed in this very second has no stamp to go by yet: a later change in the same second would carry the same one. It comes whole until the second is over.
    coast.updatedAt = NOW;
    const fresh = (await r.mara.lore.read(r.chat.id, { "book-coast": NOW }))[0];
    expect([fresh?.updatedAt, fresh?.entries?.length]).toEqual([0, 2]);
    r.tick(1_000);
    expect((await r.mara.lore.read(r.chat.id))[0]?.updatedAt).toBe(NOW);
    expect((await r.mara.lore.read(r.chat.id, { "book-coast": NOW }))[0]?.entries).toBeNull();

    // Another user reads neither Mara's chat nor, from a chat of their own that names it, Mara's book.
    expect(await refusal(r.joss.lore.read(r.chat.id))).toBe("not_found");
    r.theirs.metadata.chat_world_book_ids = ["book-coast", "book-nets"];
    expect((await r.joss.lore.read(r.theirs.id)).map((book) => book.id)).toEqual(["book-nets"]);

    // Without the permission to read world books there is no lore to read, and nothing fails.
    r.host.permissions.delete("world_books");
    expect(await r.mara.lore.read(r.chat.id)).toEqual([]);
  });

  test("lore.activated says how Lumiverse activated each entry of a generation's prompt, with the entry's text where it can be read", async () => {
    const r = rig();
    r.host.books.set("book-coast", { book: { id: "book-coast", name: "The Coast", description: "" }, userId: MARA, entries: [entry("book-coast", "e-quay", "The Quay", QUAY), entry("book-coast", "e-mill", "The Mill", MILL)] });
    r.activated.set(`${MARA}/${r.chat.id}/gen-1`, [
      { entryId: "e-quay", bookId: "book-coast", title: "The Quay", how: "key" },
      // Lumiverse named neither its book nor its title: the entry itself says both.
      { entryId: "e-mill", bookId: null, title: "", how: "vector", score: 0.82 },
      // Deleted since the prompt was made, and Lumiverse didn't say how it got there.
      { entryId: "e-ferry", bookId: "book-coast", title: "The Ferry" },
    ]);

    expect(await r.mara.lore.activated(r.chat.id, "gen-1")).toEqual([
      { entryId: "e-quay", bookId: "book-coast", title: "The Quay", how: "key", content: QUAY },
      { entryId: "e-mill", bookId: "book-coast", title: "The Mill", how: "vector", score: 0.82, content: MILL },
      { entryId: "e-ferry", bookId: "book-coast", title: "The Ferry", how: null },
    ]);
    // A generation LumiAH had no turn in, and another user's asking: none.
    expect(await r.mara.lore.activated(r.chat.id, "gen-2")).toEqual([]);
    expect(await r.joss.lore.activated(r.chat.id, "gen-1")).toEqual([]);

    // Without the permission to read world books, which entries and how still stand; their text can't be read.
    r.host.permissions.delete("world_books");
    expect(await r.mara.lore.activated(r.chat.id, "gen-1")).toEqual([
      { entryId: "e-quay", bookId: "book-coast", title: "The Quay", how: "key" },
      { entryId: "e-mill", bookId: null, title: "", how: "vector", score: 0.82 },
      { entryId: "e-ferry", bookId: "book-coast", title: "The Ferry", how: null },
    ]);
  });

  test("chat.messages gives a range of the chat's messages, each with when it was sent", async () => {
    const r = rig();
    const asked = r.host.say(r.chat.id, "user", "Who keeps the harbour light now?");
    r.tick(90_000);
    const told = r.host.say(r.chat.id, "assistant", "Okoro does, since the flood.");
    r.tick(DAY);
    const undated = r.host.say(r.chat.id, "user", "And who kept it before him?");
    // A message Lumiverse has no time for.
    undated.at = null;

    expect(await r.mara.chat.messages(r.chat.id, 0, 3)).toEqual([
      { id: asked.id, index: 0, role: "user", name: "Mara", swipeId: 0, content: "Who keeps the harbour light now?", at: NOW },
      { id: told.id, index: 1, role: "assistant", name: "Joss", swipeId: 0, content: "Okoro does, since the flood.", at: NOW + 90_000 },
      { id: undated.id, index: 2, role: "user", name: "Mara", swipeId: 0, content: "And who kept it before him?", at: null },
    ]);
    expect((await r.mara.chat.messages(r.chat.id, 1, 2)).map((m) => m.id)).toEqual([told.id]);
    expect(await r.mara.chat.messages(r.chat.id, 2, 2)).toEqual([]);

    // Another user's asking for Mara's chat is refused as a chat that isn't there.
    expect(await refusal(r.joss.chat.messages(r.chat.id, 0, 3))).toBe("not_found");
  });

  test("embeddings gives the user's main embedding connection and embeds on it, within Lumiverse's bounds", async () => {
    const r = rig();
    // Until the permission is granted there is no connection, and search is by word.
    const main = { userId: MARA, main: true, enabled: true, connection: { id: "emb-main", name: "Harbour embeddings", model: "embed-large", dimensions: 3 } };
    r.host.embedders.push({ userId: MARA, main: false, enabled: true, connection: { id: "emb-spare", name: "Spare", model: "embed-small", dimensions: null } }, main);
    expect(await r.mara.embeddings.connection()).toBeNull();
    await expect(r.mara.embeddings.embed(["the quay at dawn"], "query")).rejects.toThrow("There is no embedding connection to use");

    r.host.permissions.add("embeddings");
    expect(await r.mara.embeddings.connection()).toEqual({ id: "emb-main", name: "Harbour embeddings", model: "embed-large", dimensions: 3 });
    expect(await r.mara.embeddings.embed(["the quay at dawn", "Okoro's lamp"], "query")).toEqual({ vectors: [r.host.embedText("the quay at dawn", "query"), r.host.embedText("Okoro's lamp", "query")], model: "embed-large", dimensions: 3 });
    expect(r.host.embedCalls).toEqual([{ userId: MARA, texts: ["the quay at dawn", "Okoro's lamp"], kind: "query" }]);

    // A call outside Lumiverse's bounds is refused in words that name the bound, and never reaches Lumiverse.
    const many = Array.from({ length: EMBED_BATCH_MAX + 1 }, (_, i) => `Entry ${i} of the coast.`);
    await expect(r.mara.embeddings.embed(many, "stored")).rejects.toThrow(`One call embeds from 1 to ${EMBED_BATCH_MAX} texts, and this one has ${EMBED_BATCH_MAX + 1}.`);
    await expect(r.mara.embeddings.embed([], "stored")).rejects.toThrow("and this one has 0.");
    await expect(r.mara.embeddings.embed(["the quay", "   "], "stored")).rejects.toThrow(`A text to embed is not blank and has ${EMBED_TEXT_MAX} characters at most: text 2 of this call isn't so.`);
    await expect(r.mara.embeddings.embed(["x".repeat(EMBED_TEXT_MAX + 1)], "stored")).rejects.toThrow("text 1 of this call isn't so.");
    expect(r.host.embedCalls).toHaveLength(1);
    // A call at the bounds goes through.
    expect((await r.mara.embeddings.embed(Array.from({ length: EMBED_BATCH_MAX }, () => "x".repeat(EMBED_TEXT_MAX)), "stored")).vectors).toHaveLength(EMBED_BATCH_MAX);

    // A call whose caller already gave up never starts.
    const gone = new AbortController();
    gone.abort(new Error("the run was stopped"));
    await expect(r.mara.embeddings.embed(["the quay"], "stored", gone.signal)).rejects.toThrow("the run was stopped");

    // Another user has no connection of their own, and Mara's isn't theirs to embed on.
    expect(await r.joss.embeddings.connection()).toBeNull();
    await expect(r.joss.embeddings.embed(["the mill"], "stored")).rejects.toThrow("Embedding connection not found");

    // The main connection switched off, and a Lumiverse that embeds nothing for an extension: no connection.
    main.enabled = false;
    expect(await r.mara.embeddings.connection()).toBeNull();
    main.enabled = true;
    r.host.capabilities.delete("embeddings-v1");
    expect(await r.mara.embeddings.connection()).toBeNull();
  });

  test("memory reads Lumiverse's Memory Cortex for a chat: whether it is on, its answer to a query, an entity, the entities and the arcs", async () => {
    const r = rig();
    r.host.cortexOn.add(MARA);
    r.host.cortex.set(r.chat.id, {
      hits: [
        { source: "chunk", text: "[USER | Mara]: Who keeps the harbour light now?", score: 0.61, span: [0, 1], entities: ["Mara", "Okoro"] },
        { source: "arc", text: "The flood: Okoro takes over the light.", score: 0.83, span: [0, 7], entities: ["Okoro"] },
        { source: "chunk", text: "[CHARACTER | Joss]: Brann mends the nets by the quay.", score: 0.4, span: null, entities: ["Brann"] },
      ],
      entities: [
        {
          id: "ent-okoro",
          name: "Okoro",
          type: "character",
          aliases: ["the keeper"],
          description: "Keeps the harbour light.",
          status: "active",
          facts: ["Keeps the second key on a cord around his neck."],
          mentions: 12,
          lastSeenAt: NOW - DAY,
          relations: [
            { target: "Ilse", type: "ally", label: null, strength: 0.4, sentiment: 0.5 },
            { target: "The Lighthouse", type: "located_in", label: "keeps it", strength: 0.9, sentiment: 0.2 },
          ],
        },
        { id: "ent-brann", name: "Brann", type: "character", aliases: [], description: "", status: "active", facts: [], mentions: 30, lastSeenAt: null, relations: [] },
        { id: "ent-ferry", name: "The Ferry", type: "item", aliases: [], description: "", status: "destroyed", facts: [], mentions: 50, lastSeenAt: null, relations: [] },
      ],
      arcs: [
        { id: "arc-1", tier: 1, title: "The flood", summary: "The river takes the mill wheel.", span: [0, 7], at: NOW - DAY },
        { id: "arc-2", tier: 2, title: null, summary: "A winter at the harbour.", span: null, at: NOW },
      ],
    });

    // Without the permission the Cortex reads as off and holds nothing, so its tools aren't offered; nothing fails.
    expect(await r.mara.memory.enabled(r.chat.id)).toBe(false);
    expect(await r.mara.memory.search(r.chat.id, "who keeps the light", { limit: 5 })).toEqual([]);
    expect(await r.mara.memory.entity(r.chat.id, "Okoro")).toBeNull();
    expect(await r.mara.memory.entities(r.chat.id, 5)).toEqual([]);
    expect(await r.mara.memory.arcs(r.chat.id)).toEqual([]);

    r.host.permissions.add("memories");
    expect(await r.mara.memory.enabled(r.chat.id)).toBe(true);
    // The Cortex's own answer, the best first, `limit` at most; and only what names an entity asked for.
    expect(await r.mara.memory.search(r.chat.id, "who keeps the light", { limit: 2 })).toEqual([
      { source: "arc", text: "The flood: Okoro takes over the light.", score: 0.83, span: [0, 7], entities: ["Okoro"] },
      { source: "chunk", text: "[USER | Mara]: Who keeps the harbour light now?", score: 0.61, span: [0, 1], entities: ["Mara", "Okoro"] },
    ]);
    expect((await r.mara.memory.search(r.chat.id, "nets", { limit: 5, entities: ["Brann"] })).map((hit) => hit.text)).toEqual(["[CHARACTER | Joss]: Brann mends the nets by the quay."]);
    expect(r.host.cortexQueries).toEqual([
      { userId: MARA, chatId: r.chat.id, query: "who keeps the light", limit: 2, entities: [] },
      { userId: MARA, chatId: r.chat.id, query: "nets", limit: 5, entities: ["Brann"] },
    ]);
    // An entity by one of its aliases, its relations the strongest first.
    expect(await r.mara.memory.entity(r.chat.id, "The Keeper")).toEqual({
      id: "ent-okoro",
      name: "Okoro",
      type: "character",
      aliases: ["the keeper"],
      description: "Keeps the harbour light.",
      status: "active",
      facts: ["Keeps the second key on a cord around his neck."],
      mentions: 12,
      lastSeenAt: NOW - DAY,
      relations: [
        { target: "The Lighthouse", type: "located_in", label: "keeps it", strength: 0.9, sentiment: 0.2 },
        { target: "Ilse", type: "ally", label: null, strength: 0.4, sentiment: 0.5 },
      ],
    });
    expect(await r.mara.memory.entity(r.chat.id, "Ilse")).toBeNull();
    // The entities still in the story, the most salient first.
    expect(await r.mara.memory.entities(r.chat.id, 5)).toEqual([
      { name: "Brann", type: "character", mentions: 30 },
      { name: "Okoro", type: "character", mentions: 12 },
    ]);
    expect(await r.mara.memory.entities(r.chat.id, 1)).toEqual([{ name: "Brann", type: "character", mentions: 30 }]);
    expect((await r.mara.memory.arcs(r.chat.id)).map((arc) => [arc.id, arc.tier, arc.title, arc.span, arc.at])).toEqual([
      ["arc-1", 1, "The flood", [0, 7], NOW - DAY],
      ["arc-2", 2, null, null, NOW],
    ]);

    // A search whose caller gave up is let go: before it starts, and while it is under way (Lumiverse can't be told to stop one).
    const gone = new AbortController();
    gone.abort(new Error("the run was stopped"));
    await expect(r.mara.memory.search(r.chat.id, "nets", { limit: 5 }, gone.signal)).rejects.toThrow("the run was stopped");
    const stop = new AbortController();
    const searching = r.mara.memory.search(r.chat.id, "nets", { limit: 5 }, stop.signal);
    stop.abort(new Error("the user pressed Stop"));
    await expect(searching).rejects.toThrow("the user pressed Stop");

    // Another user: Mara's chat is no chat of theirs, whatever is asked of it; and their own chat has the Cortex off.
    const asked = [r.joss.memory.enabled(r.chat.id), r.joss.memory.search(r.chat.id, "light", { limit: 5 }), r.joss.memory.entity(r.chat.id, "Okoro"), r.joss.memory.entities(r.chat.id, 5), r.joss.memory.arcs(r.chat.id)];
    expect(await Promise.all(asked.map(refusal))).toEqual(["not_found", "not_found", "not_found", "not_found", "not_found"]);
    expect(await r.joss.memory.enabled(r.theirs.id)).toBe(false);

    // A chat may have the Cortex off for itself, as Lumiverse reads its metadata: a temporary chat, or one switched off in its own Cortex settings.
    r.chat.metadata.cortex_settings = { enabled: false };
    expect(await r.mara.memory.enabled(r.chat.id)).toBe(false);
    expect(await r.mara.memory.search(r.chat.id, "who keeps the light", { limit: 5 })).toEqual([]);
    r.chat.metadata.cortex_settings = { enabled: true };
    expect(await r.mara.memory.enabled(r.chat.id)).toBe(true);
    r.chat.metadata.temporary = true;
    expect(await r.mara.memory.enabled(r.chat.id)).toBe(false);
  });

  test("databanks lists the databanks that apply to the chat and are switched on, their documents, and a document's text", async () => {
    const r = rig();
    const bank = (id: string, name: string, scope: "global" | "character" | "chat", scopeId: string | null, more: { enabled?: boolean; userId?: string } = {}) => ({ id, name, description: `${name}, as kept.`, scope, scopeId, enabled: true, userId: MARA, ...more });
    r.host.databankList.push(
      bank("bank-almanac", "Almanac", "global", null),
      bank("bank-log", "Harbour log", "chat", r.chat.id),
      bank("bank-okoro", "Okoro's letters", "character", "char-okoro"),
      // Named by the chat's metadata, and by the character's card, though scoped elsewhere.
      bank("bank-charts", "Charts", "chat", "chat-elsewhere"),
      bank("bank-songs", "Songs", "character", "char-ilse"),
      // Switched off; scoped to another chat and to another character; and another user's.
      bank("bank-old", "Old almanac", "global", null, { enabled: false }),
      bank("bank-other-chat", "Another chat's", "chat", "chat-elsewhere-2"),
      bank("bank-other-character", "Brann's ledger", "character", "char-brann"),
      bank("bank-joss", "Joss's notes", "global", null, { userId: JOSS }),
    );
    r.chat.metadata.chat_databank_ids = ["bank-charts"];
    r.host.characterDatabanks.set("char-okoro", ["bank-songs"]);
    r.host.documentList.push(
      { id: "doc-tides", databankId: "bank-almanac", name: "Tide tables", version: "h1:10", bytes: 2048, status: "ready", userId: MARA, text: "High water at Okoro's Quay: 06:10 and 18:40." },
      { id: "doc-moons", databankId: "bank-almanac", name: "Moons", version: "h2:11", bytes: null, status: "processing", userId: MARA, text: "Waning." },
      { id: "doc-notes", databankId: "bank-joss", name: "Notes", version: "h3:12", bytes: 12, status: "ready", userId: JOSS, text: "The mill wheel." },
    );

    // Without the permission there are none, so the databank tools aren't offered; nothing fails.
    expect(await r.mara.databanks.list(r.chat.id)).toEqual([]);
    expect(await r.mara.databanks.documents("bank-almanac")).toEqual([]);
    expect(await r.mara.databanks.content("doc-tides")).toBeNull();

    r.host.permissions.add("databanks");
    expect(await r.mara.databanks.list(r.chat.id)).toEqual([
      { id: "bank-almanac", name: "Almanac", description: "Almanac, as kept.", scope: "global", documents: 2 },
      { id: "bank-log", name: "Harbour log", description: "Harbour log, as kept.", scope: "chat", documents: 0 },
      { id: "bank-okoro", name: "Okoro's letters", description: "Okoro's letters, as kept.", scope: "character", documents: 0 },
      { id: "bank-charts", name: "Charts", description: "Charts, as kept.", scope: "chat", documents: 0 },
      { id: "bank-songs", name: "Songs", description: "Songs, as kept.", scope: "character", documents: 0 },
    ]);
    expect(await r.mara.databanks.documents("bank-almanac")).toEqual([
      { id: "doc-tides", databankId: "bank-almanac", name: "Tide tables", version: "h1:10", bytes: 2048, status: "ready" },
      { id: "doc-moons", databankId: "bank-almanac", name: "Moons", version: "h2:11", bytes: null, status: "processing" },
    ]);
    // A document's text can be read once Lumiverse has read it in.
    expect(await r.mara.databanks.content("doc-tides")).toBe("High water at Okoro's Quay: 06:10 and 18:40.");
    expect(await r.mara.databanks.content("doc-moons")).toBeNull();

    // A chat that keeps its memory to itself takes no databank through its character.
    r.chat.metadata.memory_isolation = true;
    expect((await r.mara.databanks.list(r.chat.id)).map((b) => b.id)).toEqual(["bank-almanac", "bank-log", "bank-charts"]);

    // Another user: Mara's chat is refused, her databanks and documents aren't theirs to read, and their own chat has only their own.
    expect(await refusal(r.joss.databanks.list(r.chat.id))).toBe("not_found");
    expect(await r.joss.databanks.documents("bank-almanac")).toEqual([]);
    expect(await r.joss.databanks.content("doc-tides")).toBeNull();
    expect((await r.joss.databanks.list(r.theirs.id)).map((b) => b.id)).toEqual(["bank-joss"]);
    expect(await r.mara.databanks.content("doc-notes")).toBeNull();
  });

  test("web searches with the user's own provider, as many results and pages as their setting allows", async () => {
    const r = rig();
    r.host.webSearches.set(MARA, {
      enabled: true,
      maxResults: 3,
      maxPages: 1,
      results: [
        { title: "Tide tables", url: "https://tides.example/harbour", snippet: "High water at 06:10.", page: "High water at Okoro's Quay: 06:10 and 18:40. Low water at noon." },
        { title: "Harbour lights", url: "https://lights.example/list", snippet: "Every light on the coast.", page: "The harbour light, the point light and the mill lamp." },
        { title: "Mill wheels", url: "https://mills.example/wheels", snippet: "How a wheel is mended." },
        { title: "Nets", url: "https://nets.example/mending", snippet: "Mending a net." },
      ],
    });

    // Without the permission there is no provider, so `web_search` isn't offered; nothing fails.
    expect(await r.mara.web.enabled()).toBe(false);
    expect(await r.mara.web.search("tides at the harbour", { count: 2, pages: false })).toEqual([]);

    r.host.permissions.add("web_search");
    expect(await r.mara.web.enabled()).toBe(true);
    expect(await r.mara.web.search("tides at the harbour", { count: 2, pages: false })).toEqual([
      { title: "Tide tables", url: "https://tides.example/harbour", snippet: "High water at 06:10." },
      { title: "Harbour lights", url: "https://lights.example/list", snippet: "Every light on the coast." },
    ]);
    // With pages, each page Lumiverse read comes with its text: as many as the user's own setting allows, as are the results.
    expect(await r.mara.web.search("tides at the harbour", { count: 10, pages: true })).toEqual([
      { title: "Tide tables", url: "https://tides.example/harbour", snippet: "High water at 06:10.", content: "High water at Okoro's Quay: 06:10 and 18:40. Low water at noon." },
      { title: "Harbour lights", url: "https://lights.example/list", snippet: "Every light on the coast." },
      { title: "Mill wheels", url: "https://mills.example/wheels", snippet: "How a wheel is mended." },
    ]);
    expect(r.host.webQueries).toEqual([
      { userId: MARA, query: "tides at the harbour", count: 2, pages: false },
      { userId: MARA, query: "tides at the harbour", count: 10, pages: true },
    ]);
    // A call for no results asks nothing; one whose caller gave up never starts.
    expect(await r.mara.web.search("tides", { count: 0, pages: false })).toEqual([]);
    const gone = new AbortController();
    gone.abort(new Error("the run was stopped"));
    await expect(r.mara.web.search("tides", { count: 2, pages: false }, gone.signal)).rejects.toThrow("the run was stopped");
    expect(r.host.webQueries).toHaveLength(2);

    // The provider's own failure is told in its words.
    const set = r.host.webSearches.get(MARA);
    if (set !== undefined) set.fails = "SearXNG returned HTTP 502";
    await expect(r.mara.web.search("tides", { count: 2, pages: false })).rejects.toThrow("SearXNG returned HTTP 502");

    // Another user has set up none of their own: Mara's isn't theirs to search with.
    expect(await r.joss.web.enabled()).toBe(false);
    await expect(r.joss.web.search("the mill", { count: 2, pages: false })).rejects.toThrow("Web search is disabled");
  });

  test("a runtime's ask over the link is served for its own user, once what it names and counts is checked", async () => {
    const r = rig();
    r.host.say(r.chat.id, "user", "Who keeps the harbour light now?");
    r.host.books.set("book-coast", { book: { id: "book-coast", name: "The Coast", description: "" }, userId: MARA, updatedAt: NOW - DAY, entries: [entry("book-coast", "e-quay", "The Quay", QUAY)] });
    r.chat.metadata.chat_world_book_ids = ["book-coast"];

    // Answered as the port itself answers.
    expect(await r.recall.serve(MARA, "recall.chat.messages", { chat: r.chat.id, from: 0, to: 1 })).toMatchObject({ messages: [{ index: 0, content: "Who keeps the harbour light now?", at: NOW }] });
    expect(await r.recall.serve(MARA, "recall.memory.enabled", { chat: r.chat.id })).toEqual({ enabled: false });
    expect(await r.recall.serve(MARA, "book.read", { chat: r.chat.id })).toEqual({ book: null });
    // The stamps a runtime holds come as it sent them: one that is no number is no stamp, and the book comes whole.
    expect(await r.recall.serve(MARA, "recall.lore.read", { chat: r.chat.id, known: { "book-coast": NOW - DAY } })).toMatchObject({ books: [{ id: "book-coast", entries: null }] });
    expect(await r.recall.serve(MARA, "recall.lore.read", { chat: r.chat.id, known: { "book-coast": "yesterday" } })).toMatchObject({ books: [{ id: "book-coast", entries: [{ id: "e-quay" }] }] });

    // A field that names nothing, a count that is none, texts that aren't texts: refused as a request no runtime of this build makes.
    const malformed = [
      r.recall.serve(MARA, "recall.chat.messages", { chat: "", from: 0, to: 1 }),
      r.recall.serve(MARA, "recall.chat.messages", { chat: r.chat.id, from: -1, to: 1 }),
      r.recall.serve(MARA, "recall.memory.search", { chat: r.chat.id, query: "light", limit: 2.5 }),
      r.recall.serve(MARA, "recall.embed", { texts: "the quay", kind: "query" }),
      r.recall.serve(MARA, "recall.embed", { texts: ["the quay"], kind: "passage" }),
      r.recall.serve(MARA, "book.read", {}),
    ];
    expect(await Promise.all(malformed.map(refusal))).toEqual(["bad_request", "bad_request", "bad_request", "bad_request", "bad_request", "bad_request"]);

    // Another user's runtime asking for Mara's chat is refused as for a chat that isn't there.
    expect(await refusal(r.recall.serve(JOSS, "recall.lore.read", { chat: r.chat.id, known: {} }))).toBe("not_found");
    expect(await refusal(r.recall.serve(JOSS, "book.read", { chat: r.chat.id }))).toBe("not_found");
  });
});

describe("a chat's book", () => {
  /** An entry as LumiBooks keeps one in its own book for a chat. */
  const chapter = (id: string, comment: string, content: string, lumibooks: Record<string, string | number | boolean | string[]>): FakeEntry => entry("book-story", id, comment, content, { enabled: false, extensions: { lumibooks: { tokenCountInput: 900, model: "summary-model", ...lumibooks } } });

  test("is LumiBooks' own book for the chat: the one the chat names, when it names the chat back", async () => {
    const r = rig();
    const said = ["Who keeps the harbour light now?", "Okoro does, since the flood.", "And who kept it before him?"].map((text, i) => r.host.say(r.chat.id, i % 2 === 0 ? "user" : "assistant", text));
    const ids = said.map((m) => m.id);
    r.host.books.set("book-story", {
      book: { id: "book-story", name: "LumiBooks: Harbour light", description: "" },
      userId: MARA,
      metadata: { lumibooks_chat_id: r.chat.id, lumibooks_created_at: 1 },
      entries: [
        chapter("ch-1", "#1 - The Light (msgs 1-2)", "## The Light\nOkoro keeps the harbour light since the flood.", { chatId: r.chat.id, tier: 1, msgIds: ids.slice(0, 2), firstMsgIdx: 0, lastMsgIdx: 1, title: "The Light" }),
        chapter("root-1", "[Root] #9 - The Night Before", "Joss locks the mill for the night.", { chatId: r.chat.id, tier: 1, msgIds: ["elsewhere-3"], firstMsgIdx: -1, lastMsgIdx: -1, isRoot: true }),
        entry("book-story", "loose-1", "A page torn out", "Brann burned it."),
      ],
    });
    // The codex LumiBooks keeps beside the book is lore, and never the book.
    r.host.books.set("book-codex", { book: { id: "book-codex", name: "LumiBooks Codex: Harbour light", description: "" }, userId: MARA, metadata: { lumibooks_codex_chat_id: r.chat.id }, entries: [entry("book-codex", "cx-1", "Okoro", "Keeper of the light.")] });
    r.chat.metadata.chat_world_book_ids = ["book-story", "book-codex"];
    const book = r.recall.book(MARA);

    // The chat doesn't name its book yet: it has none.
    expect(await book.read(r.chat.id)).toBeNull();

    r.chat.metadata.lumibooks_book_id = "book-story";
    expect(await book.read(r.chat.id)).toEqual({
      entries: [
        // Of what LumiBooks keeps on an entry, what the core reads.
        { id: "ch-1", comment: "#1 - The Light (msgs 1-2)", content: "## The Light\nOkoro keeps the harbour light since the flood.", extensions: { lumibooks: { chatId: r.chat.id, tier: 1, msgIds: ids.slice(0, 2), firstMsgIdx: 0, lastMsgIdx: 1, title: "The Light" } } },
        { id: "root-1", comment: "[Root] #9 - The Night Before", content: "Joss locks the mill for the night.", extensions: { lumibooks: { chatId: r.chat.id, tier: 1, msgIds: ["elsewhere-3"], firstMsgIdx: -1, lastMsgIdx: -1, isRoot: true } } },
        { id: "loose-1", comment: "A page torn out", content: "Brann burned it.", extensions: {} },
      ],
      // LumiBooks' own book names the messages it summarized by id, and keeps no hash of them.
      hashes: [],
    });

    // A branch carries its source's claim: the book names the source, so the branch has no book.
    const branch = r.host.addChat(MARA, "Harbour light (branch)", "chat-branch");
    branch.metadata = { lumibooks_book_id: "book-story", chat_world_book_ids: ["book-story", "book-codex"] };
    expect(await book.read(branch.id)).toBeNull();

    // Another user reads neither Mara's chat nor, from a chat of their own that names it, her book.
    expect(await refusal(r.recall.book(JOSS).read(r.chat.id))).toBe("not_found");
    r.theirs.metadata = { lumibooks_book_id: "book-story", chat_world_book_ids: ["book-story"] };
    expect(await r.recall.book(JOSS).read(r.theirs.id)).toBeNull();

    // Without the permission to read world books no chat has a book, and nothing fails.
    r.host.permissions.delete("world_books");
    expect(await book.read(r.chat.id)).toBeNull();
  });

  test("is a summaries lorebook kept as a world book of the chat where LumiBooks has none of its own, with the hashes it keeps beside the messages as they stand", async () => {
    const r = rig();
    const lines: [ChatRole, string][] = [
      ["assistant", "The wheel stands still, flood wood jammed in the race."],
      ["user", "Mara wades in to clear it."],
      ["assistant", "Brann brings a pole and they lever the wood free."],
    ];
    for (const [role, text] of lines) r.host.say(r.chat.id, role, text);
    const kept = await Promise.all(lines.map(async ([role, text], index) => ({ index, hash: await lumibooksHash(role, text) })));
    const summary = (id: string, comment: string, content: string, tier: number, messageIndices: number[]): FakeEntry => entry("book-kept", id, comment, content, { constant: true, extensions: { lumibooks_summary: { tier, messageIndices }, displayIndex: 0 } });
    const lorebook: FakeBook = {
      book: { id: "book-kept", name: "LumiBooks summaries", description: "" },
      userId: MARA,
      // The hashes LumiBooks wrote on the lorebook's file, kept with the book; one more for a message the chat no longer has.
      metadata: { source: "import", extensions: { lumibooks_summary: { version: 1, algorithm: "sha256-role-content-v1", contentHash: "0".repeat(64), messages: [...kept, { index: 7, hash: "a".repeat(64) }, { index: -1, hash: "b".repeat(64) }, { index: 2, hash: "not a hash" }] } } },
      entries: [summary("0", "Arc #1 - The Still Wheel (msgs 1-3)", "Flood wood stops the wheel, and Mara and Brann clear it.", 2, [0, 1, 2]), summary("1", "#1 - Into the Race (msgs 1-2)", "Mara wades in.", 1, [0, 1])],
    };
    r.host.books.set("book-kept", lorebook);
    r.host.books.set("book-coast", { book: { id: "book-coast", name: "The Coast", description: "" }, userId: MARA, entries: [entry("book-coast", "e-quay", "The Quay", QUAY)] });
    const book = r.recall.book(MARA);

    // Attached to the chat's character, it applies to every chat with that character: its places mean nothing there, so it is lore and no book.
    r.host.characterBooks.set("char-okoro", ["book-kept"]);
    r.chat.metadata.chat_world_book_ids = ["book-coast"];
    expect(await book.read(r.chat.id)).toBeNull();

    // Attached to the chat itself, its entries are the book, and each hash it kept stands beside the same hash of the message at that place now.
    r.chat.metadata.chat_world_book_ids = ["book-coast", "book-kept"];
    expect(await book.read(r.chat.id)).toEqual({
      entries: [
        { id: "0", comment: "Arc #1 - The Still Wheel (msgs 1-3)", content: "Flood wood stops the wheel, and Mara and Brann clear it.", extensions: { lumibooks_summary: { tier: 2, messageIndices: [0, 1, 2] } } },
        { id: "1", comment: "#1 - Into the Race (msgs 1-2)", content: "Mara wades in.", extensions: { lumibooks_summary: { tier: 1, messageIndices: [0, 1] } } },
      ],
      hashes: [...kept.map((k) => ({ index: k.index, kept: k.hash, now: k.hash })), { index: 7, kept: "a".repeat(64), now: null }],
    });

    // A message edited since it was summarized no longer hashes as it did.
    const edited = r.host.chatList.get(r.chat.id)?.messages[1];
    if (edited !== undefined) edited.swipes[0] = "Mara calls Brann before she wades in.";
    const after = await book.read(r.chat.id);
    expect(after?.hashes.map((h) => h.now === h.kept)).toEqual([true, false, true, false]);
    expect(after?.hashes[1]?.now).toBe(await lumibooksHash("user", "Mara calls Brann before she wades in."));

    // A lorebook Lumiverse imported from the file keeps the marks on its entries and no hashes: it is still the book.
    lorebook.metadata = { source: "import" };
    expect((await book.read(r.chat.id))?.hashes).toEqual([]);
    expect((await book.read(r.chat.id))?.entries).toHaveLength(2);

    // LumiBooks made its own book for the chat and has written nothing in it yet: the lorebook the user keeps is still the book.
    r.host.books.set("book-story", { book: { id: "book-story", name: "LumiBooks: Harbour light", description: "" }, userId: MARA, metadata: { lumibooks_chat_id: r.chat.id }, entries: [] });
    r.chat.metadata.lumibooks_book_id = "book-story";
    r.chat.metadata.chat_world_book_ids = ["book-story", "book-coast", "book-kept"];
    expect((await book.read(r.chat.id))?.entries.map((e) => e.id)).toEqual(["0", "1"]);
  });
});
