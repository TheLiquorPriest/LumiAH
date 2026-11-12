// What the pages ask (DESIGN §8), the first screen (§8 Home), lore and the chronicle (§24) and the
// learning of a story (§22), on the whole backend over a fake Lumiverse, as a user's page would
// notice it: which permissions are missing and what first-time setup counts, a chat switched on
// (pinned to the runtime's loopback connection) and what is said while its runtime is away, every
// request that needs the core refused in plain words while no runtime is linked, what the first
// screen says of a chat's latest turn while it runs, once it ended and after the extension started
// again, an ask for the notes to be summarized, the core's own answers about lore and the
// chronicle passed on as they are, and the job that learns a chat's story, which the backend
// remembers across a restart.

import { afterEach, describe, expect, test } from "bun:test";
import type { AgentDefinition } from "../../../src/core/agents";
import type { Harness as Core } from "../../../src/core/harness";
import type { AgentUsage, JobView, TurnRecord } from "../../../src/core/ports";
import type { ChronicleCheck, LoreSearchView, StoryStatus } from "../../../src/core/recall/shapes";
import { defaultSettings } from "../../../src/core/settings";
import { toJsonObject } from "../../../src/link/json";
import type { Harness } from "../../../src/runtime/turn";
import { toolCall } from "../../support/fake-host";
import { UiFailure } from "../../support/fake-lumiverse";
import { type Rig, type RigOptions, rig, until, USER } from "../../support/rig";

const NO_USAGE: AgentUsage = { calls: 0, toolTurns: 0, in: 0, cachedIn: 0, out: 0, reasoningOut: 0, estimated: false, ms: 0 };

/** What a page is told when it asks for something only the core can do and no runtime of the user's is linked. */
const NONE_LINKED = "LumiAH needs its runtime for this, and none is linked now. Start it (its line is on LumiAH's Runtime page) and try again.";

/** What the chronicle's check finds, in the core's own shape: one file, and one line whose message changed since it was cited. */
const CHRONICLE: ChronicleCheck = {
  files: [{ path: "learned/chronicle/facts.md", chars: 96, lines: 2, cited: 2, failed: 1 }],
  failures: [{ path: "learned/chronicle/facts.md", line: 2, text: "- Ilse handed Okoro the keys last spring. [#3 a3f9]", citation: "[#3 a3f9]", index: 3, why: "changed" }],
  moved: [],
  uncited: [],
};

/** What a search of the chat's lore finds, in the core's own shape. */
const FOUND: LoreSearchView = {
  queries: [{ query: "brass key", total: 1, hits: [{ entryId: "entry-key", short: "e1", bookId: "book-harbour", book: "The harbour", title: "The brass key", chars: 43, state: "not_in_prompt", constant: false, score: 3.5, by: ["word"], fields: ["title"], words: ["brass", "key"], lines: [{ line: 1, text: "Brann keeps the brass key to the lamp room." }] }] }],
  meaning: "none",
};

const STORY: StoryStatus = {
  plan: null,
  messages: 240,
  covered: 0,
  suggested: { task: "Read this chat from its first message and write down what its story has established.", agent: "chronicler" },
  refused: null,
  estimate: { messages: 240, chars: 96_000, stretches: 3, promptTokens: 180_000, cachedTokens: 60_000, writtenTokens: 12_000, weighedTokens: 126_000, toolTurns: 24, usd: null },
};

/** What the scripted core was asked, and what a test has it answer. */
interface Script {
  asked: { op: string; input: unknown }[];
  /** The jobs it keeps, as the store would hold them. */
  jobs: JobView[];
  chronicle: ChronicleCheck;
  found: LoreSearchView;
  story: StoryStatus;
  /** The tools the user approved "for this chat", as the core keeps them; none where a test sets none. */
  approved?: { chatId: string; tool: string; at: number | null }[];
}

