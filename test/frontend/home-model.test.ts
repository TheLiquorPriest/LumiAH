// Home, the first screen (DESIGN §25): for someone new it is setup (switch a chat on, send a
// message); after that it says whether LumiAH is used in the open chat, what needs the user, what
// the last reply's turn did in a sentence (where it failed, the cause and the step that mends it),
// offers to learn a long story nobody has learned, and leads to every other page.

import { describe, expect, test } from "bun:test";
import { NO_PART_TIME } from "../../dev/preview/fixtures";
import { MockBackend, type Scenario } from "../../dev/preview/mock-backend";
import { realSettings, sampleSettings } from "../../dev/preview/sections";
import { PAGES } from "../../src/extension/frontend/app";
import { didWords, type HomeInput, homeOf } from "../../src/extension/frontend/home-model";
import { SKIP_ABOUT, SKIP_REPLY } from "../../src/extension/frontend/nav-model";
import type { ApprovalView, ChatView, HomeView, JobView, LastTurn, LiveEnded, Notice, ReplyDid, RunningTurn, StoryEstimate, StoryView, UiState } from "../../src/shared/ui";

const T0 = Date.UTC(2026, 10, 10, 9, 0, 0);
const settled = sampleSettings();
/** The state a scenario of the preview opens with. */
const stateOf = (scenario: Scenario): UiState => new MockBackend(() => {}, { scenario, turn: "none", sections: settled.sections, texts: settled.texts, delay: 0, page: 50, fail: new Set(), now: () => T0, later: () => () => {} }).state;
const ready = stateOf("ready");
const fresh = stateOf("fresh");
const trouble = stateOf("trouble");

const OWN = { id: "conn-deepseek", name: "Deepseek", loopback: false };
const mara: ChatView = { chatId: "chat-mara", name: "Mara at the harbour", on: true, since: T0, place: "builtin", connection: OWN };
const USAGE = { calls: 2, toolTurns: 2, in: 12_430, cachedIn: 11_910, out: 280, reasoningOut: 78, estimated: false, ms: 4800, cost: 0.0018 };
const last = (over: Partial<LastTurn> = {}): LastTurn => ({ turn: "turn-0043", kind: "new", messageId: "msg-0043", startedAt: T0 - 60_000, ended: { state: "done", at: T0 - 48_600 }, place: "builtin", replyBy: null, usage: USAGE, agents: 1, tools: 3, lore: { added: 1, dropped: 1 }, changes: 0, jobs: 0, transcript: "t".repeat(64), ...over });
const home = (over: Partial<HomeView> = {}): HomeView => ({ chat: mara, last: last(), ...over });
const input = (over: Partial<HomeInput> = {}): HomeInput => ({ state: ready, home: home(), active: "chat-mara", now: T0, ...over });
const running: RunningTurn = { stream: "chat-mara", chatId: "chat-mara", turn: "turn-live-1", kind: "new", startedAt: T0 - 20_000, paused: false, place: "builtin", replyBy: T0 + 250_000 };
const held: ApprovalView = { id: "held-1", stream: "chat-mara", turn: "turn-live-1", chatId: "chat-mara", agentId: "archivist-1", role: "archivist", callId: "call_1", tool: "workspace_write", tier: "write", args: {}, at: T0, until: T0 + 60_000 };
const notice = (kind: Notice["kind"], id: string, at: number): Notice => ({ id, at, kind, chatId: "chat-mara", jobId: `job-${id}`, text: `The job ${id}.` });

