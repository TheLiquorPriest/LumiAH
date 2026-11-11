// Definitions (DESIGN §13, §21): the agents, skills and tools one run works with.
//
// Each has three sources: built in, the extension that builds LumiAH into itself, and the user. They
// are merged when a run starts, so a definition made, changed or switched off on the page holds from
// the next run on. A user's definition with the id of a built-in or an extension's stands over it;
// removing the user's restores the original, which was never changed.
//
// Tools merge by name too, with one rule of their own: an extension's tool that bears the name of a
// built-in replaces it only in a chat the extension claims (`ChatClaim`), and in such a chat the
// extension may withdraw built-ins it wants no agent to hold. Everywhere else the built-in stands.
//
// What an agent runs with (connection, model, effort, tools, budget) is a setting, kept under the
// definition's id; the definition's own values are what it runs with until the user sets others.

import { type AgentDefinition, type ResolvedAgent, resolveAgent } from "./agents";
import type { ChatClaim } from "./extension";
import type { DefinitionSource, HarnessHost, JsonObject, RemoteTool, ToolTier } from "./ports";
import { isRecord } from "./ports";
import type { RefusalProblem } from "./refusal";
import { ADDED_TOOLS, AGENT, type AgentSettings, CORE_AGENTS, newAgentSettings, readAgentSettings, type Settings, type SettingsScope } from "./settings";
import type { Skill } from "./skills";
import { toolId } from "./text-def";
import { TEXT, type Texts, textDef } from "./texts";
import type { AgentTool, ToolDefinition, ToolEnv } from "./tools";
import { hasOwn } from "./util";
import { takeChanges } from "./workspace";

// ---------------------------------------------------------------- as the page shows them

/**
 * Where a definition comes from, and how it stands: its source; for a user's definition that stands
 * over a built-in or an extension's of the same id, which (`over`: removing the user's restores that
 * original); and whether the user switched it off.
 */
export interface Sourced {
  source: DefinitionSource;
  over?: "builtin" | "extension";
  off: boolean;
}

/** An agent definition with where it comes from. What it runs with is given as it stands under Settings. */
export type AgentView = AgentDefinition & Sourced;

export type SkillView = Skill & Sourced;

/** A tool of the registry: what a model is told it does, its arguments' schema where the registry has it without building the tool (an extension's), and where it runs. */
export interface ToolView {
  name: string;
  family: string;
  tier: ToolTier;
  description: string;
  parameters?: JsonObject;
  runs: "runtime" | "extension";
  source: DefinitionSource;
  off: boolean;
}

export interface DefinitionsView {
  agents: AgentView[];
  skills: SkillView[];
  tools: ToolView[];
}

// ---------------------------------------------------------------- the user's own, as stored

/**
 * The user's definitions as the host keeps them, a stored format: their own agent definitions and
 * skills by id, each whole, and what they switched off, by id (a tool by its name). Nothing here
 * changes a built-in or an extension's definition: it stands over one, or switches one off.
 */
export interface StoredDefinitions {
  agents?: Record<string, AgentDefinition>;
  skills?: Record<string, Skill>;
  off?: { agents?: string[]; skills?: string[]; tools?: string[] };
}

/**
 * An id as a definition may bear it: letters, digits and `_ . : -`, starting with a letter or a
 * digit, 64 characters at most. Fixed, not a setting: an id is a name the tools, the settings and
 * the stored documents all key by, so its form has to hold still.
 */
const ID = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,63}$/;

const text = (value: unknown): value is string => typeof value === "string";

/**
 * The texts a definition may name as its instructions: those the core's own definitions name. A
 * user's definition that stands over one of them keeps following the text the user edits under
 * Texts until they write instructions of their own. Fixed: any other text is written for another
 * place and has placeholders an agent's instructions don't fill.
 */
const INSTRUCTION_TEXTS: readonly string[] = [TEXT.main.system, TEXT.agents.summarizer, TEXT.recall.chronicler, TEXT.recall.reader];

/**
 * An agent definition from what the page (or the store) holds, checked: the definition, or null with
 * what is wrong. `tools`: every tool and family the definition may name. What it runs with is read
 * as Settings are: a value the schema refuses is a problem, and reads as a new agent's.
 */
