// The story as a table of contents (DESIGN §24.4: chat_outline): parts of the chat, each with the
// messages it spans, so an agent finds where in a long chat something is before it reads any of it.
//
// It is read from the first source there is. The chat's book (§23) is a tree of volumes, arcs and
// chapters that LumiBooks wrote; the arcs of Lumiverse's memory make the same kind of tree; and
// where a chat has neither, a skeleton is worked out from the messages themselves: a stretch ends
// at a long gap in time or when it is long enough, and says who speaks in it and how it opens.
// Messages a tree doesn't cover are outlined by the skeleton too, so an outline always covers the
// whole range it was asked for. Nothing here asks a model.
//
// The same parts say where a reader's stretch ends (§24.7): a long chat is learned a stretch at a
// time, each read by an agent with a session of its own, and the cut is made here, in the size
// Settings give, so that no model does that arithmetic (`stretchesOf`).

import type { BookNode } from "../book";
import { excerptOf } from "../lexical";
import type { Settings } from "../settings";
import { TEXT, type Texts } from "../texts";
import { clip } from "../util";
import { spanText, whenText } from "./answers";
import { type ChatDoc, type ChatRun, speakersOf } from "./chat";
import type { MemoryArc } from "./ports";
import type { RecallRun } from "./recall";

/** Where an outline comes from. */
export type OutlineSource = "book" | "arcs" | "skeleton";

/** An entry of the tree an outline is read from: an entry of the chat's book, or an arc of Lumiverse's memory, with the entries it sums up. */
export interface OutlineNode {
  /** The first and the last message it spans, by their numbers in the chat. */
  from: number;
  to: number;
  what: { book: BookNode } | { arc: MemoryArc };
  children: OutlineNode[];
}

/** Messages no listed entry sums up, as a part of the skeleton: by their places among the run's messages, from `start` up to `end`, with how many stretches they are. One of more than one stretch opens into them. */
export interface OutlineRun {
  start: number;
  end: number;
  stretches: number;
}

/** A part of an outline: an entry of the tree, or a run of messages worked out from the chat itself. */
export type OutlinePart = { node: OutlineNode } | OutlineRun;

export interface Outline {
  source: OutlineSource;
  /** The messages outlined, by their places among the run's: from `start` up to `end`. */
  start: number;
  end: number;
  /** Its parts, in chat order. */
  parts: OutlinePart[];
  /** Nothing in it opens further: it is one stretch, with no entry under it. */
  leaf: boolean;
}

/**
 * How many of a part's speakers its line names: the three who speak most. Fixed, not a setting: it
 * shapes one line, whose length Line length already bounds, and a fourth voice says little of where
 * in the story a part is.
 */
const SPEAKERS = 3;

/**
 * The fewest parts a run of messages is merged into, whatever Hits per page says. Fixed, not a
 * setting: a part of several stretches must open into more than itself, or opening it would answer
 * with the same part for ever.
 */
const PARTS_LEAST = 2;

// ---------------------------------------------------------------- the skeleton

/** The stretches of the skeleton among the messages from `start` up to `end`, each from its first message's place up to the place after its last: one ends where the next message was sent more than `gap` milliseconds later (where the host gives times), or when it holds `most` messages. */
function skeletonOf(messages: readonly ChatDoc[], start: number, end: number, gap: number, most: number): [start: number, end: number][] {
  const out: [number, number][] = [];
  let from = start;
  for (let i = start + 1; i <= end; i++) {
    const before = messages[i - 1];
    const next = i < end ? messages[i] : undefined;
    const apart = before !== undefined && next !== undefined && before.at !== null && next.at !== null && next.at - before.at > gap;
    if (next !== undefined && !apart && i - from < most) continue;
    out.push([from, i]);
    from = i;
  }
  return out;
}