describe("for someone new, Home is setup", () => {
  test("a fresh install shows two steps, and the switch asks for what LumiAH lacks: it isn't said again among what needs the user", () => {
    const model = homeOf(input({ state: fresh, home: { chat: { ...mara, on: false, since: null }, last: null } }));
    expect(model.setup?.map((s) => [s.id, s.at])).toEqual([
      ["chat", "now"],
      ["reply", "todo"],
    ]);
    expect(model.chat?.view.on).toBe(false);
    expect(model.needs).toEqual([]);
    expect(model.last).toMatchObject({ state: "none", action: null });
    expect(model.last.detail).toContain("Once LumiAH is switched on for this chat");
  });

  test("with no chat open there is no switch to ask with, so the need says it and asks itself", () => {
    const model = homeOf(input({ state: fresh, home: { chat: null, last: null }, active: null }));
    expect(model.chat).toBeNull();
    expect(model.needs.map((n) => [n.kind, n.tone, n.action?.do])).toEqual([["permission", "neg", "grant"]]);
    expect(model.last.detail).toContain("Open a chat in Lumiverse");
  });

  test("once a chat is on and a reply was answered, the steps are behind the user", () => {
    expect(homeOf(input()).setup).toBeNull();
    // A permission taken away later is said by the chat's switch, not by bringing the steps back.
    expect(homeOf(input({ state: trouble })).setup).toBeNull();
  });
});

describe("the open chat", () => {
  test("is the one the state lists, else the one the read answered; a read of another chat is no longer this chat's", () => {
    expect(homeOf(input()).chat?.view.name).toBe("Mara at the harbour");
    const other: ChatView = { chatId: "chat-ilse", name: "Ilse, after the storm", on: false, since: null, place: "builtin", connection: OWN };
    const model = homeOf(input({ active: "chat-ilse", home: { chat: other, last: null } }));
    expect(model.chat).toMatchObject({ view: { chatId: "chat-ilse", on: false }, standing: { answered: false } });
    // The read still holds the chat opened before: its last turn isn't this chat's.
    const stale = homeOf(input({ active: "chat-ilse" }));
    expect(stale.chat).toBeNull();
    expect(stale.last.state).toBe("none");
  });
});

describe("what needs the user, each thing with its one action", () => {
  test("a held call leads to where it is answered; a failed job to the job; a finished one is news, not a need", () => {
    const state: UiState = { ...ready, running: [running], approvals: [held], notices: [notice("job_done", "a", T0 - 5000), notice("job_failed", "b", T0 - 9000), notice("job_interrupted", "c", T0 - 1000)] };
    const model = homeOf(input({ state }));
    expect(model.needs.map((n) => [n.kind, n.action?.do === "go" ? n.action.target.page : null, n.notice])).toEqual([
      ["held", "live", null],
      ["job", "jobs", "c"],
      ["job", "jobs", "b"],
    ]);
    expect(model.needs[0]?.text).toBe("Archivist asks permission to use workspace_write.");
    expect(model.news.map((n) => n.id)).toEqual(["a"]);
  });

  test("a reply LumiAH had no part in is no need of its own: the last reply's card names the cause and carries the step", () => {
    const model = homeOf(input({ home: home({ last: last({ ended: { state: "failed", at: T0 - 5000, noPart: NO_PART_TIME, cause: "time" } }) }) }));
    expect(model.needs.map((n) => n.kind)).toEqual(homeOf(input()).needs.map((n) => n.kind));
    expect(model.last).toMatchObject({ state: "no_part", tone: "warn", title: "LumiAH ran out of time before the reply, 5 s ago", detail: NO_PART_TIME.text });
    expect(model.last.mend?.action).toEqual({ label: "See how a runtime lifts the limit", step: { go: "page", page: "runtime" } });
    expect(model.last.action).toEqual({ label: "See what happened", target: { page: "live", chatId: null } });
  });

  test("a permission only a part of LumiAH rests on is asked for once the needed ones are there", () => {
    const granted: UiState = { ...trouble, permissions: trouble.permissions.filter((p) => !p.needed) };
    expect(homeOf(input({ state: granted })).needs.filter((n) => n.kind === "optional").map((n) => n.action?.do)).toEqual(["grant"]);
    // While one it can't answer without is missing, that comes first.
    expect(homeOf(input({ state: trouble })).needs.some((n) => n.kind === "optional")).toBe(false);
  });

  test("a runtime that isn't ready is said only to someone who set a chat to run in one", () => {
    expect(homeOf(input({ state: trouble })).needs.find((n) => n.kind === "runtime")?.action).toMatchObject({ do: "go", target: { page: "runtime" } });
    expect(homeOf(input()).needs.some((n) => n.kind === "runtime")).toBe(false);
  });
});

