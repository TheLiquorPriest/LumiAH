// Agent definitions (DESIGN §3.3, §13) and the registry those written in code are kept in (§1: an
// extension that runs beside the core registers its own).
//
// A definition says what something that calls a model is: its name and what it is for, its
// instructions, what it is given when another agent starts it, and what it runs with unless the
// user's settings say otherwise: its tools, connection, model, effort and budget. The core ships
// three. The main agent works with tools every turn. The writer and the summarizer are definitions
// too, so the user sets them up the same way; the writer is given no tools by default, so it makes
// one call and is no agent until the user gives it tools.
//
// The definitions a run works with are these merged with an extension's and the user's
// (`definitions.ts`); this file is the shape, the core's own, and how one runs under Settings.

import type { ModelEffort } from "./ports";
import { AGENT, type AgentBudget, type AgentSettings, agentSettings, defaultSettings, type Settings, type ToolCalls } from "./settings";
import { renderDefault, TEXT } from "./texts";

export interface AgentDefinition extends AgentSettings {
  /** Its id: what `delegate` names it by, what its settings are kept under, and its role in the trace. */
  id: string;
  name: string;
  /** What it is for: what an agent reads when it chooses whom to delegate to, and what the page says under its name. */
  description: string;
  /** Its instructions: its system prompt. */
  instructions: string;
  /**
   * One of the core's texts that its instructions are, by id: the text as the user has it is what is
   * sent, and `instructions` holds the shipped wording. Only the core's own definitions name one.
   */
  text?: string;
  /** What it is given when another agent starts it: the request the turn answers along with its task, or its task alone. */
  given: "request" | "task";
  /** Another definition whose connection and model it takes while it names no connection of its own. */
  follows?: string;
  /**
   * What it is given of its tools when another agent starts it (§14): `own`, no tool that agent
   * doesn't hold itself; `definition`, every tool this definition names, whoever starts it (for an
   * agent whose tools are its own trade, which the agent that hands it tasks has no use for).
   * Absent: Settings' "What a sub-agent may be given" decides.
   */
  grant?: "own" | "definition";
  /**
   * The fields an extension keeps as its own (§13), on a definition it supplies: where the user
   * keeps a version of the agent, each field named here comes from the extension's definition as it
   * is now (`instructions` with the text it names), and the user's version keeps the rest. A save
   * of the user's version stores none of them. Only an extension's definition says it.
   */
  owns?: readonly OwnedField[];
}

/** A field of an agent definition an extension may keep as its own (`AgentDefinition.owns`). */
export type OwnedField = "instructions" | "tools" | "name" | "description";

export const OWNED_FIELDS: readonly OwnedField[] = ["instructions", "tools", "name", "description"];

/** A definition as one run runs it: the user's settings over what it runs with by default, its connection and model resolved. */
export interface ResolvedAgent {
  definition: AgentDefinition;
  connectionId: string | null;
  model: string | null;
  effort: ModelEffort;
  tools: readonly string[];
  toolCalls: ToolCalls;
  budget: AgentBudget;
}

/**
 * The definitions the core ships: the main agent; the writer; and the summarizer, which summarizes
 * what another agent delegates to it, makes the summary of the main agent's notes (that call has
 * instructions of its own, among the texts), and runs where the main agent does unless it is given a
 * connection of its own.
 */
export function baseAgents(): AgentDefinition[] {
  const defaults = defaultSettings().agents;
  const of = (id: string): AgentSettings => defaults[id] as AgentSettings;
  return [
    { id: AGENT.main, name: "Main agent", description: "Works out what each reply needs, with tools, then briefs the writer or writes the reply itself.", instructions: renderDefault(TEXT.main.system), text: TEXT.main.system, given: "request", ...of(AGENT.main) },
    { id: AGENT.writer, name: "Writer", description: "Writes the reply from the prompt Lumiverse assembled and the main agent's brief.", instructions: "", given: "request", ...of(AGENT.writer) },
    { id: AGENT.summarizer, name: "Summarizer", description: "Summarizes what it is asked to: a span of the chat, lore entries, workspace files, or a text given in its task. It reads them itself and answers with the summary.", instructions: renderDefault(TEXT.agents.summarizer), text: TEXT.agents.summarizer, given: "task", follows: AGENT.main, ...of(AGENT.summarizer) },
  ];
}

/** The agent definitions written in code, by id. An id registered again replaces the one before it. */
export class AgentRegistry {
  private readonly byId = new Map<string, AgentDefinition>();

  register(...definitions: readonly AgentDefinition[]): void {
    for (const d of definitions) this.byId.set(d.id, d);
  }

  get(id: string): AgentDefinition | undefined {
    return this.byId.get(id);
  }

  all(): AgentDefinition[] {
    return [...this.byId.values()];
  }
}

/**
 * How `definition` runs under `settings`. One that follows another and names no connection takes
 * that one's connection, and its model unless it names one (`followed`: the definition it follows,
 * where the run has it).
 */
export function resolveAgent(definition: AgentDefinition, settings: Readonly<Settings>, followed?: AgentDefinition): ResolvedAgent {
  const own = agentSettings(settings, definition.id, definition);
  // A definition can't follow itself, and one step is all there is: whom it follows is read as set, not resolved again.
  const base = followed && followed.id !== definition.id && own.connectionId === null ? agentSettings(settings, followed.id, followed) : null;
  return { definition, connectionId: base ? base.connectionId : own.connectionId, model: base ? (own.model ?? base.model) : own.model, effort: own.effort, tools: own.tools, toolCalls: own.toolCalls, budget: own.budget };
}
