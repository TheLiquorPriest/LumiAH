// Agents at work, end to end (DESIGN §11 to §18): the core's own harness in a runtime, linked to the
// extension backend over a fake Lumiverse, with a scripted model behind the backend. What a test
// here checks is what a user would see on the page and what a model would be sent: sub-agents and a
// job started from a reply, a job that leaves the chat's path, a tool of an MCP server, a call held
// for the user's word, a file tool kept inside its area, the user's words to a turn under way, and
// a job a runtime restart cut off.

import { afterEach, describe, expect, test } from "bun:test";
import type { AgentDefinition } from "../../src/core/agents";
import type { JobView } from "../../src/core/ports";
import { recordOf } from "../../src/core/sessions";
import { newAgentSettings } from "../../src/core/settings";
import { isRecord } from "../../src/link/json";
import type { Runtime } from "../../src/runtime/runtime";
import type { Notice } from "../../src/shared/ui";
import { bare, cast, gate, heard, offers, told } from "../support/cast";
import { type Answer, toolCall } from "../support/fake-host";
import { callsOf, live, startedAs, stepsOf } from "../support/live";
import { plug } from "../support/plug";
import { type Rig, rig, runtimeFor, until, USER } from "../support/rig";

let r: Rig | null = null;
/** What a test started beside the rig, stopped with it. */
const also: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const stop of also.splice(0)) await stop();
  await r?.close();
  r = null;
});

const state = (it: Rig) => it.page.request("lah.hello", {});

/** The jobs not yet over, as every page's state has them now. */
const activeJobs = (it: Rig): JobView[] => it.backend.jobs.state(USER, false, false).active;

/** The record LumiAH keeps on a message for a swipe, read as the core reads one; null when there is none. */
function anchored(own: unknown, swipe: number) {
  return isRecord(own) && isRecord(own.swipes) ? recordOf(own.swipes[String(swipe)]) : null;
}

/** An agent definition of the user's own, as the Agents page saves one: it runs with what a new agent starts from, and these tools. */
function worker(id: string, name: string, description: string, instructions: string, tools: string[]): AgentDefinition {
  return { id, name, description, instructions, given: "task", ...newAgentSettings(), tools };
}

const SCOUT = "You are the harbour's scout. Read what your task names and say what you found.";
const ARCHIVIST = "You are the harbour's archivist. Find where the chat speaks of what your task names.";
const TALLY = "You keep the harbour's tally. Count what your task names and report the count.";
/** What a job's agent is told first, whatever definition it runs as (the core's own text). */
const AS_JOB = "You are running as a job";

/** A line that answers only once `n` calls wait on it: calls made one after another would never get past it, so it shows they ran at once. */
function together(n: number): <T extends Answer>(answer: T) => () => Promise<T> {
  const all = Promise.withResolvers<void>();
  let waiting = 0;
  return (answer) => async () => {
    if (++waiting >= n) all.resolve();
    await all.promise;
    return answer;
  };
}

const kinds = (notices: readonly Notice[]): [string, string][] => notices.map((n) => [n.kind, n.jobId]);

