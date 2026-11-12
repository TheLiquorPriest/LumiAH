// What runs besides replies, and what the pages ask of the core (DESIGN §15, §18, §19, §20), in the
// runtime, which holds the core. The core keeps its state in documents only the place that holds it
// writes, so:
//
// - A job the core queued is run here when its time comes: at once for `now`; for `after_reply`,
//   once a reply turn of its chat has returned (the turn that started it, or the chat's next one for
//   a job the user started). The core does the rest: how many run at once, each job's budget, the
//   day's tokens, whether its turn is still on the chat's path. A job is stopped by its signal (the
//   user's Stop, a shutdown); what a restart cut off is marked interrupted when the place starts.
// - A side session's turn is started here when a page says something in it.
// - Whatever else a page asks of the core (a workspace file read or written, a list of jobs, the
//   spend, the sweep) is one call of the harness: the request's body in, the core's own answer out.
//   Only the methods listed here can be reached.
// - A chat Lumiverse deleted is forgotten here when the extension hands it over (`chats.forget`):
//   the core removes what it kept of it. No page asks for that; the extension does, on its own.
//
// The ops an `ask` push may name are fixed here, beside the link's contract; the runtime runs this.

import type { JobView, ReplySink } from "../core/ports";
import type { JsonObject, JsonValue } from "./json";
import { isRecord } from "./json";

/**
 * What the work runner reaches of the core's harness (`createHarness(host, …)`). Each member is
 * optional, so a harness without it still fits (a test's, an older build's): running a job it
 * queued and marking what a restart cut off (DESIGN §15), a side session's turn (§19), and the
 * user's words to a run under way (§18). Its page-facing methods (`workspace.list`, `jobs.start`,
 * …) are reached by name.
 */
export interface WorkHarness {
  jobs?: {
    /** Runs a queued job to its end; the signal stops it. */
    run(input: { id: string }, signal: AbortSignal): Promise<unknown>;
    /** Marks the jobs a restart cut off as interrupted; what it found: those, the ones the restart found held, and the ones that still waited to run (each a job as the core says it, checked where it is read). */
    recover(): Promise<{ interrupted: unknown[]; paused: unknown[]; queued: unknown[] }>;
    /** The user's hold on every job, or its end. */
    hold?(input: { paused: boolean }): Promise<unknown>;
  };
  side?(input: { session: string; generationId: string; text: string }, sink: ReplySink, signal: AbortSignal): Promise<unknown>;
  /** Something the user said to a run under way. Rejects (`not_found`) when there is no such run. */
  say?(input: { run: string; text: string }): Promise<{ said: boolean }>;
  /** Holds every agent of a run at its next round, and lets them go on; `resume` of a job a restart left held has the core queue it again. Each rejects when there is no such run or job. */
  pause?(input: { run: string }): Promise<{ paused: boolean }>;
  resume?(input: { run: string }): Promise<{ paused: boolean }>;
  /** Forgets a chat Lumiverse deleted: whatever the core kept of it. Rejects (`conflict`) while a reply or a side session's answer is worked on in it. */
  chats?: { forget(input: { chatId: string }): Promise<unknown> };
}

/** A request the place that holds the core (or the core itself) refuses, with one of the pages' error codes and words the page shows. */
export class OpRefused extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "OpRefused";
  }
}

/** The page-facing methods of the harness, as `group.method`: each takes the request's body and resolves the core's own answer. */
const PAGE_OPS: Readonly<Record<string, true>> = {
  "workspace.list": true,
  "workspace.read": true,
  "workspace.write": true,
  "workspace.move": true,
  "workspace.delete": true,
  "workspace.pin": true,
  "workspace.history": true,
  "workspace.changes": true,
  "guidance.get": true,
  "guidance.set": true,
  "definitions.get": true,
  "definitions.held": true,
  "session.summarize": true,
  "jobs.list": true,
  "jobs.start": true,
  "jobs.cancel": true,
  "jobs.again": true,
  "jobs.read": true,
  "jobs.grant": true,
  "sides.list": true,
  "sides.start": true,
  "sides.turns": true,
  "sides.remove": true,
  "spend.get": true,
  "upkeep.get": true,
  "upkeep.sweep": true,
  "recall.lore": true,
  "recall.entry": true,
  "recall.search": true,
  "recall.embed": true,
  "recall.chronicle": true,
  "recall.cited": true,
  "recall.story": true,
  "approvals.kept": true,
  "approvals.forget": true,
};

