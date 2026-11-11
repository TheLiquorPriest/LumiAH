// The stand-in backend's definitions: each request answers, keeps what the page changes, moves the
// state's counter, and refuses what the real backend would. The last test is the sequence the
// preview's contract test runs, on settings that have no approval section.

import { describe, expect, test } from "bun:test";
import { type Handlers, type MockCtx, Refusal } from "../../dev/preview/mock/ctx";
import { defsMock } from "../../dev/preview/mock/defs";
import { baseAgents } from "../../src/core/agents";
import type { AgentDefinition, DefsView, JsonObject, JsonValue, Skill, UiRequest, UiRequests, UiState } from "../../src/shared/ui";

type Requests = "lah.defs.get" | "lah.agent.save" | "lah.skill.save" | "lah.def.remove" | "lah.def.switch" | "lah.tool.approval" | "lah.tier.approval";

const RULE = { type: "string", oneOf: [{ const: "allow" }, { const: "ask" }] };
/** Settings with the core's approval section, as the real ones hold it. */
const CORE_SETTINGS = {
  schema: { type: "object", properties: { core: { type: "object", properties: { approval: { type: "object", properties: { tiers: { type: "object", properties: { read: RULE, write: RULE, external: RULE } }, tools: { type: "object", additionalProperties: RULE } } } } } } },
  values: { core: { approval: { tiers: { read: "allow", write: "allow", external: "ask" }, tools: {} } } },
};

interface Stand {
  /** Sends the part a request as it crosses, and answers what the part does. */
  call<K extends Requests>(type: K, body: UiRequests[K]["body"]): UiRequests[K]["result"] | Promise<UiRequests[K]["result"]>;
  state(): UiState;
  /** Every change `ctx.settings` was asked for. */
  set: { path: string[]; value: JsonValue }[];
}

/** The part on a context made by hand: a state with only what the part reads, and settings that keep what is set. */
function stand(options: { ready?: boolean; settings?: { schema: JsonObject; values: JsonObject } } = {}): Stand {
  const settings = options.settings ? (JSON.parse(JSON.stringify(options.settings)) as { schema: JsonObject; values: JsonObject }) : { schema: {}, values: {} };
  let state = { rev: 0, defs: 0, settings: { ...settings, defaults: {} }, texts: { defs: [], own: {} } } as unknown as UiState;
  const set: Stand["set"] = [];
  const ctx: MockCtx = {
    now: () => Date.UTC(2026, 10, 10, 9, 0, 0),
    later: () => () => {},
    ready: options.ready ?? true,
    state: () => state,
    push: (patch) => {
      state = { ...state, ...patch, rev: state.rev + 1 };
    },
    blobs: { put: () => "", set: () => {}, get: () => undefined },
    play: () => null,
    stop: () => false,
    pause: () => false,
    settings: (changes) => {
      const values = JSON.parse(JSON.stringify(state.settings.values)) as JsonObject;
      for (const change of changes) {
        set.push(change);
        let at = values;
        for (const key of change.path.slice(0, -1)) at = at[key] as JsonObject;
        at[change.path.at(-1) ?? ""] = change.value;
      }
      state = { ...state, settings: { ...state.settings, values } };
    },
    keep: () => "",
  };
  const mock: Handlers<Requests> = defsMock(ctx);
  return { call: (type, body) => mock[type]({ lah: 1, type, reqId: "r1", ...body } as Extract<UiRequest, { type: typeof type }>), state: () => state, set };
}

const now = async (s: Stand): Promise<DefsView> => s.call("lah.defs.get", {});
const agentOf = (view: DefsView, id: string) => view.agents.find((a) => a.id === id);
const toolOf = (view: DefsView, name: string) => view.tools.find((t) => t.name === name);

/** The refusal a request gives; fails where it gives none. */
function refusal(run: () => unknown): Refusal {
  try {
    run();
  } catch (error) {
    if (error instanceof Refusal) return error;
    throw error;
  }
  throw new Error("The request was answered, where a refusal was expected.");
}

const clerk = (over: Partial<AgentDefinition> = {}): AgentDefinition => {
  const { text: _text, ...first } = baseAgents()[0] as AgentDefinition;
  return { ...first, id: "harbour-clerk", name: "Harbour clerk", given: "task", ...over };
};
const promise: Skill = { id: "note-a-promise", name: "Note a promise", description: "When someone promises something, write who, what and by when.", body: "# Note a promise\n\n1. Write it to notes/promises.md.\n" };

