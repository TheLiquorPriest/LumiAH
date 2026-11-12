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
// The mirror carries a mark naming the working copy it mirrors. A runtime that finds another's mark
// there (or none, while its own copy holds something) throws its copy away, reads the mirror afresh
// and takes the mark: two working copies never write over each other unseen.
//
// On the disk, under `dir`, a folder for each identity (one user's data of one extension on one
// Lumiverse), named by a hash of it:
//   identity.json        whose data it is, in plain words, and the copy's own id, which the mark names
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
import { BLOB_HASH } from "../../link/contract";
import { type Disk, nodeDisk } from "./disk";

/** A document's path as the extension's storage takes it (`extension/backend/reads.ts`): names of letters, digits, `.`, `_` and `-`, joined by `/`, none of them `.` or `..`. The same pattern, so the working copy refuses at once what the mirror would refuse, and never journals a write the mirror can't take. */
const DOC_PATH = /^(?!.*(?:^|\/)\.{1,2}(?:\/|$))[A-Za-z0-9._-]{1,128}(?:\/[A-Za-z0-9._-]{1,128}){0,7}$/;
/** A prefix of documents' paths as the extension's storage takes it: a path's names, ending with `/` or inside a name; empty for every document. */
const DOC_PREFIX = /^(?!.*(?:^|\/)\.{1,2}(?:\/|$))(?:[A-Za-z0-9._-]{1,128}\/){0,7}[A-Za-z0-9._-]{0,128}$/;

/** Where the mirror's mark is kept: a document of the store's own beside the core's, at a path none of the core's can be. */
export const MARK_PATH = "mirror.json";

const WORDS = {
  path: "A document's path is names of letters, digits, '.', '_' and '-' joined by '/'.",
  prefix: "A documents' prefix is names of letters, digits, '.', '_' and '-' joined by '/'.",
  mark: `${MARK_PATH} is where the runtime notes which runtime keeps the extension's storage: no document can be kept under that name.`,
  hash: "A blob is named by its SHA-256 hash, in lower-case hex.",
  text: "A blob is text.",
  value: "A document needs a value.",
  closed: "The runtime's store is closed: the runtime is stopping.",
  closedBehind: "The runtime's store closed before the extension's storage had everything: what it hadn't sent waits on the runtime's disk and goes there when the runtime starts again.",
  dropped: "Another runtime began keeping the extension's storage while this was being done, so it was dropped. Try again.",
};

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
  /** How long `settle()` waits for the mirror, and an operation for the store to open (it can't tell whose its copy is until it has reached the mirror once). */
  waitMs: number;
  /** The most bytes of blobs kept on the disk: past it, those the mirror holds go, the one read longest ago first. One the mirror doesn't hold yet is never dropped. */
  blobBytes: number;
  /** The wait after the mirror first fails, doubled at each failure since, up to `retryMostMs`. */
  retryFirstMs: number;
  retryMostMs: number;
  /** How long a reading of the mirror's mark is trusted: a round of sending that begins later reads it again. */
  markMs: number;
  /** How many documents the mirror doesn't have are remembered as absent, the one asked about longest ago forgotten first. */
  absent: number;
}

export const STORE_DEFAULTS: StoreLimits = {
  waitMs: 60_000,
  blobBytes: 2 * 1024 ** 3,
  retryFirstMs: 1_000,
  retryMostMs: 60_000,
  markMs: 60_000,
  absent: 10_000,
};

export interface WorkingStoreDeps {
  /** The folder the runtime keeps its working copies in (`<runtimeDir>/store`). */
  dir: string;
  identity: StoreIdentity;
  /** The extension's storage, over the link: the mirror. */
  remote: { store: Required<StorePort>; blobs: Required<BlobsPort> };
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
  /** The setting that holds `waitMs` and where to change it, as the user finds it: named when a wait runs out. */
  waitSetting?: string;
  /** The disk (the runtime's own, unless a test hands one that stops part way). */
  disk?: Disk;
}

