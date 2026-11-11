// What the Jobs page says of jobs (DESIGN §15, §22): how each state is named and signed, what can be
// done to a job as it stands, which jobs the list shows and in what order, what a job spent and may
// spend in words, the limits in force, and when the start form and a grant can be sent.

import { describe, expect, test } from "bun:test";
import { count, duration } from "../../src/extension/frontend/format";
import {
  agentName,
  ALLOWANCE_FIELDS,
  allowanceDraft,
  allowanceFacts,
  allowanceOf,
  clipped,
  countLine,
  dayUse,
  draftAgent,
  grantBlock,
  heldStreams,
  jobActions,
  jobBadge,
  jobFacts,
  jobOver,
  jobPaused,
  jobSentence,
  limitFacts,
  needingUser,
  NO_DRAFT,
  noWorkWords,
  openJob,
  REASON_TITLES,
  reportName,
  rowLine,
  settingsAllowanceWords,
  shownJobs,
  sortJobs,
  startBlock,
  startedBy,
  startNote,
  usageFacts,
  usageLine,
  whenWords,
} from "../../src/extension/frontend/jobs-model";
import type { AgentUsage, ApprovalView, JobState, JobView, JobsPage, RunningTurn } from "../../src/shared/ui";

const T0 = Date.UTC(2026, 10, 10, 9, 0, 0);
const STATES: readonly JobState[] = ["queued", "running", "done", "failed", "cancelled", "interrupted", "off_path", "spent", "paused"];
const AGENTS = [
  { id: "archivist", name: "Archivist" },
  { id: "reader", name: "Reader" },
];
const LIMITS: JobsPage["limits"] = { atOnce: 2, tokensPerJob: 60_000, msPerJob: 900_000, tokensPerDay: 400_000 };
const NO_SWITCH = { off: false, paused: false };
const NONE: ReadonlySet<string> = new Set();

const usage = (over: Partial<AgentUsage> = {}): AgentUsage => ({ calls: 4, toolTurns: 3, in: 9200, cachedIn: 6100, out: 410, reasoningOut: 60, estimated: false, ms: 21_400, cost: 0.0014, ...over });
const nothing = usage({ calls: 0, toolTurns: 0, in: 0, cachedIn: 0, out: 0, reasoningOut: 0, ms: 0, cost: 0 });
const job = (over: Partial<JobView> = {}): JobView => ({ id: "job-1", chatId: "chat-mara", agent: "archivist", task: "Bring notes/timeline.md up to date.", when: "now", state: "queued", by: { who: "user" }, basis: null, createdAt: T0, usage: nothing, ...over });
const running = (stream: string, paused: boolean): RunningTurn => ({ stream, chatId: "chat-mara", turn: stream, kind: "job", startedAt: T0, paused });
const approval = (stream: string): ApprovalView => ({ id: `held-${stream}`, stream, turn: stream, chatId: "chat-mara", agentId: "archivist-1", role: "archivist", callId: "call_1", tool: "workspace_write", tier: "write", args: {}, at: T0, until: null });

