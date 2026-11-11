// The provider session's parts that stand alone: recovering the tool calls a model writes as text,
// telling a refusal of native tools and a failure that passes from any other failure, how an agent's
// tools are offered and how long a refusal is remembered, the names its tools go by on the wire
// (DESIGN §13, §16), a connection's calls at once, and ranking a search.

import { describe, expect, test } from "bun:test";
import { excerptOf, LexicalIndex, tokenize } from "../../src/core/lexical";
import { startAgent } from "../../src/core/loop";
import type { JsonObject, ModelMessage, ModelRequest, ModelTool } from "../../src/core/ports";
import { type AgentCall, AgentAccounts, assemble, type CallSpec, isToolRefusal, isTransient, type ModelReply, NATIVE_TURNS, ownBreakpoints, type PreparedCall, type ProviderDeps, ProviderSession, recoverToolCalls, requestOf, TEXT_TURNS, ToolsRefused } from "../../src/core/provider";
import { defaultSettings, type Settings, type ToolCalls } from "../../src/core/settings";
import { SCRATCH_READ, Texts } from "../../src/core/texts";
import type { AgentTool } from "../../src/core/tools";
import { call, MAIN, MemoryHost, promptText, type Script, settle } from "./support/host";

const NAMES = new Set(["lookup", "chat_read"]);
/** The namespace a tag of Claude's XML form may carry before its name. */
const NS = "antml:";

/** What reading `text` for written calls gives, and how long the fastest of three reads took: a stall of the machine isn't the recovery's. */
function timed(text: string) {
  const reads = [1, 2, 3].map(() => {
    const t0 = performance.now();
    const read = recoverToolCalls(text, NAMES);
    return { read, ms: performance.now() - t0 };
  });
  return reads.reduce((fastest, each) => (each.ms < fastest.ms ? each : fastest));
}

