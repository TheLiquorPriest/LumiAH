// What the Workspace and Guidance pages decide before they draw anything (DESIGN §11, §12): the
// three areas in words, a file's name as agents write it, the tree an area's flat paths make, a
// path checked before it is sent, who wrote a version, how much of a bound is used, which files are
// pinned for which agent, the line diff two texts make, the rows of a turn's change set and of a
// file's history, and how text typed and not yet saved stands against the file it was typed over.
// No DOM and no requests: the pages render what these give.

import type { ChangedFile, FileAuthor, FileVersion, GuidanceLevel, GuidanceLevelId, WorkspaceArea, WorkspaceFile, WorkspaceView } from "../../shared/ui";
import type { FileTarget, Nav } from "./app";
import { ago, count, counted } from "./format";
import { filePath, roleLabel } from "./live-model";

// ---------------------------------------------------------------- the areas

/** The areas in the order the page offers them: the chat's own, what is kept with the chat, the user's. */
export const AREAS: readonly WorkspaceArea[] = ["chat", "learned", "user"];

/** An area in words: the sign agents and the page write it by, whose it is, what happens to its files when the user swipes or edits (the one thing that tells the chat's two areas apart, said under each name), and what is kept there. */
export interface AreaWords {
  sign: string;
  name: string;
  does: string;
  about: string;
}

export const AREA_WORDS: Readonly<Record<WorkspaceArea, AreaWords>> = {
  chat: { sign: "/", name: "This chat's", does: "Go back when you swipe or edit.", about: "Notes the agents keep as the story goes. Swipe a reply or edit an earlier message, and these files go back to how they stood at that point." },
  learned: { sign: "learned/", name: "Kept with the chat", does: "Stay when you swipe or edit.", about: "What is kept about this chat for good: the chronicle, this chat's guidance, what an agent learned. Swiping and editing change none of it, and a branch of the chat gets a copy." },
  user: { sign: "~/", name: "Yours", does: "The same in all your chats.", about: "Your own files, shared by all your chats: your guidance, and whatever every agent should find." },
};

/** A file's name as agents write it and as the page says it: `notes/ledger.md` in the chat's area, `learned/people/okoro.md`, `~/GUIDANCE.md`. */
export function fullPath(area: WorkspaceArea, path: string): string {
  return filePath({ area, path });
}

/** A reply as the pages name it: "reply #43", with its swipe where it isn't the first. */
export function replyWords(turn: { index: number; swipe: number }): string {
  return turn.swipe > 0 ? `reply #${turn.index}, swipe ${turn.swipe + 1}` : `reply #${turn.index}`;
}

/** Which reply the chat's area stands on, as a sentence. */
export function basisWords(basis: WorkspaceView["basis"]): string {
  return basis === null ? "No reply has written here yet, so these files stand on no reply." : `They show as they stood after ${replyWords(basis)}, the latest reply LumiAH worked on that is still part of the chat.`;
}

// ---------------------------------------------------------------- who and when

/** Who wrote a version, in a few words: "you", an agent by its role ("Main agent", "Archivist (agent)"), a job by its role ("Archivist (job)"). */
export function authorWords(by: FileAuthor): string {
  if (by.who === "user") return "you";
  const role = roleLabel(by.role);
  if (by.who === "job") return `${role} (job)`;
  // "Main agent" already says what it is.
  return /agent$/i.test(role) ? role : `${role} (agent)`;
}

/** A file's facts on one line: its length, when it was last written, and by whom. */
export function fileFacts(file: { chars: number; at: number; by: FileAuthor }, now: number): string {
  return `${counted(file.chars, "character")} · ${ago(now, file.at)} · by ${authorWords(file.by)}`;
}

/** A refusal in the backend's own words: what it said, then what it said of each value it refused, where that adds anything. */
export function refusalWords(message: string, problems: readonly { message: string }[]): string {
  return [message, ...problems.map((p) => p.message).filter((m) => !message.includes(m))].join(" ");
}

// ---------------------------------------------------------------- bounds

/** How much of a bound is used: the figures, whether it is passed and by how much, the share used (0 to 1, for a bar), and the words. */
export interface Bound {
  used: number;
  limit: number;
  over: number;
  share: number;
  words: string;
}

export function boundOf(used: number, limit: number, one: string, many = `${one}s`): Bound {
  const over = Math.max(0, used - limit);
  const share = limit > 0 ? Math.min(1, used / limit) : used > 0 ? 1 : 0;
  return { used, limit, over, share, words: `${count(used)} of ${count(limit)} ${limit === 1 ? one : many}${over > 0 ? `, ${count(over)} over` : ""}` };
}

/** An area's two bounds: how many files it holds, and their characters together. */
export function areaBounds(view: WorkspaceView): { files: Bound; chars: Bound } {
  return { files: boundOf(view.files.length, view.limits.files, "file"), chars: boundOf(view.chars, view.limits.areaChars, "character") };
}

/** An area as the page holds it: one of a chat while no chat is shown, being read, read, or refused. */
export type AreaRead = { status: "no-chat" } | { status: "reading" } | { status: "ready"; view: WorkspaceView } | { status: "failed"; message: string };

