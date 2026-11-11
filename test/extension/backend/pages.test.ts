// What the pages ask that came with the two ways to run (DESIGN §25), the first screen (§8 Home),
// lore and the chronicle (§24) and the learning of a story (§22), on the whole backend over a fake
// Lumiverse, as a user's page would notice it: which permissions are missing and what first-time
// setup counts, a chat switched on in either place, what the first screen says of a chat's latest
// turn while it runs, once it ended and after the extension started again, an ask for the notes to
// be summarized, the core's own answers about lore and the chronicle passed on as they are, and the
// job that learns a chat's story, which the backend remembers across a restart.

import { afterEach, describe, expect, test } from "bun:test";
import type { Harness as Core } from "../../../src/core/harness";
import type { AgentUsage, JobView, TurnRecord } from "../../../src/core/ports";
import type { ChronicleCheck, LoreSearchView, StoryStatus } from "../../../src/core/recall/shapes";
import { type Backend, createBackend } from "../../../src/extension/backend/backend";
import { toJsonObject } from "../../../src/link/json";
import type { Harness } from "../../../src/runtime/turn";
import { toolCall } from "../../support/fake-host";
import { FakePage, UiFailure } from "../../support/fake-lumiverse";
import { BUILD, type Rig, type RigOptions, rig, until, USER } from "../../support/rig";

const NO_USAGE: AgentUsage = { calls: 0, toolTurns: 0, in: 0, cachedIn: 0, out: 0, reasoningOut: 0, estimated: false, ms: 0 };

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

/** What the scripted core was asked, in which place, and what a test has it answer. */
interface Script {
  asked: { op: string; input: unknown; place: "runtime" | "builtin" }[];
  /** The jobs it keeps, as the store both places share would hold them. */
  jobs: JobView[];
  chronicle: ChronicleCheck;
  found: LoreSearchView;
  story: StoryStatus;
  /** The tools the user approved "for this chat", as the core keeps them; none where a test sets none. */
  approved?: { chatId: string; tool: string; at: number | null }[];
}

