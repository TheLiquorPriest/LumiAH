// What a review of the loop found, one part for each finding, on the scripted model and the
// hand-moved clock `loop.test.ts` uses:
//
//   - a round that a stop or a time limit ended begins none of its calls that had not begun, and the
//     built-in tools that start something read their signal before anything else;
//   - approval fails closed: only an answer that is exactly an approval runs a held call;
//   - the loop detector counts a call as a repeat only where its result is the same too, a call an
//     answer makes several times is run once, and waiting for a job is never a loop;
//   - of one answer's calls to a tool whose result ends the send, the first alone is run.

import { describe, expect, test } from "bun:test";
import { type AgentDeps, type AgentHandle, type AgentSpec, type ApprovalGate, startAgent } from "../../src/core/loop";
import type { ApprovalAnswer, JobState, JobView, JsonObject, ModelRequest, TranscriptEntry } from "../../src/core/ports";
import { AgentAccounts } from "../../src/core/provider";
import { defaultSettings, type Settings } from "../../src/core/settings";
import { TEXT, Texts, TOOL } from "../../src/core/texts";
import type { AgentTool, Delegation, JobTools, ToolCtx, ToolEnv } from "../../src/core/tools";
import { AGENT_TOOLS } from "../../src/core/tools/agents";
import { JOB_TOOLS } from "../../src/core/tools/jobs";
import { REPLY_TOOLS } from "../../src/core/tools/write-reply";
import { emptyUsage } from "../../src/core/usage";
import { call, idle, MAIN, MemoryHost, type Script, until } from "./support/host";

/** A tool that records each call's arguments and answers `answer` of them. */
function tool(name: string, answer: (args: JsonObject) => string | Promise<string> = () => `${name} done`): AgentTool & { runs: JsonObject[] } {
  const runs: JsonObject[] = [];
  return {
    name,
    description: `The ${name} tool.`,
    parameters: { type: "object", properties: { q: { type: "string" } } },
    runs,
    run: async (args) => {
      runs.push(args);
      return { text: await answer(args) };
    },
  };
}

/** A tool whose run never settles and doesn't heed its signal: whatever ends the round has to leave it behind. */
function stuck(): AgentTool & { runs: JsonObject[] } {
  const runs: JsonObject[] = [];
  return {
    name: "stuck",
    description: "The stuck tool.",
    parameters: { type: "object", properties: {} },
    runs,
    run: (args) => {
      runs.push(args);
      return new Promise<never>(() => undefined);
    },
  };
}

function rig(script: Script, change: (s: Settings) => void = () => undefined, options: { approval?: ApprovalGate } = {}) {
  const host = new MemoryHost();
  host.script = script;
  const settings = defaultSettings();
  change(settings);
  const texts = new Texts({});
  const deps: AgentDeps = { host, settings, texts, accounts: new AgentAccounts(host), turn: null, ...(options.approval ? { approval: options.approval } : {}) };
  const budget = { ...defaultSettings().agents.main!.budget };
  const spec = (over: Partial<AgentSpec> = {}): AgentSpec => ({ role: "main", connectionId: MAIN, model: null, effort: "medium", system: "You look things up.", prefix: [], tools: [], budget, ...over });
  return { host, deps, settings, texts, spec, start: (over: Partial<AgentSpec> = {}) => startAgent(spec(over), deps) };
}

type ResultEntry = Extract<TranscriptEntry, { kind: "result" }>;

/** A call's result as the agent's transcript holds it. */
function resultOf(agent: AgentHandle, callId: string): ResultEntry | undefined {
  return agent.transcript().entries.find((e): e is ResultEntry => e.kind === "result" && e.callId === callId);
}

/** The results the model was sent with a request: each call's id, text and whether it failed. */
function resultsSent(request: ModelRequest | undefined): { id: string; text: string; error: boolean }[] {
  return (request?.messages.at(-1)?.parts ?? []).flatMap((p) => (p.type === "tool_result" ? [{ id: p.toolUseId, text: p.content, error: p.isError === true }] : []));
}