export interface WorkingStoreState {
  /** Whether the store is open: it has reached the mirror since it started and holds the mark. */
  open: boolean;
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
  /** The last time this runtime threw its copy away for another's mark (or for none): whose (null: no mark was found), when, and how many changes the mirror never had went with it. */
  takeover: { from: string | null; at: number; dropped: number } | null;
}

export interface WorkingStore {
  readonly store: Required<StorePort>;
  readonly blobs: Required<BlobsPort>;
  /** Resolves when the mirror holds everything written before the call; rejects, in words a person can act on, when it doesn't within `waitMs`. */
  settle(): Promise<void>;
  /** Removes a chat's documents, by the core's rule (`deps.chatDocuments`), from the working copy and from the mirror, and settles; gives how many there were. */
  forget(chatId: string): Promise<{ documents: number }>;
  state(): WorkingStoreState;
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

/** A `settle()` waiting: the changes it waits for are those numbered up to `upTo`. */
interface Waiter {
  upTo: number;
  resolve(): void;
  reject(error: Error): void;
  cancel(): void;
}

/** The mirror's mark: the working copy it mirrors, the runtime that holds it, and since when. */
interface Mark {
  copy: string;
  owner: string;
  at: number;
}

function markOf(raw: JsonValue | null): Mark | null {
  if (!isRecord(raw) || raw.v !== 1 || raw.kind !== "mirror" || typeof raw.copy !== "string" || typeof raw.owner !== "string" || typeof raw.at !== "number") return null;
  return { copy: raw.copy, owner: raw.owner, at: raw.at };
}

function sha256(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}

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
  const { remote } = deps;
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
  let closed = false;
  /** Whether operations may run: the store has opened and the mark is this copy's. */
  let usable = false;
  /** Counts the times the working copy was thrown away: an operation begun before the last refuses to change anything after it. */
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
  /** Counts the changes as they enter the journal, for whoever reads the mirror meanwhile (`watched`). */
  let entered = 0;
  /** Documents the mirror was found not to have, the one asked about last at the end. */
  const absent = new Set<string>();
  /** While the mirror is being read for something (or listed), the last change made to each key since, so what it gives isn't kept over a change. */
  const watched = { count: 0, changes: new Map<string, number>() };
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
  /** The mirror's failures in a row, which set the wait before the next try. */
  let failures = 0;
  let markReadAt = Number.NEGATIVE_INFINITY;
  let failedSinceMark = false;
  let round: Promise<void> | null = null;
  /** Cancels the wait before the next round of sending; null while there is none. */
  let retry: (() => void) | null = null;
  let closing: Promise<void> | null = null;

  const backoff = (): number => {
    const { retryFirstMs, retryMostMs } = limits();
    return Math.min(retryMostMs, retryFirstMs * 2 ** Math.min(Math.max(failures - 1, 0), 30));
  };
  const seconds = (ms: number): string => `${Math.round(ms / 100) / 10} s`;

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

  /** Waits `ms`, or until the store closes. */
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

  /** Puts `text` at `path` at once: written whole beside it, then renamed into its place. */
  async function place(path: string, text: string): Promise<void> {
    const temp = `${TMP}/${deps.id()}`;
    await disk.write(temp, text);
    const folder = path.slice(0, path.lastIndexOf("/"));
    if (!made.has(folder)) {
      await disk.mkdir(folder);
      made.add(folder);
    }
    await disk.rename(temp, path);
  }

  function failed(error: unknown): void {
    failures += 1;
    failedSinceMark = true;
    lastError = { words: errorText(error), at: deps.now() };
    if (failures === 1) deps.log("warn", `the extension's storage can't be reached (${lastError.words}): the runtime keeps what it saves and tries again, less often while it fails`);
  }

  function reached(): void {
    if (failures > 0) deps.log("info", "the extension's storage can be reached again");
    failures = 0;
  }

  // ---------------------------------------------------------------- opening, and the mark

