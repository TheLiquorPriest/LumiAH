// Definitions from their three sources (DESIGN §13), through the harness with the sample extension
// mounted: LumiAH's own, the extension's and the user's are one registry for a run; a user's
// definition with the id of a built-in or an extension's stands over it; taking the user's away
// (the page's reset) restores the original, which was never changed; and the tools the user added
// (an extension's, a switched-on MCP server's) are the main agent's as it ships, under one name.
// An extension's tool that replaces a built-in in a chat it claims, and what it withdraws there,
// are in `extension.test.ts`.

import { describe, expect, test } from "bun:test";
import type { AgentDefinition } from "../../src/core/agents";
import { mergeDefinitions, type StoredDefinitions } from "../../src/core/definitions";
import { createHarness } from "../../src/core/harness";
import type { ModelRequest, RemoteTool } from "../../src/core/ports";
import { ADDED_TOOLS, defaultSettings, newAgentSettings, type Settings } from "../../src/core/settings";
import type { ToolDefinition } from "../../src/core/tools";
import { renderDefault, TEXT } from "../../src/core/texts";
import { call, MemoryHost, runTurn, type Script } from "./support/host";
import { HARBOUR, LOG_SKILL, READER, sampleExtension, TIDES } from "./support/sample-extension";

/** A chat the sample extension doesn't claim: LumiAH's own main agent answers it. */
const CHAT = "chat-1";

const SCOUT: AgentDefinition = { ...newAgentSettings(), id: "scout", name: "Scout", description: "Reads ahead along the shore and says what it found.", instructions: "You scout the shore.", given: "task", tools: ["chat_read"] };
const KNOTS = { id: "knots", name: "Knots", description: "How to tie off a mooring line.", body: "Two round turns, then two half hitches." };
/** A tool of an MCP server the user switched on for agents, as the host lists it beside the extension's. */
const DEPTH: RemoteTool = { name: "mcp:charts:depth", family: "mcp:charts", tier: "external", description: "The chart server's soundings.", parameters: { type: "object", properties: {} }, source: "user" };

const system = (request: ModelRequest | undefined): string => request?.messages[0]?.content ?? "";
const offered = (request: ModelRequest | undefined): string[] => request?.tools?.map((t) => t.name) ?? [];
/** Which of a run's agents a request is from: the writer takes no tools, and only the agent a run starts with holds write_reply. */
const from = (request: ModelRequest): "writer" | "main" | "sub" => (!request.tools ? "writer" : offered(request).includes("write_reply") ? "main" : "sub");

/** A model whose main agent hands one task to `agent`, which answers at once; then the main agent briefs the writer. With no agent it briefs at once. */
const script = (agent?: string): Script => (request) => {
  if (from(request) === "writer") return "Brann squints at the water.";
  if (from(request) === "sub") return "High water at 18:40.";
  const delegated = request.messages.some((m) => m.parts?.some((part) => part.type === "tool_result"));
  return agent !== undefined && !delegated ? { toolCalls: [call("delegate", { agent, task: "When is high water today?" }, "d1")] } : { toolCalls: [call("write_reply", { brief: "High water at 18:40." }, "w1")] };
};

function rig(answers: Script, change: (s: Settings) => void = () => undefined) {
  const host = new MemoryHost();
  host.script = answers;
  const sample = sampleExtension();
  host.tools = { list: async (chatId) => [...(await sample.tools.list(chatId)), DEPTH], call: sample.tools.call };
  host.say(CHAT, "assistant", "The harbour is quiet tonight.");
  host.say(CHAT, "user", "I ask Brann when the tide turns.");
  const stored: { values: Settings; texts: Record<string, string>; definitions?: StoredDefinitions } = { values: defaultSettings(), texts: {} };
  change(stored.values);
  const harness = createHarness(host, { settings: async () => structuredClone(stored), extension: sample.extension });
  const view = () => harness.definitions.get({ chatId: CHAT });
  return { host, harness, stored, view, turn: () => runTurn(host, harness, CHAT) };
}