describe("calls written as text", () => {
  test("are recovered in the forms models write them, and taken out of the text", () => {
    expect(recoverToolCalls('I will look.\n<tool_call>{"name": "lookup", "arguments": {"q": "tide"}}</tool_call>', NAMES)).toEqual({ calls: [{ name: "lookup", args: { q: "tide" } }], rest: "I will look." });
    expect(recoverToolCalls('<function_calls><invoke name="chat_read"><parameter name="from">12</parameter><parameter name="note">the quay</parameter></invoke></function_calls>', NAMES)).toEqual({ calls: [{ name: "chat_read", args: { from: 12, note: "the quay" } }], rest: "" });
    expect(recoverToolCalls('<function=lookup>{"q": "mill"}</function>', NAMES).calls).toEqual([{ name: "lookup", args: { q: "mill" } }]);
    expect(recoverToolCalls('[TOOL_CALLS] [{"name": "lookup", "arguments": {"q": "a"}}, {"name": "chat_read", "arguments": {"from": 3}}]', NAMES).calls).toHaveLength(2);
    expect(recoverToolCalls('```json\n{"tool": "lookup", "input": {"q": "nets"}}\n```', NAMES).calls).toEqual([{ name: "lookup", args: { q: "nets" } }]);
    expect(recoverToolCalls('{"name": "lookup", "arguments": "{\\"q\\": \\"floats\\"}"}', NAMES)).toEqual({ calls: [{ name: "lookup", args: { q: "floats" } }], rest: "" });
    expect(recoverToolCalls("<｜tool▁calls▁begin｜><｜tool▁call▁begin｜>function<｜tool▁sep｜>lookup\n```json\n{\"q\": \"lamp\"}\n```<｜tool▁call▁end｜><｜tool▁calls▁end｜>", NAMES)).toEqual({ calls: [{ name: "lookup", args: { q: "lamp" } }], rest: "" });
  });

  test("a block that names another tool, or isn't a call, stays in the text", () => {
    const other = '<tool_call>{"name": "format_disk", "arguments": {}}</tool_call>';
    expect(recoverToolCalls(other, NAMES)).toEqual({ calls: [], rest: other });
    const data = '```json\n{"name": "lookup", "description": "A tool, described."}\n```';
    expect(recoverToolCalls(data, NAMES)).toEqual({ calls: [], rest: data });
    expect(recoverToolCalls("Ilse said: look it up.", NAMES)).toEqual({ calls: [], rest: "Ilse said: look it up." });
  });

  test("an opening tag that is never closed costs no more than reading the answer once", () => {
    // Each form's opening tag, and what stands around it where the form is only read inside another.
    const forms: [form: string, opening: string, around?: [before: string, after: string]][] = [
      ["tool_call", "<tool_call>"],
      ["function=", "<function=lookup>"],
      ["function= with no end to its name", "<function=lookup"],
      ["function_calls", "<function_calls>"],
      ["function_calls under its namespace", `<${NS}function_calls>`],
      ["invoke", '<invoke name="format_disk">', ["<function_calls>", "</function_calls>"]],
      ["invoke under its namespace", `<${NS}invoke name="format_disk">`, [`<${NS}function_calls>`, `</${NS}function_calls>`]],
      ["parameter", '<parameter name="q">', ['<function_calls><invoke name="format_disk">', "</invoke></function_calls>"]],
      ["DeepSeek's tokens", "<｜tool▁call▁begin｜>lookup\n"],
      ["DeepSeek's tokens and a fence", "<｜tool▁call▁begin｜>function<｜tool▁sep｜>lookup\n```json\n"],
      ["[TOOL_CALLS]", "[TOOL_CALLS]"],
      ["[TOOL_CALLS] and an object", "[TOOL_CALLS] {"],
      ["a code fence", "```json\n"],
      ["JSON alone", '{"name": "lookup", "arguments": {'],
    ];
    for (const [form, opening, [before, after] = ["", ""]] of forms) {
      for (const [then, rest] of [["50,000 newlines", `${opening}${"\n".repeat(50_000)}`], ["50,000 spaces", `${opening}${" ".repeat(50_000)}`], ["itself, 2,000 times", opening.repeat(2000)]] as const) {
        const text = `${before}${rest}${after}`;
        const { read, ms } = timed(text);
        expect({ form, then, calls: read.calls, unchanged: read.rest === text, under200ms: ms < 200 }).toEqual({ form, then, calls: [], unchanged: true, under200ms: true });
      }
    }
  });

  test("a call written after a tag that is never closed is still recovered, Claude's form under its namespace too", () => {
    const call = `<${NS}function_calls>\n<${NS}invoke name="lookup">\n<${NS}parameter name="q">tide</${NS}parameter>\n</invoke>\n</${NS}function_calls>`;
    const { read, ms } = timed(`<tool_call>${"\n".repeat(50_000)}${call}`);
    expect(read).toEqual({ calls: [{ name: "lookup", args: { q: "tide" } }], rest: "<tool_call>" });
    expect(ms).toBeLessThan(200);
  });

  test("a tool's name may hold a colon or a dot: every form carries it", () => {
    const names = new Set(["mcp:tides:table", "harbour.tides"]);
    for (const name of names) {
      const forms = [
        `<tool_call>{"name": "${name}", "arguments": {"day": "today"}}</tool_call>`,
        `<function_calls><invoke name="${name}"><parameter name="day">today</parameter></invoke></function_calls>`,
        `<${NS}function_calls><${NS}invoke name="${name}"><${NS}parameter name="day">today</${NS}parameter></${NS}invoke></${NS}function_calls>`,
        `<function=${name}>{"day": "today"}</function>`,
        `[TOOL_CALLS] [{"name": "${name}", "arguments": {"day": "today"}}]`,
        `\`\`\`json\n{"tool": "${name}", "input": {"day": "today"}}\n\`\`\``,
        `{"name": "${name}", "arguments": {"day": "today"}}`,
        `<｜tool▁calls▁begin｜><｜tool▁call▁begin｜>function<｜tool▁sep｜>${name}\n\`\`\`json\n{"day": "today"}\n\`\`\`<｜tool▁call▁end｜><｜tool▁calls▁end｜>`,
        `<｜tool▁call▁begin｜>${name}<｜tool▁sep｜>{"day": "today"}<｜tool▁call▁end｜>`,
      ];
      for (const written of forms) expect({ written, read: recoverToolCalls(written, names) }).toEqual({ written, read: { calls: [{ name, args: { day: "today" } }], rest: "" } });
    }
  });
});

describe("a refusal of native tools", () => {
  test("is read from the provider's own words, in the error or its cause", () => {
    for (const words of ["400: this model does not support tools", "No endpoints found that support tool use", "Function calling is not enabled for this model", "tools param requires --jinja flag", "Unsupported parameter: 'tools'", '"auto" tool choice requires --enable-auto-tool-choice']) expect({ words, refusal: isToolRefusal(new Error(words)) }).toEqual({ words, refusal: true });
    expect(isToolRefusal(new Error("the call failed", { cause: new Error("tool use is not supported") }))).toBe(true);
    for (const words of ["503: overloaded", "rate limit reached", "the tool lookup failed: no shelf", "context length exceeded"]) expect({ words, refusal: isToolRefusal(new Error(words)) }).toEqual({ words, refusal: false });
  });
});

