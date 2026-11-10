// The link's client end (DESIGN §6): the runtime's own connection to Lumiverse (connection.ts), then
// the link's hello with the relay's secret and the link version on every socket it opens, so the
// extension sends the runtime's answers and pushes to that session and resumes the streams in flight
// from their last chunk. While down it reconnects with backoff; while up it pings every heartbeat
// with a report for the Runtime page, and every few seconds while it reads streams or answers turns,
// naming them, so an extension restart under a live socket ends them at once. It knows the extension
// silent when something it asked goes unanswered with nothing heard meanwhile. Daily it asks
// Lumiverse about its session, which renews it, and it keeps its origin in its account's
// local-inference scheduler exclusions.

import type { ChunkPush, ConnectionPush, LinkNotice, LinkRequests, LinkRequestType, OpenStream, RuntimeReport, SchedulerState, SessionReport, StopPush } from "../link/contract";
import { LINK, LINK_VERSION, versionWords } from "../link/contract";
import { pushOf } from "../link/frames";
import type { RuntimeTuning } from "../link/settings";
import type { OpenSocket } from "./connection";
import { HostConnection, LinkError } from "./connection";
import type { Http, LiveProblem, StoredLogin } from "./lumiverse";
import { excludeOrigins, LiveError, runtimeOrigins, sessionOf } from "./lumiverse";

/**
 * Why the extension is out of reach: the link down; the extension silent (asked, unanswered,
 * nothing heard); stopped by Lumiverse (restart, update, disable); or crashed (Lumiverse reported an
 * error, then nothing heard), which Lumiverse never restarts by itself.
 */
export interface OutOfReach {
  since: number;
  why: "down" | "silent" | "stopped" | "crashed";
  /** A crash's words, as Lumiverse reported them. */
  detail?: string | null;
}

/** The requests the runtime's parts send; the link sends `register`, `hello` and `ping` itself. */
export type AskType = Exclude<LinkRequestType, "register" | "hello" | "ping">;

/** A request's own fields: the envelope and the secret are the link's to add. */
export type Asked<T extends AskType> = Omit<LinkRequests[T]["fields"], "secret">;

/** What the runtime's parts need of the link. */
export interface RuntimeLink {
  /** The socket is open and the runtime said hello on it. */
  readonly up: boolean;
  /** The extension out of reach, since when and why; null while it answers. */
  readonly out: OutOfReach | null;
  /** Why the link can't serve at all (the registration is gone, the versions differ), or null. */
  readonly refused: string | null;
  /** One request, sent once the link is up (waiting `waitMs` at most), with the relay's secret. */
  request<T extends AskType>(type: T, fields: Asked<T>, waitMs: number): Promise<LinkRequests[T]["result"]>;
  /** A notice, sent now when the link is up and dropped when it isn't: nothing waits for it. */
  notify(notice: Omit<LinkNotice, "link">): void;
}

/** What the link hands the runtime's parts, and asks of them. */
export interface LinkHandlers {
  chunk(push: ChunkPush): void;
  /** The streams to resume on a new socket. */
  open(): OpenStream[];
  /** Streams the extension no longer holds. */
  lost(streams: readonly string[]): void;
  /** Lumiverse stopped the extension, or it crashed: every stream ends at once. */
  stopped(why: "stopped" | "crashed", detail: string | null): void;
  /** The user stopped a turn. */
  stop(push: StopPush): void;
  /** The user's settings stand at this revision now. */
  settings(revision: number): void;
  /** A loopback key to put in the loopback connection. */
  connection(push: ConnectionPush): void;
  /** The turns under way, for the ping and the report. */
  turns(): string[];
}

export interface LinkOptions {
  base: string;
  credentials(): StoredLogin | null;
  http: Http;
  openSocket: OpenSocket;
  /** The relay's id and secret now: the Runtime page's rotation changes the secret (`rotated`). */
  relay: string;
  secret(): string;
  /** The extension rotated the secret: keep it (the config file), then use it. */
  rotated(secret: string): void;
  name: string;
  build: string;
  runtime: RuntimeReport["runtime"];
  host: string;
  listen: string;
  port: number;
  tuning(): RuntimeTuning;
  now(): number;
  log(text: string): void;
}

