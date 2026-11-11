// What the Library pages show of definitions (DESIGN §13, §16, §17), worked out from what
// `lah.defs.get` gives: where a definition comes from in words, what a filter keeps, what the id of
// a new one may be, an agent's and a skill's edits before they are saved and the definition a save
// sends, a tool's arguments made readable, what a tool's calls do and why, and how an MCP server
// stands. The pages (pages/agents.tsx, pages/skills.tsx, pages/tools.tsx) only render these.

import { type AgentDefinition, type AgentView, type ApprovalChoice, type DefinitionSource, type DefsView, isRecord, type JsonObject, type JsonValue, type McpServerView, type SettingsView, type Skill, type SkillView, type Sourced, type TextDef, type ToolRow, type ToolTier, type UiProblem } from "../../shared/ui";
import { counted } from "./format";
import { sameJson, valueAt } from "./settings-model";

// ---------------------------------------------------------------- any definition

/** What every definition a list shows has: its id, its name, what it is for, and where it comes from. */
export type Def = { id: string; name: string; description: string } & Sourced;

/** How a kind of definition is called in the pages' sentences, and what switching one off does. */
export interface KindWords {
  one: string;
  a: string;
  many: string;
  off: string;
}

export const AGENT_WORDS: KindWords = { one: "agent", a: "an agent", many: "agents", off: "A turn's registry leaves it out: no agent can delegate to it, and no job or conversation starts with it." };

export const SKILL_WORDS: KindWords = { one: "skill", a: "a skill", many: "skills", off: "A turn's registry leaves it out: no agent's prompt lists it, and skill_load doesn't find it." };

const SOURCE_WORDS: Readonly<Record<DefinitionSource, string>> = { builtin: "built in", extension: "an extension's", user: "yours" };

const ORIGINAL_WORDS: Readonly<Record<"builtin" | "extension", string>> = { builtin: "the built-in", extension: "the extension's" };

/** Where a definition comes from: "built in", "an extension's", "yours", or "yours, over the built-in" for one of the user's that stands over an original of the same id. */
export function sourceWords(def: Pick<Sourced, "source" | "over">): string {
  return def.source === "user" && def.over !== undefined ? `yours, over ${ORIGINAL_WORDS[def.over]}` : SOURCE_WORDS[def.source];
}

/** A definition's name, or its id where it has none. */
export function titleOf(def: { id: string; name: string }): string {
  return def.name.trim() !== "" ? def.name.trim() : def.id;
}

/** A filter's words, lower-cased; none for a blank one. */
function wordsOf(query: string): string[] {
  return query
    .toLowerCase()
    .split(/\s+/)
    .filter((w) => w !== "");
}

/**
 * The definitions a filter keeps: those whose name, id, description or source holds each of its
 * words, whatever the letter case ("off" finds the ones switched off). They stay in the order the
 * backend gives them, which is the registry's own, so a definition keeps its place when it is saved
 * as the user's.
 */
export function filterDefs<T extends Def>(defs: readonly T[], query: string): T[] {
  const words = wordsOf(query);
  if (words.length === 0) return [...defs];
  return defs.filter((d) => {
    const hay = [d.name, d.id, d.description, sourceWords(d), d.off ? "off" : ""].join("\n").toLowerCase();
    return words.every((w) => hay.includes(w));
  });
}

/** How many definitions there are and whose: "7 agents: 3 built in, 1 from an extension, 3 yours". */
export function countWords(defs: readonly Pick<Sourced, "source">[], words: KindWords): string {
  if (defs.length === 0) return `No ${words.many}`;
  const of = (source: DefinitionSource): number => defs.filter((d) => d.source === source).length;
  const parts = [`${of("builtin")} built in`, `${of("extension")} from an extension`, `${of("user")} yours`].filter((p) => !p.startsWith("0 "));
  return `${counted(defs.length, words.one, words.many)}: ${parts.join(", ")}`;
}

