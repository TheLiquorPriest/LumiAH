// The package example (`examples/dice-tools`), mounted as a user would install it: LumiAH's backend
// given what the example supplies, on the fake Lumiverse, with LumiAH's own runtime linked to it by
// the example's identifier. A turn is played in which a scripted model rolls its dice, so the
// example keeps working as the package changes under it. The example is imported by its path at
// run time, not statically: it names the package as its users do (`lumi-ah/core`), which resolves
// only from inside its own project (its `tsconfig.json`), not from this test's.

import { afterEach, describe, expect, test } from "bun:test";
import { resolve } from "node:path";
import type { BackendOptions } from "../../src/extension/backend/backend";
import { bare, cast, heard, offers } from "../support/cast";
import { toolCall } from "../support/fake-host";
import { callsOf, live, startedAs, stepsOf } from "../support/live";
import { type Rig, rig, until, USER } from "../support/rig";

const ROOT = resolve(import.meta.dir, "../..");

/** What the example's `src/dice.ts` exports, as this test uses it. */
interface DiceExample {
  IDENTIFIER: string;
  roll(dice: string, random: () => number): string | null;
  diceTools(deps: { random: () => number; log: (line: string) => void }): BackendOptions;
}
const example: DiceExample = await import(resolve(ROOT, "examples/dice-tools/src/dice.ts"));

let r: Rig | null = null;
afterEach(async () => {
  await r?.close();
  r = null;
});

/** Dice that fall as told: each number is what `Math.random` would have given, in order. */
const falling = (...numbers: number[]): (() => number) => {
  let at = 0;
  return () => numbers[at++ % numbers.length] ?? 0;
};

/** The example mounted with dice that fall as told; `logged` is what it wrote to the log, and `callers` what each call of its tool said of who made it, as the call reached its backend. */
async function mounted(...numbers: number[]) {
  const logged: string[] = [];
  const callers: { callId: string; role: string; kind: string; main: boolean; above: string[] }[] = [];
  const options = example.diceTools({ random: falling(...numbers), log: (line) => void logged.push(line) });
  const own = options.tools;
  if (own === undefined) throw new Error("the example supplies no tools");
  const it = (r = await rig({
    backend: {
      ...options,
      tools: {
        list: own.list,
        call: (call, signal, userId) => {
          callers.push({ callId: call.callId, role: call.role, kind: call.kind, main: call.main, above: call.above.map((over) => over.role) });
          return own.call(call, signal, userId);
        },
      },
    },
  }));
  const chatId = await it.setUp();
  return { it, chatId, logged, callers };
}

describe("the dice", () => {
  test("roll what the expression says, each die from the extension's own numbers, and refuse what isn't one", () => {
    // 0.5 of six sides is a 4, 0.99 a 6, 0 a 1.
    expect(example.roll("2d6+3", falling(0.5, 0.99))).toBe("2d6+3: rolled 4, 6 (+3); total 13.");
    expect(example.roll(" d20 ", falling(0))).toBe("d20: rolled 1; total 1.");
    expect(example.roll("3D4 - 2", falling(0.99))).toBe("3D4 - 2: rolled 4, 4, 4 (-2); total 10.");
    for (const not of ["", "two dice", "0d6", "2d1", "2d6+", "2d6; drop tables"]) expect(example.roll(not, falling(0.5))).toBeNull();
  });
});