describe("the three sources", () => {
  test("LumiAH's own, the extension's and the user's are listed together, each with where it comes from, and one run works with all of them", async () => {
    const r = rig(script());
    r.stored.definitions = { agents: { scout: SCOUT }, skills: { knots: KNOTS } };
    const listed = await r.view();
    const agents = new Map(listed.agents.map((a) => [a.id, a.source]));
    expect(["main", "writer", "summarizer", HARBOUR.keeper, HARBOUR.reader, "scout"].map((id) => agents.get(id))).toEqual(["builtin", "builtin", "builtin", "extension", "extension", "user"]);
    const skills = new Map(listed.skills.map((s) => [s.id, s.source]));
    expect([skills.get(HARBOUR.skill), skills.get("knots")]).toEqual(["extension", "user"]);
    const tools = new Map(listed.tools.map((t) => [t.name, [t.source, t.runs, t.tier]]));
    expect(tools.get("chat_read")).toEqual(["builtin", "runtime", "read"]);
    expect(tools.get(HARBOUR.tides)).toEqual(["extension", "extension", "external"]);
    expect(tools.get(DEPTH.name)).toEqual(["user", "extension", "external"]);
    // None of them stands over another, so none says it does.
    expect([...listed.agents, ...listed.skills].filter((d) => d.over !== undefined)).toEqual([]);

    await r.turn();
    const main = r.host.calls[0];
    // The main agent holds a tool from each source with nothing set (the MCP tool under a name a provider takes), may hand a task to an agent from each, and is told a skill from each.
    expect(offered(main)).toEqual(expect.arrayContaining(["chat_read", HARBOUR.tides, "mcp_charts_depth"]));
    const delegate = JSON.stringify(main?.tools?.find((t) => t.name === "delegate"));
    for (const id of ["summarizer", HARBOUR.reader, "scout"]) expect(delegate).toContain(id);
    expect(system(main)).toContain(`- ${HARBOUR.skill}: ${LOG_SKILL.name}. ${LOG_SKILL.description}`);
    expect(system(main)).toContain(`- knots: ${KNOTS.name}. ${KNOTS.description}`);
  });

  test("a definition the user switched off is still listed, as off, and no run has it", async () => {
    const r = rig(script());
    r.stored.definitions = { agents: { scout: SCOUT }, off: { agents: ["scout", HARBOUR.reader], skills: [HARBOUR.skill], tools: ["chat_grep"] } };
    const listed = await r.view();
    expect(listed.agents.filter((a) => a.off).map((a) => a.id)).toEqual([HARBOUR.reader, "scout"]);
    expect(listed.skills.filter((s) => s.off).map((s) => s.id)).toEqual([HARBOUR.skill]);
    expect(listed.tools.filter((t) => t.off).map((t) => t.name)).toEqual(["chat_grep"]);
    await r.turn();
    const main = r.host.calls[0];
    expect(offered(main)).not.toContain("chat_grep");
    const delegate = JSON.stringify(main?.tools?.find((t) => t.name === "delegate"));
    expect(delegate).toContain("summarizer");
    expect(delegate).not.toContain("scout");
    expect(delegate).not.toContain(HARBOUR.reader);
    expect(system(main)).not.toContain(HARBOUR.skill);
  });
});

