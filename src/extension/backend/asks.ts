// What a page asks of the core (DESIGN §4, §8, §25). The core keeps the workspace, the jobs, the
// side sessions, the spend and the rest in documents in the user's storage, and it runs in the
// user's runtime. So a page's request for any of it is sent on to a runtime, which does it with its
// core and answers. Which runtime:
//
// - about a chat on a loopback connection: the one that chat's replies reach (the one whose loopback
//   connection the chat generates on), since its jobs and side sessions run there; while that one
//   isn't linked there is nobody to ask, and the page is told so;
// - about a run under way, or a job that isn't over: the one it runs in;
// - about anything else (no chat, the user's own files, their definitions, the spend, the sweep, a
//   chat that generates elsewhere): the user's runtime, the one linked now that was heard from last.
//
// With no runtime linked there is nobody to ask, and the page is told that in plain words.
//
// Which road (PI-BUILD-PLAN §4.7): through Lumiverse's proxy to the runtime's loopback server where
// it reaches that runtime (proxy.ts says when) and the ask's wait fits under the proxy's own 30
// seconds; else over the link, as an `ask` push answered with `ask.answer`. On the proxy road an ask
// doesn't wait behind the link's large frames. Past the proxy road's own wait it is sent over the
// link as well, and whichever answers first is taken; one the proxy road fails, or whose answer is
// too large for it, goes over the link once. The runtime does an ask once, whichever road brings it
// (by its id), so nothing a page asked is done twice. Each crossing goes in the timing log, by its
// op, road, size each way and time: never what it carried.

import type { JsonObject, JsonValue } from "../../core/ports";
import { LINK } from "../../link/contract";
import { isRecord } from "../../link/json";
import { PROXY_HOP_MS, PROXY_MAX_BYTES, PROXY_ROOM_BYTES } from "../../link/road";
import type { Outcome, Road, Timings } from "../../link/timings";
import { spanWords, transportWait } from "../../link/waits";
import type { UiErrorCode, UiProblem } from "../../shared/ui";
import { UiRefused } from "./errors";
import type { Opened, ProxyRoad } from "./proxy";
import type { Relays } from "./relays";
import type { SettingsStore } from "./settings";

/** What a page's request is about, which says where it is done. At most one of `relay`, `chat`, `run`, `job` and `side`; none: about no chat. */
export interface Where {
  /** One of the user's runtimes, by its id (`RelayView.id`): what it is asked of itself (how it is run, its update, its connections, its store). Another user's is never asked. */
  relay?: string;
  /** The chat it is about; null: none. */
  chat?: string | null;
  /** A run under way, by the stream it is followed under and its id. */
  run?: { stream: string; turn: string };
  /** A job, by its id. */
  job?: string;
  /** A side session, by its id. */
  side?: string;
  /** It takes as long as it takes (the sweep): a runtime is waited for as long as it stays linked. */
  patient?: boolean;
}

export interface AsksDeps {
  relays: Pick<Relays, "push" | "isLinked">;
  settings: Pick<SettingsStore, "transport">;
  /** Whether a chat generates on a loopback connection, so its replies reach a runtime; rejects (`not_found`) for a chat that isn't the user's. */
  onLoopback(userId: string, chatId: string): Promise<boolean>;
  /** The runtime a chat on a loopback connection generates on (the one whose loopback connection the chat is on), by its id; null while that runtime isn't linked. */
  runtimeOf(userId: string, chatId: string): Promise<string | null>;
  /** The user's runtime for what is about no chat: the one linked now that was heard from last; null while none is. */
  userRuntime(userId: string): Promise<string | null>;
  /** The runtime a run under way runs in; null when it isn't under way. */
  runOf(userId: string, stream: string, turn: string): string | null;
  /** The runtime a job that isn't over runs in; null when nothing was heard of it since the extension started. */
  jobOf(userId: string, job: string): string | null;
  /** The extension as its pages show it. */
  name: string;
  /** Where its Settings are shown, where that isn't "<name>'s Settings" (`BackendIdentity.settingsAt`): a timeout's words name it. */
  settingsAt?: string;
  now(): number;
  /** Runs `fn` once after `ms`; what it returns cancels that. */
  later(ms: number, fn: () => void): () => void;
  /** An id no other ask under way has: 128 bits or more, as hex. */
  id(): string;
  /** The road through Lumiverse's proxy (proxy.ts); absent, every ask goes over the link. */
  road?: Pick<ProxyRoad, "open" | "send">;
  /** This end of the timing log; absent, nothing is logged. */
  timings?: Timings;
}

