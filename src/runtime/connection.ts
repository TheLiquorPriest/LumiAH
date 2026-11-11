// The runtime's way into the extension from outside Lumiverse, with no change to Lumiverse. The saved
// session token is a bearer: find the extension (`GET /api/v1/spindle`), take a single-use ticket,
// open the event socket as a widget session (so it never takes the frontend-execution slot from the
// user's browser) with a frontend session of its own (so the extension's answers and pushes come to
// this socket alone), wait for CONNECTED, then send the link's requests as SPINDLE_BACKEND_MSG frames
// and match each answer to its request by id. Lumiverse never acknowledges a frame, so every request
// has a timeout. A frame too large for the socket crosses in parts (src/link/parts.ts), either way.
// HTTP and the socket are passed in: the tests run all of this against a fake Lumiverse.

import type { LinkErrorCode, LinkNotice, LinkRequests, LinkRequestType } from "../link/contract";
import { EXTENSION_IDENTIFIER, LINK } from "../link/contract";
import { answerOf, isLinkFrame } from "../link/frames";
import { isRecord } from "../link/json";
import { PartJoiner, needsParts, partOf, splitFrame } from "../link/parts";
import type { Http, StoredLogin } from "./lumiverse";
import { exchange, inClear, LiveError, loginAgain, refused } from "./lumiverse";

export interface SocketEvents {
  message(text: string): void;
  close(code: number, reason: string): void;
}

export interface Socket {
  send(text: string): void;
  close(): void;
}

/** Opens the event socket; main.ts supplies Bun's WebSocket. Events arrive later, never during the call itself. */
export type OpenSocket = (url: string, events: SocketEvents) => Socket;

/** The extension refused a request (a `link` error frame): its code and its words. */
export class LinkError extends Error {
  constructor(
    readonly code: LinkErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "LinkError";
  }
}

export interface ExtensionInfo {
  /** Its database id, which frames are addressed by. */
  id: string;
  version: string | null;
  enabled: boolean;
  status: string;
}

/** The connection's own limits, read each time one is needed: the user's settings can change them while it runs. */
export interface ConnectionLimits {
  /** Each request's wait for its answer; null: no limit. */
  requestMs: number | null;
  /** How often the socket is pinged while open: Lumiverse closes one idle for longer than its own sweep allows. */
  socketPingMs: number;
  /** The largest frame, in characters, it puts together from parts. */
  joinMaxUnits: number;
  /** How long a frame's first parts wait for the rest. */
  partStaleMs: number;
}

export interface ConnectionOptions {
  base: string;
  /** The identifier of the extension to find in Lumiverse: LumiAH's own, or that of an extension LumiAH is built into. */
  identifier: string;
  /** The sign-in to use, read again every time the socket opens: after `lumiah login`, a running runtime uses the new token. */
  credentials(): StoredLogin | null;
  http: Http;
  openSocket: OpenSocket;
  limits(): ConnectionLimits;
  now(): number;
  /** A new socket is open: the link's hello is due on it. */
  onOpen?(): void;
  /** A frame of the link's that answers no request of ours: a push. */
  onPush?(frame: Record<string, unknown>): void;
  /**
   * Lumiverse started, stopped or reported an error in the extension (`SPINDLE_EXTENSION_LOADED`,
   * `_UNLOADED`, `_ERROR`, which it sends every socket; `detail` is the error's words): the runtime
   * ends its streams at once rather than wait for silence.
   */
  onExtension?(change: "loaded" | "unloaded" | "error", detail: string | null): void;
}

interface Pending {
  type: string;
  resolve(body: unknown): void;
  reject(error: Error): void;
  timer: ReturnType<typeof setTimeout> | undefined;
}

/** A frontend session id as Lumiverse takes one: 32 lowercase hex digits, fresh for every socket. */
function frontendSession(): string {
  return [...crypto.getRandomValues(new Uint8Array(16))].map((b) => b.toString(16).padStart(2, "0")).join("");
}

const formatMs = (ms: number): string => (ms % 1000 === 0 ? `${ms / 1000} s` : `${ms} ms`);

/** A timer that keeps nothing alive: a command that is done exits though its connection's ping was never cleared. */
function quiet<T>(timer: T): T {
  const t = timer as { unref?: () => void };
  t.unref?.();
  return timer;
}

