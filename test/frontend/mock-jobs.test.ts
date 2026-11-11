// The stand-in backend's jobs (dev/preview/mock/jobs.ts) answer as the contract says: every request
// of the Jobs page answers, keeps what the page changes, and refuses what the real backend would.
// The context is built by hand, with a clock and runs the test turns itself.

import { describe, expect, test } from "bun:test";
import { CHATS, fakeHash, type HeldWord, type PlayStep, Trace } from "../../dev/preview/fixtures";
import { type MockCtx, type PlayOptions, Refusal } from "../../dev/preview/mock/ctx";
import { jobsMock } from "../../dev/preview/mock/jobs";
import { UI_VERSION, type JobState, type JobView, type JobsPage, type RunningTurn, type UiRequests, type UiState } from "../../src/shared/ui";

const T0 = Date.UTC(2026, 10, 10, 9, 0, 0);

type Mine = "lah.jobs.list" | "lah.jobs.set" | "lah.job.start" | "lah.job.cancel" | "lah.job.again" | "lah.job.grant" | "lah.job.resume" | "lah.notice.dismiss";

interface Run {
  steps: PlayStep[];
  options: PlayOptions;
  trace: Trace;
  paused: boolean;
}

/** A jobs part on a context of its own: its state, its texts, and the runs it plays, which the test ends by hand. */
function world(ready = true) {
  let now = T0;
  let state: UiState = {
    rev: 1,
    runtime: { build: "test", link: 1, model: "lumiah", relays: [], start: { service: null, foreground: null, missing: [] }, issues: [], ready: false },
    setup: { steps: [] },
    key: { set: false, print: null, at: null },
    chats: ready ? CHATS : [],
    running: [],
    connections: [],
    settings: { values: {}, defaults: {}, schema: {} },
    texts: { defs: [], own: {} },
    approvals: [],
    jobs: { active: [], off: false, paused: false, changed: 0 },
    notices: [],
    defs: 0,
    permissions: [],
  };
  const texts = new Map<string, string>();
  const runs = new Map<string, Run>();
  const end = (stream: string, how: "done" | "stopped"): boolean => {
    const run = runs.get(stream);
    if (!run) return false;
    runs.delete(stream);
    run.options.done?.({ turn: run.trace.turn, state: how, transcript: fakeHash(`transcript:${run.trace.turn}`), trace: run.trace });
    return true;
  };
  const ctx: MockCtx = {
    now: () => now,
    later: () => () => undefined,
    ready,
    state: () => state,
    push: (patch) => {
      state = { ...state, ...patch, rev: state.rev + 1 };
    },
    blobs: {
      put: (text) => {
        const hash = fakeHash(`text:${text}`);
        texts.set(hash, text);
        return hash;
      },
      set: (hash, text) => void texts.set(hash, text),
      get: (hash) => texts.get(hash),
    },
    play: (stream, steps, options) => {
      if (runs.has(stream)) return null;
      runs.set(stream, { steps, options, trace: new Trace(options.chatId ?? "", options.turn ?? stream, now), paused: false });
      return options.turn ?? stream;
    },
    stop: (stream, why) => {
      runs.get(stream)?.trace.ended("stopped", why);
      return end(stream, "stopped");
    },
    pause: (stream, on) => {
      const run = runs.get(stream);
      if (!run) return false;
      run.paused = on;
      return true;
    },
    settings: () => undefined,
    keep: (_stream, trace) => fakeHash(`transcript:${trace.turn}`),
  };
  const handlers = jobsMock(ctx);
  const ask = async <K extends Mine>(type: K, body: UiRequests[K]["body"]): Promise<UiRequests[K]["result"]> => {
    // The table is keyed by the request's type, which TypeScript can't follow through the lookup.
    const handler = handlers[type] as (r: unknown) => UiRequests[K]["result"] | Promise<UiRequests[K]["result"]>;
    return handler({ lah: UI_VERSION, type, reqId: "t", ...body });
  };
  const all = async (): Promise<JobView[]> => (await ask("lah.jobs.list", { chatId: null, cursor: null, limit: 100 })).jobs;
  return {
    ask,
    /** Every job there is, newest first. */
    all,
    /** A job that stands in `wanted`: the made-up data has one of each state a job rests in. */
    byState: async (wanted: JobState): Promise<JobView> => {
      const job = (await all()).find((j) => j.state === wanted);
      if (!job) throw new Error(`the made-up data has no ${wanted} job`);
      return job;
    },
    /** A request's refusal, or its answer where it wasn't refused. */
    refused: async <K extends Mine>(type: K, body: UiRequests[K]["body"]): Promise<unknown> => ask(type, body).catch((error: unknown) => error),
    state: () => state,
    text: (hash: string | undefined) => (hash === undefined ? undefined : texts.get(hash)),
    run: (stream: string) => runs.get(stream),
    streams: () => [...runs.keys()],
    pass: (ms: number) => {
      now += ms;
    },
    /** A job's run plays to its end, its held call answered with `word`. */
    finish: (stream: string, word: HeldWord = { decision: "once" }) => {
      const run = runs.get(stream);
      if (!run) throw new Error(`no run under ${stream}`);
      for (const step of run.steps) step.run(run.trace, step.asks ? word : undefined);
      end(stream, "done");
    },
    /** A reply of a chat is under way, or none is. */
    replying: (chatId: string | null) => {
      const running: RunningTurn[] = chatId === null ? [] : [{ stream: chatId, chatId, turn: "turn-reply", kind: "new", startedAt: now, paused: false }];
      state = { ...state, running };
    },
  };
}

