// The workspace (DESIGN §11): the agents' only file system. Markdown and other text files they keep
// for themselves and for each other, in three areas: the chat's (`/`), which follows the story path
// as the session does; `learned/`, kept with the chat itself; and `~/`, the user's own, shared by all
// their chats.
//
// A file's body is a blob. An area is an index, a blob too: each file by its path, with its version
// now (the body's hash), who wrote it and when, the versions before it, and the agent definitions it
// is pinned for. Where an area's index stands is its head, which whoever holds the area keeps: a
// document in the store for `learned/` and `~/`, and for the chat's area one per turn (the turn's
// record holds the index as it stood when the turn ended).
//
// Every write names the version it was based on, or says the file is new; a mismatch is refused with
// the version there is, so whoever wrote reads again. That is what lets the main agent, sub-agents,
// jobs and the user work on the same files.

import type { Blobs } from "./blobs";
import { isHash, textHash } from "./hash";
import type { FileAuthor, FileChange, HarnessHost, JsonObject, WorkspaceArea } from "./ports";
import { isRecord } from "./ports";
import { HarnessRefusal } from "./refusal";
import { AGENT, type Settings } from "./settings";
import { hasOwn, parseJson } from "./util";

// ---------------------------------------------------------------- what is stored

/** A version of a file: its body's hash, its length in characters, when it was written and by whom. */
export interface FileVersion {
  hash: string;
  chars: number;
  at: number;
  by: FileAuthor;
}

/** A file as its area's index holds it: its version now, the versions before it (the newest first, as many as Settings keep), and the agent definitions it is pinned for. */
export interface FileEntry extends FileVersion {
  was: FileVersion[];
  pins: string[];
}

/** An area's index, as stored in its blob: every file by its path within the area (`notes/plan.md`: no leading slash, no `.` or `..`). */
export interface AreaIndex {
  v: 1;
  kind: "index";
  files: Record<string, FileEntry>;
}

/** Where an area's index stands, as stored in a head's document: the index's hash (null while the area has never held a file), and when it was last moved on. */
export interface AreaDoc {
  v: 1;
  kind: "area";
  head: string | null;
  at: number;
}

/** Where an area's index stands, read and moved on by whoever holds the area. */
export interface AreaHead {
  /** The hash of the area's index; null while it has never held a file. */
  read(): Promise<string | null>;
  write(hash: string): Promise<void>;
}

// ---------------------------------------------------------------- an area

/**
 * Why an area refused a change: there is no such file; the change said the file was new, and there is
 * one (`version`: its body's hash); the version the change was based on isn't the one there is; the
 * file, the area's file count or the area's size would pass its setting; or whoever holds the area
 * refuses it (`reason`, in words for whoever asked: a file agents may not write, a job whose turn left
 * the path).
 */
export type AreaRefusal =
  | { code: "missing"; path: string }
  | { code: "exists"; path: string; version: string }
  | { code: "stale"; path: string; version: string }
  | { code: "file_chars"; chars: number; limit: number }
  | { code: "files"; limit: number }
  | { code: "area_chars"; chars: number; limit: number }
  | { code: "refused"; reason: string };

/** A change to an area, made (`changes`: what it did to which files; `entry`: the file as it stands after, where it still is) or refused. */
export type AreaResult = { ok: true; changes: FileChange[]; entry: FileEntry | null } | { ok: false; why: AreaRefusal };

/** A write: the file's whole new text, and the version it was based on (null: the file is new). `force` writes whatever is there, for a change already checked elsewhere. */
export interface WriteInput {
  path: string;
  text: string;
  base: string | null;
  by: FileAuthor;
  force?: true;
}

/** A move: the version of `from` it was based on. `to` must be new. */
export interface MoveInput {
  from: string;
  to: string;
  base: string;
  by: FileAuthor;
  force?: true;
}

export interface RemoveInput {
  path: string;
  base: string;
  by: FileAuthor;
  force?: true;
}

/** A pin set or lifted for one agent definition. A pin is no version: the file's body and history stay as they are. */
export interface PinInput {
  path: string;
  role: string;
  pinned: boolean;
}

/**
 * An area as its tools and the page use it. Paths are within the area and already normalized
 * (`resolvePath`). A `base` is a body's hash, or any start of one at least `VERSION_CHARS` long.
 */
export interface AreaAccess {
  readonly kind: WorkspaceArea;
  /** The index as it stands. */
  index(): Promise<AreaIndex>;
  /** The text of a version by its body's hash; null when the store no longer has it. */
  text(hash: string): Promise<string | null>;
  write(input: WriteInput): Promise<AreaResult>;
  move(input: MoveInput): Promise<AreaResult>;
  remove(input: RemoveInput): Promise<AreaResult>;
  pin(input: PinInput): Promise<AreaResult>;
}

// ---------------------------------------------------------------- the workspace as one agent holds it