export class HostConnection {
  private socket: Socket | null = null;
  private extension: ExtensionInfo | null = null;
  private ready = false;
  private opening: Promise<void> | null = null;
  /** The extension as the last lookup found it, for words that stop short after it. */
  private lastExtension: ExtensionInfo | null = null;
  private readonly pending = new Map<string, Pending>();
  private seq = 0;
  private prefix = "";
  private ping: ReturnType<typeof setInterval> | null = null;
  /** The token the open socket was made with. Lumiverse trusts a socket for its life, so a new sign-in drops it here. */
  private openedToken: string | null = null;
  /** Settles the open in progress when CONNECTED (or AUTH_ERROR) arrives. */
  private greeting: { resolve(): void; reject(error: Error): void } | null = null;
  private readonly joiner: PartJoiner;

  constructor(private readonly options: ConnectionOptions) {
    this.joiner = new PartJoiner(() => {
      const { joinMaxUnits, partStaleMs } = options.limits();
      return { maxUnits: joinMaxUnits, staleMs: partStaleMs };
    });
  }

  /** The Lumiverse this connection is to. */
  get base(): string {
    return this.options.base;
  }

  /** Whether the socket is open and Lumiverse said CONNECTED on it. */
  isOpen(): boolean {
    return this.ready && this.socket !== null;
  }

  /** Opens the socket unless it is open already. */
  async ensureOpen(): Promise<void> {
    const saved = this.options.credentials();
    if (this.isOpen()) {
      // After `lumiah login` the runtime reconnects as that sign-in.
      if (saved !== null && saved.token === this.openedToken) return;
      this.close();
    }
    this.opening ??= this.open().finally(() => {
      this.opening = null;
    });
    return this.opening;
  }

  /** One request, sent on the open socket; the extension's `error` rejects with a LinkError. */
  request<T extends LinkRequestType>(type: T, fields: LinkRequests[T]["fields"]): Promise<LinkRequests[T]["result"]> {
    const socket = this.socket;
    const extension = this.extension;
    if (socket === null || extension === null || !this.ready) return Promise.reject(new LiveError("closed", "The connection to Lumiverse closed. Try again."));
    const id = `${this.prefix}${++this.seq}`;
    // `type` first: Lumiverse reads it from a large frame's first bytes to allow it 4 MiB instead of 1.
    const wrap = (payload: unknown): string => JSON.stringify({ type: "SPINDLE_BACKEND_MSG", extensionId: extension.id, payload });
    const payload = { ...fields, link: LINK, type, id };
    const whole = wrap(payload);
    const frames = needsParts(whole) ? splitFrame(JSON.stringify(payload), id).map(wrap) : [whole];
    const { promise, resolve, reject } = Promise.withResolvers<unknown>();
    const limit = this.options.limits().requestMs;
    const timer =
      limit === null
        ? undefined
        : setTimeout(() => {
            this.pending.delete(id);
            reject(new LiveError("timeout", `LumiAH didn't answer ${type} within ${formatMs(limit)}.`));
          }, limit);
    this.pending.set(id, { type, resolve, reject, timer });
    for (const frame of frames) socket.send(frame);
    return promise as Promise<LinkRequests[T]["result"]>;
  }

  /** A notice, sent on the open socket and never answered; dropped when there is none, since nothing waits for it. */
  notify(notice: LinkNotice): void {
    const socket = this.socket;
    const extension = this.extension;
    if (socket === null || extension === null || !this.ready) return;
    const whole = JSON.stringify({ type: "SPINDLE_BACKEND_MSG", extensionId: extension.id, payload: notice });
    // A notice is small by its nature (what one moment of a model's answer adds): one too large to cross whole is let go rather than cut.
    if (!needsParts(whole)) socket.send(whole);
  }

  close(): void {
    const socket = this.socket;
    this.socket = null;
    socket?.close();
    this.closed(1000, "closed by the runtime");
  }

  /** The sign-in to use now. Plain http to another machine needs the consent `up --allow-http` saved with it. */
  private signedIn(): StoredLogin {
    const { base } = this.options;
    const saved = this.options.credentials();
    if (saved === null) throw new LiveError("login", `The runtime isn't signed in to ${base}. Run: lumiah login`);
    if (inClear(base) && saved.allowHttp !== true) throw new LiveError("insecure", `${base} is plain http to another machine, and this sign-in wasn't made with --allow-http, so its session token won't be sent there in clear. Use https, or set the runtime up again with --allow-http.`);
    return saved;
  }

