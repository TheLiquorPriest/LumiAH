// Skills (DESIGN §13): a procedure in markdown that an agent may follow. An agent that holds
// `skill_load` is told which skills there are for it, each by its name and what it is for, and
// loads the body of one it chooses. Nothing in the code decides when a skill applies; a skill may
// say whom it is for.

/** A skill: its id (what `skill_load` takes), its name, what it is for (what an agent reads when it chooses), and its body. */
export interface Skill {
  id: string;
  name: string;
  description: string;
  body: string;
  /** On a skill an extension supplies: it is the extension's alone, and a copy the user keeps under its id is not used (§13). */
  owned?: true;
  /** The ids of the agent definitions it is offered to. Absent: every agent that holds `skill_load`. */
  agents?: readonly string[];
  /** The agent definitions its procedure has its reader start. Where the backend leaves one of them out (`BackendOptions.withoutAgents`), the skill isn't offered at all. */
  starts?: readonly string[];
}

/** Whether `skill` is offered to the agent definition `agent`. */
export function offeredTo(skill: Pick<Skill, "agents">, agent: string): boolean {
  return skill.agents === undefined || skill.agents.includes(agent);
}

/** The skills registered in code: the core's own, and those of an extension that runs beside it. An id registered again replaces the one before it. */
export class SkillRegistry {
  private readonly byId = new Map<string, Skill>();

  register(...skills: readonly Skill[]): void {
    for (const s of skills) this.byId.set(s.id, s);
  }

  all(): Skill[] {
    return [...this.byId.values()];
  }
}
