// The rest of a made-up Lumiverse, for tests that run a runtime against the extension backend: the
// HTTP routes the runtime calls, the event socket its link travels (to the fake host's backend and
// back), pages that send the backend requests, and a generation as Lumiverse runs one: its start
// event, the prompt through the interceptor, the request to the loopback connection, the reply read
// as it streams, the message saved and the end event. Where the host has other extensions beside it
// (fake-host.ts), all of them are listed, the socket carries each one's frames by its id, and a
// generation goes through every one's interceptor and is told to every one.

import { isRecord, type ChatRole, type JsonObject } from "../../src/core/ports";
import type { HostGenerationType, PromptMessage } from "../../src/extension/backend/spindle";
import { LINK } from "../../src/link/contract";
import type { OpenSocket, Socket } from "../../src/runtime/connection";
import type { Http, HttpReply } from "../../src/runtime/lumiverse";
import { UI_VERSION, type BackendToFrontend, type UiErrorMessage, type UiRequestType, type UiRequests } from "../../src/shared/ui";
import type { FakeHost, FakeMessage } from "./fake-host";

const hex = (bytes: number): string => [...crypto.getRandomValues(new Uint8Array(bytes))].map((b) => b.toString(16).padStart(2, "0")).join("");

const reply = (status: number, body: unknown): HttpReply => ({ status, header: () => null, text: typeof body === "string" ? body : JSON.stringify(body) });

/** A page's request refused by the backend. */
export class UiFailure extends Error {
  constructor(readonly error: UiErrorMessage) {
    super(error.message);
  }
}

/** A page of the user's: it sends requests and keeps what it is pushed. */
export class FakePage {
  readonly session = hex(16);
  readonly pushes: BackendToFrontend[] = [];
  private readonly waiting = new Map<string, { resolve(body: unknown): void; reject(error: Error): void }>();
  private n = 0;

  constructor(
    private readonly host: FakeHost,
    readonly userId: string,
  ) {
    host.outlets.set(this.session, {
      userId,
      receive: (message) => {
        const m = message as BackendToFrontend & { link?: unknown };
        if (m.link !== undefined || m.lah !== UI_VERSION) return;
        if (m.type === "lah.result" || m.type === "lah.error") {
          const waiting = this.waiting.get(m.reqId);
          if (waiting === undefined) return;
          this.waiting.delete(m.reqId);
          if (m.type === "lah.result") waiting.resolve(m.body);
          else waiting.reject(new UiFailure(m));
          return;
        }
        this.pushes.push(m);
      },
    });
  }

  request<K extends UiRequestType>(type: K, body: UiRequests[K]["body"]): Promise<UiRequests[K]["result"]> {
    const reqId = `r${++this.n}`;
    const { promise, resolve, reject } = Promise.withResolvers<unknown>();
    this.waiting.set(reqId, { resolve, reject });
    this.host.deliver({ lah: UI_VERSION, type, reqId, ...body }, this.userId, this.session);
    return promise as Promise<UiRequests[K]["result"]>;
  }

  close(): void {
    this.host.closeSession(this.session);
  }
}

/** What a generation came to. */
export interface Generated {
  generationId: string;
  /** The message the reply was saved on; null when none was. */
  messageId: string | null;
  status: number;
  content: string;
  reasoning: string;
  /** The error the loopback answered with, in its own words; null when it answered a reply. */
  error: { message: string; code: string } | null;
  finish: string | null;
  usage: JsonObject | null;
  /** The request's body as Lumiverse sent it. */
  body: JsonObject;
  /** The messages an interceptor put in and named for the Prompt Breakdown: each by its place in the prompt as sent. */
  breakdown: { index: number; name: string }[];
}

