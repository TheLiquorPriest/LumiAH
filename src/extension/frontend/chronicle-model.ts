// What the Chronicle page decides (DESIGN §24.7, §22), apart from drawing it: which files it offers
// and what each is called, a file's text as lines with the citations to press and the marks the
// check gives them, the counts and the words for a line that no longer holds, how a cited message
// stands, and the card for learning the story: how far the chronicle has come, how the job stands,
// what can be done about it, and what Learn this story starts. Pure, so it is tested without a DOM;
// the page renders what these give.

import { type ChronicleFailure, type ChronicleFile, type ChronicleView, type Citation, citationsOf, type CitedView, type JobAllowance, type JobView, learnedPath, type StoryEstimate, type StoryView, type UiRequests, type WorkspaceFile } from "../../shared/ui";
import type { FileTarget } from "./app";
import { compact, count, counted, money } from "./format";
import type { IconName } from "./icons";
import { ALLOWANCE_FIELDS, type AllowanceDraft, allowanceDraft, type AllowanceKey, allowanceOf, type JobActions, jobActions, type JobBadge, jobBadge, jobPaused, jobSentence, type JobTone, REASON_TITLES, type Switches } from "./jobs-model";
import { fractionOf, percentWords } from "./spend-model";

// ---------------------------------------------------------------- the files

/** The folder the chronicle's files are in, as the agents write their paths. */
export const CHRONICLE_DIR = "learned/chronicle/";

const LEARNED = "learned/";

/**
 * The chronicle's own four files (DESIGN §24.7), in the order a reader wants them: the story's
 * parts, what holds, what is open, who is who. Their names are core's: it writes and checks these
 * four, so they are no setting.
 */
const OWN: readonly string[] = ["outline.md", "facts.md", "threads.md", "cast.md"];

/** What learning a story leaves beside the four (§22), in the order it is offered after them. */
const BESIDE: readonly string[] = ["plan.md", "unverified.md"];

const FILE_WORDS: Readonly<Record<string, { label: string; about: string }>> = {
  "outline.md": { label: "Outline", about: "The parts of the story in order, with the messages each spans." },
  "facts.md": { label: "Established", about: "What the story has established as true." },
  "threads.md": { label: "Open threads", about: "Promises made and questions not yet answered." },
  "cast.md": { label: "Cast", about: "Who is in the story, where each is and in what state." },
  "plan.md": { label: "Plan", about: "What the agent that learns this story means to read closely, to skim and to leave out." },
  "unverified.md": { label: "Not verified", about: "What the agent that learned this story wrote down without checking it against the chat." },
};

/** A path as the agents write it: one given within `learned/` (`chronicle/facts.md`, as a listing of that area has it) gains the area's name. */
export function agentsPath(path: string): string {
  return path.startsWith(LEARNED) ? path : `${LEARNED}${path}`;
}

/** A file's name within the chronicle's folder: `facts.md`. */
export function fileName(path: string): string {
  const whole = agentsPath(path);
  return whole.startsWith(CHRONICLE_DIR) ? whole.slice(CHRONICLE_DIR.length) : whole;
}

const wordsOf = (path: string): { label: string; about: string } | null => {
  const name = fileName(path);
  return Object.hasOwn(FILE_WORDS, name) ? (FILE_WORDS[name] ?? null) : null;
};

/** What a file is called on the page: a plain name for those the page knows, its own name for any other. */
export function fileLabel(path: string): string {
  return wordsOf(path)?.label ?? fileName(path);
}

const placeIn = (names: readonly string[], path: string): number => names.indexOf(fileName(path));

/** The chronicle's own files the check found, in the page's order: none while the chat has no chronicle yet. */
export function ownFiles(view: Pick<ChronicleView, "files">): ChronicleFile[] {
  return view.files.filter((f) => placeIn(OWN, f.path) >= 0).sort((a, b) => placeIn(OWN, a.path) - placeIn(OWN, b.path));
}

/** Whether the chat has a chronicle: one of its own four files is there. A plan alone is none yet. */
export function hasChronicle(view: Pick<ChronicleView, "files">): boolean {
  return ownFiles(view).length > 0;
}

/**
 * What else is in the chronicle's folder, as the agents write the paths: the files a listing of
 * `learned/` holds under `chronicle/` that aren't one of the four, with the story's plan where
 * `lah.story.get` names one the listing lacks. The plan first, then what wasn't verified, then any
 * other by its name.
 */