describe("a job's state", () => {
  test("every state has a word, a tint and a sign of its own kind", () => {
    for (const state of STATES) {
      const badge = jobBadge(job({ state }));
      expect(badge.word, state).not.toBe("");
      expect(badge.icon, state).not.toBe("");
      expect(REASON_TITLES[state], state).not.toBe("");
    }
    expect(jobBadge(job({ state: "off_path" })).word).toBe("off the path");
    expect(jobBadge(job({ state: "done" }))).toMatchObject({ word: "done", tone: "pos" });
    expect(jobBadge(job({ state: "failed" }))).toMatchObject({ word: "failed", tone: "neg" });
    // The word a first-time user reads is budget, on the badge and in the sentence under it.
    expect(jobBadge(job({ state: "spent" }))).toMatchObject({ word: "out of budget", tone: "warn" });
    expect(jobBadge(job({ state: "spent", stoppedAt: "day" }))).toMatchObject({ word: "at a day's limit", tone: "warn" });
  });

  test("a running job the user holds says paused, whether its own view or its run says so", () => {
    expect(jobBadge(job({ state: "running" })).word).toBe("running");
    expect(jobBadge(job({ state: "running", paused: true }))).toMatchObject({ word: "paused", tone: "warn", icon: "pause" });
    const held = heldStreams([running("job-1", true), running("job-2", false)]);
    expect(jobPaused(job({ state: "running" }), held)).toBe(true);
    expect(jobPaused(job({ id: "job-2", state: "running" }), held)).toBe(false);
    // A job that waits isn't held, whatever its run would say.
    expect(jobPaused(job({ state: "queued", paused: true }), held)).toBe(false);
    // One a restart left paused has no run, and says paused all the same.
    expect(jobBadge(job({ state: "paused", paused: true })).word).toBe("paused");
  });

  test("a sentence says what the state means for the job", () => {
    expect(jobSentence(job(), NONE, { off: true, paused: false })).toContain("switched off");
    expect(jobSentence(job(), NONE, { off: false, paused: true })).toContain("paused");
    expect(jobSentence(job({ when: "after_reply" }), NONE, NO_SWITCH)).toContain("chat's next reply");
    expect(jobSentence(job({ when: "after_reply", by: { who: "agent", id: "main-1", role: "main" } }), NONE, NO_SWITCH)).toContain("its turn's reply");
    expect(jobSentence(job(), NONE, NO_SWITCH)).toContain("Waiting for a place");
    expect(jobSentence(job({ state: "running" }), NONE, NO_SWITCH)).toContain("Running");
    expect(jobSentence(job({ state: "running" }), new Set(["job-1"]), NO_SWITCH)).toContain("Paused");
    expect(jobSentence(job({ state: "interrupted" }), NONE, NO_SWITCH)).toContain("started again");
    expect(jobSentence(job({ state: "off_path", report: "a".repeat(64) }), NONE, NO_SWITCH)).toContain("marked off the path");
    expect(jobSentence(job({ state: "spent" }), NONE, NO_SWITCH)).toBe("Out of budget: it stopped when what it may spend ran out. Give it more and it carries on from where it stopped.");
    expect(jobSentence(job({ state: "spent", stoppedAt: "day" }), NONE, NO_SWITCH)).toContain("Paused at a day's limit: nothing of it is lost");
    expect(jobSentence(job({ state: "paused" }), NONE, NO_SWITCH)).toContain("Resume it");
  });

  test("what can be done follows the state", () => {
    const can = (state: JobState): string[] => Object.entries(jobActions({ state })).flatMap(([name, on]) => (on ? [name] : []));
    expect(can("queued")).toEqual(["cancel"]);
    expect(can("running")).toEqual(["cancel"]);
    expect(can("done")).toEqual([]);
    expect(can("off_path")).toEqual([]);
    for (const state of ["failed", "cancelled", "interrupted"] as const) expect(can(state), state).toEqual(["again"]);
    expect(can("spent")).toEqual(["grant"]);
    expect(can("paused")).toEqual(["resume"]);
  });

  test("a job is over once it neither waits nor runs", () => {
    expect(STATES.filter((state) => !jobOver({ state }))).toEqual(["queued", "running"]);
  });

  test("a job whose run holds a tool call needs the user", () => {
    const needs = needingUser([approval("job-2"), approval("chat-mara")]);
    expect(needs.has("job-2")).toBe(true);
    expect(needs.has("job-1")).toBe(false);
  });
});

