// What the card of a tool call that asks permission says (DESIGN §17), worked out from the call as
// core asks it: who wants to do what to what, as a sentence; for a tool that changes a workspace
// file, the change it would make to the file as it stands, for the Workspace's own diff; for any
// other tool, its arguments as a short list; and how long the wait still is. No DOM and no
// requests: runs.tsx reads the file and draws what these give.

import { type ApprovalView, isRecord, type JsonObject, type JsonValue, type WorkspaceArea } from "../../shared/ui";
import { count, duration } from "./format";
import { filePath, roleLabel } from "./live-model";
import { type DiffMarks, diffLines } from "./workspace-model";

/** What of a held call the card's words rest on. */
export type AskedCall = Pick<ApprovalView, "role" | "tool" | "args">;

/** A piece of the card's sentence: plain words, or a name that shows as code (a file's path, a tool's name, a job's id). */
export interface Piece {
  text: string;
  code?: true;
}

const code = (text: string): Piece => ({ text, code: true });

/** A role as a sentence names it: "the archivist", "the main agent". */
function theAgent(role: string): string {
  const label = roleLabel(role);
  return `the ${label.charAt(0).toLowerCase()}${label.slice(1)}`;
}

/** An argument that is text with something in it; null for anything else. */
function textOf(value: JsonValue | undefined): string | null {
  return typeof value === "string" && value.trim() !== "" ? value.trim() : null;
}

/** A yes or a no as a model's arguments give it, or written as text, as the core's tools read one; null for anything else. */
function flagOf(value: JsonValue | undefined): boolean | null {
  if (typeof value === "boolean") return value;
  return value === "true" ? true : value === "false" ? false : null;
}

// ---------------------------------------------------------------- a workspace file's tools

/** A workspace file as a call names it: its area, its path within it, and its name as the pages write it. */
export interface Place {
  area: WorkspaceArea;
  path: string;
  shown: string;
}

/**
 * A path as an agent writes it, read the way the core's workspace reads one: `~/…` is the user's
 * area, `learned/…` is kept with the chat, anything else is the chat's own, with or without a slash
 * at its start. Null for what names no one file the page can be sure of (no path, a folder, a path
 * that climbs with `..`): the core has the last word on those, and the card then shows the call's
 * arguments instead of a diff.
 */
export function placeOf(raw: JsonValue | undefined): Place | null {
  const given = textOf(raw);
  if (given === null || /[\\\p{Cc}]/u.test(given)) return null;
  const home = given === "~" || given.startsWith("~/");
  const segments = (home ? given.slice(1) : given).split("/").filter((segment) => segment !== "" && segment !== ".");
  if (segments.includes("..")) return null;
  const learned = !home && segments[0] === "learned";
  const path = (learned ? segments.slice(1) : segments).join("/");
  if (path === "") return null;
  const area: WorkspaceArea = home ? "user" : learned ? "learned" : "chat";
  return { area, path, shown: filePath({ area, path }) };
}

/** What a call of one of the workspace's changing tools asks for, read from its arguments. */
export type FileAsk =
  | { kind: "write"; place: Place; content: string; fresh: boolean }
  | { kind: "edit"; place: Place; find: string; replace: string; all: boolean }
  | { kind: "move"; place: Place; to: Place }
  | { kind: "delete"; place: Place }
  | { kind: "pin"; place: Place; pinned: boolean };

// The core's names for these tools and their arguments (core/text-def.ts `TOOL`, core/tools/workspace.ts).
// The pages take nothing from the core but the contract, so they are written out here; a test holds
// each name to the core's own.
const FILE_TOOLS: Readonly<Record<string, (args: JsonObject) => FileAsk | null>> = {
  workspace_write: (args) => {
    const place = placeOf(args.path);
    // A file's text counts as it is written, an empty one too.
    return place !== null && typeof args.content === "string" ? { kind: "write", place, content: args.content, fresh: textOf(args.base)?.toLowerCase() === "new" } : null;
  },
  workspace_edit: (args) => {
    const place = placeOf(args.path);
    return place !== null && typeof args.find === "string" && args.find !== "" && typeof args.replace === "string" ? { kind: "edit", place, find: args.find, replace: args.replace, all: flagOf(args.all) === true } : null;
  },
  workspace_move: (args) => {
    const place = placeOf(args.from);
    const to = placeOf(args.to);
    return place !== null && to !== null ? { kind: "move", place, to } : null;
  },
  workspace_delete: (args) => {
    const place = placeOf(args.path);
    return place !== null ? { kind: "delete", place } : null;
  },
  workspace_pin: (args) => {
    const place = placeOf(args.path);
    const pinned = flagOf(args.pinned);
    return place !== null && pinned !== null ? { kind: "pin", place, pinned } : null;
  },
};

