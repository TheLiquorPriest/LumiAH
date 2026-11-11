// The Lore page's part of the stand-in backend (DESIGN §24.1 to §24.5): the story's two world books
// with an entry in every state for the last reply, the agents' own search over them (core's lexical
// index, a title and a key weighing what Settings say, with made-up matches by meaning merged in
// while search by meaning is on), and search by meaning as it stands, which follows the preview's
// settings and, once told to, embeds what waits over a few seconds. Live's made-up turns name these
// entries (fixtures.ts: `PROMPT_HELD`, `LORE_CHANGE`), so the ids, titles, sizes and states of the
// ones it names are the story's and stay as they are.

import { bestLines, heldTerms, LexicalIndex, queryTerms, tokenize } from "../../../src/core/lexical";
import { LORE_HEADS } from "../../../src/core/recall/lore";
import { valueAt } from "../../../src/extension/frontend/settings-model";
import type { EmbeddingStatus, LoreBookView, LoreHit, LoreRow, LoreSearch, LoreState, LoreView, LoreWhy } from "../../../src/shared/ui";
import { type Handlers, type MockCtx, Refusal } from "./ctx";

type Requests = "lah.lore.get" | "lah.lore.entry" | "lah.lore.search" | "lah.lore.embed";

/**
 * An entry of the made-up lore: what Lumiverse keeps of it, how it stood for the last reply (left
 * out: not in the prompt), and `also`, words that say the same as it in other words, which no part
 * of it holds. A match by meaning is made up from those: a real one comes from a model.
 */
interface Made {
  id: string;
  title: string;
  keys: string[];
  text: string;
  state?: LoreState;
  why?: LoreWhy;
  secondary?: string[];
  constant?: true;
  vectorized?: true;
  also?: string;
}

interface MadeBook {
  id: string;
  name: string;
  description: string;
  entries: readonly Made[];
}

/** A chat's lore in the story: its books, whether LumiAH has answered a reply in it (the states are that reply's), and how many messages it has, with how much of it had a vector when the preview opened. */
interface Story {
  books: readonly MadeBook[];
  answered: boolean;
  messages: number;
  embedded: { lore: number; messages: number };
}

/** An entry, its text a line a sentence or two. */
const made = (id: string, title: string, keys: string[], lines: string[], more: Partial<Omit<Made, "id" | "title" | "keys" | "text">> = {}): Made => ({ id, title, keys, text: lines.join("\n"), ...more });