// A definition's id as the backend takes one: it is a key of a stored document and what a tool call
// names, so it is lower-case letters, digits, "-" and "_", starting with a letter, 64 characters at
// most. That is the backend's own format (backend/defs.ts), not a bound of this page's: it is said
// here so a slip shows while it is typed, and the backend still has the last word on a save.
const ID_CHARS = /^[a-z0-9_-]+$/;
const ID_MAX = 64;

/** What is wrong with the id of a definition being made; null when it can be made under it. `taken`: the ids there are. */
export function idProblem(id: string, taken: readonly string[]): string | null {
  if (id === "") return "Give it an id: the name a tool call uses for it.";
  if (!ID_CHARS.test(id)) return 'An id is lower-case letters, digits, "-" and "_": no spaces, no capitals.';
  if (!/^[a-z]/.test(id)) return "An id starts with a letter.";
  if (id.length > ID_MAX) return `An id is ${ID_MAX} characters at most.`;
  if (taken.includes(id)) return `"${id}" is taken: an id names one definition.`;
  return null;
}

/** An id for a copy of `id` that none of `taken` has: "writer-copy", then "writer-copy-2", and so on. */
export function copyId(id: string, taken: readonly string[]): string {
  for (let n = 1; ; n += 1) {
    const tail = n === 1 ? "-copy" : `-copy-${n}`;
    const made = `${id.slice(0, ID_MAX - tail.length)}${tail}`;
    if (!taken.includes(made)) return made;
  }
}

/** The key a definition being made is kept under until it is saved: one no definition's id can be (an id starts with a letter), so it never stands for a saved one. */
export function newKey(n: number): string {
  return `+${n}`;
}

/** What a definition's line under its name says of where it comes from, and what a save or a reset does to that. */
export function standingWords(def: Pick<Def, "source" | "over"> | null, words: KindWords): string {
  if (def === null) return `A new ${words.one} of yours. It exists once you save it.`;
  if (def.source !== "user") return `${def.source === "builtin" ? "Built in" : "An extension's"}. Saving a change makes ${words.a} of yours with the same id that stands over this one; resetting yours brings this one back.`;
  if (def.over === undefined) return "Yours.";
  return `Yours, standing over ${ORIGINAL_WORDS[def.over]} ${words.one} of the same id. Resetting it removes yours and brings ${ORIGINAL_WORDS[def.over]} one back.`;
}

/** What the save button says: making one, making the user's own over an original, or saving the user's. */
export function saveLabel(def: Pick<Def, "source"> | null, words: KindWords): string {
  if (def === null) return `Make this ${words.one}`;
  return def.source === "user" ? "Save" : "Save as yours";
}

/** What a save says once it is done. */
export function savedWords(def: Pick<Def, "source"> | null, title: string): string {
  if (def === null) return `Made ${title}.`;
  return def.source === "user" ? `Saved ${title}.` : `Saved as yours: your ${title} now stands over ${ORIGINAL_WORDS[def.source]} one.`;
}

/** How a definition's edits stand, for the bar that saves them. `refused`: what the backend said of the last save; `idWrong`: what is wrong with a new one's id. */
export function saveStatus(state: { made: boolean; dirty: boolean; refused: string | null; idWrong: string | null }, words: KindWords): string {
  if (state.refused !== null) return `Not saved: ${state.refused}`;
  if (!state.made) return state.idWrong !== null ? `Not made yet. ${state.idWrong}` : `Not made yet: the ${words.one} exists once you save it.`;
  return state.dirty ? "Edits not saved yet. They are kept here until you save or discard them, or the page reloads." : "No edits to save.";
}

/** What removing the user's definition is called, and what the confirmation says it does: a delete for one that is theirs alone, a reset for one that stands over an original (which comes back). */
export function removeAsk(def: Pick<Def, "id" | "name" | "over">, words: KindWords, edits: boolean): { label: string; title: string; message: string; confirm: string; done: string } {
  const title = titleOf(def);
  const lost = edits ? " The edits you haven't saved go with it." : "";
  if (def.over === undefined) return { label: "Delete", title: `Delete ${title}?`, message: `Your ${words.one} "${def.id}" is removed, and whatever names it finds it gone.${lost} This can't be undone.`, confirm: "Delete", done: `Deleted ${title}.` };
  const original = ORIGINAL_WORDS[def.over];
  return {
    label: "Reset to the original",
    title: `Reset ${title} to the original?`,
    message: `Your ${words.one} "${def.id}" is removed with everything you changed in it, and ${original} ${words.one} of that id comes back as it was made.${lost} This can't be undone.`,
    confirm: "Reset",
    done: `${original.charAt(0).toUpperCase()}${original.slice(1)} ${words.one} "${def.id}" is back.`,
  };
}

