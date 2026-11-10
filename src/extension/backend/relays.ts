// A user's runtimes as the extension knows them now (DESIGN §6): which are registered (registry.ts
// keeps that), where each one's pushes go (the session that last spoke with its secret), when it
// last spoke and what it said of itself. Every request but `register` is authenticated here by its
// secret, and the `hello` handshake checks the link version both ends speak.

import type { LinkFrame, LinkPush, LinkRequests, RuntimeReport } from "../../link/contract";
import { LINK, LINK_VERSION, MODEL_ID, RUNTIME_NAME, runtimeBase, shellWord, versionWords } from "../../link/contract";
import { REPORT_TEXT_MAX, runtimeReportOf } from "../../link/frames";
import type { LinkState, RelayView, RuntimeView } from "../../shared/ui";
import { URL_SLOT } from "../../shared/ui";
import { randomHex, sha256 } from "./docs";
import { LinkRefused } from "./errors";
import type { RegistryStore, RelayRecord } from "./registry";
import type { SettingsStore } from "./settings";
import type { BackendHost } from "./spindle";

/** A runtime as it lives now: where its pushes go, when it last spoke, what it last said, why its hello was refused, and how the pages last saw its link. */
interface Live {
  session: string | null;
  seenAt: number | null;
  report: RuntimeReport | null;
  refused: string | null;
  /** The turns it named on its last ping. */
  turns: string[];
  shown: LinkState;
}

/** A request's runtime, once its secret checked out. */
export interface Caller {
  userId: string;
  relay: RelayRecord;
  session: string;
}

export interface RelaysEnv {
  now(): number;
  build: string;
  /** Sends a frame to a session, in parts when it is too large to cross whole. */
  send(frame: LinkFrame, userId: string, session: string): void;
}

const SEP = "\u0000";
const key = (userId: string, relay: string): string => `${userId}${SEP}${relay}`;

const short = (v: unknown): v is string => typeof v === "string" && v.length <= REPORT_TEXT_MAX;

/** What of a report is kept with the registration: how the runtime is installed, not how it is doing. */
const installOf = (r: RuntimeReport | null): string => (r === null ? "" : JSON.stringify([r.name, r.build, r.runtime, r.host, r.listen, r.port]));

export class Relays {
  private readonly live = new Map<string, Live>();
  /** Each session a runtime spoke on, to the runtime it spoke for. */
  private readonly sessions = new Map<string, string>();
  /**
   * A secret just rotated out, by its runtime: it still admits the requests the runtime sent before
   * the new one reached it, until the runtime first uses the new one or a request's wait has passed.
   * Without it a ping already on its way would be refused, and the runtime would take that as its
   * registration gone.
   */
  private readonly outgoing = new Map<string, { hash: string; until: number }>();
  private readonly changed: ((userId: string) => void)[] = [];
  private readonly pinged: ((userId: string, relay: string, turns: readonly string[]) => void)[] = [];

  constructor(
    private readonly host: Pick<BackendHost, "install" | "log">,
    private readonly registry: RegistryStore,
    private readonly settings: SettingsStore,
    private readonly env: RelaysEnv,
  ) {}

  /** What the Runtime page shows of a user's runtimes changed. */
  onChange(listener: (userId: string) => void): void {
    this.changed.push(listener);
  }

  /** A runtime pinged, naming the turns it answers. */
  onPing(listener: (userId: string, relay: string, turns: readonly string[]) => void): void {
    this.pinged.push(listener);
  }

  private tell(userId: string): void {
    for (const listener of this.changed) listener(userId);
  }

  private liveOf(userId: string, relay: string): Live {
    const k = key(userId, relay);
    let live = this.live.get(k);
    if (live === undefined) {
      live = { session: null, seenAt: null, report: null, refused: null, turns: [], shown: "down" };
      this.live.set(k, live);
    }
    return live;
  }

  private stateOf(live: Live | undefined, quietMs: number): LinkState {
    if (live === undefined) return "down";
    if (live.refused !== null) return "refused";
    if (live.session === null || live.seenAt === null) return "down";
    return this.env.now() - live.seenAt <= quietMs ? "linked" : "quiet";
  }

  /** Tells the pages when a runtime's link stands otherwise than they last saw. */
  private async follow(userId: string, live: Live): Promise<void> {
    const state = this.stateOf(live, (await this.settings.transport(userId)).link.quietMs);
    if (state === live.shown) return;
    live.shown = state;
    this.tell(userId);
  }