/** What an area's row in the chooser says under its name: once read, what swiping and editing do to its files; else why its files don't show. */
export function areaRowWords(area: WorkspaceArea, read: AreaRead): string {
  if (read.status === "ready") return AREA_WORDS[area].does;
  if (read.status === "reading") return "Reading…";
  if (read.status === "failed") return `Couldn't be read: ${read.message}`;
  return "Belongs to a chat: open one in Lumiverse, or pick one above.";
}

/** How full an area is on one line, said where the area chosen is told about. */
export function areaSummary(view: WorkspaceView): string {
  const b = areaBounds(view);
  return `${b.files.words} · ${b.chars.words}`;
}

/**
 * Why a text can't be written as a file of an area, from the bounds the area's view carries; null
 * when the bounds allow it. `replacing` is the file the text takes the place of (null: a new file).
 * The backend checks the same and has the last word; this says it before the request is sent.
 */
export function writeProblem(view: WorkspaceView, text: string, replacing: WorkspaceFile | null): string | null {
  const { limits } = view;
  if (text.length > limits.fileChars) return `It is ${counted(text.length - limits.fileChars, "character")} over what one file may hold (${count(limits.fileChars)}): shorten it, or split it into two files.`;
  if (replacing === null && view.files.length >= limits.files) return `This area holds all the files Settings allow it (${count(limits.files)}): delete one first, or raise the limit in Settings.`;
  const after = view.chars - (replacing?.chars ?? 0) + text.length;
  if (after > limits.areaChars) return `With this the area would hold ${count(after)} characters, and Settings allow it ${count(limits.areaChars)}: shorten it, or delete a file first.`;
  return null;
}

// ---------------------------------------------------------------- paths

/**
 * The longest path a request may carry: the contract's own bound (`isFilePath` in shared/ui.ts),
 * which answers a longer one as malformed before the workspace can say why. No setting: it is the
 * contract's, the same in every build. The bound Settings put on a path is shorter and is the
 * backend's to say, since an area's view doesn't carry it.
 */
const PATH_MAX_CHARS = 1024;

/** A path as typed, made ready to check: the space around it gone, a backslash read as a slash, a leading `./` dropped. */
export function normalizePath(raw: string): string {
  let path = raw.trim().replace(/\\/g, "/");
  while (path.startsWith("./")) path = path.slice(2);
  return path;
}

/**
 * Why a path can't name a new file of an area (or the place a file moves to), in words that say what
 * to change; null when it can. `files` are the area's; `self` is the path of the file being moved,
 * which may not stay where it is. The backend checks again and has the last word.
 */
export function pathProblem(area: WorkspaceArea, raw: string, files: readonly { path: string }[], self: string | null = null): string | null {
  const path = normalizePath(raw);
  if (path === "") return "Give the file a path, such as notes/plan.md.";
  if (path.startsWith("/")) return "A path starts inside the area: leave out the slash at its start.";
  if (path.endsWith("/")) return "That names a folder: put the file's name after the last slash.";
  if (/[\u0000-\u001f\u007f]/.test(path)) return "A path can't hold a line break, a tab or another control character.";
  const parts = path.split("/");
  if (parts.some((part) => part === "")) return "Two slashes in a row leave a folder without a name: take one out.";
  if (parts.some((part) => part.trim() !== part)) return "A folder's or a file's name can't start or end with a space.";
  if (parts.includes("..")) return "A path can't climb out of a folder: take the “..” out.";
  if (parts.includes(".")) return "A single dot names no folder: take the “.” out.";
  if (parts.includes("~")) return "“~” names your own area, not a folder: pick the area Yours to put the file there.";
  if (area === "chat" && parts[0] === "learned") return "A path that starts with learned/ names the area kept with the chat: pick that area to put the file there.";
  if (path.length > PATH_MAX_CHARS) return `A path holds ${count(PATH_MAX_CHARS)} characters at most; this one has ${count(path.length)}.`;
  if (self !== null && path === self) return "That is where the file is now.";
  if (files.some((f) => f.path === path)) return `There is a file at ${fullPath(area, path)} already: pick another path.`;
  if (files.some((f) => f.path.startsWith(`${path}/`))) return `${fullPath(area, path)} is a folder here, and a file can't take a folder's name.`;
  const blocking = files.find((f) => f.path !== self && path.startsWith(`${f.path}/`));
  if (blocking) return `${fullPath(area, blocking.path)} is a file, so nothing can be kept under it.`;
  return null;
}

// ---------------------------------------------------------------- the tree

export interface FolderNode {
  kind: "folder";
  name: string;
  /** The folder's path within the area, with no slash at its end. */
  path: string;
  depth: number;
  /** The files under it at any depth (those the filter lets through), and their characters together. */
  files: number;
  chars: number;
  children: TreeNode[];
}

export interface FileNode {
  kind: "file";
  name: string;
  path: string;
  depth: number;
  file: WorkspaceFile;
}

export type TreeNode = FolderNode | FileNode;

const NAMES = new Intl.Collator("en", { numeric: true, sensitivity: "base" });

