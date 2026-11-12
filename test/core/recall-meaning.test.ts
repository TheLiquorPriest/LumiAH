// Search by meaning (DESIGN §24.5): what `Meaning` finds, what it keeps and what it costs. A
// paraphrase found beside the hits by word; a text embedded once however often it is searched,
// across a restart, under another key and in a branch; the daily cap, for stored texts and for a
// search's queries; that nothing is embedded until the user switches it on; a host with no
// embedder; an embedder that fails, and one that never answers; what the page is told; stored
// vectors that are damaged; and how long a search over a long chat takes.

import { describe, expect, test } from "bun:test";
import { textHash } from "../../src/core/hash";
import { Meaning, type MeaningGroup } from "../../src/core/recall/meaning";
import type { EmbeddingsPort } from "../../src/core/recall/ports";
import { mergeRanked } from "../../src/core/recall/rank";
import { Recall, recallOf } from "../../src/core/recall/recall";
import { defaultSettings, type Settings } from "../../src/core/settings";
import { CHAT_TOOLS } from "../../src/core/tools/chat";
import { LORE_TOOLS } from "../../src/core/tools/lore";
import { Storage } from "../../src/extension/backend/reads";
import { DOC_PATH } from "../../src/link/contract";
import { CHAT, DAY, FakeEmbedder, harbour, RecallHost, toolRig } from "./recall-support";

const HOUR = 3_600_000;

/** Words that mean the same, as the fake embedder knows them. */
const CONCEPTS = [
  ["debt", "debts", "owed", "owes", "arrears"],
  ["ledger", "accounts", "register"],
  ["lighthouse", "lamp", "beacon"],
  ["key", "keys", "latchkey"],
  ["strongbox", "coffer"],
  ["row", "oars", "skiff"],
];

/** How long the fake embedder's vectors are, and where they are kept: its connection, its model, and the model's own dimensions. */
const DIMS = CONCEPTS.length + 8;
const SPACE = "embed-1.fake-embed.own";
const VECTORS = `recall/vectors/${SPACE}`;
const COUNT = "recall/embedded.json";

/** Search by meaning as a user who chose it has it: a new user's settings have it off. */
const on = (settings: Settings): void => void (settings.recall.meaning.enabled = true);

/** The harbour story on a host whose user has an embedding connection, and has switched search by meaning on. */
function setup(change: (settings: Settings) => void = () => undefined) {
  const host = harbour();
  const embedder = new FakeEmbedder(CONCEPTS);
  host.recall = { ...host.recall, embeddings: embedder };
  const settings = defaultSettings();
  on(settings);
  change(settings);
  return { host, embedder, settings };
}

/** Texts as search by meaning takes them, each under the hash of its text. */
async function groupOf(kind: "chat" | "book", id: string, texts: Record<string, string>): Promise<MeaningGroup> {
  return { owner: { kind, id }, texts: await Promise.all(Object.entries(texts).map(async ([key, text]) => ({ key, hash: await textHash(text), text }))) };
}

/** A chat's messages as search by meaning takes them. */
async function chatOf(host: RecallHost, chatId = CHAT): Promise<MeaningGroup> {
  const messages = await host.chat.messages(chatId, 0, (await host.chat.path(chatId)).length);
  return groupOf("chat", chatId, Object.fromEntries(messages.map((m) => [m.id, m.content])));
}

/** The host's world books as search by meaning takes them: each entry's title, keys and text. */
function loreOf(host: RecallHost): Promise<MeaningGroup[]> {
  return Promise.all(host.books.map((book) => groupOf("book", book.id, Object.fromEntries(host.entries.filter((e) => e.bookId === book.id).map((e) => [e.id, `${e.title}\n${e.keys.join(", ")}\n${e.content}`])))));
}

const tokensOf = (text: string, settings: Settings): number => Math.ceil(text.length / settings.loop.charsPerToken);

/** The document an owner's vector for a hash is kept in. */
const docOf = (owner: string, hash: string): string => `${VECTORS}/${owner}/${hash.slice(0, 2)}.json`;

/** The vectors a stored document holds, as stored: text, by hash. */
function vectorsAt(host: RecallHost, path: string): Record<string, string> {
  const doc = host.documents.get(path) as { vectors?: Record<string, string> } | undefined;
  return doc?.vectors ?? {};
}

const warnings = (host: RecallHost): string[] => host.logs.filter((l) => l.level === "warn").map((l) => l.message);

/** The calls of one kind an embedder took, each with its texts. */
const callsOf = (embedder: FakeEmbedder, kind: "query" | "stored"): string[][] => embedder.calls.filter((c) => c.kind === kind).map((c) => c.texts);

/** A group's texts in the order they are embedded: by their hashes, so a batch's vectors fall into few of the owner's documents. */
const inOrder = (group: MeaningGroup): string[] => [...group.texts].sort((a, b) => (a.hash < b.hash ? -1 : 1)).map((t) => t.text);

/** Lets everything that waits on no clock run: the store of these tests answers at once, so what is still unanswered afterwards waits on the embedder or on the clock. */
const tick = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));

/**
 * Puts a port before the host's embedder that never answers the calls `holds` picks (by their kind,
 * and how many of that kind came before): as a port that ends a call once the signal it was given
 * ends (`listens`), or as one that ignores its signal. Each held call is kept with its texts and
 * its signal; `arrived` waits until so many are held.
 */
function holding(host: RecallHost, embedder: FakeEmbedder, listens: boolean, holds: (kind: "query" | "stored", nth: number) => boolean) {
  const held: { texts: string[]; kind: "query" | "stored"; signal: AbortSignal | undefined }[] = [];
  const seen = { query: 0, stored: 0 };
  let arrival = Promise.withResolvers<void>();
  const port: EmbeddingsPort = {
    connection: embedder.connection,
    embed: (texts, kind, signal) => {
      if (!holds(kind, seen[kind]++)) return embedder.embed(texts, kind);
      held.push({ texts: [...texts], kind, signal });
      arrival.resolve();
      return new Promise((_resolve, reject) => {
        if (listens) signal?.addEventListener("abort", () => reject(signal.reason), { once: true });
      });
    },
  };
  host.recall = { ...host.recall, embeddings: port };
  return {
    held,
    arrived: async (count: number): Promise<void> => {
      while (held.length < count) {
        await arrival.promise;
        arrival = Promise.withResolvers<void>();
      }
    },
  };
}

