// The chronicle (DESIGN §24.7): what the story has established, kept by agents as markdown files of
// their workspace's `learned` area so that no agent has to read the chat again to know it. Nothing
// here asks a model, and nothing is a store of its own: the files are workspace files, and a line
// is checked against the chat's messages as they stand.
//
// A line of the chronicle rests on the messages it cites (`[#412 a3f9c27e]`, `cite.ts`), and the
// check reads every citation back. A line passes where each of its citations names a message that
// reads as cited. A line that says something and cites nothing was never checked, so it fails like
// one whose citation fails; and a line that fails is left out of what the main agent is given each
// turn (`pinnedChronicle`) until an agent fixes or removes it. Where a citation's hash is that of
// exactly one other message, only its number is wrong: the line passes, the main agent is shown the
// right number, and `chronicle_check` writes it into the file (`correctedText`).
//
// The check proves that a cited message exists and reads as cited, never that it supports the line:
// that is the reading agent's to judge. `chronicle_check`, the Chronicle page and the turn all read
// through this file.
//
// What counts as the story (§24.4) is what the chronicle covers: a message the story leaves out is
// nothing to learn, so a chat whose last messages are left out is still learned to its end. A
// citation of such a message still checks (it names a message of the chat), but a line whose every
// citation names one is not given to the main agent.

import type { JobView, PathMessage } from "../ports";
import type { Settings } from "../settings";
import { leftOutWhy, type StorySource } from "../story";
import { TEXT, type Texts } from "../texts";
import { clip } from "../util";
import { type AreaAccess, fileAt, filesIn, showPath } from "../workspace";
import { checkCitation, citationsIn, placesOf } from "./cite";
import { CHRONICLER } from "./definitions";
import type { ChronicleCheck, ChronicleMoved } from "./shapes";

/** The folder of the `learned` area the chronicle is kept in. A stored path, so fixed: the agents' instructions and the skills name it. */
const FOLDER = "chronicle";

const OUTLINE = `${FOLDER}/outline.md`;
const FACTS = `${FOLDER}/facts.md`;
const THREADS = `${FOLDER}/threads.md`;
const CAST = `${FOLDER}/cast.md`;

/** The chronicle's four files, by their paths within the `learned` area, in the order the check lists them: the outline, what is established, what is open, the cast. Stored paths, so fixed. */
export const CHRONICLE_FILES: readonly string[] = [OUTLINE, FACTS, THREADS, CAST];

/** What learning a story keeps beside the chronicle (§22): its plan, and what it took on trust. Working files, so neither is checked or pinned; any other markdown file of the folder is held to the same rule as the four. */
const BESIDE: readonly string[] = [`${FOLDER}/plan.md`, `${FOLDER}/unverified.md`];

/** The order the files are pinned in: who is where first, then what is open, what is established, and the outline, which the tools give as well. */
const PINNED_ORDER: readonly string[] = [CAST, THREADS, FACTS, OUTLINE].map((path) => showPath("learned", path));

/** A file of the chronicle as the check reads it: its path as agents write it (`learned/chronicle/facts.md`), and its text. */
export interface ChronicleText {
  path: string;
  text: string;
}

/** A file of the chronicle as the `learned` area gave it: what a correction of it is written with as well, which is its path within that area and the version that was read (its body's hash). */
export interface ChronicleFile extends ChronicleText {
  within: string;
  version: string;
}

/**
 * The little of a chat a check needs: each message's hash by its number, every message of the
 * chat's (those the story leaves out among them: a citation names a message of the chat), and the
 * numbers of the messages that count as the story, ascending: what the chronicle covers. A
 * `ChatRun` is one; a turn makes one from the chat's path alone, without any message's text
 * (`storyHashes`).
 */
export interface ChatHashes {
  hashes(): Map<number, string>;
  story(): number[];
}

/** A chat's path as a check reads it: every message's hash, and the numbers of those that count as the story. */
export function storyHashes(path: readonly PathMessage[], story: StorySource): ChatHashes {
  return { hashes: () => new Map(path.map((m) => [m.index, m.hash])), story: () => path.filter((m) => leftOutWhy(m, story) === null).map((m) => m.index) };
}