/** Names in the order a person lists them: letters whatever their case, `2` before `10`; two that differ only by case in a fixed order. */
function byName(a: string, b: string): number {
  return NAMES.compare(a, b) || (a < b ? -1 : a > b ? 1 : 0);
}

function sortNodes(nodes: TreeNode[]): void {
  nodes.sort((a, b) => (a.kind === b.kind ? byName(a.name, b.name) : a.kind === "folder" ? -1 : 1));
  for (const node of nodes) if (node.kind === "folder") sortNodes(node.children);
}

/** The words of a filter: each must be somewhere in a file's path, whatever its case. */
export function filterTerms(filter: string): string[] {
  return filter
    .toLowerCase()
    .split(/\s+/)
    .filter((term) => term !== "");
}

/**
 * An area's files as a tree by folder, from their flat paths: at each level the folders first, then
 * the files, each by name. A filter keeps the files whose path holds every one of its words, and
 * the folders that lead to them.
 */
export function treeOf(files: readonly WorkspaceFile[], filter = ""): TreeNode[] {
  const terms = filterTerms(filter);
  const top: TreeNode[] = [];
  const folders = new Map<string, FolderNode>();
  for (const file of files) {
    const lower = file.path.toLowerCase();
    if (!terms.every((term) => lower.includes(term))) continue;
    const parts = file.path.split("/");
    let siblings = top;
    for (let depth = 0; depth < parts.length - 1; depth += 1) {
      const path = parts.slice(0, depth + 1).join("/");
      let folder = folders.get(path);
      if (!folder) {
        folder = { kind: "folder", name: parts[depth] ?? "", path, depth, files: 0, chars: 0, children: [] };
        folders.set(path, folder);
        siblings.push(folder);
      }
      folder.files += 1;
      folder.chars += file.chars;
      siblings = folder.children;
    }
    siblings.push({ kind: "file", name: parts.at(-1) ?? file.path, path: file.path, depth: parts.length - 1, file });
  }
  sortNodes(top);
  return top;
}

export type TreeRow = { kind: "folder"; node: FolderNode; open: boolean } | { kind: "file"; node: FileNode };

/**
 * The tree as the rows the page lists, top to bottom: a folded folder's contents left out. While a
 * filter narrows the tree every folder shows open, since what it found would otherwise be hidden
 * inside one the user folded earlier.
 */
export function treeRows(tree: readonly TreeNode[], folded: ReadonlySet<string>, filtering: boolean): TreeRow[] {
  const rows: TreeRow[] = [];
  const walk = (nodes: readonly TreeNode[]): void => {
    for (const node of nodes) {
      if (node.kind === "file") {
        rows.push({ kind: "file", node });
        continue;
      }
      const open = filtering || !folded.has(node.path);
      rows.push({ kind: "folder", node, open });
      if (open) walk(node.children);
    }
  };
  walk(tree);
  return rows;
}

// ---------------------------------------------------------------- pins

/** The definition id of the main agent: the one a file is pinned for with one press. */
export const MAIN_AGENT = "main";

/** What is pinned for one agent definition, across the areas read: the files, their characters together against the bound, and whether the definition is one the areas still name. */
export interface PinGroup {
  agent: string;
  name: string;
  known: boolean;
  files: { area: WorkspaceArea; file: WorkspaceFile }[];
  bound: Bound;
}

/**
 * The pinned files by the agent they are pinned for: the main agent first, then the others in the
 * order the areas name them, then any a file is pinned for that no area names any more (a
 * definition removed since). Each agent's files are in the areas' order, then by path.
 */
export function pinGroups(views: readonly WorkspaceView[]): PinGroup[] {
  const names = new Map<string, string>();
  for (const view of views) for (const a of view.agents) if (!names.has(a.id)) names.set(a.id, a.name);
  const limit = views[0]?.limits.pinChars ?? 0;
  const pinned = new Map<string, { area: WorkspaceArea; file: WorkspaceFile }[]>();
  for (const area of AREAS) {
    for (const view of views) {
      if (view.area !== area) continue;
      for (const file of [...view.files].sort((a, b) => byName(a.path, b.path))) {
        for (const agent of file.pins) pinned.set(agent, [...(pinned.get(agent) ?? []), { area, file }]);
      }
    }
  }
  const order = [...new Set([MAIN_AGENT, ...names.keys(), ...pinned.keys()])];
  return order.flatMap((agent): PinGroup[] => {
    const files = pinned.get(agent);
    if (!files) return [];
    const known = names.has(agent);
    return [{ agent, name: names.get(agent) ?? agent, known, files, bound: boundOf(files.reduce((sum, f) => sum + f.file.chars, 0), limit, "character") }];
  });
}

/** How many of the areas' files are pinned for at least one agent. */
export function pinnedCount(views: readonly WorkspaceView[]): number {
  return views.reduce((sum, view) => sum + view.files.filter((f) => f.pins.length > 0).length, 0);
}

/** One file's pins as its pane offers them: whether it is pinned for the main agent, and every other definition with whether it is pinned for it (one it is pinned for that is no longer named shows by its id). */
export function pinChoices(file: WorkspaceFile, agents: readonly { id: string; name: string }[]): { main: boolean; others: { id: string; name: string; on: boolean }[] } {
  const others = agents.filter((a) => a.id !== MAIN_AGENT).map((a) => ({ id: a.id, name: a.name, on: file.pins.includes(a.id) }));
  for (const id of file.pins) if (id !== MAIN_AGENT && !others.some((o) => o.id === id)) others.push({ id, name: id, on: true });
  return { main: file.pins.includes(MAIN_AGENT), others };
}

