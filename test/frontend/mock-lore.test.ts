// The stand-in backend's lore: the story's two books with an entry in every state, an entry whole,
// a search that ranks titles and keys over text and says where each word was found, matches by
// meaning while search by meaning is on, and embedding that follows the preview's settings.

import { describe, expect, test } from "bun:test";
import { type Handlers, type MockCtx, Refusal } from "../../dev/preview/mock/ctx";
import { loreMock } from "../../dev/preview/mock/lore";
import type { JsonObject, LoreSearch, LoreView, UiRequest, UiRequests, UiState } from "../../src/shared/ui";

type Requests = "lah.lore.get" | "lah.lore.entry" | "lah.lore.search" | "lah.lore.embed";

const T0 = Date.UTC(2026, 10, 10, 9, 0, 0);

interface Stand {
  /** Sends the part a request as it crosses, and answers what the part does. */
  call<K extends Requests>(type: K, body: UiRequests[K]["body"]): UiRequests[K]["result"] | Promise<UiRequests[K]["result"]>;
  /** Turns the clock on, running what falls due in order. */
  pass(ms: number): void;
}

/** The part on a context made by hand: settings that hold what a test gives them, and a clock the test turns. */
function stand(options: { ready?: boolean; values?: JsonObject } = {}): Stand {
  let now = T0;
  let timers: { at: number; fn: () => void }[] = [];
  const state = { rev: 0, settings: { values: options.values ?? {}, defaults: {}, schema: {} } } as unknown as UiState;
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
    state: () => state,
    push: () => {},
    blobs: { put: () => "", set: () => {}, get: () => undefined },
    play: () => null,
    stop: () => false,
    pause: () => false,
    settings: () => {},
    keep: () => "",
  };
  const mock: Handlers<Requests> = loreMock(ctx);
  return {
    call: (type, body) => mock[type]({ lah: 1, type, reqId: "r1", ...body } as Extract<UiRequest, { type: typeof type }>),
    pass(ms) {
      const until = now + ms;
      for (;;) {
        const due = timers.filter((t) => t.at <= until).sort((a, b) => a.at - b.at)[0];
        if (!due) break;
        timers = timers.filter((t) => t !== due);
        now = due.at;
        due.fn();
      }
      now = until;
    },
  };
}

const lore = async (s: Stand, chatId = "chat-mara"): Promise<LoreView> => s.call("lah.lore.get", { chatId });
const search = async (s: Stand, ...queries: string[]): Promise<LoreSearch> => s.call("lah.lore.search", { chatId: "chat-mara", queries });
const meaning = (enabled: boolean, more: JsonObject = {}): JsonObject => ({ core: { recall: { meaning: { enabled, ...more } } } });

/** The refusal a request gives; fails where it gives none. */
function refusal(run: () => unknown): Refusal {
  try {
    run();
  } catch (error) {
    if (error instanceof Refusal) return error;
    throw error;
  }
  throw new Error("The request was answered, where a refusal was expected.");
}