/** Problems no wait mends: a request fails at once rather than wait for the link (a session that ended, an address locked out or refused, the extension missing or too old). */
const LASTING: Partial<Record<LiveProblem, true>> = { login: true, locked: true, forbidden: true, insecure: true, not_installed: true, too_old: true };

/** Words for a call that the extension's stop or crash ended or kept from starting. */
export function stoppedWords(why: "stopped" | "crashed", detail: string | null | undefined): string {
  if (why === "stopped") return "LumiAH was stopped on Lumiverse (restarted, updated or turned off), so this reply ended here. Press Retry, or swipe, once it runs again (Lumiverse's Extensions tab).";
  const said = detail?.replace(/\s+/g, " ").trim().slice(0, 200) ?? "";
  return `LumiAH stopped with an error${said !== "" ? ` (${said})` : ""}, so this reply ended here. Lumiverse doesn't restart it by itself: restart it in Lumiverse's Extensions tab, then press Retry.`;
}

export class LinkClient implements RuntimeLink {
  private readonly conn: HostConnection;
  private handlers: LinkHandlers | null = null;
  /** Bumped by every socket that opens: a new socket needs the link's hello. */
  private socketGen = 0;
  private greetedGen = -1;
  private connecting: Promise<void> | null = null;
  private failures = 0;
  private retryAt = 0;
  private lastProblem = "";
  private pingedAt = 0;
  private pinging = false;
  private refusal: string | null = null;
  /** Requests the extension hasn't answered yet, by when each was sent. */
  private readonly asked = new Map<number, number>();
  private askSeq = 0;
  /** When the extension last answered or pushed anything. */
  private heardAt = 0;
  /** When the earliest request that timed out since then was sent; null once the extension is heard again. */
  private timedOut: number | null = null;
  /** Since when the link has been down, as the last tick saw it. */
  private downAt: number | null = null;
  /**
   * Lumiverse stopped the extension (`SPINDLE_EXTENSION_UNLOADED`), or it crashed (an error report,
   * then nothing heard within `crashMs`). The live socket says when Lumiverse starts it again; a crash
   * it never restarts by itself. Cleared then, or when a hello on a new socket is answered.
   */
  private stoppedBy: { at: number; why: "stopped" | "crashed"; detail: string | null } | null = null;
  /** An error report not yet borne out: a crash unless the extension is heard within `crashMs`. */
  private suspect: { at: number; detail: string | null } | null = null;
  /** The extension's build and link version, from the last hello. */
  hello: LinkRequests["hello"]["result"] | null = null;
  scheduler: SchedulerState = "unknown";
  session: SessionReport = { valid: null, expiresAt: null, checkedAt: null };

  constructor(private readonly options: LinkOptions) {
    this.conn = new HostConnection({
      base: options.base,
      credentials: options.credentials,
      http: options.http,
      openSocket: options.openSocket,
      limits: () => {
        const { requestMs, socketPingMs, joinMaxUnits, partStaleMs } = options.tuning();
        return { requestMs, socketPingMs, joinMaxUnits, partStaleMs };
      },
      now: options.now,
      onOpen: () => {
        this.socketGen++;
      },
      onPush: (data) => this.push(data),
      onExtension: (change, detail) => this.lifecycle(change, detail),
    });
  }

  attach(handlers: LinkHandlers): void {
    this.handlers = handlers;
  }

  get up(): boolean {
    return this.refusal === null && this.stoppedBy === null && this.conn.isOpen() && this.greetedGen === this.socketGen;
  }

  get refused(): string | null {
    return this.refusal;
  }