/**
 * A refused save's problems, each where the page shows it: at one of the fields the page draws
 * itself (`fields`: the definition's keys those are; a problem goes by its path's first key), or
 * left for the form of what an agent runs with (`rest`), which places its own.
 */
export function ownProblems(problems: readonly UiProblem[], fields: readonly string[]): { own: Map<string, string>; rest: UiProblem[] } {
  const own = new Map<string, string>();
  const rest: UiProblem[] = [];
  for (const p of problems) {
    const key = typeof p.path[0] === "string" ? p.path[0] : null;
    if (key !== null && fields.includes(key)) own.set(key, own.has(key) ? `${own.get(key)} ${p.message}` : p.message);
    else rest.push(p);
  }
  return { own, rest };
}

// ---------------------------------------------------------------- agents

/**
 * An agent's instructions as the page holds them: its own words, or one of the core's texts by id
 * (with the wording the definition ships, which goes back unchanged while the text stands).
 */
export type Instructions = { kind: "own"; text: string } | { kind: "text"; id: string; shipped: string };

/** An agent definition as the page edits it. */
export interface AgentDraft {
  id: string;
  name: string;
  description: string;
  instructions: Instructions;
  /** The rest of the definition as JSON: what the backend's form edits (what it is given, what it runs with) and what the page hands back as it came (whom it follows). */
  rest: JsonObject;
}

/** A copy that shares nothing with what it was made from, as JSON: a value left out (an optional field) is left out of the copy too. */
const jsonOf = (value: unknown): JsonObject => JSON.parse(JSON.stringify(value)) as JsonObject;

/** A definition as the page edits it. */
export function agentDraft(view: AgentView): AgentDraft {
  const { id, name, description, instructions, text, source: _source, over: _over, off: _off, ...rest } = view;
  return { id, name, description, instructions: text !== undefined ? { kind: "text", id: text, shipped: instructions } : { kind: "own", text: instructions }, rest: jsonOf(rest) };
}

/** An agent being made: nothing said of it yet, given and running with what the backend says a new agent starts with. */
export function newAgent(defaults: JsonObject): AgentDraft {
  return { id: "", name: "", description: "", instructions: { kind: "own", text: "" }, rest: jsonOf(defaults) };
}

/** A copy of an agent as it shows, to be made under `id`. Where the one copied names a text for its instructions, so does the copy. */
export function copyAgent(shown: AgentDraft, id: string): AgentDraft {
  return { ...shown, id, name: `${titleOf(shown)} (copy)`, rest: jsonOf(shown.rest) };
}

export function sameAgent(a: AgentDraft, b: AgentDraft): boolean {
  return a.id === b.id && a.name === b.name && a.description === b.description && sameJson(a.instructions, b.instructions) && sameJson(a.rest, b.rest);
}

/** The instructions an agent is sent as they stand: its own, or the text its definition names as the user has it (`ownTexts`: the user's own texts by id), else as shipped. */
export function instructionsShown(instructions: Instructions, ownTexts: Readonly<Record<string, string>>): string {
  if (instructions.kind === "own") return instructions.text;
  return Object.hasOwn(ownTexts, instructions.id) ? (ownTexts[instructions.id] ?? instructions.shipped) : instructions.shipped;
}

/**
 * What a draft holds once its instructions box holds `typed`. Instructions that are one of the
 * core's texts stay that while the box holds the text's own wording (`saved`: the instructions as
 * the definition is kept; null for one being made), so an edit undone by hand is undone; anything
 * else is the agent's own.
 */
