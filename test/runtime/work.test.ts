// The transport of what a later slice of the core does (DESIGN §13 to §21), with a scripted harness
// in the core's place: what a test here checks is that each thing crosses the link and reaches the
// other side as it should (a tool that runs in the extension, a held call and the user's word, a
// job's run and its end, the user's words to a run under way, a page's request the core serves, what
// an extension that LumiAH is built into supplies), whatever the core then does with it.

import { afterEach, describe, expect, test } from "bun:test";
import type { HarnessExtension } from "../../src/core/extension";
import type { Harness as Core } from "../../src/core/harness";
import type { AgentUsage, HarnessHost, JobView, TraceEvent } from "../../src/core/ports";
import { newAgentSettings } from "../../src/core/settings";
import type { BackendExtension, BackendTools } from "../../src/extension/backend/extension";
import type { Harness } from "../../src/runtime/turn";
import { UiFailure } from "../support/fake-lumiverse";
import { type Rig, rig, until, USER } from "../support/rig";

const USAGE: AgentUsage = { calls: 1, toolTurns: 0, in: 10, cachedIn: 0, out: 5, reasoningOut: 0, estimated: false, ms: 1 };

function job(id: string, chatId: string, more: Partial<JobView> = {}): JobView {
  return { id, chatId, agent: "scout", task: "Find who kept the harbour light before Okoro.", when: "now", state: "queued", by: { who: "user" }, basis: null, createdAt: 1_000, usage: { ...USAGE, calls: 0 }, ...more };
}

/** What the scripted harness was asked, and what a test has it do. */
interface Script {
  host: HarnessHost | null;
  extension: HarnessExtension | null;
  /** Jobs the next reply turn queues before it writes its reply. */
  queue: JobView[];
  /** Holds the reply turn, a job's run or a side turn open until the test lets it go. */
  gate: PromiseWithResolvers<void> | null;
  ran: string[];
  said: { run: string; text: string }[];
  held: string[];
  asked: { op: string; args: unknown }[];
  recovered: JobView[];
  sideTurns: { session: string; generationId: string; text: string }[];
  /** The chat the script's one side session is about; "": about none. */
  sideChat: string;
}

function script(): Script {
  return { host: null, extension: null, queue: [], gate: null, ran: [], said: [], held: [], asked: [], recovered: [], sideTurns: [], sideChat: "" };
}

