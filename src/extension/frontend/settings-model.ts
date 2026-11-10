// The Settings page's forms, built from the settings' schema (`shared/ui.ts` says which keywords),
// pure so it is tested without a browser. `formOf` reads the schema beside the values and their
// defaults into a tree of nodes, each with the control that edits it; a node the page has no control
// for becomes JSON to edit, so no setting is out of reach. The schema is the backend's, read as
// outside data: a keyword that isn't what it should be is left out, never trusted.

import { isRecord, type JsonObject, type JsonValue, type SettingPath, type SettingsView, type UiProblem } from "../../shared/ui";

export interface Choice {
  value: JsonValue;
  label: string;
  help: string | null;
}

/** What names a table's rows: one of the user's connections, a model, or any name. */
export type TableKeys = "connection" | "model" | "name";

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

/** A schema's choices: its `enum`, or its `oneOf` when every member is a `const` with words; null when it has neither. */
function choicesOf(schema: JsonObject): Choice[] | null {
  if (Array.isArray(schema.enum)) return schema.enum.map((value) => ({ value, label: value === null ? "None" : String(value), help: null }));
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
    const keys: TableKeys = schema["x-keys"] === "connection" || schema["x-keys"] === "model" ? schema["x-keys"] : "name";
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

/** A setting's value in a few words, for a search's result and a row's summary. */
export function valueWords(node: FormNode): string {
  const v = node.value;
  if (v === null) return node.none;
  if (node.control.kind === "choice") return node.control.options.find((o) => sameJson(o.value, v))?.label ?? String(v);
  if (node.control.kind === "number") return `${String(v)}${node.control.unit ? ` ${node.control.unit}` : ""}`;
  if (typeof v === "boolean") return v ? "On" : "Off";
  if (typeof v === "string") return v === "" ? "(empty)" : v;
  if (typeof v === "number") return String(v);
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
    const hay = [...trail, node.label, node.help ?? "", node.path.join("."), valueWords(node)].join("\n").toLowerCase();
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
