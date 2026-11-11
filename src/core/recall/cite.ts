// Citations (DESIGN §24.4, §24.7): how a chat message is named so that what rests on it can be
// checked later. A citation is the message's number in the chat and the first characters of the
// hash of its text (`PathMessage.hash`), written `[#412 a3f9c27e]`. Every chat tool prints a message
// with it, an agent copies it into the chronicle, and `chronicle_check` reads it back.
//
// A citation holds where the message at its number has its hash, and nowhere else. LumiAH keeps no
// record of a chat changing, so a citation that doesn't hold is told by what was compared (the chat
// has no message at that number; the message there doesn't read as cited) and never by a guess at
// why. The one thing the hash settles beyond that: where exactly one other message has it, the
// number was written wrong, and the right one is known.

/**
 * How many characters of the hash a citation carries. A stored format, not a setting: the chronicle's
 * files are written with it. Eight hex characters are four thousand million values, so in a chat of
 * 2,000 messages a hash nobody copied from a message starts one message's about once in two million
 * tries: found at exactly one other number, it is evidence that the number was miscopied. With four
 * characters it was one try in thirty, and proved nothing. A longer hash in a file is read all the
 * same; a shorter one is no citation.
 */
export const CITE_CHARS = 8;

/** The most of a hash a citation may carry: all of it. `PathMessage.hash` is 64 hex characters. */
const HASH_CHARS = 64;

/** A message's citation, without its brackets: `#412 a3f9c27e`. */
export function citeOf(index: number, hash: string): string {
  return `#${index} ${hash.slice(0, CITE_CHARS)}`;
}

/** A citation as a file holds it: `[#412 a3f9c27e]`, the hash eight characters or more. A message number is at most nine digits, which a JavaScript number holds exactly. */
const CITATION = new RegExp(`\\[#(\\d{1,9})\\s+([0-9a-f]{${CITE_CHARS},${HASH_CHARS}})\\]`, "gi");

export interface Citation {
  /** The citation as written. */
  text: string;
  /** The message number it names. */
  index: number;
  /** The start of the hash it gives that message's text, in lower case. */
  hash: string;
}

/** Every citation a text holds, in order. */
export function citationsIn(text: string): Citation[] {
  return [...text.matchAll(CITATION)].map((m) => ({ text: m[0], index: Number(m[1]), hash: (m[2] ?? "").toLowerCase() }));
}

/**
 * The longest text that is read as naming a message. Fixed, not a setting: it follows from the
 * format. The longest citation there is (a nine-digit number and a whole hash, in brackets) has 77
 * characters, so a text longer than this names no message whatever it holds, and is refused unread:
 * a model's argument may be of any length, and none of it is worth a pass over a megabyte.
 */
const NAMED_CHARS = 96;

/**
 * A message as an agent may name it to a tool: its number alone (`412`, `#412`), or its citation
 * with or without brackets (`#412 a3f9c27e`, `[#412 a3f9c27e]`). No two runs of optional space
 * stand side by side (the one after `#` is there only with the `#`), so a text that names nothing is
 * told so in one pass: side by side, each way of sharing the blanks between them was tried in turn.
 */
const NAMED = new RegExp(`^\\[?\\s*(?:#\\s*)?(\\d{1,9})(?:\\s+([0-9a-f]{${CITE_CHARS},${HASH_CHARS}}))?\\s*\\]?$`, "i");

/** The message a tool's argument names: its number, and the hash it was cited with where the argument is a citation. Null for anything else. */
export function namedMessage(value: unknown): { index: number; hash: string | null } | null {
  if (typeof value === "number") return Number.isSafeInteger(value) && value >= 0 ? { index: value, hash: null } : null;
  if (typeof value !== "string" || value.length > NAMED_CHARS) return null;
  const m = NAMED.exec(value.trim());
  return m ? { index: Number(m[1]), hash: m[2]?.toLowerCase() ?? null } : null;
}

/**
 * How a citation stands against the chat as it is. The names are the ones the page's shapes and the
 * chat tools read, and say what was compared, not what happened to the chat:
 * - `ok`: the message at the cited number has the cited hash. Nothing else holds.
 * - `moved`: it doesn't, and exactly one message of the chat has that hash, at `now`: the number
 *   was written wrong.
 * - `changed`: the chat has a message at the cited number, and it doesn't read as cited.
 * - `gone`: the chat has no message at the cited number.
 * `several`, on the last two: the numbers of the messages that do read as cited where more than one
 * does (two messages with the same text have the same hash), none where no message does. A hash
 * that several messages have names none of them.
 */
export type CiteState = { state: "ok" } | { state: "moved"; now: number } | { state: "changed"; several: readonly number[] } | { state: "gone"; several: readonly number[] };

/**
 * Checks a citation against the chat's messages as they stand: `hashes` holds each message's hash by
 * its number, `places` the numbers of the messages whose hash starts with a citation's (`placesOf`).
 * The one rule every reader of a citation goes by (the chronicle's check, the page, the chat tools).
 * A hash shorter than a citation carries holds nowhere, whoever passes it.
 */
export function checkCitation(cite: { index: number; hash: string }, hashes: ReadonlyMap<number, string>, places: (hash: string) => readonly number[]): CiteState {
  const at = hashes.get(cite.index);
  if (cite.hash.length >= CITE_CHARS && at?.startsWith(cite.hash)) return { state: "ok" };
  const [now, ...others] = places(cite.hash);
  if (now !== undefined && others.length === 0) return { state: "moved", now };
  const several = now === undefined ? [] : [now, ...others];
  return at === undefined ? { state: "gone", several } : { state: "changed", several };
}

/** Where the messages whose hash starts with a citation's stand, lowest number first: the lookup `checkCitation` takes, over `hashes` by message number. Built once for a check of many lines. */
export function placesOf(hashes: ReadonlyMap<number, string>): (hash: string) => readonly number[] {
  const byStart = new Map<string, number[]>();
  for (const [index, hash] of hashes) {
    const start = hash.slice(0, CITE_CHARS);
    const list = byStart.get(start);
    if (list) list.push(index);
    else byStart.set(start, [index]);
  }
  for (const list of byStart.values()) list.sort((a, b) => a - b);
  // A hash shorter than a citation's is the start of no key here, so it finds nothing.
  return (hash) => (byStart.get(hash.slice(0, CITE_CHARS)) ?? []).filter((index) => hashes.get(index)?.startsWith(hash));
}
