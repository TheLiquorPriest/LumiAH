// Which runtime holds each user's mirror (PI-BUILD-PLAN §4.4, and the decision of 12 Nov 17:52Z). One
// runtime at a time keeps a working copy of the core's documents and blobs on its own disk, with this
// extension's storage as the copy's mirror; any other runtime of the same user reads and writes the
// storage directly, as every runtime did before working copies. This backend decides, at each hello:
// the mirror goes to the first runtime that asks for it, back to the same working copy whenever that
// one says hello again (a new socket, a restart), and to another runtime only once the one that holds
// it has been silent past the link's allowance ("Quiet after"). It moves at no other time, and no
// runtime takes it by itself.
//
// A write to the storage from the holder's working copy names the process that holds it (`mirror`);
// one that names another process, or comes while no runtime holds the mirror, is refused for good
// (`conflict`): the runtime that sent it has lost the mirror, and stops using its copy. A runtime's
// own write (no `mirror`) is taken from any runtime of the user's, and the holder is told of each path
// at once (a `mirror` push) so that its copy drops it. When the holder can't be told (its link is
// down, no runtime holds the mirror, or a push to it may not have arrived before its link went), the
// user's count `gen` goes up; a holder whose copy took fewer drops, at its next hello, everything the
// storage holds of it.
//
// Of two runtimes' writes of one document, the later stands. A working copy's write says how long ago
// its change was made (`ago`): the change may be older than another runtime's write the storage took
// meanwhile (its link was down; or it lost the mirror with changes unsent, which it then writes as
// its own). Such a write is refused (`superseded`): the copy gives way. What decides is the last
// write of each path as this worker saw it, which it forgets when it starts again: a write it knows
// nothing against is taken, as every write was before.
//
// Who holds the mirror is kept in the user's storage (`mirror-holder.json`, beside the registry),
// written before a grant is answered: after this worker starts again, the runtime that held it gets it
// back at its hello, and another one only once the holder has been silent past the allowance, counted
// from the start (every runtime linked is asked to say hello at the start).
//
// Per user, and per extension as this backend sees them: an extension that builds LumiAH in keeps its
// own storage, under its own folder, and so its own holder. The runtime needs to know nothing of that.

import type { LinkPush, MirrorAsk, MirrorWord } from "../../link/contract";
import { LINK, MARK_PATH, MIRROR_ID } from "../../link/contract";
import { runtimeReportOf } from "../../link/frames";
import { isRecord } from "../../link/json";
import { UserDocs } from "./docs";
import { LinkRefused, wordsOf } from "./errors";
import type { Caller } from "./relays";
import type { BackendHost } from "./spindle";

/** The runtime that holds a user's mirror, as kept: its registration, its working copy, the process that holds it, and who it is in words. */
interface Holder {
  relay: string;
  copy: string;
  process: string;
  owner: string;
}

interface HolderDoc {
  v: 1;
  holder: Holder | null;
  /** How many times the holder may have missed being told of another runtime's change (`MirrorWord.gen`). */
  gen: number;
}

const FILE = "mirror-holder.json";

/** How many documents' last writes are kept for each user: past it the one written longest ago is forgotten, and a write of it is taken as one nothing is known against. */
const STAMPS_KEPT = 10_000;

const id = (v: unknown): v is string => typeof v === "string" && MIRROR_ID.test(v);

function holderDocOf(raw: unknown): HolderDoc | null {
  if (!isRecord(raw) || raw.v !== 1 || typeof raw.gen !== "number" || !Number.isSafeInteger(raw.gen) || raw.gen < 0) return null;
  const h = raw.holder;
  if (h === null) return { v: 1, holder: null, gen: raw.gen };
  if (!isRecord(h) || typeof h.relay !== "string" || !id(h.copy) || !id(h.process) || typeof h.owner !== "string") return null;
  return { v: 1, holder: { relay: h.relay, copy: h.copy, process: h.process, owner: h.owner }, gen: raw.gen };
}

/** What a hello says of the runtime's working copy, checked; null for one that says none (it keeps no copy). */
function askOf(raw: unknown): MirrorAsk | null {
  if (!isRecord(raw) || !id(raw.copy) || !id(raw.process) || typeof raw.asks !== "boolean" || typeof raw.seen !== "number" || !Number.isSafeInteger(raw.seen) || raw.seen < 0) return null;
  return { copy: raw.copy, process: raw.process, asks: raw.asks, seen: raw.seen };
}

/** What is known in this worker's life of a user's holder: where its pushes go, when it was last heard, and whether it may have missed being told of a change. */
interface Live {
  session: string | null;
  /** The last hello, ping or write from it; this worker's start until it is heard. */
  heardAt: number;
  /** A drop was pushed on its session since its last hello: one may not have arrived if that session goes. */
  pushed: boolean;
  /** `gen` went up since it was last granted: once is enough until then. */
  missed: boolean;
}

export interface MirrorsEnv {
  now(): number;
  /** How long a runtime may be silent before another may take the mirror from it: the link's "Quiet after". */
  quietMs(userId: string): Promise<number>;
  /** Sends a push to a session. */
  send(push: LinkPush, userId: string, session: string): void;
  /** The extension as its words name it. */
  name: string;
}

