// The core's answers as the pages take them (DESIGN §8, §25). A page's request for the workspace,
// the jobs, the side sessions, the spend, what is stored, the lore or the chronicle is served by
// the core in the place it belongs to (built in, or the user's runtime: asks.ts), and the core
// answers its own shapes (its harness's, src/core/harness.ts), which are not always the pages'
// (src/shared/ui.ts). Here each answer is read as it came, field by field, and made into the
// page's view, with what the core doesn't hold put in by whoever calls: a chat's name, an agent
// definition's, a connection's, a setting's title.
//
// Built in, the core and the extension are one bundle; a runtime and the extension should be one
// build. So an answer that doesn't read as the core's is another build's runtime: it is refused in
// words that say so, never passed on half read. A reader gives exactly what the core's own type
// says its method answers, so a change of the core's answer fails the build here before it reaches
// a page. Every function here is pure.

import { characterGuidance } from "../../core/guidance";
import type { Harness } from "../../core/harness";
import type { AgentUsage, DefinitionSource, FileAuthor, JobState, JobView, JsonObject, JsonValue, ToolTier, TraceRecord, TurnRecord, TurnStatus, WorkspaceArea } from "../../core/ports";
import type { ChronicleCheck, ChronicleFailure, ChronicleMoved, CitedMessage, EmbedStatus, LoreHitView, LoreListing, LoreRow, LoreSearchView } from "../../core/recall/shapes";
import type { PathTurn } from "../../core/sessions";
import type { Settings } from "../../core/settings";
import type { TurnTranscript } from "../../core/transcript";
import { clip } from "../../core/util";
import { showPath } from "../../core/workspace";
import { isRecord } from "../../link/json";
import type { ApprovalChoice, CauseCode, ChangedFile, ChronicleView, CitedView, DefsView, EmbeddingStatus, FileVersion, GuidanceLevel, GuidanceLevelId, GuidanceView, JobsPage, LastTurn, LiveEndState, LiveView, LoreSearch, LoreView, McpServerView, NoPart, NoPartWhy, RunPlace, SettingPath, SideSession, SideTurn, SpendCap, SpendRow, SpendView, StoredKind, StoryEstimate, StoryView, ToolRow, TurnKind, UpkeepView, WorkspaceFile, WorkspaceView } from "../../shared/ui";
import { loreChangesOf, replyDid } from "../../shared/ui";
import { causeOf } from "./cause";
import { UiRefused } from "./errors";

/** What a page-facing method of the core's harness answers. */
type Answer<G extends keyof Harness, M extends keyof Harness[G]> = Harness[G][M] extends (...args: never[]) => Promise<infer A> ? A : never;

// ---------------------------------------------------------------- reading what crossed

/** An answer that isn't what this build's core gives. Built in, the core is this build's own, so it can only be a runtime's of another build. */
function refuse(what: string): never {
  throw new UiRefused("internal", `The core answered with something that isn't ${what}. If a runtime answered, update the runtime and the extension to the same build.`);
}

/** A value of an answer: JSON, or nothing where a field is absent. */
type Raw = JsonValue | undefined;

const isObject = (v: Raw): v is JsonObject => typeof v === "object" && v !== null && !Array.isArray(v);
const isText = (v: unknown): v is string => typeof v === "string";
const record = (v: Raw, what: string): JsonObject => (isObject(v) ? v : refuse(what));
const list = (v: Raw, what: string): JsonValue[] => (Array.isArray(v) ? v : refuse(what));
const text = (v: Raw, what: string): string => (typeof v === "string" ? v : refuse(what));
const number = (v: Raw, what: string): number => (typeof v === "number" && Number.isFinite(v) ? v : refuse(what));
const flag = (v: Raw, what: string): boolean => (typeof v === "boolean" ? v : refuse(what));
const textOrNull = (v: Raw, what: string): string | null => (v === null ? null : text(v, what));
const numberOrNull = (v: Raw, what: string): number | null => (v === null ? null : number(v, what));

/** One of a union's members, by a table that names every one of them: a member the core adds fails the build at its table. */
function oneOf<T extends string>(v: Raw, among: Readonly<Record<T, unknown>>, what: string): T {
  return typeof v === "string" && Object.hasOwn(among, v) ? (v as T) : refuse(what);
}

const AREAS: Readonly<Record<WorkspaceArea, true>> = { chat: true, learned: true, user: true };
const SOURCES: Readonly<Record<DefinitionSource, true>> = { builtin: true, extension: true, user: true };
const TIERS: Readonly<Record<ToolTier, true>> = { read: true, write: true, external: true };
const JOB_STATES: Readonly<Record<JobState, true>> = { queued: true, running: true, done: true, failed: true, cancelled: true, interrupted: true, off_path: true, spent: true, paused: true };
const TURN_ENDS: Readonly<Record<TurnStatus, true>> = { done: true, failed: true, stopped: true };
const LEVELS: Readonly<Record<GuidanceLevelId, true>> = { user: true, middle: true, chat: true };

/** Things the core names by id and name: the agent definitions an area's files may be pinned for, or a job given to. */
function namedOf(v: Raw, what: string): { id: string; name: string }[] {
  return list(v, what).map((one) => {
    const o = record(one, what);
    return { id: text(o.id, what), name: text(o.name, what) };
  });
}

function authorOf(v: Raw, what: string): FileAuthor {
  const o = record(v, what);
  if (o.who === "user") return { who: "user" };
  if (o.who === "agent" || o.who === "job") return { who: o.who, id: text(o.id, what), role: text(o.role, what) };
  return refuse(what);
}

/** What an agent or a run spent, as the core counts it: its own type is the page's, so it is passed on as it is once it reads as one. */
function isUsage(v: unknown): v is AgentUsage {
  return isRecord(v) && [v.calls, v.toolTurns, v.in, v.cachedIn, v.out, v.reasoningOut, v.ms].every((n) => typeof n === "number") && typeof v.estimated === "boolean";
}