/** The tools `fileAsk` reads, by the core's names for them. */
export const FILE_TOOL_NAMES: readonly string[] = Object.keys(FILE_TOOLS);

/** What a held call would do to a workspace file; null for any other tool, and for a call whose arguments name no one file. */
export function fileAsk(call: Pick<AskedCall, "tool" | "args">): FileAsk | null {
  return Object.hasOwn(FILE_TOOLS, call.tool) ? (FILE_TOOLS[call.tool]?.(call.args) ?? null) : null;
}

/** The file a call is about as the page has read it: being read, its text, not there, or why it couldn't be read. */
export type Standing = { status: "reading" } | { status: "ready"; text: string } | { status: "none" } | { status: "failed"; message: string };

/** Whether the card must read the file before it can show what the call would change: a write and an edit change its text. */
export function needsFile(ask: FileAsk | null): ask is Extract<FileAsk, { kind: "write" | "edit" }> {
  return ask !== null && (ask.kind === "write" || ask.kind === "edit");
}

/**
 * Two texts for the Workspace's diff: the file as it stands and as the call would leave it. Where
 * an edit's text can't be placed in the file (`whole` false), only the text it looks for and what
 * would take its place, with `note` saying why.
 */
export interface Change {
  before: string;
  after: string;
  whole: boolean;
  note: string | null;
}

/** What a write or an edit would change, once the file is read; null while it is read, where it couldn't be, and for the other tools. */
export function changeOf(ask: FileAsk | null, standing: Standing): Change | null {
  if (!needsFile(ask) || standing.status === "reading" || standing.status === "failed") return null;
  const text = standing.status === "ready" ? standing.text : null;
  if (ask.kind === "write") return { before: text ?? "", after: ask.content, whole: true, note: null };
  const pieces = text === null ? [] : text.split(ask.find);
  const matches = pieces.length - 1;
  if (matches === 1 || (matches > 1 && ask.all)) return { before: text ?? "", after: pieces.join(ask.replace), whole: true, note: null };
  const why = text === null ? "There is no such file now" : matches < 1 ? "The file doesn't hold that text as it stands now" : `The file holds that text ${count(matches)} times, and the call names one`;
  return { before: ask.find, after: ask.replace, whole: false, note: `${why}, so the tool will likely turn this call down. Shown here: the text it looks for, and what would take its place.` };
}

/** How a call's change is marked against the file as it stands: nothing is written yet, so each line says what the call would do. */
export const ASK_MARKS: DiffMarks = { added: { sign: "+", word: "adds", counted: "would be added" }, removed: { sign: "−", word: "removes", counted: "would be removed" } };

const lines = (n: number): string => (n === 1 ? "a line" : `${count(n)} lines`);

/** What a change comes to, as the sentence's verb: "add a line to", "remove 3 lines from", "change", "make the file". `tail` is what follows the file's name. */
function changeVerb(ask: Extract<FileAsk, { kind: "write" | "edit" }>, change: Change | null, standing: Standing): { verb: string; tail: string } {
  if (change === null || !change.whole) return { verb: ask.kind === "write" && ask.fresh ? "make the file" : "change", tail: "" };
  if (standing.status === "none") return { verb: "make the file", tail: "" };
  const diff = diffLines(change.before, change.after);
  if (diff.added === 0 && diff.removed === 0) return { verb: "write", tail: " again, with the text it already holds" };
  if (diff.removed === 0) return { verb: `add ${lines(diff.added)} to`, tail: "" };
  if (diff.added === 0) return { verb: `remove ${lines(diff.removed)} from`, tail: "" };
  return diff.added === diff.removed ? { verb: `change ${lines(diff.added)} of`, tail: "" } : { verb: "change", tail: "" };
}

function filePieces(ask: FileAsk, change: Change | null, standing: Standing): Piece[] {
  const file = code(ask.place.shown);
  switch (ask.kind) {
    case "write":
    case "edit": {
      const { verb, tail } = changeVerb(ask, change, standing);
      return [{ text: `${verb} ` }, file, ...(tail !== "" ? [{ text: tail }] : [])];
    }
    case "move":
      return [{ text: "move " }, file, { text: " to " }, code(ask.to.shown)];
    case "delete":
      return [{ text: "delete " }, file];
    case "pin":
      return ask.pinned ? [{ text: "be given " }, file, { text: " with every reply it works on" }] : [{ text: "stop being given " }, file, { text: " with every reply" }];
  }
}

