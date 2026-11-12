// The pages' requests the core serves (DESIGN §8, §11, §12, §15, §19, §20), each asked of the
// runtime it belongs to (what is about a chat on a loopback connection, of that chat's runtime; what
// is about no chat, of the user's runtime), with a scripted harness in the core's place: each
// request reaches the core with the input its method takes, and the page is answered a view of its
// own contract (src/shared/ui.ts), with what the core doesn't hold put in: a chat's name, an
// agent's, a connection's, a setting's title, the reply a version was made at, a side session's
// turn under way. The scripted answers are typed with the core's own types, so the core and what is
// checked here can't drift apart unseen.

import { afterEach, describe, expect, test } from "bun:test";
import type { Harness as Core } from "../../../src/core/harness";
import type { AgentUsage, JobView, TraceEvent, TurnRecord } from "../../../src/core/ports";
import { defaultSettings, newAgentSettings } from "../../../src/core/settings";
import { toJsonObject } from "../../../src/link/json";
import type { Harness } from "../../../src/runtime/turn";
import type { SideTurn } from "../../../src/shared/ui";
import { UiFailure } from "../../support/fake-lumiverse";
import { type Rig, rig, until, USER } from "../../support/rig";

/** What a page-facing method of the core's harness answers. */
type Answer<G extends keyof Core, M extends keyof Core[G]> = Core[G][M] extends (...args: never[]) => Promise<infer A> ? A : never;

const USAGE: AgentUsage = { calls: 2, toolTurns: 1, in: 120, cachedIn: 40, out: 30, reasoningOut: 0, estimated: false, ms: 900 };

/** A blob's hash, made of one character. */
const hash = (c: string): string => c.repeat(64);

const FILE: Answer<"workspace", "read">["file"] = { path: "notes/tides.md", hash: hash("a"), chars: 17, at: 90, by: { who: "user" }, pins: [] };

const LIMITS = { fileChars: 200_000, files: 400, areaChars: 4_000_000, pinChars: 12_000 };

const SCOUT: Answer<"definitions", "get">["agents"][number] = { ...newAgentSettings(), id: "scout", name: "Scout", description: "Looks things up in the chat.", instructions: "Find what you are asked for in the chat and say where it is.", given: "task", source: "user", off: false };

function job(id: string, more: Partial<JobView> = {}): JobView {
  return { id, chatId: "chat-light", agent: "scout", task: "Find who kept the harbour light before Okoro.", when: "now", state: "done", by: { who: "user" }, basis: null, createdAt: 1_000, usage: USAGE, ...more };
}

/** What the scripted core was asked, and what a test has it answer. */
interface Script {
  asked: { op: string; input: unknown }[];
  /** Holds a side session's turn open until the test lets it go. */
  gate: PromiseWithResolvers<void> | null;
  area: Answer<"workspace", "list">;
  versions: Answer<"workspace", "history">["versions"];
  levels: Answer<"guidance", "get">["levels"];
  jobs: JobView[];
  sides: Answer<"sides", "list">["sides"];
  /** Each side session's kept turns, oldest first. */
  turns: Map<string, Answer<"sides", "turns">["turns"]>;
  spend: Answer<"spend", "get">;
  upkeep: Answer<"upkeep", "get">;
}

function script(): Script {
  const none = { key: "total", calls: 0, in: 0, cachedIn: 0, out: 0, cost: 0, unpriced: 0 };
  return {
    asked: [],
    gate: null,
    area: { area: "chat", files: [FILE], chars: 17, limits: LIMITS, agents: [{ id: "main", name: "Main agent" }, { id: "scout", name: "Scout" }], basis: null },
    versions: [],
    levels: [],
    jobs: [],
    sides: [],
    turns: new Map(),
    spend: { days: [], chats: [], agents: [], connections: [], models: [], total: none, caps: [] },
    upkeep: { kinds: [], total: { count: 0, bytes: 0 }, loose: null, lastSweep: null, sweeping: false },
  };
}

