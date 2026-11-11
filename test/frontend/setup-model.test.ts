// First-time setup and where a chat runs (DESIGN §25): built in is the default and needs nothing
// installed, and a runtime is an option whose own steps show only to someone who asks for one.

import { describe, expect, test } from "bun:test";
import { MockBackend, type Scenario } from "../../dev/preview/mock-backend";
import { sampleSettings } from "../../dev/preview/sections";
import { asksWords, chatStanding, grantReason, neededPermissions, optionalPermissions, PLACE_ABOUT, runtimeBegun, runtimeSteps, runtimeTrouble, setupDone, setupSteps } from "../../src/extension/frontend/setup-model";
import type { ChatView, PermissionNeed, RelayView, UiState } from "../../src/shared/ui";

const T0 = Date.UTC(2026, 10, 10, 9, 0, 0);
const settled = sampleSettings();
/** The state a scenario of the preview opens with. */
const stateOf = (scenario: Scenario): UiState => new MockBackend(() => {}, { scenario, turn: "none", sections: settled.sections, texts: settled.texts, delay: 0, page: 50, fail: new Set(), now: () => T0, later: () => () => {} }).state;
const ready = stateOf("ready");
const fresh = stateOf("fresh");
const trouble = stateOf("trouble");

const OWN = { id: "conn-deepseek", name: "Deepseek", loopback: false };
const LOOPBACK = { id: "conn-loopback", name: "LumiAH loopback", loopback: true };
const chat = (over: Partial<ChatView>): ChatView => ({ chatId: "chat-ilse", name: "Ilse, after the storm", on: true, since: T0, place: "builtin", connection: OWN, ...over });

describe("first-time setup", () => {
  test("is one thing to do and a message to send: never a runtime, a key or a connection, and no step for Lumiverse's permissions", () => {
    expect(setupSteps(fresh).map((s) => [s.id, s.at])).toEqual([
      ["chat", "now"],
      ["reply", "todo"],
    ]);
    expect(setupDone(fresh)).toBe(false);
    for (const step of setupSteps(fresh)) expect(step.title).not.toMatch(/runtime|key|connection|permission/i);
  });

  test("the first step not done is the one to do now; with both done, setup is behind the user", () => {
    const on: UiState = { ...fresh, setup: { steps: fresh.setup.steps.map((s) => (s.id === "chat" ? { ...s, done: true } : s)) } };
    expect(setupSteps(on).map((s) => s.at)).toEqual(["done", "now"]);
    expect(setupDone(on)).toBe(false);
    expect(setupDone(ready)).toBe(true);
    // A permission taken away later doesn't bring the steps back: the chat's switch and what needs the user say it.
    expect(setupSteps(trouble).map((s) => s.at)).toEqual(["done", "done"]);
    expect(setupDone(trouble)).toBe(true);
  });

  test("what LumiAH lacks is told apart: what it can't answer without, and what only a part of it rests on", () => {
    expect(neededPermissions(fresh).length).toBeGreaterThan(0);
    expect(neededPermissions(trouble).map((p) => p.id)).toEqual(["generation"]);
    expect(optionalPermissions(trouble).map((p) => p.id)).toEqual(["mcp_servers"]);
    expect(neededPermissions(ready)).toEqual([]);
  });
});