  private async findExtension(token: string): Promise<ExtensionInfo> {
    const { base, http } = this.options;
    this.lastExtension = null;
    const reply = await exchange(http, base, "GET", "/api/v1/spindle", token);
    if (reply.status === 401) throw new LiveError("login", loginAgain(base));
    if (reply.status !== 200) throw refused(base, reply, "was asked for its extensions");
    let body: unknown = null;
    try {
      body = JSON.parse(reply.text);
    } catch {
      // Not JSON: no extension found below.
    }
    const { identifier } = this.options;
    // With LumiAH and an extension that includes it installed together, the words say which of the two this runtime links to.
    const named = identifier === EXTENSION_IDENTIFIER ? "LumiAH" : `The extension "${identifier}", which LumiAH is part of,`;
    const found = isRecord(body) && Array.isArray(body.extensions) ? body.extensions.find((e): e is Record<string, unknown> => isRecord(e) && e.identifier === identifier) : undefined;
    if (!found || typeof found.id !== "string") throw new LiveError("not_installed", `${named} isn't installed on ${base}, or your account can't use it. Install it in Lumiverse's Extensions tab.`);
    const extension: ExtensionInfo = { id: found.id, version: typeof found.version === "string" ? found.version : null, enabled: found.enabled === true, status: typeof found.status === "string" ? found.status : "unknown" };
    this.lastExtension = extension;
    if (extension.status !== "running") throw new LiveError("not_running", `${named} is installed on ${base} but not running (${extension.enabled ? extension.status : "disabled"}). Enable it in Lumiverse's Extensions tab.`);
    return extension;
  }

  private async ticket(token: string): Promise<string> {
    const { base, http } = this.options;
    const reply = await exchange(http, base, "POST", "/api/v1/ws-ticket", token, "{}");
    if (reply.status !== 200) throw refused(base, reply, "was asked for a socket ticket");
    let body: unknown = null;
    try {
      body = JSON.parse(reply.text);
    } catch {
      // Not JSON: no ticket below.
    }
    if (!isRecord(body) || typeof body.ticket !== "string") throw new LiveError("protocol", `Lumiverse at ${base} gave no socket ticket.`);
    return body.ticket;
  }

  private async open(): Promise<void> {
    // Read now, not when the connection was made: a reconnect after `lumiah login` uses the new token.
    const { token } = this.signedIn();
    this.openedToken = token;
    this.extension = await this.findExtension(token);
    // A ticket lives a few seconds and works once; one refused on the way gets one more try with a new ticket.
    for (let attempt = 1; ; attempt++) {
      try {
        await this.connect(await this.ticket(token));
        break;
      } catch (error) {
        if (!(error instanceof LiveError && error.problem === "protocol" && attempt === 1)) throw error;
      }
    }
    this.ready = true;
    this.options.onOpen?.();
  }

  private connect(ticket: string): Promise<void> {
    const session = frontendSession();
    this.prefix = `${session.slice(0, 8)}-`;
    const url = new URL(this.options.base);
    url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
    url.pathname = `${url.pathname.replace(/\/+$/, "")}/api/ws`;
    url.search = new URLSearchParams({ ticket, frontend_session: session, frontend_runtime: "widget" }).toString();
    const { promise, resolve, reject } = Promise.withResolvers<void>();
    const settle = (error: Error | null): void => {
      clearTimeout(timer);
      this.greeting = null;
      if (error === null) return resolve();
      // A socket that never got ready is dropped here; the next open starts a new one.
      if (this.socket === socket) this.socket = null;
      socket.close();
      reject(error);
    };
    const limit = this.options.limits().requestMs;
    const timer = limit === null ? undefined : setTimeout(() => settle(new LiveError("timeout", `Lumiverse at ${this.options.base} opened no event socket within ${formatMs(limit)}. Behind a proxy, the proxy must pass WebSocket upgrades on /api/ws.`)), limit);
    this.greeting = { resolve: () => settle(null), reject: settle };
    const socket: Socket = this.options.openSocket(url.toString(), {
      message: (text) => this.received(socket, text),
      close: (code, reason) => {
        // A socket this connection already left (closed, or given up before it was ready).
        if (this.socket !== socket) return;
        this.socket = null;
        const why = code === 1006 ? "it never opened (1006): behind a proxy, the proxy must pass WebSocket upgrades on /api/ws" : `Lumiverse closed it (${code}${reason ? ` ${reason}` : ""})`;
        this.greeting?.reject(new LiveError(code === 1008 ? "protocol" : "closed", `The event socket at ${this.options.base}/api/ws failed: ${why}.`));
        this.closed(code, reason);
      },
    });
    this.socket = socket;
    return promise;
  }

