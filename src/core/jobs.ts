// Jobs (DESIGN §15, §22): an agent's run that outlives the reply.
//
// One function makes a job (`createJob`), and two things call it: an agent's `job_start` call
// (through the run's `JobTools.start`) and the user on the page. Nothing else starts one, and a test
// holds that. A job made waits: the host is told (`JobsPort.queued`) and runs it when it will, with
// `run`, which is where every limit is kept: jobs at once, what one job may spend (Settings' limits
// for each job, or the job's own allowance), the day's tokens for all jobs, and the user's switch.
//
// A job an agent started belongs to that agent's turn. It may write the workspace only while that
// turn's record stands on the chat's active path: the moment it would write or report and the turn
// has left the path, it stops, and its report is marked off the path. A job the user started belongs
// to the chat and to no turn: it writes `learned/` and `~/` and never the chat's own area.
//
// A job keeps a session of its own where it may be carried on: when the user holds it, and when its
// allowance runs out. Resumed, or granted more, it goes on from there. A runtime restart finds a
// held job still held, and one that was running interrupted, with what it had written kept.

import { gated } from "./areas";
import { Gate } from "./gate";
import { jobEnded, jobRestarts, jobState } from "./job-words";
import { cutShort, type RunWords } from "./loop";
import { DOC } from "./paths";
import type { AgentStopCode, AgentUsage, HarnessHost, JobAllowance, JobState, JobView, JobWhen, JsonObject, JsonValue, ModelMessage, RecordJob, TurnRecord } from "./ports";
import { isRecord } from "./ports";
import { AgentStop } from "./provider";
import { HarnessRefusal } from "./refusal";
import { type Equipment, readSetup, Run, type Setup, type Shared } from "./run";
import { pathTurns } from "./sessions";
import { AGENT, type Settings, type TurnBudget } from "./settings";
import type { AllJobsDoc, ChatJobsDoc, JobDoc, RunningJobsDoc } from "./stored";
import { TEXT, type Texts, textsOf } from "./texts";
import type { JobRead, JobStarted } from "./tools";
import { addUsage, emptyUsage, usageSince } from "./usage";
import { clip, errorText, jsonEqual, type Limit, stopWords } from "./util";
import { chatView, loreView } from "./views";
import { showPath } from "./workspace";

/** The words a job's own budget stops its agents with. */
const JOB_WORDS: RunWords = { tokensIn: TEXT.jobs.stopIn, tokensOut: TEXT.jobs.stopOut, toolTurns: TEXT.jobs.stopRounds, time: TEXT.jobs.stopTime };

/** The stops that are a job's own allowance running out: granted more, it carries on. */
const ALLOWANCE_STOPS: readonly AgentStopCode[] = ["turn_tokens_in", "turn_tokens_out", "turn_tool_turns", "turn_time"];

/** The stop of a limit on a day's spend (Job tokens per day, the user's Tokens per day and Cost per day): the job has done nothing wrong and loses nothing; it carries on once the day's count allows. */
const DAY_STOP: AgentStopCode = "spend";

/**
 * How often the chat's path is looked at while a job waits for its turn's record to be saved: forty
 * times in the wait Settings give. Fixed, not a setting: it trades a few reads of the path against
 * how soon the job goes on, and the wait it divides is the setting.
 */
const RECORD_LOOKS = 40;

/** The plan file a job the user started is asked to keep (§22): one for each job, in `learned/`. Fixed: it is a path the job's texts and its report name, and what a run that carries the job on reads first. */
export function planPath(jobId: string): string {
  return `learned/plans/${jobId}.md`;
}

/** What starting a job takes. */
export interface JobCreate {
  chatId: string;
  when: JobWhen;
  by: JobView["by"];
  /** The turn it belongs to; null for a job the user starts (§22). */
  basis: string | null;
  /** The agent and the task, or the job to start again in their place. */
  what: { agent: string; task: string } | { again: string };
  allowance?: JobAllowance;
  /** The job whose agent starts it, and what is left of that job's allowance: the new job may spend no more. */
  parent?: { id: string; left: TurnBudget };
  /** The agent that starts it, where an agent does: the tools it holds, which are the most the job's own agent is given (§14), and how deep it stands, which the job's agent stands one deeper than. */
  starter?: { held: readonly string[]; depth: number };
}

/** What a job may spend: its allowance's members over Settings' limits for each job. */
export function jobBudget(job: Pick<JobView, "allowance">, settings: Readonly<Pick<Settings, "jobs">>): TurnBudget {
  const own = job.allowance ?? {};
  const { budget } = settings.jobs;
  return { tokensIn: own.tokensIn !== undefined ? own.tokensIn : budget.tokensIn, tokensOut: own.tokensOut !== undefined ? own.tokensOut : budget.tokensOut, toolTurns: own.toolTurns !== undefined ? own.toolTurns : budget.toolTurns, wallMs: own.wallMs !== undefined ? own.wallMs : budget.wallMs };
}

/** The smaller of two limits, where none is the largest. */
function least(a: Limit, b: Limit): Limit {
  return a === null ? b : b === null ? a : Math.min(a, b);
}