export function extraPaths(listed: readonly Pick<WorkspaceFile, "path">[], plan: string | null): string[] {
  const found = new Set(listed.map((f) => agentsPath(f.path)).filter((path) => path.startsWith(CHRONICLE_DIR) && placeIn(OWN, path) < 0));
  if (plan !== null) found.add(agentsPath(plan));
  const rank = (path: string): number => (placeIn(BESIDE, path) >= 0 ? placeIn(BESIDE, path) : BESIDE.length);
  return [...found].sort((a, b) => rank(a) - rank(b) || fileName(a).localeCompare(fileName(b)));
}

/** A file the page offers. */
export interface FileChoice {
  /** Its path as the agents write it. */
  path: string;
  label: string;
  /** What the file is, in a line; null for one the page has no words for. */
  about: string | null;
  /** One of the chronicle's own four, whose lines the check reads. */
  own: boolean;
  /** How many of its lines the check fails. */
  failed: number;
}

/** The files to choose from: the chronicle's own, then what else its folder holds. */
export function fileChoices(view: ChronicleView, extras: readonly string[]): FileChoice[] {
  const failed = failedPlaces(view);
  const own = ownFiles(view).map((f): FileChoice => ({ path: f.path, label: fileLabel(f.path), about: wordsOf(f.path)?.about ?? null, own: true, failed: failed.filter((p) => p.path === agentsPath(f.path)).length }));
  const rest = extras.filter((path) => !own.some((f) => agentsPath(f.path) === agentsPath(path))).map((path): FileChoice => ({ path: agentsPath(path), label: fileLabel(path), about: wordsOf(path)?.about ?? null, own: false, failed: 0 }));
  return [...own, ...rest];
}

/** The file shown: the one asked for where it is among the choices (a path within `learned/` is one too), else the first. */
export function shownChoice(choices: readonly FileChoice[], asked: string | null): FileChoice | null {
  const wanted = asked === null ? null : agentsPath(asked);
  return choices.find((c) => agentsPath(c.path) === wanted) ?? choices[0] ?? null;
}

/** Where the Workspace page opens a file of the chronicle, to edit it. */
export function workspaceTarget(path: string): FileTarget {
  return { area: "learned", path: learnedPath(agentsPath(path)), hash: null };
}

// ---------------------------------------------------------------- a file's lines

/** A citation of a line that no longer holds, and why. */
export interface LineFail {
  index: number;
  citation: string;
  why: ChronicleFailure["why"];
}

/** A citation of a line whose message stands unchanged at another number now. */
export interface LineMove {
  index: number;
  citation: string;
  now: number;
}

/** A piece of a line as it shows: words, or a citation to press (`nth`: which of the line's citations it is, from 0). */
export type LinePiece = { text: string } | { cite: Citation; nth: number };

/** A line of a file as the page shows it. Empty lines are left out; the numbers are the file's own. */
export interface ChronLine {
  /** Its number in the file, from 1. */
  n: number;
  kind: "heading" | "item" | "text";
  /** A heading's level (1 to 6); how deep an item is set in (0: not at all); 0 for plain text. */
  level: number;
  /** A numbered item's own number as written ("2."); null for a bullet. */
  marker: string | null;
  pieces: LinePiece[];
  /** Its citations, in the order written. */
  citations: Citation[];
  /** The citations the check fails: with any, agents are no longer given the line. */
  fails: LineFail[];
  moves: LineMove[];
  /** An item that cites no message. */
  uncited: boolean;
}

/** What the check says of one file's lines, by line number. */
export interface FileMarks {
  fails: ReadonlyMap<number, LineFail[]>;
  moves: ReadonlyMap<number, LineMove[]>;
  uncited: ReadonlySet<number>;
}

const samePath = (a: string, b: string): boolean => agentsPath(a) === agentsPath(b);