/**
 * The workspace as one agent of a run, a job or the user holds it: who its writes are recorded as,
 * the agent definition its pins are kept for, its three areas (null for one the run doesn't have: a
 * side session about no chat has the user's alone), and what it may not write.
 */
export interface WorkspaceView {
  author: FileAuthor;
  role: string;
  areas: Readonly<Record<WorkspaceArea, AreaAccess | null>>;
  /** Why this holder may not write `path` of `area`, in words for whoever asked; null: it may. */
  guard(area: WorkspaceArea, path: string): string | null;
}

// ---------------------------------------------------------------- versions

/**
 * How a version is written for a model: this many leading hex characters of the body's hash. Fixed,
 * not a setting: it limits nothing. Twelve tell any two versions of a file apart (16^12) and are
 * still short to copy, and a base is read as the start of a hash, so the versions an agent's notes
 * hold from earlier turns stay good whatever length they were written at.
 */
export const VERSION_CHARS = 12;

/**
 * The shortest start of a hash that is taken as a base. Fixed, not a setting: it is what keeps a
 * base from matching by chance (one in 16^8), so that a change can't pass for based on a version its
 * writer never read. A model that copies a version a little short is still understood.
 */
const BASE_CHARS = 8;

/** A version as a model reads it and writes it back: the start of its body's hash. */
export function versionOf(hash: string): string {
  return hash.slice(0, VERSION_CHARS);
}

/** Whether `base` names the version whose body's hash is `hash`: the whole hash, or a start of it long enough to name it alone, in any letter case. */
export function sameVersion(base: string, hash: string): boolean {
  const given = base.trim().toLowerCase();
  return given === hash || (given.length >= BASE_CHARS && hash.startsWith(given));
}

// ---------------------------------------------------------------- paths

/** The three areas, in the order they are read wherever all of them are: the chat's, what is kept with the chat, the user's. */
export const WORKSPACE_AREAS: readonly WorkspaceArea[] = ["chat", "learned", "user"];

/** How each area's root is written: what a path opens with says which area it is in. */
const ROOT: Readonly<Record<WorkspaceArea, string>> = { chat: "/", learned: "learned/", user: "~/" };

/** The folder at the chat's root that is the `learned` area. */
const LEARNED = "learned";

/** What no path holds: a backslash (a path's folders are parted by `/` alone) or a control character. */
const NOT_IN_A_PATH = /[\\\p{Cc}]/u;

/**
 * A path as an agent writes it, read: the area it is in, and its path within that area
 * (`notes/plan.md`; `""` for the area's root). `~` and `~/…` are the user's area, `learned/…` is
 * `learned`, and anything else is the chat's, with or without a leading slash. Empty and `.` segments
 * are dropped, and `..` climbs one segment.
 *
 * Refused: `bad` for a path that holds a backslash or a control character, `outside` for one that
 * would leave its area, `long` for one longer than `pathChars` within its area.
 */
export function resolvePath(raw: string, pathChars: number): { area: WorkspaceArea; path: string } | { refused: "outside" | "long" | "bad" } {
  const given = raw.trim();
  if (NOT_IN_A_PATH.test(given)) return { refused: "bad" };
  const home = given === "~" || given.startsWith("~/");
  const segments = (home ? given.slice(1) : given).split("/").filter((segment) => segment !== "" && segment !== ".");
  const learned = !home && segments[0] === LEARNED;
  const kept: string[] = [];
  for (const segment of learned ? segments.slice(1) : segments) {
    if (segment !== "..") kept.push(segment);
    else if (kept.pop() === undefined) return { refused: "outside" };
  }
  // A climb that comes down on `learned` at the chat's root has left the chat's area for the one of that name: what it wrote there could never be read back by the path it is shown under.
  if (!home && !learned && kept[0] === LEARNED) return { refused: "outside" };
  const path = kept.join("/");
  if (path.length > pathChars) return { refused: "long" };
  return { area: home ? "user" : learned ? "learned" : "chat", path };
}

/** A path as agents read it: `/notes/a.md` in the chat's area, `learned/a.md`, `~/a.md`; an area's root is `/`, `learned/` or `~/`. `resolvePath` reads it back. */
export function showPath(area: WorkspaceArea, path: string): string {
  return `${ROOT[area]}${path}`;
}

/** A folder as agents read it: its path closed with a slash, which tells it from a file in a listing (`/notes/`, `learned/`, `~/drafts/`). */
export function showFolder(area: WorkspaceArea, path: string): string {
  return path === "" ? ROOT[area] : `${ROOT[area]}${path}/`;
}

// ---------------------------------------------------------------- indexes

type Filed = readonly [path: string, entry: FileEntry];

