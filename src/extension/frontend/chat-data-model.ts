// What Runtime → Chat data says of a runtime's copy of chat and lore (`lah.runtime.chatdata`): where the
// agents' reads of chats and world books are answered and why, what the copy reads from and why, the
// runtime's sign-in to Lumiverse where it needs renewing, the database reader's own state, what the copy
// holds (each chat's and book's last read and why, what its last check could and couldn't see), what it
// found too large beside all it may keep and the runtime's memory limit, the latest reads, every read it
// sent to the extension instead, Lumiverse's own routes where they don't answer as the runtime expects,
// and Lumiverse's events with each one lost. Each line in plain words, with a tone where something needs
// the user's eye.

import type { ChatDataKept, ChatDataReaderRead, ChatDataView, DatabaseSwitchView } from "../../shared/ui";
import { ago, clock, count, counted } from "./format";

export interface ChatDataLine {
  text: string;
  tone: "neutral" | "warn" | "neg";
}

/** One kept chat or book: what heads it, and its lines. */
export interface KeptLines {
  title: string;
  lines: ChatDataLine[];
}

/** The lines that say where the reads go and what the copy holds, in the order the section shows them. */
export function chatDataLines(state: ChatDataView, now: number, name: string): ChatDataLine[] {
  const lines: ChatDataLine[] = [{ text: state.why, tone: state.road === "copy" ? "neutral" : "warn" }];
  if (state.sourceWhy !== null) lines.push({ text: state.sourceWhy, tone: state.reader !== null && !state.reader.on ? "warn" : "neutral" });
  if (state.signIn !== null) lines.push({ text: `The runtime's sign-in to Lumiverse needs renewing, so the copy's reads over Lumiverse's routes go to ${name} instead: ${state.signIn}`, tone: "neg" });
  const { kept, most, limit, note } = state.memory;
  lines.push({ text: most === 0 ? `The copy keeps nothing ("Chat data kept" is 0): every read goes to ${name}. The runtime's memory limit is ${limit}.` : `The copy holds ${count(kept)} characters of the ${count(most)} it may keep ("Chat data kept"), beside the runtime's memory limit of ${limit}.`, tone: "neutral" });
  if (note !== null) lines.push({ text: note, tone: "warn" });
  for (const [what, list] of [["Chat", state.tooLarge.chats], ["World book", state.tooLarge.books]] as const) {
    for (const large of list) lines.push({ text: `${what} ${large.id} has ${count(large.chars)} characters, more than all the copy may keep: it is read from ${name} every time, until "Chat data kept" is raised past it.`, tone: "warn" });
  }
  const { heard, gaps, lastGap } = state.events;
  lines.push(gaps === 0 || lastGap === null ? { text: `${counted(heard, "event")} of Lumiverse's heard; none was lost on the way.`, tone: "neutral" } : { text: `${counted(heard, "event")} of Lumiverse's heard; ${counted(gaps, "time")} something was lost on the way, the last ${ago(now, lastGap.at)} (${lastGap.why}), and the copy read again what it held.`, tone: "warn" });
  const { total, latest } = state.fallbacks;
  lines.push({ text: total === 0 ? `No read went to ${name} for want of the copy vouching for it.` : `${counted(total, "read")} went to ${name} because the copy couldn't vouch for its answer${latest.length > 0 ? "; the latest below" : ""}.`, tone: "neutral" });
  const routes = state.routes;
  const last = routes.latest.at(-1);
  if (routes.total > 0 && last !== undefined) {
    const paused = last.until !== null && last.until > now ? ` Until ${clock(last.until)} the runtime asks that route nothing and reads everything it would give through ${name}; then it tries the route again.` : "";
    lines.push({ text: `Lumiverse's own routes aren't answering as the runtime expects, so ${counted(routes.total, "read")} of chats and world books went to ${name} instead, the slower way. The latest, ${ago(now, last.at)}: ${last.route} answered ${last.status} for ${last.what === "chat" ? "chat" : "world book"} ${last.id}.${paused}`, tone: "warn" });
  }
  return lines;
}