/**
 * A page of `rows` from a place in them: `cursor` is that place as the page before named it (null:
 * the first row), `next` the place after this page (null: it is the last). Null when the cursor is
 * no place in a list.
 */
export function pageOf<T>(rows: readonly T[], cursor: string | null, limit: number): { rows: T[]; next: string | null } | null {
  const from = cursor === null ? 0 : Number(cursor);
  if (!Number.isSafeInteger(from) || from < 0) return null;
  const page = rows.slice(from, from + limit);
  return { rows: page, next: from + page.length < rows.length ? String(from + page.length) : null };
}

// ---------------------------------------------------------------- the workspace (§11)

const A_FILE = "a workspace file";

function fileOf(v: Raw): Answer<"workspace", "read">["file"] {
  const o = record(v, A_FILE);
  return { path: text(o.path, A_FILE), hash: text(o.hash, A_FILE), chars: number(o.chars, A_FILE), at: number(o.at, A_FILE), by: authorOf(o.by, A_FILE), pins: list(o.pins, A_FILE).map((pin) => text(pin, A_FILE)) };
}

/** `lah.ws.list`: an area as the core lists it is the page's own view of it. */
export function areaView(raw: JsonValue): WorkspaceView {
  const what = "an area of the workspace";
  const o = record(raw, what);
  const limits = record(o.limits, what);
  const basis = o.basis === null ? null : record(o.basis, what);
  const core: Answer<"workspace", "list"> = {
    area: oneOf(o.area, AREAS, what),
    files: list(o.files, what).map(fileOf),
    chars: number(o.chars, what),
    limits: { fileChars: number(limits.fileChars, what), files: number(limits.files, what), areaChars: number(limits.areaChars, what), pinChars: number(limits.pinChars, what) },
    agents: namedOf(o.agents, what),
    basis: basis === null ? null : { messageId: text(basis.messageId, what), swipe: number(basis.swipe, what), index: number(basis.index, what) },
  };
  return core;
}

/** A version of a file as the core's index holds it: its body's hash, its length, and when and by whom it was written. */
function versionOf(v: Raw, what: string): Answer<"workspace", "history">["versions"][number] {
  const o = record(v, what);
  return { hash: text(o.hash, what), chars: number(o.chars, what), at: number(o.at, what), by: authorOf(o.by, what) };
}

/** `lah.ws.read`: the file as it stands, and the text of the version asked for, which the page knows by its hash. */
export function fileRead(raw: JsonValue): { file: WorkspaceFile; text: string; version: string } {
  const o = record(raw, A_FILE);
  const core: Answer<"workspace", "read"> = { file: fileOf(o.file), text: text(o.text, A_FILE), version: versionOf(o.version, A_FILE) };
  return { file: core.file, text: core.text, version: core.version.hash };
}

/** `lah.ws.write`, `lah.ws.move` and `lah.ws.pin`: the file as the change left it. */
export function fileChanged(raw: JsonValue): { file: WorkspaceFile } {
  const core: Answer<"workspace", "write"> = { file: fileOf(record(raw, A_FILE).file) };
  return core;
}

/** `workspace.history`'s answer, read. */
export function versionsOf(raw: JsonValue): Answer<"workspace", "history"> {
  const what = "a file's versions";
  return { versions: list(record(raw, what).versions, what).map((one) => versionOf(one, what)) };
}

/**
 * The reply whose turn made a version, among the records on the chat's path (`turns`, oldest
 * first); null where none of them did. The core's version says who wrote it and when, not in which
 * run: a job's is found by the record that lists the job (§15); an agent's by the record whose turn
 * was under way when it was written, which is all a record tells of its agents; and what the user
 * wrote on the page is no turn's.
 */
function madeIn(version: { at: number; by: FileAuthor }, turns: readonly PathTurn[]): FileVersion["turn"] {
  const { at, by } = version;
  if (by.who === "user") return null;
  const turn = by.who === "job" ? turns.findLast((t) => t.record.jobs?.some((job) => job.id === by.id) === true) : turns.findLast((t) => t.record.began !== undefined && t.record.began <= at && at <= t.record.at);
  return turn === undefined ? null : { messageId: turn.messageId, swipe: turn.swipeId, index: turn.index };
}

/** `lah.ws.history`: the versions as the core gives them, newest first, each with the reply whose turn made it. */
export function versionsView(core: Answer<"workspace", "history">, turns: readonly PathTurn[]): { versions: FileVersion[] } {
  return { versions: core.versions.map((version) => ({ hash: version.hash, chars: version.chars, at: version.at, by: version.by, turn: madeIn(version, turns) })) };
}

/** `lah.ws.changes`: a turn's change set as the core gives it. */
export function changesView(raw: JsonValue): { changes: ChangedFile[] } {
  const what = "a turn's change set";
  const core: Answer<"workspace", "changes"> = {
    changes: list(record(raw, what).changes, what).map((one) => {
      const o = record(one, what);
      return { area: oneOf(o.area, AREAS, what), path: text(o.path, what), before: textOrNull(o.before, what), after: textOrNull(o.after, what), by: authorOf(o.by, what) };
    }),
  };
  return core;
}

// ---------------------------------------------------------------- guidance (§12)

type CoreLevel = Answer<"guidance", "get">["levels"][number];

/** `guidance.get`'s and `guidance.set`'s answer, read. */
export function guidanceOf(raw: JsonValue): Answer<"guidance", "get"> {
  const what = "the guidance";
  const o = record(raw, what);
  return {
    levels: list(o.levels, what).map((one): CoreLevel => {
      const level = record(one, what);
      return {
        id: oneOf(level.id, LEVELS, what),
        whose: text(level.whose, what),
        text: text(level.text, what),
        path: textOrNull(level.path, what),
        hash: textOrNull(level.hash, what),
        at: numberOrNull(level.at, what),
        by: level.by === null ? null : authorOf(level.by, what),
        editable: flag(level.editable, what),
        ...(level.locked !== undefined ? { locked: text(level.locked, what) } : {}),
      };
    }),
    limit: number(o.limit, what),
    agentsEdit: flag(o.agentsEdit, what),
  };
}

