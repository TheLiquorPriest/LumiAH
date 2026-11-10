// The agent loop on a scripted model (DESIGN §4.1): tool round trips, the fallback from native tools
// to text, calls a model writes as text, the loop detector, budgets, clipping with scratch_read,
// reasoning carried across tool calls, cache breakpoints, throttles, a connection's calls at once,
// a call that fails in passing made again, a streaming answer's pieces for the live view, and a
// tool that ends the send.

import { describe, expect, test } from "bun:test";
import { type AgentDeps, type AgentSpec, type AgentTrace, AgentTurn, startAgent } from "../../src/core/loop";
import type { JsonObject, ModelRequest } from "../../src/core/ports";
import { AgentAccounts } from "../../src/core/provider";
import { defaultSettings, type Settings } from "../../src/core/settings";
import { SCRATCH_READ, Texts } from "../../src/core/texts";
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

function rig(script: Script, change: (s: Settings) => void = () => undefined, options: { texts?: Record<string, string>; turn?: (s: Settings, host: MemoryHost) => AgentTurn } = {}) {
  const host = new MemoryHost();
  host.script = script;
  const settings = defaultSettings();
  change(settings);
  const deps: AgentDeps = { host, settings, texts: new Texts(options.texts ?? {}), accounts: new AgentAccounts(host), turn: options.turn?.(settings, host) ?? null };
  const budget = { ...defaultSettings().agents.main!.budget };
  const spec = (over: Partial<AgentSpec> = {}): AgentSpec => ({ role: "main", connectionId: MAIN, model: null, effort: "medium", system: "You look things up.", prefix: [], tools: [], budget, ...over });
  return { host, deps, settings, spec, start: (over: Partial<AgentSpec> = {}) => startAgent(spec(over), deps) };
}

const lastMessage = (request: ModelRequest | undefined) => request?.messages.at(-1);

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
  test("the same call with the same arguments, a setting's number of times running, stops the agent", async () => {
    const lookup = tool("lookup");
    const again = { toolCalls: [call("lookup", { q: "same" })] };
    const r = rig([again, again, again, "never reached"]);
    const reply = await r.start({ tools: [lookup] }).send("go");
    expect(reply).toMatchObject({ status: "stopped", code: "loop", reason: "the agent called lookup with the same arguments 3 times in a row (Loop detector)" });
    expect(lookup.runs).toHaveLength(2);
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
    const r = rig([{ toolCalls: [call("lookup")], usage }, { toolCalls: [call("lookup", { q: "b" })], usage }, "never"]);
    const reply = await r.start({ tools: [tool("lookup")], budget: { ...r.spec().budget, callTokensOut: 100, tokensOut: 120 } }).send("go");
    expect(r.host.calls.map((c) => c.maxTokens)).toEqual([100, 60]);
    expect(reply).toMatchObject({ status: "refused", code: "tokens_out" });
  });

  test("the turn's budget counts every agent of the turn together", async () => {
    const r = rig(looping(10), undefined, { turn: (s, host) => new AgentTurn({ ...s.turn, toolTurns: 3 }, host.clock.now()) });
    const first = await r.start({ tools: [tool("lookup")], budget: { ...r.spec().budget, toolTurns: 2 } }).send("go");
    expect(first.code).toBe("tool_turns");
    const second = await r.start({ tools: [tool("lookup")] }).send("go");
    expect(second).toMatchObject({ status: "refused", code: "turn_tool_turns" });
    expect(r.deps.turn?.usage.toolTurns).toBe(3);
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

  test("a loopback connection, or one that isn't there, stops the agent before any call, saying what to do", async () => {
    const r = rig(["never"]);
    const loop = await r.start({ connectionId: "conn-loopback" }).send("go");
    expect(loop).toMatchObject({ status: "refused", code: "connection" });
    expect(loop.reason).toContain("a call on it would come straight back here");
    const gone = await r.start({ connectionId: "conn-gone" }).send("go");
    expect(gone.reason).toBe("the connection conn-gone no longer exists: give this agent another in LumiAH's Settings");
    expect(r.host.calls).toHaveLength(0);
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

  test("on a provider that takes breakpoints, the opening and the conversation so far are marked, within its limit", async () => {
    const r = rig([{ toolCalls: [call("lookup", {}, "c1")] }, "done"]);
    r.host.profiles.push({ id: "conn-cache", name: "Cache", provider: "anthropic", model: "m", loopback: false, cache: { limit: 4, system: false, lastMessage: false, tools: false, automatic: false }, parallelTools: false });
    await r.start({ connectionId: "conn-cache", tools: [tool("lookup")], prefix: ["Guidance for every agent."] }).send("go");
    const [first, second] = r.host.calls;
    // All four of the provider's breakpoints are spent: the shared prefix, the opening, the last tool, and the conversation so far.
    expect(first?.messages[0]?.parts).toEqual([
      { type: "text", text: "Guidance for every agent.", cache: true },
      { type: "text", text: "You look things up.", cache: true },
    ]);
    expect(first?.tools?.map((t) => t.cache === true)).toEqual([false, true]);
    expect(first?.messages.at(-1)?.parts?.at(-1)).toMatchObject({ cache: true });
    expect(second?.messages.at(-1)?.parts?.at(-1)).toMatchObject({ type: "tool_result", cache: true });
    expect(first?.parallelToolCalls).toBe(false);
    // Switched off in Settings, nothing is marked.
    const off = rig(["done"], (s) => (s.cache.breakpoints = false));
    off.host.profiles.push({ id: "conn-cache", name: "Cache", provider: "anthropic", model: "m", loopback: false, cache: { limit: 4, system: false, lastMessage: false, tools: false, automatic: false }, parallelTools: true });
    await off.start({ connectionId: "conn-cache" }).send("go");
    expect(off.host.calls[0]?.messages[0]).toEqual({ role: "system", content: "You look things up." });
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
    expect(answer?.kind === "answer" ? answer.usage : null).toEqual({ in: 1000, cachedIn: 400, out: 200, reasoningOut: 0, estimated: ["reasoningOut", "cost"], cost: (600 * 2 + 400 * 0.5 + 200 * 10) / 1_000_000 });
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