/** The mark a file carries in the tree where some agent is always given it; null where none is. */
export function pinMark(file: WorkspaceFile): string | null {
  return file.pins.length === 0 ? null : file.pins.length === 1 ? "always given" : `always given ×${file.pins.length}`;
}

/** Names as a phrase: "A", "A and B", "A, B and C". */
function namesWords(names: readonly string[]): string {
  return names.length <= 1 ? (names[0] ?? "") : `${names.slice(0, -1).join(", ")} and ${names.at(-1) ?? ""}`;
}

/** Which agents are always given a file, and what that does, as a sentence. */
export function pinnedWords(file: WorkspaceFile, agents: readonly { id: string; name: string }[]): string {
  if (file.pins.length === 0) return "No agent is always given this file: one reads it only when it looks for it.";
  const names = file.pins.map((id) => agents.find((a) => a.id === id)?.name ?? id);
  return `Always given to ${namesWords(names)}: it is in ${names.length === 1 ? "its" : "their"} prompt at every reply.`;
}

// ---------------------------------------------------------------- the line diff

export type DiffKind = "same" | "added" | "removed";

/** A line of a diff: whether both texts have it or only one, and its number in each (from 1; null where that text hasn't it). */
export interface DiffLine {
  kind: DiffKind;
  text: string;
  before: number | null;
  after: number | null;
}

/** Two texts line against line. `coarse`: they were too long to match line by line, so everything between what they share at their start and end shows as removed, then added. */
export interface Diff {
  lines: DiffLine[];
  added: number;
  removed: number;
  coarse: boolean;
}

/**
 * The most cells the table that matches two texts' lines may have (the lines of one that differ,
 * times the lines of the other that do). The table is what finds the longest run of lines both
 * keep, and it is built in the page, at once: four million cells are 8 MB and a fraction of a
 * second on a phone, which two texts of two thousand changed lines each reach. Past that the tab
 * would stall or run out of memory, so the diff says it is coarse instead. No setting: it bounds
 * the browser's own work on this device, not anything LumiAH keeps or sends, and no value of it
 * would change what a user can do, only how soon the page gives up on being exact.
 */
const DIFF_CELLS_MAX = 4_000_000;

/** A text's lines; an empty text has none. A line break at the very end leaves an empty last line, which a diff then shows as a line of its own. */
export function linesOf(text: string): string[] {
  return text === "" ? [] : text.split("\n");
}

/**
 * The lines two texts share and the ones only one has, by the longest common subsequence of their
 * lines: the fewest lines removed and added that turn `before` into `after`. Where a line was
 * rewritten, the old one comes before the new one.
 */
export function diffLines(before: string, after: string): Diff {
  const a = linesOf(before);
  const b = linesOf(after);
  // What the two share at their start and at their end needs no matching, and most edits leave most of a file alone.
  let head = 0;
  while (head < a.length && head < b.length && a[head] === b[head]) head += 1;
  let tail = 0;
  while (tail < a.length - head && tail < b.length - head && a[a.length - 1 - tail] === b[b.length - 1 - tail]) tail += 1;
  const n = a.length - head - tail;
  const m = b.length - head - tail;
  const lines: DiffLine[] = [];
  const same = (i: number, j: number): void => void lines.push({ kind: "same", text: a[i] ?? "", before: i + 1, after: j + 1 });
  const removed = (i: number): void => void lines.push({ kind: "removed", text: a[i] ?? "", before: i + 1, after: null });
  const added = (j: number): void => void lines.push({ kind: "added", text: b[j] ?? "", before: null, after: j + 1 });
  for (let i = 0; i < head; i += 1) same(i, i);
  const coarse = n > 0 && m > 0 && (n + 1) * (m + 1) > DIFF_CELLS_MAX;
  if (n === 0 || m === 0 || coarse) {
    for (let i = 0; i < n; i += 1) removed(head + i);
    for (let j = 0; j < m; j += 1) added(head + j);
  } else {
    // Each line as a number, so a cell compares two numbers and not two strings.
    const ids = new Map<string, number>();
    const idOf = (line: string): number => {
      const known = ids.get(line);
      if (known !== undefined) return known;
      ids.set(line, ids.size);
      return ids.size - 1;
    };
    const x = Int32Array.from({ length: n }, (_, i) => idOf(a[head + i] ?? ""));
    const y = Int32Array.from({ length: m }, (_, j) => idOf(b[head + j] ?? ""));
    // lcs[i * w + j] is the longest run of lines the two share from line i of one and line j of the other on. The guard keeps the shorter text under two thousand lines, so a count fits 16 bits.
    const w = m + 1;
    const lcs = new Uint16Array((n + 1) * w);
    for (let i = n - 1; i >= 0; i -= 1) {
      for (let j = m - 1; j >= 0; j -= 1) {
        lcs[i * w + j] = x[i] === y[j] ? (lcs[(i + 1) * w + j + 1] ?? 0) + 1 : Math.max(lcs[(i + 1) * w + j] ?? 0, lcs[i * w + j + 1] ?? 0);
      }
    }
    let i = 0;
    let j = 0;
    while (i < n && j < m) {
      if (x[i] === y[j]) {
        same(head + i, head + j);
        i += 1;
        j += 1;
      } else if ((lcs[(i + 1) * w + j] ?? 0) >= (lcs[i * w + j + 1] ?? 0)) {
        removed(head + i);
        i += 1;
      } else {
        added(head + j);
        j += 1;
      }
    }
    for (; i < n; i += 1) removed(head + i);
    for (; j < m; j += 1) added(head + j);
  }
  for (let k = 0; k < tail; k += 1) same(a.length - tail + k, b.length - tail + k);
  return { lines, added: lines.filter((l) => l.kind === "added").length, removed: lines.filter((l) => l.kind === "removed").length, coarse };
}

