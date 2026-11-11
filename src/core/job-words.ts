// A job in words (DESIGN §15), for whoever tells a model about one: the job tools, and the note the
// main agent's turn opens with for the jobs that ended since its last.

import type { JobView } from "./ports";
import { TEXT, type Texts } from "./texts";
import type { Limit } from "./util";

/** A job has stopped for good or until the user says more: it neither waits nor runs, and isn't one the user holds. */
export function jobEnded(job: Pick<JobView, "state">): boolean {
  return job.state !== "queued" && job.state !== "running" && job.state !== "paused";
}

/** A job may be started again from the start: it stopped, and not with its report. */
export function jobRestarts(job: Pick<JobView, "state">): boolean {
  return jobEnded(job) && job.state !== "done";
}

/** Where a job stands. */
export function jobState(job: Pick<JobView, "state" | "paused" | "stoppedAt">, texts: Texts): string {
  // A job a day's limit stopped is no job that ran out of its own allowance: it is said apart.
  if (job.state === "spent" && job.stoppedAt === "day") return texts.render(TEXT.jobs.spentDay);
  return texts.render(job.state === "running" && job.paused ? TEXT.jobs.paused : TEXT.jobs.state[job.state]);
}

/** Who started it. */
export function jobBy(job: Pick<JobView, "by">, texts: Texts): string {
  return job.by.who === "user" ? texts.render(TEXT.jobs.byUser) : texts.render(TEXT.jobs.byAgent, { role: job.by.role });
}

/** What a job may spend, limit by limit, as its agent is told and as the agent that started it is: each limit there is, or that there is none. */
export function allowanceParts(left: Readonly<{ tokensIn?: Limit; tokensOut?: Limit; toolTurns?: Limit; wallMs?: Limit }>, texts: Texts): string {
  const { tokensIn = null, tokensOut = null, toolTurns = null, wallMs = null } = left;
  const parts = [
    ...(tokensIn !== null ? [texts.render(TEXT.jobs.allowanceIn, { tokens: texts.counted(tokensIn, TEXT.word.token) })] : []),
    ...(tokensOut !== null ? [texts.render(TEXT.jobs.allowanceOut, { tokens: texts.counted(tokensOut, TEXT.word.token) })] : []),
    ...(toolTurns !== null ? [texts.render(TEXT.jobs.allowanceRounds, { rounds: texts.counted(toolTurns, TEXT.word.round) })] : []),
    ...(wallMs !== null ? [texts.render(TEXT.jobs.allowanceTime, { minutes: String(Math.max(1, Math.round(wallMs / 60_000))) })] : []),
  ];
  return parts.length > 0 ? parts.join(", ") : texts.render(TEXT.jobs.allowanceNone);
}

/** What a job that ended left: how its report opens (and how to read the rest), or why it has none. Nothing for one still waiting or running. */
export function jobLeft(job: JobView, texts: Texts): string {
  if (job.report !== undefined && job.opening !== undefined && job.state === "done") {
    return texts.render(TEXT.jobs.newsMore, { opening: job.opening, more: (job.reportChars ?? 0) > job.opening.length ? texts.render(TEXT.jobs.newsRest, { id: job.id }) : "" });
  }
  return jobEnded(job) ? texts.render(TEXT.jobs.newsNoReport, { reason: job.reason ?? texts.render(TEXT.jobs.whyNoAnswer) }) : "";
}

/** The note a turn opens with for the jobs that ended since the main agent's last turn; null for none. */
export function jobNews(jobs: readonly JobView[], texts: Texts): string | null {
  if (jobs.length === 0) return null;
  return texts.render(TEXT.jobs.news, { jobs: jobs.map((job) => texts.render(TEXT.jobs.newsLine, { id: job.id, agent: job.agent, state: jobState(job, texts), report: jobLeft(job, texts) })).join("\n") });
}
