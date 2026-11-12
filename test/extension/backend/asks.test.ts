// What a page asks of the core is done in the user's runtime (DESIGN §4, §8): about a chat on a
// loopback connection it goes to the runtime that chat generates on, whichever others are linked,
// and while that one isn't linked the page is told so; about anything else it goes to the user's
// runtime, the one linked now that was heard from last. With no runtime linked there is nobody to
// ask, and the page is told so in plain words. One that doesn't answer in the time Settings give is
// given up, a refusal keeps the code the core gave it, and what a runtime that went away was asked
// fails at once.

import { describe, expect, test } from "bun:test";
import type { JsonValue } from "../../../src/core/ports";
import { Asks } from "../../../src/extension/backend/asks";
import { UiRefused } from "../../../src/extension/backend/errors";
import { LINK, type LinkPush } from "../../../src/link/contract";
import { TRANSPORT_DEFAULTS } from "../../../src/link/settings";

const USER = "user-mara";
/** Two chats on loopback connections, each generating on another of the user's runtimes, and one that generates on a connection of its own. */
const AWAY = "chat-away";
const FURTHER = "chat-further";
const ELSEWHERE = "chat-elsewhere";
/** The runtime whose loopback connection each chat on one generates on. */
const HOMES: Readonly<Record<string, string>> = { [AWAY]: "relay-1", [FURTHER]: "relay-2" };
const NONE_LINKED = "LumiAH needs its runtime for this, and none is linked now. Start it (its line is on LumiAH's Runtime page) and try again.";

/** Asks over the runtimes `linked`, the first of them heard from last, by an extension that names itself as `who` says; a page waits `askMs` where given, else the default. */
function rig(linked: string[] = ["relay-1"], who: { name: string; settingsAt?: string } = { name: "LumiAH" }, askMs?: number) {
  const pushed: { relay: string; push: LinkPush }[] = [];
  const timers: { ms: number; fn(): void; cancelled: boolean }[] = [];
  const up = new Set(linked);
  /** The runs under way and the jobs not over, each with the runtime it runs in. */
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
    settings: { transport: async () => (askMs === undefined ? TRANSPORT_DEFAULTS : { ...TRANSPORT_DEFAULTS, pages: { ...TRANSPORT_DEFAULTS.pages, askMs } }) },
    onLoopback: async (_userId, chatId) => chatId in HOMES,
    runtimeOf: async (_userId, chatId) => {
      const home = HOMES[chatId];
      return home !== undefined && up.has(home) ? home : null;
    },
    userRuntime: async () => [...up][0] ?? null,
    runOf: (_userId, _stream, turn) => runs.get(turn) ?? null,
    jobOf: (_userId, job) => jobs.get(job) ?? null,
    ...who,
    now: () => 0,
    later: (ms, fn) => {
      const timer = { ms, fn, cancelled: false };
      timers.push(timer);
      return () => {
        timer.cancelled = true;
      };
    },
    id: () => `ask-${++n}`,
  });
  /** Each ask pushed so far: the runtime it went to, its op and its chat. */
  const asked = (): [string, string, JsonValue | undefined][] => pushed.map(({ relay, push }) => (push.type === "ask" ? [relay, push.op, push.args.chatId] : [relay, push.type, undefined]));
  /** The runtime answers the ask it was pushed last. */
  const answer = (value: JsonValue): void => {
    const last = pushed.at(-1);
    if (last?.push.type !== "ask") throw new Error("nothing was asked");
    asks.answered(USER, last.relay, last.push.ask, value, null);
  };
  return { asks, pushed, timers, up, runs, jobs, asked, answer };
}

