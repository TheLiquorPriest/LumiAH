// What a tool that runs in the extension is told of its caller (DESIGN §21): the kind of run the
// call is part of, whether the caller is the run's main agent, and the agents over it. An extension
// tells the run's main agent from an agent it handed a task by this, never by the definition the
// two run as: a delegate may run as the very definition the run started with.

import { describe, expect, test } from "bun:test";
import type { AgentDefinition } from "../../src/core/agents";
import { createHarness } from "../../src/core/harness";
import type { ModelRequest, RemoteTool, RemoteToolCall } from "../../src/core/ports";
import { defaultSettings, newAgentSettings, type Settings } from "../../src/core/settings";
import { type Answer, call, MemoryHost, runTurn, type Script, Sink } from "./support/host";

const CHAT = "chat-1";
const never = new AbortController().signal;

/** The extension's tool: it answers with nothing of interest, and the test reads what it was told. */
const BERTH: RemoteTool = { name: "harbour_berth", family: "harbour", tier: "read", description: "Says which berth a boat lies at.", parameters: { type: "object", properties: { boat: { type: "string", description: "The boat's name." } }, required: ["boat"] }, source: "extension" };

const SCOUT = "You are a scout. Find what you are asked for and say it in a line.";
const PILOT = "You are a pilot. Bring a boat to its berth and say where it lies.";
/** Two definitions registered beside the core's, each holding the extension's tool and delegation's. */
const worker = (id: string, name: string, instructions: string): AgentDefinition => ({ ...newAgentSettings(), id, name, description: `${name}: finds a boat's berth.`, instructions, given: "task", tools: [BERTH.name, "delegate", "agent_message"] });

const system = (request: ModelRequest): string => (request.messages[0]?.role === "system" ? request.messages[0].content : "");
/** What opens a call's conversation: for a sub-agent, its task. */
const task = (request: ModelRequest): string => request.messages.find((m) => m.role === "user")?.content ?? "";
/** The agent has had a round of tool calls on what it is working on. */
const worked = (request: ModelRequest): boolean => request.messages.at(-1)?.parts?.some((part) => part.type === "tool_result") === true;

const berth = (boat: string, id: string) => call(BERTH.name, { boat }, id);
const delegate = (agent: string, what: string, id: string) => call("delegate", { agent, task: what }, id);

/** A host whose extension has one tool, a harness with the two workers registered, and every call the tool was sent. */
function rig(script: Script, change: (s: Settings) => void = () => undefined) {
  const host = new MemoryHost();
  host.script = script;
  const calls: RemoteToolCall[] = [];
  host.tools = { list: async () => [BERTH], call: async (made) => (calls.push(structuredClone(made)), { text: `The ${String(made.args.boat)} lies at berth 2.` }) };
  host.say(CHAT, "assistant", "The harbour is quiet tonight.");
  host.say(CHAT, "user", "I ask Brann where the Gannet lies.");
  const stored = { values: defaultSettings(), texts: {} };
  stored.values.reply.writer = "main";
  change(stored.values);
  const harness = createHarness(host, { settings: async () => structuredClone(stored) });
  harness.agents.register(worker("scout", "Scout", SCOUT), worker("pilot", "Pilot", PILOT));
  /** The agents the run started as one definition, in the order they started. */
  const started = (role: string): string[] => host.traced.flatMap(({ event }) => (event.kind === "agent_started" && event.agent.role === role ? [event.agent.id] : []));
  /** What the tool was told of a call's caller, by the call's id. */
  const told = (callId: string) => {
    const made = calls.find((c) => c.callId === callId);
    return made ? { turn: made.turn, agentId: made.agentId, role: made.role, kind: made.kind, main: made.main, above: made.above } : undefined;
  };
  return { host, harness, calls, started, told };
}