/** What a job may still spend, as its agent is told. */
function allowanceText(left: TurnBudget, texts: Texts): string {
  const parts = [
    ...(left.tokensIn !== null ? [texts.render(TEXT.jobs.allowanceIn, { tokens: texts.counted(left.tokensIn, TEXT.word.token) })] : []),
    ...(left.tokensOut !== null ? [texts.render(TEXT.jobs.allowanceOut, { tokens: texts.counted(left.tokensOut, TEXT.word.token) })] : []),
    ...(left.toolTurns !== null ? [texts.render(TEXT.jobs.allowanceRounds, { rounds: texts.counted(left.toolTurns, TEXT.word.round) })] : []),
    ...(left.wallMs !== null ? [texts.render(TEXT.jobs.allowanceTime, { minutes: String(Math.max(1, Math.round(left.wallMs / 60_000))) })] : []),
  ];
  return texts.render(TEXT.jobs.allowance, { parts: parts.length > 0 ? parts.join(", ") : texts.render(TEXT.jobs.allowanceNone) });
}

/** A job's session as stored, read: the messages its agent's conversation held; null when the blob isn't one. */
function sessionOf(raw: unknown): ModelMessage[] | null {
  if (!Array.isArray(raw)) return null;
  const ok = raw.every((m: unknown) => isRecord(m) && (m.role === "system" || m.role === "user" || m.role === "assistant") && typeof m.content === "string");
  return ok ? (raw as ModelMessage[]) : null;
}

/** A job under way in this process: waiting for its place, or running. */
interface Live {
  /** Ends the job's run: a cancel, or its turn leaving the path. */
  controller: AbortController;
  /** Why it was cancelled, once it was. */
  cancelled: string | null;
  run: Run | null;
  done: Promise<JobView>;
}

/** How a job's run came out: where the job stands, why (unless it is done), what it leaves as its report, and when its agent stopped. */
interface Outcome {
  state: JobState;
  reason?: string;
  /** For a job that stopped at a limit: which. */
  stoppedAt?: JobView["stoppedAt"];
  report: string | null;
  at: number;
}

export class Jobs {
  /** Jobs running at once: one past the setting waits its turn. */
  private readonly gate = new Gate(() => this.shared().latest.jobs.atOnce);
  private readonly live = new Map<string, Live>();
  /** The job documents have one writer at a time. */
  private writes: Promise<unknown> = Promise.resolve();
  /** The turns that ended lately, by generation: when, and whether each left a record to be anchored. */
  private readonly ended = new Map<string, { at: number; record: boolean }>();
  /** The user holds every job: one that begins meanwhile begins held. */
  private holding = false;
  /** The chats forgotten since the process started (§20): nothing is written for a job of one. */
  private readonly forgotten = new Set<string>();

  constructor(private readonly shared: () => Shared) {}

  private get host(): HarnessHost {
    return this.shared().host;
  }

  // ---------------------------------------------------------------- the documents

  private write<T>(step: () => Promise<T>): Promise<T> {
    const done = this.writes.then(step);
    this.writes = done.catch(() => undefined);
    return done;
  }

  /** One job, whole; null when there is none. Past its envelope it is taken as the core wrote it. */
  private async doc(id: string): Promise<JobDoc | null> {
    const raw = await this.host.store.read(DOC.job(id));
    return isRecord(raw) && raw.v === 1 && raw.kind === "job" && isRecord(raw.job) && typeof raw.task === "string" ? (raw as unknown as JobDoc) : null;
  }

  /** A chat's jobs by id, oldest first, as its index holds them: when each was started and, once it stopped, when. An entry that isn't one is left out. */
  private async index(chatId: string): Promise<ChatJobsDoc["jobs"]> {
    const raw = await this.host.store.read(DOC.chatJobs(chatId));
    if (!isRecord(raw) || raw.kind !== "jobs" || !Array.isArray(raw.jobs)) return [];
    return raw.jobs.flatMap((entry: unknown) => (isRecord(entry) && typeof entry.id === "string" && typeof entry.at === "number" ? [{ id: entry.id, at: entry.at, ...(typeof entry.ended === "number" ? { ended: entry.ended } : {}) }] : []));
  }

  /** The jobs some ids name, in the ids' order, each read from its own document: one whose document is gone is left out. */
  async some(ids: readonly string[]): Promise<JobView[]> {
    return (await Promise.all(ids.map((id) => this.doc(id)))).flatMap((doc) => doc?.job ?? []);
  }

  private async ids(): Promise<AllJobsDoc["jobs"]> {
    const raw = await this.host.store.read(DOC.allJobs);
    return isRecord(raw) && raw.kind === "job_ids" && Array.isArray(raw.jobs) ? (raw.jobs as unknown as AllJobsDoc["jobs"]) : [];
  }

  private async openIds(): Promise<string[]> {
    const raw = await this.host.store.read(DOC.runningJobs);
    return isRecord(raw) && raw.kind === "running" && Array.isArray(raw.ids) ? raw.ids.filter((id): id is string => typeof id === "string") : [];
  }