describe("a turn whose main agent hands work on", () => {
  test("runs two sub-agents at once, shows each one's steps in the live view, and starts a job that reports after the reply and is told to the next turn", async () => {
    const it = (r = await rig());
    const chatId = await it.setUp();
    await it.page.request("lah.agent.save", { agent: worker("scout", "Scout", "Reads a span of the chat and says what is in it.", SCOUT, ["chat_read"]) });
    await it.page.request("lah.agent.save", { agent: worker("archivist", "Archivist", "Finds where the chat speaks of something.", ARCHIVIST, ["chat_grep"]) });
    await it.page.request("lah.agent.save", { agent: worker("tallyman", "Tallyman", "Counts things in the chat.", TALLY, ["chat_read"]) });
    // A job that waits for its turn's record looks for it forty times in this wait: often enough here that the test doesn't wait on the look.
    await it.page.request("lah.settings.set", { set: [{ path: ["core", "jobs", "recordWaitMs"], value: 1_000 }], reset: [] });

    const both = together(2);
    const replyHeld = gate();
    const jobHeld = gate();
    const REPORT = "The chat holds one message, Mara's, and it asks who keeps the light.";
    const play = cast(
      // A job's agent is told it runs as a job before anything else: that tells it from a sub-agent of the same definition.
      { name: "job", is: told(AS_JOB), lines: [jobHeld.held({ toolCalls: [toolCall("chat_read", { from: 0 }, "job_read")] }), REPORT] },
      { name: "scout", is: told(SCOUT), lines: [both({ toolCalls: [toolCall("chat_read", { from: 0 }, "scout_read")] }), "Mara asks who keeps the harbour light. Nobody has answered her yet."] },
      { name: "archivist", is: told(ARCHIVIST), lines: [both({ toolCalls: [toolCall("chat_grep", { text: "light" }, "archivist_grep")] }), "One line names the light: Mara's question, message 0."] },
      {
        name: "main",
        is: offers("write_reply"),
        lines: [
          {
            toolCalls: [
              toolCall("delegate", { agent: "scout", task: "Read message 0 and say what Mara asks." }, "to_scout"),
              toolCall("delegate", { agent: "archivist", task: "Find every line that names the light." }, "to_archivist"),
              toolCall("job_start", { agent: "tallyman", task: "Count the chat's messages and say whose they are.", when: "after_reply" }, "start_tally"),
            ],
          },
          replyHeld.held({ toolCalls: [toolCall("write_reply", { brief: "Okoro keeps the light; say so plainly." }, "reply_1")] }),
          { toolCalls: [toolCall("write_reply", { brief: "Ilse kept it before Okoro." }, "reply_2")] },
        ],
      },
      { name: "writer", is: bare, lines: ["Okoro keeps it now.", "Ilse did, until last spring."] },
    );
    it.host.script = play.script;

    let turn = "";
    const generating = it.generate(chatId, { onStarted: (id) => (turn = id) });

    // The job waits for the reply: every page's state has it, queued, while the turn still works.
    await until(() => replyHeld.waiting === 1 && activeJobs(it).length === 1, "the job to be queued while the turn works");
    const [queued] = (await state(it)).jobs.active;
    expect(queued).toMatchObject({ chatId, agent: "tallyman", when: "after_reply", state: "queued", by: { who: "agent", role: "main" }, basis: turn });
    const jobId = queued?.id ?? "";
    expect(play.calls("job")).toEqual([]);

    replyHeld.open();
    const out = await generating;
    expect(out.error).toBeNull();
    expect(out.content).toBe("Okoro keeps it now.");

    // Both sub-agents are in the turn's live view under the main agent, each with its own steps.
    await until(() => it.backend.live.runningOf(USER).every((run) => run.stream !== chatId), "the turn's end in the live view");
    const { events } = await live(it, chatId);
    const [main] = startedAs(events, "main");
    const [scout] = startedAs(events, "scout");
    const [archivist] = startedAs(events, "archivist");
    expect(scout).toMatchObject({ parent: main?.id, system: expect.stringContaining(SCOUT) });
    expect(archivist).toMatchObject({ parent: main?.id, system: expect.stringContaining(ARCHIVIST) });
    expect(stepsOf(events, scout?.id).map((s) => s.kind)).toEqual(["message", "answer", "result", "answer"]);
    expect(callsOf(stepsOf(events, scout?.id))).toMatchObject([{ name: "chat_read", error: false, text: expect.stringContaining("Who keeps the harbour light now?") }]);
    expect(callsOf(stepsOf(events, archivist?.id))).toMatchObject([{ name: "chat_grep", error: false, text: expect.stringContaining("Who keeps the harbour light now?") }]);
    // Each one's answer came back to the main agent as its delegate call's result.
    const handed = callsOf(stepsOf(events, main?.id));
    expect(handed.map((c) => c.name)).toEqual(["delegate", "delegate", "job_start", "write_reply"]);
    expect(handed[0]?.text).toContain("Nobody has answered her yet.");
    expect(handed[1]?.text).toContain("One line names the light");
    expect(handed[2]).toMatchObject({ error: false, text: expect.stringContaining(jobId) });
    // The trace says the job was started from this turn.
    expect(events.flatMap((e) => (e.kind === "job" ? [e.job.id] : []))).toEqual([jobId]);

    // Once the reply is written the job runs, followed under its own id.
    await until(() => jobHeld.waiting === 1 && activeJobs(it)[0]?.state === "running" && it.backend.live.runningOf(USER).some((run) => run.stream === jobId), "the job to run after the reply");
    expect((await state(it)).jobs.active).toMatchObject([{ id: jobId, state: "running" }]);
    expect((await state(it)).running).toMatchObject([{ stream: jobId, chatId, turn: jobId, kind: "job" }]);

    jobHeld.open();
    await until(() => activeJobs(it).length === 0, "the job to end");
    await it.backend.settle();
    const after = await state(it);
    expect(after.jobs.active).toEqual([]);
    expect(kinds(after.notices)).toEqual([["job_done", jobId]]);
    expect(after.notices[0]?.text).toContain(REPORT);
    // Its run is kept in the live view, with the tool it called.
    const ran = await live(it, jobId);
    expect(ran.view).toMatchObject({ stream: jobId, kind: "job", ended: { state: "done" } });
    expect(callsOf(stepsOf(ran.events, startedAs(ran.events, "tallyman")[0]?.id))).toMatchObject([{ name: "chat_read", error: false }]);
    // The Jobs page lists it done, with its report, under the turn that started it.
    const listed = await it.page.request("lah.jobs.list", { chatId, cursor: null, limit: 10 });
    expect(listed.jobs).toMatchObject([{ id: jobId, state: "done", basis: turn, opening: REPORT }]);
    const report = listed.jobs[0]?.report ?? "";
    expect((await it.page.request("lah.blob.get", { hash: report })).text).toBe(REPORT);
    // And the record of that turn lists the job with its report.
    const reply = it.host.message(chatId, out.messageId ?? "");
    await until(() => anchored(reply.own, 0)?.jobs?.[0]?.state === "done", "the job's end on its turn's record");
    expect(anchored(reply.own, 0)?.jobs).toEqual([{ id: jobId, agent: "tallyman", state: "done", report }]);

    // The next turn's main agent is told the job ended and how its report opens.
    it.host.say(chatId, "user", "And who kept it before him?");
    const next = await it.generate(chatId);
    expect(next.error).toBeNull();
    expect(next.content).toBe("Ilse did, until last spring.");
    const said = heard(play.calls("main")[2]);
    expect(said).toContain(jobId);
    expect(said).toContain(REPORT);
    await until(() => it.backend.live.runningOf(USER).length === 0, "the second turn's end in the live view");
    const second = await live(it, chatId);
    expect(second.events.flatMap((e) => (e.kind === "session" ? (e.session.jobs ?? []).map((j) => [j.id, j.state]) : []))).toEqual([[jobId, "done"]]);
  });

  test("stops a job when a swipe takes the reply it belongs to off the chat's path", async () => {
    const it = (r = await rig());
    const chatId = await it.setUp();
    await it.page.request("lah.agent.save", { agent: worker("tallyman", "Tallyman", "Counts things in the chat.", TALLY, ["chat_read"]) });
    // How long a job takes a turn that just ended as still being saved: past it, a turn that isn't on the path has left it.
    await it.page.request("lah.settings.set", { set: [{ path: ["core", "jobs", "recordWaitMs"], value: 1_000 }], reset: [] });
    const jobHeld = gate();
    const play = cast(
      { name: "job", is: told(AS_JOB), lines: [jobHeld.held("The chat holds one message, Mara's.")] },
      {
        name: "main",
        is: offers("write_reply"),
        lines: [
          { toolCalls: [toolCall("job_start", { agent: "tallyman", task: "Count the chat's messages.", when: "after_reply" }, "start_tally")] },
          { toolCalls: [toolCall("write_reply", { brief: "Okoro keeps the light." }, "reply_1")] },
          // The swipe's own turn.
          { toolCalls: [toolCall("write_reply", { brief: "Okoro keeps the light; say since when." }, "reply_2")] },
        ],
      },
      { name: "writer", is: bare, lines: ["Okoro keeps it now.", "Okoro has kept it since spring."] },
    );
    it.host.script = play.script;

    const first = await it.generate(chatId);
    const reply = it.host.message(chatId, first.messageId ?? "");
    await until(() => anchored(reply.own, 0) !== null, "the first reply's record");
    await until(() => jobHeld.waiting === 1 && activeJobs(it)[0]?.state === "running", "the job to run after the reply");
    const jobId = activeJobs(it)[0]?.id ?? "";
    expect(activeJobs(it)[0]?.basis).toBe(first.generationId);

    // The user swipes the reply while the job works: the turn it belongs to is no longer the one the chat shows.
    const swiped = await it.generate(chatId, { type: "swipe" });
    expect(swiped.error).toBeNull();
    expect(swiped.content).toBe("Okoro has kept it since spring.");
    expect(reply.swipeId).toBe(1);

    // The job's agent answers now, and its report has no turn on the path to belong to.
    jobHeld.open();
    await until(() => activeJobs(it).length === 0, "the job to stop");
    await it.backend.settle();
    const listed = await it.page.request("lah.jobs.list", { chatId, cursor: null, limit: 10 });
    expect(listed.jobs).toMatchObject([{ id: jobId, state: "off_path", basis: first.generationId }]);
    expect(listed.jobs[0]?.reason).toContain("no longer on the chat's active path");
    const after = await state(it);
    expect(after.jobs.active).toEqual([]);
    expect(kinds(after.notices)).toEqual([["job_failed", jobId]]);
    expect(after.notices[0]?.text).toContain("no longer on the chat's path");
  });
});

