// The runtime's end of the asks (PI-BUILD-PLAN §4.7): what a page asks of the core, and what an
// extension that builds LumiAH in asks for its tools, arrives two ways. Over the link it is an `ask`
// push answered with `ask.answer`; through Lumiverse's proxy it is `POST /x/ask` on the runtime's
// loopback server (link/road.ts), answered in the response. Both reach the same answer as the link
// always gave it, so the proxy road answers exactly the page ops the link does.
//
// An ask is done once, whichever road it came by. The extension may send one by the proxy and then
// over the link as well (the proxy didn't answer in time, or its answer was too large for it): the
// second joins the first while it is under way, and once it is over is answered from what it came
// to, kept a short while for that. What is kept is bounded by count and by size; one whose answer
// was let go for room is said to be answered already rather than done again.
//
// The route takes the relay's secret as a bearer, compared in a time that says nothing of it, and
// never the loopback key. Every refusal is in fixed words: nothing of a request is said back, and
// nothing of its body is read before its bearer checks out. It never redirects. A probe (a nonce,
// no secret) is answered with a proof bound to the secret, so the extension sends the secret only
// to the runtime it is linked to.

import type { JsonObject, JsonValue } from "../link/json";
import { isRecord } from "../link/json";
import { ASK_ID, PROBE_HEADER, PROBE_NONCE, PROXY_MAX_BYTES, PROXY_ROOM_BYTES, roadProof, sameSecret, TOO_LARGE_STATUS } from "../link/road";
import type { Road } from "../link/timings";
import { refusalOf } from "../link/work";

/** What refused an ask: one of the pages' codes, the words the page shows, and what was wrong with a value where the core says. */
export interface AskRefusal {
  code: string;
  message: string;
  problems?: JsonValue;
}

/** What an ask came to: its value, or what refused it; and how long the runtime worked on it, in ms. */
export interface AskOutcome {
  value: JsonValue;
  refusal: AskRefusal | null;
  took: number;
}

/** How long an ask that came by the proxy is remembered once answered, so the same ask sent again over the link is answered from it. */
export const ASKS_KEPT_MS = 2 * 60_000;
/** The most answered asks remembered at once, and the most characters of their answers kept. */
export const ASKS_KEPT = 1_024;
export const ASK_CHARS_KEPT = 64 * 1024 * 1024;

/** The longest op an ask names: every one is a name the code gives, far shorter. */
const OP_MAX = 64;

export interface AskDeskDeps {
  /** This runtime's registration: an ask addressed to another is refused. */
  relay: string;
  /** The relay's secret now: what an ask on the proxy road must carry, and what a probe's proof is made with. */
  secret(): string;
  now(): number;
  log(text: string): void;
  /** Whether the runtime answers an op at all, by its name. */
  knows(op: string): boolean;
  /** The op's answer, as an `ask` push over the link is answered: rejects with what refused it. */
  answer(op: string, args: JsonObject): Promise<JsonValue>;
}

interface Kept {
  /** Settles with what the ask came to. */
  done: Promise<AskOutcome>;
  /** When it ended; null while under way. */
  endedAt: number | null;
  /** What it came to, while kept; null while under way, or once let go for room. */
  outcome: AskOutcome | null;
  /** The characters of its answer kept. */
  chars: number;
  /** It came by the proxy: once over it is remembered for an ask again over the link. */
  remembered: boolean;
}

const json = (status: number, body: JsonObject): Response => new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json", "Cache-Control": "no-store" } });

/** A refusal of the route's own, in words that say nothing of the request. */
const refuse = (status: number, code: string, message: string): Response => json(status, { refusal: { code, message } });

export class AskDesk {
  /** The asks under way, and those answered that are still remembered, oldest first. */
  private readonly asks = new Map<string, Kept>();
  private chars = 0;

  constructor(private readonly deps: AskDeskDeps) {}

  /** The asks under way now. */
  get underWay(): number {
    let n = 0;
    for (const kept of this.asks.values()) if (kept.endedAt === null) n++;
    return n;
  }

  /**
   * One ask, by its id: done now, or joined to the same ask under way, or answered from what it came
   * to when it came by the proxy and is still remembered. `road`: the road it came by now.
   */
  run(id: string, op: string, args: JsonObject, road: Road): Promise<AskOutcome> {
    const known = this.asks.get(id);
    if (known !== undefined) {
      if (road === "proxy") known.remembered = true;
      if (known.endedAt === null) return known.done;
      if (known.outcome !== null) return Promise.resolve(known.outcome);
      return Promise.resolve({ value: null, refusal: { code: "unavailable", message: "The runtime answered this already, by the other road. Try again." }, took: 0 });
    }
    const started = this.deps.now();
    const kept: Kept = { done: Promise.resolve({ value: null, refusal: null, took: 0 }), endedAt: null, outcome: null, chars: 0, remembered: road === "proxy" };
    kept.done = this.deps.answer(op, args).then(
      (value): AskOutcome => ({ value, refusal: null, took: this.deps.now() - started }),
      (error: unknown): AskOutcome => {
        const refusal = refusalOf(error);
        // Its op and the refusal's own words, never what it was asked with: an ask's args may hold a key.
        if (refusal.code === "internal") this.deps.log(`${op} failed: ${refusal.message}`);
        return { value: null, refusal, took: this.deps.now() - started };
      },
    );
    this.asks.set(id, kept);
    void kept.done.then((outcome) => {
      kept.endedAt = this.deps.now();
      if (kept.remembered) kept.outcome = outcome;
      else this.asks.delete(id);
      this.prune();
    });
    return kept.done;
  }