/** The check's marks for one file. */
export function marksOf(view: ChronicleView, path: string): FileMarks {
  const fails = new Map<number, LineFail[]>();
  const moves = new Map<number, LineMove[]>();
  for (const f of view.failures) {
    if (!samePath(f.path, path)) continue;
    fails.set(f.line, [...(fails.get(f.line) ?? []), { index: f.index, citation: f.citation, why: f.why }]);
  }
  for (const m of view.moved) {
    if (!samePath(m.path, path)) continue;
    moves.set(m.line, [...(moves.get(m.line) ?? []), { index: m.index, citation: m.citation, now: m.now }]);
  }
  return { fails, moves, uncited: new Set(view.uncited.filter((u) => samePath(u.path, path)).map((u) => u.line)) };
}

const HEADING = /^\s{0,3}(#{1,6})\s+(.*?)\s*$/;
const ITEM = /^(\s*)(?:[-*+]|(\d{1,9}[.)]))\s+(.*?)\s*$/;

/** A line's words with its citations cut out of them, each where it stood. */
function piecesOf(content: string): { pieces: LinePiece[]; citations: Citation[] } {
  const citations = citationsOf(content);
  const pieces: LinePiece[] = [];
  let at = 0;
  citations.forEach((cite, nth) => {
    // The space before a citation is the chip's own margin on the page.
    const before = content.slice(at, cite.start).replace(/\s+$/, "");
    if (before !== "") pieces.push({ text: before });
    pieces.push({ cite, nth });
    at = cite.start + cite.citation.length;
  });
  const rest = content.slice(at);
  if (rest.trim() !== "") pieces.push({ text: rest });
  return { pieces, citations };
}

/** One line read as markdown as far as the chronicle uses it: a heading, a bullet or a numbered item, or plain words. */
function lineOf(n: number, raw: string, marks: FileMarks | null): ChronLine {
  const heading = HEADING.exec(raw);
  const item = heading ? null : ITEM.exec(raw);
  const kind: ChronLine["kind"] = heading ? "heading" : item ? "item" : "text";
  const content = heading ? (heading[2] ?? "") : item ? (item[3] ?? "") : raw.trim();
  // A tab sets an item in as far as two spaces do.
  const level = heading ? (heading[1] ?? "#").length : item ? Math.floor((item[1] ?? "").replace(/\t/g, "  ").length / 2) : 0;
  return { n, kind, level, marker: item?.[2] ?? null, ...piecesOf(content), fails: marks?.fails.get(n) ?? [], moves: marks?.moves.get(n) ?? [], uncited: marks?.uncited.has(n) ?? false };
}

/** A file's text as the lines the page shows, each with the check's marks (null: a file the check doesn't read). */
export function linesOf(text: string, marks: FileMarks | null): ChronLine[] {
  return text.split("\n").flatMap((raw, i) => {
    const line = raw.replace(/\r$/, "");
    return line.trim() === "" ? [] : [lineOf(i + 1, line, marks)];
  });
}

/** A place in the chronicle: a file, as the agents write its path, and a line of it. */
export interface LinePlace {
  path: string;
  line: number;
}

const samePlace = (a: LinePlace, b: LinePlace): boolean => samePath(a.path, b.path) && a.line === b.line;

/** The lines the check fails, each once, in the order the page shows them: file by file, down each. */
export function failedPlaces(view: Pick<ChronicleView, "failures">): LinePlace[] {
  const places: LinePlace[] = [];
  for (const f of view.failures) if (!places.some((p) => samePlace(p, f))) places.push({ path: agentsPath(f.path), line: f.line });
  const rank = (path: string): number => (placeIn(OWN, path) >= 0 ? placeIn(OWN, path) : OWN.length);
  return places.sort((a, b) => rank(a.path) - rank(b.path) || fileName(a.path).localeCompare(fileName(b.path)) || a.line - b.line);
}

/** The failing line after the one the reader stands on, round to the first again; null where none fails. */
export function nextPlace(places: readonly LinePlace[], from: LinePlace | null): LinePlace | null {
  const at = from === null ? -1 : places.findIndex((p) => samePlace(p, from));
  return places[(at + 1) % Math.max(1, places.length)] ?? null;
}