export function checkAgent(value: unknown, tools: readonly string[]): { agent: AgentDefinition | null; problems: RefusalProblem[] } {
  const problems: RefusalProblem[] = [];
  if (!isRecord(value)) return { agent: null, problems: [{ path: [], message: "It must be an agent definition." }] };
  const need = (key: string, what: string): string => {
    const v = value[key];
    if (text(v) && v.trim() !== "") return v;
    problems.push({ path: [key], message: `It needs ${what}.` });
    return "";
  };
  const id = need("id", "an id");
  if (id !== "" && !ID.test(id)) problems.push({ path: ["id"], message: "An id is letters, digits and _ . : - only, starts with a letter or a digit, and is at most 64 characters." });
  const name = need("name", "a name");
  const description = need("description", "a description: it is what another agent reads when it chooses whom to hand a task");
  if (!text(value.instructions)) problems.push({ path: ["instructions"], message: "Its instructions must be text." });
  if (value.given !== "request" && value.given !== "task") problems.push({ path: ["given"], message: "It must be given the whole request, or its task alone." });
  if (value.follows !== undefined && !(text(value.follows) && ID.test(value.follows))) problems.push({ path: ["follows"], message: "It must name an agent definition by its id." });
  if (value.grant !== undefined && value.grant !== "own" && value.grant !== "definition") problems.push({ path: ["grant"], message: "It must say own (no tool the agent that starts it doesn't hold) or definition (its own tools, whoever starts it), or be left out for Settings to decide." });
  if (value.text !== undefined && !(text(value.text) && INSTRUCTION_TEXTS.includes(value.text))) problems.push({ path: ["text"], message: `It may name only one of: ${INSTRUCTION_TEXTS.join(", ")}.` });
  const run: JsonObject = {};
  for (const key of ["connectionId", "model", "effort", "tools", "toolCalls", "budget"]) if (hasOwn(value, key)) run[key] = value[key] as JsonObject;
  const settings = readAgentSettings(run, tools, newAgentSettings(), [], problems);
  if (problems.length > 0) return { agent: null, problems };
  const grant = value.grant === "own" || value.grant === "definition" ? value.grant : undefined;
  return { agent: { id, name, description, instructions: value.instructions as string, ...(text(value.text) ? { text: value.text } : {}), given: value.given as "request" | "task", ...(text(value.follows) ? { follows: value.follows } : {}), ...(grant !== undefined ? { grant } : {}), ...settings }, problems };
}

/** A skill from what the page (or the store) holds, checked: the skill, or null with what is wrong. */
export function checkSkill(value: unknown): { skill: Skill | null; problems: RefusalProblem[] } {
  const problems: RefusalProblem[] = [];
  if (!isRecord(value)) return { skill: null, problems: [{ path: [], message: "It must be a skill." }] };
  const need = (key: string, what: string): string => {
    const v = value[key];
    if (text(v) && v.trim() !== "") return v;
    problems.push({ path: [key], message: `It needs ${what}.` });
    return "";
  };
  const id = need("id", "an id");
  if (id !== "" && !ID.test(id)) problems.push({ path: ["id"], message: "An id is letters, digits and _ . : - only, starts with a letter or a digit, and is at most 64 characters." });
  const name = need("name", "a name");
  const description = need("description", "a description: it is what an agent reads when it chooses a skill");
  const body = need("body", "a body: the procedure itself");
  return problems.length > 0 ? { skill: null, problems } : { skill: { id, name, description, body }, problems };
}

const strings = (value: unknown): string[] => (Array.isArray(value) ? value.filter(text) : []);

// ---------------------------------------------------------------- the merge

/** A tool as a run holds it: how it is built, where it comes from and runs, and whether the user switched it off. */
interface ToolRow {
  definition: ToolDefinition;
  source: DefinitionSource;
  runs: "runtime" | "extension";
  off: boolean;
  remote?: RemoteTool;
}

/** What a run's definitions are merged from. */
export interface DefinitionSources {
  /** Written in code: the core's own, and whatever was registered beside them. `core` names the core's own among them. */
  code: { agents: readonly AgentDefinition[]; skills: readonly Skill[]; tools: readonly ToolDefinition[] };
  core: { agents: ReadonlySet<string>; skills: ReadonlySet<string>; tools: ReadonlySet<string> };
  /** The extension's own agent definitions and skills, as it gave them (`HarnessExtension.definitions`): outside data, checked as the user's are. */
  extension: { agents: readonly unknown[]; skills: readonly unknown[] };
  /** The tools that run in the extension, as its port lists them now. */
  remote: readonly RemoteTool[];
  /** The user's definitions, as stored. */
  user: unknown;
  /** What the extension supplies for the run's chat; null for a chat it doesn't claim, and where there is no chat. */
  claim: ChatClaim | null;
}