// Only two entries say "night" or "key": the entry of that name and the harbour office. A search for
// the night key finds those two, as the agent's own does in the turn Live plays.
const HARBOUR: readonly Made[] = [
  made("lore-harbour-office", "The harbour office", ["harbour office", "harbourmaster's office"], ["A two-room brick building at the foot of the long pier. It shuts at six.", "Brann keeps the day key; Ilse has held the night key since the autumn storms.", "The ledgers stand in the back room, in a cabinet that sticks."], {
    state: "in_prompt",
    why: { by: "key", key: "harbour office" },
    vectorized: true,
    also: "bureau clerk customs house",
  }),
  made("lore-town-rules", "How the town speaks", [], ["People of the town speak plainly and use no titles.", "What is promised on the pier is always kept."], { state: "in_prompt", why: { by: "constant" }, constant: true, also: "manners etiquette custom oath vow" }),
  made("lore-night-key", "The night key", ["night key"], ["It opens the harbour office after six.", "Ilse keeps it on a cord under her coat and lends it to no one without a reason."], { state: "added", vectorized: true, also: "unlock door dark evening" }),
  made("lore-tide-tables", "Old tide tables", ["tide tables", "tides"], ["They hang by the door of the tavern.", "They are a year out of date, and Joss knows it."], { state: "off", also: "almanac chart schedule" }),
  made("lore-ledger", "The pilot's ledger", ["pilot's ledger", "pilots' book"], ["It records every ship brought in over the bar: its name, its draught, the pilot and the fee.", "It stands in the harbour office, in the back room cabinet.", "Okoro signs the last page he has read on the first of each month.", "One page is missing: the week before the autumn storms."], {
    vectorized: true,
    also: "logbook record register accounts arrivals",
  }),
  made("lore-long-pier", "The long pier", ["long pier", "pier head"], ["Three hundred paces of tarred planks from the harbour office out to the pier head, where the pilots wait.", "The planks are numbered, and the town gives directions by them.", "A promise made on the pier binds; one made on the shore can be argued."], { also: "jetty dock wharf quay" }),
  made("lore-tavern", "The tavern by the pier", ["tavern", "taproom"], ["A low taproom with one long counter, the last building before the long pier.", "Joss keeps it. It opens when the first boat is in and closes when Joss says so.", "Tabs are chalked on the beam over the counter, and a paid tab is wiped in front of whoever paid it."], {
    vectorized: true,
    also: "inn pub alehouse drink ale",
  }),
  made("lore-closing", "Closing hours", ["closing time", "closing hours"], ["The harbour office shuts at six, winter and summer.", "The tavern closes when Joss says so, and the fish market when the catch is gone.", "After six, harbour business waits for morning or goes through Ilse."], { also: "curfew locked late" }),
  made("lore-autumn-storms", "The autumn storms", ["autumn storms", "the gale"], ["Three days of gale at the turn of autumn, two months ago.", "The old lock of the harbour office was forced while they blew, and nobody saw by whom.", "Two boats were lost off the bar, and the harbour light was out for a week."], {
    vectorized: true,
    also: "weather tempest wind burglary theft",
  }),
  made("lore-harbour-light", "The harbour light", ["harbour light", "the light"], ["A lamp on an iron frame at the pier head, lit at dusk and put out at dawn.", "Whoever lights it writes the hour on the slate beneath.", "It was out for a week after the autumn storms, until new glass came down the river."], { also: "lighthouse beacon lantern" }),
  made("lore-the-bar", "The bar", ["sandbar", "harbour mouth"], ["A sandbar across the harbour mouth, covered at high water and bare at low.", "No ship crosses it without a pilot, and the fee is set by the ship's draught.", "The channel through it moves after every storm."], { also: "shoal reef shallows" }),
  made("lore-pilots", "The pilots", ["pilot"], ["Six pilots work the bar by turns from the pier head.", "Each signs the ledger for the ships brought in and is paid on the first of the month, after the audit.", "A pilot who loses a ship pays nothing and is never asked again."], {
    secondary: ["bar", "fee"],
    also: "navigator helmsman guide",
  }),
  made("lore-fish-market", "The fish market", ["fish market"], ["Held on the shore side of the long pier from first light until the catch is gone.", "Prices are called, never written.", "Brann buys there for the harbour office stove on cold mornings."], { also: "stall seller trade" }),
  made("lore-chandlery", "The chandlery", ["chandlery"], ["A shop of rope, tar, lamp oil and ship's biscuit, two doors up from the tavern.", "It sells on credit to boats of the town and for coin to everyone else.", "Ilse bought the cord she wears under her coat here."], { also: "store supplies goods" }),
  made("lore-upriver-road", "The upriver road", ["upriver road", "the road"], ["The only road out of the town follows the river inland for two days.", "Carts leave at dawn on market days.", "In winter it floods at the third mile, and the town is reached by water alone."], { also: "highway route journey travel" }),
  made("lore-flats", "The flats", ["flats", "mud flats"], ["Mud flats north of the harbour mouth, bare for a mile at low water.", "The tide comes in over them faster than a man walks.", "The cocklers work them by the turn of the tide, never by the old tide tables."], { also: "quicksand drown danger" }),
  made("lore-old-lock", "The old lock", ["old lock", "the lock"], ["The lock of the harbour office was forced during the autumn storms and changed the week after.", "The new one is opened by Brann from dawn until six, and after six by Ilse alone.", "The old lock lies in a drawer of the back room. Its scratches are fresh."], {
    vectorized: true,
    also: "burglary broken latch bolt",
  }),
];