/** The lines that fail, a file a group, as the check gives their text: what "show only these" shows, with no file read for it. */
export function failingLines(view: ChronicleView): { path: string; label: string; lines: ChronLine[] }[] {
  const groups: { path: string; label: string; lines: ChronLine[] }[] = [];
  for (const place of failedPlaces(view)) {
    const failure = view.failures.find((f) => samePlace(f, place));
    if (failure === undefined) continue;
    const read = lineOf(place.line, failure.text, marksOf(view, place.path));
    // Core may give a line's words without its citations: those that fail are then shown after the words.
    const cited = read.citations.length > 0 ? read.citations : read.fails.flatMap((f) => citationsOf(f.citation).slice(0, 1));
    // A line that fails is an item of its file, whether or not its bullet came with its words.
    const line: ChronLine = { ...read, kind: read.kind === "text" ? "item" : read.kind, citations: cited, pieces: read.citations.length > 0 ? read.pieces : [...read.pieces, ...cited.map((cite, nth): LinePiece => ({ cite, nth }))] };
    const group = groups.find((g) => g.path === place.path);
    if (group) group.lines.push(line);
    else groups.push({ path: place.path, label: fileLabel(place.path), lines: [line] });
  }
  return groups;
}

/** How many lines fail, cite a message that moved, and cite nothing: each line once. */
export interface Counts {
  failed: number;
  moved: number;
  uncited: number;
}

export function countsOf(view: ChronicleView): Counts {
  const moved = new Set(view.moved.map((m) => `${agentsPath(m.path)}\n${m.line}`));
  return { failed: failedPlaces(view).length, moved: moved.size, uncited: view.uncited.length };
}

/** The count that leads to the failing lines: "3 lines no longer hold". */
export function failedWords(failed: number): string {
  return failed === 1 ? "1 line no longer holds" : `${count(failed)} lines no longer hold`;
}

/** What else the check found, said quietly; null where there is nothing to say. */
export function quietWords(counts: Pick<Counts, "moved" | "uncited">): string | null {
  const said: string[] = [];
  if (counts.uncited > 0) said.push(`${counted(counts.uncited, "line")} ${counts.uncited === 1 ? "cites" : "cite"} no message.`);
  if (counts.moved > 0) said.push(`${counted(counts.moved, "line")} ${counts.moved === 1 ? "cites" : "cite"} a message that stands unchanged at another number now.`);
  return said.length > 0 ? said.join(" ") : null;
}

/** "#40", "#40 and #41", "#40, #41 and #42". */
function listed(numbers: readonly number[]): string {
  const names = [...new Set(numbers)].map((n) => `#${n}`);
  return names.length <= 1 ? (names[0] ?? "") : `${names.slice(0, -1).join(", ")} and ${names.at(-1) ?? ""}`;
}

/** Why a line no longer holds, and what that means for it: said in words beside its sign, never by colour alone. */
export function failWords(fails: readonly LineFail[]): string {
  const changed = [...new Set(fails.filter((f) => f.why === "changed").map((f) => f.index))];
  const gone = [...new Set(fails.filter((f) => f.why === "gone").map((f) => f.index))];
  const parts: string[] = [];
  if (changed.length > 0) parts.push(`${changed.length === 1 ? "message" : "messages"} ${listed(changed)} ${changed.length === 1 ? "has" : "have"} changed since this was written (a swipe or an edit)`);
  if (gone.length > 0) parts.push(`${gone.length === 1 ? "message" : "messages"} ${listed(gone)} ${gone.length === 1 ? "is" : "are"} gone from the chat`);
  return `No longer holds: ${parts.join(", and ")}. Agents are no longer given this line.`;
}

/** What a moved citation means for its line. */
export function moveWords(moves: readonly LineMove[]): string {
  const [one] = moves;
  if (moves.length === 1 && one) return `Message #${one.index} stands unchanged at #${one.now} now, so the line still holds.`;
  return `${moves.map((m) => `#${m.index} stands at #${m.now} now`).join(", ")}: each unchanged, so the line still holds.`;
}

export const UNCITED_WORDS = "Cites no message";

// ---------------------------------------------------------------- a cited message

/** How a cited message stands against its citation. */
export type CitedState = "holds" | "moved" | "changed" | "gone";

export function citedState(cited: CitedView): CitedState {
  if (cited.message === null || cited.why === "gone") return "gone";
  if (cited.why === "moved") return "moved";
  return cited.ok ? "holds" : "changed";
}

/** A cited message's mark where it isn't simply as cited: a word and a sign. */
export function citedBadge(cited: CitedView): { word: string; tone: JobTone; icon: IconName } | null {
  const state = citedState(cited);
  if (state === "holds") return null;
  if (state === "moved") return { word: cited.now !== undefined ? `now #${cited.now}` : "moved", tone: "neutral", icon: "arrow-right" };
  return state === "changed" ? { word: "changed", tone: "warn", icon: "alert" } : { word: "gone", tone: "warn", icon: "alert" };
}

