// Jobs (DESIGN §15) and a long objective (§22) on an in-memory host and a scripted model: how a job
// comes to be and that nothing else makes one, how the host runs it and what keeps it within its
// limits, what the user and the agents can do with it, what a swipe, an edit and a restart do to it,
// and a job the user starts: its allowance, its plan, what it may write, and how it is carried on.

import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { createHarness, type Harness, type StoredState } from "../../src/core/harness";
import type { ModelRequest, TraceEvent } from "../../src/core/ports";
import { HarnessRefusal } from "../../src/core/refusal";
import { recordOf } from "../../src/core/sessions";
import { defaultSettings, newAgentSettings, type Settings } from "../../src/core/settings";
import { type Answer, call, idle, MemoryHost, runTurn, type Script, until } from "./support/host";

const CHAT = "chat-1";
const TASK = "Read the whole chat and note who holds the lighthouse key.";

/** A host with a short chat, and a harness over it whose settings and texts the test changes; `options` makes a second harness over the same host, as a restart does. */
function rig(script: Script, change: (s: Settings) => void = () => undefined) {
  const host = new MemoryHost();
  host.script = script;
  host.say(CHAT, "assistant", "The harbour is quiet tonight.");
  host.say(CHAT, "user", "I walk down to the lighthouse and knock.");
  const stored: StoredState & { values: Settings; texts: Record<string, string> } = { values: defaultSettings(), texts: {} };
  change(stored.values);
  const options = { settings: async () => structuredClone(stored) };
  const harness = createHarness(host, options);
  return { host, harness, stored, options, turn: (o: Parameters<typeof runTurn>[3] = {}) => runTurn(host, harness, CHAT, o) };
}

/** The first message of an agent's conversation, as a call sent it: a job's opens as a job's does, whichever run of the job makes the call. */
const firstUser = (request: ModelRequest): string => request.messages.find((m) => m.role === "user")?.content ?? "";
const isJob = (request: ModelRequest): boolean => firstUser(request).startsWith("You are running as a job");
const events = (host: MemoryHost): TraceEvent[] => host.traced.map((r) => r.event);

/** One scripted answer, or what gives it when its call is made (a promise, for a call the test answers when it will). */
type Step = Answer | ((request: ModelRequest) => Answer | Promise<Answer>);

/** A script that answers each caller from its own list, in the order its calls are made: a job's agent, a turn's main agent (the caller with tools that is no job), and the writer (it has none). */
function cast(lines: { main?: Step[]; job?: Step[]; writer?: Step[] }): Script {
  const next = { main: 0, job: 0, writer: 0 };
  return (request) => {
    const who = isJob(request) ? "job" : request.tools ? "main" : "writer";
    const step = lines[who]?.[next[who]++];
    if (step === undefined) {
      if (who === "writer") return "The door opens.";
      throw new Error(`no answer scripted for the ${who}'s call ${next[who]}`);
    }
    return typeof step === "function" ? step(request) : step;
  };
}

/** What a model was told a tool call came to: the call's result, as the request after it held it. */
function resultOf(host: MemoryHost, callId: string): { content: string; isError: boolean } | null {
  for (const request of host.calls) {
    for (const m of request.messages) {
      for (const part of m.parts ?? []) if (part.type === "tool_result" && part.toolUseId === callId) return { content: part.content, isError: part.isError === true };
    }
  }
  return null;
}

/** What a request of the page was refused with. */
async function refusal(asked: Promise<unknown>): Promise<{ code: string; message: string }> {
  try {
    await asked;
  } catch (error) {
    if (error instanceof HarnessRefusal) return { code: error.code, message: error.message };
    throw error;
  }
  throw new Error("the request wasn't refused");
}

const never = new AbortController().signal;
const reply = call("write_reply", { brief: "Okoro opens the door." }, "w1");
/** A turn whose main agent starts one job for the summarizer and then has the reply written. */
const starting: Step[] = [{ toolCalls: [call("job_start", { agent: "summarizer", task: TASK }, "c1")] }, { toolCalls: [reply] }];
/** The summarizer reads only, by default: a job that writes files is given the tool to. */
const writing = (s: Settings): void => void s.agents.summarizer!.tools.push("workspace_write");

describe("starting and running a job", () => {
  test("a main agent's job_start call queues a job: the host is told once, the answer names it, the turn's record lists it, the trace has it, and nothing runs", async () => {
    const r = rig(cast({ main: starting }));
    const { result, request } = await r.turn();
    expect(r.host.queued).toHaveLength(1);
    const job = r.host.queued[0]!;
    expect(job).toMatchObject({ chatId: CHAT, agent: "summarizer", task: TASK, when: "after_reply", state: "queued", by: { who: "agent", role: "main" }, basis: request.generationId });
    expect(resultOf(r.host, "c1")).toEqual({ content: `Started job ${job.id} (summarizer): it runs once this turn's reply is written. You are told how its report opens at your next turn; job_read reads it sooner, and job_cancel stops it.`, isError: false });
    expect(result.record?.jobs).toEqual([{ id: job.id, agent: "summarizer", state: "queued" }]);
    expect(events(r.host).flatMap((e) => (e.kind === "job" ? [e.job.id] : []))).toEqual([job.id]);
    // Nothing runs until the host says so: no call of the job's was made, and the job still waits.
    await idle();
    expect(r.host.calls).toHaveLength(3);
    expect(r.host.calls.some(isJob)).toBe(false);
    expect(r.host.jobChanges).toEqual([]);
    expect((await r.harness.jobs.read({ id: job.id })).job.state).toBe("queued");
  });

  test("jobs.run runs it: its agent is given the task, its report is a blob, it ends done with what it spent, the host hears each change, and the turn's record lists it done", async () => {
    const r = rig(cast({ main: starting, job: [{ toolCalls: [call("chat_search", { query: "lighthouse" }, "j1")], usage: { prompt_tokens: 500, completion_tokens: 40 } }, { content: "Okoro keeps the key.", usage: { prompt_tokens: 700, completion_tokens: 60 } }] }));
    await r.turn();
    const { id } = r.host.queued[0]!;
    const job = await r.harness.jobs.run({ id }, never);
    const asked = r.host.calls.filter(isJob);
    expect(asked).toHaveLength(2);
    expect(firstUser(asked[0]!)).toStartWith(`You are running as a job: work started from a chat that goes on after its reply was written. Nobody is waiting on you and nobody reads along. Your task:\n\n${TASK}\n\n`);
    expect(job).toMatchObject({ id, state: "done", reportChars: 20, opening: "Okoro keeps the key.", usage: { calls: 2, toolTurns: 1, in: 1200, out: 100 } });
    expect(r.host.blobStore.get(job.report ?? "")).toBe("Okoro keeps the key.");
    expect(r.host.jobChanges.map((j) => [j.id, j.state])).toEqual([[id, "running"], [id, "done"]]);
    // Its own trace, under its id: one agent, the definition it runs as, from its start to its end.
    const traced = r.host.traced.filter((t) => t.turn === id).map((t) => t.event);
    expect(traced[0]).toMatchObject({ kind: "turn_started", generation: "job", job: id });
    expect(traced.flatMap((e) => (e.kind === "agent_started" ? [[e.agent.role, e.agent.task]] : []))).toEqual([["summarizer", TASK]]);
    expect(traced.at(-1)).toMatchObject({ kind: "turn_ended", status: "done" });
    // The record on the reply's message is written again with the job as it ended.
    await until(() => recordOf(r.host.last(CHAT).anchors[0])?.jobs?.[0]?.state === "done");
    expect(recordOf(r.host.last(CHAT).anchors[0])?.jobs).toEqual([{ id, agent: "summarizer", state: "done", report: job.report ?? "" }]);
  });

  test("a now job runs beside its turn: what it writes, the turn's own agent then reads, and the turn's record lists it as it ended", async () => {
    const second = Promise.withResolvers<Answer>();
    const r = rig(
      cast({
        main: [{ toolCalls: [call("job_start", { agent: "summarizer", task: TASK, when: "now" }, "c1")] }, () => second.promise, { toolCalls: [reply] }],
        job: [{ toolCalls: [call("workspace_write", { path: "/notes/key.md", content: "Brann holds the key.", base: "new" }, "j1")] }, "I wrote /notes/key.md."],
      }),
      writing,
    );
    const turning = r.turn();
    await until(() => r.host.queued.length === 1);
    expect(r.host.queued[0]).toMatchObject({ when: "now", state: "queued" });
    expect(resultOf(r.host, "c1")?.content).toContain("it runs now, beside this turn");
    // The host runs it while the turn's main agent still waits for its next answer.
    const job = await r.harness.jobs.run({ id: r.host.queued[0]!.id }, never);
    expect(job.state).toBe("done");
    expect(resultOf(r.host, "j1")?.isError).toBe(false);
    second.resolve({ toolCalls: [call("workspace_read", { path: "/notes/key.md" }, "m2")] });
    const { result } = await turning;
    expect(resultOf(r.host, "m2")).toEqual({ content: "[/notes/key.md: characters 0 to 20 of 20, version 7c5ba9a961e8. A write, an edit, a move or a delete of this file takes that version as base.]\nBrann holds the key.", isError: false });
    expect(result.record?.jobs).toEqual([{ id: job.id, agent: "summarizer", state: "done", report: job.report ?? "" }]);
    expect(result.record?.changed).toBe(1);
    expect((await r.harness.workspace.changes({ chatId: CHAT, messageId: r.host.last(CHAT).id, swipe: 0 })).changes).toMatchObject([{ path: "notes/key.md", before: null, by: { who: "job", id: job.id } }]);
  });
});

// ---------------------------------------------------------------- the rule, read from the source

const ROOT = resolve(import.meta.dir, "../..");
const CORE = join(ROOT, "src/core");

function files(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => (entry.isDirectory() ? files(join(dir, entry.name)) : entry.name.endsWith(".ts") ? [join(dir, entry.name)] : []));
}

interface Source {
  path: string;
  source: string;
}

const sources: Source[] = files(CORE).map((path) => ({ path: relative(ROOT, path), source: readFileSync(path, "utf8") }));