  /**
   * Writes a job as it stands: its own document, and the list of those that wait or run. Its chat's
   * index is written only when the job starts and when it stops (or is carried on again), never for
   * what it does in between. Nothing is written for a chat that was forgotten (§20): a job of its
   * that ends after that leaves no document behind.
   */
  private put(doc: JobDoc): Promise<void> {
    return this.write(async () => {
      const { store } = this.host;
      const { job } = doc;
      if (this.forgotten.has(job.chatId)) return;
      await store.write(DOC.job(job.id), doc as unknown as JsonObject);
      const chat = await this.index(job.chatId);
      const at = chat.findIndex((j) => j.id === job.id);
      const entry = { id: job.id, at: job.createdAt, ...(jobEnded(job) && job.endedAt !== undefined ? { ended: job.endedAt } : {}) };
      if (at < 0 || !jsonEqual(chat[at], entry)) {
        if (at >= 0) chat[at] = entry;
        else chat.push(entry);
        const list: ChatJobsDoc = { v: 1, kind: "jobs", jobs: chat };
        await store.write(DOC.chatJobs(job.chatId), list as unknown as JsonObject);
      }
      if (at < 0) {
        const all: AllJobsDoc = { v: 1, kind: "job_ids", jobs: [...(await this.ids()), { id: job.id, chatId: job.chatId, at: job.createdAt }] };
        await store.write(DOC.allJobs, all as unknown as JsonObject);
      }
      const open = await this.openIds();
      const stays = !jobEnded(job);
      if (stays !== open.includes(job.id)) {
        const running: RunningJobsDoc = { v: 1, kind: "running", ids: stays ? [...open, job.id] : open.filter((id) => id !== job.id) };
        await store.write(DOC.runningJobs, running as unknown as JsonObject);
      }
    });
  }

  /** A job changed: written, and the host told. */
  private async changed(doc: JobDoc): Promise<JobView> {
    await this.put(doc);
    try {
      this.host.jobs?.changed?.(doc.job);
    } catch (error) {
      this.host.log("warn", `[LumiAH] the host took no word of job ${doc.job.id} (${errorText(error)})`);
    }
    return doc.job;
  }

  // ---------------------------------------------------------------- reading

  /** A chat's jobs, the latest first. */
  async list(chatId: string): Promise<JobView[]> {
    return this.some((await this.index(chatId)).map((entry) => entry.id).reverse());
  }

  /** A chat's jobs that haven't stopped (they wait, run or are held), the latest first: the index says which, so only theirs are read. */
  async open(chatId: string): Promise<JobView[]> {
    return this.some(
      (await this.index(chatId))
        .filter((entry) => entry.ended === undefined)
        .map((entry) => entry.id)
        .reverse(),
    );
  }

  /** One page of jobs, the latest first: a chat's, or every chat's. `cursor`: the `next` of the page before. */
  async page(input: { chatId: string | null; cursor: string | null; limit: number }): Promise<{ jobs: JobView[]; next: string | null }> {
    const from = input.cursor === null ? 0 : Number(input.cursor);
    if (!Number.isSafeInteger(from) || from < 0) throw new HarnessRefusal("bad_request", "That isn't a cursor a list of jobs gave.");
    const limit = Number.isSafeInteger(input.limit) && input.limit > 0 ? input.limit : 1;
    if (input.chatId !== null) {
      // Only the page's own jobs are read: the index says which they are.
      const all = (await this.index(input.chatId)).reverse();
      return { jobs: await this.some(all.slice(from, from + limit).map((entry) => entry.id)), next: from + limit < all.length ? String(from + limit) : null };
    }
    const ids = (await this.ids()).reverse();
    const jobs = (await Promise.all(ids.slice(from, from + limit).map((entry) => this.doc(entry.id)))).flatMap((doc) => doc?.job ?? []);
    return { jobs, next: from + limit < ids.length ? String(from + limit) : null };
  }

  /** A job with its task and its report whole; null when there is none (in that chat, where one is named). */
  async read(chatId: string | null, id: string): Promise<JobRead | null> {
    const doc = await this.doc(id);
    if (!doc || (chatId !== null && doc.job.chatId !== chatId)) return null;
    return { job: doc.job, task: doc.task, report: doc.job.report !== undefined ? await this.shared().blobs.get(doc.job.report) : null };
  }

  /**
   * The jobs of a chat a turn's main agent hasn't heard of: those that stopped after `since` and
   * belong to the chat, or to a turn among `records` (the records its path holds). A job of a turn
   * that left the path belongs to another telling of the story. Only those jobs are read: the chat's
   * index says which stopped since, so a turn's cost doesn't grow with the jobs the chat has had.
   */
  async news(chatId: string, records: readonly TurnRecord[], since: number): Promise<JobView[]> {
    const stopped = (await this.index(chatId)).filter((entry) => entry.ended !== undefined && entry.ended > since);
    return (await this.some(stopped.map((entry) => entry.id))).filter((job) => jobEnded(job) && (job.endedAt ?? 0) > since && (job.basis === null || records.some((record) => record.generationId === job.basis)));
  }

  // ---------------------------------------------------------------- forgetting

  /**
   * Forgets a chat's jobs (§20): takes them out of the list of every job and of those that wait or
   * run, and gives their ids, for whoever asked to remove their documents and the chat's index. One
   * step among the job documents' writes: whatever a job was writing has landed before it, and from
   * then on nothing is written for that chat, so no document of its comes back. Whoever asks has
   * ended the chat's jobs first.
   */
  forget(chatId: string): Promise<string[]> {
    return this.write(async () => {
      const { store } = this.host;
      this.forgotten.add(chatId);
      const all = await this.ids();
      const ids = new Set([...(await this.index(chatId)).map((entry) => entry.id), ...all.filter((entry) => entry.chatId === chatId).map((entry) => entry.id)]);
      if (all.some((entry) => ids.has(entry.id))) {
        const stay: AllJobsDoc = { v: 1, kind: "job_ids", jobs: all.filter((entry) => !ids.has(entry.id)) };
        await store.write(DOC.allJobs, stay as unknown as JsonObject);
      }
      const open = await this.openIds();
      if (open.some((id) => ids.has(id))) {
        const running: RunningJobsDoc = { v: 1, kind: "running", ids: open.filter((id) => !ids.has(id)) };
        await store.write(DOC.runningJobs, running as unknown as JsonObject);
      }
      return [...ids];
    });
  }