  /**
   * The extension out of reach: stopped or crashed; the link down; or silent (something asked has
   * waited `silentMs` with nothing heard from the extension meanwhile, counted from the later of the
   * two). Null while it answers.
   */
  get out(): OutOfReach | null {
    const now = this.options.now();
    if (this.stoppedBy !== null) return { since: this.stoppedBy.at, why: this.stoppedBy.why, detail: this.stoppedBy.detail };
    if (!this.up) return { since: this.downAt ?? now, why: "down" };
    let oldest = this.timedOut;
    for (const at of this.asked.values()) if (oldest === null || at < oldest) oldest = at;
    if (oldest === null) return null;
    const since = Math.max(oldest, this.heardAt);
    return now - since >= this.options.tuning().silentMs ? { since, why: "silent" } : null;
  }

  /** Lumiverse's word on the extension's lifecycle, which reaches the runtime's socket too. */
  private lifecycle(change: "loaded" | "unloaded" | "error", detail: string | null): void {
    const now = this.options.now();
    if (change === "loaded") {
      // A new worker, which knows neither this runtime's session nor its streams: the next tick says hello to it.
      if (this.stoppedBy !== null) this.options.log("LumiAH is running again on Lumiverse");
      this.stoppedBy = null;
      this.suspect = null;
      this.greetedGen = -1;
      this.retryAt = 0;
      return;
    }
    if (change === "unloaded") {
      this.stop({ at: now, why: "stopped", detail: null });
      return;
    }
    // An error report: a worker that died, or one that carries on. It is asked at once, and the answer decides.
    this.suspect ??= { at: now, detail };
    this.pingedAt = 0;
  }

  private stop(stopped: { at: number; why: "stopped" | "crashed"; detail: string | null }): void {
    this.stoppedBy = stopped;
    this.suspect = null;
    this.greetedGen = -1;
    this.options.log(stoppedWords(stopped.why, stopped.detail));
    this.handlers?.stopped(stopped.why, stopped.detail);
  }

  report(): RuntimeReport {
    const { name, build, runtime, host, listen, port } = this.options;
    return { name, build, runtime, host, listen, port, scheduler: this.scheduler, session: this.session, turns: this.handlers?.turns().length ?? 0 };
  }

  async request<T extends AskType>(type: T, fields: Asked<T>, waitMs: number): Promise<LinkRequests[T]["result"]> {
    const deadline = this.options.now() + waitMs;
    const pause = async (): Promise<void> => {
      const { promise, resolve } = Promise.withResolvers<void>();
      setTimeout(resolve, Math.min(1_000, Math.max(0, deadline - this.options.now())));
      await promise;
    };
    while (!this.up) {
      if (this.refusal !== null) throw new LiveError("forbidden", this.refusal);
      const stopped = this.stoppedBy;
      if (stopped !== null && this.conn.isOpen()) {
        // The live socket will say when Lumiverse starts the extension again; a crash it never restarts by itself.
        if (stopped.why === "crashed" || this.options.now() >= deadline) throw new LiveError("not_running", stoppedWords(stopped.why, stopped.detail));
        await pause();
        continue;
      }
      try {
        await this.connect();
      } catch (error) {
        // A wait mends a link that is down, not a session that ended or an extension that's missing.
        if ((error instanceof LiveError && LASTING[error.problem] === true) || this.options.now() >= deadline) throw error;
        await pause();
      }
    }
    // The secret is the link's to add: the parts' fields never carry it.
    return this.ask(type, { ...fields, secret: this.options.secret() } as LinkRequests[T]["fields"]);
  }

  notify(notice: Omit<LinkNotice, "link">): void {
    if (this.up) this.conn.notify({ link: LINK, ...notice });
  }

  /** One request, kept in `asked` until the extension answers it: an answer of any kind is a sign of life, a timeout a sign of silence. */
  private async ask<T extends LinkRequestType>(type: T, fields: LinkRequests[T]["fields"]): Promise<LinkRequests[T]["result"]> {
    const id = ++this.askSeq;
    const at = this.options.now();
    this.asked.set(id, at);
    try {
      const answer = await this.conn.request(type, fields);
      this.heard();
      return answer;
    } catch (error) {
      if (error instanceof LinkError) this.heard();
      else if (error instanceof LiveError && error.problem === "timeout" && at >= this.heardAt) this.timedOut ??= at;
      throw error;
    } finally {
      this.asked.delete(id);
    }
  }