/** A tool that runs in the extension, as a definition the registry builds like any other: its call goes over the host's port. */
function remoteDefinition(tool: RemoteTool, host: Pick<HarnessHost, "tools">): ToolDefinition {
  return {
    name: tool.name,
    family: tool.family,
    tier: tool.tier,
    build(env: ToolEnv): AgentTool | null {
      const port = host.tools;
      if (!port) return null;
      return {
        name: tool.name,
        description: tool.description,
        parameters: tool.parameters,
        tier: tool.tier,
        async run(args, ctx) {
          const { main = false, above = [] } = env.standing ?? {};
          // What the port answers comes from outside the core, whatever its type says: an answer that holds no text is a tool that gave nothing, told in words the agent can go on from.
          const answer: unknown = await port.call({ name: tool.name, args, turn: env.run.id, chatId: env.run.chatId, agentId: ctx.agentId, role: ctx.role, callId: ctx.callId, kind: env.run.kind, main, above: above.map(({ agentId, role, as }) => ({ agentId, role, ...(as !== undefined ? { as } : {}) })), ...(ctx.as !== undefined ? { as: ctx.as } : {}) }, ctx.signal);
          // A file the tool's owner kept for this call (`harness.workspace.writeAs`) is the call's change: it rides on its result, as a built-in workspace tool's does.
          const files = takeChanges(env.run, ctx.callId);
          const changed = files.length > 0 ? { files } : {};
          if (!isRecord(answer) || typeof answer.text !== "string") return { text: env.texts.render(TEXT.agents.remoteNothing, { tool: tool.name }), error: true, ...changed };
          return { text: answer.text, ...(answer.error === true ? { error: true as const } : {}), ...changed };
        },
      };
    },
  };
}

/** A definition that came from outside the core: the extension's as it gave it, or the user's as stored under `key`. */
interface Given {
  value: unknown;
  source: "extension" | "user";
  key?: string;
}

/** The extension's definitions, then the user's: the order in which each stands over the ones before it. */
function givenOf(extension: readonly unknown[], stored: unknown): Given[] {
  return [...extension.map((value): Given => ({ value, source: "extension" })), ...Object.entries(isRecord(stored) ? stored : {}).map(([key, value]): Given => ({ value, source: "user", key }))];
}

/** The log's line for a definition that isn't one, or that isn't kept under its own id: whose it is, which, and what is wrong with it. It is left out, and the run goes on with the rest. */
function unused(log: HarnessHost["log"], what: string, given: Given, problems: readonly RefusalProblem[]): void {
  const id = given.key ?? (isRecord(given.value) && text(given.value.id) ? given.value.id : null);
  const why = problems.map((p) => (p.path.length > 0 ? `${p.path.join(".")}: ${p.message}` : p.message)).join(" ") || "its id isn't the one it is kept under.";
  log("warn", `[LumiAH] ${given.source === "user" ? "your" : "the extension's"} ${what}${id === null ? "" : ` "${id}"`} isn't used: ${why}`);
}

/** The tools a run has, by name, before the user's own are read: built-ins, what was registered beside them, and the extension's, under the claim's rule. */
function mergeTools(sources: DefinitionSources, host: Pick<HarnessHost, "tools" | "log">): Map<string, ToolRow> {
  const rows = new Map<string, ToolRow>();
  for (const definition of sources.code.tools) rows.set(definition.name, { definition, source: sources.core.tools.has(definition.name) ? "builtin" : "extension", runs: "runtime", off: false });
  for (const tool of sources.remote) {
    // Only the extension's own tool may stand in for one of LumiAH's, and only where it claims the chat: anywhere else two tools of one name would be a model's guess.
    if (sources.core.tools.has(tool.name) && (tool.source !== "extension" || sources.claim === null)) continue;
    // An MCP server's tool takes nobody's name: it stands under its own (`mcp:<server>:<tool>`, §16). Asked of each tool as it is listed, so the order the port lists them in decides nothing.
    if (tool.source === "user" && rows.has(tool.name) && rows.get(tool.name)?.source !== "user") continue;
    rows.set(tool.name, { definition: remoteDefinition(tool, host), source: tool.source, runs: "extension", off: false, remote: tool });
  }
  for (const name of sources.claim?.withdraw ?? []) {
    if (rows.get(name)?.source === "builtin") rows.delete(name);
    else host.log("debug", `[LumiAH] the extension withdrew "${name}", which is no tool of LumiAH's here: nothing was withdrawn`);
  }
  return rows;
}