  private received(socket: Socket, text: string): void {
    if (socket !== this.socket) return;
    let msg: unknown;
    try {
      msg = JSON.parse(text);
    } catch {
      return;
    }
    if (!isRecord(msg)) return;
    if (msg.event === "CONNECTED") {
      this.ping ??= quiet(setInterval(() => this.socket?.send(JSON.stringify({ type: "ping" })), this.options.limits().socketPingMs));
      this.greeting?.resolve();
      return;
    }
    if (msg.event === "AUTH_ERROR") {
      this.greeting?.reject(new LiveError("protocol", "Lumiverse refused the event socket's ticket."));
      return;
    }
    const lifecycle = msg.event === "SPINDLE_EXTENSION_LOADED" ? "loaded" : msg.event === "SPINDLE_EXTENSION_UNLOADED" ? "unloaded" : msg.event === "SPINDLE_EXTENSION_ERROR" ? "error" : null;
    if (lifecycle !== null) {
      // Every extension's lifecycle reaches every socket: only LumiAH's counts.
      const id = this.extension?.id ?? this.lastExtension?.id;
      if (isRecord(msg.payload) && id !== undefined && msg.payload.extensionId === id) this.options.onExtension?.(lifecycle, typeof msg.payload.error === "string" ? msg.payload.error : null);
      return;
    }
    if (msg.event !== "SPINDLE_FRONTEND_MSG" || !isRecord(msg.payload) || msg.payload.extensionId !== this.extension?.id) return;
    this.frame(msg.payload.data);
  }

  /** One frame of the extension's: a part of a larger one, an answer to a request of ours, or a push. */
  private frame(data: unknown): void {
    // The extension's messages to its pages travel the same channel: only the link's are the runtime's.
    if (!isLinkFrame(data)) return;
    const part = partOf(data);
    if (part !== null) {
      const joined = this.joiner.take(part, this.options.now());
      if ("text" in joined) {
        let whole: unknown = null;
        try {
          whole = JSON.parse(joined.text);
        } catch {
          // Not a frame after all: dropped, and whatever waited for it times out.
        }
        // A whole frame is never itself a part.
        if (partOf(whole) === null) this.frame(whole);
      } else if ("refused" in joined) {
        // Its answer never comes whole: the request it answered fails now rather than time out.
        const waiting = this.pending.get(joined.id);
        if (waiting !== undefined) {
          this.pending.delete(joined.id);
          clearTimeout(waiting.timer);
          waiting.reject(new LiveError("too_large", `LumiAH's answer to ${waiting.type} was too large for the runtime: ${joined.refused} Raise the runtime's "Largest frame joined" in LumiAH's settings.`));
        }
      }
      return;
    }
    const answer = answerOf(data);
    const waiting = answer !== null ? this.pending.get(answer.id) : undefined;
    if (answer === null || waiting === undefined) {
      this.options.onPush?.(data);
      return;
    }
    this.pending.delete(answer.id);
    clearTimeout(waiting.timer);
    if (answer.type === "result") waiting.resolve(answer.body);
    else waiting.reject(new LinkError(answer.code, answer.message));
  }

  /** The socket is gone: whatever waited on it fails, and the next request opens a new one. */
  private closed(code: number, reason: string): void {
    clearInterval(this.ping ?? undefined);
    this.ping = null;
    this.ready = false;
    this.joiner.clear();
    const waiting = [...this.pending.values()];
    this.pending.clear();
    for (const w of waiting) {
      clearTimeout(w.timer);
      w.reject(new LiveError("closed", `The connection to Lumiverse closed (${code}${reason ? ` ${reason}` : ""}) before LumiAH answered ${w.type}.`));
    }
  }
}
