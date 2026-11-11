// The jobs as the pages hear of them (DESIGN §15). The core keeps every job and the place that
// holds it runs them (a runtime, or this extension for what runs built in); each time one is queued
// or changes, that place says so (a runtime's `job.changed`), and this keeps what
// the state every page holds needs: the jobs not yet over, a counter that moves with every change
// (a page showing a list reads it again), and a notice for the user when a job finishes, fails, is
// interrupted, or waits on their word, so they hear of it on whichever page they open next.

import type { JobView } from "../../core/ports";
import { CEILINGS } from "../../link/settings";
import type { Notice, UiState } from "../../shared/ui";
import type { Notices } from "./notices";

/** A job that is over: it has its report, or never will. */
export function jobOver(job: JobView): boolean {
  // One that used up its allowance, or that a restart left held, isn't over: it waits on the user.
  return job.state !== "queued" && job.state !== "running" && job.state !== "spent" && job.state !== "paused";
}

/** How a task is named in a notice: its opening, on one line. Not a setting: it is the notice's own wording, and the whole task is a click away. */
const TASK_CHARS = 80;

function named(job: JobView): string {
  const task = job.task.replace(/\s+/g, " ").trim();
  return `"${task.length > TASK_CHARS ? `${task.slice(0, TASK_CHARS).trimEnd()}…` : task}"`;
}

/** The notice a job's end calls for; null for an end the user brought about themselves (a cancel) or needs no telling of. A finished job's notice opens with what it reported, as far as `openingChars`: a report is as long as its agent made it, and a notice is kept until dismissed. */
function endNotice(job: JobView, openingChars: number): Omit<Notice, "id" | "at"> | null {
  const base = { chatId: job.chatId, jobId: job.id };
  const opening = job.opening?.trim() ?? "";
  switch (job.state) {
    case "done":
      return { ...base, kind: "job_done", text: `The job ${named(job)} finished${opening === "" ? "." : `: ${opening.length > openingChars ? `${opening.slice(0, openingChars).trimEnd()}…` : opening}`}` };
    case "failed":
      return { ...base, kind: "job_failed", text: `The job ${named(job)} failed${job.reason !== undefined ? `: ${job.reason}` : "."}` };
    case "interrupted":
      return { ...base, kind: "job_interrupted", text: `The job ${named(job)} was cut off by a restart. Start it again from the Jobs page.` };
    case "off_path":
      return { ...base, kind: "job_failed", text: `The job ${named(job)} was stopped: the reply it belonged to is no longer on the chat's path${job.reason !== undefined ? ` (${job.reason})` : ""}.` };
    default:
      return null;
  }
}

interface UserJobs {
  /** The jobs not yet over, by id, in the order they were first heard of. */
  active: Map<string, JobView>;
  changed: number;
  /** The jobs whose end was told already, the one told longest ago first: an end the runtime says twice (its request sent again) is told once. */
  told: Set<string>;
  /** Where each job that isn't over runs, as its place said when it told of it: a runtime's id, or `BUILTIN`. */
  runs: Map<string, string>;
}

/**
 * How many ended jobs are remembered as told, per user. It bounds memory only: an end said again
 * after this many others ended would be told a second time, which a dismiss mends. Not a setting,
 * since nothing a user sees changes with it.
 */
const TOLD_KEPT = 4096;

export class JobsBoard {
  private readonly users = new Map<string, UserJobs>();
  /** The jobs not yet over that all accounts have here, together. */
  private total = 0;
  private readonly changed: ((userId: string) => void)[] = [];

  /** @param noticeChars How much of a job's opening a notice keeps, as the user set it. */
  constructor(
    private readonly notices: Pick<Notices, "add" | "settle">,
    private readonly now: () => number,
    private readonly noticeChars: (userId: string) => Promise<number>,
  ) {}

  /** A user's jobs changed. */
  onChange(listener: (userId: string) => void): void {
    this.changed.push(listener);
  }

  private of(userId: string): UserJobs {
    let user = this.users.get(userId);
    if (user === undefined) {
      // The counter starts where no page can hold it from before this start, so an open list reads again.
      user = { active: new Map(), changed: this.now(), told: new Set(), runs: new Map() };
      this.users.set(userId, user);
    }
    return user;
  }

  /** Whether anything has been heard of the user's jobs since the extension started. */
  known(userId: string): boolean {
    return this.users.has(userId);
  }

  /** What a list read says of the jobs not yet over, for a user of whom nothing was heard yet (the extension started again while they ran). */
  seed(userId: string, jobs: readonly JobView[]): void {
    const user = this.of(userId);
    for (const job of jobs) if (!jobOver(job) && !user.active.has(job.id)) this.hold(userId, user, job, null);
  }

