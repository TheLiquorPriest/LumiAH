// The timing log (PI-BUILD-PLAN §4.7): each end of the link keeps its latest crossings in memory, so
// Runtime → Timings can say where the time goes. A crossing is one request and its answer: what was
// asked (the op), the road it took (the link, or Lumiverse's proxy to the runtime's loopback
// server), how much crossed each way, how long it waited and how long the other end worked on it,
// and how it ended. The extension's end logs the asks it sends a runtime; the runtime's end logs the
// requests it sends the extension. Each end's answer says how long it worked, so a row splits its
// time into waiting (on the way, in queues) and working.
//
// Nothing of what crossed is kept but its size, and nothing is written anywhere. The log is a ring
// of a fixed number of rows: the newest overwrite the oldest, so it holds the same memory however
// much goes through it. A page reads it whole in one request, summed up here.

/** Which way a crossing went: over the link's socket, or through Lumiverse's proxy (`spindle.cors`). */
export type Road = "link" | "proxy";

/** How a crossing ended: answered; refused by the other end (whoever asked was told why); given up waiting; or failed on the way. */
export type Outcome = "ok" | "refused" | "timeout" | "failed";

/** One crossing as the log keeps it. Sizes are characters of the JSON that crossed, about its bytes: what crosses is mostly ASCII. */
export interface Crossing {
  /** When it was sent, in ms since the epoch. */
  at: number;
  op: string;
  road: Road;
  sent: number;
  got: number;
  /** Its whole time: from sending to its answer, or to giving it up. */
  ms: number;
  /** How long the other end said it worked on it; null where it didn't say (no answer came, or an end from before it could). */
  workMs: number | null;
  outcome: Outcome;
}

/** A spread of times: the median, the 95th percentile and the most, in ms. */
export interface Spread {
  p50: number;
  p95: number;
  max: number;
}

/** One op on one road over the rows kept. */
export interface OpTimes {
  op: string;
  road: Road;
  count: number;
  /** How many were refused, given up or failed. */
  notOk: number;
  /** The whole times. */
  ms: Spread;
  /** Of those whose other end said how long it worked: the part spent waiting (on the way, in queues), and the part spent working. Null where none said. */
  waitMs: Spread | null;
  workMs: Spread | null;
  /** The largest each way. */
  sent: number;
  got: number;
}

/** One end's log as a page reads it: per op and road, the slowest of the rows kept, how many it keeps and since when. */
export interface TimingsView {
  /** When the oldest row kept was sent; null while there is none. */
  since: number | null;
  rows: number;
  capacity: number;
  /** The ops by their slowest 95th percentile first. */
  ops: OpTimes[];
  /** The slowest rows kept, slowest first. */
  slowest: Crossing[];
}

/** How many rows an end keeps: enough for a few minutes of a busy preparation, a few hundred kilobytes at most. Not a setting: it bounds memory, not a wait. */
export const TIMINGS_KEPT = 2_000;

/** How many of the slowest rows a page is shown. */
export const SLOWEST_SHOWN = 12;

/** The longest op a row keeps: every op is a name the code gives, far shorter. */
const OP_MAX = 64;

/** The value at a fraction of a sorted list (nearest rank). */
function at(sorted: readonly number[], fraction: number): number {
  if (sorted.length === 0) return 0;
  return sorted[Math.min(sorted.length - 1, Math.max(0, Math.ceil(fraction * sorted.length) - 1))] ?? 0;
}

function spread(values: number[]): Spread | null {
  if (values.length === 0) return null;
  values.sort((a, b) => a - b);
  return { p50: at(values, 0.5), p95: at(values, 0.95), max: values[values.length - 1] ?? 0 };
}

/** One end's crossings, the latest `capacity` of them. */
export class Timings {
  private readonly rows: (Crossing | undefined)[];
  /** Where the next row goes. */
  private next = 0;
  private held = 0;

  constructor(readonly capacity: number = TIMINGS_KEPT) {
    this.rows = new Array<Crossing | undefined>(capacity);
  }

  /** Keeps one crossing, over the oldest once the log is full. Nothing of what crossed is given here but its size. */
  add(row: Crossing): void {
    if (this.capacity === 0) return;
    const kept: Crossing = {
      at: row.at,
      op: row.op.length > OP_MAX ? row.op.slice(0, OP_MAX) : row.op,
      road: row.road,
      sent: Math.max(0, Math.round(row.sent)),
      got: Math.max(0, Math.round(row.got)),
      ms: Math.max(0, Math.round(row.ms)),
      workMs: row.workMs === null ? null : Math.max(0, Math.round(Math.min(row.workMs, row.ms))),
      outcome: row.outcome,
    };
    this.rows[this.next] = kept;
    this.next = (this.next + 1) % this.capacity;
    this.held = Math.min(this.held + 1, this.capacity);
  }