describe("how an agent's tools are offered", () => {
  const LOOKUP: ModelTool = { name: "lookup", description: "Looks a thing up.", parameters: { type: "object", properties: { q: { type: "string", description: "What to look up." } } } };
  const REFUSAL = "400: this model does not support tools";
  const open = new AbortController().signal;

  /** A host whose provider refuses native tools, its accounts, and sessions on its main connection that each offer one tool. */
  function rig(change: (s: Settings) => void = () => undefined) {
    const host = new MemoryHost();
    host.script = (request) => (request.tools ? { error: REFUSAL } : "Ilse is at the mill.");
    const settings = defaultSettings();
    change(settings);
    const deps: ProviderDeps = { host, settings, texts: new Texts(), accounts: new AgentAccounts(host) };
    /** A session on `model` (null: the connection's own), its tools offered as `toolCalls` says. */
    const session = (model: string | null, toolCalls?: ToolCalls) => {
      const spec: CallSpec = { connectionId: MAIN, model, effort: "medium", system: "You look things up.", prefix: [], cache: settings.cache, ...(toolCalls !== undefined ? { toolCalls } : {}) };
      const made = new ProviderSession(deps, spec);
      const prepare = (): Promise<PreparedCall> => made.prepare([{ role: "user", content: "Where is Ilse?" }], [LOOKUP]);
      return { made, prepare, send: async (p: PreparedCall) => made.send(p, requestOf(spec, p, 500, settings), open) };
    };
    /** How a new session on `model` would offer its tool on its first call. */
    const offered = async (model: string | null, toolCalls?: ToolCalls): Promise<"native" | "text"> => {
      const p = await session(model, toolCalls).prepare();
      expect(p.tools.length).toBe(p.textTools ? 0 : 1);
      return p.textTools ? "text" : "native";
    };
    /** A session on `model` is refused its native tools, turns to text, and its next call works: what the accounts remember a refusal from. */
    const refused = async (model: string | null): Promise<void> => {
      const s = session(model);
      await expect(s.send(await s.prepare())).rejects.toBeInstanceOf(ToolsRefused);
      s.made.refuseNativeTools(REFUSAL);
      expect((await s.send(await s.prepare())).text).toBe("Ilse is at the mill.");
    };
    return { host, session, offered, refused };
  }

  test("a refusal is remembered for the model that refused, not for every model of its connection", async () => {
    const r = rig();
    // The session names no model, so its calls ran on the connection's own.
    await r.refused(null);
    expect(await r.offered(null)).toBe("text");
    expect(await r.offered("model-main")).toBe("text");
    expect(await r.offered("model-b")).toBe("native");
  });

  test("a refusal is remembered for as long as Settings say, then native tools are tried again", async () => {
    const r = rig((s) => (s.connections.toolRefusalMinutes = 5));
    await r.refused("model-a");
    r.host.clock.advance(5 * 60_000 - 1);
    expect(await r.offered("model-a")).toBe("text");
    r.host.clock.advance(1);
    expect(await r.offered("model-a")).toBe("native");
    // Tried again and refused again, it is remembered from then.
    await r.refused("model-a");
    r.host.clock.advance(5 * 60_000 - 1);
    expect(await r.offered("model-a")).toBe("text");
    const forever = rig((s) => (s.connections.toolRefusalMinutes = null));
    await forever.refused("model-a");
    forever.host.clock.advance(1000 * 24 * 60 * 60_000);
    expect(await forever.offered("model-a")).toBe("text");
  });

  test("an agent set to tools as text is offered them so from its first call, and nothing is remembered of it", async () => {
    const r = rig();
    r.host.script = () => 'I will look.\n<tool_call>{"name": "lookup", "arguments": {"q": "Ilse"}}</tool_call>';
    const s = r.session("model-a", "text");
    const p = await s.prepare();
    expect({ native: p.tools, text: p.textTools }).toEqual({ native: [], text: true });
    const reply = await s.send(p);
    expect(r.host.calls).toHaveLength(1);
    expect(r.host.calls[0]?.tools).toBeUndefined();
    expect(promptText(r.host.calls[0])).toContain('lookup: Looks a thing up.\nArguments (JSON Schema): {"type":"object"');
    expect(reply).toMatchObject({ text: "I will look.", written: true, calls: [{ name: "lookup", args: { q: "Ilse" } }] });
    // No call of it was refused: the connection's other agents are still offered native tools.
    expect(await r.offered("model-a")).toBe("native");
  });

  test("an agent set to native tools is always offered them natively, and a refusal is its call's failure", async () => {
    const r = rig();
    await r.refused("model-a");
    expect(await r.offered("model-a")).toBe("text");
    // What the accounts remember of the model doesn't turn it.
    expect(await r.offered("model-a", "native")).toBe("native");
    const fresh = rig();
    const s = fresh.session("model-a", "native");
    const failure: unknown = await s.send(await s.prepare()).then(
      () => null,
      (error: unknown) => error,
    );
    expect(failure).toBeInstanceOf(Error);
    expect(failure).not.toBeInstanceOf(ToolsRefused);
    expect((failure as Error).message).toBe(REFUSAL);
    // Nothing turns it, and nothing was remembered: its next call offers native tools, and so does another agent's.
    s.made.refuseNativeTools(REFUSAL);
    expect((await s.prepare()).textTools).toBe(false);
    expect(await fresh.offered("model-a")).toBe("native");
    expect(fresh.host.calls.every((call) => call.tools?.length === 1)).toBe(true);
  });
});