describe("a search by meaning", () => {
  test("finds a paraphrase that shares no word with the query, and one ranking holds it beside the hits by word", async () => {
    const { host } = setup();
    const rig = await toolRig(host, [], { settings: on });
    const run = recallOf(rig.env);
    const chat = await run.chat();
    const query = "ledger arrears";
    // Nothing is embedded yet: the first search finds nothing by meaning, and has the chat embedded behind it.
    expect(await run.meaning("chat", [query])).toEqual({ state: "on", matches: [[]] });
    await Recall.of(host).meaning.settled();
    const found = await run.meaning("chat", [query]);
    expect(found.state).toBe("on");
    const matches = found.matches[0]!;

    // Two messages are about a debt in other words: neither says "ledger" or "arrears".
    const owed = chat.messages.find((m) => m.text.includes("what's owed"))!;
    const debt = chat.messages.find((m) => m.text.includes("Every debt"))!;
    for (const message of [owed, debt]) {
      expect(/ledger|arrears/i.test(message.text)).toBe(false);
      expect(matches.map((m) => m.key)).toContain(message.id);
    }
    // The closest first, none below Settings' least similarity.
    const closeness = matches.map((m) => m.similarity);
    expect(closeness).toEqual([...closeness].sort((a, b) => b - a));
    expect(closeness.every((s) => s >= rig.settings.recall.meaning.floor && s <= 1)).toBe(true);

    const words = chat.index.search(query, { keep: chat.has }).map((hit) => ({ key: hit.key, score: hit.score }));
    expect(words.length).toBeGreaterThan(0);
    expect(words.map((w) => w.key)).not.toContain(debt.id);
    const merged = mergeRanked(words, matches, rig.settings.recall.meaning);
    // Every hit of either kind is in the one ranking, once; the paraphrase by its meaning alone, and a message both found first.
    expect(merged.map((hit) => hit.key).sort()).toEqual([...new Set([...words.map((w) => w.key), ...matches.map((m) => m.key)])].sort());
    expect(merged.find((hit) => hit.key === debt.id)).toMatchObject({ by: ["meaning"], similarity: matches.find((m) => m.key === debt.id)!.similarity });
    expect(merged.some((hit) => hit.by.length === 1 && hit.by[0] === "word")).toBe(true);
    expect(merged[0]!.by).toEqual(["word", "meaning"]);
  });

  test("gives each query its own list: only keys the caller keeps, no more than Settings' matches, none below the floor", async () => {
    const { host, embedder, settings } = setup();
    const chat = await chatOf(host);
    const meaning = new Meaning(host);
    await meaning.status({ lore: [], chat, settings, start: true });
    await meaning.settled();
    const keyOf = (words: string): string => chat.texts.find((t) => t.text.includes(words))!.key;

    const found = await meaning.search({ groups: [chat], queries: ["arrears", "  ", "beacon", "arrears"], settings });
    expect(found.state).toBe("on");
    expect(found.matches.map((list) => list.map((m) => m.key).sort())).toEqual([[keyOf("what's owed"), keyOf("Every debt")].sort(), [], [keyOf("row out to the lighthouse"), keyOf("trimming the lamp")].sort(), [keyOf("what's owed"), keyOf("Every debt")].sort()]);
    // The queries of a search go in one call: each once, and a blank one not at all.
    expect(callsOf(embedder, "query")).toEqual([["arrears", "beacon"]]);

    const kept = await meaning.search({ groups: [chat], queries: ["arrears"], keep: (key) => key !== keyOf("Every debt"), settings });
    expect(kept.matches).toEqual([[{ key: keyOf("what's owed"), similarity: expect.any(Number) }]]);

    settings.recall.meaning.matches = 1;
    const one = await meaning.search({ groups: [chat], queries: ["arrears"], settings });
    expect(one.matches[0]).toHaveLength(1);
    expect(one.matches[0]![0]).toEqual(found.matches[0]![0]!);

    settings.recall.meaning.floor = 0.999;
    expect((await meaning.search({ groups: [chat], queries: ["arrears"], settings })).matches).toEqual([[]]);
    // A query asked again is not embedded again: a search that is paged asks the same one.
    expect(callsOf(embedder, "query")).toEqual([["arrears", "beacon"]]);
  });

  test("embeds a query no longer than Settings embed a text, whatever it is given", async () => {
    const { host, embedder, settings } = setup((s) => (s.recall.meaning.textChars = 120));
    const chat = await chatOf(host);
    const meaning = new Meaning(host);
    await meaning.status({ lore: [], chat, settings, start: true });
    await meaning.settled();
    const found = await meaning.search({ groups: [chat], queries: ["arrears ".repeat(625)], settings });
    expect(found.matches[0]!.length).toBeGreaterThan(0);
    const [[sent]] = callsOf(embedder, "query") as [[string]];
    expect(sent.length).toBeLessThanOrEqual(120);
    expect(sent.startsWith("arrears arrears")).toBe(true);
  });
});