describe("a tool of an MCP server", () => {
  test("is offered once the user switches the server on, waits for their word once they have external tools ask first, and is called through Lumiverse", async () => {
    const it = (r = await rig());
    const chatId = await it.setUp();
    it.host.permissions.add("mcp_servers");
    it.host.mcpServers.push({
      server: { id: "srv-tides", name: "Harbour Tides", enabled: true, createdAt: 1 },
      tools: [{ name: "tide_table", description: "The day's tides for a harbour.", parameters: { type: "object", properties: { harbour: { type: "string" } }, required: ["harbour"] } }],
      run: (_tool, args) => `High water at ${String(args.harbour)}: 06:10.`,
    });

    // Nothing of the server is offered until the user switches it on for agents.
    const before = await it.page.request("lah.defs.get", {});
    expect(before.mcp).toEqual([{ id: "srv-tides", name: "Harbour Tides", off: true, status: "ready", tools: 0 }]);
    expect(before.tools.filter((t) => t.name.startsWith("mcp:"))).toEqual([]);
    const on = await it.page.request("lah.def.switch", { kind: "mcp", id: "srv-tides", off: false });
    expect(on.mcp).toEqual([{ id: "srv-tides", name: "Harbour Tides", off: false, status: "ready", tools: 1 }]);
    // Switching the server on was the user's word: its tools run without asking, as every tier's do unless Settings say otherwise.
    expect(on.tools.find((t) => t.name === "mcp:harbour-tides:tide_table")).toMatchObject({ family: "mcp:harbour-tides", tier: "external", runs: "extension", source: "user", off: false, approval: null, asks: false });
    // This user has every external tool ask first: one switch on the Tools page, for the whole tier.
    const asking = await it.page.request("lah.tier.approval", { tier: "external", approval: "ask" });
    expect(asking.tiers.external).toBe("ask");
    expect(asking.tools.find((t) => t.name === "mcp:harbour-tides:tide_table")).toMatchObject({ approval: null, asks: true });

    // An agent holds the tool when its definition names it, here by the server's family, which gives it every tool of the server; a sub-agent keeps what its definition names once Settings say so.
    const WATCHER = "You watch the tides for the harbour. Look the tide up before you answer.";
    await it.page.request("lah.agent.save", { agent: worker("tidewatcher", "Tidewatcher", "Looks up the day's tides.", WATCHER, ["@mcp:harbour-tides"]) });
    await it.page.request("lah.settings.set", { set: [{ path: ["core", "delegation", "grant"], value: "definition" }], reset: [] });
    const play = cast(
      {
        name: "tidewatcher",
        is: told(WATCHER),
        lines: [{ toolCalls: [toolCall("mcp:harbour-tides:tide_table", { harbour: "Okoro's Quay" }, "tide_1")] }, { toolCalls: [toolCall("mcp:harbour-tides:tide_table", { harbour: "Brann's Reach" }, "tide_2")] }, "High water is at 06:10 at both harbours."],
      },
      { name: "main", is: offers("write_reply"), lines: [{ toolCalls: [toolCall("delegate", { agent: "tidewatcher", task: "When is high water today?" }, "to_watcher")] }, { toolCalls: [toolCall("write_reply", { brief: "High water is at 06:10." }, "reply_1")] }] },
      { name: "writer", is: bare, lines: ["The tide turns at ten past six."] },
    );
    it.host.script = play.script;

    let turn = "";
    const generating = it.generate(chatId, { onStarted: (id) => (turn = id) });
    // An external tool's call now waits for the user: the page shows it, and Lumiverse has not been asked.
    await until(() => it.backend.approvals.views(USER).length === 1, "the tool's call to be held");
    const [held] = (await state(it)).approvals;
    expect(held).toMatchObject({ stream: chatId, turn, chatId, role: "tidewatcher", callId: "tide_1", tool: "mcp:harbour-tides:tide_table", tier: "external", args: { harbour: "Okoro's Quay" } });
    expect(it.host.mcpCalls).toEqual([]);

    // Approved for this chat: this call runs, and the next one of the tool isn't held.
    expect(await it.page.request("lah.approval.answer", { id: held?.id ?? "", answer: { decision: "chat" } })).toEqual({ answered: true });
    const out = await generating;
    expect(out.error).toBeNull();
    expect(out.content).toBe("The tide turns at ten past six.");
    expect(it.host.mcpCalls.map((c) => ({ serverId: c.serverId, tool: c.tool, args: c.args, userId: c.userId }))).toEqual([
      { serverId: "srv-tides", tool: "tide_table", args: { harbour: "Okoro's Quay" }, userId: USER },
      { serverId: "srv-tides", tool: "tide_table", args: { harbour: "Brann's Reach" }, userId: USER },
    ]);
    expect((await state(it)).approvals).toEqual([]);

    // The agent's steps hold the ask, the user's word and what the server answered.
    await until(() => it.backend.live.runningOf(USER).length === 0, "the turn's end in the live view");
    const { events } = await live(it, chatId);
    const steps = stepsOf(events, startedAs(events, "tidewatcher")[0]?.id);
    expect(steps.flatMap((s) => (s.kind === "approval_asked" || s.kind === "approval" ? [[s.kind, s.callId, s.kind === "approval" ? s.decision : s.tier]] : []))).toEqual([
      ["approval_asked", "tide_1", "external"],
      ["approval", "tide_1", "chat"],
    ]);
    expect(callsOf(steps)).toEqual([
      { name: "mcp:harbour-tides:tide_table", text: "High water at Okoro's Quay: 06:10.", error: false },
      { name: "mcp:harbour-tides:tide_table", text: "High water at Brann's Reach: 06:10.", error: false },
    ]);
  });
});

