// The pages against a backend, end to end and without a browser: the page's client and its live
// follower on one side, the preview's stand-in backend (dev/preview/mock-backend.ts) on the other,
// with only `src/shared/ui.ts` between them. What holds here is what the preview shows, and the
// stand-in answering the whole contract is what makes the preview worth looking at.

import { describe, expect, test } from "bun:test";
import { fakeHash, workingTurn } from "../../dev/preview/fixtures";
import { MockBackend, type MockOptions } from "../../dev/preview/mock-backend";
import { sampleSettings } from "../../dev/preview/sections";
import { type Channel, UiClient } from "../../src/extension/frontend/client";
import { LiveFollower, type LiveState } from "../../src/extension/frontend/live-follow";
import { feedOf, NO_FILTER, turnTotals, turnView } from "../../src/extension/frontend/live-model";
import type { LiveView, UiRequests, UiRequestType } from "../../src/shared/ui";
import { BODIES } from "./bodies";

const T0 = Date.UTC(2026, 10, 10, 9, 0, 0);

/** A page and a backend joined by a channel, on a clock the test turns by hand. */
function world(over: Partial<MockOptions> = {}) {
  let now = T0;
  let nextId = 0;
  let timers: { at: number; id: number; fn: () => void }[] = [];
  let toPage: (payload: unknown) => void = () => {};
  const settled = sampleSettings();
  const backend = new MockBackend((payload) => toPage(structuredClone(payload)), {
    scenario: "ready",
    turn: "done",
    sections: settled.sections,
    texts: settled.texts,
    delay: 0,
    page: 6,
    fail: new Set(),
    now: () => now,
    later: (fn, ms) => {
      const timer = { at: now + ms, id: (nextId += 1), fn };
      timers.push(timer);
      return () => {
        timers = timers.filter((t) => t !== timer);
      };
    },
    ...over,
  });
  const channel: Channel = {
    send: (payload) => backend.receive(structuredClone(payload)),
    subscribe: (handler) => {
      toPage = handler;
      return () => {
        toPage = () => {};
      };
    },
  };
  const client = new UiClient(channel, { timeoutMs: () => 60_000 });
  /** Turns the clock on by `ms`, running what falls due in order, with the page's own work settled between. */
  const pass = async (ms = 0): Promise<void> => {
    const until = now + ms;
    for (;;) {
      for (let i = 0; i < 20; i += 1) await Promise.resolve();
      const due = timers.filter((t) => t.at <= until).sort((a, b) => a.at - b.at || a.id - b.id)[0];
      if (!due) break;
      timers = timers.filter((t) => t !== due);
      now = Math.max(now, due.at);
      due.fn();
    }
    now = until;
  };
  /** A request and its answer, the clock turned just far enough for the backend to answer. */
  const ask = async <K extends UiRequestType>(type: K, body: UiRequests[K]["body"]): Promise<UiRequests[K]["result"]> => {
    const asked = client.request(type, body);
    // Failing asks are awaited by the caller; this keeps a rejection from being unhandled meanwhile.
    asked.catch(() => {});
    await pass(0);
    return asked;
  };
  /** A page following a chat's live view. */
  const follow = async (chatId: string): Promise<{ follower: LiveFollower; states: LiveState[] }> => {
    const states: LiveState[] = [];
    const follower = new LiveFollower(
      {
        open: () => client.request("lah.live.open", { stream: chatId }),
        events: (turn, from) => client.request("lah.live.events", { stream: chatId, turn, from }),
      },
      (state) => states.push(state),
    );
    client.onLive((id, change) => {
      if (id === chatId) follower.hear(change);
    });
    const started = follower.start();
    await pass(0);
    await started;
    return { follower, states };
  };
  /** The page starts: it says hello and holds the state from then on. */
  const hello = async (): Promise<void> => {
    const syncing = client.sync();
    await pass(0);
    await syncing;
  };
  return { backend, client, pass, ask, follow, hello };
}

/** What a request came to: its result, or the error it was refused with. */
const outcome = (p: Promise<unknown>): Promise<unknown> => p.then((value) => value, (e: unknown) => e);

