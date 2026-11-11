// The Agents, Skills and Tools pages' requests (DESIGN §13, §17): what the user makes or switches is
// kept with their settings and reaches the core with them, a definition the core refuses isn't
// kept, what a tool's calls do is the same setting Settings holds, and the jobs' two switches are
// settings too. The definitions are about no chat, so the core built in answers for them (§25); its
// part (merging and checking in a run) is scripted here.

import { afterEach, describe, expect, test } from "bun:test";
import type { AgentDefinition } from "../../../src/core/agents";
import type { Harness as Core } from "../../../src/core/harness";
import { defaultSettings, newAgentSettings } from "../../../src/core/settings";
import type { JsonObject } from "../../../src/core/ports";
import { UiFailure } from "../../support/fake-lumiverse";
import { type Rig, rig, USER } from "../../support/rig";

/** A harness that answers the pages' reads as the core would for a user with one tool (in the core's own type, so the two can't drift apart unseen), and remembers the settings it is handed. The rig gives it to both places; what is asked about no chat reaches the one built in. */
function scripted(seen: { definitions: unknown[] }): NonNullable<Parameters<typeof rig>[0]>["harness"] {
  return (_host, settings) => ({
    answer: async () => ({ status: "failed", reason: "no turn is answered in this test", record: null, reply: "", usage: { calls: 0, toolTurns: 0, in: 0, cachedIn: 0, out: 0, reasoningOut: 0, estimated: false, ms: 0 } }),
    definitions: {
      get: async () => {
        const read = await settings();
        seen.definitions.push(read.definitions);
        return { agents: [], skills: [], tools: [{ name: "chat_search", family: "chat", tier: "read", description: "Searches the chat.", runs: "runtime", source: "builtin", off: false }], agentSchema: { type: "object" }, agentDefaults: newAgentSettings(), scope: { tools: ["chat_search", "@chat", "@added"], agents: [] } };
      },
    } satisfies Core["definitions"],
  });
}

let open: Rig | null = null;
afterEach(() => {
  open?.close();
  open = null;
});

async function start(seen: { definitions: unknown[] } = { definitions: [] }): Promise<Rig> {
  const it = await rig({ harness: scripted(seen) });
  open = it;
  await it.setUp();
  return it;
}

const scout = (more: Partial<AgentDefinition> = {}): AgentDefinition => ({ ...(defaultSettings().agents.summarizer as AgentDefinition), id: "scout", name: "Scout", description: "Looks things up in the chat.", instructions: "Find what you are asked for in the chat and say where it is.", given: "task", tools: ["chat_search"], ...more });

describe("the user's own definitions", () => {
  test("are kept with their settings, reach the core with them, and move the pages' counter", async () => {
    const seen = { definitions: [] as unknown[] };
    const it = await start(seen);
    const before = (await it.page.request("lah.hello", {})).defs;
    const view = await it.page.request("lah.agent.save", { agent: scout() });
    expect<unknown>(view.agentDefaults).toEqual(newAgentSettings());
    expect(view.tools).toMatchObject([{ name: "chat_search", tier: "read", approval: null, asks: false }]);
    // The core's next read of the settings holds the definition, as stored.
    expect(seen.definitions.at(-1)).toMatchObject({ agents: { scout: { id: "scout", name: "Scout", tools: ["chat_search"] } } });
    expect((await it.backend.settings.snapshot(USER)).definitions).toMatchObject({ agents: { scout: { id: "scout" } }, skills: {}, off: { agents: [], skills: [], tools: [] }, mcp: [] });
    expect((await it.page.request("lah.hello", {})).defs).toBeGreaterThan(before);

    await it.page.request("lah.def.switch", { kind: "tool", id: "chat_search", off: true });
    await it.page.request("lah.skill.save", { skill: { id: "tide_reading", name: "Reading a tide table", description: "How to read the harbour's tide tables.", body: "Find the day, then the harbour." } });
    expect((await it.backend.settings.snapshot(USER)).definitions).toMatchObject({ skills: { tide_reading: { name: "Reading a tide table" } }, off: { tools: ["chat_search"] } });

    await it.page.request("lah.def.remove", { kind: "agent", id: "scout" });
    expect((await it.backend.settings.snapshot(USER)).definitions).toMatchObject({ agents: {} });
    const gone = await it.page.request("lah.def.remove", { kind: "agent", id: "scout" }).catch((error: unknown) => error);
    expect((gone as UiFailure).error.code).toBe("not_found");
  });

  test("are refused, and nothing kept, when the core finds something wrong with one", async () => {
    const it = await start();
    const refused = await it.page.request("lah.agent.save", { agent: scout({ tools: ["chat_search", "no_such_tool"] }) }).catch((error: unknown) => error);
    expect(refused).toBeInstanceOf(UiFailure);
    expect((refused as UiFailure).error.code).toBe("invalid");
    expect((refused as UiFailure).error.problems?.length).toBeGreaterThan(0);
    const named = await it.page.request("lah.agent.save", { agent: scout({ id: "Scout The First" }) }).catch((error: unknown) => error);
    expect((named as UiFailure).error.code).toBe("invalid");
    expect((await it.backend.settings.snapshot(USER)).definitions).toEqual({});
  });

  test("may name a tool, a whole family of them, or every tool that isn't built in, as the main agent's own definition does", async () => {
    const it = await start();
    await it.page.request("lah.agent.save", { agent: scout({ tools: ["chat_search", "@chat", "@added"] }) });
    expect((await it.backend.settings.snapshot(USER)).definitions).toMatchObject({ agents: { scout: { tools: ["chat_search", "@chat", "@added"] } } });
  });
});

describe("what a tool's calls do", () => {
  test("is the setting Settings holds: a tier's choice, a tool's own over it, and back to the tier's", async () => {
    const it = await start();
    let view = await it.page.request("lah.tier.approval", { tier: "read", approval: "ask" });
    expect(view.tiers.read).toBe("ask");
    expect(view.tools).toMatchObject([{ name: "chat_search", approval: null, asks: true }]);
    view = await it.page.request("lah.tool.approval", { name: "chat_search", approval: "allow" });
    expect(view.tools).toMatchObject([{ name: "chat_search", approval: "allow", asks: false }]);
    expect(((await it.page.request("lah.hello", {})).settings.values.core as JsonObject).approval).toMatchObject({ tiers: { read: "ask" }, tools: { chat_search: "allow" } });
    view = await it.page.request("lah.tool.approval", { name: "chat_search", approval: null });
    expect(view.tools).toMatchObject([{ name: "chat_search", approval: null, asks: true }]);
  });
});

describe("the switches over all jobs", () => {
  test("are settings: off stops jobs from starting, paused holds those running, and every page's state says so", async () => {
    const it = await start();
    expect((await it.page.request("lah.hello", {})).jobs).toMatchObject({ active: [], off: false, paused: false });
    expect(await it.page.request("lah.jobs.set", { paused: true })).toEqual({ off: false, paused: true });
    expect(await it.page.request("lah.jobs.set", { off: true })).toEqual({ off: true, paused: true });
    const state = await it.page.request("lah.hello", {});
    expect(state.jobs).toMatchObject({ off: true, paused: true });
    expect((state.settings.values.core as JsonObject).jobs).toMatchObject({ enabled: false });
    expect((state.settings.values.transport as JsonObject).jobs).toEqual({ paused: true });
  });
});
