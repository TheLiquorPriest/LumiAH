// Small helpers the core's parts share: limits, cuts that never split a character, JSON equality,
// and the values a model's arguments give.

import { isRecord } from "./ports";

/** A limit a setting holds: a number, or null for no limit at all. */
export type Limit = number | null;

/** A limit as a number to compare with: none is infinite. */
export function limitOf(limit: Limit): number {
  return limit === null ? Number.POSITIVE_INFINITY : limit;
}

/**
 * The longest a JavaScript timer can wait (2^31 − 1 ms, about 24.8 days): a longer one fires at once,
 * so a longer limit runs as no limit, and no wait a setting holds may be longer. Not a setting: it
 * is the platform's own bound.
 */
export const TIMER_MAX_MS = 2_147_483_647;

/** A time left as a timer's milliseconds: null for no limit, or one longer than a timer can wait. */
export function timerMs(left: number): number | null {
  return left >= TIMER_MAX_MS ? null : Math.max(0, left);
}

/** A cut at `at` or one before, so it never splits a character: a UTF-16 unit from 0xD800 to 0xDBFF opens a surrogate pair. */
export function cutAt(text: string, at: number): number {
  const unit = text.charCodeAt(at - 1);
  return at > 0 && at < text.length && unit >= 0xd800 && unit <= 0xdbff ? at - 1 : at;
}

/** A text no longer than `max` characters, ending in "…" where it was cut. */
export function clip(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, cutAt(text, Math.max(0, max - 1)))}…`;
}

export function hasOwn(o: object, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(o, key);
}

/** Two JSON values are the same value: key order never matters, array order does. */
export function jsonEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (Array.isArray(a) && Array.isArray(b)) return a.length === b.length && a.every((v, i) => jsonEqual(v, b[i]));
  if (isRecord(a) && isRecord(b)) {
    const keys = Object.keys(a);
    return keys.length === Object.keys(b).length && keys.every((k) => hasOwn(b, k) && jsonEqual(a[k], b[k]));
  }
  return false;
}

/** A whole number as a model's arguments give it, or written as text ("12"); null for anything else. */
export function wholeArg(v: unknown): number | null {
  const n = typeof v === "string" && v.trim() !== "" ? Number(v) : v;
  return typeof n === "number" && Number.isSafeInteger(n) ? n : null;
}

/** A text argument, trimmed; null when it is missing, not text, or blank. */
export function textArg(v: unknown): string | null {
  if (typeof v !== "string") return null;
  const t = v.trim();
  return t === "" ? null : t;
}

/** A token estimate of a text, at `charsPerToken` (a setting): what budgets and the session's length are measured in before a provider reports its own count. */
export function tokensOf(text: string, charsPerToken: number): number {
  return Math.ceil(text.length / charsPerToken);
}

/** Why a call failed, in its own words. */
export function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** A text as JSON, or undefined when it isn't JSON: outside data is read, never trusted. */
export function parseJson(text: string): unknown {
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return undefined;
  }
}
