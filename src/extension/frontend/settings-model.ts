// The Settings page's forms, built from the settings' schema (`shared/ui.ts` says which keywords),
// pure so it is tested without a browser. `formOf` reads the schema beside the values and their
// defaults into a tree of nodes, each with the control that edits it; a node the page has no control
// for becomes JSON to edit, so no setting is out of reach. The schema is the backend's, read as
// outside data: a keyword that isn't what it should be is left out, never trusted.

import { ADDED_TOOLS, isRecord, type JsonObject, type JsonValue, type SettingPath, type SettingsView, type UiProblem } from "../../shared/ui";
import { count } from "./format";

export interface Choice {
  value: JsonValue;
  label: string;
  help: string | null;
}

/** What names a table's rows: one of the user's connections, a model, a tool, or any name. */
export type TableKeys = "connection" | "model" | "tool" | "name";

/** One shape of a setting that has several, with the value of the property that chooses it. */
export interface Variant extends Choice {
  schema: JsonObject;
}

/** The control that edits a node. */
export type Control =
  | { kind: "group"; fields: FormNode[] }
  | { kind: "table"; keys: TableKeys; row: JsonObject; rows: FormNode[] }
  | { kind: "variant"; property: string; variants: Variant[]; current: number; fields: FormNode[] }
  | { kind: "boolean" }
  | { kind: "number"; integer: boolean; min: number | null; max: number | null; step: number | null; unit: string | null }
  | { kind: "choice"; options: Choice[] }
  | { kind: "connection" }
  | { kind: "connections" }
  | { kind: "model"; connection: SettingPath | null }
  | { kind: "text"; multiline: boolean; maxLength: number | null }
  | { kind: "set"; options: Choice[] }
  | { kind: "list" }
  | { kind: "json" };

/** A setting, or a group of them: where it sits, how it is labelled, its value and its default, and its control. */
export interface FormNode {
  path: SettingPath;
  key: string;
  label: string;
  help: string | null;
  value: JsonValue;
  fallback: JsonValue;
  /** Its value differs from its default. */
  changed: boolean;
  /** It may be none, which `none` says in words. */
  nullable: boolean;
  none: string;
  control: Control;
}

/** Whether two JSON values are the same, whatever order their keys are in. */
export function sameJson(a: JsonValue | undefined, b: JsonValue | undefined): boolean {
  if (a === b) return true;
  if (a === undefined || b === undefined || a === null || b === null || typeof a !== "object" || typeof b !== "object") return false;
  if (Array.isArray(a) || Array.isArray(b)) return Array.isArray(a) && Array.isArray(b) && a.length === b.length && a.every((v, i) => sameJson(v, b[i]));
  const keys = Object.keys(a);
  return keys.length === Object.keys(b).length && keys.every((k) => Object.hasOwn(b, k) && sameJson(a[k], b[k]));
}

/** The value at a path; undefined where there is none. */
export function valueAt(root: JsonValue | undefined, path: readonly string[]): JsonValue | undefined {
  let at: JsonValue | undefined = root;
  for (const key of path) {
    if (at === null || typeof at !== "object" || Array.isArray(at) || !Object.hasOwn(at, key)) return undefined;
    at = at[key];
  }
  return at;
}

const text = (v: unknown): string | null => (typeof v === "string" && v !== "" ? v : null);
const num = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : null);

/** A key as a label where the schema gives no title: "tokensIn" → "Tokens in", "max_rounds" → "Max rounds". */
export function keyLabel(key: string): string {
  const words = key
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/[_-]+/g, " ")
    .trim()
    .toLowerCase();
  return words === "" ? key : words.charAt(0).toUpperCase() + words.slice(1);
}

function typesOf(schema: JsonObject): string[] {
  const t = schema.type;
  if (typeof t === "string") return [t];
  return Array.isArray(t) ? t.filter((x): x is string => typeof x === "string") : [];
}

/**
 * Core's reserved entries among tool names: `@added` is every tool that isn't built in, `@family`
 * every tool of a family, those gained later too. Each names a group and no one tool, so it is said
 * in words; null for any other value, which is its own label.
 */