  // ---------------------------------------------------------------- starting

  /**
   * Makes a job and tells the host it waits. The one way a job comes to be: an agent's `job_start`
   * call and the user on the page reach here, and nothing else does. `refused`: why not, in words
   * for whoever asked.
   */
  async createJob(input: JobCreate, ctx: Pick<Setup, "settings" | "texts" | "definitions">): Promise<JobStarted> {
    const { settings, texts, definitions } = ctx;
    const port = this.host.jobs;
    if (!settings.jobs.enabled) return { refused: texts.render(TEXT.jobs.off) };
    // Never said to a model: an agent isn't offered job_start on a host that can't run jobs.
    if (!port) return { refused: "This runtime can't run jobs." };
    const { lineChars } = settings.tools;
    let agent: string;
    let task: string;
    let again: string | undefined;
    if ("again" in input.what) {
      const old = await this.doc(input.what.again);
      if (!old || old.job.chatId !== input.chatId) return { refused: texts.render(TEXT.jobs.noJob, { id: clip(input.what.again, lineChars) }) };
      if (!jobRestarts(old.job)) return { refused: texts.render(TEXT.jobs.notAgain, { id: old.job.id, state: jobState(old.job, texts) }) };
      agent = old.job.agent;
      task = old.task;
      again = old.job.id;
    } else ({ agent, task } = input.what);
    // The user may give a job to any agent, the main agent among them (§22); an agent, to any but the main agent and the writer, whose work is a turn's reply.
    const may = input.by.who === "user" ? definitions.agents().filter((d) => d.id !== AGENT.writer) : definitions.workers();
    if (!may.some((d) => d.id === agent)) return { refused: texts.render(TEXT.jobs.noAgent, { agent: clip(agent, lineChars), agents: may.map((d) => d.id).join(", ") }) };
    if (task.trim() === "") return { refused: texts.render(TEXT.jobs.noTask) };
    if (task.length > settings.jobs.taskChars) return { refused: texts.render(TEXT.jobs.taskLong, { chars: String(task.length), limit: String(settings.jobs.taskChars) }) };
    let allowance = input.allowance;
    if (input.parent) {
      // A job a job starts may spend no more than is left of the one that started it.
      const own = jobBudget({ ...(allowance ? { allowance } : {}) }, settings);
      const { left } = input.parent;
      allowance = { tokensIn: least(own.tokensIn, left.tokensIn), tokensOut: least(own.tokensOut, left.tokensOut), toolTurns: least(own.toolTurns, left.toolTurns), wallMs: least(own.wallMs, left.wallMs) };
    }
    const job: JobView = {
      // Eight hex digits of a random id, as an agent's: a name, not a limit.
      id: `job_${crypto.randomUUID().slice(0, 8)}`,
      chatId: input.chatId,
      agent,
      task: clip(task, settings.jobs.openingChars),
      when: input.when,
      state: "queued",
      ...(this.holding ? { paused: true as const } : {}),
      by: input.by,
      basis: input.basis,
      ...(again !== undefined ? { again } : {}),
      ...(input.parent ? { parent: input.parent.id } : {}),
      ...(allowance ? { allowance } : {}),
      createdAt: this.host.clock.now(),
      usage: emptyUsage(),
    };
    // A chat a job is started in is there: whatever was forgotten of it before is past.
    this.forgotten.delete(input.chatId);
    const { starter } = input;
    await this.put({ v: 1, kind: "job", job, task, ...(starter ? { held: [...starter.held], depth: starter.depth + 1 } : {}) });
    port.queued(job);
    return job;
  }

  // ---------------------------------------------------------------- the user's controls

  /**
   * Cancels a job that waits, runs or is held: `cancelled` says it did (false for one that had
   * already stopped). Null when there is no such job (in that chat, where one is named).
   */
  async cancel(chatId: string | null, id: string, reason: string): Promise<{ job: JobView; cancelled: boolean } | null> {
    const doc = await this.doc(id);
    if (!doc || (chatId !== null && doc.job.chatId !== chatId)) return null;
    if (jobEnded(doc.job)) return { job: doc.job, cancelled: false };
    const live = this.live.get(id);
    if (!live) return { job: await this.stopped(doc, { state: "cancelled", reason }), cancelled: true };
    live.cancelled = reason;
    live.controller.abort(new AgentStop("cancelled", { id: TEXT.stop.cancelled }));
    return { job: await live.done, cancelled: true };
  }

  /**
   * The user holds every job, or lets them go. Held: those running wait at their next round, and one
   * that begins meanwhile begins held. Let go: those running go on, and so does every job held with
   * no run under way (one that began to wait meanwhile, one a restart found held): a job left held
   * would begin held when the host runs it, and keep its place among the jobs at once.
   */
  async hold(paused: boolean): Promise<{ paused: boolean }> {
    this.holding = paused;
    for (const { run } of this.live.values()) {
      if (paused) run?.pause();
      else run?.resume();
    }
    if (!paused) for (const id of await this.openIds()) await this.resumeWaiting(id);
    return { paused };
  }

