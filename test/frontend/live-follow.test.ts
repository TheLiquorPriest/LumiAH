// A page following a chat's live view: what it shows as the backend's reads and pushes arrive, in
// order, out of order, or not at all.

import { describe, expect, test } from "bun:test";
import { finishedTurn } from "../../dev/preview/fixtures";
import { LiveFollower, type LiveReads, type LiveState } from "../../src/extension/frontend/live-follow";
import type { LiveDelta, LiveEvent, LivePartial, LiveView } from "../../src/shared/ui";

const T0 = Date.UTC(2026, 10, 10, 9, 0, 0);
const ALL = finishedTurn("chat-mara", "turn-1", T0).events;

function view(events: LiveEvent[], turn = "turn-1", partials: LivePartial[] = []): LiveView {
  return { stream: "chat-mara", chatId: "chat-mara", turn, kind: "new", messageId: null, startedAt: T0, ended: null, events, partials };
}

/** The backend's side of a follower, driven by hand: what each read answers, and what was asked. */
function backend(options: { open: () => { live: LiveView | null; next: number | null }; page?: number; fail?: { open?: boolean; events?: boolean } }) {
  const asked: string[] = [];
  const states: LiveState[] = [];
  const fail = { open: false, events: false, ...options.fail };
  const reads: LiveReads = {
    open: async () => {
      asked.push("open");
      if (fail.open) throw new Error("The extension didn't answer.");
      return options.open();
    },
    events: async (turn, from) => {
      asked.push(`events ${turn} ${from}`);
      if (fail.events) throw new Error("The extension didn't answer.");
      const rest = ALL.filter((e) => e.seq >= from);
      const page = rest.slice(0, options.page ?? rest.length);
      return { events: page, next: page.length < rest.length ? (page.at(-1)?.seq ?? from) + 1 : null };
    },
  };
  const follower = new LiveFollower(reads, (state) => states.push(state));
  return { follower, asked, states, fail };
}

const seqs = (state: LiveState): number[] => (state.status === "ready" && state.view ? state.view.events.map((e) => e.seq) : []);
/** Lets every read under way, and what follows it, settle. */
const settle = async (): Promise<void> => {
  for (let i = 0; i < 20; i += 1) await Promise.resolve();
};

describe("opening a live view", () => {
  test("a chat with no turn yet shows none", async () => {
    const b = backend({ open: () => ({ live: null, next: null }) });
    await b.follower.start();
    expect(b.follower.current).toEqual({ status: "ready", view: null, partial: false });
  });

  test("a long turn is read a page at a time until it is whole", async () => {
    const b = backend({ open: () => ({ live: view(ALL.slice(0, 5)), next: 6 }), page: 7 });
    await b.follower.start();
    expect(seqs(b.follower.current)).toEqual(ALL.map((e) => e.seq));
    expect(b.asked).toEqual(["open", "events turn-1 6", "events turn-1 13", "events turn-1 20"]);
    // The page saw the turn grow as each part came, never a part out of place.
    expect(b.states.map((s) => seqs(s).length)).toEqual([5, 12, 19, ALL.length]);
  });

  test("a view that can't be opened says so, and opens once it is tried again", async () => {
    const b = backend({ open: () => ({ live: view(ALL.slice(0, 3)), next: null }), fail: { open: true } });
    await b.follower.start();
    expect(b.follower.current).toEqual({ status: "failed", message: "The extension didn't answer." });
    b.fail.open = false;
    await b.follower.refresh();
    expect(seqs(b.follower.current)).toEqual([1, 2, 3]);
  });

  test("what couldn't be read of a turn is said, with what was read still shown", async () => {
    const b = backend({ open: () => ({ live: view(ALL.slice(0, 4)), next: 5 }), fail: { events: true } });
    await b.follower.start();
    expect(b.follower.current).toMatchObject({ status: "ready", partial: true });
    expect(seqs(b.follower.current)).toEqual([1, 2, 3, 4]);
  });
});