/** A chat's character: its id, which its guidance file is kept under, and its name where Lumiverse gives one. */
export interface ChatCharacter {
  id: string;
  name: string | null;
}

/** What a level is for, led by where its file is when it is one. */
function noted(path: string | null, words: string): string {
  return path === null ? words.replace(/^./, (first) => first.toUpperCase()) : `${path}: ${words}`;
}

/**
 * Whose a level is and what it is for, in the page's words. The core says whose it is as an agent
 * is told, and where its file is. The middle level is the character's while its file is the one
 * kept for the chat's character (`character`: null for a chat with none); any other was named in
 * the character's place by an extension that answers the chat, by the words agents hear it under.
 */
function levelWords(level: CoreLevel, character: ChatCharacter | null): { label: string; note: string } {
  if (level.id === "user") return { label: "Yours", note: noted(level.path, "every agent of every chat of yours is given it.") };
  if (level.id === "chat") return { label: "This chat's", note: noted(level.path, "kept with this chat, whatever path its story takes.") };
  if (character !== null && level.path === showPath("user", characterGuidance(character.id))) {
    const name = character.name !== null && character.name.trim() !== "" ? character.name : null;
    return name === null ? { label: "The character's", note: noted(level.path, "every chat of yours with this chat's character is given it.") } : { label: `${name}'s`, note: noted(level.path, `every chat of yours with ${name} is given it.`) };
  }
  return { label: "The extension's", note: noted(level.path, `named by the extension that answers this chat, in the character's place. Agents are told it is guidance ${level.whose}.`) };
}

/** `lah.guidance.get` and `lah.guidance.set`: the levels in the order they are given, each named in the page's words. */
export function guidanceView(core: Answer<"guidance", "get">, character: ChatCharacter | null): GuidanceView {
  return {
    levels: core.levels.map((level): GuidanceLevel => ({ id: level.id, ...levelWords(level, character), text: level.text, hash: level.hash, at: level.at, by: level.by, editable: level.editable, ...(level.locked !== undefined ? { locked: level.locked } : {}) })),
    limit: core.limit,
    agentsEdit: core.agentsEdit,
  };
}

// ---------------------------------------------------------------- definitions (§13)

type Defs = Answer<"definitions", "get">;

/** Where a definition comes from and how it stands, as the core says it of each. */
function isSourced(o: Readonly<Record<string, unknown>>): boolean {
  return isText(o.source) && Object.hasOwn(SOURCES, o.source) && typeof o.off === "boolean" && (o.over === undefined || o.over === "builtin" || o.over === "extension");
}

/** An agent definition with where it comes from. The core's type is the page's, so one is passed on as it is once it reads as one. */
function isAgent(v: unknown): v is Defs["agents"][number] {
  if (!isRecord(v) || !isSourced(v)) return false;
  const runsWith = (v.connectionId === null || isText(v.connectionId)) && (v.model === null || isText(v.model)) && isText(v.effort) && isText(v.toolCalls) && Array.isArray(v.tools) && v.tools.every(isText) && isRecord(v.budget);
  return runsWith && isText(v.id) && isText(v.name) && isText(v.description) && isText(v.instructions) && (v.given === "request" || v.given === "task");
}

/** A skill with where it comes from, passed on as an agent definition is. */
function isSkill(v: unknown): v is Defs["skills"][number] {
  return isRecord(v) && isSourced(v) && isText(v.id) && isText(v.name) && isText(v.description) && isText(v.body);
}

function toolOf(v: Raw): Defs["tools"][number] {
  const what = "a tool";
  const o = record(v, what);
  return {
    name: text(o.name, what),
    family: text(o.family, what),
    tier: oneOf(o.tier, TIERS, what),
    description: text(o.description, what),
    ...(o.parameters !== undefined ? { parameters: record(o.parameters, what) } : {}),
    runs: o.runs === "runtime" || o.runs === "extension" ? o.runs : refuse(what),
    source: oneOf(o.source, SOURCES, what),
    off: flag(o.off, what),
  };
}

/** What a tool's calls do (§17), as the user's settings say: each tier's choice, and the tools that have one of their own. */
export interface Approvals {
  tiers: Readonly<Record<ToolTier, ApprovalChoice>>;
  tools: Readonly<Record<string, ApprovalChoice>>;
}

/**
 * `lah.defs.get`: every definition as the core merged them for the user, each tool with what its
 * calls do (`approval`), and the MCP servers, which the extension lists (`mcp`). What a new agent
 * starts from is the page's to put in a form, so it goes on as the JSON it crossed as.
 */
export function defsView(raw: JsonValue, approval: Approvals, mcp: McpServerView[]): DefsView {
  const what = "the definitions";
  const o = record(raw, what);
  return {
    agents: list(o.agents, what).map((one: unknown) => (isAgent(one) ? one : refuse("an agent definition"))),
    skills: list(o.skills, what).map((one: unknown) => (isSkill(one) ? one : refuse("a skill"))),
    tools: list(o.tools, what).map((one): ToolRow => {
      const tool = toolOf(one);
      const own = Object.hasOwn(approval.tools, tool.name) ? (approval.tools[tool.name] ?? null) : null;
      return { ...tool, approval: own, asks: (own ?? approval.tiers[tool.tier]) === "ask" };
    }),
    mcp,
    agentSchema: record(o.agentSchema, what),
    agentDefaults: record(o.agentDefaults, what),
    tiers: { ...approval.tiers },
  };
}

/** The agent definitions' names by id, from `definitions.get`'s answer: what names an agent wherever the core gives its definition's id alone. */
export function agentNames(raw: JsonValue): Map<string, string> {
  const what = "the definitions";
  return new Map(namedOf(record(raw, what).agents, what).map((agent) => [agent.id, agent.name]));
}

// ---------------------------------------------------------------- jobs (§15)

