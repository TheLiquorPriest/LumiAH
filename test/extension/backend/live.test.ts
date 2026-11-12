// A model's answer in the live view as it arrives (DESIGN §8 Live): the runtime sends what each call
// in flight gained, the live buffer keeps it as that call's partial and hands each delta on to the
// pages following the chat, a page that opens the view mid-call gets the partial with it, and the
// partial is gone once the call's own entry lands. Nothing of it is stored.
//
// And what the buffer keeps and lets go: each account's runs apart from every other's, under
// ceilings no account sets, and a run whose runtime went away for good ended as lost.

import { afterEach, describe, expect, test } from "bun:test";
import type { AgentStopCode, AgentUsage, TraceDelta, TraceRecord, TranscriptEntry } from "../../../src/core/ports";
import { LiveBuffer, type LiveCeilings, type RunStart } from "../../../src/extension/backend/live";
import { LINK } from "../../../src/link/contract";
import { CEILINGS, TRANSPORT_DEFAULTS, type TransportSettings } from "../../../src/link/settings";
import { type BackendToFrontend, type LiveDelta, type LiveView, followDelta, followLive } from "../../../src/shared/ui";
import type { FakePage } from "../../support/fake-lumiverse";
import { FakeHost, toolCall } from "../../support/fake-host";
import { type Rig, rig, until, USER } from "../../support/rig";

let r: Rig | null = null;
afterEach(async () => {
  await r?.close();
  r = null;
});

const deltasOf = (page: FakePage): LiveDelta[] => page.pushes.flatMap((p: BackendToFrontend) => (p.type === "lah.live.delta" ? [p.delta] : []));

/** A page's view after everything it was pushed since it opened the chat, followed with the page's own functions. */
function followed(opened: LiveView | null, page: FakePage): LiveView | null {
  let view = opened;
  for (const push of page.pushes) {
    if (push.type !== "lah.live" && push.type !== "lah.live.delta") continue;
    const next = push.type === "lah.live" ? followLive(view, push.change) : followDelta(view, push.delta);
    if ("gap" in next) throw new Error(`the page couldn't follow: it found a gap (${next.gap})`);
    view = next;
  }
  return view;
}