/** How an ask ended: its value, or what refused it or gave it up; the road that brought it, how long the runtime said it worked on it, and the characters that came. */
type Settled = ({ value: JsonValue } | { error: Error; outcome: Exclude<Outcome, "ok"> }) & { road: Road; took: number | null; got: number };

interface Pending {
  userId: string;
  relay: string;
  op: string;
  args: JsonObject;
  /** When it was sent, the characters it sent, and the road it took first. */
  at: number;
  sent: number;
  road: Road;
  /** It went over the link (its push reached the runtime's session). */
  linked: boolean;
  /** Its ask on the proxy road is still out. */
  proxied: boolean;
  /** Ends the wait on the proxy road alone. */
  unproxy(): void;
  settle(out: Settled): void;
}

/** The codes a refusal may carry to a page; anything else its place says is a failure of its own. */
const CODES: Readonly<Record<string, UiErrorCode>> = { bad_request: "bad_request", not_found: "not_found", forbidden: "forbidden", unavailable: "unavailable", invalid: "invalid", conflict: "conflict" };

const LINK_DROPPED = "The runtime's link just dropped. Try again once the Runtime page shows it linked.";

function problemsOf(raw: unknown): UiProblem[] | undefined {
  if (!Array.isArray(raw)) return undefined;
  const out: UiProblem[] = [];
  for (const one of raw) if (isRecord(one) && Array.isArray(one.path) && typeof one.message === "string") out.push({ path: one.path.filter((k): k is string | number => typeof k === "string" || typeof k === "number"), message: one.message });
  return out;
}

/** A refusal of the core's, or of the place that holds it, as a page is told it: its own code and words where it has one of the pages' codes, else a failure named as `who`'s. */
export function refused(refusal: { code?: unknown; message?: unknown; problems?: unknown }, who: string): UiRefused {
  const said = typeof refusal.message === "string" && refusal.message !== "" ? refusal.message : `${who} couldn't do that.`;
  const code = typeof refusal.code === "string" ? CODES[refusal.code] : undefined;
  return new UiRefused(code ?? "internal", code === undefined ? `${who} couldn't do that (${said}).` : said, problemsOf(refusal.problems));
}

/** The characters a value comes to as JSON: about what crossed for it, for the timing log. */
const sizeOf = (value: unknown): number => JSON.stringify(value ?? null).length;

export class Asks {
  private readonly pending = new Map<string, Pending>();

  constructor(private readonly deps: AsksDeps) {}

  /** The chat a job or a side session is about, as the user's runtime reads it from the store; null: none, or there is no such job or session. */
  private async chatOf(userId: string, op: "jobs.read" | "sides.turns", id: string): Promise<string | null> {
    try {
      const read = await this.ask(userId, op, { id });
      const row = isRecord(read) ? (op === "jobs.read" ? read.job : read.side) : undefined;
      return isRecord(row) && typeof row.chatId === "string" && row.chatId !== "" ? row.chatId : null;
    } catch (error) {
      // No such job or session: the core says so in its own words, asked about it again where it runs.
      if (error instanceof UiRefused && error.code === "not_found") return null;
      throw error;
    }
  }