/** A job as the core gives it. Its type is the page's, so one is passed on as it is once it reads as one. */
function isJob(v: unknown): v is JobView {
  if (!isRecord(v) || !isRecord(v.by)) return false;
  const what = isText(v.id) && isText(v.chatId) && isText(v.agent) && isText(v.task) && (v.when === "now" || v.when === "after_reply");
  return what && isText(v.state) && Object.hasOwn(JOB_STATES, v.state) && (v.by.who === "user" || v.by.who === "agent") && (v.basis === null || isText(v.basis)) && typeof v.createdAt === "number" && isUsage(v.usage);
}

/** The job a request about one was answered with: `jobs.start`, `jobs.again`, `jobs.cancel` and `jobs.grant` answer it, and so does the runtime's `job.resume`, with the job as read. */
export function jobOf(raw: JsonValue): JobView {
  const job: unknown = isObject(raw) ? raw.job : undefined;
  return isJob(job) ? job : refuse("a job");
}

/** `jobs.list`'s answer, read. */
export function jobsOf(raw: JsonValue): Answer<"jobs", "list"> {
  const what = "a page of jobs";
  const o = record(raw, what);
  return {
    jobs: list(o.jobs, what).map((one: unknown) => (isJob(one) ? one : refuse("a job"))),
    next: textOrNull(o.next, what),
    today: { tokens: number(record(o.today, what).tokens, what) },
    agents: namedOf(o.agents, what),
    paused: flag(o.paused, what),
  };
}

/**
 * `lah.jobs.list`: the core's page with the limits Settings put on jobs (`limits`: the core's own
 * section on jobs). The core doesn't count the jobs there are in all, so `total` is how many are
 * known of: those on the pages before this one (`cursor`: the place in the list the core named
 * this page by) and this page's, which is all of them on the last page.
 */
export function jobsPage(core: Answer<"jobs", "list">, limits: Settings["jobs"], cursor: string | null): JobsPage {
  const before = cursor === null ? 0 : Number(cursor);
  const { tokensIn, tokensOut, wallMs } = limits.budget;
  return {
    jobs: core.jobs,
    next: core.next,
    total: (Number.isSafeInteger(before) && before > 0 ? before : 0) + core.jobs.length,
    // The page shows one figure for a job's tokens: what it may send and what it may write, together; none where neither is bounded.
    limits: { atOnce: limits.atOnce, tokensPerJob: tokensIn === null && tokensOut === null ? null : (tokensIn ?? 0) + (tokensOut ?? 0), msPerJob: wallMs, tokensPerDay: limits.tokensPerDay },
    today: core.today,
    agents: core.agents,
  };
}

// ---------------------------------------------------------------- side sessions (§19)

type CoreSide = Answer<"sides", "start">["side"];

function sideOf(v: Raw): CoreSide {
  const what = "a side session";
  const o = record(v, what);
  return { id: text(o.id, what), chatId: text(o.chatId, what), agent: text(o.agent, what), title: text(o.title, what), createdAt: number(o.createdAt, what), lastAt: number(o.lastAt, what), turns: number(o.turns, what) };
}

/** `sides.list`'s answer, read. */
export function sidesOf(raw: JsonValue): Answer<"sides", "list"> {
  const what = "the side sessions";
  return { sides: list(record(raw, what).sides, what).map(sideOf) };
}

/** `sides.start`'s answer, read. */
export function sideStartedOf(raw: JsonValue): Answer<"sides", "start"> {
  return { side: sideOf(record(raw, "a side session").side) };
}

/** `sides.turns`'s answer, read. */
export function sideTurnsOf(raw: JsonValue): Answer<"sides", "turns"> {
  const what = "a side session's turns";
  const o = record(raw, what);
  return {
    side: sideOf(o.side),
    turns: list(o.turns, what).map((one) => {
      const turn = record(one, what);
      const usage: unknown = turn.usage;
      return {
        turn: text(turn.turn, what),
        at: number(turn.at, what),
        asked: text(turn.asked, what),
        answered: textOrNull(turn.answered, what),
        status: oneOf(turn.status, TURN_ENDS, what),
        ...(turn.reason !== undefined ? { reason: text(turn.reason, what) } : {}),
        ...(turn.segment !== undefined ? { segment: text(turn.segment, what) } : {}),
        ...(turn.transcript !== undefined ? { transcript: text(turn.transcript, what) } : {}),
        usage: isUsage(usage) ? usage : refuse(what),
      };
    }),
  };
}

/** The runtime's `side.send`: the turn it started, by its id. */
export function turnStarted(raw: JsonValue): string {
  const turn: Raw = isObject(raw) ? raw.turn : undefined;
  return typeof turn === "string" && turn !== "" ? turn : refuse("the turn it started");
}

/** A side session's turn the core hasn't kept yet (it keeps a turn once it has ended): its id, what the user said, and when. */
export interface UnkeptTurn {
  turn: string;
  said: string;
  at: number;
}

/** What a list calls a side session nothing was said in yet. */
const NEW_TALK = "New conversation";

/**
 * A side session as the pages list it: the core's row with its agent's name (`names`: the agent
 * definitions' by id; a definition that is gone goes by its id), and about no chat where the core
 * says "". While a turn of it is known that the core hasn't kept yet (`unkept`), that turn counts:
 * it is one turn more and when the session was last used, and what was said in it titles a session
 * that has no title yet, as the core will title it once it keeps the turn (how its first message
 * opens, on one line, in `titleChars` characters at most: the core's setting for it).
 */
export function sideSession(row: CoreSide, names: ReadonlyMap<string, string>, unkept: Pick<UnkeptTurn, "said" | "at"> | null, titleChars: number): SideSession {
  const title = row.title !== "" || unkept === null ? row.title : clip(unkept.said.replace(/\s+/g, " ").trim(), titleChars);
  return {
    id: row.id,
    agent: row.agent,
    agentName: names.get(row.agent) ?? row.agent,
    chatId: row.chatId === "" ? null : row.chatId,
    title: title !== "" ? title : NEW_TALK,
    createdAt: row.createdAt,
    lastAt: unkept === null ? row.lastAt : Math.max(row.lastAt, unkept.at),
    turns: row.turns + (unkept === null ? 0 : 1),
  };
}

