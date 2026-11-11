// The Settings page's forms as built from the settings' schema: which control edits each setting,
// what the list of sections holds, what a search finds, and what a backup keeps.

import { describe, expect, test } from "bun:test";
import { SAMPLE_SCHEMA, sampleDefaults } from "../../dev/preview/fixtures";
import { MockBackend } from "../../dev/preview/mock-backend";
import { realSettings } from "../../dev/preview/sections";
import {
  allSections,
  backupJson,
  backupOf,
  changedCount,
  changesOf,
  type FormNode,
  formOf,
  initialOf,
  keyLabel,
  leavesOf,
  linesOf,
  navOf,
  nodeAt,
  pathKey,
  placeholdersIn,
  problemsByPath,
  sameJson,
  searchSettings,
  sectionAt,
  sectionFor,
  startHere,
  textProblems,
  valueWords,
  withoutRow,
} from "../../src/extension/frontend/settings-model";
import type { JsonObject, JsonValue, SettingsView } from "../../src/shared/ui";

/** The sample section as the backend sends it, with `set` put over its defaults. */
function settings(set: { path: string[]; value: JsonValue }[] = []): SettingsView {
  const defaults: JsonObject = { sample: sampleDefaults() };
  const values: JsonObject = { sample: sampleDefaults() };
  for (const { path, value } of set) {
    let at: JsonObject = values;
    for (const key of path.slice(0, -1)) at = at[key] as JsonObject;
    at[path.at(-1) as string] = value;
  }
  return { schema: { type: "object", properties: { sample: SAMPLE_SCHEMA } }, defaults, values };
}

/** The node at a path under the sample section; the test fails where there is none. */
function at(root: FormNode, ...path: string[]): FormNode {
  const node = nodeAt(root, ["sample", ...path]);
  if (node === null) throw new Error(`no setting at ${path.join(".")}`);
  return node;
}