/**
 * How many unchanged lines show on each side of a change before the rest of an unchanged run folds
 * away. Three is what a unified diff shows by convention, enough to see where a change sits. No
 * setting: the fold opens on a press, so it hides nothing a user can't reach.
 */
const DIFF_CONTEXT_LINES = 3;

/** A diff as the page lists it: a line, or a run of unchanged lines folded into one row (`id` tells folds of one diff apart). */
export type DiffRow = { kind: "line"; line: DiffLine } | { kind: "fold"; id: number; lines: DiffLine[] };

/**
 * A diff with its long unchanged runs folded: each keeps the lines next to a change and folds the
 * rest, unless that would hide a single line (a fold's row takes a line's room itself). A fold named
 * in `open` shows its lines.
 */
export function foldDiff(diff: Diff, open: ReadonlySet<number> = new Set()): DiffRow[] {
  const rows: DiffRow[] = [];
  const { lines } = diff;
  let at = 0;
  while (at < lines.length) {
    const line = lines[at];
    if (!line) break;
    if (line.kind !== "same") {
      rows.push({ kind: "line", line });
      at += 1;
      continue;
    }
    let end = at;
    while (end < lines.length && lines[end]?.kind === "same") end += 1;
    const run = lines.slice(at, end);
    // A run at the diff's very start follows no change, and one at its very end precedes none: there it keeps lines on one side only.
    const keepStart = at === 0 ? 0 : DIFF_CONTEXT_LINES;
    const keepEnd = end === lines.length ? 0 : DIFF_CONTEXT_LINES;
    const hidden = run.slice(keepStart, run.length - keepEnd);
    if (hidden.length <= 1 || open.has(at + keepStart)) {
      for (const l of run) rows.push({ kind: "line", line: l });
    } else {
      for (const l of run.slice(0, keepStart)) rows.push({ kind: "line", line: l });
      rows.push({ kind: "fold", id: at + keepStart, lines: hidden });
      for (const l of run.slice(run.length - keepEnd)) rows.push({ kind: "line", line: l });
    }
    at = end;
  }
  return rows;
}

/** The sign and the word a diff's line carries beside its colour (`same` carries neither), and how the lines of that kind are counted in a sentence. */
export interface DiffMarks {
  added: { sign: string; word: string; counted: string };
  removed: { sign: string; word: string; counted: string };
}

/** A version against a later one: what was added and what was removed. */
export const CHANGE_MARKS: DiffMarks = { added: { sign: "+", word: "added", counted: "added" }, removed: { sign: "−", word: "removed", counted: "removed" } };

/** Someone else's text against the user's own: whose each line is. */
export const CONFLICT_MARKS: DiffMarks = { added: { sign: "+", word: "yours", counted: "only in yours" }, removed: { sign: "−", word: "theirs", counted: "only in theirs" } };

/** What a diff found, in a sentence: how many lines only one text has, in the words its lines are marked by, or that the two texts are the same. */
export function diffWords(diff: Diff, marks: DiffMarks = CHANGE_MARKS): string {
  if (diff.added === 0 && diff.removed === 0) return "No difference: the two texts are the same.";
  const parts = [...(diff.added > 0 ? [`${counted(diff.added, "line")} ${marks.added.counted}`] : []), ...(diff.removed > 0 ? [`${counted(diff.removed, "line")} ${marks.removed.counted}`] : [])];
  return `${parts.join(", ")}.${diff.coarse ? " These texts are too long to match line by line here, so everything between what they share at their start and end shows as one block, then the other." : ""}`;
}

// ---------------------------------------------------------------- a turn's change set

export type ChangeKind = "added" | "changed" | "removed" | "moved";

/** One file of a change set as the page lists it: what happened to it, where it is now (`from`: where it was, for a move), its version before and after, and who did it. */
export interface ChangeRow {
  kind: ChangeKind;
  area: WorkspaceArea;
  path: string;
  from: string | null;
  before: string | null;
  after: string | null;
  by: FileAuthor;
}

/** The sign and the word each kind of change carries. */
export const CHANGE_WORDS: Readonly<Record<ChangeKind, { sign: string; word: string }>> = {
  added: { sign: "+", word: "added" },
  changed: { sign: "~", word: "changed" },
  removed: { sign: "−", word: "removed" },
  moved: { sign: "→", word: "moved" },
};