function groupWords(value: string): { label: string; help: string } | null {
  if (value === ADDED_TOOLS) return { label: "Tools you added (MCP servers and extensions)", help: "Every tool of the MCP servers you switched on for agents and of your extensions, those added later too." };
  if (value.startsWith("@mcp:")) return { label: `Every tool of the MCP server ${value.slice("@mcp:".length)}`, help: "Those it gains later too." };
  if (value.startsWith("@")) return { label: `Every ${value.slice(1)} tool`, help: "Those the family gains later too." };
  return null;
}

/** A schema's choices: its `enum`, or its `oneOf` when every member is a `const` with words; null when it has neither. */
function choicesOf(schema: JsonObject): Choice[] | null {
  if (Array.isArray(schema.enum))
    return schema.enum.map((value) => {
      const group = typeof value === "string" ? groupWords(value) : null;
      return { value, label: group?.label ?? (value === null ? "None" : String(value)), help: group?.help ?? null };
    });
  if (!Array.isArray(schema.oneOf) || schema.oneOf.length === 0) return null;
  const out: Choice[] = [];
  for (const member of schema.oneOf) {
    if (!isRecord(member) || !Object.hasOwn(member, "const")) return null;
    const value = member.const as JsonValue;
    out.push({ value, label: text(member.title) ?? String(value), help: text(member.description) });
  }
  return out;
}

/** A schema's shapes: its `oneOf` when every member is an object that fixes the same property with `const`; null otherwise. */
function variantsOf(schema: JsonObject): { property: string; variants: Variant[] } | null {
  if (!Array.isArray(schema.oneOf) || schema.oneOf.length === 0) return null;
  let property: string | null = null;
  const variants: Variant[] = [];
  for (const member of schema.oneOf) {
    if (!isRecord(member) || !isRecord(member.properties)) return null;
    const fixed = Object.entries(member.properties).filter(([, p]) => isRecord(p) && Object.hasOwn(p, "const"));
    const [name, prop] = fixed[0] ?? [];
    if (name === undefined || !isRecord(prop) || (property !== null && property !== name)) return null;
    property = name;
    variants.push({ value: prop.const as JsonValue, label: text(member.title) ?? String(prop.const), help: text(member.description), schema: member as JsonObject });
  }
  return property === null ? null : { property, variants };
}

/**
 * A value a new row, or a shape just chosen, starts with: the schema's `default`, else the least its
 * type allows (none where it may be none, a group's properties each started the same way).
 */
export function initialOf(schema: JsonObject): JsonValue {
  if (Object.hasOwn(schema, "default")) return schema.default as JsonValue;
  if (Object.hasOwn(schema, "const")) return schema.const as JsonValue;
  const types = typesOf(schema);
  if (types.includes("null")) return null;
  const choices = choicesOf(schema);
  if (choices && choices[0]) return choices[0].value;
  const shapes = variantsOf(schema);
  if (shapes && shapes.variants[0]) return initialOf(shapes.variants[0].schema);
  if (isRecord(schema.properties)) {
    const out: JsonObject = {};
    for (const [key, prop] of Object.entries(schema.properties)) if (isRecord(prop)) out[key] = initialOf(prop as JsonObject);
    return out;
  }
  if (types.includes("object")) return {};
  if (types.includes("array")) return [];
  if (types.includes("boolean")) return false;
  if (types.includes("integer") || types.includes("number")) return num(schema.minimum) ?? 0;
  return "";
}