/** A harness that answers the pages' requests as its script says, each answer in the core's own type, and runs a side session's turn as the core would trace and keep it. */
function scripted(s: Script): NonNullable<Parameters<typeof rig>[0]>["harness"] {
  return (host) => {
    const seqs = new Map<string, number>();
    const trace = (turn: string, event: TraceEvent): void => {
      const seq = (seqs.get(turn) ?? 0) + 1;
      seqs.set(turn, seq);
      host.trace.event({ turn, chatId: "", seq, event });
    };
    const asked = <T>(op: string, input: unknown, answer: T): T => {
      s.asked.push({ op, input });
      return answer;
    };
    const jobNamed = (id: string): JobView => s.jobs.find((one) => one.id === id) ?? job(id);
    const workspace = {
      list: async (input) => asked("workspace.list", input, s.area),
      read: async (input) => asked("workspace.read", input, { file: FILE, text: "Low water at six.", version: { hash: input.version ?? FILE.hash, chars: FILE.chars, at: FILE.at, by: FILE.by } }),
      write: async (input) => asked("workspace.write", input, { file: { ...FILE, path: input.path } }),
      move: async (input) => asked("workspace.move", input, { file: { ...FILE, path: input.to } }),
      delete: async (input) => asked("workspace.delete", input, { deleted: true as const }),
      pin: async (input) => asked("workspace.pin", input, { file: { ...FILE, pins: input.on && input.role !== undefined ? [input.role] : [] } }),
      history: async (input) => asked("workspace.history", input, { versions: s.versions }),
      changes: async (input) => asked("workspace.changes", input, { changes: [{ area: "chat" as const, path: "notes/tides.md", before: null, after: hash("a"), by: FILE.by }] }),
      // Every member a page reaches: `writeAs` is an extension's tool's to call, never a page's.
    } satisfies Omit<Core["workspace"], "writeAs">;
    const guidance = {
      get: async (input) => asked("guidance.get", input, { levels: s.levels, limit: 8000, agentsEdit: false }),
      set: async (input) => asked("guidance.set", input, { levels: s.levels, limit: 8000, agentsEdit: false }),
    } satisfies Core["guidance"];
    // Asked for the names it holds alone, so it isn't counted among what a test checks was asked.
    const definitions = { get: async () => ({ agents: [SCOUT], skills: [], tools: [], agentSchema: { type: "object" }, agentDefaults: newAgentSettings(), scope: { tools: [], agents: [] } }) } satisfies Pick<Core["definitions"], "get">;
    const jobs = {
      run: async () => undefined,
      recover: async () => ({ interrupted: [], paused: [], queued: [] }),
      list: async (input) => {
        const from = Number(input.cursor ?? 0);
        return asked("jobs.list", input, { jobs: s.jobs.slice(from, from + input.limit), next: from + input.limit < s.jobs.length ? String(from + input.limit) : null, today: { tokens: 1_200 }, agents: [{ id: "scout", name: "Scout" }], paused: false });
      },
      read: async (input) => asked("jobs.read", input, { job: jobNamed(input.id), task: "Find who kept the harbour light before Okoro, and say where each reply says so.", report: null }),
      start: async (input) => {
        const started = job("job_new", { chatId: input.chatId, agent: input.agent, when: input.when, state: "queued", ...(input.allowance !== undefined ? { allowance: input.allowance } : {}) });
        s.jobs.unshift(started);
        // The core tells its host of a job it queued, which is how the pages learn where the job runs.
        host.jobs?.queued(started);
        return asked("jobs.start", input, { job: started });
      },
      again: async (input) => asked("jobs.again", input, { job: job("job_again", { state: "queued", again: input.id }) }),
      cancel: async (input) => asked("jobs.cancel", input, { job: { ...jobNamed(input.id), state: "cancelled" as const } }),
      grant: async (input) => asked("jobs.grant", input, { job: { ...jobNamed(input.id), state: "queued" as const, allowance: input.allowance } }),
    } satisfies Pick<Core["jobs"], "list" | "read" | "start" | "again" | "cancel" | "grant"> & NonNullable<Harness["jobs"]>;
    const sides = {
      list: async (input) => asked("sides.list", input, { sides: [...s.sides].sort((a, b) => b.lastAt - a.lastAt) }),
      start: async (input) => {
        const side = { id: `side_${s.sides.length + 1}`, chatId: input.chatId ?? "", agent: input.agent ?? "main", title: "", createdAt: 50, lastAt: 50, turns: 0 };
        s.sides.push(side);
        return asked("sides.start", input, { side });
      },
      // Asked too to find where a session's turns run, so it isn't counted among what a test checks was asked.
      turns: async (input) => {
        const side = s.sides.find((row) => row.id === input.id);
        if (side === undefined) throw Object.assign(new Error("That side session is gone."), { code: "not_found" });
        return { side, turns: s.turns.get(side.id) ?? [] };
      },
      remove: async (input) => {
        s.sides = s.sides.filter((row) => row.id !== input.id);
        return asked("sides.remove", input, { removed: true as const });
      },
    } satisfies Core["sides"];
    const spend = { get: async (input) => asked("spend.get", input, s.spend) } satisfies Core["spend"];
    const upkeep = {
      get: async () => asked("upkeep.get", null, s.upkeep),
      sweep: async () => asked("upkeep.sweep", null, { ...s.upkeep, lastSweep: { at: 90, removed: 3, bytes: 300, ms: 12 } }),
    } satisfies Core["upkeep"];
    return {
      answer: async () => ({ status: "failed", reason: "no turn is answered in this test", record: null, reply: "", usage: USAGE }),
      async side(input, _sink, signal) {
        trace(input.generationId, { kind: "turn_started", turn: input.generationId, chatId: "", generation: "side", messageId: null, side: input.session, at: 60 });
        const stopped = Promise.withResolvers<void>();
        signal.addEventListener("abort", () => stopped.resolve(), { once: true });
        if (s.gate !== null) await Promise.race([s.gate.promise, stopped.promise]);
        if (signal.aborted) return;
        // The core keeps a turn once it has ended.
        const side = s.sides.find((row) => row.id === input.session);
        if (side !== undefined) {
          s.turns.set(side.id, [...(s.turns.get(side.id) ?? []), { turn: input.generationId, at: 70, asked: input.text, answered: "Brann keeps the tide tables.", status: "done", transcript: hash("e"), usage: USAGE }]);
          side.turns += 1;
          side.lastAt = 70;
        }
        trace(input.generationId, { kind: "turn_ended", status: "done", usage: USAGE, at: 70 });
      },
      resume: async (input) => asked("resume", input, { paused: false }),
      workspace,
      guidance,
      definitions,
      jobs,
      sides,
      spend,
      upkeep,
    } satisfies Harness & Record<string, unknown>;
  };
}