describe("tool names on the wire", () => {
  const TABLE = "mcp:tides:table";
  /** What OpenAI and Anthropic take as a native tool's name. */
  const TAKEN = /^[A-Za-z0-9_-]{1,64}$/;
  const open = new AbortController().signal;
  const described = (name: string): ModelTool => ({ name, description: `The ${name} tool.`, parameters: { type: "object", properties: { day: { type: "string" } } } });
  /** The tools a request offers natively, by name. */
  const offered = (request: ModelRequest | undefined): string[] => (request?.tools ?? []).map((t) => t.name);
  /** The tool calls that messages carry, by name. */
  const carried = (messages: readonly ModelMessage[] | undefined): string[] => (messages ?? []).flatMap((m) => (m.parts ?? []).flatMap((p) => (p.type === "tool_use" ? [p.name] : [])));

  /**
   * A session on a connection whose agent has `names` as its tools, driven as the loop drives one:
   * `round` prepares a call from the conversation so far and sends it, and `ran` puts its calls back
   * with a result each.
   */
  function rig(names: readonly string[], script: Script, options: { toolCalls?: ToolCalls; connectionId?: string } = {}) {
    const host = new MemoryHost();
    host.script = script;
    const settings = defaultSettings();
    const texts = new Texts();
    const spec: CallSpec = { connectionId: options.connectionId ?? MAIN, model: null, effort: "medium", system: "You read tide tables.", prefix: [], cache: settings.cache, ...(options.toolCalls !== undefined ? { toolCalls: options.toolCalls } : {}) };
    const session = new ProviderSession({ host, settings, texts, accounts: new AgentAccounts(host) }, spec);
    const tools = names.map(described);
    const conversation: ModelMessage[] = [{ role: "user", content: "When is high water?" }];
    const round = async (): Promise<ModelReply> => {
      const p = await session.prepare(conversation, tools);
      return session.send(p, requestOf(spec, p, 500, settings), open);
    };
    const ran = (reply: ModelReply): void => {
      const turns = reply.written ? TEXT_TURNS : NATIVE_TURNS;
      conversation.push(turns.assistant(reply), turns.results(reply.calls.map((made) => ({ call: made, text: `${made.name} read`, error: false })), texts));
    };
    return { host, conversation, round, ran };
  }

  /** A tool of the registry's under `name` that keeps each run's arguments and answers `text`. */
  function recording(name: string, text: string): AgentTool & { runs: JsonObject[] } {
    const runs: JsonObject[] = [];
    return {
      ...described(name),
      runs,
      run: async (args) => {
        runs.push(args);
        return { text };
      },
    };
  }

  /** An agent in the loop on the main connection, with `tools` and a scripted model. */
  function working(tools: AgentTool[], script: Script) {
    const host = new MemoryHost();
    host.script = script;
    const settings = defaultSettings();
    const agent = startAgent({ role: "main", connectionId: MAIN, model: null, effort: "medium", system: "You read tide tables.", prefix: [], tools, budget: { ...settings.agents.main!.budget } }, { host, settings, texts: new Texts(), accounts: new AgentAccounts(host), turn: null });
    return { host, agent };
  }

  test("a name a provider refuses goes out under one it takes, comes back to the loop as the tool's own, and stands in the next call's history as it went out", async () => {
    const table = recording(TABLE, "06:10 and 18:40");
    const { host, agent } = working([table], [{ content: "The table first.", toolCalls: [call("mcp_tides_table", { day: "today" }, "c1")] }, "High water at ten past six."]);
    expect(await agent.send("When is high water?")).toMatchObject({ status: "answered", text: "High water at ten past six." });
    // Out: offered under a name a provider takes, the same on every call.
    expect(host.calls.map((request) => offered(request))).toEqual([
      ["mcp_tides_table", SCRATCH_READ],
      ["mcp_tides_table", SCRATCH_READ],
    ]);
    // Back: the loop had the tool's own name, so the tool ran, and the record names it as the registry does.
    expect(table.runs).toEqual([{ day: "today" }]);
    const entries = agent.transcript().entries;
    expect(entries.flatMap((e) => (e.kind === "answer" ? e.calls : []))).toEqual([{ id: "c1", name: TABLE, args: { day: "today" } }]);
    expect(entries.find((e) => e.kind === "result")).toMatchObject({ callId: "c1", name: TABLE, text: "06:10 and 18:40", error: false });
    // Out again: the call in the next request's history is named as it was offered, in its part and in the text that renders it.
    expect(host.calls[1]?.messages.at(-2)).toEqual({
      role: "assistant",
      content: 'The table first.\nmcp_tides_table {"day":"today"}',
      parts: [
        { type: "text", text: "The table first." },
        { type: "tool_use", id: "c1", name: "mcp_tides_table", input: { day: "today" } },
      ],
    });
    expect(host.calls[1]?.messages.at(-1)?.parts).toEqual([{ type: "tool_result", toolUseId: "c1", content: "06:10 and 18:40" }]);
    // The conversation the agent keeps, which its session is stored from, names the tool as the registry does.
    expect(carried(agent.messages())).toEqual([TABLE]);
    expect(agent.messages().at(-3)?.content).toBe('The table first.\nmcp:tides:table {"day":"today"}');
  });

  test("two names that would be one on the wire go out apart, and each call comes back as its own tool's", async () => {
    // One a provider takes as it is, and one that would become it: the first keeps its name wherever it stands among the tools.
    for (const names of [
      [TABLE, "mcp_tides_table"],
      ["mcp_tides_table", TABLE],
    ]) {
      const r = rig(names, [{ toolCalls: [call("mcp_tides_table", { day: "today" }, "c1"), call("mcp_tides_table_2", { day: "tomorrow" }, "c2")] }, "Both read."]);
      const reply = await r.round();
      expect(offered(r.host.calls[0])).toEqual(names.map((name) => (name === TABLE ? "mcp_tides_table_2" : "mcp_tides_table")));
      expect(reply.calls.map((c) => [c.id, c.name])).toEqual([
        ["c1", "mcp_tides_table"],
        ["c2", TABLE],
      ]);
      r.ran(reply);
      await r.round();
      expect(carried(r.host.calls[1]?.messages)).toEqual(["mcp_tides_table", "mcp_tides_table_2"]);
      expect(offered(r.host.calls[1])).toEqual(offered(r.host.calls[0]));
    }
    // None a provider takes but one: the first of the others has the plain name, each after it the next number that no tool bears.
    const names = ["tides.table", "tides:table", "tides_table_2", "tides table"];
    const r = rig(names, [{ toolCalls: [call("tides_table"), call("tides_table_3"), call("tides_table_2"), call("tides_table_4")] }]);
    const reply = await r.round();
    expect(offered(r.host.calls[0])).toEqual(["tides_table", "tides_table_3", "tides_table_2", "tides_table_4"]);
    expect(reply.calls.map((c) => c.name)).toEqual(names);
  });

  test("a name longer than a provider takes is cut, and two the cut would make one are told apart within the length", async () => {
    // 70 characters each, alike through the first 64.
    const north = `tides_${"n".repeat(60)}_one`;
    const south = `tides_${"n".repeat(60)}_two`;
    expect([north.length, south.length]).toEqual([70, 70]);
    const r = rig([north, south], (request) => ({ toolCalls: (request.tools ?? []).map((t, i) => call(t.name, { day: `day ${i}` }, `c${i}`)) }));
    const reply = await r.round();
    const wire = offered(r.host.calls[0]);
    expect(wire).toEqual([north.slice(0, 64), `${north.slice(0, 62)}_2`]);
    expect(wire.map((name) => TAKEN.test(name))).toEqual([true, true]);
    expect(reply.calls.map((c) => [c.name, c.args])).toEqual([
      [north, { day: "day 0" }],
      [south, { day: "day 1" }],
    ]);
  });

  test("a name a provider takes goes out as it is, and so does the conversation", async () => {
    const names = ["lookup", "chat-read_2", "T", "x".repeat(64)];
    const r = rig(names, [{ toolCalls: names.map((name, i) => call(name, {}, `c${i}`)) }, "Read."]);
    const reply = await r.round();
    expect(r.host.calls[0]?.tools).toEqual(names.map(described));
    expect(reply.calls.map((c) => c.name)).toEqual(names);
    r.ran(reply);
    await r.round();
    expect(r.host.calls[1]?.messages.slice(1)).toEqual(r.conversation);
  });

  test("a call in the history whose tool the agent no longer has is made one a provider takes, and the conversation it stands in is left as it is", async () => {
    // 71 characters; and a name of nothing, and one with a character outside the basic plane, which is one character.
    const long = `harbour.${"ledger_".repeat(9)}`;
    const r = rig(["lookup"], ["Read."]);
    const earlier: AgentCall[] = [
      { id: "c1", name: "mcp:charts:depth", args: {} },
      { id: "c2", name: long, args: {} },
      { id: "c3", name: "", args: {} },
      { id: "c4", name: "tide\u{20000}table", args: {} },
      { id: "c5", name: "chat_read", args: { from: 0 } },
    ];
    // An assistant turn that came from elsewhere, whose text is its own and no rendering of its calls.
    const foreign: ModelMessage = { role: "assistant", content: "Soundings taken.", parts: [{ type: "tool_use", id: "c6", name: "mcp:charts:depth", input: { at: "the bar" } }] };
    r.conversation.push(NATIVE_TURNS.assistant({ text: "", raw: "", calls: earlier }), NATIVE_TURNS.results(earlier.map((made) => ({ call: made, text: "read", error: false })), new Texts()), foreign, { role: "user", content: "And the tide?" });
    const kept = structuredClone(r.conversation);
    await r.round();
    const sent = r.host.calls[0]?.messages ?? [];
    expect(carried(sent)).toEqual(["mcp_charts_depth", `harbour_${"ledger_".repeat(8)}`, "_", "tide_table", "chat_read", "mcp_charts_depth"]);
    expect(sent.at(-2)).toEqual({ role: "assistant", content: "Soundings taken.", parts: [{ type: "tool_use", id: "c6", name: "mcp_charts_depth", input: { at: "the bar" } }] });
    expect(r.conversation).toEqual(kept);
  });

  test("a call that names no tool comes to the loop as it was made, and one made under a tool's own name is that tool's", async () => {
    const table = recording(TABLE, "06:10 and 18:40");
    const { host, agent } = working([table], [{ toolCalls: [call("tide.chart", {}, "c1"), call(TABLE, { day: "today" }, "c2")] }, "High water at ten past six."]);
    await agent.send("When is high water?");
    expect(host.calls[1]?.messages.at(-1)?.parts).toEqual([
      { type: "tool_result", toolUseId: "c1", content: "There's no tool tide.chart. The tools are: mcp:tides:table, scratch_read. Call one of those.", isError: true },
      { type: "tool_result", toolUseId: "c2", content: "06:10 and 18:40" },
    ]);
    expect(table.runs).toEqual([{ day: "today" }]);
    // Whatever name a call was made under, it goes out again under one a provider takes.
    expect(carried(host.calls[1]?.messages)).toEqual(["tide_chart", "mcp_tides_table"]);
  });

  test("a call written as text where the tools are native names the tool as it was offered, or by its own name: either is the tool's", async () => {
    const r = rig([TABLE], ['<tool_call>{"name": "mcp_tides_table", "arguments": {"day": "today"}}</tool_call>', 'The other day too.\n<function=mcp:tides:table>{"day": "tomorrow"}</function>']);
    expect(await r.round()).toMatchObject({ written: true, text: "", calls: [{ id: "written_1", name: TABLE, args: { day: "today" } }] });
    expect(await r.round()).toMatchObject({ written: true, text: "The other day too.", calls: [{ id: "written_2", name: TABLE, args: { day: "tomorrow" } }] });
    expect(r.host.calls.map((request) => offered(request))).toEqual([["mcp_tides_table"], ["mcp_tides_table"]]);
  });

  test("as text a tool is offered, called and answered under its own name", async () => {
    const wrote = 'The table first.\n<tool_call>{"name": "mcp:tides:table", "arguments": {"day": "today"}}</tool_call>';
    const r = rig([TABLE], [wrote, "High water at ten past six."], { toolCalls: "text" });
    const reply = await r.round();
    expect(r.host.calls[0]?.tools).toBeUndefined();
    expect(promptText(r.host.calls[0])).toContain('mcp:tides:table: The mcp:tides:table tool.\nArguments (JSON Schema): {"type":"object"');
    expect(reply).toMatchObject({ text: "The table first.", written: true, calls: [{ name: TABLE, args: { day: "today" } }] });
    r.ran(reply);
    await r.round();
    expect(r.host.calls[1]?.messages.slice(-2)).toEqual([
      { role: "assistant", content: wrote },
      { role: "user", content: 'Results of your tool calls:\n\n<tool_result name="mcp:tides:table">\nmcp:tides:table read\n</tool_result>' },
    ]);
  });

  test("a call made natively stays one a provider takes in the history once the tools go as text", async () => {
    const r = rig([TABLE], [{ toolCalls: [call("mcp_tides_table", { day: "today" }, "c1")] }, "High water at ten past six."]);
    r.ran(await r.round());
    // The model behind the connection was seen refusing native tools: the next call offers them as text.
    const refused = rig([TABLE], ["High water at ten past six."], { toolCalls: "text" });
    refused.conversation.push(...r.conversation.slice(1));
    await refused.round();
    expect(refused.host.calls[0]?.tools).toBeUndefined();
    expect(carried(refused.host.calls[0]?.messages)).toEqual(["mcp_tides_table"]);
  });

  test("a breakpoint after the last tool stays on it under the name it goes by", async () => {
    const r = rig(["lookup", TABLE], ["Read."], { connectionId: "conn-cache" });
    r.host.profiles.push({ id: "conn-cache", name: "Cache", provider: "anthropic", model: "m", loopback: false, cache: { limit: 4, system: false, lastMessage: false, tools: false, automatic: false }, parallelTools: true });
    await r.round();
    expect(r.host.calls[0]?.tools).toEqual([described("lookup"), { ...described(TABLE), name: "mcp_tides_table", cache: true }]);
  });
});