function controlOf(schema: JsonObject, path: SettingPath, value: JsonValue, fallback: JsonValue | undefined, siblings: JsonObject | null): Control {
  const types = typesOf(schema).filter((t) => t !== "null");
  const shapes = variantsOf(schema);
  if (shapes) {
    const chosen = isRecord(value) ? shapes.variants.findIndex((v) => sameJson(v.value, value[shapes.property] as JsonValue)) : -1;
    const current = shapes.variants[chosen];
    const fields = current && isRecord(current.schema.properties) ? fieldsOf(current.schema.properties as JsonObject, path, value, fallback, shapes.property) : [];
    return { kind: "variant", property: shapes.property, variants: shapes.variants, current: chosen, fields };
  }
  const choices = choicesOf(schema);
  if (choices) return { kind: "choice", options: choices };
  if (isRecord(schema.properties)) return { kind: "group", fields: fieldsOf(schema.properties as JsonObject, path, value, fallback, null) };
  if (types.includes("object") && isRecord(schema.additionalProperties)) {
    const row = schema.additionalProperties as JsonObject;
    const named = schema["x-keys"];
    const keys: TableKeys = named === "connection" || named === "model" || named === "tool" ? named : "name";
    const held = isRecord(value) ? value : {};
    const rows = Object.keys(held).map((key) => nodeOf(key, row, [...path, key], held[key] as JsonValue, valueAt(fallback, [key]), null, key));
    return { kind: "table", keys, row, rows };
  }
  if (types.includes("boolean")) return { kind: "boolean" };
  if (types.includes("integer") || types.includes("number")) return { kind: "number", integer: types.includes("integer"), min: num(schema.minimum), max: num(schema.maximum), step: num(schema.multipleOf), unit: text(schema["x-unit"]) };
  if (types.includes("string")) {
    if (schema.format === "connection") return { kind: "connection" };
    if (schema.format === "model") {
      const beside = siblings ? Object.entries(siblings).find(([, s]) => isRecord(s) && s.format === "connection") : undefined;
      return { kind: "model", connection: beside ? [...path.slice(0, -1), beside[0]] : null };
    }
    return { kind: "text", multiline: schema.format === "multiline", maxLength: num(schema.maxLength) };
  }
  if (types.includes("array") && isRecord(schema.items)) {
    const options = choicesOf(schema.items as JsonObject);
    if (options) return { kind: "set", options };
    // A list of connection ids is picked from the user's connections, never typed: a typed name would be kept and match nothing.
    if ((schema.items as JsonObject).format === "connection") return { kind: "connections" };
    if (typesOf(schema.items as JsonObject).includes("string")) return { kind: "list" };
  }
  return { kind: "json" };
}

function fieldsOf(properties: JsonObject, path: SettingPath, value: JsonValue, fallback: JsonValue | undefined, skip: string | null): FormNode[] {
  const out: FormNode[] = [];
  for (const [key, schema] of Object.entries(properties)) {
    if (key === skip || !isRecord(schema)) continue;
    out.push(nodeOf(key, schema as JsonObject, [...path, key], valueAt(value, [key]), valueAt(fallback, [key]), properties, null));
  }
  return out;
}

function nodeOf(key: string, schema: JsonObject, path: SettingPath, value: JsonValue | undefined, fallback: JsonValue | undefined, siblings: JsonObject | null, label: string | null): FormNode {
  const held = value === undefined ? (fallback ?? initialOf(schema)) : value;
  return {
    path,
    key,
    label: label ?? text(schema.title) ?? keyLabel(key),
    help: text(schema.description),
    value: held,
    fallback: fallback ?? null,
    // A setting the backend sent no value for stands at its default, whatever the form shows for it.
    changed: value !== undefined && !sameJson(value, fallback),
    nullable: typesOf(schema).includes("null"),
    none: text(schema["x-none"]) ?? "None",
    control: controlOf(schema, path, held, fallback, siblings),
  };
}

/** The settings as a form: the root group, its fields the settings' top-level keys in the schema's order. */
export function formOf(settings: SettingsView): FormNode {
  return nodeOf("", settings.schema, [], settings.values, settings.defaults, null, "Settings");
}

/** Whether a node holds other nodes rather than a value of its own. */
export function isBranch(node: FormNode): boolean {
  return node.control.kind === "group" || node.control.kind === "table" || node.control.kind === "variant";
}

/** The nodes a node holds, in order; none for a leaf. */
export function childrenOf(node: FormNode): FormNode[] {
  const c = node.control;
  return c.kind === "group" ? c.fields : c.kind === "table" ? c.rows : c.kind === "variant" ? c.fields : [];
}

