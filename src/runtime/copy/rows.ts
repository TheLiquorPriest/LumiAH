// The rows the runtime's copy keeps, in the shapes the extension's own host gives for the same
// Lumiverse rows (`createSpindleHost`, extension/backend/spindle.ts), read from what Lumiverse sends
// the user's session: the rows of its HTTP routes and the payloads of its events.
//
// Those carry a message as Lumiverse stores it, projected for the swipe it shows (`rowToMessage`, or
// its lean form, which leaves the other swipes' slots null and drops the per-swipe extras). Spindle's
// `chat.getMessages` reshapes such a row before an extension sees it: the role from `is_user` and
// `extra.spindle_role`, `hidden` from `extra.hidden`, and the extensions' entries
// (`extra.spindle_metadata`) as `metadata`. The extension's host then reads that. Here both steps are
// one, so a row read over HTTP or heard in an event is the row the extension would have been given.
// A world book and its entries pass through Spindle's own defaults first (`toWorldBookDTO`,
// `toWorldBookEntryDTO`), which are applied here too.

import type { ChatRole, JsonValue } from "../../core/ports";
import type { HostBook, HostBookEntry, HostBookRecord, HostChat, HostEntryRecord, HostMessage } from "../../host/rows";
import { hasOwn, isRecord, toJson, toJsonObject } from "../../link/json";
import type { SourceEntry, SourceMessage } from "./source";

function str(o: Record<string, unknown>, key: string): string | undefined {
  const v = o[key];
  return typeof v === "string" ? v : undefined;
}

function num(o: Record<string, unknown>, key: string): number | undefined {
  const v = o[key];
  return typeof v === "number" && Number.isFinite(v) ? v : undefined;
}

/** The least number that can only be a time in milliseconds (as seconds it is the year 5138): the host's own rule. */
const MILLISECONDS_FROM = 100_000_000_000;

/** A time as the host keeps one, in milliseconds since 1970; null where it keeps none. Lumiverse stamps some rows in seconds and some in milliseconds. */
export function stampOf(raw: unknown): number | null {
  if (typeof raw !== "number" || !Number.isFinite(raw) || raw <= 0) return null;
  return Math.floor(raw >= MILLISECONDS_FROM ? raw : raw * 1000);
}

/**
 * The value, frozen all through. What the copy keeps is handed to every reader as it is, not copied
 * for each: a reader that changed it would change the copy for every other, so such a change fails
 * where it is made instead.
 */
function fixed<T extends JsonValue>(value: T): T {
  if (value !== null && typeof value === "object" && !Object.isFrozen(value)) {
    for (const inner of Object.values(value)) fixed(inner as JsonValue);
    Object.freeze(value);
  }
  return value;
}

/** A message's role as Lumiverse gives it to an extension (its `getMessageRole`): the user's, else a system message an extension wrote, else the assistant's. */
function roleOf(raw: Record<string, unknown>, extra: Record<string, unknown>): ChatRole {
  if (raw.is_user) return "user";
  return extra.spindle_role === "system" ? "system" : "assistant";
}

/**
 * A message's swipes as the host reads them, lean. Lumiverse keeps whatever its `swipes` JSON parses
 * to, nearly always a list; its lean form gives as many slots as that has (when more than one), the
 * shown one as stored, and Spindle passes on only a list. A row stored as JSON text parses to a
 * string, which the lean form spreads into that many slots, the shown one holding a single letter. A
 * whole row (an event's) is read the same way, so it gives the host's count too.
 */
function swipesOf(raw: unknown, swipeId: number): readonly unknown[] {
  if (Array.isArray(raw)) return raw;
  if (typeof raw !== "string" || raw.length <= 1) return [];
  const slots: unknown[] = new Array(raw.length).fill(null);
  const shown = swipeId >= 0 && swipeId < raw.length ? swipeId : 0;
  slots[shown] = raw[shown];
  return slots;
}

/**
 * A message as Lumiverse sends it over HTTP or in an event, as the host gives it, with each swipe's
 * text the row carries and its revision; null when it isn't one. `identifier` is the extension whose
 * entry in the message's extension metadata is its own.
 */
export function messageOf(raw: unknown, identifier: string): SourceMessage | null {
  if (!isRecord(raw)) return null;
  const id = str(raw, "id");
  if (id === undefined) return null;
  const extra = isRecord(raw.extra) ? raw.extra : {};
  const swipeId = num(raw, "swipe_id") ?? 0;
  const swipes = swipesOf(raw.swipes, swipeId);
  const shown = swipes[swipeId];
  const content = str(raw, "content") ?? (typeof shown === "string" ? shown : "");
  const bag = extra.spindle_metadata;
  const own = isRecord(bag) && hasOwn(bag, identifier) ? bag[identifier] : undefined;
  const row: HostMessage = {
    id,
    index: num(raw, "index_in_chat") ?? 0,
    role: roleOf(raw, extra),
    name: str(raw, "name") ?? "",
    swipeId,
    swipes: Math.max(1, swipes.length),
    content,
    hidden: extra.hidden === true,
    own: own === undefined ? null : fixed(toJson(own)),
    at: stampOf(raw.send_date) ?? stampOf(raw.created_at),
  };
  // The shown swipe's text is nearly always the message's text: held once, not twice.
  const texts = swipes.map((text, i) => (typeof text !== "string" ? null : i === swipeId && text === content ? content : text));
  return { row: Object.freeze(row), texts, revision: num(raw, "revision") ?? null };
}

