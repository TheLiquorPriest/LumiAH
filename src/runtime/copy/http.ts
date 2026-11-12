// The copy's source over Lumiverse's HTTP routes, as the runtime's signed-in user (PI-BUILD-PLAN
// §4.5): the session decides whose rows Lumiverse answers with, so another user's chat or book is
// simply not there.
//
// A chat's messages come in pages of 1000, Lumiverse's own cap, lean: only the shown swipe's text
// crosses, which is most of the saving on a long chat. Its first page says how many there are, and
// the rest are read a few at once. A page that fails is tried again; a chat is given only once every
// page was read and every page agreed on the count, which they don't when the chat changed while it
// was read: then it is read again from the start. A world book comes with its first page of entries
// and Lumiverse's ETag, which a later read sends back, so a book that didn't change costs one empty
// answer. Lumiverse has no ETag on chats: their cheap signature is the newest message and the count.

import { LiveError } from "../lumiverse";
import { isRecord } from "../../link/json";
import { bookOf, chatOf, entryOf, messageOf } from "./rows";
import type { ChatSignature, CopySource, SourceBook, SourceChat, SourceEntry, SourceMessage } from "./source";

/** One GET to Lumiverse with the runtime's session already on it: a path under Lumiverse's address (`/api/v1/...`), and the headers to add. */
export type SessionFetch = (path: string, init: { headers: Record<string, string> }) => Promise<Response>;

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
}

/** Lumiverse's own cap on a page of messages or entries. */
const PAGE = 1000;

/** A page of rows as Lumiverse answers one: the rows, and how many there are in all. */
interface Page {
  data: unknown[];
  total: number;
}

/** What one GET gave: its status, its body as JSON (null where it had none), and its ETag. */
interface Answer {
  status: number;
  body: unknown;
  tag: string | null;
}

/** A refusal no second try changes: the session is gone or not let in, or the address is locked out. */
function refusal(status: number, asked: string): LiveError | null {
  if (status === 401) return new LiveError("login", "The runtime's Lumiverse session is no longer valid (it expired, or was signed out). Sign it in again: lumiah login");
  if (status === 403) return new LiveError("forbidden", `Lumiverse refused the runtime when it ${asked} (403 Forbidden): the address the runtime uses isn't one of its trusted hosts.`);
  if (status === 429) return new LiveError("locked", `Lumiverse is refusing every request from the runtime's address for a while (429) after repeated failed sign-ins, so it couldn't be ${asked}.`);
  return null;
}