  get held(): boolean {
    return this.holding;
  }

  /** Holds a job that isn't running here yet (it waits to run): it begins held. False when there is no such job waiting. */
  async pauseWaiting(id: string): Promise<boolean> {
    const doc = await this.doc(id);
    if (!doc || doc.job.state !== "queued" || this.live.get(id)?.run) return false;
    await this.changed({ ...doc, job: { ...doc.job, paused: true } });
    return true;
  }

  /**
   * Lets go a job that is held with no run under way: one that waits goes on waiting, unheld; one a
   * restart found held waits to run again, and carries on from its own session. False when there is
   * no such job.
   */
  async resumeWaiting(id: string): Promise<boolean> {
    const doc = await this.doc(id);
    if (!doc || this.live.get(id)?.run || doc.job.paused !== true || (doc.job.state !== "queued" && doc.job.state !== "paused")) return false;
    const { paused: _held, ...rest } = doc.job;
    const job: JobView = { ...rest, state: "queued" };
    await this.changed({ ...doc, job });
    if (doc.job.state === "paused") this.host.jobs?.queued(job);
    return true;
  }

  /**
   * Has a job that stopped at a limit carry on (§22): one its own allowance stopped is granted more
   * (each member given stands in place of what it had); one a day's limit stopped needs no more of
   * its own, and is granted nothing. It waits to run again, and carries on from its own session. If
   * the limit that stopped it still stands, it stops there again, having made no call.
   */
  async grant(id: string, allowance: JobAllowance): Promise<JobView> {
    const doc = await this.doc(id);
    if (!doc) throw new HarnessRefusal("not_found", `There is no job ${id}.`);
    const port = this.host.jobs;
    if (!port) throw new HarnessRefusal("unavailable", "This runtime can't run jobs.");
    if (doc.job.state !== "spent") throw new HarnessRefusal("conflict", "Only a job that stopped at a limit can be carried on. One that failed or was cancelled can be started again.");
    const { endedAt: _ended, reason: _reason, stoppedAt: _limit, ...rest } = doc.job;
    const granted = { ...doc.job.allowance, ...allowance };
    const job: JobView = { ...rest, state: "queued", ...(Object.keys(granted).length > 0 ? { allowance: granted } : {}) };
    await this.changed({ ...doc, job });
    port.queued(job);
    return job;
  }

  // ---------------------------------------------------------------- where a job's turn stands

  /** A turn ended: jobs that belong to it know from when to wait for its record, and whether one is coming. */
  turnEnded(generationId: string, record: boolean): void {
    const now = this.host.clock.now();
    const wait = this.shared().latest.jobs.recordWaitMs;
    for (const [id, ended] of this.ended) if (now - ended.at > wait) this.ended.delete(id);
    this.ended.set(generationId, { at: now, record });
  }

  /**
   * Whether the turn a job belongs to stands on the chat's active path. A turn still under way does.
   * One that ended a moment ago and left a record is waited for, as long as Settings say: Lumiverse
   * saves the reply first, and the record is anchored only then.
   */
  private async stands(job: Pick<JobView, "chatId" | "basis">, waitMs: number, signal: AbortSignal): Promise<boolean> {
    const { basis } = job;
    if (basis === null) return true;
    const { host, runs } = this.shared();
    for (;;) {
      if (runs.has(basis)) return true;
      const turns = await pathTurns(await host.chat.path(job.chatId));
      if (turns.some((turn) => turn.onPath && turn.record.generationId === basis)) return true;
      const ended = this.ended.get(basis);
      if (!ended?.record || host.clock.now() - ended.at >= waitMs) return false;
      await host.clock.sleep(Math.max(1, Math.ceil(waitMs / RECORD_LOOKS)), signal);
    }
  }

  /**
   * Writes a job as it stands into the record of the turn it belongs to, with the chat's area as it
   * stands (§15: its report is listed with that record). Nothing waits for it: a turn that ended a
   * moment ago has its record written on only once Lumiverse has saved the reply.
   */
  private listOn(job: JobView): void {
    const { basis } = job;
    if (basis === null) return;
    const listing = async (): Promise<void> => {
      if (!(await this.stands(job, this.shared().latest.jobs.recordWaitMs, new AbortController().signal))) return;
      await this.write(() => this.onRecord(job, basis));
    };
    listing().catch((error: unknown) => this.host.log("warn", `[LumiAH] job ${job.id} couldn't be listed on its turn's record (${errorText(error)})`));
  }

  private async onRecord(job: JobView, basis: string): Promise<void> {
    const { host, runs, areas } = this.shared();
    const entry: RecordJob = { id: job.id, agent: job.agent, state: job.state, ...(job.report !== undefined ? { report: job.report } : {}) };
    const under = runs.get(basis);
    if (under) {
      // Its turn is still under way: the turn's own record lists it as it stands then.
      const at = under.jobs.findIndex((j) => j.id === job.id);
      if (at >= 0) under.jobs[at] = entry;
      else under.jobs.push(entry);
      return;
    }
    const turns = await pathTurns(await host.chat.path(job.chatId));
    const turn = turns.find((t) => t.onPath && t.record.generationId === basis);
    if (!turn) return;
    const head = await areas.at(job.chatId, turn.record).headHash();
    const changed = (await areas.changes(job.chatId, turns, turn)).length;
    const { changed: _was, ...rest } = turn.record;
    const record: TurnRecord = { ...rest, jobs: [...(turn.record.jobs ?? []).filter((j) => j.id !== job.id), entry], ...(head !== null ? { workspace: head } : {}), ...(changed > 0 ? { changed } : {}) };
    if (!(await host.chat.anchor(job.chatId, turn.messageId, turn.swipeId, record as unknown as JsonValue))) host.log("warn", `[LumiAH] job ${job.id} couldn't be listed on its turn's record: the reply is gone`);
  }