/** Every leaf under a node (itself, for a leaf), in order. */
export function leavesOf(node: FormNode): FormNode[] {
  if (!isBranch(node)) return [node];
  return childrenOf(node).flatMap(leavesOf);
}

/** How many settings under a node differ from their defaults. A table or a shape that differs as a whole counts once where no setting inside it does (a row removed, another shape chosen). */
export function changedCount(node: FormNode): number {
  if (!isBranch(node)) return node.changed ? 1 : 0;
  const inside = childrenOf(node).reduce((sum, child) => sum + changedCount(child), 0);
  return inside === 0 && node.changed ? 1 : inside;
}

/** A section of the Settings page: what its row opens. `parts` are its own groups, each a section too, where it holds nothing but groups (the agents, one each). */
export interface NavSection {
  key: string;
  node: FormNode;
  /** The paths that put it back to its defaults: its own, or each of its settings' where it is a gathering of loose ones. */
  resets: SettingPath[];
  parts: NavSection[];
}

/** The sections under one heading of the Settings page's list. */
export interface NavGroup {
  heading: string;
  sections: NavSection[];
}

/** The loose settings of a group, gathered as a section of their own, "General". */
function generalOf(parent: FormNode, loose: FormNode[]): NavSection {
  return { key: `${pathKey(parent.path)}*`, node: { ...parent, key: "general", label: "General", help: null, changed: loose.some((f) => f.changed), control: { kind: "group", fields: loose } }, resets: loose.map((f) => f.path), parts: [] };
}

function sectionOf(node: FormNode): NavSection {
  const inside = node.control.kind === "group" ? node.control.fields : [];
  // A group of nothing but groups, two or more: each is worth a row of its own under it.
  const parts = inside.length >= 2 && inside.every((f) => f.control.kind === "group") ? inside.map(sectionOf) : [];
  return { key: pathKey(node.path), node, resets: [node.path], parts };
}

/**
 * The Settings page's list. The backend's settings are sections of sections (the core's, the
 * transport's, an extension's own), so a top-level group that holds groups is a heading, and each
 * group in it a section; its loose settings gather in a section "General". Anything else at the top
 * (a group of plain settings, a table, a loose setting) goes under a first heading, "Settings".
 */
export function navOf(root: FormNode): NavGroup[] {
  const groups: NavGroup[] = [];
  const plain: FormNode[] = [];
  const loose: FormNode[] = [];
  for (const top of childrenOf(root)) {
    if (!isBranch(top)) loose.push(top);
    else if (top.control.kind === "group" && top.control.fields.some(isBranch)) {
      const own = top.control.fields.filter((f) => !isBranch(f));
      groups.push({ heading: top.label, sections: [...(own.length > 0 ? [generalOf(top, own)] : []), ...top.control.fields.filter(isBranch).map(sectionOf)] });
    } else plain.push(top);
  }
  const first = [...(loose.length > 0 ? [generalOf(root, loose)] : []), ...plain.map(sectionOf)];
  return first.length > 0 ? [{ heading: "Settings", sections: first }, ...groups] : groups;
}

/** Every section of the list, each part after the section it is part of. */
export function allSections(nav: readonly NavGroup[]): NavSection[] {
  return nav.flatMap((g) => g.sections.flatMap((s) => [s, ...s.parts]));
}

/** The section that shows the setting at `path`: the smallest one that holds it; null when none does. */
export function sectionFor(nav: readonly NavGroup[], path: readonly string[]): NavSection | null {
  let best: NavSection | null = null;
  for (const s of allSections(nav)) {
    const holds = leavesOf(s.node).some((leaf) => leaf.path.length === path.length && leaf.path.every((k, i) => k === path[i]));
    if (holds && (best === null || leavesOf(s.node).length < leavesOf(best.node).length)) best = s;
  }
  return best;
}