/** A harness that does what its script says and traces as the core would. */
function scripted(s: Script): NonNullable<Parameters<typeof rig>[0]>["harness"] {
  return (host, _settings, extension, place) => {
    // The same script stands for the core in both places; what a test does to "the harness's host" it does to the runtime's.
    if (place === "runtime") {
      s.host = host;
      s.extension = extension;
    }
    const seqs = new Map<string, number>();
    const trace = (turn: string, chatId: string, event: TraceEvent): void => {
      const seq = (seqs.get(turn) ?? 0) + 1;
      seqs.set(turn, seq);
      host.trace.event({ turn, chatId, seq, event });
    };
    // What a page asks of the core, each answered as the core's own type says it is: the two can't drift apart unseen.
    const pages = {
      workspace: {
        async read(input) {
          s.asked.push({ op: "workspace.read", args: input });
          const version = { hash: "a".repeat(64), chars: 9, at: 5, by: { who: "user" as const } };
          return { file: { path: input.path, ...version, pins: [] }, text: "Low tide.", version };
        },
        async write(input) {
          s.asked.push({ op: "workspace.write", args: input });
          throw Object.assign(new Error("notes.md changed since you opened it: read it again."), { code: "conflict" });
        },
      },
      sides: {
        list: async () => ({ sides: [{ id: "side-ilse", chatId: s.sideChat, agent: "scout", title: "The tide tables", createdAt: 1, lastAt: 1, turns: 0 }] }),
        turns: async ({ id }) => ({ side: { id, chatId: s.sideChat, agent: "scout", title: "The tide tables", createdAt: 1, lastAt: 1, turns: 0 }, turns: [] }),
      },
      definitions: { get: async () => ({ agents: [], skills: [], tools: [], agentSchema: { type: "object" }, agentDefaults: newAgentSettings(), scope: { tools: [], agents: [] } }) },
    } satisfies { workspace: Pick<Core["workspace"], "read" | "write">; sides: Pick<Core["sides"], "list" | "turns">; definitions: Core["definitions"] };
    const harness = {
      async answer(turn, sink, signal) {
        trace(turn.generationId, turn.chatId, { kind: "turn_started", turn: turn.generationId, chatId: turn.chatId, generation: turn.kind, messageId: turn.target.messageId, at: 1 });
        for (const queued of s.queue) host.jobs?.queued(queued);
        if (s.gate !== null) await Promise.race([s.gate.promise, new Promise<void>((resolve) => signal.addEventListener("abort", () => resolve(), { once: true }))]);
        sink.content("Okoro keeps it now.");
        sink.done("stop", USAGE);
        trace(turn.generationId, turn.chatId, { kind: "turn_ended", status: "done", usage: USAGE, at: 2 });
        return { status: "done", record: null, reply: "Okoro keeps it now.", usage: USAGE };
      },
      jobs: {
        async run({ id }, signal) {
          const queued = s.queue.find((j) => j.id === id) ?? job(id, "");
          s.ran.push(id);
          trace(id, queued.chatId, { kind: "turn_started", turn: id, chatId: queued.chatId, generation: "job", messageId: null, job: id, at: 3 });
          host.jobs?.changed?.({ ...queued, state: "running", startedAt: 3 });
          if (s.gate !== null) await Promise.race([s.gate.promise, new Promise<void>((resolve) => signal.addEventListener("abort", () => resolve(), { once: true }))]);
          const cancelled = signal.aborted;
          trace(id, queued.chatId, { kind: "turn_ended", status: cancelled ? "stopped" : "done", usage: USAGE, at: 4 });
          host.jobs?.changed?.(cancelled ? { ...queued, state: "cancelled", endedAt: 4, reason: "It was stopped." } : { ...queued, state: "done", endedAt: 4, opening: "Ilse kept it before him.", report: "b".repeat(64) });
        },
        recover: async () => ({ interrupted: s.recovered, paused: [], queued: [] }),
      },
      async side(input, _sink, signal) {
        s.sideTurns.push(input);
        trace(input.generationId, "", { kind: "turn_started", turn: input.generationId, chatId: "", generation: "side", messageId: null, side: input.session, at: 5 });
        if (s.gate !== null) await Promise.race([s.gate.promise, new Promise<void>((resolve) => signal.addEventListener("abort", () => resolve(), { once: true }))]);
        trace(input.generationId, "", { kind: "turn_ended", status: "done", usage: USAGE, at: 6 });
      },
      async say({ run, text }) {
        s.said.push({ run, text });
        if (!seqs.has(run)) throw Object.assign(new Error("There is no such run under way."), { code: "not_found" });
        return { said: true };
      },
      async pause({ run }) {
        if (!seqs.has(run)) throw Object.assign(new Error("There is no such run under way."), { code: "not_found" });
        s.held.push(run);
        trace(run, "", { kind: "turn_paused", at: 7 });
        return { paused: true };
      },
      async resume({ run }) {
        if (!s.held.includes(run)) throw Object.assign(new Error("There is no such run under way."), { code: "not_found" });
        s.held.splice(s.held.indexOf(run), 1);
        trace(run, "", { kind: "turn_resumed", at: 8 });
        return { paused: false };
      },
      ...pages,
    } satisfies Harness & Record<string, unknown>;
    return harness;
  };
}

let open: Rig | null = null;
afterEach(() => {
  open?.close();
  open = null;
});