  /**
   * The runtime behind a request's secret; the frame's session is where its pushes go from now on.
   * Refused (`forbidden`) for a secret that is no runtime's of this user, so a runtime carries only
   * its own account's work.
   */
  async authenticate(secret: unknown, userId: string, session: string): Promise<Caller> {
    const refused = new LinkRefused("forbidden", "LumiAH doesn't know this runtime (its registration was forgotten or replaced): run its start line on LumiAH's Runtime page again.");
    if (typeof secret !== "string" || secret === "") throw refused;
    const hash = await sha256(secret);
    const relays = (await this.registry.read(userId)).relays;
    let relay = Object.values(relays).find((r) => r.secret === hash);
    if (relay !== undefined) this.outgoing.delete(key(userId, relay.id));
    else {
      relay = Object.values(relays).find((r) => {
        const old = this.outgoing.get(key(userId, r.id));
        return old !== undefined && old.hash === hash && this.env.now() <= old.until;
      });
      if (relay === undefined) throw refused;
    }
    const live = this.liveOf(userId, relay.id);
    if (live.session !== session) {
      if (live.session !== null) this.sessions.delete(live.session);
      live.session = session;
      this.sessions.set(session, key(userId, relay.id));
    }
    return { userId, relay, session };
  }

  /** `register`: a runtime's first word, with its user's own session and no secret yet. Mints its secret, kept only as a hash; the same name again replaces the registration. */
  async register(fields: Record<string, unknown>, userId: string): Promise<LinkRequests["register"]["result"]> {
    const { name, build, host, listen, port } = fields;
    if (typeof name !== "string" || !RUNTIME_NAME.test(name)) throw new LinkRefused("bad_request", "A runtime's name is lowercase letters, digits, _ and -, up to 40.");
    if (!short(build) || !short(host) || !short(listen) || listen === "" || typeof port !== "number" || !Number.isInteger(port) || port < 1 || port > 65535) throw new LinkRefused("bad_request", "The runtime's registration is malformed: update the runtime and LumiAH to the same build.");
    const most = (await this.settings.transport(userId)).link.relays;
    const secret = randomHex(256);
    const hash = await sha256(secret);
    const now = this.env.now();
    const id = await this.registry.change(userId, (registry) => {
      const held = Object.values(registry.relays).find((r) => r.name === name);
      if (held === undefined && Object.keys(registry.relays).length >= most) return null;
      const relay = held?.id ?? randomHex(64);
      registry.relays[relay] = { id: relay, name, secret: hash, build, host, listen, port, registeredAt: now, report: held?.report ?? null };
      return relay;
    });
    if (id === null) throw new LinkRefused("conflict", `This account has ${most} runtimes registered already: forget one on LumiAH's Runtime page first.`);
    // Its old secret no longer speaks for it, so neither does the session that used it.
    const live = this.liveOf(userId, id);
    if (live.session !== null) this.sessions.delete(live.session);
    live.session = null;
    live.refused = null;
    this.outgoing.delete(key(userId, id));
    this.host.log("info", `[LumiAH] runtime "${name}" registered`);
    this.tell(userId);
    return { relay: id, secret, model: MODEL_ID, user: userId };
  }

  /** `hello`: the version checked, the runtime's report kept. Refused in words that name which side to update when the versions differ. */
  async hello(caller: Caller, fields: Record<string, unknown>): Promise<void> {
    const live = this.liveOf(caller.userId, caller.relay.id);
    const version = fields.version;
    if (typeof version !== "number" || !Number.isSafeInteger(version)) throw new LinkRefused("bad_request", "The runtime's hello names no link version: update the runtime with its start line on LumiAH's Runtime page.");
    if (version !== LINK_VERSION) {
      live.refused = versionWords(version, LINK_VERSION);
      live.seenAt = this.env.now();
      const report = runtimeReportOf(fields.report);
      if (report !== null) live.report = report;
      live.shown = "refused";
      this.tell(caller.userId);
      throw new LinkRefused("version", live.refused);
    }
    live.refused = null;
    await this.heard(caller, fields.report);
  }