/** Words that open a block and name nothing. */
const KEYWORDS: readonly string[] = ["if", "for", "while", "switch", "catch", "return", "await", "else", "try", "do", "new", "throw"];

/** The name a line gives the block it opens: a class, a function, a variable or a member assigned one, a property, a method; null for a line that names none (an `if`, a `try`, a `return {`). */
function nameOf(line: string): string | null {
  const t = line.trim();
  const named =
    /^(?:export\s+)?(?:abstract\s+)?class\s+(\w+)/.exec(t) ??
    /^(?:export\s+)?(?:async\s+)?function\s*\*?\s*(\w+)/.exec(t) ??
    /^(?:export\s+)?(?:const|let|var)\s+(\w+)\b[^=]*=/.exec(t) ??
    /^(?:[\w.]+\.)?(\w+)\s*=\s*(?:async\b|\(|function\b)/.exec(t) ??
    /^(\w+)\s*:/.exec(t) ??
    /^(?:(?:public|private|protected|static|override|async|readonly|get|set)\s+)*(\w+)\s*(?:<[^>]*>)?\(/.exec(t);
  const name = named?.[1] ?? null;
  return name !== null && !KEYWORDS.includes(name) ? name : null;
}

/**
 * Every line of a source that `pattern` matches, as `path: Outer.inner`: the named blocks the line
 * stands in, outermost first, its own where it opens one (a method's declaration). Comments are left
 * out: what one says about starting a job starts none. The core is formatted, so the block a line
 * stands in is opened by the nearest line above it with less indent.
 */
function sitesOf({ path, source }: Source, pattern: RegExp): string[] {
  const lines = source
    .replace(/\/\*[\s\S]*?\*\//g, (comment) => comment.replace(/[^\n]/g, ""))
    .replace(/^\s*\/\/.*$/gm, "")
    .split("\n");
  const indentOf = (line: string): number => line.length - line.trimStart().length;
  return lines.flatMap((line, at) => {
    if (!pattern.test(line)) return [];
    const own = line.trimEnd().endsWith("{") ? nameOf(line) : null;
    const within: string[] = own !== null ? [own] : [];
    let indent = indentOf(line);
    for (let i = at - 1; i >= 0 && indent > 0; i--) {
      const above = lines[i] ?? "";
      if (above.trim() === "" || indentOf(above) >= indent) continue;
      indent = indentOf(above);
      const name = nameOf(above);
      if (name !== null) within.unshift(name);
    }
    return [`${path}: ${within.join(".")}`];
  });
}

/** The one function that makes a job, wherever the code names it: a call, or a reference kept for one. */
const MAKES = /\bcreateJob\b/;
/** A call that tells the host a job waits: `queued` on the jobs port. A class's call of a method of its own by that name (`this.queued(`) is no such call. */
const TELLS = /(?<!\bthis)\??\.queued\s*\(/;
/** The run's `start`, reached on the jobs a tool is built with. */
const STARTS = /\bjobs\s*\??\.\s*start\b/;

describe("nothing starts a job except an agent's job_start call or the user", () => {
  test("the test reads the core's files", () => {
    expect(sources.length).toBeGreaterThan(30);
    expect(sources.map((s) => s.path)).toContain("src/core/jobs.ts");
  });

  test("createJob is named in four places: where it is declared, the job_start tool's side of a run, and the user's start and start-again", () => {
    const allowed: Record<string, string> = {
      "src/core/jobs.ts: Jobs.createJob": "its own declaration: the one function that makes a job",
      "src/core/run.ts: Run.jobTools.start": "the run's side of the job_start tool: what an agent's job_start call reaches",
      "src/core/harness.ts: createHarness.jobs.start": "the user starts a job on the page",
      "src/core/harness.ts: createHarness.jobs.again": "the user starts a job that stopped short again",
    };
    expect(sources.flatMap((s) => sitesOf(s, MAKES)).sort()).toEqual(Object.keys(allowed).sort());
  });

  test("the host is told a job waits in three places: where one is made, and where the user carries on one they already started", () => {
    const allowed: Record<string, string> = {
      "src/core/jobs.ts: Jobs.createJob": "a job was made",
      "src/core/jobs.ts: Jobs.grant": "no new job: the user granted more to one that stopped at its allowance, and it waits to run again",
      "src/core/jobs.ts: Jobs.resumeWaiting": "no new job: the user resumed one a restart had found held, and it waits to run again",
    };
    expect(sources.flatMap((s) => sitesOf(s, TELLS)).sort()).toEqual(Object.keys(allowed).sort());
  });

  test("the run's start has one caller, the job_start tool, and is made in one place, for the one agent a run builds tools for", () => {
    expect(sources.flatMap((s) => sitesOf(s, STARTS))).toEqual(["src/core/tools/jobs.ts: jobStart.build"]);
    expect(sources.flatMap((s) => sitesOf(s, /\bjobTools\s*\(/)).sort()).toEqual(["src/core/run.ts: Run.agent", "src/core/run.ts: Run.jobTools"]);
  });

  test("the scan can fail: a call from anywhere else is found, in a new file and in a file that has an allowed one", () => {
    const sneak: Source = { path: "src/core/sneak.ts", source: ["export class Sneak {", "  async later(shared: Shared): Promise<void> {", "    // createJob( in a comment starts nothing", '    await shared.jobs.createJob({ chatId: "chat-1" }, setup);', "  }", "}"].join("\n") };
    expect(sitesOf(sneak, MAKES)).toEqual(["src/core/sneak.ts: Sneak.later"]);
    const inside: Source = { path: "src/core/jobs.ts", source: ["export class Jobs {", "  async recover(): Promise<void> {", "    for (const id of ids) {", "      const make = this.createJob;", "      this.host.jobs?.queued(job);", "    }", "  }", "}"].join("\n") };
    expect(sitesOf(inside, MAKES)).toEqual(["src/core/jobs.ts: Jobs.recover"]);
    expect(sitesOf(inside, TELLS)).toEqual(["src/core/jobs.ts: Jobs.recover"]);
    // A class that queues work of its own under that name tells no host of a job.
    expect(sitesOf({ path: "src/core/spend.ts", source: "export class Spend {\n  flush(): Promise<void> {\n    return this.queued(async () => undefined);\n  }\n}" }, TELLS)).toEqual([]);
  });

  test("by behaviour: a turn that only reads, one that fails, one that is stopped and a restart leave no job", async () => {
    const none = async (host: MemoryHost, harness: Harness): Promise<void> => {
      expect(host.queued).toEqual([]);
      expect([...host.documents.keys()].filter((path) => path.startsWith("jobs/") || path.endsWith("/jobs.json"))).toEqual([]);
      expect((await harness.jobs.list({ chatId: CHAT, cursor: null, limit: 10 })).jobs).toEqual([]);
    };
    const reads = rig(cast({ main: [{ toolCalls: [call("chat_search", { query: "lighthouse" }), call("workspace_list", {}), call("job_list", {}, "l1")] }, { toolCalls: [reply] }] }));
    expect((await reads.turn()).result.status).toBe("done");
    expect(resultOf(reads.host, "l1")).toEqual({ content: "This chat has no jobs.", isError: false });
    await none(reads.host, reads.harness);

    const fails = rig(cast({ main: [{ error: "401: the key was refused" }] }), (s) => (s.reply.withoutBrief = "fail"));
    expect((await fails.turn()).result.status).toBe("failed");
    await none(fails.host, fails.harness);

    const stopped = rig(cast({ main: [{ hang: true }] }));
    const stop = new AbortController();
    const turning = stopped.turn({ signal: stop.signal });
    await until(() => stopped.host.calls.length === 1);
    stop.abort();
    expect((await turning).result.status).toBe("stopped");
    await none(stopped.host, stopped.harness);

    // A restart: a second harness over what the first left looks for jobs to carry on, and finds none.
    const restarted = createHarness(reads.host, reads.options);
    expect(await restarted.jobs.recover()).toEqual({ interrupted: [], paused: [], queued: [] });
    await none(reads.host, restarted);
  });
});

describe("limits", () => {
  test("jobs switched off: no job tool is offered, the user's start is refused, and a job that waited isn't run", async () => {
    const r = rig(cast({ main: [{ toolCalls: [reply] }] }));
    const waiting = (await r.harness.jobs.start({ chatId: CHAT, agent: "summarizer", task: TASK, when: "now" })).job;
    r.stored.values.jobs.enabled = false;
    await r.turn();
    expect(r.host.calls[0]?.tools?.map((t) => t.name).filter((name) => name.startsWith("job_"))).toEqual([]);
    expect(await refusal(r.harness.jobs.start({ chatId: CHAT, agent: "summarizer", task: TASK, when: "now" }))).toEqual({ code: "invalid", message: "Not started: jobs are switched off in Settings (Jobs). Do the work in this turn, or leave it." });
    expect(await r.harness.jobs.run({ id: waiting.id }, never)).toMatchObject({ state: "cancelled", reason: "jobs were switched off in Settings before it ran" });
    expect(r.host.calls.some(isJob)).toBe(false);
  });

  test("Jobs per turn: a start past it is refused, in the same answer as the last one allowed and in a later one", async () => {
    const one = (task: string, id: string) => call("job_start", { agent: "summarizer", task }, id);
    const r = rig(cast({ main: [{ toolCalls: [one("One.", "a"), one("Two.", "b")] }, { toolCalls: [one("Three.", "c")] }, { toolCalls: [reply] }] }), (s) => (s.jobs.perRun = 1));
    const { result } = await r.turn();
    const refused = { content: "Not started: this turn has started the 1 job it may (Jobs per turn).", isError: true };
    expect(resultOf(r.host, "a")?.isError).toBe(false);
    expect(resultOf(r.host, "b")).toEqual(refused);
    expect(resultOf(r.host, "c")).toEqual(refused);
    expect(r.host.queued.map((job) => job.task)).toEqual(["One."]);
    expect(result.record?.jobs).toHaveLength(1);
  });

  test("Task length: a longer task is refused, an agent's and the user's", async () => {
    const r = rig(cast({ main: [{ toolCalls: [call("job_start", { agent: "summarizer", task: "x".repeat(101) }, "a")] }, { toolCalls: [reply] }] }), (s) => (s.jobs.taskChars = 100));
    await r.turn();
    const words = "Not started: the task is 101 characters, and a task may be 100 at most (Task length). Put the details in a workspace file and name the file in a shorter task.";
    expect(resultOf(r.host, "a")).toEqual({ content: words, isError: true });
    expect(await refusal(r.harness.jobs.start({ chatId: CHAT, agent: "summarizer", task: "x".repeat(101), when: "now" }))).toEqual({ code: "invalid", message: words });
    expect(r.host.queued).toEqual([]);
  });

  test("an agent that is no worker: an agent's job goes to neither the main agent nor the writer, the user's to any agent but the writer", async () => {
    const r = rig(cast({ main: [{ toolCalls: [call("job_start", { agent: "main", task: TASK }, "a"), call("job_start", { agent: "writer", task: TASK }, "b")] }, { toolCalls: [reply] }] }));
    await r.turn();
    // The core's own workers, in the order it registers them: the summarizer first.
    const workers = r.harness.agents.all().flatMap((d) => (d.id === "main" || d.id === "writer" ? [] : [d.id])).join(", ");
    expect(workers).toStartWith("summarizer");
    expect(resultOf(r.host, "a")).toEqual({ content: `Not started: there's no agent main a job can run as. A job can run as: ${workers}.`, isError: true });
    expect(resultOf(r.host, "b")).toEqual({ content: `Not started: there's no agent writer a job can run as. A job can run as: ${workers}.`, isError: true });
    expect(await refusal(r.harness.jobs.start({ chatId: CHAT, agent: "writer", task: TASK, when: "now" }))).toEqual({ code: "invalid", message: `Not started: there's no agent writer a job can run as. A job can run as: main, ${workers}.` });
    expect(r.host.queued).toEqual([]);
  });

  test("a host without a jobs port: no job tool is offered, and the user's start is refused as unavailable", async () => {
    const r = rig(cast({ main: [{ toolCalls: [reply] }] }));
    r.host.jobs = undefined;
    await r.turn();
    expect(r.host.calls[0]?.tools?.map((t) => t.name).filter((name) => name.startsWith("job_"))).toEqual([]);
    expect(await refusal(r.harness.jobs.start({ chatId: CHAT, agent: "summarizer", task: TASK, when: "now" }))).toEqual({ code: "unavailable", message: "This runtime can't run jobs." });
  });

  test("Jobs at once: at 1 a second job waits until the first ends; at 2 they run together", async () => {
    const start = async (harness: Harness, task: string) => (await harness.jobs.start({ chatId: CHAT, agent: "summarizer", task, when: "now" })).job.id;
    const first = Promise.withResolvers<Answer>();
    const r = rig(cast({ job: [() => first.promise, "Two is done."] }));
    const [one, two] = [await start(r.harness, "One."), await start(r.harness, "Two.")];
    const a = r.harness.jobs.run({ id: one }, never);
    const b = r.harness.jobs.run({ id: two }, never);
    await until(() => r.host.calls.length === 1);
    await idle();
    expect(r.host.calls).toHaveLength(1);
    expect((await r.harness.jobs.read({ id: two })).job.state).toBe("queued");
    first.resolve("One is done.");
    expect([(await a).state, (await b).state]).toEqual(["done", "done"]);
    expect(r.host.jobChanges.map((j) => [j.task, j.state])).toEqual([["One.", "running"], ["One.", "done"], ["Two.", "running"], ["Two.", "done"]]);

    const held = Promise.withResolvers<Answer>();
    // Two jobs run at once here, so which makes the first call isn't the test's to choose: each is answered by its task, never by the order of the calls.
    const byTask = (request: ModelRequest): Answer | Promise<Answer> => (firstUser(request).includes("One.") ? held.promise : "Two is done.");
    const wide = rig(cast({ job: [byTask, byTask] }), (s) => (s.jobs.atOnce = 2));
    const [three, four] = [await start(wide.harness, "One."), await start(wide.harness, "Two.")];
    const c = wide.harness.jobs.run({ id: three }, never);
    // The second ends while the first still waits for its answer.
    expect((await wide.harness.jobs.run({ id: four }, never)).state).toBe("done");
    expect((await wide.harness.jobs.read({ id: three })).job.state).toBe("running");
    held.resolve("One is done.");
    expect((await c).state).toBe("done");
  });

  test("a job's own budget: Tool rounds per job stops a job that keeps calling tools, and it ends spent with a report LumiAH writes", async () => {
    let n = 0;
    const r = rig(cast({ main: starting, job: Array.from({ length: 3 }, () => () => ({ content: `Looking, ${n}.`, toolCalls: [call("chat_search", { query: `try ${n++}` })] })) }), (s) => (s.jobs.budget.toolTurns = 1));
    await r.turn();
    const job = await r.harness.jobs.run({ id: r.host.queued[0]!.id }, never);
    const why = "the job's agents have had its 1 round of tool calls (Tool rounds per job)";
    expect(job).toMatchObject({ state: "spent", reason: why, usage: { calls: 2, toolTurns: 1 } });
    expect(r.host.calls.filter(isJob)).toHaveLength(2);
    // An agent's job was asked for no plan, so its report names none.
    expect((await r.harness.jobs.read({ id: job.id })).report).toBe(`Stopped at its allowance: ${why}.\nIt had last written: Looking, 1.\nGranted more, it carries on from where it stopped.`);
  });

  test("Job tokens per day: once jobs have spent it, the next job stops at its first call with nothing lost, never failed", async () => {
    // The limit leaves room for a job's first prompt (a cap is asked about the call about to be made too); what that call then reports takes the day past it.
    const r = rig(cast({ job: [{ content: "One is done.", usage: { prompt_tokens: 9900, completion_tokens: 200 } }] }), (s) => (s.jobs.tokensPerDay = 10_000));
    const one = (await r.harness.jobs.start({ chatId: CHAT, agent: "summarizer", task: "One.", when: "now" })).job;
    const two = (await r.harness.jobs.start({ chatId: CHAT, agent: "summarizer", task: "Two.", when: "now" })).job;
    expect((await r.harness.jobs.run({ id: one.id }, never)).state).toBe("done");
    const why = "what jobs sent and wrote in the last 24 hours is counted as 10100 tokens of the 10000 Job tokens per day allows (a cached re-read counts as 0.1 of a token)";
    expect(await r.harness.jobs.run({ id: two.id }, never)).toMatchObject({ state: "spent", stoppedAt: "day", reason: why, usage: { calls: 0 } });
    expect(r.host.calls).toHaveLength(1);
    expect((await r.harness.jobs.read({ id: two.id })).report).toBe(
      // The summarizer can write no file, so its job is asked for no plan, and its report names none.
      `Stopped at a day's limit: ${why}.\nNothing is lost: it carries on from where it stopped. Raise the limit it names in Settings (Job tokens per day is under Jobs; Tokens per day and Cost per day are under Spend), or wait until the last 24 hours count less, then carry it on from the Jobs page.`,
    );
    expect((await r.harness.jobs.list({ chatId: CHAT, cursor: null, limit: 10 })).today).toEqual({ tokens: 10_100, sent: 10_100 });
  });

  test("Prompt tokens per job counts a cached re-read at What a cached re-read counts as, and says so when it stops the job", async () => {
    // Each call reads 9,000 of its 10,000 prompt tokens again from the provider's cache: 1,900 as the limit counts it, so several calls fit in 8,000 where, counted in full, the first alone is past it.
    const reread = (n: number) => ({ content: `Read part ${n}.`, toolCalls: [call("chat_search", { query: `part ${n}` }, `s${n}`)], usage: { prompt_tokens: 10_000, completion_tokens: 10, provider_raw: { prompt_tokens_details: { cached_tokens: 9000 } } } });
    const five = [reread(1), reread(2), reread(3), reread(4), reread(5)];
    const r = rig(cast({ job: five }), (s) => (s.jobs.budget.tokensIn = 8000));
    const { job } = await r.harness.jobs.start({ chatId: CHAT, agent: "summarizer", task: TASK, when: "now" });
    const stopped = await r.harness.jobs.run({ id: job.id }, never);
    const made = r.host.calls.length;
    expect(made).toBeGreaterThanOrEqual(2);
    expect(made).toBeLessThan(5);
    // What it truly sent is on the job, whatever the limit counted.
    expect(stopped).toMatchObject({ state: "spent", stoppedAt: "allowance", usage: { calls: made, in: made * 10_000, cachedIn: made * 9000 } });
    expect(stopped.reason).toMatch(/^the call would take the job's prompt tokens past Prompt tokens per job: counted as \d{4,5} of the 8000 allowed \(a cached re-read counts as 0\.1 of a token\)$/);
    // Counted in full, the same job stops after its first call.
    const full = rig(cast({ job: five }), (s) => {
      s.jobs.budget.tokensIn = 8000;
      s.spend.cachedWeight = 1;
    });
    const other = await full.harness.jobs.start({ chatId: CHAT, agent: "summarizer", task: TASK, when: "now" });
    expect(await full.harness.jobs.run({ id: other.job.id }, never)).toMatchObject({ state: "spent", stoppedAt: "allowance", usage: { calls: 1 } });
  });
});

describe("the user's and the agents' controls", () => {
  test("the user cancels a job while it runs, while it waits for its place, and while it waits to be run", async () => {
    const r = rig(cast({ job: [{ hang: true }] }));
    const start = async (task: string) => (await r.harness.jobs.start({ chatId: CHAT, agent: "summarizer", task, when: "now" })).job.id;
    const [one, two, three] = [await start("One."), await start("Two."), await start("Three.")];
    const running = r.harness.jobs.run({ id: one }, never);
    const placed = r.harness.jobs.run({ id: two }, never);
    await until(() => r.host.calls.length === 1);
    const cancelled = { state: "cancelled", reason: "the user cancelled it" };
    expect((await r.harness.jobs.cancel({ id: two })).job).toMatchObject(cancelled);
    expect(await placed).toMatchObject(cancelled);
    expect((await r.harness.jobs.cancel({ id: three })).job).toMatchObject(cancelled);
    // Run later, a cancelled job is given as it stands: it makes no call.
    expect(await r.harness.jobs.run({ id: three }, never)).toMatchObject(cancelled);
    expect((await r.harness.jobs.cancel({ id: one })).job).toMatchObject(cancelled);
    expect(await running).toMatchObject({ ...cancelled, id: one });
    expect(r.host.calls).toHaveLength(1);
    expect(r.host.jobChanges.map((j) => [j.task, j.state])).toEqual([["One.", "running"], ["Two.", "cancelled"], ["Three.", "cancelled"], ["One.", "cancelled"]]);
    expect(await refusal(r.harness.jobs.cancel({ id: "job_nope" }))).toEqual({ code: "not_found", message: "There is no such job." });
  });

  test("an agent's job_cancel cancels a job, says so for one that had ended, and says when there is none", async () => {
    const r = rig(
      cast({
        main: [starting[0]!, () => ({ toolCalls: [call("job_cancel", { job: r.host.queued[0]!.id }, "x"), call("job_cancel", { job: "job_nope" }, "y")] }), () => ({ toolCalls: [call("job_cancel", { job: r.host.queued[0]!.id }, "z")] }), { toolCalls: [reply] }],
      }),
    );
    await r.turn();
    const { id } = r.host.queued[0]!;
    expect(resultOf(r.host, "x")).toEqual({ content: `Cancelled job ${id}. What it had already written to the workspace stays.`, isError: false });
    expect(resultOf(r.host, "y")).toEqual({ content: "There's no job job_nope in this chat. job_list lists the jobs there are.", isError: true });
    expect(resultOf(r.host, "z")).toEqual({ content: `Job ${id} had already ended (cancelled); there is nothing to cancel.`, isError: false });
    expect((await r.harness.jobs.read({ id })).job).toMatchObject({ state: "cancelled", reason: "the main agent cancelled it" });
    expect((await r.harness.jobs.run({ id }, never)).state).toBe("cancelled");
    expect(r.host.calls.some(isJob)).toBe(false);
  });

  test("job_list shows a job with where it stands, job_read gives its report a page at a time, and an unknown id says so", async () => {
    const report = Array.from({ length: 220 }, (_, i) => `Line ${i}: Brann holds the key and Ilse owes Okoro a boat.`).join("\n");
    const cursorOf = (text: string | undefined): string | null => /cursor "(\d+)"\.\]$/.exec(text ?? "")?.[1] ?? null;
    const next: Step = (request) => {
      const cursor = cursorOf(request.messages.at(-1)?.content);
      return { toolCalls: [cursor === null ? reply : call("job_read", { job: r.host.queued[0]!.id, cursor }, `page-${cursor}`)] };
    };
    const r = rig(cast({ main: [...starting, () => ({ toolCalls: [call("job_list", {}, "n1"), call("job_read", { job: "job_nope" }, "n3"), call("job_read", { job: r.host.queued[0]!.id }, "n2")] }), next, next, next, next, next], job: [report] }));
    await r.turn();
    const { id } = r.host.queued[0]!;
    await r.harness.jobs.run({ id }, never);
    r.host.say(CHAT, "user", "I knock again.");
    await r.turn();
    const listed = resultOf(r.host, "n1")?.content ?? "";
    expect(listed).toStartWith(`1 job found; showing 1 to 1.\n- ${id}: summarizer, done, started by the main agent. Task: ${TASK} Its report opens: Line 0: Brann holds the key`);
    expect(listed).toEndWith(`(job_read with job ${id} reads the whole.)`);
    expect(resultOf(r.host, "n3")).toEqual({ content: "There's no job job_nope in this chat. job_list lists the jobs there are.", isError: true });
    const pages = [resultOf(r.host, "n2")?.content ?? ""];
    for (let cursor = cursorOf(pages.at(-1)); cursor !== null; cursor = cursorOf(pages.at(-1))) pages.push(resultOf(r.host, `page-${cursor}`)?.content ?? "");
    expect(pages.length).toBeGreaterThan(2);
    expect(pages[0]).toStartWith(`Job ${id}: summarizer, done, started by the main agent. Spent `);
    expect(pages[0]).toContain(`\nTask: ${TASK}\n\n[Its report, characters 0 to `);
    expect(pages.at(-1)).toEndWith("[That is the end.]");
    for (const page of pages) expect(page.length).toBeLessThanOrEqual(4000);
    // Each page's text, between its heading and its footer: together, the report whole.
    expect(pages.map((page) => page.slice(page.indexOf("]\n", page.indexOf("[Its report,")) + 2, page.lastIndexOf("\n["))).join("")).toBe(report);
  });

  test("an id as long as a page is said back clipped: job_read, job_cancel and job_start answer within Answer length, with how the id opens", async () => {
    const long = `job_${"lighthouse ".repeat(460)}`.slice(0, 5000);
    const asking: Step[] = [{ toolCalls: [call("job_read", { job: long }, "a"), call("job_cancel", { job: long }, "b"), call("job_start", { again: long }, "c"), call("job_start", { agent: long, task: TASK }, "d")] }, { toolCalls: [reply] }];
    const r = rig(cast({ main: asking }));
    await r.turn();
    // Line length (300) of the id, the last of them the mark that it was cut.
    const said = `${long.slice(0, 299)}…`;
    const none = { content: `There's no job ${said} in this chat. job_list lists the jobs there are.`, isError: true };
    expect(resultOf(r.host, "a")).toEqual(none);
    expect(resultOf(r.host, "b")).toEqual(none);
    expect(resultOf(r.host, "c")).toEqual(none);
    expect(resultOf(r.host, "d")?.content).toStartWith(`Not started: there's no agent ${said} a job can run as. A job can run as: summarizer`);
    expect(resultOf(r.host, "d")?.isError).toBe(true);
    expect(r.host.queued).toEqual([]);

    // Where Answer length has less room than Line length, the id takes what room the answer has.
    const tight = rig(cast({ main: asking }), (s) => (s.tools.pageChars = 200));
    await tight.turn();
    for (const id of ["a", "b"]) {
      const answer = resultOf(tight.host, id)?.content ?? "";
      expect(answer).toHaveLength(200);
      expect(answer).toStartWith(`There's no job ${long.slice(0, 100)}`);
      expect(answer).toEndWith("… in this chat. job_list lists the jobs there are.");
    }
    for (const id of ["c", "d"]) {
      const answer = resultOf(tight.host, id)?.content ?? "";
      expect(answer).toHaveLength(200);
      expect(answer).toStartWith(id === "c" ? `There's no job ${long.slice(0, 100)}` : `Not started: there's no agent ${long.slice(0, 100)}`);
    }
  });

  test("hearing about it: the next turn's main agent is told which jobs ended, with how each report opens and how to read the whole; the turn after isn't told again", async () => {
    const report = Array.from({ length: 40 }, (_, i) => `Line ${i}: Brann holds the key.`).join("\n");
    const r = rig(cast({ main: [...starting, { toolCalls: [reply] }, { toolCalls: [reply] }], job: [report] }));
    await r.turn();
    const { id } = r.host.queued[0]!;
    r.host.clock.advance(1000);
    await r.harness.jobs.run({ id }, never);
    const told = async (): Promise<string> => {
      r.host.clock.advance(1000);
      r.host.say(CHAT, "user", "I knock again.");
      const before = r.host.calls.length;
      await r.turn();
      return r.host.calls[before]?.messages.at(-1)?.content ?? "";
    };
    const second = await told();
    expect(second).toContain(`Jobs of this chat that ended since your last turn:\n- ${id} (summarizer): done. Its report opens: ${report.slice(0, 300)}`);
    expect(second).toContain(`(job_read with job ${id} reads the whole.)\n\nThe request, as Lumiverse assembled it`);
    expect(await told()).not.toContain("Jobs of this chat");
    expect(events(r.host).flatMap((e) => (e.kind === "session" ? [e.session.jobs?.map((job) => [job.id, job.state]) ?? null] : []))).toEqual([null, [[id, "done"]], null]);
  });

  test("a report longer than Report opening is told cut once: its opening ends in one ellipsis, then how to read the whole; one that fits is told whole, with neither", async () => {
    const long = "Brann holds the lighthouse key, and Ilse owes Okoro a boat since the storm.";
    const r = rig(cast({ main: [{ toolCalls: [call("job_start", { agent: "summarizer", task: "Note who holds the key." }, "c1"), call("job_start", { agent: "summarizer", task: "Note who keeps the light." }, "c2")] }, { toolCalls: [reply] }, { toolCalls: [call("job_list", {}, "n1")] }, { toolCalls: [reply] }], job: [long, "Okoro keeps the light."] }), (s) => (s.jobs.openingChars = 40));
    await r.turn();
    const [a, b] = r.host.queued.map((job) => job.id);
    r.host.clock.advance(1000);
    for (const job of r.host.queued) await r.harness.jobs.run({ id: job.id }, never);
    r.host.clock.advance(1000);
    r.host.say(CHAT, "user", "I knock again.");
    const before = r.host.calls.length;
    await r.turn();
    const cut = `Its report opens: ${long.slice(0, 39)}… (job_read with job ${a} reads the whole.)`;
    const whole = "Its report opens: Okoro keeps the light.";
    expect(r.host.calls[before]?.messages.at(-1)?.content).toContain(`Jobs of this chat that ended since your last turn:\n- ${a} (summarizer): done. ${cut}\n- ${b} (summarizer): done. ${whole}\n\nThe request, as Lumiverse assembled it`);
    // job_list says a report's opening the same way, the latest job first.
    expect(resultOf(r.host, "n1")?.content).toBe(`2 jobs found; showing 1 to 2.\n- ${b}: summarizer, done, started by the main agent. Task: Note who keeps the light. ${whole}\n- ${a}: summarizer, done, started by the main agent. Task: Note who holds the key. ${cut}`);
  });

  test("say, pause and resume reach a job as they reach a turn", async () => {
    const first = Promise.withResolvers<Answer>();
    const second = Promise.withResolvers<Answer>();
    const r = rig(cast({ job: [() => first.promise, () => second.promise, "Done."] }));
    const { id } = (await r.harness.jobs.start({ chatId: CHAT, agent: "summarizer", task: TASK, when: "now" })).job;
    const running = r.harness.jobs.run({ id }, never);
    await until(() => r.host.calls.length === 1);
    expect(await r.harness.say({ run: id, text: "Skip the prologue." })).toEqual({ said: true });
    first.resolve({ toolCalls: [call("chat_search", { query: "key" }, "s1")] });
    await until(() => r.host.calls.length === 2);
    // The note comes with the round's results, marked as the user's.
    expect(r.host.calls[1]?.messages.at(-1)?.parts?.at(-1)).toEqual({ type: "text", text: "[The user says, while you work:]\nSkip the prologue." });

    expect(await r.harness.pause({ run: id })).toEqual({ paused: true });
    second.resolve({ toolCalls: [call("chat_search", { query: "boat" }, "s2")] });
    await idle();
    // Held at its next round: the round's tools ran, and no further call is made.
    expect(r.host.calls).toHaveLength(2);
    expect((await r.harness.jobs.read({ id })).job).toMatchObject({ state: "running", paused: true });
    expect(r.host.jobChanges.at(-1)).toMatchObject({ state: "running", paused: true });
    expect(await r.harness.resume({ run: id })).toEqual({ paused: false });
    const job = await running;
    expect(job.state).toBe("done");
    expect(job.paused).toBeUndefined();
    expect(r.host.calls).toHaveLength(3);
    expect(r.host.traced.filter((t) => t.turn === id).flatMap((t) => (t.event.kind === "turn_paused" || t.event.kind === "turn_resumed" || (t.event.kind === "agent_entry" && t.event.entry.kind === "note") ? [t.event.kind] : []))).toEqual(["agent_entry", "turn_paused", "turn_resumed"]);
    // Once it ended there is nobody to tell.
    expect((await refusal(r.harness.say({ run: id, text: "Too late." }))).code).toBe("not_found");
  });

  test("the user holds every job and lets them go: one running waits at its next round, one that begins meanwhile begins held, and one started meanwhile isn't left held", async () => {
    const first = Promise.withResolvers<Answer>();
    const r = rig(cast({ job: [() => first.promise, "One is done.", "Two is done.", "Three is done."] }), (s) => (s.jobs.atOnce = 2));
    const start = async (task: string) => (await r.harness.jobs.start({ chatId: CHAT, agent: "summarizer", task, when: "now" })).job;
    const [one, two] = [await start("One."), await start("Two.")];
    const a = r.harness.jobs.run({ id: one.id }, never);
    await until(() => r.host.calls.length === 1);
    expect(await r.harness.jobs.hold({ paused: true })).toEqual({ paused: true });
    first.resolve({ toolCalls: [call("chat_search", { query: "key" })] });
    const b = r.harness.jobs.run({ id: two.id }, never);
    const three = await start("Three.");
    await idle();
    expect(r.host.calls).toHaveLength(1);
    const page = await r.harness.jobs.list({ chatId: CHAT, cursor: null, limit: 5 });
    expect(page.paused).toBe(true);
    expect(page.jobs.map((job) => [job.task, job.state, job.paused])).toEqual([["Three.", "queued", true], ["Two.", "running", true], ["One.", "running", true]]);
    expect(await r.harness.jobs.hold({ paused: false })).toEqual({ paused: false });
    expect([(await a).state, (await b).state]).toEqual(["done", "done"]);
    // The one that was started while every job was held runs freely once they were let go.
    expect((await r.harness.jobs.read({ id: three.id })).job.paused).toBeUndefined();
    expect(await r.harness.jobs.run({ id: three.id }, never)).toMatchObject({ state: "done", opening: "Three is done." });
  });
});

describe("off the path", () => {
  test("a job whose turn's reply was swiped away stops the moment it would write, and what it wrote before stays with the path it was made on", async () => {
    const second = Promise.withResolvers<Answer>();
    const r = rig(
      cast({
        main: [...starting, { toolCalls: [call("write_reply", { brief: "Another way." }, "w2")] }],
        job: [{ toolCalls: [call("workspace_write", { path: "/notes/key.md", content: "Brann holds the key.", base: "new" }, "j1")] }, () => second.promise, "never reached"],
        writer: ["The door opens.", "The door stays shut."],
      }),
      writing,
    );
    await r.turn();
    const { id } = r.host.queued[0]!;
    const running = r.harness.jobs.run({ id }, never);
    await until(() => r.host.calls.filter(isJob).length === 2);
    expect(resultOf(r.host, "j1")?.isError).toBe(false);
    // Long after the turn was saved, the user swipes its reply away.
    r.host.clock.advance(200_000);
    await r.turn({ kind: "swipe" });
    second.resolve({ toolCalls: [call("workspace_write", { path: "/notes/more.md", content: "Ilse owes a boat.", base: "new" }, "j2")] });
    const job = await running;
    expect(job).toMatchObject({ state: "off_path", reason: "the turn that started it is no longer on the chat's active path (its reply was swiped, edited away or deleted), so it stopped" });
    // It made no further call, and the write it tried was not made.
    expect(r.host.calls.filter(isJob)).toHaveLength(2);
    const list = async (): Promise<string[]> => (await r.harness.workspace.list({ chatId: CHAT, area: "chat" })).files.map((file) => file.path);
    expect(await list()).toEqual([]);
    // Back on the swipe it was made on, the first write is there, and the second never was.
    const message = r.host.last(CHAT);
    r.host.show(CHAT, message.id, 0);
    expect(await list()).toEqual(["notes/key.md"]);
    expect((await r.harness.workspace.read({ chatId: CHAT, area: "chat", path: "notes/key.md" })).file.by).toEqual({ who: "job", id, role: "summarizer" });
  });

  test("a job whose turn left the path before it reports is marked off the path, and the turn's record isn't given its report", async () => {
    const answer = Promise.withResolvers<Answer>();
    const r = rig(cast({ main: starting, job: [() => answer.promise] }));
    await r.turn();
    const { id } = r.host.queued[0]!;
    const running = r.harness.jobs.run({ id }, never);
    await until(() => r.host.calls.filter(isJob).length === 1);
    r.host.clock.advance(200_000);
    r.host.edit(CHAT, r.host.chats.get(CHAT)![1]!.id, "I walk away from the lighthouse.");
    answer.resolve("Brann holds the key.");
    expect(await running).toMatchObject({ state: "off_path", reason: "the turn that started it is no longer on the chat's active path (its reply was swiped, edited away or deleted), so it stopped", opening: "Brann holds the key." });
    await idle();
    expect(recordOf(r.host.last(CHAT).anchors[0])?.jobs).toEqual([{ id, agent: "summarizer", state: "queued" }]);
  });

  test("a job whose turn left no record has no turn to belong to: run, it ends off the path and says why", async () => {
    const r = rig(cast({ main: [starting[0]!, { error: "401: the key was refused" }] }), (s) => (s.reply.withoutBrief = "fail"));
    expect((await r.turn()).result).toMatchObject({ status: "failed", record: null });
    const { id } = r.host.queued[0]!;
    expect(await r.harness.jobs.run({ id }, never)).toMatchObject({ state: "off_path", reason: "the turn that started it left no record on its reply (it was stopped or failed), so the job has no turn to belong to" });
    expect(r.host.calls.some(isJob)).toBe(false);
  });
});

describe("a restart and a failure", () => {
  test("a job the restart cut off is marked interrupted, what it wrote is kept, and the user or an agent starts it again as a new job with the same task", async () => {
    const r = rig(cast({ job: [{ toolCalls: [call("workspace_write", { path: "learned/notes.md", content: "Brann holds the key.", base: "new" }, "j1")] }, { hang: true }], main: [() => ({ toolCalls: [call("job_start", { again: r.host.queued[0]!.id }, "g1")] }), { toolCalls: [reply] }] }), writing);
    const { job } = await r.harness.jobs.start({ chatId: CHAT, agent: "summarizer", task: TASK, when: "now" });
    void r.harness.jobs.run({ id: job.id }, never);
    await until(() => r.host.calls.length === 2);
    // The runtime goes down with the job's call under way; a new one comes up over what it left.
    const next = createHarness(r.host, r.options);
    const found = await next.jobs.recover();
    expect(found).toMatchObject({ interrupted: [{ id: job.id, state: "interrupted", reason: "the runtime restarted while it ran; what it had written to the workspace is kept, and job_start with again starts it again" }], paused: [], queued: [] });
    expect((await next.workspace.read({ chatId: CHAT, area: "learned", path: "notes.md" })).text).toBe("Brann holds the key.");

    const again = (await next.jobs.again({ id: job.id })).job;
    expect(again).toMatchObject({ again: job.id, agent: "summarizer", state: "queued", by: { who: "user" }, basis: null });
    expect(again.id).not.toBe(job.id);
    expect((await next.jobs.read({ id: again.id })).task).toBe(TASK);
    expect(r.host.queued.at(-1)?.id).toBe(again.id);
    // One that waits can't be started again.
    expect((await refusal(next.jobs.again({ id: again.id }))).code).toBe("conflict");

    const { request } = await runTurn(r.host, next, CHAT);
    const third = r.host.queued.at(-1)!;
    expect(resultOf(r.host, "g1")).toEqual({ content: `Started job ${third.id} (summarizer): it runs once this turn's reply is written. You are told how its report opens at your next turn; job_read reads it sooner, and job_cancel stops it.`, isError: false });
    expect(third).toMatchObject({ again: job.id, by: { who: "agent", role: "main" }, basis: request.generationId });
    expect((await next.jobs.read({ id: third.id })).task).toBe(TASK);
  });

  test("a failure inside a job ends the job failed, in the failure's own words: its run is closed, the host is told, and whoever ran it is given the job", async () => {
    const r = rig(cast({ job: ["Two is done."] }));
    const start = async (task: string) => (await r.harness.jobs.start({ chatId: CHAT, agent: "summarizer", task, when: "now" })).job.id;
    const [one, two] = [await start("One."), await start("Two.")];
    const path = r.host.chat.path;
    let asked = 0;
    r.host.chat.path = (chatId) => (asked++ === 0 ? Promise.reject(new Error("the chat can't be read")) : path(chatId));
    const job = await r.harness.jobs.run({ id: one }, never);
    expect(job).toMatchObject({ id: one, state: "failed", reason: "the chat can't be read" });
    expect((await r.harness.jobs.read({ id: one })).job.state).toBe("failed");
    expect(r.host.jobChanges.map((j) => [j.task, j.state])).toEqual([["One.", "failed"]]);
    const traced = r.host.traced.filter((t) => t.turn === one).map((t) => t.event);
    expect(traced.at(-1)).toMatchObject({ kind: "turn_ended", status: "failed", reason: "the chat can't be read" });
    // Its run is gone: there is nobody to tell, and its place is free for the next job.
    expect((await refusal(r.harness.say({ run: one, text: "Hello?" }))).code).toBe("not_found");
    expect(await r.harness.jobs.run({ id: two }, never)).toMatchObject({ state: "done", opening: "Two is done." });
    expect(r.host.calls).toHaveLength(1);
  });

  test("a job whose run can't begin ends failed, in the failure's own words: the host is told, whoever ran it is given the job, its place is free, and it can be started again", async () => {
    const r = rig(cast({ job: ["Okoro keeps the key."] }));
    /** What the next read of the user's settings comes to, where it fails. */
    let failing: (() => Promise<never>) | null = null;
    const harness = createHarness(r.host, {
      settings: async () => {
        const fails = failing;
        failing = null;
        if (fails) await fails();
        return structuredClone(r.stored);
      },
    });
    const start = async (task: string) => (await harness.jobs.start({ chatId: CHAT, agent: "summarizer", task, when: "now" })).job.id;
    const [one, two] = [await start("One."), await start("Two.")];
    const unread = new Error("the settings can't be read");

    failing = () => Promise.reject(unread);
    const job = await harness.jobs.run({ id: one }, never);
    expect(job).toMatchObject({ id: one, state: "failed", reason: "the settings can't be read", endedAt: r.host.clock.now() });
    expect((await harness.jobs.read({ id: one })).job).toMatchObject({ state: "failed", reason: "the settings can't be read" });
    expect(r.host.jobChanges.map((j) => [j.task, j.state])).toEqual([["One.", "failed"]]);
    expect(r.host.calls).toHaveLength(0);
    // It no longer waits: run again it is given as it stands, and the user starts it again as a new job, which has the one place there is.
    expect((await harness.jobs.run({ id: one }, never)).state).toBe("failed");
    const again = (await harness.jobs.again({ id: one })).job;
    expect(again).toMatchObject({ again: one, state: "queued" });
    expect(await harness.jobs.run({ id: again.id }, never)).toMatchObject({ state: "done", opening: "Okoro keeps the key." });

    // A cancel that came while the settings were being read stands: the job ends cancelled, not failed.
    const read = Promise.withResolvers<never>();
    failing = () => read.promise;
    const running = harness.jobs.run({ id: two }, never);
    await until(() => failing === null);
    const cancelling = harness.jobs.cancel({ id: two });
    await idle();
    read.reject(unread);
    expect(await running).toMatchObject({ id: two, state: "cancelled", reason: "the user cancelled it" });
    expect(await cancelling).toMatchObject({ job: { state: "cancelled" } });
    expect(r.host.calls).toHaveLength(1);
  });

  test("a job that failed on what it runs on says it lasts, so whoever starts jobs knows a new run would only meet it again: a key or a model the provider refused, no connection to run on; a failure that may pass says nothing of the kind", async () => {
    const r = rig(cast({ job: [{ error: "401: the key was refused" }, { error: "The model `model-9` does not exist or you do not have access to it." }, { error: "503: overloaded" }, "never reached"] }), (s) => (s.loop.retries = 0));
    const ended = async () => {
      const { job } = await r.harness.jobs.start({ chatId: CHAT, agent: "summarizer", task: TASK, when: "now" });
      return r.harness.jobs.run({ id: job.id }, never);
    };
    expect(await ended()).toMatchObject({ state: "failed", reason: "401: the key was refused", lasting: true });
    expect(await ended()).toMatchObject({ state: "failed", lasting: true });
    const passing = await ended();
    expect(passing).toMatchObject({ state: "failed", reason: "503: overloaded" });
    expect(passing.lasting).toBeUndefined();
    // No connection to run on (its own is gone, and the runtime has no default to run it on instead): no call is made, and what the page lists says it lasts.
    r.stored.values.agents.summarizer!.connectionId = "conn-gone";
    r.host.defaultConnection = null;
    const gone = await ended();
    expect(gone).toMatchObject({ state: "failed", reason: "the connection conn-gone is no longer one of the runtime's, and the runtime has no default connection to run this agent on instead: give it another in LumiAH's Settings, or make one the default on LumiAH's Runtime page under Connections", lasting: true });
    expect((await r.harness.jobs.list({ chatId: CHAT, cursor: null, limit: 1 })).jobs[0]).toMatchObject({ id: gone.id, lasting: true });
    expect(r.host.calls).toHaveLength(3);
  });
});

describe("a long objective", () => {
  test("the user's job belongs to no turn and may run as the main agent: it is told its allowance and asked for a plan file, in a text the user can replace", async () => {
    const r = rig(cast({ job: ["The plan is written.", "Tidied."] }));
    const { job } = await r.harness.jobs.start({ chatId: CHAT, agent: "main", task: "Learn the story so far.", when: "now", allowance: { toolTurns: 5, tokensIn: 50_000 } });
    expect(job).toMatchObject({ agent: "main", basis: null, by: { who: "user" }, allowance: { toolTurns: 5, tokensIn: 50_000 }, state: "queued" });
    expect((await r.harness.jobs.run({ id: job.id }, never)).state).toBe("done");
    const [asked] = r.host.calls;
    expect(asked?.messages[0]?.content).toStartWith("You are the main agent behind a roleplay chat in Lumiverse.");
    expect(asked?.tools?.map((t) => t.name)).not.toContain("write_reply");
    const told = firstUser(asked!);
    expect(told).toStartWith("You are running as a job the user started: work that is too long for a reply and ends in none.");
    expect(told).toContain("The user's objective, in their words:\n\nLearn the story so far.\n\nWhat this job may still spend: 50000 tokens sent to models, 60000 tokens written by them, 5 rounds of tool calls, 15 minutes of work.");
    expect(told).toContain(`Before you work, write your plan to learned/plans/${job.id}.md: what you will do with this allowance`);

    // The user's own wording, with the part about a plan and files where the agent can write them: the summarizer can write none, so it is told of neither.
    r.stored.texts["jobs.objective"] = "Objective: {{task}} | {{allowance}} | files:{{files}}";
    const two = (await r.harness.jobs.start({ chatId: CHAT, agent: "summarizer", task: "Tidy the workspace.", when: "now" })).job;
    await r.harness.jobs.run({ id: two.id }, never);
    expect(firstUser(r.host.calls.at(-1)!)).toStartWith("Objective: Tidy the workspace. | What this job may still spend: 600000 tokens sent to models, 60000 tokens written by them, 60 rounds of tool calls, 15 minutes of work. | files:\n");
  });

  test("it writes learned/ and ~/, and a write to the chat's own area is refused in words that say why", async () => {
    const r = rig(
      cast({
        job: [
          () => ({ toolCalls: [call("workspace_write", { path: `learned/plans/${r.host.queued[0]!.id}.md`, content: "Plan: read it all.", base: "new" }, "p1"), call("workspace_write", { path: "~/style.md", content: "Mara likes short replies.", base: "new" }, "p2"), call("workspace_write", { path: "/notes.md", content: "A note.", base: "new" }, "p3")] }),
          "The plan is written.",
        ],
      }),
    );
    const { id } = (await r.harness.jobs.start({ chatId: CHAT, agent: "main", task: "Learn the story so far.", when: "now" })).job;
    expect((await r.harness.jobs.run({ id }, never)).state).toBe("done");
    expect(resultOf(r.host, "p1")?.isError).toBe(false);
    expect(resultOf(r.host, "p2")?.isError).toBe(false);
    expect(resultOf(r.host, "p3")).toEqual({ content: "Not changed: this job belongs to the chat, not to a turn, so it can't change the chat's own area (/), which follows the story as swipes and edits do. Write to learned/ (kept with the chat) or ~/ (the user's own).", isError: true });
    expect((await r.harness.workspace.read({ chatId: CHAT, area: "learned", path: `plans/${id}.md` })).text).toBe("Plan: read it all.");
    expect((await r.harness.workspace.read({ chatId: CHAT, area: "user", path: "style.md" })).text).toBe("Mara likes short replies.");
    expect((await r.harness.workspace.list({ chatId: CHAT, area: "chat" })).files).toEqual([]);
  });

  test("an allowance stands over the limits for each job: five rounds where Settings give one", async () => {
    let n = 0;
    const r = rig(cast({ job: Array.from({ length: 7 }, () => () => ({ toolCalls: [call("chat_search", { query: `try ${n++}` })] })) }), (s) => (s.jobs.budget.toolTurns = 1));
    const { id } = (await r.harness.jobs.start({ chatId: CHAT, agent: "summarizer", task: TASK, when: "now", allowance: { toolTurns: 5 } })).job;
    const job = await r.harness.jobs.run({ id }, never);
    expect(job).toMatchObject({ state: "spent", reason: "the job's agents have had its 5 rounds of tool calls (Tool rounds per job)", usage: { calls: 6, toolTurns: 5 } });
    expect(firstUser(r.host.calls[0]!)).toContain("5 rounds of tool calls, 15 minutes of work.");
  });

  test("when its allowance runs out it stops spent with a report and keeps its session; granted more, it carries on from there, and its usage counts both runs", async () => {
    const r = rig(
      cast({
        job: [
          () => ({ toolCalls: [call("workspace_write", { path: `learned/plans/${r.host.queued[0]!.id}.md`, content: "Plan: read it all.", base: "new" }, "p1")], usage: { prompt_tokens: 1000, completion_tokens: 100 } }),
          { content: "Reading the first half.", toolCalls: [call("chat_read", { from: 0 }, "p2")], usage: { prompt_tokens: 1200, completion_tokens: 100 } },
          { content: "Halfway: Brann holds the key.", toolCalls: [call("chat_search", { query: "key" }, "p3")], usage: { prompt_tokens: 1500, completion_tokens: 100 } },
          { toolCalls: [call("chat_search", { query: "boat" }, "p4")], usage: { prompt_tokens: 1800, completion_tokens: 100 } },
          { content: "All read: Brann holds the key, Ilse owes a boat.", usage: { prompt_tokens: 2000, completion_tokens: 100 } },
        ],
      }),
    );
    const { id } = (await r.harness.jobs.start({ chatId: CHAT, agent: "main", task: "Learn the story so far.", when: "now", allowance: { toolTurns: 2 } })).job;
    const why = "the job's agents have had its 2 rounds of tool calls (Tool rounds per job)";
    const spent = await r.harness.jobs.run({ id }, never);
    expect(spent).toMatchObject({ state: "spent", stoppedAt: "allowance", reason: why, usage: { calls: 3, toolTurns: 2, in: 3700, out: 300 } });
    expect((await r.harness.jobs.read({ id })).report).toBe(`Stopped at its allowance: ${why}.\nIt had last written: Halfway: Brann holds the key.\nFiles it wrote in this run: learned/plans/${id}.md\nIts plan, learned/plans/${id}.md, says what it did and what is left.\nGranted more, it carries on from where it stopped.`);
    // Only a job that stopped at its allowance is granted more.
    const granted = (await r.harness.jobs.grant({ id, allowance: { toolTurns: 4 } })).job;
    expect(granted).toMatchObject({ id, state: "queued", allowance: { toolTurns: 4 } });
    expect(granted.stoppedAt).toBeUndefined();
    expect(r.host.queued.map((job) => [job.id, job.allowance?.toolTurns])).toEqual([[id, 2], [id, 4]]);

    const done = await r.harness.jobs.run({ id }, never);
    const carried = r.host.calls[3]?.messages ?? [];
    // The conversation it had: its objective, each call with what came back, and what it had last written.
    expect(carried.map((m) => `${m.role}:${(m.parts ?? []).map((part) => part.type).join("+")}`)).toEqual(["system:", "user:", "assistant:tool_use", "user:tool_result+text", "assistant:text+tool_use", "user:tool_result+text", "assistant:", "user:"]);
    expect(carried[1]?.content).toStartWith("You are running as a job the user started");
    expect(carried[3]?.parts?.[0]).toMatchObject({ type: "tool_result", toolUseId: "p1" });
    expect(carried[6]?.content).toBe("Halfway: Brann holds the key.");
    expect(carried.at(-1)?.content).toStartWith(`This job was stopped and is carried on now, from where you left it. What this job may still spend: 596300 tokens sent to models, 59700 tokens written by them, 2 rounds of tool calls, 15 minutes of work. Read your plan (learned/plans/${id}.md) and your files first: they say what is done and what is left. Then go on.`);
    expect(done).toMatchObject({ state: "done", opening: "All read: Brann holds the key, Ilse owes a boat.", usage: { calls: 5, toolTurns: 3, in: 7500, out: 500 } });
    expect((await refusal(r.harness.jobs.grant({ id, allowance: { toolTurns: 9 } }))).code).toBe("conflict");
  });

  test("a job a day's limit stops keeps its session and its work: carried on while the limit stands it stops again without a call, and once the limit is raised it goes on from where it was", async () => {
    // Each limit on a day's spend in turn: the jobs' own, and the user's two caps.
    const limits: [string, (s: Settings, limit: number | null) => void, number, RegExp][] = [
      ["Job tokens per day", (s, limit) => (s.jobs.tokensPerDay = limit), 10_000, /^what jobs sent and wrote in the last 24 hours is counted as 10100 tokens of the 10000 Job tokens per day allows/],
      ["Tokens per day", (s, limit) => (s.spend.tokensPerDay = limit), 10_000, /^what every agent's calls sent and wrote in the last 24 hours is counted as 10100 tokens of the 10000 Tokens per day allows/],
      ["Cost per day", (s, limit) => (s.spend.costPerDay = limit), 0.01, /^every agent's calls together have cost \$0\.02 in the last 24 hours, and Cost per day allows \$0\.01$/],
    ];
    for (const [name, set, limit, why] of limits) {
      const r = rig(
        cast({
          job: [
            { content: "Halfway: Brann holds the key.", toolCalls: [call("workspace_write", { path: "learned/key.md", content: "Brann holds the key.", base: "new" }, "k1")], usage: { prompt_tokens: 9900, completion_tokens: 200, cost: 0.02 } },
            { content: "All read: Brann holds the key, Ilse owes a boat.", usage: { prompt_tokens: 1200, completion_tokens: 100, cost: 0.02 } },
          ],
        }),
        (s) => {
          writing(s);
          set(s, limit);
        },
      );
      const { id } = (await r.harness.jobs.start({ chatId: CHAT, agent: "summarizer", task: TASK, when: "now" })).job;
      const stopped = await r.harness.jobs.run({ id }, never);
      // Stopped, not failed: its first call was made, its file is written, and the report says what happened and what to do.
      expect([name, stopped.state, stopped.stoppedAt, stopped.usage.calls]).toEqual([name, "spent", "day", 1]);
      expect(stopped.reason).toMatch(why);
      const { report } = await r.harness.jobs.read({ id });
      expect(report).toStartWith("Stopped at a day's limit: ");
      expect(report).toContain(`\nIt had last written: Halfway: Brann holds the key.\nFiles it wrote in this run: learned/key.md\nIts plan, learned/plans/${id}.md, says what it did and what is left.\nNothing is lost: it carries on from where it stopped.`);
      expect((await r.harness.workspace.read({ chatId: CHAT, area: "learned", path: "key.md" })).text).toBe("Brann holds the key.");

      // Carried on with the limit as it was: it stops there again, having called no model, and is none the worse.
      const again = (await r.harness.jobs.grant({ id, allowance: {} })).job;
      expect([again.state, again.stoppedAt, again.allowance]).toEqual(["queued", undefined, undefined]);
      expect(await r.harness.jobs.run({ id }, never)).toMatchObject({ state: "spent", stoppedAt: "day", usage: { calls: 1 } });
      expect(r.host.calls).toHaveLength(1);

      // The user raises the limit and carries it on: it goes on from its own session, and ends with its report.
      set(r.stored.values, null);
      await r.harness.jobs.grant({ id, allowance: {} });
      const done = await r.harness.jobs.run({ id }, never);
      expect(done).toMatchObject({ state: "done", opening: "All read: Brann holds the key, Ilse owes a boat.", usage: { calls: 2, in: 11_100, out: 300 } });
      expect(done.stoppedAt).toBeUndefined();
      // Its conversation as the first run left it, with one message that carries it on: the run that made no call added nothing to it.
      const carried = r.host.calls[1]?.messages ?? [];
      expect(carried.map((m) => `${m.role}:${(m.parts ?? []).map((part) => part.type).join("+")}`)).toEqual(["system:", "user:", "assistant:text+tool_use", "user:tool_result", "user:"]);
      expect(carried.at(-1)?.content).toStartWith("This job was stopped and is carried on now, from where you left it.");
    }
  });

  test("a paused job stays paused across a restart: resumed, it waits to run again, carries on from its session, and counts what it spent before", async () => {
    const second = Promise.withResolvers<Answer>();
    const r = rig(cast({ job: [{ toolCalls: [call("chat_search", { query: "key" }, "k1")], usage: { prompt_tokens: 1000, completion_tokens: 100 } }, () => second.promise, { content: "Done after the restart.", usage: { prompt_tokens: 3000, completion_tokens: 100 } }] }));
    const { id } = (await r.harness.jobs.start({ chatId: CHAT, agent: "summarizer", task: TASK, when: "now" })).job;
    void r.harness.jobs.run({ id }, never);
    await until(() => r.host.calls.length === 2);
    await r.harness.pause({ run: id });
    await until(() => r.host.jobChanges.at(-1)?.paused === true);
    // Its call under way comes back; at its next round it comes to rest, and the host hears that the hold has taken.
    const heard = r.host.jobChanges.length;
    second.resolve({ toolCalls: [call("chat_search", { query: "boat" }, "k2")], usage: { prompt_tokens: 2000, completion_tokens: 100 } });
    await until(() => r.host.jobChanges.length > heard);

    const next = createHarness(r.host, r.options);
    const found = await next.jobs.recover();
    expect(found).toMatchObject({ interrupted: [], paused: [{ id, state: "paused", paused: true, usage: { calls: 2, toolTurns: 2, in: 3000, out: 200 } }], queued: [] });
    expect(await next.resume({ run: id })).toEqual({ paused: false });
    expect(r.host.queued.at(-1)).toMatchObject({ id, state: "queued" });
    expect(r.host.queued.at(-1)?.paused).toBeUndefined();
    const done = await next.jobs.run({ id }, never);
    const carried = r.host.calls.at(-1)?.messages ?? [];
    expect(carried.map((m) => `${m.role}:${(m.parts ?? []).map((part) => part.type).join("+")}`)).toEqual(["system:", "user:", "assistant:tool_use", "user:tool_result", "assistant:tool_use", "user:tool_result", "user:"]);
    expect(carried[5]?.parts?.[0]).toMatchObject({ type: "tool_result", toolUseId: "k2" });
    // What it spent before the restart is counted: against what it may still spend, and in what it has spent.
    expect(carried.at(-1)?.content).toStartWith("This job was stopped and is carried on now, from where you left it. What this job may still spend: 597000 tokens sent to models, 59800 tokens written by them, 58 rounds of tool calls, 15 minutes of work.");
    expect(done).toMatchObject({ state: "done", opening: "Done after the restart.", usage: { calls: 3, toolTurns: 2, in: 6000, out: 300 } });
  });

  test("a job a job starts may spend no more than was left of the one that started it, and what it spends is added to that one's; with Jobs may start jobs off, a job's agent is offered no job_start", async () => {
    let n = 0;
    const r = rig(
      cast({
        job: [
          { toolCalls: [call("job_start", { agent: "summarizer", task: "Count the lamps.", when: "now" }, "l1")], usage: { prompt_tokens: 1000, completion_tokens: 100 } },
          { content: "Started the count.", usage: { prompt_tokens: 1200, completion_tokens: 50 } },
          ...Array.from({ length: 4 }, () => () => ({ toolCalls: [call("chat_search", { query: `lamp ${n++}` })], usage: { prompt_tokens: 300, completion_tokens: 40 } })),
        ],
      }),
    );
    const { id } = (await r.harness.jobs.start({ chatId: CHAT, agent: "main", task: "Learn the story so far.", when: "now", allowance: { toolTurns: 3 } })).job;
    expect(r.host.calls).toHaveLength(0);
    const parent = await r.harness.jobs.run({ id }, never);
    expect(r.host.calls[0]?.tools?.map((t) => t.name).filter((name) => name.startsWith("job_"))).toEqual(["job_start", "job_list", "job_read", "job_cancel"]);
    expect(parent).toMatchObject({ state: "done", usage: { calls: 2, toolTurns: 1, in: 2200, out: 150 } });
    // What was left of its three rounds, its tokens and its time when it started the other is all the other gets.
    const child = r.host.queued[1]!;
    expect(child).toMatchObject({ parent: id, agent: "summarizer", by: { who: "agent", role: "main" }, basis: null, allowance: { tokensIn: 599_000, tokensOut: 59_900, toolTurns: 2, wallMs: 900_000 } });
    expect(await r.harness.jobs.run({ id: child.id }, never)).toMatchObject({ state: "spent", reason: "the job's agents have had its 2 rounds of tool calls (Tool rounds per job)", usage: { calls: 3, toolTurns: 2, in: 900, out: 120 } });
    expect((await r.harness.jobs.read({ id })).job.usage).toMatchObject({ calls: 5, toolTurns: 3, in: 3100, out: 270 });

    const off = rig(cast({ job: ["Done."] }), (s) => (s.jobs.chain = false));
    const alone = (await off.harness.jobs.start({ chatId: CHAT, agent: "main", task: "Learn the story so far.", when: "now" })).job;
    await off.harness.jobs.run({ id: alone.id }, never);
    expect(off.host.calls[0]?.tools?.map((t) => t.name).filter((name) => name.startsWith("job_"))).toEqual(["job_list", "job_read", "job_cancel"]);
  });
});

// ---------------------------------------------------------------- what a job's agent holds, and how deep it stands (§14)

describe("a job an agent starts holds no more than its starter and stands one deeper", () => {
  const SCOUT = "You are the scout: you find what a task names.";
  const toolsOf = (request: ModelRequest | undefined): string[] => (request?.tools ?? []).map((t) => t.name).sort();
  const isScout = (request: ModelRequest): boolean => request.messages.some((m) => m.content.includes(SCOUT));
  const scout = (harness: Harness): void => harness.agents.register({ id: "scout", name: "Scout", description: "Finds what a task names.", instructions: SCOUT, given: "task", ...newAgentSettings(), tools: [...newAgentSettings().tools, "delegate", "agent_message"] });
  /** The main agent holds few tools; the summarizer's definition names two it doesn't. */
  const narrow = (s: Settings): void => {
    s.agents.main!.tools = ["delegate", "job_start", "write_reply", "chat_read"];
    s.agents.summarizer!.tools = ["chat_read", "workspace_write", "workspace_delete"];
  };

  test("its agent is given the tools of its definition that its starter holds, as a sub-agent is; all of them where Settings or its definition say so; and the user's job its definition's", async () => {
    const r = rig(cast({ main: starting, job: ["Okoro keeps the key."] }), narrow);
    await r.turn();
    expect((await r.harness.jobs.run({ id: r.host.queued[0]!.id }, never)).state).toBe("done");
    expect(toolsOf(r.host.calls.find(isJob))).toEqual(["chat_read", "scratch_read"]);
    // What a sub-agent may be given, set to its definition, holds for a job's agent too.
    const free = rig(cast({ main: starting, job: ["Okoro keeps the key."] }), (s) => {
      narrow(s);
      s.delegation.grant = "definition";
    });
    await free.turn();
    await free.harness.jobs.run({ id: free.host.queued[0]!.id }, never);
    expect(toolsOf(free.host.calls.find(isJob))).toEqual(["chat_read", "scratch_read", "workspace_delete", "workspace_write"]);
    // A definition that keeps its tools whoever starts it keeps them as a job.
    const kept = rig(cast({ main: [{ toolCalls: [call("job_start", { agent: "keeper", task: TASK }, "c1")] }, { toolCalls: [reply] }], job: ["Okoro keeps the key."] }), narrow);
    kept.harness.agents.register({ id: "keeper", name: "Keeper", description: "Keeps the notes.", instructions: "You keep the notes.", given: "task", ...newAgentSettings(), tools: ["chat_read", "workspace_write"], grant: "definition" });
    await kept.turn();
    await kept.harness.jobs.run({ id: kept.host.queued[0]!.id }, never);
    expect(toolsOf(kept.host.calls.find(isJob))).toEqual(["chat_read", "scratch_read", "workspace_write"]);
    // The user's job is the user's to give: its definition's tools.
    const own = rig(cast({ job: ["Okoro keeps the key."] }), narrow);
    const { id } = (await own.harness.jobs.start({ chatId: CHAT, agent: "summarizer", task: TASK, when: "now" })).job;
    await own.harness.jobs.run({ id }, never);
    expect(toolsOf(own.host.calls.find(isJob))).toEqual(["chat_read", "scratch_read", "workspace_delete", "workspace_write"]);
  });

  /** The main agent starts a job; the job's agent hands a task to the scout, whose definition names delegate too. */
  const handing = (): Script => {
    let main = 0;
    let job = 0;
    return (request) => {
      if (isJob(request)) return job++ === 0 ? { toolCalls: [call("delegate", { agent: "scout", task: "Find the key." }, "d1")] } : "Okoro keeps the key.";
      if (isScout(request)) return "It hangs by the door.";
      if (!request.tools) return "The door opens.";
      return main++ === 0 ? { toolCalls: [call("job_start", { agent: "summarizer", task: TASK }, "c1")] } : { toolCalls: [reply] };
    };
  };
  const delegating = (s: Settings): void => void s.agents.summarizer!.tools.push("delegate", "agent_message");

  test("with Depth as shipped the main agent's job delegates, and the agent it hands a task to does not; at 1 the job doesn't either, and the user's job, which stands at 0, does", async () => {
    const r = rig(handing(), delegating);
    scout(r.harness);
    await r.turn();
    expect((await r.harness.jobs.run({ id: r.host.queued[0]!.id }, never)).state).toBe("done");
    expect(toolsOf(r.host.calls.find(isJob))).toContain("delegate");
    expect(resultOf(r.host, "d1")?.isError).toBe(false);
    const handed = r.host.calls.find(isScout);
    expect(toolsOf(handed)).toContain("chat_search");
    expect(toolsOf(handed)).not.toContain("delegate");

    const shallow = rig(handing(), (s) => {
      delegating(s);
      s.delegation.depth = 1;
    });
    scout(shallow.harness);
    await shallow.turn();
    await shallow.harness.jobs.run({ id: shallow.host.queued[0]!.id }, never);
    expect(toolsOf(shallow.host.calls.find(isJob))).not.toContain("delegate");
    expect(shallow.host.calls.some(isScout)).toBe(false);
    const { id } = (await shallow.harness.jobs.start({ chatId: CHAT, agent: "summarizer", task: TASK, when: "now" })).job;
    await shallow.harness.jobs.run({ id }, never);
    expect(toolsOf(shallow.host.calls.filter(isJob).at(-1))).toContain("delegate");
  });

  test("a job's sub-agents count against Delegations per job, not Sub-agents per turn: as shipped a job starts more than a turn may, and with a limit set the one past it is refused in words", async () => {
    /** A job whose agent hands two parts to two scouts, one an answer. */
    const parts = (): Script => {
      let job = 0;
      return (request) => {
        if (!isJob(request)) return "Read.";
        const at = job++;
        return at < 2 ? { toolCalls: [call("delegate", { agent: "scout", task: `Read part ${at + 1}.` }, `d${at}`)] } : "Both parts are read.";
      };
    };
    const ran = async (change: (s: Settings) => void) => {
      const r = rig(parts(), (s) => {
        delegating(s);
        s.delegation.perRun = 1;
        change(s);
      });
      scout(r.harness);
      const { id } = (await r.harness.jobs.start({ chatId: CHAT, agent: "summarizer", task: TASK, when: "now" })).job;
      expect((await r.harness.jobs.run({ id }, never)).state).toBe("done");
      return r;
    };
    const shipped = await ran(() => undefined);
    expect(shipped.stored.values.jobs.delegations).toBeNull();
    expect([resultOf(shipped.host, "d0")?.isError, resultOf(shipped.host, "d1")?.isError]).toEqual([false, false]);
    expect(shipped.host.calls.filter(isScout)).toHaveLength(2);
    const tight = await ran((s) => (s.jobs.delegations = 1));
    expect(resultOf(tight.host, "d0")?.isError).toBe(false);
    expect(resultOf(tight.host, "d1")).toEqual({ content: "Not started: this job has started the 1 sub-agent it may (Delegations per job). Ask one you already have with agent_message, or do it yourself.", isError: true });
    expect(tight.host.calls.filter(isScout)).toHaveLength(1);
  });
});