describe("the last reply, in a line or two", () => {
  const DID: ReplyDid = { brief: "Mara reaches the harbour office at dusk. Ilse holds the night key and will not hand it over.", lore: { added: ["The night key"], dropped: ["Joss"] }, stop: null };

  test("a finished reply says how long it took and what it cost, the brief it gave and the lore by name; the counts are folded away (ux B1)", () => {
    const model = homeOf(input({ home: home({ last: last({ did: DID }) }) }));
    expect(model.last).toMatchObject({ state: "done", tone: "pos", title: "Prepared in 11.4 s, $0.0018, 49 s ago", brief: DID.brief, lore: "Added “The night key”. Left out of this prompt: “Joss”.", detail: null, clock: null, skip: null, mend: null });
    expect(model.last.counts).toBe("1 agent, 3 tool calls, 1 lore entry added, 1 lore entry left out of this prompt, built in. 2 calls · 12,430 in (11,910 cached) · 280 out (78 reasoning) · 4.8 s · $0.0018");
    expect(model.last.action).toEqual({ label: "See what it did", target: { page: "live", chatId: null } });
  });

  test("where the backend says nothing of the brief, the counts are what it says, unfolded", () => {
    const bare = homeOf(input());
    expect([bare.last.brief, bare.last.lore, bare.last.counts]).toEqual([null, "", null]);
    expect(bare.last.detail).toStartWith("1 agent, 3 tool calls, 1 lore entry added, 1 lore entry left out of this prompt, built in.");
  });

  const FAILED_TEXT = "LumiAH's agents didn't finish. Lumiverse sent the prompt as it was, so the reply is its own.";
  const ended = (over: Partial<LiveEnded>): LiveEnded => ({ state: "failed", at: T0 - 5000, noPart: { why: "failed", text: FAILED_TEXT }, ...over });

  test("a reply that failed names its cause as the card's title and offers the step that mends it (ux B2)", () => {
    const tools = homeOf(input({ home: home({ last: last({ ended: ended({ cause: "no_tools" }) }) }) })).last;
    expect(tools).toMatchObject({ state: "no_part", tone: "neg", title: "The agents' model can't call tools, 5 s ago", detail: FAILED_TEXT });
    expect(tools.mend?.action).toEqual({ label: "Choose another model for the agents", step: { go: "setting", link: "agentsModel" } });
    // A limit the main agent stopped at leads to where that limit is raised.
    const limit = homeOf(input({ home: home({ last: last({ ended: ended({ cause: "limit" }), did: { ...DID, brief: null, stop: { code: "tool_turns", reason: "It used its 12 rounds of tool calls." } } }) }) })).last;
    expect(limit.title).toBe("The main agent reached one of its limits, 5 s ago");
    expect(limit.mend?.action).toEqual({ label: "Raise the main agent's limits", step: { go: "setting", link: "agentLimits" } });
    // A permission LumiAH needs and lacks is the cause whatever else is said, and the step asks for it.
    const lacking = homeOf(input({ state: trouble, home: home({ last: last({ ended: ended({}) }) }) })).last;
    expect(lacking.title).toBe("LumiAH is missing a permission it needs, 5 s ago");
    expect(lacking.mend?.action?.step).toEqual({ go: "grant" });
  });

  test("a reply the user skipped is said once, plainly, with nothing to mend", () => {
    const text = "You skipped LumiAH for this reply. Lumiverse wrote the reply from the prompt as it was. To stop a reply itself, use Lumiverse's own Stop.";
    const model = homeOf(input({ home: home({ last: last({ ended: { state: "stopped", at: T0 - 5000, noPart: { why: "stopped", text }, cause: "skipped" } }) }) }));
    expect(model.last).toMatchObject({ state: "no_part", tone: "neutral", title: "You skipped LumiAH for this reply, 5 s ago", detail: "Lumiverse wrote the reply from the prompt as it was. To stop a reply itself, use Lumiverse's own Stop.", mend: null });
    expect(model.last.action?.label).toBe("See what it did");
    expect(model.needs.map((n) => n.kind)).toEqual(homeOf(input()).needs.map((n) => n.kind));
  });

  test("a turn that runs built in shows its time before the reply and can be skipped; one in a runtime has neither", () => {
    const working = homeOf(input({ state: { ...ready, running: [running] } }));
    expect(working.last).toMatchObject({ state: "running", title: "Working on a reply now", clock: { startedAt: T0 - 20_000, replyBy: T0 + 250_000 }, skip: { stream: "chat-mara", turn: "turn-live-1" } });
    expect(working.last.action?.label).toBe("Watch it live");
    expect(SKIP_REPLY).toBe("Skip LumiAH for this reply");
    expect(SKIP_ABOUT).toContain("Lumiverse's own Stop");
    const runtime = homeOf(input({ state: { ...ready, running: [{ ...running, place: "runtime", replyBy: null }] } }));
    expect(runtime.last).toMatchObject({ state: "running", clock: null, skip: null, detail: "In your runtime." });
  });

  test("a failed, a stopped and a lost turn each say what happened and lead to it", () => {
    const failed = homeOf(input({ home: home({ last: last({ place: "runtime", ended: { state: "failed", at: T0 - 5000, reason: "The main agent ran out of tool rounds." } }) }) }));
    expect(failed.last).toMatchObject({ state: "failed", tone: "neg", title: "The turn failed, 5 s ago", detail: "The main agent ran out of tool rounds." });
    expect(failed.last.mend?.action).toEqual({ label: "Show what went wrong", step: { go: "problems" } });
    const stopped = homeOf(input({ home: home({ last: last({ place: "runtime", ended: { state: "stopped", at: T0 - 5000 } }) }) }));
    expect(stopped.last).toMatchObject({ state: "stopped", mend: null });
    const lost = homeOf(input({ home: home({ last: last({ place: "runtime", ended: { state: "lost", at: T0 - 5000 } }) }) }));
    expect(lost.last.title).toBe("The turn was lost with its runtime, 5 s ago");
    expect(lost.last.mend?.action).toEqual({ label: "Open Runtime", step: { go: "page", page: "runtime" } });
  });

  test("what a turn did is counted in words, and nothing is said of what it didn't do", () => {
    expect(didWords({ agents: 3, tools: 1, lore: { added: 0, dropped: 2 }, changes: 2, jobs: 1 })).toBe("3 agents, 1 tool call, 2 lore entries left out of this prompt, 2 files changed, 1 job started");
    expect(didWords({ agents: 0, tools: 0, lore: { added: 0, dropped: 0 }, changes: 0, jobs: 0 })).toBe("");
  });
});