  /** What a job spent in one run counts against the job that started it too (§22): against that job's run where it is under way here, else in its document. */
  private async charge(parent: string, spent: AgentUsage): Promise<void> {
    const run = this.live.get(parent)?.run;
    if (run) {
      addUsage(run.agents.usage, spent);
      return;
    }
    const doc = await this.doc(parent);
    if (!doc) return;
    const usage = { ...doc.job.usage };
    addUsage(usage, spent);
    await this.put({ ...doc, job: { ...doc.job, usage } });
  }

  /** A job stops without having run here: written as it ends, listed on its turn's record, and the host told. */
  private async stopped(doc: JobDoc, change: { state: JobState; reason: string }): Promise<JobView> {
    const { paused: _held, ...rest } = doc.job;
    const job: JobView = { ...rest, ...change, endedAt: this.host.clock.now() };
    await this.changed({ ...doc, job });
    this.listOn(job);
    return job;
  }

  // ---------------------------------------------------------------- running

  /**
   * Runs a job that waits: the host calls this when it will (§15). Resolves with the job as it
   * stopped. A job that doesn't wait (it ran already, or was cancelled) is given as it stands. The
   * signal is the host's: it ends the run, and a job so ended is interrupted, to be started again.
   */
  run(input: { id: string }, signal: AbortSignal): Promise<JobView> {
    const had = this.live.get(input.id);
    if (had) return had.done;
    const { promise, resolve, reject } = Promise.withResolvers<JobView>();
    const live: Live = { controller: new AbortController(), cancelled: null, run: null, done: promise };
    this.live.set(input.id, live);
    this.work(input.id, live, signal)
      .finally(() => this.live.delete(input.id))
      .then(resolve, reject);
    return promise;
  }