/** Stretches as parts, no more than `most` of them: where there are more, neighbours are merged so that each part holds about as many messages as the others. */
function mergedTo(stretches: readonly [number, number][], most: number): OutlineRun[] {
  const first = stretches[0];
  const last = stretches.at(-1);
  if (!first || !last || stretches.length <= most) return stretches.map(([start, end]) => ({ start, end, stretches: 1 }));
  const endOf = (i: number): number => (stretches[i] ?? last)[1];
  const parts: OutlineRun[] = [];
  let at = 0;
  for (let i = 0; i < most; i++) {
    // Where this part would end were every part the same size.
    const even = first[0] + ((last[1] - first[0]) * (i + 1)) / most;
    let next = at + 1;
    // It takes stretches while one more brings its end no further from there, and leaves one for each part still to come.
    while (next < stretches.length - (most - i - 1) && Math.abs(endOf(next) - even) <= Math.abs(endOf(next - 1) - even)) next++;
    parts.push({ start: (stretches[at] ?? first)[0], end: endOf(next - 1), stretches: next - at });
    at = next;
  }
  return parts;
}

// ---------------------------------------------------------------- the tree

/** The book's entries as an outline reads them. An entry carried over from another chat spans none of this one's messages, and is no part of its outline. */
function bookNodes(nodes: readonly BookNode[]): OutlineNode[] {
  return nodes.flatMap((book): OutlineNode[] => (book.span === null ? [] : [{ from: book.span[0], to: book.span[1], what: { book }, children: bookNodes(book.children) }]));
}

/**
 * The arcs of Lumiverse's memory as a tree, in the chat's order: each under the narrowest arc of a
 * higher tier that spans all of it, as the book's entries stand under each other. An arc the host
 * can't place in the chat is left out.
 */
function arcNodes(arcs: readonly MemoryArc[]): OutlineNode[] {
  const placed = arcs.flatMap((arc) => (arc.span === null ? [] : [{ tier: arc.tier, node: { from: arc.span[0], to: arc.span[1], what: { arc }, children: [] } as OutlineNode }]));
  // Where two start at the same message the larger leads, so each arc comes above the ones it sums up.
  placed.sort((a, b) => a.node.from - b.node.from || b.tier - a.tier || a.node.to - b.node.to);
  const top: OutlineNode[] = [];
  for (const one of placed) {
    let holder: (typeof placed)[number] | null = null;
    for (const other of placed) {
      if (other.tier <= one.tier || other.node.from > one.node.from || other.node.to < one.node.to) continue;
      const width = other.node.to - other.node.from;
      const held = holder === null ? Number.POSITIVE_INFINITY : holder.node.to - holder.node.from;
      if (holder === null || width < held || (width === held && other.tier < holder.tier)) holder = other;
    }
    (holder?.node.children ?? top).push(one.node);
  }
  return top;
}

/** The entries that span a message of the run's, each with those under it that do: an entry of messages the run doesn't read outlines nothing for it. */
function reaching(chat: ChatRun, nodes: readonly OutlineNode[]): OutlineNode[] {
  return nodes.flatMap((node): OutlineNode[] => (chat.place(node.to + 1) > chat.place(node.from) ? [{ ...node, children: reaching(chat, node.children) }] : []));
}

/** The tree an outline of the run's chat is read from: the book's where the chat has one, else the arcs' where Lumiverse's memory has made some, else none. */
async function treeOf(run: RecallRun, chat: ChatRun): Promise<{ source: OutlineSource; top: OutlineNode[] }> {
  const { book } = run.env;
  const entries = book ? reaching(chat, bookNodes(book.nodes)) : [];
  if (entries.length > 0) return { source: "book", top: entries };
  const arcs = reaching(chat, arcNodes(await run.arcs()));
  return arcs.length > 0 ? { source: "arcs", top: arcs } : { source: "skeleton", top: [] };
}

// ---------------------------------------------------------------- an outline

/**
 * The outline of the run's messages from place `start` up to `end` (at least one message). Not
 * `opened` (the call named no range): the top of the tree. Opened: the entries inside the range,
 * and where one entry spans all of it, the entries under that one instead, as far down as that
 * holds. Messages no listed entry covers are outlined by the skeleton, in their place among the
 * entries. An entry with nothing under it opens into the skeleton's stretches, where it is more
 * than one.
 */
