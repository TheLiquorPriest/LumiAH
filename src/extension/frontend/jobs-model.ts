// What the Jobs page decides (DESIGN §15), apart from drawing it: how a job's state is said and
// tinted, what can be done to a job as it stands, which jobs the list shows and in what order (the
// list as read, with the live changes of the jobs not yet over laid over it), what a job spent in
// words, the limits in force, which jobs need the user, and whether the start form can be sent.
// Pure, so it is tested without a DOM; the page renders what these give.

import type { AgentUsage, ApprovalView, JobAllowance, JobState, JobView, JobsPage, JobWhen, RunningTurn } from "../../shared/ui";
import { ago, compact, count, counted, dateTime, duration, elapsed } from "./format";
import type { IconName } from "./icons";
import { costWords, JOB_STATE_WORDS, roleLabel } from "./live-model";
import { CACHED_NOTE, fractionOf, percentWords, sentBeside } from "./spend-model";

/** How a badge is tinted: the shared Badge's own tones, named here so the model needs no component. */
export type JobTone = "neutral" | "accent" | "pos" | "neg" | "warn";

/** A job's state as its badge says it: a word, a tint, and a sign, so the tint never says it alone. */
export interface JobBadge {
  word: string;
  tone: JobTone;
  icon: IconName;
}

const STATE_TONE: Readonly<Record<JobState, JobTone>> = { queued: "neutral", running: "accent", done: "pos", failed: "neg", cancelled: "neutral", interrupted: "warn", off_path: "warn", spent: "warn", paused: "warn" };

const STATE_ICON: Readonly<Record<JobState, IconName>> = { queued: "hourglass", running: "pulse", done: "check", failed: "alert", cancelled: "close", interrupted: "bolt", off_path: "branch", spent: "coins", paused: "pause" };

const NO_STREAMS: ReadonlySet<string> = new Set();

/** A job that is over: it has its report, or never will. */
export function jobOver(job: Pick<JobView, "state">): boolean {
  return job.state !== "queued" && job.state !== "running";
}

/** The streams of the runs the user holds: a job's run goes by the job's id. */
export function heldStreams(running: readonly RunningTurn[]): Set<string> {
  return new Set(running.filter((r) => r.paused).map((r) => r.stream));
}

/** The streams of the runs that hold a tool call for the user's word: a job whose id is among them needs the user. */
export function needingUser(approvals: readonly ApprovalView[]): Set<string> {
  return new Set(approvals.map((a) => a.stream));
}

/** Whether a job that runs is held: its own view says so, or its run's does (it was held from its live view, and the job's view follows a moment later). */
export function jobPaused(job: JobView, held: ReadonlySet<string> = NO_STREAMS): boolean {
  return job.state === "running" && (job.paused === true || held.has(job.id));
}

export function jobBadge(job: JobView, held: ReadonlySet<string> = NO_STREAMS): JobBadge {
  if (jobPaused(job, held)) return { word: "paused", tone: "warn", icon: "pause" };
  // A day's limit stopped it, not its own allowance: it has used nothing up, and waits for the day to count less.
  if (job.state === "spent" && job.stoppedAt === "day") return { word: "at a day's limit", tone: "warn", icon: "clock" };
  return { word: JOB_STATE_WORDS[job.state], tone: STATE_TONE[job.state], icon: STATE_ICON[job.state] };
}

/** The user's switches over all jobs. */
export interface Switches {
  off: boolean;
  paused: boolean;
}