export class Mirrors {
  private readonly docs: UserDocs<HolderDoc>;
  private readonly live = new Map<string, Live>();
  /** Each user's runtimes that said hello in this worker's life, by session, to the relay they spoke for: each is told when the holder changes. */
  private readonly sessions = new Map<string, Map<string, string>>();
  private readonly started: number;
  /** Raises of `gen` under way, which `settle` waits for. */
  private readonly raising = new Set<Promise<void>>();
  /** Each user's documents written in this worker's life, by path: the runtime (its registration) whose write stands, and when its change was made, by this worker's clock. */
  private readonly stamps = new Map<string, Map<string, { relay: string; at: number }>>();
  /** The write of each user's document under way, chained: the check and the write it lets through are one step. */
  private readonly writing = new Map<string, Promise<void>>();

  constructor(
    private readonly host: Pick<BackendHost, "storage" | "log">,
    private readonly env: MirrorsEnv,
  ) {
    this.docs = new UserDocs<HolderDoc>(host, FILE, holderDocOf, () => ({ v: 1, holder: null, gen: 0 }));
    this.started = env.now();
  }

  private liveOf(userId: string): Live {
    let live = this.live.get(userId);
    if (live === undefined) {
      live = { session: null, heardAt: this.started, pushed: false, missed: false };
      this.live.set(userId, live);
    }
    return live;
  }

  private sessionsOf(userId: string): Map<string, string> {
    let sessions = this.sessions.get(userId);
    if (sessions === undefined) {
      sessions = new Map();
      this.sessions.set(userId, sessions);
    }
    return sessions;
  }

  /**
   * A runtime said hello (its version checked): the mirror is its when it asks and none holds it, or
   * the same working copy does (the holder on a new socket, or started again), or the holder has been
   * silent past the allowance. Kept before it is answered; every other runtime of the user's that said
   * hello is told who holds it now, the one that held it among them. The answer is this runtime's word.
   */
  async hello(caller: Caller, raw: unknown, report: unknown): Promise<MirrorWord> {
    const { userId, session } = caller;
    const relay = caller.relay.id;
    this.sessionsOf(userId).set(session, relay);
    const ask = askOf(raw);
    const doc = await this.docs.get(userId);
    const held = doc.holder;
    if (ask === null || !ask.asks) return { held: false, holder: held?.owner ?? null, gen: doc.gen };
    const live = this.liveOf(userId);
    const same = held !== null && held.relay === relay && held.copy === ask.copy;
    if (held !== null && !same && this.env.now() - live.heardAt <= (await this.env.quietMs(userId))) return { held: false, holder: held.owner, gen: doc.gen };
    const said = runtimeReportOf(report);
    const owner = said === null ? caller.relay.name : `${said.name} (${said.host})`;
    const moved = held === null || held.process !== ask.process || !same;
    if (moved || held.owner !== owner) {
      await this.docs.change(userId, (d) => {
        d.holder = { relay, copy: ask.copy, process: ask.process, owner };
      });
    }
    live.session = session;
    live.heardAt = this.env.now();
    live.pushed = false;
    live.missed = false;
    if (moved) {
      const told: LinkPush = { link: LINK, type: "mirror", held: false, holder: owner, gen: doc.gen };
      for (const other of this.sessionsOf(userId).keys()) if (other !== session) this.env.send(told, userId, other);
    }
    return { held: true, holder: null, gen: doc.gen, ...(ask.seen < doc.gen ? { dropped: { docs: [], blobs: [], all: true } } : {}) };
  }

  /**
   * A write to the storage (`doc.put|remove`, `blob.put|remove`), done by `apply` once it may be. One
   * that names a process (`mirror`) is the working copy's: done only for the process that holds the
   * mirror, else refused for good. One that names none is the runtime's own: done, and the holder told
   * of what it changed (or, where it can't be told now, made to drop everything at its next hello).
   * A document's write that says how long ago its change was made (`ago`) is refused (`superseded`)
   * when another runtime's later write of the path stands.
   */
  async write(caller: Caller, mark: unknown, changed: { docs: string[]; blobs: string[] }, apply: () => Promise<void>, ago?: unknown): Promise<void> {
    const { userId } = caller;
    const doc = await this.docs.get(userId);
    const held = doc.holder;
    const { name } = this.env;
    const made = typeof ago === "number" && Number.isFinite(ago) && ago > 0 ? this.env.now() - ago : null;
    const path = changed.docs.length === 1 && changed.blobs.length === 0 ? changed.docs[0] : undefined;
    if (mark !== undefined) {
      if (held === null || held.relay !== caller.relay.id || held.process !== mark) {
        throw new LinkRefused("conflict", `${held === null ? "No runtime keeps" : `Another runtime (${held.owner}) keeps`} ${name}'s storage now, so ${name} takes nothing from this runtime's own copy of it: this runtime reads and writes the storage directly from now on.`);
      }
      const live = this.liveOf(userId);
      live.heardAt = this.env.now();
      // Started again, this worker learns where the holder's pushes go from its first word.
      live.session ??= caller.session;
      await this.ordered(userId, caller.relay.id, path, made, apply);
      return;
    }
    if (changed.docs.includes(MARK_PATH)) throw new LinkRefused("bad_request", `${MARK_PATH} is where the runtime that keeps ${name}'s storage notes its copy: no other runtime writes it.`);
    await this.ordered(userId, caller.relay.id, path, made, apply);
    // A blob stored again is the same text under the same hash: no copy of it can be out of date.
    if (changed.docs.length > 0 || changed.blobs.length > 0) await this.tell(userId, changed);
  }

