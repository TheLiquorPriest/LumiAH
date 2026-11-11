// The chronicle's tool (DESIGN §24.7): chronicle_check, which reads every citation of the chronicle's
// files back against the chat as the run has it. Worked out by code (`recall/chronicle.ts`); it asks
// no model. It is offered where the run has a chat and the `learned` area the chronicle is kept in.
//
// A citation whose number alone is wrong (the message there doesn't read as cited, and exactly one
// other message does) is written right in the file before anything is said, so the answer is about
// the files as they then stand: it lists what it corrected, the messages no outline line covers,
// and the lines that fail. It writes nothing else: a line that fails is the agent's to fix.
//
// What the check found is the chronicle's as a whole, so it is said once: it leads the page the
// list of problems starts with, and no page after it.

import type { FileChange, JsonObject } from "../ports";
import { CHRONICLE_FILES, type ChatHashes, type ChronicleFile, type ChronicleText, checkChronicle, chronicleFile, correctedText, examineChronicle, readChronicle, uncoveredMessages, uncoveredRuns } from "../recall/chronicle";
import { RECALL_SKILL } from "../recall/definitions";
import { recallOf } from "../recall/recall";
import type { ChronicleMoved } from "../recall/shapes";
import { FAMILY, TEXT, TOOL } from "../texts";
import type { ToolCtx, ToolDefinition, ToolEnv, ToolOutcome } from "../tools";
import { clip, textArg } from "../util";
import { type AreaAccess, type AreaRefusal, showPath, type WorkspaceView } from "../workspace";
import { badCursor, fitted, listPage, pagerOf, readCursor } from "./paging";

/**
 * The share of a page the check's summary may take where it leads the list: half, so the problems
 * have the rest. Fixed, not a setting: it divides one page between the two, and the page's length
 * is the setting (Answer length).
 */
const LEAD_SHARE = 0.5;

/** The outline, as agents write its path: the file whose spans say which messages the chronicle covers. */
const OUTLINE = showPath("learned", CHRONICLE_FILES[0] ?? "");

/**
 * The call's arguments with its cursor, where that is no number, a line long at most: the answer to
 * a cursor no tool gave repeats it, and a cursor a tool gave is far shorter.
 */
function bounded(args: JsonObject, max: number): JsonObject {
  const { cursor } = args;
  if (cursor === undefined || cursor === null || typeof cursor === "number") return args;
  return { ...args, cursor: clip(typeof cursor === "string" ? cursor : JSON.stringify(cursor), max) };
}

/** What became of the wrong numbers of the files a call checked: the files as they stand after, the citations written right, and for each file that couldn't be written how many are left and why. */
interface Corrected {
  files: ChronicleText[];
  done: ChronicleMoved[];
  undone: { path: string; count: number; why: string }[];
  changes: FileChange[];
}

/**
 * Writes right every citation of `files` whose number alone is wrong (`ChronicleCheck.moved`), a
 * file at a time, each on the version that was read: a file written meanwhile is left as it is, and
 * the answer says so. A turn that was stopped changes nothing (the signal is read before the first
 * write), and a file its holder may not write is left alone with the holder's own reason.
 */
async function correct(env: ToolEnv, view: WorkspaceView, learned: AreaAccess, files: readonly ChronicleFile[], chat: ChatHashes, ctx: ToolCtx): Promise<Corrected> {
  const { texts } = env;
  const A = TEXT.recall.answer;
  const out: Corrected = { files: [], done: [], undone: [], changes: [] };
  const { moved } = checkChronicle(files, chat);
  const why = (refusal: AreaRefusal): string => {
    if (refusal.code === "refused") return refusal.reason;
    return texts.render(refusal.code === "stale" || refusal.code === "missing" || refusal.code === "exists" ? A.chronicleStale : A.chronicleNoRoom);
  };
  for (const file of files) {
    const own = moved.filter((move) => move.path === file.path);
    if (own.length === 0) {
      out.files.push(file);
      continue;
    }
    ctx.signal.throwIfAborted();
    const barred = view.guard("learned", file.within);
    const text = correctedText(file, own);
    const result = barred === null ? await learned.write({ path: file.within, text, base: file.version, by: view.author }) : null;
    if (result?.ok) {
      out.files.push({ path: file.path, text });
      out.done.push(...own);
      out.changes.push(...result.changes);
    } else {
      out.files.push(file);
      out.undone.push({ path: file.path, count: own.length, why: barred ?? (result && !result.ok ? why(result.why) : "") });
    }
  }
  return out;
}