describe("a text is embedded once", () => {
  test("not again by a second search, not after a restart, not under another key", async () => {
    const { host, embedder, settings } = setup();
    const chat = await chatOf(host);
    const meaning = new Meaning(host);
    const reads: string[] = [];
    const read = host.store.read;
    host.store.read = async (path) => {
      reads.push(path);
      return read(path);
    };
    await meaning.search({ groups: [chat], queries: ["arrears"], settings });
    await meaning.settled();
    expect(embedder.stored.sort()).toEqual(chat.texts.map((t) => t.text).sort());

    reads.length = 0;
    const second = await meaning.search({ groups: [chat], queries: ["arrears"], settings });
    await meaning.settled();
    expect(second.matches[0]!.length).toBe(2);
    expect(embedder.stored).toHaveLength(12);
    // Its vectors are compared from memory: the store isn't read again.
    expect(reads).toEqual([]);

    // A restart: another `Meaning` over the same store reads the vectors there, and finds the same.
    const restarted = new Meaning(host);
    const third = await restarted.search({ groups: [chat], queries: ["arrears"], settings });
    await restarted.settled();
    expect(third).toEqual(second);
    expect(embedder.stored).toHaveLength(12);
    expect(reads.filter((path) => path.startsWith(VECTORS)).length).toBeGreaterThan(0);

    // The same text under another key of the chat (a message said again) has the vector there is.
    const owed = chat.texts.find((t) => t.text.includes("what's owed"))!;
    const again: MeaningGroup = { owner: chat.owner, texts: [...chat.texts, { ...owed, key: "said-again" }] };
    const fourth = await restarted.search({ groups: [again], queries: ["arrears"], settings });
    await restarted.settled();
    expect(embedder.stored).toHaveLength(12);
    const closeness = (key: string): number | undefined => fourth.matches[0]!.find((m) => m.key === key)?.similarity;
    expect(closeness("said-again")).toBeGreaterThan(settings.recall.meaning.floor);
    expect(closeness("said-again")).toBe(closeness(owed.key));
  });

  test("kept in the extension's storage through its own rule for a path, and read back from there after a restart", async () => {
    const { host, embedder, settings } = setup();
    // The model's id holds what a path can't: a `/` and a `.`.
    embedder.info = { id: "embed-1", name: "Embedder", model: "acme/embed.v2", dimensions: null };
    // The user's storage as the extension keeps it, reached through the extension's own reads and writes, with their rule for a document's path (the link's `DOC_PATH`).
    const files = new Map<string, string>();
    const storage = new Storage({
      storage: {
        read: async (path) => files.get(path) ?? null,
        write: async (path, text) => void files.set(path, text),
        remove: async (path) => void files.delete(path),
        stat: async (path) => (files.has(path) ? { bytes: files.get(path)?.length ?? 0, writtenAt: 0 } : null),
        list: async (dir) => [...files.keys()].filter((path) => path.startsWith(`${dir}/`)).map((path) => path.slice(dir.length + 1)),
      },
    });
    host.store.read = (path) => storage.doc("user-1", path);
    host.store.write = (path, value) => storage.putDoc("user-1", path, value);
    host.store.remove = (path) => storage.removeDoc("user-1", path);
    host.store.list = (prefix) => storage.docs("user-1", prefix);
    const chat = await chatOf(host);

    const first = new Meaning(host);
    await first.status({ lore: [], chat, settings, start: true });
    await first.settled();
    expect(warnings(host)).toEqual([]);
    const kept = [...files.keys()].filter((path) => path.startsWith("docs/recall/vectors/"));
    expect(kept.length).toBeGreaterThan(0);
    for (const path of kept) expect(path).toMatch(/^docs\/recall\/vectors\/embed-1\.acme_2fembed_2ev2\.own\/chat\/chat-1\/[0-9a-f]{2}\.json$/);
    expect(kept.every((path) => DOC_PATH.test(path.slice("docs/".length)))).toBe(true);
    // The name the vectors had before is one the rule refuses: no vector was ever kept under it.
    expect(DOC_PATH.test("recall/vectors/embed-1~acme%2Fembed%2Ev2~own/chat/chat-1/0a.json")).toBe(false);
    expect(embedder.stored).toHaveLength(12);

    // A restart: what was kept is read back, and nothing is embedded again.
    const restarted = new Meaning(host);
    expect(await restarted.status({ lore: [], chat, settings, start: true })).toMatchObject({ messages: { embedded: 12, total: 12 }, pending: 0 });
    expect((await restarted.search({ groups: [chat], queries: ["arrears"], settings })).matches[0]).toHaveLength(2);
    await restarted.settled();
    expect(embedder.stored).toHaveLength(12);
    expect(warnings(host)).toEqual([]);
  });

  test("under a name the storage takes however long the model's id is, and apart for two ids that differ only at their end", async () => {
    const { host, embedder, settings } = setup();
    const chat = await groupOf("chat", "chat-1", { m1: "Okoro keeps the second key." });
    const long = "a-very-long-model-name/".repeat(8);
    for (const end of ["one", "two"]) {
      embedder.info = { id: "embed-1", name: "Embedder", model: `${long}${end}`, dimensions: 1536 };
      const meaning = new Meaning(host);
      await meaning.status({ lore: [], chat, settings, start: true });
      await meaning.settled();
    }
    const kept = [...host.documents.keys()].filter((path) => path.startsWith("recall/vectors/"));
    const spaces = [...new Set(kept.map((path) => path.split("/")[2] ?? ""))];
    expect(spaces).toHaveLength(2);
    for (const space of spaces) {
      expect(space.length).toBe(128);
      expect(space).toMatch(/_h[0-9a-f]{16}$/);
    }
    expect(kept.every((path) => DOC_PATH.test(path))).toBe(true);
    expect(embedder.stored).toHaveLength(2);
  });

  test("where two keys share it, and where two owners wait for it at once", async () => {
    const { host, embedder, settings } = setup();
    const book = await groupOf("book", "book-notes", { first: "Okoro keeps the second key.", second: "Okoro keeps the second key." });
    const chat = await groupOf("chat", "chat-notes", { m1: "Okoro keeps the second key.", m2: "Ilse wants what is owed." });
    const meaning = new Meaning(host);
    await meaning.status({ lore: [book], chat, settings, start: true });
    await meaning.settled();
    expect(callsOf(embedder, "stored")).toEqual([["Okoro keeps the second key.", "Ilse wants what is owed."]]);
    expect(await meaning.status({ lore: [book], chat, settings })).toMatchObject({ lore: { embedded: 2, total: 2 }, messages: { embedded: 2, total: 2 }, pending: 0, today: { texts: 2 } });
    const found = await meaning.search({ groups: [book, chat], queries: ["latchkey"], settings });
    expect(found.matches[0]!.map((m) => m.key).sort()).toEqual(["first", "m1", "second"]);
  });

  test("and again once it changed, under its new hash", async () => {
    const { host, embedder, settings } = setup();
    const meaning = new Meaning(host);
    const before = await chatOf(host);
    await meaning.search({ groups: [before], queries: ["beacon"], settings });
    await meaning.settled();
    const opening = before.texts[0]!;
    expect((await meaning.search({ groups: [before], queries: ["beacon"], settings })).matches[0]!.map((m) => m.key)).not.toContain(opening.key);

    // The user edits the opening message: it is about a beacon now.
    host.edit(CHAT, opening.key, "I climb to the beacon at dusk.");
    const after = await chatOf(host);
    const edited = after.texts[0]!;
    expect(edited.key).toBe(opening.key);
    expect(edited.hash).not.toBe(opening.hash);
    // The new text has no vector yet, and the old text's vector isn't taken for it.
    expect((await meaning.search({ groups: [after], queries: ["beacon"], settings })).matches[0]!.map((m) => m.key)).not.toContain(opening.key);
    await meaning.settled();
    expect(embedder.stored).toHaveLength(13);
    expect(embedder.stored.at(-1)).toBe("I climb to the beacon at dusk.");
    expect((await meaning.search({ groups: [after], queries: ["beacon"], settings })).matches[0]![0]).toMatchObject({ key: opening.key });
    expect(Object.keys(vectorsAt(host, docOf("chat/chat-1", edited.hash)))).toContain(edited.hash);
    // The old text's vector is still there: shown again (a swipe back), it costs nothing.
    expect(Object.keys(vectorsAt(host, docOf("chat/chat-1", opening.hash)))).toContain(opening.hash);
    await meaning.search({ groups: [before], queries: ["beacon"], settings });
    await meaning.settled();
    expect(embedder.stored).toHaveLength(13);
  });

  test("never, where it is empty", async () => {
    const { host, embedder, settings } = setup();
    const chat = await groupOf("chat", "chat-gaps", { m1: "", m2: " \n\t", m3: "Okoro trims the lamp." });
    const meaning = new Meaning(host);
    expect(await meaning.status({ lore: [], chat, settings, start: true })).toMatchObject({ messages: { embedded: 0, total: 1 }, pending: 1 });
    await meaning.settled();
    expect(embedder.calls).toEqual([{ texts: ["Okoro trims the lamp."], kind: "stored" }]);
    expect(await meaning.status({ lore: [], chat, settings })).toMatchObject({ messages: { embedded: 1, total: 1 }, pending: 0 });
    expect((await meaning.search({ groups: [chat], queries: ["beacon", ""], settings })).matches).toEqual([[{ key: "m3", similarity: expect.any(Number) }], []]);
    expect(embedder.calls.flatMap((c) => c.texts).every((text) => text.trim() !== "")).toBe(true);
  });

  test("in batches of Settings' size, one call at a time", async () => {
    const { host, embedder, settings } = setup((s) => (s.recall.meaning.batch = 5));
    const chat = await chatOf(host);
    let open = 0;
    let most = 0;
    const embed = embedder.embed;
    embedder.embed = async (texts, kind) => {
      most = Math.max(most, ++open);
      await Promise.resolve();
      try {
        return await embed(texts, kind);
      } finally {
        open--;
      }
    };
    const meaning = new Meaning(host);
    // Nothing is embedded yet, so the search has nothing to compare its query with, and doesn't pay for embedding it.
    expect(await meaning.search({ groups: [chat], queries: ["arrears"], settings })).toEqual({ state: "on", matches: [[]] });
    await meaning.settled();
    expect(embedder.calls.map((c) => [c.kind, c.texts.length])).toEqual([
      ["stored", 5],
      ["stored", 5],
      ["stored", 2],
    ]);
    expect(embedder.stored).toEqual(inOrder(chat));
    expect(most).toBe(1);
  });
});