/** What one kept chat or book is like: where it was read from and when, why, what its last check saw and missed, and whether it is to be read again. */
export function keptLines(kept: ChatDataKept, what: "chat" | "book", now: number): KeptLines {
  const rows = what === "chat" ? counted(kept.rows, "message") : counted(kept.rows, "entry", "entries");
  const lines: ChatDataLine[] = [
    { text: `${rows}, ${counted(kept.chars, "character")}, from ${kept.from === "database" ? "Lumiverse's own file" : "Lumiverse's routes"}.`, tone: "neutral" },
    { text: `Read whole ${ago(now, kept.read.at)}: ${kept.read.why}.`, tone: "neutral" },
    { text: `Last found current ${ago(now, kept.checkedAt)}, by ${kept.check.saw}.`, tone: "neutral" },
  ];
  if (kept.check.missed !== null) lines.push({ text: `That couldn't see: ${kept.check.missed}.`, tone: "warn" });
  if (kept.stale !== null) lines.push({ text: `To be read again before it is next used: ${kept.stale}.`, tone: "neutral" });
  return { title: `${what === "chat" ? "Chat" : "World book"} ${kept.id}`, lines };
}

/** One read the database reader made, in words. */
function readerRead(read: ChatDataReaderRead, now: number): string {
  return `${read.what}, ${ago(now, read.at)}: ${read.outcome} (${counted(read.rows, "row")}, ${counted(read.chars, "character")}, ${read.ms} ms)`;
}

/** The database reader as it says it stands: on or off and why, its file open, its check of Lumiverse's tables, its last read and check. */
export function readerLines(reader: NonNullable<ChatDataView["reader"]>, now: number): ChatDataLine[] {
  const lines: ChatDataLine[] = [reader.on ? { text: `The database reader is on${reader.open ? ", with the file open" : ""}.`, tone: "neutral" } : { text: `The database reader is off: ${reader.why ?? "it was closed"}`, tone: "warn" }];
  const { checkedAt, matches, difference } = reader.schema;
  if (matches === null || checkedAt === null) lines.push({ text: "It hasn't checked Lumiverse's tables yet: it does before its first read.", tone: "neutral" });
  else lines.push(matches ? { text: `Lumiverse's tables were as it reads them ${ago(now, checkedAt)}.`, tone: "neutral" } : { text: `Lumiverse's tables weren't as it reads them ${ago(now, checkedAt)}: ${difference ?? "they differ"}.`, tone: "neg" });
  if (reader.lastRead !== null) lines.push({ text: `Last read: ${readerRead(reader.lastRead, now)}.`, tone: reader.lastRead.outcome.startsWith("failed") ? "warn" : "neutral" });
  if (reader.lastCheck !== null) lines.push({ text: `Last check: ${readerRead(reader.lastCheck, now)}.`, tone: reader.lastCheck.outcome.startsWith("failed") ? "warn" : "neutral" });
  return lines;
}

/** The latest reads whole, the newest first: of what, why, and how each ended. */
export function readLines(state: ChatDataView, now: number): ChatDataLine[] {
  return [...state.reads].reverse().map((read) => ({ text: `${ago(now, read.at)}: ${read.what === "chat" ? "chat" : "world book"} ${read.id}, as ${read.why}: ${read.outcome}.`, tone: read.outcome.startsWith("failed") ? "warn" : "neutral" }));
}

/** The latest reads sent to the extension because the copy couldn't vouch for its answer, the newest first, and why. */
export function fallbackLines(state: ChatDataView, now: number): ChatDataLine[] {
  return [...state.fallbacks.latest].reverse().map((fell) => ({ text: `${ago(now, fell.at)}: ${fell.what === "chat" ? "chat" : "world book"} ${fell.id}, as ${fell.why}.`, tone: "neutral" }));
}

/** The operator's switch, as the section offers it: shown to the operator alone, the file named to them alone. Null for anyone else. */
export function switchWords(database: DatabaseSwitchView): { label: string; help: string } | null {
  if (!database.operator) return null;
  const file = database.path === null ? "Where Lumiverse's database is can't be told from where the extension is installed, so it can't be switched on." : `Lumiverse's database: ${database.path}.`;
  return {
    label: "Read Lumiverse's database directly",
    help: `Yours alone, as this Lumiverse's operator: your own runtimes read the file itself instead of asking Lumiverse, when they run on its machine and may read the file. Off until you switch it on. ${file}`,
  };
}