describe("a failure that passes", () => {
  test("is read from the words of whoever reports it, in the error or its cause", () => {
    const passing = [
      "503: overloaded",
      "HTTP 502 Bad Gateway",
      "Request failed with status code 500",
      "Error: 429 Too Many Requests",
      "error code: 524",
      "rate_limit_exceeded: slow down",
      "overloaded_error",
      "The request timed out",
      "Gateway Timeout",
      "ETIMEDOUT",
      "read ECONNRESET",
      "socket hang up",
      "fetch failed",
      "terminated",
      "the stream was cut",
      "Stream ended unexpectedly",
      "RESOURCE_EXHAUSTED: quota exceeded for requests per minute",
      "The socket connection was closed unexpectedly",
      "Unable to connect. Is the computer able to access the url?",
      "ConnectionRefused",
      "Connection error.",
      "The operation timed out",
    ];
    for (const words of passing) expect({ words, passes: isTransient(new Error(words)) }).toEqual({ words, passes: true });
    expect(isTransient(new Error("the call failed", { cause: new Error("other side closed") }))).toBe(true);
  });

  test("a failure that would fail the same way again isn't one, whatever number it carries", () => {
    const lasting = [
      "401: the key was refused",
      "400: this model does not support tools",
      "400: max_tokens 512 is more than this model allows",
      "This model's maximum context length is 8192 tokens, and you asked for 8500",
      "429: You exceeded your current quota, please check your plan and billing details",
      "insufficient_quota",
      "402: payment required",
      "content policy: the request was refused",
      "the connection conn-gone no longer exists: give this agent another in LumiAH's Settings",
    ];
    for (const words of lasting) expect({ words, passes: isTransient(new Error(words)) }).toEqual({ words, passes: false });
  });
});

