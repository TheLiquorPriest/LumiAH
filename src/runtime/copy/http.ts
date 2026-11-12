// The copy's source over Lumiverse's HTTP routes, as the runtime's signed-in user (PI-BUILD-PLAN
// §4.5): the session decides whose rows Lumiverse answers with.
//
// Those routes are no interface Lumiverse promises to keep: a release may move or change them, and a
// test bed may serve none of them. So the source takes only the answers it expects for answers. "Not
// found", any other status it doesn't expect (a redirect among them: following one would drop the
// runtime's sign-in), and a body it can't read each say that it can't answer (`Unanswered`), never that
// the chat or the book isn't there: the read goes to the extension, whose answer alone may say so. A
// route that answered so for several different chats or books in a row is asked nothing for a while
// (`pauseMs`), its reads going to the extension at once, and is then asked again.
//
// A chat's messages come in pages of 1000, Lumiverse's own cap, lean: only the shown swipe's text
// crosses, which is most of the saving on a long chat. Its first page says how many there are, and
// the rest are read a few at once. Lumiverse pages by place and keeps no snapshot between two pages,
// so a message deleted (or put in) before a page boundary while the pages are read would slide every
// later one across it unseen, and the count alone can't show that when another message came at the
// end meanwhile. So each page after the first starts at the row the page before ended on and must give
// that same row again, at the same place; every page must give the same count, and no row may come
// twice. Where any of that fails, the chat changed while it was read, and it is read again from the
// start. A world book's entries are read the same way, each page together with the book's own row,
// which must be alike on every page (Lumiverse stamps a book with every change that can move an entry
// across a page boundary: one made, deleted, moved, or given another order).
//
// A book is always read whole, never asked whether it changed since its last read: Lumiverse's ETag
// for a book misses a write to an entry's extensions by namespace and a second change to the book in
// the same second, so a "not modified" can't be trusted. A page that fails is tried again; a request
// that hasn't answered within its deadline is given up, and the read it was part of fails. Lumiverse
// has no ETag on chats: their cheap signature is the count, the newest message and the chat's own row.

import { linkedBackendOf } from "../../link/frames";
import { spanWords, transportWait } from "../../link/waits";
import type { SettingsOwner } from "../../shared/timeouts";
import { LiveError } from "../lumiverse";
import { isRecord } from "../../link/json";
import { bookOf, chatOf, entryOf, messageOf } from "./rows";
import { type ChatSignature, type CopySource, type SourceBook, type SourceChat, type SourceEntry, type SourceMessage, Unanswered } from "./source";

/**
 * One GET to Lumiverse with the runtime's session already on it: a path under Lumiverse's address
 * (`/api/v1/...`), the headers to add, and a signal that fires when the source gave up on the request,
 * to be handed to `fetch` so the request doesn't stay open after nobody waits for it.
 */
export type SessionFetch = (path: string, init: { headers: Record<string, string>; signal?: AbortSignal }) => Promise<Response>;

export interface HttpSourceDeps {
  fetch: SessionFetch;
  /** The extension whose entry in a message's extension metadata is its own. */
  identifier: string;
  /** Waits before a failed page is asked for again. */
  sleep(ms: number): Promise<void>;
  /** How many pages are read at once; 4 when not said. */
  parallel?: number;
  /** How many times a page is asked for before its read fails; 3 when not said. */
  tries?: number;
  /** The wait before the second try of a page, doubled for each try after; 250 ms when not said. */
  retryMs?: number;
  /** How many times a chat or a book is read from the start when its pages disagreed; 3 when not said. */
  rereads?: number;
  /** How long one request may go unanswered, its body included, before it is given up and the read it is part of fails; `REQUEST_MS` when not said. */
  requestMs?: number;
  /** Whose Settings hold that wait (the runtime's "Chat data wait"), for the words of a request given up: the extension the runtime links to, as it last said, read when the words are made; LumiAH's own when not said, as `linkedBackendOf` has it. */
  owner?: () => SettingsOwner;
  /** How long a route that didn't answer as expected for `PAUSE_AFTER` different chats or books in a row is asked nothing, its reads going to the extension at once; `PAUSE_MS` when not said. */
  pauseMs?: number;
  /** The clock a route's pause is kept by; `Date.now` when not said. */
  now?: () => number;
}