/** Every tool and every family `rows` hold, as an agent's tools may name them, and the name that stands for every tool that isn't built in. */
function namesOf(rows: ReadonlyMap<string, ToolRow>): string[] {
  const families = new Set<string>([ADDED_TOOLS]);
  for (const row of rows.values()) families.add(`@${row.definition.family}`);
  return [...rows.keys(), ...families];
}

/** The run fields of a definition: what it runs with by default. */
function runOf(d: AgentDefinition): AgentSettings {
  return { connectionId: d.connectionId, model: d.model, effort: d.effort, tools: [...d.tools], toolCalls: d.toolCalls, budget: { ...d.budget } };
}

/** The definitions of one run, merged from their sources. */
export function mergeDefinitions(sources: DefinitionSources, host: Pick<HarnessHost, "tools" | "log">): Definitions {
  const tools = mergeTools(sources, host);
  const names = namesOf(tools);
  const stored = isRecord(sources.user) ? sources.user : {};
  const off = isRecord(stored.off) ? stored.off : {};
  const offTools = strings(off.tools);
  for (const [name, row] of tools) row.off = offTools.includes(name);

  const agents = new Map<string, AgentView>();
  for (const d of sources.code.agents) agents.set(d.id, { ...d, source: sources.core.agents.has(d.id) ? "builtin" : "extension", off: false });
  for (const given of givenOf(sources.extension.agents, stored.agents)) {
    // A definition was checked against the tools there were when it was written. A tool it names that this run doesn't have (an MCP server switched off since, a built-in the extension withdraws in this chat, a tool the port didn't list this time) is no reason to lose the agent: the name stays, and gives nothing (`Definitions.names`).
    const { agent, problems } = checkAgent(given.value, [...names, ...strings(isRecord(given.value) ? given.value.tools : undefined)]);
    if (!agent || (given.key !== undefined && agent.id !== given.key)) {
      unused(host.log, "agent definition", given, problems);
      continue;
    }
    const under = agents.get(agent.id);
    agents.set(agent.id, { ...agent, source: given.source, ...(given.source === "user" && under && under.source !== "user" ? { over: under.source } : {}), off: false });
  }
  // The three a turn can't do without are never off, whatever is stored.
  const offAgents = strings(off.agents);
  for (const [id, view] of agents) view.off = offAgents.includes(id) && !CORE_AGENTS.includes(id);
  // The built-in agents the backend leaves out (`BackendOptions.withoutAgents`, handed over with the user's definitions as `without`): there is no such agent here, to list or to start, for anyone. The three a turn can't do without are never left out.
  const without = strings(stored.without).filter((id) => !CORE_AGENTS.includes(id));
  for (const id of without) agents.delete(id);

  const skills = new Map<string, SkillView>();
  for (const s of sources.code.skills) skills.set(s.id, { ...s, source: sources.core.skills.has(s.id) ? "builtin" : "extension", off: false });
  for (const given of givenOf(sources.extension.skills, stored.skills)) {
    const { skill, problems } = checkSkill(given.value);
    if (!skill || (given.key !== undefined && skill.id !== given.key)) {
      unused(host.log, "skill", given, problems);
      continue;
    }
    const under = skills.get(skill.id);
    skills.set(skill.id, { ...skill, source: given.source, ...(given.source === "user" && under && under.source !== "user" ? { over: under.source } : {}), off: false });
  }
  const offSkills = strings(off.skills);
  for (const [id, view] of skills) view.off = offSkills.includes(id);
  return new Definitions(agents, skills, tools, new Set(without));
}

/** One run's definitions. */
export class Definitions {
  constructor(
    private readonly agentRows: ReadonlyMap<string, AgentView>,
    private readonly skillRows: ReadonlyMap<string, SkillView>,
    private readonly toolRows: ReadonlyMap<string, ToolRow>,
    /** The built-in agents the backend leaves out: a call that names one is told it isn't offered here. */
    readonly without: ReadonlySet<string> = new Set(),
  ) {}