  private async work(id: string, live: Live, hostSignal: AbortSignal): Promise<JobView> {
    const shared = this.shared();
    const { host } = shared;
    const signal = AbortSignal.any([hostSignal, live.controller.signal]);
    const waiting = await this.doc(id);
    if (!waiting) throw new HarnessRefusal("not_found", `There is no job ${id}.`);
    if (waiting.job.state !== "queued") return waiting.job;
    let leave: () => void;
    try {
      leave = await this.gate.enter(signal);
    } catch {
      // It never got its place: cancelled while it waited, or the host stopped waiting, in which case it waits on to be run again.
      return live.cancelled !== null ? this.stopped(waiting, { state: "cancelled", reason: live.cancelled }) : waiting.job;
    }
    try {
      // Read again: it waited for its place, and may have been held or cancelled meanwhile.
      const doc = (await this.doc(id)) ?? waiting;
      if (doc.job.state !== "queued") return doc.job;
      // What a run reads before it begins can fail too (the user's settings can't be read), and that is the job's own failure as much as one after: left waiting, it would wait for good, since the host runs a job it was told of once. Failed, it can be started again. A cancel that came meanwhile stands.
      const setup = await readSetup(shared, doc.job.chatId).catch((error: unknown) => errorText(error));
      if (typeof setup === "string") return await this.stopped(doc, live.cancelled !== null ? { state: "cancelled", reason: live.cancelled } : { state: "failed", reason: setup });
      const { settings, texts } = setup;
      if (!settings.jobs.enabled) return await this.stopped(doc, { state: "cancelled", reason: texts.render(TEXT.jobs.whyOff) });
      const resolved = setup.definitions.resolve(doc.job.agent, settings);
      if (!resolved) return await this.stopped(doc, { state: "failed", reason: texts.render(TEXT.jobs.whyGone, { agent: doc.job.agent }) });
      if (!(await this.stands(doc.job, settings.jobs.recordWaitMs, signal).catch(() => true))) return await this.stopped(doc, { state: "off_path", reason: texts.render(this.ended.get(doc.job.basis ?? "")?.record === false ? TEXT.jobs.whyNoRecord : TEXT.jobs.whyOffPath) });

      const startedAt = host.clock.now();
      const before: AgentUsage = { ...doc.job.usage };
      const workedBefore = doc.job.workedMs ?? 0;
      const { endedAt: _ended, reason: _reason, stoppedAt: _limit, ...carried } = doc.job;
      let job: JobView = { ...carried, state: "running", startedAt: doc.job.startedAt ?? startedAt };
      let session = doc.session;
      /** How the run came out is known: nothing that comes late (a hold, a session kept) writes the job after that. */
      let over = false;
      // What the job was started with (the tools its starter held, how deep it stands) is kept with it through every write of the run.
      const { held, depth } = doc;
      const save = (): Promise<JobView> => this.changed({ v: 1, kind: "job", job, task: doc.task, ...(session !== undefined ? { session } : {}), ...(held !== undefined ? { held } : {}), ...(depth !== undefined ? { depth } : {}) });
      const run = new Run(shared, setup, {
        info: { id: job.id, kind: "job", chatId: job.chatId },
        budget: jobBudget(job, settings),
        words: JOB_WORDS,
        startedAt,
        messageId: null,
        job: job.id,
        spent: { usage: job.usage, workedMs: workedBefore },
        held: (paused) => {
          if (over) return;
          const { paused: _was, ...rest } = job;
          job = paused ? { ...rest, paused: true } : rest;
          save().catch((error: unknown) => host.log("warn", `[LumiAH] job ${job.id}'s hold couldn't be kept (${errorText(error)})`));
        },
      });
      live.run = run;
      /** How long the job has worked by `now`, over every run of it, less the time it was held. */
      const workedBy = (now: number): number => workedBefore + Math.max(0, now - startedAt - run.agents.held(now));

      /** The job's agent at work, from what it is given to how it came out. */
      const worked = async (): Promise<Outcome> => {
        let left = false;
        // Asked before each of its writes: the turn it belongs to must still stand on the path. Once it doesn't, the job stops.
        const onPath = async (): Promise<string | null> => {
          if (await this.stands(job, settings.jobs.recordWaitMs, signal)) return null;
          left = true;
          live.controller.abort(new AgentStop("off_path", { id: TEXT.jobs.stopOffPath }));
          return texts.render(TEXT.jobs.whyOffPath);
        };
        const { areas } = shared;
        const learned = await areas.learned(job.chatId);
        const equipment: Equipment = {
          chat: chatView(host, job.chatId, await host.chat.path(job.chatId), settings.tools),
          lore: loreView(host, { chatId: job.chatId, generationId: job.id }, settings.tools),
          // A job the user started belongs to the chat and to no turn: the chat's own area, which follows the story's path, isn't its to change.
          areas: job.basis === null ? { chat: areas.now(job.chatId, { gate: async () => texts.render(TEXT.jobs.noChatArea) }), learned, user: areas.user() } : { chat: areas.now(job.chatId, { basis: job.basis, gate: onPath }), learned: gated(learned, onPath), user: gated(areas.user(), onPath) },
          past: [],
          basis: job.basis,
        };
        await run.equip(equipment);
        if (job.paused || this.holding) run.pause();
        await save();

        const history = session !== undefined ? sessionOf(await shared.blobs.getJson(session)) : null;
        // A job an agent started is given no more than that agent held (§14), as a sub-agent is, unless its definition keeps its tools whoever starts it; and it stands one deeper than its starter, so what it may delegate is counted on from there. One the user started holds its definition's tools, at 0.
        const grant = held !== undefined && (resolved.definition.grant ?? settings.delegation.grant) === "own" ? { grant: new Set(held) } : {};
        const { agent, lead } = await run.agent(resolved, { depth: depth ?? 0, task: job.task, notes: true, main: true, ...grant, ...(history ? { history } : {}) });
        /** Keeps the job's session as it stands, for a run that carries the job on. */
        const keep = async (): Promise<void> => {
          session = await shared.blobs.putJson(agent.messages() as unknown as JsonValue, false);
        };
        // The user's hold has taken: what the job has done is whole now, so its session is kept, and a restart finds it held with something to carry on from.
        run.agents.onHeld = (): void => {
          keep()
            .then(() => {
              if (over) return undefined;
              // What it has spent is kept with its session: carried on after a restart, the job counts it against what it may spend.
              job = { ...job, usage: { ...run.agents.usage }, workedMs: workedBy(host.clock.now()) };
              return save();
            })
            .catch((error: unknown) => host.log("warn", `[LumiAH] job ${job.id}'s session couldn't be kept (${errorText(error)})`));
        };
        // Only a job the user started is asked for a plan (§22), so only its texts name one.
        const plan = job.by.who === "user" ? planPath(job.id) : null;
        const allowance = allowanceText(run.left(), texts);
        const message = history ? texts.render(TEXT.jobs.resumed, { allowance, plan: plan === null ? "" : texts.render(TEXT.jobs.resumedPlan, { plan }) }) : plan !== null ? texts.render(TEXT.jobs.objective, { task: doc.task, allowance, plan }) : texts.render(TEXT.jobs.task, { task: doc.task });
        const reply = await agent.send(lead === "" ? message : `${lead}\n\n${message}`, signal);

        const at = host.clock.now();
        const said = reply.text.trim();
        const whole = reply.status === "answered" && said !== "" && !cutShort(reply.finish);
        const told = said === "" ? null : reply.text;
        if (live.cancelled !== null) return { state: "cancelled", reason: live.cancelled, report: told, at };
        if (left || reply.code === "off_path") return { state: "off_path", reason: texts.render(TEXT.jobs.whyOffPath), report: told, at };
        if (hostSignal.aborted) {
          // The host stopped the run. A job the user held stays held, with its session; any other is interrupted, to be started again.
          const reason = stopWords(hostSignal) ?? texts.render(TEXT.jobs.whyStopped);
          if (!run.agents.paused) return { state: "interrupted", reason, report: told, at };
          await keep();
          return { state: "paused", reason, report: told, at };
        }
        if (reply.code !== undefined && (reply.code === DAY_STOP || ALLOWANCE_STOPS.includes(reply.code))) {
          // Its agent can make no further call, so what it leaves is said for it: why it stopped, what it had last written, the files it wrote, and where its plan is. A day's limit says how the job is carried on; its own allowance, that it can be granted more.
          const day = reply.code === DAY_STOP;
          const files = [...new Set(run.wrote.map((file) => showPath(file.area, file.path)))];
          const report = texts.render(day ? TEXT.jobs.dayReport : TEXT.jobs.spentReport, {
            reason: reply.reason ?? "",
            said: told === null ? "" : texts.render(TEXT.jobs.spentSaid, { text: told }),
            files: files.length === 0 ? "" : texts.render(TEXT.jobs.spentFiles, { files: files.join(", ") }),
            plan: plan === null ? "" : texts.render(TEXT.jobs.spentPlan, { plan }),
          });
          // A run that made no call (the limit still stood when the job was carried on, or stood before it ever began) leaves the session as it was: nothing was learned, and the words that carried it on would only pile up in it.
          if (run.agents.usage.calls > before.calls) await keep();
          return { state: "spent", ...(reply.reason !== undefined ? { reason: reply.reason } : {}), stoppedAt: day ? "day" : "allowance", report, at };
        }
        if (!whole) return { state: "failed", reason: reply.status === "answered" && said !== "" ? texts.render(TEXT.agents.cut) : (reply.reason ?? texts.render(TEXT.jobs.whyNoAnswer)), report: told, at };
        // The moment it would report: its turn must still stand on the path, else the report is marked off the path.
        if (await this.stands(job, settings.jobs.recordWaitMs, hostSignal).catch(() => true)) return { state: "done", report: told, at };
        return { state: "off_path", reason: texts.render(TEXT.jobs.whyOffPath), report: told, at };
      };
      // Whatever breaks between the run's start and its end (a port that fails, a blob that can't be read) is the job's own failure, in the failure's own words: the run is closed and the job written all the same, and whoever ran it is given the job, never a rejection. A cancel that came meanwhile stands.
      const { state, reason, stoppedAt, report, at } = await worked().catch((error: unknown): Outcome => ({ state: live.cancelled !== null ? "cancelled" : "failed", reason: live.cancelled ?? errorText(error), report: null, at: host.clock.now() }));
      over = true;

      const usage: AgentUsage = { ...run.agents.usage };
      const ended = { status: state === "done" ? ("done" as const) : state === "failed" ? ("failed" as const) : ("stopped" as const), ...(reason !== undefined ? { reason } : {}), at };
      run.close(ended, usage);
      const { paused: _held, transcript: _old, report: _report, reportChars: _chars, opening: _opening, ...rest } = job;
      job = {
        ...rest,
        state,
        ...(state === "paused" ? { paused: true as const } : { endedAt: at }),
        usage,
        workedMs: workedBy(at),
        ...(reason !== undefined ? { reason } : {}),
        ...(stoppedAt !== undefined ? { stoppedAt } : {}),
      };
      try {
        if (report !== null) job = { ...job, report: await shared.blobs.put(report), reportChars: report.length, opening: clip(report, settings.jobs.openingChars) };
        if (settings.keep.transcripts) job = { ...job, transcript: await shared.blobs.putJson(run.trace.transcript({ generation: "job", messageId: null, startedAt, ended }), false) };
      } catch (error) {
        host.log("warn", `[LumiAH] job ${job.id}'s report or transcript couldn't be stored (${errorText(error)})`);
      }
      // Only a job that may be carried on keeps its session.
      if (state !== "paused" && state !== "spent") session = undefined;
      try {
        await save();
        if (job.parent !== undefined) await this.charge(job.parent, usageSince(usage, before));
      } catch (error) {
        // The job ended all the same: whoever ran it is given it as it ended, and the store keeps it as it could last be written.
        host.log("warn", `[LumiAH] job ${job.id} ended (${state}) and couldn't be written (${errorText(error)})`);
      }
      this.listOn(job);
      const extension = shared.options.extension;
      run.hook("answer to a run ending", extension?.runEnded ? () => extension.runEnded?.({ userId: run.userId, chatId: job.chatId, turn: job.id, kind: "job", status: ended.status, ...(reason !== undefined ? { reason } : {}), reply: "", record: null, usage }) ?? Promise.resolve() : undefined);
      return job;
    } finally {
      leave();
    }
  }