function jobOf(raw: unknown): JobView | null {
  return isRecord(raw) && typeof raw.id === "string" && typeof raw.chatId === "string" && typeof raw.state === "string" ? (raw as unknown as JobView) : null;
}

/** Whether the core refused something because the run or the job it names is no longer there. */
function gone(error: unknown): boolean {
  return isRecord(error) && error.code === "not_found";
}

export interface WorkEnv {
  log(text: string): void;
  /** 128 random bits as hex: a side session turn's id. */
  id(): string;
  /** Runs `fn` as the work of a run, where the place tells its runs apart that way (a runtime names the run on each model call, so the extension can end them with it). */
  within<T>(run: { turn: string; chat: string }, fn: () => Promise<T>): Promise<T>;
  /** A run is over: what it traced has gone out, and the trace lets go of it. */
  traced(run: string): Promise<void>;
  /** A job was queued or changed: the pages hear of it. */
  tell(job: JobView): void;
  /**
   * The place's own words: for something this build of it can't do (`notYet`), for an op it has no
   * name for, and for why its runs end when it stops (`ending`).
   */
  words: { notYet: string; noSuch(op: string): string; ending: string };
}

interface Running {
  /** The side session a side turn belongs to; null for a job. */
  session: string | null;
  stop: AbortController;
}

export class Work {
  /** The job runs and side turns under way, by the run's id (the job's id, the side turn's). */
  private readonly running = new Map<string, Running>();
  /** The `after_reply` jobs waiting for their chat's reply, by chat, in the order they were queued. */
  private readonly waiting = new Map<string, JobView[]>();
  /** The user holds every job: one that begins is paused at its first round. */
  private hold = false;
  private recovering: Promise<void> | null = null;

  constructor(
    private readonly harness: WorkHarness,
    private readonly env: WorkEnv,
  ) {}

  /** The runs under way here: a runtime names them on its ping, and a run the extension shows that it no longer names is over. */
  ids(): string[] {
    return [...this.running.keys()];
  }

  /** Whether the core was told of the user's hold since this place started: the first word goes whatever it says, since the core may still hold another from before a restart. */
  private holdTold = false;
  /** Ends with the place: what the core does at a page's word and takes a signal for (the sweep) stops with it. */
  private readonly ending = new AbortController();

  // ---------------------------------------------------------------- jobs

  /** The core queued a job (`JobsPort.queued`). */
  queued(job: JobView): void {
    this.env.tell(job);
    // One that ran before (granted more, or let go on after a restart) has no reply left to wait for.
    if (job.when === "after_reply" && job.startedAt === undefined) {
      const list = this.waiting.get(job.chatId) ?? [];
      list.push(job);
      this.waiting.set(job.chatId, list);
      return;
    }
    this.start(job);
  }

  /** A job changed (`JobsPort.changed`). */
  changed(job: JobView): void {
    this.env.tell(job);
  }

  /** A reply turn of a chat has returned: the jobs that waited for it start. */
  replied(chatId: string): void {
    const list = this.waiting.get(chatId);
    if (list === undefined) return;
    this.waiting.delete(chatId);
    for (const job of list) this.start(job);
  }