const writing = (name: string) => ({ ...tool(name), tier: "write" as const });

/** As much of what a tool is built from as the tools of this file read: the settings, the texts, and what a test gives besides. */
function envOf(over: Partial<ToolEnv>): ToolEnv {
  return { settings: defaultSettings(), texts: new Texts({}), ...over } as ToolEnv;
}

/** A definition's tool as built from `env`. */
function built(definitions: readonly { name: string; build(env: ToolEnv): AgentTool | null }[], name: string, env: ToolEnv): AgentTool {
  const made = definitions.find((d) => d.name === name)?.build(env);
  if (!made) throw new Error(`${name} has nothing to offer here`);
  return made;
}

const job = (state: JobState): JobView => ({ id: "job-1", chatId: "chat-1", agent: "summarizer", task: "Find who holds the key.", when: "now", state, by: { who: "agent", id: "agent_1", role: "main" }, basis: "gen-1", createdAt: 1, usage: emptyUsage() });

describe("a round a stop or a time limit ended begins no further call (H4)", () => {
  const notRun = (texts: Texts, name: string, stop: string): string => texts.render(TEXT.runtime.notRun, { name, reason: texts.render(stop) });

  test("stopped while the calls that run at once are under way, the calls still waiting for their place are never begun, and each reads that it wasn't run", async () => {
    const hang = stuck();
    const save = writing("save");
    const r = rig([{ toolCalls: [call("stuck", { q: "1" }, "c1"), call("stuck", { q: "2" }, "c2"), call("stuck", { q: "3" }, "c3"), call("stuck", { q: "4" }, "c4"), call("save", { q: "5" }, "c5"), call("save", { q: "6" }, "c6")] }, "never"]);
    expect(r.spec().budget.concurrency).toBe(4);
    const agent = r.start({ tools: [hang, save] });
    const stop = new AbortController();
    const sending = agent.send("go", stop.signal);
    await until(() => hang.runs.length === 4);
    stop.abort();
    expect(await sending).toMatchObject({ status: "cancelled", code: "cancelled" });
    await idle();
    expect(save.runs).toEqual([]);
    expect(hang.runs).toHaveLength(4);
    for (const id of ["c5", "c6"]) expect(resultOf(agent, id)).toMatchObject({ name: "save", text: notRun(r.texts, "save", TEXT.stop.cancelled), error: true });
    expect(resultOf(agent, "c5")?.text).toBe("Not run: the agent was cancelled, before this call of save began. Nothing of it was started.");
    expect(r.host.calls).toHaveLength(1);
  });

  test("one call at a time: every call after the one the stop overtook is left unbegun", async () => {
    const hang = stuck();
    const save = writing("save");
    const r = rig([{ toolCalls: [call("stuck", {}, "c1"), call("save", { q: "Ilse" }, "c2"), call("save", { q: "Brann" }, "c3")] }, "never"]);
    const agent = r.start({ tools: [hang, save], budget: { ...r.spec().budget, concurrency: 1 } });
    const sending = agent.send("go");
    await until(() => hang.runs.length === 1);
    agent.cancel();
    expect(await sending).toMatchObject({ status: "cancelled" });
    await idle();
    expect(save.runs).toEqual([]);
    for (const id of ["c2", "c3"]) expect(resultOf(agent, id)).toMatchObject({ text: notRun(r.texts, "save", TEXT.stop.cancelled), error: true });
  });

  test("the agent's time running out while the first calls are under way does the same, and the result names the limit", async () => {
    const hang = stuck();
    const save = writing("save");
    const r = rig([{ toolCalls: [call("stuck", { q: "1" }, "c1"), call("stuck", { q: "2" }, "c2"), call("save", { q: "3" }, "c3"), call("save", { q: "4" }, "c4")] }, "never"]);
    const agent = r.start({ tools: [hang, save], budget: { ...r.spec().budget, concurrency: 2, wallMs: 5000 } });
    const sending = agent.send("go");
    await until(() => hang.runs.length === 2);
    r.host.clock.advance(4999);
    await idle();
    expect(save.runs).toEqual([]);
    r.host.clock.advance(1);
    expect(await sending).toMatchObject({ status: "refused", code: "wall_time" });
    await idle();
    expect(save.runs).toEqual([]);
    const why = "the agent has worked all the time Time per agent (Settings → Agents → Main agent → Budget) allows";
    for (const id of ["c3", "c4"]) expect(resultOf(agent, id)).toMatchObject({ text: `Not run: ${why}, before this call of save began. Nothing of it was started.`, error: true });
  });

  test("a call that still waited for its place when the stop came is not asked about either: nothing of it is started, whatever it would have been told", async () => {
    const hang = stuck();
    const save = writing("save");
    const asked: string[] = [];
    const gate: ApprovalGate = { asks: (held) => held.tier === "write", waitMs: 300_000, ask: async (ask) => (asked.push(ask.callId), { decision: "once" }) };
    // After the stuck call: one the user would be asked about, one to a tool there isn't, and one past Tool calls per answer.
    const r = rig([{ toolCalls: [call("stuck", {}, "c1"), call("save", { q: "Ilse" }, "c2"), call("nowhere", {}, "c3"), call("save", { q: "Brann" }, "c4")] }, "never"], undefined, { approval: gate });
    const agent = r.start({ tools: [hang, save], budget: { ...r.spec().budget, concurrency: 1, callTools: 3 } });
    const sending = agent.send("go");
    await until(() => hang.runs.length === 1);
    agent.cancel();
    expect(await sending).toMatchObject({ status: "cancelled" });
    await idle();
    expect(asked).toEqual([]);
    expect(save.runs).toEqual([]);
    expect(agent.transcript().entries.filter((e) => e.kind === "approval_asked")).toEqual([]);
    expect(["c2", "c3", "c4"].map((id) => resultOf(agent, id)?.text)).toEqual([notRun(r.texts, "save", TEXT.stop.cancelled), notRun(r.texts, "nowhere", TEXT.stop.cancelled), notRun(r.texts, "save", TEXT.stop.cancelled)]);
  });

  test("a held call the stop overtook never runs, even when the approval comes after the stop", async () => {
    const save = writing("save");
    const word = Promise.withResolvers<ApprovalAnswer>();
    let asked = 0;
    // A way to ask that doesn't heed its signal: the word it gives arrives after the round has ended.
    const gate: ApprovalGate = { asks: (held) => held.tier === "write", waitMs: 300_000, ask: () => (asked++, word.promise) };
    const r = rig([{ toolCalls: [call("save", { q: "Ilse" }, "c1")] }, "never"], undefined, { approval: gate });
    const agent = r.start({ tools: [save] });
    const stop = new AbortController();
    const sending = agent.send("go", stop.signal);
    await until(() => asked === 1);
    stop.abort();
    await idle();
    word.resolve({ decision: "once" });
    expect(await sending).toMatchObject({ status: "cancelled", code: "cancelled" });
    await idle();
    expect(save.runs).toEqual([]);
    expect(resultOf(agent, "c1")).toMatchObject({ text: notRun(r.texts, "save", TEXT.stop.cancelled), error: true });
    expect(r.host.calls).toHaveLength(1);
  });

  test("a held call whose ask the stop ended never runs, and reads that it wasn't begun", async () => {
    const save = writing("save");
    let asked = 0;
    const gate: ApprovalGate = {
      asks: (held) => held.tier === "write",
      waitMs: 300_000,
      ask: (_ask, signal) => {
        asked++;
        const { promise, reject } = Promise.withResolvers<ApprovalAnswer>();
        signal.addEventListener("abort", () => reject(signal.reason), { once: true });
        return promise;
      },
    };
    const r = rig([{ toolCalls: [call("save", { q: "Ilse" }, "c1")] }, "never"], undefined, { approval: gate });
    const agent = r.start({ tools: [save] });
    const sending = agent.send("go");
    await until(() => asked === 1);
    agent.cancel();
    expect(await sending).toMatchObject({ status: "cancelled" });
    expect(save.runs).toEqual([]);
    expect(resultOf(agent, "c1")).toMatchObject({ text: notRun(r.texts, "save", TEXT.stop.cancelled), error: true });
  });

  /** A call's context whose round has already ended. */
  const ended = (): ToolCtx => ({ signal: AbortSignal.abort(new Error("the round ended")), agentId: "agent_test", role: "main", callId: "c1" });
  const live = (): ToolCtx => ({ signal: new AbortController().signal, agentId: "agent_test", role: "main", callId: "c1" });

  test("delegate and agent_message, given a signal already ended, start no agent and send none a message", async () => {
    const started: string[] = [];
    const delegation: Delegation = {
      agents: () => [{ id: "summarizer", name: "Summarizer", description: "Reads and sums up." }],
      offersAs: false,
      toReply: false,
      start: async (input) => (started.push(`start:${input.agent}`), { text: "started" }),
      message: async (input) => (started.push(`message:${input.handle}`), { text: "sent" }),
    };
    const env = envOf({ delegation });
    const delegate = built(AGENT_TOOLS, TOOL.delegate, env);
    const message = built(AGENT_TOOLS, TOOL.agentMessage, env);
    await expect(delegate.run({ agent: "summarizer", task: "Read the harbour log." }, ended())).rejects.toThrow("the round ended");
    await expect(message.run({ handle: "a1", text: "And the mill?" }, ended())).rejects.toThrow("the round ended");
    expect(started).toEqual([]);
    // With the round under way the same calls go through: it is the signal alone that held them.
    await delegate.run({ agent: "summarizer", task: "Read the harbour log." }, live());
    await message.run({ handle: "a1", text: "And the mill?" }, live());
    expect(started).toEqual(["start:summarizer", "message:a1"]);
  });

  test("job_start and job_cancel, given a signal already ended, queue no job and cancel none", async () => {
    const done: string[] = [];
    const jobs: JobTools = {
      offersAs: false,
      agents: () => [{ id: "summarizer", name: "Summarizer", description: "Reads and sums up." }],
      start: async () => (done.push("start"), job("queued")),
      list: async () => [],
      read: async () => null,
      cancel: async (id) => (done.push(`cancel:${id}`), { job: job("cancelled"), cancelled: true }),
    };
    const env = envOf({ jobs });
    const start = built(JOB_TOOLS, TOOL.jobStart, env);
    const cancel = built(JOB_TOOLS, TOOL.jobCancel, env);
    await expect(start.run({ agent: "summarizer", task: "Find who holds the key." }, ended())).rejects.toThrow("the round ended");
    await expect(cancel.run({ job: "job-1" }, ended())).rejects.toThrow("the round ended");
    expect(done).toEqual([]);
    await start.run({ agent: "summarizer", task: "Find who holds the key." }, live());
    await cancel.run({ job: "job-1" }, live());
    expect(done).toEqual(["start", "cancel:job-1"]);
  });
});