describe("the story's lore", () => {
  test("the open chat has two books and about thirty entries, in every state", async () => {
    const view = await lore(stand());
    expect(view.books.map((b) => [b.id, b.name, b.entries])).toEqual([
      ["book-harbour", "The harbour town", 17],
      ["book-people", "People of the pier", 14],
    ]);
    expect(view.entries.length).toBe(31);
    for (const book of view.books) expect(view.entries.filter((e) => e.bookId === book.id).length).toBe(book.entries);
    const count = (state: string): number => view.entries.filter((e) => e.state === state).length;
    expect([count("in_prompt"), count("added"), count("dropped"), count("not_in_prompt"), count("off")]).toEqual([2, 1, 1, 25, 2]);
    expect(view.last).toEqual({ generationId: "turn-0043", at: T0 - 3 * 60_000 });
    // The id the tools print an entry under names one entry.
    expect(new Set(view.entries.map((e) => e.short)).size).toBe(31);
  });

  test("the entries Live's turns name stand as those turns have them", async () => {
    const view = await lore(stand());
    const told = (id: string) => {
      const e = view.entries.find((x) => x.entryId === id);
      return e ? [e.title, e.state, e.why ?? null, e.chars, e.tokens] : null;
    };
    expect(told("lore-harbour-office")).toEqual(["The harbour office", "in_prompt", { by: "key", key: "harbour office" }, 212, 53]);
    expect(told("lore-town-rules")).toEqual(["How the town speaks", "in_prompt", { by: "constant" }, 96, 24]);
    expect(told("lore-night-key")).toEqual(["The night key", "added", null, 118, 30]);
    expect(told("lore-joss")).toEqual(["Joss", "dropped", { by: "vector", score: 0.71 }, 131, 33]);
    expect(told("lore-okoro")).toEqual(["Okoro", "not_in_prompt", null, 102, 26]);
    expect(told("lore-tide-tables")).toEqual(["Old tide tables", "off", null, 84, 21]);
    expect(view.entries.find((e) => e.entryId === "lore-okoro")?.keys).toEqual(["Okoro", "audit"]);
    // The turn's agent was refused an entry for Ilse: the books have none.
    expect(view.entries.some((e) => e.entryId === "lore-ilse")).toBe(false);
  });

  test("an entry is read whole, by its id or the id the tools print, with a text of several lines as long as its row says", async () => {
    const s = stand();
    const view = await lore(s);
    for (const listed of view.entries) {
      const { entry, text } = await s.call("lah.lore.entry", { chatId: "chat-mara", entryId: listed.entryId });
      expect(entry).toEqual(listed);
      expect(text.length).toBe(listed.chars);
      expect(text.split("\n").length).toBeGreaterThan(1);
    }
    const office = view.entries.find((e) => e.entryId === "lore-harbour-office");
    expect((await s.call("lah.lore.entry", { chatId: "chat-mara", entryId: office?.short ?? "" })).entry.entryId).toBe("lore-harbour-office");
    expect(refusal(() => s.call("lah.lore.entry", { chatId: "chat-mara", entryId: "lore-ilse" })).code).toBe("not_found");
  });

  test("a chat LumiAH has answered no reply in has entries that are only off or not in the prompt; another chat has no books", async () => {
    const s = stand();
    const brann = await lore(s, "chat-brann");
    expect(brann.books.map((b) => b.entries)).toEqual([3]);
    expect(brann.last).toBeNull();
    expect(brann.entries.map((e) => [e.state, e.why ?? null])).toEqual([
      ["not_in_prompt", null],
      ["not_in_prompt", null],
      ["off", null],
    ]);
    const ilse = await lore(s, "chat-ilse");
    expect([ilse.books, ilse.entries, ilse.last]).toEqual([[], [], null]);
  });

  test("a new install has no lore and no embedding connection", async () => {
    const s = stand({ ready: false });
    const view = await lore(s);
    expect([view.books.length, view.entries.length, view.embedding.connection, view.embedding.pending]).toEqual([0, 0, null, 0]);
    expect((await search(s, "night key")).meaning).toBe("none");
    expect(refusal(() => s.call("lah.lore.embed", { chatId: "chat-mara", start: true }))).toMatchObject({ code: "unavailable" });
  });
});

describe("the search", () => {
  test("a title and a key weigh more than the text, and each hit says where its words were found", async () => {
    const found = await search(stand(), "night key");
    const [answer] = found.queries;
    // What the agent's own search for the night key finds in the turn Live plays: the entry of that name, then the one that mentions it.
    expect(answer?.hits.map((h) => [h.entryId, h.book, h.state, h.by, h.fields, h.words])).toEqual([
      ["lore-night-key", "The harbour town", "added", ["word"], ["title", "key"], ["night", "key"]],
      ["lore-harbour-office", "The harbour town", "in_prompt", ["word"], ["text"], ["night", "key"]],
    ]);
    expect(answer?.total).toBe(2);
    expect(answer?.hits[1]?.lines).toEqual([{ line: 2, text: "Brann keeps the day key; Ilse has held the night key since the autumn storms." }]);
    expect((answer?.hits[0]?.score ?? 0) > (answer?.hits[1]?.score ?? 0)).toBe(true);
  });

  test("several queries are each answered, in order, best first and no more than the limit", async () => {
    const s = stand();
    const found = await s.call("lah.lore.search", { chatId: "chat-mara", queries: ["harbour", "who signed the ledger", "zeppelin"], limit: 3 });
    expect(found.queries.map((q) => [q.query, q.hits.length, q.total > q.hits.length])).toEqual([
      ["harbour", 3, true],
      ["who signed the ledger", 3, true],
      ["zeppelin", 0, false],
    ]);
    expect(found.queries[1]?.hits[0]?.entryId).toBe("lore-ledger");
    for (const q of found.queries) expect(q.hits.map((h) => h.score)).toEqual([...q.hits.map((h) => h.score)].sort((a, b) => b - a));
    // Left out, the limit is the settings' page of hits.
    expect((await search(s, "harbour")).queries[0]?.hits.length).toBe(10);
  });

  test("a word no entry holds can still find one by meaning, with how alike it is and where the entry starts", async () => {
    const found = await search(stand({ values: meaning(true) }), "innkeeper");
    expect(found.meaning).toBe("on");
    expect(found.queries[0]?.hits.map((h) => [h.entryId, h.by, h.fields, h.words, h.similarity, h.lines])).toEqual([["lore-joss", ["meaning"], [], [], 0.82, [{ line: 1, text: "Joss keeps the tavern by the long pier." }]]]);
    // A hit can match both ways.
    const both = (await search(stand({ values: meaning(true) }), "who can unlock the office after dark")).queries[0]?.hits.find((h) => h.entryId === "lore-night-key");
    expect(both?.by).toEqual(["word", "meaning"]);
    expect(both?.similarity).toBeGreaterThan(0.3);
  });

  test("until it is switched on, and switched off again in the settings, search is by word and says so", async () => {
    expect((await search(stand(), "innkeeper")).meaning).toBe("off");
    const found = await search(stand({ values: meaning(false) }), "innkeeper", "night key");
    expect(found.meaning).toBe("off");
    expect(found.queries.map((q) => q.hits.map((h) => h.by))).toEqual([[], [["word"], ["word"]]]);
  });

  test("more queries than the settings allow in one search are refused in words that say what to do", () => {
    const s = stand();
    const error = refusal(() => s.call("lah.lore.search", { chatId: "chat-mara", queries: ["a1", "b2", "c3", "d4", "e5", "f6", "g7"] }));
    expect(error.code).toBe("invalid");
    expect(error.message).toContain("takes 6 queries at once");
  });
});