describe("the stand-in backend answers the whole contract", () => {
  test("every request gets its result", async () => {
    const w = world();
    const state = await w.ask("lah.hello", {});
    expect(state.rev).toBe(1);
    const { live } = await w.ask("lah.live.open", { stream: "chat-mara" });
    const turns = await w.ask("lah.turns.list", { chatId: "chat-mara", cursor: null, limit: 4 });
    const compacted = turns.turns.find((t) => t.compaction?.rollback === "available");
    const prompt = live?.events.flatMap((e) => (e.event.kind === "agent_entry" && e.event.entry.kind === "answer" && e.event.entry.prompt ? [e.event.entry.prompt] : []))[0];
    if (!live || !compacted?.compaction || !turns.turns[0]?.transcript || !prompt) throw new Error("the fixtures lack a live turn, a compaction, a transcript or a prompt");
    // What the workspace, the guidance and the jobs hold now: a write names the version it is based on, and only a job that ended badly can be started again. The notes are left alone: the made-up data has a job rewrite one of them, and Live's turns point at another.
    const files = (await w.ask("lah.ws.list", { chatId: "chat-mara", area: "chat" })).files.filter((f) => !f.path.startsWith("notes/"));
    const [moved, deleted] = files;
    const guidance = (await w.ask("lah.guidance.get", { chatId: "chat-mara" })).levels.find((l) => l.id === "chat");
    const jobs = (await w.ask("lah.jobs.list", { chatId: null, cursor: null, limit: 50 })).jobs;
    const queued = jobs.find((j) => j.state === "queued");
    const again = jobs.find((j) => j.state === "interrupted" || j.state === "failed" || j.state === "cancelled");
    const spent = jobs.find((j) => j.state === "spent");
    const held = jobs.find((j) => j.state === "paused");
    if (!moved || !deleted || !guidance || !queued || !again || !spent || !held) throw new Error("the fixtures lack two files to move and delete, the chat's guidance, a queued job, one that ended badly, one out of allowance or one left paused");

    // The shared bodies name what the made-up data holds; these need what only a live answer gives.
    const bodies: { [K in UiRequestType]: UiRequests[K]["body"] } = {
      ...BODIES,
      "lah.chat.get": { chatId: "chat-ilse" },
      "lah.chat.set": { chatId: "chat-ilse", on: true },
      "lah.live.events": { stream: "chat-mara", turn: live.turn, from: 7 },
      "lah.turn.stop": { stream: "chat-mara", turn: live.turn },
      "lah.turn.say": { stream: "chat-mara", turn: live.turn, text: "Keep it short." },
      "lah.turn.pause": { stream: "chat-mara", turn: live.turn, on: true },
      "lah.turns.list": { chatId: "chat-mara", cursor: turns.next, limit: 4 },
      "lah.transcript.get": { transcript: turns.turns[0].transcript, from: 1 },
      "lah.prompt.get": { prompt },
      "lah.blob.get": { hash: compacted.compaction.summary },
      "lah.session.rollback": { chatId: "chat-mara", messageId: compacted.messageId, swipe: compacted.swipe },
      "lah.settings.set": { set: [{ path: ["sample", "reply", "writer"], value: "main" }], reset: [] },
      "lah.text.set": { id: "main.system", text: "Be brief." },
      "lah.ws.move": { chatId: "chat-mara", area: "chat", from: moved.path, to: `${moved.path}.moved`, base: moved.hash },
      "lah.ws.delete": { chatId: "chat-mara", area: "chat", path: deleted.path, base: deleted.hash },
      "lah.guidance.set": { chatId: "chat-mara", level: "chat", text: "Joss never lies to Mara, though he leaves things out.", base: guidance.hash },
      "lah.job.cancel": { id: queued.id },
      "lah.job.again": { id: again.id },
      "lah.job.grant": { id: spent.id, allowance: { tokensIn: 400_000, tokensOut: 40_000 } },
      "lah.job.resume": { id: held.id },
    };
    for (const type of Object.keys(bodies) as UiRequestType[]) {
      // An answer may come later than at once (a sweep takes a while): the clock is turned until it has.
      const asked = outcome(w.client.request(type, bodies[type]));
      await w.pass(10_000);
      expect(await asked, type).not.toBeInstanceOf(Error);
    }
  });

  test("what it has no answer for is refused in words, never left hanging", async () => {
    const w = world();
    expect(await outcome(w.ask("lah.prompt.get", { prompt: fakeHash("no such prompt") }))).toMatchObject({ code: "not_found", message: "The store no longer has that prompt." });
    expect(await outcome(w.ask("lah.live.events", { stream: "chat-mara", turn: "another-turn", from: 1 }))).toMatchObject({ code: "not_found" });
    expect(await outcome(w.ask("lah.relay", { op: "forget", relay: "relay-9" }))).toMatchObject({ code: "not_found" });
    expect(await outcome(w.ask("lah.connections.models", { connectionId: "conn-local" }))).toMatchObject({ code: "not_found" });
    expect(await outcome(w.ask("lah.connections.list", { relay: "relay-9" }))).toMatchObject({ code: "unavailable" });
    // A request the page's own types wouldn't let it send still gets an answer.
    const malformed = w.client.request("lah.chat.get", { chatId: "" });
    expect(await outcome(malformed)).toMatchObject({ code: "bad_request", message: "The request lah.chat.get is malformed." });
  });

  test("a request the preview was told to fail fails, so a page's failure can be looked at", async () => {
    const w = world({ fail: new Set(["lah.turns.list"]) });
    expect(await outcome(w.ask("lah.turns.list", { chatId: "chat-mara", cursor: null, limit: 20 }))).toMatchObject({ code: "internal" });
    expect(await outcome(w.ask("lah.hello", {}))).toMatchObject({ rev: 1 });
  });
});