const PEOPLE: readonly Made[] = [
  made("lore-joss", "Joss", ["tavern keeper", "landlord"], ["Joss keeps the tavern by the long pier.", "He never lies to Mara, though he leaves things out.", "He owes Brann a favour since the flood."], { state: "dropped", why: { by: "vector", score: 0.71 }, vectorized: true, also: "innkeeper barkeep barman publican" }),
  made("lore-okoro", "Okoro", ["Okoro", "audit"], ["Okoro audits the harbour's books on the first of each month.", "He wants the ledger's missing page found."], { also: "auditor inspector accountant official" }),
  made("lore-harbourmaster", "The harbourmaster's post", ["harbourmaster's post", "the post"], ["The post has stood empty since spring.", "Brann does the work without the title, and the town has not pressed the matter.", "Whoever is named to it answers for the ledgers and for the office after dark."], { also: "vacancy appointment authority" }),
  made("lore-senior-pilot", "The senior pilot", ["senior pilot"], ["The oldest of the six pilots, who sets the turns at the pier head.", "She brought the last ship in before the autumn storms and signed the ledger for it.", "She distrusts the audit and anyone who comes with it."], { also: "veteran captain elder" }),
  made("lore-lamplighter", "The lamplighter", ["lamplighter"], ["A boy of fourteen who lights the harbour light at dusk.", "He writes the hour on the slate and sees who walks the long pier after dark.", "He will say what he saw for a hot meal, and to Joss for nothing."], { also: "witness child lad" }),
  made("lore-chandler", "The chandler", ["chandler"], ["She runs the chandlery and tallies every length of cord and rope she sells.", "She remembers who asked about Ilse's cord after the storms.", "She gives credit to boats of the town and to no one else."], { also: "shopkeeper merchant trader" }),
  made("lore-market-women", "The market women", ["market women"], ["They sell the catch on the shore side of the long pier and call the prices.", "Nothing is said at the market that the whole town does not know by noon.", "They like Mara, who pays what is asked."], { also: "gossip rumour fishwives" }),
  made("lore-pier-watch", "The pier watch", ["pier watch", "watchmen"], ["Two men once walked the long pier from dusk to dawn.", "The watch was ended last year to save their wages.", "Since then nobody is paid to see who comes and goes after dark."], { also: "guard patrol sentry" }),
  made("lore-cocklers", "The cocklers", ["cocklers", "cockles"], ["A dozen families who rake the flats for cockles at low water.", "They read the tides better than any table and sell that knowledge dearly.", "They owe the tavern more than they will ever pay."], { also: "shellfish gatherers poor" }),
  made("lore-carter", "The carter", ["carter"], ["He drives the upriver road on market days and carries letters for a coin.", "He took a sealed packet inland the morning after the storms.", "He does not remember who gave it to him, or says he does not."], { also: "wagon courier messenger delivery" }),
  made("lore-ferryman", "The ferryman", ["ferryman", "ferry"], ["He rows people across the harbour mouth for a coin when the bar is covered.", "He counts heads both ways and remembers who did not come back.", "He drinks at the tavern on credit that Joss has stopped chalking up."], { also: "boatman oarsman crossing" }),
  made("lore-debts", "Who owes whom", ["debt", "debts"], ["Joss owes Brann a favour. Brann's tab at the tavern is paid: Mara paid it.", "The cocklers owe the tavern, and the tavern owes the chandlery for lamp oil.", "Okoro owes nobody in the town, which the town holds against him."], { also: "money loan payment obligation" }),
  made("lore-strangers", "Strangers in the town", ["stranger", "strangers"], ["A stranger is anyone not born within sound of the harbour bell.", "Strangers are served, sold to and watched.", "Mara has been in the town a month and is still one, though Joss has stopped saying so."], { also: "outsider foreigner newcomer" }),
  made("lore-brann", "Brann", ["Brann"], ["Brann has kept the harbour office by day for twenty years.", "He opens it at dawn, locks it at six and goes home with the tide.", "He vouches for few people, and Ilse opens the office after dark for no one else."], { state: "off", also: "warden doorman caretaker" }),
];

