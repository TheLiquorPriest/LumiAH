// What the working store's tests run it on (src/runtime/store): a folder of its own, a made-up mirror
// (the extension's storage as the link reaches it) that can fail, come back or hold a call, a clock
// whose timers run when a test moves it on, and a disk that stops for good part way, as the disk is
// left when the process dies there. A store opened alone (`open`) is given the mirror at once; the
// runtimes of a test about who holds it (`linked`) say hello to the extension's own part that decides
// it (backend/mirror.ts), and their writes to the mirror go through it, as over the link.

import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type BlobInfo, type BlobsPort, isRecord, type JsonValue, type LogLevel, type StorePort } from "../../../src/core/ports";
import { Mirrors } from "../../../src/extension/backend/mirror";
import type { Caller } from "../../../src/extension/backend/relays";
import { LinkRefused } from "../../../src/host/refused";
import type { MirrorWord } from "../../../src/link/contract";
import { mirrorWordOf } from "../../../src/link/frames";
import { type Disk, nodeDisk } from "../../../src/runtime/store/disk";
import { createWorkingStore, type StoragePorts, type WorkingStore, type WorkingStoreDeps } from "../../../src/runtime/store/index";

/** A clock that stands still: its timers run, in order, when a test moves it on. */
export class Clock {
  at = 1_700_000_000_000;
  private timers: { at: number; fn: () => void; n: number }[] = [];
  private made = 0;

  readonly now = (): number => this.at;

  readonly later = (ms: number, fn: () => void): (() => void) => {
    const timer = { at: this.at + ms, fn, n: this.made++ };
    this.timers.push(timer);
    return () => {
      this.timers = this.timers.filter((t) => t !== timer);
    };
  };

  /** Moves time on by `ms`, running each timer that falls due on the way. */
  advance(ms: number): void {
    const end = this.at + ms;
    for (;;) {
      const due = this.timers.filter((t) => t.at <= end).sort((a, b) => a.at - b.at || a.n - b.n)[0];
      if (due === undefined) break;
      this.timers = this.timers.filter((t) => t !== due);
      this.at = Math.max(this.at, due.at);
      due.fn();
    }
    this.at = end;
  }
}

/** What the made-up mirror refuses a call with for good: by a rule of its own, which asking again doesn't change. */
export class Refused extends Error {}

/** The extension's storage, made up: documents kept as JSON text and blobs with the time each was last written, as Spindle's storage keeps them. */
export class Mirror {
  readonly docs = new Map<string, string>();
  readonly stored = new Map<string, { text: string; at: number }>();
  /** Every call asked of it, taken or not, and when (`read <path>`, `write <path>`, `remove <path>`, `list <prefix>`, `put <hash>`, `get <hash>`, `blobs <page>`, `drop <hashes>`). */
  readonly calls: { what: string; at: number }[] = [];
  /** Every change it took, in order: `write <path>`, `remove <path>`, `put <hash>`, `drop <hash>`. */
  readonly took: string[] = [];
  /** The path of each document read from it, in order. */
  readonly reads: string[] = [];
  /** While set, every call fails with these words, as a storage the link can't reach does. */
  down: string | null = null;
  /** While set, every call waits on it first. */
  hold: ((what: string) => Promise<void>) | null = null;
  /** The words it refuses a call with for good (`Refused`), where this gives any. */
  refuses: (what: string) => string | null = () => null;

  constructor(private readonly clock: Clock) {}

  private async enter(what: string): Promise<void> {
    this.calls.push({ what, at: this.clock.now() });
    if (this.down !== null) throw new Error(this.down);
    await this.hold?.(what);
    if (this.down !== null) throw new Error(this.down);
    const rule = this.refuses(what);
    if (rule !== null) throw new Refused(rule);
  }

  /** A document as it holds it, read; null when it holds none. */
  doc(path: string): JsonValue | null {
    const text = this.docs.get(path);
    return text === undefined ? null : (JSON.parse(text) as JsonValue);
  }

