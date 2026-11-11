// How the tools of §24 answer (DESIGN §4.3, §24.6), in one place so they answer alike: a call may
// carry several queries or several ids; each query is answered on its own, within its share of one
// page; a call of one query pages by cursor; several texts are read in one call, a page at a time;
// and a line is found by exact text or by a pattern that can't hold the process: only patterns of
// a class that cannot run away are run, a line is matched in pieces of bounded length, and a search
// gives way between pieces and stops at its time. Everything stays within Answer length, whatever
// the call's arguments are.

import type { ShownLine } from "../lexical";
import type { ClockPort, JsonObject } from "../ports";
import type { Settings } from "../settings";
import { TEXT, type Texts } from "../texts";
import type { ToolOutcome } from "../tools";
import { badCursor, type Pager, pageEnd, readCursor, saidBack } from "../tools/paging";
import { clip, cutAt, textArg } from "../util";

// ---------------------------------------------------------------- arguments

/** The texts an argument names: a list of them, or one alone; trimmed, blanks left out, each once. */
export function listArg(value: unknown): string[] {
  const given = Array.isArray(value) ? value : [value];
  const out: string[] = [];
  for (const one of given) {
    const text = typeof one === "number" && Number.isFinite(one) ? String(one) : textArg(one);
    if (text !== null && !out.includes(text)) out.push(text);
  }
  return out;
}

/**
 * What a call names under `key` (a list), or under `alone` (one, as a model writes it when it has
 * one): the first `most` of them to work on, and the rest, which the answer says weren't run.
 */
export function namedArgs(args: JsonObject, key: string, alone: string, most: number): { named: string[]; rest: string[] } {
  const all = listArg(args[key]);
  for (const one of listArg(args[alone])) if (!all.includes(one)) all.push(one);
  const limit = Math.max(1, most);
  return { named: all.slice(0, limit), rest: all.slice(limit) };
}

/** What follows an answer to a call that named more than one call carries: the limit, and what wasn't run. Empty where everything was. */
export function restNote(p: Pager, limit: number, rest: readonly string[]): string {
  if (rest.length === 0) return "";
  const said = (list: string): string => p.texts.render(TEXT.recall.answer.tooMany, { limit: String(limit), rest: list });
  return said(clip(rest.join("; "), Math.max(1, Math.min(p.lineChars, p.pageChars - said("").length))));
}

// ---------------------------------------------------------------- words every answer uses

/** A run of chat messages as the answers write it: "#3 to #40", or "#52" for one. */
export function spanText(texts: Texts, from: number, to: number): string {
  return from === to ? texts.render(TEXT.recall.message, { index: String(from) }) : texts.render(TEXT.recall.span, { from: String(from), to: String(to) });
}

/** A moment as the answers write it, in UTC: its day (`2026-03-04`), and its time to the minute where `time` asks. */
export function dateText(at: number, time: boolean): string {
  const iso = new Date(at).toISOString();
  return time ? `${iso.slice(0, 10)} ${iso.slice(11, 16)}` : iso.slice(0, 10);
}

/**
 * When a message was sent, as it follows who wrote it: its day and time; for a run of messages
 * (`to`), the day it starts and, where it ends on another, the day it ends. Empty where the host
 * gave no time.
 */
export function whenText(texts: Texts, at: number | null, to?: number | null): string {
  if (at === null) return "";
  if (to === undefined) return texts.render(TEXT.recall.when, { date: dateText(at, true) });
  const first = dateText(at, false);
  const last = to === null ? first : dateText(to, false);
  return texts.render(TEXT.recall.when, { date: first === last ? first : `${first} to ${last}` });
}

/** A search hit's best lines, one under the other, each with its number in the text. */
export function hitLines(texts: Texts, lines: readonly ShownLine[]): string {
  return lines.map((line) => texts.render(TEXT.recall.answer.hitLine, { line: String(line.line), text: line.text })).join("\n");
}

/**
 * How long each of a hit's best lines may be, so that a hit's lines together stay within Excerpt
 * length. Never under forty characters, however many lines Settings show of a hit: a shorter line
 * holds a word or two and tells nothing of what was found. Fixed, not a setting: it is the least a
 * line is worth showing at, and what bounds a hit's lines is the setting (Excerpt length).
 */