/** A page's rows and its count, as Lumiverse answers a page; throws on anything else. */
function pageOf(body: unknown, asked: string): Page {
  if (!isRecord(body) || !Array.isArray(body.data) || typeof body.total !== "number" || !Number.isSafeInteger(body.total) || body.total < 0) throw new LiveError("protocol", `Lumiverse answered something that isn't a page when it was ${asked}.`);
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

/** The offsets of every page after the first, for `total` rows. */
function laterPages(total: number): number[] {
  const offsets: number[] = [];
  for (let offset = PAGE; offset < total; offset += PAGE) offsets.push(offset);
  return offsets;
}

/** Whether every page agreed on the count, and the rows read are that many, none twice: the read is whole. */
function whole(pages: readonly Page[], ids: readonly string[]): boolean {
  const total = pages[0]?.total ?? 0;
  return pages.every((p) => p.total === total) && ids.length === total && new Set(ids).size === total;
}

export function createHttpSource(deps: HttpSourceDeps): CopySource {
  const parallel = Math.max(1, deps.parallel ?? 4);
  const tries = Math.max(1, deps.tries ?? 3);
  const retryMs = deps.retryMs ?? 250;
  const rereads = Math.max(1, deps.rereads ?? 3);

  /** One GET, tried again while Lumiverse can't be reached or fails on its side. 200, 304 and 404 are answers; any other refusal throws. */
  async function get(path: string, asked: string, headers: Record<string, string> = {}): Promise<Answer> {
    for (let attempt = 1; ; attempt++) {
      let failure: string;
      try {
        const reply = await deps.fetch(path, { headers: { Accept: "application/json", ...headers } });
        const refused = refusal(reply.status, asked);
        if (refused !== null) throw refused;
        if (reply.status === 200 || reply.status === 304 || reply.status === 404) {
          const text = reply.status === 200 ? await reply.text() : "";
          let body: unknown = null;
          if (text !== "") {
            try {
              body = JSON.parse(text);
            } catch {
              throw new LiveError("protocol", `Lumiverse answered something that isn't JSON when it was ${asked}.`);
            }
          }
          return { status: reply.status, body, tag: reply.headers.get("etag") };
        }
        if (reply.status < 500) throw new LiveError("protocol", `Lumiverse answered ${reply.status} when it was ${asked}.`);
        failure = `Lumiverse answered ${reply.status}`;
      } catch (error) {
        if (error instanceof LiveError) throw error;
        failure = `Lumiverse couldn't be reached (${error instanceof Error ? error.message : String(error)})`;
      }
      if (attempt >= tries) throw new LiveError("unreachable", `${failure} when it was ${asked}, ${tries} times.`);
      await deps.sleep(retryMs * 2 ** (attempt - 1));
    }
  }

  /** The rows of every page after the first, read a few at once; null when the chat or book went away meanwhile. */
  async function rest(total: number, pathAt: (offset: number) => string, asked: string): Promise<Page[] | null> {
    const pages = await inTurn(laterPages(total), parallel, async (offset) => {
      const answer = await get(pathAt(offset), asked);
      return answer.status === 404 ? null : pageOf(answer.body, asked);
    });
    return pages.some((p) => p === null) ? null : (pages as Page[]);
  }

  async function readChat(chatId: string): Promise<SourceChat | null> {
    const id = encodeURIComponent(chatId);
    const asked = `asked for chat ${chatId}'s messages`;
    for (let attempt = 1; ; attempt++) {
      const [chatAnswer, firstAnswer] = await Promise.all([get(`/api/v1/chats/${id}?messages=false`, `asked for chat ${chatId}`), get(`/api/v1/chats/${id}/messages?limit=${PAGE}&offset=0`, asked)]);
      if (chatAnswer.status === 404 || firstAnswer.status === 404) return null;
      const read = chatOf(chatAnswer.body);
      if (read === null || chatAnswer.status !== 200) throw new LiveError("protocol", `Lumiverse answered something that isn't a chat when it was asked for chat ${chatId}.`);
      const first = pageOf(firstAnswer.body, asked);
      const later = await rest(first.total, (offset) => `/api/v1/chats/${id}/messages?limit=${PAGE}&offset=${offset}`, asked);
      if (later === null) return null;
      const pages = [first, ...later];
      const messages = pages.flatMap((p) => p.data.map((raw) => messageOf(raw, deps.identifier)).filter((m): m is SourceMessage => m !== null));
      if (whole(pages, messages.map((m) => m.row.id))) return { ...read, messages };
      // The chat changed while it was read: a message came or went between two pages.
      if (attempt >= rereads) throw new Error(`Chat ${chatId} kept changing while it was read (${rereads} times), so it wasn't kept.`);
    }
  }

  async function readBook(bookId: string, held: SourceBook | null): Promise<SourceBook | null> {
    const id = encodeURIComponent(bookId);
    const asked = `asked for world book ${bookId}`;
    for (let attempt = 1; ; attempt++) {
      const ask: Record<string, string> = held?.signature != null && attempt === 1 ? { "If-None-Match": held.signature } : {};
      const firstAnswer = await get(`/api/v1/world-books/${id}?limit=${PAGE}&offset=0`, asked, ask);
      if (firstAnswer.status === 404) return null;
      if (firstAnswer.status === 304 && held !== null) return held;
      const book = bookOf(firstAnswer.body);
      if (book === null || firstAnswer.status !== 200 || !isRecord(firstAnswer.body)) throw new LiveError("protocol", `Lumiverse answered something that isn't a world book when it was ${asked}.`);
      const first = pageOf(firstAnswer.body.entries, asked);
      const later = await rest(first.total, (offset) => `/api/v1/world-books/${id}/entries?limit=${PAGE}&offset=${offset}`, `asked for world book ${bookId}'s entries`);
      if (later === null) return null;
      const pages = [first, ...later];
      const entries = pages.flatMap((p) => p.data.map(entryOf).filter((e): e is SourceEntry => e !== null));
      if (whole(pages, entries.map((e) => e.row.id))) return { book, entries, signature: firstAnswer.tag };
      if (attempt >= rereads) throw new Error(`World book ${bookId} kept changing while it was read (${rereads} times), so it wasn't kept.`);
    }
  }

  async function chatSignature(chatId: string): Promise<ChatSignature | null> {
    const asked = `asked for chat ${chatId}'s newest message`;
    const answer = await get(`/api/v1/chats/${encodeURIComponent(chatId)}/messages?tail=true&limit=1`, asked);
    if (answer.status === 404) return null;
    const page = pageOf(answer.body, asked);
    const last = page.data.length > 0 ? messageOf(page.data[page.data.length - 1], deps.identifier) : null;
    return { count: page.total, last: last?.row ?? null };
  }

  async function bookSignature(bookId: string, held: SourceBook | null): Promise<string | null> {
    const ask: Record<string, string> = held?.signature != null ? { "If-None-Match": held.signature } : {};
    const answer = await get(`/api/v1/world-books/${encodeURIComponent(bookId)}?limit=${PAGE}&offset=0`, `asked about world book ${bookId}`, ask);
    if (answer.status === 404) return null;
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