describe("Learn this story, offered for a long chat nobody has learned", () => {
  // LumiAH's own settings, which hold how far a chat may be past its chronicle ("Bring up to date after", 20 messages as shipped).
  const real = realSettings();
  const own: UiState = new MockBackend(() => {}, { scenario: "ready", turn: "none", sections: real.sections, texts: real.texts, delay: 0, page: 50, fail: new Set(), now: () => T0, later: () => () => {} }).state;
  const ESTIMATE: StoryEstimate = { messages: 1840, chars: 1_656_000, stretches: 31, promptTokens: 459_000, cachedTokens: 0, writtenTokens: 30_000, weighedTokens: 459_000, toolTurns: 13, usd: 0.21 };
  const view = (over: Partial<StoryView> = {}): StoryView => ({ job: null, plan: null, messages: 1840, covered: 0, suggested: { task: "Learn this story from its start.", agent: "archivist" }, estimate: ESTIMATE, refused: null, ...over });
  const story = (over: Partial<StoryView> = {}): HomeInput["story"] => ({ chatId: "chat-mara", view: view(over) });
  const learning: JobView = { id: "job-story", chatId: "chat-mara", agent: "archivist", task: "Learn this story from its start.", when: "now", state: "running", by: { who: "user" }, basis: null, createdAt: T0, usage: { calls: 0, toolTurns: 0, in: 0, cachedIn: 0, out: 0, reasoningOut: 0, estimated: false, ms: 0, cost: 0 } };

  test("a chat far longer than the upkeep trails by, with no chronicle, is offered it with what it should cost", () => {
    const { learn } = homeOf(input({ state: own, story: story() }));
    expect(learn?.title).toBe("This chat's 1,840 messages haven't been learned");
    expect(learn?.text).toContain("should cost about $0.21");
    expect(learn?.text).toContain("1,840 messages");
    // A chronicle that is far behind is offered in its own words.
    expect(homeOf(input({ state: own, story: story({ covered: 900, estimate: { ...ESTIMATE, messages: 940 } }) })).learn?.title).toBe("The chronicle is 940 messages behind this chat");
  });

  test("it is not offered for a short chat, one LumiAH is off for, one a job is at, another chat's read, or while setup is still to do", () => {
    // At Settings' 20 messages or under, upkeep covers it; one more and it is offered.
    expect(homeOf(input({ state: own, story: story({ messages: 20, estimate: { ...ESTIMATE, messages: 20 } }) })).learn).toBeNull();
    expect(homeOf(input({ state: own, story: story({ messages: 21, estimate: { ...ESTIMATE, messages: 21 } }) })).learn).not.toBeNull();
    const off: ChatView = { ...mara, on: false, since: null };
    expect(homeOf(input({ state: { ...own, chats: [off] }, home: home({ chat: off }), story: story() })).learn).toBeNull();
    expect(homeOf(input({ state: own, story: story({ job: learning }) })).learn).toBeNull();
    expect(homeOf(input({ state: own, story: { chatId: "chat-ilse", view: view() } })).learn).toBeNull();
    expect(homeOf(input({ state: own, story: null })).learn).toBeNull();
    expect(homeOf(input({ state: { ...own, setup: fresh.setup, permissions: fresh.permissions }, story: story() })).learn).toBeNull();
    // Settings that hold no such setting (an extension's own) say nothing of how far is far: no offer is made.
    expect(homeOf(input({ state: ready, story: story() })).learn).toBeNull();
  });
});