const START = { chatId: "chat-mara", agent: "archivist", task: "Bring notes/timeline.md up to date.", when: "now" } as const;

describe("what is there when the preview opens", () => {
  test("jobs in every state a job can rest in, for two chats", async () => {
    const w = world();
    const page = await w.ask("lah.jobs.list", { chatId: null, cursor: null, limit: 100 });
    expect(page.total).toBe(page.jobs.length);
    expect(page.next).toBeNull();
    expect(new Set(page.jobs.map((j) => j.state))).toEqual(new Set(["queued", "done", "failed", "cancelled", "interrupted", "off_path", "spent", "paused"]));
    expect(page.jobs.filter((j) => j.chatId === "chat-mara").length).toBeGreaterThanOrEqual(12);
    expect((await w.ask("lah.jobs.list", { chatId: "chat-brann", cursor: null, limit: 100 })).jobs.map((j) => j.id).sort()).toEqual(["job-brann-1", "job-brann-2"]);
    // Newest first.
    const times = page.jobs.map((j) => j.createdAt);
    expect(times).toEqual([...times].sort((a, b) => b - a));
    expect(page.limits.atOnce).toBeGreaterThan(0);
    expect(page.agents.map((a) => a.id)).toContain("archivist");
  });

  test("the jobs Live's turns name are there, the report under the hash Live points at", async () => {
    const w = world();
    const jobs = await w.all();
    const done = jobs.find((j) => j.id === "job-timeline-1");
    expect(done).toMatchObject({ state: "done", report: fakeHash("report:job-timeline-1"), opening: "Started notes/timeline.md: 14 lines, one a reply, from #17 to #43." });
    expect(w.text(done?.report)?.startsWith("Started notes/timeline.md")).toBe(true);
    expect(done?.reportChars).toBe(w.text(done?.report)?.length);
    expect(jobs.find((j) => j.id === "job-timeline-2")).toMatchObject({ state: "queued", when: "after_reply" });
  });

  test("a job that ran has a transcript; one the user started belongs to no turn", async () => {
    const jobs = await world().all();
    for (const job of jobs.filter((j) => j.startedAt !== undefined)) expect(job.transcript, job.id).toBe(fakeHash(`transcript:${job.id}`));
    expect(jobs.find((j) => j.id === "job-map-1")).toMatchObject({ state: "cancelled" });
    expect(jobs.find((j) => j.id === "job-map-1")?.transcript).toBeUndefined();
    for (const job of jobs.filter((j) => j.by.who === "user")) expect(job.basis, job.id).toBeNull();
  });

  test("the long objective stopped at its allowance, and one is held with no run", async () => {
    const w = world();
    const spent = await w.byState("spent");
    expect(spent).toMatchObject({ id: "job-story-so-far", allowance: { tokensIn: 200_000 } });
    expect(spent.usage.in).toBeGreaterThanOrEqual(200_000);
    expect(w.text(spent.report)).toContain("What is left");
    expect((await w.all()).some((j) => j.parent === spent.id)).toBe(true);
    const held = await w.byState("paused");
    expect(held).toMatchObject({ id: "job-paused", paused: true });
    expect(held.endedAt).toBeUndefined();
  });

  test("the state holds the jobs not yet over and two notices", () => {
    const w = world();
    expect(w.state().jobs).toMatchObject({ off: false, paused: false });
    expect(w.state().jobs.active.map((j) => j.id)).toEqual(["job-timeline-2"]);
    expect(w.state().notices.map((n) => n.kind).sort()).toEqual(["job_done", "job_interrupted"]);
    expect(w.streams()).toEqual([]);
  });

  test("nothing is there before anything was set up", async () => {
    const w = world(false);
    expect(await w.ask("lah.jobs.list", { chatId: null, cursor: null, limit: 10 })).toMatchObject({ jobs: [], next: null, total: 0, today: { tokens: 0 } });
    expect(w.state().jobs.active).toEqual([]);
    expect(w.state().notices).toEqual([]);
  });
});

