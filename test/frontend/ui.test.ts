// The messages between a page and the backend (`src/shared/ui.ts`): how a page follows the live
// view and the state from what it hears, and what the backend takes for a request.

import { describe, expect, test } from "bun:test";
import { finishedTurn } from "../../dev/preview/fixtures";
import { MockBackend } from "../../dev/preview/mock-backend";
import { sampleSettings } from "../../dev/preview/sections";
import { chatAnswered, followDelta, followLive, followState, type LiveDelta, type LiveEvent, type LivePartial, type LiveView, startLine, UI_VERSION, type UiRequests, type UiRequestType, uiMessageOf, uiRequestOf, URL_SLOT } from "../../src/shared/ui";

const T0 = Date.UTC(2026, 10, 10, 9, 0, 0);
const EVENTS = finishedTurn("chat-mara", "turn-1", T0).events;

const view = (upTo: number, turn = "turn-1", partials: LivePartial[] = []): LiveView => ({ chatId: "chat-mara", turn, kind: "new", messageId: null, startedAt: T0, ended: null, events: EVENTS.slice(0, upTo), partials });

describe("following a live view", () => {
  test("a new turn's view takes the place of whatever the page held", () => {
    expect(followLive(null, { view: view(2) })).toEqual(view(2));
    expect(followLive(view(9), { view: view(1, "turn-2") })).toEqual(view(1, "turn-2"));
  });

  test("events for the turn the page holds join it in order", () => {
    const next = followLive(view(3), { turn: "turn-1", events: EVENTS.slice(3, 6), ended: null });
    expect(next).toEqual(view(6));
  });

  test("events the page holds already are left out, so hearing one twice shows it once", () => {
    const next = followLive(view(5), { turn: "turn-1", events: EVENTS.slice(2, 7), ended: null });
    expect(next).toEqual(view(7));
    const held = view(5);
    const same = followLive(held, { turn: "turn-1", events: EVENTS.slice(0, 5), ended: null });
    expect("events" in same && same.events).toBe(held.events);
  });

  test("events after a gap say where to read from", () => {
    expect(followLive(view(3), { turn: "turn-1", events: EVENTS.slice(5, 7), ended: null })).toEqual({ gap: "events", from: 4 });
  });

  test("events for a turn the page doesn't hold tell it to read the view", () => {
    expect(followLive(null, { turn: "turn-1", events: EVENTS.slice(0, 1), ended: null })).toEqual({ gap: "view" });
    expect(followLive(view(3, "turn-0"), { turn: "turn-1", events: EVENTS.slice(0, 1), ended: null })).toEqual({ gap: "view" });
  });

  test("a turn's end stays once heard", () => {
    const ended = followLive(view(3), { turn: "turn-1", events: EVENTS.slice(3, 4), ended: { state: "stopped", at: T0 + 1000 } });
    expect(ended).toMatchObject({ ended: { state: "stopped" } });
    const after = followLive(ended as LiveView, { turn: "turn-1", events: [], ended: null });
    expect(after).toMatchObject({ ended: { state: "stopped" } });
  });

  test("an older read of the same turn takes nothing away, but its end counts", () => {
    const held = view(8);
    expect(followLive(held, { view: view(4) })).toBe(held);
    expect(followLive(held, { view: { ...view(4), ended: { state: "lost", at: T0 + 5 } } })).toMatchObject({ ended: { state: "lost" }, events: held.events });
  });
});