async function start(s: Script, backend?: { extension?: BackendExtension; tools?: BackendTools }): Promise<{ it: Rig; chatId: string; host: HarnessHost }> {
  const it = await rig({ harness: scripted(s), ...(backend !== undefined ? { backend } : {}) });
  open = it;
  const chatId = await it.setUp();
  if (s.host === null) throw new Error("the runtime made no harness");
  return { it, chatId, host: s.host };
}

const state = (it: Rig) => it.page.request("lah.hello", {});

describe("a job", () => {
  test("queued for after the reply runs once the reply turn has returned, and the page hears how it stands and that it finished", async () => {
    const s = script();
    const { it, chatId } = await start(s);
    s.queue = [job("job-after", chatId, { when: "after_reply", by: { who: "agent", id: "main", role: "main" } }), job("job-now", chatId)];
    s.gate = Promise.withResolvers<void>();

    const generating = it.generate(chatId);
    // The job for now runs beside the turn; the one for after the reply waits for it.
    await until(() => s.ran.includes("job-now"), "the job for now to start");
    expect(s.ran).toEqual(["job-now"]);
    await until(() => it.backend.jobs.active(USER, "job-after") !== null && it.backend.jobs.active(USER, "job-now")?.state === "running", "the page's jobs");
    expect((await state(it)).jobs.active.map((j) => [j.id, j.state])).toEqual([
      ["job-after", "queued"],
      ["job-now", "running"],
    ]);
    // Its run is followed under the job's own id.
    await until(() => it.backend.live.runningOf(USER).some((r) => r.stream === "job-now"), "the job's run in the live view");
    const live = await it.page.request("lah.live.open", { stream: "job-now" });
    expect(live.live).toMatchObject({ stream: "job-now", chatId, turn: "job-now", kind: "job", ended: null });

    s.gate.resolve();
    const out = await generating;
    expect(out.error).toBeNull();
    await until(() => s.ran.includes("job-after"), "the job for after the reply to start");
    await until(() => it.backend.jobs.active(USER, "job-after") === null && it.backend.jobs.active(USER, "job-now") === null, "both jobs to end");
    await it.backend.settle();
    const after = await state(it);
    expect(after.jobs.active).toEqual([]);
    expect(after.notices.map((n) => [n.kind, n.jobId]).sort()).toEqual([
      ["job_done", "job-after"],
      ["job_done", "job-now"],
    ]);
    expect(after.notices[0]?.text).toContain("Ilse kept it before him.");
    // Dismissed, it is gone from every page's state.
    expect((await it.page.request("lah.notice.dismiss", { id: null })).notices).toEqual([]);
  });

  test("stopped from its live view ends by its signal, and one a restart cut off is told as interrupted", async () => {
    const s = script();
    s.recovered = [job("job-cut", "chat-gone", { state: "interrupted", endedAt: 9, reason: "The runtime restarted while it ran." })];
    const { it, chatId, host } = await start(s);
    // The link is up: what the restart cut off was looked for, and the page is told.
    await until(() => it.backend.jobs.known(USER), "the interrupted job to be told");
    await it.backend.settle();
    expect((await state(it)).notices.map((n) => [n.kind, n.jobId])).toEqual([["job_interrupted", "job-cut"]]);

    s.gate = Promise.withResolvers<void>();
    s.queue = [job("job-long", chatId)];
    host.jobs?.queued(s.queue[0] as JobView);
    await until(() => it.backend.live.runningOf(USER).some((r) => r.turn === "job-long"), "the job's run in the live view");
    expect(await it.page.request("lah.turn.stop", { stream: "job-long", turn: "job-long" })).toEqual({ stopped: true });
    await until(() => it.backend.jobs.active(USER, "job-long") === null, "the job to end");
    expect(it.runtime.work.ids()).toEqual([]);
  });
});