describe("reading the list a page at a time", () => {
  test("each page starts after the last, and all of them are every job once", async () => {
    const w = world();
    const total = (await w.all()).length;
    const seen: string[] = [];
    let cursor: string | null = null;
    do {
      const page: JobsPage = await w.ask("lah.jobs.list", { chatId: null, cursor, limit: 5 });
      expect(page.jobs.length).toBeLessThanOrEqual(5);
      seen.push(...page.jobs.map((j) => j.id));
      cursor = page.next;
    } while (cursor !== null);
    expect(seen.length).toBe(total);
    expect(new Set(seen).size).toBe(total);
  });

  test("a place the list never gave is refused", async () => {
    expect(await world().refused("lah.jobs.list", { chatId: null, cursor: "nowhere", limit: 5 })).toMatchObject({ code: "invalid" });
  });
});

describe("starting a job by hand", () => {
  test("it plays under its own id, holds a call for the user's word, and ends done with a report and a notice", async () => {
    const w = world();
    const before = w.state().jobs.changed;
    const { job } = await w.ask("lah.job.start", START);
    expect(job).toMatchObject({ state: "running", chatId: "chat-mara", agent: "archivist", by: { who: "user" }, basis: null });
    expect(w.state().jobs.changed).toBeGreaterThan(before);
    expect(w.state().jobs.active.find((j) => j.id === job.id)?.state).toBe("running");
    const run = w.run(job.id);
    expect(run?.options).toMatchObject({ reply: false, chatId: "chat-mara", turn: job.id });
    expect(run?.steps.filter((s) => s.asks !== undefined).map((s) => s.asks?.tier)).toEqual(["write"]);
    w.pass(9000);
    w.finish(job.id);
    const done = (await w.all()).find((j) => j.id === job.id);
    expect(done).toMatchObject({ state: "done", transcript: fakeHash(`transcript:${job.id}`), workedMs: 9000 });
    expect(done?.usage.calls).toBeGreaterThan(0);
    expect(w.text(done?.report)).toContain("once you allowed the write");
    expect(done?.opening).toBe(w.text(done?.report)?.split("\n\n")[0]);
    expect(w.state().jobs.active.some((j) => j.id === job.id)).toBe(false);
    expect(w.state().notices[0]).toMatchObject({ kind: "job_done", jobId: job.id, chatId: "chat-mara" });
    // What it spent counts toward the day's.
    expect((await w.ask("lah.jobs.list", { chatId: null, cursor: null, limit: 1 })).today.tokens).toBeGreaterThan(0);
  });

  test("its report says so when the write was refused", async () => {
    const w = world();
    const { job } = await w.ask("lah.job.start", START);
    w.finish(job.id, { decision: "refused", reason: "not now" });
    const done = (await w.all()).find((j) => j.id === job.id);
    expect(done?.state).toBe("done");
    expect(w.text(done?.report)).toContain("Nothing was written");
  });

  test("an allowance of its own is kept on the job", async () => {
    const w = world();
    const { job } = await w.ask("lah.job.start", { ...START, allowance: { tokensIn: 200_000, wallMs: null } });
    expect(job.allowance).toEqual({ tokensIn: 200_000, wallMs: null });
  });

  test("one to start after the next reply waits until a reply of its chat was written", async () => {
    const w = world();
    const { job } = await w.ask("lah.job.start", { ...START, when: "after_reply" });
    expect(job.state).toBe("queued");
    expect(w.run(job.id)).toBeUndefined();
    w.replying("chat-mara");
    await w.all();
    expect(w.run(job.id)).toBeUndefined();
    w.replying(null);
    expect((await w.all()).find((j) => j.id === job.id)?.state).toBe("running");
    expect(w.run(job.id)).toBeDefined();
  });

  test("no more run at once than the limit allows; the next starts when a place is free", async () => {
    const w = world();
    const limit = (await w.ask("lah.jobs.list", { chatId: null, cursor: null, limit: 1 })).limits.atOnce;
    const started = [];
    for (let i = 0; i <= limit; i += 1) started.push((await w.ask("lah.job.start", START)).job);
    const expected: JobState[] = [...Array.from({ length: limit }, (): JobState => "running"), "queued"];
    expect(started.map((j) => j.state)).toEqual(expected);
    const first = started[0];
    const last = started.at(-1);
    if (!first || !last) throw new Error("nothing was started");
    w.finish(first.id);
    expect((await w.all()).find((j) => j.id === last.id)?.state).toBe("running");
  });

  test("what the real backend would refuse is refused in words", async () => {
    const w = world();
    expect(await w.refused("lah.job.start", { ...START, chatId: "chat-nowhere" })).toMatchObject({ code: "not_found" });
    expect(await w.refused("lah.job.start", { ...START, agent: "nobody" })).toMatchObject({ code: "not_found" });
    expect(await w.refused("lah.job.start", { ...START, task: "   " })).toMatchObject({ code: "invalid", problems: [{ path: ["task"] }] });
    expect(await w.refused("lah.job.start", { ...START, task: "x".repeat(4001) })).toMatchObject({ code: "invalid", problems: [{ path: ["task"] }] });
    expect(w.streams()).toEqual([]);
  });
});