export function typedInstructions(typed: string, saved: Instructions | null, ownTexts: Readonly<Record<string, string>>): Instructions {
  return saved !== null && saved.kind === "text" && typed === instructionsShown(saved, ownTexts) ? saved : { kind: "own", text: typed };
}

/** A text as Settings → Texts lists it ("Main agent → Instructions (main.system)"), so it is found there; its id alone where the texts don't list it. */
export function textName(id: string, defs: readonly Pick<TextDef, "id" | "group" | "label">[]): string {
  const def = defs.find((d) => d.id === id);
  return def ? `${def.group} → ${def.label} (${id})` : id;
}

/**
 * What stands over the instructions box where one of the core's texts is, or was, the agent's
 * instructions: that the box shows that text (which Settings → Texts also edits), or, once they
 * were edited here, what saving them does. Null where no text is involved.
 */
export function instructionsNote(now: Instructions, saved: Instructions | null, defs: readonly Pick<TextDef, "id" | "group" | "label">[]): { tone: "info" | "warn"; words: string } | null {
  if (now.kind === "text") return { tone: "info", words: `Its instructions are the text ${textName(now.id, defs)}, which Settings → Texts also edits. The box shows that text as it stands now.` };
  if (saved !== null && saved.kind === "text") return { tone: "warn", words: `You edited them here. Once saved they are this agent's own: the text ${textName(saved.id, defs)} stops applying to it, and Settings → Texts no longer changes what it is told, until you reset the agent to the original. Discard your edits to keep the text.` };
  return null;
}

/**
 * The definition a save sends. The one place that decides what becomes of instructions that are one
 * of the core's texts (DESIGN §13): while they weren't edited here the definition goes on naming
 * the text, so Settings → Texts goes on deciding what the agent is told, and the wording it ships
 * goes back as it came (the core doesn't read it while a text is named); once they were edited the
 * definition carries them as its own and names no text.
 */
export function agentToSave(draft: AgentDraft): AgentDefinition {
  const i = draft.instructions;
  const definition = { ...draft.rest, id: draft.id, name: draft.name.trim(), description: draft.description.trim(), instructions: i.kind === "own" ? i.text : i.shipped, ...(i.kind === "text" ? { text: i.id } : {}) };
  // What the form holds goes back as it is: the schema that built the form is the backend's, which checks each value and names the ones it refuses.
  return definition as unknown as AgentDefinition;
}

/** `root` with `value` at `path`, or without that key where `value` is undefined. `root` itself is left as it was. */
function putAt(root: JsonObject, path: readonly string[], value: JsonValue | undefined): JsonObject {
  const [key, ...deeper] = path;
  if (key === undefined) return root;
  if (deeper.length > 0) {
    const inner = root[key];
    return { ...root, [key]: putAt(isRecord(inner) ? (inner as JsonObject) : {}, deeper, value) };
  }
  if (value !== undefined) return { ...root, [key]: value };
  const { [key]: _gone, ...others } = root;
  return others;
}

/**
 * What an agent is given and runs with after its form kept changes, as the Settings form asks the
 * page that holds it to keep them: each `reset` a path back to what a new agent starts with
 * (`defaults`; the empty path: all of it), then each `set` a whole value at a path.
 */
export function applyForm(rest: JsonObject, defaults: JsonObject, set: readonly { path: readonly string[]; value: JsonValue }[], reset: readonly (readonly string[])[] = []): JsonObject {
  let next = rest;
  for (const path of reset) next = path.length === 0 ? { ...next, ...jsonOf(defaults) } : putAt(next, path, valueAt(defaults, path));
  for (const { path, value } of set) next = putAt(next, path, value);
  return next;
}

/** Whom an agent takes its connection and model from while it names no connection of its own, in words; null where it follows no one. */
export function followsWords(rest: JsonObject, agents: readonly { id: string; name: string }[]): string | null {
  const id = rest.follows;
  if (typeof id !== "string" || id === "") return null;
  const whom = agents.find((a) => a.id === id);
  return `While it names no connection of its own, it runs where ${whom ? titleOf(whom) : id} does.`;
}

// ---------------------------------------------------------------- what an agent is given of its tools (§14)