describe("a tool call that Settings hold for the user's word", () => {
  test("waits on every page until they answer: approved once it runs, refused it changes nothing and the agent is told why", async () => {
    const it = (r = await rig());
    const chatId = await it.setUp();
    // The user has every call that writes wait for them.
    await it.page.request("lah.settings.set", { set: [{ path: ["core", "approval", "tiers", "write"], value: "ask" }], reset: [] });
    const play = cast(
      {
        name: "main",
        is: offers("write_reply"),
        lines: [
          { toolCalls: [toolCall("workspace_write", { path: "/notes/light.md", content: "Okoro keeps the harbour light.", base: "new" }, "write_1")] },
          { toolCalls: [toolCall("workspace_write", { path: "/notes/brann.md", content: "Brann wants the light for himself.", base: "new" }, "write_2")] },
          { toolCalls: [toolCall("write_reply", { brief: "Okoro keeps the light." }, "reply_1")] },
        ],
      },
      { name: "writer", is: bare, lines: ["Okoro keeps it now."] },
    );
    it.host.script = play.script;

    let turn = "";
    const generating = it.generate(chatId, { onStarted: (id) => (turn = id) });
    await until(() => it.backend.approvals.views(USER).length === 1, "the first write to be held");
    const [first] = (await state(it)).approvals;
    expect(first).toMatchObject({ stream: chatId, turn, chatId, role: "main", callId: "write_1", tool: "workspace_write", tier: "write", args: { path: "/notes/light.md", content: "Okoro keeps the harbour light.", base: "new" } });
    // Held, it has written nothing.
    expect((await it.page.request("lah.ws.list", { chatId, area: "chat" })).files).toEqual([]);

    // Approved this once: the write is made, and the next call of the same tool waits again.
    expect(await it.page.request("lah.approval.answer", { id: first?.id ?? "", answer: { decision: "once" } })).toEqual({ answered: true });
    await until(() => it.backend.approvals.views(USER)[0]?.callId === "write_2", "the second write to be held");
    expect((await it.page.request("lah.ws.list", { chatId, area: "chat" })).files.map((f) => f.path)).toEqual(["notes/light.md"]);
    const [second] = (await state(it)).approvals;
    expect(second).toMatchObject({ turn, role: "main", callId: "write_2", tool: "workspace_write", tier: "write", args: { path: "/notes/brann.md" } });

    // Refused, with a reason: the agent is told it in the call's place, and goes on to the reply.
    expect(await it.page.request("lah.approval.answer", { id: second?.id ?? "", answer: { decision: "refused", reason: "Leave Brann out of the notes." } })).toEqual({ answered: true });
    const out = await generating;
    expect(out.error).toBeNull();
    expect(out.content).toBe("Okoro keeps it now.");
    expect((await state(it)).approvals).toEqual([]);
    const after = heard(play.calls("main")[2]);
    expect(after).toContain("the user refused this call of workspace_write");
    expect(after).toContain("Their reason: Leave Brann out of the notes.");

    // The live view holds each ask and the user's word on it, and the refused call's result as a failure.
    await until(() => it.backend.live.runningOf(USER).length === 0, "the turn's end in the live view");
    const { events } = await live(it, chatId);
    const steps = stepsOf(events, startedAs(events, "main")[0]?.id);
    expect(steps.flatMap((s) => (s.kind === "approval_asked" || s.kind === "approval" ? [[s.kind, s.callId, s.kind === "approval" ? s.decision : s.tier]] : []))).toEqual([
      ["approval_asked", "write_1", "write"],
      ["approval", "write_1", "once"],
      ["approval_asked", "write_2", "write"],
      ["approval", "write_2", "refused"],
    ]);
    expect(steps.find((s) => s.kind === "approval" && s.callId === "write_2")).toMatchObject({ reason: "Leave Brann out of the notes." });
    expect(callsOf(steps).map((c) => [c.name, c.error])).toEqual([
      ["workspace_write", false],
      ["workspace_write", true],
      ["write_reply", false],
    ]);
    // The chat's workspace holds the file the user approved, and not the one they refused.
    const reply = it.host.message(chatId, out.messageId ?? "");
    await until(() => anchored(reply.own, 0) !== null, "the reply's record");
    expect((await it.page.request("lah.ws.list", { chatId, area: "chat" })).files.map((f) => f.path)).toEqual(["notes/light.md"]);
  });
});

