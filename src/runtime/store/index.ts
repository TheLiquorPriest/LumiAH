// The runtime's working store (PI-BUILD-PLAN §4.4): the core's documents and blobs (`StorePort`,
// `BlobsPort`) kept on the runtime's own disk, the working copy, with the extension's storage,
// reached over the link through the ports it is handed, as the durable mirror.
//
// A read is answered from the working copy, else from the mirror, whose answer is kept from then on.
// A write lands on the disk first and is acknowledged once it is there and its path is in the journal
// of paths the mirror doesn't hold as they stand here; a sender brings the mirror up to date behind
// it, one path at a time in the order they were last written, the last write of a path winning, and
// waits longer and longer between tries while the mirror can't be reached. A restart sends what the
// journal still names. `settle()` waits until the mirror holds everything written before it: the
// barrier for whoever reads the mirror itself.
//
// One runtime at a time keeps a working copy for a user and an extension: the extension says which
// (its word comes on each hello's answer, and as a push when it changes: `heard`). Until it has said,
// operations wait. A runtime that doesn't hold the mirror keeps no copy: every read and write goes
// straight to the mirror, as before working copies. One that loses it stops using its copy at once,
// drops what it hadn't sent (each path in the log; a `settle()` that covers any of it is told), and
// never asks for the mirror again in the same process. The holder is told of each path another
// runtime changed, and drops what its copy holds of it: its next read is the mirror's.
//
// The mirror carries a mark: the working copy it mirrors, and how many changes it took from it. A
// copy is used, when its runtime is given the mirror, only when it is the mark's and not behind the
// mark's count: one copied to another machine or restored from a backup has taken fewer, and is
// thrown away for the mirror's, as is any other's. A copy thrown away starts again under a new id.
//
// On the disk, under `dir`, a folder for each identity (one user's data of one extension on one
// Lumiverse), named by a hash of it:
//   identity.json        whose data it is, in plain words, the copy's own id (which the mark names),
//                        how many of its changes the mirror took, and the extension's count of what
//                        a holder may have missed that the copy last took (`MirrorWord.gen`)
//   docs/<path>          each document's JSON text, as the mirror keeps it; an empty file is a removal
//                        the mirror hasn't had yet
//   blobs/<xx>/<hash>    each blob's text, as the mirror keeps it
//   journal/             a file for each path the mirror doesn't hold as it stands here: `b.<hash>`,
//                        or `d.<sha256 of the path>` holding the path
//   tmp/                 files being written, renamed into place once whole; emptied at each start
//
// Every change is steps a restart can finish: the journal's file is in place before the change, and
// the change itself is one rename. So a journal file whose path has nothing on the disk names a write
// cut off before it happened (it goes), and every other path is sent as the disk holds it.

import { createHash } from "node:crypto";
import { textHash } from "../../core/hash";
import { type BlobInfo, type BlobsPort, isRecord, type JsonValue, type LogLevel, type StorePort } from "../../core/ports";
import { errorText, parseJson } from "../../core/util";
import { BLOB_HASH, DOC_PATH, DOC_PREFIX, MARK_PATH, type MirrorAsk, type MirrorWord } from "../../link/contract";
import { transportWait } from "../../link/waits";
import type { SettingsOwner } from "../../shared/timeouts";
import { type Disk, nodeDisk } from "./disk";

const WORDS = {
  path: "A document's path is names of letters, digits, '.', '_' and '-' joined by '/'.",
  prefix: "A documents' prefix is names of letters, digits, '.', '_' and '-' joined by '/'.",
  mark: `${MARK_PATH} is where the runtime notes which runtime keeps the extension's storage: no document can be kept under that name.`,
  hash: "A blob is named by its SHA-256 hash, in lower-case hex.",
  text: "A blob is text.",
  value: "A document needs a value.",
  closed: "The runtime's store is closed: the runtime is stopping.",
  closedBehind: "The runtime's store closed before the extension's storage had everything: what it hadn't sent waits on the runtime's disk and goes there when the runtime starts again.",
  ended: "The runtime stopped using its own copy of the extension's storage while this was being done.",
};

/** What waits on the mirror is told once the extension refused the runtime itself (`WorkingStoreDeps.disowned`): its words, and that nothing is lost. */
function shutOutWords(why: string): string {
  return `The extension's storage takes nothing more from this runtime: ${why} Nothing is lost: what the runtime saved and the storage hasn't taken waits on its disk, and goes to the storage from the next runtime started on this folder that the extension knows.`;
}

/** Whose data a working copy holds: one user's, of one extension, on one Lumiverse. Copies of different identities are kept apart. */
export interface StoreIdentity {
  /** Lumiverse's address, as the runtime reaches it. */
  lumiverse: string;
  /** The user the runtime signed in as. */
  user: string;
  /** The identifier of the extension whose storage is the mirror. */
  extension: string;
}

export interface StoreLimits {
  /** How long `settle()` waits for the mirror, and an operation for the store to open (until the extension has said whether this runtime keeps the copy, and the copy has been checked against the mirror's mark). */
  waitMs: number;
  /** The most bytes of blobs kept on the disk: past it, those the mirror holds go, the one read longest ago first. One the mirror doesn't hold yet is never dropped. */
  blobBytes: number;
  /** The wait after the mirror first fails, doubled at each failure since, up to `retryMostMs`. */
  retryFirstMs: number;
  retryMostMs: number;
  /** The least time between two writes of the mirror's mark while the mirror takes changes: a copy restored from a backup made less than this before the runtime's last change, the runtime then stopping with no chance to write the mark, isn't caught by its count. */
  markMs: number;
  /** How many documents the mirror doesn't have are remembered as absent, the one asked about longest ago forgotten first. */
  absent: number;
}

export const STORE_DEFAULTS: StoreLimits = {
  waitMs: 60_000,
  blobBytes: 2 * 1024 ** 3,
  retryFirstMs: 1_000,
  retryMostMs: 60_000,
  markMs: 10_000,
  absent: 10_000,
};

export interface WorkingStoreDeps {
  /** The folder the runtime keeps its working copies in (`<runtimeDir>/store`). */
  dir: string;
  identity: StoreIdentity;
  /** The extension's storage, over the link: the mirror, its writes those of this runtime's working copy, made as the process that holds the mirror (`holding`). The extension takes them from that process only. */
  remote: { store: Required<StorePort>; blobs: Required<BlobsPort> };
  /** The same storage, written as a runtime that keeps no copy writes it: what this store does while the runtime doesn't hold the mirror. */
  direct: { store: Required<StorePort>; blobs: Required<BlobsPort> };
  /** This process's own id as it holds the mirror, which its writes to the mirror carry. */
  holding: string;
  /** This runtime as a person knows it (its name, and the machine it runs on): what the mark says to another runtime that finds it. */
  owner: string;
  now(): number;
  /** Runs `fn` once `ms` have gone by; gives what cancels it. */
  later(ms: number, fn: () => void): () => void;
  /** A random id, as hex: a working copy's own, and a file's being written. */
  id(): string;
  log(level: LogLevel, message: string): void;
  /**
   * The core's rule for which documents are a chat's (the one its forgetting uses), read through a
   * store: `forget` reads it once over the store and once over the working copy alone.
   */
  chatDocuments(store: Pick<StorePort, "list" | "read">, chatId: string): Promise<Iterable<string>>;
  /** The limits as Settings hold them now, read each time so a change takes effect; what is absent is the default (`STORE_DEFAULTS`). */
  limits?(): Partial<StoreLimits>;
  /** Whose Settings show the runtime's waits (the extension it is linked to, as it last said): a wait that runs out names its setting (`runtime.storeWaitMs`, which holds `waitMs`) and where it is changed there. Absent: the words name no setting. */
  waitsOwner?(): SettingsOwner;
  /**
   * Whether the mirror refused a change for good: by a rule it holds to (a path it doesn't take, a
   * frame larger than it puts together), not a failure that passes. Such a change leaves the journal
   * at once and the working copy with it, so the two agree again; the log and `state().refused` say
   * so, a `settle()` that waited for it is told in the mirror's words, and nothing else waits on it.
   * Absent: every failure is taken as one that passes, and tried again.
   */
  refusedForGood?(error: unknown): boolean;
  /** Whether the mirror refused a write of the working copy's because this runtime doesn't hold the mirror (another does now): the copy ends, as when the extension says so. Neither a failure that passes nor a refusal of the change itself. */
  withdrawn?(error: unknown): boolean;
  /**
   * Whether the extension refused the runtime itself, which no wait mends while this process runs: it
   * doesn't know the runtime any more (forgotten on the Runtime page, or registered anew by `lumiah
   * up`), or the runtime's link is refused. From then on nothing is sent: what waits on the mirror (the
   * copy's opening, each `settle()`) is told at once rather than at the end of its wait, and what
   * wasn't sent stays in the journal for the next runtime started on this folder. Absent: such a
   * refusal is taken as a failure that passes, and tried again.
   */
  disowned?(error: unknown): boolean;
  /** Tells the extension that this process lets the mirror go: its runtime is stopping, and the mirror holds everything. */
  release?(): Promise<void>;
  /** The disk (the runtime's own, unless a test hands one that stops part way). */
  disk?: Disk;
}