/**
 * A change set as rows, a move paired: a file gone and a file there, in one area, with the same
 * body, are one file that moved (each gone file pairs with one new file at most). The rows are in
 * the areas' order, then by path.
 */
export function changeRows(changes: readonly ChangedFile[]): ChangeRow[] {
  const gone = changes.filter((c) => c.after === null && c.before !== null);
  const taken = new Set<ChangedFile>();
  const rows: ChangeRow[] = [];
  for (const c of changes) {
    if (c.before === null && c.after !== null) {
      const was = gone.find((g) => !taken.has(g) && g.area === c.area && g.before === c.after);
      if (was) {
        taken.add(was);
        rows.push({ kind: "moved", area: c.area, path: c.path, from: was.path, before: was.before, after: c.after, by: c.by });
      } else rows.push({ kind: "added", area: c.area, path: c.path, from: null, before: null, after: c.after, by: c.by });
    }
  }
  for (const c of changes) {
    if (c.before === null && c.after !== null) continue;
    if (taken.has(c)) continue;
    rows.push({ kind: c.after === null ? "removed" : "changed", area: c.area, path: c.path, from: null, before: c.before, after: c.after, by: c.by });
  }
  return rows.sort((a, b) => AREAS.indexOf(a.area) - AREAS.indexOf(b.area) || byName(a.path, b.path));
}

/** A change set in a sentence: "3 files: 1 added, 1 changed, 1 moved." */
export function changesSummary(rows: readonly ChangeRow[]): string {
  if (rows.length === 0) return "This reply changed no file.";
  const kinds: ChangeKind[] = ["added", "changed", "moved", "removed"];
  const parts = kinds.flatMap((kind) => {
    const n = rows.filter((r) => r.kind === kind).length;
    return n > 0 ? [`${count(n)} ${CHANGE_WORDS[kind].word}`] : [];
  });
  return `${counted(rows.length, "file")}: ${parts.join(", ")}.`;
}

// ---------------------------------------------------------------- a file's history

/** What tells two versions of one history apart: when it was written and its body. Two with the same of both hold the same text, so nothing depends on telling them apart. */
export function versionKey(v: FileVersion): string {
  return `${v.at}:${v.hash ?? "deleted"}`;
}

/** A version as the history lists it: its key, whether it is the one the file has now, and whether it is a deletion. */
export interface VersionRow {
  key: string;
  version: FileVersion;
  current: boolean;
  deleted: boolean;
}

/** A history's rows, newest first as it is given: the first is the file as it stands, unless it is a deletion (the file is gone now). */
export function versionRows(versions: readonly FileVersion[]): VersionRow[] {
  return versions.map((version, i) => ({ key: versionKey(version), version, current: i === 0 && version.hash !== null, deleted: version.hash === null }));
}

/** A version's facts on one line: its length (or that it is a deletion), who wrote it, and the reply whose turn made it. */
export function versionFacts(v: FileVersion): string {
  return [v.hash === null ? "deleted" : counted(v.chars, "character"), `by ${authorWords(v.by)}`, ...(v.turn !== null ? [replyWords(v.turn)] : [])].join(" · ");
}

/** The versions picked to compare after another is pressed: pressing a picked one lets it go; a third takes the place of the one picked first. */
export function pickVersion(picked: readonly string[], key: string): string[] {
  if (picked.includes(key)) return picked.filter((k) => k !== key);
  return [...picked, key].slice(-2);
}

/** The two versions picked, the older first, whichever was picked first; null until two that the history still has are picked. */
export function pickedPair(rows: readonly VersionRow[], picked: readonly string[]): { older: VersionRow; newer: VersionRow } | null {
  const found = rows.filter((r) => picked.includes(r.key));
  const newer = found[0];
  const older = found[1];
  // The history is newest first, so of two rows the later one is the older version.
  return newer && older && found.length === 2 ? { older, newer } : null;
}

// ---------------------------------------------------------------- text typed and not yet saved

/** Text typed over a file and not yet saved: the version it was typed over (null: no file was there), that version's text, and the text as it stands. A new file's draft carries the path typed for it. */
export interface Draft {
  base: string | null;
  from: string;
  text: string;
  path?: string;
}

/** Where a draft belongs: a file, a file not yet made, or a guidance level, each of a chat (null: of none, as the user's own area and level are the same in every chat). */
export type DraftPlace = { kind: "file"; chatId: string | null; area: WorkspaceArea; path: string } | { kind: "new"; chatId: string | null; area: WorkspaceArea } | { kind: "guidance"; chatId: string | null; level: GuidanceLevelId };

/** The chat a draft belongs to as a part of its key: none where the place is the same in every chat. A chat's id is the host's, so it is escaped rather than trusted to hold no bar. */
function chatPart(chatId: string | null, shared: boolean): string {
  return shared || chatId === null ? "" : encodeURIComponent(chatId);
}

/** What a file's draft is kept under: its chat (none for the user's own area), its area and its path. */
export function draftKey(chatId: string | null, area: WorkspaceArea, path: string): string {
  return `file|${chatPart(chatId, area === "user")}|${area}|${path}`;
}