describe("each setting gets the control that fits it", () => {
  const form = formOf(settings());

  test("a choice among named values shows each with its words", () => {
    const writer = at(form, "reply", "writer");
    expect(writer.label).toBe("Who writes the reply");
    expect(writer.help).toBe("A separate writer, or the main agent itself.");
    expect(writer.control).toEqual({
      kind: "choice",
      options: [
        { value: "writer", label: "The writer", help: "A second call writes the prose." },
        { value: "main", label: "The main agent", help: "Its final answer is the reply." },
      ],
    });
    expect(at(form, "agents", "main", "effort").control).toMatchObject({ kind: "choice", options: [{ label: "inherit" }, { label: "off" }, { label: "low" }, { label: "medium" }, { label: "high" }] });
  });

  test("among an agent's tools, the entries that stand for a group of tools are said in words; a tool keeps its name", () => {
    const given: SettingsView = {
      schema: { type: "object", properties: { tools: { type: "array", title: "Tools", uniqueItems: true, items: { type: "string", enum: ["lore_search", "@workspace", "@mcp:tides", "@added"] } } } },
      defaults: { tools: [] },
      values: { tools: ["@added"] },
    };
    const control = formOf(given).control;
    const tools = control.kind === "group" ? control.fields[0]?.control : undefined;
    expect(tools).toEqual({
      kind: "set",
      options: [
        { value: "lore_search", label: "lore_search", help: null },
        { value: "@workspace", label: "Every workspace tool", help: "Those the family gains later too." },
        { value: "@mcp:tides", label: "Every tool of the MCP server tides", help: "Those it gains later too." },
        { value: "@added", label: "Tools you added (MCP servers and extensions)", help: "Every tool of the MCP servers you switched on for agents and of your extensions, those added later too." },
      ],
    });
  });

  test("a switch, a number with its range and unit, a text, a list", () => {
    expect(at(form, "reply", "progress").control).toEqual({ kind: "boolean" });
    expect(at(form, "agents", "main", "budget", "toolTurns")).toMatchObject({ nullable: true, none: "No limit", control: { kind: "number", integer: true, min: 0, max: null, unit: "rounds" } });
    expect(at(form, "notes").control).toEqual({ kind: "text", multiline: true, maxLength: 2000 });
    expect(at(form, "stops").control).toEqual({ kind: "list" });
  });

  test("a connection is picked from the user's connections, and a model from those of the connection beside it", () => {
    expect(at(form, "agents", "main", "connectionId")).toMatchObject({ nullable: true, none: "Your default connection", control: { kind: "connection" } });
    expect(at(form, "agents", "main", "model").control).toEqual({ kind: "model", connection: ["sample", "agents", "main", "connectionId"] });
    expect(at(form, "agents", "writer", "model").control).toEqual({ kind: "model", connection: ["sample", "agents", "writer", "connectionId"] });
  });

  test("a list of named values is a set to tick", () => {
    const tools = at(form, "agents", "main", "tools");
    expect(tools.control).toMatchObject({ kind: "set", options: [{ value: "chat_search" }, { value: "lore_read" }, { value: "write_reply", help: "Briefs the writer." }] });
    expect(valueWords(tools)).toBe("chat_search, lore_read, write_reply");
  });

  test("a setting with several shapes shows the one chosen, with that shape's own settings", () => {
    const history = at(form, "history");
    expect(history.control).toMatchObject({ kind: "variant", property: "keep", current: 1, variants: [{ value: "all", label: "Every message" }, { value: "last", label: "The latest" }] });
    expect(leavesOf(history).map((leaf) => leaf.path)).toEqual([["sample", "history", "count"]]);
    const all = at(formOf(settings([{ path: ["sample", "history"], value: { keep: "all" } }])), "history");
    expect(all.control).toMatchObject({ kind: "variant", current: 0, fields: [] });
  });

  test("a table has a row a key, and says what names its rows", () => {
    const empty = at(form, "prices");
    expect(empty.control).toMatchObject({ kind: "table", keys: "model", rows: [] });
    const priced = at(formOf(settings([{ path: ["sample", "prices"], value: { "deepseek-v4-flash": { in: 0.14, out: 0.28 } } }])), "prices");
    expect(priced.control.kind === "table" && priced.control.rows.map((row) => [row.label, row.path])).toEqual([["deepseek-v4-flash", ["sample", "prices", "deepseek-v4-flash"]]]);
    expect(leavesOf(priced).map((leaf) => leaf.label)).toEqual(["Prompt", "Answer"]);
  });

  test("a setting the page has no form for is still there, as JSON to edit", () => {
    expect(at(form, "odd")).toMatchObject({ label: "Something the page has no form for", control: { kind: "json" } });
  });

  test("a list of connection ids is picked from the user's connections, never typed; a table can hold a row per tool", () => {
    // The shapes LumiAH's own settings use: a list whose items are connection ids, and a table keyed by tool name.
    const view: SettingsView = {
      schema: {
        type: "object",
        properties: {
          oneToolAtATime: { type: "array", title: "One tool call per answer", uniqueItems: true, items: { type: "string", format: "connection", maxLength: 256 } },
          names: { type: "array", title: "Names", items: { type: "string" } },
          tools: { type: "object", title: "By tool", "x-keys": "tool", additionalProperties: { type: "string", default: "ask", oneOf: [{ const: "allow", title: "Allow" }, { const: "ask", title: "Ask first" }] } },
          other: { type: "object", title: "By anything", "x-keys": "planet", additionalProperties: { type: "integer" } },
        },
      },
      defaults: { oneToolAtATime: [], names: [], tools: {}, other: {} },
      values: { oneToolAtATime: ["conn-deepseek"], names: [], tools: { workspace_write: "ask" }, other: {} },
    };
    const root = formOf(view);
    expect(nodeAt(root, ["oneToolAtATime"])?.control).toEqual({ kind: "connections" });
    expect(nodeAt(root, ["oneToolAtATime"])?.changed).toBe(true);
    // A list of plain strings is still typed, one a line.
    expect(nodeAt(root, ["names"])?.control).toEqual({ kind: "list" });
    const tools = nodeAt(root, ["tools"])?.control;
    expect(tools?.kind === "table" && [tools.keys, tools.rows.map((r) => [r.key, r.value])]).toEqual(["tool", [["workspace_write", "ask"]]]);
    // A kind of key the page doesn't know is a name to type.
    const other = nodeAt(root, ["other"])?.control;
    expect(other?.kind === "table" && other.keys).toBe("name");
  });

  test("a setting without a title is labelled from its key", () => {
    expect(keyLabel("tokensIn")).toBe("Tokens in");
    expect(keyLabel("max_rounds")).toBe("Max rounds");
    expect(keyLabel("wallMs")).toBe("Wall ms");
    expect(keyLabel("__")).toBe("__");
  });

  test("a schema that isn't what it should be is not trusted: the setting falls back to JSON", () => {
    const odd: SettingsView = { schema: { type: "object", properties: { a: { type: "string", oneOf: "nonsense", enum: 4 }, b: { type: 7 }, c: "not a schema" } }, defaults: { a: "x", b: 1 }, values: { a: "x", b: 1 } };
    const form = formOf(odd);
    expect(nodeAt(form, ["a"])?.control).toEqual({ kind: "text", multiline: false, maxLength: null });
    expect(nodeAt(form, ["b"])?.control).toEqual({ kind: "json" });
    expect(nodeAt(form, ["c"])).toBeNull();
  });
});