/** A harness for the runtime that answers what these pages ask as its script says: the jobs in the core's own types, and the core's page surface for lore and the chronicle (`harness.recall`) by the names and inputs the pages' requests are asked under. */
function scripted(s: Script): NonNullable<RigOptions["harness"]> {
  return () => {
    const asked = <T>(op: string, input: unknown, answer: T): T => {
      s.asked.push({ op, input });
      return answer;
    };
    const kept = (id: string): JobView => {
      const job = s.jobs.find((one) => one.id === id);
      if (job === undefined) throw Object.assign(new Error("There is no such job."), { code: "not_found" });
      return job;
    };
    const jobs = {
      run: async () => undefined,
      recover: async () => ({ interrupted: [], paused: [], queued: [] }),
      start: async (input) => {
        const started: JobView = { id: `job_${s.jobs.length + 1}`, chatId: input.chatId, agent: input.agent, task: input.task, when: input.when, state: "queued", by: { who: "user" }, basis: null, createdAt: 1_000, usage: NO_USAGE, ...(input.allowance !== undefined ? { allowance: input.allowance } : {}) };
        s.jobs.push(started);
        return asked("jobs.start", input, { job: started });
      },
      again: async (input) => {
        const started: JobView = { ...kept(input.id), id: `job_${s.jobs.length + 1}`, state: "queued", again: input.id };
        s.jobs.push(started);
        return asked("jobs.again", input, { job: started });
      },
      // Asked too to find where a job runs, so it isn't counted among what a test checks was asked.
      read: async (input) => ({ job: kept(input.id), task: kept(input.id).task, report: null }),
    } satisfies Pick<Core["jobs"], "start" | "again" | "read"> & NonNullable<Harness["jobs"]>;
    const recall = {
      search: async (input: unknown) => asked("recall.search", input, s.found),
      chronicle: async (input: unknown) => asked("recall.chronicle", input, s.chronicle),
      story: async (input: unknown) => asked("recall.story", input, s.story),
    };
    const approvals = {
      kept: async (input: unknown) => asked("approvals.kept", input, { kept: s.approved ?? [] }),
      forget: async (input: unknown) => asked("approvals.forget", input, { kept: [] }),
    };
    return { answer: async () => ({ status: "failed", reason: "no turn is answered in this test", record: null, reply: "", usage: NO_USAGE }), jobs, recall, approvals } satisfies Harness & Record<string, unknown>;
  };
}

let open: Rig | null = null;
afterEach(async () => {
  await open?.close();
  open = null;
});

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

describe("the state every page holds", () => {
  test("says which permissions LumiAH lacks, and counts first-time setup as the permissions it can't do without, a chat and a reply", async () => {
    const it = (open = await rig());
    const chat = it.host.addChat(USER, "Harbour light");
    it.host.permissions.delete("mcp_servers");

    // A permission LumiAH can do without is said, with what is absent without it and what to do, and holds first-time setup up for nothing.
    const first = await it.page.request("lah.hello", {});
    const optional = first.permissions.find((need) => need.id === "mcp_servers");
    expect(optional).toMatchObject({ id: "mcp_servers", needed: false });
    expect(optional?.what).toContain("MCP servers");
    expect(optional?.todo).toContain("Permissions");
    expect(first.permissions.some((need) => need.needed)).toBe(false);
    expect(first.setup.steps).toEqual([
      { id: "permissions", done: true },
      { id: "chat", done: false },
      { id: "reply", done: false },
    ]);

    // Without one it answers no chat without, the first step is open again, and no chat can be switched on.
    it.host.permissions.delete("chats");
    const lacking = await it.page.request("lah.hello", {});
    expect(lacking.permissions.find((need) => need.id === "chats")).toMatchObject({ needed: true });
    expect(lacking.setup.steps[0]).toEqual({ id: "permissions", done: false });
    const blocked = await refusal(it.page.request("lah.chat.set", { chatId: chat.id, on: true }));
    expect(blocked.code).toBe("unavailable");
    expect(blocked.message).toContain('"chats"');

    // Granted, both are gone from what the state lists.
    it.host.permissions.add("chats");
    it.host.permissions.add("mcp_servers");
    const granted = await it.page.request("lah.hello", {});
    expect(granted.permissions.map((need) => need.id)).not.toContain("chats");
    expect(granted.permissions.map((need) => need.id)).not.toContain("mcp_servers");
    expect(granted.setup.steps[0]).toEqual({ id: "permissions", done: true });
  });
});

