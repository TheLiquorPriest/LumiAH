// Lumiverse's rows as its HTTP routes send them, made from the rows of its database file: a message in
// the lean form of its message pages (`rowToMessage`, `rowToMessageLight`), a chat (`rowToChat`), a
// world book (`rowToBook`) and an entry (`rowToEntry`), each cut to the fields the copy reads, and then
// the copy's own rows from those (../copy/rows.ts). So a row read from the file comes out as the HTTP
// source gives the same row. Each step is Lumiverse's own, its fallbacks for bad JSON included, and so
// is each place where its mapper fails on a row: Lumiverse can't send such a row over HTTP either, so it
// isn't read from the file (`Unreadable`).

import type { HostBookRecord, HostChat } from "../../host/rows";
import { bookOf, chatOf, entryOf, messageOf } from "../copy/rows";
import type { SourceEntry, SourceMessage } from "../copy/source";

/** A value as SQLite hands one over: any column may hold any of these, whatever type it is declared with. */
export type Cell = string | number | Uint8Array | null;

/** A message as the reader selects it: its columns, its place in the file, and how many bytes its texts take. */
export interface MessageRow {
  /** Its rowid: which of two messages at one place in a chat Lumiverse lists first. */
  at: number;
  id: Cell;
  index_in_chat: Cell;
  is_user: Cell;
  name: Cell;
  content: Cell;
  send_date: Cell;
  swipe_id: Cell;
  swipes: Cell;
  extra: Cell;
  created_at: Cell;
  revision: Cell;
  content_bytes: Cell;
  swipes_bytes: Cell;
  extra_bytes: Cell;
}

/** A chat's own row as the reader selects it. */
export interface ChatHead {
  id: Cell;
  user_id: Cell;
  character_id: Cell;
  name: Cell;
  metadata: Cell;
  updated_at: Cell;
}

/** A world book's own row as the reader selects it. */
export interface BookHead {
  id: Cell;
  user_id: Cell;
  name: Cell;
  description: Cell;
  metadata: Cell;
  updated_at: Cell;
}

/** An entry as the reader selects it, with how many bytes its longer texts take. */
export interface EntryRow {
  id: Cell;
  world_book_id: Cell;
  key: Cell;
  keysecondary: Cell;
  content: Cell;
  comment: Cell;
  role: Cell;
  order_value: Cell;
  constant: Cell;
  disabled: Cell;
  use_regex: Cell;
  vectorized: Cell;
  extensions: Cell;
  revision: Cell;
  updated_at: Cell;
  content_bytes: Cell;
  extensions_bytes: Cell;
}

/** A row Lumiverse's own mapper fails on, and why, in words that finish "Lumiverse can't read it: ...". */
export class Unreadable extends Error {}

/** Lumiverse's `normalizeSpindleMessageMetadata`: the saved preset contexts held one to a swipe. */
function withPresetContexts(value: unknown, swipeCount: number): unknown {
  if (!value || typeof value !== "object") return value;
  const metadata = value as Record<string, unknown>;
  const contexts = metadata.preset_contexts;
  return Array.isArray(contexts) ? { ...metadata, preset_contexts: Array.from({ length: Math.max(1, swipeCount) }, (_, i) => contexts[i] ?? null) } : metadata;
}

/**
 * A message row as the HTTP source gives it: Lumiverse's `rowToMessage` and the lean form of its
 * message pages, then the copy's own row. Throws `Unreadable` where Lumiverse's mapper fails.
 */