describe("a call in flight", () => {
  test("reaches a following page delta by delta, is in the view a page opens mid-call, and is gone after its answer", async () => {
    const it = (r = await rig());
    const chatId = await it.setUp();
    // The main agent's first call never answers by itself: the test says what arrives of it.
    it.host.script = [{ hang: true }];
    let turn = "";
    const stop = new AbortController();
    const generating = it.generate(chatId, { signal: stop.signal, onStarted: (id) => (turn = id) });
    await until(() => it.host.calls.length === 1 && it.backend.live.runningOf(USER).length === 1, "the turn to be running");
    const early = it.lumiverse.page();
    const opened = await early.request("lah.live.open", { stream: chatId });
    expect(opened.live?.partials).toEqual([]);

    const delta = (more: Pick<TraceDelta, "text" | "reasoning">): TraceDelta => ({ turn, chatId, agentId: "main", call: 1, ...more, at: 1_000 });
    it.runtime.link.notify({ type: "trace.deltas", deltas: [delta({ reasoning: "Who keeps the light? " }), delta({ text: "Okoro " }), delta({ text: "keeps " })] });
    await until(() => deltasOf(early).length === 3, "the deltas to reach the page");

    // In the order they were sent, each saying how much of the call came before it.
    expect(deltasOf(early)).toEqual([
      { turn, agentId: "main", call: 1, reasoning: "Who keeps the light? ", before: { text: 0, reasoning: 0 }, at: 1_000 },
      { turn, agentId: "main", call: 1, text: "Okoro ", before: { text: 0, reasoning: 21 }, at: 1_000 },
      { turn, agentId: "main", call: 1, text: "keeps ", before: { text: 6, reasoning: 21 }, at: 1_000 },
    ]);

    // A page that starts following now gets what has arrived so far with the view.
    const late = it.lumiverse.page();
    const midCall = await late.request("lah.live.open", { stream: chatId });
    expect(midCall.live?.partials).toEqual([{ agentId: "main", call: 1, text: "Okoro keeps ", reasoning: "Who keeps the light? ", at: 1_000 }]);

    // Both hear what arrives next, and both hold the same partial after it.
    it.runtime.link.notify({ type: "trace.deltas", deltas: [delta({ text: "it." })] });
    await until(() => deltasOf(late).length === 1 && deltasOf(early).length === 4, "the next delta to reach both pages");
    expect(deltasOf(late)[0]?.before).toEqual({ text: 12, reasoning: 21 });
    const whole = [{ agentId: "main", call: 1, text: "Okoro keeps it.", reasoning: "Who keeps the light? ", at: 1_000 }];
    expect(followed(opened.live, early)?.partials).toEqual(whole);
    expect(followed(midCall.live, late)?.partials).toEqual(whole);

    // A delta from a session that is no runtime's is not taken.
    it.host.deliver({ link: LINK, type: "trace.deltas", deltas: [delta({ text: " (not from the runtime)" })] }, USER, early.session);

    // The call's own entry lands: the partial has done its work.
    const held = (await late.request("lah.live.open", { stream: chatId })).live?.events.length ?? 0;
    const answer: TraceRecord = { turn, chatId, seq: held + 1, event: { kind: "agent_entry", agentId: "main", entry: { kind: "answer", text: "Okoro keeps it.", reasoning: "Who keeps the light? ", calls: [], written: false, tools: "none", usage: { in: 10, cachedIn: 0, out: 4, reasoningOut: 0, estimated: [] }, model: "scripted-model", finishReason: "stop", ms: 5, at: 1_200 } } };
    expect(await it.runtime.link.request("trace.push", { records: [answer] }, 1_000)).toEqual({ taken: 1 });
    const after = await it.lumiverse.page().request("lah.live.open", { stream: chatId });
    expect(after.live?.partials).toEqual([]);
    expect(after.live?.events.at(-1)?.event).toMatchObject({ kind: "agent_entry", entry: { kind: "answer", text: "Okoro keeps it." } });
    expect(followed(opened.live, early)?.partials).toEqual([]);

    // What comes late of the answered call is left; the agent's next call starts its own partial.
    it.runtime.link.notify({ type: "trace.deltas", deltas: [delta({ text: " (late)" }), { ...delta({ text: "Next." }), call: 2 }] });
    await until(() => deltasOf(early).length === 5, "the next call's delta");
    expect(deltasOf(early).at(-1)).toMatchObject({ call: 2, text: "Next.", before: { text: 0, reasoning: 0 } });
    expect((await late.request("lah.live.open", { stream: chatId })).live?.partials).toEqual([{ agentId: "main", call: 2, text: "Next.", reasoning: "", at: 1_000 }]);

    // The turn ends: nothing is in flight, and nothing of the partials was stored.
    stop.abort();
    await generating;
    await until(() => it.backend.live.runningOf(USER).length === 0, "the turn to end");
    expect((await late.request("lah.live.open", { stream: chatId })).live?.partials).toEqual([]);
    expect([...it.host.files.values()].some((text) => text.includes("Okoro keeps"))).toBe(false);
  });

  test("of a real turn: the writer's answer reaches a following page as it streams, before the entry that holds it whole", async () => {
    const it = (r = await rig());
    const chatId = await it.setUp();
    it.host.script = [{ toolCalls: [toolCall("write_reply", { brief: "Okoro keeps the light." })] }, { content: "Okoro keeps it now. Ilse handed him the keys.", reasoning: "Short and plain." }];
    const opened = await it.page.request("lah.live.open", { stream: chatId });

    const out = await it.generate(chatId);
    await until(() => it.backend.live.runningOf(USER).length === 0, "the turn to end");
    await it.backend.settle();

    expect(out.content).toBe("Okoro keeps it now. Ilse handed him the keys.");
    // The page could follow all of it, and ends with the turn done and nothing in flight.
    const view = followed(opened.live, it.page);
    expect(view?.ended?.state).toBe("done");
    expect(view?.partials).toEqual([]);
    // What the page was pushed of the writer's call, joined in order, is the reply and its thinking.
    const writer = view?.events.flatMap((e) => (e.event.kind === "agent_started" && e.event.agent.role === "writer" ? [e.event.agent.id] : []))[0] ?? "";
    const written = deltasOf(it.page).filter((d) => d.agentId === writer);
    expect(written.length).toBeGreaterThan(0);
    expect(written.every((d) => d.call === 1)).toBe(true);
    expect(written.map((d) => d.text ?? "").join("")).toBe("Okoro keeps it now. Ilse handed him the keys.");
    expect(written.map((d) => d.reasoning ?? "").join("")).toBe("Short and plain.");
    // Every delta of the call came before the push that carried its answer entry.
    const lastDelta = it.page.pushes.findLastIndex((p) => p.type === "lah.live.delta" && p.delta.agentId === writer);
    const entry = it.page.pushes.findIndex((p) => p.type === "lah.live" && "events" in p.change && p.change.events.some((e) => e.event.kind === "agent_entry" && e.event.agentId === writer && e.event.entry.kind === "answer"));
    expect(entry).toBeGreaterThan(lastDelta);
  });
});