/**
 * `lah.side.turns`: a side session's turns, newest first. The core gives those it keeps, each as
 * it ended; the one it hasn't kept yet (`unkept`) leads them, with how its run stands: under way,
 * or lost with its runtime.
 */
export function sideTurns(kept: Answer<"sides", "turns">["turns"], unkept: (UnkeptTurn & { state: "running" | "lost" }) | null): SideTurn[] {
  const turns = kept.map((turn): SideTurn => ({ turn: turn.turn, at: turn.at, said: turn.asked, answer: turn.answered, state: turn.status, transcript: turn.transcript ?? null, usage: turn.usage })).reverse();
  return unkept === null ? turns : [{ turn: unkept.turn, at: unkept.at, said: unkept.said, answer: null, state: unkept.state, transcript: null, usage: null }, ...turns];
}

// ---------------------------------------------------------------- spend and what is stored (§20)

/** The user's settings as a view names one of the core's by: the key the core's sit under, the schema the Settings page is built from, and the values as they stand. */
export interface SettingsNow {
  coreKey: string;
  schema: JsonObject;
  values: JsonObject;
}

/** One of the core's settings as a page leads to it and names it: its place from the settings' root, its title on the Settings page, its unit, what the page says where it holds none, and what it holds. */
interface Setting {
  path: SettingPath;
  title: string;
  unit: string | null;
  none: string;
  value: Raw;
}

/** A setting of the core's by its place in the core's own section. One this build's settings don't have is named by that place. */
function settingOf(settings: SettingsNow, setting: readonly string[]): Setting {
  const path = [settings.coreKey, ...setting];
  let schema: Raw = settings.schema;
  let value: Raw = settings.values;
  for (const key of path) {
    const properties: Raw = isObject(schema) ? schema.properties : undefined;
    schema = isObject(properties) && Object.hasOwn(properties, key) ? properties[key] : undefined;
    value = isObject(value) && Object.hasOwn(value, key) ? value[key] : undefined;
  }
  const node = isObject(schema) ? schema : {};
  return { path, title: isText(node.title) ? node.title : setting.join("."), unit: isText(node["x-unit"]) ? node["x-unit"] : null, none: isText(node["x-none"]) ? node["x-none"] : "No limit", value };
}

type Spend = Answer<"spend", "get">;
type CoreRow = Spend["total"];

const CAP_UNITS: Readonly<Record<Spend["caps"][number]["unit"], true>> = { tokens: true, usd: true };

function spendRowOf(v: Raw): CoreRow {
  const what = "a row of spend";
  const o = record(v, what);
  return { key: text(o.key, what), calls: number(o.calls, what), in: number(o.in, what), cachedIn: number(o.cachedIn, what), out: number(o.out, what), cost: number(o.cost, what), unpriced: number(o.unpriced, what) };
}

/** `spend.get`'s answer, read. */
export function spendOf(raw: JsonValue): Spend {
  const what = "the spend";
  const o = record(raw, what);
  const rows = (v: Raw): CoreRow[] => list(v, what).map(spendRowOf);
  return {
    days: rows(o.days),
    chats: rows(o.chats),
    agents: rows(o.agents),
    connections: rows(o.connections),
    models: rows(o.models),
    total: spendRowOf(o.total),
    caps: list(o.caps, what).map((one) => {
      const cap = record(one, what);
      return { setting: list(cap.setting, what).map((key) => text(key, what)), unit: oneOf(cap.unit, CAP_UNITS, what), limit: numberOrNull(cap.limit, what), used: number(cap.used, what), reached: flag(cap.reached, what) };
    }),
  };
}

/** The names a spend's rows go by, each by the row's key: a chat's (null: the chat is gone), an agent definition's and a connection's. */
export interface SpendNames {
  chats: ReadonlyMap<string, string | null>;
  agents: ReadonlyMap<string, string>;
  connections: ReadonlyMap<string, string>;
}

/** How much of an id tells two things apart where there is no name to go by: what the pages show of a chat without one. */
const ID_CHARS = 8;

function chatLabel(chatId: string, names: SpendNames["chats"]): string {
  // A side session about no chat spends under none.
  if (chatId === "") return "No chat";
  const name = names.get(chatId);
  if (name === null) return `A chat that is gone (${chatId.slice(0, ID_CHARS)})`;
  return name !== undefined && name.trim() !== "" ? name : `Chat ${chatId.slice(0, ID_CHARS)}`;
}

/**
 * `lah.spend.get`: the core's sums, each row named. A day and a model go by their own keys; a chat,
 * an agent definition and a connection by the names looked up for them; a cap by the setting that
 * holds it, as the Settings page titles it and where that page finds it.
 */
export function spendView(core: Spend, names: SpendNames, settings: SettingsNow): SpendView {
  const rows = (of: readonly CoreRow[], label: (key: string) => string): SpendRow[] => of.map((row) => ({ ...row, label: label(row.key) }));
  const days = core.days.length;
  return {
    days: rows(core.days, (day) => day),
    chats: rows(core.chats, (chatId) => chatLabel(chatId, names.chats)),
    agents: rows(core.agents, (id) => names.agents.get(id) ?? (id !== "" ? id : "An agent with no name")),
    connections: rows(core.connections, (id) => names.connections.get(id) ?? `A connection that is gone (${id.slice(0, ID_CHARS)})`),
    models: rows(core.models, (model) => model),
    total: { ...core.total, label: days === 1 ? "Today" : `The last ${days} days` },
    caps: core.caps.map((cap): SpendCap => {
      const { path, title } = settingOf(settings, cap.setting);
      return { path, label: title, unit: cap.unit, limit: cap.limit, used: cap.used, reached: cap.reached };
    }),
  };
}

type Upkeep = Answer<"upkeep", "get">;

