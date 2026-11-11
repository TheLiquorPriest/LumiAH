// A gate that lets a setting's number through at once and the rest wait their turn, first come
// first through: sub-agents at work in one run (DESIGN §14), jobs running at once (§15). A waiter
// may ask to go `soon`: it goes before every waiter that didn't, and after those that did before
// it (a job's lane, §15).

export class Gate {
  private busy = 0;
  private readonly waiting: { go(): void; stop(): void; soon: boolean }[] = [];

  /** `limit` is read whenever a place comes free, so a changed setting holds from then on. */
  constructor(private readonly limit: () => number) {}

  /** How many wait their turn. */
  get queued(): number {
    return this.waiting.length;
  }

  /**
   * Waits for a place and takes it: resolves with what gives it back (call it once, whatever came
   * of the work). Rejects with the signal's reason when that ends the wait first.
   */
  enter(signal: AbortSignal, soon = false): Promise<() => void> {
    if (signal.aborted) return Promise.reject(signal.reason);
    if (this.busy < this.limit() && this.waiting.length === 0) return Promise.resolve(this.take());
    const { promise, resolve, reject } = Promise.withResolvers<() => void>();
    const entry = {
      soon,
      go: (): void => {
        signal.removeEventListener("abort", entry.stop);
        resolve(this.take());
      },
      stop: (): void => {
        const at = this.waiting.indexOf(entry);
        if (at >= 0) this.waiting.splice(at, 1);
        reject(signal.reason);
      },
    };
    // A soon waiter goes in after the last soon one already waiting, ahead of every later one.
    const at = soon ? this.waiting.findIndex((w) => !w.soon) : -1;
    if (at >= 0) this.waiting.splice(at, 0, entry);
    else this.waiting.push(entry);
    signal.addEventListener("abort", entry.stop, { once: true });
    return promise;
  }

  private take(): () => void {
    this.busy += 1;
    let given = false;
    return () => {
      if (given) return;
      given = true;
      this.busy -= 1;
      while (this.busy < this.limit()) {
        const next = this.waiting.shift();
        if (!next) break;
        next.go();
      }
    };
  }
}
