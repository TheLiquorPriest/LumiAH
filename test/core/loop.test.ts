// The agent loop on a scripted model (DESIGN §4.1): tool round trips, the fallback from native tools
// to text, calls a model writes as text, the loop detector, budgets, clipping with scratch_read,
// reasoning carried across tool calls, cache breakpoints, throttles, a connection's calls at once,
// a call that fails in passing made again, a streaming answer's pieces for the live view, and a
// tool that ends the send.
//
// And what the user and the run do to an agent at work: the least room a call is made with, its
// rounds told up front and as they run out, a stop that reaches a round's tools, a note from the
// user (§18), a hold on the run (§18), a cap from outside the run, a conversation carried on by
// another agent, a tool's changed files on the record, and a call held for the user's word (§17).

import { describe, expect, test } from "bun:test";
import { type AgentDeps, type AgentSpec, type AgentTrace, AgentTurn, type ApprovalGate, startAgent } from "../../src/core/loop";
import type { AgentStarted, ApprovalAnswer, ApprovalAsk, FileChange, JsonObject, ModelMessage, ModelRequest, TranscriptEntry } from "../../src/core/ports";
import { AgentAccounts, AgentStop } from "../../src/core/provider";
import { defaultSettings, type Settings } from "../../src/core/settings";
import { SCRATCH_READ, TEXT, Texts } from "../../src/core/texts";
import type { AgentTool } from "../../src/core/tools";
import { call, idle, MAIN, MemoryHost, type Script, settle, until, WRITER } from "./support/host";

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

function rig(script: Script, change: (s: Settings) => void = () => undefined, options: { texts?: Record<string, string>; turn?: (s: Settings, host: MemoryHost) => AgentTurn; approval?: ApprovalGate } = {}) {
  const host = new MemoryHost();
  host.script = script;
  const settings = defaultSettings();
  change(settings);
  const deps: AgentDeps = { host, settings, texts: new Texts(options.texts ?? {}), accounts: new AgentAccounts(host), turn: options.turn?.(settings, host) ?? null, ...(options.approval ? { approval: options.approval } : {}) };
  const budget = { ...defaultSettings().agents.main!.budget };
  const spec = (over: Partial<AgentSpec> = {}): AgentSpec => ({ role: "main", connectionId: MAIN, model: null, effort: "medium", system: "You look things up.", prefix: [], tools: [], budget, ...over });
  return { host, deps, settings, spec, start: (over: Partial<AgentSpec> = {}) => startAgent(spec(over), deps) };
}

const lastMessage = (request: ModelRequest | undefined) => request?.messages.at(-1);

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

/** Whether a send has ended, without waiting for it. */
function watch<T>(sending: Promise<T>): { done: boolean } {
  const state = { done: false };
  void sending.then(() => (state.done = true));
  return state;
}

describe("tool round trips", () => {
  test("a call goes back as the model's tool_use and its result as a tool_result, and the model answers from it", async () => {
    const lookup = tool("lookup", (a) => `found ${String(a.q)}`);
    const r = rig([{ content: "Let me look.", toolCalls: [call("lookup", { q: "Ilse" }, "toolu_1")] }, "Ilse is at the mill."]);
    const agent = r.start({ tools: [lookup] });
    expect(await agent.send("Where is Ilse?")).toMatchObject({ status: "answered", text: "Ilse is at the mill." });
    expect(lookup.runs).toEqual([{ q: "Ilse" }]);
    expect(r.host.calls[0]?.tools?.map((t) => t.name)).toEqual(["lookup", SCRATCH_READ]);
    const sent = r.host.calls[1]?.messages ?? [];
    expect(sent.at(-2)?.parts).toEqual([
      { type: "text", text: "Let me look." },
      { type: "tool_use", id: "toolu_1", name: "lookup", input: { q: "Ilse" } },
    ]);
    expect(sent.at(-1)?.parts).toEqual([{ type: "tool_result", toolUseId: "toolu_1", content: "found Ilse" }]);
    expect(agent.usage()).toMatchObject({ calls: 2, toolTurns: 1 });
  });

  test("a round's calls run at once up to the budget, and their results go back in the calls' order", async () => {
    let running = 0;
    let most = 0;
    const slow = tool("slow", async (a) => {
      most = Math.max(most, ++running);
      await settle();
      running--;
      return `did ${String(a.q)}`;
    });
    const r = rig([{ toolCalls: [call("slow", { q: "a" }, "c1"), call("slow", { q: "b" }, "c2"), call("slow", { q: "c" }, "c3")] }, "done"]);
    const agent = r.start({ tools: [slow], budget: { ...r.spec().budget, concurrency: 2 } });
    await agent.send("go");
    expect(most).toBe(2);
    expect(lastMessage(r.host.calls[1])?.parts?.map((p) => (p.type === "tool_result" ? p.content : ""))).toEqual(["did a", "did b", "did c"]);
  });

  test("calls past Tool calls per answer aren't run, and the model is told to call them again", async () => {
    const lookup = tool("lookup");
    const r = rig([{ toolCalls: [call("lookup", { q: "a" }), call("lookup", { q: "b" })] }, "done"]);
    await r.start({ tools: [lookup], budget: { ...r.spec().budget, callTools: 1 } }).send("go");
    expect(lookup.runs).toEqual([{ q: "a" }]);
    const second = lastMessage(r.host.calls[1])?.parts?.[1];
    expect(second).toMatchObject({ type: "tool_result", isError: true });
    expect(second?.type === "tool_result" ? second.content : "").toContain("at most 1 tool");
  });

  test("a tool that isn't there and a tool that throws come back as failures the model can read", async () => {
    const broken: AgentTool = { name: "broken", description: "Breaks.", parameters: { type: "object", properties: {} }, run: async () => Promise.reject(new Error("the shelf is empty")) };
    const r = rig([{ toolCalls: [call("nowhere", {}, "c1"), call("broken", {}, "c2")] }, "done"]);
    await r.start({ tools: [broken] }).send("go");
    const results = lastMessage(r.host.calls[1])?.parts ?? [];
    expect(results[0]).toMatchObject({ type: "tool_result", isError: true });
    expect(results[0]?.type === "tool_result" ? results[0].content : "").toBe("There's no tool nowhere. The tools are: broken, scratch_read. Call one of those.");
    expect(results[1]?.type === "tool_result" ? results[1].content : "").toBe("broken failed: the shelf is empty");
  });

  test("a tool whose outcome ends the send answers with its text, and no further call is made", async () => {
    const finish: AgentTool = { name: "finish", description: "Ends.", parameters: { type: "object", properties: {} }, run: async () => ({ text: "the final word", end: true }) };
    const r = rig([{ toolCalls: [call("finish")] }]);
    expect(await r.start({ tools: [finish] }).send("go")).toMatchObject({ status: "answered", text: "the final word" });
    expect(r.host.calls).toHaveLength(1);
  });

  test("run works the conversation the agent took up, with no message of its own, and sends its sampling parameters", async () => {
    const r = rig(["A reply."]);
    const agent = r.start({ system: "", history: [{ role: "system", content: "Be brief." }, { role: "user", content: "Hello?" }], params: { temperature: 0.4, top_p: 0.9 } });
    expect(await agent.run()).toMatchObject({ status: "answered", text: "A reply." });
    expect(r.host.calls[0]?.messages).toEqual([{ role: "system", content: "Be brief." }, { role: "user", content: "Hello?" }]);
    expect(r.host.calls[0]?.params).toEqual({ temperature: 0.4, top_p: 0.9 });
    expect(agent.transcript().entries.map((e) => e.kind)).toEqual(["answer"]);
  });
});

describe("native tools, and the fallback to text", () => {
  test("a connection that refuses tools is asked again with them as text, and the model's written calls run", async () => {
    const lookup = tool("lookup", () => "the tide table");
    const r = rig([{ error: "400: this model does not support tools" }, 'I need the table.\n<tool_call>{"name": "lookup", "arguments": {"q": "tide"}}</tool_call>', "High water at six."]);
    const agent = r.start({ tools: [lookup] });
    expect(await agent.send("When is high water?")).toMatchObject({ status: "answered", text: "High water at six." });
    expect(lookup.runs).toEqual([{ q: "tide" }]);
    // The second call offers no native tools: they are in the system text instead.
    expect(r.host.calls[0]?.tools).toBeDefined();
    expect(r.host.calls[1]?.tools).toBeUndefined();
    expect(r.host.calls[1]?.messages[0]?.content).toContain("<tool_call>");
    expect(r.host.calls[1]?.messages[0]?.content).toContain("lookup: The lookup tool.");
    // The written call's result goes back as a plain user message.
    const back = lastMessage(r.host.calls[2]);
    expect(back?.parts).toBeUndefined();
    expect(back?.content).toContain('<tool_result name="lookup">\nthe tide table\n</tool_result>');
    expect(agent.transcript().entries.map((e) => e.kind)).toEqual(["message", "tools_refused", "answer", "result", "answer"]);
    expect(agent.transcript().entries[2]).toMatchObject({ kind: "answer", tools: "text", written: true, text: "I need the table." });
  });

  test("a connection seen refusing tools is offered them as text from then on", async () => {
    const r = rig([{ error: "No endpoints found that support tool use" }, "first", "second"]);
    await r.start({ tools: [tool("lookup")] }).send("go");
    await r.start({ tools: [tool("lookup")] }).send("again");
    expect(r.host.calls[2]?.tools).toBeUndefined();
    expect(r.host.calls[2]?.messages[0]?.content).toContain("lookup: The lookup tool.");
  });

  test("a failure that says nothing about tools is the call's own: no second try", async () => {
    const r = rig([{ error: "401: the key was refused" }]);
    const reply = await r.start({ tools: [tool("lookup")] }).send("go");
    expect(reply).toMatchObject({ status: "failed", code: "failed", reason: "401: the key was refused" });
    expect(r.host.calls).toHaveLength(1);
  });

  test("a call a model writes as text on a connection that takes tools is recovered and run", async () => {
    const lookup = tool("lookup", () => "three boats");
    const r = rig(['```json\n{"name": "lookup", "arguments": {"q": "boats"}}\n```', "Three boats."]);
    expect(await r.start({ tools: [lookup] }).send("How many boats?")).toMatchObject({ status: "answered", text: "Three boats." });
    expect(lookup.runs).toEqual([{ q: "boats" }]);
  });
});