  /** An agent definition by its id; undefined for none, and for one switched off. */
  agent(id: string): AgentDefinition | undefined {
    const view = this.agentRows.get(id);
    return view && !view.off ? view : undefined;
  }

  /** Where the agent definition `id` comes from, and what it stands over; undefined for none, and for one switched off. */
  sourced(id: string): Pick<Sourced, "source" | "over"> | undefined {
    const view = this.agentRows.get(id);
    return view && !view.off ? { source: view.source, ...(view.over !== undefined ? { over: view.over } : {}) } : undefined;
  }

  /** Every agent definition that is switched on. */
  agents(): AgentDefinition[] {
    return [...this.agentRows.values()].filter((view) => !view.off);
  }

  /**
   * The definitions a task may be handed to (by `delegate`, or as a job): every one switched on but
   * the main agent and the writer, whose work is a turn's reply and nothing else, and `but` (the
   * agent choosing, which doesn't hand tasks to itself).
   */
  workers(but?: string): AgentDefinition[] {
    return this.agents().filter((d) => d.id !== AGENT.main && d.id !== AGENT.writer && d.id !== but);
  }

  /** Every skill that is switched on. */
  skills(): Skill[] {
    return [...this.skillRows.values()].filter((view) => !view.off).map(({ id, name, description, body }) => ({ id, name, description, body }));
  }

  /** What Settings are read against for this run: every tool and family an agent may be given, and every definition with what it runs with by default. */
  scope(): SettingsScope {
    return {
      tools: namesOf(this.toolRows),
      agents: [...this.agentRows.values()].filter((view) => !CORE_AGENTS.includes(view.id) || view.source !== "builtin").map((view) => ({ id: view.id, label: view.name, note: view.description, defaults: runOf(view) })),
    };
  }

  /** How the definition `id` runs under `settings`; undefined for none, and for one switched off. */
  resolve(id: string, settings: Readonly<Settings>): ResolvedAgent | undefined {
    const definition = this.agent(id);
    if (!definition) return undefined;
    return resolveAgent(definition, settings, definition.follows !== undefined ? this.agent(definition.follows) : undefined);
  }

  /** The tools `names` give, each once, in the order named: a name is one tool, `@family` every tool of the family, `@added` every tool that isn't built in (an extension's, an MCP server's). One switched off, withdrawn or gone gives nothing. */
  names(names: readonly string[]): string[] {
    const out = new Set<string>();
    for (const name of names) {
      if (name.startsWith("@")) {
        // `@added` is read first: it is no family's name, whatever an extension calls a family of its own.
        for (const [tool, row] of this.toolRows) if (!row.off && (name === ADDED_TOOLS ? row.source !== "builtin" : `@${row.definition.family}` === name)) out.add(tool);
      } else if (this.toolRows.get(name)?.off === false) out.add(name);
    }
    return [...out];
  }

  /** The tools `names` give, built for one agent of a run: one with nothing to offer there is left out. */
  build(names: readonly string[], env: ToolEnv): AgentTool[] {
    return this.names(names).flatMap((name) => {
      const row = this.toolRows.get(name);
      const tool = row?.definition.build(env);
      // The definition's tier is the registry's word: a built tool that names none still asks as its definition does.
      return tool && row ? [{ ...tool, tier: tool.tier ?? row.definition.tier }] : [];
    });
  }

  /** Every definition, for the page: an agent with what it runs with as it stands under `settings`, a tool with the description a model is given (the user's text for a built-in's, its placeholders unfilled). */
  view(settings: Readonly<Settings>, texts: Texts): DefinitionsView {
    return {
      agents: [...this.agentRows.values()].map((view) => ({ ...view, ...resolveSettings(view, settings) })),
      skills: [...this.skillRows.values()],
      tools: [...this.toolRows.entries()].map(([name, row]) => ({
        name,
        family: row.definition.family,
        tier: row.definition.tier,
        description: row.remote?.description ?? (textDef(toolId(name)) ? texts.text(toolId(name)) : ""),
        ...(row.remote ? { parameters: row.remote.parameters } : {}),
        runs: row.runs,
        source: row.source,
        off: row.off,
      })),
    };
  }
}

/** What an agent definition runs with under `settings`: the user's where they set any, else its own. */
function resolveSettings(definition: AgentDefinition, settings: Readonly<Settings>): AgentSettings {
  const own = hasOwn(settings.agents, definition.id) ? settings.agents[definition.id] : undefined;
  return own ?? runOf(definition);
}