describe("how a chat stands, said under its switch", () => {
  test("built in, its replies are prepared on whatever connection it has", () => {
    expect(chatStanding(chat({}), ready)).toEqual({ answered: true, tone: "pos", line: "LumiAH prepares each reply in this chat, built in.", fix: null, takeover: null });
    expect(chatStanding(chat({ connection: null }), ready)).toMatchObject({ answered: true });
  });

  test("off, LumiAH takes no part, unless the chat generates on the runtime's connection", () => {
    expect(chatStanding(chat({ on: false, since: null }), ready)).toEqual({ answered: false, tone: "neutral", line: "LumiAH is off for this chat.", fix: null, takeover: null });
    const pinned = chatStanding(chat({ on: false, since: null, connection: LOOPBACK }), ready);
    expect(pinned).toMatchObject({ answered: true, tone: "warn", fix: null });
    expect(pinned.line).toContain("LumiAH loopback");
  });

  test("a chat another extension with LumiAH built in holds says whose it is, and can be taken over where that extension is gone", () => {
    const theirs = chatStanding(chat({ on: false, since: null, other: { identifier: "harbour_tales", name: "Harbour Tales" } }), ready);
    expect(theirs).toMatchObject({ answered: false, tone: "neutral", fix: null, takeover: "Harbour Tales" });
    expect(theirs.line).toBe("Harbour Tales has this chat, with LumiAH built into it: switch it on or off on Harbour Tales's own pages. If Harbour Tales is no longer installed, take the chat over here.");
    // Whatever connection it generates on, the chat is the other's.
    expect(chatStanding(chat({ on: false, since: null, connection: LOOPBACK, other: { identifier: "harbour_tales", name: "Harbour Tales" } }), ready).line).toContain("Harbour Tales has this chat");
    // No other chat offers a takeover.
    expect(chatStanding(chat({}), ready).takeover).toBeNull();
  });

  test("switched on while a needed permission is missing, it says what must come first", () => {
    const standing = chatStanding(chat({}), trouble);
    expect(standing).toMatchObject({ answered: false, tone: "warn", fix: null });
    expect(standing.line).toContain("allowed what it needs");
  });

  test("in a runtime, its replies are prepared through the loopback while a runtime is ready", () => {
    expect(chatStanding(chat({ place: "runtime", connection: LOOPBACK }), ready)).toEqual({ answered: true, tone: "pos", line: "LumiAH prepares each reply in this chat, in your runtime.", fix: null, takeover: null });
  });

  test("a chat whose runtime isn't answering says replies may fail until it is back, and offers the one press that runs it built in", () => {
    const unready: UiState = { ...ready, runtime: { ...ready.runtime, ready: false } };
    const away = chatStanding(chat({ place: "runtime", connection: LOOPBACK, away: true }), unready);
    expect(away).toEqual({ answered: false, tone: "warn", line: "Set to run in your runtime, which isn't answering, so replies here may fail until it is back.", fix: { label: "Run it built in", place: "builtin" }, takeover: null });
  });

  test("in a runtime that isn't ready, or off its connection, it says so and offers the one press that mends it", () => {
    const unready: UiState = { ...ready, runtime: { ...ready.runtime, ready: false } };
    expect(chatStanding(chat({ place: "runtime", connection: LOOPBACK }), unready)).toMatchObject({ answered: false, tone: "warn", fix: { label: "Run it built in", place: "builtin" } });
    const off = chatStanding(chat({ place: "runtime", connection: OWN }), ready);
    expect(off).toMatchObject({ answered: false, tone: "warn", fix: { label: "Pin it back", place: "runtime" } });
    expect(off.line).toContain("Deepseek");
    // With no runtime to pin it back to, built in is the way out.
    expect(chatStanding(chat({ place: "runtime", connection: OWN }), unready).fix).toEqual({ label: "Run it built in", place: "builtin" });
  });

  test("each place is said in a line a newcomer can read", () => {
    expect(PLACE_ABOUT.builtin).toContain("Nothing to install");
    expect(PLACE_ABOUT.runtime).toContain("a program you start beside Lumiverse".replace(/^a/, "A"));
  });
});

