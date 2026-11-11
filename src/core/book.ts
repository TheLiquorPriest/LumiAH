// A story's book (DESIGN §23). LumiBooks, another extension, summarizes a chat's older messages into
// chapters, arcs that each sum up a run of chapters, and volumes that sum up arcs, and keeps them as
// the entries of a world book it makes for the chat. This reads those entries as a tree, each entry
// under the narrowest larger one that spans all of it, and works out how the book stands against
// the chat: which messages no entry covers, and which changed since they were summarized. All of it
// is worked out by code from the entries and the chat's path: nothing here asks a model, and
// nothing is written.
//
// LumiBooks keeps books of two kinds, and an entry of either reads here. Its own book for a chat
// names the messages an entry summarizes by id, with where they stood when it was written. A
// summaries lorebook it exports names them by their places in the chat, and keeps a hash of each.
// Where an entry has ids they are the truth, as LumiBooks itself takes them: the messages' places
// are read from the chat as it stands, since a message deleted before them moves every place after
// it, and the stored places stand in only when none of the ids is in the chat any more.

import type { BookEntry, BookMessageHash, ChatBook, HarnessHost, PathMessage } from "./ports";
import { errorText } from "./util";
import { shortIds } from "./views";

/** What an entry of the book is: a chapter sums up messages, an arc chapters, a volume arcs. */
export type BookLevel = "chapter" | "arc" | "volume";

/** An entry of the book, in its tree. */
export interface BookNode {
  /** The entry's id in its world book. */
  id: string;
  /** The id the tools show and take: the shortest start of `id` that names it alone in the book. */
  short: string;
  level: BookLevel;
  /** LumiBooks' label for it, less the messages the label counts; empty where it has none. */
  title: string;
  /**
   * The first and the last chat message it spans, by their numbers in the chat (`PathMessage.index`,
   * which the chat tools name a message by); null for an entry carried over from another chat, which
   * spans none of this one's.
   */
  span: [number, number] | null;
  /** Its text's length, in characters. */
  chars: number;
  /** The entries it sums up, in the chat's order. */
  children: BookNode[];
}

/** Some of the chat's messages: how many, and the runs they make, each from its first message's number to its last's, oldest first. */
export interface MessageRuns {
  count: number;
  runs: [number, number][];
}

/** How the book stands against the chat. */
export interface BookCoverage {
  /** How many messages the chat has. */
  messages: number;
  /** How many of them an entry covers, those that changed since among them. */
  covered: number;
  /** Those no entry covers: there the book is silent. */
  uncovered: MessageRuns;
  /**
   * Those that changed since they were summarized: there the book is out of date. Null where the
   * book kept no hash of any message, so a change can't be told (LumiBooks' own book for a chat
   * keeps none; a summaries lorebook does).
   */
  changed: MessageRuns | null;
}

/** A chat's book as the tools read it (`book_outline`, `book_read`). */
export interface Book {
  /** The top of the tree, in the chat's order: each entry holds the ones it sums up. */
  nodes: BookNode[];
  coverage: BookCoverage;
  /** Each entry's text, by its id. */
  contents: ReadonlyMap<string, string>;
}

/** How one message of the chat stands with the book. */
type MessageCover = "covered" | "changed" | "uncovered";

/** One entry as read: what the tree and the coverage are worked out from. */
interface BookRecord {
  id: string;
  /** LumiBooks' tier: 1 a chapter, 2 an arc, 3 and above a volume, each made of entries of the tier below. */
  tier: number;
  title: string;
  text: string;
  span: [number, number] | null;
  /** Where it sorts among the others: at its first message, or before every message for one carried over from another chat. */
  at: number;
  /** The ids of the messages it summarizes, where LumiBooks kept them and they can be this chat's. */
  msgIds: readonly string[];
}

/** The chat's numbers in an entry's label (`#4 - The Long Road (msgs 31-40)`), from 1: read only where the entry keeps neither ids nor places. */
const MSGS = /\bmsgs?\s+(\d+)\s*[-–]\s*(\d+)/i;

/**
 * Those numbers where they close a label. A title leaves them out: they count from 1, and beside a
 * span that counts from 0, as the chat tools do, they would read as other messages.
 */