describe("a file tool", () => {
  test("is refused a path that leaves its area, and what it writes inside one is the only file there", async () => {
    const it = (r = await rig());
    const chatId = await it.setUp();
    const play = cast(
      {
        name: "main",
        is: offers("write_reply"),
        lines: [
          {
            toolCalls: [
              toolCall("workspace_write", { path: "../outside.md", content: "Okoro keeps the harbour light.", base: "new" }, "write_out"),
              toolCall("workspace_read", { path: "~/../../etc/passwd" }, "read_out"),
              toolCall("workspace_write", { path: "/notes/light.md", content: "Okoro keeps the harbour light.", base: "new" }, "write_in"),
            ],
          },
          { toolCalls: [toolCall("write_reply", { brief: "Okoro keeps the light." }, "reply_1")] },
        ],
      },
      { name: "writer", is: bare, lines: ["Okoro keeps it now."] },
    );
    it.host.script = play.script;

    const out = await it.generate(chatId);
    expect(out.error).toBeNull();
    expect(out.content).toBe("Okoro keeps it now.");

    await until(() => it.backend.live.runningOf(USER).length === 0, "the turn's end in the live view");
    const { events } = await live(it, chatId);
    const calls = callsOf(stepsOf(events, startedAs(events, "main")[0]?.id));
    expect(calls.map((c) => [c.name, c.error])).toEqual([
      ["workspace_write", true],
      ["workspace_read", true],
      ["workspace_write", false],
      ["write_reply", false],
    ]);
    // Each refusal says what was wrong with the path, and the agent read both before it went on.
    expect(calls[0]?.text).toContain("That path climbs out of its area");
    expect(calls[1]?.text).toContain("That path climbs out of its area");
    expect(heard(play.calls("main")[1])).toContain("That path climbs out of its area");

    // The page shows the one file that was written, in the chat's area, and none in the user's own.
    const reply = it.host.message(chatId, out.messageId ?? "");
    await until(() => anchored(reply.own, 0) !== null, "the reply's record");
    const chat = await it.page.request("lah.ws.list", { chatId, area: "chat" });
    expect(chat.files.map((f) => [f.path, f.by])).toEqual([["notes/light.md", { who: "agent", id: startedAs(events, "main")[0]?.id ?? "", role: "main" }]]);
    expect((await it.page.request("lah.ws.list", { chatId, area: "user" })).files).toEqual([]);
    expect((await it.page.request("lah.ws.list", { chatId, area: "learned" })).files).toEqual([]);
    // Nothing was kept under either name anywhere in the user's storage.
    expect([...it.host.files.keys()].filter((path) => path.includes("outside") || path.includes("passwd"))).toEqual([]);
  });
});