/** How long one request to Lumiverse may go unanswered when `requestMs` isn't said: long enough for a page of 1000 rows from a slow machine. */
export const REQUEST_MS = 15_000;
/** How many different chats or books in a row a route may fail to answer as expected before it is asked nothing for a while. */
export const PAUSE_AFTER = 3;
/** How long such a route is asked nothing when `pauseMs` isn't said: long enough that its reads pay no failed request each, short enough that a route back in service is soon used again. */
export const PAUSE_MS = 60_000;

/** The routes the source reads, as it names them where one doesn't answer as it expects. */
const CHAT = "GET /api/v1/chats/:id";
const MESSAGES = "GET /api/v1/chats/:id/messages";
const BOOK = "GET /api/v1/world-books/:id";
type Route = typeof CHAT | typeof MESSAGES | typeof BOOK;

/** Lumiverse's own cap on a page of messages or entries. */
const PAGE = 1000;
/** How far each page after the first starts beyond the one before: one row short of a page, so it gives that page's last row again. */
const STEP = PAGE - 1;

/** A page of rows as Lumiverse answers one: the rows, how many there are in all, and what the page says of the book they are of (its own row), which every page must say alike. */
interface Page {
  data: unknown[];
  total: number;
  head?: string;
}

/** What one GET gave: its status (200, or 304 where it was asked whether the row changed), its body as JSON (null where it had none), and its ETag. */
interface Answer {
  status: number;
  body: unknown;
  tag: string | null;
}

/** Why one GET failed in a way a second try may change. */
interface Failure {
  failure: string;
}

const words = (error: unknown): string => (error instanceof Error ? error.message : String(error));

/** A refusal no second try changes: the session is gone or not let in, or the address is locked out. */
function refusal(status: number, asked: string): LiveError | null {
  if (status === 401) return new LiveError("login", "The runtime's Lumiverse session is no longer valid (it expired, or was signed out). Sign it in again: lumiah login");
  if (status === 403) return new LiveError("forbidden", `Lumiverse refused the runtime when it ${asked} (403 Forbidden): the address the runtime uses isn't one of its trusted hosts.`);
  if (status === 429) return new LiveError("locked", `Lumiverse is refusing every request from the runtime's address for a while (429) after repeated failed sign-ins, so it couldn't be ${asked}.`);
  return null;
}

/** A page's rows and its count, as Lumiverse answers a page; null for anything else. */
function pageOf(body: unknown): Page | null {
  if (!isRecord(body) || !Array.isArray(body.data) || typeof body.total !== "number" || !Number.isSafeInteger(body.total) || body.total < 0) return null;
  return { data: body.data, total: body.total };
}

/** Runs `work` for each of `items`, at most `most` at once; the results in the items' order. */
async function inTurn<T, R>(items: readonly T[], most: number, work: (item: T) => Promise<R>): Promise<R[]> {
  const out = new Array<R>(items.length);
  let next = 0;
  const lane = async (): Promise<void> => {
    while (next < items.length) {
      const at = next++;
      out[at] = await work(items[at] as T);
    }
  };
  await Promise.all(Array.from({ length: Math.min(most, items.length) }, lane));
  return out;
}

/** The offsets of every page after the first, for `total` rows: each starts at the last row of the page before. */
function laterPages(total: number): number[] {
  const offsets: number[] = [];
  for (let offset = STEP; offset + 1 < total; offset += STEP) offsets.push(offset);
  return offsets;
}

/**
 * The rows of a chat's or a book's pages, read in order, as one list; null when they don't fit
 * together. Each page after the first must start with the row the page before ended on (the same id
 * at the same `place`: a message's place in the chat, an entry's order), and say the count and the
 * head the first said; and no row may come twice. Otherwise a row came, went or moved before a page
 * boundary while the pages were read.
 */
function joined(pages: readonly Page[], place: "index_in_chat" | "order_value"): unknown[] | null {
  const [first, ...later] = pages;
  if (first === undefined) return null;
  const rows: unknown[] = [...first.data];
  for (const page of later) {
    if (page.total !== first.total || page.head !== first.head) return null;
    const [overlap, ...fresh] = page.data;
    const before = rows.at(-1);
    if (!isRecord(overlap) || !isRecord(before) || overlap.id !== before.id || overlap[place] !== before[place]) return null;
    rows.push(...fresh);
  }
  if (rows.length !== first.total) return null;
  const ids = new Set(rows.map((row) => (isRecord(row) ? row.id : undefined)));
  return ids.size === rows.length ? rows : null;
}

