// The user's settings and their own texts (DESIGN §3.3, §7), kept in user storage. The settings are
// sections, each with its defaults, its hand-written schema and its check: the core's (`core`) and
// the transport's (`transport`, src/link/settings.ts); an extension that uses LumiAH as a package
// adds its own. What is stored is only what the user changed: each change is a value put whole at a
// path, over the defaults, so a default that moves in a later build reaches every user who never
// touched it. Every change gets the next revision, which the runtimes and the pages follow.

import type { JsonObject, JsonValue } from "../../core/ports";
import type { SettingsSnapshot } from "../../link/contract";
import { hasOwn, isRecord } from "../../link/json";
import type { TransportSettings } from "../../link/settings";
import { TRANSPORT_KEY, transportOf } from "../../link/settings";
import type { SettingPath, SettingsView, TextDef, TextsView, UiProblem } from "../../shared/ui";
import { UserDocs } from "./docs";
import type { BackendHost } from "./spindle";

/** One section of the settings: the key it sits under, its defaults, its schema, and what it refuses of a section's values. */
export interface SettingsSection {
  key: string;
  defaults(): JsonObject;
  schema: JsonObject;
  /** What the section refuses of its values, for a user: a section whose names depend on what that user has (the core's: their extension's tools, their own agents) may ask for it first. */
  check(values: unknown, userId: string): UiProblem[] | Promise<UiProblem[]>;
}

/** The texts a model is sent: their definitions, and what a text of the user's own is refused for (null: it is taken). */
export interface TextsDef {
  defs: readonly TextDef[];
  check(id: string, text: string): string | null;
}

/** A value the user put at a path, whole. */
interface Own {
  path: string[];
  value: JsonValue;
}

interface Stored {
  v: 1;
  rev: number;
  own: Own[];
  texts: Record<string, string>;
  /** The user's own definitions (their agents and skills, and what they switched off: DESIGN §13), kept with the settings so both change under one revision. The core reads and checks them. */
  definitions?: JsonObject;
}

/** The settings refused a change: each value it refuses, where it is and why. */
export class SettingsRefused extends Error {
  constructor(
    message: string,
    readonly problems: UiProblem[],
  ) {
    super(message);
    this.name = "SettingsRefused";
  }
}

const FILE = "settings.json";

/** Keys no path may name: they reach an object's prototype, not a setting. */
const FORBIDDEN_KEYS: Readonly<Record<string, true>> = Object.assign(Object.create(null) as Record<string, true>, { __proto__: true, constructor: true, prototype: true });

const isPath = (v: unknown): v is string[] => Array.isArray(v) && v.every((k) => typeof k === "string");

/**
 * A stored value as it is read: a number past the most its setting takes reads as that most, down
 * through a group put whole. A build that lowers a maximum (a ceiling that protects the worker all
 * accounts share) would otherwise leave whoever had stored more with settings that refuse every
 * later change, of any setting: a change is checked with all the values it leaves standing.
 */
function capped(schema: unknown, value: JsonValue): JsonValue {
  if (!isRecord(schema)) return value;
  if (typeof value === "number") return typeof schema.maximum === "number" && value > schema.maximum ? schema.maximum : value;
  if (!isRecord(value) || !isRecord(schema.properties)) return value;
  // By the schema's own names, so no key of the stored value's is ever written that the schema doesn't have.
  for (const [key, child] of Object.entries(schema.properties)) if (hasOwn(value, key)) value[key] = capped(child, value[key] as JsonValue);
  return value;
}

/** A stored document, read: `schema` is the settings' whole, which what it holds is capped by. */
function storedOf(raw: unknown, schema: JsonObject): Stored | null {
  if (!isRecord(raw) || raw.v !== 1) return null;
  const own: Own[] = [];
  if (Array.isArray(raw.own))
    for (const o of raw.own) {
      if (!isRecord(o) || !isPath(o.path) || o.path.length === 0 || o.value === undefined) continue;
      let rule: unknown = schema;
      for (const key of o.path) rule = isRecord(rule) && isRecord(rule.properties) && hasOwn(rule.properties, key) ? rule.properties[key] : undefined;
      own.push({ path: o.path, value: capped(rule, o.value as JsonValue) });
    }
  const texts: Record<string, string> = {};
  if (isRecord(raw.texts)) for (const [id, text] of Object.entries(raw.texts)) if (typeof text === "string") texts[id] = text;
  return { v: 1, rev: typeof raw.rev === "number" && Number.isSafeInteger(raw.rev) && raw.rev >= 0 ? raw.rev : 0, own, texts, ...(isRecord(raw.definitions) ? { definitions: raw.definitions as JsonObject } : {}) };
}