/** What to know of a cited message that isn't simply as cited; null for one that is. */
export function citedNote(cited: CitedView): string | null {
  switch (citedState(cited)) {
    case "holds":
      return null;
    case "moved":
      return `It stands unchanged at ${cited.now !== undefined ? `#${cited.now}` : "another number"} now: a message before it was removed or added. What cites it still holds.`;
    case "changed":
      return "Its text has changed since it was cited: it was swiped or edited. This is how it reads now, so what cites it no longer holds.";
    case "gone":
      return "This message is gone from the chat, so what cites it no longer holds.";
  }
}

const ROLE_WORDS: Readonly<Record<string, string>> = { user: "You", assistant: "The character", system: "The system" };

/** Who said a message: its name, else its role in words. */
export function saidBy(message: Pick<NonNullable<CitedView["message"]>, "name" | "role">): string {
  if (message.name.trim() !== "") return message.name.trim();
  return Object.hasOwn(ROLE_WORDS, message.role) ? (ROLE_WORDS[message.role] ?? message.role) : message.role;
}

// ---------------------------------------------------------------- learning the story (§22)

/** How far the chronicle has come: in words, as a share of the chat (null: the chat has no message, so no bar), and how many messages it doesn't span. */
export interface Progress {
  words: string;
  fraction: number | null;
  behind: number;
}

export function progressOf(story: Pick<StoryView, "messages" | "covered">): Progress {
  const messages = Math.max(0, story.messages);
  const covered = Math.min(messages, Math.max(0, story.covered));
  if (messages === 0) return { words: "This chat has no messages yet.", fraction: null, behind: 0 };
  if (covered === messages) return { words: messages === 1 ? "The chronicle covers the chat's one message." : `The chronicle covers all ${count(messages)} messages.`, fraction: 1, behind: 0 };
  const fraction = fractionOf(covered, messages);
  // A share says little of a handful of messages, and "0%" nothing the count doesn't.
  const share = covered > 0 && messages >= 100 ? ` (${percentWords(fraction)})` : "";
  return { words: `The chronicle covers ${count(covered)} of ${counted(messages, "message")}${share}.`, fraction, behind: messages - covered };
}

/** The job that learns the story, as it stands now: the state's own copy while it isn't over (it follows every change), else as `lah.story.get` read it. */
export function storyJobOf(story: Pick<StoryView, "job">, active: readonly JobView[]): JobView | null {
  const job = story.job;
  if (job === null) return null;
  return active.find((j) => j.id === job.id) ?? job;
}

// ---------------------------------------------------------------- what the rest is expected to take, and the budget sized to it

/**
 * How much over the estimate the budget offered is: half as much again, so the usual story ends
 * learned, and one that runs longer is a tap away ("Carry on to the end"). Not a setting: it sizes
 * the figures the form opens with, which the user changes under "Choose exactly"; the limits
 * themselves are the job's budget and Settings'.
 */
export const BUDGET_MARGIN = 1.5;

/**
 * The least a grant raises a limit by, as a share of what the job has used of it: a tenth. It only
 * keeps "Carry on to the end" from granting nothing where the estimate says little is left (the
 * outline spans the chat, and the job still had its other files to write). Not a setting.
 */
const LEAST_RAISE = 0.1;

const MINUTE_MS = 60_000;

/** The estimate in a sentence, said before anything is started: in money where the model that does it has a price, in tokens otherwise. Empty where nothing is left to learn. */
export function estimateWords(estimate: StoryEstimate): string {
  if (estimate.messages <= 0) return "";
  const what = `Learning the ${estimate.messages === 1 ? "one message" : `${count(estimate.messages)} messages`} the chronicle doesn't cover yet`;
  const tokens = `about ${compact(Math.round(estimate.promptTokens))} tokens read and ${compact(Math.round(estimate.writtenTokens))} written`;
  return estimate.usd !== null ? `${what} should cost about ${money(estimate.usd)} (${tokens}).` : `${what} should take ${tokens}. The model that does it has no price set, so that can't be said in money.`;
}