  // ---------------------------------------------------------------- after a restart

  /**
   * Looks through the jobs that waited or ran when the runtime last stopped: one that ran is marked
   * interrupted, with what it had written kept, unless the user held it and its session was kept,
   * in which case it stays held; one that waited is given back for the host to run.
   */
  async recover(): Promise<{ interrupted: JobView[]; paused: JobView[]; queued: JobView[] }> {
    let texts = textsOf(null);
    try {
      texts = textsOf((await this.shared().options.settings()).texts);
    } catch {
      // The shipped words do: nothing here is sent to a model.
    }
    const found = { interrupted: [] as JobView[], paused: [] as JobView[], queued: [] as JobView[] };
    for (const id of await this.openIds()) {
      if (this.live.has(id)) continue;
      const doc = await this.doc(id);
      if (!doc) continue;
      const { job } = doc;
      if (job.state === "queued") found.queued.push(job);
      else if (job.state === "paused") found.paused.push(job);
      else if (job.state === "running" && job.paused === true && doc.session !== undefined) found.paused.push(await this.changed({ ...doc, job: { ...job, state: "paused" } }));
      else if (job.state === "running") found.interrupted.push(await this.stopped(doc, { state: "interrupted", reason: texts.render(TEXT.jobs.whyInterrupted) }));
      else await this.put(doc);
    }
    return found;
  }
}