describe("following a call in flight", () => {
  /** The main agent's delta: what arrived, after `before` characters of its text and its thinking. */
  const delta = (over: Partial<LiveDelta> & { before: LiveDelta["before"] }): LiveDelta => ({ turn: "turn-1", agentId: "main-1", call: 1, at: T0 + 900, ...over });
  const held = (v: LiveView | { gap: string }): LiveView => {
    if ("gap" in v) throw new Error(`a gap where a view was expected: ${v.gap}`);
    return v;
  };

  test("what arrives adds up, its thinking and its text apart", () => {
    // Four events in: the main agent has been told and its first call is in flight.
    const start = view(4);
    let v = held(followDelta(start, delta({ reasoning: "Mara asks ", before: { text: 0, reasoning: 0 } })));
    v = held(followDelta(v, delta({ reasoning: "who keeps the key.", before: { text: 0, reasoning: 10 } })));
    v = held(followDelta(v, delta({ text: "I have ", before: { text: 0, reasoning: 28 } })));
    v = held(followDelta(v, delta({ text: "what the reply needs.", before: { text: 7, reasoning: 28 } })));
    expect(v.partials).toEqual([{ agentId: "main-1", call: 1, reasoning: "Mara asks who keeps the key.", text: "I have what the reply needs.", at: T0 + 900 }]);
    // A delta changes nothing else of the turn: its events are the very ones the view held.
    expect(v.events).toBe(start.events);
  });

  test("a delta the view already holds changes nothing, so one heard twice shows once", () => {
    const v = view(4, "turn-1", [{ agentId: "main-1", call: 1, text: "I have what", reasoning: "Mara asks.", at: T0 }]);
    // Sent before the view was read, heard after: the view holds it already.
    expect(followDelta(v, delta({ reasoning: "asks.", before: { text: 0, reasoning: 5 } }))).toBe(v);
    expect(followDelta(v, delta({ text: "I have ", before: { text: 0, reasoning: 10 } }))).toBe(v);
    // The next one joins on.
    expect(held(followDelta(v, delta({ text: " the reply needs.", before: { text: 11, reasoning: 10 } }))).partials[0]?.text).toBe("I have what the reply needs.");
  });

  test("a delta after one that never came makes the page read the view again", () => {
    const v = view(4, "turn-1", [{ agentId: "main-1", call: 1, text: "I have", reasoning: "", at: T0 }]);
    expect(followDelta(v, delta({ text: " needs.", before: { text: 21, reasoning: 0 } }))).toEqual({ gap: "view" });
    // A call's first delta lost: the next one finds nothing to join.
    expect(followDelta(view(4), delta({ reasoning: "who keeps", before: { text: 0, reasoning: 10 } }))).toEqual({ gap: "view" });
    expect(followDelta(null, delta({ text: "I", before: { text: 0, reasoning: 0 } }))).toEqual({ gap: "view" });
    expect(followDelta(view(4, "turn-0"), delta({ text: "I", before: { text: 0, reasoning: 0 } }))).toEqual({ gap: "view" });
  });

  test("the call's answer takes the partial's place when its entry lands", () => {
    const v = view(4, "turn-1", [{ agentId: "main-1", call: 1, text: "", reasoning: "Mara asks who keeps the key.", at: T0 }]);
    // Event 5 is the main agent's first answer.
    const next = held(followLive(v, { turn: "turn-1", events: EVENTS.slice(4, 6), ended: null }));
    expect(next.partials).toEqual([]);
    expect(next.events.length).toBe(6);
  });

  test("a tool's result leaves a call in flight alone; a turn's end leaves none", () => {
    const writer: LivePartial = { agentId: "writer-1", call: 1, text: "Joss was already", reasoning: "", at: T0 };
    // Events 7 to 9 are the main agent's tool results.
    const results = held(followLive(view(6, "turn-1", [writer]), { turn: "turn-1", events: EVENTS.slice(6, 9), ended: null }));
    expect(results.partials).toEqual([writer]);
    const ended = held(followLive(view(6, "turn-1", [writer]), { turn: "turn-1", events: [], ended: { state: "stopped", at: T0 + 9000 } }));
    expect(ended.partials).toEqual([]);
    // And a turn that has ended takes no more.
    expect(followDelta(ended, { ...delta({ text: " reaching", before: { text: 16, reasoning: 0 } }), agentId: "writer-1" })).toBe(ended);
  });

  test("a call that failed in passing drops what it had sent, and its next try starts anew under the same number", () => {
    const retry: LiveEvent = { turn: "turn-1", chatId: "chat-mara", seq: 5, event: { kind: "agent_entry", agentId: "main-1", entry: { kind: "retry", reason: "The connection closed.", attempt: 1, of: 2, waitMs: 2000, ms: 900, at: T0 + 1000 } } };
    const v = view(4, "turn-1", [{ agentId: "main-1", call: 1, text: "", reasoning: "Mara asks who", at: T0 }]);
    const after = held(followLive(v, { turn: "turn-1", events: [retry], ended: null }));
    expect(after.partials).toEqual([]);
    expect(held(followDelta(after, delta({ reasoning: "Mara ", before: { text: 0, reasoning: 0 } }))).partials).toEqual([{ agentId: "main-1", call: 1, text: "", reasoning: "Mara ", at: T0 + 900 }]);
  });

  test("an agent's later call starts a partial of its own, and a late delta of a call already answered is passed over", () => {
    // Nine events in: the first answer and its results; the second call starts.
    const second = held(followDelta(view(9), delta({ call: 2, reasoning: "The id ", before: { text: 0, reasoning: 0 } })));
    expect(second.partials).toEqual([{ agentId: "main-1", call: 2, text: "", reasoning: "The id ", at: T0 + 900 }]);
    const stale = view(9);
    expect(followDelta(stale, delta({ call: 1, reasoning: "key.", before: { text: 0, reasoning: 24 } }))).toBe(stale);
    expect(followDelta(second, delta({ call: 1, reasoning: "key.", before: { text: 0, reasoning: 24 } }))).toBe(second);
  });

  test("a view read while a call is in flight brings what the call has sent, and never takes away what the page holds more of", () => {
    const page = view(4, "turn-1", [{ agentId: "main-1", call: 1, text: "", reasoning: "Mara asks who keeps", at: T0 }]);
    // A page that opens mid-call gets the partial with the view.
    expect(held(followLive(null, { view: page })).partials[0]?.reasoning).toBe("Mara asks who keeps");
    // A read that is older than what the page has since heard: the page's own stands.
    const older = view(4, "turn-1", [{ agentId: "main-1", call: 1, text: "", reasoning: "Mara asks", at: T0 }]);
    expect(followLive(page, { view: older })).toBe(page);
    // A read that is newer: its partial is taken.
    const newer = view(4, "turn-1", [{ agentId: "main-1", call: 1, text: "I", reasoning: "Mara asks who keeps the key.", at: T0 }]);
    expect(held(followLive(page, { view: newer })).partials[0]?.reasoning).toBe("Mara asks who keeps the key.");
  });
});