/** A harness that answers what these pages ask as its script says, in either place: the jobs in the core's own types, and the core's page surface for lore and the chronicle (`harness.recall`) by the names and inputs the pages' requests are asked under. */
function scripted(s: Script): NonNullable<RigOptions["harness"]> {
  return (_host, _settings, _extension, place) => {
    const asked = <T>(op: string, input: unknown, answer: T): T => {
      s.asked.push({ op, input, place });
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
    const chats = { forget: async (input: unknown) => asked("chats.forget", input, { documents: 3, jobs: 0, sides: 0 }) };
    return { answer: async () => ({ status: "failed", reason: "no turn is answered in this test", record: null, reply: "", usage: NO_USAGE }), jobs, recall, approvals, chats } satisfies Harness & Record<string, unknown>;
  };
}

let open: Rig | null = null;
afterEach(() => {
  open?.close();
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

/**
 * The extension started again: a new backend over the Lumiverse the first one ran in, which finds
 * what the first one kept in the user's storage and on the chats' messages and holds nothing of it
 * in memory, with the same core in it (`s`: the script, where the rig was given one); and a page
 * of it.
 */
function restarted(it: Rig, s?: Script): { backend: Backend; page: FakePage } {
  const backend = createBackend(it.host, {
    now: () => Date.now(),
    // Nothing a backend started again is asked here waits on its own timers, so it is given none.
    later: () => () => undefined,
    build: BUILD,
    ...(s !== undefined
      ? {
          harness: (host, given) => ({
            prepare: async (turn) => ({ messages: turn.messages, part: "none" as const, reason: "This test's harness prepares no turn.", pending: false, usage: NO_USAGE }),
            complete: async () => {
              throw new Error("this test's harness completes no turn");
            },
            abandon: async () => ({ abandoned: true }),
            ...scripted(s)(host, given.settings, given.extension ?? { name: "LumiAH" }, "builtin"),
          }),
        }
      : {}),
  });
  return { backend, page: new FakePage(it.host, USER) };
}

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
  test("built in unless the runtime is chosen, in a runtime only once one is there to choose, and keeps or gets back the connection it had", async () => {
    const it = (open = await rig());
    it.host.addConnection({ id: "conn-ilse", name: "Ilse's" });
    const chat = it.host.addChat(USER, "Brann's ledger");
    it.host.say(chat.id, "user", "What does Brann owe the harbour?");
    // The chat generates on a connection of its own.
    chat.metadata.connection_profile_id = "conn-ilse";
    const set = async (body: { on: boolean; place?: "builtin" | "runtime" }) => (await it.page.request("lah.chat.set", { chatId: chat.id, ...body })).chat;

    // No place named for a chat never set: built in. Nothing of the chat changes.
    expect(await set({ on: true })).toMatchObject({ chatId: chat.id, name: "Brann's ledger", on: true, place: "builtin", connection: { id: "conn-ilse", name: "Ilse's", loopback: false } });
    expect(chat.metadata.connection_profile_id).toBe("conn-ilse");
    expect((await it.page.request("lah.hello", {})).setup.steps[1]).toEqual({ id: "chat", done: true });

    // The runtime, while none is linked with its key minted: refused in words that say what to do, and the chat stays as it was.
    expect((await it.page.request("lah.hello", {})).runtime.ready).toBe(false);
    const none = await refusal(it.page.request("lah.chat.set", { chatId: chat.id, on: true, place: "runtime" }));
    expect(none.code).toBe("unavailable");
    expect(none.message).toContain("built in");
    expect((await it.page.request("lah.chat.get", { chatId: chat.id })).chat).toMatchObject({ on: true, place: "builtin", connection: { id: "conn-ilse" } });

    // With a runtime linked and its key minted (the rig's own chat runs there), the chat is pinned to the loopback connection.
    await it.setUp();
    expect((await it.page.request("lah.hello", {})).runtime.ready).toBe(true);
    const inRuntime = await set({ on: true, place: "runtime" });
    expect(inRuntime).toMatchObject({ on: true, place: "runtime", connection: { loopback: true } });
    expect<unknown>(chat.metadata.connection_profile_id).toBe(inRuntime.connection?.id);

    // Off, it has its own connection again; where it ran is kept, so on again with no place named it runs there.
    expect(await set({ on: false })).toMatchObject({ on: false, since: null, place: "runtime", connection: { id: "conn-ilse", loopback: false } });
    expect(await set({ on: true })).toMatchObject({ on: true, place: "runtime", connection: { loopback: true } });

    // Set to run built in while it is on: the connection it had is put back.
    expect(await set({ on: true, place: "builtin" })).toMatchObject({ on: true, place: "builtin", connection: { id: "conn-ilse", loopback: false } });
    expect(chat.metadata.connection_profile_id).toBe("conn-ilse");
    expect((await it.page.request("lah.hello", {})).chats.find((view) => view.chatId === chat.id)).toMatchObject({ on: true, place: "builtin" });
  });

  test("to run in a runtime that isn't linked says so, and the user is told before a reply goes there: the runtime way has no fallback, and one tap sets the chat to run built in", async () => {
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
    expect(linked).toMatchObject({ on: true, place: "runtime", connection: { loopback: true } });
    expect(linked.away).toBeUndefined();
    await prompt();
    expect(it.host.toasts).toEqual([]);

    // The runtime goes away. The chat stays set to it, and its view says the runtime isn't answering; the user's other chats are told nothing.
    it.runtime.shutdown();
    it.runtime.close();
    await until(() => !it.backend.relays.isLinked(USER, it.registration.relay), "the runtime's link to be gone");
    expect((await it.page.request("lah.chat.get", { chatId })).chat).toMatchObject({ on: true, place: "runtime", away: true, connection: { id: loopback, loopback: true } });
    expect((await it.page.request("lah.hello", {})).chats.find((view) => view.chatId === chatId)?.away).toBe(true);
    const here = await it.setUpBuiltin("The fish market");
    expect((await it.page.request("lah.chat.get", { chatId: here })).chat.away).toBeUndefined();

    // A reply about to go there: nothing answers in the runtime's place, so the user is told before it fails. A prompt preview sends nothing, and says nothing.
    await prompt(true);
    expect(it.host.toasts).toEqual([]);
    await prompt();
    expect(it.host.toasts).toEqual([{ userId: USER, level: "warning", text: "LumiAH's runtime isn't answering, so this reply may fail. On LumiAH's Home, set this chat to Built in, or start the runtime." }]);
    // The chat was left as it was: still pinned to the loopback connection, still set to the runtime.
    expect<unknown>(it.host.chatList.get(chatId)?.metadata.connection_profile_id).toBe(loopback);

    // One tap: built in, on the connection the chat had, and nothing more is said of the runtime.
    const builtIn = (await it.page.request("lah.chat.set", { chatId, on: true, place: "builtin" })).chat;
    expect(builtIn).toMatchObject({ on: true, place: "builtin", connection: { id: "conn-main", loopback: false } });
    expect(builtIn.away).toBeUndefined();
  });
});

describe("the first screen", () => {
  test("says of a chat's latest turn what its run says while it works and once it ended, and the same from its record after the extension started again", async () => {
    const it = (open = await rig());
    const chatId = await it.setUpBuiltin();

    // No chat is open, the chat is gone, or LumiAH has worked on no reply in it yet.
    expect(await it.page.request("lah.home.get", { chatId: null })).toEqual({ chat: null, last: null });
    expect(await it.page.request("lah.home.get", { chatId: "chat-gone" })).toEqual({ chat: null, last: null });
    expect(await it.page.request("lah.home.get", { chatId })).toMatchObject({ chat: { chatId, on: true, place: "builtin" }, last: null });

    // The main agent's call is held open, so its turn is under way while the page asks.
    const gate = Promise.withResolvers<void>();
    it.host.script = async () => {
      await gate.promise;
      return { toolCalls: [toolCall("write_reply", { brief: "Okoro keeps the light; Ilse handed it over last spring." })] };
    };
    it.lumiverse.writes = () => "Okoro keeps it now. Ilse handed him the keys last spring.";
    const generating = it.generate(chatId);
    await until(() => it.host.calls.length === 1 && (it.backend.live.whole(USER, chatId)?.events.some((e) => e.event.kind === "agent_started") ?? false), "the main agent at work");

    const during = (await it.page.request("lah.home.get", { chatId })).last;
    expect(during).toMatchObject({ kind: "new", ended: null, place: "builtin", agents: 1, tools: 0, lore: { added: 0, dropped: 0 }, changes: 0, jobs: 0, transcript: null });
    // Built in, the turn has until a moment before Lumiverse stops waiting for the extension.
    expect(during?.replyBy).toBeGreaterThan(during?.startedAt ?? Number.POSITIVE_INFINITY);
    expect((await it.page.request("lah.hello", {})).running).toMatchObject([{ stream: chatId, turn: during?.turn, kind: "new", place: "builtin", replyBy: during?.replyBy }]);

    gate.resolve();
    const out = await generating;
    expect(out.content).toBe("Okoro keeps it now. Ilse handed him the keys last spring.");
    const reply = it.host.message(chatId, out.messageId ?? "");
    await until(() => reply.own !== null, "the reply's record");
    await until(() => it.backend.live.runningOf(USER).length === 0, "the turn's end in the live view");

    // Ended: the reply it is on, what it spent, the one agent and its one call (`write_reply`), and the transcript its record names.
    const ended = (await it.page.request("lah.home.get", { chatId })).last;
    expect(ended).toMatchObject({ turn: out.generationId, kind: "new", messageId: reply.id, ended: { state: "done" }, place: "builtin", replyBy: during?.replyBy, agents: 1, tools: 1, lore: { added: 0, dropped: 0 }, changes: 0, jobs: 0 });
    expect(ended?.usage).toMatchObject({ calls: 1 });
    expect(ended?.transcript).toMatch(/^[0-9a-f]{64}$/);
    // The chat's turns say where it ran too, and a reply was answered: first-time setup is done.
    expect((await it.page.request("lah.turns.list", { chatId, cursor: null, limit: 5 })).turns).toMatchObject([{ turn: out.generationId, place: "builtin", transcript: ended?.transcript }]);
    // Read back, the stored transcript says it was a built-in reply's turn, and when its time before the reply ended.
    const stored = await it.page.request("lah.transcript.get", { transcript: ended?.transcript ?? "", from: 1 });
    expect(stored.view).toMatchObject({ turn: out.generationId, ended: { state: "done" }, place: "builtin", replyBy: during?.replyBy });
    await it.backend.settle();
    expect((await it.page.request("lah.hello", {})).setup.steps).toEqual([
      { id: "permissions", done: true },
      { id: "chat", done: true },
      { id: "reply", done: true },
    ]);

    // The extension starts again: nothing of the run is in memory, and the same is read from the record on the reply and the transcript it names.
    const again = restarted(it);
    expect(again.backend.live.whole(USER, chatId)).toBeNull();
    const kept = await again.page.request("lah.home.get", { chatId });
    expect(kept.chat).toMatchObject({ chatId, on: true, place: "builtin" });
    expect(kept.last).toEqual(ended);
  });

  test("says the same of a turn that ran in a runtime: where it ran, with no time set before the reply, and the writer among its agents", async () => {
    const it = (open = await rig());
    const chatId = await it.setUp();
    it.host.script = [{ toolCalls: [toolCall("write_reply", { brief: "Okoro keeps the light; Ilse handed it over last spring." })] }, "Okoro keeps it now."];
    const out = await it.generate(chatId);
    expect(out.content).toBe("Okoro keeps it now.");
    const reply = it.host.message(chatId, out.messageId ?? "");
    await until(() => reply.own !== null, "the reply's record");
    await until(() => it.backend.live.runningOf(USER).length === 0, "the turn's end in the live view");

    // In a runtime the writer is an agent of the turn too, and nothing bounds the time before the reply.
    const ended = (await it.page.request("lah.home.get", { chatId })).last;
    expect(ended).toMatchObject({ turn: out.generationId, kind: "new", messageId: reply.id, ended: { state: "done" }, place: "runtime", replyBy: null, agents: 2, tools: 1, changes: 0, jobs: 0 });
    expect(ended?.usage).toMatchObject({ calls: 2 });
    expect((await it.page.request("lah.turns.list", { chatId, cursor: null, limit: 5 })).turns).toMatchObject([{ turn: out.generationId, place: "runtime" }]);
    // And after the extension started again, from the record and its transcript.
    expect((await restarted(it).page.request("lah.home.get", { chatId })).last).toEqual(ended);
  });

  test("says why LumiAH had no part in a reply, as the chat's turns do, from what its record holds alone", async () => {
    const it = (open = await rig());
    const chatId = await it.setUpBuiltin();
    // A reply Lumiverse wrote alone: its record says where the turn ran and why it gave up, and names no transcript.
    const reply = it.host.say(chatId, "assistant", "Okoro keeps it now.");
    const noPart = { why: "time" as const, text: "LumiAH wasn't ready when Lumiverse had to send the prompt, so Lumiverse sent it as it was." };
    const record: TurnRecord = { v: 1, generationId: "gen-light", kind: "new", began: 100, at: 200, path: "", segment: "d".repeat(64), changed: 2, jobs: [{ id: "job_1a2b3c4d", agent: "main", state: "done" }], usage: { ...NO_USAGE, calls: 3, in: 900, out: 40 } };
    expect(await it.backend.chats.anchor(USER, chatId, reply.id, null, { ...toJsonObject(record), ran: { place: "builtin", noPart } })).toBe(true);

    const { turns } = await it.page.request("lah.turns.list", { chatId, cursor: null, limit: 5 });
    expect(turns).toMatchObject([{ turn: "gen-light", messageId: reply.id, place: "builtin", noPart, changes: 2, transcript: null }]);
    expect((await it.page.request("lah.home.get", { chatId })).last).toEqual({
      turn: "gen-light",
      kind: "new",
      messageId: reply.id,
      startedAt: 100,
      // The time ran out: the turn was stopped, and the reply is Lumiverse's own. Beside the sentence, the code a page can act on.
      ended: { state: "stopped", at: 200, noPart, cause: "time" },
      place: "builtin",
      replyBy: null,
      usage: record.usage,
      // With no transcript there are no steps to count: the record still says what it changed and started.
      agents: 0,
      tools: 0,
      lore: { added: 0, dropped: 0 },
      changes: 2,
      jobs: 1,
      transcript: null,
    });

    // A record from before there were two places names none: its turn ran in a runtime, and the row leaves the place out.
    const older = it.host.say(chatId, "assistant", "Ilse did, before him.");
    expect(await it.backend.chats.anchor(USER, chatId, older.id, null, toJsonObject({ ...record, generationId: "gen-older" }))).toBe(true);
    const listed = (await it.page.request("lah.turns.list", { chatId, cursor: null, limit: 5 })).turns;
    expect(listed.map((turn) => [turn.turn, turn.place, turn.noPart])).toEqual([
      ["gen-older", undefined, undefined],
      ["gen-light", "builtin", noPart],
    ]);
    expect((await it.page.request("lah.home.get", { chatId })).last).toMatchObject({ turn: "gen-older", messageId: older.id, ended: { state: "done", at: 200 }, place: "runtime" });
  });
});

describe("a chat's notes", () => {
  test("are asked to be summarized at its next turn, wherever the chat runs, and its session says so from then on", async () => {
    const it = (open = await rig());
    const builtin = await it.setUpBuiltin("Brann's ledger");
    expect((await it.page.request("lah.turns.list", { chatId: builtin, cursor: null, limit: 5 })).session.asked ?? null).toBeNull();

    const asked = (await it.page.request("lah.session.summarize", { chatId: builtin })).session;
    expect(asked).toMatchObject({ turns: 0, summary: false });
    expect(typeof asked.asked).toBe("number");
    // Any page that reads the chat's turns later hears the same.
    expect((await it.page.request("lah.turns.list", { chatId: builtin, cursor: null, limit: 5 })).session.asked).toBe(asked.asked ?? null);

    // A chat that runs in a runtime is asked there, and says so the same way.
    const inRuntime = await it.setUp();
    expect(typeof (await it.page.request("lah.session.summarize", { chatId: inRuntime })).session.asked).toBe("number");

    // Another account's chat is never reached.
    const other = it.host.addChat("user-joss", "Joss's log");
    expect((await refusal(it.page.request("lah.session.summarize", { chatId: other.id }))).code).toBe("not_found");
  });
});

describe("a chat's lore and chronicle", () => {
  test("are the core's own answers, asked where the chat's turns run with the page's own body and passed on as they are", async () => {
    const s: Script = { asked: [], jobs: [], chronicle: CHRONICLE, found: FOUND, story: STORY };
    const it = (open = await rig({ harness: scripted(s) }));
    const builtin = await it.setUpBuiltin("Brann's ledger");
    const inRuntime = await it.setUp();

    expect(await it.page.request("lah.chronicle.get", { chatId: builtin })).toEqual(CHRONICLE);
    expect(await it.page.request("lah.lore.search", { chatId: builtin, queries: ["brass key"], limit: 3 })).toEqual(FOUND);
    // A chat that runs in a runtime is asked about there.
    expect(await it.page.request("lah.chronicle.get", { chatId: inRuntime })).toEqual(CHRONICLE);
    expect(s.asked).toEqual([
      { op: "recall.chronicle", input: { chatId: builtin }, place: "builtin" },
      { op: "recall.search", input: { chatId: builtin, queries: ["brass key"], limit: 3 }, place: "builtin" },
      { op: "recall.chronicle", input: { chatId: inRuntime }, place: "runtime" },
    ]);

    // Another account's chat is never reached, and an answer that isn't the core's is never passed on.
    const other = it.host.addChat("user-joss", "Joss's log");
    expect((await refusal(it.page.request("lah.chronicle.get", { chatId: other.id }))).code).toBe("not_found");
    s.chronicle = { files: "none" } as unknown as ChronicleCheck;
    const refused = await refusal(it.page.request("lah.chronicle.get", { chatId: builtin }));
    expect(refused.code).toBe("internal");
    expect(refused.message).toContain("isn't a chat's chronicle");
    expect(s.asked).toHaveLength(4);
  });
});

describe("the learning of a chat's story", () => {
  test("is the job a page started as such: named with how far it has come and what to start one with, and still named after the extension started again", async () => {
    const s: Script = { asked: [], jobs: [], chronicle: CHRONICLE, found: FOUND, story: STORY };
    const it = (open = await rig({ harness: scripted(s) }));
    const chatId = await it.setUpBuiltin();

    // None was started yet: the page is given what to start one with and the core's own estimate of what the story takes, from which the page sizes the budget it offers.
    expect(await it.page.request("lah.story.get", { chatId })).toEqual({ job: null, plan: null, messages: 240, covered: 0, suggested: { task: STORY.suggested.task, agent: "chronicler" }, estimate: STORY.estimate, refused: null });

    // A job started by hand without saying so is no story's.
    await it.page.request("lah.job.start", { chatId, agent: "main", task: "Put the notes in order.", when: "now" });
    expect((await it.page.request("lah.story.get", { chatId })).job).toBeNull();

    // One started as the story's is, from then on. That it is the story's is the backend's to remember: the core is told nothing of it.
    const allowance = { tokensIn: 2_000_000, wallMs: null };
    const started = (await it.page.request("lah.job.start", { chatId, agent: "chronicler", task: STORY.suggested.task, when: "now", allowance, story: true })).job;
    expect(s.asked.at(-1)).toEqual({ op: "jobs.start", input: { chatId, agent: "chronicler", task: STORY.suggested.task, when: "now", allowance }, place: "builtin" });
    s.story = { ...STORY, plan: "learned/chronicle/plan.md", covered: 120 };
    expect(await it.page.request("lah.story.get", { chatId })).toMatchObject({ job: { id: started.id, agent: "chronicler", state: "queued", allowance }, plan: "learned/chronicle/plan.md", messages: 240, covered: 120 });

    // The extension starts again. Which job it was is in the user's storage; how the job stands now is the core's to say.
    const job = s.jobs.find((one) => one.id === started.id);
    if (job === undefined) throw new Error("the story's job is gone");
    job.state = "spent";
    const again = restarted(it, s);
    expect((await again.page.request("lah.story.get", { chatId })).job).toMatchObject({ id: started.id, agent: "chronicler", state: "spent", allowance });

    // Started again as a new job, the new one takes its place.
    const next = (await again.page.request("lah.job.again", { id: started.id })).job;
    expect(next).toMatchObject({ again: started.id, state: "queued" });
    expect((await again.page.request("lah.story.get", { chatId })).job).toMatchObject({ id: next.id, again: started.id });

    // A job the core keeps no more is no longer named, so the page offers to start one.
    s.jobs = [];
    expect((await again.page.request("lah.story.get", { chatId })).job).toBeNull();
    expect((await again.page.request("lah.story.get", { chatId })).job).toBeNull();
  });
});

describe("the core itself", () => {
  test("answers what a page asks of a chat's lore, its chronicle and the learning of its story in what the views read", async () => {
    // No script: the core's own harness answers, so what it gives at run time is what is read here.
    const it = (open = await rig());
    const chatId = await it.setUpBuiltin();
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

  test("lists the tools the user approved for a chat and takes one back, and forgets a chat Lumiverse deleted", async () => {
    const s: Script = { asked: [], jobs: [], chronicle: CHRONICLE, found: FOUND, story: STORY };
    const it = (open = await rig({ harness: scripted(s) }));
    const chatId = await it.setUpBuiltin();
    s.approved = [
      { chatId, tool: "mcp:tide:table", at: 5_000 },
      { chatId: "chat-gone", tool: "dice_roll", at: null },
    ];

    // Every chat's are read built in, from the store both places share; each row names its chat as Lumiverse has it, and one of a chat that is gone is left out.
    expect(await it.page.request("lah.approvals.kept", { chatId: null })).toEqual({ kept: [{ chatId, chat: "Harbour light", tool: "mcp:tide:table", at: 5_000 }] });
    expect(s.asked.at(-1)).toEqual({ op: "approvals.kept", input: { chatId: null }, place: "builtin" });
    // Taking one back is the core's to do, where the chat runs; another account's chat is no chat at all.
    expect(await it.page.request("lah.approval.forget", { chatId, tool: "mcp:tide:table" })).toEqual({ kept: [] });
    expect(s.asked.at(-1)).toEqual({ op: "approvals.forget", input: { chatId, tool: "mcp:tide:table" }, place: "builtin" });
    const theirs = it.host.addChat("user-joss", "Joss's nets");
    expect((await refusal(it.page.request("lah.approval.forget", { chatId: theirs.id, tool: "dice_roll" }))).code).toBe("not_found");

    // Lumiverse deletes the chat and says whose it was: the core is asked to forget what it kept of it.
    it.host.chatList.delete(chatId);
    it.host.emit.touched(chatId, true, USER);
    await until(() => s.asked.at(-1)?.op === "chats.forget", "the core to be asked to forget the chat");
    expect(s.asked.at(-1)).toEqual({ op: "chats.forget", input: { chatId }, place: "builtin" });
    // A deletion that names no user is nobody's to forget for.
    const asked = s.asked.length;
    it.host.emit.touched("chat-other", true, null);
    await it.backend.settle();
    expect(s.asked).toHaveLength(asked);
  });
});