/** Tokens rounded up to a whole thousand: a budget's figure is one a person reads. */
const tidy = (tokens: number): number => Math.ceil(tokens / 1000) * 1000;

/**
 * The budget Learn this story offers: the estimate and half as much again, in tokens read (as a
 * budget counts them), tokens written and rounds of tool calls. Time stays at Settings' limit,
 * since nothing says how fast a provider answers. Empty where nothing is left to learn.
 */
export function budgetFor(estimate: StoryEstimate): JobAllowance {
  if (estimate.messages <= 0) return {};
  return { tokensIn: tidy(estimate.weighedTokens * BUDGET_MARGIN), tokensOut: tidy(estimate.writtenTokens * BUDGET_MARGIN), toolTurns: Math.ceil(estimate.toolTurns * BUDGET_MARGIN) };
}

/**
 * What "Carry on to the end" grants a job that ran out of its budget: for each limit, what the job
 * has used of it (or the limit it had, where that is more), and on top of that what the rest is
 * expected to need, with the same margin. Time has no estimate, so the rest's is taken from the
 * job's own pace: the time it has worked for the tokens it has read. A limit the job used nothing
 * of is left as it was, and one it had lifted stays lifted.
 */
export function carryOnGrant(job: Pick<JobView, "allowance" | "usage" | "workedMs">, estimate: StoryEstimate): JobAllowance {
  const had = job.allowance ?? {};
  const used: Readonly<Record<AllowanceKey, number>> = { tokensIn: job.usage.in, tokensOut: job.usage.out, toolTurns: job.usage.toolTurns, wallMs: job.workedMs ?? 0 };
  const pace = job.usage.in > 0 ? estimate.promptTokens / job.usage.in : 0;
  const rest: Readonly<Record<AllowanceKey, number>> = { tokensIn: estimate.weighedTokens, tokensOut: estimate.writtenTokens, toolTurns: estimate.toolTurns, wallMs: used.wallMs * pace };
  const out: JobAllowance = {};
  for (const { key } of ALLOWANCE_FIELDS) {
    const limit = had[key];
    if (limit === null) continue;
    const more = Math.max(rest[key] * BUDGET_MARGIN, used[key] * LEAST_RAISE);
    // Nothing used and nothing expected: it didn't stop at this one.
    if (more <= 0) continue;
    const raised = Math.max(used[key], limit ?? 0) + more;
    out[key] = key === "wallMs" ? Math.ceil(raised / MINUTE_MS) * MINUTE_MS : key === "toolTurns" ? Math.ceil(raised) : tidy(raised);
  }
  return out;
}

// ---------------------------------------------------------------- the card

/**
 * How the card for learning the story stands: nothing can be started here (`off`: LumiAH isn't
 * switched on for the chat; `empty`: the chat has no message; `refused`: LumiAH's own agents don't
 * keep its chronicle, and the core said why), Learn this story is the thing to do (`offer`), the
 * chronicle spans the chat (`whole`), or a job is at it or was: it waits, runs, stopped at a limit
 * (`spent`: its own budget, or a day's), is held with no run (`paused`), ended badly (`ended`) or is
 * done.
 */
export type StoryState = "off" | "empty" | "refused" | "offer" | "whole" | "waiting" | "running" | "spent" | "paused" | "ended" | "done";

export interface StoryCard {
  state: StoryState;
  /** The job the card is about; null where none has anything to say. */
  job: JobView | null;
  badge: JobBadge | null;
  title: string;
  /** What the rest is expected to take, said first wherever something can be started or carried on; "" elsewhere. */
  estimate: string;
  /** How it stands, in a sentence or two; empty where the title and the progress say it all. */
  text: string;
  /** Why the job stands as it does, in the backend's own words. */
  reason: { title: string; text: string; tone: "warn" | "neg" } | null;
  progress: Progress;
  /** Learn this story is offered. */
  learn: boolean;
  /** What can be done to the job. */
  actions: JobActions;
  /** The job waits or runs: the page looks again as it goes, and its work is followed as it happens. */
  live: boolean;
}

const NO_ACTIONS: JobActions = { cancel: false, again: false, grant: false, carryOn: false, resume: false };

const ENDED_TITLES: Readonly<Record<"interrupted" | "failed" | "cancelled", string>> = { interrupted: "Learning this story was cut off", failed: "Learning this story failed", cancelled: "Learning this story was cancelled" };