describe("approval fails closed: only an answer that is exactly an approval runs a held call (M10)", () => {
  /** A gate that holds every tool that writes and answers each ask with `answer`, whatever that is. */
  const answering = (answer: unknown): ApprovalGate => ({ asks: (held) => held.tier === "write", waitMs: 300_000, ask: async () => answer as ApprovalAnswer });
  const closed = (agent: AgentHandle) => agent.transcript().entries.flatMap((e) => (e.kind === "approval" ? [e] : []));

  const junk: [label: string, answer: unknown][] = [
    ["an object with no decision", {}],
    ["a decision that is none of the three", { decision: "expired" }],
    ["a refusal spelled another way", { decision: "Refused" }],
    ["an approval spelled another way", { decision: "Once" }],
    ["an error in an answer's place", { error: "the page went away" }],
    ["a bare string", "once"],
    ["null", null],
    ["nothing", undefined],
    ["a list", [{ decision: "once" }]],
  ];

  for (const [label, answer] of junk) {
    test(`${label}: the tool isn't run, the model reads that nobody gave their word, and the record closes the ask as a refusal`, async () => {
      const save = writing("save");
      const r = rig([{ toolCalls: [call("save", { q: "Ilse" }, "c1")] }, "Done without it."], undefined, { approval: answering(answer) });
      const agent = r.start({ tools: [save] });
      expect(await agent.send("go")).toMatchObject({ status: "answered", text: "Done without it." });
      expect(save.runs).toEqual([]);
      expect(resultsSent(r.host.calls[1])).toEqual([{ id: "c1", text: r.texts.render(TEXT.approval.unread, { tool: "save" }), error: true }]);
      expect(closed(agent)).toMatchObject([{ callId: "c1", decision: "refused", reason: r.texts.render(TEXT.approval.unreadWhy) }]);
    });
  }

  test("the words the model reads for an answer that isn't one", async () => {
    const r = rig([{ toolCalls: [call("save", {}, "c1")] }, "Done without it."], undefined, { approval: answering({}) });
    await r.start({ tools: [writing("save")] }).send("go");
    expect(resultsSent(r.host.calls[1])[0]?.text).toBe("Not run: this call of save needs the user's approval, and what came back was neither an approval nor a refusal, so nobody gave their word for it. Go on without it, or say in your answer what you needed it for.");
  });

  for (const decision of ["once", "chat"] as const) {
    test(`an answer that is exactly ${decision} runs the tool`, async () => {
      const save = writing("save");
      const r = rig([{ toolCalls: [call("save", { q: "Ilse" }, "c1")] }, "Saved."], undefined, { approval: answering({ decision, more: "ignored" }) });
      const agent = r.start({ tools: [save] });
      expect(await agent.send("go")).toMatchObject({ status: "answered", text: "Saved." });
      expect(save.runs).toEqual([{ q: "Ilse" }]);
      expect(resultsSent(r.host.calls[1])).toEqual([{ id: "c1", text: "save done", error: false }]);
      expect(closed(agent)).toMatchObject([{ callId: "c1", decision }]);
    });
  }

  test("a refusal with a reason gives the model the reason; a reason that isn't words is left out", async () => {
    for (const [answer, reason] of [
      [{ decision: "refused", reason: "Brann hasn't agreed" }, "Brann hasn't agreed"],
      [{ decision: "refused", reason: 7 }, ""],
    ] as const) {
      const save = writing("save");
      const r = rig([{ toolCalls: [call("save", {}, "c1")] }, "Done without it."], undefined, { approval: answering(answer) });
      const agent = r.start({ tools: [save] });
      await agent.send("go");
      expect(save.runs).toEqual([]);
      expect(resultsSent(r.host.calls[1])).toEqual([{ id: "c1", text: r.texts.render(TEXT.approval.refused, { tool: "save", reason: reason === "" ? "" : r.texts.render(TEXT.approval.refusedReason, { reason }) }), error: true }]);
      expect(closed(agent)).toMatchObject([{ callId: "c1", decision: "refused" }]);
      expect(closed(agent)[0]?.reason).toBe(reason === "" ? undefined : reason);
    }
  });
});