describe("a chat is switched on", () => {
  test("pinned to the runtime's loopback connection, refused in plain words while there is none, and gets back the connection it had when switched off", async () => {
    const it = (open = await rig());
    it.host.addConnection({ id: "conn-ilse", name: "Ilse's" });
    const chat = it.host.addChat(USER, "Brann's ledger");
    it.host.say(chat.id, "user", "What does Brann owe the harbour?");
    // The chat generates on a connection of its own.
    chat.metadata.connection_profile_id = "conn-ilse";
    const set = async (on: boolean) => (await it.page.request("lah.chat.set", { chatId: chat.id, on })).chat;

    // No runtime is set up yet, so there is no loopback connection to pin the chat to: refused in words that say what to do, and nothing of the chat changes.
    expect((await it.page.request("lah.hello", {})).runtime.ready).toBe(false);
    const none = await refusal(it.page.request("lah.chat.set", { chatId: chat.id, on: true }));
    expect(none).toMatchObject({ code: "unavailable", message: "There is no runtime to answer this chat yet. Start one with its line on LumiAH's Runtime page and mint its key there, then switch the chat on." });
    expect(chat.metadata.connection_profile_id).toBe("conn-ilse");
    expect((await it.page.request("lah.chat.get", { chatId: chat.id })).chat).toMatchObject({ on: false, connection: { id: "conn-ilse", loopback: false } });
    expect((await it.page.request("lah.hello", {})).setup.steps[1]).toEqual({ id: "chat", done: false });

    // With a runtime linked and its key minted (the rig's own chat is switched on there), the chat is pinned to the loopback connection.
    await it.setUp();
    expect((await it.page.request("lah.hello", {})).runtime.ready).toBe(true);
    const on = await set(true);
    expect(on).toMatchObject({ chatId: chat.id, name: "Brann's ledger", on: true, connection: { loopback: true } });
    expect(on.away).toBeUndefined();
    expect<unknown>(chat.metadata.connection_profile_id).toBe(on.connection?.id);
    expect((await it.page.request("lah.hello", {})).chats.find((view) => view.chatId === chat.id)).toMatchObject({ on: true, connection: { loopback: true } });

    // Off, it has its own connection again; on again, it is pinned again.
    expect(await set(false)).toMatchObject({ on: false, since: null, connection: { id: "conn-ilse", loopback: false } });
    expect(chat.metadata.connection_profile_id).toBe("conn-ilse");
    expect(await set(true)).toMatchObject({ on: true, connection: { loopback: true } });
  });

  test("whose runtime isn't linked says so, is told before a reply goes there, and what a page asks of it is refused in words that say what to do", async () => {
    const it = (open = await rig());
    const chatId = await it.setUp();
    const loopback = it.host.connectionList.find((c) => c.provider === "custom")?.id ?? "";
    const handler = it.host.interceptor?.handler;
    if (handler === undefined) throw new Error("no interceptor");
    let n = 0;
    /** A reply of the chat is about to be sent: its prompt comes to the interceptor, as a prompt preview does when `dryRun` says so. */
    const prompt = async (dryRun = false) => {
      const generationId = `gen-${++n}`;
      it.host.emit.started({ generationId, chatId, userId: USER, type: "normal", targetMessageId: null, targetSwipeId: null });
      await handler({ chatId, userId: USER, generationId, type: "normal", dryRun, connectionId: loopback, presetId: null, personaId: null, activated: [], messages: [{ role: "user", text: "Who keeps the harbour light now?", history: true }] });
      // What is said of a reply's runtime is said beside the prompt, not before it goes on: the backend says when it is done.
      await it.backend.settle();
    };

    // Linked: the chat is answered there, and nothing is said.
    const linked = (await it.page.request("lah.chat.get", { chatId })).chat;
    expect(linked).toMatchObject({ on: true, connection: { loopback: true } });
    expect(linked.away).toBeUndefined();
    await prompt();
    expect(it.host.toasts).toEqual([]);

    // The runtime goes away. The chat stays pinned to it, and its view says the runtime isn't answering.
    it.runtime.shutdown();
    await it.runtime.close();
    await until(() => !it.backend.relays.isLinked(USER, it.registration.relay), "the runtime's link to be gone");
    expect((await it.page.request("lah.chat.get", { chatId })).chat).toMatchObject({ on: true, away: true, connection: { id: loopback, loopback: true } });
    expect((await it.page.request("lah.hello", {})).chats.find((view) => view.chatId === chatId)?.away).toBe(true);
    // A chat switched on meanwhile is pinned all the same, the loopback connection being there, and is away too.
    const market = it.host.addChat(USER, "The fish market");
    expect((await it.page.request("lah.chat.set", { chatId: market.id, on: true })).chat).toMatchObject({ on: true, away: true, connection: { id: loopback, loopback: true } });

    // What a page asks about the chat is refused in words that say what to do, and so is what it asks about none.
    expect(await refusal(it.page.request("lah.ws.list", { chatId, area: "chat" }))).toMatchObject({ code: "unavailable", message: "This chat runs in a runtime, and that runtime isn't linked now. Start it (its line is on LumiAH's Runtime page) and try again." });
    expect(await refusal(it.page.request("lah.spend.get", { days: 7 }))).toMatchObject({ code: "unavailable", message: NONE_LINKED });

    // A reply about to go there: nothing answers in the runtime's place, so the user is told before it fails. A prompt preview sends nothing, and says nothing.
    await prompt(true);
    expect(it.host.toasts).toEqual([]);
    await prompt();
    expect(it.host.toasts).toEqual([{ userId: USER, level: "warning", text: "LumiAH's runtime isn't answering, so this reply will fail. Start the runtime (its line is on LumiAH's Runtime page), then send your message again." }]);
    // The chat was left as it was: still pinned to the loopback connection.
    expect<unknown>(it.host.chatList.get(chatId)?.metadata.connection_profile_id).toBe(loopback);
  });
});

