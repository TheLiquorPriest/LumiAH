// What Dice Tools adds to LumiAH: one tool that runs in this extension's backend, one agent
// definition, one skill, and a hook on a turn's end. It claims no chat, so LumiAH's own main agent
// answers every chat as it does without Dice Tools, and hands a roll to the Dice clerk.

import { type AgentDefinition, newAgentSettings, type RemoteTool, type Skill } from "lumi-ah/core";
import type { BackendOptions } from "lumi-ah/extension/backend";

/** This extension's identifier in Lumiverse: the one in `spindle.json`. */
export const IDENTIFIER = "dice_tools";

/** A dice expression: how many dice, their sides, and what is added. `2d6+3`, `d20`, `4d8-1`. */
const EXPRESSION = /^\s*(\d{0,2})d(\d{1,4})\s*([+-]\s*\d{1,4})?\s*$/i;

/** Rolls `dice` with `random` (a number from 0 up to 1, as `Math.random` gives): each die and the total, in a line; null for what isn't a dice expression. */
export function roll(dice: string, random: () => number): string | null {
  const parts = EXPRESSION.exec(dice);
  if (!parts) return null;
  const count = Number(parts[1] || 1);
  const sides = Number(parts[2]);
  const added = Number((parts[3] ?? "0").replace(/\s/g, ""));
  if (count < 1 || sides < 2) return null;
  const rolls = Array.from({ length: count }, () => 1 + Math.floor(random() * sides));
  const total = rolls.reduce((sum, die) => sum + die, added);
  return `${dice.trim()}: rolled ${rolls.join(", ")}${added === 0 ? "" : ` (${added > 0 ? "+" : ""}${added})`}; total ${total}.`;
}

/** The tool as a model is offered it. Its tier is `read`: a roll changes nothing, so it runs without asking the user. */
export const ROLL_DICE: RemoteTool = {
  name: "roll_dice",
  family: "dice",
  tier: "read",
  description: "Rolls dice and gives each die and the total. The dice are real: never make up a roll, call this.",
  parameters: { type: "object", properties: { dice: { type: "string", description: "What to roll: NdS with an optional +M or -M, such as 2d6+3 or d20." } }, required: ["dice"] },
  source: "extension",
};

/** An agent the main agent may hand a task to (`delegate`), or the user a job or a side session. It runs with what a new agent runs with, and these tools. */
export const DICE_CLERK: AgentDefinition = {
  ...newAgentSettings(),
  id: "dice_clerk",
  name: "Dice clerk",
  description: "Settles something by dice: hand it what is at stake and the roll to make, and it rolls and says what came of it.",
  instructions: "You are the dice clerk of a roleplay chat. Another agent hands you something to settle by dice. Roll with roll_dice, once for each roll the task needs, and never state a number you didn't roll. Answer with each roll as the tool gave it and, in one line, what the result means for the task.",
  given: "task",
  tools: [ROLL_DICE.name, "skill_load"],
};

/** A procedure an agent may load with `skill_load` when its work is what the description says. */
export const CONTESTED_ROLL: Skill = {
  id: "contested_roll",
  name: "A contested roll",
  description: "How to settle two characters acting against each other with dice.",
  body: ["1. Say in a line what each side is trying to do.", "2. Roll d20 for each side with roll_dice, adding what the story gives that side (+2 for a clear advantage, -2 for a clear hindrance).", "3. The higher total has its way. On a tie, roll again.", "4. A margin of ten or more is decisive: say so, and what it costs the loser."].join("\n"),
};

const NOT_A_ROLL = 'That isn\'t a roll. Give dice as NdS with an optional +M or -M: "2d6+3", "d20".';

/** What Dice Tools gives LumiAH's backend. `random` is where the dice come from; `log` writes a line to Lumiverse's log. */
export function diceTools(deps: { random: () => number; log: (line: string) => void }): BackendOptions {
  /** How many rolls each run under way has made, by the run's id. */
  const rolled = new Map<string, number>();
  return {
    identity: { identifier: IDENTIFIER, name: "Dice Tools" },
    extension: {
      name: "Dice Tools",
      definitions: async () => ({ agents: [DICE_CLERK], skills: [CONTESTED_ROLL] }),
      // A hook: every run that ends (a turn, a job, a side session's turn) is told here, with how it ended.
      runEnded: async (run) => {
        const rolls = rolled.get(run.turn);
        rolled.delete(run.turn);
        if (rolls !== undefined) deps.log(`[Dice Tools] ${rolls} ${rolls === 1 ? "roll" : "rolls"} in a ${run.kind} run of chat ${run.chatId} that ended ${run.status}`);
      },
    },
    tools: {
      list: async () => [ROLL_DICE],
      // A call says which run and which agent made it. The answer is text for the model; an error says how to call it right.
      call: async (call) => {
        const line = typeof call.args.dice === "string" ? roll(call.args.dice, deps.random) : null;
        if (line === null) return { text: NOT_A_ROLL, error: true };
        rolled.set(call.turn, (rolled.get(call.turn) ?? 0) + 1);
        return { text: line };
      },
    },
  };
}