/** A chat as Lumiverse sends it over HTTP or in an event (`rowToChat`), as the host gives it, with whose it is and when it last changed; null when it isn't one. */
export function chatOf(raw: unknown): { chat: HostChat; owner: string | null; updatedAt: number | null } | null {
  if (!isRecord(raw)) return null;
  const id = str(raw, "id");
  if (id === undefined) return null;
  const character = raw.character_id;
  const chat: HostChat = { id, name: str(raw, "name") ?? "", characterId: typeof character === "string" && character !== "" ? character : null, metadata: fixed(toJsonObject(raw.metadata)) };
  return { chat: Object.freeze(chat), owner: str(raw, "user_id") ?? null, updatedAt: stampOf(raw.updated_at) };
}

/** A world book as Lumiverse sends it (`rowToBook`), as the host gives its record; null when it isn't one. */
export function bookOf(raw: unknown): HostBookRecord | null {
  if (!isRecord(raw)) return null;
  const id = str(raw, "id");
  if (id === undefined) return null;
  return Object.freeze({ id, name: str(raw, "name") ?? "", description: str(raw, "description") ?? "", metadata: fixed(toJsonObject(raw.metadata)), updatedAt: stampOf(raw.updated_at) ?? 0 });
}

/** A list as Spindle passes it on: an array as it is, anything else as none. */
const listOf = (value: unknown): string[] => (Array.isArray(value) ? Object.freeze([...(value as string[])]) : Object.freeze([])) as string[];

/** A world book entry as Lumiverse sends it (`rowToEntry`), as the host gives its record, with its revision; null when it isn't one. */
export function entryOf(raw: unknown): SourceEntry | null {
  if (!isRecord(raw)) return null;
  const id = str(raw, "id");
  const bookId = str(raw, "world_book_id");
  if (id === undefined || bookId === undefined) return null;
  const role = raw.role;
  // Spindle orders an entry with no order of its own as 100.
  const order = raw.order_value ?? 100;
  const row: HostEntryRecord = {
    id,
    bookId,
    title: str(raw, "comment") ?? "",
    keys: listOf(raw.key),
    secondaryKeys: listOf(raw.keysecondary),
    content: str(raw, "content") ?? "",
    enabled: !raw.disabled,
    constant: !!raw.constant,
    vectorized: !!raw.vectorized,
    regex: !!raw.use_regex,
    role: role === "system" || role === "user" || role === "assistant" ? role : null,
    order: typeof order === "number" && Number.isFinite(order) ? order : 0,
    updatedAt: stampOf(raw.updated_at) ?? 0,
    extensions: fixed(toJsonObject(raw.extensions)),
  };
  return { row: Object.freeze(row), revision: num(raw, "revision") ?? null };
}

/** A book's record as the host gives the book alone. */
export const bookOnly = (record: HostBookRecord): HostBook => ({ id: record.id, name: record.name, description: record.description });

/** An entry's record as the host gives the entry alone. */
export const entryOnly = (e: HostEntryRecord): HostBookEntry => ({ id: e.id, bookId: e.bookId, title: e.title, keys: e.keys, secondaryKeys: e.secondaryKeys, content: e.content, enabled: e.enabled, constant: e.constant });

/** Whether two rows of a message say the same: every field the host gives. */
export function sameMessage(a: HostMessage, b: HostMessage): boolean {
  return a.id === b.id && a.index === b.index && a.role === b.role && a.name === b.name && a.swipeId === b.swipeId && a.swipes === b.swipes && a.content === b.content && a.hidden === b.hidden && a.at === b.at && sameJson(a.own, b.own);
}

/** Whether two rows of a chat say the same: every field the host gives. */
export function sameChat(a: HostChat, b: HostChat): boolean {
  return a.id === b.id && a.name === b.name && a.characterId === b.characterId && sameJson(a.metadata, b.metadata);
}

/** Whether two JSON values are the same value. */
export function sameJson(a: JsonValue | null, b: JsonValue | null): boolean {
  return a === b || JSON.stringify(a) === JSON.stringify(b);
}

/** About how many characters a JSON value holds, as text. */
export const jsonChars = (value: JsonValue | null): number => (value === null ? 0 : JSON.stringify(value).length);

/** About how many characters the copy holds for a message: its texts, its name and its own entry. */
export function messageChars(m: SourceMessage): number {
  let chars = m.row.content.length + m.row.name.length + jsonChars(m.row.own);
  m.texts.forEach((text, i) => {
    if (text !== null && !(i === m.row.swipeId && text === m.row.content)) chars += text.length;
  });
  return chars;
}

/** About how many characters the copy holds for an entry. */
export function entryChars(e: HostEntryRecord): number {
  let chars = e.title.length + e.content.length + jsonChars(e.extensions);
  for (const key of e.keys) chars += key.length;
  for (const key of e.secondaryKeys) chars += key.length;
  return chars;
}
