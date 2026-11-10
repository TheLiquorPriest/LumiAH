// How every base tool answers (DESIGN §4.3), in one place so they answer alike:
// - a result is paged with a cursor: an answer that has more ends with the cursor that reads on, and
//   the same call with that cursor gives the next page;
// - a search or a listing says how many it found and which of them the page shows;
// - an error says what to do next;
// - nothing returns more than Answer length allows (`Settings.tools.pageChars`), and a page of a
//   search or a listing shows at most Hits per page.

import type { JsonObject } from "../ports";
import { TEXT, type Texts } from "../texts";
import type { ToolEnv, ToolOutcome } from "../tools";
import { clip, cutAt } from "../util";

/** What one tool pages by: its name, the user's texts, and the page's limits. */
export interface Pager {
  tool: string;
  texts: Texts;
  pageChars: number;
  pageItems: number;
}

export function pagerOf(env: ToolEnv, tool: string): Pager {
  return { tool, texts: env.texts, pageChars: env.settings.tools.pageChars, pageItems: env.settings.tools.pageItems };
}

/** Where a page starts: an item of a list, or a place in a text ("40"); or an item and a place in it ("12:3000"). `given`: the call named one. */
export interface Cursor {
  at: number;
  within: number;
  given: boolean;
}

/** A cursor as the tools write one: one whole number, or two with a colon between. At most 15 digits each, which a JavaScript number holds exactly; not a limit of the harness, so not a setting. */
const CURSOR = /^(\d{1,15})(?::(\d{1,15}))?$/;

/** The call's cursor, read; or the error that says it isn't one. None given starts at the beginning. */
export function readCursor(p: Pager, args: JsonObject): Cursor | ToolOutcome {
  const raw = args.cursor;
  if (raw === undefined || raw === null || raw === "") return { at: 0, within: 0, given: false };
  const match = typeof raw === "number" && Number.isSafeInteger(raw) && raw >= 0 ? CURSOR.exec(String(raw)) : typeof raw === "string" ? CURSOR.exec(raw.trim()) : null;
  if (!match) return badCursor(p, raw);
  return { at: Number(match[1]), within: Number(match[2] ?? 0), given: true };
}

export function badCursor(p: Pager, raw: unknown): ToolOutcome {
  return { text: p.texts.render(TEXT.answer.badCursor, { cursor: typeof raw === "string" ? raw : (JSON.stringify(raw) ?? ""), tool: p.tool }), error: true };
}

/** The error for a call that lacks an argument its tool can't do without: what the argument is, in its own description's words. */
export function needs(p: Pager, arg: string): ToolOutcome {
  return { text: p.texts.render(TEXT.answer.needs, { tool: p.tool, arg, what: p.texts.render(TEXT.toolArg(p.tool, arg)) }), error: true };
}

/** What ends a page: the cursor that reads on, or, on the last page of an answer a cursor asked for, that this is the end; nothing for an answer that fits one page. */
function footer(p: Pager, next: string | null, given: boolean): string {
  if (next !== null) return p.texts.render(TEXT.answer.more, { tool: p.tool, cursor: next });
  return given ? p.texts.render(TEXT.answer.end) : "";
}

/** The room a page has for what it shows, once its heading and its footer are taken out; never less than one character, so a page always moves on. */
function roomFor(p: Pager, heading: string, longestCursor: string): number {
  return Math.max(1, p.pageChars - heading.length - footer(p, longestCursor, true).length - 2);
}

/**
 * One page of a search's hits or a listing's items: a heading that says how many there are and which
 * are shown, then the items from `start`, as many as Hits per page and Answer length allow, then the
 * cursor for the rest. `noun`: the word text the count is written with (`TEXT.word`). `item` renders
 * one (`first`: it leads the page). An item too long for a page of its own is cut, and says so.
 */