describe("the user's words to a turn under way", () => {
  test("reach its main agent: a pause holds it at its next round, a note is read when it goes on, and the live view shows all three", async () => {
    const it = (r = await rig());
    const chatId = await it.setUp();
    const firstHeld = gate();
    const play = cast(
      { name: "main", is: offers("write_reply"), lines: [firstHeld.held({ toolCalls: [toolCall("chat_read", { from: 0 }, "read_1")] }), { toolCalls: [toolCall("write_reply", { brief: "Okoro keeps the light. Leave Brann out." }, "reply_1")] }] },
      { name: "writer", is: bare, lines: ["Okoro keeps it now."] },
    );
    it.host.script = play.script;
    // The page follows the chat, so each step of the turn reaches it as it is traced.
    await it.page.request("lah.live.open", { stream: chatId });

    let turn = "";
    const generating = it.generate(chatId, { onStarted: (id) => (turn = id) });
    await until(() => firstHeld.waiting === 1 && it.backend.live.runningOf(USER).length === 1, "the main agent's first call to be under way");

    // Held while its first call is still out: the call comes back and its tool runs, and there the agent waits.
    expect(await it.page.request("lah.turn.pause", { stream: chatId, turn, on: true })).toEqual({ paused: true });
    await until(() => it.backend.live.runningOf(USER)[0]?.paused === true, "the pause to show on the page");
    expect((await state(it)).running).toMatchObject([{ stream: chatId, turn, paused: true }]);
    expect(await it.page.request("lah.turn.say", { stream: chatId, turn, text: "Keep Brann out of this one." })).toEqual({ said: true });
    firstHeld.open();
    // What the page that follows the chat has been pushed so far is read without a wait: the round's result has been traced once it is there.
    await until(() => it.page.pushes.some((p) => p.type === "lah.live" && p.stream === chatId && ("view" in p.change ? p.change.view.events : p.change.events).some((e) => e.event.kind === "agent_entry" && e.event.entry.kind === "result")), "the first round's tool result");
    expect(play.calls("main")).toHaveLength(1);

    // Let go, it reads the note at the start of its next round, marked as the user's.
    expect(await it.page.request("lah.turn.pause", { stream: chatId, turn, on: false })).toEqual({ paused: false });
    const out = await generating;
    expect(out.error).toBeNull();
    expect(out.content).toBe("Okoro keeps it now.");
    const second = heard(play.calls("main")[1]);
    expect(second).toContain("[The user says, while you work:]\nKeep Brann out of this one.");

    await until(() => it.backend.live.runningOf(USER).length === 0, "the turn's end in the live view");
    const trace = (await live(it, chatId)).events;
    const main = startedAs(trace, "main")[0]?.id;
    const order = trace.flatMap((e): string[] => (e.kind === "turn_paused" || e.kind === "turn_resumed" ? [e.kind] : e.kind === "agent_entry" && e.agentId === main && (e.entry.kind === "answer" || e.entry.kind === "note" || e.entry.kind === "result") ? [e.entry.kind] : []));
    // Its second answer follows the resume: nothing was asked of the model while the turn was held.
    expect(order).toEqual(["turn_paused", "answer", "result", "turn_resumed", "note", "answer", "result"]);
    expect(stepsOf(trace, main).find((s) => s.kind === "note")).toMatchObject({ text: "Keep Brann out of this one." });
    // A turn that has ended takes no more words.
    expect(await it.page.request("lah.turn.say", { stream: chatId, turn, text: "Too late." })).toEqual({ said: false });
  });
});