describe("what there is when the preview opens", () => {
  test("the agents: the core's three, an extension's, the user's, and the user's writer over the built-in", async () => {
    const view = await now(stand());
    expect(view.agents.map((a) => `${a.id}:${a.source}${a.over ? `>${a.over}` : ""}${a.off ? ":off" : ""}`)).toEqual(["main:builtin", "writer:user>builtin", "summarizer:builtin", "cartographer:extension", "archivist:user", "reader:user:off"]);
    expect(agentOf(view, "main")?.text).toBe("main.system");
    expect(view.skills.map((s) => s.source)).toEqual(["builtin", "builtin", "extension", "user"]);
  });

  test("the tools: the core's under their real names, each with its arguments, and the MCP server's that is on", async () => {
    const view = await now(stand());
    const names = view.tools.map((t) => t.name);
    // An entry that opens with @ names no one tool: a family's, or every tool the user added.
    for (const name of (baseAgents()[0]?.tools ?? []).filter((n) => !n.startsWith("@"))) expect(names).toContain(name);
    expect(view.tools.every((t) => t.parameters !== undefined && t.description !== "")).toBe(true);
    expect(names.filter((n) => n.startsWith("mcp:"))).toEqual(["mcp:tides:tide_times", "mcp:tides:harbour_depth", "mcp:tides:storm_warnings"]);
    expect(toolOf(view, "mcp:tides:tide_times")?.tier).toBe("external");
    expect(view.mcp.map((s) => `${s.id}:${s.off ? "off" : "on"}:${s.status}`)).toEqual(["tides:on:ready", "ship-register:off:failed"]);
    expect(view.mcp[1]?.problem).toContain("couldn't start it");
  });

  test("the form of what an agent runs with offers every tool and family, and what a new agent starts with fits it", async () => {
    const view = await now(stand());
    const properties = view.agentSchema.properties as JsonObject;
    expect(Object.keys(properties)).toEqual(["given", "connectionId", "model", "effort", "toolCalls", "tools", "budget"]);
    const offered = ((properties.tools as JsonObject).items as JsonObject).enum as string[];
    expect(offered).toContain("lore_search");
    expect(offered).toContain("@workspace");
    expect(offered).toContain("@mcp:tides");
    expect(Object.keys(view.agentDefaults).sort()).toEqual(["budget", "connectionId", "effort", "given", "model", "toolCalls", "tools"]);
  });

  test("nothing of the user's is kept where nothing was set up", async () => {
    const view = await now(stand({ ready: false }));
    expect(view.agents.map((a) => a.source)).toEqual(["builtin", "builtin", "builtin", "extension"]);
    expect(view.skills.some((s) => s.source === "user")).toBe(false);
    expect(view.agents.some((a) => a.off) || view.tools.some((t) => t.off || t.approval !== null)).toBe(false);
    expect(view.mcp).toEqual([]);
  });
});