export function lineRoom(excerptChars: number, lines: number): number {
  return Math.max(40, Math.floor(excerptChars / Math.max(1, lines)));
}

// ---------------------------------------------------------------- a search of several queries

/** One query's part of a search's answer. */
export interface QueryPart {
  query: string;
  /** How many items it found: entries, stretches of the chat, documents. */
  total: number;
  /** Its heading, saying which of its items are shown, counted from 1. */
  head(from: number, to: number): string;
  /** One item, on one line or several. */
  item(i: number): string;
  /** What it says where it found nothing: what to try next. */
  nothing: string;
}

/** Items from `start` while they fit `room` characters and `most` items: the lines, and the item the next page starts with. One too long for a page of its own is cut, and says so. */
function fill(p: Pager, part: QueryPart, start: number, room: number, most: number): { lines: string[]; next: number } {
  const lines: string[] = [];
  let used = 0;
  let i = start;
  for (; i < part.total && lines.length < most; i++) {
    const item = part.item(i);
    if (used + item.length + 1 > room) {
      if (lines.length > 0) break;
      const frame = p.texts.render(TEXT.answer.cut, { text: "" }).length;
      lines.push(p.texts.render(TEXT.answer.cut, { text: item.slice(0, cutAt(item, Math.max(1, room - frame))) }));
      i++;
      break;
    }
    lines.push(item);
    used += item.length + 1;
  }
  return { lines, next: i };
}

/**
 * A search's answer. One query pages by cursor, as every listing does: its heading, its items from
 * the cursor on, and the cursor for the rest. Several queries are each answered on their own within
 * an equal share of the page: its heading and its best items, and how many more there are, which a
 * call of that query alone pages through. `tail` follows (what wasn't run, that search is by word):
 * it is counted in the page.
 */
export function searchAnswer(p: Pager, args: JsonObject, parts: readonly QueryPart[], tail: readonly string[] = []): ToolOutcome {
  const cursor = readCursor(p, args);
  if ("text" in cursor) return cursor;
  const notes = tail.filter((note) => note !== "");
  const noted = notes.reduce((n, note) => n + note.length + 1, 0);
  const [only] = parts;
  if (parts.length === 1 && only) {
    if (only.total === 0) return { text: [clip(only.nothing, Math.max(1, p.pageChars - noted)), ...notes].join("\n") };
    if (cursor.within !== 0 || cursor.at >= only.total) return badCursor(p, args.cursor);
    const more = (next: string): string => p.texts.render(TEXT.answer.more, { tool: p.tool, cursor: next });
    const room = Math.max(1, p.pageChars - noted - only.head(only.total, only.total).length - Math.max(more(String(only.total)).length, p.texts.render(TEXT.answer.end).length) - 2);
    const { lines, next } = fill(p, only, cursor.at, room, p.pageItems);
    const footer = next < only.total ? more(String(next)) : cursor.given ? p.texts.render(TEXT.answer.end) : "";
    return { text: [only.head(cursor.at + 1, next), ...lines, ...(footer === "" ? [] : [footer]), ...notes].join("\n") };
  }
  // A cursor reads on in one query's hits: several queries have none to read on from.
  if (cursor.given) return badCursor(p, args.cursor);
  const share = Math.max(1, Math.floor((p.pageChars - noted) / Math.max(1, parts.length)) - 1);
  const most = Math.max(1, Math.floor(p.pageItems / Math.max(1, parts.length)));
  const said = parts.map((part) => {
    if (part.total === 0) return clip(part.nothing, share);
    const rest = (count: number): string => p.texts.render(TEXT.recall.answer.queryMore, { count: String(count), tool: p.tool });
    const { lines, next } = fill(p, part, 0, Math.max(1, share - part.head(part.total, part.total).length - rest(part.total).length - 2), most);
    // A share shorter than a part's own lines (a short page carrying many queries) still holds the part's start: the page keeps its length.
    return clip([part.head(1, next), ...lines, ...(next < part.total ? [rest(part.total - next)] : [])].join("\n"), share);
  });
  return { text: [...said, ...notes].join("\n") };
}