describe("a tool that runs in the extension", () => {
  test("is listed with the tools of an MCP server the user switched on, and each is called where it lives", async () => {
    const s = script();
    const calls: { name: string; userId: string }[] = [];
    const tools: BackendTools = {
      list: async () => [{ name: "harbour_log", family: "harbour", tier: "external", description: "The harbour master's log for a day.", parameters: { type: "object", properties: {} }, source: "extension" }],
      call: async (call, _signal, userId) => {
        calls.push({ name: call.name, userId });
        return { text: "Brann signed the log at dawn." };
      },
    };
    const { it, chatId, host } = await start(s, { tools });
    it.host.permissions.add("mcp_servers");
    it.host.mcpServers.push({ server: { id: "srv-1", name: "Harbour Tides", enabled: true, createdAt: 1 }, tools: [{ name: "tide_table", description: "The day's tides.", parameters: { type: "object", properties: {} } }], run: (_tool, args) => `High water at ${String(args.harbour)}: 06:10.` });

    // An MCP server offers nothing until the user switches it on.
    expect((await host.tools?.list(chatId))?.map((t) => t.name)).toEqual(["harbour_log"]);
    const defs = await it.page.request("lah.def.switch", { kind: "mcp", id: "srv-1", off: false });
    expect(defs.mcp).toEqual([{ id: "srv-1", name: "Harbour Tides", off: false, status: "ready", tools: 1 }]);
    expect(await host.tools?.list(chatId)).toMatchObject([
      { name: "harbour_log", source: "extension" },
      { name: "mcp:harbour-tides:tide_table", family: "mcp:harbour-tides", tier: "external", source: "user" },
    ]);

    const call = { turn: "turn-1", chatId, agentId: "main", role: "main", callId: "call-1", kind: "new" as const, main: true, above: [] };
    const signal = new AbortController().signal;
    expect(await host.tools?.call({ ...call, name: "mcp:harbour-tides:tide_table", args: { harbour: "Okoro's Quay" } }, signal)).toEqual({ text: "High water at Okoro's Quay: 06:10." });
    expect(it.host.mcpCalls).toMatchObject([{ serverId: "srv-1", tool: "tide_table", userId: USER }]);
    expect(await host.tools?.call({ ...call, name: "harbour_log", args: {} }, signal)).toEqual({ text: "Brann signed the log at dawn." });
    expect(calls).toEqual([{ name: "harbour_log", userId: USER }]);
    // A failure is the tool's answer, in words the model can act on.
    expect(await host.tools?.call({ ...call, name: "mcp:harbour-tides:storm_warning", args: {} }, signal)).toEqual({ text: "MCP tool is not advertised by this server", error: true });
  });
});

describe("a tool call held for the user's word", () => {
  test("shows on every page, and goes on, is refused with the user's reason, or is taken down when the wait is given up", async () => {
    const s = script();
    const { it, chatId, host } = await start(s);
    const ask = { turn: "turn-1", chatId, agentId: "main", role: "main", callId: "call-1", tool: "workspace_write", tier: "write" as const, args: { path: "notes.md" }, at: 10, until: null };

    const first = host.approvals?.ask(ask, new AbortController().signal);
    await until(() => it.backend.approvals.views(USER).length === 1, "the held call to show");
    const [held] = (await state(it)).approvals;
    expect(held).toMatchObject({ ...ask, stream: "turn-1" });
    expect(await it.page.request("lah.approval.answer", { id: held?.id ?? "", answer: { decision: "chat" } })).toEqual({ answered: true });
    expect(await first).toEqual({ decision: "chat" });
    // Answered once: a second word finds nothing waiting.
    expect(await it.page.request("lah.approval.answer", { id: held?.id ?? "", answer: { decision: "once" } })).toEqual({ answered: false });

    const second = host.approvals?.ask({ ...ask, callId: "call-2" }, new AbortController().signal);
    await until(() => it.backend.approvals.views(USER).length === 1, "the second held call");
    const id = it.backend.approvals.views(USER)[0]?.id ?? "";
    await it.page.request("lah.approval.answer", { id, answer: { decision: "refused", reason: "Leave Joss's notes alone." } });
    expect(await second).toEqual({ decision: "refused", reason: "Leave Joss's notes alone." });

    const gaveUp = new AbortController();
    const third = host.approvals?.ask({ ...ask, callId: "call-3" }, gaveUp.signal);
    await until(() => it.backend.approvals.views(USER).length === 1, "the third held call");
    gaveUp.abort(new Error("Nobody answered in time."));
    await expect(third).rejects.toThrow("Nobody answered in time.");
    await until(() => it.backend.approvals.views(USER).length === 0, "the ask to be taken down");
    expect((await state(it)).approvals).toEqual([]);
  });
});