describe("the list", () => {
  test("the newest job comes first, and two of one instant never swap", () => {
    const list = [job({ id: "a", createdAt: T0 }), job({ id: "c", createdAt: T0 + 5 }), job({ id: "b", createdAt: T0 })];
    expect(sortJobs(list).map((j) => j.id)).toEqual(["c", "b", "a"]);
    expect(sortJobs([...list].reverse()).map((j) => j.id)).toEqual(["c", "b", "a"]);
  });

  test("a job not yet over shows as the state has it now", () => {
    const listed = [job({ id: "a", state: "queued" })];
    const shown = shownJobs(listed, [job({ id: "a", state: "running", startedAt: T0 + 10 })], "chat-mara", false);
    expect(shown.map((j) => [j.id, j.state])).toEqual([["a", "running"]]);
  });

  test("a job the list says is over stays over", () => {
    const listed = [job({ id: "a", state: "done" })];
    expect(shownJobs(listed, [job({ id: "a", state: "running" })], "chat-mara", false)[0]?.state).toBe("done");
  });

  test("a job started since the read stands on top; another chat's stays out of a chat's list", () => {
    const listed = [job({ id: "a", createdAt: T0 })];
    const active = [job({ id: "b", createdAt: T0 + 60_000 }), job({ id: "x", chatId: "chat-brann", createdAt: T0 + 90_000 })];
    expect(shownJobs(listed, active, "chat-mara", false).map((j) => j.id)).toEqual(["b", "a"]);
    expect(shownJobs(listed, active, null, false).map((j) => j.id)).toEqual(["x", "b", "a"]);
  });

  test("a waiting job older than the last row read belongs to a page not read yet", () => {
    const listed = [job({ id: "a", state: "done", createdAt: T0 })];
    const old = job({ id: "old", createdAt: T0 - 60_000 });
    expect(shownJobs(listed, [old], "chat-mara", true).map((j) => j.id)).toEqual(["a"]);
    // With no page left to read it is simply one more job.
    expect(shownJobs(listed, [old], "chat-mara", false).map((j) => j.id)).toEqual(["a", "old"]);
  });

  test("the job open is found in the list, else among those not yet over", () => {
    const shown = [job({ id: "a" })];
    const active = [job({ id: "far", chatId: "chat-okoro", state: "running" })];
    expect(openJob("a", shown, active)?.id).toBe("a");
    expect(openJob("far", shown, active)?.chatId).toBe("chat-okoro");
    expect(openJob("gone", shown, active)).toBeNull();
    expect(openJob(null, shown, active)).toBeNull();
  });

  test("the head counts the jobs, and says when not all show", () => {
    expect(countLine(1, 1, "chat")).toBe("1 job of this chat, newest first.");
    expect(countLine(14, 5, "all")).toBe("14 jobs in every chat, newest first; 5 shown.");
  });
});