/** What one press carries a stopped learning on with: said on the button, on the Chronicle page and on the job's own. */
export const CARRY_ON = "Carry on to the end";

export interface StoryInput {
  story: StoryView;
  /** The state's jobs not yet over. */
  active: readonly JobView[];
  /** The streams of the runs the user holds. */
  held: ReadonlySet<string>;
  switches: Switches;
  /** The chat has a chronicle: one of its own four files is there. */
  has: boolean;
  /** Whether LumiAH is switched on for the chat; null while that isn't known. */
  on: boolean | null;
}

export function storyCard(input: StoryInput): StoryCard {
  const { story, has } = input;
  const progress = progressOf(story);
  const job = storyJobOf(story, input.active);
  const behind = progress.behind > 0;
  const estimate = behind ? estimateWords(story.estimate) : "";
  const plain = { job: null, badge: null, estimate: "", reason: null, progress, actions: NO_ACTIONS, live: false };
  // An agent of an extension's stands in the chronicler's place, or LumiAH's is switched off: nothing is started or carried on here, and why is said. A job already under way is still shown, so it can be stopped.
  if (story.refused !== null && (job === null || (job.state !== "queued" && job.state !== "running"))) return { ...plain, state: "refused", title: "LumiAH doesn't learn this story", text: story.refused, learn: false };
  const ofJob = (state: StoryState, title: string, of: JobView, more: Partial<StoryCard> = {}): StoryCard => ({
    state,
    job: of,
    badge: jobBadge(of, input.held),
    title,
    estimate: "",
    text: jobSentence(of, input.held, input.switches),
    reason: of.reason !== undefined ? { title: REASON_TITLES[of.state], text: of.reason, tone: of.state === "failed" ? "neg" : "warn" } : null,
    progress,
    learn: false,
    actions: jobActions(of),
    live: of.state === "queued" || of.state === "running",
    ...more,
  });
  if (job !== null) {
    switch (job.state) {
      case "queued":
        return ofJob("waiting", "Learning this story: waiting to start", job);
      case "running":
        return ofJob("running", jobPaused(job, input.held) ? "Learning this story: paused" : "Learning this story", job);
      case "spent":
        // A day's limit used nothing of the job's own up: it carries on as it is, once the day counts less or that limit is raised.
        if (job.stoppedAt === "day") return ofJob("spent", "Learning this story is paused at a day's limit", job, { estimate, text: `Nothing it wrote is lost. ${CARRY_ON} lets it go on from where it stopped, once the last 24 hours count less or you have raised that limit.` });
        return ofJob("spent", "Learning this story ran out of budget", job, { estimate, text: `Nothing it wrote is lost. ${CARRY_ON} gives it what the rest should need, and it goes on from where it stopped.` });
      case "paused":
        return ofJob("paused", "Learning this story is on hold", job);
      case "done":
        // The chat may have gone on since: what it left stands, and the rest can be learned. The job's own sentence points at a report under it, which is on the Jobs page, not here: this card says where it is.
        return ofJob("done", "This story is learned", job, { learn: behind && input.on !== false, estimate: input.on !== false ? estimate : "", text: "The agent's report says what it read closely, what it skimmed and what it left out: open the job to read it." });
      case "interrupted":
      case "failed":
      case "cancelled":
        // Once the chronicle spans the chat there is nothing left to start again.
        if (behind) return ofJob("ended", ENDED_TITLES[job.state], job);
        break;
      case "off_path":
        break;
    }
  }
  if (!behind) {
    if (story.messages <= 0 && !has) return { ...plain, state: "empty", title: "This chat has no chronicle yet", text: "It has no messages yet, so there is no story to learn. Once the story starts, an agent writes its chronicle as it goes.", learn: false };
    return { ...plain, state: "whole", title: "The chronicle is up to date", text: "", learn: false };
  }
  const title = has ? "The chronicle is behind the chat" : "This chat has no chronicle yet";
  if (input.on === false) return { ...plain, state: "off", title, text: has ? "LumiAH isn't switched on for this chat, so no agent adds to its chronicle. Switch it on at Home, then the rest can be learned here." : "LumiAH isn't switched on for this chat, so no agent keeps its chronicle. Switch it on at Home, then its story can be learned here.", learn: false };
  return {
    ...plain,
    state: "offer",
    title,
    estimate,
    text: has ? "An agent reads what is missing and adds it, in the background, within a budget sized to that. You can stop it at any time." : "An agent reads the chat from its start and writes the chronicle, in the background, within a budget sized to that. You can stop it at any time.",
    learn: true,
  };
}