// ---------------------------------------------------------------- several texts read in one call

/** A text to read: the number a cursor names it by (a message's number, an entry's place in the call), its text, and how a part of it is framed. */
export interface ReadItem {
  key: number;
  text: string;
  frame(part: { from: number; to: number; text: string }): string;
}

/**
 * Several texts read in one call, a page at a time: each framed, whole while the page has room, and
 * a cursor (`key:offset`) that reads on inside the text the page ended in. `lead` heads every page;
 * `tail` follows the last text of a page and is counted in it.
 */
export function readAnswer(p: Pager, args: JsonObject, items: readonly ReadItem[], lead: string, tail: readonly string[] = []): ToolOutcome {
  const given = readCursor(p, args);
  if ("text" in given) return given;
  const start = given.given ? items.findIndex((item) => item.key === given.at) : 0;
  if (start < 0 || given.within > (items[start]?.text.length ?? 0)) return badCursor(p, args.cursor);
  const notes = tail.filter((note) => note !== "");
  const more = (cursor: string): string => p.texts.render(TEXT.answer.more, { tool: p.tool, cursor });
  const longest = items.reduce((n, item) => Math.max(n, item.text.length), 0);
  const widest = items.reduce((n, item) => Math.max(n, item.key), 0);
  const room = Math.max(1, p.pageChars - lead.length - more(`${widest}:${longest}`).length - notes.reduce((n, note) => n + note.length + 1, 0) - 2);
  const shown: string[] = [];
  let used = 0;
  let next: string | null = null;
  let offset = given.within;
  for (let i = start; i < items.length; i++) {
    const item = items[i] as ReadItem;
    const left = room - used - item.frame({ from: item.text.length, to: item.text.length, text: "" }).length - 2;
    // A text that doesn't fit after the ones before it starts the next page.
    if (left < 1 && shown.length > 0) {
      next = `${item.key}:${offset}`;
      break;
    }
    const end = pageEnd(item.text, offset, Math.max(1, left));
    const part = item.frame({ from: offset, to: end, text: item.text.slice(offset, end) });
    shown.push(part);
    used += part.length + 2;
    if (end < item.text.length) {
      next = `${item.key}:${end}`;
      break;
    }
    offset = 0;
  }
  const footer = next !== null ? more(next) : given.given ? p.texts.render(TEXT.answer.end) : "";
  return { text: [lead, shown.join("\n\n"), footer, ...notes].filter((part) => part !== "").join("\n") };
}

// ---------------------------------------------------------------- lines found by text or by pattern
//
// A pattern comes from a model, and a regular expression can take longer than the universe has on
// a line of ordinary text. Three things keep a search from holding the process, each alone enough
// for most patterns and all three together for any:
// 1. Only patterns of a class that cannot run away are compiled (`refusedPattern`).
// 2. A pattern is matched against a piece of a line of bounded length (`Settings.recall.grep`), so
//    one match is bounded whatever the text is.
// 3. A search gives way between pieces, so a Stop and the clock can act, and stops with a plain
//    answer once it has taken longer than Settings allow (`grepTexts`).

/** Where a piece of a line holds what a grep looks for: where in the line it starts, and how long it is. */
export interface LineFound {
  at: number;
  length: number;
}

/** What a grep looks for, as a test of one line a piece at a time. */
export interface LineMatch {
  /** In how many pieces a line is searched: one, unless a pattern meets a line longer than a piece. */
  pieces(line: string): number;
  /** Where piece `n` of the line (from 0) holds it; null where that piece doesn't. */
  find(line: string, n: number): LineFound | null;
}

/**
 * How many ways the optional and bounded parts of a pattern may combine beside its one repeat
 * without bound, at most. Fixed, not a setting: it is part of what the class of patterns is. With
 * it, a piece of the default length (2,000 characters) is matched in a few milliseconds as a rule
 * and in about a tenth of a second at the very worst (measured: a pattern at this bound on the text
 * that is worst for it), which is what the settings (the piece's length, and how long a search
 * works before it gives way) rest on. Sixty-four lets a pattern hold five alternatives before a
 * `.*` and five after it, or six optional characters; more multiplies the work of every piece.
 */