/** The member of a definition that says what the agent is given of its tools when another agent starts it: `own`, `definition`, or left out for Settings to decide. */
const GRANT = "grant";

/** The schema of the setting at a path of a settings schema; null where it describes none there. */
function schemaAt(schema: JsonObject, path: readonly string[]): JsonObject | null {
  let at: JsonObject = schema;
  for (const key of path) {
    const next = isRecord(at.properties) ? at.properties[key] : undefined;
    if (!isRecord(next)) return null;
    at = next as JsonObject;
  }
  return at;
}

const titleOr = (schema: JsonObject, otherwise: string): string => (typeof schema.title === "string" && schema.title !== "" ? schema.title : otherwise);

/**
 * What Settings say a sub-agent may be given, for the choice that leaves it to them: where the
 * setting is, in the words Settings list it under, and what it says now. Read from the settings'
 * schema as approval's place is: at their root or inside one section (the core's). Null where the
 * settings shown have no such setting.
 */
export function grantSettingWords(settings: Pick<SettingsView, "schema" | "values" | "defaults">): string | null {
  const top = isRecord(settings.schema.properties) ? settings.schema.properties : {};
  for (const place of [[], ...Object.keys(top).map((key) => [key])]) {
    const group = schemaAt(settings.schema, [...place, "delegation"]);
    const setting = group !== null ? schemaAt(group, [GRANT]) : null;
    if (group === null || setting === null) continue;
    const path = [...place, "delegation", GRANT];
    const now = valueAt(settings.values, path) ?? valueAt(settings.defaults, path);
    const option = Array.isArray(setting.oneOf) ? setting.oneOf.find((member) => isRecord(member) && now !== undefined && sameJson(member.const as JsonValue, now)) : undefined;
    const says = isRecord(option) && typeof option.title === "string" ? option.title : typeof now === "string" ? now : null;
    const where = `Settings → ${titleOr(group, "Delegation")} → ${titleOr(setting, "What a sub-agent may be given")}`;
    return says !== null ? `${where} decides. It says now: ${says}.` : `${where} decides.`;
  }
  return null;
}

/**
 * An agent's form as `formOf` takes it, with one choice more than the backend's schema describes:
 * what the agent has of its tools when another agent starts it. The definition holds that as a
 * member it leaves out where Settings are to decide, which no value of a schema can say, so the
 * page adds the choice itself, after the tools it is about, with "left out" as none.
 * `settings`: what Settings say now (`grantSettingWords`), said under the choice that leaves it to them.
 */
export function agentForm(view: Pick<DefsView, "agentSchema" | "agentDefaults">, rest: JsonObject, settings: string | null): SettingsView {
  // What "left out" is called: in the list, and where the form names the choice's default (a new agent's).
  const left = "As Settings say";
  const choice: JsonObject = {
    title: "The tools it has when another agent starts it",
    description: "Another agent, most often the main agent, can hand this one a task. This says which of its tools it gets then.",
    "x-none": left,
    oneOf: [
      { const: null, title: left, description: settings ?? "Settings decide, as for every agent that says nothing here." },
      { const: "own", title: "No more than its starter holds", description: "A tool the agent that starts it doesn't have is left out, whatever Settings say." },
      { const: "definition", title: "Its own tools, whoever starts it", description: "Every tool ticked for it. For an agent whose tools are its own trade, which the agent that hands it tasks has no use for." },
    ],
  };
  const properties: JsonObject = {};
  for (const [key, property] of Object.entries(isRecord(view.agentSchema.properties) ? view.agentSchema.properties : {})) {
    properties[key] = property as JsonValue;
    if (key === "tools") properties[GRANT] = choice;
  }
  // A schema with no tools to stand after still gets the choice, last.
  if (!Object.hasOwn(properties, GRANT)) properties[GRANT] = choice;
  return { schema: { ...view.agentSchema, properties }, values: { ...rest, [GRANT]: rest[GRANT] ?? null }, defaults: { ...view.agentDefaults, [GRANT]: null } };
}