const JOSS = "user-joss";

/**
 * A live buffer of its own: a clock the test moves, each account's settings the test's to set,
 * each runtime's link gone for as long as the test says (by `account relay`; absent: linked), and
 * a permission LumiAH needs missing when the test says so (`lacking.needed`).
 */
function buffer(ceilings: Partial<LiveCeilings> = {}) {
  const clock = { now: 1_000_000 };
  const set = new Map<string, { live?: Partial<TransportSettings["live"]>; runtime?: Partial<TransportSettings["runtime"]> }>();
  const gone = new Map<string, number>();
  const lacking = { needed: false };
  const transport = async (userId: string): Promise<TransportSettings> => ({ ...TRANSPORT_DEFAULTS, live: { ...TRANSPORT_DEFAULTS.live, ...set.get(userId)?.live }, runtime: { ...TRANSPORT_DEFAULTS.runtime, ...set.get(userId)?.runtime } });
  const live = new LiveBuffer(new FakeHost(), { now: () => clock.now, transport, linkGoneFor: (userId, relay) => gone.get(`${userId} ${relay}`) ?? null, missing: () => lacking.needed }, { ...CEILINGS, ...ceilings });
  return { live, clock, set, gone, lacking };
}

const reply = (chat: string, turn: string): RunStart => ({ stream: chat, chatId: chat, turn, kind: "new", messageId: null });
/** The first record of a job's run, as a runtime traces it: all the buffer needs to start following one. */
const jobStarted = (job: string, turn: string): TraceRecord => ({ turn, chatId: "", seq: 1, event: { kind: "turn_started", turn, chatId: "", generation: "job", messageId: null, job, at: 1 } });
const step = (turn: string, seq: number): TraceRecord => ({ turn, chatId: "", seq, event: { kind: "notice", text: `Brann checks lamp ${seq}.`, at: seq } });
const USAGE: AgentUsage = { calls: 1, toolTurns: 0, in: 10, cachedIn: 0, out: 5, reasoningOut: 0, estimated: false, ms: 1 };
/** The record a runtime traces as a run of its ends. */
const ended = (turn: string, seq: number, status: "done" | "stopped" = "done"): TraceRecord => ({ turn, chatId: "", seq, event: { kind: "turn_ended", status, usage: USAGE, at: seq } });
/** The runtime the replies of these tests run in. */
const RELAY = "relay-quay";