  /** The runtime a request goes to, by its id; `{ chat }`: that chat's runtime, which isn't linked; `{ relay }`: the runtime asked for, which isn't one of the user's linked now; null: no runtime of the user's is linked. */
  private async place(userId: string, where: Where): Promise<string | { chat: string } | { relay: string } | null> {
    // Only the user's own runtime is ever pushed to: an id that isn't one of theirs is never linked for them.
    if (where.relay !== undefined) return this.deps.relays.isLinked(userId, where.relay) ? where.relay : { relay: where.relay };
    const running = where.run !== undefined ? this.deps.runOf(userId, where.run.stream, where.run.turn) : null;
    if (running !== null) return running;
    let chat = where.chat ?? null;
    if (where.job !== undefined) {
      const runs = this.deps.jobOf(userId, where.job);
      if (runs !== null) return runs;
      chat = await this.chatOf(userId, "jobs.read", where.job);
    } else if (where.side !== undefined) chat = await this.chatOf(userId, "sides.turns", where.side);
    if (chat !== null && (await this.deps.onLoopback(userId, chat))) return (await this.deps.runtimeOf(userId, chat)) ?? { chat };
    return this.deps.userRuntime(userId);
  }

  /**
   * Asks the core for `op` in the runtime `where` says: its own answer. Refused as the core or the
   * runtime refused it; `unavailable`, in words that say what to do, when no runtime of the user's
   * is linked, when the chat's isn't, when the one asked goes away, and when it doesn't answer in
   * the time Settings give (`patient`: it is waited for as long as it stays linked).
   */
  async ask(userId: string, op: string, args: JsonObject, where: Where = {}): Promise<JsonValue> {
    const relay = await this.place(userId, where);
    const start = `Start it (its line is on ${this.deps.name}'s Runtime page) and try again.`;
    if (relay === null) throw new UiRefused("unavailable", `${this.deps.name} needs its runtime for this, and none is linked now. ${start}`);
    if (typeof relay !== "string") throw new UiRefused("unavailable", "relay" in relay ? `That runtime isn't linked now. ${start}` : `This chat runs in a runtime, and that runtime isn't linked now. ${start}`);
    const { askMs: waitMs, proxyMs } = (await this.deps.settings.transport(userId)).pages;
    // Lumiverse's proxy waits 30 seconds at most: an ask that may wait longer goes over the link, as an ask always went.
    const opened = where.patient !== true && waitMs <= PROXY_HOP_MS && this.deps.road !== undefined ? await this.deps.road.open(userId, relay) : null;
    const id = this.deps.id();
    // The ask as the proxy road carries it, with where it is going, so a runtime refuses one meant for another.
    const body = opened === null ? null : JSON.stringify({ ask: id, op, args, where: { ...where, relay } });
    const proxied = body !== null && body.length <= PROXY_MAX_BYTES - PROXY_ROOM_BYTES;
    const { promise, resolve, reject } = Promise.withResolvers<JsonValue>();
    const unwait = where.patient
      ? (): void => undefined
      : this.deps.later(waitMs, () => {
          const pending = this.pending.get(id);
          if (pending !== undefined) this.settle(id, { error: new UiRefused("unavailable", `The runtime didn't answer within ${spanWords(waitMs)}. It may be busy or restarting: try again in a moment. ${transportWait(["pages", "askMs"], this.deps)} says how long a page waits for it.`), outcome: "timeout", road: pending.road, took: null, got: 0 });
        });
    this.pending.set(id, {
      userId,
      relay,
      op,
      args,
      at: this.deps.now(),
      sent: proxied && body !== null ? body.length : sizeOf(args),
      road: proxied ? "proxy" : "link",
      linked: false,
      proxied,
      unproxy: () => undefined,
      settle: (out) => {
        unwait();
        if ("error" in out) reject(out.error);
        else resolve(out.value);
      },
    });
    if (proxied && opened !== null && body !== null) this.viaProxy(id, opened, body, proxyMs);
    else this.viaLink(id);
    return promise;
  }