describe("what differs from the defaults", () => {
  test("nothing does until something is changed", () => {
    expect(changedCount(formOf(settings()))).toBe(0);
  });

  test("each changed setting counts once, wherever it is", () => {
    const form = formOf(
      settings([
        { path: ["sample", "reply", "writer"], value: "main" },
        { path: ["sample", "agents", "main", "budget", "toolTurns"], value: null },
        { path: ["sample", "stops"], value: ["THE END"] },
      ]),
    );
    expect(changedCount(form)).toBe(3);
    expect(at(form, "reply", "writer").changed).toBe(true);
    expect(at(form, "reply", "progress").changed).toBe(false);
    expect(changedCount(at(form, "agents"))).toBe(1);
  });

  test("another shape chosen, or a row added, counts once as a whole", () => {
    expect(changedCount(at(formOf(settings([{ path: ["sample", "history"], value: { keep: "all" } }])), "history"))).toBe(1);
    expect(changedCount(at(formOf(settings([{ path: ["sample", "prices"], value: { m: { in: 1, out: 2 } } }])), "prices"))).toBe(2);
  });

  test("the order of a value's keys is not a difference", () => {
    expect(sameJson({ keep: "last", count: 40 }, { count: 40, keep: "last" })).toBe(true);
    expect(sameJson([1, 2], [2, 1])).toBe(false);
    expect(sameJson(null, undefined)).toBe(false);
    expect(changedCount(formOf(settings([{ path: ["sample", "history"], value: { count: 40, keep: "last" } }])))).toBe(0);
  });

  test("a setting the backend sent no value for stands at its default", () => {
    const view = settings();
    delete (view.values.sample as JsonObject).notes;
    const notes = at(formOf(view), "notes");
    expect(notes).toMatchObject({ value: "", changed: false });
  });
});