let open: Rig | null = null;
afterEach(() => {
  open?.close();
  open = null;
});

async function start(s: Script): Promise<{ it: Rig; chatId: string }> {
  const it = await rig({ harness: scripted(s) });
  open = it;
  return { it, chatId: await it.setUp() };
}

const refusal = (answer: Promise<unknown>): Promise<UiFailure["error"]> =>
  answer.then(
    () => {
      throw new Error("the request was answered");
    },
    (error: unknown) => {
      if (!(error instanceof UiFailure)) throw error;
      return error.error;
    },
  );

describe("the workspace", () => {
  test("is listed and read as the core has it, with the reply an area stands on and the agents a file may be pinned for", async () => {
    const s = script();
    const { it, chatId } = await start(s);
    s.area = { ...s.area, basis: { messageId: "msg-reply", swipe: 0, index: 1 } };

    expect(await it.page.request("lah.ws.list", { chatId, area: "chat" })).toEqual({ area: "chat", files: [FILE], chars: 17, limits: LIMITS, agents: [{ id: "main", name: "Main agent" }, { id: "scout", name: "Scout" }], basis: { messageId: "msg-reply", swipe: 0, index: 1 } });
    expect(await it.page.request("lah.ws.read", { chatId, area: "chat", path: "notes/tides.md" })).toEqual({ file: FILE, text: "Low water at six.", version: FILE.hash });
    // An earlier version's text is read by that version's hash, which the answer then names.
    expect((await it.page.request("lah.ws.read", { chatId, area: "chat", path: "notes/tides.md", version: hash("b") })).version).toBe(hash("b"));
    // The page names the agent a file is pinned for; the core calls it the role.
    expect((await it.page.request("lah.ws.pin", { chatId, area: "chat", path: "notes/tides.md", agent: "scout", on: true })).file.pins).toEqual(["scout"]);
    expect(s.asked).toEqual([
      { op: "workspace.list", input: { chatId, area: "chat" } },
      { op: "workspace.read", input: { chatId, area: "chat", path: "notes/tides.md" } },
      { op: "workspace.read", input: { chatId, area: "chat", path: "notes/tides.md", version: hash("b") } },
      { op: "workspace.pin", input: { chatId, area: "chat", path: "notes/tides.md", on: true, role: "scout" } },
    ]);
  });

  test("is changed with what the core takes, answers a turn's change set as the core gives it, and never reaches into another account's chat", async () => {
    const s = script();
    const { it, chatId } = await start(s);
    expect(await it.page.request("lah.ws.write", { chatId, area: "chat", path: "notes/light.md", text: "Okoro keeps it.", base: null })).toEqual({ file: { ...FILE, path: "notes/light.md" } });
    expect(await it.page.request("lah.ws.move", { chatId, area: "chat", from: "notes/light.md", to: "notes/lamp.md", base: FILE.hash })).toEqual({ file: { ...FILE, path: "notes/lamp.md" } });
    expect(await it.page.request("lah.ws.delete", { chatId, area: "chat", path: "notes/lamp.md", base: FILE.hash })).toEqual({ deleted: true });
    expect(await it.page.request("lah.ws.changes", { chatId, messageId: "msg-reply", swipe: 0 })).toEqual({ changes: [{ area: "chat", path: "notes/tides.md", before: null, after: hash("a"), by: { who: "user" } }] });
    expect(s.asked).toEqual([
      { op: "workspace.write", input: { chatId, area: "chat", path: "notes/light.md", text: "Okoro keeps it.", base: null } },
      { op: "workspace.move", input: { chatId, area: "chat", from: "notes/light.md", to: "notes/lamp.md", base: FILE.hash } },
      { op: "workspace.delete", input: { chatId, area: "chat", path: "notes/lamp.md", base: FILE.hash } },
      { op: "workspace.changes", input: { chatId, messageId: "msg-reply", swipe: 0 } },
    ]);

    const other = it.host.addChat("user-joss", "Joss's log");
    expect((await refusal(it.page.request("lah.ws.list", { chatId: other.id, area: "chat" }))).code).toBe("not_found");
    expect(s.asked).toHaveLength(4);
  });

  test("names the reply whose turn made each version of a file", async () => {
    const s = script();
    const { it, chatId } = await start(s);
    // The chat's reply holds the record of the turn that wrote it: when the turn ran, and the job it started.
    const reply = it.host.say(chatId, "assistant", "Okoro keeps it now.");
    const record: TurnRecord = { v: 1, generationId: "gen-light", kind: "new", began: 100, at: 200, path: "", segment: hash("d"), jobs: [{ id: "job_1a2b3c4d", agent: "scout", state: "done" }], usage: USAGE };
    expect(await it.backend.chats.anchor(USER, chatId, reply.id, null, toJsonObject(record))).toBe(true);
    s.versions = [
      { hash: hash("c"), chars: 21, at: 260, by: { who: "job", id: "job_1a2b3c4d", role: "scout" } },
      { hash: hash("b"), chars: 19, at: 150, by: { who: "agent", id: "agent_5e6f7a8b", role: "main" } },
      { hash: hash("a"), chars: 17, at: 90, by: { who: "user" } },
      { hash: hash("9"), chars: 12, at: 40, by: { who: "agent", id: "agent_0c1d2e3f", role: "main" } },
    ];
    const made = { messageId: reply.id, swipe: 0, index: 1 };

    const history = await it.page.request("lah.ws.history", { chatId, area: "chat", path: "notes/tides.md" });
    expect(history.versions).toEqual([
      // A job's version: the reply whose record lists the job, whenever the job wrote it.
      { hash: hash("c"), chars: 21, at: 260, by: { who: "job", id: "job_1a2b3c4d", role: "scout" }, turn: made },
      // An agent's: the reply whose turn was under way when it was written.
      { hash: hash("b"), chars: 19, at: 150, by: { who: "agent", id: "agent_5e6f7a8b", role: "main" }, turn: made },
      // What the user wrote on the page is no turn's, nor is what an agent wrote while no turn on the path ran.
      { hash: hash("a"), chars: 17, at: 90, by: { who: "user" }, turn: null },
      { hash: hash("9"), chars: 12, at: 40, by: { who: "agent", id: "agent_0c1d2e3f", role: "main" }, turn: null },
    ]);
    // With no chat there is no reply to name.
    expect((await it.page.request("lah.ws.history", { chatId: null, area: "user", path: "notes/tides.md" })).versions.map((version) => version.turn)).toEqual([null, null, null, null]);
    expect(s.asked.at(-1)).toEqual({ op: "workspace.history", input: { chatId: null, area: "user", path: "notes/tides.md" } });
  });
});

