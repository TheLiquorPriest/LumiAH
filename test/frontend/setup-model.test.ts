// First-time setup and how a chat stands (DESIGN §25): no chat is answered without the runtime, so
// its own steps (start it, mint its key, have its connection) stand on the Runtime page until they
// are done, a chat switched on is answered through the runtime's loopback connection, and what is
// wrong is said in plain words with no way around the runtime.

import { describe, expect, test } from "bun:test";
import { MockBackend, type Scenario } from "../../dev/preview/mock-backend";
import { sampleSettings } from "../../dev/preview/sections";
import { PAGES } from "../../src/extension/frontend/app";
import { asksWords, chatStanding, grantReason, neededPermissions, optionalPermissions, runtimeSteps, runtimeTrouble, setupDone, setupSteps } from "../../src/extension/frontend/setup-model";
import type { ChatView, PermissionNeed, RelayView, UiState } from "../../src/shared/ui";

const T0 = Date.UTC(2026, 10, 10, 9, 0, 0);
const settled = sampleSettings();
/** The state a scenario of the preview opens with. */
const stateOf = (scenario: Scenario): UiState => new MockBackend(() => {}, { scenario, turn: "none", sections: settled.sections, texts: settled.texts, delay: 0, page: 50, fail: new Set(), now: () => T0, later: () => () => {} }).state;
const ready = stateOf("ready");
const fresh = stateOf("fresh");
const trouble = stateOf("trouble");
/** The preview's set-up story with its runtime not ready now. */
const unready: UiState = { ...ready, runtime: { ...ready.runtime, ready: false } };

const OWN = { id: "conn-deepseek", name: "Deepseek", loopback: false };
const LOOPBACK = { id: "conn-loopback", name: "LumiAH loopback", loopback: true };
const chat = (over: Partial<ChatView>): ChatView => ({ chatId: "chat-ilse", name: "Ilse, after the storm", on: true, since: T0, connection: LOOPBACK, ...over });

