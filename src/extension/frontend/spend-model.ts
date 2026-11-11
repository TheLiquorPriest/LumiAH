// What the Spend and Storage pages decide (DESIGN §20), apart from drawing it: the chart's scale and
// its bars, the order of a table's rows, how a sum says the calls that had no price, the period as
// CSV, a size in words, how much of a cap is used and how that is said, and what a sweep did. Pure,
// so it is tested without a DOM; the pages render what these give.

import type { SpendCap, SpendRow, SpendView, UpkeepView } from "../../shared/ui";
import { ago, count, counted, duration, money } from "./format";

/**
 * The periods the Spend page offers, in days: a week, a month and a quarter. They are the page's
 * own three choices, not a bound on anything (the backend answers any number of days), so they are
 * no setting.
 */
export const PERIODS: readonly number[] = [7, 30, 90];

/** What a chart's bars measure: what a day cost, or the tokens it sent and wrote (which says something of a day whose calls had no price). */
export type Measure = "cost" | "tokens";

export const MEASURE_WORDS: Readonly<Record<Measure, string>> = { cost: "Cost", tokens: "Tokens" };

/** A row's size by a measure. */
export function measureOf(row: SpendRow, measure: Measure): number {
  return measure === "cost" ? row.cost : row.in + row.out;
}

/** An amount of a measure in words: money, or a count of tokens. */
export function measureWords(value: number, measure: Measure): string {
  return measure === "cost" ? money(value) : `${count(value)} tokens`;
}

/**
 * The top of a chart's scale: the least of 1, 2, 2.5 or 5 times a power of ten that holds the
 * greatest value, so the axis reads in round figures; 0 when there is nothing to draw.
 */
export function scaleTop(max: number): number {
  if (!(max > 0) || !Number.isFinite(max)) return 0;
  const power = 10 ** Math.floor(Math.log10(max));
  for (const step of [1, 2, 2.5, 5]) {
    // Twelve figures drop the noise a power of ten below one carries (0.30000000000000004).
    const top = Number((step * power).toPrecision(12));
    if (top >= max) return top;
  }
  return Number((10 * power).toPrecision(12));
}

const DAY_KEY = /^(\d{4})-(\d{2})-(\d{2})$/;

/** A day's key ("2026-11-03") as a moment: the start of that calendar day, read as written whatever the reader's time zone; null for a key that is no date. */
function dayAt(key: string): number | null {
  const m = DAY_KEY.exec(key);
  return m ? Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])) : null;
}

/** A day in words, with its weekday: "Tue, Nov 3" as the reader's own language writes it. A key that is no date is said as it is. */
export function dayWords(key: string, locale?: string): string {
  const at = dayAt(key);
  return at === null ? key : new Date(at).toLocaleDateString(locale, { weekday: "short", month: "short", day: "numeric", timeZone: "UTC" });
}

/** A day in as few words as an axis has room for: "Nov 3". */
export function dayShort(key: string, locale?: string): string {
  const at = dayAt(key);
  return at === null ? key : new Date(at).toLocaleDateString(locale, { month: "short", day: "numeric", timeZone: "UTC" });
}

/** A row's cost as its cell says it: the sum of the calls that had a price; "at least" that where some had none; "no price" where none had. */
export function costCell(row: Pick<SpendRow, "calls" | "cost" | "unpriced">): string {
  if (row.unpriced <= 0) return money(row.cost);
  if (row.unpriced >= row.calls) return "no price";
  return `at least ${money(row.cost)}`;
}

/** What the calls without a price mean for a sum; null when every call had one. */
export function unpricedWords(row: Pick<SpendRow, "unpriced">): string | null {
  return row.unpriced > 0 ? `${counted(row.unpriced, "call")} had no price, so the total is at least this.` : null;
}

/** A row's tokens in, with how many of them were read from the cache: "1,204,311 (800,120 cached)". */
export function tokensInWords(row: Pick<SpendRow, "in" | "cachedIn">): string {
  return row.cachedIn > 0 ? `${count(row.in)} (${count(row.cachedIn)} cached)` : count(row.in);
}

/** A row's figures in a sentence: what a bar says to someone who can't see it, and what the chart says of the day picked. */
export function rowWords(row: SpendRow): string {
  if (row.calls === 0) return "nothing spent";
  return [costCell(row), counted(row.calls, "call"), `${tokensInWords(row)} tokens in`, `${count(row.out)} out`, ...(row.unpriced > 0 && row.unpriced < row.calls ? [`${counted(row.unpriced, "call")} had no price`] : [])].join(", ");
}

/** One bar of the chart: its day, its size, its height as a share of the scale (0 to 1), and its figures in words. */
export interface Bar {
  key: string;
  day: string;
  value: number;
  height: number;
  words: string;
}

