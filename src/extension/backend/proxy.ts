// The asks' own road (PI-BUILD-PLAN §4.7): what a page asks of the core, and what an extension that
// builds LumiAH in asks for its tools, can reach a runtime through Lumiverse's proxy to the runtime's
// loopback server (`spindle.cors`, `POST /x/ask`) instead of over the link, where an ask waits behind
// whatever large frames the link carries. This is the extension's end of that road: whether a
// runtime can be reached on it, and an ask sent on it. Asks (asks.ts) chooses the road for each ask.
//
// A runtime is reached on this road only while all of these hold:
// - this extension holds `cors_proxy`. Only an owner or an admin grants it (an update never does),
//   and Lumiverse tells the worker at once when it is granted or taken away;
// - the runtime says it listens on a loopback address. Lumiverse's proxy runs on Lumiverse's
//   machine, so that is the only address that can be the runtime's own there;
// - that address, asked through the proxy, answered a probe with a proof bound to the runtime's
//   secret, since the runtime last opened its link. A probe carries a nonce and no secret; the
//   runtime answers with an HMAC of it under its relay secret, which this end checks against the
//   secret the runtime last showed on the link. A runtime on another machine fails it (whatever
//   answers there holds no such secret), so nothing more of what a runtime says of itself is
//   trusted than where to look. The secret goes as a bearer only to an address that proved this;
// - the road hasn't failed in the last little while (`RETRY_MS`): a failure falls back to the link
//   once, and the road is checked again before it is used again, so every ask doesn't pay for it.
//
// The secret is held in memory only, as the runtime last showed it on the link (the registration
// keeps only its hash), and it is never logged, shown, put in a URL or said in an error.

import type { JsonValue } from "../../core/ports";
import { isRecord } from "../../link/json";
import { ASK_PATH, isLoopback, PROBE_HEADER, roadBase, roadProof, sameSecret, TOO_LARGE_STATUS } from "../../link/road";
import type { TransportSettings } from "../../link/settings";
import { spanWords, transportWait } from "../../link/waits";
import type { RoadsView, RoadView } from "../../shared/ui";
import type { BackendHost, CorsReply } from "./spindle";

/** How long a failed road is left alone before it is checked again: asks go over the link meanwhile. Not a wait anyone meets: the link answers them. */
export const RETRY_MS = 2 * 60_000;

/** The permission the road rests on. */
export const CORS_PROXY = "cors_proxy";

/** A runtime reached on the road: its loopback server through the proxy, and the secret its asks carry. */
export interface Opened {
  base: string;
  secret: string;
}

/** What the road brought back: the runtime's answer (its value, or what refused it, how long it worked, and the characters that came); an answer too large for the proxy; or a failure of the road itself. */
export type RoadAnswer = { kind: "answer"; value: JsonValue; refusal: { code?: unknown; message?: unknown; problems?: unknown } | null; took: number | null; got: number } | { kind: "too_large" } | { kind: "failed" };

export interface ProxyDeps {
  host: Pick<BackendHost, "granted" | "cors">;
  /** The permissions the extension's manifest chose not to ask for: one of them can never be granted. */
  declined: ReadonlySet<string>;
  /** Where a runtime says it listens; null for one that isn't registered. */
  address(userId: string, relay: string): Promise<{ listen: string; port: number } | null>;
  transport(userId: string): Promise<TransportSettings>;
  now(): number;
  /** 128 random bits as hex: a probe's nonce. */
  nonce(): string;
  /** Whether a runtime has a link now: a road is kept only for one that has. */
  isLinked(userId: string, relay: string): boolean;
  /** How the road to a user's runtimes stands changed: the Runtime page shows it. */
  changed(userId: string): void;
  /** The extension as its pages show it. */
  name: string;
  /** Where its Settings are shown, where that isn't "<name>'s Settings" (`BackendIdentity.settingsAt`): a timeout's words name it. */
  settingsAt?: string;
}

/** The road to one runtime, as last found. */
interface Road {
  /** The runtime's secret as it last showed it on the link, and the session it showed it on. */
  secret: string;
  session: string;
  /** The last probe: the address it asked, on which session, whether the proof held, and why not. */
  checked: { base: string; session: string; held: boolean; at: number; why: string | null } | null;
  probing: Promise<void> | null;
  /** The road failed under an ask: when, and why. Cleared by a probe that holds. */
  failed: { at: number; why: string } | null;
}

const SEP = "\u0000";

/** Words that came back from the proxy, with nothing of the secret in them, whatever they held. */
function cleaned(words: string, secret: string): string {
  return secret === "" ? words : words.replaceAll(secret, "…");
}