describe("agents", () => {
  test("a save makes the user's own, and the state's counter moves", async () => {
    const s = stand();
    const view = await s.call("lah.agent.save", { agent: clerk() });
    expect(agentOf(view, "harbour-clerk")).toMatchObject({ source: "user", off: false, given: "task", name: "Harbour clerk" });
    expect(s.state().defs).toBe(1);
    expect(agentOf(await now(s), "harbour-clerk")?.name).toBe("Harbour clerk");
  });

  test("one saved under a built-in's id stands over it, and removing it brings the built-in back", async () => {
    const s = stand();
    const saved = await s.call("lah.agent.save", { agent: clerk({ id: "summarizer", name: "Summarizer of mine" }) });
    expect(agentOf(saved, "summarizer")).toMatchObject({ source: "user", over: "builtin", name: "Summarizer of mine" });
    expect(saved.agents.map((a) => a.id)).toEqual(["main", "writer", "summarizer", "cartographer", "archivist", "reader"]);
    const reset = await s.call("lah.def.remove", { kind: "agent", id: "summarizer" });
    expect(agentOf(reset, "summarizer")).toMatchObject({ source: "builtin", name: "Summarizer" });
    expect(agentOf(reset, "summarizer")?.over).toBeUndefined();
  });

  test("the user's writer resets to the built-in one; one of theirs alone is deleted", async () => {
    const s = stand();
    const reset = await s.call("lah.def.remove", { kind: "agent", id: "writer" });
    expect(agentOf(reset, "writer")?.source).toBe("builtin");
    const gone = await s.call("lah.def.remove", { kind: "agent", id: "reader" });
    expect(agentOf(gone, "reader")).toBeUndefined();
    expect(refusal(() => s.call("lah.def.remove", { kind: "agent", id: "main" })).code).toBe("not_found");
  });

  test("a bad value is refused with where it is", async () => {
    const s = stand();
    const base = clerk();
    const bad = refusal(() => s.call("lah.agent.save", { agent: clerk({ tools: ["chat_read", "harbour_bell", "@tides"], budget: { ...base.budget, revisions: -1 }, text: "harbour.system" }) }));
    expect(bad.code).toBe("invalid");
    expect(bad.problems?.map((p) => p.path.join("."))).toEqual(["tools.1", "tools.2", "budget.revisions", "text"]);
    expect(bad.problems?.[0]?.message).toContain("harbour_bell");
    expect(agentOf(await now(s), "harbour-clerk")).toBeUndefined();
    expect(s.state().defs).toBe(0);
    expect(refusal(() => s.call("lah.agent.save", { agent: clerk({ id: "Harbour Clerk" }) })).problems?.[0]?.path).toEqual(["id"]);
  });

  test("what an agent has of its tools when another starts it is kept as its definition says, and a word the core doesn't know is refused", async () => {
    const s = stand();
    // The extension's cartographer keeps its chart tools whoever starts it.
    expect(agentOf(await now(s), "cartographer")?.grant).toBe("definition");
    const kept = await s.call("lah.agent.save", { agent: clerk({ grant: "own" }) });
    expect(agentOf(kept, "harbour-clerk")?.grant).toBe("own");
    // A definition that says nothing of it leaves it to Settings: the member is left out, not kept as a word.
    const left = await s.call("lah.agent.save", { agent: clerk() });
    expect(agentOf(left, "harbour-clerk")).not.toHaveProperty("grant");
    // As a page of another build might send it: a word the type doesn't allow, so it is read as JSON, untyped.
    const strange: AgentDefinition = JSON.parse(JSON.stringify({ ...clerk(), grant: "everything" }));
    const bad = refusal(() => s.call("lah.agent.save", { agent: strange }));
    expect(bad.problems?.map((p) => p.path.join("."))).toEqual(["grant"]);
    expect(agentOf(await now(s), "harbour-clerk")).not.toHaveProperty("grant");
  });

  test("the core's own agent goes back with its text, as the user's over the built-in", async () => {
    const s = stand();
    const main = baseAgents()[0] as AgentDefinition;
    const view = await s.call("lah.agent.save", { agent: { ...main, description: "Works out each reply." } });
    expect(agentOf(view, "main")).toMatchObject({ source: "user", over: "builtin", text: "main.system", description: "Works out each reply." });
  });

  test("switches off and on, but not one a turn can't do without", async () => {
    const s = stand();
    const off = await s.call("lah.def.switch", { kind: "agent", id: "cartographer", off: true });
    expect(agentOf(off, "cartographer")?.off).toBe(true);
    const on = await s.call("lah.def.switch", { kind: "agent", id: "reader", off: false });
    expect(agentOf(on, "reader")?.off).toBe(false);
    expect(refusal(() => s.call("lah.def.switch", { kind: "agent", id: "main", off: true })).code).toBe("conflict");
    expect(refusal(() => s.call("lah.def.switch", { kind: "agent", id: "harbour-clerk", off: true })).code).toBe("not_found");
  });
});

describe("skills", () => {
  test("a save makes one, a second save replaces it, and it switches off and is deleted", async () => {
    const s = stand();
    const made = await s.call("lah.skill.save", { skill: promise });
    expect(made.skills.at(-1)).toEqual({ ...promise, source: "user", off: false });
    const edited = await s.call("lah.skill.save", { skill: { ...promise, name: "Note what was promised" } });
    expect(edited.skills.filter((k) => k.id === promise.id).map((k) => k.name)).toEqual(["Note what was promised"]);
    const off = await s.call("lah.def.switch", { kind: "skill", id: promise.id, off: true });
    expect(off.skills.at(-1)?.off).toBe(true);
    const gone = await s.call("lah.def.remove", { kind: "skill", id: promise.id });
    expect(gone.skills.some((k) => k.id === promise.id)).toBe(false);
  });

  test("one with no body is refused, and a built-in can't be removed", async () => {
    const s = stand();
    const bad = refusal(() => s.call("lah.skill.save", { skill: { ...promise, body: "  " } }));
    expect(bad.code).toBe("invalid");
    expect(bad.problems?.map((p) => p.path)).toEqual([["body"]]);
    expect(refusal(() => s.call("lah.def.remove", { kind: "skill", id: "recap-a-scene" })).code).toBe("not_found");
  });
});

describe("tools and MCP servers", () => {
  test("a tool switches off by name", async () => {
    const s = stand();
    const view = await s.call("lah.def.switch", { kind: "tool", id: "lore_search", off: true });
    expect(toolOf(view, "lore_search")?.off).toBe(true);
    expect(refusal(() => s.call("lah.def.switch", { kind: "tool", id: "harbour_bell", off: true })).code).toBe("not_found");
  });

  test("switching a server off takes its tools from the list, and on brings them back", async () => {
    const s = stand();
    const off = await s.call("lah.def.switch", { kind: "mcp", id: "tides", off: true });
    expect(off.tools.some((t) => t.name.startsWith("mcp:"))).toBe(false);
    expect(off.mcp[0]?.off).toBe(true);
    const on = await s.call("lah.def.switch", { kind: "mcp", id: "tides", off: false });
    expect(on.tools.filter((t) => t.name.startsWith("mcp:tides:")).length).toBe(3);
    // A server that failed in Lumiverse has nothing to offer, switched on or not.
    const failed = await s.call("lah.def.switch", { kind: "mcp", id: "ship-register", off: false });
    expect(failed.mcp[1]?.off).toBe(false);
    expect(failed.tools.some((t) => t.name.startsWith("mcp:ship-register:"))).toBe(false);
    expect(refusal(() => s.call("lah.def.switch", { kind: "mcp", id: "lighthouse", off: false })).code).toBe("not_found");
  });
});