const MSGS_NOTE = /\s*\(msgs?\s+\d+\s*[-–]\s*\d+\)\s*$/i;

/**
 * Where an entry's short id starts: a world book's ids are UUIDs, whose first group is eight
 * characters. Not a setting: the id grows from there until it names one entry of the book, so
 * nothing is limited by it.
 */
const SHORT_ID = 8;

/** A message's place in a chat as LumiBooks writes one: a whole number from 0. */
function isIndex(v: number | undefined): v is number {
  return typeof v === "number" && Number.isInteger(v) && v >= 0;
}

/** An entry's tier: the one LumiBooks wrote on it, else what its label opens with; null for an entry that is no part of the tree. */
function tierOf(entry: BookEntry, label: string): number | null {
  const tier = entry.extensions.lumibooks_summary?.tier ?? entry.extensions.lumibooks?.tier;
  if (typeof tier === "number" && Number.isInteger(tier) && tier >= 1) return tier;
  if (/^vol/i.test(label)) return 3;
  if (/^arc\b/i.test(label)) return 2;
  return /^#\d/.test(label) ? 1 : null;
}

/**
 * The messages an entry spans, by their numbers in the chat: where the messages it names by id stand
 * now; else the places its summaries lorebook keeps; else the first and last place its own book
 * stored; else the numbers in its label. Null when none of these places it.
 */
function spanOf(entry: BookEntry, label: string, at: ReadonlyMap<string, number>): [number, number] | null {
  const own = entry.extensions.lumibooks;
  const live = (own?.msgIds ?? []).flatMap((id) => at.get(id) ?? []);
  const places = live.length > 0 ? live : (entry.extensions.lumibooks_summary?.messageIndices ?? []).filter(isIndex);
  if (places.length > 0) return [places.reduce((a, b) => Math.min(a, b)), places.reduce((a, b) => Math.max(a, b))];
  const first = own?.firstMsgIdx;
  const last = own?.lastMsgIdx;
  if (isIndex(first) && isIndex(last) && first <= last) return [first, last];
  const counted = MSGS.exec(label);
  if (!counted) return null;
  const from = Number(counted[1]) - 1;
  const to = Number(counted[2]) - 1;
  return from >= 0 && from <= to ? [from, to] : null;
}

/**
 * One entry as the tree takes it; null for an entry that is no part of the tree: one LumiBooks
 * didn't write or has let go of, one it wrote for another chat (it passes over those itself), one
 * with no text, one whose messages can't be placed.
 */
function recordOf(entry: BookEntry, chatId: string, at: ReadonlyMap<string, number>): BookRecord | null {
  const label = entry.comment.trim();
  const text = entry.content.trim();
  const tier = tierOf(entry, label);
  const own = entry.extensions.lumibooks;
  if (text === "" || tier === null || (own?.chatId !== undefined && own.chatId !== chatId)) return null;
  const title = label.replace(MSGS_NOTE, "") || (own?.title ?? "").trim();
  // An entry carried over from another chat spans no message of this one. LumiBooks numbers those downwards from -1 where its own entries keep their messages' places, so they sort before every message, in their own order.
  if (own?.isRoot === true) return { id: entry.id, tier, title, text, span: null, at: typeof own.firstMsgIdx === "number" && own.firstMsgIdx < 0 ? own.firstMsgIdx : -1, msgIds: [] };
  const span = spanOf(entry, label, at);
  return span === null ? null : { id: entry.id, tier, title, text, span, at: span[0], msgIds: own?.msgIds ?? [] };
}

/**
 * How each message of the chat stands with the book: `covered` where LumiBooks' hash of it still
 * matches (or, in a book that keeps ids and no hashes, where an entry names it; in one that keeps
 * neither, where an entry spans it), `changed` where its hash no longer matches, `uncovered` where
 * nothing of the book reaches it.
 */
function coverOf(records: readonly BookRecord[], hashes: readonly BookMessageHash[], path: readonly PathMessage[]): MessageCover[] {
  const hashed = new Map(hashes.map((h) => [h.index, h]));
  const named = new Set(records.flatMap((r) => r.msgIds));
  // A book that keeps neither hashes nor ids says only how far its entries reach.
  const bySpan = hashed.size === 0 && named.size === 0;
  return path.map((m) => {
    const hash = hashed.get(m.index);
    if (hash) return hash.now === hash.kept ? "covered" : "changed";
    if (named.has(m.id)) return "covered";
    return bySpan && records.some((r) => r.span !== null && r.span[0] <= m.index && m.index <= r.span[1]) ? "covered" : "uncovered";
  });
}