describe("the user's words to a run under way", () => {
  test("reach it: a note, a pause the pages then show, and a resume", async () => {
    const s = script();
    const { it, chatId } = await start(s);
    s.gate = Promise.withResolvers<void>();
    const generating = it.generate(chatId);
    await until(() => it.backend.live.runningOf(USER).length === 1, "the turn to be running");
    const turn = it.backend.live.runningOf(USER)[0]?.turn ?? "";

    expect(await it.page.request("lah.turn.say", { stream: chatId, turn, text: "Keep Brann out of this one." })).toEqual({ said: true });
    expect(s.said).toEqual([{ run: turn, text: "Keep Brann out of this one." }]);

    expect(await it.page.request("lah.turn.pause", { stream: chatId, turn, on: true })).toEqual({ paused: true });
    await until(() => it.backend.live.runningOf(USER)[0]?.paused === true, "the pause to show");
    expect((await state(it)).running).toMatchObject([{ stream: chatId, turn, paused: true }]);
    expect(await it.page.request("lah.turn.pause", { stream: chatId, turn, on: false })).toEqual({ paused: false });
    await until(() => it.backend.live.runningOf(USER)[0]?.paused === false, "the resume to show");

    s.gate.resolve();
    await generating;
    await until(() => it.backend.live.runningOf(USER).length === 0, "the turn to end");
    // A turn that has ended takes no more words.
    expect(await it.page.request("lah.turn.say", { stream: chatId, turn, text: "Too late." })).toEqual({ said: false });
    expect(s.said).toHaveLength(1);
  });
});

describe("what a page asks of the core", () => {
  test("is done by the runtime's harness with the request's own body, and a refusal keeps its code", async () => {
    const s = script();
    const { it, chatId } = await start(s);
    const read = await it.page.request("lah.ws.read", { chatId, area: "chat", path: "notes.md" });
    expect(read).toEqual({ file: { path: "notes.md", hash: "a".repeat(64), chars: 9, at: 5, by: { who: "user" }, pins: [] }, text: "Low tide.", version: "a".repeat(64) });
    expect(s.asked).toEqual([{ op: "workspace.read", args: { chatId, area: "chat", path: "notes.md" } }]);

    const refused = await it.page.request("lah.ws.write", { chatId, area: "chat", path: "notes.md", text: "High tide.", base: "a".repeat(64) }).catch((error: unknown) => error);
    expect(refused).toBeInstanceOf(UiFailure);
    expect((refused as UiFailure).error).toMatchObject({ code: "conflict", message: "notes.md changed since you opened it: read it again." });
    // What this build's core doesn't do is said so, not left hanging.
    const missing = await it.page.request("lah.spend.get", { days: 7 }).catch((error: unknown) => error);
    expect((missing as UiFailure).error.code).toBe("unavailable");
    // Another account's chat is no chat at all.
    const other = it.host.addChat("user-joss", "Joss's log");
    const foreign = await it.page.request("lah.ws.read", { chatId: other.id, area: "chat", path: "notes.md" }).catch((error: unknown) => error);
    expect((foreign as UiFailure).error.code).toBe("not_found");
  });

  test("starts a side session's turn, followed under the session's id, one at a time", async () => {
    const s = script();
    const { it, chatId } = await start(s);
    // The session is about the chat that runs in the runtime, so its turn is the runtime's to run.
    s.sideChat = chatId;
    s.gate = Promise.withResolvers<void>();
    const sent = await it.page.request("lah.side.send", { session: "side-ilse", text: "Which tide table is the right one?" });
    expect(sent.session).toMatchObject({ id: "side-ilse", title: "The tide tables" });
    expect(s.sideTurns).toEqual([{ session: "side-ilse", generationId: sent.turn, text: "Which tide table is the right one?" }]);
    await until(() => it.backend.live.runningOf(USER).length === 1, "the side turn in the live view");
    expect(it.backend.live.runningOf(USER)[0]).toMatchObject({ stream: "side-ilse", chatId: null, turn: sent.turn, kind: "side" });

    const again = await it.page.request("lah.side.send", { session: "side-ilse", text: "And tomorrow?" }).catch((error: unknown) => error);
    expect((again as UiFailure).error.code).toBe("unavailable");
    s.gate.resolve();
    await until(() => it.backend.live.runningOf(USER).length === 0, "the side turn to end");
  });
});

