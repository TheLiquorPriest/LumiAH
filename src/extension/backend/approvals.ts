// The tool calls held for the user's word (DESIGN §17). An agent's call of a tool whose tier or own
// setting says "ask" waits here until the user answers on a page (any page of theirs: the held
// calls are part of the state every page holds), until the asking side gives the wait up (its run
// stopped, or the wait Settings allow ran out: the core does that wait), or until its run is over.
// Nothing is stored: a call can only wait while its run does, and a run doesn't outlive the
// extension. What a "for this chat" answer stands for from then on is the core's to keep.

import type { ApprovalAnswer, ApprovalAsk } from "../../core/ports";
import type { ApprovalView, StreamId } from "../../shared/ui";
import type { JobsBoard } from "./jobs";
import type { LiveBuffer } from "./live";

interface Held {
  userId: string;
  view: ApprovalView;
  settle(answer: ApprovalAnswer | Error): void;
}

export interface ApprovalsEnv {
  /** An id no other held call has. */
  id(): string;
}

export class Approvals {
  /** The held calls, the one asked first first. */
  private readonly held = new Map<string, Held>();
  private readonly changed: ((userId: string) => void)[] = [];

  constructor(private readonly env: ApprovalsEnv) {}

  /** A user's held calls changed. */
  onChange(listener: (userId: string) => void): void {
    this.changed.push(listener);
  }

  private tell(userId: string): void {
    for (const listener of this.changed) listener(userId);
  }

  private settle(id: string, answer: ApprovalAnswer | Error): boolean {
    const held = this.held.get(id);
    if (held === undefined) return false;
    this.held.delete(id);
    held.settle(answer);
    this.tell(held.userId);
    return true;
  }

  /**
   * Holds a call for the user's word and resolves with it. `stream` is where the run that waits is
   * followed. Rejects, with the signal's own reason, when the asking side gives the wait up, and
   * when the call's run is over (`dropRun`).
   */
  ask(userId: string, stream: StreamId, ask: ApprovalAsk, signal: AbortSignal): Promise<ApprovalAnswer> {
    const { promise, resolve, reject } = Promise.withResolvers<ApprovalAnswer>();
    if (signal.aborted) {
      reject(signal.reason instanceof Error ? signal.reason : new Error("The call no longer waits for an answer."));
      return promise;
    }
    const id = this.env.id();
    const gaveUp = (): void => void this.settle(id, signal.reason instanceof Error ? signal.reason : new Error("The call no longer waits for an answer."));
    signal.addEventListener("abort", gaveUp, { once: true });
    this.held.set(id, {
      userId,
      view: { ...ask, id, stream },
      settle: (answer) => {
        signal.removeEventListener("abort", gaveUp);
        if (answer instanceof Error) reject(answer);
        else resolve(answer);
      },
    });
    this.tell(userId);
    return promise;
  }

  /**
   * `lah.approval.answer`: the user's word on a held call, passed on exactly as it was given. What
   * it means is the core's to read, and the core fails closed (its `approvalAnswerOf`): only a word
   * that is exactly an approval runs the call. So nothing here reads it, rewrites it or fills it
   * in, lest a word that is no approval be made one on the way. False when the call no longer
   * waits (answered on another page, given up, or its run is over).
   */
  answer(userId: string, id: string, answer: ApprovalAnswer): boolean {
    if (this.held.get(id)?.userId !== userId) return false;
    return this.settle(id, answer);
  }

  /** The calls a user is asked about, in every chat of theirs, the one asked first first. */
  views(userId: string): ApprovalView[] {
    const out: ApprovalView[] = [];
    for (const held of this.held.values()) if (held.userId === userId) out.push(held.view);
    return out;
  }

  /** The jobs of a user that have a call waiting on them, by the job's id. */
  waitingRuns(userId: string): Set<string> {
    const out = new Set<string>();
    for (const held of this.held.values()) if (held.userId === userId) out.add(held.view.turn);
    return out;
  }

  /** A run is over (ended, stopped or lost): none of its calls waits any longer. */
  dropRun(userId: string, run: string, why: string): void {
    for (const [id, held] of [...this.held]) if (held.userId === userId && held.view.turn === run) this.settle(id, new Error(why));
  }
}

/**
 * Holds a call for the user's word as a run asks it (the core's `approvals` port), wherever the run
 * runs: under the stream the run is followed by, and with a notice while it waits when the run is
 * a job's, which nobody may be watching.
 */
export function holdCall(d: { approvals: Approvals; jobs: Pick<JobsBoard, "active" | "waits">; live: Pick<LiveBuffer, "streamOf"> }, userId: string, ask: ApprovalAsk, signal: AbortSignal): Promise<ApprovalAnswer> {
  const job = d.jobs.active(userId, ask.turn);
  if (job !== null) void d.jobs.waits(userId, job.id, ask.tool).catch(() => undefined);
  // The run is followed under its stream; a run the buffer doesn't hold (the extension started again under it) is followed under its own id.
  return d.approvals.ask(userId, d.live.streamOf(userId, ask.turn) ?? ask.turn, ask, signal).finally(() => {
    if (job !== null && !d.approvals.waitingRuns(userId).has(job.id)) void d.jobs.waits(userId, job.id, null).catch(() => undefined);
  });
}