  /** `ping`: the runtime is there, and says how it is doing and which turns it answers. */
  async ping(caller: Caller, fields: Record<string, unknown>): Promise<void> {
    const turns = Array.isArray(fields.turns) ? fields.turns.filter((t): t is string => typeof t === "string") : [];
    this.liveOf(caller.userId, caller.relay.id).turns = turns;
    await this.heard(caller, fields.report);
    for (const listener of this.pinged) listener(caller.userId, caller.relay.id, turns);
  }

  private async heard(caller: Caller, rawReport: unknown): Promise<void> {
    const live = this.liveOf(caller.userId, caller.relay.id);
    const report = runtimeReportOf(rawReport);
    const before = JSON.stringify(live.report);
    live.seenAt = this.env.now();
    if (report !== null) {
      live.report = report;
      // How it is installed is kept with its registration, so the page has its lines while it is down; how it is doing lives only here.
      if (installOf(report) !== installOf(caller.relay.report)) {
        await this.registry.change(caller.userId, (registry) => {
          const held = registry.relays[caller.relay.id];
          if (held !== undefined) held.report = report;
        });
      }
    }
    if (before !== JSON.stringify(live.report)) {
      live.shown = this.stateOf(live, (await this.settings.transport(caller.userId)).link.quietMs);
      this.tell(caller.userId);
    } else await this.follow(caller.userId, live);
  }

  /** A session went away: the runtime that spoke on it has nowhere for its pushes until it says hello again. */
  sessionClosed(session: string): void {
    const k = this.sessions.get(session);
    if (k === undefined) return;
    this.sessions.delete(session);
    const live = this.live.get(k);
    if (live === undefined || live.session !== session) return;
    live.session = null;
    live.turns = [];
    live.shown = this.stateOf(live, 0);
    this.tell(k.slice(0, k.indexOf(SEP)));
  }

  /** Every so often: a runtime that went quiet shows as quiet, and a secret rotated out long ago is let go. */
  async tick(): Promise<void> {
    const now = this.env.now();
    for (const [k, old] of this.outgoing) if (now > old.until) this.outgoing.delete(k);
    for (const [k, live] of this.live) if (live.session !== null) await this.follow(k.slice(0, k.indexOf(SEP)), live).catch(() => undefined);
  }

  /** Pushes to a runtime's session; false while it has none (its hello resumes what it missed). */
  push(userId: string, relay: string, push: LinkPush): boolean {
    const session = this.live.get(key(userId, relay))?.session ?? null;
    if (session === null) return false;
    this.env.send(push, userId, session);
    return true;
  }

  /** The user's runtimes that are linked now, the one heard from last first. */
  async linked(userId: string): Promise<RelayRecord[]> {
    const quietMs = (await this.settings.transport(userId)).link.quietMs;
    const seen = (r: RelayRecord): number => this.live.get(key(userId, r.id))?.seenAt ?? 0;
    return Object.values((await this.registry.read(userId)).relays)
      .filter((r) => this.stateOf(this.live.get(key(userId, r.id)), quietMs) === "linked")
      .sort((a, b) => seen(b) - seen(a));
  }

  /** Where Lumiverse reaches each of the user's runtimes: what makes a connection a loopback. */
  async bases(userId: string): Promise<string[]> {
    return Object.values((await this.registry.read(userId)).relays).map((r) => runtimeBase(r.listen, r.port));
  }

  /** Rotates a runtime's secret: the runtime takes the new one over its link, and the old one stops working. Refused while it isn't linked, since it could never learn the new one. */
  async rotate(userId: string, relay: string): Promise<void> {
    const held = (await this.registry.read(userId)).relays[relay];
    if (held === undefined) throw new LinkRefused("not_found", "There is no such runtime.");
    const transport = await this.settings.transport(userId);
    if (this.stateOf(this.live.get(key(userId, relay)), transport.link.quietMs) !== "linked") throw new LinkRefused("unavailable", "This runtime isn't linked now, so it couldn't take a new secret. Start it first, or forget it and run its start line again.");
    const secret = randomHex(256);
    const hash = await sha256(secret);
    this.outgoing.set(key(userId, relay), { hash: held.secret, until: this.env.now() + transport.runtime.requestMs });
    await this.registry.change(userId, (r) => {
      const record = r.relays[relay];
      if (record !== undefined) record.secret = hash;
    });
    this.push(userId, relay, { link: LINK, type: "secret", relay, secret });
    this.tell(userId);
  }