describe("guidance", () => {
  test("names each level in the page's words: the user's, the character's by the character's name, the chat's, and one an extension keeps", async () => {
    const s = script();
    const { it, chatId } = await start(s);
    const chat = it.host.chatList.get(chatId);
    if (chat === undefined) throw new Error("the chat is gone");
    chat.characterId = "char-ilse";
    it.host.characters.set("char-ilse", "Ilse");
    const none = { text: "", hash: null, at: null, by: null, editable: true };
    s.levels = [
      { id: "user", whose: "from the user, for every chat", text: "Keep answers short.", path: "~/GUIDANCE.md", hash: hash("a"), at: 10, by: { who: "user" }, editable: true },
      { id: "middle", whose: "from the user, for every chat with Ilse", path: "~/characters/char-ilse/GUIDANCE.md", ...none },
      { id: "chat", whose: "for this chat", path: "learned/GUIDANCE.md", ...none },
    ];

    expect(await it.page.request("lah.guidance.get", { chatId })).toEqual({
      levels: [
        { id: "user", label: "Yours", note: "~/GUIDANCE.md: every agent of every chat of yours is given it.", text: "Keep answers short.", hash: hash("a"), at: 10, by: { who: "user" }, editable: true },
        { id: "middle", label: "Ilse's", note: "~/characters/char-ilse/GUIDANCE.md: every chat of yours with Ilse is given it.", ...none },
        { id: "chat", label: "This chat's", note: "learned/GUIDANCE.md: kept with this chat, whatever path its story takes.", ...none },
      ],
      limit: 8000,
      agentsEdit: false,
    });

    // An extension that answers the chat keeps the middle level in the character's place, under the words agents hear it by.
    const locked = "This level is kept by the extension that answers this chat: it is edited there.";
    s.levels = [{ id: "middle", whose: "of the lamp room", text: "Trim the wick at dusk.", path: null, hash: null, at: null, by: null, editable: false, locked }];
    const set = await it.page.request("lah.guidance.set", { chatId, level: "user", text: "Keep answers short.", base: hash("a") });
    expect(set.levels).toEqual([{ id: "middle", label: "The extension's", note: "Named by the extension that answers this chat, in the character's place. Agents are told it is guidance of the lamp room.", text: "Trim the wick at dusk.", hash: null, at: null, by: null, editable: false, locked }]);
    expect(s.asked).toEqual([
      { op: "guidance.get", input: { chatId } },
      { op: "guidance.set", input: { chatId, level: "user", text: "Keep answers short.", base: hash("a") } },
    ]);
  });
});