describe("the ways into the rest", () => {
  test("every other page is one tap from Home, each with a line on what it is for; the ones few need are folded away", () => {
    const { ways } = homeOf(input());
    const all = [...ways.main, ...ways.more].map((w) => w.id);
    expect(all.sort()).toEqual(PAGES.map((p) => p.id).filter((id) => id !== "home").sort());
    expect(ways.main.map((w) => w.id)).toEqual(["live", "sessions", "jobs", "talk", "lore", "chronicle", "workspace", "guidance", "settings"]);
    expect(ways.more.map((w) => w.id)).toEqual(["agents", "skills", "tools", "spend", "upkeep", "runtime"]);
    for (const way of [...ways.main, ...ways.more]) expect(way.about.length).toBeGreaterThan(20);
  });

  test("a page with something under way or waiting carries its mark, and a shell that shows only some pages leads only to those", () => {
    const state: UiState = { ...ready, running: [running], approvals: [held] };
    const { ways } = homeOf(input({ state }));
    expect(ways.main.find((w) => w.id === "live")?.mark).toBe("needs");
    const few = homeOf(input({ pages: ["home", "live", "settings", "runtime"] })).ways;
    expect([few.main.map((w) => w.id), few.more.map((w) => w.id)]).toEqual([["live", "settings"], ["runtime"]]);
  });
});