  private start(job: JobView): void {
    const jobs = this.harness.jobs;
    if (jobs === undefined || this.running.has(job.id)) return;
    const stop = new AbortController();
    this.running.set(job.id, { session: null, stop });
    void this.env
      .within({ turn: job.id, chat: job.chatId }, () => jobs.run({ id: job.id }, stop.signal))
      .catch((error: unknown) => this.env.log(`job ${job.id.slice(0, 8)} failed to run: ${error instanceof Error ? error.message : String(error)}`))
      .finally(() => this.over(job.id));
  }

  private over(run: string): void {
    this.running.delete(run);
    void this.env.traced(run).catch(() => undefined);
  }

  /** The user holds every job, or lets them go on: the core holds those running at their agents' next round, and one that begins at its first. */
  async setHold(on: boolean): Promise<void> {
    if (this.holdTold && this.hold === on) return;
    const jobs = this.harness.jobs;
    if (jobs?.hold === undefined) return;
    await jobs.hold({ paused: on });
    this.hold = on;
    this.holdTold = true;
  }

  /**
   * Once the place has started (a runtime: once its link is up): the core marks the jobs a restart
   * cut off as interrupted, and says which it found held and which still waited to run. All are
   * told to the pages; those that waited are run now, since the turn one of them waited for ended
   * with the restart. Asked again the next time when it couldn't be done.
   */
  recover(): Promise<void> {
    const jobs = this.harness.jobs;
    if (jobs === undefined) return Promise.resolve();
    if (this.recovering !== null) return this.recovering;
    const recovering = jobs.recover().then(
      (found) => {
        const jobsOf = (list: readonly unknown[]): JobView[] => list.flatMap((raw) => jobOf(raw) ?? []);
        for (const job of [...jobsOf(found.interrupted), ...jobsOf(found.paused)]) this.env.tell(job);
        for (const job of jobsOf(found.queued)) {
          this.env.tell(job);
          this.start(job);
        }
      },
      (error: unknown) => {
        this.recovering = null;
        this.env.log(`couldn't look for jobs a restart interrupted: ${error instanceof Error ? error.message : String(error)}`);
      },
    );
    this.recovering = recovering;
    return recovering;
  }

  // ---------------------------------------------------------------- side sessions

  /** Says something in a side session: its next turn starts, and is followed by its id. One turn of a session runs at a time. */
  send(session: string, text: string): { turn: string } {
    const side = this.harness.side;
    if (side === undefined) throw new OpRefused("unavailable", this.env.words.notYet);
    for (const running of this.running.values()) if (running.session === session) throw new OpRefused("unavailable", "The agent is still working on what you said before. Wait for it to answer, or stop it.");
    const turn = this.env.id();
    const stop = new AbortController();
    this.running.set(turn, { session, stop });
    // Nothing reads a side turn's reply as it is written: the live view follows its trace, and the core keeps its answer with the session.
    const sink: ReplySink = { progress: () => undefined, reasoning: () => undefined, content: () => undefined, done: () => undefined, error: () => undefined };
    void this.env
      .within({ turn, chat: "" }, () => side.call(this.harness, { session, generationId: turn, text }, sink, stop.signal))
      .catch((error: unknown) => this.env.log(`side session ${session.slice(0, 8)}: its turn failed to run: ${error instanceof Error ? error.message : String(error)}`))
      .finally(() => this.over(turn));
    return { turn };
  }

  // ---------------------------------------------------------------- stopping and talking to a run

  /** Stops a job's run or a side session's turn; false when it isn't one under way here. */
  stop(run: string, why: string): boolean {
    const running = this.running.get(run);
    if (running === undefined) return false;
    running.stop.abort(new Error(why));
    return true;
  }

  /** The place is stopping: every run ends. A job cut off this way is found interrupted at the next start. */
  shutdown(): void {
    const ending = new Error(this.env.words.ending);
    this.ending.abort(ending);
    for (const running of this.running.values()) running.stop.abort(ending);
  }