describe("the user's switches", () => {
  test("Off refuses a start, in words that say where to switch jobs on", async () => {
    const w = world();
    expect(await w.ask("lah.jobs.set", { off: true })).toEqual({ off: true, paused: false });
    expect(w.state().jobs.off).toBe(true);
    const refusal = await w.refused("lah.job.start", START);
    expect(refusal).toBeInstanceOf(Refusal);
    expect(refusal).toMatchObject({ code: "unavailable", message: expect.stringContaining("Switch them on at the top of the Jobs page") });
    expect(await w.refused("lah.job.again", { id: (await w.byState("failed")).id })).toMatchObject({ code: "unavailable" });
    expect(await w.ask("lah.jobs.set", { off: false })).toEqual({ off: false, paused: false });
    expect((await w.ask("lah.job.start", START)).job.state).toBe("running");
  });

  test("Paused holds what would start as queued, and letting go starts it", async () => {
    const w = world();
    expect(await w.ask("lah.jobs.set", { paused: true })).toEqual({ off: false, paused: true });
    const { job } = await w.ask("lah.job.start", START);
    expect(job.state).toBe("queued");
    expect(w.run(job.id)).toBeUndefined();
    await w.ask("lah.jobs.set", { paused: false });
    expect(w.state().jobs).toMatchObject({ paused: false });
    expect(w.state().jobs.active.find((j) => j.id === job.id)?.state).toBe("running");
    expect(w.run(job.id)).toBeDefined();
  });

  test("Paused holds what runs at its next round, and letting go resumes it", async () => {
    const w = world();
    const { job } = await w.ask("lah.job.start", START);
    await w.ask("lah.jobs.set", { paused: true });
    expect(w.run(job.id)?.paused).toBe(true);
    expect(w.state().jobs.active.find((j) => j.id === job.id)).toMatchObject({ state: "running", paused: true });
    await w.ask("lah.jobs.set", { paused: false });
    expect(w.run(job.id)?.paused).toBe(false);
    expect(w.state().jobs.active.find((j) => j.id === job.id)?.paused).toBeUndefined();
  });
});

