// The pages against a backend, end to end and without a browser: the page's client and its live
// follower on one side, the preview's stand-in backend (dev/preview/mock-backend.ts) on the other,
// with only `src/shared/ui.ts` between them. What holds here is what the preview shows, and the
// stand-in answering the whole contract is what makes the preview worth looking at.

import { describe, expect, test } from "bun:test";
import { fakeHash } from "../../dev/preview/fixtures";
import { MockBackend, type MockOptions } from "../../dev/preview/mock-backend";
import { sampleSettings } from "../../dev/preview/sections";
import { type Channel, UiClient } from "../../src/extension/frontend/client";
import { LiveFollower, type LiveState } from "../../src/extension/frontend/live-follow";
import { feedOf, NO_FILTER, turnTotals, turnView } from "../../src/extension/frontend/live-model";
import type { LiveView, UiRequests, UiRequestType } from "../../src/shared/ui";

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
        open: () => client.request("lah.live.open", { chatId }),
        events: (turn, from) => client.request("lah.live.events", { chatId, turn, from }),
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
    const { live } = await w.ask("lah.live.open", { chatId: "chat-mara" });
    const turns = await w.ask("lah.turns.list", { chatId: "chat-mara", cursor: null, limit: 4 });
    const compacted = turns.turns.find((t) => t.compaction?.rollback === "available");
    const prompt = live?.events.flatMap((e) => (e.event.kind === "agent_entry" && e.event.entry.kind === "answer" && e.event.entry.prompt ? [e.event.entry.prompt] : []))[0];
    if (!live || !compacted?.compaction || !turns.turns[0]?.transcript || !prompt) throw new Error("the fixtures lack a live turn, a compaction, a transcript or a prompt");

    // One well-formed body per request: a request added to the contract must be added here to compile.
    const bodies: { [K in UiRequestType]: UiRequests[K]["body"] } = {
      "lah.hello": {},
      "lah.chat.get": { chatId: "chat-ilse" },
      "lah.chat.set": { chatId: "chat-ilse", on: true },
      "lah.live.open": { chatId: "chat-mara" },
      "lah.live.events": { chatId: "chat-mara", turn: live.turn, from: 7 },
      "lah.live.close": { chatId: "chat-mara" },
      "lah.turn.stop": { chatId: "chat-mara", turn: live.turn },
      "lah.turns.list": { chatId: "chat-mara", cursor: turns.next, limit: 4 },
      "lah.transcript.get": { chatId: "chat-mara", transcript: turns.turns[0].transcript, from: 1 },
      "lah.prompt.get": { prompt },
      "lah.blob.get": { hash: compacted.compaction.summary },
      "lah.session.rollback": { chatId: "chat-mara", messageId: compacted.messageId, swipe: compacted.swipe },
      "lah.settings.set": { set: [{ path: ["sample", "reply", "writer"], value: "main" }], reset: [] },
      "lah.models.list": { connectionId: null },
      "lah.text.set": { id: "main.system", text: "Be brief." },
      "lah.text.reset": { id: "main.system" },
      "lah.key": { op: "mint" },
      "lah.relay": { op: "rotate", relay: "relay-1" },
    };
    for (const type of Object.keys(bodies) as UiRequestType[]) {
      const answered = await outcome(w.ask(type, bodies[type]));
      expect(answered, type).not.toBeInstanceOf(Error);
    }
  });

  test("what it has no answer for is refused in words, never left hanging", async () => {
    const w = world();
    expect(await outcome(w.ask("lah.prompt.get", { prompt: fakeHash("no such prompt") }))).toMatchObject({ code: "not_found", message: "The store no longer has that prompt." });
    expect(await outcome(w.ask("lah.live.events", { chatId: "chat-mara", turn: "another-turn", from: 1 }))).toMatchObject({ code: "not_found" });
    expect(await outcome(w.ask("lah.relay", { op: "forget", relay: "relay-9" }))).toMatchObject({ code: "not_found" });
    expect(await outcome(w.ask("lah.models.list", { connectionId: "conn-local" }))).toMatchObject({ code: "unavailable" });
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
    expect(turnView(state.view).agents.map((a) => [a.start.role, a.state])).toEqual([["main", "done"], ["writer", "done"]]);
  });

  test("a turn that plays reaches the page a step at a time, and the state says it runs", async () => {
    const w = world({ turn: "none" });
    await w.hello();
    const { follower } = await w.follow("chat-mara");
    expect(follower.current).toEqual({ status: "ready", view: null, partial: false });

    expect(w.backend.startTurn("chat-mara")).toBe(true);
    await w.pass(400);
    expect(w.client.state.get()?.running.map((r) => r.chatId)).toEqual(["chat-mara"]);
    // A second reply can't be asked for while one is being written.
    expect(w.backend.startTurn("chat-mara")).toBe(false);

    // The main agent has been told and waits on its model.
    let state = follower.current;
    if (state.status !== "ready" || !state.view) throw new Error("no live view");
    expect(turnView(state.view).agents.map((a) => [a.start.role, a.state, a.activity?.waits])).toEqual([["main", "working", "model"]]);

    await w.pass(3000);
    state = follower.current;
    if (state.status !== "ready" || !state.view) throw new Error("no live view");
    // Its first answer called two tools, neither answered yet.
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
    // The state follows: nothing runs, and first-time setup's last step is done.
    expect(w.client.state.get()?.running).toEqual([]);
    // Its record is kept: the chat's turns gain it, newest first.
    const turns = await w.ask("lah.turns.list", { chatId: "chat-mara", cursor: null, limit: 1 });
    expect(turns.turns[0]?.turn).toBe(state.view.turn);
    expect(turns.total).toBe(7);
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
    const w = world({ turn: "none" });
    const { follower } = await w.follow("chat-mara");
    const viewNow = (): LiveView => {
      const state = follower.current;
      if (state.status !== "ready" || !state.view) throw new Error("no live view");
      return state.view;
    };
    const answers = (agentId: string) => viewNow().events.flatMap((e) => (e.event.kind === "agent_entry" && e.event.agentId === agentId && e.event.entry.kind === "answer" ? [e.event.entry] : []));
    w.backend.startTurn("chat-mara");
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
    const fresh = await w.ask("lah.live.open", { chatId: "chat-mara" });
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
    expect(await w.ask("lah.turn.stop", { chatId: "chat-mara", turn })).toEqual({ stopped: true });
    await w.pass(30_000);
    state = follower.current;
    if (state.status !== "ready" || !state.view) throw new Error("no live view");
    expect(state.view.ended).toMatchObject({ state: "stopped", reason: "You stopped it from the live view." });
    const stopped = turnView(state.view);
    expect(stopped.agents.map((a) => a.state)).toEqual(["cancelled"]);
    expect(feedOf(stopped, { ...NO_FILTER, problems: true })[0]?.items.map((i) => i.kind)).toEqual(["stop"]);
    expect(await w.ask("lah.turn.stop", { chatId: "chat-mara", turn })).toEqual({ stopped: false });
  });

  test("a chat LumiAH doesn't answer has no turn to play", async () => {
    const w = world({ turn: "none" });
    expect(w.backend.startTurn("chat-ilse")).toBe(false);
    expect((await w.ask("lah.live.open", { chatId: "chat-ilse" })).live).toBeNull();
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
  test("each step is done by what the user does, in the state every page holds", async () => {
    const w = world({ scenario: "fresh", turn: "none" });
    await w.hello();
    const done = (): string[] => (w.client.state.get()?.setup.steps ?? []).filter((s) => s.done).map((s) => s.id);
    expect(done()).toEqual([]);
    // No loopback connection yet: a chat can't be pinned to it.
    expect(await outcome(w.ask("lah.chat.set", { chatId: "chat-ilse", on: true }))).toMatchObject({ code: "unavailable" });

    // A key minted before a runtime links is shown, but nothing could put it in a connection.
    const early = await w.ask("lah.key", { op: "mint" });
    expect(early.key).toStartWith("lah_");
    expect(early.connection).toBeNull();
    expect(done()).toEqual(["key"]);

    w.backend.linkRuntime();
    await w.pass(0);
    expect(done()).toEqual(["runtime", "key"]);

    // Minted with a runtime linked, the key goes into the loopback connection, which is made.
    const minted = await w.ask("lah.key", { op: "mint" });
    expect(minted.key).not.toBe(early.key);
    expect(minted.connection).toEqual({ id: "conn-loopback", name: "LumiAH loopback" });
    expect(w.client.state.get()?.key).toMatchObject({ set: true });
    expect(done()).toEqual(["runtime", "key", "connection"]);

    const { chat } = await w.ask("lah.chat.set", { chatId: "chat-ilse", on: true });
    expect(chat).toMatchObject({ on: true, connection: { loopback: true } });
    expect(w.client.state.get()?.chats.map((c) => c.chatId)).toEqual(["chat-ilse"]);
    expect(done()).toEqual(["runtime", "key", "connection", "chat"]);

    expect(w.backend.startTurn("chat-ilse")).toBe(true);
    await w.pass(60_000);
    expect(done()).toEqual(["runtime", "key", "connection", "chat", "reply"]);

    // Switched off, the chat goes back to the connection it had and leaves the list.
    const off = await w.ask("lah.chat.set", { chatId: "chat-ilse", on: false });
    expect(off.chat).toMatchObject({ on: false, connection: { loopback: false } });
    expect(w.client.state.get()?.chats).toEqual([]);
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
    expect(one.total).toBe(6);
    const two = await w.ask("lah.turns.list", { chatId: "chat-mara", cursor: one.next, limit: 4 });
    expect(two.turns.map((t) => t.index)).toEqual([35, 31]);
    expect(two.next).toBeNull();
    // A turn whose transcript wasn't kept says so by having none to open.
    expect(two.turns[0]?.transcript).toBeNull();
  });
});
