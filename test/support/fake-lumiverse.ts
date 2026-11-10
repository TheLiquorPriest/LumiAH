// The rest of a made-up Lumiverse, for tests that run a runtime against the extension backend: the
// HTTP routes the runtime calls, the event socket its link travels (to the fake host's backend and
// back), pages that send the backend requests, and a generation as Lumiverse runs one: its start
// event, the prompt through the interceptor, the request to the loopback connection, the reply read
// as it streams, the message saved and the end event.

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
}

export class FakeLumiverse {
  readonly extensionId = "ext-lumiah";
  readonly base = "http://127.0.0.1:7860";
  token = "session-token-mara";
  /** Frames on their way to a runtime pass here first: false drops one (a chunk lost on the way). */
  filter: (frame: Record<string, unknown>) => boolean = () => true;
  /** The runtime sockets open now, by session. */
  readonly sockets = new Map<string, { close(code: number, reason: string): void }>();
  /** The keys put in connections, by connection. */
  readonly keys = new Map<string, string>();
  private n = 0;

  constructor(
    readonly host: FakeHost,
    readonly userId: string,
  ) {}

  /** The routes the runtime calls with its session. */
  readonly http: Http = async (request) => {
    const url = new URL(request.url);
    const path = url.pathname;
    if (request.headers.Authorization !== `Bearer ${this.token}` && path !== "/api/auth/sign-in/username") return reply(401, { error: "Unauthorized" });
    if (path === "/api/v1/spindle" && request.method === "GET") return reply(200, { extensions: [{ id: this.extensionId, identifier: "lumi_ah", version: "0.0.1", enabled: true, status: "running" }] });
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
    return reply(404, { error: "Not found" });
  };

  /** The event socket: a runtime's frames go to the backend with the socket's session, and the backend's to that session come back. */
  readonly openSocket: OpenSocket = (url, events) => {
    const session = new URL(url).searchParams.get("frontend_session") ?? hex(16);
    let open = true;
    this.host.outlets.set(session, {
      userId: this.userId,
      receive: (message) => {
        if (!open) return;
        const frame = message as Record<string, unknown>;
        if (frame.link === LINK && !this.filter(frame)) return;
        events.message(JSON.stringify({ event: "SPINDLE_FRONTEND_MSG", payload: { extensionId: this.extensionId, data: message } }));
      },
    });
    this.sockets.set(session, {
      close: (code, reason) => {
        if (!open) return;
        open = false;
        this.sockets.delete(session);
        this.host.closeSession(session);
        events.close(code, reason);
      },
    });
    queueMicrotask(() => events.message(JSON.stringify({ event: "CONNECTED" })));
    const socket: Socket = {
      send: (text) => {
        if (!open) return;
        const message = JSON.parse(text) as { type?: string; extensionId?: string; payload?: unknown };
        if (message.type === "SPINDLE_BACKEND_MSG" && message.extensionId === this.extensionId) this.host.deliver(message.payload, this.userId, session);
      },
      close: () => {
        if (!open) return;
        open = false;
        this.sockets.delete(session);
        this.host.closeSession(session);
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
   * request is on its way; `signal` is Lumiverse's Stop.
   */
  async generate(
    fetch: (request: Request) => Promise<Response>,
    chatId: string,
    options: { key: string; port: number; type?: HostGenerationType; presetId?: string | null; system?: string; signal?: AbortSignal; onStarted?(generationId: string): void; onPiece?(text: string): void } = { key: "", port: 0 },
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
        host.emit.touched(chatId);
      }
    }
    host.emit.started({ generationId, chatId, userId, type, targetMessageId: target.id, targetSwipeId: target.swipeId });
    options.onStarted?.(generationId);

    const pin = chat.metadata.connection_profile_id;
    const connection = host.connectionList.find((c) => c.id === pin) ?? host.connectionList.find((c) => c.isDefault);
    if (connection === undefined) throw new Error("the chat has no connection");
    const prompt: PromptMessage[] = [{ role: "system", text: options.system ?? "You are Joss, keeper of the harbour light.", history: false }];
    chat.messages.forEach((m, index) => {
      if (m === target && type !== "continue") return;
      prompt.push({ role: m.role as ChatRole, text: m.swipes[m.swipeId] ?? "", history: true, sourceId: m.id, sourceIndex: index });
    });
    let parameters: Record<string, unknown> = {};
    let kept = prompt;
    const interceptor = host.interceptor;
    if (interceptor !== null && interceptor.options.types.includes(type)) {
      const verdict = await interceptor.handler({ chatId, userId, generationId: null, type, dryRun: false, connectionId: connection.id, presetId: options.presetId ?? null, personaId: null, activated: [], messages: prompt });
      const omit = new Set(verdict.omit ?? []);
      kept = prompt.filter((_, i) => !omit.has(i));
      parameters = verdict.parameters ?? {};
    }
    const body = { model: connection.model, stream: true, messages: kept.map((m) => ({ role: m.role, content: m.text })), temperature: 0.8, max_tokens: 600, ...parameters } as JsonObject;

    const out: Generated = { generationId, messageId: null, status: 0, content: "", reasoning: "", error: null, finish: null, usage: null, body };
    Object.assign(out, await this.post(fetch, body, options));

    if (options.signal?.aborted === true) {
      // Stop: Lumiverse keeps what was written on the message it was writing, and says so.
      target.swipes[target.swipeId] = out.content;
      host.emit.touched(chatId);
      host.emit.stopped({ generationId, chatId, userId });
      return out;
    }
    if (out.error !== null || out.status !== 200) {
      if (type === "normal") {
        chat.messages.splice(chat.messages.indexOf(target), 1);
        host.emit.touched(chatId);
      }
      host.emit.ended({ generationId, chatId, userId, messageId: null, error: out.error?.message ?? `status ${out.status}` });
      return out;
    }
    target.swipes[target.swipeId] = out.content;
    out.messageId = target.id;
    host.emit.touched(chatId);
    host.emit.ended({ generationId, chatId, userId, messageId: target.id, error: null });
    return out;
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