/** Path order: by UTF-16 code unit, which every host sorts alike. */
function byPath([a]: Filed, [b]: Filed): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/**
 * Files by path as an index holds them, written in path order, so the same files always make the
 * same blob. The record has no prototype: a file may be named anything (`constructor`, `__proto__`),
 * and a path that names no file reads as none.
 */
function filesOf(files: Iterable<Filed>): Record<string, FileEntry> {
  const out = Object.create(null) as Record<string, FileEntry>;
  for (const [path, entry] of [...files].sort(byPath)) out[path] = entry;
  return out;
}

function emptyIndex(): AreaIndex {
  return { v: 1, kind: "index", files: filesOf([]) };
}

/** An index's files, in path order. */
export function filesIn(index: AreaIndex): [path: string, entry: FileEntry][] {
  return Object.entries(index.files).sort(byPath);
}

/** The file an index holds at `path`, if it holds one. An index made anywhere is read safely: a path is never answered from an object's prototype. */
export function fileAt(index: AreaIndex, path: string): FileEntry | undefined {
  return hasOwn(index.files, path) ? index.files[path] : undefined;
}

/** A file's version now, apart from its history and its pins. */
function versionNow(entry: FileEntry): FileVersion {
  return { hash: entry.hash, chars: entry.chars, at: entry.at, by: entry.by };
}

const isCount = (value: unknown): value is number => typeof value === "number" && Number.isSafeInteger(value) && value >= 0;

function authorFrom(raw: unknown): FileAuthor | null {
  if (!isRecord(raw)) return null;
  if (raw.who === "user") return { who: "user" };
  return (raw.who === "agent" || raw.who === "job") && typeof raw.id === "string" && typeof raw.role === "string" ? { who: raw.who, id: raw.id, role: raw.role } : null;
}

function versionFrom(raw: unknown): FileVersion | null {
  if (!isRecord(raw) || !isHash(raw.hash) || !isCount(raw.chars) || typeof raw.at !== "number") return null;
  const by = authorFrom(raw.by);
  return by ? { hash: raw.hash, chars: raw.chars, at: raw.at, by } : null;
}

function entryFrom(raw: unknown): FileEntry | null {
  const now = versionFrom(raw);
  if (!now || !isRecord(raw)) return null;
  return { ...now, was: Array.isArray(raw.was) ? raw.was.flatMap((version) => versionFrom(version) ?? []) : [], pins: Array.isArray(raw.pins) ? raw.pins.filter((role): role is string => typeof role === "string") : [] };
}

/** A stored index, read; null when the blob isn't one. A file that doesn't read as one is left out, and so is an earlier version that doesn't. */
function indexFrom(raw: unknown): AreaIndex | null {
  if (!isRecord(raw) || raw.v !== 1 || raw.kind !== "index" || !isRecord(raw.files)) return null;
  const files = Object.entries(raw.files).flatMap(([path, value]): Filed[] => {
    const entry = entryFrom(value);
    return entry ? [[path, entry]] : [];
  });
  return { v: 1, kind: "index", files: filesOf(files) };
}

/** What the store and the settings give the workspace. `limits` is read at each change, so a setting that changed holds from the next one. */
export interface WorkspaceDeps {
  host: Pick<HarnessHost, "store" | "clock" | "log">;
  blobs: Blobs;
  limits(): Settings["workspace"];
}

/** What the blob that should hold an index holds: the index, or why it can't be read as one, in words for the log. */
async function storedIndex(blobs: Blobs, hash: string): Promise<AreaIndex | { lost: string }> {
  const text = await blobs.get(hash);
  if (text === null) return { lost: `the workspace index ${hash} is gone from the store` };
  return indexFrom(parseJson(text)) ?? { lost: `the stored blob ${hash} isn't a workspace index` };
}

/** What the log says of an area whose index can't be read. */
const READS_EMPTY = "so the area reads as holding no files";

// ---------------------------------------------------------------- a head in the store

/**
 * The head kept in the store's document at `path` (an `AreaDoc`). While there is no document the
 * head is what `seed` gives (null without one): where an area that hasn't changed yet starts from.
 * The first change writes the document, and from then on the seed isn't asked.
 */
export function storeHead(host: Pick<HarnessHost, "store" | "clock">, path: string, seed?: () => Promise<string | null>): AreaHead {
  return {
    async read(): Promise<string | null> {
      const doc = await host.store.read(path);
      if (isRecord(doc) && doc.v === 1 && doc.kind === "area" && (doc.head === null || isHash(doc.head))) return doc.head;
      return seed ? seed() : null;
    },
    async write(hash: string): Promise<void> {
      const doc: AreaDoc = { v: 1, kind: "area", head: hash, at: host.clock.now() };
      await host.store.write(path, doc as unknown as JsonObject);
    },
  };
}

// ---------------------------------------------------------------- an area, kept in the store

/** What a change makes of an index: the files after it, what it did to which of them, and the file it left. */
interface Made {
  files: Record<string, FileEntry>;
  changes: FileChange[];
  entry: FileEntry | null;
}