/** A promise given up after `ms`: rejects with `late`'s words then. */
function within<T>(promise: Promise<T>, ms: number, late: string): Promise<T> {
  const { promise: timeout, reject } = Promise.withResolvers<never>();
  const timer = setTimeout(() => reject(new Error(late)), ms);
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

export class ProxyRoad {
  private readonly roads = new Map<string, Road>();

  constructor(private readonly deps: ProxyDeps) {}

  /** Whether this extension holds the permission now. */
  get granted(): boolean {
    return this.deps.host.granted(CORS_PROXY);
  }

  /**
   * A runtime showed its secret on the link, on `session` (every request does). Kept in memory as it
   * stands; a new session, or another secret, means the address is checked again before the road
   * takes the secret anywhere: on a new session at once, in the background.
   */
  heard(userId: string, relay: string, session: string, secret: string): void {
    const key = `${userId}${SEP}${relay}`;
    const road = this.roads.get(key);
    if (road !== undefined && road.session === session && road.secret === secret) return;
    const fresh: Road = { secret, session, checked: null, probing: null, failed: null };
    this.roads.set(key, fresh);
    if (this.granted) void this.probe(userId, relay, fresh);
  }

  /** A runtime's link went away, or it was forgotten: its secret is let go, and its road with it. */
  forget(userId: string, relay: string): void {
    if (this.roads.delete(`${userId}${SEP}${relay}`)) this.deps.changed(userId);
  }

  /** The permission was granted or taken away: every runtime's road is checked again, or ends now. */
  permission(granted: boolean): void {
    const users = new Set<string>();
    for (const [key, road] of this.roads) {
      const [userId = "", relay = ""] = key.split(SEP);
      users.add(userId);
      road.checked = null;
      road.failed = null;
      if (granted) void this.probe(userId, relay, road);
    }
    for (const userId of users) this.deps.changed(userId);
  }

  /** The runtime as the road reaches it now; null when it doesn't (and the ask goes over the link), checking it again in the background where that is due. */
  async open(userId: string, relay: string): Promise<Opened | null> {
    if (!this.granted) return null;
    const road = this.roads.get(`${userId}${SEP}${relay}`);
    if (road === undefined) return null;
    const now = this.deps.now();
    if (road.failed !== null && now - road.failed.at < RETRY_MS) return null;
    const checked = road.checked;
    const address = await this.deps.address(userId, relay);
    const base = address !== null && isLoopback(address.listen) ? roadBase(address.listen, address.port) : null;
    if (checked !== null && checked.held && checked.session === road.session && checked.base === base && road.failed === null) return { base: checked.base, secret: road.secret };
    // Never checked on this link, checked at another address, or failed long enough ago: checked again, and the link carries this ask.
    if (base !== null && road.probing === null && (checked === null || checked.session !== road.session || checked.base !== base || road.failed !== null)) void this.probe(userId, relay, road);
    return null;
  }

  /** Probes a runtime's address through the proxy: whether whatever answers there holds the runtime's secret. Never rejects. */
  private probe(userId: string, relay: string, road: Road): Promise<void> {
    road.probing ??= (async () => {
      const at = this.deps.now();
      const address = await this.deps.address(userId, relay);
      if (address === null || !isLoopback(address.listen)) {
        road.checked = { base: "", session: road.session, held: false, at, why: null };
        return;
      }
      const base = roadBase(address.listen, address.port);
      const nonce = this.deps.nonce();
      const waitMs = (await this.deps.transport(userId)).pages.proxyMs;
      let why: string | null = null;
      try {
        const reply = await within(this.deps.host.cors(`${base}${ASK_PATH}`, { method: "POST", headers: { [PROBE_HEADER]: nonce, "Content-Type": "application/json" }, body: "{}" }), waitMs, `it didn't answer within ${spanWords(waitMs)}`);
        let said: unknown = null;
        try {
          said = JSON.parse(reply.body);
        } catch {
          // Not JSON: no proof below.
        }
        const proof = isRecord(said) && typeof said.proof === "string" ? said.proof : "";
        if (reply.status !== 200 || !(await sameSecret(proof, await roadProof(road.secret, relay, nonce)))) why = "what answers there didn't prove it is this runtime";
      } catch (error) {
        why = cleaned(error instanceof Error ? error.message : String(error), road.secret);
      }
      // The runtime may have shown another secret, or opened another link, while the probe was out: then this probe says nothing of it.
      if (this.roads.get(`${userId}${SEP}${relay}`) !== road) return;
      road.checked = { base, session: road.session, held: why === null, at, why };
      if (why === null) road.failed = null;
    })().finally(() => {
      road.probing = null;
      this.deps.changed(userId);
    });
    return road.probing;
  }

  /**
   * One ask on the road: `body` is the ask as JSON. Never rejects: a failure of the road is
   * remembered, so the next asks go over the link until the road is checked again, and is said as
   * `failed`; an answer too large for the proxy as `too_large`, which is no failure of the road.
   */
  async send(userId: string, relay: string, opened: Opened, body: string): Promise<RoadAnswer> {
    let reply: CorsReply;
    try {
      reply = await this.deps.host.cors(`${opened.base}${ASK_PATH}`, { method: "POST", headers: { Authorization: `Bearer ${opened.secret}`, "Content-Type": "application/json" }, body });
    } catch (error) {
      this.failed(userId, relay, cleaned(error instanceof Error ? error.message : String(error), opened.secret));
      return { kind: "failed" };
    }
    if (reply.status === TOO_LARGE_STATUS) return { kind: "too_large" };
    let said: unknown = null;
    try {
      said = JSON.parse(reply.body);
    } catch {
      // Not JSON: a failure of the road below.
    }
    if (reply.status !== 200 || !isRecord(said) || !("value" in said) || !(said.refusal === null || isRecord(said.refusal))) {
      // A secret the runtime no longer takes (it was rotated) is shown again on the link's next request, and the road is checked again then.
      this.failed(userId, relay, reply.status === 401 ? "the runtime didn't take its secret (it may have been rotated)" : `it answered ${reply.status}`);
      return { kind: "failed" };
    }
    const took = typeof said.took === "number" && Number.isFinite(said.took) && said.took >= 0 ? said.took : null;
    return { kind: "answer", value: (said.value ?? null) as JsonValue, refusal: isRecord(said.refusal) ? said.refusal : null, took, got: reply.body.length };
  }

  /** The road failed under an ask: remembered, so the asks that follow go over the link until it is checked again. */
  private failed(userId: string, relay: string, why: string): void {
    const road = this.roads.get(`${userId}${SEP}${relay}`);
    if (road === undefined) return;
    road.failed = { at: this.deps.now(), why };
    this.deps.changed(userId);
  }

  /** A user's runtimes changed how they stand: the secret and the road of each whose link is gone are let go. */
  sweep(userId: string): void {
    for (const key of [...this.roads.keys()]) {
      const [owner = "", relay = ""] = key.split(SEP);
      if (owner === userId && !this.deps.isLinked(userId, relay)) this.forget(userId, relay);
    }
  }

  /** How the road to each of a user's runtimes stands, for the Runtime page. `linked`: the runtimes linked now, by id. */
  async view(userId: string, relays: readonly { id: string; linked: boolean }[]): Promise<RoadsView> {
    const { name } = this.deps;
    const granted = this.granted;
    const declined = this.deps.declined.has(CORS_PROXY);
    const offer = granted
      ? null
      : declined
        ? `Pages reach your runtime over the link alone: ${name} doesn't ask Lumiverse for the permission "${CORS_PROXY}", which opens a faster road.`
        : `Granting ${name} the permission "${CORS_PROXY}" (Extensions → ${name} → Permissions; only an owner or an admin can) lets its pages, and the tools of an extension that builds it in, reach a runtime on this machine through Lumiverse's own proxy, so a request doesn't wait behind a reply's or a job's traffic on the link. Without it everything still works over the link.`;
    const out: Record<string, RoadView> = {};
    for (const { id, linked } of relays) {
      const road = this.roads.get(`${userId}${SEP}${id}`);
      const address = await this.deps.address(userId, id);
      if (!linked || road === undefined) out[id] = { road: "link", why: "It isn't linked now.", at: null };
      else if (!granted) out[id] = { road: "link", why: `${name} doesn't hold the permission "${CORS_PROXY}".`, at: null };
      else if (address === null || !isLoopback(address.listen)) out[id] = { road: "link", why: `It listens on ${address?.listen ?? "an address it hasn't said"}, not on a loopback address: Lumiverse's proxy reaches only a runtime on Lumiverse's own machine.`, at: null };
      else if (road.failed !== null) out[id] = { road: "link", why: `The faster road failed (${road.failed.why}). It is checked again within ${spanWords(RETRY_MS)}; the link carries every request meanwhile.`, at: road.failed.at };
      else if (road.checked === null || road.checked.session !== road.session || road.probing !== null) out[id] = { road: "link", why: "Checking that Lumiverse's proxy reaches it…", at: null };
      else if (!road.checked.held) out[id] = { road: "link", why: `Lumiverse's proxy didn't reach it at ${road.checked.base} (${road.checked.why ?? "no answer"}): it may run on another machine, or behind a firewall that keeps Lumiverse out. ${transportWait(["pages", "proxyMs"], this.deps)} says how long the check waits.`, at: road.checked.at };
      else out[id] = { road: "proxy", why: null, at: road.checked.at };
    }
    return { granted, offer, relays: out };
  }
}