describe("the loop detector", () => {
  test("the same call with the same arguments and the same result, a setting's number of times running, stops the agent", async () => {
    const lookup = tool("lookup");
    const again = { toolCalls: [call("lookup", { q: "same" })] };
    const r = rig([again, again, again, "never reached"]);
    const reply = await r.start({ tools: [lookup] }).send("go");
    expect(reply).toMatchObject({ status: "stopped", code: "loop", reason: "the agent called lookup with the same arguments 3 times in a row and got the same result each time (Loop detector)" });
    // The detector reads each call's result, so the third is run before the agent stops; no fourth call of the model is made.
    expect(lookup.runs).toHaveLength(3);
    expect(r.host.calls).toHaveLength(3);
  });

  test("other arguments, or a tool whose state changed, make it a new call", async () => {
    let state = 0;
    const edit: AgentTool = { ...tool("edit"), state: () => state, run: async () => ({ text: `line ${++state}` }) };
    const again = { toolCalls: [call("edit", { line: 1 })] };
    const r = rig([again, again, again, again, "done"]);
    expect(await r.start({ tools: [edit] }).send("go")).toMatchObject({ status: "answered" });
    const s = rig([{ toolCalls: [call("lookup", { q: "a" })] }, { toolCalls: [call("lookup", { q: "b" })] }, { toolCalls: [call("lookup", { q: "a" })] }, "done"]);
    expect(await s.start({ tools: [tool("lookup")] }).send("go")).toMatchObject({ status: "answered" });
  });

  test("the number of repeats is a setting", async () => {
    const again = { toolCalls: [call("lookup", { q: "same" })] };
    const r = rig([again, again, "never reached"], (s) => (s.loop.repeats = 2));
    expect(await r.start({ tools: [tool("lookup")] }).send("go")).toMatchObject({ status: "stopped", code: "loop" });
    expect(r.host.calls).toHaveLength(2);
  });
});