const refused = (why: AreaRefusal): AreaResult => ({ ok: false, why });

/** An index's files with each path of `set` holding its entry, or nothing where that is null. */
function filesWith(index: AreaIndex, set: readonly (readonly [path: string, entry: FileEntry | null])[]): Record<string, FileEntry> {
  const files = new Map(Object.entries(index.files));
  for (const [path, entry] of set) {
    if (entry) files.set(path, entry);
    else files.delete(path);
  }
  return filesOf(files);
}

/**
 * An area whose index and file bodies are blobs and whose head someone holds (`AreaHead`). Its
 * changes run one at a time, each on the index as the head has it then, so of two writers of one
 * version of a file the second is refused: it reads again, and nobody's change is lost.
 *
 * An index is never changed once made: a change makes the next one, so whoever holds an index it was
 * given holds the area as it stood then.
 */
export class Area implements AreaAccess {
  /** The index read or made last, by its hash: a head that hasn't moved isn't read again. */
  private kept: { hash: string; index: AreaIndex } | null = null;
  /** The head whose index couldn't be read, so the log says it once and not at every read of the area. */
  private lost: string | null = null;
  /** The change under way, or the last one made: the next starts once it has ended. */
  private last: Promise<unknown> = Promise.resolve();

  constructor(
    private readonly deps: WorkspaceDeps,
    readonly kind: WorkspaceArea,
    private readonly head: AreaHead,
  ) {}

  /** The hash of the index as it stands: what a turn's record keeps of the area. Null while the area has never held a file. */
  headHash(): Promise<string | null> {
    return this.head.read();
  }

  async index(): Promise<AreaIndex> {
    const hash = await this.head.read();
    if (hash === null) return emptyIndex();
    if (this.kept?.hash === hash) return this.kept.index;
    const read = await storedIndex(this.deps.blobs, hash);
    if ("lost" in read) {
      if (this.lost !== hash) this.deps.host.log("warn", `${read.lost}, ${READS_EMPTY}`);
      this.lost = hash;
      return emptyIndex();
    }
    this.kept = { hash, index: read };
    return read;
  }

  text(hash: string): Promise<string | null> {
    return this.deps.blobs.get(hash);
  }

  /**
   * Runs `step` once every change asked before it has ended, on the index as the head has it then
   * (another holder of the same head may have moved it on). What the step makes is stored as the
   * next index, and the head moves on to it; a refusal, or a change that changes nothing, leaves
   * the head where it is.
   */
  private change(step: (index: AreaIndex) => AreaResult | Made | Promise<AreaResult | Made>): Promise<AreaResult> {
    const done = this.last.then(async (): Promise<AreaResult> => {
      const made = await step(await this.index());
      if ("ok" in made) return made;
      const index: AreaIndex = { v: 1, kind: "index", files: made.files };
      const hash = await this.deps.blobs.putJson(index as unknown as JsonObject);
      await this.head.write(hash);
      this.kept = { hash, index };
      return { ok: true, changes: made.changes, entry: made.entry };
    });
    // A change the store failed fails for whoever asked it alone: the next one runs on what the head holds.
    this.last = done.catch(() => undefined);
    return done;
  }

  write(input: WriteInput): Promise<AreaResult> {
    return this.change(async (index) => {
      const limits = this.deps.limits();
      const entry = fileAt(index, input.path);
      if (input.force !== true) {
        if (entry && input.base === null) return refused({ code: "exists", path: input.path, version: entry.hash });
        if (!entry && input.base !== null) return refused({ code: "missing", path: input.path });
        if (entry && input.base !== null && !sameVersion(input.base, entry.hash)) return refused({ code: "stale", path: input.path, version: entry.hash });
      }
      const chars = input.text.length;
      // The text the file already holds makes no version; its hash is worked out only where the lengths agree. It is stored again all the same, the same bytes, so a body the store lost comes back.
      if (entry && entry.chars === chars && (await textHash(input.text)) === entry.hash) {
        await this.deps.blobs.put(input.text);
        return { ok: true, changes: [], entry };
      }
      if (chars > limits.fileChars) return refused({ code: "file_chars", chars, limit: limits.fileChars });
      const held = Object.values(index.files);
      if (!entry && held.length >= limits.files) return refused({ code: "files", limit: limits.files });
      const before = held.reduce((sum, file) => sum + file.chars, 0);
      const after = before - (entry?.chars ?? 0) + chars;
      // A change that leaves the area no bigger is never refused for its size: an area over a limit that was lowered can still be brought down.
      if (after > limits.areaChars && after > before) return refused({ code: "area_chars", chars: after, limit: limits.areaChars });
      const hash = await this.deps.blobs.put(input.text);
      const made: FileEntry = { hash, chars, at: this.deps.host.clock.now(), by: input.by, was: entry ? [versionNow(entry), ...entry.was].slice(0, limits.versions) : [], pins: entry?.pins ?? [] };
      return { files: filesWith(index, [[input.path, made]]), changes: [{ area: this.kind, path: input.path, before: entry?.hash ?? null, after: hash }], entry: made };
    });
  }