  /** Forgets a runtime: its secret stops working, and it must register again. */
  async forget(userId: string, relay: string): Promise<void> {
    const found = await this.registry.change(userId, (r) => {
      if (r.relays[relay] === undefined) return false;
      delete r.relays[relay];
      return true;
    });
    if (!found) throw new LinkRefused("not_found", "There is no such runtime.");
    const k = key(userId, relay);
    const session = this.live.get(k)?.session ?? null;
    if (session !== null) this.sessions.delete(session);
    this.live.delete(k);
    this.outgoing.delete(k);
    this.tell(userId);
  }

  /** The runtime a session speaks for: the one whose secret last came on it; null for a session that never gave one of this user's. A notice, which carries no secret, is taken by this. */
  relayOf(userId: string, session: string): string | null {
    const bound = this.sessions.get(session);
    return bound !== undefined && bound.startsWith(`${userId}${SEP}`) ? bound.slice(userId.length + SEP.length) : null;
  }

  /** The turns a runtime named on its last ping. */
  turnsOf(userId: string, relay: string): readonly string[] {
    return this.live.get(key(userId, relay))?.turns ?? [];
  }

  /** Whether a runtime has a session now: its pushes have somewhere to go. */
  reachable(userId: string, relay: string): boolean {
    return (this.live.get(key(userId, relay))?.session ?? null) !== null;
  }

  /** The runtime as the Runtime page shows it. */
  async view(userId: string, issues: string[]): Promise<RuntimeView> {
    const quietMs = (await this.settings.transport(userId)).link.quietMs;
    const { bun, dir } = this.host.install;
    const script = dir === null ? null : `${dir}/lumiah.js`;
    const relays = Object.values((await this.registry.read(userId)).relays)
      .sort((a, b) => a.registeredAt - b.registeredAt)
      .map((r): RelayView => {
        const live = this.live.get(key(userId, r.id));
        const report = live?.report ?? r.report;
        const link = this.stateOf(live, quietMs);
        if (live !== undefined) live.shown = link;
        const unit = report?.runtime.unit ?? null;
        const updateBun = bun ?? report?.runtime.bun ?? null;
        const loginBun = report?.runtime.bun ?? bun;
        const problem =
          link === "linked"
            ? null
            : link === "refused"
              ? (live?.refused ?? null)
              : link === "quiet"
                ? `LumiAH hasn't heard from this runtime for over ${Math.round(quietMs / 1000)} seconds. Check that it is still running${unit !== null ? ` (systemctl --user status ${unit})` : ""}.`
                : `This runtime isn't connected to Lumiverse now. ${unit !== null ? `Check its service (systemctl --user status ${unit}), or run its update line.` : "Start it with its line."}`;
        return {
          id: r.id,
          name: r.name,
          build: report?.build ?? null,
          host: report?.host ?? null,
          url: report === null ? null : runtimeBase(report.listen, report.port),
          registeredAt: r.registeredAt,
          seenAt: live?.seenAt ?? null,
          link,
          problem,
          update: report !== null && report.build !== this.env.build,
          turns: live?.turns.length ?? 0,
          unit,
          session: { valid: live?.report?.session.valid ?? null, endsAt: live?.report?.session.expiresAt ?? null },
          scheduler: live?.report?.scheduler ?? "unknown",
          lines: {
            // The extension's own copy of the runtime is the build to update to; `up` reads the address from the runtime's config.
            update: updateBun !== null && script !== null ? [updateBun, script, "up", "--name", r.name, ...(unit !== null ? ["--systemd"] : [])].map(shellWord).join(" ") : null,
            login: report !== null && loginBun !== null ? [loginBun, report.runtime.script, "login", "--name", r.name].map(shellWord).join(" ") : null,
          },
        };
      });
    const missing = [...(bun === null ? ["the path of Lumiverse's Bun (use the full path of your own bun)"] : []), ...(script === null ? ["where this extension is installed (the runtime is dist/lumiah.js in LumiAH's extension folder)"] : [])];
    const line = (systemd: boolean): string | null => (bun === null || script === null ? null : `${[bun, script, "up", "--url"].map(shellWord).join(" ")} ${URL_SLOT}${systemd ? " --systemd" : ""}`);
    return { build: this.env.build, link: LINK_VERSION, model: MODEL_ID, relays, start: { service: line(true), foreground: line(false), missing }, issues };
  }
}