  /** Something the user said to a run under way (DESIGN §18); false when the run is over, which the core says by refusing it. */
  async say(run: string, text: string): Promise<boolean> {
    const say = this.harness.say;
    if (say === undefined) return false;
    try {
      return (await say.call(this.harness, { run, text })).said === true;
    } catch (error) {
      if (gone(error)) return false;
      throw error;
    }
  }

  /** Holds every agent of a run at its next round, or lets them go on; whether the run took it (false: it is over). */
  async pause(run: string, on: boolean): Promise<boolean> {
    const word = on ? this.harness.pause : this.harness.resume;
    if (word === undefined) return false;
    try {
      await word.call(this.harness, { run });
      return true;
    } catch (error) {
      if (gone(error)) return false;
      throw error;
    }
  }

  // ---------------------------------------------------------------- what a page asks

  /** One thing a page asked of the core (`ask` on the link): the op's own answer. Rejects with what refused it. */
  async ask(op: string, args: JsonObject): Promise<JsonValue> {
    switch (op) {
      case "run.say":
        return { said: typeof args.run === "string" && typeof args.text === "string" && (await this.say(args.run, args.text)) };
      case "run.pause": {
        const on = args.on === true;
        const took = typeof args.run === "string" && (await this.pause(args.run, on));
        return { paused: took ? on : false, took };
      }
      case "side.send": {
        if (typeof args.session !== "string" || typeof args.text !== "string") throw new OpRefused("bad_request", "A side session's turn needs the session and what you said.");
        return this.send(args.session, args.text);
      }
      case "job.resume": {
        if (typeof args.id !== "string") throw new OpRefused("bad_request", "A job is named by its id.");
        // A job a restart left held has no run to let go: the core queues it again, and it carries on from its own session.
        if (this.harness.resume === undefined) throw new OpRefused("unavailable", this.env.words.notYet);
        await this.harness.resume({ run: args.id });
        return this.ask("jobs.read", { id: args.id });
      }
      case "chats.forget": {
        if (typeof args.chatId !== "string" || args.chatId === "") throw new OpRefused("bad_request", "Say which chat to forget.");
        if (this.harness.chats === undefined) throw new OpRefused("unavailable", this.env.words.notYet);
        const forgot = await this.harness.chats.forget({ chatId: args.chatId });
        return forgot === undefined ? null : (forgot as JsonValue);
      }
      default:
        break;
    }
    if (!Object.hasOwn(PAGE_OPS, op)) throw new OpRefused("bad_request", this.env.words.noSuch(op));
    const [group = "", method = ""] = op.split(".");
    const members: unknown = (this.harness as unknown as Record<string, unknown>)[group];
    const fn: unknown = isRecord(members) ? members[method] : undefined;
    if (typeof fn !== "function") throw new OpRefused("unavailable", this.env.words.notYet);
    // The sweep takes a signal where the others take the request's body: it ends with the place.
    const out: unknown = op === "upkeep.sweep" ? await (fn as (this: unknown, signal: AbortSignal) => Promise<unknown>).call(members, this.ending.signal) : await (fn as (this: unknown, input: JsonObject) => Promise<unknown>).call(members, args);
    // A cancelled job's run ends by its own signal too, should the core leave that to its caller.
    if (op === "jobs.cancel" && typeof args.id === "string") this.stop(args.id, "The job was cancelled.");
    return out === undefined ? null : (out as JsonValue);
  }
}

/** A refusal as a page is told it: the pages' code the core or its place gave it (`internal` for anything else), its words, and what it found wrong with a value where it says. */
export function refusalOf(error: unknown): { code: string; message: string; problems?: JsonValue } {
  const message = error instanceof Error ? error.message : String(error);
  const code = isRecord(error) && typeof error.code === "string" ? error.code : error instanceof OpRefused ? error.code : "internal";
  const problems: unknown = isRecord(error) ? error.problems : undefined;
  return { code, message, ...(Array.isArray(problems) ? { problems: problems as JsonValue } : {}) };
}