  /** The rows kept, oldest first. */
  all(): Crossing[] {
    const out: Crossing[] = [];
    for (let i = 0; i < this.held; i++) {
      const row = this.rows[(this.next - this.held + i + this.capacity) % this.capacity];
      if (row !== undefined) out.push(row);
    }
    return out;
  }

  /** The log summed up for a page: counts and spreads per op and road, and the slowest rows. */
  view(): TimingsView {
    const rows = this.all();
    const groups = new Map<string, Crossing[]>();
    for (const row of rows) {
      const key = `${row.road} ${row.op}`;
      const group = groups.get(key);
      if (group === undefined) groups.set(key, [row]);
      else group.push(row);
    }
    const ops: OpTimes[] = [...groups.values()].map((group) => {
      const first = group[0] as Crossing;
      const said = group.filter((row) => row.workMs !== null);
      return {
        op: first.op,
        road: first.road,
        count: group.length,
        notOk: group.filter((row) => row.outcome !== "ok").length,
        ms: spread(group.map((row) => row.ms)) ?? { p50: 0, p95: 0, max: 0 },
        waitMs: spread(said.map((row) => row.ms - (row.workMs ?? 0))),
        workMs: spread(said.map((row) => row.workMs ?? 0)),
        sent: Math.max(...group.map((row) => row.sent)),
        got: Math.max(...group.map((row) => row.got)),
      };
    });
    ops.sort((a, b) => b.ms.p95 - a.ms.p95 || b.count - a.count || a.op.localeCompare(b.op));
    const slowest = [...rows].sort((a, b) => b.ms - a.ms || b.at - a.at).slice(0, SLOWEST_SHOWN);
    return { since: rows[0]?.at ?? null, rows: rows.length, capacity: this.capacity, ops, slowest };
  }
}

/** A view as it crossed from the other end, checked: every field of its type and within its bounds, rows past the shown ones dropped; null for anything else. */
export function timingsViewOf(raw: unknown): TimingsView | null {
  const record = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
  const whole = (v: unknown): v is number => typeof v === "number" && Number.isSafeInteger(v) && v >= 0;
  const roadOf = (v: unknown): v is Road => v === "link" || v === "proxy";
  const outcomeOf = (v: unknown): v is Outcome => v === "ok" || v === "refused" || v === "timeout" || v === "failed";
  const opOf = (v: unknown): v is string => typeof v === "string" && v !== "" && v.length <= OP_MAX;
  const spreadOf = (v: unknown): Spread | null | undefined => (v === null ? null : record(v) && whole(v.p50) && whole(v.p95) && whole(v.max) ? { p50: v.p50, p95: v.p95, max: v.max } : undefined);
  if (!record(raw) || !(raw.since === null || whole(raw.since)) || !whole(raw.rows) || !whole(raw.capacity) || !Array.isArray(raw.ops) || !Array.isArray(raw.slowest)) return null;
  const ops: OpTimes[] = [];
  for (const o of raw.ops) {
    if (!record(o) || !opOf(o.op) || !roadOf(o.road) || !whole(o.count) || !whole(o.notOk) || !whole(o.sent) || !whole(o.got)) return null;
    const ms = spreadOf(o.ms);
    const waitMs = spreadOf(o.waitMs);
    const workMs = spreadOf(o.workMs);
    if (ms === undefined || ms === null || waitMs === undefined || workMs === undefined) return null;
    ops.push({ op: o.op, road: o.road, count: o.count, notOk: o.notOk, ms, waitMs, workMs, sent: o.sent, got: o.got });
  }
  const slowest: Crossing[] = [];
  for (const c of raw.slowest.slice(0, SLOWEST_SHOWN)) {
    if (!record(c) || !whole(c.at) || !opOf(c.op) || !roadOf(c.road) || !whole(c.sent) || !whole(c.got) || !whole(c.ms) || !(c.workMs === null || whole(c.workMs)) || !outcomeOf(c.outcome)) return null;
    slowest.push({ at: c.at, op: c.op, road: c.road, sent: c.sent, got: c.got, ms: c.ms, workMs: c.workMs, outcome: c.outcome });
  }
  return { since: raw.since, rows: raw.rows, capacity: raw.capacity, ops, slowest };
}