/** The section that shows the group at `path` (or a setting under it): the one whose own place is the longest start of `path`; null when none is. A lead from another page may name a group, where `sectionFor` finds only a setting. */
export function sectionAt(nav: readonly NavGroup[], path: readonly string[]): NavSection | null {
  let best: NavSection | null = null;
  for (const s of allSections(nav)) {
    const own = s.node.path;
    if (own.length <= path.length && own.every((key, i) => key === path[i]) && (best === null || own.length > best.node.path.length)) best = s;
  }
  return best;
}

/**
 * Where the settings shown keep a setting another page names by its place among the core's own
 * settings or the transport's (`["guidance", "chars"]`): at their root, or inside one section
 * (`core`, `transport` in LumiAH's own). Null where they hold none such.
 */
export function settingPlace(schema: JsonObject, tail: readonly string[]): string[] | null {
  const holds = (root: JsonObject): boolean => {
    let at: JsonObject = root;
    for (const key of tail) {
      const next = isRecord(at.properties) ? at.properties[key] : undefined;
      if (!isRecord(next)) return false;
      at = next as JsonObject;
    }
    return true;
  };
  if (holds(schema)) return [...tail];
  for (const [key, section] of Object.entries(isRecord(schema.properties) ? schema.properties : {})) if (isRecord(section) && holds(section as JsonObject)) return [key, ...tail];
  return null;
}

/** A way straight to one of the few settings most people change first: what it is called there, a line on it, and the section it opens. */
export interface StartHere {
  path: readonly string[];
  label: string;
  about: string;
  section: NavSection;
}

/**
 * The few groups of LumiAH's own settings most people change first, by their place, in the words a
 * newcomer would look for them under. Which they are is a judgement about the page, not a limit on
 * anything: every setting stays in the full list under them and in the search.
 */
const START_HERE: readonly { path: readonly string[]; label: string; about: string }[] = [
  { path: ["core", "agents", "main"], label: "The main agent's model", about: "The connection and model the agent that reads your story thinks with. Left alone, it is the chat's own." },
  { path: ["transport", "history"], label: "How much of the chat stays in the prompt", about: "The latest messages stay word for word; the agents read the rest when a reply needs it." },
  { path: ["core", "spend"], label: "Spending caps", about: "The most tokens or money a day. Once reached, the next model call is refused and says so." },
  { path: ["core", "approval"], label: "Ask before a tool runs", about: "Which kinds of tool call go ahead, and which ask permission first." },
  { path: ["core", "recall", "meaning"], label: "Search by meaning", about: "Let lore and chat searches also find what says the same in other words. It is off until you switch it on: each text is then sent once to your embedding connection." },
];

/** The ways straight to those settings that the settings shown hold (none where they are another's, as the preview's sample is). */
export function startHere(nav: readonly NavGroup[]): StartHere[] {
  return START_HERE.flatMap((start) => {
    const section = sectionAt(nav, start.path);
    return section !== null && section.node.path.length === start.path.length ? [{ ...start, section }] : [];
  });
}

/**
 * How a section opens: `first` are the settings shown at once, `more` those folded under `label`
 * until asked for.
 */
export interface SectionFold {
  first: FormNode[];
  more: FormNode[];
  label: string;
}

/**
 * An agent's section opens on its connection and its model, which is what most people come to
 * change; its effort, its tools and its budget are folded under one disclosure, which says how many
 * of them were changed so none is changed out of sight. Null for any other section: it shows whole.
 */
export function foldOf(node: FormNode): SectionFold | null {
  if (node.control.kind !== "group") return null;
  const fields = node.control.fields;
  const leads = (f: FormNode): boolean => f.control.kind === "connection" || f.control.kind === "model";
  const more = fields.filter((f) => !leads(f));
  if (!fields.some((f) => f.control.kind === "connection") || !fields.some((f) => f.control.kind === "model") || more.length === 0) return null;
  const changed = more.reduce((n, f) => n + changedCount(f), 0);
  return { first: fields.filter(leads), more, label: changed > 0 ? `More for this agent (${count(changed)} changed)` : "More for this agent" };
}

/** Whether a fold's folded part holds the setting or the group at `key` (`pathKey`): the page opens it then, so a lead from a search or another page is never left hidden. */
export function foldHolds(fold: SectionFold, key: string): boolean {
  const within = (node: FormNode): boolean => pathKey(node.path) === key || childrenOf(node).some(within);
  return fold.more.some(within);
}

