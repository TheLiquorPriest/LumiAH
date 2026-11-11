// What a page asks of the core is done in the place it belongs to (DESIGN §4, §8, §25): about a chat
// that runs in a runtime it goes to the runtime that chat generates on, whichever others are linked,
// and while that one isn't linked the page is told so, one that doesn't answer in the time Settings
// give is given up, a refusal keeps the code the core gave it, and what a runtime that went away was
// asked fails at once. About no chat, or about a chat that runs built in, it is done by the core
// here, and no runtime is asked anything.

import { describe, expect, test } from "bun:test";
import type { JsonObject, JsonValue } from "../../../src/core/ports";
import { Asks } from "../../../src/extension/backend/asks";
import { UiRefused } from "../../../src/extension/backend/errors";
import { BUILTIN } from "../../../src/extension/backend/live";
import { LINK, type LinkPush } from "../../../src/link/contract";
import { TRANSPORT_DEFAULTS } from "../../../src/link/settings";

const USER = "user-mara";
/** A chat that runs in the runtime (it generates on the loopback), one that runs in the user's second runtime, and one that runs built in. */
const AWAY = "chat-away";
const FURTHER = "chat-further";
const HERE = "chat-here";
/** The runtime whose loopback connection each chat that runs in one generates on. */
const HOMES: Readonly<Record<string, string>> = { [AWAY]: "relay-1", [FURTHER]: "relay-2" };

function rig(linked: string[] = ["relay-1"]) {
  const pushed: { relay: string; push: LinkPush }[] = [];
  const here: { op: string; args: JsonObject }[] = [];
  const timers: { ms: number; fn(): void; cancelled: boolean }[] = [];
  const up = new Set(linked);
  /** What the built-in core answers each op with; a `UiRefused` is thrown. */
  const answers = new Map<string, JsonValue | UiRefused>();
  /** The runs under way and the jobs not over, each with where it runs. */
  const runs = new Map<string, string>();
  const jobs = new Map<string, string>();
  let n = 0;
  const asks = new Asks({
    relays: {
      push: (_userId, relay, push) => {
        if (!up.has(relay)) return false;
        pushed.push({ relay, push });
        return true;
      },
      isLinked: (_userId, relay) => up.has(relay),
    },
    settings: { transport: async () => TRANSPORT_DEFAULTS },
    builtin: async (_userId, op, args) => {
      here.push({ op, args });
      const answer = answers.get(op) ?? { done: op };
      if (answer instanceof UiRefused) throw answer;
      return answer;
    },
    placeOf: async (_userId, chatId) => (chatId in HOMES ? "runtime" : "builtin"),
    runtimeOf: async (_userId, chatId) => {
      const home = HOMES[chatId];
      return home !== undefined && up.has(home) ? home : null;
    },
    needsRuntime: async () => null,
    runOf: (_userId, _stream, turn) => runs.get(turn) ?? null,
    jobOf: (_userId, job) => jobs.get(job) ?? null,
    name: "LumiAH",
    later: (ms, fn) => {
      const timer = { ms, fn, cancelled: false };
      timers.push(timer);
      return () => {
        timer.cancelled = true;
      };
    },
    id: () => `ask-${++n}`,
  });
  return { asks, pushed, here, timers, up, answers, runs, jobs };
}

/** Lets what an ask awaits before it pushes (where it belongs, its chat's runtime, the settings) settle. */
const settled = async (): Promise<void> => {
  for (let i = 0; i < 8; i++) await Promise.resolve();
};

const refusal = (asked: Promise<unknown>): Promise<UiRefused> =>
  asked.then(
    () => {
      throw new Error("the ask was answered");
    },
    (error: unknown) => {
      if (!(error instanceof UiRefused)) throw error;
      return error;
    },
  );