describe("Dice Tools, installed", () => {
  test("lists its tool, its agent and its skill on the pages as the extension's own, and asks Lumiverse for what LumiAH asks for", async () => {
    const { it } = await mounted(0.5);
    expect(it.host.identifier).toBe(example.IDENTIFIER);
    const defs = await it.page.request("lah.defs.get", {});
    expect(defs.tools.find((t) => t.name === "roll_dice")).toMatchObject({ family: "dice", tier: "read", runs: "extension", source: "extension", off: false });
    expect(defs.agents.find((a) => a.id === "dice_clerk")).toMatchObject({ name: "Dice clerk", source: "extension", off: false, tools: ["roll_dice", "skill_load"] });
    expect(defs.skills.find((s) => s.id === "contested_roll")).toMatchObject({ name: "A contested roll", source: "extension", off: false });
    // Its manifest names the identifier its code does, and every permission LumiAH's backend needs: LumiAH's own manifest is the list.
    const [own, lumiah]: Record<string, unknown>[] = await Promise.all([Bun.file(resolve(ROOT, "examples/dice-tools/spindle.json")).json(), Bun.file(resolve(ROOT, "spindle.json")).json()]);
    expect(own?.identifier).toBe(example.IDENTIFIER);
    expect(own?.permissions).toEqual(lumiah?.permissions);
    expect(own?.interceptorTimeoutMs).toEqual(lumiah?.interceptorTimeoutMs);
  });

  test("a turn with nothing set: LumiAH's own main agent holds roll_dice and rolls, and the Dice clerk it hands a roll to rolls too, each call run in the extension's backend with its dice", async () => {
    const { it, chatId, logged, callers } = await mounted(0, 0.5, 0.99);
    const play = cast(
      {
        name: "main",
        is: offers("write_reply"),
        lines: [
          { toolCalls: [toolCall("roll_dice", { dice: "a handful" }, "roll_1"), toolCall("roll_dice", { dice: "d20" }, "roll_2")] },
          { toolCalls: [toolCall("delegate", { agent: "dice_clerk", task: "Brann puts his shoulder to the lamp room door. Roll 2d6+3 against 10." }, "hand_1")] },
          { toolCalls: [toolCall("write_reply", { brief: "Okoro fumbles the key (a 1); Brann forces the door, 13 against 10." }, "reply_1")] },
        ],
      },
      // The clerk's calls: it holds roll_dice and no write_reply.
      { name: "clerk", is: offers("roll_dice"), lines: [{ toolCalls: [toolCall("roll_dice", { dice: "2d6+3" }, "roll_3")] }, "2d6+3: rolled 4, 6 (+3); total 13. Brann forces the lamp room door."] },
      { name: "writer", is: bare, lines: ["The key rings on the step, and the door gives on the second heave."] },
    );
    it.host.script = play.script;
    const out = await it.generate(chatId);
    expect(out.error).toBeNull();
    expect(out.content).toBe("The key rings on the step, and the door gives on the second heave.");

    // The main agent was LumiAH's own (the example claims no chat): it was offered the extension's tool, told its skill, and could hand a task to its agent.
    const [first, , third] = play.calls("main");
    expect(first?.tools?.map((t) => t.name)).toContain("roll_dice");
    expect(heard(first)).toContain("- contested_roll: A contested roll. How to settle two characters acting against each other with dice.");
    expect(JSON.stringify(first?.tools?.find((t) => t.name === "delegate"))).toContain("dice_clerk");
    await until(() => it.backend.live.runningOf(USER).length === 0, "the turn's end in the live view");
    const { events } = await live(it, chatId);
    const [main] = startedAs(events, "main");
    // A call that isn't a roll is answered with how to make one; a roll, with each die and the total.
    expect(callsOf(stepsOf(events, main?.id)).slice(0, 2)).toEqual([
      { name: "roll_dice", text: 'That isn\'t a roll. Give dice as NdS with an optional +M or -M: "2d6+3", "d20".', error: true },
      { name: "roll_dice", text: "d20: rolled 1; total 1.", error: false },
    ]);
    // The clerk ran under its own instructions, rolled, and its answer went back to the main agent.
    const [clerk] = startedAs(events, "dice_clerk");
    expect(clerk?.system).toContain("You are the dice clerk of a roleplay chat.");
    expect(callsOf(stepsOf(events, clerk?.id))).toEqual([{ name: "roll_dice", text: "2d6+3: rolled 4, 6 (+3); total 13.", error: false }]);
    expect(heard(play.calls("clerk")[1])).toContain("2d6+3: rolled 4, 6 (+3); total 13.");
    expect(heard(third)).toContain("Brann forces the lamp room door.");
    // Each call told the backend who made it, across the link: the run's main agent, and the clerk with the main agent over it.
    expect(callers).toEqual([
      { callId: "roll_1", role: "main", kind: "new", main: true, above: [] },
      { callId: "roll_2", role: "main", kind: "new", main: true, above: [] },
      { callId: "roll_3", role: "dice_clerk", kind: "new", main: false, above: ["main"] },
    ]);
    // Its hook heard the turn end, and counted the rolls that were made.
    await until(() => logged.length === 1, "the example's line in the log");
    expect(logged).toEqual([`[Dice Tools] 2 rolls in a new run of chat ${chatId} that ended done`]);
  });
});