describe("a user's definition with the id of another", () => {
  const OWN = "Answer in one line, and name nobody.";
  const SLOW = "Read the tide table aloud, slowly.";
  /** The instructions of the sub-agent a turn's main agent handed its task to. */
  const subSystem = (host: MemoryHost): string => system(host.calls.find((request) => from(request) === "sub"));

  test("stands over a built-in and over an extension's, says which, and is what a run works with", async () => {
    const r = rig(script("summarizer"));
    r.stored.definitions = {
      agents: { summarizer: { ...newAgentSettings(), id: "summarizer", name: "Summarizer", description: "Answers in a line.", instructions: OWN, given: "task" }, [HARBOUR.reader]: { ...READER, instructions: SLOW } },
      skills: { [HARBOUR.skill]: { ...LOG_SKILL, body: "Write the hour first." } },
    };
    const listed = await r.view();
    expect(listed.agents.find((a) => a.id === "summarizer")).toMatchObject({ source: "user", over: "builtin", instructions: OWN, description: "Answers in a line." });
    expect(listed.agents.find((a) => a.id === HARBOUR.reader)).toMatchObject({ source: "user", over: "extension", instructions: SLOW });
    expect(listed.skills.find((s) => s.id === HARBOUR.skill)).toMatchObject({ source: "user", over: "extension", body: "Write the hour first." });
    // Each id is listed once: the user's took the original's place.
    expect(listed.agents.filter((a) => a.id === "summarizer" || a.id === HARBOUR.reader)).toHaveLength(2);
    await r.turn();
    expect(subSystem(r.host)).toContain(OWN);
    expect(subSystem(r.host)).not.toContain(renderDefault(TEXT.agents.summarizer));
  });

  test("a reset takes the user's away and the original stands again, as it was", async () => {
    const r = rig(script("summarizer"));
    const before = await r.view();
    r.stored.definitions = { agents: { summarizer: { ...newAgentSettings(), id: "summarizer", name: "Summarizer", description: "Answers in a line.", instructions: OWN, given: "task" }, [HARBOUR.reader]: { ...READER, instructions: SLOW }, scout: SCOUT }, skills: { [HARBOUR.skill]: { ...LOG_SKILL, body: "Write the hour first." } } };
    expect((await r.view()).agents.find((a) => a.id === "summarizer")?.over).toBe("builtin");
    // What the page's reset does: the user's definition under that id is removed from what is stored. Their own scout, which stands over nothing, stays.
    r.stored.definitions = { agents: { scout: SCOUT } };
    const after = await r.view();
    for (const id of ["summarizer", HARBOUR.reader]) expect(after.agents.find((a) => a.id === id)).toEqual(before.agents.find((a) => a.id === id));
    expect(after.skills.find((s) => s.id === HARBOUR.skill)).toEqual(before.skills.find((s) => s.id === HARBOUR.skill));
    expect(after.agents.find((a) => a.id === "summarizer")).toMatchObject({ source: "builtin", instructions: renderDefault(TEXT.agents.summarizer) });
    expect(after.agents.find((a) => a.id === "summarizer")?.over).toBeUndefined();
    expect(after.agents.find((a) => a.id === "scout")?.source).toBe("user");
    await r.turn();
    expect(subSystem(r.host)).toContain(renderDefault(TEXT.agents.summarizer));
    expect(subSystem(r.host)).not.toContain(OWN);
  });

  test("a stored definition that isn't one, or isn't kept under its own id, is left out with a line in the log, and the original stands", async () => {
    const r = rig(script());
    r.stored.definitions = { agents: { summarizer: { id: "summarizer", name: "Summarizer" } as AgentDefinition, [HARBOUR.reader]: { ...READER, id: "somebody_else" } } };
    const listed = await r.view();
    expect(listed.agents.find((a) => a.id === "summarizer")?.source).toBe("builtin");
    expect(listed.agents.find((a) => a.id === HARBOUR.reader)?.source).toBe("extension");
    expect(listed.agents.find((a) => a.id === "somebody_else")).toBeUndefined();
    const lines = r.host.logs.map((line) => line.message);
    expect(lines.some((line) => line.includes('your agent definition "summarizer" isn\'t used'))).toBe(true);
    expect(lines.some((line) => line.includes(`your agent definition "${HARBOUR.reader}" isn't used: its id isn't the one it is kept under.`))).toBe(true);
  });
});

describe("the extension's tool, as a run's definition", () => {
  test("is listed with the description and arguments its backend gave, and built-ins with the text the user has for them", async () => {
    const r = rig(script());
    r.stored.texts = { "tool.chat_read": "Reads the chat, a page at a time." };
    const listed = await r.view();
    expect(listed.tools.find((t) => t.name === HARBOUR.tides)).toMatchObject({ description: TIDES.description, parameters: TIDES.parameters });
    expect(listed.tools.find((t) => t.name === "chat_read")?.description).toBe("Reads the chat, a page at a time.");
  });
});