/** Whether the store keeps a working copy: `waiting` for the extension's word, `opening` (the copy checked against the mirror's mark, or a holder's copy dropping what another runtime changed), `held` (it keeps the copy), `direct` (it keeps none: every read and write is the mirror's). */
export type StoreMode = "waiting" | "opening" | "held" | "direct";

export interface WorkingStoreState {
  /** Whether operations run now: on the working copy, or straight on the mirror. */
  open: boolean;
  mode: StoreMode;
  /** The runtime that holds the mirror, as the extension said, when this one doesn't; null when none does, or it isn't known. */
  holder: string | null;
  /** When this runtime lost the mirror to another (null: it hasn't, in this process), to whom (null: the extension didn't say), and how many changes the mirror never had went with its copy. */
  lost: { at: number; to: string | null; dropped: number } | null;
  /** How many paths (documents and blobs) the mirror doesn't hold as they stand here. */
  waiting: number;
  /** When the oldest of those changes was made; null when the mirror holds everything. */
  behindSince: number | null;
  /** The last time the mirror couldn't be reached or refused, and its words; null when it never has since the store started. */
  lastError: { words: string; at: number } | null;
  /** When the mirror last took a change; null when it hasn't since the store started. */
  lastSent: number | null;
  /** Bytes the working copy's documents and blobs take on the disk. */
  bytes: number;
  /** True while the store is still counting what it found on the disk at its start (`bytes` is short of it until then). */
  counting: boolean;
  /** The last time this runtime, given the mirror, threw its copy away for the mirror's (another's mark, none, or its own with a larger count): whose (null: no mark was found), when, and how many changes the mirror never had went with it. */
  takeover: { from: string | null; at: number; dropped: number } | null;
  /** The changes the mirror refused for good since the store started, the latest first (`REFUSED_KEPT` at most): the document's path or the blob's hash, the mirror's words, and when. Each left the working copy too. */
  refused: { name: string; doc: boolean; words: string; at: number }[];
}

export interface WorkingStore {
  readonly store: Required<StorePort>;
  readonly blobs: Required<BlobsPort>;
  /** Resolves when the mirror holds everything written before the call; rejects, in words a person can act on, when it doesn't within `waitMs`, when the mirror refused for good a change it waited for, and when the copy's end dropped one (each such change is told once: a later call isn't held up by it). */
  settle(): Promise<void>;
  /** Removes a chat's documents, by the core's rule (`deps.chatDocuments`), from the working copy and from the mirror, and settles; gives how many there were. */
  forget(chatId: string): Promise<{ documents: number }>;
  state(): WorkingStoreState;
  /** What this runtime says of its copy on a hello: its id, this process's holding, whether it asks for the mirror (not once it lost it), and the extension's count it last took. Null when the disk can't say whose copy it is: the runtime then keeps none. */
  ask(): Promise<MirrorAsk | null>;
  /** The extension's word on who holds the mirror (a hello's answer, or its push); null from a backend that names no holder, which keeps the runtime without a copy. */
  heard(word: MirrorWord | null): void;
  /** Lets the mirror go, as the runtime stops: when it holds it and the mirror holds everything, the mark is brought up to date and the extension told. Operations from then on go straight to the mirror. */
  release(): Promise<void>;
  /** Ends the store's work: whatever was under way on the disk is finished, nothing more is begun, and what the mirror doesn't hold yet waits in the journal for the next start. */
  close(): Promise<void>;
}

/** A path the mirror doesn't hold as it stands here. */
interface Entry {
  /** `d:<path>` or `b:<hash>`. */
  key: string;
  doc: boolean;
  /** The document's path or the blob's hash. */
  name: string;
  /** The first change (by number) the mirror lacks, and when it was made. */
  first: number;
  since: number;
  /** The last change made. */
  last: number;
  /** The change the text being sent now was read at; null while none is being sent. */
  sending: number | null;
  /** The first change made while it was being sent, and when: what the mirror lacks first once that send lands. */
  again: { change: number; at: number } | null;
}

/** A `settle()` waiting: the changes it waits for are those numbered up to `upTo`, and what the mirror refused for good of them (or the copy's end dropped) meanwhile, in words. */
interface Waiter {
  upTo: number;
  refusals: string[];
  resolve(): void;
  reject(error: Error): void;
  cancel(): void;
}

/** How many of the changes the mirror refused for good `state()` keeps, and how many wait to be told to a `settle()`. */
const REFUSED_KEPT = 20;

/** A loss not yet told to a `settle()`: the changes refused for good or dropped (from `from`, up to the one made since, `until`, where the path changed again), in words. */
interface Owed {
  from: number;
  until: number | null;
  words: string;
}

/** Whether a `settle()` that waits for the changes up to `upTo` waited for what was lost. */
function covers(owed: Owed, upTo: number): boolean {
  return upTo >= owed.from && (owed.until === null || upTo < owed.until);
}

/** The mirror's mark: the working copy it mirrors, how many changes it took from it, the runtime that holds it, and since when. */
interface Mark {
  copy: string;
  count: number;
  owner: string;
  at: number;
}

const whole = (v: unknown): number => (typeof v === "number" && Number.isSafeInteger(v) && v >= 0 ? v : 0);

function markOf(raw: JsonValue | null): Mark | null {
  if (!isRecord(raw) || raw.v !== 1 || raw.kind !== "mirror" || typeof raw.copy !== "string" || typeof raw.owner !== "string" || typeof raw.at !== "number") return null;
  return { copy: raw.copy, count: whole(raw.count), owner: raw.owner, at: raw.at };
}

function sha256(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}

/** An operation of the working copy's that the copy's end cut short before it changed anything: done straight on the mirror instead. */
class Ended extends Error {}

/** Sizes on the disk by name, and their sum, in the order of last use (the oldest first). */
class Tally {
  readonly sizes = new Map<string, number>();
  total = 0;

  set(name: string, bytes: number): void {
    this.drop(name);
    this.sizes.set(name, bytes);
    this.total += bytes;
  }

  drop(name: string): void {
    this.total -= this.sizes.get(name) ?? 0;
    this.sizes.delete(name);
  }

  clear(): void {
    this.sizes.clear();
    this.total = 0;
  }
}

