// The settings of lore and history (DESIGN §24): `Settings.recall`. Every limit §24 keeps and every
// switch it has, each with its default, and their part of the settings' JSON Schema, in the keywords
// the Settings page builds its forms from (`settings.ts` says how a schema is read).
//
// This file imports types only, so `settings.ts` can gather it without a cycle.

import type { JsonObject } from "../ports";
import { type Limit, TIMER_MAX_MS } from "../util";
import { EMBED_BATCH_MAX, EMBED_TEXT_MAX } from "./ports";

export interface RecallSettings {
  /** What the main agent is told of the prompt each turn, in the request itself (§24.1). */
  prompt: {
    /** Tell it which lore entries the prompt holds, and how each got there. */
    lore: boolean;
    /** That list at most, in characters; entries past it are counted. */
    loreChars: number;
    /** Tell it which entries of the chat's books the prompt doesn't hold. */
    index: boolean;
    /** That index at most, in characters; entries past it are counted. */
    indexChars: number;
    /** The index lists entries the user switched off too. */
    indexOff: boolean;
    /** The index is ordered by how well each entry matches this many of the chat's latest messages. */
    recent: number;
    /** Tell it which chat messages the prompt holds word for word, and what stands in for the rest. */
    history: boolean;
    /** That note at most, in characters. */
    historyChars: number;
  };
  lore: {
    /** How much a query's word counts in an entry's title, against 1 in its text. */
    titleWeight: number;
    /** How much it counts among an entry's keys. */
    keyWeight: number;
    /** The best lines a search shows of each hit. */
    lines: number;
    /** The queries one `lore_search` call may carry. */
    queries: number;
    /** The entries one `lore_read` call may name. */
    reads: number;
    /** The entries `lore_related` and `lore_about` list each way. */
    links: number;
  };
  /** The lore the writer sees (§24.3). */
  writer: {
    /** The main agent may add entries to the writer's request. */
    add: boolean;
    /** It may take entries out of it. */
    drop: boolean;
    /** The entries one reply may add. */
    addEntries: number;
    /** Their text together at most, in characters. */
    addChars: number;
  };
  chat: {
    /** The queries one `chat_search` call may carry. */
    queries: number;
    /** Hits no further apart than this many messages make one stretch. */
    stretchGap: number;
    /** The hits a search shows of one stretch; the rest are counted. */
    stretchHits: number;
    /** The best lines a search shows of each hit. */
    lines: number;
    /** The messages `chat_around` shows each side of the one asked for, when the call names none. */
    around: number;
    /** The most telling lines `chat_about` shows. */
    trail: number;
    /** A gap this long between two messages breaks the outline's skeleton there, in minutes. */
    gapMinutes: number;
    /** The messages one stretch of the skeleton holds at most. */
    stretchMessages: number;
    /** How much of a stretch's opening the skeleton shows, in characters. */
    openingChars: number;
    /** The chats whose index is kept in memory between turns. */
    kept: number;
  };
  /** A search for a text or a pattern, line by line (`chat_grep`, `lore_grep`). */
  grep: {
    /** A pattern is matched against this much of a line at once, in characters: a longer line is matched a piece at a time. */
    pieceChars: number;
    /** How long one such search may take before it stops and says so, in milliseconds. */
    ms: number;
    /** How long it works at a time before it gives way to whatever else waits (a Stop, a timer), in milliseconds. */
    sliceMs: number;
  };
  /** Search by meaning (§24.5). */
  meaning: {
    /** Keep a vector for each lore entry and each chat message, where the user has an embedding connection. Off until the user switches it on: it sends the chat's and the lore's text to their embedding provider. */
    enabled: boolean;
    /** How long one embedding call may take before it is let go, in milliseconds: a search then goes on by word. */
    callMs: number;
    /** The tokens embedded in any 24 hours at most, as estimated; null: no cap. */
    tokensPerDay: Limit;
    /** The texts one embedding call carries. */
    batch: number;
    /** How much of a text is embedded, in characters. */
    textChars: number;
    /** How much a match by meaning counts beside a match by word, from 0 (not at all) to 1 (alone). */
    weight: number;
    /** A text counts as a match by meaning from this similarity up, from 0 to 1. */
    floor: number;
    /** The matches by meaning one query brings to a search. */
    matches: number;
    /** What the embedding model costs, in US dollars per million tokens; null: unknown, and no cost is shown. */
    usdPerMillion: number | null;
  };
  /** The chronicle (§24.7). */
  chronicle: {
    /** Pin the top of the chronicle into the main agent's context each turn. */
    pin: boolean;
    /** The pinned part at most, in characters. */
    pinChars: number;
    /** The pinned part ends with a line that says whether the chronicle wants bringing up to date, and how to start the chronicler for it with the reply. */
    remind: boolean;
    /** How many messages the chat may be past the chronicle before the main agent is told to have it brought up to date. */
    tail: number;
    /** The stretch of the chat one reader is given (§24.7), in messages at most. */
    stretchMessages: number;
    /** The same in characters at most. */
    stretchChars: number;
    /** What learning a story is reckoned to take (`StoryStatus.estimate`): the prompt tokens sent for each token of chat still to read. */
    estimateSent: number;
    /** The tokens written for each token of chat still to read. */
    estimateWritten: number;
    /** The rounds of tool calls each stretch takes. */
    estimateRounds: number;
  };
  memory: {
    /** What `memory_search` asks the Cortex for at most. */
    hits: number;
    /** The facts `memory_entity` shows of an entity. */
    facts: number;
    /** The relations it shows. */
    relations: number;
    /** The entities it names when the one asked for isn't known. */
    entities: number;
  };
  databanks: {
    /** The characters of the chat's databank documents read in for `databank_search` at most. */
    indexChars: number;
  };
  web: {
    /** The results `web_search` asks for. */
    results: number;
    /** It reads the pages too, where the call doesn't say. */
    pages: boolean;
    /** How much of each page's text it shows, in characters. */
    pageChars: number;
  };
}