describe("the tools the user added", () => {
  /** The names a model was offered that the sample extension or the chart server supplies. */
  const added = (request: ModelRequest | undefined): string[] => offered(request).filter((name) => name === HARBOUR.tides || name === "mcp_charts_depth");

  test("are the main agent's as it ships, and no other agent's: an extension's own tool and a switched-on MCP server's, with nothing else to set", async () => {
    const r = rig(script("summarizer"));
    expect(r.stored.values.agents.main?.tools).toContain(ADDED_TOOLS);
    await r.turn();
    expect(added(r.host.calls.find((request) => from(request) === "main"))).toEqual([HARBOUR.tides, "mcp_charts_depth"]);
    // The summarizer's definition names neither, so it is given neither.
    expect(added(r.host.calls.find((request) => from(request) === "sub"))).toEqual([]);
    // The page's form for an agent's tools takes the name, and the scope Settings are checked against holds it.
    const listed = await r.view();
    expect(listed.scope.tools).toEqual(expect.arrayContaining([ADDED_TOOLS, HARBOUR.tides, DEPTH.name, `@${HARBOUR.family}`, "@mcp:charts"]));
    expect(JSON.stringify(listed.agentSchema)).toContain(`"${ADDED_TOOLS}"`);
  });

  test("unticked for the main agent, they are gone from it; one switched off on the Tools page is no agent's", async () => {
    const unticked = rig(script(), (s) => (s.agents.main!.tools = s.agents.main!.tools.filter((name) => name !== ADDED_TOOLS)));
    await unticked.turn();
    expect(added(unticked.host.calls[0])).toEqual([]);
    const off = rig(script());
    off.stored.definitions = { off: { tools: [DEPTH.name] } };
    await off.turn();
    expect(added(off.host.calls[0])).toEqual([HARBOUR.tides]);
  });

  test("a sub-agent whose definition names one is given it under the grant LumiAH ships with, since the main agent holds it; where the main agent doesn't, it isn't", async () => {
    // The extension's reader names its tide tool by its family.
    const r = rig(script(HARBOUR.reader));
    expect(r.stored.values.delegation.grant).toBe("own");
    await r.turn();
    expect(offered(r.host.calls.find((request) => from(request) === "sub"))).toContain(HARBOUR.tides);
    const unticked = rig(script(HARBOUR.reader), (s) => (s.agents.main!.tools = s.agents.main!.tools.filter((name) => name !== ADDED_TOOLS)));
    await unticked.turn();
    expect(offered(unticked.host.calls.find((request) => from(request) === "sub"))).not.toContain(HARBOUR.tides);
  });

  test("hold no built-in tool, whatever its tier: one that acts outside LumiAH is an agent's only by its own name", () => {
    const tool = (name: string, family: string, tier: ToolDefinition["tier"]): ToolDefinition => ({ name, family, tier, build: () => null });
    const code = [tool("chat_read", "chat", "read"), tool("harbour_wire", "wire", "external"), tool("registered_beside", "wire", "external")];
    const definitions = mergeDefinitions(
      // The first two are the core's own; the third was registered beside them, so it is an extension's.
      { code: { agents: [], skills: [], tools: code }, core: { agents: new Set(), skills: new Set(), tools: new Set(["chat_read", "harbour_wire"]) }, extension: { agents: [], skills: [] }, remote: [TIDES, DEPTH], user: { off: { tools: [TIDES.name] } }, claim: null },
      { log: () => undefined },
    );
    expect(definitions.names([ADDED_TOOLS])).toEqual(["registered_beside", DEPTH.name]);
    expect(definitions.names(["chat_read", ADDED_TOOLS, "harbour_wire"])).toEqual(["chat_read", "registered_beside", DEPTH.name, "harbour_wire"]);
    // A family's name still gives the family, built in or not.
    expect(definitions.names(["@wire"])).toEqual(["harbour_wire", "registered_beside"]);
    expect(definitions.scope().tools).toContain(ADDED_TOOLS);
  });
});