  /** Moves a file whole: its version, its history and its pins. A move writes no version, so who moved it isn't kept: an index holds who wrote each version. */
  move(input: MoveInput): Promise<AreaResult> {
    return this.change((index) => {
      const entry = fileAt(index, input.from);
      // `force` skips the check of the version, never that there is a file to move and room for it where it goes.
      if (!entry) return refused({ code: "missing", path: input.from });
      if (input.force !== true && !sameVersion(input.base, entry.hash)) return refused({ code: "stale", path: input.from, version: entry.hash });
      const taken = fileAt(index, input.to);
      if (taken) return refused({ code: "exists", path: input.to, version: taken.hash });
      return {
        files: filesWith(index, [[input.from, null], [input.to, entry]]),
        changes: [{ area: this.kind, path: input.from, before: entry.hash, after: null }, { area: this.kind, path: input.to, before: null, after: entry.hash }],
        entry,
      };
    });
  }

  /** Takes a file out of the index, its history with it. Who removed it isn't kept either: an index holds the files that are there. */
  remove(input: RemoveInput): Promise<AreaResult> {
    return this.change((index) => {
      const entry = fileAt(index, input.path);
      if (!entry) return refused({ code: "missing", path: input.path });
      if (input.force !== true && !sameVersion(input.base, entry.hash)) return refused({ code: "stale", path: input.path, version: entry.hash });
      return { files: filesWith(index, [[input.path, null]]), changes: [{ area: this.kind, path: input.path, before: entry.hash, after: null }], entry: null };
    });
  }

  pin(input: PinInput): Promise<AreaResult> {
    return this.change((index) => {
      const entry = fileAt(index, input.path);
      if (!entry) return refused({ code: "missing", path: input.path });
      if (entry.pins.includes(input.role) === input.pinned) return { ok: true, changes: [], entry };
      const pinned: FileEntry = { ...entry, pins: input.pinned ? [...entry.pins, input.role].sort() : entry.pins.filter((role) => role !== input.role) };
      return { files: filesWith(index, [[input.path, pinned]]), changes: [], entry: pinned };
    });
  }
}

/**
 * The workspace's areas as one process holds them: each area whose head is a document in the store,
 * once, so that everything that works on an area shares its lock and its view of it.
 */
export class Workspace {
  /**
   * The areas handed out and still held by someone, by their head's path. Held weakly: the chat's
   * area has a head for every turn, so a process that kept each one for good would grow with every
   * reply. An area nobody holds has no change under way and nothing to share, so the next one made
   * for its path is as good.
   */
  private readonly areas = new Map<string, WeakRef<Area>>();
  /** Lets go of an area's place in the map once nobody holds the area any more, unless another was made for its path since. */
  private readonly released = new FinalizationRegistry<string>((path) => {
    if (this.areas.get(path)?.deref() === undefined) this.areas.delete(path);
  });

  constructor(private readonly deps: WorkspaceDeps) {}

  /**
   * The area whose head is the store's document at `path`: one object for one path, the same for
   * everyone who asks while anyone holds it. `seed`: where it starts from while it has no document
   * (`storeHead`); an area already held keeps the seed it was first asked with.
   */
  area(kind: WorkspaceArea, path: string, seed?: () => Promise<string | null>): Area {
    const held = this.areas.get(path)?.deref();
    if (held) return held;
    const made = new Area(this.deps, kind, storeHead(this.deps.host, path, seed));
    this.areas.set(path, new WeakRef(made));
    this.released.register(made, path);
    return made;
  }

  /**
   * Lets go of every area whose head is a document under `prefix` (a chat's own, as the chat is
   * forgotten): nothing of them is answered from memory any more, and the next one asked for is made
   * from what the store holds then.
   */
  forget(prefix: string): void {
    for (const path of [...this.areas.keys()]) if (path.startsWith(prefix)) this.areas.delete(path);
  }

  /** An index by its blob's hash: an area as a turn's record keeps it. Empty for null, and for a blob that is gone or isn't an index. */
  async index(hash: string | null): Promise<AreaIndex> {
    if (hash === null) return emptyIndex();
    const read = await storedIndex(this.deps.blobs, hash);
    if (!("lost" in read)) return read;
    this.deps.host.log("warn", `${read.lost}, ${READS_EMPTY}`);
    return emptyIndex();
  }
}

// ---------------------------------------------------------------- what goes into an agent's context