describe("jobs", () => {
  test("are listed a page at a time, with the limits Settings put on them, what today spent and the agents one may be given to", async () => {
    const s = script();
    const { it, chatId } = await start(s);
    s.jobs = [job("job_c"), job("job_b"), job("job_a")];
    const set = defaultSettings().jobs;
    const limits = { atOnce: set.atOnce, tokensPerJob: (set.budget.tokensIn ?? 0) + (set.budget.tokensOut ?? 0), msPerJob: set.budget.wallMs, tokensPerDay: set.tokensPerDay };

    const first = await it.page.request("lah.jobs.list", { chatId: null, cursor: null, limit: 2 });
    expect(first).toEqual({ jobs: [job("job_c"), job("job_b")], next: "2", total: 2, limits, today: { tokens: 1_200 }, agents: [{ id: "scout", name: "Scout" }] });
    // The core doesn't count the jobs there are in all: the last page knows.
    expect(await it.page.request("lah.jobs.list", { chatId: null, cursor: first.next, limit: 2 })).toMatchObject({ jobs: [job("job_a")], next: null, total: 3 });
    expect(s.asked).toEqual([
      { op: "jobs.list", input: { chatId: null, cursor: null, limit: 2 } },
      { op: "jobs.list", input: { chatId: null, cursor: "2", limit: 2 } },
    ]);

    // The limits are the user's settings as they stand: here a job may write without bound, so what bounds its tokens is what it may send.
    await it.page.request("lah.settings.set", { set: [{ path: ["core", "jobs", "atOnce"], value: 3 }, { path: ["core", "jobs", "budget", "tokensOut"], value: null }], reset: [] });
    expect((await it.page.request("lah.jobs.list", { chatId, cursor: null, limit: 2 })).limits).toEqual({ ...limits, atOnce: 3, tokensPerJob: set.budget.tokensIn });
  });

  test("one is started with what it alone may spend, granted more, let go on, cancelled and started again, each answered with the job", async () => {
    const s = script();
    const { it, chatId } = await start(s);
    const task = "Find who kept the harbour light before Okoro.";

    const started = await it.page.request("lah.job.start", { chatId, agent: "scout", task, when: "now", allowance: { tokensIn: 50_000, wallMs: null } });
    expect(started.job).toMatchObject({ id: "job_new", chatId, agent: "scout", state: "queued", allowance: { tokensIn: 50_000, wallMs: null } });
    // The runtime said it queued the job: what is asked about the job from now on is asked there.
    await until(() => it.backend.jobs.runsIn(USER, "job_new") === it.registration.relay, "the job to be told to the pages");
    expect((await it.page.request("lah.job.grant", { id: "job_new", allowance: { tokensIn: 90_000 } })).job).toMatchObject({ id: "job_new", allowance: { tokensIn: 90_000 } });
    // A job a restart left held has no run to let go: the place it runs in has the core let it go, and answers the job as it then reads.
    expect((await it.page.request("lah.job.resume", { id: "job_new" })).job).toEqual(started.job);
    expect((await it.page.request("lah.job.cancel", { id: "job_new" })).job).toMatchObject({ id: "job_new", state: "cancelled" });
    expect((await it.page.request("lah.job.again", { id: "job_new" })).job).toMatchObject({ id: "job_again", again: "job_new" });
    expect(s.asked).toEqual([
      { op: "jobs.start", input: { chatId, agent: "scout", task, when: "now", allowance: { tokensIn: 50_000, wallMs: null } } },
      { op: "jobs.grant", input: { id: "job_new", allowance: { tokensIn: 90_000 } } },
      { op: "resume", input: { run: "job_new" } },
      { op: "jobs.read", input: { id: "job_new" } },
      { op: "jobs.cancel", input: { id: "job_new" } },
      { op: "jobs.again", input: { id: "job_new" } },
    ]);
  });
});