/** Where a job stands, in a sentence that says what that means for it. */
export function jobSentence(job: JobView, held: ReadonlySet<string>, switches: Switches): string {
  switch (job.state) {
    case "queued":
      if (switches.off) return "Waiting: jobs are switched off, so it starts only once you switch them on.";
      if (switches.paused) return "Waiting: jobs are paused, so it starts once you resume them.";
      if (job.when === "after_reply") return job.by.who === "user" ? "Waiting for the chat's next reply: it starts once that reply is written." : "Waiting for its turn's reply: it starts once that reply is written.";
      return "Waiting for a place: it starts when fewer jobs run than Settings allow at once.";
    case "running":
      return jobPaused(job, held) ? "Paused: its agents are held at their next round until it is resumed. What they had started finishes first." : "Running: its work shows below as it happens.";
    case "done":
      return "Done: its report is below.";
    case "failed":
      return "Failed: it left no report.";
    case "cancelled":
      return job.report !== undefined ? "Cancelled: the report below is from its run before. What it had written to the workspace stays." : "Cancelled: it left no report. What it had written to the workspace stays.";
    case "interrupted":
      return "Interrupted: a runtime restart cut it off. What it had done is kept, and it can be started again.";
    case "off_path":
      return job.report !== undefined ? "Off the path: the turn it belongs to is no longer on the chat's path, so it stopped. Its report is kept, marked off the path." : "Off the path: the turn it belongs to is no longer on the chat's path, so it stopped.";
    case "spent":
      if (job.stoppedAt === "day") return `Paused at a day's limit: nothing of it is lost${job.report !== undefined ? ", and its report says what it did and what is left" : ""}. Carry on once the last 24 hours count less, or after you raise that limit: it goes on from where it stopped.`;
      return job.report !== undefined ? "Out of budget: it stopped when what it may spend ran out, and its report says what it did and what is left. Give it more and it carries on from where it stopped." : "Out of budget: it stopped when what it may spend ran out. Give it more and it carries on from where it stopped.";
    case "paused":
      return "Paused: you held it, and a runtime restart came meanwhile, so no run of it is under way. What it had done is kept. Resume it and it carries on from its own session.";
  }
}

/**
 * What can be done to a job as it stands: one that waits or runs can be cancelled; one that was
 * interrupted, failed or was cancelled can be started again, as a new job; one that stopped at its
 * allowance can be granted more, one a day's limit stopped can be carried on as it is, and one a
 * restart left paused can be resumed, each carrying on from its own session (DESIGN §22).
 */
export interface JobActions {
  cancel: boolean;
  again: boolean;
  grant: boolean;
  carryOn: boolean;
  resume: boolean;
}

export function jobActions(job: Pick<JobView, "state" | "stoppedAt">): JobActions {
  const day = job.state === "spent" && job.stoppedAt === "day";
  return { cancel: job.state === "queued" || job.state === "running", again: job.state === "interrupted" || job.state === "failed" || job.state === "cancelled", grant: job.state === "spent" && !day, carryOn: day, resume: job.state === "paused" };
}

/** Jobs, the newest first; two started in the same instant by their ids, so the order never shifts between two reads. */
export function sortJobs(jobs: readonly JobView[]): JobView[] {
  return [...jobs].sort((a, b) => b.createdAt - a.createdAt || (a.id < b.id ? 1 : a.id > b.id ? -1 : 0));
}

/**
 * The jobs the list shows: what was read, with each job not yet over as the state has it now (the
 * state hears of a change before the list is read again), and the jobs started since the read on
 * top. A job the list says is over stays over: the list was read after the state last named it. A
 * job of another chat stays out of a chat's list, and one older than the last row read belongs to a
 * page not read yet (`more`).
 */
export function shownJobs(listed: readonly JobView[], active: readonly JobView[], chatId: string | null, more: boolean): JobView[] {
  const live = new Map(active.map((j) => [j.id, j]));
  const out = listed.map((j) => (jobOver(j) ? j : (live.get(j.id) ?? j)));
  const have = new Set(listed.map((j) => j.id));
  const oldest = listed.reduce((least, j) => Math.min(least, j.createdAt), Number.POSITIVE_INFINITY);
  for (const j of active) {
    if (have.has(j.id) || (chatId !== null && j.chatId !== chatId)) continue;
    if (more && j.createdAt < oldest) continue;
    out.push(j);
  }
  return sortJobs(out);
}