/** `applyForm` for an agent's form: the choice the page adds is kept as the definition holds it, so "as Settings say" (none in the form, and what a new agent starts with) leaves the member out. */
export function applyAgentForm(rest: JsonObject, defaults: JsonObject, set: readonly { path: readonly string[]; value: JsonValue }[], reset: readonly (readonly string[])[] = []): JsonObject {
  const next = applyForm(rest, { ...defaults, [GRANT]: null }, set, reset);
  if (next[GRANT] !== null && next[GRANT] !== undefined) return next;
  const { [GRANT]: _left, ...others } = next;
  return others;
}

// ---------------------------------------------------------------- skills

/** A skill as the page edits it: the skill itself, without where it comes from. */
export function skillDraft(view: SkillView): Skill {
  return { id: view.id, name: view.name, description: view.description, body: view.body };
}

export function newSkill(): Skill {
  return { id: "", name: "", description: "", body: "" };
}

/** A copy of a skill as it shows, to be made under `id`. */
export function copySkill(shown: Skill, id: string): Skill {
  return { ...shown, id, name: `${titleOf(shown)} (copy)` };
}

export function sameSkill(a: Skill, b: Skill): boolean {
  return a.id === b.id && a.name === b.name && a.description === b.description && a.body === b.body;
}

/** The skill a save sends: its name and description without the blank space around them, its body as written. */
export function skillToSave(draft: Skill): Skill {
  return { ...draft, name: draft.name.trim(), description: draft.description.trim() };
}

// ---------------------------------------------------------------- tools

export const TIERS: readonly ToolTier[] = ["read", "write", "external"];

/** What each tier's tools may touch (§17). */
export const TIER_COVERS: Readonly<Record<ToolTier, string>> = {
  read: "Tools that change nothing.",
  write: "Tools that change what LumiAH keeps: workspace files, jobs.",
  external: "Tools that act outside LumiAH: an extension's tools, MCP servers.",
};

export const CHOICE_LABEL: Readonly<Record<ApprovalChoice, string>> = { allow: "Allow", ask: "Ask first" };

/** What a tool's own choice may be: its tier's (no choice of its own, which `lah.tool.approval` takes as null), or one of the two. */
export type ToolChoice = "tier" | ApprovalChoice;

export const TOOL_CHOICES: readonly { value: ToolChoice; label: string }[] = [
  { value: "tier", label: "As its tier" },
  { value: "allow", label: CHOICE_LABEL.allow },
  { value: "ask", label: CHOICE_LABEL.ask },
];

/** What a tool's calls do now, and whose choice that is: the tier's, or the user's for this tool. */
export function holdsWords(tool: Pick<ToolRow, "asks" | "approval" | "tier" | "off">): string {
  const does = tool.asks ? "each call waits for your word" : "its calls run without asking";
  const why = tool.approval === null ? `as ${tool.tier} tools do` : "your choice for this tool";
  return tool.off ? `It is off, so no agent is offered it. Switched on, ${does}: ${why}.` : `Now ${does}: ${why}.`;
}

/** How far a tier's choice reaches: how many tools are of the tier, and how many of them have a choice of their own. */
export function tierReach(tools: readonly Pick<ToolRow, "tier" | "approval">[], tier: ToolTier): string {
  const of = tools.filter((t) => t.tier === tier);
  if (of.length === 0) return "No tool is of this tier now.";
  const own = of.filter((t) => t.approval !== null).length;
  return `${counted(of.length, "tool")}${own > 0 ? `, ${own} with a choice of ${own === 1 ? "its" : "their"} own` : ""}.`;
}

export interface ToolFilter {
  text: string;
  tier: ToolTier | null;
  family: string | null;
  /** Only the tools whose calls wait for the user now. */
  asks: boolean;
}

export const NO_TOOL_FILTER: ToolFilter = { text: "", tier: null, family: null, asks: false };

/** Whether a filter leaves any tool out. */
export function filtersOn(filter: ToolFilter): boolean {
  return filter.text.trim() !== "" || filter.tier !== null || filter.family !== null || filter.asks;
}

/** The families the tools sit in, each once, in the order the registry lists them. */
export function familiesOf(tools: readonly Pick<ToolRow, "family">[]): string[] {
  return [...new Set(tools.map((t) => t.family))];
}

