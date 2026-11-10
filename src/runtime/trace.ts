// Where the core's trace goes (DESIGN §2 step 6, §6 "push trace events"): every event of every agent,
// to the extension's live buffer, in the order the core traced them. Events wait a moment to be sent
// together, one request at a time, so they arrive in order; a batch whose socket closed under it is
// sent again (the buffer counts an event it holds already once). A turn whose events can't be sent
// at all stops being traced to the live view, and says so in the log; its stored transcript, which
// the core writes itself, is whole all the same.
//
// A model's answer as it arrives (the trace port's deltas) goes too, as notices nobody answers: what
// arrived in the same moment for the same call goes as one, in the order it arrived, always before
// the events traced after it, so the entry that ends a call never overtakes the call's last words.
// One that can't be sent is let go: the live view shows the whole answer with the call's entry.

import type { TraceDelta, TraceRecord } from "../core/ports";
import type { RuntimeTuning } from "../link/settings";
import type { RuntimeLink } from "./link";
import { LiveError } from "./lumiverse";
import { problemOf } from "./streams";

export interface TraceEnv {
  now(): number;
  log(text: string): void;
  tuning(): RuntimeTuning;
}

export class TraceSink {
  private queue: TraceRecord[] = [];
  private timer: ReturnType<typeof setTimeout> | null = null;
  private sending: Promise<void> | null = null;
  /** Turns whose events can't reach the live view any more: the rest of theirs are dropped here. */
  private readonly broken = new Set<string>();
  /** What arrived of calls under way and hasn't been sent yet, in order. */
  private deltas: TraceDelta[] = [];
  private deltaTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(
    private readonly link: RuntimeLink,
    private readonly env: TraceEnv,
  ) {}

  /** One event, in the order the core traced it. */
  event(record: TraceRecord): void {
    if (this.broken.has(record.turn)) return;
    if (this.queue.length >= this.env.tuning().traceHeld) {
      this.give(record.turn, `more than ${this.env.tuning().traceHeld} of its events are waiting to be sent`);
      return;
    }
    this.queue.push(record);
    if (this.sending !== null || this.timer !== null) return;
    this.timer = setTimeout(() => {
      this.timer = null;
      this.flush();
    }, this.env.tuning().traceMs);
  }

  /** What one call's answer gained since its last delta. It waits a moment to go with what follows it for the same call. */
  delta(delta: TraceDelta): void {
    if (this.broken.has(delta.turn)) return;
    const last = this.deltas.at(-1);
    if (last !== undefined && last.turn === delta.turn && last.agentId === delta.agentId && last.call === delta.call) {
      if (delta.text !== undefined) last.text = (last.text ?? "") + delta.text;
      if (delta.reasoning !== undefined) last.reasoning = (last.reasoning ?? "") + delta.reasoning;
    } else {
      // Past what may wait, the oldest goes: a delta lost shows as a hole the live view mends by reading the turn again.
      if (this.deltas.length >= this.env.tuning().traceHeld) this.deltas.shift();
      this.deltas.push({ ...delta });
    }
    if (this.deltaTimer !== null) return;
    this.deltaTimer = setTimeout(() => {
      this.deltaTimer = null;
      this.sendDeltas();
    }, this.env.tuning().traceMs);
  }

  private sendDeltas(): void {
    if (this.deltaTimer !== null) {
      clearTimeout(this.deltaTimer);
      this.deltaTimer = null;
    }
    if (this.deltas.length === 0) return;
    const deltas = this.deltas;
    this.deltas = [];
    this.link.notify({ type: "trace.deltas", deltas });
  }

  /** Resolves once every event traced so far has been sent or given up. */
  async drained(): Promise<void> {
    if (this.timer !== null) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    this.flush();
    while (this.sending !== null) await this.sending;
  }

  /** A turn is over: nothing of it is remembered. */
  forget(turn: string): void {
    this.broken.delete(turn);
    this.deltas = this.deltas.filter((d) => d.turn !== turn);
  }

  private flush(): void {
    if (this.sending !== null || this.queue.length === 0) return;
    this.sending = this.send().finally(() => {
      this.sending = null;
      if (this.queue.length > 0) this.flush();
    });
  }

  private async send(): Promise<void> {
    while (this.queue.length > 0) {
      const batch = this.queue.slice(0, this.env.tuning().traceBatch);
      // What the calls had gained before these events were traced goes first, on the same socket.
      this.sendDeltas();
      const first = this.env.now();
      for (;;) {
        const wait = this.env.tuning().lostMs;
        try {
          await this.link.request("trace.push", { records: batch }, wait);
          break;
        } catch (error) {
          // The batch may or may not have arrived: sent again, the buffer takes each event once.
          if (error instanceof LiveError && error.problem === "closed" && this.env.now() - first < wait) continue;
          for (const turn of new Set(batch.map((r) => r.turn))) this.give(turn, problemOf(error).message);
          break;
        }
      }
      // Whatever was sent, or given up with its turn: the batch's own events leave the queue.
      const sent = new Set(batch);
      this.queue = this.queue.filter((r) => !sent.has(r));
    }
  }

  /** Gives a turn's trace up: what waits of it is dropped, and nothing more of it is taken. */
  private give(turn: string, why: string): void {
    if (this.broken.has(turn)) return;
    this.broken.add(turn);
    this.queue = this.queue.filter((r) => r.turn !== turn);
    this.deltas = this.deltas.filter((d) => d.turn !== turn);
    this.env.log(`turn ${turn.slice(0, 8)}'s later steps won't show in the live view (${why}); its stored transcript is unaffected`);
  }
}