/** What the draft of a file not yet made is kept under: one for each area of each chat. */
export function newDraftKey(chatId: string | null, area: WorkspaceArea): string {
  return `new|${chatPart(chatId, area === "user")}|${area}`;
}

/** What a guidance level's draft is kept under. */
export function guidanceDraftKey(chatId: string | null, level: GuidanceLevelId): string {
  return `guidance|${chatPart(chatId, level === "user")}|${level}`;
}

/** Where a draft belongs, read back from the key it is kept under; null for a key that is none of these. */
export function draftPlace(key: string): DraftPlace | null {
  const [kind, chat = "", third = "", ...rest] = key.split("|");
  const chatId = chat === "" ? null : decodeURIComponent(chat);
  if (kind === "guidance") return third === "user" || third === "middle" || third === "chat" ? { kind, chatId, level: third } : null;
  if (third !== "chat" && third !== "learned" && third !== "user") return null;
  if (kind === "new") return { kind, chatId, area: third };
  // A path may hold a bar itself: everything after the area is the path.
  return kind === "file" ? { kind, chatId, area: third, path: rest.join("|") } : null;
}

/** Whether a draft holds anything typed: text that differs from what it was typed over, or a path typed for a file not yet made. */
export function isDirty(draft: Draft): boolean {
  return draft.text !== draft.from || (draft.path !== undefined && draft.path.trim() !== "");
}

/** Whether the file has another version now than the one a draft was typed over: someone else wrote it meanwhile (`current` null: it is gone). */
export function isStale(draft: Draft, current: string | null): boolean {
  return draft.base !== current;
}

/** The places that hold unsaved text for a chat other than the one shown: what a page says is waiting where the user can't see it. */
export function draftsElsewhere(drafts: ReadonlyMap<string, Draft>, chatId: string | null): DraftPlace[] {
  const places: DraftPlace[] = [];
  for (const [key, draft] of drafts) {
    const place = draftPlace(key);
    if (place !== null && place.chatId !== null && place.chatId !== chatId && isDirty(draft)) places.push(place);
  }
  return places;
}

// ---------------------------------------------------------------- where the page is

/** What the Workspace page shows beside its list: nothing, the file open, a reply's change set, what is pinned, or the form that makes a file. */
export type WorkspacePane = "none" | "file" | "changes" | "pins" | "new";

/**
 * What a file's Back says, by where it leads: to the page that led to the file where one did (`from`
 * is that page's name: the Chronicle, for one of its files), which comes before the reply's change
 * set the Workspace happens to hold; else to that change set where the file was opened from it; else
 * to the list of files.
 */
export function fileBackWords(from: string | null, fromChanges: boolean): string {
  if (from !== null) return `Back to ${from}`;
  return fromChanges ? "Back to the reply's changes" : "Back to the files";
}

/**
 * Where the Workspace page is, kept while the user is on another page: the area listed, the pane
 * shown, the filter, the folders folded (each as `<area>:<path>`), and what nav pointed at when the
 * page last looked (`chat` undefined: it hasn't looked yet), which is how it tells what another
 * page led to since from what it has shown already.
 */
export interface WorkspaceKept {
  area: WorkspaceArea;
  pane: WorkspacePane;
  filter: string;
  folded: ReadonlySet<string>;
  seen: { chat: string | null | undefined; file: FileTarget | null; changes: Nav["changes"] };
}

export const START_KEPT: WorkspaceKept = { area: "chat", pane: "none", filter: "", folded: new Set(), seen: { chat: undefined, file: null, changes: null } };

/**
 * Where the page stands once it has looked at nav and at the chat shown: a file or a change set
 * that arrived since it last looked comes to the front (a file brings its area); one that was
 * closed gives the pane to the other, or to nothing. A file or a change set that was open under
 * another chat doesn't belong to this one and closes (`file` and `changes` are what stands: the
 * page puts them back in nav where they differ), unless it arrived with the chat; the user's own
 * files are the same in every chat and stay. The same `kept` comes back where nothing moved.
 */
export function followNav(kept: WorkspaceKept, nav: Pick<Nav, "file" | "changes">, chatId: string | null): { kept: WorkspaceKept; file: FileTarget | null; changes: Nav["changes"] } {
  const first = kept.seen.chat === undefined;
  const moved = !first && kept.seen.chat !== chatId;
  const file = moved && nav.file !== null && nav.file === kept.seen.file && nav.file.area !== "user" ? null : nav.file;
  const changes = moved && nav.changes !== null && nav.changes === kept.seen.changes ? null : nav.changes;
  let { area, pane } = kept;
  if (file !== kept.seen.file) {
    if (file !== null) {
      pane = "file";
      area = file.area;
    } else if (pane === "file") pane = changes !== null ? "changes" : "none";
  }
  if (changes !== kept.seen.changes) {
    if (changes !== null) pane = "changes";
    else if (pane === "changes") pane = file !== null ? "file" : "none";
  }
  // A file being made belongs to the chat it was started in; its draft waits there.
  if (moved && pane === "new") pane = "none";
  // With no chat only the user's own area can be read.
  if (chatId === null) area = "user";
  if (!first && !moved && area === kept.area && pane === kept.pane && file === kept.seen.file && changes === kept.seen.changes) return { kept, file, changes };
  return { kept: { area, pane, filter: moved ? "" : kept.filter, folded: moved ? new Set() : kept.folded, seen: { chat: chatId, file, changes } }, file, changes };
}