describe("with no runtime linked", () => {
  test("every request that needs the core is refused in plain words that say what to do, and nothing it would change is changed", async () => {
    const it = (open = await rig());
    const chat = it.host.addChat(USER, "Brann's ledger");
    it.host.say(chat.id, "user", "What does Brann owe the harbour?");
    const chatId = chat.id;
    const scout: AgentDefinition = { ...(defaultSettings().agents.summarizer as AgentDefinition), id: "scout", name: "Scout", description: "Looks things up in the chat.", instructions: "Find what you are asked for in the chat and say where it is.", given: "task", tools: [] };
    const settingsBefore = it.host.stored(USER, "settings.json");
    const asking: [string, () => Promise<unknown>][] = [
      ["lah.defs.get", () => it.page.request("lah.defs.get", {})],
      ["lah.agent.save", () => it.page.request("lah.agent.save", { agent: scout })],
      ["lah.skill.save", () => it.page.request("lah.skill.save", { skill: { id: "knots", name: "Knots", description: "How a net is mended.", body: "Bowline first." } })],
      ["lah.def.switch", () => it.page.request("lah.def.switch", { kind: "tool", id: "chat_grep", off: true })],
      ["lah.tool.approval", () => it.page.request("lah.tool.approval", { name: "chat_grep", approval: "ask" })],
      ["lah.tier.approval", () => it.page.request("lah.tier.approval", { tier: "write", approval: "ask" })],
      ["lah.ws.list", () => it.page.request("lah.ws.list", { chatId: null, area: "user" })],
      ["lah.ws.read", () => it.page.request("lah.ws.read", { chatId, area: "chat", path: "notes.md" })],
      ["lah.ws.write", () => it.page.request("lah.ws.write", { chatId, area: "chat", path: "notes.md", text: "Brann owes two nets.", base: null })],
      ["lah.guidance.get", () => it.page.request("lah.guidance.get", { chatId: null })],
      ["lah.guidance.set", () => it.page.request("lah.guidance.set", { chatId: null, level: "user", text: "Keep replies short.", base: null })],
      ["lah.session.summarize", () => it.page.request("lah.session.summarize", { chatId })],
      ["lah.approvals.kept", () => it.page.request("lah.approvals.kept", { chatId: null })],
      ["lah.approval.forget", () => it.page.request("lah.approval.forget", { chatId, tool: "dice_roll" })],
      ["lah.jobs.list", () => it.page.request("lah.jobs.list", { chatId: null, cursor: null, limit: 10 })],
      ["lah.job.start", () => it.page.request("lah.job.start", { chatId, agent: "summarizer", task: "Tidy the notes.", when: "now" })],
      ["lah.job.cancel", () => it.page.request("lah.job.cancel", { id: "job_1" })],
      ["lah.side.list", () => it.page.request("lah.side.list", {})],
      ["lah.side.start", () => it.page.request("lah.side.start", { agent: "summarizer", chatId: null })],
      ["lah.side.send", () => it.page.request("lah.side.send", { session: "side_1", text: "Which tide table?" })],
      ["lah.spend.get", () => it.page.request("lah.spend.get", { days: 7 })],
      ["lah.upkeep.get", () => it.page.request("lah.upkeep.get", {})],
      ["lah.upkeep.sweep", () => it.page.request("lah.upkeep.sweep", {})],
      ["lah.lore.get", () => it.page.request("lah.lore.get", { chatId })],
      ["lah.chronicle.get", () => it.page.request("lah.chronicle.get", { chatId })],
      ["lah.story.get", () => it.page.request("lah.story.get", { chatId })],
    ];
    for (const [type, ask] of asking) {
      const refused = await refusal(ask());
      expect([type, refused.code, refused.message]).toEqual([type, "unavailable", NONE_LINKED]);
    }
    // Nothing of what was asked was kept: no switch, no approval, no definition.
    expect(it.host.stored(USER, "settings.json")).toEqual(settingsBefore);

    // What needs no core is answered: the state, the chat, its turns, and a change of settings.
    const state = await it.page.request("lah.hello", {});
    expect(state.runtime.ready).toBe(false);
    expect((await it.page.request("lah.chat.get", { chatId })).chat).toMatchObject({ on: false });
    expect((await it.page.request("lah.turns.list", { chatId, cursor: null, limit: 5 })).turns).toEqual([]);
    expect((await it.page.request("lah.settings.set", { set: [{ path: ["transport", "history", "count"], value: 12 }], reset: [] })).settings.values).toMatchObject({ transport: { history: { count: 12 } } });
  });
});