/** A filter as it stands against the tools there are: a family that is gone (its MCP server was switched off since) filters nothing. */
export function soundFilter(filter: ToolFilter, tools: readonly Pick<ToolRow, "family">[]): ToolFilter {
  return filter.family !== null && !tools.some((t) => t.family === filter.family) ? { ...filter, family: null } : filter;
}

export interface Param {
  name: string;
  type: string;
  required: boolean;
  description: string | null;
}

const TYPE_WORDS: Readonly<Record<string, string>> = { string: "text", integer: "whole number", number: "number", boolean: "true or false", object: "group", array: "list", null: "nothing" };

/** A schema's type in plain words: "text", "whole number", "list of text", "one of: now, after_reply", "text or nothing"; "anything" where it names none. */
export function typeWords(schema: JsonObject): string {
  const choices = Array.isArray(schema.enum) ? schema.enum : Array.isArray(schema.oneOf) && schema.oneOf.length > 0 && schema.oneOf.every((o) => isRecord(o) && Object.hasOwn(o, "const")) ? schema.oneOf.map((o) => (isRecord(o) ? (o.const as JsonValue) : null)) : null;
  if (choices !== null && choices.length > 0) return `one of: ${choices.map((c) => String(c)).join(", ")}`;
  const types = typeof schema.type === "string" ? [schema.type] : Array.isArray(schema.type) ? schema.type.filter((t): t is string => typeof t === "string") : [];
  if (types.length === 0) return "anything";
  return types.map((t) => (t === "array" && isRecord(schema.items) ? `list of ${typeWords(schema.items as JsonObject)}` : (TYPE_WORDS[t] ?? t))).join(" or ");
}

/** A tool's arguments, as its schema names them and in its order: each one's name, its type in words, whether a call must give it, and what the model is told of it. None for a tool that takes none. */
export function paramsOf(parameters: JsonObject | undefined): Param[] {
  if (!parameters || !isRecord(parameters.properties)) return [];
  const required = new Set(Array.isArray(parameters.required) ? parameters.required.filter((r): r is string => typeof r === "string") : []);
  return Object.entries(parameters.properties).flatMap(([name, schema]): Param[] => {
    if (!isRecord(schema)) return [];
    return [{ name, type: typeWords(schema as JsonObject), required: required.has(name), description: typeof schema.description === "string" && schema.description !== "" ? schema.description : null }];
  });
}

/**
 * The tools a filter keeps, grouped by family in the registry's order: those of its tier and its
 * family, those that ask first where it says so, and those whose name, family, tier, description
 * or an argument's name holds each of its words.
 */
export function toolGroups(tools: readonly ToolRow[], filter: ToolFilter): { family: string; tools: ToolRow[] }[] {
  const words = wordsOf(filter.text);
  const kept = tools.filter((t) => {
    if (filter.tier !== null && t.tier !== filter.tier) return false;
    if (filter.family !== null && t.family !== filter.family) return false;
    if (filter.asks && !t.asks) return false;
    if (words.length === 0) return true;
    const hay = [t.name, t.family, t.tier, t.description, ...paramsOf(t.parameters).map((p) => p.name)].join("\n").toLowerCase();
    return words.every((w) => hay.includes(w));
  });
  return familiesOf(kept).map((family) => ({ family, tools: kept.filter((t) => t.family === family) }));
}

/** How many tools show: "27 tools", or "5 of 27 tools" under a filter. */
export function toolCountWords(shown: number, all: number): string {
  return shown === all ? counted(all, "tool") : `${shown} of ${counted(all, "tool")}`;
}

/** The server part of an MCP tool's name (`mcp:<server>:<tool>`, §16); null for any other tool. */
export function mcpServerOf(name: string): string | null {
  const parts = /^mcp:([^:]+):.+$/.exec(name);
  return parts ? (parts[1] ?? null) : null;
}

/** Where a tool comes from: "built in", "an extension's", or the MCP server it is a tool of. */
export function toolSourceWords(tool: Pick<ToolRow, "name" | "source">): string {
  const server = mcpServerOf(tool.name);
  return server !== null ? `the MCP server ${server}` : SOURCE_WORDS[tool.source];
}