/** A file by its path as an agent writes it, with its text; null when there is no such file, the path can't be read, the view doesn't have its area, or the store no longer has its text. */
export async function readFile(view: WorkspaceView, raw: string, pathChars: number): Promise<{ area: WorkspaceArea; path: string; entry: FileEntry; text: string } | null> {
  const at = resolvePath(raw, pathChars);
  if ("refused" in at) return null;
  const area = view.areas[at.area];
  const entry = area ? fileAt(await area.index(), at.path) : undefined;
  if (!area || !entry) return null;
  const text = await area.text(entry.hash);
  return text === null ? null : { area: at.area, path: at.path, entry, text };
}

/** Every file pinned for the view's agent definition: the chat's area first, then `learned`, then the user's, each by path. */
export async function pinnedFiles(view: WorkspaceView): Promise<{ area: WorkspaceArea; path: string; entry: FileEntry }[]> {
  const pinned: { area: WorkspaceArea; path: string; entry: FileEntry }[] = [];
  for (const area of WORKSPACE_AREAS) {
    const held = view.areas[area];
    if (!held) continue;
    for (const [path, entry] of filesIn(await held.index())) if (entry.pins.includes(view.role)) pinned.push({ area, path, entry });
  }
  return pinned;
}

// ---------------------------------------------------------------- a change set

/**
 * What changed between two indexes of one area, in path order: each file added, changed (its body's
 * hash is another) or gone. `by` is who wrote the version after; for a file that is gone, who wrote
 * the version that went. A file moved is one gone and one there.
 */
export function changesBetween(area: WorkspaceArea, before: AreaIndex, after: AreaIndex): (FileChange & { by: FileAuthor })[] {
  const paths = [...new Set([...Object.keys(before.files), ...Object.keys(after.files)])].sort();
  return paths.flatMap((path) => {
    const was = fileAt(before, path);
    const now = fileAt(after, path);
    const by = (now ?? was)?.by;
    return by === undefined || was?.hash === now?.hash ? [] : [{ area, path, before: was?.hash ?? null, after: now?.hash ?? null, by }];
  });
}

// ---------------------------------------------------------------- changes made for a tool call from outside it

/**
 * The files changed for a tool call by what isn't the call's own code: a mounting extension's tool
 * keeps a file through the harness (`workspace.writeAs`) while its call runs. They wait here, by
 * the run and the call, until the call's result takes them for the trace, as a built-in tool's
 * result names the files it changed. Held weakly by the run (its `RunInfo`, the one object the
 * harness and a tool's environment both hold), so what no result takes goes with its run.
 */
const FILED = new WeakMap<object, Map<string, FileChange[]>>();

/** Notes the files changed for call `callId` of `run`. */
export function fileChanges(run: object, callId: string, changes: readonly FileChange[]): void {
  if (changes.length === 0) return;
  let calls = FILED.get(run);
  if (!calls) FILED.set(run, (calls = new Map()));
  calls.set(callId, [...(calls.get(callId) ?? []), ...changes]);
}

/** The files changed for call `callId` of `run` since they were last taken, in the order they were changed: taken once, by the call's result. */
export function takeChanges(run: object, callId: string): FileChange[] {
  const calls = FILED.get(run);
  const changes = calls?.get(callId) ?? [];
  calls?.delete(callId);
  return changes;
}

// ---------------------------------------------------------------- the page's side

/** A file as the page lists it: its path within its area, its version now, and the agent definitions it is pinned for. */
export interface FileRow {
  path: string;
  hash: string;
  chars: number;
  at: number;
  by: FileAuthor;
  pins: string[];
}

/** What a write left: the file as it stands, and what the write did to which files, for whoever traces it (none where the file already held the text). */
export interface WrittenFile {
  file: FileRow;
  changes: FileChange[];
}

/**
 * The workspace as the user's page reads and edits it (DESIGN §11), for one view of it. Each method
 * is one request: it takes one plain object and resolves plain JSON, or rejects with a
 * `HarnessRefusal` whose message the user reads. A path is within the request's area
 * (`notes/plan.md`), and a write is recorded as the view's author.
 */
export interface PageWorkspace {
  /** An area as it stands: its files by path, their characters together, and the limits Settings put on it. */
  list(input: { area: WorkspaceArea }): Promise<{ area: WorkspaceArea; files: FileRow[]; chars: number; limits: { fileChars: number; files: number; areaChars: number; pinChars: number } }>;
  /**
   * A file's text: as it stands, or as one of its versions held it (`version`: that version's hash
   * or a start of it, as `history` lists them). `file` is the file as it stands either way, so a page
   * that restores an earlier version writes that text based on `file.hash`; comparing two versions is
   * two reads.
   */
  read(input: { area: WorkspaceArea; path: string; version?: string }): Promise<{ file: FileRow; text: string; version: FileVersion }>;
  /** `base`: the version the text was based on (a body's hash, or a start of it); null for a new file. */
  write(input: { area: WorkspaceArea; path: string; text: string; base: string | null }): Promise<WrittenFile>;
  move(input: { area: WorkspaceArea; from: string; to: string; base: string }): Promise<{ file: FileRow }>;
  delete(input: { area: WorkspaceArea; path: string; base: string }): Promise<{ deleted: true }>;
  /** Sets or lifts a file's pin for an agent definition (`role`; the main agent's without one). */
  pin(input: { area: WorkspaceArea; path: string; on: boolean; role?: string }): Promise<{ file: FileRow }>;
  /** A file's versions, the current one first. */
  history(input: { area: WorkspaceArea; path: string }): Promise<{ versions: FileVersion[] }>;
}