describe("a runtime, for someone who asks for one", () => {
  const none: UiState = { ...fresh };

  test("nobody is taken to have begun with one until something of it is there", () => {
    expect(runtimeBegun(none)).toBe(false);
    expect(runtimeTrouble(none)).toBeNull();
    expect(runtimeBegun({ ...none, key: { set: true, print: "9f2c", at: T0 } })).toBe(true);
    expect(runtimeBegun({ ...none, chats: [chat({ place: "runtime", connection: LOOPBACK })] })).toBe(true);
    // A chat that remembers the runtime but is switched off rests on nothing.
    expect(runtimeBegun({ ...none, chats: [chat({ on: false, since: null, place: "runtime" })] })).toBe(false);
    expect(runtimeBegun(ready)).toBe(true);
  });

  test("its steps are start, key, connection, the first one not done marked", () => {
    expect(runtimeSteps(none).map((s) => [s.id, s.at])).toEqual([
      ["start", "now"],
      ["key", "todo"],
      ["connection", "todo"],
    ]);
    expect(runtimeSteps(ready).map((s) => s.at)).toEqual(["done", "done", "done"]);
    // A key minted before any runtime linked: starting one is still what to do now.
    expect(runtimeSteps({ ...none, key: { set: true, print: "9f2c", at: T0 } }).map((s) => s.at)).toEqual(["now", "done", "todo"]);
  });

  test("trouble is said only where a runtime is used and not ready, names the chats that rest on it, and promises nothing in its place", () => {
    expect(runtimeTrouble(ready)).toBeNull();
    const unready: UiState = { ...ready, runtime: { ...ready.runtime, ready: false } };
    const resting = (away: boolean): ChatView[] => [chat({ chatId: "chat-brann", place: "runtime", connection: LOOPBACK, ...(away ? { away: true as const } : {}) }), chat({ chatId: "chat-okoro", place: "runtime", connection: LOOPBACK, ...(away ? { away: true as const } : {}) })];
    const line = "2 chats are set to run in the runtime, and none is ready: replies there may fail until one is, or until the chat is set to run built in.";
    expect(runtimeTrouble({ ...unready, chats: resting(false) })).toBe(line);
    // Nothing stands in for a runtime that is away: the line is the same, and claims no fallback.
    expect(runtimeTrouble({ ...unready, chats: resting(true) })).toBe(line);
    expect(runtimeTrouble({ ...unready, chats: resting(true).slice(0, 1) })).toStartWith("1 chat is set to run in the runtime");
    const quiet: RelayView[] = ready.runtime.relays.map((r) => ({ ...r, link: "quiet" }));
    const idle: UiState = { ...ready, runtime: { ...ready.runtime, relays: quiet, ready: false }, chats: ready.chats.filter((c) => c.place === "builtin") };
    expect(runtimeTrouble(idle)).toBe("Your runtime isn't linked. No chat is set to run in it, so nothing is lost.");
  });
});

describe("asking Lumiverse for permissions", () => {
  const need = (id: string, needed: boolean): PermissionNeed => ({ id, what: "read the chat", without: "no reply is worked on", todo: "Grant it in Lumiverse.", needed });

  test("the reason says LumiAH can't work without them only of a list that holds nothing optional, and counts both where it holds both", () => {
    expect(grantReason([need("chats", true), need("interceptor", true)])).toEndWith("It can't work on a reply without these.");
    expect(grantReason([need("chats", true), need("world_books", false)])).toEndWith("It can't work on a reply without one of these; the other one adds a part of it.");
    expect(grantReason(fresh.permissions)).toEndWith("It can't work on a reply without 4 of these; the other 3 each add a part of it.");
    expect(grantReason([need("world_books", false)])).toEndWith("LumiAH works without these; each adds a part of it.");
  });

  test("before the switch is pressed, the first-run words name each of the four permissions LumiAH can't work without by what it is for, and count the rest", () => {
    expect(fresh.permissions.filter((p) => p.needed).map((p) => p.id)).toEqual(["interceptor", "chats", "generation", "chat_mutation"]);
    const said = asksWords(fresh.permissions);
    expect(said).toStartWith("Switching it on first asks Lumiverse to allow LumiAH the 4 things it can't work on a reply without: to ");
    for (const p of fresh.permissions.filter((p) => p.needed)) expect(said).toContain(`to ${p.what}`);
    expect(said).toEndWith("It also asks for 3 things that each add a part of it; all 7 are listed below.");
    // Only what is lacking is asked for: one needed permission is "the one thing", and with none lacking nothing is said.
    expect(asksWords([need("chats", true)])).toBe("Switching it on first asks Lumiverse to allow LumiAH the one thing it can't work on a reply without: to read the chat.");
    expect(asksWords([need("world_books", false)])).toBe("Switching it on first asks Lumiverse to allow LumiAH one thing that adds a part of it.");
    expect(asksWords([])).toBe("");
  });
});