/** A new user's settings for lore and history. */
export function defaultRecallSettings(): RecallSettings {
  return {
    // Three short notes: together they cost about what one lookup call would, and save it on most turns.
    prompt: { lore: true, loreChars: 2400, index: true, indexChars: 3000, indexOff: false, recent: 6, history: true, historyChars: 900 },
    // A title names what an entry is about and a key is what its author chose to find it by: both say more than a word in passing.
    lore: { titleWeight: 4, keyWeight: 3, lines: 2, queries: 6, reads: 8, links: 12 },
    // Enough to bring a scene's people and its place; not a second world-info budget.
    writer: { add: true, drop: true, addEntries: 8, addChars: 12_000 },
    // A stretch is an exchange and what follows from it; four hours without a message is another sitting.
    chat: { queries: 6, stretchGap: 6, stretchHits: 2, lines: 2, around: 3, trail: 8, gapMinutes: 240, stretchMessages: 40, openingChars: 160, kept: 4 },
    // A paragraph of a chat is seldom longer than a piece, and one piece is matched in a few milliseconds as a rule, a tenth of a second at the very worst a pattern may be; two seconds find a line in a chat of many thousands of messages; a fiftieth of a second is how long a search works before it lets a Stop in.
    grep: { pieceChars: 2000, ms: 2000, sliceMs: 20 },
    // Off: nothing leaves for an embedding provider until the user chooses. A long chat's first embedding fits one day; half a minute is longer than an embedding call takes; half and half between word and meaning, since each finds what the other misses.
    meaning: { enabled: false, callMs: 30_000, tokensPerDay: 2_000_000, batch: 64, textChars: 6000, weight: 0.5, floor: 0.3, matches: 20, usdPerMillion: null },
    // Twenty messages is an evening's play: under it a job would mostly re-read what the prompt still holds. A reader's stretch is a few pages of the chat: small enough that no reader carries much of it from call to call, large enough that a long story doesn't take hundreds of readers. A reader sends its stretch about twice (each call carries what it has read so far) and the chronicler carries the lines the readers returned in every later call: about four tokens sent for each token of chat, a quarter of one written, and four rounds a stretch (a reader's two or three, and the chronicler's share of handing out and merging).
    chronicle: { pin: true, pinChars: 3000, remind: true, tail: 20, stretchMessages: 60, stretchChars: 36_000, estimateSent: 4, estimateWritten: 0.25, estimateRounds: 4 },
    memory: { hits: 8, facts: 20, relations: 12, entities: 30 },
    databanks: { indexChars: 2_000_000 },
    web: { results: 5, pages: false, pageChars: 3000 },
  };
}