describe("cancelling and starting again", () => {
  test("a waiting job is cancelled where it stands", async () => {
    const w = world();
    const { job } = await w.ask("lah.job.cancel", { id: "job-timeline-2" });
    expect(job).toMatchObject({ state: "cancelled", reason: expect.stringContaining("before it started") });
    expect(w.state().jobs.active).toEqual([]);
    expect(await w.refused("lah.job.cancel", { id: "job-timeline-2" })).toMatchObject({ code: "conflict" });
  });

  test("a running job's run is stopped, and no notice tells the user what they did themselves", async () => {
    const w = world();
    const { job } = await w.ask("lah.job.start", START);
    const notices = w.state().notices.length;
    const cancelled = await w.ask("lah.job.cancel", { id: job.id });
    expect(cancelled.job).toMatchObject({ state: "cancelled", reason: "You cancelled it." });
    expect(cancelled.job.endedAt).toBeDefined();
    expect(w.run(job.id)).toBeUndefined();
    expect(w.state().notices.length).toBe(notices);
  });

  test("a job that ended badly is started again as a new job with the same agent and its whole task", async () => {
    const w = world();
    const failed = await w.byState("interrupted");
    const { job } = await w.ask("lah.job.again", { id: failed.id });
    expect(job).toMatchObject({ again: failed.id, agent: failed.agent, chatId: failed.chatId, by: { who: "user" }, state: "running" });
    expect(job.id).not.toBe(failed.id);
    expect((await w.all()).find((j) => j.id === failed.id)?.state).toBe("interrupted");
  });

  test("a job that did not end badly can't be started again, and one that isn't there is not found", async () => {
    const w = world();
    expect(await w.refused("lah.job.again", { id: "job-timeline-1" })).toMatchObject({ code: "conflict" });
    expect(await w.refused("lah.job.again", { id: "job-timeline-2" })).toMatchObject({ code: "conflict" });
    expect(await w.refused("lah.job.again", { id: "job-nowhere" })).toMatchObject({ code: "not_found" });
    expect(await w.refused("lah.job.cancel", { id: "job-nowhere" })).toMatchObject({ code: "not_found" });
  });
});

