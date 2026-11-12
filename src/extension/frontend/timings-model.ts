// Runtime → Timings, worked out from the timing log each end keeps (`lah.timings.get`): per op and
// road, how many crossed and how long they took, split into waiting (on the way, in queues) and
// working (the other end's own time); and the slowest of the latest ones. Also the line each
// runtime's row says of the road the pages' requests take to it. Pure, so it is tested without a
// browser; timings.tsx only renders it.

import type { Crossing, OpTimes, Outcome, Road, RoadView, Spread, TimingsView } from "../../shared/ui";
import { ago, count, duration } from "./format";

/** A road as the page names it. */
export const ROAD_WORDS: Readonly<Record<Road, string>> = { link: "link", proxy: "proxy" };

/** How a crossing ended, as the page says it. */
export const OUTCOME_WORDS: Readonly<Record<Outcome, string>> = { ok: "answered", refused: "refused", timeout: "given up waiting", failed: "failed on the way" };

/** A size as the page says it: about bytes, since what crosses is mostly ASCII JSON. */
export function sizeWords(chars: number): string {
  if (chars < 1024) return `${count(chars)} B`;
  if (chars < 1024 * 1024) return `${(chars / 1024).toFixed(chars < 10 * 1024 ? 1 : 0)} KB`;
  return `${(chars / (1024 * 1024)).toFixed(1)} MB`;
}

/** One op on one road, as a row of the table. */
export interface OpRow {
  key: string;
  op: string;
  road: string;
  /** How many, and how many of them didn't end well ("12", "12, 1 not answered"). */
  count: string;
  /** Whole times: the median, the 95th percentile, the most. */
  median: string;
  p95: string;
  max: string;
  /** The median time waiting, and working, where the other end said how long it worked; "unknown" where none did. */
  waiting: string;
  working: string;
  /** The largest sent and received. */
  largest: string;
  /** Its 95th percentile went past `slowMs`: the row is marked. */
  slow: boolean;
}

const median = (spread: Spread | null): string => (spread === null ? "unknown" : duration(spread.p50));

/** The table of an end's log: one row per op and road, slowest first, as the log sums it up. `slowMs`: past this a row is marked (a page's own wait, say). */
export function opRows(view: TimingsView, slowMs: number): OpRow[] {
  return view.ops.map((o: OpTimes) => ({
    key: `${o.road} ${o.op}`,
    op: o.op,
    road: ROAD_WORDS[o.road],
    count: o.notOk > 0 ? `${count(o.count)}, ${count(o.notOk)} not answered` : count(o.count),
    median: duration(o.ms.p50),
    p95: duration(o.ms.p95),
    max: duration(o.ms.max),
    waiting: median(o.waitMs),
    working: median(o.workMs),
    largest: `${sizeWords(o.sent)} sent, ${sizeWords(o.got)} back`,
    slow: o.ms.p95 >= slowMs,
  }));
}

/** One of the slowest crossings, in a line: what, by which road, how long and how that split, how it ended, and when. */
export function slowLine(c: Crossing, now: number): string {
  const split = c.workMs === null ? "" : ` (waited ${duration(c.ms - c.workMs)}, worked ${duration(c.workMs)})`;
  return `${c.op} by the ${ROAD_WORDS[c.road]}: ${duration(c.ms)}${split}, ${OUTCOME_WORDS[c.outcome]}, ${ago(now, c.at)}.`;
}

/** What an end's log holds, in a line: how many crossings, of how many it keeps, since when. */
export function keptWords(view: TimingsView, now: number): string {
  if (view.rows === 0) return "Nothing has crossed since it started.";
  return `The latest ${count(view.rows)} crossings (it keeps ${count(view.capacity)}), the oldest ${view.since === null ? "unknown" : ago(now, view.since)}.`;
}

/** The line a runtime's row says of the road the pages' requests take to it: `proxy` (the faster road), or the link and why. */
export function roadLine(road: RoadView | undefined): { proxy: boolean; text: string } {
  if (road === undefined) return { proxy: false, text: "Pages reach it over the link." };
  if (road.road === "proxy") return { proxy: true, text: "Pages reach it through Lumiverse's own proxy, the faster road: a request doesn't wait behind a reply's traffic on the link." };
  return { proxy: false, text: `Pages reach it over the link. ${road.why ?? ""}`.trim() };
}