  readonly store: Required<StorePort> = {
    read: async (path) => {
      await this.enter(`read ${path}`);
      this.reads.push(path);
      return this.doc(path);
    },
    write: async (path, value) => {
      await this.enter(`write ${path}`);
      this.docs.set(path, JSON.stringify(value));
      this.took.push(`write ${path}`);
    },
    remove: async (path) => {
      await this.enter(`remove ${path}`);
      this.docs.delete(path);
      this.took.push(`remove ${path}`);
    },
    list: async (prefix) => {
      await this.enter(`list ${prefix}`);
      return [...this.docs.keys()].filter((path) => path.startsWith(prefix));
    },
  };

  readonly blobs = {
    put: async (hash: string, text: string): Promise<void> => {
      await this.enter(`put ${hash}`);
      this.stored.set(hash, { text, at: this.clock.now() });
      this.took.push(`put ${hash}`);
    },
    get: async (hash: string): Promise<string | null> => {
      await this.enter(`get ${hash}`);
      return this.stored.get(hash)?.text ?? null;
    },
    /** A page for each pair of a hash's first two characters, as the extension's storage lists them. */
    list: async (cursor?: string): Promise<{ blobs: BlobInfo[]; next: string | null }> => {
      await this.enter(`blobs ${cursor ?? "00"}`);
      const at = cursor === undefined ? 0 : Number.parseInt(cursor, 16);
      const pair = at.toString(16).padStart(2, "0");
      const blobs = [...this.stored].filter(([hash]) => hash.startsWith(pair)).map(([hash, held]) => ({ hash, bytes: Buffer.byteLength(held.text), at: held.at }));
      return { blobs, next: at < 255 ? (at + 1).toString(16).padStart(2, "0") : null };
    },
    remove: async (hashes: readonly string[]): Promise<void> => {
      await this.enter(`drop ${hashes.join(",")}`);
      for (const hash of hashes) {
        this.stored.delete(hash);
        this.took.push(`drop ${hash}`);
      }
    },
  };
}

/** Holds the mirror's calls that `match` until `go()`; `reached` resolves at the first of them. */
export function holding(mirror: Mirror, match: (what: string) => boolean): { reached: Promise<void>; go(): void } {
  const reached = Promise.withResolvers<void>();
  const gate = Promise.withResolvers<void>();
  mirror.hold = async (what) => {
    if (!match(what)) return;
    reached.resolve();
    await gate.promise;
  };
  return { reached: reached.promise, go: () => gate.resolve() };
}

/** Every blob a store lists, page after page, as upkeep reads them. */
export async function listed(blobs: { list(cursor?: string): Promise<{ blobs: BlobInfo[]; next: string | null }> }): Promise<BlobInfo[]> {
  const all: BlobInfo[] = [];
  let cursor: string | undefined;
  for (;;) {
    const page = await blobs.list(cursor);
    all.push(...page.blobs);
    if (page.next === null) return all;
    cursor = page.next;
  }
}

/** The core's rule as these tests give it, read through a store as the core's forgetting reads one: a chat's documents are those under its folder, and its search vectors (a book's stay, whatever its id). */
export async function chatDocuments(store: Pick<StorePort, "list" | "read">, chatId: string): Promise<Set<string>> {
  const found = new Set<string>();
  if (store.list === undefined) return found;
  for (const path of await store.list(`chats/${chatId}/`)) found.add(path);
  for (const path of await store.list("recall/vectors/")) if (path.includes(`/chat/${chatId}/`)) found.add(path);
  return found;
}

/** Where a test's stores live: a folder of the system's temp folder, the mirror they share, the clock, and what they logged. */
export interface Bench {
  dir: string;
  clock: Clock;
  mirror: Mirror;
  logs: { level: LogLevel; message: string }[];
  /** Ids given so far: each id is new, as a random one is. */
  ids: number;
  /** The extension's part that decides who holds the mirror, for the runtimes `linked` to it. */
  arbiter: Arbiter;
}

export async function bench(): Promise<Bench> {
  const clock = new Clock();
  return { dir: await mkdtemp(join(tmpdir(), "lumiah-store-")), clock, mirror: new Mirror(clock), logs: [], ids: 0, arbiter: new Arbiter(clock) };
}

export async function cleanUp(b: Bench): Promise<void> {
  await rm(b.dir, { recursive: true, force: true });
}

