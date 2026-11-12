// The proof `GET /healthz` takes that a request comes from whoever holds the runtime's config
// (`lumiah status`, and `up` before it ends a running runtime's link), where the runtime listens on
// an address other machines reach. It is an HMAC of the moment it was made and a nonce, under the
// relay's secret: the secret never crosses, and whatever answers on the runtime's port when the
// runtime doesn't (another account's program, while the runtime is down) learns nothing it can use.
// A proof holds for a minute either side of its time, once: the runtime refuses one it has seen.

/** How far a proof's time may be from the runtime's clock. */
export const PROOF_WINDOW_MS = 60_000;

const FORM = /^([0-9]{1,16})\.([0-9a-f]{32})\.([0-9a-f]{64})$/;

function hex(bytes: Uint8Array): string {
  return [...bytes].map((b) => b.toString(16).padStart(2, "0")).join("");
}

async function mac(secret: string, at: number, nonce: string): Promise<string> {
  const encoder = new TextEncoder();
  const key = await crypto.subtle.importKey("raw", encoder.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return hex(new Uint8Array(await crypto.subtle.sign("HMAC", key, encoder.encode(`lumiah healthz\n${at}\n${nonce}`))));
}

/** A proof made now (`at`, ms since the epoch) with a nonce of its own: `<at>.<nonce>.<hmac>`. */
export async function healthProof(secret: string, at: number): Promise<string> {
  const nonce = hex(crypto.getRandomValues(new Uint8Array(16)));
  return `${at}.${nonce}.${await mac(secret, at, nonce)}`;
}

/** Whether two texts are the same, in a time that doesn't say where they first differ. */
function same(a: string, b: string): boolean {
  let differs = a.length ^ b.length;
  for (let i = 0; i < a.length && i < b.length; i++) differs |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return differs === 0;
}

/** The runtime's side: the proofs it has taken within the window, so none is taken twice. */
export class HealthProofs {
  /** The nonces of the proofs taken, by their time; let go once their time is out of the window. */
  private readonly taken = new Map<string, number>();

  constructor(
    private readonly secret: () => string,
    private readonly now: () => number,
  ) {}

  /** Whether `shown` is a proof made with the relay's secret now, and not one taken before. */
  async holds(shown: string): Promise<boolean> {
    const parts = FORM.exec(shown);
    if (parts === null) return false;
    const [, time = "", nonce = "", given = ""] = parts;
    const at = Number(time);
    const now = this.now();
    for (const [seen, when] of this.taken) if (now - when > PROOF_WINDOW_MS) this.taken.delete(seen);
    if (Math.abs(now - at) > PROOF_WINDOW_MS || this.taken.has(nonce)) return false;
    if (!same(given, await mac(this.secret(), at, nonce))) return false;
    this.taken.set(nonce, at);
    return true;
  }
}