// The watch Brann keeps, in his own chat: LumiAH has answered no reply there yet, so no entry has a state for one.
const WATCH: readonly Made[] = [
  made("lore-watch-rules", "Rules of the watch", [], ["Brann notes who passes the door of the harbour office, and when.", "He writes nothing down that he would not say aloud.", "He is never away from the door at the turn of the tide."], { constant: true }),
  made("lore-watch-bench", "The bench by the door", ["bench"], ["An oak bench under the office window, worn pale at one end.", "From it the whole of the long pier can be seen, and half the tavern's door.", "Whoever sits at the dark end wants to watch and not be seen."]),
  made("lore-watch-dog", "The harbour dog", ["dog"], ["A grey dog that belongs to no one and sleeps under the bench.", "It barks at strangers and at the carter, and never at Ilse."], { state: "off" }),
];

/** The chats of the story that have lore. Every other chat has none, and so does every chat of a new install. */
const STORIES: Readonly<Record<string, Story>> = {
  "chat-mara": {
    books: [
      { id: "book-harbour", name: "The harbour town", description: "Places and customs of the town by the long pier.", entries: HARBOUR },
      { id: "book-people", name: "People of the pier", description: "Who is who, and what each wants.", entries: PEOPLE },
    ],
    answered: true,
    messages: 48,
    embedded: { lore: 22, messages: 31 },
  },
  "chat-brann": { books: [{ id: "book-watch", name: "Brann's watch", description: "What Brann keeps an eye on from the door of the harbour office.", entries: WATCH }], answered: false, messages: 1240, embedded: { lore: 0, messages: 610 } },
};

// What the embedding is made up to take: nothing here calls a model, so its pace and its sizes are invented, and none of them is a setting.
/** A batch of texts is embedded this long after the one before it, in ms. */
const BATCH_MS = 900;
/** What waits when the user asks is embedded in this many batches, so it is done in a few seconds however much waits. */
const BATCHES = 4;
/** What a text comes to, in tokens, when the day's and the whole count go up. */
const TEXT_TOKENS = 200;

/** An entry as the search reads it: its row, its text, and the words of its title and keys, of its text and of what says the same as it. */
interface Indexed {
  row: LoreRow;
  book: string;
  text: string;
  head: ReadonlySet<string>;
  body: ReadonlySet<string>;
  also: ReadonlySet<string>;
}

/** The id the tools print an entry under: the shortest start of its id, eight characters at least, that no other entry of the chat starts with (as core shortens a host's ids). */
function shortIds(ids: readonly string[]): Map<string, string> {
  const out = new Map<string, string>();
  for (const id of ids) {
    let length = Math.min(8, id.length);
    while (length < id.length && ids.some((other) => other !== id && other.startsWith(id.slice(0, length)))) length += 1;
    out.set(id, id.slice(0, length));
  }
  return out;
}

/** A chat's entries as the page lists them and the search reads them, in the books' order. The size in tokens is an estimate, as core's is: four characters to a token. */
function indexed(story: Story): Indexed[] {
  const all = story.books.flatMap((book) => book.entries.map((entry) => ({ book, entry })));
  const short = shortIds(all.map(({ entry }) => entry.id));
  return all.map(({ book, entry }) => {
    const state: LoreState = story.answered ? (entry.state ?? "not_in_prompt") : entry.state === "off" ? "off" : "not_in_prompt";
    const keys = [...entry.keys, ...(entry.secondary ?? [])];
    const row: LoreRow = { entryId: entry.id, short: short.get(entry.id) ?? entry.id, bookId: book.id, title: entry.title, keys: entry.keys, secondaryKeys: entry.secondary ?? [], chars: entry.text.length, tokens: Math.ceil(entry.text.length / 4), enabled: entry.state !== "off", constant: entry.constant === true, vectorized: entry.vectorized === true, state, ...(story.answered && entry.why ? { why: entry.why } : {}) };
    return { row, book: book.name, text: entry.text, head: new Set(tokenize(`${entry.title}\n${keys.join(", ")}`)), body: new Set(tokenize(entry.text)), also: new Set(tokenize(entry.also ?? "")) };
  });
}