describe("the first screen", () => {
  test("says of a chat's latest turn what its run says while it works and once it ended, and the same from its record after the extension started again", async () => {
    const it = (open = await rig());
    const chatId = await it.setUp();

    // No chat is open, the chat is gone, or LumiAH has worked on no reply in it yet.
    expect(await it.page.request("lah.home.get", { chatId: null })).toEqual({ chat: null, last: null });
    expect(await it.page.request("lah.home.get", { chatId: "chat-gone" })).toEqual({ chat: null, last: null });
    expect(await it.page.request("lah.home.get", { chatId })).toMatchObject({ chat: { chatId, on: true, connection: { loopback: true } }, last: null });

    // The main agent's call is held open, so its turn is under way while the page asks; then the writer writes the reply.
    const gate = Promise.withResolvers<void>();
    it.host.script = async (_call, n) => {
      if (n > 0) return "Okoro keeps it now. Ilse handed him the keys last spring.";
      await gate.promise;
      return { toolCalls: [toolCall("write_reply", { brief: "Okoro keeps the light; Ilse handed it over last spring." })] };
    };
    const generating = it.generate(chatId);
    await until(() => it.host.calls.length === 1 && (it.backend.live.whole(USER, chatId)?.events.some((e) => e.event.kind === "agent_started") ?? false), "the main agent at work");

    const during = (await it.page.request("lah.home.get", { chatId })).last;
    expect(during).toMatchObject({ kind: "new", ended: null, agents: 1, tools: 0, lore: { added: 0, dropped: 0 }, changes: 0, jobs: 0, transcript: null });
    expect((await it.page.request("lah.hello", {})).running).toMatchObject([{ stream: chatId, turn: during?.turn, kind: "new", paused: false }]);

    gate.resolve();
    const out = await generating;
    expect(out.content).toBe("Okoro keeps it now. Ilse handed him the keys last spring.");
    const reply = it.host.message(chatId, out.messageId ?? "");
    await until(() => reply.own !== null, "the reply's record");
    await until(() => it.backend.live.runningOf(USER).length === 0, "the turn's end in the live view");

    // Ended: the reply it is on, what it spent, its two agents (the main agent and the writer) and the main agent's one call (`write_reply`), and the transcript its record names.
    const ended = (await it.page.request("lah.home.get", { chatId })).last;
    expect(ended).toMatchObject({ turn: out.generationId, kind: "new", messageId: reply.id, ended: { state: "done" }, agents: 2, tools: 1, lore: { added: 0, dropped: 0 }, changes: 0, jobs: 0 });
    expect(ended?.usage).toMatchObject({ calls: 2 });
    expect(ended?.transcript).toMatch(/^[0-9a-f]{64}$/);
    // The chat's turns say the same, and the stored transcript reads back as the turn.
    expect((await it.page.request("lah.turns.list", { chatId, cursor: null, limit: 5 })).turns).toMatchObject([{ turn: out.generationId, transcript: ended?.transcript }]);
    expect((await it.page.request("lah.transcript.get", { transcript: ended?.transcript ?? "", from: 1 })).view).toMatchObject({ turn: out.generationId, ended: { state: "done" } });
    // A reply was answered: first-time setup is done.
    await it.backend.settle();
    expect((await it.page.request("lah.hello", {})).setup.steps).toEqual([
      { id: "permissions", done: true },
      { id: "chat", done: true },
      { id: "reply", done: true },
    ]);

    // The extension starts again: nothing of the run is in memory, and the same is read from the record on the reply and the transcript it names.
    await it.restart();
    expect(it.backend.live.whole(USER, chatId)).toBeNull();
    const kept = await it.page.request("lah.home.get", { chatId });
    expect(kept.chat).toMatchObject({ chatId, on: true });
    expect(kept.last).toEqual(ended);
  });

  test("reads a record an earlier build left, which says where its turn ran and why LumiAH had no part in the reply, as a plain turn", async () => {
    const it = (open = await rig());
    const chatId = await it.setUp();
    // A reply Lumiverse wrote alone while the chat ran inside it: the record says so, was finished from storage after a restart, and names no transcript.
    const reply = it.host.say(chatId, "assistant", "Okoro keeps it now.");
    const record: TurnRecord = { v: 1, generationId: "gen-light", kind: "new", began: 100, at: 200, path: "", segment: "d".repeat(64), changed: 2, jobs: [{ id: "job_1a2b3c4d", agent: "main", state: "done" }], usage: { ...NO_USAGE, calls: 3, in: 900, out: 40 } };
    const ran = { place: "builtin", noPart: { why: "time", text: "LumiAH wasn't ready when Lumiverse had to send the prompt, so Lumiverse sent it as it was." } };
    expect(await it.backend.chats.anchor(USER, chatId, reply.id, null, { ...toJsonObject(record), ran, recovered: "late" })).toBe(true);

    // Nothing of where it ran or why is shown: the row and the first screen read it as the turn its record holds.
    const [row] = (await it.page.request("lah.turns.list", { chatId, cursor: null, limit: 5 })).turns;
    expect(row).toMatchObject({ turn: "gen-light", messageId: reply.id, changes: 2, transcript: null });
    for (const gone of ["place", "noPart", "recovered", "ran"]) expect(row).not.toHaveProperty(gone);
    expect((await it.page.request("lah.home.get", { chatId })).last).toEqual({
      turn: "gen-light",
      kind: "new",
      messageId: reply.id,
      startedAt: 100,
      ended: { state: "done", at: 200 },
      usage: record.usage,
      // With no transcript there are no steps to count: the record still says what it changed and started.
      agents: 0,
      tools: 0,
      lore: { added: 0, dropped: 0 },
      changes: 2,
      jobs: 1,
      transcript: null,
    });
  });
});