/** A reply's run that began and ended done, as its runtime traced it. */
async function answered(live: LiveBuffer, userId: string, chat: string, turn: string): Promise<void> {
  await live.begin(userId, RELAY, reply(chat, turn));
  await live.push(userId, RELAY, [ended(turn, 1)]);
}

describe("two accounts on one server", () => {
  test("one account's 'Chats kept' at 1 lets go of its own earlier run and leaves another account's latest run in its live view", async () => {
    const it = (r = await rig());
    const mine = it.host.addChat(USER, "Harbour light");
    await answered(it.backend.live, USER, mine.id, "gen-mara");

    await it.backend.settings.change(JOSS, [{ path: ["transport", "live", "chats"], value: 1 }], []);
    await answered(it.backend.live, JOSS, "chat-joss-quay", "gen-joss-1");
    await it.backend.live.begin(JOSS, RELAY, reply("chat-joss-mill", "gen-joss-2"));

    expect(it.backend.live.whole(USER, mine.id)?.turn ?? null).toBe("gen-mara");
    expect(it.backend.live.chatsOf(USER)).toEqual([mine.id]);
    expect(it.backend.live.chatsOf(JOSS)).toEqual(["chat-joss-mill"]);
  });

  test("an account past its own 'Chats kept' loses the ended run of its own that began longest ago, and nobody else's", async () => {
    const { live, set } = buffer();
    set.set(USER, { live: { chats: 2 } });
    await answered(live, JOSS, "chat-joss", "gen-joss");
    await answered(live, USER, "chat-quay", "gen-1");
    await answered(live, USER, "chat-mill", "gen-2");
    await answered(live, USER, "chat-light", "gen-3");

    expect(live.chatsOf(USER)).toEqual(["chat-mill", "chat-light"]);
    expect(live.streamOf(USER, "gen-1")).toBeNull();
    expect(live.whole(JOSS, "chat-joss")?.turn).toBe("gen-joss");
  });

  test("two accounts' runs with one id are two runs: each account reads, ends and stops only its own", async () => {
    const { live } = buffer();
    await live.push(USER, "relay-mara", [jobStarted("job-tide", "run-1")]);
    await live.push(JOSS, "relay-joss", [jobStarted("job-tide", "run-1"), step("run-1", 2)]);

    await live.push(JOSS, "relay-joss", [ended("run-1", 3, "stopped")]);

    expect(live.running(USER, "job-tide", "run-1")?.relay).toBe("relay-mara");
    expect(live.whole(USER, "job-tide")?.events.length).toBe(1);
    expect(live.whole(JOSS, "job-tide")?.ended?.state).toBe("stopped");
    expect(live.whole(JOSS, "job-tide")?.events.length).toBe(3);
  });
});