describe("approval, kept by the part where the settings have no such section", () => {
  test("a tool's own choice stands over its tier's, and null gives it back to the tier", async () => {
    const s = stand();
    const asks = await s.call("lah.tool.approval", { name: "workspace_write", approval: "ask" });
    expect(toolOf(asks, "workspace_write")).toMatchObject({ approval: "ask", asks: true });
    expect(toolOf(asks, "workspace_edit")).toMatchObject({ approval: null, asks: false });
    const back = await s.call("lah.tool.approval", { name: "workspace_write", approval: null });
    expect(toolOf(back, "workspace_write")).toMatchObject({ approval: null, asks: false });
    expect(refusal(() => s.call("lah.tool.approval", { name: "harbour_bell", approval: "ask" })).code).toBe("not_found");
  });

  test("a tier's choice changes what the tools that follow it do, and leaves a tool's own", async () => {
    const s = stand();
    // Every tier's calls go ahead until the user says otherwise: an MCP server's tools too, once it is switched on for agents.
    expect((await now(s)).tiers).toEqual({ read: "allow", write: "allow", external: "allow" });
    await s.call("lah.tool.approval", { name: "workspace_read", approval: "allow" });
    await s.call("lah.tier.approval", { tier: "external", approval: "ask" });
    const view = await s.call("lah.tier.approval", { tier: "read", approval: "ask" });
    expect(view.tiers).toEqual({ read: "ask", write: "allow", external: "ask" });
    expect(toolOf(view, "chat_search")?.asks).toBe(true);
    expect(toolOf(view, "workspace_read")?.asks).toBe(false);
    expect(toolOf(view, "mcp:tides:tide_times")?.asks).toBe(true);
    expect(s.set).toEqual([]);
  });
});

describe("approval, kept as the setting it is where the settings have it", () => {
  test("a tier's choice is set at the settings' own path, and read back from there", async () => {
    const s = stand({ settings: CORE_SETTINGS });
    const view = await s.call("lah.tier.approval", { tier: "write", approval: "ask" });
    expect(s.set).toEqual([{ path: ["core", "approval", "tiers", "write"], value: "ask" }]);
    expect(view.tiers.write).toBe("ask");
    expect(toolOf(view, "workspace_write")?.asks).toBe(true);
    expect(s.state().defs).toBe(1);
  });

  test("a tool's choice is a row of the settings' table by tool, and null takes the row away", async () => {
    const s = stand({ settings: CORE_SETTINGS });
    const asks = await s.call("lah.tool.approval", { name: "job_start", approval: "ask" });
    expect(s.set.at(-1)).toEqual({ path: ["core", "approval", "tools"], value: { job_start: "ask" } });
    expect(toolOf(asks, "job_start")).toMatchObject({ approval: "ask", asks: true });
    const back = await s.call("lah.tool.approval", { name: "job_start", approval: null });
    expect(s.set.at(-1)).toEqual({ path: ["core", "approval", "tools"], value: {} });
    expect(toolOf(back, "job_start")).toMatchObject({ approval: null, asks: false });
  });
});

test("the contract test's sequence succeeds on settings with no approval section", async () => {
  const s = stand();
  await now(s);
  const saved = await s.call("lah.agent.save", { agent: clerk({ name: "Main agent" }) });
  expect(agentOf(saved, "harbour-clerk")?.given).toBe("task");
  expect((await s.call("lah.skill.save", { skill: promise })).skills.some((k) => k.id === "note-a-promise")).toBe(true);
  expect(agentOf(await s.call("lah.def.remove", { kind: "agent", id: "archivist" }), "archivist")).toBeUndefined();
  expect(toolOf(await s.call("lah.def.switch", { kind: "tool", id: "lore_search", off: true }), "lore_search")?.off).toBe(true);
  expect(toolOf(await s.call("lah.tool.approval", { name: "workspace_write", approval: "ask" }), "workspace_write")?.asks).toBe(true);
  expect((await s.call("lah.tier.approval", { tier: "external", approval: "ask" })).tiers.external).toBe("ask");
  expect(s.state().defs).toBe(6);
});