// ---------------------------------------------------------------- numbers as shown

type NumberControl = Extract<Control, { kind: "number" }>;

/** The unit the settings' schema names a span of time by. No page shows it: a time reads in seconds or minutes. */
const TIME_UNIT = "ms";
const SECOND_MS = 1000;
const MINUTE_MS = 60_000;

/** A step for − and + that suits a number's size: a tenth of its magnitude, so 32,000 steps by 1,000 and 8 by 1. */
export function niceStep(value: number, integer: boolean): number {
  const size = Math.abs(value);
  if (size < 10) return integer ? 1 : size < 1 ? 0.05 : 0.5;
  return 10 ** (Math.floor(Math.log10(size)) - 1) * (size < 100 ? 10 : 1);
}

/**
 * A number as its setting shows it and takes it typed. A span of time is kept in milliseconds and
 * shown in seconds or minutes; every other number is shown as it is kept.
 */
export interface NumberShown {
  /** The value in the unit shown; null where the setting holds none. */
  value: number | null;
  /** The unit's word, fitted to the value ("1 minute", "5 minutes"); null where the schema names none. */
  unit: string | null;
  /** What one of the unit shown comes to as the setting is kept: 1 where they are the same. */
  per: number;
  integer: boolean;
  min: number | null;
  max: number | null;
  step: number;
}

/**
 * What a span of time is shown in, by its size and its step: minutes where it is a whole number of
 * them and steps by whole minutes, seconds otherwise. So five minutes read "5 minutes", ninety
 * seconds "90 seconds" and a quarter of a second "0.25 seconds".
 */
function timePer(ms: number, step: number | null): number {
  const whole = (n: number): boolean => n >= MINUTE_MS && n % MINUTE_MS === 0;
  return whole(ms) && (step === null || whole(step)) ? MINUTE_MS : SECOND_MS;
}

/** A bound of a time in the unit shown, kept to thousandths on the side that stays within it: a bound of one millisecond would else be a minute's sixty-thousandth, written out. */
function boundShown(bound: number | null, per: number, round: (n: number) => number): number | null {
  return bound === null ? null : round((bound / per) * 1000) / 1000;
}

/** A number setting as shown: `value` as kept (null: none), `fallback` its default where that is a number (a setting with no value takes its unit and step from it). */
export function shownNumber(control: NumberControl, value: number | null, fallback: number | null = null): NumberShown {
  const size = value ?? fallback ?? control.min ?? 0;
  if (control.unit !== TIME_UNIT) return { value, unit: control.unit, per: 1, integer: control.integer, min: control.min, max: control.max, step: control.step ?? niceStep(size, control.integer) };
  const per = timePer(size, control.step);
  const shown = value === null ? null : value / per;
  const word = per === MINUTE_MS ? "minute" : "second";
  return {
    value: shown,
    unit: shown === 1 ? word : `${word}s`,
    per,
    // Half a second and a minute and a half are both times someone sets.
    integer: false,
    min: boundShown(control.min, per, Math.ceil),
    max: boundShown(control.max, per, Math.floor),
    step: control.step !== null ? control.step / per : niceStep(size / per, Number.isInteger(size / per)),
  };
}

/** What a number typed in the unit shown is kept as: a time in whole milliseconds, any other number as typed. */
export function storedNumber(shown: Pick<NumberShown, "per">, typed: number): number {
  return shown.per === 1 ? typed : Math.round(typed * shown.per);
}

/** A setting's number with its thousands marked. Its fraction is kept to six places, as far as a typed number is: a price of 0.0125 isn't rounded away. */
const GROUPED = new Intl.NumberFormat("en-US", { maximumFractionDigits: 6 });

/**
 * What stands beside a number's field: its unit, with the number itself grouped before it once it is
 * long enough for grouping to help ("400,000 tokens"). The field holds the number plain, as it is
 * typed. Null where there is neither.
 */
