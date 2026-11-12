// The runtime's reads of chats and world books (PI-BUILD-PLAN §4.5, §4.6): the core's `chat.path` and
// `chat.messages`, `lore.books` and `lore.entries`, `recall.lore.read` and `recall.chat.messages`,
// answered by the very logic the extension's backend runs for them (src/host/), over the runtime's own
// copy of chat and lore (copy/) instead of over the link. The copy reads Lumiverse's database file
// itself where the instance's operator switched the reader on for this runtime, the runtime reaches
// Lumiverse at a loopback address (so runs on Lumiverse's own machine, where that file is
// Lumiverse's), and the file passed the reader's check of the tables it reads (db/); else
// Lumiverse's HTTP routes as the runtime's signed-in user. Whatever it can't vouch for, it asks of
// the extension over the link.
//
// It is told what it may read on every hello and whenever that changes; of every event Lumiverse sends
// the extension about the user's chats and world books, in the order Lumiverse sent them, each push
// numbered (a number missing means one was lost on the way, and everything held is read again); when
// the link went down and when it reopened; of the runtime's own writes on a message; and when a run
// begins on a chat, whose first read then checks the chat whatever the time since it was last checked.
//
// Without a copy, every read goes over the link, as it did before this build: before the extension said
// what the copy may read (or where it is a build from before the copy), and while the runtime doesn't
// know whose session it holds. So does a chat's message list where the extension LumiAH is built into
// keeps LumiAH's records in a form only its backend reads. An expired or signed-out session is never
// taken for "no such chat": its refusal fails the copy's read, which then goes over the link, and the
// Runtime page says the sign-in needs renewing. Nor is Lumiverse's "not found", or any answer of its
// routes the copy doesn't expect (they are no interface Lumiverse promises to keep): only the link's
// answer may say a chat or a book isn't there, and the page says when the routes aren't answering.

import type { ChatPort, JsonValue, LogLevel, LorePort } from "../core/ports";
import type { RecallChatPort, RecallLorePort } from "../core/recall/ports";
import { type AnchorCodec, anchorsUnder, ChatReader, OWN_ANCHORS, type PathKeeping } from "../host/chat";
import { Lore, type LoreDeps } from "../host/lore";
import { RecallReads } from "../host/recall";
import { LinkRefused } from "../host/refused";
import type { HostChat, HostReads, LoreReads } from "../host/rows";
import type { CopyOffer, CopyPush, EventPush, OwnPush, TurnBooks } from "../link/contract";
import { isRecord } from "../link/json";
import { isLoopback } from "../link/road";
import type { RuntimeTuning } from "../link/settings";
import type { SettingsOwner } from "../shared/timeouts";
import type { ChatDataView } from "../shared/ui";
import { LinkError } from "./connection";
import { createHostCopy, type HostCopy } from "./copy";
import { createHttpSource, type SessionFetch, sessionUser } from "./copy/http";
import type { CopySource } from "./copy/source";
import { createDbSource, DatabaseOff, type DbSource, preferDatabase } from "./db";
import { asked } from "./host";
import type { RuntimeLink } from "./link";
import { type Http, LiveError, loginAgain, type StoredLogin } from "./lumiverse";

/** The core's reads of chats and world books that the copy can answer: the rest of the chat, lore and recall ports go over the link either way. */
export interface CoreReads {
  chat: Pick<ChatPort, "path" | "messages">;
  lore: Pick<LorePort, "books" | "entries">;
  recall: { lore: Pick<RecallLorePort, "read">; chat: RecallChatPort };
}