/** The job the page has open: from the list shown, else from the jobs not yet over (a job of another chat that needs the user is opened from the strip under the bar); null when neither holds it. */
export function openJob(id: string | null, shown: readonly JobView[], active: readonly JobView[]): JobView | null {
  if (id === null) return null;
  return shown.find((j) => j.id === id) ?? active.find((j) => j.id === id) ?? null;
}

/** The name of the agent a job runs as: its definition's, else its id as a heading. */
export function agentName(agent: string, agents: readonly { id: string; name: string }[]): string {
  return agents.find((a) => a.id === agent)?.name ?? roleLabel(agent);
}

/** Who started a job: "you", or the agent that did, by its role ("Main agent"). */
export function startedBy(job: Pick<JobView, "by">): string {
  return job.by.who === "user" ? "you" : roleLabel(job.by.role);
}

/** When a job was to start, in words. */
export function whenWords(job: Pick<JobView, "when" | "by">): string {
  if (job.when === "now") return "At once";
  return job.by.who === "user" ? "After the chat's next reply" : "Once its turn's reply was written";
}

/** What a job spent, shortly, for its row: "4 calls · 9.2k in · 410 out · $0.0014 · 21.4 s". Counts the runtime estimated are marked ≈. */
export function usageLine(u: AgentUsage, over: boolean): string {
  if (u.calls === 0 && u.in === 0 && u.out === 0) return over ? "nothing spent" : "nothing spent yet";
  const est = u.estimated ? "≈" : "";
  return [counted(u.calls, "call"), `${est}${compact(u.in)} in`, `${est}${compact(u.out)} out`, costWords(u), duration(u.ms)].join(" · ");
}

/** A figure with its name, and a line under it where there is more to say. */
export interface Fact {
  label: string;
  value: string;
  sub?: string;
}

/** What a job spent, a figure a card: its calls, tokens in and out, cost and time in the model. */
export function usageFacts(u: AgentUsage): Fact[] {
  const est = u.estimated ? "≈" : "";
  return [
    { label: "Model calls", value: count(u.calls), sub: `${counted(u.toolTurns, "round")} of tool calls` },
    { label: "Tokens in", value: `${est}${count(u.in)}`, ...(u.cachedIn > 0 ? { sub: `${count(u.cachedIn)} read from the cache` } : {}) },
    { label: "Tokens out", value: `${est}${count(u.out)}`, ...(u.reasoningOut > 0 ? { sub: `${count(u.reasoningOut)} of them reasoning` } : {}) },
    // A tally has a cost only while every call so far had one.
    { label: "Cost", value: u.calls === 0 ? "$0" : costWords(u), ...(u.calls > 0 && u.cost === undefined ? { sub: "a call had no price" } : {}) },
    { label: "Time in the model", value: duration(u.ms) },
  ];
}

/** A job's row under its task: who started it, when, and what it spent. */
export function rowLine(job: JobView, now: number): string {
  return [`by ${startedBy(job)}`, ago(now, job.createdAt), usageLine(job.usage, jobOver(job))].join(" · ");
}