export function besideNumber(value: number | null, unit: string | null): string | null {
  // From a thousand up a grouped number reads differently from the plain one.
  if (value === null || Math.abs(value) < 1000) return unit;
  return unit !== null ? `${GROUPED.format(value)} ${unit}` : GROUPED.format(value);
}

/** A setting's value in a few words, for a search's result and a row's summary. A number reads grouped, in the unit it is shown in ("400,000 tokens", "5 minutes"). */
export function valueWords(node: FormNode): string {
  const v = node.value;
  if (v === null) return node.none;
  if (node.control.kind === "choice") return node.control.options.find((o) => sameJson(o.value, v))?.label ?? String(v);
  if (node.control.kind === "number" && typeof v === "number") {
    const shown = shownNumber(node.control, v);
    return `${GROUPED.format(shown.value ?? v)}${shown.unit !== null ? ` ${shown.unit}` : ""}`;
  }
  if (typeof v === "boolean") return v ? "On" : "Off";
  if (typeof v === "string") return v === "" ? "(empty)" : v;
  if (typeof v === "number") return GROUPED.format(v);
  if (Array.isArray(v)) return v.length === 0 ? "(none)" : v.map((x) => (typeof x === "string" ? x : JSON.stringify(x))).join(", ");
  return JSON.stringify(v);
}

/** The settings a search finds: every leaf whose label, help, path or value holds each of the query's words; `trail` is the labels down to it. Case is ignored. */
export function searchSettings(root: FormNode, query: string): { node: FormNode; trail: string[] }[] {
  const words = query.toLowerCase().split(/\s+/).filter((w) => w !== "");
  if (words.length === 0) return [];
  const out: { node: FormNode; trail: string[] }[] = [];
  const walk = (node: FormNode, trail: string[]): void => {
    if (isBranch(node)) {
      for (const child of childrenOf(node)) walk(child, node.path.length === 0 ? trail : [...trail, node.label]);
      return;
    }
    // A number is found as it is typed too ("400000"), beside how it reads ("400,000 tokens").
    const hay = [...trail, node.label, node.help ?? "", node.path.join("."), valueWords(node), typeof node.value === "number" ? String(node.value) : ""].join("\n").toLowerCase();
    if (words.every((w) => hay.includes(w))) out.push({ node, trail });
  };
  walk(root, []);
  return out;
}

/** The node at a path; null when the form has none there. */
export function nodeAt(root: FormNode, path: readonly string[]): FormNode | null {
  let at: FormNode = root;
  for (let depth = 0; depth < path.length; depth += 1) {
    const next = childrenOf(at).find((child) => child.path.length === depth + 1 && child.path[depth] === path[depth]);
    if (!next) return null;
    at = next;
  }
  return at;
}

/** A path as one string, for keys and lookups: its keys as JSON, so no key's own characters can join two paths into one. */
export function pathKey(path: readonly (string | number)[]): string {
  return JSON.stringify(path.map(String));
}

/** The settings' refusals by the path each is about, for the field that shows it; one about a place inside a value lands on the nearest setting above it. */
export function problemsByPath(root: FormNode, problems: readonly UiProblem[]): Map<string, string> {
  const out = new Map<string, string>();
  for (const p of problems) {
    const path = p.path.map(String);
    let at = path;
    while (at.length > 0 && nodeAt(root, at) === null) at = at.slice(0, -1);
    const key = pathKey(at);
    out.set(key, out.has(key) ? `${out.get(key)} ${p.message}` : p.message);
  }
  return out;
}

/** A table without one of its rows: the value to set at the table's path. */
export function withoutRow(table: FormNode, key: string): JsonObject {
  const out: JsonObject = {};
  if (isRecord(table.value)) for (const [k, v] of Object.entries(table.value)) if (k !== key) out[k] = v as JsonValue;
  return out;
}

/** What a setting's text field holds as a list: one entry a line, blank lines left out. */
export function linesOf(textValue: string): string[] {
  return textValue
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line !== "");
}

// ---------------------------------------------------------------- backup

/** One change to the settings: a whole value at a path. */
export interface SettingChange {
  path: SettingPath;
  value: JsonValue;
}