describe("vectors as stored", () => {
  test("are kept by the text's hash, as text, in small documents of their owner and their embedding space", async () => {
    const { host, settings } = setup();
    const lore = await loreOf(host);
    const chat = await chatOf(host);
    const meaning = new Meaning(host);
    await meaning.status({ lore, chat, settings, start: true });
    await meaning.settled();
    const paths = [...host.documents.keys()].filter((path) => path !== COUNT);
    expect(paths.length).toBeGreaterThan(0);
    for (const path of paths) expect(path).toMatch(/^recall\/vectors\/embed-1\.fake-embed\.own\/(chat\/chat-1|book\/book-coast|book\/book-people)\/[0-9a-f]{2}\.json$/);
    const owners: [string, MeaningGroup][] = [["chat/chat-1", chat], ...lore.map((group): [string, MeaningGroup] => [`book/${group.owner.id}`, group])];
    for (const [owner, group] of owners) {
      for (const text of group.texts) {
        const doc = host.documents.get(docOf(owner, text.hash)) as { v: number; dims: number; vectors: Record<string, string> };
        expect(doc).toMatchObject({ v: 1, dims: DIMS });
        // A byte a component, three bytes to four characters: not a list of numbers.
        expect(doc.vectors[text.hash]).toMatch(/^[A-Za-z0-9+/]+$/);
        expect(doc.vectors[text.hash]).toHaveLength(Math.ceil((DIMS * 4) / 3));
      }
    }
    // Each vector is in one document, and a document holds only the hashes that start as it is named.
    const kept = paths.flatMap((path) => Object.keys(vectorsAt(host, path)).map((hash) => [path.slice(-7, -5), hash.slice(0, 2)]));
    expect(kept).toHaveLength(18);
    expect(kept.every(([doc, start]) => doc === start)).toBe(true);
  });

  test("of two embedding models are kept apart: another model's are never compared, and the first one's are there when it is back", async () => {
    const { host, embedder, settings } = setup();
    const chat = await chatOf(host);
    const meaning = new Meaning(host);
    const search = async (): Promise<string[]> => {
      const found = await meaning.search({ groups: [chat], queries: ["arrears"], settings });
      await meaning.settled();
      return found.matches[0]!.map((m) => m.key);
    };
    await search();
    const first = await search();
    expect(first).toHaveLength(2);
    const docs = [...host.documents.keys()].filter((path) => path.startsWith(VECTORS));

    embedder.info = { id: "embed-1", name: "Embedder", model: "other/embed.v2", dimensions: 512 };
    // Nothing is embedded with the other model yet: nothing is compared, and the chat is embedded with it.
    expect(await search()).toEqual([]);
    expect(embedder.stored).toHaveLength(24);
    expect(await search()).toEqual(first);
    const others = [...host.documents.keys()].filter((path) => path.startsWith("recall/vectors/embed-1.other_2fembed_2ev2.512/chat/chat-1/"));
    expect(others).toHaveLength(docs.length);

    embedder.info = { id: "embed-1", name: "Embedder", model: "fake-embed", dimensions: null };
    expect(await search()).toEqual(first);
    expect(embedder.stored).toHaveLength(24);
  });

  test("of other dimensions than the embedder gives now are not compared: their texts are embedded again", async () => {
    const { host, embedder, settings } = setup();
    const chat = await chatOf(host);
    const before = new Meaning(host);
    await before.status({ lore: [], chat, settings, start: true });
    await before.settled();
    expect(embedder.stored).toHaveLength(12);
    // The model behind the same connection gives longer vectors now.
    const longer = new FakeEmbedder([...CONCEPTS, ["mill", "flour"]]);
    host.recall = { ...host.recall, embeddings: longer };
    const meaning = new Meaning(host);
    // Until the embedder has said what it gives, the vectors the store holds are taken for the chat's: asking how much is embedded embeds nothing.
    expect(await meaning.status({ lore: [], chat, settings, start: true })).toMatchObject({ messages: { embedded: 12, total: 12 }, pending: 0 });
    await meaning.settled();
    expect(longer.calls).toEqual([]);
    // A search's query comes back longer than they are: none is compared with it, and their texts are embedded again.
    expect((await meaning.search({ groups: [chat], queries: ["arrears"], settings })).matches).toEqual([[]]);
    await meaning.settled();
    expect(longer.stored.sort()).toEqual(chat.texts.map((t) => t.text).sort());
    expect((await meaning.search({ groups: [chat], queries: ["arrears"], settings })).matches[0]).toHaveLength(2);
    for (const text of chat.texts) expect(host.documents.get(docOf("chat/chat-1", text.hash))).toMatchObject({ dims: DIMS + 1 });
    // And a restart reads them as they are now.
    const restarted = new Meaning(host);
    expect((await restarted.search({ groups: [chat], queries: ["arrears"], settings })).matches[0]).toHaveLength(2);
    await restarted.settled();
    expect(longer.stored).toHaveLength(12);
  });

  test("that are damaged are skipped: what can't be read as a vector is embedded again, and the rest is kept", async () => {
    const { host, embedder, settings } = setup();
    const chat = await chatOf(host);
    const first = new Meaning(host);
    await first.status({ lore: [], chat, settings, start: true });
    await first.settled();
    expect(embedder.stored).toHaveLength(12);
    // Texts each alone in its document, so each kind of damage is one text's.
    const alone = chat.texts.filter((text) => chat.texts.filter((other) => other.hash.slice(0, 2) === text.hash.slice(0, 2)).length === 1);
    expect(alone.length).toBeGreaterThanOrEqual(6);
    const [replaced, short, strange, sized, moved, whole] = alone as [(typeof alone)[0], (typeof alone)[0], (typeof alone)[0], (typeof alone)[0], (typeof alone)[0], (typeof alone)[0]];
    const path = (text: { hash: string }): string => docOf("chat/chat-1", text.hash);
    const vector = (text: { hash: string }): string => vectorsAt(host, path(text))[text.hash]!;
    const good = vector(whole);
    // A document that isn't one; a vector cut short; one with a character of no alphabet; a document that says its vectors are longer; a vector under a hash of another document.
    host.documents.set(path(replaced), "these are no vectors");
    host.documents.set(path(short), { v: 1, dims: DIMS, vectors: { [short.hash]: vector(short).slice(0, -1) } });
    host.documents.set(path(strange), { v: 1, dims: DIMS, vectors: { [strange.hash]: `*${vector(strange).slice(1)}` } });
    host.documents.set(path(sized), { v: 1, dims: DIMS + 3, vectors: { [sized.hash]: vector(sized) } });
    host.documents.set(path(moved), { v: 1, dims: DIMS, vectors: { [whole.hash]: good, [moved.hash]: 7 } });
    const damaged = [replaced, short, strange, sized, moved];

    const second = new Meaning(host);
    expect(await second.status({ lore: [], chat, settings, start: true })).toMatchObject({ messages: { embedded: 7, total: 12 }, pending: 5 });
    await second.settled();
    expect(warnings(host)).toEqual([]);
    expect(embedder.stored.slice(12).sort()).toEqual(damaged.map((t) => t.text).sort());
    expect(await second.status({ lore: [], chat, settings })).toMatchObject({ messages: { embedded: 12, total: 12 }, pending: 0 });
    // Each damaged document was written whole again, and the one left alone still holds what it held.
    for (const text of damaged) {
      expect(host.documents.get(path(text))).toMatchObject({ v: 1, dims: DIMS });
      expect(Object.keys(vectorsAt(host, path(text)))).toEqual([text.hash]);
      expect(vector(text)).toMatch(/^[A-Za-z0-9+/]+$/);
    }
    expect(vector(whole)).toBe(good);
    const third = new Meaning(host);
    expect((await third.search({ groups: [chat], queries: ["arrears"], settings })).matches[0]).toHaveLength(2);
    await third.settled();
    expect(embedder.stored).toHaveLength(17);
  });

  test("of as many chats as Settings keep stay in memory: the chat unused longest is read from the store again", async () => {
    const { host, embedder, settings } = setup((s) => (s.recall.chat.kept = 2));
    for (const id of ["chat-a", "chat-b", "chat-c"]) {
      host.say(id, "user", `Mara asks after the ledger of ${id}.`);
      host.say(id, "assistant", `Joss keeps the accounts of ${id} in the coffer.`);
    }
    const reads: string[] = [];
    const read = host.store.read;
    host.store.read = async (path) => {
      if (path.startsWith(VECTORS)) reads.push(path.slice(VECTORS.length + 1).replace(/\/[0-9a-f]{2}\.json$/, ""));
      return read(path);
    };
    const meaning = new Meaning(host);
    /** Searches a chat, and gives the owners whose vectors were read from the store for it. */
    const search = async (id: string): Promise<string[]> => {
      reads.length = 0;
      await meaning.search({ groups: [await chatOf(host, id)], queries: ["register"], settings });
      await meaning.settled();
      return [...new Set(reads)];
    };
    await search("chat-a");
    await search("chat-b");
    // Both are held: a search of either reads nothing.
    expect(await search("chat-a")).toEqual([]);
    expect(await search("chat-b")).toEqual([]);
    // A third chat: the first, unused longest, is let go, and read again when it is next searched.
    expect(await search("chat-c")).toEqual(["chat/chat-c"]);
    expect(await search("chat-b")).toEqual([]);
    expect(await search("chat-a")).toEqual(["chat/chat-a"]);
    expect(await search("chat-c")).toEqual(["chat/chat-c"]);
    // Whatever was let go, nothing was embedded twice, and every search found its chat's two messages.
    expect(embedder.stored).toHaveLength(6);
    const found = await meaning.search({ groups: [await chatOf(host, "chat-b")], queries: ["register"], settings });
    expect(found.matches[0]).toHaveLength(2);
  });
});