describe("a turn as the Live page sees it", () => {
  test("a finished turn is read whole, a page of events at a time", async () => {
    const w = world();
    const { follower, states } = await w.follow("chat-mara");
    const state = follower.current;
    if (state.status !== "ready" || !state.view) throw new Error("no live view");
    expect(state.partial).toBe(false);
    expect(state.view.events.map((e) => e.seq)).toEqual(state.view.events.map((_, i) => i + 1));
    expect(state.view.ended?.state).toBe("done");
    // It came six events a read, and the page never showed less than it had.
    const sizes = states.flatMap((s) => (s.status === "ready" && s.view ? [s.view.events.length] : []));
    expect(sizes.length).toBeGreaterThan(2);
    expect(sizes).toEqual([...sizes].sort((a, b) => a - b));
    // The main agent briefs LumiAH's writer, which writes the reply; the view says what the prompt held.
    expect(turnView(state.view).agents.map((a) => [a.start.role, a.state])).toEqual([["main", "done"], ["writer", "done"]]);
    expect(turnView(state.view).held?.lore.map((e) => e.title)).toEqual(["How the town speaks", "The harbour office", "Joss"]);
  });

  test("a turn that plays reaches the page a step at a time, and LumiAH's own writer writes the reply", async () => {
    const w = world({ turn: "none" });
    await w.hello();
    const { follower } = await w.follow("chat-mara");
    expect(follower.current).toEqual({ status: "ready", view: null, partial: false });

    expect(w.backend.startTurn("chat-mara")).toBe(true);
    await w.pass(400);
    // The state says it runs.
    expect(w.client.state.get()?.running.map((r) => [r.chatId, r.kind])).toEqual([["chat-mara", "new"]]);
    // A second reply can't be asked for while one is being written.
    expect(w.backend.startTurn("chat-mara")).toBe(false);

    // The main agent has been told and waits on its model.
    let state = follower.current;
    if (state.status !== "ready" || !state.view) throw new Error("no live view");
    expect(turnView(state.view).agents.map((a) => [a.start.role, a.state, a.activity?.waits])).toEqual([["main", "working", "model"]]);

    // Its first answer called two tools, neither answered yet.
    await w.pass(3000);
    state = follower.current;
    if (state.status !== "ready" || !state.view) throw new Error("no live view");
    expect(turnView(state.view).agents[0]?.activity).toMatchObject({ waits: "tools", names: ["chat_search", "lore_search"] });

    await w.pass(20_000);
    state = follower.current;
    if (state.status !== "ready" || !state.view) throw new Error("no live view");
    const turn = turnView(state.view);
    expect(state.view.ended?.state).toBe("done");
    expect(turn.agents.map((a) => [a.start.role, a.state])).toEqual([["main", "done"], ["writer", "done"]]);
    expect(state.view.events.map((e) => e.seq)).toEqual(state.view.events.map((_, i) => i + 1));
    expect(turnTotals(turn, 0).turn).toMatchObject({ calls: 3, in: 6020 + 6410 + 2380, toolCalls: 3, toolErrors: 0 });
    expect(feedOf(turn, NO_FILTER)[1]?.items.some((i) => i.kind === "said" && i.text.includes("night key"))).toBe(true);
    // The state follows: nothing runs.
    expect(w.client.state.get()?.running).toEqual([]);
    // Its record is kept: the chat's turns gain it, newest first.
    const turns = await w.ask("lah.turns.list", { chatId: "chat-mara", cursor: null, limit: 1 });
    expect(turns.turns[0]).toMatchObject({ turn: state.view.turn });
    expect(turns.total).toBe(8);
    // And the first screen's read counts what it did: two agents, and the main agent's three tool calls.
    expect((await w.ask("lah.home.get", { chatId: "chat-mara" })).last).toMatchObject({ turn: state.view.turn, agents: 2, tools: 3, lore: { added: 0, dropped: 0 } });
  });

  test("a push that never arrives leaves no hole: the page reads what it missed", async () => {
    const w = world({ turn: "none" });
    const { follower } = await w.follow("chat-mara");
    w.backend.startTurn("chat-mara");
    await w.pass(1000);
    w.backend.dropNextLive = true;
    await w.pass(30_000);
    const state = follower.current;
    if (state.status !== "ready" || !state.view) throw new Error("no live view");
    expect(w.backend.dropNextLive).toBe(false);
    expect(state.view.ended?.state).toBe("done");
    expect(state.view.events.map((e) => e.seq)).toEqual(state.view.events.map((_, i) => i + 1));
  });

  test("a call's answer shows as it arrives, and its entry takes its place when it lands", async () => {
    // LumiAH's own writer writes the reply, so its text arrives as a call's answer does.
    const w = world({ turn: "none" });
    const { follower } = await w.follow("chat-brann");
    const viewNow = (): LiveView => {
      const state = follower.current;
      if (state.status !== "ready" || !state.view) throw new Error("no live view");
      return state.view;
    };
    const answers = (agentId: string) => viewNow().events.flatMap((e) => (e.event.kind === "agent_entry" && e.event.agentId === agentId && e.event.entry.kind === "answer" ? [e.event.entry] : []));
    w.backend.startTurn("chat-brann");
    // The main agent is told at 300 ms and its first call answers at 2,900: by 1,900 some of its thinking has come.
    await w.pass(1900);
    const early = turnView(viewNow());
    const thinking = early.partials.get("main-1");
    expect(thinking).toMatchObject({ call: 1, text: "" });
    expect(thinking?.reasoning.length).toBeGreaterThan(10);
    expect(feedOf(early, NO_FILTER)[0]?.items.slice(-2).map((i) => [i.kind, "live" in i && i.live])).toEqual([["streaming", false], ["thinking", true]]);
    // More has come a moment later, joined to what was there.
    await w.pass(400);
    const later = viewNow().partials[0]?.reasoning ?? "";
    expect(later.length).toBeGreaterThan(thinking?.reasoning.length ?? 0);
    expect(later.startsWith(thinking?.reasoning ?? "?")).toBe(true);
    // Its answer lands: the entry holds the whole of it, and nothing is in flight.
    await w.pass(700);
    expect(viewNow().partials).toEqual([]);
    const whole = answers("main-1")[0]?.reasoning ?? "";
    expect(whole.startsWith(later)).toBe(true);
    expect(feedOf(turnView(viewNow()), NO_FILTER)[0]?.items.some((i) => "live" in i && i.live === true)).toBe(false);
    // The writer's reply comes the same way, as text: it is asked at 7,100 ms and answers at 10,900.
    await w.pass(6500);
    const writing = turnView(viewNow()).partials.get("writer-1");
    expect(writing).toMatchObject({ call: 1, reasoning: "" });
    expect(writing?.text.startsWith("The door opened")).toBe(true);
    await w.pass(5000);
    expect(viewNow().ended?.state).toBe("done");
    expect(viewNow().partials).toEqual([]);
    expect(answers("writer-1")[0]?.text.startsWith(writing?.text ?? "?")).toBe(true);
  });

  test("a page that opens while a call is in flight shows what it has sent, then follows on", async () => {
    const w = world({ turn: "none" });
    w.backend.startTurn("chat-mara");
    await w.pass(1900);
    // Nobody was watching until now.
    const { follower } = await w.follow("chat-mara");
    const first = follower.current;
    if (first.status !== "ready" || !first.view) throw new Error("no live view");
    const had = first.view.partials[0]?.reasoning ?? "";
    expect(had.length).toBeGreaterThan(10);
    await w.pass(400);
    const next = follower.current;
    if (next.status !== "ready" || !next.view) throw new Error("no live view");
    expect(next.view.partials[0]?.reasoning.startsWith(had)).toBe(true);
    expect(next.view.partials[0]?.reasoning.length).toBeGreaterThan(had.length);
  });

  test("a delta that never arrives leaves no hole in what a call has sent", async () => {
    const w = world({ turn: "none" });
    const { follower } = await w.follow("chat-mara");
    w.backend.startTurn("chat-mara");
    await w.pass(1500);
    w.backend.dropNextLive = true;
    await w.pass(800);
    expect(w.backend.dropNextLive).toBe(false);
    const state = follower.current;
    if (state.status !== "ready" || !state.view) throw new Error("no live view");
    // What the page shows is what the backend holds: read afresh, the view says the same.
    const fresh = await w.ask("lah.live.open", { stream: "chat-mara" });
    expect(state.view.partials).toEqual(fresh.live?.partials ?? []);
    expect(state.view.partials[0]?.reasoning.length).toBeGreaterThan(10);
  });

  test("Stop ends a running turn: its agents stop, and a second Stop finds nothing to stop", async () => {
    const w = world({ turn: "none" });
    const { follower } = await w.follow("chat-mara");
    w.backend.startTurn("chat-mara");
    await w.pass(1500);
    let state = follower.current;
    if (state.status !== "ready" || !state.view) throw new Error("no live view");
    const turn = state.view.turn;
    expect(await w.ask("lah.turn.stop", { stream: "chat-mara", turn })).toEqual({ stopped: true });
    await w.pass(30_000);
    state = follower.current;
    if (state.status !== "ready" || !state.view) throw new Error("no live view");
    expect(state.view.ended).toMatchObject({ state: "stopped", reason: "You stopped it from the live view." });
    const stopped = turnView(state.view);
    expect(stopped.agents.map((a) => a.state)).toEqual(["cancelled"]);
    expect(feedOf(stopped, { ...NO_FILTER, problems: true })[0]?.items.map((i) => i.kind)).toEqual(["stop"]);
    expect(await w.ask("lah.turn.stop", { stream: "chat-mara", turn })).toEqual({ stopped: false });
    // It ended before any reply was written, so nothing of it is kept on the chat: the stored turns are as they were.
    expect((await w.ask("lah.turns.list", { chatId: "chat-mara", cursor: null, limit: 1 })).total).toBe(7);
  });

  test("a chat LumiAH doesn't answer has no turn to play", async () => {
    const w = world({ turn: "none" });
    expect(w.backend.startTurn("chat-ilse")).toBe(false);
    expect((await w.ask("lah.live.open", { stream: "chat-ilse" })).live).toBeNull();
  });
});