export function createHttpSource(deps: HttpSourceDeps): CopySource {
  const parallel = Math.max(1, deps.parallel ?? 4);
  const tries = Math.max(1, deps.tries ?? 3);
  const retryMs = deps.retryMs ?? 250;
  const rereads = Math.max(1, deps.rereads ?? 3);
  const requestMs = Math.max(1, deps.requestMs ?? REQUEST_MS);
  const owner = deps.owner ?? (() => linkedBackendOf(undefined));
  const pauseMs = Math.max(0, deps.pauseMs ?? PAUSE_MS);
  const now = deps.now ?? Date.now;
  /** Each route since it last answered as expected: the chats and books it didn't answer for, what it answered last, and until when it is asked nothing (passed: it is asked). */
  const runs = new Map<Route, { ids: Set<string>; status: number; until: number }>();

  /** Throws where the route is asked nothing now. */
  function open(route: Route): void {
    const run = runs.get(route);
    if (run === undefined || now() >= run.until) return;
    throw new Unanswered(route, run.status, run.until, `Lumiverse's ${route} answered ${run.status} for ${run.ids.size} different ${route === BOOK ? "world books" : "chats"} in a row, so the runtime asks it nothing for ${spanWords(pauseMs)}, and the extension is asked instead`);
  }

  /** The route didn't answer as expected for one chat or book: counted against it, and it is asked nothing for a while once it did so for `PAUSE_AFTER` different ones in a row (again at once where it does so right after such a while). */
  function unanswered(route: Route, id: string, status: number, why: string): Unanswered {
    let run = runs.get(route);
    if (run === undefined) {
      run = { ids: new Set(), status, until: 0 };
      runs.set(route, run);
    }
    run.ids.add(id);
    run.status = status;
    const at = now();
    if (run.ids.size >= PAUSE_AFTER) run.until = at + pauseMs;
    return new Unanswered(route, status, run.until > at ? run.until : null, `${why}, which the runtime doesn't take for an answer of ${route}, so the extension is asked instead`);
  }

  /** The routes answered as expected: what they failed before is forgotten. */
  function answered(...routes: Route[]): void {
    for (const route of routes) runs.delete(route);
  }

  /** One GET's answer, or why it failed in a way a second try may change. Throws what no second try changes: a refusal of the session or the address as it is, any other answer the source doesn't take as one as `Unanswered`. */
  async function ask(route: Route, id: string, path: string, asked: string, headers: Record<string, string>, signal: AbortSignal): Promise<Answer | Failure> {
    let reply: Response;
    let text: string;
    try {
      reply = await deps.fetch(path, { headers: { Accept: "application/json", ...headers }, signal });
      const refused = refusal(reply.status, asked);
      if (refused !== null) throw refused;
      if (reply.status >= 500) return { failure: `Lumiverse answered ${reply.status}` };
      text = reply.status === 200 ? await reply.text() : "";
    } catch (error) {
      if (error instanceof LiveError) throw error;
      return { failure: `Lumiverse couldn't be reached (${words(error)})` };
    }
    // Not modified, where the source asked whether it was.
    if (reply.status === 304 && headers["If-None-Match"] !== undefined) return { status: 304, body: null, tag: reply.headers.get("etag") };
    if (reply.status !== 200) {
      const redirect = reply.status >= 300 && reply.status < 400 ? `, a redirect to ${reply.headers.get("location") ?? "another address"}, which the runtime doesn't follow: it would drop the runtime's sign-in` : "";
      throw unanswered(route, id, reply.status, `Lumiverse answered ${reply.status} when it was ${asked}${redirect}`);
    }
    try {
      return { status: 200, body: text === "" ? null : JSON.parse(text), tag: reply.headers.get("etag") };
    } catch {
      throw unanswered(route, id, 200, `Lumiverse answered something that isn't JSON when it was ${asked}`);
    }
  }

  /** `ask`, given up once `requestMs` passed with no whole answer: the request is aborted, and what it was part of fails rather than wait on. */
  async function within(route: Route, id: string, path: string, asked: string, headers: Record<string, string>): Promise<Answer | Failure> {
    const stop = new AbortController();
    const late = Promise.withResolvers<never>();
    const timer = setTimeout(() => {
      late.reject(new LiveError("timeout", `Lumiverse didn't answer within ${spanWords(requestMs)} when it was ${asked}, so the runtime gave up on it. ${transportWait(["runtime", "copyReadMs"], owner())} says how long each of the runtime's reads of chat data waits.`));
      stop.abort();
    }, requestMs);
    try {
      return await Promise.race([ask(route, id, path, asked, headers, stop.signal), late.promise]);
    } finally {
      clearTimeout(timer);
    }
  }

  /** One GET of a route for one chat or book, tried again while Lumiverse can't be reached or fails on its side. 200 is an answer, and 304 where an ETag was sent; any other answer, a refusal, and a request past its deadline, throws. */
  async function get(route: Route, id: string, path: string, asked: string, headers: Record<string, string> = {}): Promise<Answer> {
    for (let attempt = 1; ; attempt++) {
      const answer = await within(route, id, path, asked, headers);
      if (!("failure" in answer)) return answer;
      if (attempt >= tries) throw new LiveError("unreachable", `${answer.failure} when it was ${asked}, ${tries} times.`);
      await deps.sleep(retryMs * 2 ** (attempt - 1));
    }
  }

  async function readChat(chatId: string): Promise<SourceChat> {
    open(CHAT);
    open(MESSAGES);
    const id = encodeURIComponent(chatId);
    const asked = `asked for chat ${chatId}'s messages`;
    const pageAt = async (offset: number): Promise<Page> => {
      const page = pageOf((await get(MESSAGES, chatId, `/api/v1/chats/${id}/messages?limit=${PAGE}&offset=${offset}`, asked)).body);
      if (page === null) throw unanswered(MESSAGES, chatId, 200, `Lumiverse answered something that isn't a page when it was ${asked}`);
      return page;
    };
    for (let attempt = 1; ; attempt++) {
      const [chatAnswer, first] = await Promise.all([get(CHAT, chatId, `/api/v1/chats/${id}?messages=false`, `asked for chat ${chatId}`), pageAt(0)]);
      const read = chatOf(chatAnswer.body);
      if (read === null) throw unanswered(CHAT, chatId, 200, `Lumiverse answered something that isn't a chat when it was asked for chat ${chatId}`);
      const later = await inTurn(laterPages(first.total), parallel, pageAt);
      const rows = joined([first, ...later], "index_in_chat");
      if (rows !== null) {
        const messages = rows.map((raw) => messageOf(raw, deps.identifier));
        if (messages.some((m) => m === null)) throw unanswered(MESSAGES, chatId, 200, `Lumiverse answered a message the runtime can't read when it was ${asked}`);
        answered(CHAT, MESSAGES);
        return { ...read, messages: messages as SourceMessage[] };
      }
      if (attempt >= rereads) throw new Error(`Chat ${chatId} kept changing while it was read (${rereads} times), so it wasn't kept.`);
    }
  }

  async function readBook(bookId: string): Promise<SourceBook> {
    open(BOOK);
    const id = encodeURIComponent(bookId);
    const asked = `asked for world book ${bookId}`;
    /** A page of the book's entries, read with the book's own row, which is the page's head. */
    const pageAt = async (offset: number): Promise<{ page: Page; book: SourceBook["book"]; tag: string | null }> => {
      const answer = await get(BOOK, bookId, `/api/v1/world-books/${id}?limit=${PAGE}&offset=${offset}`, asked);
      const book = bookOf(answer.body);
      const page = isRecord(answer.body) ? pageOf(answer.body.entries) : null;
      if (book === null || page === null) throw unanswered(BOOK, bookId, 200, `Lumiverse answered something that isn't a world book when it was ${asked}`);
      return { page: { ...page, head: JSON.stringify(book) }, book, tag: answer.tag };
    };
    for (let attempt = 1; ; attempt++) {
      const first = await pageAt(0);
      const later = await inTurn(laterPages(first.page.total), parallel, async (offset) => (await pageAt(offset)).page);
      const rows = joined([first.page, ...later], "order_value");
      if (rows !== null) {
        const entries = rows.map(entryOf);
        if (entries.some((e) => e === null)) throw unanswered(BOOK, bookId, 200, `Lumiverse answered an entry the runtime can't read when it was ${asked}`);
        answered(BOOK);
        return { book: first.book, entries: entries as SourceEntry[], signature: first.tag };
      }
      if (attempt >= rereads) throw new Error(`World book ${bookId} kept changing while it was read (${rereads} times), so it wasn't kept.`);
    }
  }

  async function chatSignature(chatId: string): Promise<ChatSignature> {
    open(CHAT);
    open(MESSAGES);
    const id = encodeURIComponent(chatId);
    const asked = `asked for chat ${chatId}'s newest message`;
    // The chat's own row with it: Lumiverse writes some keys of its metadata with no event (the chat memory's config hash, the memory cortex's rebuild state, a databank's bindings).
    const [chatAnswer, tailAnswer] = await Promise.all([get(CHAT, chatId, `/api/v1/chats/${id}?messages=false`, `asked for chat ${chatId}`), get(MESSAGES, chatId, `/api/v1/chats/${id}/messages?tail=true&limit=1`, asked)]);
    const read = chatOf(chatAnswer.body);
    if (read === null) throw unanswered(CHAT, chatId, 200, `Lumiverse answered something that isn't a chat when it was asked for chat ${chatId}`);
    const page = pageOf(tailAnswer.body);
    if (page === null) throw unanswered(MESSAGES, chatId, 200, `Lumiverse answered something that isn't a page when it was ${asked}`);
    const newest = page.data.at(-1);
    const last = newest === undefined ? null : messageOf(newest, deps.identifier);
    if (newest !== undefined && last === null) throw unanswered(MESSAGES, chatId, 200, `Lumiverse answered a message the runtime can't read when it was ${asked}`);
    answered(CHAT, MESSAGES);
    return { count: page.total, last: last?.row ?? null, chat: read.chat };
  }

  /** Lumiverse's ETag for the book's first page. It misses a write to an entry's extensions by namespace and a second change in the same second, which is why the copy reads a book from this source whole instead of asking this. */
  async function bookSignature(bookId: string, held: SourceBook | null): Promise<string> {
    open(BOOK);
    const asked = `asked about world book ${bookId}`;
    const ask: Record<string, string> = held?.signature != null ? { "If-None-Match": held.signature } : {};
    const answer = await get(BOOK, bookId, `/api/v1/world-books/${encodeURIComponent(bookId)}?limit=${PAGE}&offset=0`, asked, ask);
    if (answer.status === 200 && bookOf(answer.body) === null) throw unanswered(BOOK, bookId, 200, `Lumiverse answered something that isn't a world book when it was ${asked}`);
    answered(BOOK);
    if (answer.status === 304 && held?.signature != null) return held.signature;
    // A Lumiverse that gives no ETag gives nothing to compare: the book reads as changed.
    return answer.tag ?? "";
  }

  return {
    kind: "http",
    readChat,
    readBook,
    chatSignature,
    bookSignature,
    // Lumiverse's HTTP routes say nothing about changes in general.
    changedSince: async () => ({ changed: null, mark: null }),
  };
}

/** The id of the user whose session `fetch` carries: the only user whose rows the copy keeps. */
export async function sessionUser(fetch: SessionFetch): Promise<string> {
  const reply = await fetch("/api/auth/get-session", { headers: { Accept: "application/json" } });
  const refused = refusal(reply.status, "asked whose session the runtime holds");
  if (refused !== null) throw refused;
  if (reply.status !== 200) throw new LiveError("unreachable", `Lumiverse answered ${reply.status} when it was asked whose session the runtime holds.`);
  let body: unknown;
  try {
    body = await reply.json();
  } catch {
    body = null;
  }
  const user = isRecord(body) && isRecord(body.user) ? body.user.id : undefined;
  if (typeof user !== "string" || user === "") throw new LiveError("login", "The runtime's Lumiverse session is no longer valid (it expired, or was signed out). Sign it in again: lumiah login");
  return user;
}