const RUNS_WORDS: Readonly<Record<ToolRow["runs"], string>> = { runtime: "in the runtime", extension: "in the extension, over the link" };

/** A tool's standing in one line: its family, where it runs and where it comes from. */
export function toolFacts(tool: Pick<ToolRow, "name" | "family" | "runs" | "source">): string {
  return `family ${tool.family} · runs ${RUNS_WORDS[tool.runs]} · ${toolSourceWords(tool)}`;
}

// ---------------------------------------------------------------- MCP servers

const MCP_STATUS: Readonly<Record<McpServerView["status"], { status: string; tone: "pos" | "neutral" | "neg" }>> = {
  ready: { status: "ready", tone: "pos" },
  stopped: { status: "stopped in Lumiverse", tone: "neutral" },
  failed: { status: "failed", tone: "neg" },
};

/** How an MCP server stands: its status in a word, and a line on whether agents are offered its tools and, where they aren't though it is on, why. */
export function mcpWords(server: McpServerView): { status: string; tone: "pos" | "neutral" | "neg"; line: string } {
  const why = server.problem ?? (server.status === "stopped" ? "It is switched off in Lumiverse, so its tools aren't offered." : "Lumiverse couldn't reach it, so its tools aren't offered.");
  const line = server.off
    ? server.status === "ready"
      ? "Off for agents: none of its tools is offered."
      : `Off for agents. ${why}`
    : server.status !== "ready"
      ? why
      : server.tools === 0
        ? "On for agents, but it offers no tool."
        : `On for agents: ${counted(server.tools, "tool")} offered.`;
  return { ...MCP_STATUS[server.status], line };
}

/** How many of the servers are on for agents: "1 of 2 servers on for agents". */
export function mcpCountWords(servers: readonly Pick<McpServerView, "off">[]): string {
  return `${servers.filter((s) => !s.off).length} of ${counted(servers.length, "server")} on for agents`;
}

/** What an MCP server is and what switching one on for agents means, by what the calls of external tools do now: said once, over the switches. */
export function mcpAbout(external: ApprovalChoice): string {
  const what = "MCP servers add tools from outside LumiAH; you set them up in Lumiverse.";
  return external === "allow"
    ? `${what} Switch one on and agents can call its tools without asking. To approve each call yourself, set external tools to Ask first on this page.`
    : `${what} Switch one on and agents can use its tools: each call waits for your word on Live, because external tools are set to Ask first on this page.`;
}

// ---------------------------------------------------------------- the approval settings

/** Whether a schema node is the approval group: one that holds the tiers' choices. */
const holdsTiers = (node: unknown): boolean => isRecord(node) && isRecord(node.properties) && isRecord(node.properties.tiers);

/**
 * Where the settings keep approval (§17), read from their schema: the path of the group that holds
 * each tier's choice under `tiers` and each tool's own under `tools`. It sits at the settings' root
 * or inside one section (the core's). Null where the settings shown have no such group, and the
 * page then offers no way to it.
 */
export function approvalSettingPath(schema: JsonObject): string[] | null {
  const top = isRecord(schema.properties) ? schema.properties : {};
  if (holdsTiers(top.approval)) return ["approval"];
  for (const [key, section] of Object.entries(top)) if (isRecord(section) && isRecord(section.properties) && holdsTiers(section.properties.approval)) return [key, "approval"];
  return null;
}

/** A tier's badge: its word is what says it; the tone only sets the three apart. */
export const TIER_TONE: Readonly<Record<ToolTier, "neutral" | "accent" | "warn">> = { read: "neutral", write: "accent", external: "warn" };

/** What "as its tier" comes to for a tool now: "External tools ask first now." */
export function tierChoiceWords(tier: ToolTier, tiers: Readonly<Record<ToolTier, ApprovalChoice>>): string {
  return `${tier.charAt(0).toUpperCase()}${tier.slice(1)} tools ${tiers[tier] === "ask" ? "ask first" : "run without asking"} now.`;
}