describe("a connection's calls at once", () => {
  const CONN = "conn-a";
  const limits = (every: number | null, own?: number): Settings["connections"] => ({ ...defaultSettings().connections, atOnce: every, throttles: own === undefined ? {} : { [CONN]: { requestsPerMinute: null, tokensPerMinute: null, atOnce: own } } });
  const open = new AbortController().signal;

  /** Accounts whose calls say when each got its place. */
  function line() {
    const accounts = new AgentAccounts(new MemoryHost());
    const got: string[] = [];
    const take = async (name: string, settings: Settings["connections"], signal: AbortSignal = open): Promise<() => void> => {
      const release = await accounts.atOnce(CONN, settings, signal);
      got.push(name);
      return release;
    };
    return { got, take };
  }

  test("never more than the limit hold a place, and a place freed goes to the call that waited longest", async () => {
    const { got, take } = line();
    const two = limits(2);
    const a = await take("a", two);
    const b = await take("b", two);
    const c = take("c", two);
    const d = take("d", two);
    await settle();
    expect(got).toEqual(["a", "b"]);
    a();
    // A call that comes just as a place frees never takes it ahead of the line.
    const e = take("e", two);
    await settle();
    expect(got).toEqual(["a", "b", "c"]);
    // A release frees its place once, however often it is called.
    a();
    await settle();
    expect(got).toEqual(["a", "b", "c"]);
    b();
    await settle();
    expect(got).toEqual(["a", "b", "c", "d"]);
    (await c)();
    (await d)();
    await settle();
    expect(got).toEqual(["a", "b", "c", "d", "e"]);
    (await e)();
  });

  test("a call whose signal aborts while it waits leaves the line and takes no place", async () => {
    const { got, take } = line();
    const one = limits(1);
    const a = await take("a", one);
    const gone = new AbortController();
    const b = take("b", one, gone.signal);
    const c = take("c", one);
    await settle();
    gone.abort(new Error("stopped while waiting"));
    await expect(b).rejects.toThrow("stopped while waiting");
    a();
    await settle();
    expect(got).toEqual(["a", "c"]);
    (await c)();
  });

  test("a connection's own limit stands in for every connection's; with none, nothing waits; and a limit raised lets the line through", async () => {
    const { got, take } = line();
    const a = await take("a", limits(5, 1));
    const b = take("b", limits(5, 1));
    await settle();
    expect(got).toEqual(["a"]);
    // Settings changed while b waits: the next call to come reads the new limit, and b goes first.
    const c = take("c", limits(5, 3));
    await settle();
    expect(got).toEqual(["a", "b", "c"]);
    for (const release of [a, await b, await c]) release();
    const free = line();
    for (const name of ["x", "y", "z"]) await free.take(name, limits(null));
    expect(free.got).toEqual(["x", "y", "z"]);
  });
});