export function listPage(p: Pager, input: { total: number; noun: string; cursor: Cursor; item: (i: number, first: boolean) => string; lead?: string }): ToolOutcome {
  const { total, cursor } = input;
  const start = cursor.at;
  if (cursor.within !== 0 || start >= total) return badCursor(p, `${cursor.at}${cursor.within !== 0 ? `:${cursor.within}` : ""}`);
  const found = (to: number): string => p.texts.render(TEXT.answer.found, { total: p.texts.counted(total, input.noun), from: String(start + 1), to: String(to) });
  const lead = input.lead === undefined ? "" : `${input.lead}\n`;
  const room = roomFor(p, `${lead}${found(total)}`, String(total));
  const lines: string[] = [];
  let used = 0;
  let i = start;
  for (; i < total && lines.length < p.pageItems; i++) {
    const line = input.item(i, i === start);
    if (used + line.length + 1 > room) {
      if (lines.length > 0) break;
      // Alone on its page and still too long: its start, saying it was cut, so the page is within its limit and the list moves on.
      const frame = p.texts.render(TEXT.answer.cut, { text: "" }).length;
      lines.push(p.texts.render(TEXT.answer.cut, { text: line.slice(0, cutAt(line, Math.max(1, room - frame))) }));
      i++;
      break;
    }
    lines.push(line);
    used += line.length + 1;
  }
  return { text: [`${lead}${found(i)}`, ...lines, footer(p, i < total ? String(i) : null, cursor.given)].filter((part) => part !== "").join("\n") };
}

/** Where a page of `room` characters from `from` ends in `text`: never inside a character, and past where it started, so a page of one character's room that starts on a pair takes the pair. */
export function pageEnd(text: string, from: number, room: number): number {
  const end = cutAt(text, Math.min(text.length, from + room));
  return end <= from && from < text.length ? Math.min(text.length, from + 2) : end;
}

/**
 * One page of a text: the characters from `from`, as many as Answer length allows once `frame` and
 * the footer are counted, then the cursor for the rest (`cursor` writes it from where the page ended).
 */
export function textPage(p: Pager, input: { text: string; from: number; given: boolean; frame: (part: { from: number; to: number; text: string }) => string; cursor?: (to: number) => string }): ToolOutcome {
  const { text } = input;
  if (input.from > text.length) return badCursor(p, String(input.from));
  const from = cutAt(text, input.from);
  const write = input.cursor ?? String;
  const to = pageEnd(text, from, roomFor(p, input.frame({ from: text.length, to: text.length, text: "" }), write(text.length)));
  return { text: [input.frame({ from, to, text: text.slice(from, to) }), footer(p, to < text.length ? write(to) : null, input.given)].filter((part) => part !== "").join("\n") };
}

/** An answer that names a list (the books there are, the turns there are), the list clipped so the whole stays within Answer length. */
export function fitted(p: Pager, list: string, render: (list: string) => string): string {
  return render(clip(list, Math.max(1, p.pageChars - render("").length)));
}

/** A line around what was found in it at `at`, at most `max` characters long. */
export function around(line: string, at: number, length: number, max: number): string {
  if (line.length <= max) return line;
  const from = cutAt(line, Math.max(0, Math.min(at - Math.floor((max - length) / 2), line.length - max)));
  const to = cutAt(line, Math.min(line.length, from + max));
  return `${from > 0 ? "…" : ""}${line.slice(from, to)}${to < line.length ? "…" : ""}`;
}

/** A line a grep found: where it is (`key`: an item of what was searched), its number there, its text, and where in it the text was found. */
export interface FoundLine {
  key: number;
  line: number;
  text: string;
  at: number;
}

/** Every line of `texts` that holds `needle`, in any letter case, in order. */
export function grepLines(texts: readonly string[], needle: string): FoundLine[] {
  const lower = needle.toLowerCase();
  const found: FoundLine[] = [];
  texts.forEach((text, key) => {
    text.split("\n").forEach((line, i) => {
      const at = line.toLowerCase().indexOf(lower);
      if (at >= 0) found.push({ key, line: i + 1, text: line, at });
    });
  });
  return found;
}
