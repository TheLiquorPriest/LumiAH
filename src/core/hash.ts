// The core's hashes (DESIGN §5): every blob's address, the fingerprint of a message's text, the path
// hash chained over a chat's messages, and the keys of what the core keeps in memory. SHA-256 through
// `crypto.subtle`, which a worker and a process both have, in lower-case hex.

import type { ChatRole } from "./ports";

const HEX = /^[0-9a-f]{64}$/;

/** Whether a value is a hash as the core writes one, so outside data naming a blob can't name anything else. */
export function isHash(value: unknown): value is string {
  return typeof value === "string" && HEX.test(value);
}

function hex(buffer: ArrayBuffer): string {
  let out = "";
  for (const byte of new Uint8Array(buffer)) out += byte.toString(16).padStart(2, "0");
  return out;
}

/** SHA-256 of a text's UTF-8: a blob's address, and a chat message's fingerprint (`PathMessage.hash`). */
export async function textHash(text: string): Promise<string> {
  return hex(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text)));
}

/** A hash of several parts, each kept apart from the next, so ("ab", "c") and ("a", "bc") differ. */
export function partsHash(...parts: readonly string[]): Promise<string> {
  return textHash(JSON.stringify(parts));
}

/** The path hash of an empty chat: what the first message chains onto. */
export const ROOT_PATH = "";

/** The path hash after one more message: chained over its role and its text's fingerprint, so an edit, a deletion or another branch before a record moves every path after it. */
export function nextPath(parent: string, role: ChatRole, hash: string): Promise<string> {
  return partsHash("lumiah.path", parent, role, hash);
}