export interface ChatDataDeps {
  link: RuntimeLink;
  /** The same reads over the link: where every one goes without a copy. */
  viaLink: CoreReads;
  /** Lumiverse's address, as the runtime reaches it. */
  base: string;
  /** The runtime's sign-in to Lumiverse now. */
  credentials(): StoredLogin | null;
  /** The runtime's own HTTP to Lumiverse. The copy's requests are held to their own wait (`copyReadMs`), not to the Lumiverse wait. */
  http: Http;
  now(): number;
  tuning(): RuntimeTuning;
  log(level: LogLevel, message: string): void;
  /** What the user's settings keep of the chats' message lists (`transport.sessions`). */
  pathKeeping(): Promise<PathKeeping>;
  /** Whose Settings hold the runtime's waits, for the words of one that ran out: the extension the runtime links to, as it last said. */
  owner(): SettingsOwner;
  sleep(ms: number): Promise<void>;
  /** The database reader on a file; `createDbSource` when not given. */
  database?: (file: { path: string; userId: string; identifier: string }) => DbSource;
  /** How long a route of Lumiverse's that didn't answer as expected for several different chats or books in a row is asked nothing; `PAUSE_MS` when not given (a test makes it short). */
  routePauseMs?: number;
  /** Set where this runtime is to keep no copy at all, saying why: every read goes over the link. */
  off?: string;
}

export interface ChatData {
  /** The core's reads: from the copy where there is one, over the link otherwise. */
  readonly reads: CoreReads;
  /** What the copy may read, as the extension said on this hello (null: a backend from before the copy). Everything held is read again from here. */
  copied(offer: CopyOffer | null): void;
  /** One of the extension's numbered pushes for the copy. */
  news(push: EventPush | OwnPush | CopyPush): void;
  /** How many numbered pushes the extension had sent this runtime when it answered a ping. */
  told(count: number): void;
  /** Every second: the copy is told when the link has gone down. */
  tick(): void;
  /**
   * The runtime wrote a record on a message through the link: until Lumiverse tells of that write, the
   * copy has the extension answer for the chat, and the message list kept of it is read again. Where
   * the message as kept already holds `wrote` (Lumiverse's word of it came before the link's answer),
   * the copy answers for the chat at once. Where the extension LumiAH is built into keeps its records
   * elsewhere, they are asked for again instead, which the extension answers after the write.
   * `messageId` null: the extension wrote it where the reply is, and which message that is wasn't said.
   */
  written(chatId: string, messageId: string | null, wrote?: { swipe: number; record: JsonValue }): void;
  /** A run begins on a chat: the first read of it checks it first, whenever it was last checked. */
  began(chatId: string): void;
  /** Runtime → Chat data: `memory` is the runtime's memory limit and what holds it there, which the page shows beside the copy's own cap. */
  state(memory: { limit: string; note: string | null }): ChatDataView;
  /** Lets go of the database file. */
  close(): void;
}

/** A copy as it was built: what for, so an offer that calls for another is seen. */
interface Built {
  copy: HostCopy;
  /** The shared logic's reader of a chat's message list and records, over the copy. */
  reader: ChatReader;
  userId: string;
  identifier: string;
  ownElsewhere: boolean;
  declinesLore: boolean;
  records: { under: string | null } | null;
  /** Where a swipe's record is in a message's own entry, where the runtime can read it (`records`); null where only the extension's backend can. */
  codec: AnchorCodec | null;
}

/** Lore's word on a chat's latest turn where none is to be asked: no persona said, nothing activated. */
const NO_TURN: LoreDeps = { persona: () => undefined, activatedBooks: () => [] };

/** The chat events Spindle counts as a chat's messages changing (`onChatTouched`). */
const TOUCHING: Readonly<Record<string, true>> = { MESSAGE_SENT: true, MESSAGE_EDITED: true, MESSAGE_DELETED: true, MESSAGE_SWIPED: true, SWIPE_EDITED: true, CHAT_CHANGED: true };

const words = (error: unknown): string => (error instanceof Error ? error.message : String(error));
const textOf = (o: unknown, key: string): string | null => (isRecord(o) && typeof o[key] === "string" && o[key] !== "" ? (o[key] as string) : null);

/** A read the shared logic refused, as the same refusal over the link reaches the core: its words, and its code. */
async function asLink<T>(work: () => Promise<T>): Promise<T> {
  try {
    return await work();
  } catch (error) {
    if (error instanceof LinkRefused) throw new Error(error.message, { cause: new LinkError(error.code, error.message) });
    throw error;
  }
}