export function messageFrom(row: MessageRow, identifier: string): SourceMessage {
  let swipes: unknown;
  try {
    swipes = JSON.parse(String(row.swipes));
  } catch {
    swipes = [row.content ?? ""];
  }
  let extra: unknown;
  try {
    extra = JSON.parse(String(row.extra));
  } catch {
    extra = {};
  }
  // Lumiverse reads the length of what it parsed unguarded: JSON null fails its mapper outright, and
  // anything else without a length (a number, an object) has none.
  if (swipes === null) throw new Unreadable("its swipes are null");
  const length: unknown = typeof swipes === "string" ? swipes.length : typeof swipes === "object" && "length" in swipes ? swipes.length : undefined;
  // Lumiverse spreads whatever it parsed; of a list or a text that makes numbered keys only, never the ones read here.
  const stored: Record<string, unknown> = extra !== null && typeof extra === "object" ? { ...extra } : {};
  // With no length the count is NaN, which keeps no preset context, as in Lumiverse.
  if (stored.spindle_metadata !== undefined) stored.spindle_metadata = withPresetContexts(stored.spindle_metadata, Math.max(1, Number(length)));
  let shown = swipes;
  if (Number(length) > 1) {
    // Only a stored object can claim a length its own text couldn't hold; Lumiverse would build a list
    // that long and may not survive it, so such a row is refused instead.
    if (typeof length !== "number" || !Number.isInteger(length) || length > (typeof row.swipes === "string" ? row.swipes.length : 0)) throw new Unreadable("its swipes claim a length no list of them can have");
    // The lean form keeps the shown swipe's slot (the first one's, where the shown one is out of range) and empties the others.
    const swipeId = row.swipe_id;
    const active = typeof swipeId === "number" && swipeId >= 0 && swipeId < length ? swipeId : 0;
    const lean: unknown[] = new Array(length).fill(null);
    lean[active] = (typeof swipes === "string" ? swipes[active] : typeof swipes === "object" && swipes !== null ? Reflect.get(swipes, active) : undefined) ?? null;
    shown = lean;
  }
  const message = messageOf(
    { id: row.id, index_in_chat: row.index_in_chat, is_user: !!row.is_user, name: row.name, content: row.content, send_date: row.send_date, swipe_id: row.swipe_id, swipes: shown, extra: stored, created_at: row.created_at, revision: row.revision },
    identifier,
  );
  if (message === null) throw new Unreadable("its id isn't text");
  return message;
}

/** Lumiverse's `parseMetadataObject`: a chat's metadata as an object, or an empty one where it isn't one. */
function metadataObject(value: Cell): Record<string, unknown> {
  if (typeof value !== "string") return {};
  try {
    const parsed: unknown = JSON.parse(value);
    return parsed !== null && typeof parsed === "object" && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

/** A chat's own row as the HTTP source gives it (Lumiverse's `rowToChat`), with whose it is and when it last changed. */
export function chatFrom(head: ChatHead): { chat: HostChat; owner: string | null; updatedAt: number | null } {
  const read = chatOf({ ...head, metadata: metadataObject(head.metadata) });
  if (read === null) throw new Unreadable("its id isn't text");
  return read;
}

/** A world book's own row as the HTTP source gives it (Lumiverse's `rowToBook`). Throws `Unreadable` where Lumiverse's mapper fails. */
export function bookFrom(head: BookHead): HostBookRecord {
  let metadata: unknown;
  try {
    metadata = JSON.parse(String(head.metadata));
  } catch {
    throw new Unreadable("its metadata isn't JSON");
  }
  const book = bookOf({ id: head.id, name: head.name, description: head.description, metadata, updated_at: head.updated_at });
  if (book === null) throw new Unreadable("its id isn't text");
  return book;
}

/** The keys Lumiverse takes out of an entry's extensions and sends as fields of their own (`splitManagedEntryExtensions`). */
const MANAGED_KEYS = ["outlet_name", "outletName", "wi_marker", "wiMarker", "wi_marker_side", "wiMarkerSide"];

function parsed(text: Cell, what: string): unknown {
  try {
    return JSON.parse(String(text));
  } catch {
    throw new Unreadable(`its ${what} aren't JSON`);
  }
}

/** An entry as the HTTP source gives it (Lumiverse's `rowToEntry`), with its revision. Throws `Unreadable` where Lumiverse's mapper fails. */
export function entryFrom(row: EntryRow): SourceEntry {
  // Lumiverse parses stored text; anything else (a blob) it copies through JSON, which makes an object of it.
  const stored: unknown = typeof row.extensions === "string" ? parsed(row.extensions, "extensions") : JSON.parse(JSON.stringify(row.extensions));
  const extensions: object = stored !== null && typeof stored === "object" ? stored : {};
  for (const key of MANAGED_KEYS) Reflect.deleteProperty(extensions, key);
  const entry = entryOf({
    ...row,
    key: parsed(row.key, "keys"),
    keysecondary: parsed(row.keysecondary, "secondary keys"),
    role: row.role || null,
    constant: !!row.constant,
    disabled: !!row.disabled,
    use_regex: !!row.use_regex,
    vectorized: !!row.vectorized,
    extensions,
  });
  if (entry === null) throw new Unreadable("its id or its book's isn't text");
  return entry;
}