describe("the daily cap", () => {
  test("holds: only what fits in a day's tokens is embedded, the rest once that day is past, and a restart counts the same", async () => {
    const { host, embedder, settings } = setup((s) => (s.recall.meaning.tokensPerDay = 100));
    const chat = await chatOf(host);
    const all = inOrder(chat);
    const sum = (texts: readonly string[]): number => texts.reduce((n, text) => n + tokensOf(text, settings), 0);
    /** The texts that fit in `room` tokens, taken in order: one too large waits, and a smaller one behind it goes. */
    const fitting = (texts: readonly string[], room: number): string[] =>
      texts.filter((text) => {
        if (tokensOf(text, settings) > room) return false;
        room -= tokensOf(text, settings);
        return true;
      });
    // The chat is more than two days' worth.
    expect(sum(all)).toBeGreaterThan(200);
    const start = async (meaning: Meaning) => {
      await meaning.status({ lore: [], chat, settings, start: true });
      await meaning.settled();
      return meaning.status({ lore: [], chat, settings });
    };

    const meaning = new Meaning(host);
    const first = fitting(all, 100);
    expect(first.length).toBeGreaterThan(0);
    const one = await start(meaning);
    expect(embedder.stored).toEqual(first);
    expect(one).toMatchObject({ messages: { embedded: first.length, total: 12 }, pending: 12 - first.length, working: false, today: { texts: first.length, tokens: sum(first), cost: null, cap: 100 }, all: { texts: first.length, tokens: sum(first), cost: null } });
    expect(one.today.tokens).toBeLessThanOrEqual(100);

    // Asked again the same day, nothing more is embedded.
    await start(meaning);
    expect(embedder.stored).toEqual(first);

    // A search's query is held to the same cap: one the day has no room for is not sent, and that search finds nothing by meaning.
    const long = "arrears ".repeat(50).trim();
    expect(tokensOf(long, settings)).toBeGreaterThan(100);
    expect(await meaning.search({ groups: [chat], queries: [long], settings })).toEqual({ state: "on", matches: [[]] });
    await meaning.settled();
    expect(callsOf(embedder, "query")).toEqual([]);
    expect(embedder.stored).toEqual(first);
    expect((await meaning.status({ lore: [], chat, settings })).today).toMatchObject({ texts: first.length, tokens: sum(first) });

    // A restart: the count is in the store, so the cap holds over it.
    expect(host.documents.get(COUNT)).toMatchObject({ v: 1, all: { texts: first.length, tokens: sum(first), queries: 0 }, hours: [{ at: 0, texts: first.length, queries: 0 }] });
    const restarted = new Meaning(host);
    expect(await start(restarted)).toMatchObject({ pending: 12 - first.length, today: { texts: first.length, tokens: sum(first) } });
    expect(embedder.stored).toEqual(first);

    // The count is kept by the hour, and an hour counts until the whole of it is a day past: an hour short of a day later nothing more is embedded...
    host.clock.advance(DAY - HOUR);
    await start(restarted);
    expect(embedder.stored).toEqual(first);
    // ...and past it, the next day's worth is.
    host.clock.advance(2 * HOUR);
    const second = fitting(
      all.filter((text) => !first.includes(text)),
      100,
    );
    expect(second.length).toBeGreaterThan(0);
    const two = await start(restarted);
    expect(embedder.stored).toEqual([...first, ...second]);
    expect(two).toMatchObject({ messages: { embedded: first.length + second.length }, today: { texts: second.length, tokens: sum(second) }, all: { texts: first.length + second.length, tokens: sum(first) + sum(second) } });
    expect(two.today.tokens).toBeLessThanOrEqual(100);

    // No cap: the rest is embedded at once.
    settings.recall.meaning.tokensPerDay = null;
    expect(await start(new Meaning(host))).toMatchObject({ messages: { embedded: 12, total: 12 }, pending: 0, today: { cap: null } });
    expect(embedder.stored.sort()).toEqual([...all].sort());
  });

  test("counts a search's queries too: one that fits is embedded and counted, one past the cap is not sent, and a restart counts the same", async () => {
    const { host, embedder, settings } = setup();
    const chat = await chatOf(host);
    const meaning = new Meaning(host);
    await meaning.status({ lore: [], chat, settings, start: true });
    await meaning.settled();
    const today = async (): Promise<number> => (await meaning.status({ lore: [], chat, settings })).today.tokens;
    const keysOf = (...words: string[]): string[] => words.map((said) => chat.texts.find((t) => t.text.includes(said))!.key).sort();
    const spent = await today();
    const [first, second, third] = ["who is in arrears", "the beacon on the point", "oars"] as const;
    const cost = (query: string): number => tokensOf(query, settings);
    expect(cost(third)).toBeLessThan(cost(second));
    // Room for the first query, and after it for the third but not for the second.
    settings.recall.meaning.tokensPerDay = spent + cost(first) + cost(second) - 1;

    expect((await meaning.search({ groups: [chat], queries: [first], settings })).matches[0]!.map((m) => m.key).sort()).toEqual(keysOf("what's owed", "Every debt"));
    expect(await today()).toBe(spent + cost(first));
    // Past the cap a query is not sent, and its search finds nothing by meaning; a smaller query of the same search still goes.
    const found = await meaning.search({ groups: [chat], queries: [second, third], settings });
    expect(found.state).toBe("on");
    expect(found.matches.map((list) => list.map((m) => m.key).sort())).toEqual([[], keysOf("row out to the lighthouse", "set the oars down")]);
    expect(callsOf(embedder, "query")).toEqual([[first], [third]]);
    expect(await today()).toBe(spent + cost(first) + cost(third));
    // A query asked before comes from memory and costs nothing: the cap doesn't hold it back.
    expect((await meaning.search({ groups: [chat], queries: [first, second], settings })).matches.map((list) => list.length)).toEqual([2, 0]);
    expect(callsOf(embedder, "query")).toHaveLength(2);

    // A restart: the count is in the store, so the cap holds a query over it.
    expect(host.documents.get(COUNT)).toMatchObject({ v: 1, all: { tokens: spent + cost(first) + cost(third), queries: 2 } });
    const restarted = new Meaning(host);
    expect(await restarted.search({ groups: [chat], queries: [second], settings })).toEqual({ state: "on", matches: [[]] });
    expect(callsOf(embedder, "query")).toHaveLength(2);
    // Once that day is past there is room again.
    host.clock.advance(DAY + HOUR);
    expect((await restarted.search({ groups: [chat], queries: [second], settings })).matches[0]!.map((m) => m.key).sort()).toEqual(keysOf("row out to the lighthouse", "trimming the lamp"));
    expect(callsOf(embedder, "query")).toEqual([[first], [third], [second]]);
  });
});

describe("without an embedder, or switched off", () => {
  test("a search says `none` or `off`, nothing is embedded, and the page is told as much", async () => {
    // No embeddings port: the host of a user's Lumiverse that has none.
    const plain = harbour();
    const settings = defaultSettings();
    on(settings);
    const chat = await chatOf(plain);
    const lore = await loreOf(plain);
    const tokens = [...lore, chat].flatMap((group) => group.texts).reduce((n, text) => n + tokensOf(text.text, settings), 0);
    const bare = new Meaning(plain);
    expect(await bare.search({ groups: [chat], queries: ["arrears", "beacon"], settings })).toEqual({ state: "none", matches: [[], []] });
    expect(await bare.status({ lore, chat, settings, start: true })).toEqual({
      connection: null,
      enabled: true,
      lore: { embedded: 0, total: 6 },
      messages: { embedded: 0, total: 12 },
      pending: 18,
      pendingTokens: tokens,
      working: false,
      today: { texts: 0, tokens: 0, cost: null, cap: 2_000_000 },
      all: { texts: 0, tokens: 0, cost: null },
    });
    await bare.settled();
    // No recall ports at all.
    delete plain.recall;
    expect(await new Meaning(plain).search({ groups: [chat], queries: ["arrears"], settings })).toEqual({ state: "none", matches: [[]] });
    expect([...plain.documents.keys()]).toEqual([]);

    // The port, and no connection set up.
    const { host, embedder } = setup();
    embedder.info = null;
    const meaning = new Meaning(host);
    expect(await meaning.search({ groups: [chat], queries: ["arrears"], settings })).toEqual({ state: "none", matches: [[]] });
    expect(await meaning.status({ lore, chat, settings, start: true })).toMatchObject({ connection: null, enabled: true, pending: 18, pendingTokens: tokens, working: false });
    await meaning.settled();
    expect(embedder.calls).toEqual([]);

    // A connection, and the setting off: the page still names the connection, and says how much switching it on would send.
    embedder.info = { id: "embed-1", name: "Embedder", model: "fake-embed", dimensions: null };
    const off = defaultSettings();
    expect(off.recall.meaning.enabled).toBe(false);
    expect(await meaning.search({ groups: [chat], queries: ["arrears"], settings: off })).toEqual({ state: "off", matches: [[]] });
    expect(await meaning.status({ lore, chat, settings: off, start: true })).toMatchObject({ connection: { id: "embed-1", name: "Embedder", model: "fake-embed", dimensions: null }, enabled: false, lore: { embedded: 0, total: 6 }, messages: { embedded: 0, total: 12 }, pending: 18, pendingTokens: tokens, working: false });
    await meaning.settled();
    expect(embedder.calls).toEqual([]);
    expect([...host.documents.keys()]).toEqual([]);
  });
});