export class FakeLumiverse {
  /** The first extension's id, which a socket's frames are addressed by; another's is `idOf` its host. */
  readonly extensionId = "ext-lumiah";
  readonly base = "http://127.0.0.1:7860";
  token = "session-token-mara";
  /** Frames on their way to a runtime pass here first: false drops one (a chunk lost on the way). */
  filter: (frame: Record<string, unknown>) => boolean = () => true;
  /** The runtime sockets open now, by session. */
  readonly sockets = new Map<string, { close(code: number, reason: string): void }>();
  /** The keys put in connections, by connection. */
  readonly keys = new Map<string, string>();
  /** The generations under way, by id: what Lumiverse's Stop ends each with. */
  private readonly generating = new Map<string, { chatId: string; stop: AbortController }>();
  /** Every call of the stop route, as it was asked. */
  readonly stops: { generationId: string; chatId: string }[] = [];
  /** A test's switch: the stop route answers an error, as a Lumiverse that can't be made to stop a reply. */
  stopFails = false;
  /**
   * What the model on a connection that is no loopback answers, as Lumiverse's own generation gets
   * it: the reply's text, for the prompt it was sent on the connection named. A test of a chat that
   * runs built in sets it; it may take its time, and rejects to fail the generation.
   */
  writes: (body: JsonObject, connectionId: string) => string | Promise<string> = () => "Joss trims the wick and says nothing.";
  /** Every prompt Lumiverse's own generation sent, in order. */
  readonly provided: { connectionId: string; body: JsonObject }[] = [];
  /** What Lumiverse logged of an interceptor that threw: it passes such a one over, unless it is required. */
  readonly interceptorErrors: { identifier: string; message: string }[] = [];
  private n = 0;

  constructor(
    readonly host: FakeHost,
    readonly userId: string,
  ) {}

  /** An extension's id in this Lumiverse (its database id there), by its host. */
  idOf(host: FakeHost): string {
    return host === this.host ? this.extensionId : `ext-${host.identifier}`;
  }

  /** The routes the runtime calls with its session. */
  readonly http: Http = async (request) => {
    const url = new URL(request.url);
    const path = url.pathname;
    if (request.headers.Authorization !== `Bearer ${this.token}` && path !== "/api/auth/sign-in/username") return reply(401, { error: "Unauthorized" });
    if (path === "/api/v1/spindle" && request.method === "GET") return reply(200, { extensions: this.host.extensions.map((host) => ({ id: this.idOf(host), identifier: host.identifier, version: "0.0.1", enabled: true, status: "running" })) });
    if (path === "/api/v1/ws-ticket" && request.method === "POST") return reply(200, { ticket: `ticket-${++this.n}` });
    if (path === "/api/auth/get-session") return reply(200, { session: { expiresAt: "2099-01-01T00:00:00.000Z" }, user: { id: this.userId } });
    if (path === "/api/v1/connections" && request.method === "GET") return reply(200, { data: this.host.connectionList.map((c) => ({ id: c.id, name: c.name, provider: c.provider, api_url: c.url, model: c.model })) });
    if (path === "/api/v1/connections" && request.method === "POST") {
      const body: unknown = JSON.parse(request.body ?? "{}");
      const text = (key: string): string => (isRecord(body) && typeof body[key] === "string" ? (body[key] as string) : "");
      const made = this.host.addConnection({ id: `conn-${++this.n}`, name: text("name"), provider: text("provider"), url: text("api_url"), model: text("model") });
      if (text("api_key") !== "") this.keys.set(made.id, text("api_key"));
      return reply(201, { id: made.id, name: made.name, provider: made.provider, api_url: made.url, model: made.model });
    }
    const key = /^\/api\/v1\/connections\/([^/]+)\/api-key$/.exec(path);
    if (key !== null && request.method === "PUT") {
      const body: unknown = JSON.parse(request.body ?? "{}");
      this.keys.set(decodeURIComponent(key[1] ?? ""), isRecord(body) && typeof body.api_key === "string" ? body.api_key : "");
      return reply(200, { ok: true });
    }
    if (path === "/api/v1/generate/stop" && request.method === "POST") {
      const body: unknown = JSON.parse(request.body ?? "{}");
      const text = (key: string): string => (isRecord(body) && typeof body[key] === "string" ? (body[key] as string) : "");
      this.stops.push({ generationId: text("generation_id"), chatId: text("chat_id") });
      if (this.stopFails) return reply(500, { error: "Internal Server Error" });
      // The generation named; else, as Lumiverse does for an id it no longer knows, whatever runs in the chat.
      const held = this.generating.get(text("generation_id")) ?? [...this.generating.values()].find((g) => g.chatId === text("chat_id"));
      held?.stop.abort();
      return reply(200, { stopped: held !== undefined });
    }
    return reply(404, { error: "Not found" });
  };