/** Whether a path within the `learned` area is a file of the chronicle: markdown, directly in its folder, and not one of the two kept beside it. */
function inChronicle(path: string): boolean {
  return path.startsWith(`${FOLDER}/`) && path.endsWith(".md") && !path.includes("/", FOLDER.length + 1) && !BESIDE.includes(path);
}

/** The chronicle's files with their texts: the four first, in the check's order, then any other the agents keep there, by path. None where the run has no `learned` area. */
export async function readChronicle(learned: AreaAccess | null): Promise<ChronicleFile[]> {
  if (!learned) return [];
  const index = await learned.index();
  const others = filesIn(index)
    .map(([path]) => path)
    .filter((path) => inChronicle(path) && !CHRONICLE_FILES.includes(path));
  const out: ChronicleFile[] = [];
  for (const path of [...CHRONICLE_FILES, ...others]) {
    const entry = fileAt(index, path);
    // A body the store no longer has can be neither checked nor pinned: the file reads as not there.
    const text = entry ? await learned.text(entry.hash) : null;
    if (entry && text !== null) out.push({ path: showPath("learned", path), text, within: path, version: entry.hash });
  }
  return out;
}

/** The file of `files` a tool's argument names: by its path as agents write it, by its path within the area, or by its name alone, with or without `.md`. */
export function chronicleFile<F extends ChronicleText>(files: readonly F[], named: string): F | undefined {
  const name = named.trim().replace(/^\/+/, "");
  const forms = [name, `${name}.md`].flatMap((n) => [n, showPath("learned", n), showPath("learned", `${FOLDER}/${n}`)]);
  return files.find((file) => forms.includes(file.path));
}

// ---------------------------------------------------------------- lines

/**
 * How an item opens: a markdown bullet (`-`, `*`) or a number and a dot, indented or not, then
 * space. The chronicle's file format, so fixed: the chronicler's instructions and the skills
 * describe it, and files already written are read by it.
 */
const ITEM = /^[ \t]*(?:[-*]|\d{1,9}\.)[ \t]+(?=\S)/;

/** A markdown rule (`---`, `* * *`): it opens like an item and is none. */
const RULE = /^[ \t]*([-*_])(?:[ \t]*\1){2,}[ \t]*$/;

/** A markdown heading: one to six `#`, then space or the line's end. An outline's `#120–#159` is a number, not a heading's mark. The file format, so fixed. */
const HEADING = /^[ \t]{0,3}#{1,6}(?:[ \t]|$)/;

/** A letter or a digit in any script: what a line must hold to say anything. */
const WORD = /[\p{L}\p{N}]/u;

/** What an item says, where the line is one: the line without its bullet; null for any other line. */
function itemOf(line: string): string | null {
  const opens = ITEM.exec(line);
  return opens && !RULE.test(line) ? line.slice(opens[0].length) : null;
}

/** A text's lines; the line break that ends the text opens no line. */
function linesOf(text: string): string[] {
  const lines = text.split(/\r?\n/);
  if (lines.at(-1) === "") lines.pop();
  return lines;
}

/** What a check found beyond what the page is given: which lines of each file fail, which pass but rest only on messages the story leaves out, for each failed citation (in the order of `check.failures`) the messages that read as cited where several do, and the highest number of a message of the story a citation that passes names. */
interface Examined {
  check: ChronicleCheck;
  failed: Map<string, Set<number>>;
  aside: Map<string, Set<number>>;
  several: (readonly number[])[];
  reach: number | null;
}

/**
 * Every line of every file against the chat. A line that holds a citation stands or falls with the
 * messages it cites, whatever it opens with. A line that holds none fails, list item or prose: it
 * says something a reader would take for what the story established, and no check ever touched it.
 * Only layout is asked for no citation: a blank line, a rule (a line with no letter and no digit)
 * and a heading. A citation whose number alone is wrong (`moved`) passes: which message it means
 * is not in doubt. A line that passes and cites no message of the story (each one it cites is left
 * out now) is set aside: it is not the story's, so it reaches no further than the check.
 */