describe("a job in words", () => {
  test("its agent by its definition's name, else by its id", () => {
    expect(agentName("archivist", AGENTS)).toBe("Archivist");
    expect(agentName("cartographer", AGENTS)).not.toBe("");
  });

  test("who started it and when it was to start", () => {
    expect(startedBy(job())).toBe("you");
    expect(startedBy(job({ by: { who: "agent", id: "main-1", role: "main" } }))).toContain("ain");
    expect(whenWords(job())).toBe("At once");
    expect(whenWords(job({ when: "after_reply" }))).toBe("After the chat's next reply");
    expect(whenWords(job({ when: "after_reply", by: { who: "agent", id: "main-1", role: "main" } }))).toBe("Once its turn's reply was written");
  });

  test("what it spent, shortly", () => {
    expect(usageLine(usage(), true)).toBe("4 calls · 9.2k in · 410 out · $0.0014 · 21.4 s");
    expect(usageLine(usage({ estimated: true }), true)).toContain("≈9.2k in · ≈410 out");
    expect(usageLine(nothing, false)).toBe("nothing spent yet");
    expect(usageLine(nothing, true)).toBe("nothing spent");
  });

  test("its row says who, when and what it spent", () => {
    const line = rowLine(job({ state: "done", usage: usage() }), T0 + 5 * 60_000);
    expect(line).toBe("by you · 5 min ago · 4 calls · 9.2k in · 410 out · $0.0014 · 21.4 s");
  });

  test("what it spent, a figure a card: a call without a price is said", () => {
    const facts = usageFacts(usage());
    expect(facts.map((f) => f.label)).toEqual(["Model calls", "Tokens in", "Tokens out", "Cost", "Time in the model"]);
    expect(facts[1]).toEqual({ label: "Tokens in", value: count(9200), sub: `${count(6100)} read from the cache` });
    const { cost: _unpriced, ...unpriced } = usage();
    expect(usageFacts(unpriced)[3]?.sub).toBe("a call had no price");
    expect(usageFacts(nothing)[3]).toEqual({ label: "Cost", value: "$0" });
  });

  test("what is known of it: a job the user started belongs to the chat, not a turn", () => {
    const facts = jobFacts(job(), { agents: AGENTS, chat: "Mara at the harbour", now: T0 + 1000 });
    const of = (label: string) => facts.find((f) => f.label === label);
    expect(of("Agent")).toEqual({ label: "Agent", value: "Archivist", sub: "archivist" });
    expect(of("Belongs to")?.value).toBe("The chat, not a turn");
    expect(of("Chat")?.value).toBe("Mara at the harbour");
    expect(of("Started by")?.value).toBe("You, on this page");
    expect(of("Started")).toBeUndefined();
    const agents = jobFacts(job({ by: { who: "agent", id: "main-1", role: "main" }, basis: "turn-0043" }), { agents: AGENTS, chat: "c", now: T0 });
    expect(agents.find((f) => f.label === "Belongs to")?.value).toBe("Turn turn-0043");
    expect(agents.find((f) => f.label === "Started by")?.sub).toBe("main-1");
  });

  test("only a job that runs counts its seconds; one that worked says for how long, and one a job started says which", () => {
    const labels = (j: JobView): string[] => jobFacts(j, { agents: AGENTS, chat: "c", now: T0 + 42_000 }).map((f) => f.label);
    expect(labels(job({ state: "running", startedAt: T0 }))).toContain("Running for");
    // A job a restart left paused has started and not ended, yet nothing of it runs.
    expect(labels(job({ state: "paused", startedAt: T0 }))).not.toContain("Running for");
    expect(labels(job({ state: "done", startedAt: T0, endedAt: T0 + 30_000, workedMs: 30_000 }))).toEqual(expect.arrayContaining(["Started", "Ended", "Worked for"]));
    const child = jobFacts(job({ parent: "job-story" }), { agents: AGENTS, chat: "c", now: T0 });
    expect(child.find((f) => f.label === "Started from")?.value).toBe("Job job-story");
  });

  test("where its work would show, words say why there is none", () => {
    expect(noWorkWords(job())).toContain("hasn't started");
    expect(noWorkWords(job({ state: "running", startedAt: T0 }))).toContain("starting");
    expect(noWorkWords(job({ state: "cancelled" }))).toContain("never started");
    expect(noWorkWords(job({ state: "done", startedAt: T0 }))).toBe("No transcript of its work was kept.");
  });

  test("its report's file name takes any id", () => {
    expect(reportName({ id: "job-timeline-1" })).toBe("lumiah-job-job-timeline-1-report.md");
    expect(reportName({ id: "a/b:c d" })).toBe("lumiah-job-a-b-c-d-report.md");
  });

  test("a long text shows its start and says how much is left", () => {
    expect(clipped("abcdef", 4)).toEqual({ shown: "abcd", rest: 2 });
    expect(clipped("abc", 4)).toEqual({ shown: "abc", rest: 0 });
  });
});

describe("the limits in force", () => {
  test("each limit as a figure, or no limit", () => {
    expect(limitFacts(LIMITS).map((f) => f.value)).toEqual(["2", count(60_000), duration(900_000)]);
    expect(limitFacts({ atOnce: 1, tokensPerJob: null, msPerJob: null, tokensPerDay: null }).map((f) => f.value)).toEqual(["1", "No limit", "No limit"]);
  });

  test("today's tokens against the day's", () => {
    const part = dayUse(LIMITS, { tokens: 100_000 });
    expect(part).toMatchObject({ fraction: 0.25, reached: false });
    expect(part.words).toContain("25%");
    const full = dayUse(LIMITS, { tokens: 400_000 });
    expect(full).toMatchObject({ fraction: 1, reached: true });
    expect(full.words).toContain("reached");
    const free = dayUse({ ...LIMITS, tokensPerDay: null }, { tokens: 12 });
    expect(free).toMatchObject({ fraction: null, reached: false });
    expect(free.words).toBe("12 tokens today. No limit a day is set.");
  });
});