describe("the loop detector counts a repeat only where the result is the same too (M5)", () => {
  const same = { toolCalls: [call("lookup", { q: "lamp" })] };

  test("the same call three times in one answer runs the tool once, gives each call the result, and stops nothing", async () => {
    const lookup = tool("lookup", () => "the lamp is lit");
    const r = rig([{ toolCalls: [call("lookup", { q: "lamp" }, "c1"), call("lookup", { q: "lamp" }, "c2"), call("lookup", { q: "lamp" }, "c3")] }, "The lamp is lit."]);
    expect(r.settings.loop.repeats).toBe(3);
    const agent = r.start({ tools: [lookup] });
    expect(await agent.send("go")).toMatchObject({ status: "answered", text: "The lamp is lit." });
    expect(lookup.runs).toEqual([{ q: "lamp" }]);
    expect(resultsSent(r.host.calls[1])).toEqual(["c1", "c2", "c3"].map((id) => ({ id, text: "the lamp is lit", error: false })));
    // Each is on the record under its own id; the two that weren't run took no time.
    expect(["c1", "c2", "c3"].map((id) => resultOf(agent, id)?.text)).toEqual(["the lamp is lit", "the lamp is lit", "the lamp is lit"]);
    expect(agent.usage().toolTurns).toBe(1);
  });

  test("an answer that makes one call many times over counts it once: the same call in the next two answers is what makes three", async () => {
    const lookup = tool("lookup", () => "the lamp is lit");
    const thrice = { toolCalls: [call("lookup", { q: "lamp" }), call("lookup", { q: "lamp" }), call("lookup", { q: "lamp" })] };
    const r = rig([thrice, thrice, "Twice over is no loop."]);
    expect(await r.start({ tools: [lookup] }).send("go")).toMatchObject({ status: "answered", text: "Twice over is no loop." });
    expect(lookup.runs).toHaveLength(2);
    const s = rig([thrice, thrice, thrice, "never reached"]);
    expect(await s.start({ tools: [tool("lookup", () => "the lamp is lit")] }).send("go")).toMatchObject({ status: "stopped", code: "loop" });
  });

  test("the same call in three answers running, with a different result each time, is no loop", async () => {
    let n = 0;
    const lookup = tool("lookup", () => `the tide stands at mark ${++n}`);
    const r = rig([same, same, same, same, same, "The tide came in."]);
    expect(await r.start({ tools: [lookup] }).send("go")).toMatchObject({ status: "answered", text: "The tide came in." });
    expect(lookup.runs).toHaveLength(5);
  });

  test("with the same result each time it is one, at Settings' number of repeats", async () => {
    const lookup = tool("lookup", () => "the lamp is lit");
    const r = rig([same, same, same, "never reached"]);
    expect(await r.start({ tools: [lookup] }).send("go")).toMatchObject({ status: "stopped", code: "loop", reason: r.texts.render(TEXT.stop.loop, { tool: "lookup", times: "3 times" }) });
    expect(lookup.runs).toHaveLength(3);
    expect(r.host.calls).toHaveLength(3);
    const four = rig([same, same, same, same, "never reached"], (s) => (s.loop.repeats = 4));
    expect(await four.start({ tools: [tool("lookup", () => "the lamp is lit")] }).send("go")).toMatchObject({ status: "stopped", code: "loop" });
    expect(four.host.calls).toHaveLength(4);
  });

  test("a result that differs once starts the count again", async () => {
    const said = ["the lamp is lit", "the lamp is lit", "the lamp is out", "the lamp is out", "the lamp is lit"];
    const lookup = tool("lookup", () => said.shift() ?? "");
    const r = rig([same, same, same, same, same, "It flickers."]);
    expect(await r.start({ tools: [lookup] }).send("go")).toMatchObject({ status: "answered", text: "It flickers." });
  });

  test("a failure and a result that say the same are not the same outcome", async () => {
    let n = 0;
    const lookup: AgentTool = { ...tool("lookup"), run: async () => ({ text: "no lamp", ...(++n === 2 ? { error: true } : {}) }) };
    const r = rig([same, same, same, "No lamp."]);
    expect(await r.start({ tools: [lookup] }).send("go")).toMatchObject({ status: "answered", text: "No lamp." });
  });

  test("a tool whose state changes between calls is never a loop, whatever it answers", async () => {
    let state = 0;
    const watchTool: AgentTool = { ...tool("watch"), state: () => state, run: async () => (state++, { text: "still waiting" }) };
    const again = { toolCalls: [call("watch", { q: "mill" })] };
    const r = rig([again, again, again, again, again, again, "It came."]);
    expect(await r.start({ tools: [watchTool] }).send("go")).toMatchObject({ status: "answered", text: "It came." });
    // The same tool once its state stands still: the same words on the same state are a loop.
    const still: AgentTool = { ...tool("watch"), state: () => 7, run: async () => ({ text: "still waiting" }) };
    const s = rig([again, again, again, "never reached"]);
    expect(await s.start({ tools: [still] }).send("go")).toMatchObject({ status: "stopped", code: "loop" });
  });

  /** The job tools over one job whose state a test sets; every read of it gives the same words while its state is the same. */
  function jobRig(script: Script) {
    let state: JobState = "running";
    let reads = 0;
    const jobs: JobTools = {
      offersAs: false,
      agents: () => [],
      list: async () => (reads++, [job(state)]),
      read: async (id) => (reads++, id === "job-1" ? { job: job(state), task: "Find who holds the key.", report: state === "done" ? "Okoro holds the key." : null } : null),
      cancel: async () => null,
    };
    const r = rig(script);
    const env = envOf({ jobs, settings: r.settings, texts: r.texts });
    const tools = [built(JOB_TOOLS, TOOL.jobRead, env), built(JOB_TOOLS, TOOL.jobList, env)];
    return { ...r, tools, reads: () => reads, end: (as: JobState = "done") => (state = as) };
  }

  const poll = { toolCalls: [call(TOOL.jobRead, { job: "job-1" })] };

  test("job_read polled while its job hasn't ended is never a loop, though every poll reads the same words", async () => {
    const r = jobRig((_request, i) => (i < 8 ? poll : "Still running."));
    const agent = r.start({ tools: r.tools });
    expect(await agent.send("go")).toMatchObject({ status: "answered", text: "Still running." });
    expect(r.reads()).toBe(8);
    // The polls did read the same words: it is the job's standing, not the text, that told them apart.
    expect(new Set(r.host.calls.slice(1).map((request) => resultsSent(request)[0]?.text)).size).toBe(1);
  });

  test("once the job has ended and the answer stays the same, asking again and again is a loop", async () => {
    // Four polls find it running; it ends before the fifth; the fifth, sixth and seventh read the same report.
    const r = jobRig((_request, i) => {
      if (i === 4) r.end();
      return i < 12 ? poll : "never reached";
    });
    const reply = await r.start({ tools: r.tools }).send("go");
    expect(reply).toMatchObject({ status: "stopped", code: "loop", reason: r.texts.render(TEXT.stop.loop, { tool: TOOL.jobRead, times: "3 times" }) });
    expect(r.reads()).toBe(7);
    expect(resultsSent(r.host.calls[5])[0]?.text).toContain("Okoro holds the key.");
  });

  test("a job that ended between two polls is read: the poll after it ended isn't taken for the ones before", async () => {
    // What the reviewer saw stopped: two polls of a running job, the job ends, the third poll never ran.
    const r = jobRig((_request, i) => {
      if (i === 2) r.end();
      return i < 3 ? poll : "Okoro holds the key.";
    });
    expect(await r.start({ tools: r.tools }).send("go")).toMatchObject({ status: "answered", text: "Okoro holds the key." });
    expect(resultsSent(r.host.calls[3])[0]?.text).toContain("Okoro holds the key.");
  });

  test("job_list does the same: no loop while it shows a job that hasn't ended, one once all it shows have", async () => {
    const list = { toolCalls: [call(TOOL.jobList, {})] };
    const running = jobRig((_request, i) => (i < 6 ? list : "Still running."));
    expect(await running.start({ tools: running.tools }).send("go")).toMatchObject({ status: "answered", text: "Still running." });
    const ended = jobRig(() => list);
    ended.end("failed");
    expect(await ended.start({ tools: ended.tools }).send("go")).toMatchObject({ status: "stopped", code: "loop" });
    expect(ended.reads()).toBe(3);
  });
});