/** Lets what an ask awaits before it pushes (where it belongs, its chat's runtime, the settings) settle. */
const settled = async (): Promise<void> => {
  for (let i = 0; i < 20; i++) await Promise.resolve();
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

describe("something a page asks of the core about a chat on a loopback connection", () => {
  test("is pushed to the runtime that chat generates on and answered with the runtime's own answer", async () => {
    const { asks, pushed, timers } = rig();
    const asked = asks.ask(USER, "workspace.read", { chatId: AWAY, area: "chat", path: "notes.md" }, { chat: AWAY });
    await settled();
    expect(pushed).toEqual([{ relay: "relay-1", push: { link: LINK, type: "ask", ask: "ask-1", op: "workspace.read", args: { chatId: AWAY, area: "chat", path: "notes.md" } } }]);
    // An answer naming another runtime, or no ask of this one's, changes nothing.
    asks.answered(USER, "relay-2", "ask-1", { text: "Not mine." }, null);
    asks.answered(USER, "relay-1", "ask-9", { text: "Not asked." }, null);
    asks.answered(USER, "relay-1", "ask-1", { text: "Low tide." }, null);
    expect(await asked).toEqual({ text: "Low tide." });
    // Answered in time: its wait is called off.
    expect(timers.map((t) => [t.ms, t.cancelled])).toEqual([[TRANSPORT_DEFAULTS.pages.askMs, true]]);
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
    const { asks, asked } = rig(["relay-2", "relay-1"]);
    void asks.ask(USER, "workspace.list", { chatId: AWAY, area: "chat" }, { chat: AWAY }).catch(() => undefined);
    void asks.ask(USER, "workspace.list", { chatId: FURTHER, area: "chat" }, { chat: FURTHER }).catch(() => undefined);
    await settled();
    expect(asked()).toEqual([
      ["relay-1", "workspace.list", AWAY],
      ["relay-2", "workspace.list", FURTHER],
    ]);
  });

  test("tells the page there is nobody to ask while the chat's runtime isn't linked, and what to do about it: another runtime of the user's is not asked in its place", async () => {
    for (const linked of [[], ["relay-2"]]) {
      const { asks, pushed } = rig(linked);
      const none = await refusal(asks.ask(USER, "jobs.list", {}, { chat: AWAY }));
      expect(none.code).toBe("unavailable");
      expect(none.message).toBe("This chat runs in a runtime, and that runtime isn't linked now. Start it (its line is on LumiAH's Runtime page) and try again.");
      expect(pushed).toEqual([]);
    }
  });

  test("is given up when the runtime doesn't answer in the time Settings give, unless it is something that takes as long as it takes", async () => {
    // The Runtime wait set short.
    const { asks, timers } = rig(["relay-1"], { name: "LumiAH" }, 2_000);
    const slow = refusal(asks.ask(USER, "jobs.list", {}, { chat: AWAY }));
    await settled();
    expect(timers.map((t) => t.ms)).toEqual([2_000]);
    timers[0]?.fn();
    expect(await slow).toMatchObject({ code: "unavailable", message: "The runtime didn't answer within 2 seconds. It may be busy or restarting: try again in a moment. Runtime wait (LumiAH's Settings → Timeouts → Waiting for the runtime) says how long a page waits for it." });
    // What takes as long as it takes is waited for while its runtime stays linked: no clock is set on it.
    const long = asks.ask(USER, "workspace.list", {}, { chat: AWAY, patient: true });
    await settled();
    expect(timers).toHaveLength(1);
    asks.answered(USER, "relay-1", "ask-2", { files: [] }, null);
    expect(await long).toEqual({ files: [] });
  });

  test("a timeout's words say where the Settings are that hold the wait: the extension's own, or where an extension that builds LumiAH in says they are shown", async () => {
    const words = async (who: { name: string; settingsAt?: string }): Promise<string> => {
      const { asks, timers } = rig(["relay-1"], who);
      const slow = refusal(asks.ask(USER, "jobs.list", {}, { chat: AWAY }));
      await settled();
      timers[0]?.fn();
      return (await slow).message;
    };
    const start = `The runtime didn't answer within ${TRANSPORT_DEFAULTS.pages.askMs / 1000} seconds. It may be busy or restarting: try again in a moment.`;
    expect(await words({ name: "LumiRPEngine" })).toBe(`${start} Runtime wait (LumiRPEngine's Settings → Timeouts → Waiting for the runtime) says how long a page waits for it.`);
    expect(await words({ name: "LumiRPEngine", settingsAt: "LumiRPEngine's Harness tab → System → Settings" })).toBe(`${start} Runtime wait (LumiRPEngine's Harness tab → System → Settings → Timeouts → Waiting for the runtime) says how long a page waits for it.`);
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

describe("something a page asks of the core about anything else", () => {
  test("about no chat, or a chat that generates elsewhere, goes to the user's runtime: the one linked now that was heard from last", async () => {
    const { asks, asked } = rig(["relay-2", "relay-1"]);
    void asks.ask(USER, "spend.get", { days: 7 }).catch(() => undefined);
    void asks.ask(USER, "workspace.list", { chatId: null, area: "user" }, { chat: null }).catch(() => undefined);
    void asks.ask(USER, "guidance.get", { chatId: ELSEWHERE }, { chat: ELSEWHERE }).catch(() => undefined);
    await settled();
    expect(asked()).toEqual([
      ["relay-2", "spend.get", undefined],
      ["relay-2", "workspace.list", null],
      ["relay-2", "guidance.get", ELSEWHERE],
    ]);
  });

  test("with no runtime linked is refused in plain words that say what to do, and nothing is asked anywhere", async () => {
    const { asks, pushed } = rig([]);
    for (const asking of [
      asks.ask(USER, "spend.get", { days: 7 }),
      asks.ask(USER, "workspace.list", { chatId: null, area: "user" }, { chat: null }),
      asks.ask(USER, "guidance.get", { chatId: ELSEWHERE }, { chat: ELSEWHERE }),
      asks.ask(USER, "jobs.cancel", { id: "job-1" }, { job: "job-1" }),
      asks.ask(USER, "side.send", { session: "side-ilse", text: "Which tide table?" }, { side: "side-ilse" }),
    ]) {
      expect(await refusal(asking)).toMatchObject({ code: "unavailable", message: NONE_LINKED });
    }
    expect(pushed).toEqual([]);
  });

  test("about a run under way goes where that run runs; one that isn't, to the user's runtime", async () => {
    const { asks, asked, runs } = rig(["relay-1", "relay-2"]);
    runs.set("turn-away", "relay-2");
    void asks.ask(USER, "run.say", { run: "turn-away", text: "Mind the tide." }, { run: { stream: AWAY, turn: "turn-away" } }).catch(() => undefined);
    void asks.ask(USER, "run.say", { run: "turn-over", text: "Mind the tide." }, { run: { stream: AWAY, turn: "turn-over" } }).catch(() => undefined);
    await settled();
    expect(asked().map(([relay, op]) => [relay, op])).toEqual([
      ["relay-2", "run.say"],
      ["relay-1", "run.say"],
    ]);
  });

  test("about a job goes where the job runs while it isn't over; once it is, the user's runtime reads its chat first, and it goes where that chat generates", async () => {
    const { asks, asked, answer, jobs } = rig(["relay-1", "relay-2"]);
    jobs.set("job-running", "relay-2");
    void asks.ask(USER, "jobs.cancel", { id: "job-running" }, { job: "job-running" }).catch(() => undefined);
    await settled();
    expect(asked().map(([relay, op]) => [relay, op])).toEqual([["relay-2", "jobs.cancel"]]);

    // A job that is over: its chat generates on the second runtime, so it is started again there.
    void asks.ask(USER, "jobs.again", { id: "job-ended" }, { job: "job-ended" }).catch(() => undefined);
    await settled();
    expect(asked().at(-1)).toEqual(["relay-1", "jobs.read", undefined]);
    answer({ job: { id: "job-ended", chatId: FURTHER } });
    await settled();
    expect(asked().at(-1)).toEqual(["relay-2", "jobs.again", undefined]);

    // One the user's runtime knows nothing of is asked of it in its place: the core says so in its own words.
    const unknown = refusal(asks.ask(USER, "jobs.again", { id: "job-gone" }, { job: "job-gone" }));
    await settled();
    asks.answered(USER, "relay-1", "ask-4", null, { code: "not_found", message: "There is no job job-gone." });
    await settled();
    expect(asked().at(-1)).toEqual(["relay-1", "jobs.again", undefined]);
    asks.answered(USER, "relay-1", "ask-5", null, { code: "not_found", message: "There is no job job-gone." });
    expect(await unknown).toMatchObject({ code: "not_found", message: "There is no job job-gone." });
  });

  test("about a side session goes where the chat it is about generates, and to the user's runtime when it is about none", async () => {
    const { asks, asked, answer } = rig(["relay-1", "relay-2"]);
    void asks.ask(USER, "side.send", { session: "side-ilse", text: "Which tide table?" }, { side: "side-ilse" }).catch(() => undefined);
    await settled();
    answer({ side: { id: "side-ilse", chatId: "" }, turns: [] });
    await settled();
    void asks.ask(USER, "side.send", { session: "side-brann", text: "And tomorrow?" }, { side: "side-brann" }).catch(() => undefined);
    await settled();
    answer({ side: { id: "side-brann", chatId: FURTHER }, turns: [] });
    await settled();
    expect(asked().map(([relay, op]) => [relay, op])).toEqual([
      ["relay-1", "sides.turns"],
      ["relay-1", "side.send"],
      ["relay-1", "sides.turns"],
      ["relay-2", "side.send"],
    ]);
  });
});
