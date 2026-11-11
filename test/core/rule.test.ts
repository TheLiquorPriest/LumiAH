// The owner's rule (DESIGN §3, §4.1): the agents decide their own steps. A tool runs only because a
// model called it, a model is called only by an agent's loop, and an agent is started only as an
// agent of a run. No code calls a tool or a model on an agent's behalf.
//
// Two kinds of test hold it. The first reads the core's source: the only places that run a tool,
// call a model or start an agent are the ones listed here, each with its reason, so new code that
// does any of it fails this file until someone adds it to the list and says why. The second runs
// turns with every tool wrapped: each run of a tool must answer a call a model made, and a turn
// whose models call nothing runs no tool, whatever the harness prepared for it.

import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { createHarness, type Harness } from "../../src/core/harness";
import type { TraceEvent } from "../../src/core/ports";
import { rollback } from "../../src/core/sessions";
import { defaultSettings, type Settings } from "../../src/core/settings";
import type { AgentTool, ToolDefinition, ToolEnv } from "../../src/core/tools";
import { call, MemoryHost, runTurn, type Script } from "./support/host";

const ROOT = resolve(import.meta.dir, "../..");
const CORE = join(ROOT, "src/core");

function files(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => (entry.isDirectory() ? files(join(dir, entry.name)) : entry.name.endsWith(".ts") ? [join(dir, entry.name)] : []));
}

/** A source file without its comments: what it says about a thing it doesn't do is no doing of it. */
function code(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
}

interface Site {
  file: string;
  line: string;
}

/** Every line of the given sources that `pattern` finds, with its file. */
function sites(sources: readonly { file: string; source: string }[], pattern: RegExp): Site[] {
  return sources.flatMap(({ file, source }) =>
    code(source)
      .split("\n")
      .filter((line) => pattern.test(line))
      .map((line) => ({ file, line: line.trim() })),
  );
}

/** One place the rule allows: its file, something its line holds, and why it is allowed. */
interface Allowed {
  file: string;
  holds: string;
  why: string;
}

/** The sites no entry of `allowed` covers, and the entries no site uses (an allowance left behind is a hole waiting for the wrong code). */
function unexplained(found: readonly Site[], allowed: readonly Allowed[]): { extra: Site[]; unused: Allowed[] } {
  const covers = (a: Allowed, s: Site): boolean => a.file === s.file && s.line.includes(a.holds);
  return { extra: found.filter((s) => !allowed.some((a) => covers(a, s))), unused: allowed.filter((a) => !found.some((s) => covers(a, s))) };
}

const SOURCES = files(CORE).map((path) => ({ file: relative(ROOT, path), source: readFileSync(path, "utf8") }));