describe("something a page asks of the core about a chat that runs in a runtime", () => {
  test("is pushed to the user's runtime and answered with the runtime's own answer", async () => {
    const { asks, pushed, here, timers } = rig();
    const asked = asks.ask(USER, "workspace.read", { chatId: AWAY, area: "chat", path: "notes.md" }, { chat: AWAY });
    await settled();
    expect(pushed).toEqual([{ relay: "relay-1", push: { link: LINK, type: "ask", ask: "ask-1", op: "workspace.read", args: { chatId: AWAY, area: "chat", path: "notes.md" } } }]);
    // An answer naming another runtime, or no ask of this one's, changes nothing.
    asks.answered(USER, "relay-2", "ask-1", { text: "Not mine." }, null);
    asks.answered(USER, "relay-1", "ask-9", { text: "Not asked." }, null);
    asks.answered(USER, "relay-1", "ask-1", { text: "Low tide." }, null);
    expect(await asked).toEqual({ text: "Low tide." });
    // Answered in time: its wait is called off. The core here was asked nothing.
    expect(timers.map((t) => [t.ms, t.cancelled])).toEqual([[TRANSPORT_DEFAULTS.pages.askMs, true]]);
    expect(here).toEqual([]);
  });

  test("is refused as the core refused it, and a failure of the runtime's own is said to be one", async () => {
    const { asks } = rig();
    const conflict = refusal(asks.ask(USER, "workspace.write", {}, { chat: AWAY }));
    await settled();
    asks.answered(USER, "relay-1", "ask-1", null, { code: "conflict", message: "notes.md changed since you opened it: read it again." });
    expect(await conflict).toMatchObject({ code: "conflict", message: "notes.md changed since you opened it: read it again." });

    const invalid = refusal(asks.ask(USER, "guidance.set", {}, { chat: AWAY }));
    await settled();
    asks.answered(USER, "relay-1", "ask-2", null, { code: "invalid", message: "The guidance is too long.", problems: [{ path: ["text"], message: "At most 4000 characters." }, "not a problem"] });
    expect(await invalid).toMatchObject({ code: "invalid", problems: [{ path: ["text"], message: "At most 4000 characters." }] });

    const broke = refusal(asks.ask(USER, "jobs.list", {}, { chat: AWAY }));
    await settled();
    asks.answered(USER, "relay-1", "ask-3", null, { code: "internal", message: "the store couldn't be read" });
    expect(await broke).toMatchObject({ code: "internal", message: "The runtime couldn't do that (the store couldn't be read)." });
  });

  test("goes to the runtime its chat generates on when two are linked, whichever was heard from last", async () => {
    // The second runtime was heard from last.
    const { asks, pushed } = rig(["relay-2", "relay-1"]);
    void asks.ask(USER, "workspace.list", { chatId: AWAY, area: "chat" }, { chat: AWAY }).catch(() => undefined);
    void asks.ask(USER, "workspace.list", { chatId: FURTHER, area: "chat" }, { chat: FURTHER }).catch(() => undefined);
    await settled();
    expect(pushed.map((p) => [p.relay, p.push.type === "ask" ? p.push.args.chatId : null])).toEqual([
      ["relay-1", AWAY],
      ["relay-2", FURTHER],
    ]);
  });

  test("tells the page there is nobody to ask while the chat's runtime isn't linked, and what to do about it: another runtime of the user's is not asked in its place", async () => {
    for (const linked of [[], ["relay-2"]]) {
      const { asks, pushed, here } = rig(linked);
      const none = await refusal(asks.ask(USER, "jobs.list", {}, { chat: AWAY }));
      expect(none.code).toBe("unavailable");
      expect(none.message).toBe("This chat runs in a runtime, and its runtime isn't linked. Start it (its line is on LumiAH's Runtime page) and try again, or set the chat to run built in, which needs no runtime.");
      expect(pushed).toEqual([]);
      expect(here).toEqual([]);
    }
  });

  test("is given up when the runtime doesn't answer in the time Settings give, unless it is something that takes as long as it takes", async () => {
    const { asks, timers } = rig();
    const slow = refusal(asks.ask(USER, "jobs.list", {}, { chat: AWAY }));
    await settled();
    timers[0]?.fn();
    expect(await slow).toMatchObject({ code: "unavailable" });
    // What takes as long as it takes is waited for while its runtime stays linked: no clock is set on it.
    const long = asks.ask(USER, "workspace.list", {}, { chat: AWAY, patient: true });
    await settled();
    expect(timers).toHaveLength(1);
    asks.answered(USER, "relay-1", "ask-2", { files: [] }, null);
    expect(await long).toEqual({ files: [] });
  });

  test("fails at once when the runtime it was asked of goes away", async () => {
    const { asks, up } = rig();
    const asked = refusal(asks.ask(USER, "workspace.list", {}, { chat: AWAY, patient: true }));
    await settled();
    up.delete("relay-1");
    asks.recheck(USER);
    expect(await asked).toMatchObject({ code: "unavailable" });
  });
});