export const IDENTITY = { lumiverse: "http://127.0.0.1:7860", user: "reader", extension: "lumiah" };

/** The word that gives a store the mirror. */
export const GIVEN: MirrorWord = { held: true, holder: null, gen: 0 };

/** The count of changes the mirror's mark says it took; null when it has no mark that says one. */
export function markCount(b: Bench): number | null {
  const mark = b.mirror.doc("mirror.json");
  return isRecord(mark) && typeof mark.count === "number" ? mark.count : null;
}

/** The registration the arbiter keeps as the mirror's holder; null when none holds it. */
export function holderRelay(b: Bench): string | null {
  const kept: unknown = JSON.parse(b.arbiter.files.get(`${IDENTITY.user}/mirror-holder.json`) ?? "null");
  return isRecord(kept) && isRecord(kept.holder) && typeof kept.holder.relay === "string" ? kept.holder.relay : null;
}

/** A working store on the bench: its mirror, its clock, its folder; `over` changes any of it. Given the mirror at once (`word`: another word, or none: it waits for one). */
export function open(b: Bench, over: Partial<WorkingStoreDeps> & { word?: MirrorWord | null | "none" } = {}): WorkingStore {
  const { word = GIVEN, ...deps } = over;
  const ports = { store: b.mirror.store, blobs: b.mirror.blobs };
  const s = createWorkingStore({
    dir: b.dir,
    identity: IDENTITY,
    remote: ports,
    direct: ports,
    holding: (b.ids++).toString(16).padStart(32, "0"),
    owner: "runtime one",
    now: b.clock.now,
    later: b.clock.later,
    id: () => (b.ids++).toString(16).padStart(32, "0"),
    log: (level, message) => void b.logs.push({ level, message }),
    chatDocuments,
    ...deps,
  });
  if (word !== "none") s.heard(word);
  return s;
}

/** A refusal as the extension's link sends it, as the runtime's link hands it on: the cause carries the code. */
function refusedOverLink(error: unknown): unknown {
  return error instanceof LinkRefused ? new Error(error.message, { cause: error }) : error;
}

/** Whether the extension refused a working copy's write because its runtime doesn't hold the mirror (host.ts `withdrawn`, over the bench's link). */
export function withdrawnHere(error: unknown): boolean {
  const cause: unknown = error instanceof Error ? error.cause : undefined;
  return cause instanceof LinkRefused && cause.code === "conflict";
}

/** Whether the extension refused a change for good, as host.ts `refusedForGood` reads it over the bench's link: another runtime's later write of the document stands (`superseded`), or a rule of its own. */
export function refusedHere(error: unknown): boolean {
  const cause: unknown = error instanceof Error ? error.cause : undefined;
  return cause instanceof LinkRefused && (cause.code === "superseded" || cause.code === "bad_request" || cause.code === "too_large");
}

/**
 * The extension's part that decides who holds each user's mirror (backend/mirror.ts, the real one),
 * over the bench's clock, its own files kept in memory as the user's storage keeps the backend's. A
 * runtime's hello goes to it, and its words and pushes to the runtime's store; while a session is
 * down nothing reaches it. `restart` starts it anew, as Lumiverse starts the extension's worker again:
 * its files stay, what it held in memory goes.
 */
export class Arbiter {
  readonly files = new Map<string, string>();
  quietMs = 120_000;
  mirrors: Mirrors;
  /** Each linked runtime's store, by the session it speaks on now. */
  readonly sessions = new Map<string, WorkingStore>();

  constructor(private readonly clock: Clock) {
    this.mirrors = this.made();
  }

  restart(): void {
    this.mirrors = this.made();
  }

  private made(): Mirrors {
    const { files, clock } = this;
    const storage = {
      read: async (path: string, userId: string) => files.get(`${userId}/${path}`) ?? null,
      write: async (path: string, text: string, userId: string) => void files.set(`${userId}/${path}`, text),
      remove: async (path: string, userId: string) => void files.delete(`${userId}/${path}`),
      stat: async (path: string, userId: string) => (files.has(`${userId}/${path}`) ? { bytes: files.get(`${userId}/${path}`)?.length ?? 0, writtenAt: clock.now() } : null),
      list: async (dir: string, userId: string) => [...files.keys()].filter((key) => key.startsWith(`${userId}/${dir}/`)).map((key) => key.slice(`${userId}/${dir}/`.length)),
    };
    return new Mirrors(
      { storage, log: () => undefined },
      {
        now: clock.now,
        quietMs: async () => this.quietMs,
        send: (push, _userId, session) => {
          if (push.type === "mirror") this.sessions.get(session)?.heard(mirrorWordOf(push));
        },
        name: "LumiAH",
      },
    );
  }
}