describe("until the user switches it on", () => {
  test("nothing is embedded: not by a run's searches, not by the page told to start; and the page still says what switching it on would send", async () => {
    const host = harbour();
    const embedder = new FakeEmbedder(CONCEPTS);
    host.recall = { ...host.recall, embeddings: embedder };
    // Settings as a new user has them, an embedding connection and all (the review's probe P9).
    const settings = defaultSettings();
    expect(settings.recall.meaning.enabled).toBe(false);
    const rig = await toolRig(host, [...CHAT_TOOLS, ...LORE_TOOLS]);
    const answers = [await rig.run("chat_search", { queries: ["brass key"] }), await rig.run("lore_search", { queries: ["brass key"] })];
    await Recall.of(host).meaning.settled();
    expect(embedder.calls).toEqual([]);
    // Search is by word until the user chooses otherwise, so no answer has anything to say about it: not with a connection, and not without one.
    const plain = await toolRig(harbour(), [...CHAT_TOOLS, ...LORE_TOOLS]);
    answers.push(await plain.run("chat_search", { queries: ["brass key"] }), await plain.run("lore_search", { queries: ["brass key"] }));
    for (const answer of answers) {
      expect(answer.error).toBeUndefined();
      expect(answer.text).toContain("brass key");
      expect(answer.text).not.toContain("Search is by word");
    }

    const chat = await chatOf(host);
    const lore = await loreOf(host);
    const meaning = new Meaning(host);
    expect(await meaning.search({ groups: [chat], queries: ["arrears"], settings })).toEqual({ state: "off", matches: [[]] });
    // Told to start, the page embeds nothing either. It names the connection the texts would go to, and counts them: how many, and about how many tokens.
    expect(await meaning.status({ lore, chat, settings, start: true })).toEqual({
      connection: { id: "embed-1", name: "Embedder", model: "fake-embed", dimensions: null },
      enabled: false,
      lore: { embedded: 0, total: 6 },
      messages: { embedded: 0, total: 12 },
      pending: 18,
      pendingTokens: [...lore, chat].flatMap((group) => group.texts).reduce((n, text) => n + tokensOf(text.text, settings), 0),
      working: false,
      today: { texts: 0, tokens: 0, cost: null, cap: 2_000_000 },
      all: { texts: 0, tokens: 0, cost: null },
    });
    await meaning.settled();
    expect(embedder.calls).toEqual([]);
    expect([...host.documents.keys()].filter((path) => path.startsWith("recall/vectors") || path === COUNT)).toEqual([]);

    // A text two owners share is sent once, so its tokens are counted once.
    const book = await groupOf("book", "book-notes", { first: "Okoro keeps the second key.", second: "Okoro keeps the second key." });
    const notes = await groupOf("chat", "chat-notes", { m1: "Okoro keeps the second key.", m2: "Ilse wants what is owed.", m3: " " });
    expect(await meaning.status({ lore: [book], chat: notes, settings })).toMatchObject({ lore: { embedded: 0, total: 2 }, messages: { embedded: 0, total: 2 }, pending: 4, pendingTokens: tokensOf("Okoro keeps the second key.", settings) + tokensOf("Ilse wants what is owed.", settings) });
  });
});

describe("an embedder that fails", () => {
  test("is logged and never fails a search: its texts wait, and are embedded once it answers again", async () => {
    const { host, embedder, settings } = setup();
    const chat = await chatOf(host);
    const meaning = new Meaning(host);
    embedder.fail = "the embedder is down";
    expect(await meaning.search({ groups: [chat], queries: ["arrears"], settings })).toEqual({ state: "on", matches: [[]] });
    await meaning.settled();
    // One call failed, once: nothing tries again by itself.
    expect(embedder.calls).toHaveLength(1);
    expect(warnings(host)).toHaveLength(1);
    expect(warnings(host)[0]).toContain("the embedder is down");
    expect(await meaning.status({ lore: [], chat, settings })).toMatchObject({ messages: { embedded: 0, total: 12 }, pending: 12, working: false, today: { texts: 0, tokens: 0 } });

    // It answers again: the next search has them embedded, and the one after finds them.
    embedder.fail = null;
    await meaning.search({ groups: [chat], queries: ["arrears"], settings });
    await meaning.settled();
    expect(callsOf(embedder, "stored").map((texts) => texts.length)).toEqual([12, 12]);
    expect(await meaning.status({ lore: [], chat, settings })).toMatchObject({ messages: { embedded: 12, total: 12 }, pending: 0, today: { texts: 12 } });
    expect((await meaning.search({ groups: [chat], queries: ["arrears"], settings })).matches[0]).toHaveLength(2);

    // A query that can't be embedded: the search finds nothing by meaning this once, and the log says why.
    embedder.fail = "the embedder is busy";
    expect(await meaning.search({ groups: [chat], queries: ["beacon"], settings })).toEqual({ state: "on", matches: [[]] });
    expect(warnings(host)).toHaveLength(2);
    expect(warnings(host)[1]).toContain("the embedder is busy");
    embedder.fail = null;
    expect((await meaning.search({ groups: [chat], queries: ["beacon"], settings })).matches[0]).toHaveLength(2);
  });

  test("that answers with what isn't a vector for each text is a call that failed", async () => {
    const { host, embedder, settings } = setup();
    const chat = await chatOf(host);
    const meaning = new Meaning(host);
    const embed = embedder.embed;
    embedder.embed = async (texts, kind) => ({ ...(await embed(texts, kind)), vectors: [[1, 2, 3]] });
    await meaning.status({ lore: [], chat, settings, start: true });
    await meaning.settled();
    expect(warnings(host)).toHaveLength(1);
    expect(warnings(host)[0]).toContain("1 vectors for 12 texts");
    expect([...host.documents.keys()].filter((path) => path.startsWith(VECTORS))).toEqual([]);
    // The call answered, so it is counted as paid for.
    expect(await meaning.status({ lore: [], chat, settings })).toMatchObject({ messages: { embedded: 0 }, pending: 12, today: { texts: 12 } });
  });
});