/** The chart of a period's days: the scale's top (as a number and in words), a bar a day in the days' own order, and the tallest bar's place (null: nothing was spent). */
export interface Chart {
  top: number;
  topWords: string;
  bars: Bar[];
  peak: number | null;
}

export function chartOf(days: readonly SpendRow[], measure: Measure, locale?: string): Chart {
  const values = days.map((d) => measureOf(d, measure));
  const max = values.reduce((most, v) => Math.max(most, v), 0);
  const top = scaleTop(max);
  const bars = days.map((d, i) => {
    const value = values[i] ?? 0;
    return { key: d.key, day: dayWords(d.key, locale), value, height: top > 0 ? Math.min(1, value / top) : 0, words: `${dayWords(d.key, locale)}: ${rowWords(d)}` };
  });
  return { top, topWords: measureWords(top, measure), bars, peak: max > 0 ? values.indexOf(max) : null };
}

/** A table's rows, the costliest first; rows of one cost by their tokens, then by name, so the order never shifts between two reads. */
export function byCost(rows: readonly SpendRow[]): SpendRow[] {
  return [...rows].sort((a, b) => b.cost - a.cost || b.in + b.out - (a.in + a.out) || (a.label < b.label ? -1 : a.label > b.label ? 1 : 0) || (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
}

/**
 * A value as a CSV field: quoted where it holds a comma, a quote or a line break. A text a
 * spreadsheet would run as a formula (it opens with =, +, - or @) is led by an apostrophe, since a
 * chat's name is whatever its user typed.
 */
function csvField(value: string | number): string {
  if (typeof value === "number") return String(value);
  const text = /^[=+\-@\t\r]/.test(value) ? `'${value}` : value;
  return /[",\n\r]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
}

const CSV_HEAD = ["group", "key", "name", "calls", "tokens_in", "cached_in", "tokens_out", "cost_usd", "unpriced_calls"];

/** The period as CSV, a row for each day, chat, agent, connection and model and one for the total, each named by its group so a spreadsheet can filter them apart. The figures are the page's own. */
export function spendCsv(view: SpendView): string {
  const groups: [string, readonly SpendRow[]][] = [
    ["day", view.days],
    ["chat", byCost(view.chats)],
    ["agent", byCost(view.agents)],
    ["connection", byCost(view.connections)],
    ["model", byCost(view.models)],
    ["total", [view.total]],
  ];
  // A cost summed from prices carries the arithmetic's noise in its last places: ten figures keep every digit that means something.
  const rows = groups.flatMap(([group, list]) => list.map((r) => [group, r.key, r.label, r.calls, r.in, r.cachedIn, r.out, Number(r.cost.toPrecision(10)), r.unpriced]));
  return `${[CSV_HEAD, ...rows].map((row) => row.map(csvField).join(",")).join("\n")}\n`;
}

/** A file name for a period's CSV: how many days, and the last of them where the days are dates. */
export function spendCsvName(view: SpendView): string {
  const last = view.days.at(-1)?.key ?? "";
  return `lumiah-spend-${view.days.length}-days${DAY_KEY.test(last) ? `-to-${last}` : ""}.csv`;
}

/** A size in words, in the units a file manager uses (a KB is 1,024 bytes), to three figures: "0 bytes", "1 byte", "812 bytes", "1.2 KB", "61.3 MB", "1.04 GB". */
export function bytesWords(bytes: number): string {
  const whole = Math.max(0, Math.round(bytes));
  if (whole < 1024) return counted(whole, "byte");
  const units = ["KB", "MB", "GB", "TB"];
  let value = whole / 1024;
  let unit = 0;
  for (;;) {
    const said = Number(value.toFixed(value >= 100 ? 0 : value >= 10 ? 1 : 2));
    // What rounds up to a whole unit is said in the unit above: "1 MB", not "1024 KB".
    if (said < 1024 || unit === units.length - 1) return `${said} ${units[unit] ?? ""}`;
    value /= 1024;
    unit += 1;
  }
}

/** How long ago something was stored, as an age: "5 min", "7 h", "41 days". */
export function ageWords(now: number, at: number): string {
  const ms = Math.max(0, now - at);
  if (ms < 3_600_000) return `${Math.round(ms / 60_000)} min`;
  if (ms < 2 * 86_400_000) return `${Math.round(ms / 3_600_000)} h`;
  return `${Math.floor(ms / 86_400_000)} days`;
}

/** How much of a limit is used, from 0 to 1; a limit of nothing is used up. */
export function fractionOf(used: number, limit: number): number {
  if (!(limit > 0)) return 1;
  return Math.min(1, Math.max(0, used / limit));
}

/** A share in words: "0%", "<1%", "37%", "100%". Rounded down, so nothing is said to be used up before it is. */
export function percentWords(fraction: number): string {
  if (!(fraction > 0)) return "0%";
  if (fraction < 0.01) return "<1%";
  return `${Math.floor(Math.min(1, fraction) * 100)}%`;
}

/** An amount in a cap's unit. */
function amountWords(n: number, unit: SpendCap["unit"]): string {
  if (unit === "usd") return money(n);
  if (unit === "ms") return duration(n);
  return unit === "calls" ? counted(n, "call") : `${count(n)} tokens`;
}

/** What has been used of a limit, the unit said once: "1,402,113 of 2,000,000 tokens", "$0.43 of $0.42". */
function usedOf(used: number, limit: number, unit: SpendCap["unit"]): string {
  if (unit === "usd") return `${money(used)} of ${money(limit)}`;
  if (unit === "ms") return `${duration(used)} of ${duration(limit)}`;
  return `${count(used)} of ${amountWords(limit, unit)}`;
}

/** Why a limit counted fewer tokens than were sent, said where the two differ, with where the share is set. */
export const CACHED_NOTE = "A token read again from a provider's cache counts as less than one (Settings → Spend → What a cached re-read counts as).";

/** The tokens truly sent, where a limit counted fewer of them; null where it counted them all, or nothing says. */
export function sentBeside(counted: number, sent: number | undefined): number | null {
  return sent !== undefined && sent !== counted ? sent : null;
}

/** A cap as the page shows it: how much of its bar is filled (null: it has no limit, so no bar), whether it is reached, and the numbers in words. */
export interface CapView {
  fraction: number | null;
  reached: boolean;
  words: string;
}

export function capView(cap: SpendCap): CapView {
  // A cap on tokens counts a cached re-read as a share of a token: what it counted and what was sent are both said where they differ.
  const sent = cap.unit === "tokens" ? sentBeside(cap.used, cap.sent) : null;
  if (cap.limit === null) return { fraction: null, reached: cap.reached, words: sent === null ? `${amountWords(cap.used, cap.unit)} used. No limit is set.` : `Counted as ${amountWords(cap.used, cap.unit)}; ${count(sent)} sent. No limit is set. ${CACHED_NOTE}` };
  const fraction = fractionOf(cap.used, cap.limit);
  return { fraction, reached: cap.reached, words: sent === null ? `${usedOf(cap.used, cap.limit, cap.unit)} used (${percentWords(fraction)}).` : `Counted as ${usedOf(cap.used, cap.limit, cap.unit)} (${percentWords(fraction)}); ${count(sent)} sent. ${CACHED_NOTE}` };
}

/** A kind's share of everything stored, by size, from 0 to 1. */
export function shareOf(bytes: number, total: number): number {
  return total > 0 ? Math.min(1, Math.max(0, bytes / total)) : 0;
}

/** The blobs nothing refers to, as last counted, in a sentence. */
export function looseWords(loose: UpkeepView["loose"], now: number): string {
  if (loose === null) return "Not counted yet: a sweep counts them.";
  if (loose.count === 0) return `None, as counted ${ago(now, loose.at)}.`;
  return `${counted(loose.count, "blob")} (${bytesWords(loose.bytes)}), as counted ${ago(now, loose.at)}.`;
}

/** The last sweep in a sentence: when, what it removed, how long it took. */
export function lastSweepWords(last: UpkeepView["lastSweep"], now: number): string {
  if (last === null) return "No sweep has run yet.";
  const removed = last.removed === 0 ? "it found nothing to remove" : `it removed ${counted(last.removed, "stored thing")} (${bytesWords(last.bytes)})`;
  return `The last sweep ran ${ago(now, last.at)}: ${removed}, in ${duration(last.ms)}.`;
}

/** What a sweep that just ran did, as the page says it. */
export function sweptWords(after: UpkeepView): string {
  const last = after.lastSweep;
  if (last === null) return "The sweep ran.";
  if (last.removed === 0) return `Swept in ${duration(last.ms)}: there was nothing to remove.`;
  return `Swept in ${duration(last.ms)}: removed ${counted(last.removed, "stored thing")}, ${bytesWords(last.bytes)}.`;
}

/** What the page asks before a sweep: what it removes, with what is known of how much. */
export function sweepAsk(view: UpkeepView): string {
  const loose = view.loose === null ? "the blobs nothing refers to (not counted yet)" : view.loose.count === 0 ? "the blobs nothing refers to (none when last counted)" : `the blobs nothing refers to (${counted(view.loose.count, "blob")}, ${bytesWords(view.loose.bytes)} when last counted)`;
  return `A sweep removes what Settings no longer keep (each kind's time is in the table), and ${loose}. What it removes can't be brought back.`;
}