describe("what the user does to a run that works", () => {
  /** A page watching the made-up turn whose archivist's workspace write is held, the clock turned to where it is. */
  const heldTurn = async (chatId = "chat-mara") => {
    const w = world({ turn: "none" });
    await w.hello();
    const { follower } = await w.follow(chatId);
    expect(w.backend.startTurn(chatId, workingTurn())).toBe(true);
    await w.pass(8000);
    const state = follower.current;
    if (state.status !== "ready" || !state.view) throw new Error("no live view");
    return { w, follower, turn: state.view.turn };
  };
  const entries = (view: LiveView | null): string[] => (view?.events ?? []).flatMap((e) => (e.event.kind === "agent_entry" ? [e.event.entry.kind] : []));
  const viewOf = (follower: LiveFollower): LiveView => {
    const state = follower.current;
    if (state.status !== "ready" || !state.view) throw new Error("no live view");
    return state.view;
  };

  test("a held tool call reaches every page in the state, and the run waits for the user's word", async () => {
    const { w, follower } = await heldTurn();
    const [held] = w.client.state.get()?.approvals ?? [];
    expect(held).toMatchObject({ stream: "chat-mara", chatId: "chat-mara", role: "archivist", tool: "workspace_write", tier: "write" });
    expect(entries(viewOf(follower)).at(-1)).toBe("approval_asked");
    // Nothing moves while it waits, however long (short of its bound).
    const before = viewOf(follower).events.length;
    await w.pass(60_000);
    expect(viewOf(follower).events.length).toBe(before);
    expect(turnView(viewOf(follower)).agents.find((a) => a.start.role === "archivist")?.activity).toMatchObject({ waits: "word", tool: "workspace_write" });
  });

  test("approved, the call runs, changes its file, and the turn goes on to its end", async () => {
    const { w, follower } = await heldTurn();
    const id = w.client.state.get()?.approvals[0]?.id ?? "";
    expect(await w.ask("lah.approval.answer", { id, answer: { decision: "once" } })).toEqual({ answered: true });
    expect(w.client.state.get()?.approvals).toEqual([]);
    await w.pass(30_000);
    const view = viewOf(follower);
    expect(view.ended?.state).toBe("done");
    const tools = feedOf(turnView(view), NO_FILTER).flatMap((f) => f.items.flatMap((i) => (i.kind === "tool" ? [i] : [])));
    const write = tools.find((t) => t.call.name === "workspace_write");
    expect(write?.word?.ended?.decision).toBe("once");
    expect(write?.files.map((f) => f.path)).toEqual(["notes/ledger.md"]);
    // Answered twice, the second finds nothing waiting.
    expect(await w.ask("lah.approval.answer", { id, answer: { decision: "once" } })).toEqual({ answered: false });
  });

  test("refused, the agent is told why and the turn goes on without the write", async () => {
    const { w, follower } = await heldTurn();
    const id = w.client.state.get()?.approvals[0]?.id ?? "";
    await w.ask("lah.approval.answer", { id, answer: { decision: "refused", reason: "Not while Brann is in the room." } });
    await w.pass(30_000);
    const view = viewOf(follower);
    const result = view.events.flatMap((e) => (e.event.kind === "agent_entry" && e.event.entry.kind === "result" && e.event.entry.name === "workspace_write" ? [e.event.entry] : []))[0];
    expect(result).toMatchObject({ error: true, text: expect.stringContaining("Not while Brann is in the room.") });
    expect(result?.files).toBeUndefined();
    expect(view.ended?.state).toBe("done");
  });

  test("unanswered, the wait runs out: the call is refused and the state stops asking", async () => {
    // A held call waits its full five minutes at most.
    const { w, follower } = await heldTurn();
    await w.pass(5 * 60_000);
    expect(w.client.state.get()?.approvals).toEqual([]);
    const worded = viewOf(follower).events.flatMap((e) => (e.event.kind === "agent_entry" && e.event.entry.kind === "approval" ? [e.event.entry.decision] : []));
    expect(worded).toEqual(["timed_out"]);
  });

  test("stopping the turn takes its held call down", async () => {
    const { w, follower, turn } = await heldTurn();
    expect(await w.ask("lah.turn.stop", { stream: "chat-mara", turn })).toEqual({ stopped: true });
    expect(w.client.state.get()?.approvals).toEqual([]);
    expect(viewOf(follower).ended?.state).toBe("stopped");
    // A held call whose turn is stopped ends with its agent's stop: no word was given on it.
    expect(entries(viewOf(follower))).not.toContain("approval");
  });

  test("what the user says reaches the main agent at its next round, as theirs", async () => {
    const w = world({ turn: "none" });
    await w.hello();
    const { follower } = await w.follow("chat-mara");
    w.backend.startTurn("chat-mara");
    await w.pass(1000);
    const turn = viewOf(follower).turn;
    expect(await w.ask("lah.turn.say", { stream: "chat-mara", turn, text: "Ilse should not open the back room." })).toEqual({ said: true });
    await w.pass(3000);
    const notes = viewOf(follower).events.flatMap((e) => (e.event.kind === "agent_entry" && e.event.entry.kind === "note" ? [[e.event.agentId, e.event.entry.text]] : []));
    expect(notes).toEqual([["main-1", "Ilse should not open the back room."]]);
    await w.pass(60_000);
    expect(await w.ask("lah.turn.say", { stream: "chat-mara", turn, text: "Too late." })).toEqual({ said: false });
  });

  test("paused, a turn stands still and the state says so; let go, it goes on to its end", async () => {
    const w = world({ turn: "none" });
    await w.hello();
    const { follower } = await w.follow("chat-mara");
    w.backend.startTurn("chat-mara");
    await w.pass(1000);
    const turn = viewOf(follower).turn;
    expect(await w.ask("lah.turn.pause", { stream: "chat-mara", turn, on: true })).toEqual({ paused: true });
    expect(w.client.state.get()?.running[0]?.paused).toBe(true);
    expect(turnView(viewOf(follower)).paused).toBe(true);
    // What it had started finishes; nothing new starts.
    await w.pass(120_000);
    const stood = viewOf(follower).events.length;
    await w.pass(120_000);
    expect(viewOf(follower).events.length).toBe(stood);
    expect(viewOf(follower).ended).toBeNull();
    expect(await w.ask("lah.turn.pause", { stream: "chat-mara", turn, on: false })).toEqual({ paused: false });
    expect(w.client.state.get()?.running[0]?.paused).toBe(false);
    await w.pass(120_000);
    expect(viewOf(follower).ended?.state).toBe("done");
    expect(viewOf(follower).events.flatMap((e) => (e.event.kind === "turn_paused" || e.event.kind === "turn_resumed" ? [e.event.kind] : []))).toEqual(["turn_paused", "turn_resumed"]);
  });
});