export async function outlineOf(run: RecallRun, chat: ChatRun, range: { start: number; end: number; opened: boolean }): Promise<Outline> {
  const { settings } = run.env;
  const { start, end } = range;
  const { source, top } = await treeOf(run, chat);
  const gap = Math.max(0, settings.recall.chat.gapMinutes) * 60_000;
  const most = Math.max(1, settings.recall.chat.stretchMessages);
  const listed = Math.max(PARTS_LEAST, settings.tools.pageItems);
  const bones = (from: number, to: number): OutlineRun[] => mergedTo(skeletonOf(chat.messages, from, to, gap, most), listed);
  const whole = bones(start, end);
  // The range is one stretch of the skeleton: only an entry of the tree could be smaller.
  const single = whole.length === 1 && whole[0]?.stretches === 1;
  const low = chat.messages[start]?.index ?? 0;
  const high = chat.messages[end - 1]?.index ?? low;
  let level = top;
  while (range.opened) {
    const spanning = level.filter((node) => node.from <= low && node.to >= high);
    const [one] = spanning;
    if (spanning.length !== 1 || !one) break;
    // Nothing under it: what is smaller is the chat's own stretches, where the range is more than one.
    if (one.children.length === 0) return single ? { source, start, end, parts: [{ node: one }], leaf: true } : { source, start, end, parts: whole, leaf: false };
    level = one.children;
  }
  const parts: OutlinePart[] = [];
  let at = start;
  for (const node of level) {
    if (node.to < low || node.from > high) continue;
    const from = Math.max(start, chat.place(node.from));
    if (from > at) parts.push(...bones(at, from));
    parts.push({ node });
    at = Math.max(at, Math.min(end, chat.place(node.to + 1)));
  }
  if (at < end) parts.push(...bones(at, end));
  const [only] = parts;
  // One part alone opens no further where the range is one stretch and no entry stands under it.
  const leaf = single && parts.length === 1 && only !== undefined && (!("node" in only) || only.node.children.length === 0);
  return { source, start, end, parts, leaf };
}

// ---------------------------------------------------------------- the stretches readers are given

/** A stretch of the chat as one reader is given it (§24.7): its first and its last message by their numbers, how many messages it holds and how long they are together. */
export interface Stretch {
  from: number;
  to: number;
  messages: number;
  chars: number;
}

/** Where the story's parts begin, each by the number of its first message. A number no message has stands for the next message there is; one past the last message begins nothing. */
export interface StretchParts {
  /** The top-level parts: no stretch holds messages of two of them. */
  top?: readonly number[];
  /** The parts under those: a stretch that is full ends where one of them begins late in it. */
  inner?: readonly number[];
}

/**
 * How late in a full stretch a smaller part must begin for the stretch to end there: in its last
 * third, counted in messages. Fixed, not a setting: how much a reader is given is the user's
 * (Messages per reader, Text per reader), and this only picks where under that size a stretch ends.
 * Earlier than that, stretches would come out half empty for readers that each cost a session.
 */
const LAST_SHARE = 3;

const NOTHING = 0;
const INNER = 1;
const TOP = 2;

/** The place of the first of `messages` (oldest first) whose number is `index` or more; their count where none is. */
function placeOf(messages: readonly { index: number }[], index: number): number {
  let low = 0;
  let high = messages.length;
  while (low < high) {
    const mid = (low + high) >> 1;
    if ((messages[mid]?.index ?? index) < index) low = mid + 1;
    else high = mid;
  }
  return low;
}

/**
 * `messages` (oldest first, each with its number and its length) cut into stretches, in order:
 * consecutive messages are packed until the next would pass `most.messages` or `most.chars`. Every
 * message is in exactly one stretch, and one longer than `most.chars` is a stretch of its own. A
 * stretch stops before a top-level part of `parts` begins; one that stopped for its size ends
 * instead where the last smaller part to begin in its last third begins, so that stretches end
 * where the story's parts do. It reads no text: a message's length is given.
 */
