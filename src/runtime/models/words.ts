// What a failed call says, in the provider's own words with its HTTP status first ("529: Overloaded
// (overloaded_error)"), so the loop's reading of a failure (core/provider.ts: one that passes, one
// that lasts, a refusal of native tools) reads it as it read Lumiverse's. pi-ai composes its error
// text per API: the Anthropic SDK's "529 {json}", the OpenAI SDK's "429: {json}", "OpenAI API error
// (429): {json}" and "Mistral API error (429): body", or Google's JSON alone with its code inside.
// Each is read back to a status and the provider's message.
//
// And what keeps a secret out of every word that leaves the layer: a key or a token the runtime
// holds, wherever it shows up in a provider's text (some echo a key they refused), is taken out.

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

/** The shortest secret worth looking for: shorter ones would match ordinary words. */
const SECRET_FLOOR = 8;

/** Text with every secret named taken out of it, wherever it stands. */
export function redact(text: string, secrets: Iterable<string>): string {
  let out = text;
  for (const secret of secrets) {
    if (secret.length >= SECRET_FLOOR && out.includes(secret)) out = out.split(secret).join("[secret]");
  }
  return out;
}

/** An error's text: its message, or what it is. */
export function errorWords(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