/**
 * How alike a query and an entry are by meaning, from 0 to 1, made up: more the more of the query's
 * words the entry is said to mean (`also`), and more again where its title, keys or text hold the
 * others. Null where they are no match: the entry means none of the words (holding them is a match
 * by word, which the index finds), or the likeness is under the floor Settings give. So a search
 * brings a few matches by meaning, each one that words alone would have missed or ranked low.
 */
function similarityOf(entry: Indexed, terms: readonly string[], floor: number): number | null {
  const share = (held: (term: string) => boolean): number => terms.filter(held).length / terms.length;
  const means = share((t) => entry.also.has(t));
  if (terms.length === 0 || means === 0) return null;
  const head = share((t) => entry.head.has(t));
  const body = share((t) => entry.body.has(t) && !entry.head.has(t));
  const similarity = Math.round(Math.min(0.96, 0.32 + 0.5 * means + 0.3 * head + 0.2 * body) * 100) / 100;
  return similarity >= floor ? similarity : null;
}

export function loreMock(ctx: MockCtx): Handlers<Requests> {
  /** A setting of the preview's own, where its settings hold one (the sample settings hold none of these): else what a new user's would be. */
  const setting = <T extends number | boolean | null>(path: string[], otherwise: T, is: (value: unknown) => value is T): T => {
    const value: unknown = valueAt(ctx.state().settings.values, ["core", ...path]);
    return is(value) ? value : otherwise;
  };
  const isNumber = (value: unknown): value is number => typeof value === "number";
  const number = (path: string[], otherwise: number): number => setting(path, otherwise, isNumber);

  const stories = new Map<string, { story: Story; entries: Indexed[]; index: LexicalIndex<string> }>();
  /** A chat's lore, read and indexed the first time it is asked for; null for a chat that has none. */
  const loreOf = (chatId: string) => {
    const story = ctx.ready ? STORIES[chatId] : undefined;
    if (story === undefined) return null;
    let lore = stories.get(chatId);
    if (!lore) {
      const entries = indexed(story);
      // As core indexes lore: an entry's text under its id, with its title and its keys as heads.
      const index = new LexicalIndex<string>(number(["tools", "pieceChars"], 600), LORE_HEADS);
      for (const e of entries) index.add(e.row.entryId, e.text, [e.row.title, [...e.row.keys, ...e.row.secondaryKeys].join(", ")]);
      stories.set(chatId, (lore = { story, entries, index }));
    }
    return lore;
  };

  /** How much of each chat has a vector now, and whether its texts are being embedded. */
  const vectors = new Map<string, { lore: number; messages: number; working: boolean }>();
  const vectorsOf = (chatId: string) => {
    let held = vectors.get(chatId);
    if (!held) vectors.set(chatId, (held = { ...(loreOf(chatId)?.story.embedded ?? { lore: 0, messages: 0 }), working: false }));
    return held;
  };
  /** What embedding has come to: in the last 24 hours (both chats of the story were embedded in them), and since the count began. */
  const spent = ctx.ready ? { today: { texts: 663, tokens: 663 * TEXT_TOKENS }, all: { texts: 2480, tokens: 2480 * TEXT_TOKENS } } : { today: { texts: 0, tokens: 0 }, all: { texts: 0, tokens: 0 } };

  const status = (chatId: string): EmbeddingStatus => {
    const lore = loreOf(chatId);
    const held = vectorsOf(chatId);
    const total = { lore: lore?.entries.length ?? 0, messages: lore?.story.messages ?? 0 };
    const price = setting<number | null>(["recall", "meaning", "usdPerMillion"], null, (v): v is number | null => v === null || typeof v === "number");
    const cost = (tokens: number): number | null => (price === null ? null : (tokens * price) / 1_000_000);
    const pending = total.lore - held.lore + total.messages - held.messages;
    return {
      // A new install has no embedding connection in Lumiverse.
      connection: ctx.ready ? { id: "embed-local", name: "Local embeddings", model: "embed-small", dimensions: 768 } : null,
      // Off until the user switches it on, as the core's own default has it.
      enabled: setting(["recall", "meaning", "enabled"], false, (v): v is boolean => typeof v === "boolean"),
      lore: { embedded: held.lore, total: total.lore },
      messages: { embedded: held.messages, total: total.messages },
      pending,
      pendingTokens: pending * TEXT_TOKENS,
      working: held.working,
      today: { ...spent.today, cost: cost(spent.today.tokens), cap: setting<number | null>(["recall", "meaning", "tokensPerDay"], 2_000_000, (v): v is number | null => v === null || typeof v === "number") },
      all: { ...spent.all, cost: cost(spent.all.tokens) },
    };
  };

  /** Why nothing can be embedded now, in words that say what to do; null where it can. */
  const cannotEmbed = (now: EmbeddingStatus): string | null => {
    if (now.connection === null) return "Lumiverse has no embedding connection, so there is nothing to embed with. Set one in Lumiverse's settings, under Embeddings.";
    if (!now.enabled) return "Search by meaning is switched off, so nothing is embedded. Switch it on in Settings, under Lore and history.";
    if (now.today.cap !== null && now.today.tokens >= now.today.cap) return "Today's limit on embedding is reached. What waits is embedded as the last 24 hours make room, or raise the limit in Settings, under Lore and history.";
    return null;
  };

  /** Embeds a batch of what waits in a chat, its entries first, and goes on to the next until nothing waits or nothing can be embedded any more. */
  const embedBatch = (chatId: string, batch: number): void => {
    const held = vectorsOf(chatId);
    const now = status(chatId);
    if (cannotEmbed(now) !== null || now.pending === 0) {
      held.working = false;
      return;
    }
    const texts = Math.min(batch, now.pending);
    const entries = Math.min(texts, now.lore.total - held.lore);
    held.lore += entries;
    held.messages += texts - entries;
    for (const part of [spent.today, spent.all]) {
      part.texts += texts;
      part.tokens += texts * TEXT_TOKENS;
    }
    if (texts === now.pending) held.working = false;
    else ctx.later(() => embedBatch(chatId, batch), BATCH_MS);
  };

  const FIELDS: readonly LoreHit["fields"][number][] = ["title", "key", "text"];

  /** One query answered as the agents' `lore_search` answers it: the entries that hold its words, ranked by core's index, with those close in meaning merged in while search by meaning is on. */
  const answer = (chatId: string, query: string, limit: number, mode: LoreSearch["meaning"]): LoreSearch["queries"][number] => {
    const lore = loreOf(chatId);
    if (!lore) return { query, total: 0, hits: [] };
    const terms = queryTerms(query);
    const byWord = new Map(lore.index.search(query, { weights: [number(["recall", "lore", "titleWeight"], 4), number(["recall", "lore", "keyWeight"], 3)] }).map((hit) => [hit.key, hit.score]));
    const best = Math.max(0, ...byWord.values());
    const weight = mode === "on" ? number(["recall", "meaning", "weight"], 0.5) : 0;
    const floor = number(["recall", "meaning", "floor"], 0.3);
    // Only an entry that has a vector can match by meaning: the first so many of the chat's, as they were embedded in order.
    const embedded = vectorsOf(chatId).lore;
    const hits: LoreHit[] = [];
    lore.entries.forEach((entry, at) => {
      const word = byWord.get(entry.row.entryId) ?? 0;
      const similarity = mode === "on" && at < embedded ? similarityOf(entry, terms, floor) : null;
      if (word === 0 && similarity === null) return;
      const { row } = entry;
      const parts: Readonly<Record<LoreHit["fields"][number], string>> = { title: row.title, key: [...row.keys, ...row.secondaryKeys].join(", "), text: entry.text };
      hits.push({
        entryId: row.entryId,
        short: row.short,
        bookId: row.bookId,
        book: entry.book,
        title: row.title,
        chars: row.chars,
        state: row.state,
        constant: row.constant,
        // Half and half by default, as Settings weigh word against meaning: the best match by word counts as 1.
        score: (1 - weight) * (best > 0 ? word / best : 0) + weight * (similarity ?? 0),
        by: [...(word > 0 ? (["word"] as const) : []), ...(similarity !== null ? (["meaning"] as const) : [])],
        fields: word > 0 ? FIELDS.filter((field) => heldTerms(parts[field], terms).length > 0) : [],
        words: word > 0 ? heldTerms(`${parts.title}\n${parts.key}\n${parts.text}`, terms) : [],
        ...(similarity !== null ? { similarity } : {}),
        // Core's own choice of lines: those that hold the most of the query's words, else the entry's first.
        lines: bestLines(entry.text, word > 0 ? terms : [], number(["recall", "lore", "lines"], 2), number(["tools", "lineChars"], 300)),
      });
    });
    // Ties stay in the books' order: the sort is stable.
    hits.sort((a, b) => b.score - a.score);
    return { query, total: hits.length, hits: hits.slice(0, limit) };
  };

  return {
    "lah.lore.get": (r): LoreView => {
      const lore = loreOf(r.chatId);
      const books: LoreBookView[] = lore?.story.books.map((b) => ({ id: b.id, name: b.name, description: b.description, entries: b.entries.length })) ?? [];
      // The states are of the reply the story's finished turn wrote, three minutes before the preview opened.
      return { books, entries: lore?.entries.map((e) => ({ ...e.row })) ?? [], last: lore?.story.answered ? { generationId: "turn-0043", at: ctx.now() - 3 * 60_000 } : null, embedding: status(r.chatId) };
    },
    "lah.lore.entry": (r) => {
      const found = loreOf(r.chatId)?.entries.find((e) => e.row.entryId === r.entryId || e.row.short === r.entryId);
      if (!found) throw new Refusal("not_found", "This chat's books have no such entry: it may have been removed, or its book taken off the chat. Read the lore again.");
      return { entry: { ...found.row }, text: found.text };
    },
    "lah.lore.search": (r): LoreSearch => {
      const most = number(["recall", "lore", "queries"], 6);
      if (r.queries.length > most) throw new Refusal("invalid", `A search takes ${most} queries at once, and this one has ${r.queries.length}. Take some out, or raise "Queries per call" in Settings, under Lore and history.`);
      const now = status(r.chatId);
      const mode: LoreSearch["meaning"] = now.connection === null ? "none" : now.enabled ? "on" : "off";
      const limit = r.limit ?? number(["tools", "pageItems"], 10);
      return { queries: r.queries.map((query) => answer(r.chatId, query, limit, mode)), meaning: mode };
    },
    "lah.lore.embed": (r) => {
      if (r.start) {
        const now = status(r.chatId);
        const why = cannotEmbed(now);
        if (why !== null) throw new Refusal("unavailable", why);
        const held = vectorsOf(r.chatId);
        if (now.pending > 0 && !held.working) {
          held.working = true;
          ctx.later(() => embedBatch(r.chatId, Math.ceil(now.pending / BATCHES)), BATCH_MS);
        }
      }
      return { embedding: status(r.chatId) };
    },
  };
}