/** What is known of a job besides its work, a fact a line: its agent, who started it and when it was to start, its chat, the turn it belongs to, and its times. */
export function jobFacts(job: JobView, known: { agents: readonly { id: string; name: string }[]; chat: string; now: number }): Fact[] {
  const { now } = known;
  const facts: Fact[] = [
    { label: "Agent", value: agentName(job.agent, known.agents), sub: job.agent },
    { label: "Started by", value: job.by.who === "user" ? "You, on this page" : `${roleLabel(job.by.role)}, with a job_start call`, ...(job.by.who === "agent" ? { sub: job.by.id } : {}) },
    { label: "To start", value: whenWords(job) },
    { label: "Chat", value: known.chat },
    { label: "Belongs to", value: job.basis === null ? "The chat, not a turn" : `Turn ${job.basis}` },
    // Past a day `ago` says the date itself, which the value already does.
    { label: "Asked for", value: dateTime(job.createdAt), ...(now - job.createdAt < 86_400_000 ? { sub: ago(now, job.createdAt) } : {}) },
  ];
  if (job.startedAt !== undefined) {
    const waited = job.startedAt - job.createdAt;
    // Under a second is no wait worth a line.
    facts.push({ label: "Started", value: dateTime(job.startedAt), ...(waited >= 1000 ? { sub: `after waiting ${duration(waited)}` } : {}) });
  }
  if (job.endedAt !== undefined) facts.push({ label: "Ended", value: dateTime(job.endedAt), ...(job.startedAt !== undefined ? { sub: `${duration(Math.max(0, job.endedAt - job.startedAt))} after it started` } : {}) });
  else if (job.state === "running" && job.startedAt !== undefined) facts.push({ label: "Running for", value: elapsed(now, job.startedAt) });
  if (job.workedMs !== undefined) facts.push({ label: "Worked for", value: duration(job.workedMs), sub: "over every run of it, less the time it was held" });
  if (job.parent !== undefined) facts.push({ label: "Started from", value: `Job ${job.parent}`, sub: "its agent started this one, so what this one spends counts against that job's budget too" });
  return facts;
}

/** The limits Settings put on every job, a figure a card. */
export function limitFacts(limits: JobsPage["limits"]): Fact[] {
  return [
    { label: "Jobs at once", value: count(limits.atOnce) },
    { label: "Tokens per job", value: limits.tokensPerJob === null ? "No limit" : count(limits.tokensPerJob) },
    { label: "Time per job", value: limits.msPerJob === null ? "No limit" : duration(limits.msPerJob) },
  ];
}

/** Today's tokens against the day's: the numbers in words, how much of a bar they fill (null: there is no limit, so no bar), and whether the day's are used up. */
export interface DayUse {
  words: string;
  fraction: number | null;
  reached: boolean;
}

export function dayUse(limits: JobsPage["limits"], today: JobsPage["today"]): DayUse {
  const limit = limits.tokensPerDay;
  // The day's limit counts a cached re-read as a share of a token: what it counted and what was sent are both said where they differ.
  const sent = sentBeside(today.tokens, today.sent);
  const beside = sent === null ? "" : ` ${count(sent)} sent. ${CACHED_NOTE}`;
  if (limit === null) return { words: sent === null ? `${count(today.tokens)} tokens today. No limit a day is set.` : `Counted as ${count(today.tokens)} tokens today. No limit a day is set.${beside}`, fraction: null, reached: false };
  const fraction = fractionOf(today.tokens, limit);
  const reached = today.tokens >= limit;
  const used = sent === null ? `${count(today.tokens)} of ${count(limit)} tokens a day used` : `Counted as ${count(today.tokens)} of ${count(limit)} tokens a day`;
  return { words: reached ? `${used}: reached, so a job that would pass it is stopped.${beside}` : `${used} today (${percentWords(fraction)}).${beside}`, fraction, reached };
}

/** A member of an allowance: tokens in and out, rounds of tool calls, and time. */
export type AllowanceKey = keyof JobAllowance;

/** How a member of an allowance stands in the form: left to Settings' limit for each job, no limit at all, or a figure set here. */
export type AllowanceMode = "settings" | "none" | "set";

/** A member as the form holds it: its mode, and the figure typed (in the member's own unit: tokens, rounds, minutes), kept while another mode is picked so it is there again. */
export interface AllowanceMember {
  mode: AllowanceMode;
  value: number;
}

export type AllowanceDraft = Record<AllowanceKey, AllowanceMember>;