describe("a side session", () => {
  test("is listed with its agent's name, about no chat where the core names none, and with a title before anything is said in it", async () => {
    const s = script();
    const { it, chatId } = await start(s);
    s.sides = [
      { id: "side_tides", chatId: "", agent: "scout", title: "The tide tables", createdAt: 10, lastAt: 40, turns: 1 },
      { id: "side_light", chatId, agent: "keeper", title: "", createdAt: 20, lastAt: 20, turns: 0 },
    ];
    expect(await it.page.request("lah.side.list", {})).toEqual({
      sessions: [
        { id: "side_tides", agent: "scout", agentName: "Scout", chatId: null, title: "The tide tables", createdAt: 10, lastAt: 40, turns: 1 },
        // An agent whose definition is gone goes by its id.
        { id: "side_light", agent: "keeper", agentName: "keeper", chatId, title: "New conversation", createdAt: 20, lastAt: 20, turns: 0 },
      ],
    });

    const started = await it.page.request("lah.side.start", { agent: "scout", chatId: null });
    expect(started.session).toEqual({ id: "side_3", agent: "scout", agentName: "Scout", chatId: null, title: "New conversation", createdAt: 50, lastAt: 50, turns: 0 });
    expect(await it.page.request("lah.side.remove", { session: "side_3" })).toEqual({ removed: true });
    expect(s.asked).toEqual([
      { op: "sides.list", input: {} },
      { op: "sides.start", input: { chatId: null, agent: "scout" } },
      { op: "sides.remove", input: { id: "side_3" } },
    ]);
  });

  test("shows the turn under way first, pages the turns the core keeps newest first, and takes the core's own once it has kept the turn", async () => {
    const s = script();
    const { it } = await start(s);
    s.sides = [{ id: "side_tides", chatId: "", agent: "scout", title: "The tide tables", createdAt: 10, lastAt: 40, turns: 3 }];
    s.turns.set("side_tides", [
      { turn: "turn-1", at: 20, asked: "Who keeps the tide tables?", answered: "Brann does.", status: "done", transcript: hash("f"), usage: USAGE },
      { turn: "turn-2", at: 30, asked: "And the harbour log?", answered: null, status: "failed", reason: "The model's connection refused the call.", usage: USAGE },
      { turn: "turn-3", at: 40, asked: "And at Okoro's Quay?", answered: null, status: "stopped", usage: USAGE },
    ]);
    s.gate = Promise.withResolvers<void>();
    const said = "Which tide table is the right one?";

    const sent = await it.page.request("lah.side.send", { session: "side_tides", text: said });
    // The turn that just started counts, though the core keeps a turn only once it has ended.
    expect(sent.session).toMatchObject({ id: "side_tides", agentName: "Scout", title: "The tide tables", turns: 4 });
    expect(sent.session.lastAt).toBeGreaterThan(40);
    const working: SideTurn = { turn: sent.turn, at: sent.session.lastAt, said, answer: null, state: "running", transcript: null, usage: null };
    const first = await it.page.request("lah.side.turns", { session: "side_tides", cursor: null, limit: 2 });
    expect(first).toEqual({ turns: [working, { turn: "turn-3", at: 40, said: "And at Okoro's Quay?", answer: null, state: "stopped", transcript: null, usage: USAGE }], next: "2" });
    expect(await it.page.request("lah.side.turns", { session: "side_tides", cursor: first.next, limit: 2 })).toEqual({
      turns: [
        { turn: "turn-2", at: 30, said: "And the harbour log?", answer: null, state: "failed", transcript: null, usage: USAGE },
        { turn: "turn-1", at: 20, said: "Who keeps the tide tables?", answer: "Brann does.", state: "done", transcript: hash("f"), usage: USAGE },
      ],
      next: null,
    });
    await until(() => it.backend.live.runningOf(USER).some((run) => run.turn === sent.turn), "the side turn in the live view");
    expect((await it.page.request("lah.side.turns", { session: "side_tides", cursor: null, limit: 1 })).turns).toEqual([working]);
    expect((await it.page.request("lah.side.list", {})).sessions).toMatchObject([{ id: "side_tides", turns: 4, lastAt: sent.session.lastAt }]);

    s.gate.resolve();
    await until(() => it.backend.live.runningOf(USER).length === 0, "the side turn to end");
    // Kept, it is the core's own: its answer, how it ended, its transcript and what it spent.
    expect(await it.page.request("lah.side.turns", { session: "side_tides", cursor: null, limit: 1 })).toEqual({ turns: [{ turn: sent.turn, at: 70, said, answer: "Brann keeps the tide tables.", state: "done", transcript: hash("e"), usage: USAGE }], next: "1" });
    expect((await it.page.request("lah.side.list", {})).sessions).toMatchObject([{ id: "side_tides", turns: 4, lastAt: 70 }]);
    // A cursor that is no place in the conversation is refused.
    expect((await refusal(it.page.request("lah.side.turns", { session: "side_tides", cursor: "soon", limit: 2 }))).code).toBe("bad_request");
  });

  test("is titled by what was first said in it, and shows a turn lost with its runtime as lost", async () => {
    const s = script();
    const { it, chatId } = await start(s);
    // A session about a chat that runs in the runtime: its turns run there too.
    s.sides = [{ id: "side_light", chatId, agent: "scout", title: "", createdAt: 20, lastAt: 20, turns: 0 }];
    s.gate = Promise.withResolvers<void>();

    const sent = await it.page.request("lah.side.send", { session: "side_light", text: "Who kept the light\n  before Okoro?" });
    // As the core will title it once it keeps the turn: how the first message opens, on one line.
    expect(sent.session).toMatchObject({ title: "Who kept the light before Okoro?", turns: 1 });
    await until(() => it.backend.live.runningOf(USER).some((run) => run.turn === sent.turn), "the side turn in the live view");
    // Its runtime stops naming the run: it went away with it, and the core never kept the turn.
    it.backend.live.named(USER, it.registration.relay, []);
    it.backend.live.named(USER, it.registration.relay, []);
    expect(it.backend.live.runningOf(USER)).toEqual([]);
    expect(await it.page.request("lah.side.turns", { session: "side_light", cursor: null, limit: 5 })).toEqual({ turns: [{ turn: sent.turn, at: sent.session.lastAt, said: "Who kept the light\n  before Okoro?", answer: null, state: "lost", transcript: null, usage: null }], next: null });

    // A session that is no longer there takes no word.
    expect((await refusal(it.page.request("lah.side.send", { session: "side_gone", text: "Anyone there?" }))).code).toBe("not_found");
  });
});