/**
 * The database reader with each call failing whole where the reader finds itself off (`DatabaseOff`),
 * as one whose schema changed or whose file went: that read goes to the extension, as any read the
 * copy can't vouch for does, and `preferDatabase` reads over HTTP from the next call on.
 */
function failingOff(db: DbSource): DbSource {
  const whole = async <T>(work: () => Promise<T>): Promise<T> => {
    try {
      return await work();
    } catch (error) {
      if (error instanceof DatabaseOff) throw new Error(`the database reader turned itself off (${error.message}), so this read goes to the extension and the next ones read Lumiverse over HTTP`);
      throw error;
    }
  };
  return {
    kind: "database",
    readChat: (chatId) => whole(() => db.readChat(chatId)),
    readBook: (bookId, held) => whole(() => db.readBook(bookId, held)),
    chatSignature: (chatId) => whole(() => db.chatSignature(chatId)),
    bookSignature: (bookId, held) => whole(() => db.bookSignature(bookId, held)),
    changedSince: (mark) => whole(() => db.changedSince(mark)),
    describe: () => db.describe(),
    close: () => db.close(),
  };
}

/**
 * Lore's reads with the lists of world books one `turn.lore` answer carried given from it, for the
 * persona and the character it was read for: the rest, and a list of another persona's or character's,
 * as `lore` gives them.
 */
function listed(lore: LoreReads, books: TurnBooks, persona: string | null | undefined, character: string | null): LoreReads {
  return {
    ...lore,
    global: async () => [...books.global],
    ofPersona: (personaId, userId) => (personaId === null ? Promise.resolve(books.active) : personaId === persona && books.persona !== undefined ? Promise.resolve(books.persona) : lore.ofPersona(personaId, userId)),
    ofCharacter: (characterId, userId) => (characterId === character ? Promise.resolve([...books.character]) : lore.ofCharacter(characterId, userId)),
  };
}