describe("a conversation with an agent", () => {
  test("saying something starts a turn under the conversation's own id, which ends with an answer and a transcript", async () => {
    const w = world({ turn: "none" });
    await w.hello();
    const { session } = await w.ask("lah.side.start", { agent: "archivist", chatId: "chat-mara" });
    expect(session).toMatchObject({ agent: "archivist", agentName: "Archivist", chatId: "chat-mara", turns: 0 });
    const { follower } = await w.follow(session.id);
    const sent = await w.ask("lah.side.send", { session: session.id, text: "What do we know of Okoro?" });
    expect(sent.session).toMatchObject({ title: "What do we know of Okoro?", turns: 1 });
    await w.pass(500);
    expect(w.client.state.get()?.running).toMatchObject([{ stream: session.id, kind: "side", chatId: "chat-mara", turn: sent.turn }]);
    // While it works a second message is refused in words, not queued.
    expect(await outcome(w.ask("lah.side.send", { session: session.id, text: "And Ilse?" }))).toMatchObject({ code: "unavailable" });
    expect((await w.ask("lah.side.turns", { session: session.id, cursor: null, limit: 10 })).turns).toMatchObject([{ turn: sent.turn, state: "running", answer: null, transcript: null }]);
    await w.pass(30_000);
    const state = follower.current;
    if (state.status !== "ready" || !state.view) throw new Error("no live view");
    expect(state.view).toMatchObject({ stream: session.id, kind: "side", chatId: "chat-mara", messageId: null });
    expect(state.view.ended?.state).toBe("done");
    expect(w.client.state.get()?.running).toEqual([]);
    const [turn] = (await w.ask("lah.side.turns", { session: session.id, cursor: null, limit: 10 })).turns;
    expect(turn).toMatchObject({ state: "done", answer: expect.stringContaining("Okoro audits the ledgers") });
    // Its work is kept as a transcript of its own, read like a reply's.
    const read = await w.ask("lah.transcript.get", { transcript: turn?.transcript ?? "", from: 1 });
    expect(read.view).toMatchObject({ stream: session.id, kind: "side" });
    // Nothing of it is a reply in the chat.
    expect((await w.ask("lah.turns.list", { chatId: "chat-mara", cursor: null, limit: 50 })).turns.some((t) => t.turn === sent.turn)).toBe(false);
  });

  test("a conversation is listed with the latest first, and is gone once deleted", async () => {
    const w = world();
    const before = (await w.ask("lah.side.list", {})).sessions;
    expect(before.map((s) => s.id)).toEqual(["side-notes", "side-plain"]);
    const { session } = await w.ask("lah.side.start", { agent: "main", chatId: null });
    expect((await w.ask("lah.side.list", {})).sessions[0]?.id).toBe(session.id);
    expect(await outcome(w.ask("lah.side.start", { agent: "nobody", chatId: null }))).toMatchObject({ code: "not_found" });
    expect(await w.ask("lah.side.remove", { session: session.id })).toEqual({ removed: true });
    expect(await outcome(w.ask("lah.side.turns", { session: session.id, cursor: null, limit: 10 }))).toMatchObject({ code: "not_found" });
    // The conversation that was there when the preview opened has its turns to read, each with its work.
    const kept = (await w.ask("lah.side.turns", { session: "side-notes", cursor: null, limit: 10 })).turns;
    expect(kept.map((t) => t.said)).toEqual(["And what do we know of Okoro?", "What do the notes say about the ledger?"]);
    expect((await w.ask("lah.transcript.get", { transcript: kept[0]?.transcript ?? "", from: 1 })).view.kind).toBe("side");
  });
});