describe("something a page asks of the core", () => {
  test("about no chat, or about a chat that runs built in, is done by the core here, with no runtime asked and none needed", async () => {
    const { asks, pushed, here } = rig([]);
    expect(await asks.ask(USER, "spend.get", { days: 7 })).toEqual({ done: "spend.get" });
    expect(await asks.ask(USER, "workspace.list", { chatId: null, area: "user" }, { chat: null })).toEqual({ done: "workspace.list" });
    expect(await asks.ask(USER, "guidance.get", { chatId: HERE }, { chat: HERE })).toEqual({ done: "guidance.get" });
    expect(here.map((asked) => asked.op)).toEqual(["spend.get", "workspace.list", "guidance.get"]);
    expect(pushed).toEqual([]);
  });

  test("is refused by the core here in the core's own words", async () => {
    const { asks, answers } = rig();
    answers.set("workspace.write", new UiRefused("conflict", "notes.md changed since you opened it: read it again."));
    expect(await refusal(asks.ask(USER, "workspace.write", {}, { chat: HERE }))).toMatchObject({ code: "conflict", message: "notes.md changed since you opened it: read it again." });
  });

  test("about a run under way goes where that run runs", async () => {
    const { asks, pushed, here, runs } = rig(["relay-1", "relay-2"]);
    runs.set("turn-here", BUILTIN);
    runs.set("turn-away", "relay-2");
    expect(await asks.ask(USER, "run.say", { run: "turn-here", text: "Mind the tide." }, { run: { stream: HERE, turn: "turn-here" } })).toEqual({ done: "run.say" });
    void asks.ask(USER, "run.say", { run: "turn-away", text: "Mind the tide." }, { run: { stream: AWAY, turn: "turn-away" } }).catch(() => undefined);
    await settled();
    // The runtime that works on it, whichever was heard from last.
    expect(pushed.map((p) => p.relay)).toEqual(["relay-2"]);
    expect(here.map((asked) => asked.op)).toEqual(["run.say"]);
  });

  test("about a job goes where the job runs while it isn't over, and where its chat runs once it is", async () => {
    const { asks, pushed, here, jobs, answers } = rig();
    jobs.set("job-running-away", "relay-1");
    jobs.set("job-running-here", BUILTIN);
    void asks.ask(USER, "jobs.cancel", { id: "job-running-away" }, { job: "job-running-away" }).catch(() => undefined);
    await settled();
    expect(pushed.map((p) => (p.push.type === "ask" ? p.push.op : ""))).toEqual(["jobs.cancel"]);
    expect(await asks.ask(USER, "jobs.cancel", { id: "job-running-here" }, { job: "job-running-here" })).toEqual({ done: "jobs.cancel" });
    // A job that is over is read here, from the store both places share, to learn its chat: started again, it runs where that chat runs now.
    answers.set("jobs.read", { job: { id: "job-ended", chatId: AWAY } });
    void asks.ask(USER, "jobs.again", { id: "job-ended" }, { job: "job-ended" }).catch(() => undefined);
    await settled();
    expect(pushed.map((p) => (p.push.type === "ask" ? p.push.op : ""))).toEqual(["jobs.cancel", "jobs.again"]);
    expect(here.map((asked) => asked.op)).toEqual(["jobs.cancel", "jobs.read"]);
  });

  test("about a side session goes where the chat it is about runs, and is done here when it is about none", async () => {
    const { asks, pushed, here, answers } = rig();
    answers.set("sides.turns", { side: { id: "side-ilse", chatId: "" }, turns: [] });
    expect(await asks.ask(USER, "side.send", { session: "side-ilse", text: "Which tide table?" }, { side: "side-ilse" })).toEqual({ done: "side.send" });
    answers.set("sides.turns", { side: { id: "side-brann", chatId: AWAY }, turns: [] });
    void asks.ask(USER, "side.send", { session: "side-brann", text: "And tomorrow?" }, { side: "side-brann" }).catch(() => undefined);
    await settled();
    expect(here.map((asked) => asked.op)).toEqual(["sides.turns", "side.send", "sides.turns"]);
    expect(pushed.map((p) => (p.push.type === "ask" ? p.push.op : ""))).toEqual(["side.send"]);
  });
});