  /** The event socket: a runtime's frames go to the backend of the extension they name, with the socket's session, and every backend's to that session come back under its own extension's id. */
  readonly openSocket: OpenSocket = (url, events) => {
    const session = new URL(url).searchParams.get("frontend_session") ?? hex(16);
    const { extensions } = this.host;
    let open = true;
    for (const host of extensions) {
      host.outlets.set(session, {
        userId: this.userId,
        receive: (message) => {
          if (!open) return;
          const frame = message as Record<string, unknown>;
          if (frame.link === LINK && !this.filter(frame)) return;
          events.message(JSON.stringify({ event: "SPINDLE_FRONTEND_MSG", payload: { extensionId: this.idOf(host), data: message } }));
        },
      });
    }
    this.sockets.set(session, {
      close: (code, reason) => {
        if (!open) return;
        open = false;
        this.sockets.delete(session);
        for (const host of extensions) host.closeSession(session);
        events.close(code, reason);
      },
    });
    queueMicrotask(() => events.message(JSON.stringify({ event: "CONNECTED" })));
    const socket: Socket = {
      send: (text) => {
        if (!open) return;
        const message = JSON.parse(text) as { type?: string; extensionId?: string; payload?: unknown };
        if (message.type === "SPINDLE_BACKEND_MSG") extensions.find((host) => this.idOf(host) === message.extensionId)?.deliver(message.payload, this.userId, session);
      },
      close: () => {
        if (!open) return;
        open = false;
        this.sockets.delete(session);
        for (const host of extensions) host.closeSession(session);
      },
    };
    return socket;
  };

  /** Lumiverse drops every runtime socket (a restart, a network blip). */
  dropSockets(): void {
    for (const socket of [...this.sockets.values()]) socket.close(1006, "");
  }

  page(userId = this.userId): FakePage {
    return new FakePage(this.host, userId);
  }

  /** One link request sent bare from a new session, as a client that isn't the runtime's own code would: its result, or its error frame. */
  async raw(fields: Record<string, unknown>, userId = this.userId): Promise<{ type: "result"; body: unknown } | { type: "error"; code: string; message: string }> {
    const session = hex(16);
    const id = `raw-${++this.n}`;
    const { promise, resolve } = Promise.withResolvers<{ type: "result"; body: unknown } | { type: "error"; code: string; message: string }>();
    this.host.outlets.set(session, {
      userId,
      receive: (message) => {
        const frame = message as { link?: string; id?: string; type?: string; body?: unknown; code?: string; message?: string };
        if (frame.link !== LINK || frame.id !== id) return;
        if (frame.type === "result") resolve({ type: "result", body: frame.body });
        else if (frame.type === "error") resolve({ type: "error", code: frame.code ?? "", message: frame.message ?? "" });
      },
    });
    this.host.deliver({ link: LINK, id, ...fields }, userId, session);
    const answer = await promise;
    this.host.outlets.delete(session);
    return answer;
  }