const clone = <T extends JsonValue>(value: T): T => JSON.parse(JSON.stringify(value)) as T;

/** Whether `path` is `under` or below it. */
const within = (path: readonly string[], under: readonly string[]): boolean => under.length <= path.length && under.every((key, i) => path[i] === key);

/** The value at `path` in `root`; undefined when there is none. */
function at(root: JsonValue, path: readonly string[]): JsonValue | undefined {
  let node: JsonValue | undefined = root;
  for (const key of path) {
    if (!isRecord(node) || !hasOwn(node, key)) return undefined;
    node = (node as JsonObject)[key];
  }
  return node;
}

/** Puts `value` whole at `path` in `root` (undefined: takes the key away), making the groups on the way. */
function put(root: JsonObject, path: readonly string[], value: JsonValue | undefined): void {
  let node = root;
  for (const key of path.slice(0, -1)) {
    const next = node[key];
    if (!isRecord(next)) node[key] = {};
    node = node[key] as JsonObject;
  }
  const last = path.at(-1);
  if (last === undefined) return;
  if (value === undefined) delete node[last];
  else node[last] = value;
}

export class SettingsStore {
  private readonly docs: UserDocs<Stored>;
  private readonly listeners: ((userId: string, revision: number) => void)[] = [];
  /** Each user's settings whole, as last worked out, by the revision they were worked out at. */
  private readonly whole = new Map<string, { rev: number; values: JsonObject; transport: TransportSettings }>();

  constructor(
    host: Pick<BackendHost, "storage" | "log">,
    private readonly sections: readonly SettingsSection[],
    private readonly textsDef: TextsDef,
  ) {
    this.docs = new UserDocs<Stored>(
      host,
      FILE,
      (raw) => storedOf(raw, this.schema()),
      () => ({ v: 1, rev: 0, own: [], texts: {} }),
    );
  }

  /** The user's settings or texts changed: told with the new revision. */
  onChange(listener: (userId: string, revision: number) => void): void {
    this.listeners.push(listener);
  }

  /** The defaults of every section. */
  defaults(): JsonObject {
    const out: JsonObject = {};
    for (const section of this.sections) out[section.key] = section.defaults();
    return out;
  }

  /** The schema of the settings whole: each section under its key. */
  schema(): JsonObject {
    const properties: JsonObject = {};
    for (const section of this.sections) properties[section.key] = section.schema;
    return { type: "object", additionalProperties: false, properties };
  }

  private valuesOf(own: readonly Own[]): JsonObject {
    const values = this.defaults();
    // A value nearer the root first, so one put deeper since stands over it.
    for (const o of [...own].sort((a, b) => a.path.length - b.path.length)) put(values, o.path, clone(o.value));
    return values;
  }

  private async current(userId: string): Promise<{ rev: number; values: JsonObject; transport: TransportSettings }> {
    const stored = await this.docs.get(userId);
    const held = this.whole.get(userId);
    if (held !== undefined && held.rev === stored.rev) return held;
    const values = this.valuesOf(stored.own);
    const now = { rev: stored.rev, values, transport: transportOf(values[TRANSPORT_KEY]) };
    this.whole.set(userId, now);
    return now;
  }

  /** The user's settings whole, the defaults under what they changed. */
  async values(userId: string): Promise<JsonObject> {
    return (await this.current(userId)).values;
  }

  /** The transport's own section, read. */
  async transport(userId: string): Promise<TransportSettings> {
    return (await this.current(userId)).transport;
  }

  async revision(userId: string): Promise<number> {
    return (await this.docs.get(userId)).rev;
  }

  /**
   * What the core reads where it runs (a runtime's `settings.get`; built in, the same): the user's
   * own values alone, with no default filled in. Each section's reader fills in its own defaults,
   * and the core's does so with the run's definitions in view: a default handed over as if the user
   * had set it would stand over what their own definition of an agent says.
   */
  async snapshot(userId: string): Promise<SettingsSnapshot> {
    const stored = await this.docs.get(userId);
    const values: JsonObject = {};
    // A value nearer the root first, so one put deeper since stands over it.
    for (const o of [...stored.own].sort((a, b) => a.path.length - b.path.length)) put(values, o.path, clone(o.value));
    return { revision: stored.rev, values, texts: { ...stored.texts }, definitions: clone(stored.definitions ?? {}) };
  }