export function stretchesOf(messages: readonly { index: number; chars: number }[], most: { messages: number; chars: number }, parts: StretchParts = {}): Stretch[] {
  const count = messages.length;
  // What begins at each place: nothing, a smaller part, or a top-level one.
  const begins = new Uint8Array(count);
  const mark = (numbers: readonly number[] | undefined, kind: number): void => {
    for (const number of numbers ?? []) {
      const place = placeOf(messages, number);
      if (place < count && (begins[place] ?? NOTHING) < kind) begins[place] = kind;
    }
  };
  mark(parts.inner, INNER);
  mark(parts.top, TOP);
  const size = (place: number): number => messages[place]?.chars ?? 0;
  const out: Stretch[] = [];
  let start = 0;
  while (start < count) {
    // Its first message is taken whatever its length, or one too long for any stretch would be in none.
    let end = start + 1;
    let chars = size(start);
    while (end < count && begins[end] !== TOP && end - start < most.messages && chars + size(end) <= most.chars) chars += size(end++);
    // It stopped for its size, in the middle of a part: it gives back the messages after the last part's start in its last third.
    if (end < count && begins[end] === NOTHING) {
      const least = start + Math.max(1, Math.ceil(((end - start) * (LAST_SHARE - 1)) / LAST_SHARE));
      let at = end - 1;
      while (at >= least && begins[at] === NOTHING) at--;
      if (at >= least) {
        for (let i = at; i < end; i++) chars -= size(i);
        end = at;
      }
    }
    const first = messages[start];
    const last = messages[end - 1];
    if (first && last) out.push({ from: first.index, to: last.index, messages: end - start, chars });
    start = end;
  }
  return out;
}

/** The size of a reader's stretch, as Settings give it: one message and one character at least. */
function readerSize(settings: Readonly<Settings>): { messages: number; chars: number } {
  const { stretchMessages, stretchChars } = settings.recall.chronicle;
  return { messages: Math.max(1, stretchMessages), chars: Math.max(1, stretchChars) };
}

/**
 * The run's messages from place `start` up to `end` cut into the stretches readers are given, in
 * Settings' size. The parts they keep to are the outline's: no stretch crosses the edge of an entry
 * at the top of the chat's book, or of the arcs where it has no book; the entries under those end
 * a stretch that is nearly full, and so do the long gaps in time among messages no entry covers,
 * where the skeleton breaks. That the skeleton also ends a part when it is long enough, and merges
 * parts to fit a page, binds nothing here: those sizes are the outline's, not the story's.
 */
export async function readerStretches(run: RecallRun, chat: ChatRun, range: { start: number; end: number }): Promise<Stretch[]> {
  const { settings } = run.env;
  const { top } = await treeOf(run, chat);
  const inner: number[] = [];
  const under = (nodes: readonly OutlineNode[]): void => {
    for (const node of nodes) {
      inner.push(node.from, node.to + 1);
      under(node.children);
    }
  };
  for (const node of top) under(node.children);
  const covered = new Uint8Array(chat.messages.length);
  for (const node of top) covered.fill(1, chat.place(node.from), chat.place(node.to + 1));
  const gap = Math.max(0, settings.recall.chat.gapMinutes) * 60_000;
  const sized: { index: number; chars: number }[] = [];
  for (let i = range.start; i < range.end; i++) {
    const doc = chat.messages[i];
    if (!doc) continue;
    const before = i > range.start ? chat.messages[i - 1] : undefined;
    if (before && covered[i] !== 1 && before.at !== null && doc.at !== null && doc.at - before.at > gap) inner.push(doc.index);
    // The length of the text the run reads, which the chat's path gives as well: nothing is read for it.
    sized.push({ index: doc.index, chars: doc.text.length });
  }
  return stretchesOf(sized, readerSize(settings), { top: top.flatMap((node) => [node.from, node.to + 1]), inner });
}

/** A count as an answer writes it, its thousands set apart: a model reads "34,200" for what it is sooner than "34200". */
const grouped = (n: number): string => String(n).replace(/\B(?=(\d{3})+$)/g, ",");