/** Each kind of thing the core stores, as the Storage page names it. Keyed by the core's own kinds, so one it adds has no name here until the build gives it one. */
const KIND_LABELS: Readonly<Record<Upkeep["kinds"][number]["kind"], string>> = {
  segment: "Turns' notes",
  summary: "Summaries",
  transcript: "Transcripts",
  prompt: "Prompts",
  index: "Workspace indexes",
  file: "Workspace file versions",
  report: "Job reports",
  session: "Jobs' sessions",
  side: "Conversations with agents",
};

/** `upkeep.get`'s and `upkeep.sweep`'s answer, read. */
export function upkeepOf(raw: JsonValue): Upkeep {
  const what = "what is stored";
  const o = record(raw, what);
  const total = record(o.total, what);
  const loose = o.loose === null ? null : record(o.loose, what);
  const last = o.lastSweep === null ? null : record(o.lastSweep, what);
  return {
    kinds: list(o.kinds, what).map((one) => {
      const kind = record(one, what);
      return { kind: oneOf(kind.kind, KIND_LABELS, what), count: number(kind.count, what), bytes: number(kind.bytes, what), oldestAt: numberOrNull(kind.oldestAt, what), keep: kind.keep === null ? null : list(kind.keep, what).map((key) => text(key, what)) };
    }),
    total: { count: number(total.count, what), bytes: number(total.bytes, what) },
    loose: loose === null ? null : { count: number(loose.count, what), bytes: number(loose.bytes, what), at: number(loose.at, what) },
    lastSweep: last === null ? null : { at: number(last.at, what), removed: number(last.removed, what), bytes: number(last.bytes, what), ms: number(last.ms, what) },
    sweeping: flag(o.sweeping, what),
  };
}

/** The settings' units of time, for one of each: a schema names a unit for several ("days"). */
const ONE_OF: Readonly<Record<string, string>> = { days: "day", hours: "hour" };

/** How long a setting keeps something, in words: its number with its unit, or what the Settings page says of it where it holds none. */
function keptWords(setting: Setting): string {
  const { value, unit } = setting;
  if (typeof value !== "number") return value === null ? setting.none : "As Settings say";
  if (unit === null) return String(value);
  return `${value} ${value === 1 && Object.hasOwn(ONE_OF, unit) ? ONE_OF[unit] : unit}`;
}

/** `lah.upkeep.get` and `lah.upkeep.sweep`: what is stored, each kind named, with the setting that says how long it is kept and what that setting holds now. */
export function upkeepView(core: Upkeep, settings: SettingsNow): UpkeepView {
  return {
    kinds: core.kinds.map((kind): StoredKind => {
      const setting = kind.keep === null ? null : settingOf(settings, kind.keep);
      return { kind: kind.kind, label: KIND_LABELS[kind.kind], count: kind.count, bytes: kind.bytes, kept: setting === null ? null : { path: setting.path, words: keptWords(setting) }, oldestAt: kind.oldestAt };
    }),
    total: core.total,
    loose: core.loose,
    lastSweep: core.lastSweep,
    sweeping: core.sweeping,
  };
}

// ---------------------------------------------------------------- lore and the chronicle (§24)
//
// For these the core's shapes are the pages' own (src/shared/ui.ts names them), so an answer is
// passed on as it is once it reads as one: what holds it together is checked, each row by the
// fields that make it one, and the rest is the core's to fill.

const isCount = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);

/** Every member of a list reads as one of `T`. */
function listOf<T>(v: unknown, is: (one: unknown) => one is T): v is T[] {
  return Array.isArray(v) && v.every(is);
}

const isBook = (v: unknown): v is LoreListing["books"][number] => isRecord(v) && isText(v.id) && isText(v.name) && isCount(v.entries);
const isLoreRow = (v: unknown): v is LoreRow => isRecord(v) && isText(v.entryId) && isText(v.short) && isText(v.bookId) && isText(v.title) && Array.isArray(v.keys) && isCount(v.chars) && isText(v.state);
const isLastTurn = (v: unknown): v is LoreListing["last"] => v === null || (isRecord(v) && isText(v.generationId) && isCount(v.at));
// `pendingTokens` (what the texts still to embed come to) is checked with the rest, so the page's own type holds whichever build's core answered.
const isEmbedding = (v: unknown): v is EmbeddingStatus => isRecord(v) && (v.connection === null || isRecord(v.connection)) && typeof v.enabled === "boolean" && isRecord(v.lore) && isRecord(v.messages) && isCount(v.pending) && isCount(v.pendingTokens) && typeof v.working === "boolean" && isRecord(v.today) && isRecord(v.all);

/** `lah.lore.get`: a chat's books and entries, each entry with its state for the last turn, and search by meaning as it stands (`recall.lore`). */
export function loreView(raw: JsonValue): LoreView {
  const what = "a chat's lore";
  const { books, entries, last, embedding }: Readonly<Record<string, unknown>> = record(raw, what);
  if (!listOf(books, isBook) || !listOf(entries, isLoreRow) || !isLastTurn(last) || !isEmbedding(embedding)) return refuse(what);
  const core: Answer<"recall", "lore"> = { books, entries, last, embedding };
  return { ...core, embedding };
}

/** `lah.lore.entry`: one entry's row and its text (`recall.entry`). */
export function loreEntry(raw: JsonValue): { entry: LoreRow; text: string } {
  const what = "a lore entry";
  const { entry, text: body }: Readonly<Record<string, unknown>> = record(raw, what);
  if (!isLoreRow(entry) || !isText(body)) return refuse(what);
  const core: Answer<"recall", "entry"> = { entry, text: body };
  return core;
}

const isHit = (v: unknown): v is LoreHitView => isRecord(v) && isText(v.entryId) && isText(v.short) && isText(v.title) && isCount(v.score) && Array.isArray(v.lines);
const isFound = (v: unknown): v is LoreSearchView["queries"][number] => isRecord(v) && isText(v.query) && isCount(v.total) && listOf(v.hits, isHit);
const MEANING: Readonly<Record<LoreSearchView["meaning"], true>> = { on: true, off: true, none: true };