export function createChatData(deps: ChatDataDeps): ChatData {
  const name = (): string => deps.link.backendName ?? "LumiAH";
  const link = { link: deps.link, now: deps.now, tuning: deps.tuning };
  /** Whether the runtime reaches Lumiverse at a loopback address, so runs on Lumiverse's own machine: the only place the database's path names Lumiverse's own file. On another machine the same path could hold an old copy of the data folder, which would answer as current, so there the reader is never opened. */
  const besideLumiverse = isLoopback(new URL(deps.base).hostname);
  /** What the copy may read, as the extension last said; null before a hello, and from a backend from before the copy. */
  let offer: CopyOffer | null = null;
  let greeted = false;
  /** The number of the last push heard. */
  let last = 0;
  let built: Built | null = null;
  let reader: { db: DbSource; path: string; userId: string; identifier: string } | null = null;
  let http: { key: string; source: CopySource } | null = null;
  /** Whose session the runtime holds, as Lumiverse said; null until it did. */
  let user: string | null = null;
  let userAt = Number.NEGATIVE_INFINITY;
  let userProblem: string | null = null;
  let asking = false;
  /** When Lumiverse last refused the runtime's session; null once it answers again. */
  let signedOut: number | null = null;
  /** The copy was told the link went down, and not yet that it reopened. */
  let downTold = false;
  const events: ChatDataView["events"] = { heard: 0, gaps: 0, lastGap: null };
  /** Reads of the extension's host under way, by what they read: each asked once, however many wait on it. */
  const hostReads = new Map<string, Promise<JsonValue>>();

  /**
   * One GET to Lumiverse as the runtime's signed-in user, over the runtime's own HTTP: Accept, the
   * bearer and an If-None-Match the source gives, never an Origin or a Cookie; a redirect isn't followed
   * (it would drop the bearer): it comes back as it was answered, where the source takes it for no
   * answer; the source's signal ends the request.
   */
  const fetch: SessionFetch = async (path, init) => {
    const token = deps.credentials()?.token;
    if (token === undefined) {
      signedOut ??= deps.now();
      throw new LiveError("login", loginAgain(deps.base));
    }
    const headers: Record<string, string> = { Accept: init.headers.Accept ?? "application/json", Authorization: `Bearer ${token}` };
    const tag = init.headers["If-None-Match"];
    if (tag !== undefined) headers["If-None-Match"] = tag;
    const reply = await deps.http({ method: "GET", url: `${deps.base}${path}`, headers, ...(init.signal !== undefined ? { signal: init.signal } : {}) });
    if (reply.status === 401) signedOut ??= deps.now();
    else if (reply.status >= 200 && reply.status < 300) signedOut = null;
    const kept: Record<string, string> = {};
    for (const name of ["etag", "location"]) {
      const value = reply.header(name);
      if (value !== null) kept[name] = value;
    }
    const empty = reply.status === 204 || reply.status === 205 || reply.status === 304;
    return new Response(empty ? null : reply.text, { status: reply.status, headers: kept });
  };

  /** The HTTP source, made again when the wait it holds each request to changes. */
  function overHttp(identifier: string): CopySource {
    const requestMs = deps.tuning().copyReadMs;
    const key = `${identifier}\u0000${requestMs}`;
    if (http === null || http.key !== key) http = { key, source: createHttpSource({ fetch, identifier, sleep: deps.sleep, requestMs, owner: deps.owner, now: deps.now, ...(deps.routePauseMs !== undefined ? { pauseMs: deps.routePauseMs } : {}) }) };
    return http.source;
  }

  /** One read of the extension's own host over the link (`host.read`), for the runtime's user: identical reads under way at once are asked once. */
  function hostRead<T>(port: "chats" | "lore", method: string, args: JsonValue[]): Promise<T> {
    const key = JSON.stringify([port, method, args]);
    let pending = hostReads.get(key);
    if (pending === undefined) {
      const asking = asked(link, "host.read", { port, method, args }).then((answer) => answer.value);
      pending = asking.finally(() => {
        if (hostReads.get(key) === pending) hostReads.delete(key);
      });
      hostReads.set(key, pending);
    }
    return pending as Promise<T>;
  }

  /** The extension's own host over the link, as the copy's fallback: it answers for the runtime's own user alone, and the copy never asks it for another. */
  function fallbackFor(userId: string): HostReads {
    const mine = (asked: string): void => {
      if (asked !== userId) throw new Error(`The runtime reads chats and world books for the user it is signed in as, not for ${asked}.`);
    };
    return {
      chats: {
        get: async (chatId, asked) => (mine(asked), hostRead("chats", "get", [chatId])),
        messages: (chatId, range) => hostRead("chats", "messages", [chatId, range ?? null]),
        swipe: (chatId, messageId, swipe) => hostRead("chats", "swipe", [chatId, messageId, swipe]),
        list: async (asked, offset, limit) => (mine(asked), hostRead("chats", "list", [offset, limit])),
        characterName: async (characterId, asked) => (mine(asked), hostRead("chats", "characterName", [characterId])),
        sovereignHand: async (chatId, asked) => (mine(asked), hostRead("chats", "sovereignHand", [chatId])),
      },
      lore: {
        book: async (bookId, asked) => (mine(asked), hostRead("lore", "book", [bookId])),
        entries: async (bookId, asked) => (mine(asked), hostRead("lore", "entries", [bookId])),
        entry: async (entryId, asked) => (mine(asked), hostRead("lore", "entry", [entryId])),
        record: async (bookId, asked) => (mine(asked), hostRead("lore", "record", [bookId])),
        records: async (bookId, asked) => (mine(asked), hostRead("lore", "records", [bookId])),
        global: async (asked) => (mine(asked), hostRead("lore", "global", [])),
        ofCharacter: async (characterId, asked) => (mine(asked), hostRead("lore", "ofCharacter", [characterId])),
        ofPersona: async (personaId, asked) => (mine(asked), hostRead("lore", "ofPersona", [personaId])),
      },
    };
  }

  /**
   * What the extension heard of the chat's latest generation (`turn.lore`): the persona and the books of
   * the entries Lumiverse activated, as the shared lore logic reads them; and the copy's lore reads with
   * the lists of world books that answer carried given from it, so that none of them crosses on its own
   * (a backend from before them carries none: each is then asked as it is needed). None asked where the
   * extension declines lore.
   */
  async function turnOf(c: Built, chat: HostChat): Promise<{ turn: LoreDeps; lore: LoreReads }> {
    if (c.declinesLore) return { turn: NO_TURN, lore: c.copy.lore };
    const said = await asked(link, "turn.lore", { chat: chat.id, ...(chat.characterId !== null ? { character: chat.characterId } : {}) });
    const books = said.activated.flatMap((a) => (a.bookId !== null ? [a.bookId] : []));
    return { turn: { persona: () => said.persona, activatedBooks: () => books }, lore: said.books === undefined ? c.copy.lore : listed(c.copy.lore, said.books, said.persona, chat.characterId) };
  }

  /** Lets go of the database reader, or opens one on the file the extension named, for the copy's user. */
  function switchReader(path: string | null, userId: string, identifier: string): void {
    if (reader !== null && reader.path === path && reader.userId === userId && reader.identifier === identifier) return;
    reader?.db.close();
    reader = null;
    if (path === null) return;
    const open = deps.database ?? ((file: { path: string; userId: string; identifier: string }): DbSource => createDbSource({ ...file, sleep: deps.sleep, now: deps.now, log: deps.log }));
    const db = failingOff(open({ path, userId, identifier }));
    reader = { db, path, userId, identifier };
    // It opens the file and checks the tables it reads at once, so the page says how it stands before a read needs it; a reader that turned itself off has said why in its own state and the log.
    void db.changedSince(null).catch(() => undefined);
  }

  /** Builds the copy, or another, where the offer and the session's user call for one, and lets it go where they don't. */
  function fit(): void {
    const said = offer;
    if (deps.off !== undefined || said === null || user === null) {
      built = null;
      reader?.db.close();
      reader = null;
      return;
    }
    const records = said.records;
    if (built === null || built.userId !== user || built.identifier !== said.identifier || built.ownElsewhere !== said.ownElsewhere || built.declinesLore !== said.declinesLore || JSON.stringify(built.records) !== JSON.stringify(records)) {
      const identifier = said.identifier;
      // Each call goes to the HTTP source made for the wait in force.
      const viaHttp: CopySource = {
        kind: "http",
        readChat: (chatId) => overHttp(identifier).readChat(chatId),
        readBook: (bookId, held) => overHttp(identifier).readBook(bookId, held),
        chatSignature: (chatId) => overHttp(identifier).chatSignature(chatId),
        bookSignature: (bookId, held) => overHttp(identifier).bookSignature(bookId, held),
        changedSince: (mark) => overHttp(identifier).changedSince(mark),
      };
      const copy = createHostCopy({
        source: preferDatabase(() => reader?.db ?? null, viaHttp),
        fallback: fallbackFor(user),
        userId: user,
        identifier,
        granted: (permission) => offer?.granted.includes(permission) === true,
        // The mounting extension's records of a chat's messages, kept elsewhere than on them.
        ...(said.ownElsewhere ? { own: async (chatId: string) => new Map(Object.entries((await asked(link, "own.read", { chat: chatId })).entries)) } : {}),
        ...(said.declinesLore ? { declinesLore: true } : {}),
        keepChars: () => deps.tuning().copyChars,
        now: deps.now,
        log: deps.log,
      });
      if (downTold) copy.closed();
      const codec = records === null ? null : records.under === null ? OWN_ANCHORS : anchorsUnder(records.under);
      built = { copy, reader: new ChatReader({ chats: copy.chats }, () => deps.pathKeeping(), deps.now, codec ?? OWN_ANCHORS), userId: user, identifier, ownElsewhere: said.ownElsewhere, declinesLore: said.declinesLore, records, codec };
    }
    switchReader(besideLumiverse ? said.database : null, user, said.identifier);
  }

  /** Asks Lumiverse whose session the runtime holds: on every hello, and on a read while it isn't known, at most once per longest reconnect wait. */
  function askUser(now: boolean): void {
    if (asking) return;
    const at = deps.now();
    if (!now && at - userAt < deps.tuning().reconnectMaxMs) return;
    asking = true;
    userAt = at;
    sessionUser(fetch)
      .then(
        (id) => {
          user = id;
          userProblem = null;
        },
        (error: unknown) => {
          userProblem = words(error);
          deps.log("warn", `[copy] couldn't ask Lumiverse whose session the runtime holds, so chats and world books are read through ${name()} until it can: ${words(error)}`);
        },
      )
      .finally(() => {
        asking = false;
        fit();
      });
  }

  /** The copy is told, once, that the link went down: no event tells of a change from now on. */
  function noteDown(): void {
    if (deps.link.up || downTold) return;
    downTold = true;
    built?.copy.closed();
    built?.reader.touchedAll();
  }

  /** The copy to read from, with the link's state told to it first; null where there is none. */
  function current(): Built | null {
    noteDown();
    if (built === null && offer !== null && user === null && deps.off === undefined) askUser(false);
    return built;
  }

  /** Something the extension told the copy never came: everything held is read again. */
  function lost(why: string): void {
    events.gaps++;
    events.lastGap = { at: deps.now(), why };
    deps.log("warn", `[copy] ${why}, so what the runtime's copy holds is read again`);
    built?.copy.lost();
    built?.reader.touchedAll();
  }

  const reads: CoreReads = {
    chat: {
      path(chatId) {
        const c = current();
        // Records in a form only the extension's backend reads: the message list, which carries them, is the extension's to give.
        return c === null || c.records === null ? deps.viaLink.chat.path(chatId) : asLink(() => c.reader.path(c.userId, chatId));
      },
      messages(chatId, from, to) {
        const c = current();
        return c === null ? deps.viaLink.chat.messages(chatId, from, to) : asLink(() => c.reader.messages(c.userId, chatId, from, to));
      },
    },
    lore: {
      books(chatId) {
        const c = current();
        if (c === null) return deps.viaLink.lore.books(chatId);
        return asLink(async () => {
          const chat = await c.reader.own(c.userId, chatId);
          const { turn, lore } = await turnOf(c, chat);
          return new Lore({ lore }, turn).books(c.userId, chat);
        });
      },
      entries(bookId) {
        const c = current();
        return c === null ? deps.viaLink.lore.entries(bookId) : asLink(() => new Lore(c.copy, NO_TURN).entries(c.userId, bookId));
      },
    },
    recall: {
      lore: {
        read(chatId, known) {
          const c = current();
          if (c === null) return deps.viaLink.recall.lore.read(chatId, known);
          return asLink(async () => {
            // A chat that isn't the user's is refused before anything else is asked of it.
            const chat = await c.reader.own(c.userId, chatId);
            const { turn, lore } = await turnOf(c, chat);
            return new RecallReads({ lore }, { chats: c.reader, lore: new Lore({ lore }, turn), now: deps.now }).lore(c.userId, chatId, known);
          });
        },
      },
      chat: {
        messages(chatId, from, to) {
          const c = current();
          if (c === null) return deps.viaLink.recall.chat.messages(chatId, from, to);
          return asLink(() => new RecallReads(c.copy, { chats: c.reader, lore: new Lore(c.copy, NO_TURN), now: deps.now }).messages(c.userId, chatId, from, to));
        },
      },
    },
  };

  /** Why the reads go where they go, in plain words. */
  function roadWords(): string {
    const who = name();
    if (deps.off !== undefined) return deps.off;
    if (built !== null) {
      const told = `The agents read chats and world books from the runtime's own copy, which Lumiverse's events keep current; whatever the copy can't vouch for is asked of ${who}.`;
      return built.records === null ? `${told} A chat's message list, which carries LumiAH's records, is read through ${who}: it keeps them in a form only it reads.` : told;
    }
    if (!greeted) return `The runtime hasn't said hello to ${who} yet: until it has, chats and world books are read through ${who}.`;
    if (offer === null) return `${who} is a build from before the runtime kept its own copy of chats and world books, so every read goes through ${who}. Update ${who} in Lumiverse.`;
    if (userProblem !== null) return `The runtime couldn't ask Lumiverse whose session it holds (${userProblem}), so chats and world books are read through ${who} until it can.`;
    return `The runtime is asking Lumiverse whose session it holds: until it knows, chats and world books are read through ${who}.`;
  }

  /** Where the copy reads from, and why, in plain words. */
  function sourceWords(): string | null {
    if (built === null) return null;
    const db = reader?.db.describe() ?? null;
    if (db !== null && db.on) return "The operator switched the database reader on for this runtime: the copy reads Lumiverse's own file, the runtime's user's rows alone.";
    if (db !== null) return `The copy reads Lumiverse as the runtime's signed-in user: the database reader is off (${db.why ?? "it was closed"}).`;
    if (offer !== null && offer.database !== null && !besideLumiverse) return `The copy reads Lumiverse as the runtime's signed-in user: the operator switched the database reader on, but this runtime reaches Lumiverse at ${new URL(deps.base).host}, not at a loopback address, and the reader opens Lumiverse's file only where the runtime runs on Lumiverse's own machine.`;
    return "The copy reads Lumiverse as the runtime's signed-in user: the database reader isn't switched on for this runtime.";
  }

  return {
    reads,
    copied(said) {
      greeted = true;
      offer = said;
      last = said?.told ?? 0;
      downTold = false;
      if (said !== null && deps.off === undefined) askUser(true);
      fit();
      built?.copy.reopened();
      built?.reader.touchedAll();
    },
    news(push) {
      // Older than what the last hello said: what the copy reads again since covers it.
      if (push.seq <= last) return;
      if (push.seq !== last + 1) lost(push.seq === last + 2 ? `push ${last + 1} of ${name()}'s never reached the runtime` : `pushes ${last + 1} to ${push.seq - 1} of ${name()}'s never reached the runtime`);
      last = push.seq;
      const c = built;
      switch (push.type) {
        case "event": {
          events.heard++;
          if (c === null) return;
          c.copy.apply({ name: push.name, payload: push.payload, userId: push.userId });
          if (push.name === "CHAT_DELETED") {
            const chatId = textOf(push.payload, "id") ?? textOf(push.payload, "chatId");
            if (chatId !== null) c.reader.dropped(chatId);
          } else if (TOUCHING[push.name] === true) {
            const chatId = textOf(push.payload, "chatId") ?? textOf(isRecord(push.payload) ? push.payload.chat : null, "id");
            if (chatId !== null) c.reader.touched(chatId);
          }
          return;
        }
        case "own":
          c?.copy.ownChanged(push.chat);
          c?.reader.touched(push.chat);
          return;
        case "copy":
          offer = { ...push.offer, told: push.seq };
          fit();
          return;
      }
    },
    told(count) {
      if (count <= last) return;
      lost(count === last + 1 ? `push ${count} of ${name()}'s never reached the runtime` : `pushes ${last + 1} to ${count} of ${name()}'s never reached the runtime`);
      last = count;
    },
    tick: noteDown,
    written(chatId, messageId, wrote) {
      const c = built;
      if (c === null) return;
      c.reader.touched(chatId);
      // The records kept elsewhere: asked for again, which the extension answers after the write.
      if (c.ownElsewhere) {
        c.copy.ownChanged(chatId);
        return;
      }
      // Lumiverse's word of the write may have come before the link's answer: a message as kept that holds the record vouches for the chat at once. Where the core rewrites a record of the same turn, the extension's backend keeps on it where the turn ran (`ran`), which the core's record doesn't carry: that is no part of what is compared then.
      const codec = c.codec;
      const landed = codec === null || wrote === undefined ? undefined : (own: JsonValue | null): boolean => {
        const held = codec.read(own, wrote.swipe);
        return held !== null && canonical(isRecord(held) && isRecord(wrote.record) && wrote.record.ran === undefined ? { ...held, ran: undefined } : held) === canonical(wrote.record);
      };
      // Without the message's id, no event can be told apart as the write's own: the copy waits out its while, then reads the chat again.
      c.copy.written(chatId, messageId ?? "", landed);
    },
    began(chatId) {
      built?.copy.due(chatId);
    },
    state(memory) {
      const c = built;
      const s = c?.copy.state() ?? null;
      const db = c !== null ? (reader?.db.describe() ?? null) : null;
      return {
        road: c !== null ? "copy" : "link",
        why: roadWords(),
        source: s?.source ?? null,
        sourceWhy: sourceWords(),
        signIn: signedOut !== null ? loginAgain(deps.base) : null,
        reader: db,
        memory: { kept: s?.chars.kept ?? 0, most: s?.chars.most ?? deps.tuning().copyChars, limit: memory.limit, note: memory.note },
        chats: s?.chats ?? [],
        books: s?.books ?? [],
        tooLarge: s?.tooLarge ?? { chats: [], books: [] },
        reads: s?.reads ?? [],
        fallbacks: s?.fallbacks ?? { total: 0, latest: [] },
        routes: s?.routes ?? { total: 0, latest: [] },
        events: { ...events, lastGap: events.lastGap === null ? null : { ...events.lastGap } },
      };
    },
    close() {
      reader?.db.close();
      reader = null;
    },
  };
}