const chronicleCheck: ToolDefinition = {
  name: TOOL.chronicleCheck,
  family: FAMILY.chronicle,
  // It writes a citation's number right where only the number is wrong, and nothing else.
  tier: "write",
  build(env: ToolEnv) {
    const { texts } = env;
    const view = env.workspace;
    const learned = view?.areas.learned;
    if (env.run.chatId === "" || !view || !learned) return null;
    const A = TEXT.recall.answer;
    const WORD = TEXT.recall.word;
    const p = pagerOf(env, TOOL.chronicleCheck);
    const { lineChars } = env.settings.tools;
    const numbers = (indices: readonly number[]): string => indices.map((index) => texts.render(TEXT.recall.message, { index: String(index) })).join(", ");
    return {
      name: TOOL.chronicleCheck,
      description: texts.render(TEXT.tool(TOOL.chronicleCheck)),
      parameters: { type: "object", properties: { path: { type: "string", description: texts.render(TEXT.toolArg(TOOL.chronicleCheck, "path")) }, cursor: { type: "string", description: texts.render(TEXT.toolArg(TOOL.chronicleCheck, "cursor")) } } },
      async run(args: JsonObject, ctx: ToolCtx): Promise<ToolOutcome> {
        const given = bounded(args, lineChars);
        const cursor = readCursor(p, given);
        if ("text" in cursor) return cursor;
        const all = await readChronicle(learned);
        if (all.length === 0) return { text: clip(texts.render(A.chronicleNone, { skill: RECALL_SKILL.keep }), p.pageChars) };
        const asked = textArg(args.path);
        const one = asked === null ? undefined : chronicleFile(all, asked);
        if (asked !== null && !one) return { text: fitted(p, all.map((file) => file.path).join(", "), (files) => texts.render(A.chronicleNoFile, { path: clip(asked, lineChars), files })), error: true };
        const chat = await recallOf(env).chat();
        // Numbers are written right on the call that starts the list, where the answer has room to say so: a later page reads the files as that call left them.
        const fixed: Corrected = cursor.at === 0 ? await correct(env, view, learned, one ? [one] : all, chat, ctx) : { files: one ? [one] : all, done: [], undone: [], changes: [] };
        const { check, several } = examineChronicle(fixed.files, chat);
        const { failures, uncited } = check;
        const total = failures.length + uncited.length;

        /** What the check corrected and what it couldn't, within `room` characters: every file it couldn't write, then as many corrected citations as fit. */
        const correctedPart = (room: number): string => {
          const undone = fixed.undone.map((left) => texts.render(A.chronicleUncorrected, { path: left.path, count: texts.counted(left.count, WORD.citation), why: clip(left.why, lineChars) })).join("");
          if (fixed.done.length === 0) return clip(undone, Math.max(0, room));
          const head = (lines: string): string => texts.render(A.chronicleCorrected, { count: texts.counted(fixed.done.length, WORD.citation), corrections: lines });
          const more = (left: number): string => texts.render(A.chronicleCorrectedMore, { count: String(left) });
          const lines: string[] = [];
          let used = head("").length + undone.length;
          for (const [i, move] of fixed.done.entries()) {
            const line = texts.render(A.chronicleCorrection, { path: move.path, line: String(move.line), citation: move.citation, now: String(move.now) });
            const after = fixed.done.length - i - 1;
            if (used + line.length + 1 + (after > 0 ? more(after).length + 1 : 0) > room) break;
            lines.push(line);
            used += line.length + 1;
          }
          if (lines.length < fixed.done.length) lines.push(more(fixed.done.length - lines.length));
          return clip(`${head(lines.join("\n"))}${undone}`, Math.max(0, room));
        };

        /** The messages no outline line covers, within `room` characters; nothing where the call checked one file that isn't the outline. */
        const gapsPart = (room: number): string => {
          if (one && one.path !== OUTLINE) return "";
          const runs = uncoveredRuns(fixed.files, chat);
          if (runs.length === 0) return clip(texts.render(A.chronicleCovered), Math.max(0, room));
          const count = texts.counted(uncoveredMessages(fixed.files, chat).length, WORD.message);
          const said = (list: string): string => texts.render(A.chronicleGaps, { count, runs: list });
          const list = runs.map(([from, to]) => (from === to ? texts.render(TEXT.recall.message, { index: String(from) }) : texts.render(TEXT.recall.span, { from: String(from), to: String(to) }))).join(", ");
          return room <= said("").length ? "" : said(clip(list, room - said("").length));
        };

        const lead = (): string => {
          const verdict = total === 0 ? texts.render(A.chronicleOk) : texts.render(A.chronicleProblems, { count: texts.counted(total, WORD.problem) });
          const said = (files: string, corrected: string, gaps: string): string => texts.render(A.chronicleCheck, { first: String(chat.first?.index ?? 0), last: String(chat.last?.index ?? 0), files, corrected, gaps, verdict });
          const files = check.files.map((file) => texts.render(A.chronicleFile, { path: file.path, lines: texts.counted(file.lines, WORD.line), cited: String(file.cited), failed: String(file.failed) })).join("\n");
          // Alone it is the answer and may fill the page; before the list it leaves the list its share. Clipped whole as well: the texts are the user's, and may be longer than the room.
          const whole = total === 0 ? p.pageChars : Math.floor(p.pageChars * LEAD_SHARE);
          const room = Math.max(1, whole - said("", "", "").length);
          // The files first, in half the room at most; what they leave is the outline's and the corrections', the outline's first since it is the shorter.
          const shown = clip(files, Math.max(1, Math.floor(room / 2)));
          const gaps = gapsPart(Math.floor((room - shown.length) / 2));
          return clip(said(shown, correctedPart(room - shown.length - gaps.length), gaps), whole);
        };
        const outcome = (answer: ToolOutcome): ToolOutcome => (fixed.changes.length > 0 ? { ...answer, files: fixed.changes } : answer);
        if (total === 0) return cursor.given ? badCursor(p, given.cursor) : outcome({ text: lead() });
        const page = (led?: string): ToolOutcome =>
          listPage(p, {
            total,
            noun: WORD.problem,
            cursor,
            ...(led === undefined ? {} : { lead: led }),
            item: (i) => {
              const failure = failures[i];
              if (failure) {
                const others = several[i] ?? [];
                const at = texts.render(failure.why === "gone" ? A.chronicleNoMessage : A.chronicleNotAsCited, { index: String(failure.index) });
                const where = others.length === 0 ? texts.render(A.chronicleNowhere) : texts.render(A.chronicleSeveral, { messages: clip(numbers(others), lineChars) });
                return texts.render(A.chronicleFailure, { path: failure.path, line: String(failure.line), citation: failure.citation, at, where, text: clip(failure.text, lineChars) });
              }
              const bare = uncited[i - failures.length];
              return bare ? texts.render(A.chronicleUncited, { path: bare.path, line: String(bare.line), text: clip(bare.text, lineChars) }) : "";
            },
          });
        if (cursor.at !== 0) return page();
        // A page takes its heading, one item and its footer whatever its length is, so on a very short page the summary's share can push it past Answer length: the summary then gives up what the page is over by, or goes.
        const said = lead();
        const led = page(said);
        const over = led.text.length - p.pageChars;
        if (over <= 0) return outcome(led);
        const less = said.length > over ? page(clip(said, said.length - over)) : page();
        return outcome(less.text.length <= p.pageChars ? less : page());
      },
    };
  },
};

export const CHRONICLE_TOOLS: readonly ToolDefinition[] = [chronicleCheck];