describe("a chat's notes", () => {
  test("are asked to be summarized at its next turn, and its session says so from then on", async () => {
    const it = (open = await rig());
    const chatId = await it.setUp();
    expect((await it.page.request("lah.turns.list", { chatId, cursor: null, limit: 5 })).session.asked ?? null).toBeNull();

    const asked = (await it.page.request("lah.session.summarize", { chatId })).session;
    expect(asked).toMatchObject({ turns: 0, summary: false });
    expect(typeof asked.asked).toBe("number");
    // Any page that reads the chat's turns later hears the same.
    expect((await it.page.request("lah.turns.list", { chatId, cursor: null, limit: 5 })).session.asked).toBe(asked.asked ?? null);

    // Another account's chat is never reached.
    const other = it.host.addChat("user-joss", "Joss's log");
    expect((await refusal(it.page.request("lah.session.summarize", { chatId: other.id }))).code).toBe("not_found");
  });
});

describe("a chat's lore and chronicle", () => {
  test("are the core's own answers, asked of the chat's runtime with the page's own body and passed on as they are", async () => {
    const s: Script = { asked: [], jobs: [], chronicle: CHRONICLE, found: FOUND, story: STORY };
    const it = (open = await rig({ harness: scripted(s) }));
    const chatId = await it.setUp();

    expect(await it.page.request("lah.chronicle.get", { chatId })).toEqual(CHRONICLE);
    expect(await it.page.request("lah.lore.search", { chatId, queries: ["brass key"], limit: 3 })).toEqual(FOUND);
    expect(s.asked).toEqual([
      { op: "recall.chronicle", input: { chatId } },
      { op: "recall.search", input: { chatId, queries: ["brass key"], limit: 3 } },
    ]);

    // Another account's chat is never reached, and an answer that isn't the core's is never passed on.
    const other = it.host.addChat("user-joss", "Joss's log");
    expect((await refusal(it.page.request("lah.chronicle.get", { chatId: other.id }))).code).toBe("not_found");
    s.chronicle = { files: "none" } as unknown as ChronicleCheck;
    const refused = await refusal(it.page.request("lah.chronicle.get", { chatId }));
    expect(refused.code).toBe("internal");
    expect(refused.message).toContain("isn't a chat's chronicle");
    expect(s.asked).toHaveLength(3);
  });
});