describe("what the live buffer holds at most", () => {
  test("an account's own settings can't raise the events kept of a run or the chats kept past the fixed ceilings", async () => {
    const { live, set, gone } = buffer({ liveEvents: 3, liveChats: 2 });
    set.set(USER, { live: { events: 1_000_000, chats: 1024 } });

    const taken = await live.push(USER, "relay-mara", [jobStarted("job-tide", "run-1"), step("run-1", 2), step("run-1", 3), step("run-1", 4), step("run-1", 5)]);
    expect(taken).toBe(3);
    expect(live.whole(USER, "job-tide")?.events.map((e) => e.seq)).toEqual([1, 2, 3]);
    // Its runtime goes away for good: the run ends, lost, and may be let go for room.
    gone.set(`${USER} relay-mara`, TRANSPORT_DEFAULTS.runtime.lostMs);
    await live.tick();

    await answered(live, USER, "chat-quay", "gen-1");
    await answered(live, USER, "chat-mill", "gen-2");
    expect(live.whole(USER, "job-tide")).toBeNull();
    expect(live.chatsOf(USER)).toEqual(["chat-quay", "chat-mill"]);
  });

  test("past the most runs under way for one account, its oldest run a runtime only told of ends as lost in words; its reply's turn and another account's runs go on", async () => {
    const { live, set } = buffer();
    // Room to keep the run that gives way, so the test can read how it ended.
    set.set(USER, { live: { chats: CEILINGS.liveChats } });
    const over: string[] = [];
    live.onEnded((run) => over.push(`${run.userId} ${run.turn}`));
    await live.begin(USER, RELAY, reply("chat-light", "gen-mara"));
    await live.push(JOSS, "relay-joss", [jobStarted("job-joss", "run-joss")]);

    for (let n = 1; n < CEILINGS.liveRunning; n++) await live.push(USER, "relay-mara", [jobStarted(`job-${n}`, `run-${n}`)]);
    expect(live.runningOf(USER).length).toBe(CEILINGS.liveRunning);
    expect(over).toEqual([]);

    await live.push(USER, "relay-mara", [jobStarted("job-more", "run-more")]);

    expect(live.runningOf(USER).length).toBe(CEILINGS.liveRunning);
    expect(over).toEqual([`${USER} run-1`]);
    const gone = live.whole(USER, "job-1")?.ended;
    expect(gone?.state).toBe("lost");
    expect(gone?.reason).toContain(`At most ${CEILINGS.liveRunning} runs under way are followed for one account`);
    expect(live.running(USER, "chat-light", "gen-mara")).not.toBeNull();
    expect(live.running(USER, "job-more", "run-more")).not.toBeNull();
    expect(live.running(JOSS, "job-joss", "run-joss")).not.toBeNull();
  });

  test("where every run under way of an account is a reply's turn, the one begun longest ago gives way", async () => {
    const { live } = buffer({ liveRunning: 2 });
    await live.begin(USER, RELAY, reply("chat-quay", "gen-1"));
    await live.begin(USER, RELAY, reply("chat-mill", "gen-2"));
    await live.begin(USER, RELAY, reply("chat-light", "gen-3"));

    expect(live.whole(USER, "chat-quay")?.ended?.state).toBe("lost");
    expect(live.runningOf(USER).map((run) => run.turn)).toEqual(["gen-2", "gen-3"]);
  });

  test("past the most runs of all accounts together, the account that holds the most loses its ended run that began longest ago", async () => {
    const { live } = buffer({ liveRunsTotal: 5 });
    for (const n of [1, 2, 3]) await answered(live, USER, `chat-mara-${n}`, `gen-mara-${n}`);
    for (const n of [1, 2]) await answered(live, JOSS, `chat-joss-${n}`, `gen-joss-${n}`);

    // Mara holds three and Joss two: room for Joss's third is made of Mara's.
    await answered(live, JOSS, "chat-joss-3", "gen-joss-3");
    expect(live.chatsOf(USER)).toEqual(["chat-mara-2", "chat-mara-3"]);
    expect(live.chatsOf(JOSS)).toEqual(["chat-joss-1", "chat-joss-2", "chat-joss-3"]);

    // Now Joss holds the most: his fourth costs him his own first.
    await live.begin(JOSS, RELAY, reply("chat-joss-4", "gen-joss-4"));
    expect(live.chatsOf(USER)).toEqual(["chat-mara-2", "chat-mara-3"]);
    expect(live.chatsOf(JOSS)).toEqual(["chat-joss-2", "chat-joss-3", "chat-joss-4"]);
    expect(live.running(JOSS, "chat-joss-4", "gen-joss-4")).not.toBeNull();
  });

  test("past the most events of all accounts together, a run's later events stay out of the live view until a run is let go", async () => {
    const { live } = buffer({ liveEventsTotal: 6 });
    expect(await live.push(USER, "relay-mara", [jobStarted("job-tide", "run-1"), step("run-1", 2), step("run-1", 3), step("run-1", 4)])).toBe(4);

    expect(await live.push(JOSS, "relay-joss", [jobStarted("job-lamp", "run-2"), step("run-2", 2), step("run-2", 3), step("run-2", 4)])).toBe(2);
    expect(live.whole(JOSS, "job-lamp")?.events.map((e) => e.seq)).toEqual([1, 2]);
    expect(await live.push(USER, "relay-mara", [step("run-1", 5)])).toBe(0);
    // The run is followed all the same: it is under way, and can be stopped.
    expect(live.running(JOSS, "job-lamp", "run-2")).not.toBeNull();

    // The job's next run takes the place of its last: the four events held of that one are let go.
    expect(await live.push(USER, "relay-mara", [jobStarted("job-tide", "run-3")])).toBe(1);
    expect(await live.push(JOSS, "relay-joss", [jobStarted("job-keys", "run-4"), step("run-4", 2), step("run-4", 3)])).toBe(3);
    expect(await live.push(JOSS, "relay-joss", [step("run-4", 4)])).toBe(0);
  });
});