describe("what an extension that LumiAH is built into supplies", () => {
  test("is asked of its backend, member by member, for the user the runtime serves", async () => {
    const s = script();
    const hooks: string[] = [];
    const extension: BackendExtension = {
      name: "harbour_ext",
      definitions: async () => ({ skills: [{ id: "tide_reading", name: "Reading a tide table", description: "How to read the harbour's tide tables.", body: "Find the day, then the harbour." }] }),
      claim: async (chat, userId) => (chat.name === "Harbour light" ? { mainAgent: `harbour_main_for_${userId}` } : null),
      runBegan: async (run, userId) => void hooks.push(`${run.kind} ${run.turn} for ${userId}`),
    };
    const { it, chatId } = await start(s, { extension });
    const supplied = s.extension;
    if (supplied === null) throw new Error("the runtime handed the harness no extension");
    await until(() => supplied.name === "harbour_ext", "the extension's offer to arrive with the link");

    // The runtime's harness names no user in what it asks (a runtime serves one): the backend hands each member the user the runtime registered for.
    expect(await supplied.definitions?.({ userId: "", chatId: null })).toEqual({ skills: [{ id: "tide_reading", name: "Reading a tide table", description: "How to read the harbour's tide tables.", body: "Find the day, then the harbour." }] });
    expect(await supplied.claim?.({ userId: "", chatId, chat: { id: chatId, name: "Harbour light", characterId: null, characterName: null, branchedFrom: null } })).toEqual({ mainAgent: `harbour_main_for_${USER}` });
    // A chat it doesn't claim is the user's own all the same, read as Lumiverse has it; one that is no chat of theirs never reaches the member.
    const elsewhere = it.host.addChat(USER, "Elsewhere");
    expect(await supplied.claim?.({ userId: "", chatId: elsewhere.id, chat: { id: elsewhere.id, name: "Harbour light", characterId: null, characterName: null, branchedFrom: null } })).toBeNull();
    expect(await supplied.claim?.({ userId: "", chatId: "chat-none", chat: { id: "chat-none", name: "Harbour light", characterId: null, characterName: null, branchedFrom: null } }).catch((error: unknown) => String(error))).toContain("There is no such chat in this account.");
    // A user an ask names is not taken at its word.
    await supplied.runBegan?.({ userId: "user-joss", chatId, turn: "turn-9", kind: "new" });
    expect(hooks).toEqual([`new turn-9 for ${USER}`]);
    // What it doesn't supply is never asked for: the core is told so at once.
    const before = it.host.sent.length;
    expect(await supplied.writerRequest?.({ userId: "", chatId, generationId: "turn-9", kind: "new", brief: null, messages: [] })).toBeNull();
    await supplied.runEnded?.({ userId: "", chatId, turn: "turn-9", kind: "new", status: "done", reply: "", record: null, usage: USAGE });
    expect(it.host.sent.length).toBe(before);
  });
});