  /**
   * One generation in a chat, as Lumiverse runs it on the connection the chat generates on: the start
   * event, the prompt through the interceptor, the request to the loopback (`fetch` is the runtime's
   * handler), the reply read as it streams, the message saved, the end event. `before` runs once the
   * request is on its way. Lumiverse's Stop is `signal`, or the stop route asked for the generation:
   * the request is closed, what was written is kept (a new reply with nothing written is deleted),
   * and the stopped event is said in the end event's place.
   */
  async generate(
    fetch: (request: Request) => Promise<Response>,
    chatId: string,
    options: {
      key: string;
      port: number;
      type?: HostGenerationType;
      presetId?: string | null;
      system?: string;
      /** World Info entries Lumiverse activated for the prompt, each put in as a message of its own. */
      lore?: { entryId: string; bookId: string | null; title: string; text: string; how?: "key" | "vector"; score?: number }[];
      signal?: AbortSignal;
      onStarted?(generationId: string): void;
      /** The prompt has been through every interceptor and is about to be sent. */
      onPrompt?(body: JsonObject): void;
      onPiece?(text: string): void;
    } = { key: "", port: 0 },
  ): Promise<Generated> {
    const { host, userId } = this;
    const chat = host.chatList.get(chatId);
    if (chat === undefined) throw new Error(`no chat ${chatId}`);
    const type = options.type ?? "normal";
    const generationId = `gen-${hex(8)}`;
    let target: FakeMessage;
    if (type === "normal") target = host.say(chatId, "assistant", "");
    else {
      const last = chat.messages.at(-1);
      if (last === undefined || last.role !== "assistant") throw new Error("nothing to regenerate");
      target = last;
      if (type !== "continue") {
        target.swipes.push("");
        target.swipeId = target.swipes.length - 1;
        host.everywhere((emit) => emit.touched(chatId));
      }
    }
    // Lumiverse's Stop ends the generation wherever it is: while an interceptor works, or while the reply is written.
    const stop = new AbortController();
    const stopped = (): void => stop.abort();
    if (options.signal?.aborted === true) stopped();
    else options.signal?.addEventListener("abort", stopped, { once: true });
    this.generating.set(generationId, { chatId, stop });
    host.everywhere((emit) => emit.started({ generationId, chatId, userId, type, targetMessageId: target.id, targetSwipeId: target.swipeId }));
    options.onStarted?.(generationId);

    // As Lumiverse picks it: the chat's own pin, else the connection the user has selected, else their default, else the first listed.
    const pin = chat.metadata.connection_profile_id;
    const selected = host.selected(userId);
    const connection = host.connectionList.find((c) => c.id === pin) ?? host.connectionList.find((c) => c.id === selected) ?? host.connectionList.find((c) => c.isDefault) ?? host.connectionList[0];
    if (connection === undefined) throw new Error("the chat has no connection");
    const prompt: PromptMessage[] = [{ role: "system", text: options.system ?? "You are Joss, keeper of the harbour light.", history: false }];
    for (const entry of options.lore ?? []) prompt.push({ role: "system", text: entry.text, history: false, lore: true });
    chat.messages.forEach((m, index) => {
      if (m === target && type !== "continue") return;
      prompt.push({ role: m.role as ChatRole, text: m.swipes[m.swipeId] ?? "", history: true, sourceId: m.id, sourceIndex: index });
    });
    const activated = (options.lore ?? []).map((e) => ({ entryId: e.entryId, bookId: e.bookId, title: e.title, ...(e.how !== undefined ? { how: e.how } : {}), ...(e.score !== undefined ? { score: e.score } : {}) }));
    let parameters: Record<string, unknown> = {};
    let kept = prompt;
    const breakdown: { index: number; name: string }[] = [];
    let failed: string | null = null;
    // Every extension's interceptor, the lowest priority first and equals in the order they were installed, each on what the one before left; a later one's parameters go over an earlier one's (Lumiverse's interceptor pipeline). Each has the time its extension's manifest asks for; one that fails or runs out of it is passed over and the prompt goes on as the one before left it, unless it is required, which fails the generation.
    const interceptors = host.extensions.flatMap((extension) => (extension.interceptor !== null && extension.interceptor.options.types.includes(type) ? [{ ...extension.interceptor, limit: extension.interceptorMs, identifier: extension.identifier }] : []));
    for (const interceptor of interceptors.sort((a, b) => a.options.priority - b.options.priority)) {
      if (stop.signal.aborted) break;
      const call = new AbortController();
      const halted = (): void => call.abort("Aborted");
      stop.signal.addEventListener("abort", halted, { once: true });
      const late = Promise.withResolvers<"late">();
      const timer = setTimeout(() => {
        call.abort(`Interceptor from ${interceptor.identifier} timed out (${Math.round(interceptor.limit / 1000)}s)`);
        late.resolve("late");
      }, interceptor.limit);
      const gone = Promise.withResolvers<"stopped">();
      const said = (): void => gone.resolve("stopped");
      stop.signal.addEventListener("abort", said, { once: true });
      try {
        const verdict = await Promise.race([interceptor.handler({ chatId, userId, generationId: null, type, dryRun: false, connectionId: connection.id, presetId: options.presetId ?? null, personaId: null, activated, messages: kept, signal: call.signal }), late.promise, gone.promise]);
        if (verdict === "stopped") break;
        if (verdict === "late") {
          if (interceptor.options.required) failed = `Interceptor from ${interceptor.identifier} timed out`;
          continue;
        }
        if (verdict.messages !== undefined) {
          const before = kept;
          kept = [];
          for (const slot of verdict.messages) {
            if ("keep" in slot) {
              const came = before[slot.keep];
              if (came !== undefined) kept.push(came);
              continue;
            }
            if (slot.label !== undefined) breakdown.push({ index: kept.length, name: slot.label });
            kept.push({ role: slot.role, text: slot.text, history: false });
          }
        } else {
          const omit = new Set(verdict.omit ?? []);
          kept = kept.filter((_, i) => !omit.has(i));
        }
        parameters = { ...parameters, ...verdict.parameters };
      } catch (error) {
        if (interceptor.options.required) failed = error instanceof Error ? error.message : String(error);
        this.interceptorErrors.push({ identifier: interceptor.identifier, message: error instanceof Error ? error.message : String(error) });
      } finally {
        clearTimeout(timer);
        stop.signal.removeEventListener("abort", halted);
        stop.signal.removeEventListener("abort", said);
      }
      if (failed !== null) break;
    }
    const body = { model: connection.model, stream: true, messages: kept.map((m) => ({ role: m.role, content: m.text })), temperature: 0.8, max_tokens: 600, ...parameters } as JsonObject;

    const out: Generated = { generationId, messageId: null, status: 0, content: "", reasoning: "", error: null, finish: null, usage: null, body, breakdown };
    try {
      if (failed !== null) Object.assign(out, { status: 500, error: { message: failed, code: "interceptor" } });
      else if (!stop.signal.aborted) {
        options.onPrompt?.(body);
        // A connection that is the runtime's loopback is the runtime's to answer; any other is a provider Lumiverse calls itself.
        if (connection.url === `http://127.0.0.1:${options.port}/v1`) Object.assign(out, await this.post(fetch, body, { ...options, signal: stop.signal }));
        else Object.assign(out, await this.provide(body, connection.id, stop.signal, options.onPiece));
      }
    } finally {
      this.generating.delete(generationId);
      options.signal?.removeEventListener("abort", stopped);
    }

    // A continue adds to what the swipe held; any other kind writes a swipe that was empty.
    const before = type === "continue" ? (target.swipes[target.swipeId] ?? "") : "";
    if (stop.signal.aborted) {
      // Stop: Lumiverse keeps what was written on the message it was writing, and deletes a new reply's message that got neither text nor reasoning; then it says so.
      if (type === "normal" && out.content === "" && out.reasoning === "") chat.messages.splice(chat.messages.indexOf(target), 1);
      else target.swipes[target.swipeId] = before + out.content;
      host.everywhere((emit) => emit.touched(chatId));
      host.everywhere((emit) => emit.stopped({ generationId, chatId, userId }));
      return out;
    }
    if (out.error !== null || out.status !== 200) {
      if (type === "normal") {
        chat.messages.splice(chat.messages.indexOf(target), 1);
        host.everywhere((emit) => emit.touched(chatId));
      }
      host.everywhere((emit) => emit.ended({ generationId, chatId, userId, messageId: null, error: out.error?.message ?? `status ${out.status}` }));
      return out;
    }
    target.swipes[target.swipeId] = before + out.content;
    out.messageId = target.id;
    host.everywhere((emit) => emit.touched(chatId));
    // Lumiverse says what the generation wrote with its end, as it saved it.
    host.everywhere((emit) => emit.ended({ generationId, chatId, userId, messageId: target.id, content: before + out.content, error: null }));
    return out;
  }