/** A value of a request that a limit refuses, named so the page can show the message beside it. */
function invalid(field: string, message: string): HarnessRefusal {
  return new HarnessRefusal("invalid", message, [{ path: [field], message }]);
}

/**
 * What the page is told when the workspace refuses it, in words for the user. Each message is built
 * here and nowhere else; a limit is named as the Settings page titles it.
 */
const REFUSED = {
  field: (field: string, what: string) => new HarnessRefusal("bad_request", `A workspace request's ${field} must be ${what}.`),
  noArea: () => new HarnessRefusal("not_found", "That area isn't there: the chat's own files and learned/ need a chat."),
  badPath: () => new HarnessRefusal("bad_request", "A path can't hold a backslash or a control character."),
  outside: () => new HarnessRefusal("bad_request", "A path can't leave its area: “..” may climb within it, never out of it."),
  otherArea: () => new HarnessRefusal("bad_request", "In the chat's own area a path can't start with learned: learned/ is an area of its own."),
  noName: () => new HarnessRefusal("bad_request", "A file's path needs a name."),
  longPath: (field: string, limit: number) => invalid(field, `A path may hold ${limit} characters at most (Path length).`),
  missing: (file: string) => new HarnessRefusal("not_found", `There is no file ${file}: it may have been moved or deleted since the page read it.`),
  noVersion: (file: string, kept: number) => new HarnessRefusal("not_found", `${file} has no such version among the ${kept} it keeps (Versions kept): it may have been dropped since the page listed them.`),
  gone: (file: string) => new HarnessRefusal("not_found", `The store no longer has the text of ${file}.`),
  exists: (file: string, hash: string) => new HarnessRefusal("conflict", `There is already a file ${file}, at version ${versionOf(hash)}.`),
  stale: (file: string, hash: string) => new HarnessRefusal("conflict", `${file} has changed since it was read: it is at version ${versionOf(hash)} now. Read it again, then make the change on that.`),
  fileChars: (chars: number, limit: number) => invalid("text", `The text is ${chars} characters, and a file may hold ${limit} at most (File length).`),
  files: (limit: number) => invalid("path", `The area already holds as many files as it may: ${limit} (Files per area).`),
  areaChars: (chars: number, limit: number) => invalid("text", `With this the area's files would hold ${chars} characters together, and an area may hold ${limit} at most (Area size).`),
  forbidden: (reason: string) => new HarnessRefusal("forbidden", reason),
} as const;

/** An area's refusal, as the page is told it. */
function areaRefusal(area: WorkspaceArea, why: AreaRefusal): HarnessRefusal {
  switch (why.code) {
    case "missing":
      return REFUSED.missing(showPath(area, why.path));
    case "exists":
      return REFUSED.exists(showPath(area, why.path), why.version);
    case "stale":
      return REFUSED.stale(showPath(area, why.path), why.version);
    case "file_chars":
      return REFUSED.fileChars(why.chars, why.limit);
    case "files":
      return REFUSED.files(why.limit);
    case "area_chars":
      return REFUSED.areaChars(why.chars, why.limit);
    case "refused":
      return REFUSED.forbidden(why.reason);
  }
}

function rowOf(path: string, entry: FileEntry): FileRow {
  return { path, hash: entry.hash, chars: entry.chars, at: entry.at, by: entry.by, pins: [...entry.pins] };
}

/** What a request's `base` must be, for the page's refusal. */
const A_VERSION = "the version the change was based on";