  /** Sends an ask on the proxy road, and past the road's own wait over the link as well; whichever answers first settles it. */
  private viaProxy(id: string, opened: Opened, body: string, proxyMs: number): void {
    const pending = this.pending.get(id);
    const road = this.deps.road;
    if (pending === undefined || road === undefined) return;
    pending.unproxy = this.deps.later(proxyMs, () => this.viaLink(id));
    void road.send(pending.userId, pending.relay, opened, body).then((answer) => {
      const still = this.pending.get(id);
      // Answered over the link already, or given up.
      if (still === undefined) return;
      still.proxied = false;
      still.unproxy();
      if (answer.kind === "answer") {
        if (answer.refusal !== null) this.settle(id, { error: refused(answer.refusal, "The runtime"), outcome: "refused", road: "proxy", took: answer.took, got: answer.got });
        else this.settle(id, { value: answer.value, road: "proxy", took: answer.took, got: answer.got });
      }
      // Too large for the proxy, or the road failed: over the link, once (the runtime answers it from what it kept, or does it if it never got it).
      else if (!still.linked) this.viaLink(id);
    });
  }

  /** Sends an ask over the link (once). While the link is down it fails, unless its ask on the proxy road is still out, whose answer is then waited for. */
  private viaLink(id: string): void {
    const pending = this.pending.get(id);
    if (pending === undefined || pending.linked) return;
    if (this.deps.relays.push(pending.userId, pending.relay, { link: LINK, type: "ask", ask: id, op: pending.op, args: pending.args })) pending.linked = true;
    else if (!pending.proxied) this.settle(id, { error: new UiRefused("unavailable", LINK_DROPPED), outcome: "failed", road: "link", took: null, got: 0 });
  }

  private settle(id: string, out: Settled): void {
    const pending = this.pending.get(id);
    if (pending === undefined) return;
    this.pending.delete(id);
    pending.unproxy();
    this.deps.timings?.add({ at: pending.at, op: pending.op, road: out.road, sent: pending.sent, got: out.got, ms: this.deps.now() - pending.at, workMs: out.took, outcome: "error" in out ? out.outcome : "ok" });
    pending.settle(out);
  }

  /** `ask.answer`: what a runtime answered over the link, and how long it worked on it (`took`, ms; absent from a runtime from before it). One that names no ask of this runtime's (answered late, twice, or by the other road first) is left. */
  answered(userId: string, relay: string, ask: unknown, value: unknown, refusal: unknown, took?: unknown): void {
    if (typeof ask !== "string") return;
    const pending = this.pending.get(ask);
    if (pending === undefined || pending.userId !== userId || pending.relay !== relay) return;
    const worked = typeof took === "number" && Number.isFinite(took) && took >= 0 ? took : null;
    if (isRecord(refusal)) {
      this.settle(ask, { error: refused(refusal, "The runtime"), outcome: "refused", road: "link", took: worked, got: sizeOf(refusal) });
      return;
    }
    this.settle(ask, { value: value === undefined ? null : (value as JsonValue), road: "link", took: worked, got: sizeOf(value) });
  }

  /** A user's runtimes changed how they stand: what one whose link is gone was asked, and hasn't answered, fails now. */
  recheck(userId: string): void {
    const gone = new Set<string>();
    for (const pending of this.pending.values()) if (pending.userId === userId && !this.deps.relays.isLinked(userId, pending.relay)) gone.add(pending.relay);
    for (const relay of gone) this.relayGone(userId, relay);
  }

  /** A runtime's link went away, or it was forgotten: what it was asked and hasn't answered fails now, unless its ask on the proxy road is still out, which answers or fails by itself. */
  relayGone(userId: string, relay: string): void {
    for (const [id, pending] of [...this.pending]) {
      if (pending.userId === userId && pending.relay === relay && !pending.proxied) this.settle(id, { error: new UiRefused("unavailable", "The runtime's link dropped before it answered. Try again once the Runtime page shows it linked."), outcome: "failed", road: pending.road, took: null, got: 0 });
    }
  }
}