/** Calls of anything's `run`: a tool's among them. A definition (`async run(`, `run(args`) is no call. */
const RUNS = /[\w\])?]\.run\(/;
const MODEL_CALLS = /\bmodels\??\.(call|stream)\(/;
const AGENT_STARTS = /\bstartAgent\(/;
const REMOTE_CALLS = /\b(tools|port)\??\.call\(/;

describe("the rule, read from the source", () => {
  test("the only place a tool is run is the loop, on a call the model's answer held", () => {
    const allowed: Allowed[] = [
      { file: "src/core/loop.ts", holds: "tool.run(call.args,", why: "the loop runs the tool a model's call names, with that call's arguments" },
      { file: "src/core/turn.ts", holds: "agent.run(this.signal)", why: "not a tool: the writer's loop, run on the conversation it was given" },
      { file: "src/core/turn.ts", holds: "shared.memo.run(key,", why: "not a tool: the memory of summaries already made" },
      { file: "src/core/harness.ts", holds: "shared.jobs.run(input, signal)", why: "not a tool: the host running a job that waits" },
      { file: "src/core/recall/recall.ts", holds: "Recall.of(env.host).run(env)", why: "not a tool: the run's own view of lore and history, made when one of its tools first asks for it" },
    ];
    expect(unexplained(sites(SOURCES, RUNS), allowed)).toEqual({ extra: [], unused: [] });
    // The loop's one run of a tool is reached only through a round's calls, and a round's calls are a model's answer's.
    const loop = code(SOURCES.find((s) => s.file === "src/core/loop.ts")?.source ?? "");
    expect(loop.match(/this\.runCall\(/g)).toHaveLength(1);
    expect(loop.match(/this\.runCalls\(/g)).toHaveLength(1);
    expect(loop).toContain("await this.runCalls(reply.calls,");
  });

  test("the only place a model is called is the provider session, which only an agent's loop holds", () => {
    const allowed: Allowed[] = [{ file: "src/core/provider.ts", holds: "host.models.call(request, signal,", why: "the provider session sends the call the loop prepared" }];
    expect(unexplained(sites(SOURCES, MODEL_CALLS), allowed)).toEqual({ extra: [], unused: [] });
    const sessions = sites(SOURCES, /new ProviderSession\(/);
    expect(sessions.map((s) => s.file)).toEqual(["src/core/loop.ts"]);
  });

  test("the only place an agent is started is a run starting one of its agents", () => {
    const allowed: Allowed[] = [
      { file: "src/core/loop.ts", holds: "export function startAgent(", why: "its definition" },
      { file: "src/core/run.ts", holds: "const agent = startAgent(", why: "Run.agent: how every agent of a turn, a job and a side session is started" },
    ];
    expect(unexplained(sites(SOURCES, AGENT_STARTS), allowed)).toEqual({ extra: [], unused: [] });
  });

  test("a tool that runs in the extension is reached only from inside that tool's own run", () => {
    const allowed: Allowed[] = [{ file: "src/core/definitions.ts", holds: "await port.call({ name: tool.name, args,", why: "the tool's run, which the loop calls for a model's call" }];
    expect(unexplained(sites(SOURCES, REMOTE_CALLS), allowed)).toEqual({ extra: [], unused: [] });
  });

  test("nothing starts a job except an agent's job_start call or the user on the page (DESIGN §15)", () => {
    // A job is made in one function, and its only callers are the job tools' side of a run (which only the job_start tool's run reaches) and the page's two requests.
    const made: Allowed[] = [
      { file: "src/core/jobs.ts", holds: "async createJob(input: JobCreate,", why: "its definition" },
      { file: "src/core/run.ts", holds: "started = await shared.jobs.createJob({ chatId: info.chatId, when, what, by: { who: \"agent\"", why: "JobTools.start: what the job_start tool's run calls, for a model's call" },
      { file: "src/core/harness.ts", holds: "what: { agent: input.agent, task: input.task }, by: { who: \"user\" }", why: "jobs.start: the user starts a job on the page" },
      { file: "src/core/harness.ts", holds: "what: { again: job.id }, by: { who: \"user\" }", why: "jobs.again: the user starts a job again on the page" },
    ];
    expect(unexplained(sites(SOURCES, /\bcreateJob\(/), made)).toEqual({ extra: [], unused: [] });
    // The job tools' start is set in one place (the run) and taken up in one: the job_start tool, whose run a model's call reaches.
    expect(sites(SOURCES, /\btools\.start = /).map((s) => s.file)).toEqual(["src/core/run.ts"]);
    expect(sites(SOURCES, /\bjobs\??\.start\b/).map((s) => `${s.file}: ${s.line}`)).toEqual(["src/core/tools/jobs.ts: const start = jobs?.start?.bind(jobs);"]);
    // And the host is told a job waits only by the jobs themselves: on a start, on a resume of one a restart left held, on a grant.
    expect([...new Set(sites(SOURCES, /\bjobs\??\.queued\(|\bport\.queued\(/).map((s) => s.file))]).toEqual(["src/core/jobs.ts"]);
  });

  test("these checks can fail: a tool run, a model call and an agent start outside the allowed places are found", () => {
    const rogue = [
      {
        file: "src/core/rogue.ts",
        source: [
          "// tool.run(args) in a comment is no call",
          "export async function prepare(env) {",
          "  const tool = registry.build(env)[0];",
          "  const found = await tool.run({ query: 'lamp' }, ctx);",
          "  const said = await host.models.call(request, signal);",
          "  const helper = startAgent(spec, deps);",
          "  await port.call({ name: 'harbour_tides' }, signal);",
          "}",
        ].join("\n"),
      },
    ];
    expect(sites(rogue, RUNS).map((s) => s.line)).toEqual(["const found = await tool.run({ query: 'lamp' }, ctx);"]);
    expect(sites(rogue, MODEL_CALLS)).toHaveLength(1);
    expect(sites(rogue, AGENT_STARTS)).toHaveLength(1);
    expect(sites(rogue, REMOTE_CALLS)).toHaveLength(1);
    expect(unexplained(sites(rogue, RUNS), []).extra).toHaveLength(1);
    expect(unexplained([], [{ file: "src/core/loop.ts", holds: "tool.run(", why: "left behind" }]).unused).toHaveLength(1);
  });
});

// ---------------------------------------------------------------- the rule, by what happens

const CHAT = "chat-1";

/** A run of a tool, as the wrapped tools saw it. */
interface Ran {
  tool: string;
  agentId: string;
  callId: string;
}

/**
 * A harness whose every tool written in code is wrapped: each run is noted before the tool does
 * anything. A tool is wrapped where the registry builds it, which is the only way an agent comes by
 * one, so nothing can run a tool around the note.
 */
function watched(script: Script, change: (s: Settings) => void = () => undefined) {
  const host = new MemoryHost();
  host.script = script;
  host.say(CHAT, "assistant", "The harbour is quiet tonight.");
  host.say(CHAT, "user", "I walk down to the lighthouse and knock.");
  const stored = { values: defaultSettings(), texts: {} as Record<string, string> };
  change(stored.values);
  const harness: Harness = createHarness(host, { settings: async () => structuredClone(stored) });
  const ran: Ran[] = [];
  const wrap = (definition: ToolDefinition): ToolDefinition => ({
    ...definition,
    build(env: ToolEnv): AgentTool | null {
      const tool = definition.build(env);
      if (!tool) return null;
      return {
        ...tool,
        run: (args, ctx) => {
          ran.push({ tool: tool.name, agentId: ctx.agentId, callId: ctx.callId });
          return tool.run(args, ctx);
        },
      };
    },
  });
  harness.tools.register(...harness.tools.all().map(wrap));
  return { host, harness, stored, ran, turn: (options: Parameters<typeof runTurn>[3] = {}) => runTurn(host, harness, CHAT, options) };
}

/** Every call a model made, by the agent whose answer held it: what the trace says a model asked for. */
function asked(events: readonly TraceEvent[]): Set<string> {
  const calls = new Set<string>();
  for (const event of events) if (event.kind === "agent_entry" && event.entry.kind === "answer") for (const made of event.entry.calls) calls.add(`${event.agentId}/${made.id}/${made.name}`);
  return calls;
}

const mainCalls = (request: { tools?: readonly { name: string }[] }): boolean => request.tools?.some((t) => t.name === "write_reply") === true;

describe("the rule, by what happens", () => {
  test("a turn whose models call nothing runs no tool, whatever was prepared for it: guidance, pinned files, its notes and a summary of them", async () => {
    // Every model answers with text alone: the main agent's answer goes to the writer in the brief's place, the summarizer summarizes, the writer writes.
    const r = watched((request) => (request.messages[0]?.content.startsWith("You keep a main agent's notes short.") ? "The door has stayed shut." : mainCalls(request) ? "Nothing new to add." : "The lamp turns."), (s) => {
      s.session = { ...s.session, summarizeAtTokens: 60, keepTurns: 1 };
    });
    // The user wrote guidance and pinned a file for the main agent.
    await r.harness.guidance.set({ chatId: CHAT, level: "user", text: "Keep replies short.", base: null });
    const { file } = await r.harness.workspace.write({ chatId: CHAT, area: "learned", path: "who.md", text: "Okoro keeps the lighthouse.", base: null });
    await r.harness.workspace.pin({ chatId: CHAT, area: "learned", path: "who.md", on: true });
    expect(file.path).toBe("who.md");
    for (const said of ["I knock.", "I wait.", "I call out.", "I go home."]) {
      await r.turn();
      r.host.say(CHAT, "user", said);
    }
    const last = await r.turn();
    expect(last.result.status).toBe("done");
    // The turns did carry what was prepared: the guidance, the pinned file, the notes and a summary of them.
    const main = r.host.calls.findLast(mainCalls);
    expect(main?.messages[0]?.content).toContain("Keep replies short.");
    expect(main?.messages.at(-1)?.content).toContain("Okoro keeps the lighthouse.");
    expect(r.host.calls.some((c) => c.messages[0]?.content.startsWith("You keep a main agent's notes short."))).toBe(true);
    // And no tool ran, in any of them: no model called one.
    expect(asked(r.host.traced.map((t) => t.event)).size).toBe(0);
    expect(r.ran).toEqual([]);
  });

  test("every run of a tool answers a call a model made: the same agent, the same call, the same tool, and nothing more", async () => {
    const script: Script = (request, n) => {
      const first = request.messages.at(-1)?.content ?? "";
      // The summarizer, delegated to: it reads the chat, then answers.
      if (request.messages[0]?.content.includes("You summarize for another agent.")) return request.messages.length > 2 ? "The harbour is quiet; Mara knocks." : { toolCalls: [call("chat_read", { from: 0, to: 1 }, `sub_${n}`)] };
      if (!mainCalls(request)) return "The door opens.";
      if (request.messages.length <= 2 && first !== "") {
        // The main agent's first round: three tools at once, one of them a delegation.
        return { toolCalls: [call("chat_search", { query: "lighthouse" }, "m1"), call("workspace_write", { path: "learned/notes.md", content: "Okoro keeps the lighthouse.", base: "new" }, "m2"), call("delegate", { agent: "summarizer", task: "Summarize the chat so far." }, "m3")] };
      }
      return { toolCalls: [call("write_reply", { brief: "Okoro opens the door." }, "m4")] };
    };
    const r = watched(script);
    const { result } = await r.turn();
    expect(result).toMatchObject({ status: "done", reply: "The door opens." });
    const made = asked(r.host.traced.map((t) => t.event));
    expect(r.ran.map((run) => run.tool).sort()).toEqual(["chat_read", "chat_search", "delegate", "workspace_write", "write_reply"]);
    for (const run of r.ran) expect(made.has(`${run.agentId}/${run.callId}/${run.tool}`)).toBe(true);
    // Each call a model made was run once, and no tool ran twice for one call.
    expect(r.ran.length).toBe(made.size);
    expect(new Set(r.ran.map((run) => `${run.agentId}/${run.callId}`)).size).toBe(r.ran.length);
  });

  test("what the user does on the page runs no tool and calls no model: writing files, pinning, reading guidance and definitions, rolling back, asking for a summary", async () => {
    const r = watched([{ toolCalls: [call("write_reply", { brief: "Okoro opens the door." }, "m1")] }, "The door opens."]);
    await r.turn();
    const calls = r.host.calls.length;
    const ran = r.ran.length;
    await r.harness.workspace.write({ chatId: CHAT, area: "chat", path: "plan.md", text: "Ask about the lamp.", base: null });
    await r.harness.workspace.list({ chatId: CHAT, area: "chat" });
    await r.harness.guidance.get({ chatId: CHAT });
    await r.harness.definitions.get({ chatId: CHAT });
    await r.harness.jobs.list({ chatId: CHAT, cursor: null, limit: 10 });
    await r.harness.session.summarize({ chatId: CHAT });
    const reply = r.host.last(CHAT);
    await rollback(r.host, CHAT, reply.id, reply.swipeId);
    await r.harness.spend.get({ days: 1 });
    expect(r.host.calls.length).toBe(calls);
    expect(r.ran.length).toBe(ran);
  });

  test("a job is queued only when a model calls job_start or the user starts one: a turn that calls no such tool queues none, whatever else it does", async () => {
    // A busy turn with no job_start in it: tools, a delegation, a reply.
    const quiet = watched((request, n) => {
      if (request.messages[0]?.content.includes("You summarize for another agent.")) return "The harbour is quiet.";
      if (!mainCalls(request)) return "The door opens.";
      return n === 0 ? { toolCalls: [call("chat_search", { query: "lighthouse" }, "m1"), call("delegate", { agent: "summarizer", task: "Summarize the chat so far." }, "m2")] } : { toolCalls: [call("write_reply", { brief: "Okoro opens the door." }, "m3")] };
    });
    expect((await quiet.turn()).result.status).toBe("done");
    expect(quiet.host.queued).toEqual([]);
    // A model's job_start call queues exactly one, recorded as that agent's.
    const asked = watched((request, n) => (!mainCalls(request) ? "The door opens." : n === 0 ? { toolCalls: [call("job_start", { agent: "summarizer", task: "Tidy the notes.", when: "after_reply" }, "j1")] } : { toolCalls: [call("write_reply", { brief: "Okoro opens the door." }, "m2")] }));
    expect((await asked.turn()).result.status).toBe("done");
    expect(asked.host.queued.map((job) => [job.agent, job.by.who, job.state])).toEqual([["summarizer", "agent", "queued"]]);
    expect(asked.ran.filter((run) => run.tool === "job_start")).toHaveLength(1);
    // The user's start on the page queues one, recorded as the user's; nothing else did.
    const { job } = await asked.harness.jobs.start({ chatId: CHAT, agent: "summarizer", task: "Tidy the notes again.", when: "now" });
    expect(job.by).toEqual({ who: "user" });
    expect(asked.host.queued.map((queued) => queued.by.who)).toEqual(["agent", "user"]);
  });
});