describe("what the page is told", () => {
  test("how much is embedded before, while and after, and what it cost", async () => {
    const { host, embedder, settings } = setup((s) => {
      s.recall.meaning.batch = 6;
      s.recall.meaning.usdPerMillion = 2;
    });
    const lore = await loreOf(host);
    const chat = await chatOf(host);
    const meaning = new Meaning(host);
    const connection = { id: "embed-1", name: "Embedder", model: "fake-embed", dimensions: null };
    const sum = (groups: readonly MeaningGroup[]): number => groups.flatMap((g) => g.texts).reduce((n, t) => n + tokensOf(t.text, settings), 0);

    // Before: asking embeds nothing.
    expect(await meaning.status({ lore, chat, settings })).toEqual({
      connection,
      enabled: true,
      lore: { embedded: 0, total: 6 },
      messages: { embedded: 0, total: 12 },
      pending: 18,
      pendingTokens: sum([...lore, chat]),
      working: false,
      today: { texts: 0, tokens: 0, cost: 0, cap: 2_000_000 },
      all: { texts: 0, tokens: 0, cost: 0 },
    });
    await meaning.settled();
    expect(embedder.calls).toEqual([]);

    // While: the embedder answers its first call, and holds the second until the test lets it go.
    const second = Promise.withResolvers<void>();
    const gate = Promise.withResolvers<void>();
    const embed = embedder.embed;
    let entered = 0;
    embedder.embed = async (texts, kind) => {
      if (++entered > 1) {
        second.resolve();
        await gate.promise;
      }
      return embed(texts, kind);
    };
    // Starting doesn't wait for the embedding.
    expect(await meaning.status({ lore, chat, settings, start: true })).toMatchObject({ lore: { embedded: 0 }, messages: { embedded: 0 }, pending: 18, pendingTokens: sum([...lore, chat]), working: true });
    await second.promise;
    const lorePaid = (sum(lore) * 2) / 1_000_000;
    expect(await meaning.status({ lore, chat, settings })).toEqual({
      connection,
      enabled: true,
      lore: { embedded: 6, total: 6 },
      messages: { embedded: 0, total: 12 },
      pending: 12,
      pendingTokens: sum([chat]),
      working: true,
      today: { texts: 6, tokens: sum(lore), cost: lorePaid, cap: 2_000_000 },
      all: { texts: 6, tokens: sum(lore), cost: lorePaid },
    });

    // After.
    gate.resolve();
    await meaning.settled();
    const tokens = sum([...lore, chat]);
    const after = { connection, enabled: true, lore: { embedded: 6, total: 6 }, messages: { embedded: 12, total: 12 }, pending: 0, pendingTokens: 0, working: false, today: { texts: 18, tokens, cost: (tokens * 2) / 1_000_000, cap: 2_000_000 }, all: { texts: 18, tokens, cost: (tokens * 2) / 1_000_000 } };
    expect(await meaning.status({ lore, chat, settings })).toEqual(after);
    // A status about no chat's messages counts the lore alone; and a restart tells the same.
    expect(await meaning.status({ lore, chat: null, settings })).toMatchObject({ lore: { embedded: 6, total: 6 }, messages: { embedded: 0, total: 0 }, pending: 0 });
    expect(await new Meaning(host).status({ lore, chat, settings })).toEqual(after);
  });
});

describe("a branch", () => {
  test("takes the vectors of the chat it came from for the messages they share, and embeds only what is said after", async () => {
    const { host, embedder, settings } = setup();
    host.branch(CHAT, 8, "chat-2");
    // A branch of the branch, made before either was searched.
    host.branch("chat-2", 6, "chat-3");
    const meaning = new Meaning(host);
    const origin = await chatOf(host);
    await meaning.status({ lore: [], chat: origin, settings, start: true });
    await meaning.settled();
    expect(embedder.stored).toHaveLength(12);

    // The branch's messages are copies under ids of their own: the same texts, so the same hashes.
    const branch = await chatOf(host, "chat-2");
    expect(branch.texts.map((t) => t.hash)).toEqual(origin.texts.slice(0, 8).map((t) => t.hash));
    expect(branch.texts.map((t) => t.key)).not.toEqual(origin.texts.slice(0, 8).map((t) => t.key));

    // The branch of the branch first: the chat between has no vectors, so they come from the first chat through it.
    const third = await chatOf(host, "chat-3");
    expect(await meaning.status({ lore: [], chat: third, settings })).toMatchObject({ messages: { embedded: 6, total: 6 }, pending: 0 });

    // The branch's first search already finds by meaning, and nothing waits to be embedded.
    const found = await meaning.search({ groups: [branch], queries: ["arrears"], settings });
    await meaning.settled();
    expect(found.matches[0]!.map((m) => m.key)).toEqual([branch.texts.find((t) => t.text.includes("what's owed"))!.key]);
    expect(embedder.stored).toHaveLength(12);
    // The vectors are the branch's own now, in its own documents, the same as stored for the chat it came from.
    for (const [at, text] of branch.texts.entries()) expect(vectorsAt(host, docOf("chat/chat-2", text.hash))[text.hash]).toBe(vectorsAt(host, docOf("chat/chat-1", origin.texts[at]!.hash))[text.hash]!);

    // What the branch says after is its own, and is embedded.
    host.say("chat-2", "user", "I count what the keeper owes.");
    const longer = await chatOf(host, "chat-2");
    await meaning.search({ groups: [longer], queries: ["arrears"], settings });
    await meaning.settled();
    expect(embedder.stored).toHaveLength(13);
    expect(embedder.stored.at(-1)).toBe("I count what the keeper owes.");
    expect((await meaning.search({ groups: [longer], queries: ["arrears"], settings })).matches[0]).toHaveLength(2);

    // A restart reads the branch's own documents: the chat it came from can be gone.
    for (const path of [...host.documents.keys()]) if (path.startsWith(`${VECTORS}/chat/chat-1/`)) host.documents.delete(path);
    const restarted = new Meaning(host);
    expect(await restarted.status({ lore: [], chat: longer, settings, start: true })).toMatchObject({ messages: { embedded: 9, total: 9 }, pending: 0 });
    await restarted.settled();
    expect(embedder.stored).toHaveLength(13);
  });

  test("of a chat that isn't embedded yet is embedded itself", async () => {
    const { host, embedder, settings } = setup();
    host.branch(CHAT, 3, "chat-2");
    const branch = await chatOf(host, "chat-2");
    const meaning = new Meaning(host);
    await meaning.status({ lore: [], chat: branch, settings, start: true });
    await meaning.settled();
    expect(embedder.stored).toEqual(inOrder(branch));
    expect(warnings(host)).toEqual([]);
  });
});

describe("the loop that embeds", () => {
  test("stops once Settings switch search by meaning off, and goes on when they switch it on again", async () => {
    const { host, embedder, settings } = setup((s) => (s.recall.meaning.batch = 5));
    const chat = await chatOf(host);
    const meaning = new Meaning(host);
    // The embedder holds each call for stored texts until the test lets it go.
    const embed = embedder.embed;
    const held: (() => void)[] = [];
    let arrival = Promise.withResolvers<void>();
    embedder.embed = async (texts, kind) => {
      if (kind === "stored") {
        const gate = Promise.withResolvers<void>();
        held.push(gate.resolve);
        arrival.resolve();
        await gate.promise;
      }
      return embed(texts, kind);
    };
    /** Waits for a call to arrive, and gives what lets it go. */
    const next = async (): Promise<() => void> => {
      if (held.length === 0) await arrival.promise;
      arrival = Promise.withResolvers<void>();
      return held.shift()!;
    };

    await meaning.search({ groups: [chat], queries: ["arrears"], settings });
    const first = await next();
    // Switched off while the first batch of five is at the embedder: that batch is kept, and no other is asked for.
    const off = structuredClone(settings);
    off.recall.meaning.enabled = false;
    expect(await meaning.search({ groups: [chat], queries: ["arrears"], settings: off })).toEqual({ state: "off", matches: [[]] });
    first();
    await meaning.settled();
    expect(callsOf(embedder, "stored").map((texts) => texts.length)).toEqual([5]);
    expect(await meaning.status({ lore: [], chat, settings: off })).toMatchObject({ enabled: false, messages: { embedded: 5, total: 12 }, pending: 7, working: false });

    // On again: the next search has the other seven embedded.
    await meaning.search({ groups: [chat], queries: ["arrears"], settings });
    (await next())();
    (await next())();
    await meaning.settled();
    expect(callsOf(embedder, "stored").map((texts) => texts.length)).toEqual([5, 5, 2]);
    expect(await meaning.status({ lore: [], chat, settings })).toMatchObject({ messages: { embedded: 12, total: 12 }, pending: 0 });
  });
});