describe("a prompt's order and its breakpoints", () => {
  test("the opening goes first as one system message; with no opening the conversation goes as it came", () => {
    const conversation = [{ role: "user" as const, content: "Hello?" }];
    expect(assemble({ nonce: null, prefix: ["Guidance."], system: "Instructions.", tools: null }, conversation, 0)).toEqual([{ role: "system", content: "Guidance.\n\nInstructions." }, ...conversation]);
    expect(assemble({ nonce: null, prefix: [], system: "", tools: null }, conversation, 4)).toEqual(conversation);
  });

  test("a connection's own caching counts against the provider's limit", () => {
    expect(ownBreakpoints({ limit: 4, system: true, lastMessage: true, tools: true, automatic: false }, 3)).toBe(3);
    expect(ownBreakpoints({ limit: 4, system: true, lastMessage: false, tools: true, automatic: false }, 0)).toBe(1);
  });
});

describe("the lexical index", () => {
  test("ranks what says the query's rarest words first, whatever their endings", () => {
    const index = new LexicalIndex<string>(600);
    index.add("a", "The boats came back at dusk with empty nets.");
    index.add("b", "Okoro counted the lamps and trimmed each wick.");
    index.add("c", "A boat without nets is only a hull.");
    expect(tokenize("The boats' nets")).toEqual(["boat", "net"]);
    expect(index.search("lamp wick").map((h) => h.key)).toEqual(["b"]);
    expect(new Set(index.search("boat nets").map((h) => h.key))).toEqual(new Set(["a", "c"]));
    expect(index.search("the and of")).toEqual([]);
  });

  test("a long text is indexed in pieces, and a hit shows the piece that matched", () => {
    const text = `${"The tide runs out over the flats. ".repeat(40)}\nBrann found the anchor under the third pier.\n${"The gulls wheel above the sheds. ".repeat(40)}`;
    const index = new LexicalIndex<number>(300);
    index.add(0, text);
    expect(index.count).toBeGreaterThan(5);
    const [hit] = index.search("anchor pier");
    expect(excerptOf(text, hit!.piece, 400)).toContain("Brann found the anchor under the third pier.");
    expect(excerptOf(text, hit!.piece, 30).length).toBeLessThanOrEqual(31);
  });
});