const WAYS_MOST = 64;

/**
 * An upper bound on the ways a part of a pattern can match from one place: `factor` times the
 * piece's length to the power `runs`, the repeats without bound (`*`, `+`, `{n,}`) one way through
 * it holds.
 */
interface Ways {
  runs: number;
  factor: number;
}

/** A repeat as written after what it repeats (`*`, `+`, `?`, `{n}`, `{n,}`, `{n,m}`), read at `at`: how many characters it takes, and how many ways it gives one character or class. Null where no repeat stands there. */
function repeatAt(pattern: string, at: number): { chars: number; ways: Ways } | null {
  const c = pattern[at];
  let found: { chars: number; ways: Ways } | null = null;
  if (c === "*" || c === "+") found = { chars: 1, ways: { runs: 1, factor: 1 } };
  else if (c === "?") found = { chars: 1, ways: { runs: 0, factor: 2 } };
  else if (c === "{") {
    // At most nine digits a number: a count a JavaScript number holds, read in one pass.
    const m = /^\{(\d{1,9})(?:(,)(\d{0,9}))?\}/.exec(pattern.slice(at, at + 24));
    if (m) {
      const least = Number(m[1]);
      const ways: Ways = m[2] === undefined ? { runs: 0, factor: 1 } : m[3] === "" || m[3] === undefined ? { runs: 1, factor: 1 } : { runs: 0, factor: Math.max(1, Number(m[3]) - least + 1) };
      found = { chars: m[0].length, ways };
    }
  }
  // A `?` after a repeat makes it take as little as it can: the ways are the same.
  return found && pattern[at + found.chars] === "?" ? { ...found, chars: found.chars + 1 } : found;
}

/**
 * Why a regular expression is refused before it is compiled, as a text id; null where it may run.
 * The patterns let through are a class that cannot run away on a piece of bounded length:
 * - no back-reference and no look-behind;
 * - a repeat (`*`, `+`, `{n}`, `{n,}`, `{n,m}`) follows one character, escape or class, never a group:
 *   so no group or alternation is under a repeat, and no repeat is repeated. A group may be
 *   optional (`(?:the )?`), which is a choice of two and no repeat;
 * - in each alternative at most one repeat without bound, and beside it no more optional and bounded
 *   parts than combine in `WAYS_MOST` ways; without one, no more than combine in as many ways as
 *   that repeat would give (`WAYS_MOST` times the piece's length).
 * What the engine then does from one place of a piece is bounded by those ways, so a piece is
 * matched in time that grows with the square of its length at worst, and the piece's length is a
 * setting. The bound is counted on the pattern's text alone, in one pass; a pattern the engine
 * itself can't compile is refused there, with the engine's words.
 */