describe("the learning of a chat's story", () => {
  test("is the job a page started as such: named with how far it has come and what to start one with, and still named after the extension started again", async () => {
    const s: Script = { asked: [], jobs: [], chronicle: CHRONICLE, found: FOUND, story: STORY };
    const it = (open = await rig({ harness: scripted(s) }));
    const chatId = await it.setUp();

    // None was started yet: the page is given what to start one with and the core's own estimate of what the story takes, from which the page sizes the budget it offers.
    expect(await it.page.request("lah.story.get", { chatId })).toEqual({ job: null, plan: null, messages: 240, covered: 0, suggested: { task: STORY.suggested.task, agent: "chronicler" }, estimate: STORY.estimate, refused: null });

    // A job started by hand without saying so is no story's.
    await it.page.request("lah.job.start", { chatId, agent: "main", task: "Put the notes in order.", when: "now" });
    expect((await it.page.request("lah.story.get", { chatId })).job).toBeNull();

    // One started as the story's is, from then on. That it is the story's is the backend's to remember: the core is told nothing of it.
    const allowance = { tokensIn: 2_000_000, wallMs: null };
    const started = (await it.page.request("lah.job.start", { chatId, agent: "chronicler", task: STORY.suggested.task, when: "now", allowance, story: true })).job;
    expect(s.asked.at(-1)).toEqual({ op: "jobs.start", input: { chatId, agent: "chronicler", task: STORY.suggested.task, when: "now", allowance } });
    s.story = { ...STORY, plan: "learned/chronicle/plan.md", covered: 120 };
    expect(await it.page.request("lah.story.get", { chatId })).toMatchObject({ job: { id: started.id, agent: "chronicler", state: "queued", allowance }, plan: "learned/chronicle/plan.md", messages: 240, covered: 120 });

    // The extension starts again, and the runtime's next word links it there. Which job it was is in the user's storage; how the job stands now is the core's to say.
    const job = s.jobs.find((one) => one.id === started.id);
    if (job === undefined) throw new Error("the story's job is gone");
    job.state = "spent";
    await it.restart();
    await it.runtime.link.connect();
    expect((await it.page.request("lah.story.get", { chatId })).job).toMatchObject({ id: started.id, agent: "chronicler", state: "spent", allowance });

    // Started again as a new job, the new one takes its place.
    const next = (await it.page.request("lah.job.again", { id: started.id })).job;
    expect(next).toMatchObject({ again: started.id, state: "queued" });
    expect((await it.page.request("lah.story.get", { chatId })).job).toMatchObject({ id: next.id, again: started.id });

    // A job the core keeps no more is no longer named, so the page offers to start one.
    s.jobs = [];
    expect((await it.page.request("lah.story.get", { chatId })).job).toBeNull();
    expect((await it.page.request("lah.story.get", { chatId })).job).toBeNull();
  });
});