function examine(files: readonly ChronicleText[], chat: ChatHashes): Examined {
  const hashes = chat.hashes();
  const places = placesOf(hashes);
  const story = new Set(chat.story());
  const check: ChronicleCheck = { files: [], failures: [], moved: [], uncited: [] };
  const failed = new Map<string, Set<number>>();
  const aside = new Map<string, Set<number>>();
  const several: (readonly number[])[] = [];
  let reach: number | null = null;
  /** A citation that passes names `index`: whether that is a message of the story, which is all the chronicle's reach counts. */
  const passesAt = (index: number): boolean => {
    if (!story.has(index)) return false;
    if (reach === null || index > reach) reach = index;
    return true;
  };
  for (const { path, text } of files) {
    const lines = linesOf(text);
    const fails = new Set<number>();
    const apart = new Set<number>();
    let cited = 0;
    lines.forEach((raw, i) => {
      const line = i + 1;
      const said = raw.trim();
      const cites = citationsIn(raw);
      if (cites.length === 0) {
        if (!WORD.test(raw) || HEADING.test(raw)) return;
        fails.add(line);
        check.uncited.push({ path, line, text: said });
        return;
      }
      cited++;
      const seen = new Set<string>();
      let rests = false;
      for (const cite of cites) {
        // A citation written twice on a line is listed once. Told apart as written, so that each way it is written is corrected where its number is wrong.
        if (seen.has(cite.text)) continue;
        seen.add(cite.text);
        const stands = checkCitation(cite, hashes, places);
        if (stands.state === "ok") rests = passesAt(cite.index) || rests;
        else if (stands.state === "moved") {
          rests = passesAt(stands.now) || rests;
          check.moved.push({ path, line, citation: cite.text, index: cite.index, now: stands.now });
        } else {
          fails.add(line);
          check.failures.push({ path, line, text: said, citation: cite.text, index: cite.index, why: stands.state });
          several.push(stands.several);
        }
      }
      if (!rests && !fails.has(line)) apart.add(line);
    });
    failed.set(path, fails);
    aside.set(path, apart);
    check.files.push({ path, chars: text.length, lines: lines.length, cited, failed: fails.size });
  }
  return { check, failed, aside, several, reach };
}

/**
 * The chronicle against the chat as it stands, as the page is given it: each citation of each line
 * is read back. `failures`: a citation that no message, or more than one, reads as (`changed` where
 * the chat has a message at its number, `gone` where it has none). `moved`: a citation whose number
 * is wrong and whose hash is exactly one other message's, at `now`; its line passes. `uncited`: a
 * line that says something and cites nothing, which fails as well.
 */
export function checkChronicle(files: readonly ChronicleText[], chat: ChatHashes): ChronicleCheck {
  return examine(files, chat).check;
}

/** The check as its tool answers with it: what the page is given, and for each of its failures, in their order, the numbers of the messages that read as cited where several do (none where no message does). */
export function examineChronicle(files: readonly ChronicleText[], chat: ChatHashes): { check: ChronicleCheck; several: readonly (readonly number[])[] } {
  const { check, several } = examine(files, chat);
  return { check, several };
}

// ---------------------------------------------------------------- a wrong number, corrected

/** A citation as written, with `now` for its number: its hash, and the space it was written with, stand. */
export function renumbered(citation: string, now: number): string {
  // A citation opens with `[#` and its number, so the first run of digits is the number.
  return citation.replace(/\d+/, String(now));
}

/**
 * A file's text with each citation of `moved` that is the file's written with its right number
 * (`moved`: as the check lists them). Nothing else of the text is touched: a line keeps its ending.
 * A citation is closed by its brackets, so wherever its text stands in the file it is that citation,
 * and no corrected one reads as one still to correct: what this gives, checked again, has none left.
 */