describe("starting a job", () => {
  test("the agent is the one picked while it is offered, else the first", () => {
    expect(draftAgent({ ...NO_DRAFT, agent: "reader" }, AGENTS)).toBe("reader");
    expect(draftAgent({ ...NO_DRAFT, agent: "gone" }, AGENTS)).toBe("archivist");
    expect(draftAgent(NO_DRAFT, [])).toBeNull();
  });

  test("the form says what is missing, in the order to mend it", () => {
    const full = { ...NO_DRAFT, task: "Note the tides." };
    expect(startBlock(full, null, AGENTS)).toContain("Open a chat");
    expect(startBlock(full, "chat-mara", [])).toContain("No agent");
    expect(startBlock({ ...NO_DRAFT, task: "  \n " }, "chat-mara", AGENTS)).toContain("Write its task");
    expect(startBlock(full, "chat-mara", AGENTS)).toBeNull();
  });

  test("the switches are said before a start is sent", () => {
    expect(startNote(NO_SWITCH)).toBeNull();
    expect(startNote({ off: true, paused: true })).toContain("switched off");
    expect(startNote({ off: false, paused: true })).toContain("waits until you resume");
  });
});

describe("an allowance", () => {
  test("a new one leaves every member to Settings, and asks for nothing", () => {
    const draft = allowanceDraft(undefined, LIMITS);
    expect(ALLOWANCE_FIELDS.map((f) => draft[f.key].mode)).toEqual(["settings", "settings", "settings", "settings"]);
    expect(allowanceOf(draft)).toEqual({});
    // The time starts from Settings' own figure, in minutes.
    expect(draft.wallMs.value).toBe(15);
  });

  test("the form holds what a job had, with the time in minutes, and gives it back the same", () => {
    const had = { tokensIn: 200_000, tokensOut: null, wallMs: 30 * 60_000 };
    const draft = allowanceDraft(had, LIMITS);
    expect(draft.tokensIn).toEqual({ mode: "set", value: 200_000 });
    expect(draft.tokensOut.mode).toBe("none");
    expect(draft.toolTurns.mode).toBe("settings");
    expect(draft.wallMs).toEqual({ mode: "set", value: 30 });
    expect(allowanceOf(draft)).toEqual(had);
  });

  test("a figure typed is kept while another choice is tried", () => {
    const draft = allowanceDraft({ tokensIn: 50_000 }, null);
    const lifted = { ...draft, tokensIn: { ...draft.tokensIn, mode: "none" as const } };
    expect(allowanceOf(lifted)).toEqual({ tokensIn: null });
    expect(allowanceOf({ ...lifted, tokensIn: { ...lifted.tokensIn, mode: "set" as const } })).toEqual({ tokensIn: 50_000 });
  });

  test("a job's allowance against what it spent, a line a member it names", () => {
    const facts = allowanceFacts({ allowance: { tokensIn: 200_000, tokensOut: 20_000, toolTurns: null, wallMs: 30 * 60_000 }, usage: usage({ in: 200_840, out: 5000, toolTurns: 31 }), workedMs: 15 * 60_000 });
    expect(facts.map((f) => f.label)).toEqual(["Tokens in", "Tokens out", "Rounds of tool calls", "Time"]);
    expect(facts[0]).toEqual({ label: "Tokens in", value: `${count(200_840)} of ${count(200_000)}`, sub: "used up" });
    expect(facts[1]?.sub).toBe("25% used");
    expect(facts[2]).toEqual({ label: "Rounds of tool calls", value: "31 used", sub: "no limit" });
    expect(facts[3]).toEqual({ label: "Time", value: `${duration(15 * 60_000)} of ${duration(30 * 60_000)}`, sub: "50% used" });
    expect(allowanceFacts({ usage: usage() })).toEqual([]);
  });

  test("a grant that changes nothing isn't sent", () => {
    const had = { tokensIn: 200_000 };
    const same = allowanceDraft(had, LIMITS);
    expect(grantBlock(same, had)).toContain("Nothing is changed");
    expect(grantBlock({ ...same, tokensIn: { mode: "set", value: 400_000 } }, had)).toBeNull();
    expect(grantBlock({ ...same, tokensIn: { mode: "none", value: 200_000 } }, had)).toBeNull();
  });

  test("without one, Settings' limits for each job are said", () => {
    expect(settingsAllowanceWords(LIMITS)).toBe(`Settings' limits for each job stand: ${count(60_000)} tokens, and ${duration(900_000)}.`);
    expect(settingsAllowanceWords({ ...LIMITS, tokensPerJob: null, msPerJob: null })).toContain("any number of tokens, and as long as it needs");
  });
});