/** What Learn this story holds while it is filled in: the objective in words, the agent, and its budget. */
export interface LearnDraft {
  task: string;
  agent: string;
  allowance: AllowanceDraft;
}

/** The form as it opens: what `lah.story.get` suggests, with a budget sized to what is left to learn, which works untouched. */
export function learnDraft(story: Pick<StoryView, "suggested" | "estimate">): LearnDraft {
  return { task: story.suggested.task, agent: story.suggested.agent, allowance: allowanceDraft(budgetFor(story.estimate), null) };
}

/** Why Learn this story can't be started yet, in words that say what to do; null when it can. */
export function learnBlock(draft: LearnDraft): string | null {
  if (draft.task.trim() === "") return "Say what it is asked to do: the box under “What it is asked” is empty.";
  if (draft.agent.trim() === "") return "Pick the agent that learns the story.";
  return null;
}

/** What starts the learning: a job of the chat, now, marked as the learning of its story. A budget that names no figure of its own is left out, so Settings' limits stand. */
export function learnBody(chatId: string, draft: LearnDraft): UiRequests["lah.job.start"]["body"] {
  const allowance = allowanceOf(draft.allowance);
  return { chatId, agent: draft.agent, task: draft.task.trim(), when: "now", ...(Object.keys(allowance).length > 0 ? { allowance } : {}), story: true };
}

/** The agents Learn this story may run as: the one the form holds first (named even where the list doesn't have it), then the others by name. */
export function agentChoices(picked: string, agents: readonly { id: string; name: string }[], name: (id: string) => string): { value: string; label: string }[] {
  const others = agents.filter((a) => a.id !== picked).map((a) => ({ value: a.id, label: a.name !== "" ? a.name : a.id }));
  return [{ value: picked, label: name(picked) }, ...others.sort((a, b) => a.label.localeCompare(b.label))];
}

/** What a budget is, said once where the user sets one: with the one word a newcomer hasn't met. */
export const ALLOWANCE_WORDS = "The budget is the most this job may spend. Tokens are how a model counts text, about four characters each: read for what it is given, written for what it answers. With a smaller budget it plans narrower: it reads less of the chat closely, or leaves more out.";

/** What each member of a budget comes to in a sentence: a figure set, or no limit at all. */
const SPEND_WORDS: Readonly<Record<AllowanceKey, { set(n: number): string; none: string }>> = {
  tokensIn: { set: (n) => `${count(n)} tokens read`, none: "any number of tokens read" },
  tokensOut: { set: (n) => `${count(n)} tokens written`, none: "any number of tokens written" },
  toolTurns: { set: (n) => `${counted(n, "round")} of tool calls`, none: "any number of rounds of tool calls" },
  wallMs: { set: (n) => counted(n, "minute"), none: "as much time as it needs" },
};

/** What the learning may spend, in a sentence said before it is started: the figures the form holds, and where it holds none, that Settings' limits stand. */
export function allowanceWords(draft: AllowanceDraft): string {
  const said = ALLOWANCE_FIELDS.flatMap(({ key }) => {
    const member = draft[key];
    return member.mode === "settings" ? [] : [member.mode === "set" ? SPEND_WORDS[key].set(member.value) : SPEND_WORDS[key].none];
  });
  if (said.length === 0) return "Its budget: what Settings allow each job.";
  const rest = said.length < ALLOWANCE_FIELDS.length ? " Settings' limits stand for the rest." : "";
  return `Its budget: at most ${said.join(", ")}.${rest}`;
}

/** What a grant comes to in a sentence, said beside the one press that makes it: each limit as it would stand. */
export function grantWords(grant: JobAllowance): string {
  const said = ALLOWANCE_FIELDS.flatMap(({ key }) => {
    const limit = grant[key];
    return typeof limit === "number" ? [SPEND_WORDS[key].set(key === "wallMs" ? Math.round(limit / MINUTE_MS) : limit)] : [];
  });
  return said.length === 0 ? "" : `Its budget becomes ${said.join(", ")}, counting what it has used.`;
}