/** The page's side of one view of the workspace. `limits` is read at each request. */
export function pageWorkspace(view: WorkspaceView, limits: () => Settings["workspace"]): PageWorkspace {
  /** A request comes from a page, so nothing in it is taken on trust: every value is checked before it is used. */
  type Asked = Readonly<Record<string, unknown>>;
  /** The area a request names, as the view holds it. */
  const areaOf = (input: Asked): { kind: WorkspaceArea; area: AreaAccess } => {
    const kind = WORKSPACE_AREAS.find((one) => one === input.area);
    if (kind === undefined) throw REFUSED.field("area", "chat, learned or user");
    const area = view.areas[kind];
    if (!area) throw REFUSED.noArea();
    return { kind, area };
  };
  /** The file a request names in `field`: its area, its path there, and the path as the user reads it. */
  const fileOf = (input: Asked, field: "path" | "from" | "to"): { kind: WorkspaceArea; area: AreaAccess; path: string; shown: string } => {
    const { kind, area } = areaOf(input);
    const raw = input[field];
    if (typeof raw !== "string") throw REFUSED.field(field, "a path within its area");
    const { pathChars } = limits();
    // Read from its area's root, as an agent would write it: one set of rules says what a path may be.
    const at = resolvePath(`${ROOT[kind]}${raw}`, pathChars);
    if ("refused" in at) throw at.refused === "long" ? REFUSED.longPath(field, pathChars) : at.refused === "bad" ? REFUSED.badPath() : REFUSED.outside();
    if (at.area !== kind) throw REFUSED.otherArea();
    if (at.path === "") throw REFUSED.noName();
    return { kind, area, path: at.path, shown: showPath(kind, at.path) };
  };
  /** Refuses a write of a path the view's holder may not write, in the holder's words. */
  const allowed = (kind: WorkspaceArea, ...paths: string[]): void => {
    for (const path of paths) {
      const reason = view.guard(kind, path);
      if (reason !== null) throw REFUSED.forbidden(reason);
    }
  };
  /** The file a change left, as the page lists it; its refusal, thrown, when the area refused it. */
  const left = (at: { kind: WorkspaceArea; shown: string }, path: string, result: AreaResult): FileRow => {
    if (!result.ok) throw areaRefusal(at.kind, result.why);
    if (!result.entry) throw REFUSED.missing(at.shown);
    return rowOf(path, result.entry);
  };
  /** The file a request names, as its area's index holds it now. */
  const entryOf = async (at: { area: AreaAccess; path: string; shown: string }): Promise<FileEntry> => {
    const entry = fileAt(await at.area.index(), at.path);
    if (!entry) throw REFUSED.missing(at.shown);
    return entry;
  };
  return {
    async list(input) {
      const { kind, area } = areaOf(input);
      const files = filesIn(await area.index()).map(([path, entry]) => rowOf(path, entry));
      const { fileChars, files: most, areaChars, pinChars } = limits();
      return { area: kind, files, chars: files.reduce((sum, file) => sum + file.chars, 0), limits: { fileChars, files: most, areaChars, pinChars } };
    },
    async read(input) {
      const at = fileOf(input, "path");
      const entry = await entryOf(at);
      if (input.version !== undefined && typeof input.version !== "string") throw REFUSED.field("version", "one of the file's versions, as its history lists them");
      const versions = [versionNow(entry), ...entry.was];
      const asked = input.version;
      const version = asked === undefined ? versions[0] : versions.find((one) => sameVersion(asked, one.hash));
      if (!version) throw REFUSED.noVersion(at.shown, versions.length);
      const text = await at.area.text(version.hash);
      if (text === null) throw REFUSED.gone(at.shown);
      return { file: rowOf(at.path, entry), text, version };
    },
    async write(input) {
      const at = fileOf(input, "path");
      if (typeof input.text !== "string") throw REFUSED.field("text", "the file's text");
      if (input.base !== null && typeof input.base !== "string") throw REFUSED.field("base", `${A_VERSION}, or null for a new file`);
      allowed(at.kind, at.path);
      const result = await at.area.write({ path: at.path, text: input.text, base: input.base, by: view.author });
      return { file: left(at, at.path, result), changes: result.ok ? result.changes : [] };
    },
    async move(input) {
      const from = fileOf(input, "from");
      const to = fileOf(input, "to");
      if (typeof input.base !== "string") throw REFUSED.field("base", A_VERSION);
      allowed(from.kind, from.path, to.path);
      return { file: left(to, to.path, await from.area.move({ from: from.path, to: to.path, base: input.base, by: view.author })) };
    },
    async delete(input) {
      const at = fileOf(input, "path");
      if (typeof input.base !== "string") throw REFUSED.field("base", A_VERSION);
      allowed(at.kind, at.path);
      const result = await at.area.remove({ path: at.path, base: input.base, by: view.author });
      if (!result.ok) throw areaRefusal(at.kind, result.why);
      return { deleted: true };
    },
    async pin(input) {
      const at = fileOf(input, "path");
      if (typeof input.on !== "boolean") throw REFUSED.field("on", "true to pin the file, false to lift its pin");
      if (input.role !== undefined && typeof input.role !== "string") throw REFUSED.field("role", "an agent definition's id");
      return { file: left(at, at.path, await at.area.pin({ path: at.path, role: input.role ?? AGENT.main, pinned: input.on })) };
    },
    async history(input) {
      const entry = await entryOf(fileOf(input, "path"));
      return { versions: [versionNow(entry), ...entry.was] };
    },
  };
}
