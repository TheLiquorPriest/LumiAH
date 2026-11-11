// Skills (DESIGN §13): a procedure in markdown that an agent may follow. An agent that holds
// `skill_load` is told which skills there are, each by its name and what it is for, and loads the
// body of one it chooses. Nothing in the code decides when a skill applies.

/** A skill: its id (what `skill_load` takes), its name, what it is for (what an agent reads when it chooses), and its body. */
export interface Skill {
  id: string;
  name: string;
  description: string;
  body: string;
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