// ---------------------------------------------------------------- any other tool

/** What a tool's call is in words, after "wants to", and which of its arguments those words already say (the list leaves them out). */
interface Said {
  pieces: Piece[];
  said: string[];
}

/**
 * The longest text of an argument the sentence itself quotes (what a web search looks for). Past it
 * the sentence would no longer read as one, so the text goes to the list below instead. Not a
 * setting: it only picks which of two places on one card shows the same words.
 */
const QUOTED_CHARS = 80;

const WHEN_WORDS: Readonly<Record<string, string>> = { now: ", to run now", after_reply: ", to run once the reply is written" };

// The core's names again (core/text-def.ts `TOOL`), for the tools whose calls say something plain.
const TOOL_WORDS: Readonly<Record<string, (args: JsonObject) => Said>> = {
  job_start: (args) => {
    const when = typeof args.when === "string" && Object.hasOwn(WHEN_WORDS, args.when) ? (WHEN_WORDS[args.when] ?? "") : "";
    const whenSaid = when !== "" ? ["when"] : [];
    const again = textOf(args.again);
    if (again !== null) return { pieces: [{ text: "start the job " }, code(again), { text: ` again${when}` }], said: ["again", ...whenSaid] };
    const agent = textOf(args.agent);
    return agent !== null ? { pieces: [{ text: `give ${theAgent(agent)} a job${when}` }], said: ["agent", ...whenSaid] } : { pieces: [{ text: `start a job${when}` }], said: whenSaid };
  },
  job_cancel: (args) => {
    const job = textOf(args.job);
    return job !== null ? { pieces: [{ text: "cancel the job " }, code(job)], said: ["job"] } : { pieces: [{ text: "cancel a job" }], said: [] };
  },
  delegate: (args) => {
    const agent = textOf(args.agent);
    return agent !== null ? { pieces: [{ text: `hand ${theAgent(agent)} a task` }], said: ["agent"] } : { pieces: [{ text: "hand another agent a task" }], said: [] };
  },
  agent_message: () => ({ pieces: [{ text: "send a message to an agent it started" }], said: [] }),
  skill_load: (args) => {
    const skill = textOf(args.skill);
    return skill !== null ? { pieces: [{ text: "read the skill " }, code(skill)], said: ["skill"] } : { pieces: [{ text: "read a skill" }], said: [] };
  },
  web_search: (args) => {
    const query = textOf(args.query);
    return query !== null && query.length <= QUOTED_CHARS ? { pieces: [{ text: `search the web for “${query}”` }], said: ["query"] } : { pieces: [{ text: "search the web" }], said: [] };
  },
};

/** What the core's reading tools read, by how their names start: "read the chat with chat_search". */
const READS: readonly (readonly [RegExp, string])[] = [
  [/^chat_/, "read the chat"],
  [/^(lore_|active_lore$)/, "read your lore"],
  [/^workspace_(list|read|grep)$/, "read the workspace's files"],
];

/** An MCP server's tool, as its name holds both (`mcp:<server>:<tool>`); null for any other tool. */
function mcpOf(name: string): { server: string; tool: string } | null {
  const parts = /^mcp:([^:]+):(.+)$/.exec(name);
  return parts ? { server: parts[1] ?? "", tool: parts[2] ?? "" } : null;
}

function toolSaid(call: Pick<AskedCall, "tool" | "args">): Said {
  if (Object.hasOwn(TOOL_WORDS, call.tool)) {
    const said = TOOL_WORDS[call.tool]?.(call.args);
    if (said) return said;
  }
  const mcp = mcpOf(call.tool);
  if (mcp !== null) return { pieces: [{ text: "use " }, code(mcp.tool), { text: " of the MCP server " }, code(mcp.server)], said: [] };
  const reads = READS.find(([names]) => names.test(call.tool));
  return reads ? { pieces: [{ text: `${reads[1]} with ` }, code(call.tool)], said: [] } : { pieces: [{ text: "use the tool " }, code(call.tool)], said: [] };
}

/**
 * How much of an argument's value shows before the rest folds behind "Show all": about three lines
 * of a phone's card. Not a setting: nothing is hidden for good, and a card that holds a whole
 * page of text would push the three answers out of reach.
 */