function refusedPattern(pattern: string, pieceChars: number): string | null {
  const A = TEXT.recall.answer;
  let at = 0;
  // Why it is refused, the first reason found; the pattern is read to its end all the same.
  const refusals: string[] = [];

  /** The alternatives from `at` up to the group's end or the pattern's: as many ways as they have together. */
  const alternatives = (): Ways => {
    const all: Ways = { runs: 0, factor: 0 };
    for (;;) {
      const one = sequence();
      all.runs = Math.max(all.runs, one.runs);
      all.factor += one.factor;
      if (pattern[at] !== "|") return all;
      at++;
    }
  };

  /** One alternative: its parts one after the other, whose ways multiply. */
  const sequence = (): Ways => {
    const all: Ways = { runs: 0, factor: 1 };
    while (at < pattern.length && pattern[at] !== "|" && pattern[at] !== ")") {
      const one = part();
      all.runs += one.runs;
      all.factor *= one.factor;
    }
    return all;
  };

  /** One character, escape, class or group, with the repeat that follows it. */
  const part = (): Ways => {
    const c = pattern[at];
    let inner: Ways | null = null;
    if (c === "\\") {
      const next = pattern[at + 1] ?? "";
      if ((next >= "1" && next <= "9") || (next === "k" && pattern[at + 2] === "<")) refusals.push(A.patternBack);
      at += 2;
      // `\p{…}`, `\P{…}` and `\u{…}` carry braces that are no repeat.
      if ((next === "p" || next === "P" || next === "u") && pattern[at] === "{") {
        const end = pattern.indexOf("}", at);
        at = end < 0 ? pattern.length : end + 1;
      }
    } else if (c === "[") {
      // A class holds no repeat and no group: to its end.
      for (at++; at < pattern.length && pattern[at] !== "]"; at++) if (pattern[at] === "\\") at++;
      at++;
    } else if (c === "(") {
      at++;
      if (pattern[at] === "?") {
        const kind = pattern.slice(at + 1, at + 3);
        if (kind === "<=" || kind === "<!") refusals.push(A.patternBack);
        // `(?:`, `(?=`, `(?!` open with two characters; a named group with its name.
        if (kind[0] === "<" && kind !== "<=" && kind !== "<!") {
          const end = pattern.indexOf(">", at);
          at = end < 0 ? pattern.length : end + 1;
        } else at += kind[0] === "<" ? 3 : 2;
      }
      inner = alternatives();
      if (pattern[at] === ")") at++;
    } else at++;
    const repeat = repeatAt(pattern, at);
    if (!repeat) return inner ?? { runs: 0, factor: 1 };
    at += repeat.chars;
    if (!inner) return repeat.ways;
    // A group that may be left out is a choice of two; any other repeat of a group is refused.
    if (repeat.ways.runs === 0 && repeat.ways.factor === 2 && pattern[at - repeat.chars] === "?") return { runs: inner.runs, factor: inner.factor + 1 };
    refusals.push(A.patternNested);
    return inner;
  };

  const whole = alternatives();
  // A `)` that closes nothing: the engine says so when it compiles; here it is passed over.
  while (at < pattern.length) {
    at++;
    const rest = alternatives();
    whole.runs = Math.max(whole.runs, rest.runs);
    whole.factor += rest.factor;
  }
  const [refused] = refusals;
  if (refused !== undefined) return refused;
  const most = whole.runs === 0 ? WAYS_MOST * Math.max(1, pieceChars) : WAYS_MOST;
  return whole.runs > 1 || !(whole.factor <= most) ? A.patternMany : null;
}

/**
 * What a grep looks for, as a test of one line: exact text in any letter case, or, where the call
 * asks, a regular expression (case-insensitive). A pattern that can't be compiled, or that isn't of
 * the class that cannot run away (`refusedPattern`), is answered with why and what to give instead.
 *
 * A pattern is matched against `pieceChars` of a line at once. A longer line is matched a piece at
 * a time, each piece overlapping the one before it by half, so a match up to half a piece long is
 * found wherever it stands. A piece is read with the character before it and the one after it, and
 * a match that ends where the piece does while the line goes on is left to the next piece: so `^`,
 * `$` and `\b` hold only where the line's own start, end and word edges are, never at a piece's.
 */