/**
 * The least that makes the defaults into these settings, for a backup: each changed setting's value
 * at its path. A table that lost one of its default rows, a row the user added and a setting whose
 * shape was changed go whole, since no single setting inside them says that.
 */
export function changesOf(node: FormNode): SettingChange[] {
  if (!node.changed) return [];
  const c = node.control;
  if (c.kind === "group") return c.fields.flatMap(changesOf);
  if (c.kind === "table") {
    const defaults = isRecord(node.fallback) ? node.fallback : {};
    const held = isRecord(node.value) ? node.value : {};
    if (Object.keys(defaults).some((key) => !Object.hasOwn(held, key))) return [{ path: node.path, value: node.value }];
    return c.rows.flatMap((row) => (Object.hasOwn(defaults, row.key) ? changesOf(row) : [{ path: row.path, value: row.value }]));
  }
  if (c.kind === "variant") {
    const before = isRecord(node.fallback) ? (node.fallback[c.property] as JsonValue | undefined) : undefined;
    const now = isRecord(node.value) ? (node.value[c.property] as JsonValue | undefined) : undefined;
    return sameJson(before, now) ? c.fields.flatMap(changesOf) : [{ path: node.path, value: node.value }];
  }
  return [{ path: node.path, value: node.value }];
}

/** The level of a backup file's shape, so a reader can tell. */
export const BACKUP_VERSION = 1;

/** A backup of the user's settings and texts: what they changed from the defaults, and nothing of the defaults themselves, so a later build's new defaults aren't frozen by restoring it. */
export interface Backup {
  set: SettingChange[];
  texts: Record<string, string>;
}

export function backupJson(backup: Backup, exportedAt: number): string {
  return JSON.stringify({ lumiah: "settings", version: BACKUP_VERSION, exportedAt: new Date(exportedAt).toISOString(), set: backup.set, texts: backup.texts }, null, 2);
}

/** A backup file as read; a sentence saying what is wrong with it when it isn't one. */
export function backupOf(text: string): Backup | string {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (error) {
    return `This isn't JSON: ${error instanceof Error ? error.message : String(error)}`;
  }
  if (!isRecord(raw) || raw.lumiah !== "settings") return "This isn't a LumiAH settings backup: it doesn't say so.";
  if (raw.version !== BACKUP_VERSION) return `This backup is of version ${String(raw.version)}, and this LumiAH reads version ${BACKUP_VERSION}.`;
  if (!Array.isArray(raw.set) || !isRecord(raw.texts)) return "This backup is damaged: its settings or its texts are missing.";
  const set: SettingChange[] = [];
  for (const change of raw.set) {
    if (!isRecord(change) || !Array.isArray(change.path) || !change.path.every((key) => typeof key === "string") || change.value === undefined) return "This backup is damaged: one of its settings has no place or no value.";
    set.push({ path: change.path as string[], value: change.value as JsonValue });
  }
  const texts: Record<string, string> = {};
  for (const [id, body] of Object.entries(raw.texts)) {
    if (typeof body !== "string") return `This backup is damaged: its text ${id} isn't text.`;
    texts[id] = body;
  }
  return { set, texts };
}

// ---------------------------------------------------------------- texts

/** The placeholders a text uses: each `{{name}}`, once, in the order first used. */
export function placeholdersIn(body: string): string[] {
  const out = new Set<string>();
  for (const m of body.matchAll(/\{\{\s*([A-Za-z0-9_.-]+)\s*\}\}/g)) if (m[1] !== undefined) out.add(m[1]);
  return [...out];
}

/** What is wrong with a text against its placeholders: the required ones it leaves out, and the ones it uses that nothing fills. */
export function textProblems(body: string, vars: readonly { name: string; required?: true }[]): { missing: string[]; unknown: string[] } {
  const used = new Set(placeholdersIn(body));
  const known = new Set(vars.map((v) => v.name));
  return { missing: vars.filter((v) => v.required === true && !used.has(v.name)).map((v) => v.name), unknown: [...used].filter((name) => !known.has(name)) };
}
