// Following a chat's live view (shared/ui.ts): open it, read the rest of a long turn a page at a
// time, take each push in order, and mend any gap by reading what was missed. One read at a time:
// pushes heard while a read is under way wait for it, then join in order, so nothing is applied
// twice or out of order. That holds for the deltas of a call in flight too: one the view just read
// already holds is passed over, and one after a delta that never came makes the view be read again.
// Pure of the page, so it is tested by driving its reads by hand.

import { followDelta, followLive, type LiveChange, type LiveDelta, type LiveEvent, type LiveView } from "../../shared/ui";

/** What a page hears of a chat's live view: a change to the turn's events, or what a call in flight sent since. */
export type LiveHeard = LiveChange | { delta: LiveDelta };

/** The reads the follower makes: the chat's live view now (with the seq to read on from), and a turn's events from a seq. */
export interface LiveReads {
  open(): Promise<{ live: LiveView | null; next: number | null }>;
  events(turn: string, from: number): Promise<{ events: LiveEvent[]; next: number | null }>;
}

/**
 * Where the follower stands: opening; following (the view, null when the chat has had no turn since
 * the extension started; `partial` while events it knows of couldn't be read); or unable to open.
 */
export type LiveState = { status: "opening" } | { status: "ready"; view: LiveView | null; partial: boolean } | { status: "failed"; message: string };

export class LiveFollower {
  private state: LiveState = { status: "opening" };
  private queue: LiveHeard[] = [];
  /** How often each queued push has had a gap mended for it: first its missing events are read, then the view is opened again, then it is dropped. */
  private readonly tries = new WeakMap<LiveHeard, number>();
  private reading = false;
  /** A refresh was asked for while a read was under way: the view is opened again once that read ends. */
  private again = false;
  private stopped = false;

  constructor(
    private readonly reads: LiveReads,
    private readonly onState: (state: LiveState) => void,
  ) {}

  get current(): LiveState {
    return this.state;
  }

  /** Opens the view and reads the rest of its turn. */
  start(): Promise<void> {
    return this.read(() => this.open());
  }

  /** Opens the view again, keeping what it holds of the same turn: after the page was away (pushes may have been missed), or to try again. */
  refresh(): Promise<void> {
    return this.read(() => this.open());
  }

  /** A push for this chat. */
  hear(heard: LiveHeard): void {
    if (this.stopped) return;
    this.queue.push(heard);
    void this.drain();
  }

  stop(): void {
    this.stopped = true;
    this.queue = [];
  }

  private set(state: LiveState): void {
    if (this.stopped) return;
    this.state = state;
    this.onState(state);
  }

  private async read(work: () => Promise<void>): Promise<void> {
    if (this.reading) {
      this.again = true;
      return;
    }
    this.reading = true;
    try {
      await work();
    } finally {
      this.reading = false;
    }
    if (this.again && !this.stopped) {
      this.again = false;
      await this.read(() => this.open());
      return;
    }
    await this.drain();
  }

  /** Applies the pushes heard so far, in order; a gap stops to read what is missing, then goes on. */
  private async drain(): Promise<void> {
    while (!this.reading && !this.stopped && this.state.status === "ready" && this.queue.length > 0) {
      const change = this.queue[0];
      if (change === undefined) return;
      const next = "delta" in change ? followDelta(this.state.view, change.delta) : followLive(this.state.view, change);
      if (!("gap" in next)) {
        this.queue.shift();
        if (next !== this.state.view) this.set({ status: "ready", view: next, partial: this.state.partial });
        continue;
      }
      const tries = this.tries.get(change) ?? 0;
      // A push still out of step after its gap was mended is for a turn the chat no longer shows, or names events the backend no longer has: the view as read stands.
      if (tries >= 2 || (next.gap === "view" && tries >= 1)) {
        this.queue.shift();
        continue;
      }
      this.tries.set(change, tries + 1);
      const turn = this.state.view?.turn;
      await this.read(() => (next.gap === "events" && tries === 0 && turn !== undefined ? this.fill(turn, next.from) : this.open()));
      return;
    }
  }

  private async open(): Promise<void> {
    try {
      const { live, next } = await this.reads.open();
      const held = this.state.status === "ready" ? this.state.view : null;
      // A view of the turn already held never takes away what later pushes brought.
      const kept = live === null ? null : followLive(held, { view: live });
      const view = kept !== null && "gap" in kept ? live : kept;
      this.set({ status: "ready", view, partial: false });
      if (view !== null && next !== null) await this.fill(view.turn, Math.max(next, (view.events.at(-1)?.seq ?? 0) + 1));
    } catch (error) {
      // A follower that held a view keeps showing it; only one that never opened says it failed.
      if (this.state.status === "ready") this.set({ ...this.state, partial: true });
      else this.set({ status: "failed", message: error instanceof Error ? error.message : String(error) });
    }
  }

  /** Reads turn `turn`'s events from `from` until there are no more, joining them to the view in order. */
  private async fill(turn: string, from: number): Promise<void> {
    let at: number | null = from;
    while (at !== null && !this.stopped) {
      let page: { events: LiveEvent[]; next: number | null };
      try {
        page = await this.reads.events(turn, at);
      } catch {
        if (this.state.status === "ready") this.set({ ...this.state, partial: true });
        return;
      }
      const held = this.state.status === "ready" ? this.state.view : null;
      if (held === null || held.turn !== turn) return;
      const followed = followLive(held, { turn, events: page.events, ended: held.ended });
      // A page that brings nothing yet names more to read would be read for ever.
      if ("gap" in followed || (page.events.length === 0 && page.next !== null)) {
        if (this.state.status === "ready") this.set({ ...this.state, partial: true });
        return;
      }
      this.set({ status: "ready", view: followed, partial: false });
      at = page.next;
    }
  }
}