export function lineMatch(p: Pager, needle: string, regex: boolean, pieceChars: number): LineMatch | ToolOutcome {
  if (!regex) {
    const lower = needle.toLowerCase();
    return {
      pieces: () => 1,
      find: (line) => {
        const at = line.toLowerCase().indexOf(lower);
        return at < 0 ? null : { at, length: needle.length };
      },
    };
  }
  const refuse = (why: string): ToolOutcome => ({ text: saidBack(p, needle, (pattern) => p.texts.render(TEXT.recall.answer.badPattern, { pattern, why: clip(why, p.lineChars) })), error: true });
  if (needle.length > p.lineChars) return refuse(p.texts.render(TEXT.recall.answer.patternLong, { limit: String(p.lineChars) }));
  // A piece of two characters at least, so its half is one and a search always moves on.
  const piece = Math.max(2, Math.floor(pieceChars));
  const half = piece >> 1;
  const refused = refusedPattern(needle, piece);
  if (refused !== null) return refuse(p.texts.render(refused));
  let compiled: RegExp;
  try {
    // `g`: a match is looked for from where `lastIndex` says, which is how a piece is read past the character before it.
    compiled = new RegExp(needle, "giu");
  } catch (error) {
    return refuse(error instanceof Error ? error.message : String(error));
  }
  return {
    pieces: (line) => (line.length <= piece ? 1 : Math.max(1, Math.ceil((line.length - piece - 1) / half) + 1)),
    find: (line, n) => {
      if (line.length <= piece) {
        compiled.lastIndex = 0;
        const m = compiled.exec(line);
        return m ? { at: m.index, length: Math.max(1, m[0].length) } : null;
      }
      // The piece, with one character before it and one after: never cut inside a character.
      const from = cutAt(line, n * half);
      const start = from === 0 ? 0 : cutAt(line, from - 1);
      const end = cutAt(line, Math.min(line.length, from + piece + 1));
      const last = end === line.length;
      const subject = line.slice(start, end);
      const first = from - start;
      for (let look = first; ; ) {
        compiled.lastIndex = look;
        const m = compiled.exec(subject);
        if (!m) return null;
        if (last || m.index + m[0].length < subject.length) return { at: start + m.index, length: Math.max(1, m[0].length) };
        // It ends where the piece does, and the line goes on: what follows it is the next piece's to see. One that began in this piece's second half is whole there; one that began earlier is looked past, for a match after it.
        if (m.index >= first + half) return null;
        look = m.index + 1;
      }
    },
  };
}

/** A line a grep found: the text it is in (its place among those searched), its number there from 1, its words, and where in it the match is. */
export interface GrepLine {
  key: number;
  line: number;
  text: string;
  at: number;
  length: number;
}

/** What holds a search to its time: the host's clock, the signal that ends the call when its agent is stopped, how long the search may take, and how long it works before it gives way (Settings, in milliseconds). */
export interface GrepBound {
  clock: ClockPort;
  signal: AbortSignal;
  ms: number;
  sliceMs: number;
}

/** A search that took longer than Settings allow: how many of the texts it had gone through when it stopped. */
export interface GrepLate {
  late: true;
  searched: number;
}

/** A search's bound for one call of a tool: Settings' two times, on the host's clock, under the call's signal. */
export function grepBound(env: { host: { clock: ClockPort }; settings: Readonly<Settings> }, signal: AbortSignal): GrepBound {
  const { ms, sliceMs } = env.settings.recall.grep;
  return { clock: env.host.clock, signal, ms, sliceMs };
}

/**
 * Every line of `texts` that `match` takes, in order. Between two pieces the search looks at the
 * clock: once it has worked for Settings' slice it gives way (a wait of no time on the host's
 * clock, which lets whatever else waits go on and ends at once where the call's agent was stopped),
 * and once it has taken longer than Settings give a search it stops and says how far it came
 * (`GrepLate`). Rejects with the signal's reason where the call was stopped.
 */
export async function grepTexts(texts: readonly string[], match: LineMatch, bound: GrepBound): Promise<GrepLine[] | GrepLate> {
  const { clock, signal } = bound;
  signal.throwIfAborted();
  const found: GrepLine[] = [];
  const began = clock.now();
  let since = began;
  for (const [key, text] of texts.entries()) {
    let line = 0;
    for (const words of text.split("\n")) {
      line++;
      const pieces = match.pieces(words);
      for (let n = 0; n < pieces; n++) {
        const at = match.find(words, n);
        if (at) found.push({ key, line, text: words, at: at.at, length: at.length });
        const now = clock.now();
        if (now - began > bound.ms) return { late: true, searched: key };
        if (now - since >= bound.sliceMs) {
          await clock.sleep(0, signal);
          since = clock.now();
        }
        if (at) break;
      }
    }
  }
  return found;
}

/** What a grep answers once it ran out of its time: that it was stopped, how far it came (`total`: how many texts there were, with their word), and what to give instead. */
export function lateAnswer(p: Pager, bound: GrepBound, late: GrepLate, total: string): ToolOutcome {
  return { text: clip(p.texts.render(TEXT.recall.answer.grepLate, { ms: String(bound.ms), searched: String(late.searched), total }), p.pageChars), error: true };
}