describe("a long objective", () => {
  test("granted more, a job that stopped at its allowance runs on and adds to what it had spent", async () => {
    const w = world();
    const spent = await w.byState("spent");
    const { job } = await w.ask("lah.job.grant", { id: spent.id, allowance: { tokensIn: 400_000, tokensOut: 40_000 } });
    expect(job).toMatchObject({ id: spent.id, state: "running", allowance: { tokensIn: 400_000, tokensOut: 40_000 }, startedAt: spent.startedAt });
    expect(job.reason).toBeUndefined();
    expect(job.endedAt).toBeUndefined();
    w.pass(5000);
    w.finish(spent.id);
    const done = (await w.all()).find((j) => j.id === spent.id);
    expect(done?.state).toBe("done");
    expect(done?.usage.calls).toBeGreaterThan(spent.usage.calls);
    expect(done?.usage.in).toBeGreaterThan(spent.usage.in);
    expect(done?.workedMs).toBe((spent.workedMs ?? 0) + 5000);
  });

  test("resumed, a job a restart left paused runs again", async () => {
    const w = world();
    const held = await w.byState("paused");
    const { job } = await w.ask("lah.job.resume", { id: held.id });
    expect(job).toMatchObject({ id: held.id, state: "running" });
    expect(job.paused).toBeUndefined();
    expect(w.run(held.id)).toBeDefined();
  });

  test("both wait while jobs are paused", async () => {
    const w = world();
    await w.ask("lah.jobs.set", { paused: true });
    expect((await w.ask("lah.job.grant", { id: "job-story-so-far", allowance: { tokensIn: null } })).job.state).toBe("queued");
    expect((await w.ask("lah.job.resume", { id: "job-paused" })).job.state).toBe("queued");
    expect(w.streams()).toEqual([]);
  });

  test("only a job that stands so can be granted more or resumed", async () => {
    const w = world();
    expect(await w.refused("lah.job.grant", { id: "job-timeline-1", allowance: {} })).toMatchObject({ code: "conflict" });
    expect(await w.refused("lah.job.resume", { id: "job-story-so-far" })).toMatchObject({ code: "conflict" });
    const { job } = await w.ask("lah.job.start", START);
    expect(await w.refused("lah.job.resume", { id: job.id })).toMatchObject({ code: "conflict", message: expect.stringContaining("bar under its work") });
    expect(await w.refused("lah.job.grant", { id: "job-nowhere", allowance: {} })).toMatchObject({ code: "not_found" });
  });
});

describe("notices", () => {
  test("one is dismissed, then all", async () => {
    const w = world();
    const [first] = w.state().notices;
    if (!first) throw new Error("the made-up data has no notice");
    expect((await w.ask("lah.notice.dismiss", { id: first.id })).notices.map((n) => n.id)).not.toContain(first.id);
    expect(w.state().notices.length).toBe(1);
    // Dismissed again from another page: nothing left of it to dismiss, and no failure.
    expect((await w.ask("lah.notice.dismiss", { id: first.id })).notices.length).toBe(1);
    expect(await w.ask("lah.notice.dismiss", { id: null })).toEqual({ notices: [] });
    expect(w.state().notices).toEqual([]);
  });
});

describe("the contract test's sequence", () => {
  test("each request succeeds in the order the shared test sends them", async () => {
    const w = world();
    const jobs = (await w.ask("lah.jobs.list", { chatId: null, cursor: null, limit: 50 })).jobs;
    const queued = jobs.find((j) => j.state === "queued");
    const again = jobs.find((j) => j.state === "interrupted" || j.state === "failed" || j.state === "cancelled");
    const spent = jobs.find((j) => j.state === "spent");
    const held = jobs.find((j) => j.state === "paused");
    if (!queued || !again || !spent || !held) throw new Error("the list lacks a queued job, one that ended badly, a spent one or a paused one");
    expect(await w.ask("lah.jobs.set", { paused: true })).toEqual({ off: false, paused: true });
    w.pass(10_000);
    expect((await w.ask("lah.job.start", { ...START, allowance: { tokensIn: 200_000, wallMs: null } })).job.state).toBe("queued");
    w.pass(10_000);
    expect((await w.ask("lah.job.cancel", { id: queued.id })).job.state).toBe("cancelled");
    w.pass(10_000);
    expect((await w.ask("lah.job.again", { id: again.id })).job.state).toBe("queued");
    w.pass(10_000);
    expect((await w.ask("lah.job.grant", { id: spent.id, allowance: { tokensIn: 400_000, tokensOut: 40_000 } })).job.state).toBe("queued");
    w.pass(10_000);
    expect((await w.ask("lah.job.resume", { id: held.id })).job.state).toBe("queued");
    w.pass(10_000);
    expect(await w.ask("lah.notice.dismiss", { id: null })).toEqual({ notices: [] });
  });
});
