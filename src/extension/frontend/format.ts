// Numbers, times and money as the pages say them. One place, so every page says them alike.

const NUMBER = new Intl.NumberFormat("en-US");

/** A count with thousands marked: "12,345". */
export function count(n: number): string {
  return NUMBER.format(n);
}

/** A count said shortly where room is tight: "980", "12.3k", "1.2M". */
export function compact(n: number): string {
  if (n < 1000) return String(n);
  if (n < 1_000_000) return `${(n / 1000).toFixed(n < 10_000 ? 1 : 0)}k`;
  return `${(n / 1_000_000).toFixed(1)}M`;
}

/** A span of time: "840 ms", "4.2 s", "3 min 12 s", "1 h 4 min". */
export function duration(ms: number): string {
  if (ms < 1000) return `${Math.max(0, Math.round(ms))} ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)} s`;
  const s = Math.round(ms / 1000);
  if (s < 3600) return `${Math.floor(s / 60)} min ${s % 60} s`;
  return `${Math.floor(s / 3600)} h ${Math.floor((s % 3600) / 60)} min`;
}

/** How long something under way has run, in whole seconds while it is under a minute ("0 s", "42 s", then "3 min 12 s"): a clock that ticks once a second has no tenths to show. */
export function elapsed(now: number, since: number): string {
  const seconds = Math.max(0, Math.floor((now - since) / 1000));
  return seconds < 60 ? `${seconds} s` : duration(seconds * 1000);
}

/** US dollars, with as many places as a small amount needs to show: "$0.0042", "$0.13", "$0.125", "$2.40". */
export function money(usd: number): string {
  if (usd === 0) return "$0";
  // Below this a number writes itself with an exponent, which no one reads as money.
  if (usd < 0.000001) return "<$0.000001";
  if (usd < 0.01) return `$${usd.toPrecision(2)}`;
  if (usd >= 1) return `$${usd.toFixed(2)}`;
  // Under a dollar a third place says something only when it isn't nought.
  const thousandths = usd.toFixed(3);
  return `$${thousandths.endsWith("0") ? thousandths.slice(0, -1) : thousandths}`;
}

/** How long ago, said shortly: "12 s ago", "3 min ago", "2 h ago", else the date. */
export function ago(now: number, at: number): string {
  const ms = now - at;
  if (ms < 60_000) return `${Math.max(0, Math.round(ms / 1000))} s ago`;
  if (ms < 3_600_000) return `${Math.round(ms / 60_000)} min ago`;
  if (ms < 86_400_000) return `${Math.round(ms / 3_600_000)} h ago`;
  return `on ${dateTime(at)}`;
}

/** A moment, in the reader's own way of writing dates and times. */
export function dateTime(at: number | string): string {
  return new Date(at).toLocaleString();
}

/** The time of day of a moment, to the second. */
export function clock(at: number): string {
  return new Date(at).toLocaleTimeString();
}

/** "1 call", "3 calls". */
export function counted(n: number, one: string, many = `${one}s`): string {
  return `${count(n)} ${n === 1 ? one : many}`;
}