describe("settings and texts as the Settings page keeps them", () => {
  test("a value is put whole at its path over the defaults, and every page hears", async () => {
    const w = world();
    await w.hello();
    const { settings } = await w.ask("lah.settings.set", { set: [{ path: ["sample", "agents", "main", "budget", "toolTurns"], value: null }], reset: [] });
    expect(settings.values).toMatchObject({ sample: { agents: { main: { budget: { toolTurns: null, wallMs: null } } } } });
    expect(settings.defaults).toMatchObject({ sample: { agents: { main: { budget: { toolTurns: 24 } } } } });
    expect(w.client.state.get()?.settings).toEqual(settings);
  });

  test("a reset takes the user's own value away, under a group as well as at a setting", async () => {
    const w = world();
    await w.ask("lah.settings.set", { set: [{ path: ["sample", "reply", "writer"], value: "main" }, { path: ["sample", "reply", "progress"], value: false }, { path: ["sample", "notes"], value: "mine" }], reset: [] });
    const one = await w.ask("lah.settings.set", { set: [], reset: [["sample", "reply"]] });
    expect(one.settings.values).toMatchObject({ sample: { reply: { writer: "writer", progress: true }, notes: "mine" } });
    const all = await w.ask("lah.settings.set", { set: [], reset: [[]] });
    expect(all.settings.values).toEqual(all.settings.defaults);
  });

  test("a refused value keeps none of the request, and says which value and why", async () => {
    const w = world();
    const error = await outcome(w.ask("lah.settings.set", { set: [{ path: ["sample", "reply", "progress"], value: false }, { path: ["sample", "history"], value: { keep: "last", count: 0 } }], reset: [] }));
    expect(error).toMatchObject({ code: "invalid", message: "Not saved: It can't be under 1.", problems: [{ path: ["sample", "history", "count"], message: "It can't be under 1." }] });
    const state = await w.ask("lah.hello", {});
    expect(state.settings.values).toEqual(state.settings.defaults);
  });

  test("a text of the user's own stands over its default until it is reset; one that leaves out what it needs is refused", async () => {
    const w = world();
    const set = await w.ask("lah.text.set", { id: "writer.brief", text: "## What to write\n{{brief}}" });
    expect(set.texts.own).toEqual({ "writer.brief": "## What to write\n{{brief}}" });
    expect(await outcome(w.ask("lah.text.set", { id: "writer.brief", text: "## What to write" }))).toMatchObject({ code: "invalid", message: "The text needs {{brief}}." });
    expect(await outcome(w.ask("lah.text.set", { id: "no.such.text", text: "x" }))).toMatchObject({ code: "not_found" });
    expect((await w.ask("lah.text.reset", { id: "writer.brief" })).texts.own).toEqual({});
  });
});