describe("one answer, one call that ends the send (L1)", () => {
  const ending = (runs: JsonObject[]): AgentTool => ({
    name: "finish",
    description: "Ends the work with what it is given.",
    parameters: { type: "object", properties: { brief: { type: "string" } } },
    ends: true,
    run: async (args) => {
      runs.push(args);
      return { text: `written from: ${String(args.brief)}`, end: true };
    },
  });

  test("of two calls in one answer the first runs and ends the send with its text; the second is never run and reads why", async () => {
    const runs: JsonObject[] = [];
    const r = rig([{ toolCalls: [call("finish", { brief: "Okoro holds the key." }, "c1"), call("finish", { brief: "Nobody holds it." }, "c2")] }, "never"]);
    const agent = r.start({ tools: [ending(runs)] });
    expect(await agent.send("go")).toMatchObject({ status: "answered", text: "written from: Okoro holds the key." });
    expect(runs).toEqual([{ brief: "Okoro holds the key." }]);
    expect(resultOf(agent, "c1")).toMatchObject({ text: "written from: Okoro holds the key.", error: false });
    expect(resultOf(agent, "c2")).toMatchObject({ text: r.texts.render(TEXT.runtime.oneEnding, { name: "finish", first: "finish" }), error: true });
    expect(resultOf(agent, "c2")?.text).toBe("Not run: one answer may make one call that ends your work, and this answer's earlier call of finish is that one. It stands, with what it was given. If its result says it failed, call finish again in your next answer.");
    expect(r.host.calls).toHaveLength(1);
  });

  test("with one call at a time and with all at once alike, and whatever other calls stand between the two", async () => {
    for (const concurrency of [1, 4]) {
      const runs: JsonObject[] = [];
      const lookup = tool("lookup");
      const r = rig([{ toolCalls: [call("finish", { brief: "first" }, "c1"), call("lookup", { q: "lamp" }, "c2"), call("finish", { brief: "second" }, "c3"), call("finish", { brief: "third" }, "c4")] }, "never"]);
      const agent = r.start({ tools: [ending(runs), lookup], budget: { ...r.spec().budget, concurrency } });
      expect(await agent.send("go")).toMatchObject({ status: "answered", text: "written from: first" });
      expect(runs).toEqual([{ brief: "first" }]);
      expect(lookup.runs).toHaveLength(1);
      for (const id of ["c3", "c4"]) expect(resultOf(agent, id)).toMatchObject({ error: true, text: r.texts.render(TEXT.runtime.oneEnding, { name: "finish", first: "finish" }) });
    }
  });

  test("a first call that failed leaves the next answer free to call again", async () => {
    let n = 0;
    const runs: JsonObject[] = [];
    const flaky: AgentTool = { ...ending(runs), run: async (args) => (runs.push(args), ++n === 1 ? { text: "the writer failed", error: true } : { text: "written", end: true }) };
    const r = rig([{ toolCalls: [call("finish", { brief: "first" }, "c1"), call("finish", { brief: "second" }, "c2")] }, { toolCalls: [call("finish", { brief: "again" }, "c3")] }]);
    expect(await r.start({ tools: [flaky] }).send("go")).toMatchObject({ status: "answered", text: "written" });
    expect(runs).toEqual([{ brief: "first" }, { brief: "again" }]);
  });

  test("a tool without the mark is run each time, as before", async () => {
    const runs: JsonObject[] = [];
    const { ends: _ends, ...plain } = ending(runs);
    const r = rig([{ toolCalls: [call("finish", { brief: "first" }, "c1"), call("finish", { brief: "second" }, "c2")] }, "never"]);
    await r.start({ tools: [plain] }).send("go");
    expect(runs).toHaveLength(2);
  });

  test("write_reply as built carries the mark", () => {
    const made = built(REPLY_TOOLS, TOOL.writeReply, envOf({ writeReply: async (brief) => ({ text: `written from: ${brief}`, end: true }) }));
    expect(made.ends).toBe(true);
  });
});