describe("the spend", () => {
  test("names each row: a chat by its name, an agent by its definition's, a connection by its own, a cap by its setting", async () => {
    const s = script();
    const { it, chatId } = await start(s);
    const row = (key: string, cost: number): Answer<"spend", "get">["total"] => ({ key, calls: 2, in: 100, cachedIn: 10, out: 20, cost, unpriced: 0 });
    s.spend = {
      days: [row("2026-11-09", 0), row("2026-11-10", 0.5)],
      chats: [row(chatId, 0.3), row("chat-gone-long-ago", 0.1), row("", 0.1)],
      agents: [row("scout", 0.4), row("keeper", 0.1)],
      connections: [row("conn-main", 0.4), row("conn-gone-long-ago", 0.1)],
      models: [row("model-main", 0.5)],
      total: row("total", 0.5),
      caps: [
        { setting: ["spend", "tokensPerDay"], unit: "tokens", limit: null, used: 240, reached: false },
        { setting: ["spend", "costPerDay"], unit: "usd", limit: 0.5, used: 0.5, reached: true },
        { setting: ["jobs", "tokensPerDay"], unit: "tokens", limit: 3_000_000, used: 0, reached: false },
      ],
    };

    const view = await it.page.request("lah.spend.get", { days: 2 });
    expect(view.days).toEqual([
      { ...row("2026-11-09", 0), label: "2026-11-09" },
      { ...row("2026-11-10", 0.5), label: "2026-11-10" },
    ]);
    // A chat that is gone, and the spend of a side session about no chat, still have a row to read.
    expect(view.chats.map((r) => [r.key, r.label])).toEqual([
      [chatId, "Harbour light"],
      ["chat-gone-long-ago", "A chat that is gone (chat-gon)"],
      ["", "No chat"],
    ]);
    expect(view.agents.map((r) => r.label)).toEqual(["Scout", "keeper"]);
    expect(view.connections.map((r) => r.label)).toEqual(["Main", "A connection that is gone (conn-gon)"]);
    expect(view.models.map((r) => r.label)).toEqual(["model-main"]);
    expect(view.total).toEqual({ ...row("total", 0.5), label: "The last 2 days" });
    // A cap leads to its setting, and goes by the title the Settings page gives it.
    expect(view.caps).toEqual([
      { path: ["core", "spend", "tokensPerDay"], label: "Tokens per day", unit: "tokens", limit: null, used: 240, reached: false },
      { path: ["core", "spend", "costPerDay"], label: "Cost per day", unit: "usd", limit: 0.5, used: 0.5, reached: true },
      { path: ["core", "jobs", "tokensPerDay"], label: "Job tokens per day", unit: "tokens", limit: 3_000_000, used: 0, reached: false },
    ]);
    expect(s.asked).toEqual([{ op: "spend.get", input: { days: 2 } }]);
  });
});