/** What heads the stretches: how many there are, and the size none of them passes. */
export function stretchesHead(texts: Texts, settings: Readonly<Settings>, count: number): string {
  const size = readerSize(settings);
  return texts.render(TEXT.recall.answer.outlineStretches, { count: texts.counted(count, TEXT.recall.word.stretch), messages: texts.counted(size.messages, TEXT.recall.word.message), chars: grouped(size.chars) });
}

/** One stretch, on one line: its messages, how many they are and how long together. */
export function stretchLine(texts: Texts, stretch: Stretch): string {
  return texts.render(TEXT.recall.answer.outlineStretch, { span: spanText(texts, stretch.from, stretch.to), messages: texts.counted(stretch.messages, TEXT.recall.word.message), chars: grouped(stretch.chars) });
}

// ---------------------------------------------------------------- an outline's answer

const SOURCE: Record<OutlineSource, string> = { book: TEXT.recall.answer.outlineBook, arcs: TEXT.recall.answer.outlineArcs, skeleton: TEXT.recall.answer.outlineSkeleton };

/** What heads an outline: where it comes from, the messages it covers and how many parts it lists. */
export function outlineHead(texts: Texts, chat: ChatRun, outline: Outline): string {
  const first = chat.messages[outline.start];
  const last = chat.messages[outline.end - 1];
  return texts.render(TEXT.recall.answer.outline, {
    source: texts.render(SOURCE[outline.source]),
    span: first && last ? spanText(texts, first.index, last.index) : texts.render(TEXT.recall.none),
    count: texts.counted(outline.end - outline.start, TEXT.recall.word.message),
    parts: texts.counted(outline.parts.length, TEXT.recall.word.part),
  });
}

/** How a text opens, on one line, `max` characters at most. */
function opening(text: string, max: number): string {
  const from = text.trimStart();
  return excerptOf(from, { start: 0, end: from.length }, max);
}

/** One part of an outline, on one line: an entry with its title and how its summary is read, or a run of messages with who speaks in it and how it opens. */
export function partLine(texts: Texts, chat: ChatRun, part: OutlinePart, settings: Readonly<Settings>): string {
  const { lineChars } = settings.tools;
  const { openingChars } = settings.recall.chat;
  const A = TEXT.recall.answer;
  if ("node" in part) {
    const { node } = part;
    const start = chat.place(node.from);
    const end = chat.place(node.to + 1);
    const first = chat.messages[start];
    const last = chat.messages[end - 1];
    const spanned = { span: spanText(texts, node.from, node.to), when: first && last ? whenText(texts, first.at, last.at) : "", messages: texts.counted(end - start, TEXT.recall.word.message) };
    if ("book" in node.what) {
      const { book } = node.what;
      return texts.render(A.outlineNode, { ...spanned, kind: texts.noun(1, TEXT.book.level[book.level]), title: book.title === "" ? texts.render(TEXT.book.untitled) : clip(book.title, lineChars), read: texts.render(A.outlineNodeBook, { id: book.short }) });
    }
    const { arc } = node.what;
    const summary = opening(arc.summary, openingChars);
    const title = arc.title === null ? "" : clip(arc.title, lineChars);
    // An arc without a title is named by how its summary opens, which is then said once.
    return texts.render(A.outlineNode, { ...spanned, kind: texts.noun(1, TEXT.recall.word.arc), title: title === "" ? summary : title, read: title === "" || summary === "" ? "" : texts.render(A.outlineNodeArc, { summary }) });
  }
  const docs = chat.messages.slice(part.start, part.end);
  const first = docs[0];
  const last = docs.at(-1);
  if (!first || !last) return "";
  const speakers = speakersOf(docs).slice(0, SPEAKERS);
  return texts.render(A.outlinePart, {
    span: spanText(texts, first.index, last.index),
    when: whenText(texts, first.at, last.at),
    messages: texts.counted(docs.length, TEXT.recall.word.message),
    chars: String(docs.reduce((n, doc) => n + doc.text.length, 0)),
    who: clip(speakers.map(([who, n]) => `${who} (${n})`).join(", "), lineChars),
    opening: opening(first.text, openingChars),
  });
}