/** `lah.lore.search`: each query with its hits, as the agents' own `lore_search` finds them (`recall.search`). */
export function loreSearch(raw: JsonValue): LoreSearch {
  const what = "what a lore search found";
  const o = record(raw, what);
  const { queries }: Readonly<Record<string, unknown>> = o;
  if (!listOf(queries, isFound)) return refuse(what);
  const core: Answer<"recall", "search"> = { queries, meaning: oneOf(o.meaning, MEANING, what) };
  return core;
}

/** `lah.lore.embed`: search by meaning as it stands for a chat (`recall.embed`). */
export function embeddingView(raw: JsonValue): { embedding: EmbeddingStatus } {
  const what = "how search by meaning stands";
  const { embedding }: Readonly<Record<string, unknown>> = record(raw, what);
  if (!isEmbedding(embedding)) return refuse(what);
  const core: Answer<"recall", "embed"> = { embedding };
  return { ...core, embedding };
}

const isLine = (v: unknown): v is Record<string, unknown> & { path: string; line: number } => isRecord(v) && isText(v.path) && isCount(v.line);
const isChronicleFile = (v: unknown): v is ChronicleCheck["files"][number] => isRecord(v) && isText(v.path) && isCount(v.chars) && isCount(v.lines) && isCount(v.cited) && isCount(v.failed);
const isFailure = (v: unknown): v is ChronicleFailure => isLine(v) && isText(v.text) && isText(v.citation) && isCount(v.index) && (v.why === "gone" || v.why === "changed");
const isMoved = (v: unknown): v is ChronicleMoved => isLine(v) && isText(v.citation) && isCount(v.index) && isCount(v.now);
const isUncited = (v: unknown): v is ChronicleCheck["uncited"][number] => isLine(v) && isText(v.text);

/** `lah.chronicle.get`: the chronicle as the check finds it (`recall.chronicle`). */
export function chronicleView(raw: JsonValue): ChronicleView {
  const what = "a chat's chronicle";
  const { files, failures, moved, uncited }: Readonly<Record<string, unknown>> = record(raw, what);
  if (!listOf(files, isChronicleFile) || !listOf(failures, isFailure) || !listOf(moved, isMoved) || !listOf(uncited, isUncited)) return refuse(what);
  const core: Answer<"recall", "chronicle"> = { files, failures, moved, uncited };
  return core;
}

const isCited = (v: unknown): v is CitedMessage => isRecord(v) && isCount(v.index) && typeof v.ok === "boolean" && (v.message === null || (isRecord(v.message) && isText(v.message.text)));

/** `lah.chronicle.cited`: the messages citations name, in the order asked (`recall.cited`). */
export function citedView(raw: JsonValue): { cited: CitedView[] } {
  const what = "the messages a chronicle cites";
  const { cited }: Readonly<Record<string, unknown>> = record(raw, what);
  if (!listOf(cited, isCited)) return refuse(what);
  const core: Answer<"recall", "cited"> = { cited };
  return core;
}

// ---------------------------------------------------------------- learning a story (§22)

/** `recall.story`'s answer as read here: the core's status, with what the rest of the story is expected to take (the core's own estimate). */
export type StoryRead = Answer<"recall", "story"> & { estimate: StoryEstimate };

/** `recall.story`'s answer, read: how far the learning has come, what to start one with, and what the rest is expected to take (the core's own estimate, passed on as it is). */
export function storyOf(raw: JsonValue): StoryRead {
  const what = "how far a story's learning has come";
  const o = record(raw, what);
  const suggested = record(o.suggested, what);
  const e = record(o.estimate, what);
  const estimate: StoryEstimate = {
    messages: number(e.messages, what),
    chars: number(e.chars, what),
    stretches: number(e.stretches, what),
    promptTokens: number(e.promptTokens, what),
    cachedTokens: number(e.cachedTokens, what),
    writtenTokens: number(e.writtenTokens, what),
    weighedTokens: number(e.weighedTokens, what),
    toolTurns: number(e.toolTurns, what),
    usd: numberOrNull(e.usd, what),
  };
  return { plan: textOrNull(o.plan, what), messages: number(o.messages, what), covered: number(o.covered, what), suggested: { task: text(suggested.task, what), agent: text(suggested.agent, what) }, estimate };
}

/**
 * `lah.story.get`: the core's status with what it doesn't hold. `job`: the job the backend
 * remembers as the learning of the chat's story, as the core has it now (null: none was started).
 * The budget a page offers is sized from the core's estimate by the page; the backend suggests none.
 */
export function storyView(core: StoryRead, job: JobView | null): StoryView {
  return { ...core, job };
}

// ---------------------------------------------------------------- the tools approved for a chat (§17)

/** `approvals.kept`'s and `approvals.forget`'s answer, read: the tools the user approved "for this chat", each with its chat and when (null: kept before the time was). */
export function keptOf(raw: JsonValue): { chatId: string; tool: string; at: number | null }[] {
  const what = "the tools you approved for a chat";
  return list(record(raw, what).kept, what).map((one) => {
    const row = record(one, what);
    return { chatId: text(row.chatId, what), tool: text(row.tool, what), at: numberOrNull(row.at, what) };
  });
}

// ---------------------------------------------------------------- home: a chat's latest turn

/**
 * Where a turn ran and, where LumiAH had no part in its reply, why (DESIGN §25): what the
 * extension writes beside the core's record on the reply's message (`ran`). Empty for a record made
 * before there were two places.
 */
export interface Ran {
  place?: RunPlace;
  noPart?: NoPart;
}

const NO_PART_WHYS: Readonly<Record<NoPartWhy, true>> = { failed: true, time: true, stopped: true };
const isWhy = (v: unknown): v is NoPartWhy => typeof v === "string" && Object.hasOwn(NO_PART_WHYS, v);