  /** What an answer kept costs, once the route has its text: counted against what may be kept. */
  private counted(id: string, chars: number): void {
    const kept = this.asks.get(id);
    if (kept === undefined || kept.outcome === null || kept.chars > 0) return;
    kept.chars = chars;
    this.chars += chars;
    this.prune();
  }

  /** Lets go of what is past its time, then of the oldest answers past the bounds. An ask under way is never let go. */
  private prune(): void {
    const now = this.deps.now();
    for (const [id, kept] of this.asks) {
      if (kept.endedAt === null) continue;
      const stale = now - kept.endedAt > ASKS_KEPT_MS;
      if (stale || this.asks.size > ASKS_KEPT) {
        this.asks.delete(id);
        this.chars -= kept.chars;
      } else if (this.chars > ASK_CHARS_KEPT && kept.outcome !== null) {
        kept.outcome = null;
        this.chars -= kept.chars;
        kept.chars = 0;
      }
    }
  }

  /** `POST /x/ask` on the runtime's loopback server (the relay hands it every request on that path, after its own checks of Origin and Host). */
  readonly fetch = async (req: Request): Promise<Response> => {
    if (req.method !== "POST") return refuse(405, "bad_request", "This route takes POST.");
    const nonce = req.headers.get(PROBE_HEADER);
    if (nonce !== null) {
      if (!PROBE_NONCE.test(nonce)) return refuse(400, "bad_request", "That isn't a probe.");
      return json(200, { proof: await roadProof(this.deps.secret(), this.deps.relay, nonce) });
    }
    const shown = /^Bearer\s+(\S+)$/i.exec((req.headers.get("authorization") ?? "").trim())?.[1] ?? "";
    // Nothing of the request is read before its bearer is the relay's secret.
    if (shown === "" || !(await sameSecret(shown, this.deps.secret()))) return refuse(401, "forbidden", "This route takes the secret of the runtime's registration.");
    const text = await bodyOf(req);
    if (text === null) return refuse(413, "too_large", "That ask is larger than the proxy carries: it goes over the link.");
    let body: unknown;
    try {
      body = JSON.parse(text);
    } catch {
      return refuse(400, "bad_request", "That ask isn't JSON.");
    }
    if (!isRecord(body) || typeof body.ask !== "string" || !ASK_ID.test(body.ask) || typeof body.op !== "string" || body.op === "" || body.op.length > OP_MAX || !isRecord(body.args) || (body.where !== undefined && !isRecord(body.where))) return refuse(400, "bad_request", "That isn't an ask.");
    if (isRecord(body.where) && body.where.relay !== undefined && body.where.relay !== this.deps.relay) return refuse(409, "conflict", "That ask is for another runtime.");
    if (!this.deps.knows(body.op)) return refuse(400, "bad_request", "The runtime answers no such ask: update the runtime and the extension to the same build.");
    const id = body.ask;
    const outcome = await this.run(id, body.op, body.args as JsonObject, "proxy");
    const answer = JSON.stringify(outcome);
    this.counted(id, answer.length);
    // One the proxy can't hold is kept, and the extension asks for it again over the link, where it crosses in parts.
    if (answer.length > PROXY_MAX_BYTES - PROXY_ROOM_BYTES) return json(TOO_LARGE_STATUS, { refusal: { code: "too_large", message: "This answer is larger than Lumiverse's proxy carries: ask again over the link." }, took: outcome.took });
    return new Response(answer, { status: 200, headers: { "Content-Type": "application/json", "Cache-Control": "no-store" } });
  };
}

/** A request's body as text, read as it arrives and given up past what the proxy carries; null when it is larger. */
async function bodyOf(req: Request): Promise<string | null> {
  const declared = Number(req.headers.get("content-length") ?? "0");
  if (Number.isFinite(declared) && declared > PROXY_MAX_BYTES) return null;
  if (req.body === null) return "";
  const parts: Uint8Array[] = [];
  let bytes = 0;
  const reader = req.body.getReader();
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    bytes += value.byteLength;
    if (bytes > PROXY_MAX_BYTES) {
      void reader.cancel().catch(() => undefined);
      return null;
    }
    parts.push(value);
  }
  return new TextDecoder().decode(Buffer.concat(parts));
}