describe("a run whose runtime went away", () => {
  test("ends as lost once the runtime's link has been gone for the account's lost-for time, saying so; a run whose runtime came back in time goes on", async () => {
    const { live, gone } = buffer();
    const lostMs = TRANSPORT_DEFAULTS.runtime.lostMs;
    await live.push(USER, "relay-quay", [jobStarted("job-tide", "run-tide")]);
    await live.begin(USER, "relay-quay", reply("chat-light", "gen-light"));
    await live.push(USER, "relay-mill", [jobStarted("job-lamp", "run-lamp")]);

    // Both runtimes' links drop. Not yet for long enough: nothing ends.
    gone.set(`${USER} relay-quay`, lostMs - 1);
    gone.set(`${USER} relay-mill`, lostMs - 1);
    await live.tick();
    expect(live.runningOf(USER).length).toBe(3);

    // One comes back; the other stays away.
    gone.delete(`${USER} relay-mill`);
    gone.set(`${USER} relay-quay`, lostMs);
    await live.tick();

    const job = live.whole(USER, "job-tide")?.ended;
    expect(job?.state).toBe("lost");
    expect(job?.reason).toBe(`The runtime this ran in went away: its link has been gone for ${lostMs / 1000} seconds. The run ended with the runtime; once the runtime is back, the job shows as interrupted.`);
    const turn = live.whole(USER, "chat-light")?.ended;
    expect(turn?.state).toBe("lost");
    expect(turn?.reason).toBe(`The runtime this ran in went away: its link has been gone for ${lostMs / 1000} seconds. The run ended with the runtime.`);
    expect(live.runningOf(USER).map((run) => run.turn)).toEqual(["run-lamp"]);
  });

  test("is given up after each account's own lost-for time, not another's", async () => {
    const { live, set, gone } = buffer();
    set.set(JOSS, { runtime: { lostMs: 5_000 } });
    await live.push(USER, "relay-quay", [jobStarted("job-tide", "run-tide")]);
    await live.push(JOSS, "relay-mill", [jobStarted("job-lamp", "run-lamp")]);
    gone.set(`${USER} relay-quay`, 5_000);
    gone.set(`${JOSS} relay-mill`, 5_000);

    await live.tick();

    expect(live.whole(JOSS, "job-lamp")?.ended?.state).toBe("lost");
    expect(live.running(USER, "job-tide", "run-tide")).not.toBeNull();
  });
});