export function correctedText(file: ChronicleText, moved: readonly ChronicleMoved[]): string {
  let text = file.text;
  const done = new Set<string>();
  for (const move of moved) {
    if (move.path !== file.path || done.has(move.citation)) continue;
    done.add(move.citation);
    text = text.split(move.citation).join(renumbered(move.citation, move.now));
  }
  return text;
}

// ---------------------------------------------------------------- what the main agent is given

/** Whether the chronicler is at work for a chat already: one of its jobs runs, one waits for the host to run it, or neither. */
export type ChroniclerJob = "running" | "waiting" | "none";

/**
 * A chat's jobs, read for the chronicler's. A job that is held with no run under way, or that
 * stopped at its allowance, goes on only when the user says so: it counts as none, so the chronicle
 * isn't left waiting on it.
 */
export function chroniclerJob(jobs: readonly Pick<JobView, "agent" | "state">[]): ChroniclerJob {
  const own = jobs.filter((job) => job.agent === CHRONICLER);
  if (own.some((job) => job.state === "running")) return "running";
  return own.some((job) => job.state === "queued") ? "waiting" : "none";
}

/** One file's top as the pinned part shows it, within `room` characters; null where the room can't hold its heading and a line. `fails`: the lines that fail the check; `apart`: those that rest only on messages the story leaves out. Neither is shown, and the heading counts each. */
function pinnedBlock(file: ChronicleText, fails: ReadonlySet<number>, apart: ReadonlySet<number>, texts: Texts, room: number): string | null {
  const C = TEXT.recall.chronicle;
  // A blank line parts nothing here that the next line's own opening doesn't, and costs room.
  const held = linesOf(file.text)
    .map((line, i) => ({ text: line.trimEnd(), fails: fails.has(i + 1), apart: apart.has(i + 1) }))
    .filter((line) => line.text.trim() !== "");
  const kept = held.filter((line) => !line.fails && !line.apart).map((line) => line.text);
  const failing = held.filter((line) => line.fails).length;
  const resting = held.filter((line) => line.apart).length;
  const failedNote = `${failing === 0 ? "" : texts.render(C.pinnedFailed, { count: texts.counted(failing, TEXT.recall.word.line) })}${resting === 0 ? "" : texts.render(C.pinnedApart, { count: texts.counted(resting, TEXT.recall.word.line) })}`;
  const block = (more: string, shown: readonly string[]): string => texts.render(C.pinnedFile, { path: file.path, more, failed: failedNote, lines: shown.join("\n") }).trimEnd();
  const more = (shown: number): string => texts.render(C.pinnedMore, { shown: String(shown), total: texts.counted(held.length, TEXT.recall.word.line) });
  const whole = block("", kept);
  if (whole.length <= room) return whole;
  // A file whose every line fails has only its heading to show, which says so.
  if (kept.length === 0) return null;
  // Cut: the lines from the top that fit beside the note that says so, counted at its longest.
  const lineRoom = room - block(more(held.length), []).length - 1;
  const shown: string[] = [];
  let used = 0;
  for (const line of kept) {
    const takes = line.length + (shown.length > 0 ? 1 : 0);
    if (used + takes > lineRoom) break;
    used += takes;
    shown.push(line);
  }
  if (shown.length === 0) {
    if (lineRoom < 1) return null;
    // A first line longer than the file's whole share is shown as far as it goes, so the file isn't passed over in silence while its heading fits.
    shown.push(clip(kept[0] ?? "", lineRoom));
  }
  return block(more(shown.length), shown);
}