describe("following the state", () => {
  const settled = sampleSettings();
  const state = new MockBackend(() => {}, { scenario: "ready", turn: "none", sections: settled.sections, texts: settled.texts, delay: 0, page: 50, fail: new Set(), now: () => T0, later: () => () => {} }).state;

  test("the next push replaces the parts it carries, each whole", () => {
    const next = followState(state, { rev: state.rev + 1, patch: { running: [{ chatId: "chat-mara", turn: "t", kind: "swipe", startedAt: T0 }] } });
    expect(next?.rev).toBe(state.rev + 1);
    expect(next?.running).toHaveLength(1);
    expect(next?.settings).toBe(state.settings);
  });

  test("a push that isn't the next one can't be followed", () => {
    expect(followState(state, { rev: state.rev + 2, patch: {} })).toBeNull();
    expect(followState(state, { rev: state.rev, patch: {} })).toBeNull();
    // A backend that started again counts from the start.
    expect(followState(state, { rev: 1, patch: {} })).toBeNull();
  });
});

describe("what the backend takes for a request", () => {
  /** One well-formed body per request: a request added to the contract must be added here to compile. */
  const BODIES: { [K in UiRequestType]: UiRequests[K]["body"] } = {
    "lah.hello": {},
    "lah.chat.get": { chatId: "chat-mara" },
    "lah.chat.set": { chatId: "chat-mara", on: true },
    "lah.live.open": { chatId: "chat-mara" },
    "lah.live.events": { chatId: "chat-mara", turn: "turn-1", from: 1 },
    "lah.live.close": { chatId: "chat-mara" },
    "lah.turn.stop": { chatId: "chat-mara", turn: "turn-1" },
    "lah.turns.list": { chatId: "chat-mara", cursor: null, limit: 20 },
    "lah.transcript.get": { chatId: "chat-mara", transcript: "t".repeat(64), from: 1 },
    "lah.prompt.get": { prompt: "p".repeat(64) },
    "lah.blob.get": { hash: "b".repeat(64) },
    "lah.session.rollback": { chatId: "chat-mara", messageId: "msg-1", swipe: 0 },
    "lah.settings.set": { set: [{ path: ["core", "reply", "writer"], value: null }], reset: [[]] },
    "lah.models.list": { connectionId: null },
    "lah.text.set": { id: "main.system", text: "" },
    "lah.text.reset": { id: "main.system" },
    "lah.key": { op: "mint" },
    "lah.relay": { op: "rotate", relay: "relay-1" },
  };
  const envelope = (type: string, body: object, reqId: unknown = "r1"): Record<string, unknown> => ({ lah: UI_VERSION, type, reqId, ...body });

  test("every request of the contract, well formed, is taken", () => {
    for (const [type, body] of Object.entries(BODIES)) {
      // Read as it was sent: the envelope and every field of the body, nothing added or dropped.
      const read: unknown = uiRequestOf(envelope(type, body));
      expect(read).toEqual({ request: envelope(type, body) });
    }
  });

  test("a message that isn't LumiAH's is not answered at all", () => {
    expect(uiRequestOf({ type: "lre.hello", reqId: "r1" })).toBeNull();
    expect(uiRequestOf({ lah: UI_VERSION, type: "other.hello", reqId: "r1" })).toBeNull();
    expect(uiRequestOf("lah.hello")).toBeNull();
    expect(uiRequestOf(null)).toBeNull();
  });

  test("a page of another version is told to reload", () => {
    const read = uiRequestOf({ lah: UI_VERSION + 1, type: "lah.hello", reqId: "r1" });
    expect(read).toEqual({ malformed: expect.stringContaining("reload the page"), reqId: "r1" });
  });

  test("a request without an id, or one the contract doesn't have, is refused", () => {
    expect(uiRequestOf({ lah: UI_VERSION, type: "lah.hello" })).toEqual({ malformed: "The request has no reqId.", reqId: null });
    expect(uiRequestOf(envelope("lah.everything.delete", {}))).toEqual({ malformed: "There is no request lah.everything.delete.", reqId: "r1" });
    // A name every object has is no request either.
    expect(uiRequestOf(envelope("lah.constructor", {}))).toMatchObject({ malformed: expect.any(String) });
  });

  test("a request with a field missing or of the wrong kind is refused, by name", () => {
    const bad: [UiRequestType, object][] = [
      ["lah.chat.get", {}],
      ["lah.chat.set", { chatId: "chat-mara", on: "yes" }],
      ["lah.live.events", { chatId: "chat-mara", turn: "turn-1", from: 0 }],
      ["lah.turns.list", { chatId: "chat-mara", cursor: null, limit: 0 }],
      ["lah.turns.list", { chatId: "chat-mara", limit: 20 }],
      ["lah.session.rollback", { chatId: "chat-mara", messageId: "msg-1", swipe: -1 }],
      ["lah.settings.set", { set: [{ path: ["a"] }], reset: [] }],
      ["lah.settings.set", { set: [], reset: [["a", 1]] }],
      ["lah.models.list", {}],
      ["lah.key", { op: "show" }],
      ["lah.relay", { op: "rotate" }],
      ["lah.blob.get", { hash: "x".repeat(257) }],
      ["lah.text.set", { id: "main.system" }],
    ];
    for (const [type, body] of bad) expect(uiRequestOf(envelope(type, body))).toEqual({ malformed: `The request ${type} is malformed.`, reqId: "r1" });
  });

  test("a setting may be set to null: null is a value, not a missing one", () => {
    expect(uiRequestOf(envelope("lah.settings.set", { set: [{ path: ["a"], value: null }], reset: [] }))).toHaveProperty("request");
  });

  test("a page reads only LumiAH's own messages of its version", () => {
    expect(uiMessageOf({ lah: UI_VERSION, type: "lah.state", rev: 2, patch: {} })).not.toBeNull();
    expect(uiMessageOf({ lah: UI_VERSION, type: "lah.hello", reqId: "r1" })).toBeNull();
    expect(uiMessageOf({ lah: UI_VERSION + 1, type: "lah.state", rev: 2, patch: {} })).toBeNull();
    expect(uiMessageOf({ type: "lah.state" })).toBeNull();
  });
});