describe("what is stored", () => {
  test("is named kind by kind, with the setting that says how long each is kept and what that setting holds", async () => {
    const s = script();
    const { it } = await start(s);
    s.upkeep = {
      kinds: [
        { kind: "prompt", count: 12, bytes: 4_000, oldestAt: 5, keep: ["keep", "promptDays"] },
        { kind: "segment", count: 4, bytes: 900, oldestAt: 6, keep: ["keep", "spanDays"] },
        { kind: "file", count: 2, bytes: 300, oldestAt: null, keep: null },
      ],
      total: { count: 18, bytes: 5_200 },
      loose: { count: 1, bytes: 40, at: 7 },
      lastSweep: null,
      sweeping: false,
    };
    const days = defaultSettings().keep.promptDays;

    expect(await it.page.request("lah.upkeep.get", {})).toEqual({
      kinds: [
        { kind: "prompt", label: "Prompts", count: 12, bytes: 4_000, kept: { path: ["core", "keep", "promptDays"], words: `${days} days` }, oldestAt: 5 },
        // The turns a summary replaced are kept for good unless the user says otherwise.
        { kind: "segment", label: "Turns' notes", count: 4, bytes: 900, kept: { path: ["core", "keep", "spanDays"], words: "No limit" }, oldestAt: 6 },
        { kind: "file", label: "Workspace file versions", count: 2, bytes: 300, kept: null, oldestAt: null },
      ],
      total: { count: 18, bytes: 5_200 },
      loose: { count: 1, bytes: 40, at: 7 },
      lastSweep: null,
      sweeping: false,
    });

    // How long a kind is kept is the setting as it stands when the page asks.
    await it.page.request("lah.settings.set", { set: [{ path: ["core", "keep", "promptDays"], value: 1 }], reset: [] });
    const swept = await it.page.request("lah.upkeep.sweep", {});
    expect(swept.kinds[0]?.kept).toEqual({ path: ["core", "keep", "promptDays"], words: "1 day" });
    expect(swept.lastSweep).toEqual({ at: 90, removed: 3, bytes: 300, ms: 12 });
    expect(s.asked.map((a) => a.op)).toEqual(["upkeep.get", "upkeep.sweep"]);
  });
});

describe("an answer that isn't this build's core's", () => {
  test("is refused in words that say to update, never passed on to a page", async () => {
    const s = script();
    const { it, chatId } = await start(s);
    // What a runtime of another build might answer, in the core's place.
    s.area = { area: "chat", files: "none" } as unknown as Script["area"];
    const refused = await refusal(it.page.request("lah.ws.list", { chatId, area: "chat" }));
    expect(refused.code).toBe("internal");
    expect(refused.message).toBe("The core answered with something that isn't an area of the workspace. If a runtime answered, update the runtime and the extension to the same build.");
  });
});

describe("the core itself", () => {
  test("answers these requests in what the views read: a file's versions, the guidance, a side session, the spend and what is stored", async () => {
    // No script: the core's own harness answers in the runtime, so what it gives at run time is what is read here.
    const it = await rig();
    open = it;
    const chatId = await it.setUp();

    const first = await it.page.request("lah.ws.write", { chatId, area: "learned", path: "notes/tides.md", text: "Low water at six.", base: null });
    const second = await it.page.request("lah.ws.write", { chatId, area: "learned", path: "notes/tides.md", text: "Low water at seven.", base: first.file.hash });
    expect(await it.page.request("lah.ws.list", { chatId, area: "learned" })).toMatchObject({ area: "learned", files: [second.file], chars: 19, basis: null });
    const history = await it.page.request("lah.ws.history", { chatId, area: "learned", path: "notes/tides.md" });
    expect(history.versions.map((version) => [version.hash, version.by, version.turn])).toEqual([
      [second.file.hash, { who: "user" }, null],
      [first.file.hash, { who: "user" }, null],
    ]);
    expect(await it.page.request("lah.ws.read", { chatId, area: "learned", path: "notes/tides.md", version: first.file.hash })).toEqual({ file: second.file, text: "Low water at six.", version: first.file.hash });

    const guidance = await it.page.request("lah.guidance.set", { chatId, level: "chat", text: "Brann speaks plainly.", base: null });
    expect(guidance.levels.map((level) => [level.id, level.label, level.text])).toEqual([
      ["user", "Yours", ""],
      ["chat", "This chat's", "Brann speaks plainly."],
    ]);

    const { session } = await it.page.request("lah.side.start", { agent: "main", chatId });
    expect(session).toMatchObject({ agent: "main", agentName: "Main agent", chatId, title: "New conversation", turns: 0 });
    expect(await it.page.request("lah.side.list", {})).toEqual({ sessions: [session] });
    expect(await it.page.request("lah.side.turns", { session: session.id, cursor: null, limit: 5 })).toEqual({ turns: [], next: null });
    expect(await it.page.request("lah.side.remove", { session: session.id })).toEqual({ removed: true });

    const spend = await it.page.request("lah.spend.get", { days: 3 });
    expect(spend.days.map((day) => day.label)).toEqual(spend.days.map((day) => day.key));
    expect(spend.total).toMatchObject({ calls: 0, label: "The last 3 days" });
    expect(spend.caps.map((cap) => cap.label)).toEqual(["Tokens per day", "Cost per day", "Job tokens per day"]);
    const stored = await it.page.request("lah.upkeep.get", {});
    expect(stored.kinds.find((kind) => kind.kind === "file")).toMatchObject({ label: "Workspace file versions", kept: null });
    expect(stored.kinds.find((kind) => kind.kind === "prompt")?.kept?.path).toEqual(["core", "keep", "promptDays"]);
  });
});
