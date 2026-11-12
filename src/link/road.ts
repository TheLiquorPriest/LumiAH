// The asks' own road (PI-BUILD-PLAN §4.7): what a page asks of the core, and what an extension that
// builds LumiAH in asks for its tools, can reach the runtime through Lumiverse's proxy to the
// runtime's loopback server (`spindle.cors`) instead of over the link, where it would wait behind
// whatever large frames the link carries. Both ends import this file, so they agree on the route,
// its headers, the proxy's bounds and the proof.
//
// The route is `POST /x/ask` on the runtime's loopback server. An ask carries the relay's secret as
// a bearer (never the loopback key), so only the extension that registered the runtime can ask it;
// the extension sends it only to an address that has first answered a probe with a proof bound to
// that secret, so the secret never goes to a program that isn't the runtime. The probe carries no
// secret: a nonce goes out, and the runtime answers with an HMAC of it under the relay's secret,
// which the extension checks against the secret it last heard on the link.

/** The route on the runtime's loopback server. Its path doesn't end in `.js`, which Lumiverse's proxy refuses. */
export const ASK_PATH = "/x/ask";

/** The header a probe carries its nonce in. A probe carries no secret. */
export const PROBE_HEADER = "x-lumiah-probe";

/** A probe's nonce: 128 random bits as hex. */
export const PROBE_NONCE = /^[0-9a-f]{32}$/;

/** How long Lumiverse's proxy waits for a hop, whatever it is asked: an ask that may wait longer goes over the link. */
export const PROXY_HOP_MS = 30_000;

/**
 * The most of an answer Lumiverse's proxy holds: it buffers the whole answer before the extension
 * sees any of it. The runtime answers a larger one with `TOO_LARGE_STATUS`, and the extension asks
 * again over the link, where it crosses in parts. A request's body is held to the same bound.
 */
export const PROXY_MAX_BYTES = 25 * 1024 * 1024;

/** Room left under that bound for what Lumiverse wraps an answer in. */
export const PROXY_ROOM_BYTES = 64 * 1024;

/** The status the runtime answers an ask with when its answer is too large for the proxy: the extension asks again over the link, and the runtime answers that from what it kept. */
export const TOO_LARGE_STATUS = 507;

/** An ask's id as the extension gives one: what the runtime knows an ask asked again by. */
export const ASK_ID = /^[0-9a-f]{16,128}$/;

function hex(bytes: Uint8Array): string {
  let out = "";
  for (const b of bytes) out += b.toString(16).padStart(2, "0");
  return out;
}

/** The proof a runtime answers a probe with: an HMAC-SHA256, under the relay's secret, of the relay's id and the probe's nonce. Its words are its own, so no proof made for anything else (`/healthz`'s) is one of these. */
export async function roadProof(secret: string, relay: string, nonce: string): Promise<string> {
  const encoder = new TextEncoder();
  const key = await crypto.subtle.importKey("raw", encoder.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return hex(new Uint8Array(await crypto.subtle.sign("HMAC", key, encoder.encode(`lumiah ask road\n${relay}\n${nonce}`))));
}

/** Whether two texts are the same, in a time that says nothing of where they first differ: each is hashed first, so neither its length nor its first difference shows. */
export async function sameSecret(a: string, b: string): Promise<boolean> {
  const encoder = new TextEncoder();
  const [x, y] = await Promise.all([crypto.subtle.digest("SHA-256", encoder.encode(a)), crypto.subtle.digest("SHA-256", encoder.encode(b))]);
  const left = new Uint8Array(x);
  const right = new Uint8Array(y);
  let differs = 0;
  for (let i = 0; i < left.length; i++) differs |= (left[i] ?? 0) ^ (right[i] ?? 0);
  return differs === 0;
}

/** Whether an address the runtime says it listens on is this machine's own loopback: one of its names, any address of 127.0.0.0/8, or `::1`. */
export function isLoopback(listen: string): boolean {
  const name = listen.toLowerCase();
  return name === "localhost" || name === "::1" || name === "[::1]" || /^127(\.\d{1,3}){3}$/.test(name);
}

/** The runtime's loopback server as the proxy reaches it: `http://<listen>:<port>`, an IPv6 address in brackets. */
export function roadBase(listen: string, port: number): string {
  const host = listen.includes(":") && !listen.startsWith("[") ? `[${listen}]` : listen;
  return `http://${host}:${port}`;
}