describe("following pushes", () => {
  test("events join the turn in order as they are pushed", async () => {
    const b = backend({ open: () => ({ live: view(ALL.slice(0, 3)), next: null }) });
    await b.follower.start();
    b.follower.hear({ turn: "turn-1", events: ALL.slice(3, 5), ended: null });
    b.follower.hear({ turn: "turn-1", events: ALL.slice(5, 6), ended: null });
    await settle();
    expect(seqs(b.follower.current)).toEqual([1, 2, 3, 4, 5, 6]);
    expect(b.asked).toEqual(["open"]);
  });

  test("a push that repeats what the page holds changes nothing", async () => {
    const b = backend({ open: () => ({ live: view(ALL.slice(0, 5)), next: null }) });
    await b.follower.start();
    b.follower.hear({ turn: "turn-1", events: ALL.slice(2, 5), ended: null });
    await settle();
    expect(seqs(b.follower.current)).toEqual([1, 2, 3, 4, 5]);
  });

  test("a lost push leaves a gap, which the page reads and then goes on", async () => {
    const b = backend({ open: () => ({ live: view(ALL.slice(0, 3)), next: null }) });
    await b.follower.start();
    // Events 4 and 5 were pushed and lost; 6 arrives.
    b.follower.hear({ turn: "turn-1", events: ALL.slice(5, 6), ended: null });
    await settle();
    expect(b.asked).toEqual(["open", "events turn-1 4"]);
    expect(seqs(b.follower.current)).toEqual(ALL.map((e) => e.seq));
  });

  test("pushes heard while a read is under way wait for it, then join in order", async () => {
    let release: (value: { live: LiveView | null; next: number | null }) => void = () => {};
    const states: LiveState[] = [];
    const follower = new LiveFollower(
      {
        open: () =>
          // The executor form: the test holds the read open until it lets it go.
          new Promise((resolve) => {
            release = resolve;
          }),
        events: async () => ({ events: [], next: null }),
      },
      (state) => states.push(state),
    );
    const opening = follower.start();
    follower.hear({ turn: "turn-1", events: ALL.slice(3, 4), ended: null });
    follower.hear({ turn: "turn-1", events: ALL.slice(4, 5), ended: null });
    expect(follower.current.status).toBe("opening");
    release({ live: view(ALL.slice(0, 3)), next: null });
    await opening;
    await settle();
    expect(seqs(follower.current)).toEqual([1, 2, 3, 4, 5]);
  });

  test("a new turn's view takes the place of the one before", async () => {
    const b = backend({ open: () => ({ live: view(ALL.slice(0, 3)), next: null }) });
    await b.follower.start();
    b.follower.hear({ view: view(ALL.slice(0, 1), "turn-2") });
    await settle();
    expect(b.follower.current).toMatchObject({ status: "ready", view: { turn: "turn-2" } });
    expect(seqs(b.follower.current)).toEqual([1]);
  });

  test("events for a turn the page doesn't hold make it read the view again", async () => {
    let turn = "turn-1";
    const b = backend({ open: () => ({ live: view(ALL.slice(0, 2), turn), next: null }) });
    await b.follower.start();
    turn = "turn-2";
    b.follower.hear({ turn: "turn-2", events: ALL.slice(2, 3), ended: null });
    await settle();
    expect(b.asked.filter((a) => a === "open").length).toBe(2);
    expect(b.follower.current).toMatchObject({ status: "ready", view: { turn: "turn-2" } });
    expect(seqs(b.follower.current)).toEqual([1, 2, 3]);
  });

  test("a turn's end reaches the page with its last events", async () => {
    const b = backend({ open: () => ({ live: view(ALL.slice(0, ALL.length - 1)), next: null }) });
    await b.follower.start();
    b.follower.hear({ turn: "turn-1", events: ALL.slice(-1), ended: { state: "done", at: T0 + 20_000 } });
    await settle();
    expect(b.follower.current).toMatchObject({ status: "ready", view: { ended: { state: "done" } } });
  });

  test("reading the view again after the page was away keeps what later pushes had brought", async () => {
    // The first page of a re-read holds less than the page already has.
    const b = backend({ open: () => ({ live: view(ALL.slice(0, 4)), next: 5 }), page: 100 });
    await b.follower.start();
    expect(seqs(b.follower.current).length).toBe(ALL.length);
    const before = b.states.length;
    await b.follower.refresh();
    expect(seqs(b.follower.current).length).toBe(ALL.length);
    // Nothing the page showed was taken away on the way.
    expect(b.states.slice(before).every((s) => seqs(s).length === ALL.length)).toBe(true);
  });

  test("a follower that was stopped hears nothing more", async () => {
    const b = backend({ open: () => ({ live: view(ALL.slice(0, 3)), next: null }) });
    await b.follower.start();
    const before = b.states.length;
    b.follower.stop();
    b.follower.hear({ turn: "turn-1", events: ALL.slice(3, 4), ended: null });
    await settle();
    expect(b.states.length).toBe(before);
  });
});

