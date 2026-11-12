// The messages between a page and the backend (`src/shared/ui.ts`): how a page follows the live
// view and the state from what it hears, and what the backend takes for a request.

import { describe, expect, test } from "bun:test";
import { finishedTurn } from "../../dev/preview/fixtures";
import { MockBackend } from "../../dev/preview/mock-backend";
import { sampleSettings } from "../../dev/preview/sections";
import { chatAnswered, type ChatView, citationsOf, followDelta, followLive, followState, type LiveDelta, type LiveEvent, type LivePartial, type LiveView, loreChangesOf, promptHeldOf, replyDid, startLine, type TraceEvent, type TranscriptEntry, UI_VERSION, type UiRequestType, uiMessageOf, uiRequestOf, URL_SLOT } from "../../src/shared/ui";
import { BODIES } from "./bodies";

const T0 = Date.UTC(2026, 10, 10, 9, 0, 0);
const EVENTS = finishedTurn("chat-mara", "turn-1", T0).events;

const view = (upTo: number, turn = "turn-1", partials: LivePartial[] = []): LiveView => ({ stream: "chat-mara", chatId: "chat-mara", turn, kind: "new", messageId: null, startedAt: T0, ended: null, events: EVENTS.slice(0, upTo), partials });

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
    const next = followState(state, { rev: state.rev + 1, patch: { running: [{ stream: "chat-mara", chatId: "chat-mara", turn: "t", kind: "swipe", startedAt: T0, paused: false }] } });
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
      ["lah.hello", { active: 5 }],
      ["lah.job.start", { chatId: "chat-mara", agent: "archivist", task: "Learn the story so far.", when: "now", allowance: { tokensIn: -1 } }],
      ["lah.job.grant", { id: "job-1" }],
      ["lah.job.grant", { id: "job-1", allowance: { wallMs: "an hour" } }],
      ["lah.job.resume", {}],
      ["lah.session.summarize", {}],
      ["lah.chat.get", {}],
      ["lah.chat.set", { chatId: "chat-mara", on: "yes" }],
      ["lah.chat.takeover", { chatId: "" }],
      ["lah.chat.takeover", {}],
      ["lah.live.events", { stream: "chat-mara", turn: "turn-1", from: 0 }],
      ["lah.live.open", { chatId: "chat-mara" }],
      ["lah.turn.say", { stream: "chat-mara", turn: "turn-1", text: "   " }],
      ["lah.approval.answer", { id: "held-1", answer: { decision: "refuse" } }],
      ["lah.approval.answer", { id: "held-1", decision: "once" }],
      ["lah.approvals.kept", {}],
      ["lah.approval.forget", { chatId: "chat-mara" }],
      ["lah.approval.forget", { chatId: null, tool: "workspace_write" }],
      ["lah.ws.list", { chatId: null, area: "chat" }],
      ["lah.ws.list", { chatId: "chat-mara", area: "everything" }],
      ["lah.ws.read", { chatId: null, area: "user", path: "a.md", version: 3 }],
      ["lah.ws.write", { chatId: null, area: "user", path: "", text: "x", base: null }],
      ["lah.ws.write", { chatId: null, area: "user", path: "a.md", text: "x" }],
      ["lah.ws.move", { chatId: null, area: "user", from: "a.md", to: "b.md", base: null }],
      ["lah.ws.pin", { chatId: null, area: "user", path: "a.md", on: true }],
      ["lah.guidance.set", { chatId: null, level: "chat", text: "x", base: null }],
      ["lah.agent.save", { agent: { id: "a", name: "A", description: "" } }],
      ["lah.def.switch", { kind: "page", id: "live", off: true }],
      ["lah.tool.approval", { name: "workspace_write", approval: "never" }],
      ["lah.tier.approval", { tier: "write", approval: null }],
      ["lah.jobs.set", {}],
      ["lah.job.start", { chatId: "chat-mara", agent: "archivist", task: "", when: "now" }],
      ["lah.job.start", { chatId: "chat-mara", agent: "archivist", task: "Tidy the notes.", when: "tomorrow" }],
      ["lah.side.send", { session: "side-notes", text: "" }],
      ["lah.spend.get", { days: 0 }],
      ["lah.spend.get", { days: 30, timeZone: 60 }],
      ["lah.turns.list", { chatId: "chat-mara", cursor: null, limit: 0 }],
      ["lah.turns.list", { chatId: "chat-mara", limit: 20 }],
      ["lah.session.rollback", { chatId: "chat-mara", messageId: "msg-1", swipe: -1 }],
      ["lah.settings.set", { set: [{ path: ["a"] }], reset: [] }],
      ["lah.settings.set", { set: [], reset: [["a", 1]] }],
      // A request about a runtime's connections names the runtime by an id, or none; a key, a pasted code and a header's value are text a user could have pasted, and no more.
      ["lah.connections.list", { relay: 1 }],
      ["lah.connections.list", { relay: "" }],
      ["lah.connections.save", { connection: { name: "Groq", provider: "groq", auth: "token" } }],
      ["lah.connections.save", { connection: { name: "Groq", provider: "groq", auth: "key", effort: "huge" } }],
      ["lah.connections.save", { connection: { name: "Groq", provider: "groq", auth: "key" }, key: "" }],
      ["lah.connections.save", { connection: { name: "Groq", provider: "groq", auth: "key" }, key: "k".repeat(8193) }],
      ["lah.connections.save", { connection: { name: "Groq", provider: "groq", auth: "key" }, create: true }],
      ["lah.connections.save", { connection: { name: "Proxy", provider: "openai-compatible", auth: "key", headers: { "X-Proxy-Key": "" } } }],
      ["lah.connections.save", { connection: { name: "Proxy", provider: "openai-compatible", auth: "key", headers: { "X-Proxy-Key": 7 } } }],
      ["lah.connections.save", { relay: "", connection: { name: "Groq", provider: "groq", auth: "key" } }],
      ["lah.connections.remove", { relay: "relay-1" }],
      ["lah.connections.default", {}],
      ["lah.connections.models", {}],
      ["lah.connections.models", { connectionId: "conn-deepseek", provider: "deepseek" }],
      ["lah.signin.start", { provider: "google" }],
      ["lah.signin.finish", { flow: "flow-1", code: "" }],
      ["lah.signin.finish", { flow: "flow-1", code: "c".repeat(8193) }],
      ["lah.signin.cancel", { relay: "relay-1" }],
      ["lah.signin.out", { relay: 7, provider: "openai" }],
      ["lah.signin.state", {}],
      ["lah.key", { op: "show" }],
      ["lah.relay", { op: "rotate" }],
      ["lah.blob.get", { hash: "x".repeat(257) }],
      ["lah.text.set", { id: "main.system" }],
      ["lah.job.start", { chatId: "chat-mara", agent: "main", task: "Learn this story.", when: "now", story: false }],
      // Home's read names a chat or none; the pages of a chat's lore and chronicle always name one.
      ["lah.home.get", {}],
      ["lah.home.get", { chatId: 7 }],
      ["lah.lore.get", { chatId: null }],
      ["lah.lore.entry", { chatId: "chat-mara" }],
      ["lah.lore.search", { chatId: "chat-mara", queries: [] }],
      ["lah.lore.search", { chatId: "chat-mara", queries: ["night key", "  "] }],
      ["lah.lore.search", { chatId: "chat-mara", queries: "night key" }],
      ["lah.lore.search", { chatId: "chat-mara", queries: ["night key"], limit: 0 }],
      ["lah.lore.embed", { chatId: "chat-mara" }],
      ["lah.lore.embed", { chatId: "chat-mara", start: "yes" }],
      ["lah.chronicle.get", {}],
      ["lah.chronicle.cited", { chatId: "chat-mara" }],
      ["lah.chronicle.cited", { chatId: "chat-mara", citations: [] }],
      ["lah.chronicle.cited", { chatId: "chat-mara", citations: ["[#38 a3f9c27e]", ""] }],
      ["lah.story.get", { chatId: "" }],
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

  test("a chat is answered where it generates on a loopback connection, whatever the switch last said", () => {
    const chat = { chatId: "chat-mara", name: "Mara at the harbour", since: 1 };
    const loopback = { id: "c1", name: "LumiAH loopback", loopback: true };
    const own = { id: "c2", name: "Deepseek", loopback: false };
    const answered = (over: Pick<ChatView, "on" | "connection">): boolean => chatAnswered({ ...chat, ...over });
    // Its replies reach the runtime through the loopback; on any other connection, or none, they don't reach LumiAH.
    expect(answered({ on: true, connection: loopback })).toBe(true);
    expect(answered({ on: false, connection: loopback })).toBe(true);
    expect(answered({ on: true, connection: own })).toBe(false);
    expect(answered({ on: true, connection: null })).toBe(false);
  });

  test("a chronicle line's citations are read in the order written, each with where it starts", () => {
    const line = "- Okoro signed the ledger [#38 a3f9c27e]; Ilse holds the night key [#412 0c1d9e3a]";
    expect(citationsOf(line)).toEqual([
      { citation: "[#38 a3f9c27e]", index: 38, hash: "a3f9c27e", start: line.indexOf("[#38") },
      { citation: "[#412 0c1d9e3a]", index: 412, hash: "0c1d9e3a", start: line.indexOf("[#412") },
    ]);
    // What only looks like one is none: a hash is eight hex characters or more, and a number is a number.
    expect(citationsOf("- Brann keeps the day key [#40] [#x a3f9c27e] [#40 a3f9] [40 a3f9c27e]")).toEqual([]);
    expect(citationsOf("- Joss never lies to Mara")).toEqual([]);
  });

  test("what the prompt held and the lore the writer saw are read from a trace by their shape", () => {
    const held = { kind: "prompt_held", lore: [{ entryId: "lore-harbour-office", bookId: "book-harbour", title: "The harbour office", chars: 212, tokens: 53, why: { by: "key", key: "harbour office" }, message: 2 }], index: { listed: [], more: 4 }, history: { held: [[30, 47]], missing: [[1, 29]], stands: [{ kind: "summary", name: "Lumiverse's summary" }] }, at: T0 };
    // Core's union names the event once its hook has landed; until then a trace carries it all the same.
    const event = held as unknown as TraceEvent;
    expect(promptHeldOf(event)).toMatchObject({ lore: [{ title: "The harbour office", message: 2 }], index: { more: 4 }, history: { missing: [[1, 29]] }, at: T0 });
    expect(promptHeldOf({ kind: "turn_paused", at: T0 })).toBeNull();
    expect(promptHeldOf({ ...held, history: null } as unknown as TraceEvent)).toBeNull();

    const result: TranscriptEntry = { kind: "result", callId: "call_write_1", name: "write_reply", text: "Written.", error: false, ms: 900, at: T0 };
    const changed = { ...result, lore: { added: [{ entryId: "lore-night-key", bookId: "book-harbour", title: "The night key", chars: 118 }], dropped: [], refused: [{ entryId: "lore-nobody", reason: "The chat's books have no such entry." }] } };
    expect(loreChangesOf(changed as unknown as TranscriptEntry)).toEqual(changed.lore);
    expect(loreChangesOf({ ...result, lore: { added: [], dropped: [] } } as unknown as TranscriptEntry)).toEqual({ added: [], dropped: [], refused: [] });
    expect(loreChangesOf(result)).toBeNull();
    expect(loreChangesOf({ kind: "note", text: "Keep it short.", at: T0 })).toBeNull();
  });

  test("what a turn came to is read from its events: the brief that was taken, the lore by title, and where the main agent stopped short", () => {
    const of = (events: TraceEvent[]): LiveEvent[] => events.map((event, i) => ({ turn: "turn-1", chatId: "chat-mara", seq: i + 1, event }));
    const agent = (id: string, parent?: string): TraceEvent => ({ kind: "agent_started", agent: { id, role: id.startsWith("main") ? "main" : "archivist", connectionId: null, model: null, effort: "inherit", system: "", prefix: [], history: 0, ...(parent !== undefined ? { parent } : {}), at: T0 } });
    const entry = (agentId: string, e: TranscriptEntry): TraceEvent => ({ kind: "agent_entry", agentId, entry: e });
    const usage = { in: 10, cachedIn: 0, out: 5, reasoningOut: 0, estimated: [] };
    const answer = (text: string, calls: { id: string; name: string; args: Record<string, string> }[]): TranscriptEntry => ({ kind: "answer", text, calls, written: false, tools: "native", usage, model: "m", finishReason: "stop", ms: 1, at: T0 });
    const result = (callId: string, name: string, error: boolean, lore?: object): TranscriptEntry => ({ kind: "result", callId, name, text: "", error, ms: 1, at: T0, ...(lore ? { lore } : {}) }) as TranscriptEntry;
    const lore = { added: [{ entryId: "lore-night-key", bookId: "book-harbour", title: "The night key", chars: 118 }], dropped: [{ entryId: "lore-joss", bookId: "book-people", title: "Joss", chars: 131 }], refused: [] };

    // The brief of the call that was taken, with what it did to the lore; a call that was turned down first gives way to it.
    const taken = of([
      agent("main-1"),
      entry("main-1", answer("", [{ id: "w1", name: "write_reply", args: { brief: "A first try." } }])),
      entry("main-1", result("w1", "write_reply", true)),
      agent("archivist-1", "main-1"),
      entry("archivist-1", answer("The ledger is in the back room.", [])),
      entry("main-1", answer("", [{ id: "w2", name: "write_reply", args: { brief: "Ilse comes to the door. End on her question." } }])),
      entry("main-1", result("w2", "write_reply", false, lore)),
    ]);
    expect(replyDid(taken)).toEqual({ brief: "Ilse comes to the door. End on her question.", lore: { added: ["The night key"], dropped: ["Joss"] }, stop: null });

    // Stopped short of a brief: the stop's code and its words, and no brief though it had said something.
    const stopped = of([agent("main-1"), entry("main-1", answer("Let me look.", [{ id: "s1", name: "chat_search", args: { query: "night key" } }])), entry("main-1", { kind: "stop", status: "failed", code: "connection", reason: "the connection has no model set", at: T0 })]);
    expect(replyDid(stopped)).toEqual({ brief: null, lore: { added: [], dropped: [] }, stop: { code: "connection", reason: "the connection has no model set" } });

    // It never called write_reply and never stopped: its last answer is what the model that writes the reply was given.
    expect(replyDid(of([agent("main-1"), entry("main-1", answer("Joss answers plainly. Keep him dry.", []))]))).toEqual({ brief: "Joss answers plainly. Keep him dry.", lore: { added: [], dropped: [] }, stop: null });
    expect(replyDid([])).toEqual({ brief: null, lore: { added: [], dropped: [] }, stop: null });
  });
});