describe("an embedder that never answers", () => {
  /** A port that ends a call once the signal it was given ends, and one that ignores its signal: neither may hold anything past Settings' time for a call. */
  const PORTS: [string, boolean][] = [
    ["a port that ends the call when told", true],
    ["a port that ignores its signal", false],
  ];

  test.each(PORTS)("holds a search no longer than Settings' time for a call (%s): the search then has only what the words find", async (_port, listens) => {
    const { host, embedder, settings } = setup((s) => (s.recall.meaning.callMs = 4000));
    const chat = await chatOf(host);
    const meaning = new Meaning(host);
    await meaning.status({ lore: [], chat, settings, start: true });
    await meaning.settled();
    const spent = (await meaning.status({ lore: [], chat, settings })).today.tokens;

    const port = holding(host, embedder, listens, (kind) => kind === "query");
    let answered = false;
    const search = meaning.search({ groups: [chat], queries: ["arrears"], settings }).finally(() => (answered = true));
    await port.arrived(1);
    // Short of Settings' time the call is waited for.
    host.clock.advance(3999);
    await tick();
    expect([answered, port.held[0]!.signal?.aborted]).toEqual([false, false]);
    // At it the call is let go, whether or not the port listens: the port is told by its signal, and the search has nothing by meaning to add to its words.
    host.clock.advance(1);
    expect(await search).toEqual({ state: "on", matches: [[]] });
    expect(port.held[0]!.signal?.aborted).toBe(true);
    expect(warnings(host)).toEqual([expect.stringContaining("no answer in 4000 ms")]);
    // The call was sent all the same, and its provider may still answer it and charge: it counts against the day.
    expect((await meaning.status({ lore: [], chat, settings })).today.tokens).toBe(spent + tokensOf("arrears", settings));

    // A search its caller stops is let go at once, and isn't logged as one that failed.
    const stop = new AbortController();
    const stopped = meaning.search({ groups: [chat], queries: ["beacon"], settings, signal: stop.signal });
    await port.arrived(2);
    stop.abort(new Error("the round was stopped"));
    expect(await stopped).toEqual({ state: "on", matches: [[]] });
    expect(warnings(host)).toHaveLength(1);

    // The embedder answers again: the query is asked again, and finds.
    host.recall = { ...host.recall, embeddings: embedder };
    expect((await meaning.search({ groups: [chat], queries: ["arrears"], settings })).matches[0]).toHaveLength(2);
  });

  test.each(PORTS)("holds the loop no longer (%s): it goes on with the next batch, and the texts of the call it let go wait for the next ask", async (_port, listens) => {
    const { host, embedder, settings } = setup((s) => {
      s.recall.meaning.batch = 5;
      s.recall.meaning.callMs = 4000;
    });
    const chat = await chatOf(host);
    const all = inOrder(chat);
    const sum = (texts: readonly string[]): number => texts.reduce((n, text) => n + tokensOf(text, settings), 0);
    const meaning = new Meaning(host);
    // The first call for stored texts is never answered.
    const port = holding(host, embedder, listens, (kind, nth) => kind === "stored" && nth === 0);
    expect(await meaning.status({ lore: [], chat, settings, start: true })).toMatchObject({ working: true });
    await port.arrived(1);
    expect(port.held[0]!.texts).toEqual(all.slice(0, 5));
    host.clock.advance(3999);
    await tick();
    expect([embedder.calls.length, port.held[0]!.signal?.aborted]).toEqual([0, false]);

    host.clock.advance(1);
    await meaning.settled();
    expect(port.held[0]!.signal?.aborted).toBe(true);
    // The loop went on with the texts behind the ones it let go, and didn't send those again by itself.
    expect(callsOf(embedder, "stored")).toEqual([all.slice(5, 10), all.slice(10)]);
    expect(port.held).toHaveLength(1);
    expect(warnings(host)).toEqual([expect.stringContaining("no answer in 4000 ms")]);
    // They are not lost: they wait. The call let go counts against the day as one that was sent.
    expect(await meaning.status({ lore: [], chat, settings })).toMatchObject({ messages: { embedded: 7, total: 12 }, pending: 5, pendingTokens: sum(all.slice(0, 5)), working: false, today: { texts: 12, tokens: sum(all) } });

    // The next ask that starts the loop tries them again.
    await meaning.status({ lore: [], chat, settings, start: true });
    await meaning.settled();
    expect(callsOf(embedder, "stored")).toEqual([all.slice(5, 10), all.slice(10), all.slice(0, 5)]);
    expect(await meaning.status({ lore: [], chat, settings })).toMatchObject({ messages: { embedded: 12, total: 12 }, pending: 0, pendingTokens: 0 });
  });

  test("leaves chat_search what its words find", async () => {
    const { host, embedder } = setup();
    const rig = await toolRig(host, CHAT_TOOLS, {
      settings: (s) => {
        on(s);
        s.recall.meaning.callMs = 4000;
      },
    });
    // The run's first search has the chat embedded behind it.
    await rig.run("chat_search", { queries: ["brass key"] });
    await Recall.of(host).meaning.settled();
    const port = holding(host, embedder, false, (kind) => kind === "query");
    const waiting = rig.run("chat_search", { queries: ["brass key", "beacon"] });
    await port.arrived(1);
    host.clock.advance(4000);
    const byWord = await waiting;
    expect(byWord.error).toBeUndefined();
    expect(byWord.text).toContain("The brass key is heavy in my coat.");
    expect(byWord.text).not.toContain("by meaning");
    // The same search once the embedder answers: no message says "beacon", and two are about one.
    host.recall = { ...host.recall, embeddings: embedder };
    expect((await rig.run("chat_search", { queries: ["brass key", "beacon"] })).text).toContain("by meaning");
  });
});

describe("speed", () => {
  /** An embedder of made-up directions: a text always has the same vector, and two texts' vectors have nothing to do with each other. */
  function seeded(dims: number): EmbeddingsPort {
    const vector = (text: string): number[] => {
      let h = 2166136261;
      for (let at = 0; at < text.length; at++) h = Math.imul(h ^ text.charCodeAt(at), 16777619);
      const out = new Array<number>(dims);
      for (let at = 0; at < dims; at++) {
        h ^= h << 13;
        h ^= h >>> 17;
        h ^= h << 5;
        out[at] = h / 2147483648;
      }
      return out;
    };
    return { connection: async () => ({ id: "embed-2", name: "Seeded", model: "seeded", dimensions: dims }), embed: async (texts) => ({ vectors: texts.map(vector), model: "seeded", dimensions: dims }) };
  }

  test("5,000 texts of 256 dimensions are searched for 3 queries in under 250 ms from memory, and in under 1,000 ms from the store", async () => {
    const host = new RecallHost();
    host.recall = { ...host.recall, embeddings: seeded(256) };
    const settings = defaultSettings();
    on(settings);
    settings.recall.meaning.tokensPerDay = null;
    settings.recall.meaning.batch = 256;
    // Made-up directions are close to none: with no least similarity every query has thousands to sort and cut.
    settings.recall.meaning.floor = 0;
    const group = await groupOf("chat", "chat-long", Object.fromEntries(Array.from({ length: 5000 }, (_, at) => [`m${at}`, `Message ${at} of a long chat, as Mara told it.`])));
    const meaning = new Meaning(host);
    await meaning.status({ lore: [], chat: group, settings, start: true });
    await meaning.settled();
    expect((await meaning.status({ lore: [], chat: group, settings })).messages).toEqual({ embedded: 5000, total: 5000 });

    const queries = [group.texts[1234]!.text, group.texts[4321]!.text, "Something nobody said."];
    const timed = async (searcher: Meaning) => {
      const from = performance.now();
      const found = await searcher.search({ groups: [group], queries, settings });
      return { found, ms: performance.now() - from };
    };
    const warm = await timed(meaning);
    expect(warm.found.state).toBe("on");
    expect(warm.found.matches.map((list) => list.length)).toEqual([20, 20, 20]);
    // A query that is a message's own text finds that message first, as close as a stored byte tells.
    expect(warm.found.matches[0]![0]!.key).toBe("m1234");
    expect(warm.found.matches[0]![0]!.similarity).toBeGreaterThan(0.999);
    expect(warm.found.matches[1]![0]!.key).toBe("m4321");
    expect(warm.found.matches[2]![0]!.similarity).toBeLessThan(0.5);
    expect(warm.ms).toBeLessThan(250);

    // From the store: a restart reads the chat's 256 documents and its 5,000 vectors first.
    const cold = await timed(new Meaning(host));
    expect(cold.found).toEqual(warm.found);
    expect(cold.ms).toBeLessThan(1000);
  });
});