describe("the list of sections", () => {
  const nav = navOf(formOf(settings([{ path: ["sample", "stops"], value: ["THE END"] }])));

  test("a section of sections is a heading, its groups the rows, its loose settings gathered as General", () => {
    expect(nav.map((g) => g.heading)).toEqual(["Sample"]);
    expect(nav[0]?.sections.map((s) => s.node.label)).toEqual(["General", "The reply", "Agents", "History cutoff", "Prices"]);
    const general = nav[0]?.sections[0];
    expect(general?.node.control.kind === "group" && general.node.control.fields.map((f) => f.key)).toEqual(["stops", "notes", "odd"]);
    // Putting General back to its defaults resets its own settings, not the whole section it was gathered from.
    expect(general?.resets).toEqual([["sample", "stops"], ["sample", "notes"], ["sample", "odd"]]);
    expect(general?.node.changed).toBe(true);
  });

  test("a group of nothing but groups gets a row for each: the agents, one each", () => {
    const agents = nav[0]?.sections[2];
    expect(agents?.parts.map((p) => p.node.label)).toEqual(["Main agent", "Writer"]);
    expect(allSections(nav).map((s) => s.node.label)).toEqual(["General", "The reply", "Agents", "Main agent", "Writer", "History cutoff", "Prices"]);
    expect(new Set(allSections(nav).map((s) => s.key)).size).toBe(7);
  });

  test("a setting opens in the smallest section that holds it", () => {
    expect(sectionFor(nav, ["sample", "agents", "main", "model"])?.node.label).toBe("Main agent");
    expect(sectionFor(nav, ["sample", "stops"])?.node.label).toBe("General");
    expect(sectionFor(nav, ["sample", "history", "count"])?.node.label).toBe("History cutoff");
    expect(sectionFor(nav, ["sample", "nowhere"])).toBeNull();
  });

  test("a lead that names a group opens the section that is that group, or the nearest one that holds it", () => {
    expect(sectionAt(nav, ["sample", "agents", "main"])?.node.label).toBe("Main agent");
    expect(sectionAt(nav, ["sample", "agents"])?.node.label).toBe("Agents");
    expect(sectionAt(nav, ["sample", "history", "count"])?.node.label).toBe("History cutoff");
    expect(sectionAt(nav, ["elsewhere"])).toBeNull();
  });

  test("the few settings most people change lead LumiAH's own list; settings that aren't LumiAH's get no such lead", () => {
    const settled = realSettings();
    const real = new MockBackend(() => {}, { scenario: "ready", turn: "none", sections: settled.sections, texts: settled.texts, delay: 0, page: 50, fail: new Set(), now: () => 0, later: () => () => {} }).state.settings;
    const starts = startHere(navOf(formOf(real)));
    expect(starts.map((s) => s.path.join("."))).toEqual(["core.agents.main", "transport.history", "core.spend", "core.approval", "core.recall.meaning"]);
    // Each opens the section that is exactly that group, so what the row promises is what shows.
    for (const start of starts) expect(start.section.node.path).toEqual([...start.path]);
    expect(startHere(nav)).toEqual([]);
  });

  test("settings that aren't sections of sections go under one heading, loose ones first", () => {
    const flat: SettingsView = {
      schema: { type: "object", properties: { verbose: { type: "boolean" }, limits: { type: "object", title: "Limits", properties: { rounds: { type: "integer" } } } } },
      defaults: { verbose: false, limits: { rounds: 4 } },
      values: { verbose: true, limits: { rounds: 4 } },
    };
    const flatNav = navOf(formOf(flat));
    expect(flatNav.map((g) => [g.heading, g.sections.map((s) => s.node.label)])).toEqual([["Settings", ["General", "Limits"]]]);
  });
});

describe("search", () => {
  const form = formOf(settings());

  test("finds a setting by its label, its help, its place or its value, whatever the case", () => {
    expect(searchSettings(form, "TOOL ROUNDS").map((r) => r.node.path.join("."))).toEqual(["sample.agents.main.budget.toolTurns"]);
    expect(searchSettings(form, "thinking block").map((r) => r.node.key)).toEqual(["progress"]);
    expect(searchSettings(form, "sample.reply.writer").map((r) => r.node.key)).toEqual(["writer"]);
    expect(searchSettings(form, "inherit").map((r) => r.node.key)).toEqual(["effort"]);
  });

  test("says where each find is, down from its heading", () => {
    expect(searchSettings(form, "tool rounds")[0]?.trail).toEqual(["Sample", "Agents", "Main agent", "Budget"]);
  });

  test("every word of the query must be there, in any order; the group's name counts", () => {
    // "writer" is the name of the group it is in, "default" a word of its value: "Your default connection".
    expect(searchSettings(form, "writer default").map((r) => r.node.path.join("."))).toEqual(["sample.agents.writer.connectionId"]);
    expect(searchSettings(form, "default writer").length).toBe(1);
    expect(searchSettings(form, "connection nothing-like-this")).toEqual([]);
    expect(searchSettings(form, "   ")).toEqual([]);
  });
});