  /**
   * A document's write, after any other of the same path under way: refused when its change was made
   * (`made`) before the write that stands there, by another runtime; else done, and noted as the one
   * that stands (made now, where it doesn't say). Anything else is done as it comes.
   */
  private ordered(userId: string, relay: string, path: string | undefined, made: number | null, apply: () => Promise<void>): Promise<void> {
    if (path === undefined) return apply();
    const key = `${userId}\n${path}`;
    const step = (this.writing.get(key) ?? Promise.resolve()).then(async () => {
      const stood = this.stamps.get(userId)?.get(path);
      if (made !== null && stood !== undefined && stood.relay !== relay && stood.at > made) {
        throw new LinkRefused("superseded", `Another runtime saved ${path} in ${this.env.name}'s storage after this change was made, so the storage keeps that save.`);
      }
      const at = made ?? this.env.now();
      await apply();
      const stamps = this.stamps.get(userId) ?? new Map<string, { relay: string; at: number }>();
      this.stamps.set(userId, stamps);
      stamps.delete(path);
      stamps.set(path, { relay, at });
      for (const oldest of stamps.keys()) {
        if (stamps.size <= STAMPS_KEPT) break;
        stamps.delete(oldest);
      }
    });
    const done = step.then(
      () => undefined,
      () => undefined,
    );
    this.writing.set(key, done);
    void done.then(() => {
      if (this.writing.get(key) === done) this.writing.delete(key);
    });
    return step;
  }

  /** Another runtime changed the storage: the holder's copy drops what it holds of the paths, told at once where it can be; else `gen` goes up, once until the mirror is granted again, so its next hello drops everything. */
  private async tell(userId: string, changed: { docs: string[]; blobs: string[] }): Promise<void> {
    const doc = await this.docs.get(userId);
    const live = this.liveOf(userId);
    if (doc.holder !== null && live.session !== null) {
      this.env.send({ link: LINK, type: "mirror", held: true, holder: null, gen: doc.gen, dropped: { ...changed, all: false } }, userId, live.session);
      live.pushed = true;
      return;
    }
    await this.raise(userId);
  }

  private async raise(userId: string): Promise<void> {
    const live = this.liveOf(userId);
    if (live.missed) return;
    live.missed = true;
    const raised = this.docs
      .change(userId, (d) => {
        d.gen += 1;
      })
      .catch((error: unknown) => {
        live.missed = false;
        throw error;
      });
    const held = raised.then(
      () => undefined,
      () => undefined,
    );
    this.raising.add(held);
    void held.then(() => this.raising.delete(held));
    await raised;
  }

  /** The process that holds the mirror lets it go: none holds it until the next runtime asks. False when that process doesn't hold it. */
  async release(caller: Caller, mark: unknown): Promise<boolean> {
    const { userId, session } = caller;
    const held = (await this.docs.get(userId)).holder;
    if (held === null || held.relay !== caller.relay.id || held.process !== mark) return false;
    const gen = await this.docs.change(userId, (d) => {
      d.holder = null;
      return d.gen;
    });
    const live = this.liveOf(userId);
    live.session = null;
    live.pushed = false;
    live.missed = false;
    const told: LinkPush = { link: LINK, type: "mirror", held: false, holder: null, gen };
    for (const other of this.sessionsOf(userId).keys()) if (other !== session) this.env.send(told, userId, other);
    return true;
  }

  /** A runtime pinged: the holder heard from is not silent. */
  async pinged(userId: string, relay: string): Promise<void> {
    if ((await this.docs.get(userId)).holder?.relay === relay) this.liveOf(userId).heardAt = this.env.now();
  }

  /** A session went away. The holder's pushes have nowhere to go until it says hello again; a drop pushed on that session may not have reached it, so its next hello drops everything. */
  sessionClosed(session: string): void {
    for (const [userId, sessions] of this.sessions) {
      if (!sessions.delete(session)) continue;
      const live = this.live.get(userId);
      if (live === undefined || live.session !== session) continue;
      live.session = null;
      if (live.pushed) void this.raise(userId).catch((error: unknown) => this.host.log("warn", `[LumiAH] the runtime that keeps the storage may keep a change another runtime made, as that couldn't be noted: ${wordsOf(error)}`));
    }
  }

  /** Resolves once every write is done (tests). */
  async settle(): Promise<void> {
    await Promise.all(this.raising);
    await this.docs.settle();
  }
}
