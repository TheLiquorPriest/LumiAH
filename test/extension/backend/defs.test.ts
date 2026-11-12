// The Agents, Skills and Tools pages' requests (DESIGN §13, §17): what the user makes or switches is
// kept with their settings and reaches the core with them, a definition the core refuses isn't
// kept, what a tool's calls do is the same setting Settings holds, and the jobs' two switches are
// settings too. The definitions are about no chat, so the user's runtime answers for them; its
// core's part (merging and checking in a run) is scripted here, but where an extension's own
// definitions are saved over and what each agent can use in a chat is read, which the core itself
// answers.

import { afterEach, describe, expect, test } from "bun:test";
import type { AgentDefinition } from "../../../src/core/agents";
import type { Harness as Core } from "../../../src/core/harness";
import { defaultSettings, newAgentSettings } from "../../../src/core/settings";
import type { Skill } from "../../../src/core/skills";
import type { JsonObject } from "../../../src/core/ports";
import type { BackendExtension } from "../../../src/extension/backend/extension";
import { UiFailure } from "../../support/fake-lumiverse";
import { type Rig, rig, USER } from "../../support/rig";

/** A harness that answers the pages' reads as the core would for a user with one tool (in the core's own type, so the two can't drift apart unseen), and remembers the settings it is handed. The rig's runtime runs it, and is asked what is about no chat. */
function scripted(seen: { definitions: unknown[] }): NonNullable<Parameters<typeof rig>[0]>["harness"] {
  return (_host, settings) => ({
    answer: async () => ({ status: "failed", reason: "no turn is answered in this test", record: null, reply: "", usage: { calls: 0, toolTurns: 0, in: 0, cachedIn: 0, out: 0, reasoningOut: 0, estimated: false, ms: 0 } }),
    definitions: {
      get: async () => {
        const read = await settings();
        seen.definitions.push(read.definitions);
        return { agents: [], skills: [], tools: [{ name: "chat_search", family: "chat", tier: "read", description: "Searches the chat.", runs: "runtime", source: "builtin", off: false }], agentSchema: { type: "object" }, agentDefaults: newAgentSettings(), scope: { tools: ["chat_search", "@chat", "@added"], agents: [] } };
      },
    } satisfies Pick<Core["definitions"], "get">,
  });
}

let open: Rig | null = null;
afterEach(async () => {
  await open?.close();
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

describe("an extension's own definitions", () => {
  const TIDE = "Read today's tide table, then answer with the times alone.";
  /** The extension's agent: it keeps its instructions and tools as its own, and names a tool of LumiAH's it withdraws, one the user switches off, and one nobody registered. */
  const reader: AgentDefinition = { ...newAgentSettings(), id: "tide_reader", name: "Tide reader", description: "Reads the tide table for a day.", instructions: TIDE, given: "task", tools: ["chat_read", "chat_grep", "lore_grep", "no_such_tool"], owns: ["instructions", "tools"] };
  const ledger: Skill = { id: "harbour_ledger", name: "The harbour's ledger", description: "How a berth is entered.", body: "Name the ship, then her berth.", owned: true };
  const extension: BackendExtension = { name: "Harbour", definitions: async () => ({ agents: [reader], skills: [ledger] }), claim: async () => ({ withdraw: ["lore_grep"] }) };

  /** A runtime linked, running the core itself, and a chat switched on: what the pages ask of the definitions is answered there. */
  async function harbour(): Promise<{ it: Rig; chatId: string }> {
    const it = await rig({ backend: { extension } });
    open = it;
    return { it, chatId: await it.setUp() };
  }

  test("a save of the user's version keeps their model and limits and stores none of the fields the extension keeps, which stay the extension's", async () => {
    const { it } = await harbour();
    const budget = { ...reader.budget, revisions: 1 };
    // Sent as a page of an older build would: with instructions of its own, other tools, and `owns`.
    await it.page.request("lah.agent.save", { agent: { ...reader, instructions: "Read it aloud.", tools: ["chat_read"], model: "tide-model-9", budget } });
    const stored = ((await it.backend.settings.snapshot(USER)).definitions as JsonObject).agents as JsonObject;
    expect(stored[reader.id]).toEqual({ id: reader.id, name: reader.name, description: reader.description, given: "task", connectionId: null, model: "tide-model-9", effort: reader.effort, toolCalls: reader.toolCalls, budget });
    const shown = (await it.page.request("lah.defs.get", {})).agents.find((a) => a.id === reader.id);
    expect(shown).toMatchObject({ source: "user", over: "extension", owns: ["instructions", "tools"], instructions: TIDE, tools: reader.tools, model: "tide-model-9", budget });
  });

  test("a skill the extension keeps as its own can't be saved over", async () => {
    const { it } = await harbour();
    const refused = await it.page.request("lah.skill.save", { skill: { id: ledger.id, name: ledger.name, description: ledger.description, body: "Write the hour first." } }).catch((error: unknown) => error);
    expect((refused as UiFailure).error).toMatchObject({ code: "forbidden", message: "This skill belongs to the extension. You change it on that extension's own pages." });
    expect((await it.backend.settings.snapshot(USER)).definitions).toEqual({});
  });

  test("Settings keep no tools for it: a tools value sent there isn't stored, and its model is", async () => {
    const { it } = await harbour();
    await it.page.request("lah.settings.set", { set: [{ path: ["core", "agents", reader.id, "tools"], value: ["chat_read"] }, { path: ["core", "agents", reader.id, "model"], value: "tide-model-9" }], reset: [] });
    expect((((await it.backend.settings.snapshot(USER)).values.core as JsonObject).agents as JsonObject)[reader.id]).toEqual({ model: "tide-model-9" });
  });

  test("held says, for each agent of a chat, the tools it holds and why it can't use each other tool it names", async () => {
    const { it, chatId } = await harbour();
    await it.page.request("lah.def.switch", { kind: "tool", id: "chat_grep", off: true });
    const held = (await it.backend.agents.held(USER, chatId)).find((agent) => agent.id === reader.id);
    expect(held).toEqual({
      id: reader.id,
      name: reader.name,
      holds: ["chat_read"],
      cannot: [
        { tool: "chat_grep", why: "off" },
        { tool: "lore_grep", why: "withdrawn" },
        { tool: "no_such_tool", why: "unknown" },
      ],
    });
  });
});