describe("the core itself", () => {
  test("answers what a page asks of a chat's lore, its chronicle and the learning of its story in what the views read", async () => {
    // No script: the core's own harness answers in the runtime, so what it gives at run time is what is read here.
    const it = (open = await rig());
    const chatId = await it.setUp();
    it.host.books.set("book-harbour", {
      book: { id: "book-harbour", name: "The harbour", description: "" },
      userId: USER,
      entries: [
        { id: "entry-key", bookId: "book-harbour", title: "The brass key", keys: ["brass key"], secondaryKeys: [], content: "Brann keeps the brass key to the lamp room.", enabled: true, constant: false },
        { id: "entry-light", bookId: "book-harbour", title: "The harbour light", keys: ["light"], secondaryKeys: [], content: "Okoro keeps the harbour light since Ilse handed him the keys.", enabled: false, constant: false },
      ],
    });
    const chat = it.host.chatList.get(chatId);
    if (chat === undefined) throw new Error("the chat is gone");
    chat.metadata.chat_world_book_ids = ["book-harbour"];

    // LumiAH has had no turn in the chat, so an entry is only off or not in the prompt; with no embedding connection, search is by word.
    const lore = await it.page.request("lah.lore.get", { chatId });
    expect(lore.books).toEqual([{ id: "book-harbour", name: "The harbour", description: "", entries: 2 }]);
    expect(lore.entries.map((row) => [row.entryId, row.title, row.chars, row.state])).toEqual([
      ["entry-key", "The brass key", 43, "not_in_prompt"],
      ["entry-light", "The harbour light", 61, "off"],
    ]);
    expect(lore.last).toBeNull();
    // How much waits for a vector is the core's own count; with no connection nothing is embedded, and nothing is being.
    expect(lore.embedding).toMatchObject({ connection: null, lore: { embedded: 0, total: 2 }, working: false });
    expect(await it.page.request("lah.lore.embed", { chatId, start: false })).toEqual({ embedding: lore.embedding });

    expect(await it.page.request("lah.lore.entry", { chatId, entryId: "entry-key" })).toEqual({ entry: lore.entries[0], text: "Brann keeps the brass key to the lamp room." });
    expect((await refusal(it.page.request("lah.lore.entry", { chatId, entryId: "entry-none" }))).code).toBe("not_found");
    const found = await it.page.request("lah.lore.search", { chatId, queries: ["brass key"], limit: 3 });
    expect(found.queries.map((query) => query.query)).toEqual(["brass key"]);
    expect(found.queries[0]?.hits[0]).toMatchObject({ entryId: "entry-key", title: "The brass key", by: ["word"], lines: [{ line: 1, text: "Brann keeps the brass key to the lamp room." }] });

    // No chronicle yet, so the check finds no file; a citation is read against the chat as it stands.
    expect(await it.page.request("lah.chronicle.get", { chatId })).toEqual({ files: [], failures: [], moved: [], uncited: [] });
    expect((await it.page.request("lah.chronicle.cited", { chatId, citations: ["[#0 a3f9c27e]", "[#7 00000000]"] })).cited).toMatchObject([
      { index: 0, ok: false, why: "changed", message: { index: 0, role: "user", name: "Mara", text: "Who keeps the harbour light now?" } },
      { index: 7, ok: false, why: "gone", message: null },
    ]);

    // Nothing of its story is learned yet: the core says what to start with and what learning it is expected to take.
    const story = await it.page.request("lah.story.get", { chatId });
    expect(story).toMatchObject({ job: null, plan: null, messages: 1, covered: 0, suggested: { agent: "chronicler" }, estimate: { messages: expect.any(Number), promptTokens: expect.any(Number), weighedTokens: expect.any(Number) } });
    expect(story.suggested.task).not.toBe("");
  });

  test("lists the tools the user approved for a chat and takes one back", async () => {
    const s: Script = { asked: [], jobs: [], chronicle: CHRONICLE, found: FOUND, story: STORY };
    const it = (open = await rig({ harness: scripted(s) }));
    const chatId = await it.setUp();
    s.approved = [
      { chatId, tool: "mcp:tide:table", at: 5_000 },
      { chatId: "chat-gone", tool: "dice_roll", at: null },
    ];

    // Every chat's are read by the user's runtime, from the store; each row names its chat as Lumiverse has it, and one of a chat that is gone is left out.
    expect(await it.page.request("lah.approvals.kept", { chatId: null })).toEqual({ kept: [{ chatId, chat: "Harbour light", tool: "mcp:tide:table", at: 5_000 }] });
    expect(s.asked.at(-1)).toEqual({ op: "approvals.kept", input: { chatId: null } });
    // Taking one back is the core's to do, in the chat's runtime; another account's chat is no chat at all.
    expect(await it.page.request("lah.approval.forget", { chatId, tool: "mcp:tide:table" })).toEqual({ kept: [] });
    expect(s.asked.at(-1)).toEqual({ op: "approvals.forget", input: { chatId, tool: "mcp:tide:table" } });
    const theirs = it.host.addChat("user-joss", "Joss's nets");
    expect((await refusal(it.page.request("lah.approval.forget", { chatId: theirs.id, tool: "dice_roll" }))).code).toBe("not_found");
  });
});
