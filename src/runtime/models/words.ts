// What a failed call says, in the provider's own words with its HTTP status first ("529: Overloaded
// (overloaded_error)"), so the loop's reading of a failure (core/provider.ts: one that passes, one
// that lasts, a refusal of native tools) reads it as it read Lumiverse's. pi-ai composes its error
// text per API: the Anthropic SDK's "529 {json}", the OpenAI SDK's "429: {json}", "OpenAI API error
// (429): {json}" and "Mistral API error (429): body", or Google's JSON alone with its code inside.
// Each is read back to a status and the provider's message.
//
// And what keeps a secret out of every word that leaves the layer: a key, a token or a header's
// value the runtime holds, wherever it shows up in a provider's text (some echo a key they
// refused), is taken out, and no text that leaves is longer than a page or a log line has use for.

import { isRecord } from "../../core/ports";

/** A status at the head of a provider's text: "529 {…}" or "429: {…}". */
const LEADING_STATUS = /^(\d{3})(?::\s*|\s+)([\s\S]*)$/;
/** A status in pi-ai's own prefix: "OpenAI API error (429): {…}", "Mistral API error (503): …". */
const PREFIXED_STATUS = /^[^\n(]*\((\d{3})\):\s*([\s\S]*)$/;

/** A value as text, when it is text that says something. */
function said(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() !== "" ? value.trim() : undefined;
}

/**
 * A provider's error body read for its words: the message of `{error: {message, type}}` (Anthropic,
 * OpenAI and the servers that copy them), of `{message, type}`, of Google's `{error: {code,
 * message, status}}`, or of OAuth's `{error, error_description}`, with its kind where it names one,
 * and the status a body carries in its code. Null when the text isn't such a body.
 */
function bodyWords(text: string): { words: string; status?: number } | null {
  if (!text.startsWith("{")) return null;
  let body: unknown;
  try {
    body = JSON.parse(text);
  } catch {
    return null;
  }
  if (!isRecord(body)) return null;
  const inner = isRecord(body.error) ? body.error : body;
  const description = said(inner.error_description);
  const code = said(inner.error);
  const message = said(inner.message) ?? description ?? code;
  if (message === undefined) return null;
  const kind = said(inner.type) ?? said(inner.status) ?? said(inner.code) ?? (description !== undefined ? code : undefined);
  const status = typeof inner.code === "number" && inner.code >= 100 && inner.code <= 599 ? inner.code : undefined;
  return { words: kind !== undefined && !message.includes(kind) ? `${message} (${kind})` : message, ...(status !== undefined ? { status } : {}) };
}

/**
 * A failed call's words as the loop reads them: the HTTP status first where there was one, then the
 * provider's own message (and its kind), then whatever pi-ai said after the body. Text that carries
 * no status (a connection that dropped, a stream that ended early) stands as it came.
 */
export function failureWords(text: string): string {
  const trimmed = text.trim();
  const found = LEADING_STATUS.exec(trimmed) ?? PREFIXED_STATUS.exec(trimmed);
  let status = found ? Number(found[1]) : undefined;
  const rest = found ? (found[2] ?? "") : trimmed;
  // A body is one line of JSON; pi-ai may add a line of its own after it (a ChatGPT usage link).
  const cut = rest.indexOf("\n");
  const head = cut === -1 ? rest : rest.slice(0, cut);
  const tail = cut === -1 ? "" : rest.slice(cut);
  const body = bodyWords(head.trim());
  status ??= body?.status;
  const words = body !== null ? `${body.words}${tail}` : rest;
  return status !== undefined ? `${status}: ${words}` : words;
}

/** What Bun's fetch says when it meets a redirect it was told not to follow. */
export const REDIRECT_REFUSED = /\bUnexpectedRedirect\b/;
/** The words for it: the runtime follows no redirect, since a call's key and headers would go with it to an address nobody gave them for. */
export const REDIRECT_WORDS = "the server answered with a redirect to another address, which the runtime doesn't follow, so that the connection's key and headers never go with it: give the connection the address it moved to.";

/** The shortest secret worth looking for: shorter ones would match ordinary words. So a save refuses a key any shorter (book.ts); a header's value may be shorter, and is then not looked for. */
export const SECRET_FLOOR = 8;
/** What stands where a secret was. */
const HIDDEN = "[secret]";
/** Where pi-ai cut a long error body short ("… [truncated 120 chars]"): a secret the cut went through leaves its first characters just before it. */
const CUT_MARK = "... [truncated ";
/** The most characters of words that leave the layer: a server's error body can be any length, and a page or a log line has no use for more. */
export const WORDS_MAX = 2000;

/**
 * Text fit to leave the layer: every secret named taken out, wherever it stands, and the text cut
 * to `WORDS_MAX` characters after that, so no cut ever leaves part of a secret behind.
 */
export function redact(text: string, secrets: Iterable<string>): string {
  // Longest first: a secret that holds a shorter one is taken out whole, never left half shown around it.
  const wanted = [...new Set(secrets)].filter((s) => s.length >= SECRET_FLOOR).sort((a, b) => b.length - a.length);
  let out = text;
  for (const secret of wanted) if (out.includes(secret)) out = out.split(secret).join(HIDDEN);
  out = withoutCutSecrets(out, wanted);
  return out.length > WORDS_MAX ? `${out.slice(0, WORDS_MAX)}…` : out;
}

/** Takes out the first characters of a secret where a text was cut short through it: before pi-ai's mark of a cut, or at the text's very end. */
function withoutCutSecrets(text: string, secrets: readonly string[]): string {
  const cuts: number[] = [];
  for (let at = text.indexOf(CUT_MARK); at !== -1; at = text.indexOf(CUT_MARK, at + 1)) cuts.push(at);
  cuts.push(text.length);
  let out = text;
  // From the last cut back, so that where the earlier ones stand still holds.
  for (const end of cuts.reverse()) {
    for (const secret of secrets) {
      const head = secret.slice(0, SECRET_FLOOR);
      let from = out.indexOf(head, Math.max(0, end - secret.length + 1));
      while (from !== -1 && from <= end - SECRET_FLOOR && !secret.startsWith(out.slice(from, end))) from = out.indexOf(head, from + 1);
      if (from !== -1 && from <= end - SECRET_FLOOR) {
        out = `${out.slice(0, from)}${HIDDEN}${out.slice(end)}`;
        break;
      }
    }
  }
  return out;
}

/** A wait in words: "5 minutes", "a minute", "90 seconds". */
export function durationWords(ms: number): string {
  const seconds = Math.max(1, Math.round(ms / 1000));
  if (seconds % 60 === 0) return seconds === 60 ? "a minute" : `${seconds / 60} minutes`;
  return seconds === 1 ? "a second" : `${seconds} seconds`;
}

/** An error's text: its message, or what it is. */
export function errorWords(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