// ---------------------------------------------------------------- guidance

/**
 * What an empty level opens with: a few lines of the kind that belong there, for an invented story,
 * which the user starts from or writes over. They are words the page shows, as its sentences are.
 */
export const GUIDANCE_EXAMPLE: Readonly<Record<GuidanceLevelId, string>> = {
  user: "- Keep a reply under four paragraphs.\n- Never speak or act for my character.\n- Weather and the tide in a clause, never a paragraph.\n- Don't make up a fact the story hasn't given: say what isn't known.",
  middle: "- Joss speaks in short sentences, and wipes something down while he thinks.\n- He never lies to Mara, though he leaves things out.\n- He calls the harbourmaster's clerk by his name, Brann, and nobody else by theirs.",
  chat: "- It is a harbour town in late autumn. Nobody has a telephone.\n- The harbour office shuts at six. Brann keeps its key by day, Ilse by night.\n- A page of the pilot's ledger is missing: don't settle who took it before Mara finds out.\n- Okoro reads everything twice before he says anything about it.",
};

/** A workspace path at the head of a level's note ("~/GUIDANCE.md: every agent…"), which the backend leads its words with. */
const NOTE_PATH = /^\S+\.md:\s+/;

/**
 * Whose a level is and who is given it, with no file's name in it. The user's level and the chat's
 * are the same two in every chat, so the page words them itself; the middle one is whoever names
 * it's to say (the character's, or an extension's own), in the backend's words without their path.
 */
export function levelWhose(level: Pick<GuidanceLevel, "id" | "note">): string {
  if (level.id === "user") return "For every chat of yours: every agent is given it, whatever the story.";
  if (level.id === "chat") return "For this chat alone. It stays as it is when you swipe or edit.";
  return level.note.replace(NOTE_PATH, "").replace(/^./, (first) => first.toUpperCase());
}

/** What a level with nothing in it says: what belongs there, where the user can write it. */
export function levelEmptyWords(level: Pick<GuidanceLevel, "id" | "editable">): string {
  if (!level.editable) return "Nothing is written here, so agents are given nothing at this level.";
  if (level.id === "user") return "Nothing is written here yet. Write how you like every story told: how long a reply is, what the agents must never do.";
  if (level.id === "chat") return "Nothing is written here yet. Write what must hold in this story: what is true, how someone speaks, what a reply got wrong.";
  return "Nothing is written here yet. Write how this character speaks and acts, in every chat with them.";
}

/** What the page says above the levels where a chat is shown: that this chat's level is where a reply's mistake is mended, for someone who came from a reply that got something wrong. */
export const GUIDANCE_CHAT_LEAD = "A reply got something wrong? Write it down for this chat, and every reply from the next one keeps to it.";

/** What happens to a level longer than its limit, said where it is; null while it fits. */
export function guidanceCutWords(text: string, limit: number): string | null {
  const over = text.length - limit;
  return over > 0 ? `${counted(over, "character")} over: an agent is given the first ${count(limit)} and told the rest was cut. Shorten it, or raise the limit in Settings.` : null;
}

/** When a level was last written and by whom; null where nothing is written, which the level says in its own words. */
export function levelFacts(level: Pick<GuidanceLevel, "hash" | "at" | "by">, now: number): string | null {
  if (level.hash === null || level.at === null) return null;
  return `Last written ${ago(now, level.at)}${level.by !== null ? ` by ${authorWords(level.by)}` : ""}.`;
}

/** Whether agents may write the chat's level, as a sentence. */
export function agentsEditWords(allowed: boolean): string {
  return allowed ? "Agents may write here too: what they learn about this chat." : "Only you write here: agents may not.";
}

/** What a level is called inside a sentence ("Edit this chat's guidance"): whose it is, never its file. */
export function levelName(level: Pick<GuidanceLevel, "id" | "label">): string {
  if (level.id === "user") return "your guidance";
  if (level.id === "chat") return "this chat's guidance";
  return `${level.label} guidance`;
}

/** What the page says of unsaved text that waits in chats other than the one shown; null where none does. */
export function waitingWords(places: readonly DraftPlace[]): string | null {
  const chats = new Set(places.map((p) => p.chatId)).size;
  if (chats === 0) return null;
  return `Text you typed and didn't save is waiting in ${counted(chats, "other chat")}: pick ${chats === 1 ? "it" : "one"} above to go on with it.`;
}

/** Who wrote a level's newest version and when, as the sentence a conflict opens with; that it was written again where the level doesn't say by whom. */
export function wroteWords(level: Pick<GuidanceLevel, "at" | "by">, now: number): string {
  if (level.by === null || level.at === null) return "It was written again.";
  return `${authorWords(level.by).replace(/^./, (c) => c.toUpperCase())} wrote it ${ago(now, level.at)}.`;
}