/** A runtime of the bench's user, linked: its store, its registration, the session it speaks on now; it says hello again on a new session (`hello`), and its link can go down (`drop`). */
export interface Linked {
  store: WorkingStore;
  relay: string;
  session: string;
  hello(): Promise<MirrorWord>;
  /** Its link goes down: the extension hears its session close, nothing reaches it, and what it sends fails, until its next hello. */
  drop(): void;
}

/**
 * A runtime started on the bench, linked to the arbiter as the real link links one: its store's
 * writes to the mirror go through the arbiter (those of its copy named by its holding), and it says
 * hello once its store can say what its copy is. `relay`: its registration (another runtime of the
 * user's has its own; the same one started again, on its folder or another, has the same).
 */
export async function linked(b: Bench, relay: string, over: Partial<WorkingStoreDeps> = {}): Promise<Linked> {
  const { arbiter } = b;
  const holding = (b.ids++).toString(16).padStart(32, "0");
  let session = `session-${b.ids++}`;
  let down = false;
  const caller = (): Caller => ({ userId: IDENTITY.user, relay: { id: relay, name: relay, secret: "", build: "", host: "", listen: "127.0.0.1", port: 1, registeredAt: 0, report: null }, session });
  const through = (mark: string | undefined): StoragePorts => {
    const write = <T>(changed: { docs: string[]; blobs: string[] }, apply: () => Promise<T>, ago?: number): Promise<T> => {
      if (down) return Promise.reject(new Error("the extension isn't linked"));
      let out: T | undefined;
      return arbiter.mirrors
        .write(
          caller(),
          mark,
          changed,
          async () => {
            out = await apply();
          },
          ago,
        )
        .then(
          () => out as T,
          (error: unknown) => Promise.reject(refusedOverLink(error)),
        );
    };
    return {
      store: { ...b.mirror.store, read: (path) => (down ? Promise.reject(new Error("the extension isn't linked")) : b.mirror.store.read(path)), list: (prefix) => (down ? Promise.reject(new Error("the extension isn't linked")) : b.mirror.store.list(prefix)), write: (path, value, ago) => write({ docs: [path], blobs: [] }, () => b.mirror.store.write(path, value), ago), remove: (path, ago) => write({ docs: [path], blobs: [] }, () => b.mirror.store.remove(path), ago) },
      blobs: { ...b.mirror.blobs, get: (hash) => (down ? Promise.reject(new Error("the extension isn't linked")) : b.mirror.blobs.get(hash)), put: (hash, text) => write({ docs: [], blobs: [] }, () => b.mirror.blobs.put(hash, text)), remove: (hashes) => write({ docs: [], blobs: [...hashes] }, () => b.mirror.blobs.remove(hashes)) },
    };
  };
  const store = open(b, { word: "none", holding, remote: through(holding), direct: through(undefined), withdrawn: withdrawnHere, refusedForGood: refusedHere, release: async () => void (await arbiter.mirrors.release(caller(), holding)), ...over });
  const runtime: Linked = {
    store,
    relay,
    get session() {
      return session;
    },
    async hello() {
      down = false;
      arbiter.sessions.set(session, store);
      const word = await arbiter.mirrors.hello(caller(), await store.ask(), null);
      store.heard(word);
      return word;
    },
    drop() {
      down = true;
      arbiter.sessions.delete(session);
      arbiter.mirrors.sessionClosed(session);
      session = `session-${b.ids++}`;
    },
  };
  await runtime.hello();
  return runtime;
}

/** How a call ended, as it ends: "done", or its error's words. */
export function outcome(work: Promise<unknown>): Promise<string> {
  return work.then(
    () => "done",
    (error: unknown) => (error instanceof Error ? error.message : String(error)),
  );
}