describe("what the backend refused", () => {
  const form = formOf(settings());

  test("a refusal lands on its setting; one about a place inside a value, on the setting that holds it", () => {
    const by = problemsByPath(form, [
      { path: ["sample", "history", "count"], message: "It can't be under 1." },
      { path: ["sample", "odd", 0, "name"], message: "It must be text." },
      { path: ["sample", "odd", 1], message: "It must be an object." },
    ]);
    expect(by.get(pathKey(["sample", "history", "count"]))).toBe("It can't be under 1.");
    expect(by.get(pathKey(["sample", "odd"]))).toBe("It must be text. It must be an object.");
    expect(by.size).toBe(2);
  });

  test("two paths never share a key, whatever their keys hold", () => {
    expect(pathKey(["a.b", "c"])).not.toBe(pathKey(["a", "b.c"]));
    expect(pathKey(["a", 1])).toBe(pathKey(["a", "1"]));
  });
});

describe("rows, lists and new values", () => {
  test("a new row starts from the row's default, a number at its least, a setting that may be none at none", () => {
    expect(initialOf((SAMPLE_SCHEMA.properties as JsonObject).prices as JsonObject)).toEqual({});
    const prices = at(formOf(settings()), "prices");
    expect(prices.control.kind === "table" && initialOf(prices.control.row)).toEqual({ in: 0, out: 0 });
    expect(initialOf({ type: "integer", minimum: 3 })).toBe(3);
    expect(initialOf({ type: ["string", "null"] })).toBeNull();
    expect(initialOf({ type: "object", properties: { on: { type: "boolean" }, name: { type: "string" } } })).toEqual({ on: false, name: "" });
  });

  test("another shape chosen starts with that shape's own settings", () => {
    const history = at(formOf(settings()), "history");
    const shapes = history.control.kind === "variant" ? history.control.variants : [];
    expect(shapes.map((v) => initialOf(v.schema))).toEqual([{ keep: "all" }, { keep: "last", count: 1 }]);
  });

  test("a table without one of its rows keeps the others", () => {
    const prices = at(formOf(settings([{ path: ["sample", "prices"], value: { a: { in: 1, out: 2 }, b: { in: 3, out: 4 } } }])), "prices");
    expect(withoutRow(prices, "a")).toEqual({ b: { in: 3, out: 4 } });
  });

  test("a list typed one a line leaves blank lines and stray spaces out", () => {
    expect(linesOf("  THE END \n\n***\n   \n")).toEqual(["THE END", "***"]);
  });

  test("a value in a few words", () => {
    const form = formOf(settings([{ path: ["sample", "agents", "main", "budget", "toolTurns"], value: 12 }]));
    expect(valueWords(at(form, "agents", "main", "budget", "toolTurns"))).toBe("12 rounds");
    expect(valueWords(at(form, "agents", "main", "budget", "wallMs"))).toBe("No limit");
    expect(valueWords(at(form, "reply", "writer"))).toBe("The writer");
    expect(valueWords(at(form, "reply", "progress"))).toBe("On");
    expect(valueWords(at(form, "notes"))).toBe("(empty)");
    expect(valueWords(at(form, "stops"))).toBe("(none)");
  });
});

