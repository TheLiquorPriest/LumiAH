// The page's end of the messages with the extension backend (`shared/ui.ts`): requests answered by
// id, the state every page holds kept current by the backend's pushes, and the live pushes handed to
// whichever view opened them. The page never asks Lumiverse or the network anything else.

import { type FrontendToBackend, followState, type UiErrorCode, type UiProblem, type UiRequests, type UiRequestType, type UiState, UI_VERSION, uiMessageOf } from "../../shared/ui";
import type { LiveHeard } from "./live-follow";
import { createStore, type Store } from "./store";

/** Spindle's messaging as the client uses it: `ctx.sendToBackend` and `ctx.onBackendMessage`. */
export interface Channel {
  send(payload: FrontendToBackend): void;
  subscribe(handler: (payload: unknown) => void): () => void;
}

/** A request that failed: the backend's code and words, or `timeout` (no answer in time) or `closed` (the page went away first). */
export class UiRequestError extends Error {
  constructor(
    readonly code: UiErrorCode | "timeout" | "closed",
    message: string,
    readonly problems: readonly UiProblem[] = [],
  ) {
    super(message);
    this.name = "UiRequestError";
  }
}

/** How the page stands with the backend: waiting for its first state, holding it, or unable to get it. */
export type Connection = "connecting" | "ready" | "failed";

export interface ClientOptions {
  /** How long a request waits for its answer, in ms (this device's setting, read at each request). */
  timeoutMs(): number;
  /** What the page tells the backend each time it says hello: what only a page can know of Lumiverse (the connection profile active now). Read at each hello, since it changes while the page is open. */
  hello?(): UiRequests["lah.hello"]["body"];
}

interface Pending {
  resolve(body: unknown): void;
  reject(error: UiRequestError): void;
  /** Stops its timeout. */
  settle(): void;
}

let counter = 0;

/** A request id unique among this user's pages: an answer that reaches another page by mistake matches nothing there. */
function newReqId(): string {
  counter += 1;
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}-${counter}`;
}

export class UiClient {
  readonly state: Store<UiState | null> = createStore<UiState | null>(null);
  readonly connection: Store<Connection> = createStore<Connection>("connecting");
  private readonly pending = new Map<string, Pending>();
  private readonly live = new Set<(stream: string, heard: LiveHeard) => void>();
  private readonly back = new Set<() => void>();
  private readonly off: () => void;
  private hello: Promise<void> | null = null;
  private closed = false;

  constructor(
    private readonly channel: Channel,
    private readonly options: ClientOptions,
  ) {
    this.off = channel.subscribe((raw) => this.receive(raw));
  }

  /** Sends a request; resolves with its result, or rejects with a `UiRequestError`. */
  request<K extends UiRequestType>(type: K, body: UiRequests[K]["body"]): Promise<UiRequests[K]["result"]> {
    if (this.closed) return Promise.reject(new UiRequestError("closed", "The page has closed."));
    const reqId = newReqId();
    // The executor form, not Promise.withResolvers: this runs in every browser Lumiverse runs in, and its own floor (Safari 16) is below the one that has withResolvers (17.4).
    return new Promise<UiRequests[K]["result"]>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(reqId);
        reject(new UiRequestError("timeout", "LumiAH's extension didn't answer in time. If this keeps happening, reload the page."));
      }, this.options.timeoutMs());
      this.pending.set(reqId, { resolve: (b) => resolve(b as UiRequests[K]["result"]), reject, settle: () => clearTimeout(timer) });
      try {
        this.channel.send({ lah: UI_VERSION, type, reqId, ...body } as FrontendToBackend);
      } catch (error) {
        this.pending.delete(reqId);
        clearTimeout(timer);
        reject(new UiRequestError("closed", error instanceof Error ? error.message : String(error)));
      }
    });
  }

  /** Asks for the whole state again (`lah.hello`); one at a time, the later callers sharing the one under way. */
  sync(): Promise<void> {
    if (this.hello) return this.hello;
    const run = this.request("lah.hello", this.options.hello?.() ?? {}).then(
      (state) => {
        this.state.set(state);
        this.connection.set("ready");
      },
      () => {
        // A page that held the state keeps showing it; only a page that never had one says it failed.
        if (this.state.get() === null) this.connection.set("failed");
      },
    );
    this.hello = run.finally(() => {
      this.hello = null;
    });
    return this.hello;
  }

  /**
   * The page was away (its socket reconnected, the extension started again, the tab came back into
   * view): pushes may have been missed with nothing to follow them, so it reads the state again and
   * tells each open view to read itself again.
   */
  resync(): void {
    if (this.closed) return;
    void this.sync();
    for (const listener of [...this.back]) listener();
  }

  /** Hears when the page comes back from being away; returns the stop. */
  onBack(listener: () => void): () => void {
    this.back.add(listener);
    return () => this.back.delete(listener);
  }

  /** Hears every live push (a turn's changes, and what its calls in flight send), for the views that opened a stream; returns the stop. */
  onLive(listener: (stream: string, heard: LiveHeard) => void): () => void {
    this.live.add(listener);
    return () => this.live.delete(listener);
  }

  /** Takes in the parts of the state a request's result carries, so the page shows them before the push that follows. */
  patch(parts: Partial<Omit<UiState, "rev">>): void {
    const held = this.state.get();
    if (held !== null) this.state.set({ ...held, ...parts });
  }

  dispose(): void {
    this.closed = true;
    this.off();
    for (const [id, p] of this.pending) {
      p.settle();
      p.reject(new UiRequestError("closed", "The page has closed."));
      this.pending.delete(id);
    }
    this.live.clear();
    this.back.clear();
  }

  private receive(raw: unknown): void {
    const message = uiMessageOf(raw);
    if (message === null) return;
    switch (message.type) {
      case "lah.result":
      case "lah.error": {
        const p = this.pending.get(message.reqId);
        if (!p) return;
        this.pending.delete(message.reqId);
        p.settle();
        if (message.type === "lah.result") p.resolve(message.body);
        else p.reject(new UiRequestError(message.code, message.message, message.problems ?? []));
        return;
      }
      case "lah.state": {
        const held = this.state.get();
        if (held === null) return;
        const next = followState(held, message);
        if (next !== null) this.state.set(next);
        else void this.sync();
        return;
      }
      case "lah.live":
        for (const listener of [...this.live]) listener(message.stream, message.change);
        return;
      case "lah.live.delta":
        for (const listener of [...this.live]) listener(message.stream, { delta: message.delta });
        return;
    }
  }
}