describe("first-time setup, from nothing to a reply", () => {
  test("needs the permissions, the runtime's own steps, the switch and a reply, each done by what the user does, in the state every page holds", async () => {
    const w = world({ scenario: "fresh", turn: "none" });
    await w.hello();
    const state = () => {
      const held = w.client.state.get();
      if (held === null) throw new Error("the page holds no state");
      return held;
    };
    const done = (): string[] => state().setup.steps.filter((s) => s.done).map((s) => s.id);
    expect(state().setup.steps.map((s) => s.id)).toEqual(["permissions", "chat", "reply"]);
    expect(done()).toEqual([]);
    expect(state().permissions.filter((p) => p.needed).length).toBeGreaterThan(0);
    // Nothing granted yet: the switch is refused in words that say what to do first.
    expect(await outcome(w.ask("lah.chat.set", { chatId: "chat-ilse", on: true }))).toMatchObject({ code: "unavailable", message: expect.stringContaining("Allow it on Home") });

    // Granting some of what it needs isn't enough; granting all of it is the first step.
    w.backend.grant(["generation"]);
    await w.pass(0);
    expect(done()).toEqual([]);
    w.backend.grant(state().permissions.map((p) => p.id));
    await w.pass(0);
    expect(state().permissions).toEqual([]);
    expect(done()).toEqual(["permissions"]);

    // No runtime yet: the switch is refused in words that say how to set one up, and nothing of the chat changes.
    expect(await outcome(w.ask("lah.chat.set", { chatId: "chat-ilse", on: true }))).toMatchObject({ code: "unavailable", message: "There is no runtime to answer this chat yet. Start one with its line on LumiAH's Runtime page and mint its key there, then switch the chat on." });
    expect(state().chats).toEqual([]);
    expect(state().runtime).toMatchObject({ relays: [], ready: false });

    // A key minted before a runtime links is shown, but nothing could put it in a connection.
    const early = await w.ask("lah.key", { op: "mint" });
    expect(early.key).toStartWith("lah_");
    expect(early.connection).toBeNull();
    w.backend.linkRuntime();
    await w.pass(0);
    expect(state().runtime.ready).toBe(false);

    // Minted with a runtime linked, the key goes into the loopback connection, which is made: the runtime is ready.
    const minted = await w.ask("lah.key", { op: "mint" });
    expect(minted.key).not.toBe(early.key);
    expect(minted.connection).toEqual({ id: "conn-loopback", name: "LumiAH loopback" });
    expect(state().runtime.ready).toBe(true);

    // Switched on, the chat is pinned to the loopback connection, so the runtime answers it.
    const { chat } = await w.ask("lah.chat.set", { chatId: "chat-ilse", on: true });
    expect(chat).toMatchObject({ on: true, connection: { id: "conn-loopback", loopback: true } });
    expect(state().chats.map((c) => c.chatId)).toEqual(["chat-ilse"]);
    expect(done()).toEqual(["permissions", "chat"]);

    // A reply: its turn runs, and once it is answered the last step is done.
    expect(w.backend.startTurn("chat-ilse")).toBe(true);
    await w.pass(500);
    expect(state().running.map((r) => r.chatId)).toEqual(["chat-ilse"]);
    await w.pass(60_000);
    expect(done()).toEqual(["permissions", "chat", "reply"]);

    // Switched off, it gets its own connection back and leaves the list.
    const off = await w.ask("lah.chat.set", { chatId: "chat-ilse", on: false });
    expect(off.chat).toMatchObject({ on: false, since: null, connection: { loopback: false } });
    expect(state().chats).toEqual([]);

    // The key forgotten, the runtime isn't ready any more.
    await w.ask("lah.key", { op: "forget" });
    expect(state().runtime.ready).toBe(false);
  });

  test("forgetting the key leaves none, and says so to every page", async () => {
    const w = world();
    await w.hello();
    expect(w.client.state.get()?.key.set).toBe(true);
    expect(await w.ask("lah.key", { op: "forget" })).toEqual({ key: null, view: { set: false, print: null, at: null }, connection: null });
    expect(w.client.state.get()?.key.set).toBe(false);
  });
});