describe("a backup", () => {
  test("keeps what was changed and nothing of the defaults", () => {
    expect(changesOf(formOf(settings()))).toEqual([]);
    const form = formOf(
      settings([
        { path: ["sample", "reply", "writer"], value: "main" },
        { path: ["sample", "agents", "main", "model"], value: "deepseek-v4-pro" },
        { path: ["sample", "history"], value: { keep: "last", count: 12 } },
      ]),
    );
    expect(changesOf(form)).toEqual([
      { path: ["sample", "reply", "writer"], value: "main" },
      { path: ["sample", "agents", "main", "model"], value: "deepseek-v4-pro" },
      { path: ["sample", "history", "count"], value: 12 },
    ]);
  });

  test("another shape goes whole, and so does a row the user added", () => {
    const form = formOf(
      settings([
        { path: ["sample", "history"], value: { keep: "all" } },
        { path: ["sample", "prices"], value: { "deepseek-v4-flash": { in: 0.14, out: 0.28 } } },
      ]),
    );
    expect(changesOf(form)).toEqual([
      { path: ["sample", "history"], value: { keep: "all" } },
      { path: ["sample", "prices", "deepseek-v4-flash"], value: { in: 0.14, out: 0.28 } },
    ]);
  });

  test("a table that lost a default row goes whole, since no row inside it says so", () => {
    const view = settings();
    (view.defaults.sample as JsonObject).prices = { a: { in: 1, out: 1 }, b: { in: 2, out: 2 } };
    (view.values.sample as JsonObject).prices = { b: { in: 2, out: 5 } };
    expect(changesOf(formOf(view))).toEqual([{ path: ["sample", "prices"], value: { b: { in: 2, out: 5 } } }]);
    // With every default row still there, only the changed setting of the changed row goes.
    (view.values.sample as JsonObject).prices = { a: { in: 1, out: 1 }, b: { in: 2, out: 5 } };
    expect(changesOf(formOf(view))).toEqual([{ path: ["sample", "prices", "b", "out"], value: 5 }]);
  });

  test("written to a file and read back, it is the same", () => {
    const backup = { set: [{ path: ["sample", "agents", "main", "budget", "toolTurns"], value: null }], texts: { "main.system": "Be brief.\n" } };
    const file = backupJson(backup, Date.UTC(2026, 10, 10, 9, 0, 0));
    expect(JSON.parse(file)).toMatchObject({ lumiah: "settings", version: 1, exportedAt: "2026-11-10T09:00:00.000Z" });
    expect(backupOf(file)).toEqual(backup);
  });

  test("a file that isn't a backup is refused in words that say why", () => {
    expect(backupOf("{ not json")).toStartWith("This isn't JSON:");
    expect(backupOf('{"lumiah":"turn","version":1}')).toBe("This isn't a LumiAH settings backup: it doesn't say so.");
    expect(backupOf('{"lumiah":"settings","version":2,"set":[],"texts":{}}')).toBe("This backup is of version 2, and this LumiAH reads version 1.");
    expect(backupOf('{"lumiah":"settings","version":1,"set":[]}')).toBe("This backup is damaged: its settings or its texts are missing.");
    expect(backupOf('{"lumiah":"settings","version":1,"set":[{"path":"a.b","value":1}],"texts":{}}')).toBe("This backup is damaged: one of its settings has no place or no value.");
    expect(backupOf('{"lumiah":"settings","version":1,"set":[],"texts":{"main.system":4}}')).toBe("This backup is damaged: its text main.system isn't text.");
  });
});

describe("a text's placeholders", () => {
  const vars = [{ name: "instructions", required: true as const }, { name: "conversation", required: true as const }, { name: "lore" }];

  test("each placeholder a text uses, once, in the order first used", () => {
    expect(placeholdersIn("{{b}} then {{ a }} then {{b}} and {{c.d-e}}")).toEqual(["b", "a", "c.d-e"]);
    expect(placeholdersIn("no braces, {single}, {{ }}")).toEqual([]);
  });

  test("a text that leaves a needed placeholder out, or uses one nothing fills, is told so", () => {
    expect(textProblems("{{instructions}}\n{{conversation}}\n{{lore}}", vars)).toEqual({ missing: [], unknown: [] });
    expect(textProblems("{{instructions}} and {{history}}", vars)).toEqual({ missing: ["conversation"], unknown: ["history"] });
    expect(textProblems("", vars)).toEqual({ missing: ["instructions", "conversation"], unknown: [] });
  });
});