// A setting's own bounds below are fixed values that can't be settings: each keeps a setting from
// breaking what it sets (a note of no characters, a search of no query), as in `settings.ts`.
const whole = (title: string, description: string, minimum: number, unit?: string, maximum?: number): JsonObject => ({ title, description, type: "integer", minimum, ...(maximum !== undefined ? { maximum } : {}), ...(unit !== undefined ? { "x-unit": unit } : {}) });
const amount = (title: string, description: string, minimum: number, maximum: number): JsonObject => ({ title, description, type: "number", minimum, maximum });
const flag = (title: string, description: string): JsonObject => ({ title, description, type: "boolean" });

/** `Settings.recall`'s part of the settings' JSON Schema. */
export const RECALL_SETTINGS_SCHEMA: JsonObject = {
  title: "Lore and history",
  description: "What the agents are told of the lore and the chat without asking, how their lore and chat tools search and answer, the lore the writer sees, search by meaning, and the chronicle.",
  type: "object",
  properties: {
    prompt: {
      title: "What the prompt already holds",
      description: "Three notes the main agent is given with each request, so most turns need no lookup to know what exists. Each note's wording is a text of its own.",
      type: "object",
      properties: {
        lore: flag("Lore in the prompt", "Tell the main agent which lore entries the prompt holds, and how each got there."),
        loreChars: whole("Lore in the prompt: length", "That list at most. Entries past it are counted.", 200, "characters"),
        index: flag("Lore not in the prompt", "Tell it which entries of the chat's books the prompt doesn't hold: id, title, keys and length, the best match for the latest messages first."),
        indexChars: whole("Lore not in the prompt: length", "That index at most. Entries past it are counted; lore_index lists them all.", 200, "characters"),
        indexOff: flag("List entries switched off", "The index lists the entries you switched off in their books too."),
        recent: whole("Latest messages it is ordered by", "The index is ordered by how well each entry matches this many of the chat's latest messages.", 1, "messages"),
        history: flag("History in the prompt", "Tell it which chat messages the prompt holds word for word, which it doesn't, and what stands in for those."),
        historyChars: whole("History in the prompt: length", "That note at most.", 200, "characters"),
      },
    },
    lore: {
      title: "Lore tools",
      type: "object",
      properties: {
        titleWeight: amount("Weight of a title", "How much a query's word counts in an entry's title, against 1 in its text.", 0, 100),
        keyWeight: amount("Weight of a key", "How much a query's word counts among an entry's keys, against 1 in its text.", 0, 100),
        lines: whole("Best lines per hit", "The lines a lore search shows of each entry it found.", 1, "lines"),
        queries: whole("Queries per call", "The queries one lore_search call may carry.", 1, "queries"),
        reads: whole("Entries per read", "The entries one lore_read call may name.", 1, "entries"),
        links: whole("Linked entries listed", "The entries lore_related and lore_about list each way.", 1, "entries"),
      },
    },
    writer: {
      title: "The lore the writer sees",
      description: "With write_reply the main agent may add lore entries to the writer's request and take entries out of it, each whole and by its id.",
      type: "object",
      properties: {
        add: flag("Add entries", "The main agent may add entries to the writer's request."),
        drop: flag("Drop entries", "The main agent may take entries Lumiverse activated out of the writer's request."),
        addEntries: whole("Entries added per reply", "The most entries one reply may add.", 0, "entries"),
        addChars: whole("Text added per reply", "The most text the added entries may hold together.", 0, "characters"),
      },
    },
    chat: {
      title: "History tools",
      type: "object",
      properties: {
        queries: whole("Queries per call", "The queries one chat_search call may carry.", 1, "queries"),
        stretchGap: whole("A stretch", "Hits no further apart than this many messages are shown as one stretch of the chat.", 0, "messages"),
        stretchHits: whole("Hits per stretch", "The hits a chat search shows of one stretch, so one exchange doesn't fill the page. The rest are counted.", 1, "hits"),
        lines: whole("Best lines per hit", "The lines a chat search shows of each message it found.", 1, "lines"),
        around: whole("Messages around one", "The messages chat_around shows each side of the one asked for, when the call names none.", 0, "messages"),
        trail: whole("Lines of a trail", "The most telling lines chat_about shows of a name or a phrase.", 1, "lines"),
        gapMinutes: whole("A break in the outline", "Without a book or arcs, chat_outline breaks the chat where two messages are this far apart in time.", 1, "minutes"),
        stretchMessages: whole("Messages per outline part", "The messages one part of that outline holds at most.", 2, "messages"),
        openingChars: whole("An outline part's opening", "How much of a part's opening lines that outline shows.", 20, "characters"),
        kept: whole("Chats indexed in memory", "The chats whose search index is kept in memory between turns. A chat past it is indexed again when it is next searched.", 1, "chats"),
      },
    },
    grep: {
      title: "Search by text or pattern",
      description: "chat_grep and lore_grep find lines by exact text or by a regular expression. A pattern that could take very long is refused, a line is matched a piece at a time, and a search gives way and stops at its time limit, so no pattern holds LumiAH.",
      type: "object",
      properties: {
        // A piece's worst case grows with the square of its length: at 4,000 it is four times the default's, which is as long as one piece may hold everything else.
        pieceChars: whole("Piece of a line", "A pattern is matched against this much of a line at once. A longer line is matched a piece at a time, each piece overlapping the last by half, so a match up to half this long is found wherever it stands. A longer piece finds longer matches and makes the slowest patterns slower.", 100, "characters", 4000),
        ms: whole("Time for one search", "A search that takes longer stops and tells the agent to narrow it.", 10, "ms", TIMER_MAX_MS),
        sliceMs: whole("Gives way after", "How long a search works at a time before it lets whatever else waits go on: a Stop, another agent.", 1, "ms", TIMER_MAX_MS),
      },
    },
    meaning: {
      title: "Search by meaning",
      description: "With an embedding connection in Lumiverse, a vector is kept for each lore entry and each chat message, so a search also finds what says the same in other words. It is off until you switch it on: it sends the text of the chat's messages and of its lore entries to your embedding provider, and costs what that provider charges.",
      type: "object",
      properties: {
        enabled: flag("Search by meaning", "Keep vectors and merge matches by meaning into lore_search and chat_search. Off, or without an embedding connection, search is by word and nothing is sent to an embedding provider."),
        callMs: whole("Time per embedding call", "An embedding call that takes longer is let go: the search it held goes on by word, and its texts wait for a later try.", 100, "ms", TIMER_MAX_MS),
        tokensPerDay: { title: "Embedded per day", description: "The most tokens embedded in any 24 hours, as estimated. Texts past it wait for the next day.", type: ["integer", "null"], minimum: 0, "x-unit": "tokens", "x-none": "No limit" },
        // Lumiverse takes no more texts in one embedding call, and no longer a text.
        batch: whole("Texts per call", "The texts one embedding call carries.", 1, "texts", EMBED_BATCH_MAX),
        textChars: whole("Text embedded", "How much of an entry or a message is embedded: its start, this long at most.", 100, "characters", EMBED_TEXT_MAX),
        weight: amount("Weight of meaning", "How much a match by meaning counts beside a match by word: 0 for not at all, 1 for meaning alone.", 0, 1),
        floor: amount("Least similarity", "A text counts as a match by meaning from this similarity to the query up.", 0, 1),
        matches: whole("Matches by meaning per query", "The matches by meaning one query brings to a search.", 1, "matches"),
        usdPerMillion: { title: "Price of embedding", description: "What your embedding model costs. Lumiverse reports no cost for embeddings, so the cost shown is worked out from this.", type: ["number", "null"], minimum: 0, "x-unit": "USD per million tokens", "x-none": "Unknown" },
      },
    },
    chronicle: {
      title: "The chronicle",
      description: "What the story has established, kept in learned/chronicle/ with a citation of the messages each line rests on.",
      type: "object",
      properties: {
        pin: flag("Pin the chronicle", "Give the main agent the top of the chronicle with each request. Lines whose citations match no message of the chat are left out."),
        pinChars: whole("Pinned chronicle: length", "The pinned part at most.", 200, "characters"),
        remind: flag("Remind it to keep the chronicle", "The pinned part ends with a line that says whether the chronicle wants bringing up to date, and how to start the chronicler for it with the reply. Off, the chronicle is kept only when you run the chronicler yourself."),
        tail: whole("Bring up to date after", "The main agent is told to have the chronicle brought up to date once the chat is more than this many messages past it. Under that it starts a job only when a reply changes something the chronicle states.", 1, "messages"),
        stretchMessages: whole("Messages per reader", "The chronicler hands the chat to readers a stretch at a time, each in a session of its own: the messages one reader is given at most.", 1, "messages"),
        stretchChars: whole("Text per reader", "The same stretch in characters at most.", 1000, "characters"),
        estimateSent: amount("Estimate: sent per token of chat", "Before you start a job that learns a chat's story, the Chronicle page says about how much it will take, reckoned from the messages the chronicle doesn't cover yet. This is the prompt tokens such a job sends for each token of chat still to read: readers send their stretch more than once, and the chronicler carries the lines they return. Raise or lower it if your jobs come out differently.", 0, 1000),
        estimateWritten: amount("Estimate: written per token of chat", "For the same estimate: the tokens a job writes for each token of chat still to read.", 0, 1000),
        estimateRounds: amount("Estimate: rounds per stretch", "For the same estimate: the rounds of tool calls each stretch takes, its reader's and the chronicler's share.", 0, 1000),
      },
    },
    memory: {
      title: "Lumiverse's memory",
      type: "object",
      properties: {
        hits: whole("Memories per search", "What memory_search asks the Memory Cortex for at most.", 1, "memories"),
        facts: whole("Facts per entity", "The facts memory_entity shows of a person or a thing.", 1, "facts"),
        relations: whole("Relations per entity", "The relations memory_entity shows.", 0, "relations"),
        entities: whole("Entities named", "The entities memory_entity names when the one asked for isn't known.", 1, "entities"),
      },
    },
    databanks: {
      title: "Databanks",
      type: "object",
      properties: {
        indexChars: whole("Documents read in", "The most text of the chat's databank documents read in for databank_search. Documents past it are listed and can be read, and aren't searched.", 1000, "characters"),
      },
    },
    web: {
      title: "Web search",
      type: "object",
      properties: {
        results: whole("Results per search", "The results web_search asks your provider for.", 1, "results"),
        pages: flag("Read the pages", "web_search reads the pages it finds too, where the call doesn't say, as many as your Lumiverse setting allows."),
        pageChars: whole("Page text shown", "How much of each page's text web_search shows.", 100, "characters"),
      },
    },
  },
};