describe("why a turn failed, as a code beside the sentence", () => {
  const CALL = { in: 10, cachedIn: 0, out: 5, reasoningOut: 0, estimated: [] };
  /** A run's trace, numbered from 1: its agents as they start (one with a `parent` is no main agent) and their steps. */
  const traced = (turn: string, events: ({ agent: string; parent?: string } | { of: string; entry: TranscriptEntry } | { ended: "done" | "failed" | "stopped"; reason?: string })[]): TraceRecord[] =>
    events.map((e, i): TraceRecord => {
      const at = { turn, chatId: "chat-light", seq: i + 1 };
      if ("agent" in e) return { ...at, event: { kind: "agent_started", agent: { id: e.agent, role: e.parent === undefined ? "main" : "scout", connectionId: null, model: null, effort: "inherit", system: "", prefix: [], history: 0, ...(e.parent !== undefined ? { parent: e.parent } : {}), at: i } } };
      if ("of" in e) return { ...at, event: { kind: "agent_entry", agentId: e.of, entry: e.entry } };
      return { ...at, event: { kind: "turn_ended", status: e.ended, ...(e.reason !== undefined ? { reason: e.reason } : {}), usage: USAGE, at: i } };
    });
  const refusedTools: TranscriptEntry = { kind: "tools_refused", reason: "This model does not support tools.", ms: 1, at: 1 };
  const plain: TranscriptEntry = { kind: "answer", text: "Okoro keeps it, I believe.", calls: [], written: false, tools: "text", usage: CALL, model: "model-main", finishReason: "stop", ms: 1, at: 2 };
  const calling: TranscriptEntry = { ...plain, text: "", calls: [{ id: "call_1", name: "preset_instructions", args: {} }] };
  const stopped = (code: AgentStopCode): TranscriptEntry => ({ kind: "stop", status: code === "failed" ? "failed" : "refused", code, reason: "It stopped short.", at: 3 });
  /** How a runtime's reply turn ended, once its trace was pushed. */
  const endOf = async (records: TraceRecord[], lacking = false) => {
    const made = buffer();
    made.lacking.needed = lacking;
    await made.live.begin(USER, "relay-quay", reply("chat-light", "gen-light"));
    await made.live.push(USER, "relay-quay", records);
    return made.live.whole(USER, "chat-light")?.ended;
  };

  test("a model that took no tools and called none as text is named as that; one that then called a tool is not", async () => {
    expect(await endOf(traced("gen-light", [{ agent: "a1" }, { of: "a1", entry: refusedTools }, { of: "a1", entry: plain }, { ended: "failed", reason: "The main agent stopped before it wrote a brief." }]))).toMatchObject({ state: "failed", reason: "The main agent stopped before it wrote a brief.", cause: "no_tools" });
    const worked = await endOf(traced("gen-light", [{ agent: "a1" }, { of: "a1", entry: refusedTools }, { of: "a1", entry: calling }, { of: "a1", entry: stopped("failed") }, { ended: "failed", reason: "The provider answered 503." }]));
    expect(worked?.state).toBe("failed");
    expect(worked?.cause).toBeUndefined();
  });

  test("a limit of the user's that stopped the main agent is named as a limit; a sub-agent's own limit is not the turn's cause", async () => {
    expect((await endOf(traced("gen-light", [{ agent: "a1" }, { of: "a1", entry: stopped("tool_turns") }, { ended: "failed", reason: "It used its 24 rounds." }])))?.cause).toBe("limit");
    expect((await endOf(traced("gen-light", [{ agent: "a1" }, { of: "a1", entry: stopped("spend") }, { ended: "failed" }])))?.cause).toBe("limit");
    expect((await endOf(traced("gen-light", [{ agent: "a1" }, { agent: "a2", parent: "a1" }, { of: "a2", entry: stopped("tool_turns") }, { of: "a1", entry: stopped("failed") }, { ended: "failed" }])))?.cause).toBeUndefined();
  });

  test("a turn that fails while a permission LumiAH needs is missing fails for that; a turn that ended well, or that the user stopped, names no cause", async () => {
    expect((await endOf(traced("gen-light", [{ agent: "a1" }, { of: "a1", entry: stopped("failed") }, { ended: "failed", reason: "Lumiverse refused the call." }]), true))?.cause).toBe("permission");
    expect((await endOf(traced("gen-light", [{ agent: "a1" }, { of: "a1", entry: plain }, { ended: "done" }]), true))?.cause).toBeUndefined();
    expect((await endOf(traced("gen-light", [{ agent: "a1" }, { of: "a1", entry: stopped("cancelled") }, { ended: "stopped", reason: "You stopped the reply." }])))?.cause).toBeUndefined();
  });
});