describe("a turn's agents", () => {
  /** The main agent asks itself, then hands the task to the scout, which asks and hands it on to the pilot, which asks. */
  const chain: Script = (request): Answer => {
    const who = system(request);
    if (who.includes(PILOT)) return worked(request) ? "Berth 2." : { toolCalls: [berth("Gannet", "p1")] };
    if (who.includes(SCOUT)) return worked(request) ? "Berth 2, the pilot says." : { toolCalls: [berth("Gannet", "s1"), delegate("pilot", "Bring the Gannet in.", "s2")] };
    return worked(request) ? "She lies at berth 2." : { toolCalls: [berth("Gannet", "m1"), delegate("scout", "Find the Gannet.", "m2")] };
  };

  test("the main agent's call says it is the run's main agent, with nobody over it, in a turn that answers a new reply", async () => {
    const r = rig(chain);
    const { request, result } = await runTurn(r.host, r.harness, CHAT);
    expect(result).toMatchObject({ status: "done", reply: "She lies at berth 2." });
    const [main] = r.started("main");
    expect(r.told("m1")).toEqual({ turn: request.generationId, agentId: main ?? "", role: "main", kind: "new", main: true, above: [] });
  });

  test("a delegate's call says it isn't, with the agent that started it above it; and the run's kind is the turn's", async () => {
    const r = rig(chain, (s) => (s.delegation.depth = 1));
    r.host.say(CHAT, "assistant", "Brann shrugs.");
    const { request } = await runTurn(r.host, r.harness, CHAT, { kind: "swipe" });
    const [main] = r.started("main");
    const [scout] = r.started("scout");
    expect(r.told("m1")).toMatchObject({ kind: "swipe", main: true, above: [] });
    expect(r.told("s1")).toEqual({ turn: request.generationId, agentId: scout ?? "", role: "scout", kind: "swipe", main: false, above: [{ agentId: main ?? "", role: "main" }] });
    // With Depth at 1 only the main agent delegates: the scout's own delegate call started nobody.
    expect(r.started("pilot")).toEqual([]);
    expect(r.told("p1")).toBeUndefined();
  });

  test("a delegate of a delegate has both above it, the run's main agent first", async () => {
    // Depth as it ships (2): the agents the main agent starts delegate too.
    const r = rig(chain);
    await runTurn(r.host, r.harness, CHAT);
    const [main] = r.started("main");
    const [scout] = r.started("scout");
    const [pilot] = r.started("pilot");
    expect(r.told("p1")).toMatchObject({
      agentId: pilot ?? "",
      role: "pilot",
      kind: "new",
      main: false,
      above: [
        { agentId: main ?? "", role: "main" },
        { agentId: scout ?? "", role: "scout" },
      ],
    });
    // The agents between them are told as before.
    expect(r.told("s1")).toMatchObject({ main: false, above: [{ agentId: main ?? "", role: "main" }] });
    expect(r.told("m1")).toMatchObject({ main: true, above: [] });
  });
});

describe("a job's agent and a side session's", () => {
  test("a job's agent is its run's main agent, and the run's kind is a job's", async () => {
    const r = rig((request) => (worked(request) ? "Berth 2." : { toolCalls: [berth("Gannet", "j1")] }));
    const { job } = await r.harness.jobs.start({ chatId: CHAT, agent: "scout", task: "Find the Gannet.", when: "now" });
    expect((await r.harness.jobs.run({ id: job.id }, never)).state).toBe("done");
    expect(r.told("j1")).toEqual({ turn: job.id, agentId: r.started("scout")[0] ?? "", role: "scout", kind: "job", main: true, above: [] });
  });

  test("a side session's agent is its run's main agent; a delegate that runs as the same definition is not, and has the first above it", async () => {
    // The user talks to the scout. It hands a task to the pilot, which hands one back to a scout: a second agent of the definition the run started with.
    const r = rig(
      (request): Answer => {
        if (system(request).includes(PILOT)) return worked(request) ? "Berth 2, the scout says." : { toolCalls: [delegate("scout", "Read the berth list.", "p2")] };
        const second = task(request).includes("Read the berth list.");
        if (second) return worked(request) ? "Berth 2." : { toolCalls: [berth("Gannet", "s9")] };
        return worked(request) ? "She lies at berth 2." : { toolCalls: [berth("Gannet", "s1"), delegate("pilot", "Bring the Gannet in.", "s2")] };
      },
      (s) => (s.delegation.depth = 2),
    );
    const { side } = await r.harness.sides.start({ chatId: CHAT, agent: "scout" });
    const { status, reply } = await r.harness.side({ session: side.id, generationId: "side-turn-1", text: "Where does the Gannet lie?" }, new Sink(), never);
    expect([status, reply]).toEqual(["done", "She lies at berth 2."]);
    const [first, second] = r.started("scout");
    const [pilot] = r.started("pilot");
    expect(second).toBeString();
    expect(r.told("s1")).toEqual({ turn: "side-turn-1", agentId: first ?? "", role: "scout", kind: "side", main: true, above: [] });
    expect(r.told("s9")).toEqual({
      turn: "side-turn-1",
      agentId: second ?? "",
      role: "scout",
      kind: "side",
      main: false,
      above: [
        { agentId: first ?? "", role: "scout" },
        { agentId: pilot ?? "", role: "pilot" },
      ],
    });
  });
});
