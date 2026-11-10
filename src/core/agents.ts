// Agent definitions (DESIGN §3.3) and the registry they are kept in (§1: an extension that uses LumiAH
// as a package registers its own beside these).
//
// A definition says what something that calls a model is: its instructions (a text the user can
// replace), and what it runs with unless the user's settings say otherwise: its tools, connection,
// model, effort and budget. The core ships three. The main agent works with tools every turn. The
// writer and the summarizer are definitions too, so the user sets them up the same way; they are
// given no tools by default, so each makes one call and is no agent until the user gives it tools.

import type { ModelEffort } from "./ports";
import { AGENT, type AgentBudget, type AgentSettings, agentSettings, defaultSettings, type Settings, type SettingsScope } from "./settings";
import { TEXT } from "./texts";

export interface AgentDefinition {
  /** Its id: what its settings are kept under, and its role in the trace. */
  id: string;
  /** The text its instructions are: its system prompt; for the writer, the frame its brief is put to it in. */
  instructions: string;
  /** Its name and what it is for, as the Settings page shows them; absent: its id. The core's own are named in the settings' schema. */
  label?: string;
  note?: string;
  /** Another definition whose connection and model it takes while it names no connection of its own. */
  follows?: string;
  /** What it runs with while the user's settings hold nothing for it. */
  defaults: AgentSettings;
}

/** A definition as one turn runs it: the user's settings over its defaults, its connection and model resolved. */
export interface ResolvedAgent {
  definition: AgentDefinition;
  connectionId: string | null;
  model: string | null;
  effort: ModelEffort;
  tools: readonly string[];
  budget: AgentBudget;
}

/** The definitions the core ships: the main agent, the writer, and the summarizer of the main agent's notes, which runs where the main agent does unless it is given a connection of its own. */
export function baseAgents(): AgentDefinition[] {
  const defaults = defaultSettings().agents;
  const of = (id: string): AgentSettings => defaults[id] as AgentSettings;
  return [
    { id: AGENT.main, instructions: TEXT.main.system, defaults: of(AGENT.main) },
    { id: AGENT.writer, instructions: TEXT.writer.brief, defaults: of(AGENT.writer) },
    { id: AGENT.summarizer, instructions: TEXT.session.summarizer, follows: AGENT.main, defaults: of(AGENT.summarizer) },
  ];
}

/** The agent definitions, by id. An id registered again replaces the one before it. */
export class AgentRegistry {
  private readonly byId = new Map<string, AgentDefinition>();

  register(...definitions: readonly AgentDefinition[]): void {
    for (const d of definitions) this.byId.set(d.id, d);
  }

  get(id: string): AgentDefinition | undefined {
    return this.byId.get(id);
  }

  ids(): string[] {
    return [...this.byId.keys()];
  }

  /** The definitions beyond the core's own, as the settings' schema lists them (`SettingsScope.agents`). */
  extra(): SettingsScope["agents"] {
    const core: readonly string[] = Object.values(AGENT);
    return [...this.byId.values()].filter((d) => !core.includes(d.id)).map((d) => ({ id: d.id, label: d.label ?? d.id, note: d.note ?? "", defaults: d.defaults }));
  }

  /**
   * How the definition `id` runs under `settings`; undefined when there is none. One that follows
   * another and names no connection takes that one's connection, and its model unless it names one.
   */
  resolve(id: string, settings: Readonly<Settings>): ResolvedAgent | undefined {
    const definition = this.byId.get(id);
    if (!definition) return undefined;
    const own = agentSettings(settings, id, definition.defaults);
    // A definition can't follow itself, and one step is all there is: whom it follows is read as set, not resolved again.
    const followed = definition.follows !== undefined && definition.follows !== id && own.connectionId === null ? this.byId.get(definition.follows) : undefined;
    const base = followed ? agentSettings(settings, followed.id, followed.defaults) : null;
    return { definition, connectionId: base ? base.connectionId : own.connectionId, model: base ? (own.model ?? base.model) : own.model, effort: own.effort, tools: own.tools, budget: own.budget };
  }
}