/** A runtime started again on the rig's registration, as after a restart: the same config, a new process. */
async function relinked(it: Rig): Promise<Runtime> {
  const second = runtimeFor(it.lumiverse, it.registration, []);
  // The real runtime's clockwork (its link's pings, a gap asked about again) has no clock a test can move by hand, as rig.ts says of the first one's: it is run every few milliseconds, as the rig runs that.
  const ticker = setInterval(() => second.tick(), 5);
  also.push(async () => {
    clearInterval(ticker);
    second.shutdown();
    await second.close();
  });
  await second.link.connect();
  return second;
}

describe("a job a runtime restart cut off", () => {
  test("is listed as interrupted once a runtime is linked again, and the user is told", async () => {
    const power = plug();
    const it = (r = await rig({ wire: power.wire }));
    const chatId = await it.setUp();
    await it.page.request("lah.agent.save", { agent: worker("tallyman", "Tallyman", "Counts things in the chat.", TALLY, ["chat_read"]) });
    // The job's agent asks its model, and no answer comes before the runtime goes down.
    const play = cast({ name: "job", is: told(AS_JOB), lines: [{ hang: true }] });
    it.host.script = play.script;

    const { job } = await it.page.request("lah.job.start", { chatId, agent: "tallyman", task: "Count the chat's messages.", when: "now" });
    expect(job).toMatchObject({ chatId, agent: "tallyman", when: "now", by: { who: "user" } });
    await until(() => play.calls("job").length === 1 && activeJobs(it)[0]?.state === "running" && it.backend.live.runningOf(USER).some((run) => run.stream === job.id), "the job to be at work");

    // The runtime's process is killed as the job works: it writes and says nothing more, so the page still shows the job running.
    power.pull();
    // Nor does a killed process stop in good order: what it kept stays on its disk, and nothing of it waits for the extension's storage.
    await it.runtime.store.close();
    await it.close();
    expect((await state(it)).jobs.active).toMatchObject([{ id: job.id, state: "running" }]);

    // Started again on the same registration, the runtime finds the job it was cut off from.
    await relinked(it);

    await until(() => activeJobs(it).length === 0, "the job to be found interrupted");
    await it.backend.settle();
    const listed = await it.page.request("lah.jobs.list", { chatId: null, cursor: null, limit: 10 });
    expect(listed.jobs).toMatchObject([{ id: job.id, state: "interrupted" }]);
    expect(listed.jobs[0]?.reason).toContain("the runtime restarted while it ran");
    const after = await state(it);
    expect(after.jobs.active).toEqual([]);
    expect(kinds(after.notices)).toEqual([["job_interrupted", job.id]]);
    expect(after.notices[0]?.text).toContain("was cut off by a restart");
  });

  test("leaves a job that still waited for its place to be run by the runtime that is linked next", async () => {
    const power = plug();
    const it = (r = await rig({ wire: power.wire }));
    const chatId = await it.setUp();
    await it.page.request("lah.agent.save", { agent: worker("tallyman", "Tallyman", "Counts things in the chat.", TALLY, ["chat_read"]) });
    const play = cast({ name: "count", is: told("Count the chat's messages."), lines: [{ hang: true }] }, { name: "list", is: told("List who speaks in the chat."), lines: ["Mara speaks, and nobody has answered her yet."] });
    it.host.script = play.script;

    // One job runs at a time unless Settings say otherwise: the second waits for the first one's place.
    const first = (await it.page.request("lah.job.start", { chatId, agent: "tallyman", task: "Count the chat's messages.", when: "now" })).job;
    await until(() => play.calls("count").length === 1, "the first job to be at work");
    const second = (await it.page.request("lah.job.start", { chatId, agent: "tallyman", task: "List who speaks in the chat.", when: "now" })).job;
    await until(() => activeJobs(it).length === 2 && activeJobs(it)[0]?.state === "running", "both jobs on the page");
    expect(activeJobs(it).map((j) => [j.id, j.state])).toEqual([
      [first.id, "running"],
      [second.id, "queued"],
    ]);

    power.pull();
    await it.runtime.store.close();
    await it.close();
    await relinked(it);
    await until(() => activeJobs(it).length === 0, "the first job to be found interrupted and the second to have run");
    await it.backend.settle();
    const listed = await it.page.request("lah.jobs.list", { chatId, cursor: null, limit: 10 });
    expect(listed.jobs.map((j) => [j.id, j.state])).toEqual([
      [second.id, "done"],
      [first.id, "interrupted"],
    ]);
    expect(listed.jobs[0]?.opening).toBe("Mara speaks, and nobody has answered her yet.");
    // The newer notice first.
    expect(kinds((await state(it)).notices).sort()).toEqual([
      ["job_done", second.id],
      ["job_interrupted", first.id],
    ]);
  });
});