/** What a reply's record says of where its turn ran, read from the record as it is stored: the core's own reader keeps the core's fields alone. */
export function ranOf(anchor: unknown): Ran {
  const ran: unknown = isRecord(anchor) ? anchor.ran : undefined;
  if (!isRecord(ran)) return {};
  const noPart: unknown = ran.noPart;
  return {
    ...(ran.place === "builtin" || ran.place === "runtime" ? { place: ran.place } : {}),
    ...(isRecord(noPart) && isWhy(noPart.why) && isText(noPart.text) ? { noPart: { why: noPart.why, text: noPart.text } } : {}),
  };
}

/**
 * What a run's events come to, as the first screen counts them: what the run has spent so far,
 * the agents that worked, the tool calls they made, the lore entries the main agent added to and
 * dropped from what the writer saw (§24.3), the workspace files changed, the jobs started, and, for
 * a built-in reply's turn, when its time before the reply ends.
 */
export interface RunCounts {
  usage: AgentUsage | null;
  agents: number;
  tools: number;
  lore: { added: number; dropped: number };
  changes: number;
  jobs: number;
  replyBy: number | null;
}

/**
 * A run's events, counted. The one way a run is counted: its live view while it runs and its
 * stored transcript afterwards hold the same events, so both say the same of it. Events are read
 * by shape past their kind, since a stored transcript may come from an earlier build.
 */
export function runCounts(events: readonly TraceRecord[]): RunCounts {
  let usage: AgentUsage | null = null;
  let replyBy: number | null = null;
  let agents = 0;
  let tools = 0;
  let lore = { added: 0, dropped: 0 };
  const files = new Set<string>();
  const jobs = new Set<string>();
  for (const { event } of events) {
    if (event.kind === "turn_started") {
      if (typeof event.replyBy === "number") replyBy = event.replyBy;
    } else if (event.kind === "agent_started") agents += 1;
    else if (event.kind === "agent_entry") {
      const { entry } = event;
      // A call counts once the model has made it, whether or not its result is back yet.
      if (entry.kind === "answer") tools += Array.isArray(entry.calls) ? entry.calls.length : 0;
      else if (entry.kind === "result") {
        // A file written twice in a run is one file changed.
        for (const file of Array.isArray(entry.files) ? entry.files : []) files.add(`${file.area}\u0000${file.path}`);
        // What the writer saw is what the last `write_reply` left it: an earlier brief's lore gave way to it.
        const changed = loreChangesOf(entry);
        if (changed !== null) lore = { added: changed.added.length, dropped: changed.dropped.length };
      }
    } else if (event.kind === "usage") usage = event.turn;
    else if (event.kind === "job") jobs.add(event.job.id);
    else if (event.kind === "turn_ended") usage = event.usage;
  }
  return { usage, agents, tools, lore, changes: files.size, jobs: jobs.size, replyBy };
}

/** A reply's turn once it has left its record: the message the reply is on, and the transcript the record names (null: none is kept). */
export interface KeptReply {
  messageId: string;
  transcript: string | null;
}

/**
 * `lah.home.get`: a chat's latest turn from its run in the live buffer (`view`: the run whole,
 * `kind`: the generation it answers). `kept`: what its record says once it has left one; until
 * then the message is the one the run targets, and there is no transcript to open.
 */
export function lastOfLive(view: LiveView, kind: TurnKind, kept: KeptReply | null): LastTurn {
  const counts = runCounts(view.events);
  return {
    turn: view.turn,
    kind,
    messageId: kept?.messageId ?? view.messageId,
    startedAt: view.startedAt,
    ended: view.ended,
    // A view that names no place is of a run from before there were two: a runtime's.
    place: view.place ?? "runtime",
    replyBy: view.replyBy ?? counts.replyBy,
    usage: counts.usage,
    agents: counts.agents,
    tools: counts.tools,
    lore: counts.lore,
    changes: counts.changes,
    jobs: counts.jobs,
    transcript: kept?.transcript ?? null,
    did: replyDid(view.events),
  };
}

/**
 * The same from the record on the reply's message, once the live buffer no longer holds the run:
 * the record, where its turn ran (`ran`), and the transcript it names (`stored`; null: none is kept,
 * or it is no longer stored). The counts are the transcript's events counted as a live run's are.
 * With no transcript there is nothing to count the agents, the tool calls and the lore from, so
 * those read 0; the record itself still says how many files its change set names and which jobs
 * it started, and how a reply LumiAH had no part in ended is told from why it had none.
 */
export function lastOfRecord(reply: { messageId: string; record: TurnRecord; ran: Ran }, stored: TurnTranscript | null): LastTurn {
  const { record, ran } = reply;
  const counts = stored === null ? null : runCounts(stored.events);
  const state: LiveEndState = stored?.ended.status ?? (ran.noPart === undefined ? "done" : ran.noPart.why === "failed" ? "failed" : "stopped");
  const reason = stored?.ended.reason;
  // Why, as a code a page can act on, where the reply was Lumiverse's own or its turn failed: read from the transcript, as the live view read it from the same events while the run was there.
  const cause: CauseCode | null = ran.noPart?.why === "time" ? "time" : stored !== null && (ran.noPart !== undefined || state === "failed") ? causeOf(stored.events) : null;
  return {
    turn: record.generationId,
    kind: record.kind,
    messageId: reply.messageId,
    startedAt: stored?.startedAt ?? record.began ?? record.at,
    ended: { state, at: stored?.ended.at ?? record.at, ...(reason !== undefined ? { reason } : {}), ...(ran.noPart !== undefined ? { noPart: ran.noPart } : {}), ...(cause !== null ? { cause } : {}) },
    // A record that names no place was made before there were two: in a runtime.
    place: ran.place ?? "runtime",
    replyBy: counts?.replyBy ?? null,
    usage: record.usage,
    agents: counts?.agents ?? 0,
    tools: counts?.tools ?? 0,
    lore: counts?.lore ?? { added: 0, dropped: 0 },
    changes: counts?.changes ?? record.changed ?? 0,
    jobs: counts?.jobs ?? record.jobs?.length ?? 0,
    transcript: stored === null ? null : (record.transcript ?? null),
    ...(stored !== null ? { did: replyDid(stored.events) } : {}),
  };
}