/** The members in the order the form and a job's detail show them, with what each is called, its unit as typed, and the step its − and + take. */
export const ALLOWANCE_FIELDS: readonly { key: AllowanceKey; label: string; unit: string; step: number }[] = [
  { key: "tokensIn", label: "Tokens in", unit: "tokens", step: 10_000 },
  { key: "tokensOut", label: "Tokens out", unit: "tokens", step: 1000 },
  { key: "toolTurns", label: "Rounds of tool calls", unit: "rounds", step: 5 },
  { key: "wallMs", label: "Time", unit: "minutes", step: 5 },
];

export const ALLOWANCE_MODE_WORDS: Readonly<Record<AllowanceMode, string>> = { settings: "Settings' limit", none: "No limit", set: "Set here" };

const MINUTE_MS = 60_000;

/**
 * Where a member's figure starts when "Set here" is picked and the job had none: a place to start
 * typing from, not a bound (the user sets the figure, and Settings hold the real limits). Settings'
 * own figure is used where the page is told it (the time a job may take); the page isn't told the
 * others apart, so these stand in.
 */
const ALLOWANCE_START: Readonly<Record<AllowanceKey, number>> = { tokensIn: 200_000, tokensOut: 20_000, toolTurns: 40, wallMs: 30 };

/** The form's fields for an allowance: what the job has (a figure, no limit, or left to Settings), with the time in minutes. */
export function allowanceDraft(allowance: JobAllowance | undefined, limits: JobsPage["limits"] | null): AllowanceDraft {
  const member = (key: AllowanceKey): AllowanceMember => {
    const given = allowance?.[key];
    const start = key === "wallMs" && limits !== null && limits.msPerJob !== null ? Math.max(1, Math.round(limits.msPerJob / MINUTE_MS)) : ALLOWANCE_START[key];
    if (given === undefined) return { mode: "settings", value: start };
    if (given === null) return { mode: "none", value: start };
    return { mode: "set", value: key === "wallMs" ? Math.round(given / MINUTE_MS) : given };
  };
  return { tokensIn: member("tokensIn"), tokensOut: member("tokensOut"), toolTurns: member("toolTurns"), wallMs: member("wallMs") };
}

/** The allowance a draft asks for: each member set here or lifted; one left to Settings is left out. */
export function allowanceOf(draft: AllowanceDraft): JobAllowance {
  const out: JobAllowance = {};
  for (const { key } of ALLOWANCE_FIELDS) {
    const m = draft[key];
    if (m.mode === "none") out[key] = null;
    else if (m.mode === "set") out[key] = key === "wallMs" ? Math.round(m.value * MINUTE_MS) : Math.round(m.value);
  }
  return out;
}

/** What a job may spend where it has no allowance of its own, in a sentence: Settings' limits for each job. */
export function settingsAllowanceWords(limits: JobsPage["limits"] | null): string {
  if (limits === null) return "Settings' limits for each job stand.";
  const tokens = limits.tokensPerJob === null ? "any number of tokens" : `${count(limits.tokensPerJob)} tokens`;
  const time = limits.msPerJob === null ? "as long as it needs" : duration(limits.msPerJob);
  return `Settings' limits for each job stand: ${tokens}, and ${time}.`;
}

/** A job's allowance against what it has spent, a line a member it has of its own: "182,400 of 200,000 (91%)", or what it used where it has no limit. None for a job that has only Settings' limits. */
export function allowanceFacts(job: Pick<JobView, "allowance" | "usage" | "workedMs">): Fact[] {
  const allowance = job.allowance;
  if (allowance === undefined) return [];
  const used: Readonly<Record<AllowanceKey, number>> = { tokensIn: job.usage.in, tokensOut: job.usage.out, toolTurns: job.usage.toolTurns, wallMs: job.workedMs ?? 0 };
  const said = (key: AllowanceKey, n: number): string => (key === "wallMs" ? duration(n) : count(n));
  return ALLOWANCE_FIELDS.flatMap(({ key, label }): Fact[] => {
    const limit = allowance[key];
    if (limit === undefined) return [];
    if (limit === null) return [{ label, value: `${said(key, used[key])} used`, sub: "no limit" }];
    return [{ label, value: `${said(key, used[key])} of ${said(key, limit)}`, sub: used[key] >= limit ? "used up" : `${percentWords(fractionOf(used[key], limit))} used` }];
  });
}