describe("what a page works out for itself", () => {
  test("a start line gets the address the page was opened at", () => {
    const line = `bunx lumiah link ${URL_SLOT} --code MARA-1234`;
    expect(startLine(line, "https://lumi.example:7860")).toBe("bunx lumiah link https://lumi.example:7860 --code MARA-1234");
    expect(startLine(line, "http://[::1]:7860")).toBe("bunx lumiah link http://[::1]:7860 --code MARA-1234");
  });

  test("an address a shell would read as something else never reaches the line", () => {
    for (const origin of ["null", "", "https://lumi.example/$(reboot)", "https://lumi.example; rm -rf ~", "file://"]) {
      expect(startLine(`link ${URL_SLOT}`, origin)).toBe("link <the address you open Lumiverse at>");
    }
  });

  test("a chat is answered by LumiAH while its connection is the loopback, whatever the switch last said", () => {
    const chat = { chatId: "chat-mara", name: "Mara at the harbour", on: true, since: 1 };
    expect(chatAnswered({ ...chat, connection: { id: "c1", name: "LumiAH loopback", loopback: true } })).toBe(true);
    expect(chatAnswered({ ...chat, connection: { id: "c2", name: "Deepseek", loopback: false } })).toBe(false);
    expect(chatAnswered({ ...chat, connection: null })).toBe(false);
  });
});