describe("following a call in flight", () => {
  const delta = (text: string, before: number): { delta: LiveDelta } => ({ delta: { turn: "turn-1", agentId: "main-1", call: 1, text, before: { text: before, reasoning: 0 }, at: T0 + 900 } });
  const said = (state: LiveState): string => (state.status === "ready" && state.view ? (state.view.partials[0]?.text ?? "") : "");

  test("what a call sends shows as it arrives, and its answer takes its place", async () => {
    // Four events in: the main agent has been told, and its first call is in flight.
    const b = backend({ open: () => ({ live: view(ALL.slice(0, 4)), next: null }) });
    await b.follower.start();
    b.follower.hear(delta("I have ", 0));
    b.follower.hear(delta("what the reply needs.", 7));
    await settle();
    expect(said(b.follower.current)).toBe("I have what the reply needs.");
    // The page was told of each as it came.
    expect(b.states.map(said).filter((t) => t !== "")).toEqual(["I have ", "I have what the reply needs."]);
    b.follower.hear({ turn: "turn-1", events: ALL.slice(4, 6), ended: null });
    await settle();
    expect(said(b.follower.current)).toBe("");
    expect(seqs(b.follower.current)).toEqual([1, 2, 3, 4, 5, 6]);
    expect(b.asked).toEqual(["open"]);
  });

  test("a page that opens mid-call shows what the call had sent, and goes on from there", async () => {
    const b = backend({ open: () => ({ live: view(ALL.slice(0, 4), "turn-1", [{ agentId: "main-1", call: 1, text: "I have ", reasoning: "", at: T0 }]), next: null }) });
    await b.follower.start();
    expect(said(b.follower.current)).toBe("I have ");
    b.follower.hear(delta("what the reply needs.", 7));
    await settle();
    expect(said(b.follower.current)).toBe("I have what the reply needs.");
  });

  test("deltas heard while the view is being read are not shown twice: the read already holds the earlier ones", async () => {
    let release: (value: { live: LiveView | null; next: number | null }) => void = () => {};
    const states: LiveState[] = [];
    const follower = new LiveFollower(
      {
        open: () =>
          // The executor form: the test holds the read open until it lets it go.
          new Promise((resolve) => {
            release = resolve;
          }),
        events: async () => ({ events: [], next: null }),
      },
      (state) => states.push(state),
    );
    const opening = follower.start();
    // Two deltas arrive before the read answers. The backend took its snapshot between them.
    follower.hear(delta("I have ", 0));
    follower.hear(delta("what the ", 7));
    release({ live: view(ALL.slice(0, 4), "turn-1", [{ agentId: "main-1", call: 1, text: "I have ", reasoning: "", at: T0 }]), next: null });
    await opening;
    await settle();
    expect(said(follower.current)).toBe("I have what the ");
    follower.hear(delta("reply needs.", 16));
    await settle();
    expect(said(follower.current)).toBe("I have what the reply needs.");
  });

  test("a delta that never came is mended by reading the view, not by guessing", async () => {
    let sent = "I have ";
    const b = backend({ open: () => ({ live: view(ALL.slice(0, 4), "turn-1", [{ agentId: "main-1", call: 1, text: sent, reasoning: "", at: T0 }]), next: null }) });
    await b.follower.start();
    // "what the " was sent and lost; the next delta doesn't join what the page holds.
    sent = "I have what the reply ";
    b.follower.hear(delta("reply ", 16));
    await settle();
    expect(b.asked).toEqual(["open", "open"]);
    expect(said(b.follower.current)).toBe("I have what the reply ");
    b.follower.hear(delta("needs.", 22));
    await settle();
    expect(said(b.follower.current)).toBe("I have what the reply needs.");
    expect(b.asked).toEqual(["open", "open"]);
  });
});