  private heard(): void {
    this.heardAt = this.options.now();
    this.timedOut = null;
  }

  /** Opens the socket if it is closed and says the link's hello on it; one at a time. */
  connect(): Promise<void> {
    this.connecting ??= this.greet().finally(() => {
      this.connecting = null;
    });
    return this.connecting;
  }

  private async greet(): Promise<void> {
    await this.conn.ensureOpen();
    const gen = this.socketGen;
    let answer: LinkRequests["hello"]["result"];
    try {
      answer = await this.ask("hello", { secret: this.options.secret(), version: LINK_VERSION, build: this.options.build, report: this.report(), open: this.handlers?.open() ?? [] });
    } catch (error) {
      if (error instanceof LinkError && error.code === "forbidden") this.refuse(`LumiAH refused this runtime (${error.message}) Register it again with its start line on LumiAH's Runtime page.`);
      else if (error instanceof LinkError && error.code === "version") this.refuse(error.message);
      else if (error instanceof LinkError && error.code === "bad_request") this.refuse(`LumiAH on ${this.options.base} doesn't know this runtime's hello (${error.message}): update LumiAH (Extensions → LumiAH → Update).`);
      else if (error instanceof LiveError && error.problem === "timeout") throw new LiveError("timeout", `LumiAH on ${this.options.base} didn't answer the runtime's hello. Check that it's running in Lumiverse's Extensions tab.`);
      throw error;
    }
    // An extension that didn't refuse another version itself is refused here, in the same words.
    if (answer.version !== LINK_VERSION) {
      this.refuse(versionWords(LINK_VERSION, answer.version));
      throw new LiveError("too_old", this.refusal ?? "");
    }
    const again = this.hello !== null || this.failures > 0;
    this.hello = answer;
    this.pingedAt = this.options.now();
    // Only the socket the hello was said on counts as greeted; an answered hello also shows the extension running.
    if (gen === this.socketGen) this.greetedGen = gen;
    this.stoppedBy = null;
    this.suspect = null;
    if (Array.isArray(answer.lost) && answer.lost.length > 0) this.handlers?.lost(answer.lost);
    if (typeof answer.settings === "number") this.handlers?.settings(answer.settings);
    this.options.log(`${again ? "linked again" : "linked"} to LumiAH ${answer.build} on ${this.options.base}`);
    this.failures = 0;
    this.lastProblem = "";
  }

  private refuse(why: string): void {
    this.refusal = why;
    this.options.log(why);
    this.conn.close();
  }

  private push(data: Record<string, unknown>): void {
    // Whatever the extension sends is a sign of life.
    this.heard();
    const push = pushOf(data);
    if (push === null) return;
    switch (push.type) {
      case "chunk":
        this.handlers?.chunk(push);
        return;
      case "stop":
        this.handlers?.stop(push);
        return;
      case "settings":
        this.handlers?.settings(push.revision);
        return;
      case "connection":
        this.handlers?.connection(push);
        return;
      case "secret":
        if (push.relay !== this.options.relay) return;
        this.options.rotated(push.secret);
        this.options.log("LumiAH rotated this runtime's secret: the new one is in its config");
        return;
    }
  }

  /** Every start: the scheduler exclusion again, reported on the next ping. */
  async fix(): Promise<void> {
    const token = this.options.credentials()?.token;
    if (token === undefined) return;
    const origins = runtimeOrigins(this.options.listen, this.options.port);
    const was = this.scheduler;
    this.scheduler = await excludeOrigins(this.options.http, this.options.base, token, origins);
    if (this.scheduler !== was && (this.scheduler === "missing" || this.scheduler === "unknown")) this.options.log(`couldn't put ${origins.join(" and ")} in the local-inference scheduler's Excluded origins. Before turning the scheduler on, add them there (Lumiverse → Settings → Inference scheduler): a turn would otherwise wait on its own calls.`);
    this.pingedAt = 0;
  }