describe("first-time setup", () => {
  test("is one thing to do and a message to send, with no step for Lumiverse's permissions: the runtime's own steps are the Runtime page's", () => {
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
  test("switched on, its replies are prepared in the runtime, through the loopback connection, while one is ready", () => {
    expect(chatStanding(chat({}), ready)).toEqual({ answered: true, tone: "pos", line: "LumiAH prepares each reply in this chat, in your runtime.", fix: null, takeover: null });
  });

  test("off, LumiAH takes no part, unless the chat generates on the runtime's connection", () => {
    expect(chatStanding(chat({ on: false, since: null, connection: OWN }), ready)).toEqual({ answered: false, tone: "neutral", line: "LumiAH is off for this chat.", fix: null, takeover: null });
    const pinned = chatStanding(chat({ on: false, since: null }), ready);
    expect(pinned).toMatchObject({ answered: true, tone: "warn", fix: null });
    expect(pinned.line).toContain("LumiAH loopback");
  });

  test("a chat another extension with LumiAH built in holds says whose it is, and can be taken over where that extension is gone", () => {
    const theirs = chatStanding(chat({ on: false, since: null, connection: OWN, other: { identifier: "harbour_tales", name: "Harbour Tales" } }), ready);
    expect(theirs).toMatchObject({ answered: false, tone: "neutral", fix: null, takeover: "Harbour Tales" });
    expect(theirs.line).toBe("Harbour Tales has this chat, with LumiAH built into it: switch it on or off on Harbour Tales's own pages. If Harbour Tales is no longer installed, take the chat over here.");
    // Whatever connection it generates on, the chat is the other's.
    expect(chatStanding(chat({ on: false, since: null, other: { identifier: "harbour_tales", name: "Harbour Tales" } }), ready).line).toContain("Harbour Tales has this chat");
    // No other chat offers a takeover.
    expect(chatStanding(chat({}), ready).takeover).toBeNull();
  });

  test("switched on while a needed permission is missing, it says what must come first", () => {
    const standing = chatStanding(chat({}), trouble);
    expect(standing).toMatchObject({ answered: false, tone: "warn", fix: null });
    expect(standing.line).toContain("allowed what it needs");
  });

  test("whose runtime isn't answering, or none is ready, it says its replies fail until it is back, and offers no way around the runtime", () => {
    expect(chatStanding(chat({ away: true }), unready)).toEqual({ answered: false, tone: "warn", line: "Switched on, but your runtime isn't answering, so its replies fail until it is back. Its line is on the Runtime page.", fix: null, takeover: null });
    expect(chatStanding(chat({}), unready)).toEqual({ answered: false, tone: "warn", line: "Switched on, but no runtime is ready now, so its replies fail until one is. See the Runtime page.", fix: null, takeover: null });
  });

  test("off its connection, it says so, and the one press pins it back whether or not a runtime is ready now", () => {
    const off = chatStanding(chat({ connection: OWN }), ready);
    expect(off).toMatchObject({ answered: false, tone: "warn", fix: { label: "Pin it back" } });
    expect(off.line).toContain("Deepseek");
    expect(chatStanding(chat({ connection: OWN }), unready).fix).toEqual({ label: "Pin it back" });
  });

  test("inside an extension that switches its chats on in its own pages, a chat that is off says to switch it on there, and so does the first step", () => {
    const theirs: UiState = { ...ready, runtime: { ...ready.runtime, switchedBy: "Harbour Play" } };
    expect(chatStanding(chat({ on: false, since: null, connection: OWN }), theirs)).toEqual({ answered: false, tone: "neutral", line: "LumiAH is off for this chat. Switch it on in Harbour Play's own pages.", fix: null, takeover: null });
    expect(setupSteps({ ...fresh, runtime: theirs.runtime })[0]?.title).toBe("Switch this chat on in Harbour Play's own pages");
  });
});

describe("the runtime, which no chat is answered without", () => {
  test("its page says it is needed", () => {
    expect(PAGES.find((p) => p.id === "runtime")?.about).toStartWith("Needed.");
  });

  test("its steps are start, key, connection, the first one not done marked", () => {
    const none: UiState = { ...fresh };
    expect(runtimeSteps(none).map((s) => [s.id, s.at])).toEqual([
      ["start", "now"],
      ["key", "todo"],
      ["connection", "todo"],
    ]);
    expect(runtimeSteps(ready).map((s) => s.at)).toEqual(["done", "done", "done"]);
    // A key minted before any runtime linked: starting one is still what to do now.
    expect(runtimeSteps({ ...none, key: { set: true, print: "9f2c", at: T0 } }).map((s) => s.at)).toEqual(["now", "done", "todo"]);
  });

  test("trouble is said whenever none is ready: how many chats switched on fail until one is, that nothing is lost yet with none on, and what to do with none set up", () => {
    expect(runtimeTrouble(ready)).toBeNull();
    const resting = (away: boolean): ChatView[] => [chat({ chatId: "chat-brann", ...(away ? { away: true as const } : {}) }), chat({ chatId: "chat-okoro", ...(away ? { away: true as const } : {}) })];
    const line = "2 chats are switched on, and no runtime is ready: their replies fail until one is.";
    expect(runtimeTrouble({ ...unready, chats: resting(false) })).toBe(line);
    // Nothing stands in for a runtime that is away: the line is the same, and claims no other way.
    expect(runtimeTrouble({ ...unready, chats: resting(true) })).toBe(line);
    expect(runtimeTrouble({ ...unready, chats: resting(true).slice(0, 1) })).toBe("1 chat is switched on, and no runtime is ready: its replies fail until one is.");
    // A chat that is off rests on nothing.
    const quiet: RelayView[] = ready.runtime.relays.map((r) => ({ ...r, link: "quiet" }));
    const idle: UiState = { ...ready, runtime: { ...ready.runtime, relays: quiet, ready: false }, chats: [chat({ on: false, since: null })] };
    expect(runtimeTrouble(idle)).toBe("Your runtime isn't linked. No chat is switched on, so nothing is lost yet.");
    expect(runtimeTrouble({ ...fresh, runtime: { ...fresh.runtime, relays: [], ready: false }, chats: [] })).toBe("No chat is answered until your runtime is set up: its steps are on the Runtime page.");
  });
});

describe("asking Lumiverse for permissions", () => {
  const need = (id: string, needed: boolean): PermissionNeed => ({ id, what: "read the chat", without: "no reply is worked on", todo: "Grant it in Lumiverse.", needed });

  test("the reason says LumiAH can't work without them only of a list that holds nothing optional, and counts both where it holds both", () => {
    expect(grantReason([need("chats", true), need("interceptor", true)])).toEndWith("It can't work on a reply without these.");
    expect(grantReason([need("chats", true), need("world_books", false)])).toEndWith("It can't work on a reply without one of these; the other one adds a part of it.");
    expect(grantReason(fresh.permissions)).toEndWith("It can't work on a reply without 5 of these; the other 2 each add a part of it.");
    expect(grantReason([need("world_books", false)])).toEndWith("LumiAH works without these; each adds a part of it.");
  });

  test("before the switch is pressed, the first-run words name each of the five permissions LumiAH can't work without by what it is for, and count the rest", () => {
    expect(fresh.permissions.filter((p) => p.needed).map((p) => p.id)).toEqual(["interceptor", "chats", "generation", "chat_mutation", "generation_parameters"]);
    const said = asksWords(fresh.permissions);
    expect(said).toStartWith("Switching it on first asks Lumiverse to allow LumiAH the 5 things it can't work on a reply without: to ");
    for (const p of fresh.permissions.filter((p) => p.needed)) expect(said).toContain(`to ${p.what}`);
    expect(said).toEndWith("It also asks for 2 things that each add a part of it; all 7 are listed below.");
    // Only what is lacking is asked for: one needed permission is "the one thing", and with none lacking nothing is said.
    expect(asksWords([need("chats", true)])).toBe("Switching it on first asks Lumiverse to allow LumiAH the one thing it can't work on a reply without: to read the chat.");
    expect(asksWords([need("world_books", false)])).toBe("Switching it on first asks Lumiverse to allow LumiAH one thing that adds a part of it.");
    expect(asksWords([])).toBe("");
  });
});