  /**
   * Lumiverse's own generation on a connection that is no loopback: the prompt goes to that
   * connection's model (`writes`), and its answer is the reply. A Stop while it writes ends it with
   * nothing written; a model that fails, fails the generation in its own words.
   */
  private async provide(body: JsonObject, connectionId: string, signal: AbortSignal, onPiece?: (text: string) => void): Promise<Pick<Generated, "status" | "content" | "reasoning" | "error" | "finish" | "usage">> {
    this.provided.push({ connectionId, body });
    const halted = Promise.withResolvers<null>();
    const stopped = (): void => halted.resolve(null);
    signal.addEventListener("abort", stopped, { once: true });
    try {
      const content = await Promise.race([Promise.resolve().then(() => this.writes(body, connectionId)), halted.promise]);
      if (content === null || signal.aborted) return { status: 0, content: "", reasoning: "", error: null, finish: null, usage: null };
      onPiece?.(content);
      return { status: 200, content, reasoning: "", error: null, finish: "stop", usage: null };
    } catch (error) {
      return { status: 502, content: "", reasoning: "", error: { message: error instanceof Error ? error.message : String(error), code: "provider" }, finish: null, usage: null };
    } finally {
      signal.removeEventListener("abort", stopped);
    }
  }

  /**
   * One request to the loopback endpoint, as Lumiverse's provider code sends one, read to its end:
   * a streamed completion piece by piece, a plain one whole, an error in its own words. An aborted
   * request gives what came before the abort.
   */
  async post(fetch: (request: Request) => Promise<Response>, body: JsonObject, options: { key: string; port: number; signal?: AbortSignal; onPiece?(text: string): void }): Promise<Pick<Generated, "status" | "content" | "reasoning" | "error" | "finish" | "usage">> {
    const out: Pick<Generated, "status" | "content" | "reasoning" | "error" | "finish" | "usage"> = { status: 0, content: "", reasoning: "", error: null, finish: null, usage: null };
    type Choice = { delta?: { content?: string; reasoning?: string }; message?: { content?: string }; finish_reason?: string | null };
    type Wire = { error?: { message?: string; code?: string }; choices?: Choice[]; usage?: JsonObject };
    const headers = { authorization: `Bearer ${options.key}`, "content-type": "application/json", host: `127.0.0.1:${options.port}` };
    try {
      const response = await fetch(new Request(`http://127.0.0.1:${options.port}/v1/chat/completions`, { method: "POST", headers, body: JSON.stringify(body), ...(options.signal ? { signal: options.signal } : {}) }));
      out.status = response.status;
      if (response.headers.get("content-type")?.includes("text/event-stream") !== true) {
        const whole = (await response.json()) as Wire;
        if (whole.error) out.error = { message: whole.error.message ?? "", code: whole.error.code ?? "" };
        out.content = whole.choices?.[0]?.message?.content ?? "";
        out.finish = whole.choices?.[0]?.finish_reason ?? null;
        out.usage = whole.usage ?? null;
      } else if (response.body !== null) {
        const reader = response.body.getReader();
        const decoder = new TextDecoder();
        let buffered = "";
        const cancel = (): void => void reader.cancel().catch(() => undefined);
        options.signal?.addEventListener("abort", cancel, { once: true });
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          buffered += decoder.decode(value, { stream: true });
          for (let at = buffered.indexOf("\n\n"); at >= 0; at = buffered.indexOf("\n\n")) {
            const event = buffered.slice(0, at);
            buffered = buffered.slice(at + 2);
            const data = event.split("\n").find((line) => line.startsWith("data: "))?.slice(6);
            if (data === undefined || data === "[DONE]") continue;
            // The runtime writes reasoning as `delta.reasoning`, the key Lumiverse reads from an OpenAI-compatible stream.
            const piece = JSON.parse(data) as Wire;
            if (piece.error) out.error = { message: piece.error.message ?? "", code: piece.error.code ?? "" };
            const choice = piece.choices?.[0];
            if (choice?.delta?.content) {
              out.content += choice.delta.content;
              options.onPiece?.(choice.delta.content);
            }
            if (choice?.delta?.reasoning) out.reasoning += choice.delta.reasoning;
            if (choice?.finish_reason) out.finish = choice.finish_reason;
            if (piece.usage) out.usage = piece.usage;
          }
        }
        options.signal?.removeEventListener("abort", cancel);
      }
    } catch (error) {
      if (options.signal?.aborted !== true) throw error;
    }
    return out;
  }
}