/** A JSON text of a value with every object's keys in order, so two answers compare by what they hold. */
function canonical(value: unknown): string {
  return JSON.stringify(value, (_key, v: unknown) => (isRecord(v) ? Object.fromEntries(Object.keys(v).sort().map((k) => [k, v[k]])) : v)) ?? "undefined";
}

/**
 * Both roads at once, for a test's check that they give the same: every read is asked over the link
 * and of the copy, the two answers (or failures, by their words) are compared, every difference is
 * handed to `differed`, and the link's answer is the one given.
 */
export function bothRoads(viaLink: CoreReads, viaCopy: CoreReads, differed: (what: string) => void): CoreReads {
  async function both<T>(what: string, linked: () => Promise<T>, copied: () => Promise<T>): Promise<T> {
    const [l, c] = await Promise.allSettled([linked(), copied()]);
    // Each answer as text, or a failure by its words.
    const [a, b] = [l, c].map((outcome) => (outcome.status === "fulfilled" ? canonical(outcome.value) : `failed: ${words(outcome.reason)}`));
    if (a !== b) differed(`${what}: over the link ${a}; from the copy ${b}`);
    if (l.status === "rejected") throw l.reason;
    return l.value;
  }
  return {
    chat: {
      path: (chatId) => both(`chat.path ${chatId}`, () => viaLink.chat.path(chatId), () => viaCopy.chat.path(chatId)),
      messages: (chatId, from, to) => both(`chat.messages ${chatId} ${from}-${to}`, () => viaLink.chat.messages(chatId, from, to), () => viaCopy.chat.messages(chatId, from, to)),
    },
    lore: {
      books: (chatId) => both(`lore.books ${chatId}`, () => viaLink.lore.books(chatId), () => viaCopy.lore.books(chatId)),
      entries: (bookId) => both(`lore.entries ${bookId}`, () => viaLink.lore.entries(bookId), () => viaCopy.lore.entries(bookId)),
    },
    recall: {
      lore: { read: (chatId, known) => both(`recall.lore.read ${chatId}`, () => viaLink.recall.lore.read(chatId, known), () => viaCopy.recall.lore.read(chatId, known)) },
      chat: { messages: (chatId, from, to) => both(`recall.chat.messages ${chatId} ${from}-${to}`, () => viaLink.recall.chat.messages(chatId, from, to), () => viaCopy.recall.chat.messages(chatId, from, to)) },
    },
  };
}