/**
 * The top of the chronicle for the main agent's turn (§24.7), within Pinned chronicle: length in
 * all: the top of each file, without the lines that fail the check or rest only on messages the
 * story leaves out, and with a wrong number shown right (the file is `chronicle_check`'s to
 * correct); where the chronicle reaches, where the story is and how many of its messages it is past
 * the chronicle; and one upkeep line, while Settings ask for it and the chronicler's jobs are known
 * (`jobs`; null: jobs can't run, couldn't be read, or the chronicle isn't kept by LumiAH's own
 * agents in this chat).
 *
 * The upkeep line is what keeps the chronicle from costing the reply a round: it says whether a job
 * is at work, and where one is wanted it carries the whole of how to start it, so the main agent
 * loads no skill and lists no jobs to find out. `writes`: the main agent writes the reply itself, so
 * it has no `write_reply` call to put the start beside.
 *
 * The files share the room equally, and what one doesn't use goes to those after it. A chat without
 * a chronicle is told so once it is longer than Settings' tail, with the same line; "" otherwise,
 * and where Settings pin nothing.
 */
export async function pinnedChronicle(input: { learned: AreaAccess | null; chat: ChatHashes; settings: Readonly<Settings>; texts: Texts; jobs: ChroniclerJob | null; writes: boolean }): Promise<string> {
  const { texts, chat } = input;
  const C = TEXT.recall.chronicle;
  const { pin, pinChars, remind, tail, stretchMessages } = input.settings.recall.chronicle;
  // No `learned` area, no place to keep a chronicle: nothing to pin, and nothing to ask for.
  if (!pin || !input.learned) return "";
  const keeper = remind ? input.jobs : null;
  const numbers = chat.story();
  const last = String(numbers.at(-1) ?? 0);
  const files = (await readChronicle(input.learned)).filter((file) => file.text.trim() !== "");
  const found = files.length === 0 ? null : examine(files, chat);
  const reach = found ? found.reach : null;
  // How many messages the chat is past the chronicle: all of them where no line of it passes.
  const past = reach === null ? numbers.length : numbers.filter((index) => index > reach).length;
  const count = texts.counted(past, TEXT.recall.word.message);
  const upkeep = (): string => {
    if (keeper === null) return "";
    if (keeper !== "none") return texts.render(keeper === "running" ? C.jobRunning : C.jobWaiting);
    // With nothing to go on from, a job begins at the chat's last stretch: what one reader takes. The story before that is the user's to have learned, in a job of its own.
    const first = numbers[0] ?? 0;
    const from = reach !== null ? reach + 1 : numbers.length > stretchMessages ? (numbers[numbers.length - stretchMessages] ?? first) : first;
    const how = texts.render(input.writes ? C.howWrites : C.how, { agent: CHRONICLER, from: String(from) });
    const before = reach === null && from > first ? texts.render(C.before, { from: String(from) }) : "";
    if (past <= tail) return texts.render(C.kept, { how, before });
    return texts.render(found ? C.due : C.begin, { count, how, before });
  };
  if (!found) {
    // A chat no longer than the tail is still whole in the prompt, or nearly: nothing is said of a chronicle it doesn't need yet, whatever its jobs do.
    if (keeper === null || past <= tail) return "";
    const said = texts.render(C.empty, { last, count, remind: upkeep() });
    // Said whole or not at all: its end is how to start the job, and an instruction cut short misleads.
    return said.length <= pinChars ? said : "";
  }
  const frame = (shown: string, ends: string): string =>
    texts.render(C.pinned, {
      reach: reach === null ? texts.render(C.reachNone, { last, count }) : texts.render(C.reach, { covered: String(reach), last, count }),
      files: shown,
      remind: ends,
    });
  // The upkeep line likewise: where the note has no room for it whole, the note goes without it.
  const line = upkeep();
  const ends = frame("", line).length <= pinChars ? line : "";
  const place = (file: ChronicleText): number => {
    const i = PINNED_ORDER.indexOf(file.path);
    return i < 0 ? PINNED_ORDER.length : i;
  };
  // A stable sort: the files the agents keep beside the four follow them in path order, as they were read.
  const ordered = [...files].sort((a, b) => place(a) - place(b));
  let room = pinChars - frame("", ends).length;
  const blocks: string[] = [];
  ordered.forEach((file, i) => {
    // Each file's share of what is left, less the line break that parts it from the next.
    const share = Math.floor(room / (ordered.length - i)) - 1;
    const block = pinnedBlock({ path: file.path, text: correctedText(file, found.check.moved) }, found.failed.get(file.path) ?? new Set(), found.aside.get(file.path) ?? new Set(), texts, share);
    if (block === null) return;
    blocks.push(block);
    room -= block.length + 1;
  });
  // The frame is a text the user can replace: one longer than the setting allows is cut, so the limit holds whatever it says.
  return clip(frame(blocks.join("\n"), ends), pinChars);
}