/** Waits until `done()` holds, in real time: the disk works at its own pace. */
export async function until(done: () => boolean, what: string): Promise<void> {
  const end = Date.now() + 5_000;
  while (!done()) {
    if (Date.now() > end) throw new Error(`waited 5 s for ${what}`);
    // The store's work runs on the real disk, at the disk's pace: what is awaited here is that work, which no promise of the store's hands back.
    await Bun.sleep(2);
  }
}

/** Every file under a folder, by its path below it. */
export async function files(dir: string): Promise<string[]> {
  const disk = nodeDisk();
  const out: string[] = [];
  const walk = async (rel: string): Promise<void> => {
    for (const entry of await disk.entries(rel === "" ? dir : `${dir}/${rel}`)) {
      const path = rel === "" ? entry.name : `${rel}/${entry.name}`;
      if (entry.folder) await walk(path);
      else out.push(path);
    }
  };
  await walk("");
  return out.sort();
}

/** A disk that, once armed, stops before a call of `method` on a path ending in `suffix`, until `go()`. */
export function stopping(): { disk: Disk; arm(method: "rename" | "remove", suffix: string): void; reached: Promise<void>; go(): void } {
  const base = nodeDisk();
  const reached = Promise.withResolvers<void>();
  const gate = Promise.withResolvers<void>();
  let armed: { method: string; suffix: string } | null = null;
  const stop = async (method: string, path: string): Promise<void> => {
    if (armed === null || armed.method !== method || !path.endsWith(armed.suffix)) return;
    armed = null;
    reached.resolve();
    await gate.promise;
  };
  const disk: Disk = {
    ...base,
    rename: async (from, to) => {
      await stop("rename", to);
      await base.rename(from, to);
    },
    remove: async (path) => {
      await stop("remove", path);
      await base.remove(path);
    },
  };
  return {
    disk,
    arm: (method, suffix) => {
      armed = { method, suffix };
    },
    reached: reached.promise,
    go: () => gate.resolve(),
  };
}

/**
 * Where a process dies: the disk's and the mirror's changes are counted as they are made, and the
 * `at`th (from 0) never happens, nor anything after it: every call from then on waits for good.
 */
export class Cut {
  private made = 0;
  private readonly death = Promise.withResolvers<void>();
  /** Resolves when the process dies. */
  readonly died = this.death.promise;
  dead = false;
  /** While false, changes are made and not counted: a run sets itself up first, and the steps it is cut in count from there. */
  armed = true;

  constructor(private readonly at: number) {}

  /** How many changes were made. */
  get changes(): number {
    return this.made;
  }

  /** A change about to be made: the one the process dies at waits for good, as does every call after. */
  async change(): Promise<void> {
    if (!this.armed) return;
    if (!this.dead && this.made >= this.at) {
      this.dead = true;
      this.death.resolve();
    }
    if (this.dead) await new Promise<never>(() => undefined);
    this.made += 1;
  }

  /** A look that changes nothing: it waits for good once the process is dead. */
  async look(): Promise<void> {
    if (this.dead) await new Promise<never>(() => undefined);
  }
}

/** A disk whose changes stop at the cut. */
export function cutDisk(cut: Cut): Disk {
  const disk = nodeDisk();
  return {
    async read(path) {
      await cut.look();
      return disk.read(path);
    },
    async write(path, text) {
      await cut.change();
      await disk.write(path, text);
    },
    async rename(from, to) {
      await cut.change();
      await disk.rename(from, to);
    },
    async remove(path) {
      await cut.change();
      await disk.remove(path);
    },
    async removeAll(path) {
      await cut.change();
      await disk.removeAll(path);
    },
    async entries(path) {
      await cut.look();
      return disk.entries(path);
    },
    async stat(path) {
      await cut.look();
      return disk.stat(path);
    },
    async touch(path, at) {
      await cut.change();
      await disk.touch(path, at);
    },
    async mkdir(path) {
      await cut.change();
      await disk.mkdir(path);
    },
    async removeEmpty(path) {
      await cut.change();
      return disk.removeEmpty(path);
    },
  };
}