describe("search by meaning", () => {
  test("it stands as the settings have it: off until switched on, with what waits and what that comes to, their limit, and no cost until a price is set", async () => {
    const plain = (await lore(stand())).embedding;
    expect([plain.enabled, plain.lore, plain.messages, plain.pending, plain.working]).toEqual([false, { embedded: 22, total: 31 }, { embedded: 31, total: 48 }, 26, false]);
    // What waits is counted while the switch is off too: it is what switching it on would send.
    expect(plain.pendingTokens).toBe(26 * 200);
    expect([plain.today.cap, plain.today.cost, plain.all.cost]).toEqual([2_000_000, null, null]);
    expect((await lore(stand({ values: meaning(true) }))).embedding.enabled).toBe(true);
    const set = (await lore(stand({ values: meaning(false, { tokensPerDay: null, usdPerMillion: 0.02 }) }))).embedding;
    expect([set.enabled, set.today.cap]).toEqual([false, null]);
    expect(set.all.cost).toBeCloseTo((set.all.tokens * 0.02) / 1_000_000, 10);
  });

  test("told to, it embeds what waits over a few seconds, and what it has come to goes up", async () => {
    const s = stand({ values: meaning(true) });
    const before = (await lore(s)).embedding;
    const started = (await s.call("lah.lore.embed", { chatId: "chat-mara", start: true })).embedding;
    expect([started.working, started.pending]).toEqual([true, 26]);
    s.pass(1000);
    const during = (await s.call("lah.lore.embed", { chatId: "chat-mara", start: false })).embedding;
    expect(during.working).toBe(true);
    expect(during.pending).toBeLessThan(26);
    s.pass(10_000);
    const after = (await s.call("lah.lore.embed", { chatId: "chat-mara", start: false })).embedding;
    expect([after.working, after.pending, after.lore.embedded, after.messages.embedded]).toEqual([false, 0, 31, 48]);
    expect(after.today.texts - before.today.texts).toBe(26);
    expect(after.all.tokens).toBeGreaterThan(before.all.tokens);
    // With every entry embedded, one that waited can be found by meaning.
    expect((await search(s, "caretaker")).queries[0]?.hits.map((h) => [h.entryId, h.by])).toEqual([["lore-brann", ["meaning"]]]);
  });

  test("it can't be told to embed until it is switched on, or past the day's limit", () => {
    expect(refusal(() => stand().call("lah.lore.embed", { chatId: "chat-mara", start: true })).message).toContain("switched off");
    expect(refusal(() => stand({ values: meaning(false) }).call("lah.lore.embed", { chatId: "chat-mara", start: true })).message).toContain("switched off");
    expect(refusal(() => stand({ values: meaning(true, { tokensPerDay: 1000 }) }).call("lah.lore.embed", { chatId: "chat-mara", start: true })).message).toContain("limit");
  });
});
