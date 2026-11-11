// What the core keeps in the store's documents for jobs and side sessions (DESIGN §15, §19), as
// stored: read by the modules that run them (jobs.ts, side.ts) and by upkeep, which follows the blobs
// they name. Stored formats: a field keeps its name and its meaning once shipped.

import type { AgentUsage, JobView, TurnStatus } from "./ports";

// ---------------------------------------------------------------- jobs

/**
 * What one job holds of the allowance of the job whose agent started it (DESIGN §22): each member
 * is what was taken out of that job's own, less what the holder has spent of it since. A member
 * the lending job has no limit on is never taken, and is absent.
 */
export interface JobLent {
  tokensIn?: number;
  tokensOut?: number;
  toolTurns?: number;
  wallMs?: number;
}

/**
 * One job, whole (`DOC.job`): the job as a list shows it, its task in full, and its session where
 * one is kept: the blob of its agent's conversation as it stood when the job was paused or stopped
 * (a JSON list of the messages the model was sent and answered), which a run that carries it on
 * takes up (DESIGN §22). For a job an agent started: the tools that agent held (`held`) and how
 * deep the job's own agent stands (`depth`: one deeper than its starter), which are what its agent
 * is started by whenever the job runs (§14); a job the user started has neither, and stands at 0
 * with its definition's tools. `lent`: what each job its agents started still holds of its
 * allowance, by that job's id.
 */
export interface JobDoc {
  v: 1;
  kind: "job";
  job: JobView;
  task: string;
  session?: string;
  held?: string[];
  depth?: number;
  lent?: Record<string, JobLent>;
}

/**
 * A chat's jobs by id, in the order they were started (`DOC.chatJobs`): when each was started and,
 * once it has stopped, when. An index, never the jobs themselves: it is written when a job starts
 * and when one stops, and a turn reads from it which jobs' documents it needs.
 */
export interface ChatJobsDoc {
  v: 1;
  kind: "jobs";
  jobs: { id: string; at: number; ended?: number }[];
}

/** Every job's id and chat, in the order they were started (`DOC.allJobs`). */
export interface AllJobsDoc {
  v: 1;
  kind: "job_ids";
  jobs: { id: string; chatId: string; at: number }[];
}

/** The jobs that wait or run, by id (`DOC.runningJobs`): what a restart looks through for the ones it cut off. */
export interface RunningJobsDoc {
  v: 1;
  kind: "running";
  ids: string[];
}

// ---------------------------------------------------------------- side sessions

/**
 * One turn of a side session: its id (the trace's `turn`), when it ended, what the user said and
 * what the agent answered (each a blob; no answer where it gave none), how it ended, the agent's
 * steps (a session segment's blob) and the turn's transcript (absent while Settings keep none), and
 * what it spent.
 */
export interface SideTurnDoc {
  turn: string;
  at: number;
  asked: string;
  answered: string | null;
  status: TurnStatus;
  reason?: string;
  segment?: string;
  transcript?: string;
  usage: AgentUsage;
}

/**
 * One side session, whole (`DOC.side`): the agent definition it is with, the chat it is about (`""`:
 * none), its title (how its first message opens), its turns in order, and, once its older turns
 * were summarized, the summary's blob and how many turns from the start it stands for.
 */
export interface SideDoc {
  v: 1;
  kind: "side";
  id: string;
  chatId: string;
  agent: string;
  title: string;
  createdAt: number;
  lastAt: number;
  summary?: { text: string; turns: number };
  turns: SideTurnDoc[];
}

/** A side session as a list shows it. */
export interface SideRow {
  id: string;
  chatId: string;
  agent: string;
  title: string;
  createdAt: number;
  lastAt: number;
  turns: number;
}

/** Every side session, in the order they were started (`DOC.sides`). */
export interface SidesDoc {
  v: 1;
  kind: "sides";
  sides: SideRow[];
}