describe("a compaction on the Sessions page", () => {
  test("its summary can be read, and a rollback asked for waits for the chat's next turn", async () => {
    const w = world();
    const first = await w.ask("lah.turns.list", { chatId: "chat-mara", cursor: null, limit: 20 });
    expect(first.session).toMatchObject({ summary: true, dropped: 1 });
    const compacted = first.turns.find((t) => t.compaction?.rollback === "available");
    if (!compacted?.compaction) throw new Error("the fixtures lack a compaction");
    expect((await w.ask("lah.blob.get", { hash: compacted.compaction.summary })).text).toStartWith("What has happened so far");

    const asked = await w.ask("lah.session.rollback", { chatId: "chat-mara", messageId: compacted.messageId, swipe: compacted.swipe });
    expect(asked.turn.compaction?.rollback).toBe("pending");
    // Asked for twice, the second is refused: it is already on its way.
    expect(await outcome(w.ask("lah.session.rollback", { chatId: "chat-mara", messageId: compacted.messageId, swipe: compacted.swipe }))).toMatchObject({ code: "unavailable" });

    // The chat's next turn makes it: the session reads the turns in full again.
    w.backend.startTurn("chat-mara");
    await w.pass(60_000);
    const after = await w.ask("lah.turns.list", { chatId: "chat-mara", cursor: null, limit: 20 });
    expect(after.turns.find((t) => t.messageId === compacted.messageId)?.compaction?.rollback).toBe("done");
    expect(after.session.summary).toBe(false);
    expect(after.session.turns).toBeGreaterThan(first.session.turns);
  });

  test("turns come a page at a time, newest first, each page naming the next", async () => {
    const w = world();
    const one = await w.ask("lah.turns.list", { chatId: "chat-mara", cursor: null, limit: 4 });
    expect(one.turns.map((t) => t.index)).toEqual([43, 41, 39, 37]);
    expect(one.total).toBe(7);
    const two = await w.ask("lah.turns.list", { chatId: "chat-mara", cursor: one.next, limit: 4 });
    expect(two.turns.map((t) => t.index)).toEqual([35, 33, 31]);
    expect(two.next).toBeNull();
    // A turn whose transcript wasn't kept says so by having none to open.
    expect(two.turns[0]?.transcript).toBeNull();
  });
});

describe("asking for a summary", () => {
  test("the session says the user asked, from then on; a chat with no session is refused", async () => {
    const w = world();
    const before = await w.ask("lah.turns.list", { chatId: "chat-mara", cursor: null, limit: 5 });
    expect(before.session.asked ?? null).toBeNull();
    const { session } = await w.ask("lah.session.summarize", { chatId: "chat-mara" });
    expect(typeof session.asked).toBe("number");
    const after = await w.ask("lah.turns.list", { chatId: "chat-mara", cursor: null, limit: 5 });
    expect(after.session.asked).toBe(session.asked);
    expect(await outcome(w.ask("lah.session.summarize", { chatId: "chat-nobody" }))).toMatchObject({ code: "not_found" });
  });
});