  async view(userId: string): Promise<SettingsView> {
    return { values: await this.values(userId), defaults: this.defaults(), schema: this.schema() };
  }

  async texts(userId: string): Promise<TextsView> {
    return { defs: [...this.textsDef.defs], own: { ...(await this.docs.get(userId)).texts } };
  }

  /**
   * Changes settings (`lah.settings.set`): each `set` puts a value whole at a path, each `reset` takes
   * the user's own value at a path away so its default stands (an empty path: every setting). All of
   * them are kept or, when a section refuses the result, none.
   */
  async change(userId: string, set: readonly { path: SettingPath; value: JsonValue }[], reset: readonly SettingPath[]): Promise<SettingsView> {
    const stored = await this.docs.get(userId);
    const defaults = this.defaults();
    let own = stored.own.map((o) => ({ path: [...o.path], value: clone(o.value) }));
    const known = (path: readonly string[]): UiProblem | null => {
      const bad = path.find((key) => hasOwn(FORBIDDEN_KEYS, key) || key === "");
      if (bad !== undefined) return { path: [...path], message: `"${bad}" can't name a setting.` };
      const section = path[0];
      if (section !== undefined && !this.sections.some((s) => s.key === section)) return { path: [...path], message: `There is no settings section "${section}".` };
      return null;
    };
    /** Puts `value` at `path` among the user's own values: inside the value they put at a path above it, when there is one; else as a value of its own, in place of any put at or below it. */
    const place = (path: string[], value: JsonValue | undefined): void => {
      const above = own.find((o) => o.path.length < path.length && within(path, o.path));
      own = own.filter((o) => !within(o.path, path));
      if (above !== undefined) {
        const rest = path.slice(above.path.length);
        if (!isRecord(above.value)) above.value = {};
        // Back to its default inside a value put whole above it: the default is written there, since the value above stands for everything under it.
        put(above.value as JsonObject, rest, value ?? at(defaults, path));
      } else if (value !== undefined) own.push({ path, value });
    };
    const problems: UiProblem[] = [];
    for (const path of reset) {
      const problem = known(path);
      if (problem) problems.push(problem);
      else if (path.length === 0) own = [];
      else place([...path], undefined);
    }
    for (const { path, value } of set) {
      const problem = known(path) ?? (path.length === 0 ? { path: [], message: "A value is put at a setting, not over all of them." } : null);
      if (problem) problems.push(problem);
      else place([...path], clone(value));
    }
    const values = this.valuesOf(own);
    for (const section of this.sections) for (const p of await section.check(values[section.key], userId)) problems.push({ path: [section.key, ...p.path], message: p.message });
    if (problems.length > 0) throw new SettingsRefused(`The settings refused ${problems.length === 1 ? "a value" : `${problems.length} values`}: nothing was changed.`, problems);
    const revision = await this.docs.change(userId, (doc) => {
      doc.own = own;
      return ++doc.rev;
    });
    for (const listener of this.listeners) listener(userId, revision);
    return this.view(userId);
  }

  /** The user's own text for `id` (`lah.text.set`), or back to its default (`text` null). */
  async text(userId: string, id: string, text: string | null): Promise<TextsView> {
    if (!this.textsDef.defs.some((d) => d.id === id)) throw new SettingsRefused(`There is no text "${id}".`, [{ path: [id], message: "There is no such text." }]);
    if (text !== null) {
      const refused = this.textsDef.check(id, text);
      if (refused !== null) throw new SettingsRefused(refused, [{ path: [id], message: refused }]);
    }
    const revision = await this.docs.change(userId, (doc) => {
      if (text === null) delete doc.texts[id];
      else doc.texts[id] = text;
      return ++doc.rev;
    });
    for (const listener of this.listeners) listener(userId, revision);
    return this.texts(userId);
  }

  /** The user's own definitions as stored; `{}` while they have none. */
  async definitions(userId: string): Promise<JsonObject> {
    return clone((await this.docs.get(userId)).definitions ?? {});
  }

  /** Keeps the user's own definitions, whole: a new revision, told like any other change, so the runtime reads them before its next run. */
  async setDefinitions(userId: string, definitions: JsonObject): Promise<void> {
    const kept = clone(definitions);
    const revision = await this.docs.change(userId, (doc) => {
      doc.definitions = kept;
      return ++doc.rev;
    });
    for (const listener of this.listeners) listener(userId, revision);
  }

  /** Resolves once every write is done (tests). */
  settle(): Promise<void> {
    return this.docs.settle();
  }
}