const ARG_SHOWN_CHARS = 160;

/** An argument as the card lists it: its name as the tool has it, its value as text, and that value's opening where it is long (null: it shows whole). */
export interface ArgRow {
  name: string;
  value: string;
  short: string | null;
}

/** A value as text: text as it is, a number or a yes/no as written, anything deeper as JSON. */
function valueText(value: JsonValue): string {
  if (typeof value === "string") return value;
  if (value === null) return "nothing";
  if (typeof value === "boolean") return value ? "yes" : "no";
  return isRecord(value) || Array.isArray(value) ? JSON.stringify(value, null, 2) : String(value);
}

/** A long text's opening, cut at a word's end where one is near. */
function opening(text: string): string | null {
  if (text.length <= ARG_SHOWN_CHARS) return null;
  const cut = text.slice(0, ARG_SHOWN_CHARS);
  const space = cut.search(/\s\S*$/);
  return `${(space > ARG_SHOWN_CHARS / 2 ? cut.slice(0, space) : cut).trimEnd()}…`;
}

/** A call's arguments as a list, in the order the agent gave them, without those named in `said`. */
export function argRows(args: JsonObject, said: readonly string[] = []): ArgRow[] {
  return Object.entries(args).flatMap(([name, value]): ArgRow[] => {
    if (said.includes(name)) return [];
    const text = valueText(value);
    return [{ name, value: text, short: opening(text) }];
  });
}

// ---------------------------------------------------------------- the card

/** A held call as its card shows it. */
export interface Ask {
  /** Who wants to do what to what, in pieces, and the same as one line of text. */
  pieces: Piece[];
  sentence: string;
  /** What a file's tool would change, for the diff; null for any other tool, and until the file is read. */
  change: Change | null;
  /** What stands where the diff would while it can't show: that the file is being read, or why it couldn't be. */
  note: string | null;
  /** The arguments as a list: every tool's but a file tool's whose words or diff already say them. */
  args: ArgRow[];
  /** The call as the agent made it, for the fold. */
  json: string;
}

/**
 * A held call as its card says it. `standing` is the file a write or an edit is about, as the page
 * has read it (`needsFile`); for every other call it is not looked at.
 */
export function askOf(call: AskedCall, standing: Standing): Ask {
  const who = `${theAgent(call.role).replace(/^t/, "T")} wants to `;
  const json = JSON.stringify(call.args, null, 2);
  const file = fileAsk(call);
  const done = (pieces: Piece[], rest: Pick<Ask, "change" | "note" | "args">): Ask => {
    const all = [{ text: who }, ...pieces, { text: "." }];
    return { pieces: all, sentence: all.map((p) => p.text).join(""), ...rest, json };
  };
  if (file === null) {
    const { pieces, said } = toolSaid(call);
    return done(pieces, { change: null, note: null, args: argRows(call.args, said) });
  }
  const change = changeOf(file, standing);
  const pieces = filePieces(file, change, standing);
  if (!needsFile(file)) return done(pieces, { change: null, note: null, args: [] });
  if (change !== null) return done(pieces, { change, note: change.note, args: [] });
  if (standing.status === "reading") return done(pieces, { change: null, note: "Reading the file as it stands…", args: [] });
  // The file couldn't be read, so no change can be shown: what the agent sent shows as it is.
  const why = standing.status === "failed" ? standing.message : "";
  return done(pieces, { change: null, note: `The file as it stands couldn't be read${why !== "" ? ` (${why.replace(/[.\s]+$/, "")})` : ""}, so this is what the agent sent rather than what would change.`, args: argRows(call.args, ["path", "base"]) });
}

/** How long a held call still waits for the user, in whole seconds (the card's clock ticks once a second), and what happens then. */
export function waitWords(left: number | null): string {
  if (left === null) return "It waits for your permission for as long as the agent works.";
  if (left <= 0) return "Its wait has run out.";
  const seconds = Math.ceil(left / 1000);
  return `It waits ${seconds < 60 ? `${seconds} s` : duration(seconds * 1000)} more for your permission. After that the call is refused, and the agent is told the wait ran out.`;
}

/** What "Approve for this chat" grants, said under the answers: the tool, not this one call. */
export function forChatWords(tool: string): Piece[] {
  return [{ text: "“For this chat” lets every later call of " }, code(tool), { text: " in this chat go ahead without asking." }];
}