  /** The working copy's id, from its `identity.json`; a copy without one is new, and is given one. */
  async function identity(): Promise<string> {
    const path = `${root}/identity.json`;
    const text = await disk.read(path);
    const held = text === null ? undefined : parseJson(text);
    if (isRecord(held) && held.v === 1 && held.kind === "working-copy" && typeof held.copy === "string" && held.copy !== "") return held.copy;
    const id = deps.id();
    await place(path, `${JSON.stringify({ v: 1, kind: "working-copy", ...deps.identity, copy: id }, null, 2)}\n`);
    return id;
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
    }
    found.sort((a, b) => Number(a.doc) - Number(b.doc) || a.since - b.since);
    // Numbered 0: made before anything this start is asked, so every `settle()` waits for them, even one asked before the store opened.
    for (const entry of found) queue.set(entry.key, entry);
  }

  async function start(): Promise<void> {
    await serial("", async () => {
      await disk.mkdir(TMP);
      await disk.mkdir(JOURNAL);
      made.add(TMP).add(JOURNAL);
      for (const { name } of await disk.entries(TMP)) await disk.removeAll(`${TMP}/${name}`);
      copy = await identity();
      await load();
    });
    await claim();
    usable = true;
    if (queue.size > 0) deps.log("info", `the runtime's store has ${queue.size} changes the extension's storage doesn't have yet: sending them`);
    track(count(epoch));
    kick();
  }

  /** Whether the folder holds a file, at any depth. */
  async function holdsFile(path: string): Promise<boolean> {
    for (const entry of await disk.entries(path)) if (!entry.folder || (await holdsFile(`${path}/${entry.name}`))) return true;
    return false;
  }

  /** Throws the working copy away: its documents, its blobs, its journal, and what was remembered of the mirror. Gives how many changes the mirror never had went with it. */
  async function discard(): Promise<number> {
    const dropped = queue.size;
    await disk.removeAll(JOURNAL);
    await disk.removeAll(DOCS);
    await disk.removeAll(BLOBS);
    made.clear();
    await disk.mkdir(JOURNAL);
    made.add(TMP).add(JOURNAL);
    queue.clear();
    absent.clear();
    docs.clear();
    blobs.clear();
    // An empty copy has nothing left to count.
    counting = false;
    uncounted.clear();
    return dropped;
  }

  /**
   * Makes the mirror's mark this copy's. When it is already, the copy carries on. When it names
   * another copy, or there is none while this copy holds something (the mirror may have changed under
   * it), the copy is thrown away first: from then on the mirror is read afresh. Tried again, waiting
   * longer each time, until the mirror can be reached or the store closes.
   */
  async function claim(): Promise<void> {
    for (;;) {
      if (closed) throw new Error(WORDS.closed);
      try {
        const found = await remote.store.read(MARK_PATH);
        const mark = markOf(found);
        if (mark !== null && mark.copy === copy) {
          markRead();
          return;
        }
        const held = queue.size > 0 || (await holdsFile(DOCS)) || (await holdsFile(BLOBS));
        let dropped = 0;
        if (found !== null || held) {
          if (closed) throw new Error(WORDS.closed);
          dropped = await serial("", discard);
        }
        if (closed) throw new Error(WORDS.closed);
        await remote.store.write(MARK_PATH, { v: 1, kind: "mirror", copy, owner: deps.owner, at: deps.now() });
        if (found !== null || held) {
          const from = mark === null ? null : mark.owner;
          takeover = { from, at: deps.now(), dropped };
          const whose = from === null ? "doesn't say which runtime keeps it" : `is kept by another runtime (${from}, since ${new Date(mark?.at ?? 0).toISOString()})`;
          deps.log("warn", `the extension's storage ${whose}: this runtime threw its own copy away${dropped > 0 ? `, with ${dropped} changes the storage never had,` : ""} and keeps the storage from now on`);
        }
        markRead();
        return;
      } catch (error) {
        if (closed) throw new Error(WORDS.closed);
        failed(error);
        await pause(backoff());
      }
    }
  }

  function markRead(): void {
    markReadAt = deps.now();
    failedSinceMark = false;
    reached();
  }

  let opening = start();
  opening.catch((error: unknown) => {
    if (!closed) {
      lastError = { words: errorText(error), at: deps.now() };
      deps.log("error", `the runtime's store couldn't open: ${lastError.words}`);
    }
  });

  /**
   * Stops every operation while the copy is thrown away for another's mark: those under way end
   * first, those that begin wait until the mark is this copy's again, and each `settle()` waiting is
   * told its changes are gone.
   */
  async function yieldTo(mark: Mark | null): Promise<void> {
    usable = false;
    epoch += 1;
    const words = mark === null ? "The extension's storage no longer says which runtime keeps it, so this runtime threw its own copy away, with what it hadn't sent there yet." : `Another runtime (${mark.owner}) keeps the extension's storage now, so this runtime threw its own copy away, with what it hadn't sent there yet.`;
    for (const waiter of waiters) {
      waiter.cancel();
      waiter.reject(new Error(words));
    }
    waiters.clear();
    await quiet();
    opening = claim().then(() => {
      usable = true;
      kick();
    });
    opening.catch(() => undefined);
  }

  /** Waits until operations may run, within `waitMs`; gives the epoch the operation began in. */
  async function ready(): Promise<number> {
    while (!usable) {
      if (closed) throw new Error(WORDS.closed);
      await within(opening, limits().waitMs, () => new Error(`The runtime's store hasn't reached the extension's storage since it started${lastError === null ? "" : ` (${lastError.words})`}, so it can't yet tell whether the copy it holds is still the one the extension keeps. Try again once the runtime is linked.`));
    }
    if (closed) throw new Error(WORDS.closed);
    return epoch;
  }

  function check(at: number): void {
    if (closed) throw new Error(WORDS.closed);
    if (epoch !== at) throw new Error(WORDS.dropped);
  }

  // ---------------------------------------------------------------- changes, and the sender

  function fresh(key: string, doc: boolean, name: string, change: number, since: number): Entry {
    return { key, doc, name, first: change, since, last: change, sending: null, again: null };
  }

  /** Notes a change of a path in the journal before it is made (its file first when it has none), and moves the path behind every other in the queue. */
  async function enter(key: string, doc: boolean, name: string, change: number): Promise<void> {
    entered += 1;
    if (watched.count > 0) watched.changes.set(key, entered);
    const entry = queue.get(key);
    if (entry === undefined) {
      const added = fresh(key, doc, name, change, deps.now());
      await place(markerOf(added), JSON.stringify(doc ? { path: name, at: added.since } : { at: added.since }));
      queue.set(key, added);
      return;
    }
    if (entry.sending !== null && entry.again === null) entry.again = { change, at: deps.now() };
    entry.last = change;
    queue.delete(key);
    queue.set(key, entry);
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
  function change(path: string, text: string): Promise<void> {
    return numbered(async (number) => {
      const at = await ready();
      const key = `d:${path}`;
      await serial(key, async () => {
        check(at);
        await enter(key, true, path, number);
        await place(docFile(path), text);
        docs.set(path, Buffer.byteLength(text));
        absent.delete(path);
      });
      kick();
    });
  }

  /** Starts a round of sending, unless one is under way or there is nothing to send; `now`: also when it would wait out a try that failed. */
  function kick(now = false): void {
    if (closed || !usable || round !== null || queue.size === 0) return;
    if (retry !== null) {
      if (!now) return;
      retry();
      retry = null;
    }
    round = send().finally(() => {
      round = null;
      if (retry === null) kick();
    });
  }

  /** A round of sending: the mark read again when it is due, then each path in the queue, oldest first, until none is left or the mirror fails. */
  async function send(): Promise<void> {
    const at = epoch;
    try {
      if (failedSinceMark || deps.now() - markReadAt >= limits().markMs) {
        const mark = markOf(await remote.store.read(MARK_PATH));
        if (mark === null || mark.copy !== copy) {
          await yieldTo(mark);
          return;
        }
        markRead();
      }
      let failedLast = false;
      for (;;) {
        if (closed || epoch !== at) return;
        const entry = queue.values().next().value;
        if (entry === undefined) return;
        try {
          await sendOne(entry, at);
        } catch (error) {
          // A second failure in a row is the mirror itself. A first may be this path alone (one the mirror refuses), so it goes behind the others and holds none of them up.
          if (failedLast || queue.size === 1 || closed) throw error;
          failedLast = true;
          lastError = { words: `${entry.name}: ${errorText(error)}`, at: deps.now() };
          if (queue.get(entry.key) === entry) {
            queue.delete(entry.key);
            queue.set(entry.key, entry);
          }
          continue;
        }
        failedLast = false;
        reached();
        // Room is made before a `settle()` waiting on this path is told: what it then finds on the disk stays as it is.
        if (!entry.doc) await evict();
        notify();
      }
    } catch (error) {
      if (closed) return;
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
      entry.sending = null;
      entry.again = null;
      throw error;
    }
    await serial(entry.key, () => landed(entry, at, read.text, sent));
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
    if (sent) lastSent = deps.now();
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
      if (entry.doc) docs.drop(entry.name);
      else dropBlob(entry.name);
    }
    if (entry.doc && text === "") remember(entry.name);
  }

  function mirrored(upTo: number): boolean {
    for (const entry of queue.values()) if (entry.first <= upTo) return false;
    return true;
  }

  function notify(): void {
    for (const waiter of [...waiters]) {
      if (!mirrored(waiter.upTo)) continue;
      waiters.delete(waiter);
      waiter.cancel();
      waiter.resolve();
    }
  }

  async function settle(): Promise<void> {
    const upTo = changes;
    const begun = epoch;
    const asked = [...inflight.values()];
    await ready();
    // What was asked before this is on the disk first, so it is among what the mirror must hold.
    await Promise.all(asked);
    // The copy was thrown away for another runtime's meanwhile, and what this waited for with it.
    if (epoch !== begun) throw new Error(WORDS.dropped);
    if (mirrored(upTo)) return;
    // Closed while it waited for those: nothing will send them now.
    if (closed) throw new Error(WORDS.closedBehind);
    kick(true);
    const ms = limits().waitMs;
    const { promise, resolve, reject } = Promise.withResolvers<void>();
    const waiter: Waiter = { upTo, resolve, reject, cancel: () => undefined };
    waiters.add(waiter);
    waiter.cancel = deps.later(ms, () => {
      waiters.delete(waiter);
      // The mirror's last word, when it was a failure: the likely reason it is behind.
      const cause = lastError !== null && (lastSent === null || lastError.at >= lastSent) ? ` (${lastError.words})` : "";
      const setting = deps.waitSetting === undefined ? "" : ` It waits as long as ${deps.waitSetting} says.`;
      reject(new Error(`The extension's storage hasn't taken everything the runtime saved within ${seconds(ms)}${cause}. Nothing is lost: it waits on the runtime's disk and goes to the storage as soon as it can be reached.${setting}`));
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
   * in the working copy (`keep`) only when no change of the key began while it was read, so an older
   * text never lands over a newer one.
   */
  async function fromMirror<T>(key: string, at: number, read: () => Promise<T>, keep: (value: T) => Promise<void>): Promise<T> {
    watched.count += 1;
    const before = entered;
    try {
      const value = await read();
      await serial(key, async () => {
        if (closed || epoch !== at || (watched.changes.get(key) ?? 0) > before) return;
        await keep(value);
      });
      return value;
    } finally {
      watched.count -= 1;
      if (watched.count === 0) watched.changes.clear();
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

  /** Counts what the disk held at the start: each document's size, and each blob's in the order they were last used (before any used since). */
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

  const store: Required<StorePort> = {
    async read(asked) {
      const path = docPath(asked);
      const at = await ready();
      const text = await disk.read(docFile(path));
      // Removed here; the mirror hasn't had the removal yet.
      if (text === "") return null;
      if (text !== null) {
        const value = parseJson(text);
        if (value !== undefined) return value as JsonValue;
        deps.log("warn", `the runtime's copy of ${path} isn't JSON any more, so it is read from the extension's storage`);
        await serial(`d:${path}`, async () => {
          if (closed || epoch !== at || queue.has(`d:${path}`)) return;
          await disk.remove(docFile(path));
          docs.drop(path);
        });
      } else if (absent.has(path)) {
        remember(path);
        return null;
      }
      return fromMirror(`d:${path}`, at, () => remote.store.read(path), async (value) => {
        if ((await disk.stat(docFile(path))) !== null) return;
        if (value === null) remember(path);
        else {
          const kept = JSON.stringify(value);
          await place(docFile(path), kept);
          docs.set(path, Buffer.byteLength(kept));
        }
      });
    },
    async write(asked, value) {
      const path = docPath(asked);
      if ((value as JsonValue | undefined) === undefined) throw new Error(WORDS.value);
      await change(path, JSON.stringify(value));
    },
    async remove(asked) {
      await change(docPath(asked), "");
    },
    async list(prefix) {
      if (typeof prefix !== "string" || !DOC_PREFIX.test(prefix)) throw new Error(WORDS.prefix);
      await ready();
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
        if (watched.count === 0) watched.changes.clear();
      }
    },
  };

  const blobPort: Required<BlobsPort> = {
    async put(asked, text) {
      const hash = blobHash(asked);
      if (typeof text !== "string") throw new Error(WORDS.text);
      return numbered(async (number) => {
        const at = await ready();
        const key = `b:${hash}`;
        await serial(key, async () => {
          check(at);
          // Stored again: written and sent again too, as the extension's storage has always been written, so a copy damaged on the disk is mended and the mirror's time for it (what upkeep's grace counts from) is the time of the last put.
          await enter(key, false, hash, number);
          await place(blobFile(hash), text);
          blobs.set(hash, Buffer.byteLength(text));
        });
        kick();
        await evict();
      });
    },
    async get(asked) {
      const hash = blobHash(asked);
      const at = await ready();
      const key = `b:${hash}`;
      const file = blobFile(hash);
      const text = await disk.read(file);
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
        async () => {
          const held = await remote.blobs.get(hash);
          if (held === null || (await textHash(held)) === hash) return held;
          deps.log("warn", `the stored blob ${hash} doesn't match its hash, so it is read as missing`);
          return null;
        },
        async (held) => {
          if (held === null || (await disk.stat(file)) !== null) return;
          await place(file, held);
          blobs.set(hash, Buffer.byteLength(held));
        },
      );
      if (found !== null) await evict();
      return found;
    },
    /** The mirror's listing, once the mirror holds everything put before it: a blob's time is the mirror's, as upkeep's grace has always counted from. */
    async list(cursor): Promise<{ blobs: BlobInfo[]; next: string | null }> {
      await settle();
      return remote.blobs.list(cursor);
    },
    /**
     * Removes blobs from the working copy, then from the mirror, once the mirror holds everything put
     * before the call. A blob put again since (still waiting for the mirror) is as fresh as one just
     * stored, which upkeep's grace keeps, so it stays.
     */
    async remove(asked) {
      const hashes = asked.map(blobHash);
      if (hashes.length === 0) return;
      await settle();
      const at = await ready();
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
      if (gone.length > 0) await remote.blobs.remove(gone);
    },
  };

  return {
    store,
    blobs: blobPort,
    settle,
    async forget(chatId) {
      await ready();
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
    state() {
      let behindSince: number | null = null;
      for (const entry of queue.values()) if (behindSince === null || entry.since < behindSince) behindSince = entry.since;
      return { open: usable, waiting: queue.size, behindSince, lastError, lastSent, bytes: docs.total + blobs.total, counting, takeover };
    },
    close() {
      closing ??= (async () => {
        closed = true;
        usable = false;
        retry?.();
        retry = null;
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