describe("budgets", () => {
  const looping = (n: number): Script => (_request, i) => (i < n ? { toolCalls: [call("lookup", { q: `q${i}` })] } : "done");

  test("Tool rounds per agent stops an agent that keeps calling tools", async () => {
    const r = rig(looping(10));
    const reply = await r.start({ tools: [tool("lookup")], budget: { ...r.spec().budget, toolTurns: 2 } }).send("go");
    expect(reply).toMatchObject({ status: "refused", code: "tool_turns", reason: "the agent has had its 2 rounds of tool calls (Tool rounds per agent)" });
    expect(r.host.calls).toHaveLength(3);
    expect(reply.usage.toolTurns).toBe(2);
  });

  test("Prompt per call refuses a call before it is sent", async () => {
    const r = rig(["never"]);
    const reply = await r.start({ budget: { ...r.spec().budget, callTokensIn: 5 } }).send("A message long enough to pass five tokens.");
    expect(reply).toMatchObject({ status: "refused", code: "call_tokens_in" });
    expect(r.host.calls).toHaveLength(0);
  });

  test("Answer tokens per agent caps each call's max_tokens at what is left, then stops the agent", async () => {
    const usage = { prompt_tokens: 10, completion_tokens: 60 };
    // The floor is set low, so the last 60 tokens are still room for a call: this is about the cap and the stop.
    const r = rig([{ toolCalls: [call("lookup")], usage }, { toolCalls: [call("lookup", { q: "b" })], usage }, "never"], (s) => (s.loop.answerFloor = 1));
    const reply = await r.start({ tools: [tool("lookup")], budget: { ...r.spec().budget, callTokensOut: 100, tokensOut: 120 } }).send("go");
    expect(r.host.calls.map((c) => c.maxTokens)).toEqual([100, 60]);
    expect(reply).toMatchObject({ status: "refused", code: "tokens_out", reason: "the agent has written its 120 tokens (Answer tokens per agent)" });
  });

  test("the turn's budget counts every agent of the turn together", async () => {
    const r = rig(looping(10), undefined, { turn: (s, host) => new AgentTurn({ ...s.turn, toolTurns: 3 }, host.clock.now()) });
    const first = await r.start({ tools: [tool("lookup")], budget: { ...r.spec().budget, toolTurns: 2 } }).send("go");
    expect(first.code).toBe("tool_turns");
    const second = await r.start({ tools: [tool("lookup")] }).send("go");
    expect(second).toMatchObject({ status: "refused", code: "turn_tool_turns" });
    expect(r.deps.turn?.usage.toolTurns).toBe(3);
  });

  /** Every call reads 9,000 of its 10,000 prompt tokens again from the provider's cache, and calls a tool. */
  const rereading: Script = (_request, i) => ({ toolCalls: [call("lookup", { q: `q${i}` })], usage: { prompt_tokens: 10_000, completion_tokens: 10, provider_raw: { prompt_tokens_details: { cached_tokens: 9000 } } } });

  test("Prompt tokens per agent counts a cached re-read at What a cached re-read counts as, says so when it stops the agent, and counts it in full once that is 1", async () => {
    // At a tenth, each call counts as 1,000 fresh and 900 for the 9,000 read again: three fit in 5,000, a fourth doesn't.
    const r = rig(rereading);
    expect(r.settings.spend.cachedWeight).toBe(0.1);
    const reply = await r.start({ tools: [tool("lookup")], budget: { ...r.spec().budget, tokensIn: 5000 } }).send("go");
    expect(r.host.calls).toHaveLength(3);
    expect(reply).toMatchObject({ status: "refused", code: "tokens_in" });
    // The three calls count as 5,700; the call refused is counted with them at its prompt's estimate, in full.
    expect(reply.reason).toMatch(/^the call would take the agent's prompt tokens past Prompt tokens per agent: counted as (5[7-9]|6\d)\d\d of the 5000 allowed \(a cached re-read counts as 0\.1 of a token\)$/);
    // What it truly sent is on its usage, whatever the limit counted.
    expect(reply.usage).toMatchObject({ in: 30_000, cachedIn: 27_000 });
    // In full, the first call alone is past the limit.
    const full = rig(rereading, (s) => (s.spend.cachedWeight = 1));
    const stopped = await full.start({ tools: [tool("lookup")], budget: { ...full.spec().budget, tokensIn: 5000 } }).send("go");
    expect(full.host.calls).toHaveLength(1);
    expect(stopped.reason).toMatch(/counted as 10\d\d\d of the 5000 allowed \(a cached re-read counts as 1 of a token\)$/);
  });

  test("Prompt tokens per turn counts a cached re-read the same way, over every agent of the turn", async () => {
    const r = rig(rereading, undefined, { turn: (s, host) => new AgentTurn({ ...s.turn, tokensIn: 5000 }, host.clock.now()) });
    // The first agent makes two calls (3,800 as counted) and stops at its own rounds; the second makes one more, and the turn's limit stops its next.
    const first = await r.start({ tools: [tool("lookup")], budget: { ...r.spec().budget, toolTurns: 1 } }).send("go");
    expect(first.code).toBe("tool_turns");
    const second = await r.start({ tools: [tool("lookup")] }).send("go");
    expect(r.host.calls).toHaveLength(3);
    expect(second).toMatchObject({ status: "refused", code: "turn_tokens_in" });
    expect(second.reason).toMatch(/^the call would take the turn's prompt tokens past Prompt tokens per turn: counted as (5[7-9]|6\d)\d\d of the 5000 allowed \(a cached re-read counts as 0\.1 of a token\)$/);
    expect(r.deps.turn?.usage).toMatchObject({ in: 30_000, cachedIn: 27_000 });
  });

  test("Time per call gives a slow call up, and Time per agent stops the agent before its next call", async () => {
    const r = rig([{ hang: true }]);
    const sending = r.start({ budget: { ...r.spec().budget, callMs: 1000 } }).send("go");
    await until(() => r.host.calls.length === 1);
    r.host.clock.advance(1500);
    expect(await sending).toMatchObject({ status: "refused", code: "call_time", reason: "the call took longer than Time per call" });

    const s = rig((_request, i) => {
      s.host.clock.advance(4000);
      return i === 0 ? { toolCalls: [call("lookup")] } : "never";
    });
    const reply = await s.start({ tools: [tool("lookup")], budget: { ...s.spec().budget, wallMs: 3000 } }).send("go");
    expect(reply).toMatchObject({ status: "refused", code: "wall_time" });
    expect(s.host.calls).toHaveLength(1);
  });

  test("Revisions bounds the messages an agent takes after its first answer", async () => {
    const r = rig(["one", "two", "three"]);
    const agent = r.start({ budget: { ...r.spec().budget, revisions: 1 } });
    expect((await agent.send("first")).text).toBe("one");
    expect((await agent.send("again")).text).toBe("two");
    expect(await agent.send("and again")).toMatchObject({ status: "refused", code: "revisions" });
  });

  test("cancel ends a call under way", async () => {
    const r = rig([{ hang: true }]);
    const agent = r.start();
    const sending = agent.send("go");
    await until(() => r.host.calls.length === 1);
    agent.cancel();
    expect(await sending).toMatchObject({ status: "cancelled", code: "cancelled" });
  });

  test("a connection that isn't there runs on the default; with no default either, the agent stops before any call, saying what to do", async () => {
    const r = rig(["done", "never"]);
    expect(await r.start({ connectionId: "conn-gone" }).send("go")).toMatchObject({ status: "answered", text: "done" });
    // The call named the default it ran on.
    expect(r.host.calls.map((c) => c.connectionId)).toEqual([MAIN]);
    r.host.defaultConnection = null;
    expect(await r.start({ connectionId: "conn-gone" }).send("go")).toMatchObject({ status: "refused", code: "connection" });
    expect(r.host.calls).toHaveLength(1);
  });

  test("a connection that isn't there runs on the default with the default's own model, not the one its settings chose for the gone connection, and its start says so", async () => {
    const started: AgentStarted[] = [];
    const trace: AgentTrace = { start: (agent) => void started.push(agent), entry: () => undefined, usage: () => undefined, idle: () => undefined, prompt: async () => undefined, delta: () => undefined };
    const r = rig(["on the default", "on its own"], undefined, { turn: (s, host) => new AgentTurn(s.turn, host.clock.now(), trace) });
    await r.start({ connectionId: "conn-gone", model: "model-of-the-gone" }).send("go");
    // A connection the runtime has keeps the model its settings chose.
    await r.start({ connectionId: WRITER, model: "model-chosen" }).send("go");
    // Null: the connection's own model runs.
    expect(r.host.calls.map((c) => [c.connectionId, c.model])).toEqual([
      [MAIN, null],
      [WRITER, "model-chosen"],
    ]);
    expect(started.map((s) => [s.connectionId, s.model])).toEqual([
      [MAIN, "model-main"],
      [WRITER, "model-chosen"],
    ]);
  });
});

describe("clipping and scratch_read", () => {
  test("a long result reaches the model clipped, and scratch_read gives the rest", async () => {
    const long = `${"a".repeat(5000)}MIDDLE${"b".repeat(4000)}END`;
    const lookup = tool("lookup", () => long);
    const r = rig([{ toolCalls: [call("lookup", {}, "c1")] }, { toolCalls: [call(SCRATCH_READ, { handle: "s1", offset: 6000 }, "c2")] }, { toolCalls: [call(SCRATCH_READ, { handle: "s9" }, "c3")] }, "done"], (s) => (s.loop.clipChars = 6000));
    const agent = r.start({ tools: [lookup] });
    await agent.send("go");
    const clipped = lastMessage(r.host.calls[1])?.parts?.[0];
    const text = clipped?.type === "tool_result" ? clipped.content : "";
    expect(text.startsWith(long.slice(0, 6000))).toBe(true);
    expect(text).toContain(`[Clipped: the first 6000 of ${long.length} characters. The rest is in scratch s1; read it with scratch_read from offset 6000.]`);
    const rest = lastMessage(r.host.calls[2])?.parts?.[0];
    expect(rest?.type === "tool_result" ? rest.content : "").toBe(`[Scratch s1, characters 6000 to ${long.length} of ${long.length}.]\n${long.slice(6000)}`);
    const missing = lastMessage(r.host.calls[3])?.parts?.[0];
    expect(missing).toMatchObject({ isError: true, content: "There's no scratch s9. Scratch holds: s1. Give one of those as the handle." });
    expect(agent.transcript().entries.find((e) => e.kind === "result")).toMatchObject({ scratch: "s1" });
  });

  test("a clip never splits a character", async () => {
    const lookup = tool("lookup", () => `${"a".repeat(299)}😀${"b".repeat(50)}`);
    const r = rig([{ toolCalls: [call("lookup", {}, "c1")] }, "done"], (s) => (s.loop.clipChars = 300));
    await r.start({ tools: [lookup] }).send("go");
    const part = lastMessage(r.host.calls[1])?.parts?.[0];
    expect((part?.type === "tool_result" ? part.content : "").split("\n")[0]).toBe("a".repeat(299));
  });

  test("a tool that names the length it gives whole is given it whole up to there and clipped past it; one that names none is clipped at the setting as before", async () => {
    const reading = { ...tool("reading", (a) => (a.q === "short" ? "r".repeat(15_000) : `${"r".repeat(20_000)}TAIL${"t".repeat(4996)}`)), wholeChars: 20_000 };
    const lookup = tool("lookup", () => "l".repeat(15_000));
    const script: Script = [{ toolCalls: [call("reading", { q: "short" }, "c1")] }, { toolCalls: [call("reading", { q: "long" }, "c2")] }, { toolCalls: [call("lookup", {}, "c3")] }, { toolCalls: [call(SCRATCH_READ, { handle: "s1", offset: 20_000 }, "c4")] }, "done"];
    const r = rig(script, (s) => (s.loop.clipChars = 6000));
    expect(await r.start({ tools: [reading, lookup] }).send("go")).toMatchObject({ status: "answered", text: "done" });
    const content = (at: number): string => {
      const part = lastMessage(r.host.calls[at])?.parts?.[0];
      return part?.type === "tool_result" ? part.content : "";
    };
    expect(content(1)).toBe("r".repeat(15_000));
    expect(content(2)).toBe(`${"r".repeat(20_000)}\n[Clipped: the first 20000 of 25000 characters. The rest is in scratch s1; read it with scratch_read from offset 20000.]`);
    expect(content(3)).toBe(`${"l".repeat(6000)}\n[Clipped: the first 6000 of 15000 characters. The rest is in scratch s2; read it with scratch_read from offset 6000.]`);
    // The rest of the long read comes in one read, as much as its tool gives whole.
    expect(content(4)).toBe(`[Scratch s1, characters 20000 to 25000 of 25000.]\nTAIL${"t".repeat(4996)}`);
    expect(r.host.calls[0]?.tools?.find((t) => t.name === SCRATCH_READ)?.parameters).toMatchObject({ properties: { length: { maximum: 20_000 } } });
  });

  test("a result the room left under Prompt per call can't hold reaches the model cut to it, in plain words, and the next call is still made", async () => {
    const book = "b".repeat(30_000);
    const reading = { ...tool("reading", () => book), wholeChars: 50_000 };
    const r = rig([{ toolCalls: [call("reading", {}, "c1")] }, "done"]);
    const agent = r.start({ tools: [reading], budget: { ...r.spec().budget, callTokensIn: 3000 } });
    expect(await agent.send("go")).toMatchObject({ status: "answered", text: "done" });
    expect(r.host.calls).toHaveLength(2);
    const part = lastMessage(r.host.calls[1])?.parts?.[0];
    const text = part?.type === "tool_result" ? part.content : "";
    const shown = Number(/room for only the first (\d+) of 30000 characters/.exec(text)?.[1] ?? 0);
    // Most of the room is given to the result, and none of it past what the prompt holds.
    expect(shown).toBeGreaterThan(5000);
    expect(text.startsWith(`${book.slice(0, shown)}\n[Cut to fit: your prompt has room for only the first ${shown} of 30000 characters of this result (Prompt per call). The rest is in scratch s1; scratch_read gives it from offset ${shown}`)).toBe(true);
    expect(part).not.toMatchObject({ isError: true });
    expect(agent.transcript().entries.find((e) => e.kind === "result")).toMatchObject({ scratch: "s1", error: false });
    // Without Prompt per call nothing is measured: the same result reaches the model whole.
    const open = rig([{ toolCalls: [call("reading", {}, "c1")] }, "done"]);
    await open.start({ tools: [reading] }).send("go");
    const whole = lastMessage(open.host.calls[1])?.parts?.[0];
    expect(whole?.type === "tool_result" ? whole.content : "").toBe(book);
  });
});

describe("reasoning, caching and throttles", () => {
  test("a model's reasoning goes back with its tool calls on the next call", async () => {
    const r = rig([{ content: "", reasoning: "The mill first.", toolCalls: [call("lookup", {}, "c1")] }, "done"]);
    const agent = r.start({ tools: [tool("lookup")], effort: "high" });
    await agent.send("go");
    expect(r.host.calls[1]?.messages.at(-2)).toMatchObject({ role: "assistant", reasoning: "The mill first." });
    expect(r.host.calls[0]?.effort).toBe("high");
    expect(agent.transcript().entries.find((e) => e.kind === "answer")).toMatchObject({ reasoning: "The mill first." });
  });

  test("with Thinking in tool loops off, a call that offers tools goes with reasoning off", async () => {
    const r = rig(["done", "done"], (s) => (s.loop.thinkingInToolLoops = false));
    await r.start({ tools: [tool("lookup")], effort: "high" }).send("go");
    await r.start({ effort: "high" }).send("go");
    expect(r.host.calls.map((c) => c.effort)).toEqual(["off", "high"]);
  });

  test("an agent's calls name its session and keep its cache as Settings say", async () => {
    const r = rig([{ toolCalls: [call("lookup", {}, "c1")] }, "done"], (s) => (s.cache.retention = "long"));
    await r.start({ tools: [tool("lookup")] }).send("go");
    const [first, second] = r.host.calls;
    expect(first?.session).toMatch(/^agent_/);
    expect(second?.session).toBe(first?.session);
    expect(r.host.calls.map((c) => c.cacheRetention)).toEqual(["long", "long"]);
    // No breakpoint is marked by the core any more: the provider places its own.
    expect(first?.messages[0]).toEqual({ role: "system", content: "You look things up." });
  });

  test("a connection's throttle makes a call wait for its minute, and refuses one bigger than the minute", async () => {
    const r = rig(["one", "two"], (s) => (s.connections.throttles[WRITER] = { requestsPerMinute: 1, tokensPerMinute: null, atOnce: null }));
    r.host.clock.auto = true;
    await r.start({ connectionId: WRITER }).send("go");
    await r.start({ connectionId: WRITER }).send("go");
    expect(r.host.clock.slept).toEqual([60_000]);
    const big = rig(["never"], (s) => (s.connections.throttles[MAIN] = { requestsPerMinute: null, tokensPerMinute: 50, atOnce: null }));
    expect(await big.start().send("go")).toMatchObject({ status: "refused", code: "throttle" });
  });

  test("a connection's calls at once: past the limit a call isn't made until one under way is over", async () => {
    const r = rig([{ hang: true }, { hang: true }, "third"], (s) => (s.connections.atOnce = 2));
    const [first, second, third] = [r.start(), r.start(), r.start()];
    const one = first.send("go");
    const two = second.send("go");
    await until(() => r.host.calls.length === 2);
    const three = third.send("go");
    await idle();
    // Two are under way, which is the limit: the third waits its turn, whatever time passes.
    expect(r.host.calls).toHaveLength(2);
    first.cancel();
    expect(await one).toMatchObject({ status: "cancelled" });
    expect(await three).toMatchObject({ status: "answered", text: "third" });
    expect(r.host.calls).toHaveLength(3);
    second.cancel();
    await two;
  });

  test("a connection's own limit stands in for every connection's, and another connection's calls don't wait on it", async () => {
    const r = rig((request) => (request.connectionId === WRITER ? "the writer's" : { hang: true }), (s) => {
      s.connections.atOnce = 5;
      s.connections.throttles[MAIN] = { requestsPerMinute: null, tokensPerMinute: null, atOnce: 1 };
    });
    const first = r.start();
    const one = first.send("go");
    await until(() => r.host.calls.length === 1);
    const second = r.start();
    const two = second.send("go");
    await idle();
    expect(r.host.calls).toHaveLength(1);
    expect(await r.start({ connectionId: WRITER }).send("go")).toMatchObject({ status: "answered", text: "the writer's" });
    // A call cancelled while it waits leaves the line without ever being made.
    second.cancel();
    expect(await two).toMatchObject({ status: "cancelled" });
    expect(r.host.calls.filter((c) => c.connectionId === MAIN)).toHaveLength(1);
    first.cancel();
    await one;
  });

  test("usage is the provider's where it reports, an estimate where it doesn't, and cost comes from the user's prices", async () => {
    const r = rig([{ content: "done", usage: { prompt_tokens: 1000, completion_tokens: 200, provider_raw: { prompt_tokens_details: { cached_tokens: 400 } } } }, "four"], (s) => (s.prices["scripted"] = { in: 2, cachedIn: 0.5, out: 10 }));
    const agent = r.start();
    await agent.send("go");
    const answer = agent.transcript().entries.find((e) => e.kind === "answer");
    // The call's usage names the price that gave its cost: the one the user set for the model the provider reported.
    expect(answer?.kind === "answer" ? answer.usage : null).toEqual({ in: 1000, cachedIn: 400, out: 200, reasoningOut: 0, estimated: ["reasoningOut", "cost"], cost: (600 * 2 + 400 * 0.5 + 200 * 10) / 1_000_000, pricedAs: "scripted" });
    await agent.send("again");
    expect(agent.usage()).toMatchObject({ calls: 2, estimated: true });
  });
});

describe("a call that fails in passing", () => {
  test("is made again after the wait Settings give, each try on the record with the failure's own words", async () => {
    const r = rig([{ error: "503: overloaded" }, { error: "429: rate limit reached" }, "The table is in."], (s) => (s.loop.retryWaitMs = 1500));
    r.host.clock.auto = true;
    const agent = r.start();
    expect(await agent.send("go")).toMatchObject({ status: "answered", text: "The table is in." });
    expect(r.host.calls).toHaveLength(3);
    expect(r.host.clock.slept).toEqual([1500, 1500]);
    const entries = agent.transcript().entries;
    expect(entries.map((e) => e.kind)).toEqual(["message", "retry", "retry", "answer"]);
    expect(entries[1]).toMatchObject({ kind: "retry", reason: "503: overloaded", attempt: 1, of: 2, waitMs: 1500 });
    expect(entries[2]).toMatchObject({ kind: "retry", reason: "429: rate limit reached", attempt: 2, of: 2, waitMs: 1500 });
    // The same call each time: a try that failed adds nothing to what the model is sent.
    expect(r.host.calls[2]?.messages).toEqual(r.host.calls[0]?.messages ?? []);
    expect(agent.usage().calls).toBe(1);
  });

  test("past Retries the agent fails, with the last failure's words", async () => {
    const r = rig([{ error: "503: overloaded" }, { error: "504: gateway timeout" }, "never reached"], (s) => (s.loop.retries = 1));
    r.host.clock.auto = true;
    const agent = r.start();
    expect(await agent.send("go")).toMatchObject({ status: "failed", code: "failed", reason: "504: gateway timeout" });
    expect(r.host.calls).toHaveLength(2);
    expect(agent.transcript().entries.map((e) => e.kind)).toEqual(["message", "retry", "stop"]);
  });

  test("each call has its own tries: one that answers starts the count afresh", async () => {
    const down = { error: "502: bad gateway" };
    const r = rig([down, down, { toolCalls: [call("lookup", {}, "c1")] }, down, down, "done"]);
    r.host.clock.auto = true;
    expect(await r.start({ tools: [tool("lookup")] }).send("go")).toMatchObject({ status: "answered", text: "done" });
    expect(r.host.calls).toHaveLength(6);
  });

  test("Retries at 0 turns it off, and a failure that won't pass is never made again", async () => {
    const off = rig([{ error: "503: overloaded" }, "never reached"], (s) => (s.loop.retries = 0));
    expect(await off.start().send("go")).toMatchObject({ status: "failed", reason: "503: overloaded" });
    expect(off.host.calls).toHaveLength(1);
    for (const words of ["401: the key was refused", "400: max_tokens 512 is more than this model allows", "429: You exceeded your current quota, please check your plan and billing details"]) {
      const lasting = rig([{ error: words }, "never reached"]);
      expect(await lasting.start().send("go")).toMatchObject({ status: "failed", reason: words });
      expect(lasting.host.calls).toHaveLength(1);
    }
  });

  test("a call one of the user's own limits stopped is never made again", async () => {
    const r = rig([{ hang: true }, "never reached"]);
    const sending = r.start({ budget: { ...r.spec().budget, callMs: 1000 } }).send("go");
    await until(() => r.host.calls.length === 1);
    r.host.clock.advance(1500);
    expect(await sending).toMatchObject({ status: "refused", code: "call_time" });
    await idle();
    expect(r.host.calls).toHaveLength(1);
  });

  test("a cancel ends the wait, and the agent's time still runs through it", async () => {
    const r = rig([{ error: "503: overloaded" }, "never reached"]);
    const agent = r.start();
    const sending = agent.send("go");
    await until(() => r.host.clock.slept.length === 1);
    agent.cancel();
    expect(await sending).toMatchObject({ status: "cancelled", code: "cancelled" });
    expect(r.host.calls).toHaveLength(1);

    const timed = rig([{ error: "503: overloaded" }, "never reached"], (s) => (s.loop.retryWaitMs = 5000));
    const waiting = timed.start({ budget: { ...timed.spec().budget, wallMs: 3000 } }).send("go");
    await until(() => timed.host.clock.slept.includes(5000));
    timed.host.clock.advance(3500);
    expect(await waiting).toMatchObject({ status: "refused", code: "wall_time" });
    expect(timed.host.calls).toHaveLength(1);
  });

  test("once text of the answer was sent on, the call is never made again; before any was, it is", async () => {
    const got: string[] = [];
    const cut = rig([{ deltas: ["The door "], error: "the stream was cut" }, "never reached"]);
    cut.host.clock.auto = true;
    const agent = cut.start({ onDelta: (delta) => void (delta.content !== undefined && got.push(delta.content)) });
    expect(await agent.send("go")).toMatchObject({ status: "failed", reason: "the stream was cut" });
    expect(got).toEqual(["The door "]);
    expect(cut.host.calls).toHaveLength(1);
    expect(agent.transcript().entries.map((e) => e.kind)).toEqual(["message", "stop"]);

    const early = rig([{ deltas: [], error: "the stream was cut" }, "The door opens."]);
    early.host.clock.auto = true;
    expect(await early.start({ onDelta: () => undefined }).send("go")).toMatchObject({ status: "answered", text: "The door opens." });
    expect(early.host.calls).toHaveLength(2);
  });
});

describe("a streaming answer, for the live view", () => {
  /** A turn's trace that keeps what it hears, in order: each entry's kind, and each piece as `call:reasoning|text`. */
  function tracer(): { heard: string[]; trace: AgentTrace } {
    const heard: string[] = [];
    const trace: AgentTrace = {
      start: () => undefined,
      entry: (_agentId, entry) => void heard.push(entry.kind),
      usage: () => undefined,
      idle: () => undefined,
      prompt: async () => undefined,
      delta: (_agentId, n, piece) => void heard.push(`${n}:${piece.reasoning ?? ""}|${piece.text ?? ""}`),
    };
    return { heard, trace };
  }

  test("each call's pieces carry its count among the agent's answers, and all of them come before its entry", async () => {
    const { heard, trace } = tracer();
    const r = rig([{ content: "Let me look.", reasoning: "The table first.", toolCalls: [call("lookup", {}, "c1")] }, "High water at six."], undefined, { turn: (s, host) => new AgentTurn(s.turn, host.clock.now(), trace) });
    await r.start({ tools: [tool("lookup")] }).send("go");
    // The clock stands still here, so each call's first piece goes at once and the rest when the call ends.
    expect(heard).toEqual(["message", "1:The table first.|", "1:|Let me look.", "answer", "result", "2:|High ", "2:|water at six.", "answer"]);
  });

  test("a call that failed and is made again keeps its count: what it had streamed goes before the retry's entry", async () => {
    const { heard, trace } = tracer();
    const r = rig([{ deltas: ["The door "], error: "the stream was cut" }, "The door opens."], undefined, { turn: (s, host) => new AgentTurn(s.turn, host.clock.now(), trace) });
    r.host.clock.auto = true;
    expect(await r.start().send("go")).toMatchObject({ status: "answered", text: "The door opens." });
    expect(heard).toEqual(["message", "1:|The door ", "retry", "1:|The ", "1:|door opens.", "answer"]);
  });

  test("outside a turn, and with the setting at 0, nothing is sent and nothing is asked of the call", async () => {
    const alone = rig(["done"]);
    expect(await alone.start().send("go")).toMatchObject({ status: "answered" });
    const { heard, trace } = tracer();
    const off = rig(["done"], (s) => ((s.trace.deltaMs = 0), (s.loop.stream = false)), { turn: (s, host) => new AgentTurn(s.turn, host.clock.now(), trace) });
    await off.start().send("go");
    expect(heard).toEqual(["message", "answer"]);
    expect(off.host.calls[0]?.stream).toBeUndefined();
  });
});

describe("least answer room", () => {
  const wrote = (out: number) => ({ prompt_tokens: 10, completion_tokens: out });
  const ROOM = "only 100 tokens are left of its answer tokens, fewer than Least answer room (256): an answer written in them would be cut";

  test("with the agent's answer tokens nearly spent the next call isn't made: it stops, and says how few are left", async () => {
    const r = rig([{ toolCalls: [call("lookup")], usage: wrote(900) }, "never"]);
    const reply = await r.start({ tools: [tool("lookup")], budget: { ...r.spec().budget, tokensOut: 1000 } }).send("go");
    expect(reply).toMatchObject({ status: "refused", code: "tokens_out", reason: ROOM });
    expect(r.host.calls).toHaveLength(1);
  });

  test("the run's answer tokens nearly spent stop it the same way, by the run's code", async () => {
    const r = rig([{ toolCalls: [call("lookup")], usage: wrote(900) }, "never"], undefined, { turn: (s, host) => new AgentTurn({ ...s.turn, tokensOut: 1000 }, host.clock.now()) });
    const reply = await r.start({ tools: [tool("lookup")] }).send("go");
    expect(reply).toMatchObject({ status: "refused", code: "turn_tokens_out", reason: ROOM });
    expect(r.host.calls).toHaveLength(1);
  });

  test("the floor is a setting, and exactly as much as it is room enough", async () => {
    const enough = rig([{ toolCalls: [call("lookup")], usage: wrote(900) }, "done"], (s) => (s.loop.answerFloor = 100));
    expect(await enough.start({ tools: [tool("lookup")], budget: { ...enough.spec().budget, tokensOut: 1000 } }).send("go")).toMatchObject({ status: "answered", text: "done" });
    expect(enough.host.calls.map((c) => c.maxTokens)).toEqual([1000, 100]);
    const short = rig([{ toolCalls: [call("lookup")], usage: wrote(900) }, "never"], (s) => (s.loop.answerFloor = 101));
    expect(await short.start({ tools: [tool("lookup")], budget: { ...short.spec().budget, tokensOut: 1000 } }).send("go")).toMatchObject({ status: "refused", code: "tokens_out" });
    expect(short.host.calls).toHaveLength(1);
  });

  test("a call's own cap below the floor stands in for it: an agent that may never write that much at once isn't stopped for it", async () => {
    const r = rig([{ toolCalls: [call("lookup", { q: "a" })], usage: wrote(100) }, { toolCalls: [call("lookup", { q: "b" })], usage: wrote(100) }, "never"]);
    const reply = await r.start({ tools: [tool("lookup")], budget: { ...r.spec().budget, callTokensOut: 100, tokensOut: 250 } }).send("go");
    // 150 tokens were left for the second call: fewer than Least answer room, and more than a call of this agent's may write anyway. 50 are too few even for that.
    expect(r.host.calls.map((c) => c.maxTokens)).toEqual([100, 100]);
    expect(reply).toMatchObject({ status: "refused", code: "tokens_out" });
    expect(reply.reason).toStartWith("only 50 tokens are left of its answer tokens, fewer than Least answer room");
  });
});

describe("its rounds, told up front", () => {
  const rounds = (n: string) => `[You have ${n} of tool calls for this. A round is one answer of yours that calls tools, however many. An answer that calls a tool after your last round isn't run and your work stops there, so keep a round for what must come last.]`;

  test("an agent with tools and a limit on its rounds has its first message end with how many it has, and no later message", async () => {
    const r = rig(["one", "two"]);
    const agent = r.start({ tools: [tool("lookup")] });
    await agent.send("Where is Ilse?");
    await agent.send("And Brann?");
    expect(lastMessage(r.host.calls[0])).toEqual({ role: "user", content: `Where is Ilse?\n\n${rounds("24 rounds")}` });
    expect(lastMessage(r.host.calls[1])).toEqual({ role: "user", content: "And Brann?" });
    // The transcript holds each message as it was sent.
    expect(agent.transcript().entries.flatMap((e) => (e.kind === "message" ? [e.text] : []))).toEqual([`Where is Ilse?\n\n${rounds("24 rounds")}`, "And Brann?"]);
  });

  test("an agent without tools, or without a limit on its rounds, has nothing added", async () => {
    const r = rig(["one", "two"]);
    await r.start().send("Where is Ilse?");
    await r.start({ tools: [tool("lookup")], budget: { ...r.spec().budget, toolTurns: null } }).send("Where is Brann?");
    expect(r.host.calls.map((c) => lastMessage(c)?.content)).toEqual(["Where is Ilse?", "Where is Brann?"]);
  });

  test("the rounds it is told are those it has: what is left of its run's where that is fewer, in the user's own words", async () => {
    const r = rig([{ toolCalls: [call("lookup", { q: "a" })] }, { toolCalls: [call("lookup", { q: "b" })] }, "one", "two", "three"], undefined, { texts: { "runtime.budget": "[Rounds: {{rounds}}.]" }, turn: (s, host) => new AgentTurn({ ...s.turn, toolTurns: 5 }, host.clock.now()) });
    // The first agent has the run's five and uses two; the second is told the three that are left; the third has one of its own.
    await r.start({ tools: [tool("lookup")] }).send("go");
    await r.start({ tools: [tool("lookup")] }).send("go");
    await r.start({ tools: [tool("lookup")], budget: { ...r.spec().budget, toolTurns: 1 } }).send("go");
    expect([0, 3, 4].map((n) => r.host.calls[n]?.messages[1]?.content)).toEqual(["go\n\n[Rounds: 5 rounds.]", "go\n\n[Rounds: 3 rounds.]", "go\n\n[Rounds: 1 round.]"]);
  });
});

describe("rounds running out", () => {
  const left = (n: string) => `[You have ${n} of tool calls left. Finish with what you have.]`;
  const LAST = "[That was your last round of tool calls. Answer now with what you have: a tool call in your next answer isn't run, and your work stops without an answer.]";
  const working = (n: number): Script => (_request, i) => (i < n ? { toolCalls: [call("lookup", { q: `q${i}` }, `c${i}`)] } : "done");

  test("with as few rounds left as Settings say, each round's results say how many, and the last round's that it was the last", async () => {
    const r = rig(working(3));
    const agent = r.start({ tools: [tool("lookup")], budget: { ...r.spec().budget, toolTurns: 3 } });
    expect(await agent.send("go")).toMatchObject({ status: "answered", text: "done" });
    const told = [left("2 rounds"), left("1 round"), LAST];
    for (const [i, text] of told.entries()) {
      // It goes with the round's results, in the one message that follows the model's calls.
      expect(lastMessage(r.host.calls[i + 1])).toEqual({ role: "user", content: `lookup done\n\n${text}`, parts: [{ type: "tool_result", toolUseId: `c${i}`, content: "lookup done" }, { type: "text", text }] });
    }
    // So the user never speaks twice in a row, which no provider takes.
    expect(r.host.calls[3]?.messages.map((m) => m.role)).toEqual(["system", "user", "assistant", "user", "assistant", "user", "assistant", "user"]);
    const entries = agent.transcript().entries;
    expect(entries.map((e) => e.kind)).toEqual(["message", "answer", "result", "notice", "answer", "result", "notice", "answer", "result", "notice", "answer"]);
    expect(entries.flatMap((e) => (e.kind === "notice" ? [e.text] : []))).toEqual(told);
  });

  test("an agent with more rounds left than that is told nothing, and at 0 nothing is ever said", async () => {
    const r = rig(working(1));
    await r.start({ tools: [tool("lookup")], budget: { ...r.spec().budget, toolTurns: 4 } }).send("go");
    expect(lastMessage(r.host.calls[1])?.parts).toEqual([{ type: "tool_result", toolUseId: "c0", content: "lookup done" }]);
    const off = rig(working(3), (s) => (s.loop.warnRounds = 0));
    const quiet = off.start({ tools: [tool("lookup")], budget: { ...off.spec().budget, toolTurns: 3 } });
    expect(await quiet.send("go")).toMatchObject({ status: "answered", text: "done" });
    expect(quiet.transcript().entries.some((e) => e.kind === "notice")).toBe(false);
    expect(off.host.calls.slice(1).map((c) => lastMessage(c)?.content)).toEqual(["lookup done", "lookup done", "lookup done"]);
  });

  test("the run's rounds count where they are fewer, and results that go back as text carry it too", async () => {
    const written = (q: string) => `<tool_call>{"name": "lookup", "arguments": {"q": "${q}"}}</tool_call>`;
    const r = rig([written("a"), written("b"), "done"], undefined, { turn: (s, host) => new AgentTurn({ ...s.turn, toolTurns: 2 }, host.clock.now()) });
    const agent = r.start({ tools: [tool("lookup")], toolCalls: "text" });
    expect(await agent.send("go")).toMatchObject({ status: "answered", text: "done" });
    const back = [1, 2].map((n) => lastMessage(r.host.calls[n]));
    expect(back.map((m) => [m?.role, m?.parts])).toEqual([["user", undefined], ["user", undefined]]);
    expect(back[0]?.content).toEndWith(`</tool_result>\n\n${left("1 round")}`);
    expect(back[1]?.content).toEndWith(`</tool_result>\n\n${LAST}`);
  });

  test("a round that ends the send says nothing", async () => {
    const finish: AgentTool = { name: "finish", description: "Ends.", parameters: { type: "object", properties: {} }, run: async () => ({ text: "the final word", end: true }) };
    const r = rig([{ toolCalls: [call("finish", {}, "c1")] }]);
    const agent = r.start({ tools: [finish], budget: { ...r.spec().budget, toolTurns: 1 } });
    expect(await agent.send("go")).toMatchObject({ status: "answered", text: "the final word" });
    expect(agent.transcript().entries.map((e) => e.kind)).toEqual(["message", "answer", "result"]);
    // Nor is anything left on its conversation for whoever carries it on.
    expect(agent.messages().at(-1)?.parts).toEqual([{ type: "tool_result", toolUseId: "c1", content: "the final word" }]);
  });
});

describe("a stop reaches a round's tools", () => {
  test("cancel ends the send at once, whatever a tool that never settles does, and the call left behind has its result", async () => {
    const hung = stuck();
    const r = rig([{ toolCalls: [call("lookup", { q: "a" }, "c1"), call("stuck", {}, "c2")] }, "never"]);
    const agent = r.start({ tools: [tool("lookup"), hung] });
    const sending = agent.send("go");
    await until(() => hung.runs.length === 1);
    agent.cancel();
    expect(await sending).toMatchObject({ status: "cancelled", code: "cancelled", reason: "the agent was cancelled" });
    expect(r.host.calls).toHaveLength(1);
    const entries = agent.transcript().entries;
    expect(entries.map((e) => e.kind)).toEqual(["message", "answer", "result", "result", "stop"]);
    expect(entries[2]).toMatchObject({ kind: "result", callId: "c1", text: "lookup done", error: false });
    expect(entries[3]).toMatchObject({ kind: "result", callId: "c2", name: "stuck", text: "stuck failed: the agent was cancelled", error: true });
    // Its conversation is whole: every call the model made has a result, so another agent can carry it on.
    expect(agent.messages().at(-1)?.parts).toEqual([
      { type: "tool_result", toolUseId: "c1", content: "lookup done" },
      { type: "tool_result", toolUseId: "c2", content: "stuck failed: the agent was cancelled", isError: true },
    ]);
  });

  test("the send's own signal ends it the same way", async () => {
    const hung = stuck();
    const r = rig([{ toolCalls: [call("stuck", {}, "c1")] }, "never"]);
    const agent = r.start({ tools: [hung] });
    const stop = new AbortController();
    const sending = agent.send("go", stop.signal);
    await until(() => hung.runs.length === 1);
    stop.abort();
    expect(await sending).toMatchObject({ status: "cancelled", code: "cancelled" });
    expect(agent.transcript().entries.map((e) => e.kind)).toEqual(["message", "answer", "result", "stop"]);
    expect(r.host.calls).toHaveLength(1);
  });

  test("the agent's time ends a round a tool holds up, and so does the run's", async () => {
    const hung = stuck();
    const r = rig([{ toolCalls: [call("stuck", {}, "c1")] }, "never"]);
    const agent = r.start({ tools: [hung], budget: { ...r.spec().budget, wallMs: 3000 } });
    const sending = agent.send("go");
    const own = watch(sending);
    await until(() => hung.runs.length === 1);
    r.host.clock.advance(2999);
    await idle();
    expect(own.done).toBe(false);
    r.host.clock.advance(1);
    expect(await sending).toMatchObject({ status: "refused", code: "wall_time", reason: "the agent's time ran out (Time per agent)" });
    expect(agent.transcript().entries.find((e) => e.kind === "result")).toMatchObject({ callId: "c1", text: "stuck failed: the agent's time ran out (Time per agent)", error: true });
    expect(r.host.calls).toHaveLength(1);

    const stalled = stuck();
    const t = rig([{ toolCalls: [call("stuck", {}, "c1")] }, "never"], undefined, { turn: (s, host) => new AgentTurn({ ...s.turn, wallMs: 3000 }, host.clock.now()) });
    const running = t.start({ tools: [stalled] }).send("go");
    await until(() => stalled.runs.length === 1);
    t.host.clock.advance(3000);
    expect(await running).toMatchObject({ status: "refused", code: "turn_time", reason: "the turn's time ran out (Time per turn)" });
    expect(t.host.calls).toHaveLength(1);
  });
});

describe("a note from the user", () => {
  const note = (text: string) => `[The user says, while you work:]\n${text}`;

  test("joins the round's results at the start of the next round, marked as the user's, and is on the record", async () => {
    const said: string[] = [];
    // The user speaks while the tool runs.
    const lookup = tool("lookup", () => {
      said.push("Look at the mill first.", "And be quick.");
      return "found Ilse";
    });
    const r = rig([{ toolCalls: [call("lookup", { q: "Ilse" }, "c1")] }, "Ilse is at the mill."]);
    const agent = r.start({ tools: [lookup], notes: () => said.splice(0) });
    expect(await agent.send("Where is Ilse?")).toMatchObject({ status: "answered", text: "Ilse is at the mill." });
    expect(r.host.calls[0]?.messages.at(-1)?.content).not.toContain("The user says");
    const sent = r.host.calls[1]?.messages ?? [];
    // With the results, not after them: the user's turn of the conversation stays one message.
    expect(sent.map((m) => m.role)).toEqual(["system", "user", "assistant", "user"]);
    expect(sent.at(-1)).toEqual({
      role: "user",
      content: `found Ilse\n\n${note("Look at the mill first.")}\n\n${note("And be quick.")}`,
      parts: [
        { type: "tool_result", toolUseId: "c1", content: "found Ilse" },
        { type: "text", text: note("Look at the mill first.") },
        { type: "text", text: note("And be quick.") },
      ],
    });
    const entries = agent.transcript().entries;
    expect(entries.map((e) => e.kind)).toEqual(["message", "answer", "result", "note", "note", "answer"]);
    expect(entries.flatMap((e) => (e.kind === "note" ? [e.text] : []))).toEqual(["Look at the mill first.", "And be quick."]);
  });

  test("given before the first call it joins the first message", async () => {
    const said = ["Keep it short."];
    const r = rig(["Ilse is at the mill."]);
    const agent = r.start({ notes: () => said.splice(0) });
    await agent.send("Where is Ilse?");
    expect(r.host.calls[0]?.messages).toEqual([
      { role: "system", content: "You look things up." },
      { role: "user", content: `Where is Ilse?\n\n${note("Keep it short.")}` },
    ]);
    expect(agent.transcript().entries.map((e) => e.kind)).toEqual(["message", "note", "answer"]);
  });

  test("where the conversation doesn't end on the user's turn it is a message of its own, in the user's own text for it", async () => {
    const said = ["Keep it short."];
    const r = rig(["A reply."], undefined, { texts: { "agents.note": "(Mara, meanwhile: {{text}})" } });
    const history: ModelMessage[] = [{ role: "user", content: "Hello?" }, { role: "assistant", content: "Hello, Mara." }];
    await r.start({ history, notes: () => said.splice(0) }).run();
    expect(r.host.calls[0]?.messages.slice(1)).toEqual([...history, { role: "user", content: "(Mara, meanwhile: Keep it short.)" }]);
  });
});

describe("a hold on the run", () => {
  const plain = (s: Settings, host: MemoryHost) => new AgentTurn(s.turn, host.clock.now());

  test("a held run's agent makes no call until the run is let go", async () => {
    const r = rig(["Ilse is at the mill."], undefined, { turn: plain });
    const turn = r.deps.turn!;
    expect(turn.pause(r.host.clock.now())).toBe(true);
    // Held already: a second hold changes nothing.
    expect(turn.pause(r.host.clock.now())).toBe(false);
    const sending = r.start().send("Where is Ilse?");
    await idle();
    expect(r.host.calls).toHaveLength(0);
    expect(turn.resume(r.host.clock.now())).toBe(true);
    expect(turn.resume(r.host.clock.now())).toBe(false);
    expect(await sending).toMatchObject({ status: "answered", text: "Ilse is at the mill." });
    expect(r.host.calls).toHaveLength(1);
  });

  test("a hold that begins in a round takes effect at the next: the round's results are in, and whoever keeps the session is told as the agent comes to rest", async () => {
    const r = rig([{ toolCalls: [call("lookup", {}, "c1")] }, "done"], undefined, { turn: plain });
    const turn = r.deps.turn!;
    // The user holds the run while the tool runs.
    const lookup = tool("lookup", () => {
      turn.pause(r.host.clock.now());
      return "found";
    });
    const agent = r.start({ tools: [lookup] });
    const rested: (ModelMessage | undefined)[] = [];
    turn.onHeld = () => void rested.push(agent.messages().at(-1));
    const sending = agent.send("go");
    await until(() => rested.length === 1);
    await idle();
    expect(r.host.calls).toHaveLength(1);
    // What it has done is whole by then: its conversation ends on the round's results.
    expect(rested[0]?.parts).toEqual([{ type: "tool_result", toolUseId: "c1", content: "found" }]);
    expect(agent.transcript().entries.map((e) => e.kind)).toEqual(["message", "answer", "result"]);
    turn.resume(r.host.clock.now());
    expect(await sending).toMatchObject({ status: "answered", text: "done" });
    expect(r.host.calls).toHaveLength(2);
  });

  test("the time it was held counts against neither the agent's time nor the run's", async () => {
    const limits: [string, (s: Settings, host: MemoryHost) => AgentTurn, number | null][] = [
      ["the agent's", plain, 3000],
      ["the run's", (s, host) => new AgentTurn({ ...s.turn, wallMs: 3000 }, host.clock.now()), null],
    ];
    for (const [whose, make, wallMs] of limits) {
      const r = rig([{ toolCalls: [call("lookup", {}, "c1")] }, "done"], undefined, { turn: make });
      const turn = r.deps.turn!;
      let rests = 0;
      turn.onHeld = () => rests++;
      const lookup = tool("lookup", () => {
        turn.pause(r.host.clock.now());
        return "found";
      });
      const sending = r.start({ tools: [lookup], budget: { ...r.spec().budget, wallMs } }).send("go");
      await until(() => rests === 1);
      // Held twenty times as long as the limit.
      r.host.clock.advance(60_000);
      await idle();
      turn.resume(r.host.clock.now());
      expect([whose, await sending]).toMatchObject([whose, { status: "answered", text: "done" }]);
    }
  });

  test("a hold that ended before an agent started isn't taken off that agent's time", async () => {
    const r = rig((_request, i) => {
      r.host.clock.advance(4000);
      return i === 0 ? { toolCalls: [call("lookup")] } : "never";
    }, undefined, { turn: plain });
    const turn = r.deps.turn!;
    turn.pause(r.host.clock.now());
    r.host.clock.advance(60_000);
    turn.resume(r.host.clock.now());
    const reply = await r.start({ tools: [tool("lookup")], budget: { ...r.spec().budget, wallMs: 3000 } }).send("go");
    expect(reply).toMatchObject({ status: "refused", code: "wall_time" });
    expect(r.host.calls).toHaveLength(1);
  });

  test("a cancel ends the hold, and so does the send's own signal: nothing of the agent goes on when the run is let go", async () => {
    const r = rig(["never", "never"], undefined, { turn: plain });
    const turn = r.deps.turn!;
    turn.pause(r.host.clock.now());
    const agent = r.start();
    const cancelled = agent.send("go");
    const stop = new AbortController();
    const stopped = r.start().send("go", stop.signal);
    await idle();
    agent.cancel();
    stop.abort();
    expect(await cancelled).toMatchObject({ status: "cancelled", code: "cancelled" });
    expect(await stopped).toMatchObject({ status: "cancelled", code: "cancelled" });
    turn.resume(r.host.clock.now());
    await idle();
    expect(r.host.calls).toHaveLength(0);
  });
});

describe("a cap from outside the run", () => {
  test("when it gives a stop, the next call isn't made and the agent stops with that code and those words", async () => {
    const r = rig([{ toolCalls: [call("lookup")] }, "never"], undefined, { turn: (s, host) => new AgentTurn(s.turn, host.clock.now()) });
    const turn = r.deps.turn!;
    let spent = false;
    turn.limits = () => (spent ? new AgentStop("spend", { id: TEXT.spend.stopTokens, vars: { tokens: "5000 tokens", limit: "4000", weight: "0.1" } }) : null);
    // The cap is reached while the agent's first round runs.
    const lookup = tool("lookup", () => {
      spent = true;
      return "found";
    });
    const reply = await r.start({ tools: [lookup] }).send("go");
    expect(reply).toMatchObject({ status: "refused", code: "spend", reason: "what every agent's calls sent and wrote in the last 24 hours is counted as 5000 tokens of the 4000 Tokens per day allows (a cached re-read counts as 0.1 of a token)" });
    expect(r.host.calls).toHaveLength(1);
  });
});

describe("a conversation carried on", () => {
  test("another agent started with an agent's conversation goes on from it: its first call holds the earlier call and its result", async () => {
    const lookup = tool("lookup", (a) => `found ${String(a.q)}`);
    const r = rig([{ content: "Let me look.", toolCalls: [call("lookup", { q: "Ilse" }, "c1")] }, "Ilse is at the mill.", "Brann is with her."]);
    const first = r.start({ tools: [lookup] });
    await first.send("Where is Ilse?");
    const carried = first.messages();
    expect(carried.map((m) => m.role)).toEqual(["user", "assistant", "user", "assistant"]);
    // What it gives is the caller's to keep: changing it changes nothing of the agent's.
    first.messages().pop();
    expect(first.messages()).toEqual(carried);
    const second = r.start({ tools: [lookup], history: carried });
    expect(await second.send("And Brann?")).toMatchObject({ status: "answered", text: "Brann is with her." });
    const sent = r.host.calls[2]?.messages ?? [];
    expect(sent.slice(1, -1)).toEqual(carried);
    expect(sent[2]?.parts).toEqual([
      { type: "text", text: "Let me look." },
      { type: "tool_use", id: "c1", name: "lookup", input: { q: "Ilse" } },
    ]);
    expect(sent[3]?.parts).toEqual([{ type: "tool_result", toolUseId: "c1", content: "found Ilse" }]);
    expect(sent[4]).toEqual({ role: "assistant", content: "Ilse is at the mill." });
    expect(sent.at(-1)?.content).toStartWith("And Brann?");
    // None of what it took up counts as a message it was sent.
    expect(second.transcript()).toMatchObject({ history: 4 });
    expect(second.transcript().entries.map((e) => e.kind)).toEqual(["message", "answer"]);
  });
});

describe("what the trace is told", () => {
  test("a tool's changed files are on its result's entry", async () => {
    const files: FileChange[] = [{ area: "chat", path: "notes/plan.md", before: null, after: "0".repeat(64) }];
    const save: AgentTool = { name: "save", description: "Saves.", parameters: { type: "object", properties: {} }, run: async () => ({ text: "Saved.", files }) };
    const nothing: AgentTool = { name: "touch", description: "Changes nothing.", parameters: { type: "object", properties: {} }, run: async () => ({ text: "Nothing changed.", files: [] }) };
    const r = rig([{ toolCalls: [call("save", {}, "c1"), call("touch", {}, "c2"), call("lookup", {}, "c3")] }, "done"]);
    const agent = r.start({ tools: [save, nothing, tool("lookup")] });
    await agent.send("go");
    const results = agent.transcript().entries.flatMap((e) => (e.kind === "result" ? [e] : []));
    expect(results.map((e) => [e.callId, e.files])).toEqual([["c1", files], ["c2", undefined], ["c3", undefined]]);
  });

  test("each call's usage names the connection and the model it ran on", async () => {
    const ran: { agent: string; connection: string; model: string }[] = [];
    const trace: AgentTrace = { start: () => undefined, entry: () => undefined, usage: (agentId, _call, _spent, on) => void ran.push({ agent: agentId, ...on }), idle: () => undefined, prompt: async () => undefined, delta: () => undefined };
    const r = rig([{ toolCalls: [call("lookup")], model: "model-large" }, { content: "done", model: "model-small" }, "the writer's"], undefined, { turn: (s, host) => new AgentTurn(s.turn, host.clock.now(), trace) });
    // One agent on the user's default connection, whichever that is; one on a connection of its own.
    const main = r.start({ connectionId: null, tools: [tool("lookup")] });
    await main.send("go");
    const writer = r.start({ connectionId: WRITER });
    await writer.send("go");
    expect(ran).toEqual([
      { agent: main.id, connection: MAIN, model: "model-large" },
      { agent: main.id, connection: MAIN, model: "model-small" },
      { agent: writer.id, connection: WRITER, model: "scripted" },
    ]);
  });

  test("an agent's start names the connection its calls go on, by its id and its name, and the one its settings name where the runtime has none of that id", async () => {
    const heard: string[] = [];
    const started: AgentStarted[] = [];
    const ran: string[] = [];
    const trace: AgentTrace = { start: (agent) => void (started.push(agent), heard.push("start")), entry: (_agentId, entry) => void heard.push(entry.kind), usage: (_agentId, _call, _spent, on) => void ran.push(on.connection), idle: () => undefined, prompt: async () => undefined, delta: () => undefined };
    const r = rig(["one", "two", "three", "never"], undefined, { turn: (s, host) => new AgentTurn(s.turn, host.clock.now(), trace) });
    // One of Lumiverse's connections, named before the runtime kept its own: the default stands in for it.
    await r.start({ connectionId: "c7c0f78d-from-lumiverse" }).send("go");
    expect(heard).toEqual(["start", "message", "answer"]);
    await r.start({ connectionId: null }).send("go");
    await r.start({ connectionId: WRITER }).send("go");
    expect(started.map(({ connectionId, connectionName, gone }) => ({ connectionId, connectionName, gone }))).toEqual([
      { connectionId: MAIN, connectionName: "Main", gone: "c7c0f78d-from-lumiverse" },
      { connectionId: MAIN, connectionName: "Main", gone: undefined },
      { connectionId: WRITER, connectionName: "Writer", gone: undefined },
    ]);
    // Each call's spend is on the record against the connection it went on.
    expect(ran).toEqual([MAIN, MAIN, WRITER]);
    // With no default to stand in, the start names what its settings name, and its stop says why.
    r.host.defaultConnection = null;
    expect(await r.start({ connectionId: "c7c0f78d-from-lumiverse" }).send("go")).toMatchObject({ status: "refused", code: "connection" });
    expect(started.at(-1)).toMatchObject({ connectionId: "c7c0f78d-from-lumiverse" });
    expect(started.at(-1)?.connectionName).toBeUndefined();
    expect(heard.slice(-3)).toEqual(["start", "message", "stop"]);
  });
});

describe("a call held for the user's word", () => {
  type Ask = Omit<ApprovalAsk, "turn" | "chatId">;

  /** The user at the loop's gate, which holds every tool that writes: each ask is kept with its signal and answered as `word` says; with no word it waits until its signal ends it, as the host's port does. */
  function asking(word: (ask: Ask) => ApprovalAnswer | Promise<ApprovalAnswer> | null, waitMs: number | null = 300_000) {
    const asked: Ask[] = [];
    const signals: AbortSignal[] = [];
    const gate: ApprovalGate = {
      asks: (held) => held.tier === "write",
      waitMs,
      ask: (ask, signal) => {
        asked.push(ask);
        signals.push(signal);
        const said = word(ask);
        if (said !== null) return Promise.resolve(said);
        const { promise, reject } = Promise.withResolvers<ApprovalAnswer>();
        signal.addEventListener("abort", () => reject(signal.reason), { once: true });
        return promise;
      },
    };
    return { gate, asked, signals };
  }

  const writing = (name: string) => ({ ...tool(name), tier: "write" as const });
  const words = (entries: readonly TranscriptEntry[]) => entries.flatMap((e) => (e.kind === "approval_asked" || e.kind === "approval" ? [e] : []));

  test("a tool the gate asks about is held: the ask is on the record with all the user needs to decide, and approved once the tool runs", async () => {
    const save = writing("save");
    const user = asking(() => ({ decision: "once" }));
    const r = rig([{ toolCalls: [call("save", { q: "Ilse" }, "c1")] }, "Saved."], undefined, { approval: user.gate });
    const agent = r.start({ tools: [save] });
    const at = r.host.clock.now();
    expect(await agent.send("go")).toMatchObject({ status: "answered", text: "Saved." });
    expect(save.runs).toEqual([{ q: "Ilse" }]);
    expect(user.asked).toEqual([{ agentId: agent.id, role: "main", callId: "c1", tool: "save", tier: "write", args: { q: "Ilse" }, at, until: at + 300_000 }]);
    const entries = agent.transcript().entries;
    expect(entries.map((e) => e.kind)).toEqual(["message", "answer", "approval_asked", "approval", "result", "answer"]);
    expect(entries[2]).toEqual({ kind: "approval_asked", callId: "c1", tool: "save", tier: "write", args: { q: "Ilse" }, until: at + 300_000, at });
    expect(entries[3]).toEqual({ kind: "approval", callId: "c1", decision: "once", ms: 0, at });
    expect(lastMessage(r.host.calls[1])?.parts).toEqual([{ type: "tool_result", toolUseId: "c1", content: "save done" }]);
  });

  test("approved for the chat it runs the same; with no bound on the wait the ask says so, and no time runs it out", async () => {
    const save = writing("save");
    const word = Promise.withResolvers<ApprovalAnswer>();
    const user = asking(() => word.promise, null);
    const r = rig([{ toolCalls: [call("save", {}, "c1")] }, "Saved."], undefined, { approval: user.gate });
    const agent = r.start({ tools: [save] });
    const sending = agent.send("go");
    await until(() => user.asked.length === 1);
    expect(user.asked[0]?.until).toBeNull();
    r.host.clock.advance(86_400_000);
    await idle();
    expect(save.runs).toEqual([]);
    word.resolve({ decision: "chat" });
    expect(await sending).toMatchObject({ status: "answered", text: "Saved." });
    expect(save.runs).toHaveLength(1);
    expect(words(agent.transcript().entries)).toMatchObject([
      { kind: "approval_asked", callId: "c1", until: null },
      { kind: "approval", callId: "c1", decision: "chat", ms: 86_400_000 },
    ]);
  });

  test("refused, the tool doesn't run and the model reads the refusal, with the user's reason where they gave one", async () => {
    const save = writing("save");
    const said: ApprovalAnswer[] = [{ decision: "refused", reason: "  Brann hasn't agreed  " }, { decision: "refused" }];
    const user = asking(() => said.shift() ?? null);
    const r = rig([{ toolCalls: [call("save", { q: "a" }, "c1")] }, { toolCalls: [call("save", { q: "b" }, "c2")] }, "Left as it was."], undefined, { approval: user.gate });
    const agent = r.start({ tools: [save] });
    expect(await agent.send("go")).toMatchObject({ status: "answered", text: "Left as it was." });
    expect(save.runs).toEqual([]);
    const refusal = "Not run: the user refused this call of save. Don't make it again unless they ask for it; go on without it, or say in your answer what you needed it for.";
    // The user's words stand apart from the runtime's, wherever theirs end.
    expect(lastMessage(r.host.calls[1])?.parts).toEqual([{ type: "tool_result", toolUseId: "c1", content: `${refusal}\nTheir reason: Brann hasn't agreed`, isError: true }]);
    expect(lastMessage(r.host.calls[2])?.parts).toEqual([{ type: "tool_result", toolUseId: "c2", content: refusal, isError: true }]);
    const closed = agent.transcript().entries.flatMap((e) => (e.kind === "approval" ? [e] : []));
    expect(closed).toMatchObject([
      { callId: "c1", decision: "refused", reason: "Brann hasn't agreed" },
      { callId: "c2", decision: "refused" },
    ]);
    expect(closed[1]).not.toHaveProperty("reason");
  });

  test("when the wait runs out the tool doesn't run, and the model reads why", async () => {
    const save = writing("save");
    const user = asking(() => null, 60_000);
    const r = rig([{ toolCalls: [call("save", {}, "c1")] }, "Done without it."], undefined, { approval: user.gate });
    const agent = r.start({ tools: [save] });
    const sending = agent.send("go");
    await until(() => user.asked.length === 1);
    r.host.clock.advance(59_999);
    await idle();
    expect(r.host.calls).toHaveLength(1);
    expect(user.signals[0]?.aborted).toBe(false);
    r.host.clock.advance(1);
    expect(await sending).toMatchObject({ status: "answered", text: "Done without it." });
    expect(save.runs).toEqual([]);
    // The ask is taken down: nobody can answer it any more.
    expect(user.signals[0]?.aborted).toBe(true);
    expect(lastMessage(r.host.calls[1])?.parts).toEqual([{ type: "tool_result", toolUseId: "c1", content: "Not run: this call of save needs the user's approval, and none came in the 60 seconds it may wait (Wait for your word). Go on without it, or say in your answer what you needed it for.", isError: true }]);
    expect(words(agent.transcript().entries)).toMatchObject([
      { kind: "approval_asked", callId: "c1" },
      { kind: "approval", callId: "c1", decision: "timed_out", ms: 60_000 },
    ]);
  });

  test("with no way to ask, the call is refused in words that say so", async () => {
    const save = writing("save");
    const r = rig([{ toolCalls: [call("save", {}, "c1")] }, "Done without it."], undefined, { approval: { asks: () => true, waitMs: 300_000 } });
    const agent = r.start({ tools: [save] });
    expect(await agent.send("go")).toMatchObject({ status: "answered", text: "Done without it." });
    expect(save.runs).toEqual([]);
    expect(lastMessage(r.host.calls[1])?.parts).toEqual([{ type: "tool_result", toolUseId: "c1", content: "Not run: this call of save needs the user's approval, and there is no way to ask them here. Go on without it, or say in your answer what you needed it for.", isError: true }]);
    // Nobody was asked, so there is no ask to show.
    expect(agent.transcript().entries.map((e) => e.kind)).toEqual(["message", "answer", "result", "answer"]);
  });

  test("a tool the gate doesn't ask about runs at once, with nothing on the record, while another call of the round waits", async () => {
    const save = writing("save");
    const lookup = tool("lookup");
    const word = Promise.withResolvers<ApprovalAnswer>();
    const user = asking(() => word.promise);
    const r = rig([{ toolCalls: [call("save", {}, "c1"), call("lookup", {}, "c2")] }, "done"], undefined, { approval: user.gate });
    const agent = r.start({ tools: [save, lookup] });
    const sending = agent.send("go");
    await until(() => user.asked.length === 1);
    await idle();
    expect(lookup.runs).toHaveLength(1);
    expect(save.runs).toHaveLength(0);
    word.resolve({ decision: "once" });
    expect(await sending).toMatchObject({ status: "answered", text: "done" });
    expect(user.asked.map((ask) => ask.tool)).toEqual(["save"]);
    expect(words(agent.transcript().entries).map((e) => e.callId)).toEqual(["c1", "c1"]);
    expect(lastMessage(r.host.calls[1])?.parts).toEqual([
      { type: "tool_result", toolUseId: "c1", content: "save done" },
      { type: "tool_result", toolUseId: "c2", content: "lookup done" },
    ]);
  });

  test("the time a call waited isn't the agent's own: it doesn't count against its time limit", async () => {
    const save = writing("save");
    const word = Promise.withResolvers<ApprovalAnswer>();
    const user = asking(() => word.promise);
    // The agent's second call takes two seconds; with the four it waited for the user's word that would be past its five.
    const r = rig(
      (_request, i) => {
        if (i === 1) r.host.clock.advance(2000);
        return i === 0 ? { toolCalls: [call("save", {}, "c1")] } : i === 1 ? { toolCalls: [call("lookup", {}, "c2")] } : "done";
      },
      undefined,
      { approval: user.gate },
    );
    const sending = r.start({ tools: [save, tool("lookup")], budget: { ...r.spec().budget, wallMs: 5000 } }).send("go");
    await until(() => user.asked.length === 1);
    r.host.clock.advance(4000);
    word.resolve({ decision: "once" });
    expect(await sending).toMatchObject({ status: "answered", text: "done" });
    expect(r.host.calls).toHaveLength(3);
  });

  test("cancelling while a call waits ends the send as cancelled, and the ask is taken down", async () => {
    const save = writing("save");
    const user = asking(() => null);
    const r = rig([{ toolCalls: [call("save", {}, "c1")] }, "never"], undefined, { approval: user.gate });
    const agent = r.start({ tools: [save] });
    const sending = agent.send("go");
    await until(() => user.asked.length === 1);
    agent.cancel();
    expect(await sending).toMatchObject({ status: "cancelled", code: "cancelled" });
    expect(user.signals[0]?.aborted).toBe(true);
    expect(save.runs).toEqual([]);
    // The call has no word of its own: the agent's stop says how it ended.
    expect(agent.transcript().entries.map((e) => e.kind)).toEqual(["message", "answer", "approval_asked", "result", "stop"]);
    expect(r.host.calls).toHaveLength(1);
  });

  test("an ask that fails is no word: the tool doesn't run, the card comes down, and the model reads the failure", async () => {
    const save = writing("save");
    const r = rig([{ toolCalls: [call("save", {}, "c1")] }, "Done without it."], undefined, { approval: { asks: () => true, waitMs: 300_000, ask: () => Promise.reject(new Error("the link is down")) } });
    const agent = r.start({ tools: [save] });
    expect(await agent.send("go")).toMatchObject({ status: "answered", text: "Done without it." });
    expect(save.runs).toEqual([]);
    expect(lastMessage(r.host.calls[1])?.parts).toEqual([{ type: "tool_result", toolUseId: "c1", content: "Not run: this call of save needs the user's approval, and asking for it failed (the link is down). Go on without it, or say in your answer what you needed it for.", isError: true }]);
    // The ask is closed on the record, so the live view no longer shows the agent as waiting for a word.
    expect(words(agent.transcript().entries)).toMatchObject([
      { kind: "approval_asked", callId: "c1" },
      { kind: "approval", callId: "c1", decision: "refused", reason: "the link is down" },
    ]);
  });

  test("a wait longer than all the time the agent has doesn't end its work: the time waited isn't the agent's", async () => {
    const save = writing("save");
    const answer = Promise.withResolvers<ApprovalAnswer>();
    const user = asking(() => answer.promise);
    const r = rig([{ toolCalls: [call("save", {}, "c1")] }, "Saved."], undefined, { approval: user.gate });
    const sending = r.start({ tools: [save], budget: { ...r.spec().budget, wallMs: 3000 } }).send("go");
    await until(() => user.asked.length === 1);
    // Ten seconds pass while the call waits: more than three times the agent's whole time.
    for (let i = 0; i < 10; i++) {
      r.host.clock.advance(1000);
      await idle(2);
    }
    answer.resolve({ decision: "once" });
    expect(await sending).toMatchObject({ status: "answered", text: "Saved." });
    expect(save.runs).toHaveLength(1);
  });

  test("two calls that wait at the same time wait that time once: the agent gets back no more time than passed", async () => {
    const save = writing("save");
    const first = Promise.withResolvers<ApprovalAnswer>();
    const second = Promise.withResolvers<ApprovalAnswer>();
    const user = asking((ask) => (ask.callId === "c1" ? first.promise : second.promise));
    // After the round, its next call never answers: the agent's own time then runs. The two calls differ, so each is a call of its own and each is asked about.
    const r = rig([{ toolCalls: [call("save", { q: "Ilse" }, "c1"), call("save", { q: "Brann" }, "c2")] }, { hang: true }], undefined, { approval: user.gate });
    const sending = r.start({ tools: [save], budget: { ...r.spec().budget, wallMs: 5000 } }).send("go");
    await until(() => user.asked.length === 2);
    // Both wait the same four seconds.
    r.host.clock.advance(4000);
    await idle(2);
    first.resolve({ decision: "once" });
    second.resolve({ decision: "once" });
    await until(() => r.host.calls.length === 2);
    // Four seconds of its own are within its five; were the wait counted twice, it would have eight more to go and not stop at six.
    r.host.clock.advance(4000);
    await idle(2);
    r.host.clock.advance(2000);
    expect(await sending).toMatchObject({ status: "refused", code: "wall_time" });
  });

  test("the send's own signal ends a waiting call the same way", async () => {
    const save = writing("save");
    const user = asking(() => null);
    const r = rig([{ toolCalls: [call("save", {}, "c1")] }, "never"], undefined, { approval: user.gate });
    const stop = new AbortController();
    const sending = r.start({ tools: [save] }).send("go", stop.signal);
    await until(() => user.asked.length === 1);
    stop.abort();
    expect(await sending).toMatchObject({ status: "cancelled", code: "cancelled" });
    expect(user.signals[0]?.aborted).toBe(true);
    expect(save.runs).toEqual([]);
  });
});
