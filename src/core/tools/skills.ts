// skill_load (DESIGN §13): gives an agent the body of a skill it chose from the list its
// instructions hold, a page at a time; with no skill named, the list itself, for an agent whose
// instructions had room for only part of it. The tool decides nothing: which skill applies is the
// agent's own reading of each one's description.

import type { JsonObject } from "../ports";
import { FAMILY, TEXT, TOOL } from "../texts";
import type { ToolDefinition, ToolEnv, ToolOutcome } from "../tools";
import { textArg } from "../util";
import { fitted, listPage, pagerOf, readCursor, saidBack, textPage } from "./paging";

const skillLoad: ToolDefinition = {
  name: TOOL.skillLoad,
  family: FAMILY.skills,
  tier: "read",
  build(env: ToolEnv) {
    const { texts, skills } = env;
    // With no skill to load the tool would only ever say so: an agent isn't offered it.
    if (!skills || skills.length === 0) return null;
    const p = pagerOf(env, TOOL.skillLoad);
    return {
      name: TOOL.skillLoad,
      description: texts.render(TEXT.tool(TOOL.skillLoad)),
      parameters: {
        type: "object",
        properties: {
          skill: { type: "string", description: texts.render(TEXT.toolArg(TOOL.skillLoad, "skill")) },
          cursor: { type: "string", description: texts.render(TEXT.toolArg(TOOL.skillLoad, "cursor")) },
        },
      },
      async run(args: JsonObject): Promise<ToolOutcome> {
        const cursor = readCursor(p, args);
        if ("text" in cursor) return cursor;
        const id = textArg(args.skill);
        if (id === null) {
          return listPage(p, {
            total: skills.length,
            noun: TEXT.agents.wordSkill,
            cursor,
            item: (i) => {
              const skill = skills[i];
              return skill ? texts.render(TEXT.agents.skill, { id: skill.id, name: skill.name, description: skill.description }) : "";
            },
          });
        }
        const skill = skills.find((s) => s.id === id);
        // The id asked for is said back clipped: a model that sends a page of text for an id doesn't get the page back.
        if (!skill) return { text: saidBack(p, id, (said) => fitted(p, skills.map((s) => s.id).join(", "), (list) => texts.render(TEXT.agents.skillNone, { id: said, skills: list }))), error: true };
        return textPage(p, {
          text: skill.body,
          from: cursor.at,
          given: cursor.given,
          frame: (part) => texts.render(TEXT.agents.skillBody, { id: skill.id, name: skill.name, from: String(part.from), to: String(part.to), total: String(skill.body.length), text: part.text }),
        });
      },
    };
  },
};

export const SKILL_TOOLS: readonly ToolDefinition[] = [skillLoad];