/** Why a grant can't be sent yet, in words that say what to do; null when it can. Granting what the job already had would stop it again at once. */
export function grantBlock(draft: AllowanceDraft, had: JobAllowance | undefined): string | null {
  const next = allowanceOf(draft);
  const same = ALLOWANCE_FIELDS.every(({ key }) => next[key] === had?.[key]);
  return same ? "Nothing is changed yet: raise the limit it ran out at, or lift it. As it stands it would stop again at once." : null;
}

/** What the start form holds while it is written: the agent, the task, when it starts, and an allowance of its own (null: Settings' limits for each job). */
export interface StartDraft {
  agent: string;
  task: string;
  when: JobWhen;
  allowance: AllowanceDraft | null;
}

export const NO_DRAFT: StartDraft = { agent: "", task: "", when: "now", allowance: null };

/** The agent a draft names: its own choice while that is one a job may run as, else the first there is; null when there is none. */
export function draftAgent(draft: StartDraft, agents: readonly { id: string }[]): string | null {
  return agents.some((a) => a.id === draft.agent) ? draft.agent : (agents[0]?.id ?? null);
}

/** Why the start form can't be sent yet, in words that say what to do; null when it can. */
export function startBlock(draft: StartDraft, chatId: string | null, agents: readonly { id: string }[]): string | null {
  if (chatId === null) return "Open a chat, or pick one above: a job belongs to a chat.";
  if (draftAgent(draft, agents) === null) return "No agent is there for a job to run as: add one on the Agents page.";
  if (draft.task.trim() === "") return "Write its task: what it is to do, and what its report should say.";
  return null;
}

/** What the list's head says: how many jobs there are, whose, and how many of them show. */
export function countLine(total: number, shown: number, scope: "chat" | "all"): string {
  const whose = scope === "chat" ? "of this chat" : "in every chat";
  return `${counted(total, "job")} ${whose}, newest first${shown < total ? `; ${count(shown)} shown` : ""}.`;
}

/** A file name for a job's report, in characters every file system takes. A job's id is short; the cut at 60 only keeps an odd one from making a name too long for some systems. */
export function reportName(job: Pick<JobView, "id">): string {
  return `lumiah-job-${job.id.replace(/[^A-Za-z0-9_-]+/g, "-").slice(0, 60)}-report.md`;
}

/** A long text's start and how much is left of it, for "Show the rest". */
export function clipped(text: string, limit: number): { shown: string; rest: number } {
  return text.length > limit ? { shown: text.slice(0, limit), rest: text.length - limit } : { shown: text, rest: 0 };
}

/** What stands over the reason a job gives for how it ended. */
export const REASON_TITLES: Readonly<Record<JobState, string>> = { queued: "Why it waits", running: "A word on it", done: "A word on it", failed: "Why it failed", cancelled: "Why it was cancelled", interrupted: "Why it was cut off", off_path: "Why it left the path", spent: "Why it stopped", paused: "Why it is held" };

/** What stands where a job's work would show while there is none to show, said by how the job stands. */
export function noWorkWords(job: Pick<JobView, "state" | "startedAt">): string {
  if (job.state === "queued") return "It hasn't started. Its work shows here, step by step, once it does.";
  if (job.state === "running") return "Its run is starting: its first step shows here in a moment.";
  return job.startedAt === undefined ? "It never started, so there is no work to show." : "No transcript of its work was kept.";
}

/** What the switches mean for a job started now, said before it is sent; null while they are in no one's way. */
export function startNote(switches: Switches): string | null {
  if (switches.off) return "Jobs are switched off, so a start is refused. Switch them on above first.";
  if (switches.paused) return "Jobs are paused: one started now waits until you resume them.";
  return null;
}