  /** Asks Lumiverse about the session, which renews it; an ended one answers `null`. */
  async refreshSession(): Promise<void> {
    const now = this.options.now();
    try {
      const state = await sessionOf(this.options.http, this.options.base, this.options.credentials()?.token ?? null);
      this.session = { valid: state.valid, expiresAt: state.expiresAt, checkedAt: now };
      if (state.valid === false) this.options.log(`the runtime's Lumiverse session for ${this.options.base} has ended: sign it in again with lumiah login`);
    } catch (error) {
      this.session = { ...this.session, valid: null, checkedAt: now };
      this.options.log(`couldn't ask ${this.options.base} about the runtime's session: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  /** The heartbeat, naming the streams the extension took and the turns under way: the streams it no longer holds end at once. */
  private ping(streams: string[], turns: string[]): void {
    this.pingedAt = this.options.now();
    this.pinging = true;
    this.ask("ping", { secret: this.options.secret(), report: this.report(), streams, turns })
      .then((answer) => {
        if (Array.isArray(answer.lost) && answer.lost.length > 0) this.handlers?.lost(answer.lost);
      })
      .catch((error: unknown) => {
        if (error instanceof LinkError && error.code === "forbidden") this.refuse(`LumiAH refused this runtime (${error.message}) Register it again with its start line on LumiAH's Runtime page.`);
      })
      .finally(() => {
        this.pinging = false;
      });
  }

  /** Every second: reconnect when down (with backoff), ping when due (often while streams or turns are open), weigh an error report, and ask about the session when due. */
  tick(): void {
    const now = this.options.now();
    const { crashMs, sessionCheckMs, reconnectMs, reconnectMaxMs, probeMs, heartbeatMs } = this.options.tuning();
    if (!this.up) this.downAt ??= now;
    else this.downAt = null;
    if (this.refusal !== null) return;
    if (this.suspect !== null) {
      // Heard since the report: the worker carries on. Silent through `crashMs`: it crashed.
      if (this.heardAt >= this.suspect.at) this.suspect = null;
      else if (now - this.suspect.at >= crashMs) this.stop({ at: this.suspect.at, why: "crashed", detail: this.suspect.detail });
    }
    if (this.session.checkedAt === null || now - this.session.checkedAt >= sessionCheckMs) {
      this.session = { ...this.session, checkedAt: now };
      void this.refreshSession();
    }
    if (!this.up) {
      // Stopped under a live socket: Lumiverse says when it starts the extension again, so nothing is sent meanwhile.
      if (this.stoppedBy !== null && this.conn.isOpen()) return;
      if (this.connecting !== null || now < this.retryAt) return;
      this.connect().catch((error: unknown) => {
        const ended = error instanceof LiveError && error.problem === "login";
        if (ended) this.session = { ...this.session, valid: false };
        const problem = ended ? `the runtime's Lumiverse session for ${this.options.base} has ended: sign it in again with lumiah login` : error instanceof Error ? error.message : String(error);
        this.retryAt = this.options.now() + Math.min(reconnectMaxMs, reconnectMs * 2 ** Math.min(this.failures, 16));
        this.failures++;
        if (problem !== this.lastProblem) this.options.log(`can't reach LumiAH yet (trying again): ${problem}`);
        this.lastProblem = problem;
      });
      return;
    }
    if (this.pinging) return;
    const streams = (this.handlers?.open() ?? []).map((s) => s.stream);
    const turns = this.handlers?.turns() ?? [];
    if (now - this.pingedAt >= (streams.length > 0 || turns.length > 0 ? probeMs : heartbeatMs)) this.ping(streams, turns);
  }

  close(): void {
    this.conn.close();
  }
}