  /**
   * Keeps a job among those not yet over (`relay`: where it runs, when that was said), within what
   * one account and all of them together may have here. A runtime can say of any number of jobs
   * that they began and never that they ended, so past either bound one is let go: the account's
   * own, or, past the total, one of the account that has the most. Nothing is lost by it: the pages
   * read their lists from the core, and a job let go here is heard of again when it next changes.
   */
  private hold(userId: string, user: UserJobs, job: JobView, relay: string | null): void {
    if (!user.active.has(job.id)) this.total += 1;
    user.active.set(job.id, job);
    if (relay !== null) user.runs.set(job.id, relay);
    if (user.active.size > CEILINGS.jobsActive) this.letGo(user, job.id);
    if (this.total <= CEILINGS.jobsActiveTotal) return;
    // The job just heard of stays, so its own account counts for one fewer.
    let most = { userId, user, spare: user.active.size - 1 };
    for (const [otherId, other] of this.users) if (other !== user && other.active.size > most.spare) most = { userId: otherId, user: other, spare: other.active.size };
    this.letGo(most.user, job.id);
    if (most.user === user) return;
    most.user.changed += 1;
    for (const listener of this.changed) listener(most.userId);
  }

  /** Lets go of the oldest of an account's jobs that isn't running, else of its oldest: a running one is the one a page may yet have to stop. Never of `keep`, the one just heard of. */
  private letGo(user: UserJobs, keep: string): void {
    let oldest: string | null = null;
    for (const [id, job] of user.active) {
      if (id === keep) continue;
      oldest ??= id;
      if (job.state === "running") continue;
      oldest = id;
      break;
    }
    if (oldest === null) return;
    user.active.delete(oldest);
    user.runs.delete(oldest);
    this.total -= 1;
  }

  /**
   * A job was queued, or changed, as the place that runs it says (`relay`: a runtime's `job.changed`,
   * or `BUILTIN` for the core here). Said twice (a request sent again) changes nothing the second time.
   */
  async took(userId: string, job: JobView, relay: string): Promise<void> {
    const user = this.of(userId);
    const before = user.active.get(job.id);
    const over = jobOver(job);
    if (over) {
      if (user.active.delete(job.id)) this.total -= 1;
      user.runs.delete(job.id);
    } else this.hold(userId, user, job, relay);
    user.changed += 1;
    for (const listener of this.changed) listener(userId);
    if (!over) {
      // A job that used up its allowance, or that a restart left held, waits on the user: they are told, and the notice goes once the job moves on.
      const needs = job.state === "spent" ? `The job ${named(job)} used up what it was allowed to spend. Grant it more on the Jobs page, or cancel it.` : job.state === "paused" ? `The job ${named(job)} was held when a restart cut it off. Let it go on from the Jobs page, or cancel it.` : null;
      if (needs !== null) await this.notices.add(userId, { kind: "job_needs_user", chatId: job.chatId, jobId: job.id, text: needs });
      else if (before?.state === "spent" || before?.state === "paused") await this.notices.settle(userId, job.id, "job_needs_user");
      return;
    }
    // An end said twice is told once.
    if (user.told.has(job.id)) return;
    user.told.add(job.id);
    if (user.told.size > TOLD_KEPT) user.told.delete(user.told.values().next().value ?? "");
    await this.notices.settle(userId, job.id, "job_needs_user");
    const notice = endNotice(job, await this.noticeChars(userId));
    if (notice !== null) await this.notices.add(userId, notice);
  }

  /** A call of a job's run waits for the user's word, or no longer does. */
  async waits(userId: string, jobId: string, tool: string | null): Promise<void> {
    const job = this.users.get(userId)?.active.get(jobId);
    if (job === undefined) return;
    if (tool === null) await this.notices.settle(userId, jobId, "job_needs_user");
    else await this.notices.add(userId, { kind: "job_needs_user", chatId: job.chatId, jobId, text: `The job ${named(job)} waits for your word on a call of ${tool}.` });
  }

  /** A job of the user's that isn't over, by its id. */
  active(userId: string, jobId: string): JobView | null {
    return this.users.get(userId)?.active.get(jobId) ?? null;
  }

  /** Where a job that isn't over runs (a runtime's id, or `BUILTIN`); null when it is over, or nothing was heard of it since the extension started. */
  runsIn(userId: string, jobId: string): string | null {
    return this.users.get(userId)?.runs.get(jobId) ?? null;
  }

  /** The jobs part of the state every page holds. */
  state(userId: string, off: boolean, paused: boolean): UiState["jobs"] {
    const user = this.users.get(userId);
    return { active: user === undefined ? [] : [...user.active.values()], off, paused, changed: user?.changed ?? 0 };
  }
}