/** The messages that stand one way with the book, as the runs they make in the chat. */
function runsOf(path: readonly PathMessage[], cover: readonly MessageCover[], which: MessageCover): MessageRuns {
  const runs: [number, number][] = [];
  let count = 0;
  path.forEach((m, i) => {
    if (cover[i] !== which) return;
    const last = runs.at(-1);
    if (last && cover[i - 1] === which) last[1] = m.index;
    else runs.push([m.index, m.index]);
    count++;
  });
  return { count, runs };
}

/** Each entry's parent in the tree: the narrowest entry of a higher tier that spans all of it. */
function parentsOf(records: readonly BookRecord[]): Map<string, string> {
  const parents = new Map<string, string>();
  for (const r of records) {
    const span = r.span;
    if (span === null) continue;
    let best: { id: string; tier: number; width: number } | null = null;
    for (const q of records) {
      if (q.span === null || q.tier <= r.tier || q.span[0] > span[0] || q.span[1] < span[1]) continue;
      const width = q.span[1] - q.span[0];
      if (best === null || width < best.width || (width === best.width && q.tier < best.tier)) best = { id: q.id, tier: q.tier, width };
    }
    if (best !== null) parents.set(r.id, best.id);
  }
  return parents;
}

/** The entries as a tree, in the chat's order: where two start at the same message, the larger leads, so each entry comes above the ones it sums up. */
function treeOf(records: readonly BookRecord[]): BookNode[] {
  const parents = parentsOf(records);
  const short = shortIds(records.map((r) => r.id), SHORT_ID);
  const nodes = new Map(records.map((r, i): [string, BookNode] => [r.id, { id: r.id, short: short[i] ?? r.id, level: r.tier >= 3 ? "volume" : r.tier === 2 ? "arc" : "chapter", title: r.title, span: r.span, chars: r.text.length, children: [] }]));
  const ordered = [...records].sort((a, b) => a.at - b.at || b.tier - a.tier || (a.span?.[1] ?? a.at) - (b.span?.[1] ?? b.at));
  const top: BookNode[] = [];
  for (const r of ordered) {
    const node = nodes.get(r.id);
    const parent = parents.get(r.id);
    const holder = parent === undefined ? undefined : nodes.get(parent);
    if (node) (holder?.children ?? top).push(node);
  }
  return top;
}

/**
 * The book the entries LumiBooks keeps for a chat make against the chat's path; null for a book with
 * no entry that is part of the tree: there is nothing in it to read.
 */
export function bookOf(chatId: string, stored: ChatBook, path: readonly PathMessage[]): Book | null {
  const at = new Map(path.map((m) => [m.id, m.index]));
  const records = stored.entries.flatMap((entry) => recordOf(entry, chatId, at) ?? []);
  if (records.length === 0) return null;
  const cover = coverOf(records, stored.hashes, path);
  return {
    nodes: treeOf(records),
    coverage: {
      messages: path.length,
      covered: cover.filter((c) => c !== "uncovered").length,
      uncovered: runsOf(path, cover, "uncovered"),
      changed: stored.hashes.length > 0 ? runsOf(path, cover, "changed") : null,
    },
    contents: new Map(records.map((r) => [r.id, r.text])),
  };
}

/**
 * A chat's book, read once for a run; null where there is none to read: the host has no `book`
 * port, the run has no chat, the chat has no book (or one with nothing in it yet), or the book
 * couldn't be read, in which case the run goes on without it.
 */
export async function readBook(host: Pick<HarnessHost, "book" | "chat" | "log">, chatId: string): Promise<Book | null> {
  if (!host.book || chatId === "") return null;
  try {
    const stored = await host.book.read(chatId);
    return stored === null ? null : bookOf(chatId, stored, await host.chat.path(chatId));
  } catch (error) {
    host.log("warn", `[LumiAH] the LumiBooks book of chat ${chatId} couldn't be read (${errorText(error)}): the run goes on without it`);
    return null;
  }
}