export function createWorkingStore(deps: WorkingStoreDeps): WorkingStore {
  const disk = deps.disk ?? nodeDisk();
  const { remote, direct } = deps;
  const limits = (): StoreLimits => ({ ...STORE_DEFAULTS, ...deps.limits?.() });
  const root = `${deps.dir}/${sha256(JSON.stringify([deps.identity.lumiverse, deps.identity.user, deps.identity.extension])).slice(0, 32)}`;
  const DOCS = `${root}/docs`;
  const BLOBS = `${root}/blobs`;
  const JOURNAL = `${root}/journal`;
  const TMP = `${root}/tmp`;
  const docFile = (path: string): string => `${DOCS}/${path}`;
  const blobFile = (hash: string): string => `${BLOBS}/${hash.slice(0, 2)}/${hash}`;
  const fileOf = (entry: Entry): string => (entry.doc ? docFile(entry.name) : blobFile(entry.name));
  const markerOf = (entry: Entry): string => `${JOURNAL}/${entry.doc ? `d.${sha256(entry.name)}` : `b.${entry.name}`}`;

  /** This working copy's own id, as the mark names it. */
  let copy = "";
  /** How many changes the mirror took from this copy (each send that landed), and how many the mark last said. */
  let taken = 0;
  let markTaken = 0;
  let markAt = Number.NEGATIVE_INFINITY;
  /** The extension's count of what a holder may have missed that this copy last took (`MirrorWord.gen`). */
  let seen = 0;
  let closed = false;
  let mode: StoreMode = "waiting";
  let holder: string | null = null;
  let lost: WorkingStoreState["lost"] = null;
  /** Resolved, and made anew, whenever the mode changes or the store closes: what waits for one wakes. */
  let turned = Promise.withResolvers<void>();
  /** Counts the times the working copy was given up: an operation begun before the last refuses to change anything after it. */
  let epoch = 0;
  /** The changes asked for, numbered in the order they were asked. */
  let changes = 0;
  /** Every path the mirror doesn't hold as it stands here, in the order they were last changed. */
  const queue = new Map<string, Entry>();
  /** The work under way on each key, chained so the work on one key runs one piece at a time. */
  const chains = new Map<string, Promise<void>>();
  const waiters = new Set<Waiter>();
  /** Each change asked for and not yet in the journal (or refused), by its number: a `settle()` waits for those asked before it. */
  const inflight = new Map<number, Promise<void>>();
  /** Counts the changes as they enter the journal (and the paths another runtime changed), for whoever reads the mirror meanwhile (`watched`). */
  let entered = 0;
  /** Documents the mirror was found not to have, the one asked about last at the end. */
  const absent = new Set<string>();
  /** While the mirror is being read for something (or listed), the last change made to each key since (`changes`), and the last another runtime was told to have made (`others`), so what it gives isn't kept over a change; `sheds` counts the times the whole copy was dropped. */
  const watched = { count: 0, changes: new Map<string, number>(), others: new Map<string, number>() };
  let sheds = 0;
  /** Keys another runtime changed whose copy here is still being dropped: read from the mirror meanwhile. */
  const stale = new Map<string, number>();
  const docs = new Tally();
  const blobs = new Tally();
  /** Folders known to be on the disk. */
  const made = new Set<string>();
  /** Work begun beside an operation (keeping the order of use on the disk, counting at the start), which closing waits for. */
  const background = new Set<Promise<void>>();
  /** What wakes each wait between two tries at the mirror's mark, so closing ends it. */
  const sleeps = new Set<() => void>();
  let counting = true;
  let evicting = false;
  /** Blobs dropped while the count at the start was under way, which it must not count back in. */
  const uncounted = new Set<string>();
  let lastError: WorkingStoreState["lastError"] = null;
  let lastSent: number | null = null;
  let takeover: WorkingStoreState["takeover"] = null;
  const refused: WorkingStoreState["refused"] = [];
  /** The losses no `settle()` has been told of yet: the next that covers each is. */
  const unreported: Owed[] = [];
  /** The mirror's failures in a row, which set the wait before the next try. */
  let failures = 0;
  /** The path that failed alone in the last round, waiting out the retry with the rest; null when the mirror itself failed, or took a path since. */
  let lone: string | null = null;
  let round: Promise<void> | null = null;
  /** Cancels the wait before the next round of sending; null while there is none. */
  let retry: (() => void) | null = null;
  /** Cancels the wait before the mark is next written; null while there is none. */
  let markLater: (() => void) | null = null;
  let closing: Promise<void> | null = null;
  /** The opening of the copy under way, or the last one. */
  let opening: Promise<void> = Promise.resolve();
  /** The extension's words when it refused this runtime itself (`deps.disowned`): from then on nothing is sent, and nothing waits on the mirror. Null until then. */
  let shutOut: string | null = null;

  const backoff = (): number => {
    const { retryFirstMs, retryMostMs } = limits();
    return Math.min(retryMostMs, retryFirstMs * 2 ** Math.min(Math.max(failures - 1, 0), 30));
  };
  const seconds = (ms: number): string => `${Math.round(ms / 100) / 10} s`;

  function become(next: StoreMode): void {
    mode = next;
    const was = turned;
    turned = Promise.withResolvers<void>();
    was.resolve();
  }

  /** Runs `work` after every earlier piece of work on the same key: one path's changes, and what reads or sends it, one at a time, in the order asked. */
  function serial<T>(key: string, work: () => Promise<T>): Promise<T> {
    const result = (chains.get(key) ?? Promise.resolve()).then(work);
    const done = result.then(
      () => undefined,
      () => undefined,
    );
    chains.set(key, done);
    void done.then(() => {
      if (chains.get(key) === done) chains.delete(key);
    });
    return result;
  }

  /** Waits until no work is under way on any key, nor begins while it waits. */
  async function quiet(): Promise<void> {
    while (chains.size > 0) await Promise.all(chains.values());
  }

  function track(work: Promise<unknown>): void {
    const held = work.then(
      () => undefined,
      (error: unknown) => deps.log("warn", `the runtime's store: ${errorText(error)}`),
    );
    background.add(held);
    void held.then(() => background.delete(held));
  }

  /** `promise`, or a rejection with `error()` once `ms` have gone by first. */
  function within<T>(promise: Promise<T>, ms: number, error: () => Error): Promise<T> {
    const { promise: out, resolve, reject } = Promise.withResolvers<T>();
    const cancel = deps.later(ms, () => reject(error()));
    promise.then(
      (value) => {
        cancel();
        resolve(value);
      },
      (why: unknown) => {
        cancel();
        reject(why);
      },
    );
    return out;
  }

  /** Waits `ms`, or until the store closes or stops opening its copy. */
  function pause(ms: number): Promise<void> {
    const { promise, resolve } = Promise.withResolvers<void>();
    let cancel = (): void => undefined;
    const wake = (): void => {
      sleeps.delete(wake);
      cancel();
      resolve();
    };
    sleeps.add(wake);
    cancel = deps.later(ms, wake);
    return promise;
  }

  /** Puts `text` at `path` at once: written whole beside it, then renamed into its place. Its folder is made again where a removal left it empty and took it away meanwhile (`prune`). */
  async function place(path: string, text: string): Promise<void> {
    const temp = `${TMP}/${deps.id()}`;
    await disk.write(temp, text);
    const folder = path.slice(0, path.lastIndexOf("/"));
    for (let tries = 0; ; tries++) {
      if (!made.has(folder)) {
        await disk.mkdir(folder);
        made.add(folder);
      }
      try {
        await disk.rename(temp, path);
        return;
      } catch (error) {
        if (tries >= 2) throw error;
        made.delete(folder);
      }
    }
  }

  /** The folders a document's removal left empty, from its own up to `docs/`, are taken away: nothing named after a chat stays once its documents are gone. A folder another path is put in meanwhile is made again (`place`); one the disk won't take away stays, which harms nothing. */
  async function prune(path: string): Promise<void> {
    for (let cut = path.lastIndexOf("/"); cut > 0; cut = path.lastIndexOf("/", cut - 1)) {
      const folder = docFile(path.slice(0, cut));
      made.delete(folder);
      if (!(await disk.removeEmpty(folder).catch(() => false))) return;
    }
  }

  function failed(error: unknown): void {
    failures += 1;
    lastError = { words: errorText(error), at: deps.now() };
    if (failures === 1) deps.log("warn", `the extension's storage can't be reached (${lastError.words}): the runtime keeps what it saves and tries again, less often while it fails`);
  }

  function reached(): void {
    if (failures > 0) deps.log("info", "the extension's storage can be reached again");
    failures = 0;
  }

  /**
   * The extension refused the runtime itself (`deps.disowned`), and no wait mends that while this
   * process runs. Sending stops, and what waits on the mirror (the copy's opening, each `settle()`) is
   * told now rather than at the end of its wait; what wasn't sent stays in the journal on the disk for
   * the next runtime started on this folder.
   */
  function disown(error: unknown): void {
    if (shutOut !== null) return;
    shutOut = errorText(error);
    lastError = { words: shutOut, at: deps.now() };
    deps.log("warn", `the extension's storage refuses this runtime (${shutOut}): it sends nothing more, and what it hadn't sent waits on its disk for the next runtime started on this folder`);
    retry?.();
    retry = null;
    for (const waiter of [...waiters]) {
      waiters.delete(waiter);
      waiter.cancel();
      waiter.reject(new Error([...waiter.refusals, shutOutWords(shutOut)].join(" ")));
    }
    // What waits for the copy to open wakes, and hears it.
    become(mode);
  }

  // ---------------------------------------------------------------- opening, the extension's word, and the mark

  /** Notes on the disk whose copy this is, its id, how many of its changes the mirror took, and the count it last took from the extension: the count is there before a mark names it. */
  async function keepIdentity(): Promise<void> {
    await place(`${root}/identity.json`, `${JSON.stringify({ v: 1, kind: "working-copy", ...deps.identity, copy, count: taken, seen }, null, 2)}\n`);
  }

  /** A new copy: a new id, nothing of it taken by the mirror yet. */
  async function reborn(gen: number): Promise<void> {
    copy = deps.id();
    taken = 0;
    markTaken = 0;
    seen = gen;
    await keepIdentity();
  }

  /** The working copy's id and counts, from its `identity.json`; a copy without one is new, and is given one. */
  async function identity(): Promise<void> {
    const text = await disk.read(`${root}/identity.json`);
    const held = text === null ? undefined : parseJson(text);
    if (isRecord(held) && held.v === 1 && held.kind === "working-copy" && typeof held.copy === "string" && held.copy !== "") {
      copy = held.copy;
      taken = whole(held.count);
      seen = whole(held.seen);
      return;
    }
    await reborn(0);
  }

  /**
   * Reads the journal into the queue. A file whose path has nothing on the disk names a write cut off
   * before its text was in place, and goes, as does anything else found there. Blobs come first, then
   * documents, each in the order they were first changed, so a document reaches the mirror after the
   * blobs it names.
   */
  async function load(): Promise<void> {
    const found: Entry[] = [];
    for (const { name, folder } of await disk.entries(JOURNAL)) {
      const file = `${JOURNAL}/${name}`;
      try {
        const held = folder ? undefined : parseJson((await disk.read(file)) ?? "");
        const since = isRecord(held) && typeof held.at === "number" ? held.at : deps.now();
        let entry: Entry | null = null;
        if (!folder && name.startsWith("b.") && BLOB_HASH.test(name.slice(2))) entry = fresh(`b:${name.slice(2)}`, false, name.slice(2), 0, since);
        else if (isRecord(held) && typeof held.path === "string" && DOC_PATH.test(held.path) && held.path !== MARK_PATH && name === `d.${sha256(held.path)}`) entry = fresh(`d:${held.path}`, true, held.path, 0, since);
        if (entry === null || (await disk.stat(fileOf(entry))) === null) {
          await disk.removeAll(file);
          continue;
        }
        found.push(entry);
      } catch (error) {
        // A change the disk can't show is one nothing can send: it goes, rather than keep the store from opening.
        deps.log("warn", `the runtime's store dropped ${name} from its journal, as the disk can't read what it names (${errorText(error)})`);
        await disk.removeAll(file).catch(() => undefined);
      }
    }
    found.sort((a, b) => Number(a.doc) - Number(b.doc) || a.since - b.since);
    // Numbered 0: made before anything this start is asked, so every `settle()` waits for them, even one asked before the store opened.
    for (const entry of found) queue.set(entry.key, entry);
  }

  /** What the disk holds is read: the copy's id and the journal. Whether the copy is used is the extension's to say; the mirror isn't asked yet. */
  async function start(): Promise<void> {
    await serial("", async () => {
      await disk.mkdir(TMP);
      await disk.mkdir(JOURNAL);
      made.add(TMP).add(JOURNAL);
      for (const { name } of await disk.entries(TMP)) await disk.removeAll(`${TMP}/${name}`);
      await identity();
      await load();
    });
  }

  const started = start();
  started.catch((error: unknown) => {
    if (!closed) {
      lastError = { words: errorText(error), at: deps.now() };
      deps.log("error", `the runtime's store couldn't read its copy: ${lastError.words}`);
    }
  });

  /** Whether the folder holds a file, at any depth. */
  async function holdsFile(path: string): Promise<boolean> {
    for (const entry of await disk.entries(path)) if (!entry.folder || (await holdsFile(`${path}/${entry.name}`))) return true;
    return false;
  }

  /** Takes the working copy off the disk (its documents, its blobs, its journal) and what was remembered of the mirror, and starts a new copy in its place under a new id. The queue is the caller's to empty first. */
  async function wipe(gen: number): Promise<void> {
    await disk.removeAll(JOURNAL);
    await disk.removeAll(DOCS);
    await disk.removeAll(BLOBS);
    made.clear();
    await disk.mkdir(JOURNAL);
    made.add(TMP).add(JOURNAL);
    absent.clear();
    docs.clear();
    blobs.clear();
    // An empty copy has nothing left to count.
    counting = false;
    uncounted.clear();
    await reborn(gen);
  }

  /** Each change of a copy thrown away that the mirror never had, in the log, path by path. */
  function logDropped(dropped: readonly Entry[], why: string): void {
    for (const entry of dropped) deps.log("warn", `the runtime's store dropped ${entry.doc ? `the document ${entry.name}` : `the stored text ${entry.name}`}, which the extension's storage never had: ${why}`);
  }

  /** Brings the mirror's mark up to date: this copy, and how many changes the mirror took from it. The count is on the disk first, so a crash between the two never leaves the copy behind its own mark. */
  async function writeMark(): Promise<void> {
    const count = taken;
    await serial("", keepIdentity);
    await remote.store.write(MARK_PATH, { v: 1, kind: "mirror", copy, count, owner: deps.owner, at: deps.now() });
    markTaken = Math.max(markTaken, count);
    markAt = deps.now();
  }

  /**
   * The runtime was given the mirror: its copy is checked against the mirror's mark. Its own mark,
   * with a count its copy isn't behind, and the copy carries on, after dropping what the extension
   * says another runtime changed since. Else (another's mark, none while the copy holds something, or
   * a count the copy is behind: copied elsewhere, or restored) the copy is thrown away, with what it
   * hadn't sent, and the mark taken. Tried again, waiting longer each time, until the mirror can be
   * reached, the runtime loses the mirror or the store closes.
   */
  async function claim(word: MirrorWord): Promise<void> {
    await started;
    for (;;) {
      if (closed) throw new Error(WORDS.closed);
      if (mode !== "opening") return;
      try {
        const found = await remote.store.read(MARK_PATH);
        if (mode !== "opening" || closed) return;
        const mark = markOf(found);
        if (mark !== null && mark.copy === copy && taken >= mark.count) {
          markTaken = mark.count;
          reached();
          if (word.dropped !== undefined) await shed(word.dropped);
          if (seen !== word.gen) {
            seen = word.gen;
            await serial("", keepIdentity);
          }
          return;
        }
        const held = queue.size > 0 || (await holdsFile(DOCS)) || (await holdsFile(BLOBS));
        const dropped = [...queue.values()];
        const own = mark !== null && mark.copy === copy;
        if (found !== null || held) {
          queue.clear();
          await serial("", () => wipe(word.gen));
        } else if (seen !== word.gen) {
          seen = word.gen;
          await serial("", keepIdentity);
        }
        if (mode !== "opening" || closed) return;
        await writeMark();
        if (found !== null || held) {
          const from = mark === null ? null : mark.owner;
          takeover = { from, at: deps.now(), dropped: dropped.length };
          const whose = mark === null ? "doesn't say which runtime keeps it" : own ? "has taken more from this runtime's copy than the copy holds (a copy from a backup, or from another machine)" : `is kept by another runtime (${from}, since ${new Date(mark.at).toISOString()})`;
          logDropped(dropped, "the copy was thrown away for the storage's");
          deps.log("warn", `the extension's storage ${whose}: this runtime threw its own copy away${dropped.length > 0 ? `, with ${dropped.length} changes the storage never had,` : ""} and keeps the storage from now on`);
        }
        reached();
        return;
      } catch (error) {
        if (closed) throw new Error(WORDS.closed);
        if (deps.withdrawn?.(error) === true) {
          lose(null);
          return;
        }
        if (deps.disowned?.(error) === true) {
          disown(error);
          return;
        }
        failed(error);
        await pause(backoff());
      }
    }
  }

  /** The runtime was given the mirror: operations wait while its copy is checked, then run on it. */
  function open(word: MirrorWord): void {
    become("opening");
    opening = claim(word).then(
      () => {
        if (mode !== "opening" || closed || shutOut !== null) return;
        become("held");
        if (counting) track(count(epoch));
        kick();
      },
      (error: unknown) => {
        if (closed) return;
        // A copy the disk can't keep is no copy: the runtime works on the mirror, and lets another hold it.
        lastError = { words: errorText(error), at: deps.now() };
        deps.log("error", `the runtime's store couldn't open its copy, so it reads and writes the extension's storage directly: ${lastError.words}`);
        lost = { at: deps.now(), to: null, dropped: 0 };
        become("direct");
        void deps.release?.().catch(() => undefined);
      },
    );
    // Not waited for at closing (both its ends are handled): its read of the mark may wait on a link that is down.
  }

  /**
   * Another runtime holds the mirror now: this one stops using its copy at once (operations from now
   * on go straight to the mirror, and one begun on the copy that hadn't changed anything yet is done
   * there instead), and never asks for the mirror again in this process. Once the work under way on
   * the copy has ended, what it hadn't sent is dropped, path by path in the log, the copy is thrown
   * away, and each `settle()` that waited for any of it is told; one that didn't is let go.
   */
  function lose(to: string | null): void {
    if (mode !== "held" && mode !== "opening") return;
    lost = { at: deps.now(), to, dropped: 0 };
    holder = to;
    epoch += 1;
    become("direct");
    retry?.();
    retry = null;
    markLater?.();
    markLater = null;
    for (const wake of [...sleeps]) wake();
    const who = to === null ? "Another runtime" : `Another runtime (${to})`;
    deps.log("warn", `the runtime's store: ${who} keeps the extension's storage now, so this runtime stops using its own copy and reads and writes the storage directly until it starts again`);
    track(
      (async () => {
        await quiet();
        const dropped = [...queue.values()];
        queue.clear();
        logDropped(dropped, "another runtime keeps the storage now");
        const ended = lost;
        if (ended !== null) ended.dropped = dropped.length;
        if (dropped.length > 0) {
          const words = `${who} keeps the extension's storage now, so this runtime stopped using its own copy, and ${dropped.length === 1 ? "a change" : `${dropped.length} changes`} it hadn't sent there ${dropped.length === 1 ? "was" : "were"} dropped (the log names each). It reads and writes the storage directly from now on.`;
          tell({ from: Math.min(...dropped.map((entry) => entry.first)), until: null, words });
        }
        notify();
        await serial("", () => wipe(0)).catch((error: unknown) => deps.log("warn", `the runtime's store couldn't take its old copy off the disk (${errorText(error)}): the next start throws it away`));
      })(),
    );
  }

  /** A loss is told to each `settle()` waiting that covers it, or (none waiting) to the next one that does. */
  function tell(owed: Owed): void {
    let told = false;
    for (const waiter of waiters) {
      if (!covers(owed, waiter.upTo)) continue;
      waiter.refusals.push(owed.words);
      told = true;
    }
    if (!told) unreported.splice(0, unreported.push(owed) - REFUSED_KEPT);
  }

  /**
   * Another runtime changed these in the mirror: what the copy holds of them goes, so the next read is
   * the mirror's (read so at once: they count as stale until their copy is gone). A change made here
   * that the mirror hasn't had yet stays: it is the newer. `all`: every one the copy holds, while
   * operations wait.
   */
  async function shed(dropped: NonNullable<MirrorWord["dropped"]>): Promise<void> {
    if (dropped.all) {
      await quiet();
      sheds += 1;
      for (const path of await localDocs()) await forgo(`d:${path}`, true, path);
      for (const pair of await disk.entries(BLOBS)) {
        if (!pair.folder) continue;
        for (const file of await disk.entries(`${BLOBS}/${pair.name}`)) if (!file.folder && BLOB_HASH.test(file.name)) await forgo(`b:${file.name}`, false, file.name);
      }
      absent.clear();
      return;
    }
    const keys = [...dropped.docs.filter((path) => DOC_PATH.test(path)).map((path) => ({ key: `d:${path}`, doc: true, name: path })), ...dropped.blobs.filter((hash) => BLOB_HASH.test(hash)).map((hash) => ({ key: `b:${hash}`, doc: false, name: hash }))];
    for (const { key, doc, name } of keys) {
      stale.set(key, (stale.get(key) ?? 0) + 1);
      entered += 1;
      if (watched.count > 0) watched.others.set(key, entered);
      if (doc) absent.delete(name);
    }
    await Promise.all(
      keys.map(({ key, doc, name }) =>
        forgo(key, doc, name).finally(() => {
          const left = (stale.get(key) ?? 1) - 1;
          if (left > 0) stale.set(key, left);
          else stale.delete(key);
        }),
      ),
    );
  }

  /** What the disk holds of one key goes, unless it is a change the mirror hasn't had yet. */
  function forgo(key: string, doc: boolean, name: string): Promise<void> {
    return serial(key, async () => {
      if (closed || queue.has(key)) return;
      if (doc) {
        if ((await disk.stat(docFile(name))) === null) return;
        await disk.remove(docFile(name));
        docs.drop(name);
        await prune(name);
      } else {
        await disk.remove(blobFile(name));
        dropBlob(name);
      }
    });
  }

  /** Every document the disk holds, by path. */
  async function localDocs(): Promise<string[]> {
    const held = new Map<string, number>();
    await walk("", held);
    return [...held.keys()];
  }

  /** The holder, told on a new hello that it may have missed another runtime's changes, drops everything its copy holds that the mirror has; operations wait meanwhile. */
  async function shedAll(word: MirrorWord): Promise<void> {
    become("opening");
    try {
      if (word.dropped !== undefined) await shed(word.dropped);
      seen = word.gen;
      await serial("", keepIdentity);
    } finally {
      if (mode === "opening" && !closed) {
        become("held");
        kick();
      }
    }
  }

  /** Waits until operations may run, within `waitMs`: on the working copy (gives the epoch they begin in), or straight on the mirror while the runtime keeps no copy (null). */
  async function ready(): Promise<number | null> {
    const until = deps.now() + limits().waitMs;
    for (;;) {
      if (closed) throw new Error(WORDS.closed);
      if (mode === "direct") return null;
      if (mode === "held") return epoch;
      // Refused by the extension, the copy can't be checked against the mirror: there is nothing to wait for.
      if (shutOut !== null) throw new Error(shutOutWords(shutOut));
      await within(turned.promise, Math.max(0, until - deps.now()), () => {
        // The mirror's last failure as the wait runs out: the likely reason.
        const cause = lastError === null ? "" : ` (${lastError.words})`;
        return mode === "waiting"
          ? new Error(`The runtime's store hasn't heard from the extension which runtime keeps its storage since it started${cause}, so it can't yet tell whether to use its own copy. Try again once the runtime is linked.`)
          : new Error(`The runtime's store hasn't reached the extension's storage since it was given it${cause}, so it can't yet tell whether the copy it holds is still the one the extension keeps. Try again once the runtime is linked.`);
      });
    }
  }

  /**
   * An operation on the working copy (`held`, given the epoch it began in), or straight on the mirror
   * while the runtime keeps no copy (`straight`). One the copy's end cut short before it changed
   * anything is done straight instead, as is one the mirror refused because the runtime lost it.
   */
  async function either<T>(held: (at: number) => Promise<T>, straight: () => Promise<T>): Promise<T> {
    for (;;) {
      const at = await ready();
      if (at === null) return straight();
      try {
        return await held(at);
      } catch (error) {
        if (error instanceof Ended) continue;
        if (deps.withdrawn?.(error) === true) {
          lose(null);
          continue;
        }
        throw error;
      }
    }
  }

  function check(at: number): void {
    if (closed) throw new Error(WORDS.closed);
    if (epoch !== at) throw new Ended(WORDS.ended);
  }

  // ---------------------------------------------------------------- changes, and the sender

  function fresh(key: string, doc: boolean, name: string, change: number, since: number): Entry {
    return { key, doc, name, first: change, since, last: change, sending: null, again: null };
  }

  /** Notes a change of a path in the journal before it is made (its file first when it has none), and moves the path behind every other in the queue. True when the path had no change waiting: `unenter` takes the note back when the change can't be made. */
  async function enter(key: string, doc: boolean, name: string, change: number): Promise<boolean> {
    entered += 1;
    if (watched.count > 0) watched.changes.set(key, entered);
    const entry = queue.get(key);
    if (entry === undefined) {
      const added = fresh(key, doc, name, change, deps.now());
      await place(markerOf(added), JSON.stringify(doc ? { path: name, at: added.since } : { at: added.since }));
      queue.set(key, added);
      return true;
    }
    if (entry.sending !== null && entry.again === null) entry.again = { change, at: deps.now() };
    entry.last = change;
    queue.delete(key);
    queue.set(key, entry);
    return false;
  }

  /** A change noted by `enter` that couldn't be made on the disk: nothing of it waits in the journal. A note the disk won't let go of names a file that isn't there, which the next start drops. */
  async function unenter(key: string): Promise<void> {
    const entry = queue.get(key);
    if (entry === undefined) return;
    queue.delete(key);
    await disk.remove(markerOf(entry)).catch(() => undefined);
  }

  /** A change asked for: numbered at once, so a `settle()` asked after it waits for it and one asked before doesn't. */
  function numbered(work: (change: number) => Promise<void>): Promise<void> {
    changes += 1;
    const change = changes;
    const done = work(change);
    const over = done.then(
      () => undefined,
      () => undefined,
    );
    inflight.set(change, over);
    void over.then(() => inflight.delete(change));
    return done;
  }

  /** A document's new text (empty: it is removed), on the disk and in the journal; the sender takes it to the mirror. */
  async function change(at: number, number: number, path: string, text: string): Promise<void> {
    const key = `d:${path}`;
    await serial(key, async () => {
      check(at);
      const noted = await enter(key, true, path, number);
      try {
        await place(docFile(path), text);
      } catch (error) {
        if (noted) await unenter(key);
        throw error;
      }
      docs.set(path, Buffer.byteLength(text));
      absent.delete(path);
    });
    kick();
  }

  /** Whether the mark says fewer changes than the mirror took, and was written long enough ago to be written again. */
  function markDue(): boolean {
    return taken > markTaken && deps.now() - markAt >= limits().markMs;
  }

  /**
   * Starts a round of sending, unless one is under way or there is nothing to send (nor a mark due);
   * `now`: also when it would wait out a try that failed. A path that failed alone (`lone`) may be the
   * one path the mirror doesn't take for now, not the mirror: another path waiting isn't held back by
   * its wait.
   */
  function kick(now = false): void {
    if (closed || shutOut !== null || mode !== "held" || round !== null || (queue.size === 0 && !markDue())) return;
    if (retry !== null) {
      if (!now && (lone === null || ![...queue.keys()].some((key) => key !== lone))) return;
      retry();
      retry = null;
    }
    round = send().finally(() => {
      round = null;
      if (retry === null) kick();
    });
  }

  /** A round of sending: each path in the queue, oldest first, until none is left or the mirror fails; then the mark, when it is due (else a wait until it is). */
  async function send(): Promise<void> {
    const at = epoch;
    try {
      let failedLast = false;
      for (;;) {
        if (closed || epoch !== at || mode !== "held") return;
        const entry = queue.values().next().value;
        if (entry === undefined) {
          if (taken > markTaken) {
            const wait = limits().markMs - (deps.now() - markAt);
            if (wait <= 0) await writeMark();
            else
              markLater ??= deps.later(wait, () => {
                markLater = null;
                kick();
              });
          }
          return;
        }
        try {
          await sendOne(entry, at);
        } catch (error) {
          // A second failure in a row is the mirror itself. A first may be this path alone (one the mirror refuses for now), so it goes behind the others and holds none of them up.
          if (failedLast || closed) {
            lone = null;
            throw error;
          }
          if (queue.size === 1) {
            lone = entry.key;
            throw error;
          }
          failedLast = true;
          lastError = { words: `${entry.name}: ${errorText(error)}`, at: deps.now() };
          if (queue.get(entry.key) === entry) {
            queue.delete(entry.key);
            queue.set(entry.key, entry);
          }
          continue;
        }
        failedLast = false;
        lone = null;
        reached();
        // Room is made before a `settle()` waiting on this path is told: what it then finds on the disk stays as it is.
        if (!entry.doc) await evict();
        notify();
      }
    } catch (error) {
      if (closed || epoch !== at) return;
      if (deps.withdrawn?.(error) === true) {
        lose(null);
        return;
      }
      if (deps.disowned?.(error) === true) {
        disown(error);
        return;
      }
      failed(error);
      retry = deps.later(backoff(), () => {
        retry = null;
        kick();
      });
    }
  }

  /** Sends what the disk holds of one path: read under the path's turn, sent outside it (a change of the path never waits on the mirror), and settled under it again. */
  async function sendOne(entry: Entry, at: number): Promise<void> {
    const read = await serial(entry.key, async () => {
      if (closed || epoch !== at || queue.get(entry.key) !== entry) return undefined;
      const text = await disk.read(fileOf(entry));
      entry.sending = entry.last;
      return { text };
    });
    if (read === undefined) return;
    let sent: boolean;
    try {
      sent = await deliver(entry, read.text);
    } catch (error) {
      // The mirror is another runtime's now: not this change's failure, nor one that passes.
      if (!closed && deps.withdrawn?.(error) === true) {
        lose(null);
        return;
      }
      if (!closed && deps.refusedForGood?.(error) === true) {
        await serial(entry.key, () => refusal(entry, at, error));
        return;
      }
      entry.sending = null;
      entry.again = null;
      throw error;
    }
    await serial(entry.key, () => landed(entry, at, read.text, sent));
  }

  /**
   * The mirror refused a path's change for good: the refusal is said in the log, in `state()`, and to
   * each `settle()` that waits for the text refused, or (when none waits) to the next one that
   * covers it, so whoever waits on what was written is told even when the refusal came first.
   * Changed again since that text was read, the path waits for its next turn with the change made
   * since, which the mirror may take (a `settle()` asked after that change waits for it alone). Else
   * it leaves the journal and the working copy, which then reads what the mirror holds: the two
   * agree again.
   */
  async function refusal(entry: Entry, at: number, error: unknown): Promise<void> {
    if (closed || epoch !== at || queue.get(entry.key) !== entry) return;
    const since = entry.last !== entry.sending ? (entry.again?.change ?? entry.last) : null;
    const what = entry.doc ? `the document ${entry.name}` : `the stored text ${entry.name}`;
    const words = `The extension's storage refused ${what} for good (${errorText(error)})${since === null ? ", so the runtime dropped it too: the storage keeps what it had." : ", and keeps what it had: the runtime sends it the change made since."}`;
    refused.unshift({ name: entry.name, doc: entry.doc, words, at: deps.now() });
    refused.splice(REFUSED_KEPT);
    deps.log("warn", `the runtime's store: ${words}`);
    tell({ from: entry.first, until: since, words });
    if (since !== null) {
      await landed(entry, at, null, false);
      return;
    }
    await disk.remove(markerOf(entry));
    queue.delete(entry.key);
    await disk.remove(fileOf(entry));
    if (entry.doc) {
      docs.drop(entry.name);
      await prune(entry.name);
    } else dropBlob(entry.name);
  }

  /** Sends a path's text to the mirror; false when there is nothing that can be sent (cut off before it was in place, or damaged on the disk: said in the log), and the mirror keeps what it had. */
  async function deliver(entry: Entry, text: string | null): Promise<boolean> {
    if (text === null) return false;
    if (!entry.doc) {
      if ((await textHash(text)) !== entry.name) {
        deps.log("warn", `the runtime's copy of blob ${entry.name} doesn't match its hash any more, so it isn't sent`);
        return false;
      }
      await remote.blobs.put(entry.name, text);
      return true;
    }
    if (text === "") {
      await remote.store.remove(entry.name);
      return true;
    }
    const value = parseJson(text);
    if (value === undefined) {
      deps.log("warn", `the runtime's copy of ${entry.name} isn't JSON any more, so it isn't sent`);
      return false;
    }
    await remote.store.write(entry.name, value as JsonValue);
    return true;
  }

  /** A send landed (or there was nothing to send). The path is the mirror's now, unless it changed meanwhile: then it waits for its next turn, from the first change since. */
  async function landed(entry: Entry, at: number, text: string | null, sent: boolean): Promise<void> {
    if (closed || epoch !== at || queue.get(entry.key) !== entry) return;
    if (sent) {
      lastSent = deps.now();
      taken += 1;
    }
    if (entry.last !== entry.sending) {
      const again = entry.again ?? { change: entry.last, at: deps.now() };
      entry.first = again.change;
      entry.since = again.at;
      entry.sending = null;
      entry.again = null;
      return;
    }
    await disk.remove(markerOf(entry));
    queue.delete(entry.key);
    // A removal the mirror has had needs no mark here any more; what couldn't be sent goes too, and is read from the mirror from then on.
    if (text === "" || (!sent && text !== null)) {
      await disk.remove(fileOf(entry));
      if (entry.doc) {
        docs.drop(entry.name);
        await prune(entry.name);
      } else dropBlob(entry.name);
    }
    if (entry.doc && text === "") remember(entry.name);
  }

  function mirrored(upTo: number): boolean {
    for (const entry of queue.values()) if (entry.first <= upTo) return false;
    return true;
  }

  /** Each `settle()` whose changes the mirror holds now (or will never hold: told why) is answered. */
  function notify(): void {
    for (const waiter of [...waiters]) {
      if (!mirrored(waiter.upTo)) continue;
      waiters.delete(waiter);
      waiter.cancel();
      if (waiter.refusals.length > 0) waiter.reject(new Error(waiter.refusals.join(" ")));
      else waiter.resolve();
    }
  }

  async function settle(): Promise<void> {
    const upTo = changes;
    const asked = [...inflight.values()];
    await ready();
    // What was asked before this is on the disk first (or in the mirror), so it is among what the mirror must hold.
    await Promise.all(asked);
    // What the mirror refused for good, or the copy's end dropped, of what this covers, that no `settle()` was told of yet.
    const owed = unreported.filter((one) => covers(one, upTo));
    if (owed.length > 0) unreported.splice(0, unreported.length, ...unreported.filter((one) => !owed.includes(one)));
    if (mirrored(upTo)) {
      if (owed.length > 0) throw new Error(owed.map((one) => one.words).join(" "));
      return;
    }
    // Closed while it waited for those: nothing will send them now.
    if (closed) throw new Error(WORDS.closedBehind);
    // Refused by the extension: nothing more is sent, so there is nothing to wait for.
    if (shutOut !== null) throw new Error([...owed.map((one) => one.words), shutOutWords(shutOut)].join(" "));
    kick(true);
    const ms = limits().waitMs;
    const { promise, resolve, reject } = Promise.withResolvers<void>();
    const waiter: Waiter = { upTo, refusals: owed.map((one) => one.words), resolve, reject, cancel: () => undefined };
    waiters.add(waiter);
    waiter.cancel = deps.later(ms, () => {
      waiters.delete(waiter);
      // The mirror's last word, when it was a failure: the likely reason it is behind.
      const cause = lastError !== null && (lastSent === null || lastError.at >= lastSent) ? ` (${lastError.words})` : "";
      const setting = deps.waitsOwner === undefined ? "" : ` It waits as long as ${transportWait(["runtime", "storeWaitMs"], deps.waitsOwner())} says.`;
      reject(new Error([...waiter.refusals, `The extension's storage hasn't taken everything the runtime saved within ${seconds(ms)}${cause}. Nothing is lost: it waits on the runtime's disk and is sent again, less often while it fails, until the storage takes it.${setting}`].join(" ")));
    });
    return promise;
  }

  // ---------------------------------------------------------------- reading, and what the disk holds

  /** A blob gone from the disk is gone from the count too, and from the count at the start while it is still under way. */
  function dropBlob(hash: string): void {
    blobs.drop(hash);
    if (counting) uncounted.add(hash);
  }

  function remember(path: string): void {
    absent.delete(path);
    absent.add(path);
    for (const old of absent) {
      if (absent.size <= limits().absent) break;
      absent.delete(old);
    }
  }

  /**
   * Reads the mirror for a key, noting the changes made to it meanwhile: what the mirror gives is kept
   * in the working copy (`keep`) only when no change of the key began while it was read (nor another
   * runtime's change was told of), so an older text never lands over a newer one.
   */
  async function fromMirror<T>(key: string, at: number, read: () => Promise<T>, keep: (value: T) => Promise<void>): Promise<T> {
    watched.count += 1;
    const before = entered;
    const shedAt = sheds;
    try {
      const value = await read();
      await serial(key, async () => {
        if (closed || epoch !== at || sheds !== shedAt || (watched.changes.get(key) ?? 0) > before || (watched.others.get(key) ?? 0) > before) return;
        try {
          await keep(value);
        } catch (error) {
          // What the mirror gave is the answer all the same; it is read from there again next time.
          deps.log("warn", `the runtime's store couldn't keep ${key.slice(2)} on its disk (${errorText(error)}), so it reads it from the extension's storage each time until it can`);
        }
      });
      return value;
    } finally {
      watched.count -= 1;
      if (watched.count === 0) {
        watched.changes.clear();
        watched.others.clear();
      }
    }
  }

  /** Keeps the blobs on the disk within their room: those the mirror holds go, the one used longest ago first; one it doesn't hold yet stays, whatever room it takes. */
  async function evict(): Promise<void> {
    if (evicting || blobs.total <= limits().blobBytes) return;
    evicting = true;
    try {
      for (const hash of [...blobs.sizes.keys()]) {
        if (closed || blobs.total <= limits().blobBytes) return;
        const key = `b:${hash}`;
        if (queue.has(key)) continue;
        await serial(key, async () => {
          if (closed || queue.has(key) || !blobs.sizes.has(hash)) return;
          await disk.remove(blobFile(hash));
          dropBlob(hash);
        });
      }
    } finally {
      evicting = false;
    }
  }

  /** Every file under `docs/<dir>`, by its document's path, with its size. */
  async function walk(dir: string, out: Map<string, number>): Promise<void> {
    for (const entry of await disk.entries(dir === "" ? DOCS : `${DOCS}/${dir}`)) {
      const path = dir === "" ? entry.name : `${dir}/${entry.name}`;
      if (entry.folder) await walk(path, out);
      else {
        const held = await disk.stat(docFile(path));
        if (held !== null) out.set(path, held.bytes);
      }
    }
  }

  /** Counts what the disk held at the opening: each document's size, and each blob's in the order they were last used (before any used since). */
  async function count(at: number): Promise<void> {
    const found: { hash: string; bytes: number; at: number }[] = [];
    for (const pair of await disk.entries(BLOBS)) {
      if (!pair.folder) continue;
      for (const file of await disk.entries(`${BLOBS}/${pair.name}`)) {
        if (closed || epoch !== at) return;
        if (file.folder || !BLOB_HASH.test(file.name)) continue;
        const held = await disk.stat(blobFile(file.name));
        if (held !== null) found.push({ hash: file.name, bytes: held.bytes, at: held.at });
      }
    }
    const held = new Map<string, number>();
    await walk("", held);
    if (closed || epoch !== at) return;
    found.sort((a, b) => a.at - b.at);
    const since = [...blobs.sizes];
    blobs.clear();
    for (const blob of found) if (!uncounted.has(blob.hash)) blobs.set(blob.hash, blob.bytes);
    for (const [hash, bytes] of since) blobs.set(hash, bytes);
    for (const [path, bytes] of held) if (!docs.sizes.has(path)) docs.set(path, bytes);
    counting = false;
    uncounted.clear();
    await evict();
  }

  /** The working copy alone, as the core's rule for a chat's documents reads a store: what the disk holds now, the mirror aside. */
  const local: Pick<StorePort, "list" | "read"> = {
    async read(path) {
      if (!DOC_PATH.test(path)) throw new Error(WORDS.path);
      const text = await disk.read(docFile(path));
      return text === null || text === "" ? null : ((parseJson(text) as JsonValue | undefined) ?? null);
    },
    async list(prefix) {
      if (!DOC_PREFIX.test(prefix)) throw new Error(WORDS.prefix);
      const cut = prefix.lastIndexOf("/");
      const held = new Map<string, number>();
      await walk(cut < 0 ? "" : prefix.slice(0, cut), held);
      return [...held].filter(([path, bytes]) => bytes > 0 && path.startsWith(prefix)).map(([path]) => path);
    },
  };

  function docPath(path: unknown): string {
    if (typeof path !== "string" || !DOC_PATH.test(path)) throw new Error(WORDS.path);
    if (path === MARK_PATH) throw new Error(WORDS.mark);
    return path;
  }

  function blobHash(hash: unknown): string {
    if (typeof hash !== "string" || !BLOB_HASH.test(hash)) throw new Error(WORDS.hash);
    return hash;
  }

  /** A blob as the mirror gives it: only when it matches its hash (else it reads as missing, in the log). */
  async function mirrorBlob(from: Required<BlobsPort>, hash: string): Promise<string | null> {
    const held = await from.get(hash);
    if (held === null || (await textHash(held)) === hash) return held;
    deps.log("warn", `the stored blob ${hash} doesn't match its hash, so it is read as missing`);
    return null;
  }

  const store: Required<StorePort> = {
    async read(asked) {
      const path = docPath(asked);
      const key = `d:${path}`;
      return either(
        async (at) => {
          const text = stale.has(key) ? null : await disk.read(docFile(path));
          // Removed here; the mirror hasn't had the removal yet.
          if (text === "") return null;
          if (text !== null) {
            const value = parseJson(text);
            if (value !== undefined) return value as JsonValue;
            deps.log("warn", `the runtime's copy of ${path} isn't JSON any more, so it is read from the extension's storage`);
            await serial(key, async () => {
              if (closed || epoch !== at || queue.has(key)) return;
              await disk.remove(docFile(path));
              docs.drop(path);
            });
          } else if (absent.has(path)) {
            remember(path);
            return null;
          }
          return fromMirror(key, at, () => remote.store.read(path), async (value) => {
            if ((await disk.stat(docFile(path))) !== null) return;
            if (value === null) remember(path);
            else {
              const kept = JSON.stringify(value);
              await place(docFile(path), kept);
              docs.set(path, Buffer.byteLength(kept));
            }
          });
        },
        () => direct.store.read(path),
      );
    },
    async write(asked, value) {
      const path = docPath(asked);
      if ((value as JsonValue | undefined) === undefined) throw new Error(WORDS.value);
      await numbered((number) =>
        either(
          (at) => change(at, number, path, JSON.stringify(value)),
          () => direct.store.write(path, value),
        ),
      );
    },
    async remove(asked) {
      const path = docPath(asked);
      await numbered((number) =>
        either(
          (at) => change(at, number, path, ""),
          () => direct.store.remove(path),
        ),
      );
    },
    async list(prefix) {
      if (typeof prefix !== "string" || !DOC_PREFIX.test(prefix)) throw new Error(WORDS.prefix);
      return either(
        async () => {
          watched.count += 1;
          const before = entered;
          try {
            const laid = new Set<string>();
            for (const entry of queue.values()) if (entry.doc && entry.name.startsWith(prefix)) laid.add(entry.name);
            const listed = new Set(await remote.store.list(prefix));
            for (const [key, number] of watched.changes) if (number > before && key.startsWith("d:") && key.slice(2).startsWith(prefix)) laid.add(key.slice(2));
            // Each path changed here since the listing began is as the disk holds it now: a document, or (an empty file, or none once the mirror had the removal) not one.
            for (const path of laid) {
              const held = await disk.stat(docFile(path));
              if (held !== null && held.bytes > 0) listed.add(path);
              else listed.delete(path);
            }
            listed.delete(MARK_PATH);
            return [...listed];
          } finally {
            watched.count -= 1;
            if (watched.count === 0) {
              watched.changes.clear();
              watched.others.clear();
            }
          }
        },
        async () => (await direct.store.list(prefix)).filter((path) => path !== MARK_PATH),
      );
    },
  };

  const blobPort: Required<BlobsPort> = {
    async put(asked, text) {
      const hash = blobHash(asked);
      if (typeof text !== "string") throw new Error(WORDS.text);
      await numbered((number) =>
        either(
          async (at) => {
            const key = `b:${hash}`;
            await serial(key, async () => {
              check(at);
              // Stored again: written and sent again too, as the extension's storage has always been written, so a copy damaged on the disk is mended and the mirror's time for it (what upkeep's grace counts from) is the time of the last put.
              const noted = await enter(key, false, hash, number);
              try {
                await place(blobFile(hash), text);
              } catch (error) {
                if (noted) await unenter(key);
                throw error;
              }
              blobs.set(hash, Buffer.byteLength(text));
            });
            kick();
            await evict();
          },
          () => direct.blobs.put(hash, text),
        ),
      );
    },
    async get(asked) {
      const hash = blobHash(asked);
      const key = `b:${hash}`;
      return either(
        async (at) => {
          const file = blobFile(hash);
          const text = stale.has(key) ? null : await disk.read(file);
          if (text !== null) {
            if ((await textHash(text)) === hash) {
              blobs.set(hash, Buffer.byteLength(text));
              track(disk.touch(file, deps.now()));
              return text;
            }
            deps.log("warn", `the runtime's copy of blob ${hash} doesn't match its hash, so it is read from the extension's storage`);
            await serial(key, async () => {
              if (closed || epoch !== at || queue.has(key)) return;
              await disk.remove(file);
              dropBlob(hash);
            });
          }
          const found = await fromMirror(
            key,
            at,
            () => mirrorBlob(remote.blobs, hash),
            async (held) => {
              if (held === null || (await disk.stat(file)) !== null) return;
              await place(file, held);
              blobs.set(hash, Buffer.byteLength(held));
            },
          );
          if (found !== null) await evict();
          return found;
        },
        () => mirrorBlob(direct.blobs, hash),
      );
    },
    /** The mirror's listing, once the mirror holds everything put before it: a blob's time is the mirror's, as upkeep's grace has always counted from. */
    list(cursor): Promise<{ blobs: BlobInfo[]; next: string | null }> {
      return either(
        async () => {
          await settle();
          return remote.blobs.list(cursor);
        },
        () => direct.blobs.list(cursor),
      );
    },
    /**
     * Removes blobs from the working copy, then from the mirror, once the mirror holds everything put
     * before the call. A blob put again since (still waiting for the mirror) is as fresh as one just
     * stored, which upkeep's grace keeps, so it stays; one put again while the mirror removed it goes
     * to the mirror again, as its put was taken.
     */
    async remove(asked) {
      const hashes = asked.map(blobHash);
      if (hashes.length === 0) return;
      await either(
        async () => {
          await settle();
          const at = await ready();
          if (at === null) throw new Ended(WORDS.ended);
          const gone: string[] = [];
          for (const hash of hashes) {
            const key = `b:${hash}`;
            await serial(key, async () => {
              check(at);
              if (queue.has(key)) return;
              await disk.remove(blobFile(hash));
              dropBlob(hash);
              gone.push(hash);
            });
          }
          if (gone.length === 0) return;
          await remote.blobs.remove(gone);
          for (const hash of gone) {
            const key = `b:${hash}`;
            await numbered((number) =>
              serial(key, async () => {
                if (closed || epoch !== at || (await disk.stat(blobFile(hash))) === null) return;
                await enter(key, false, hash, number);
              }),
            );
          }
          kick();
        },
        () => direct.blobs.remove(hashes),
      );
    },
  };

  return {
    store,
    blobs: blobPort,
    settle,
    forget(chatId) {
      return either(
        async () => {
          // The working copy first, which can always be read: what it holds of the chat goes even while the mirror can't be reached.
          const paths = new Set(await deps.chatDocuments(local, chatId));
          for (const path of paths) await store.remove(path);
          for (const path of await deps.chatDocuments(store, chatId)) {
            if (paths.has(path)) continue;
            paths.add(path);
            await store.remove(path);
          }
          await settle();
          return { documents: paths.size };
        },
        async () => {
          const paths = new Set(await deps.chatDocuments(direct.store, chatId));
          for (const path of paths) await direct.store.remove(path);
          // What an old copy on the disk still holds of the chat goes too: nothing of it stays here.
          for (const path of await deps.chatDocuments(local, chatId)) {
            await serial(`d:${path}`, async () => {
              if (closed || mode !== "direct") return;
              await disk.remove(docFile(path));
              docs.drop(path);
              await prune(path);
            });
          }
          return { documents: paths.size };
        },
      );
    },
    state() {
      let behindSince: number | null = null;
      for (const entry of queue.values()) if (behindSince === null || entry.since < behindSince) behindSince = entry.since;
      return { open: mode === "held" || mode === "direct", mode, holder, lost: lost === null ? null : { ...lost }, waiting: queue.size, behindSince, lastError, lastSent, bytes: docs.total + blobs.total, counting, takeover, refused: [...refused] };
    },
    async ask() {
      try {
        await started;
      } catch {
        return null;
      }
      return { copy, process: deps.holding, asks: lost === null, seen };
    },
    heard(word) {
      if (closed) return;
      if (word === null || !word.held) {
        holder = word?.holder ?? null;
        if (mode === "held" || mode === "opening") lose(holder);
        else if (mode === "waiting") become("direct");
        else if (lost !== null && lost.to === null) lost.to = holder;
        return;
      }
      holder = null;
      // A process that lost the mirror never holds it again: it didn't ask.
      if (lost !== null) return;
      if (mode === "waiting" || mode === "direct") {
        open(word);
        return;
      }
      const { dropped } = word;
      if (dropped === undefined) return;
      if (dropped.all) {
        // Once the copy is open (it may be being checked now): the whole of it, while operations wait.
        track(opening.then(() => (mode === "held" ? shedAll(word) : undefined)));
        return;
      }
      track(shed(dropped));
    },
    async release() {
      if (mode !== "held" || closed || shutOut !== null) return;
      // What the mirror lacks waits for the next start, which needs the mirror back: it isn't let go.
      if (queue.size > 0) return;
      if (taken > markTaken) await writeMark();
      if (mode !== "held" || queue.size > 0) return;
      await deps.release?.();
      markLater?.();
      markLater = null;
      become("direct");
    },
    close() {
      closing ??= (async () => {
        closed = true;
        become(mode);
        retry?.();
        retry = null;
        markLater?.();
        markLater = null;
        for (const wake of [...sleeps]) wake();
        for (const waiter of waiters) {
          waiter.cancel();
          waiter.reject(new Error(WORDS.closedBehind));
        }
        waiters.clear();
        await quiet();
        await Promise.all(background);
      })();
      return closing;
    },
  };
}