// ---------------------------------------------------------------- how far the outline reaches

/**
 * The messages an outline item opens with: `#120–#159`, `#120-#159`, `#120 to #159` (the second `#`
 * may be left out where nothing parts the numbers but the dash), or a lone `#120`, a part of one
 * message. Emphasis around it is passed over. The chronicle's file format, so fixed.
 */
const SPAN = /^[*_]*#(\d{1,9})(?:\s*(?:[–—-]|to\b)\s*#(\d{1,9})|[–—-](\d{1,9}))?(?!\d)/;

/** The spans the items of an outline name, in the file's order, each from its lower number to its higher. */
export function outlineSpans(text: string): [number, number][] {
  const spans: [number, number][] = [];
  for (const line of linesOf(text)) {
    const item = itemOf(line);
    const m = item === null ? null : SPAN.exec(item);
    if (!m) continue;
    const from = Number(m[1]);
    const to = Number(m[2] ?? m[3] ?? m[1]);
    spans.push([Math.min(from, to), Math.max(from, to)]);
  }
  return spans;
}

/** What the outline of `files` covers, as runs of message numbers that don't overlap, in order: two parts that share a message make one run. None where there is no outline. */
function coveredRuns(files: readonly ChronicleText[]): [number, number][] {
  const outline = showPath("learned", OUTLINE);
  const runs: [number, number][] = [];
  for (const [from, to] of outlineSpans(files.find((file) => file.path === outline)?.text ?? "").sort((a, b) => a[0] - b[0])) {
    const open = runs.at(-1);
    if (open && from <= open[1]) open[1] = Math.max(open[1], to);
    else runs.push([from, to]);
  }
  return runs;
}

/** For each of `numbers` (message numbers, ascending): whether it lies in a span an item of the outline names. */
function coveredAmong(files: readonly ChronicleText[], numbers: readonly number[]): boolean[] {
  const runs = coveredRuns(files);
  let r = 0;
  return numbers.map((index) => {
    while (r < runs.length && (runs[r]?.[1] ?? 0) < index) r++;
    const run = runs[r];
    return run !== undefined && run[0] <= index;
  });
}

/** How far the chronicle's outline reaches: how many of the messages of the story lie in a span one of its items names. */
export function chronicleReach(files: readonly ChronicleText[], chat: ChatHashes): { covered: number } {
  return { covered: coveredAmong(files, chat.story()).filter((is) => is).length };
}

/**
 * The numbers of the story's messages no item of the outline covers, ascending: what nobody has read
 * into the chronicle, the messages after the outline's last among them. Every message of the story
 * where there is no outline. One the story leaves out is nothing to learn, and is never among them.
 */
export function uncoveredMessages(files: readonly ChronicleText[], chat: ChatHashes): number[] {
  const numbers = chat.story();
  const covered = coveredAmong(files, numbers);
  return numbers.filter((_index, at) => !covered[at]);
}

/** Those messages as runs of neighbours in the story, each from its first message's number to its last's: a covered message between two of them parts two runs, one the story leaves out doesn't. */
export function uncoveredRuns(files: readonly ChronicleText[], chat: ChatHashes): [number, number][] {
  const numbers = chat.story();
  const covered = coveredAmong(files, numbers);
  const runs: [number, number][] = [];
  let open = false;
  numbers.forEach((index, at) => {
    const last = runs.at(-1);
    if (covered[at]) open = false;
    else if (open && last) last[1] = index;
    else {
      runs.push([index, index]);
      open = true;
    }
  });
  return runs;
}
