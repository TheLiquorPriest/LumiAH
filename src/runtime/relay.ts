// The runtime's loopback endpoint (DESIGN §2): an OpenAI-compatible endpoint for Lumiverse's Custom
// connection. `POST /v1/chat/completions` with the interceptor's tag is a turn (turn.ts); one without
// passes through to the writer's connection whole, through the runtime's model layer (models/),
// streamed back as it comes. A request passed through is refused before anything of it is answered
// or sent where something in it can't be carried: what no call carries as the body reads
// (openai.ts), then, once the extension says its key is the user's own, what can't reach the model
// on the connection it goes to (the layer's `passing`). With no connection of the runtime's to call,
// a turn and a request passed through are refused before any work, in words that say where to add
// one. `GET /v1/models` lists the loopback's model once the key checks out; `GET /healthz` says how
// the runtime is (on an address other machines reach, only that it is up, unless the runtime's own
// config asks). The key each request carries is checked for its form before any of the request's
// body is read, and the extension says whether it is the user's own (with the turn, or before
// anything of a request passed through is told or sent); it is never kept. Once the runtime begins
// to stop, everything but the road's probe is refused: it keeps its port until its link has closed
// (cli.ts), and nothing meant for it is answered meanwhile.
//
// The handler takes and gives the web's Request and Response, so Bun.serve runs it (main.ts) and the
// tests call it directly. Time comes from `now()`, and `tick()` (every second) keeps the answers'
// streams alive while the work behind them runs.

import type { JsonObject } from "../link/json";
import { hasOwn, isRecord } from "../link/json";
import { KEY_FORM, TAG_PARAM } from "../link/contract";
import { ASK_PATH, PROBE_HEADER } from "../link/road";
import type { RuntimeTuning } from "../link/settings";
import { addConnectionWords } from "../shared/connections";
import { LinkError } from "./connection";
import type { RuntimeLink } from "./link";
import { refusedReply } from "./link";
import { LiveError } from "./lumiverse";
import type { ModelLayer, Passing } from "./models";
import { NoConnection, NotCarried } from "./models";
import type { PassedRequest } from "./openai";
import { notPassedWords, passedRequest } from "./openai";
import { HealthProofs } from "./proof";
import type { Answer, ReplyPiece } from "./sse";
import { JsonAnswer, SSE_HEADERS, SseAnswer, errorJson, statusOf } from "./sse";
import { problemOf } from "./streams";

export interface RelaySettings {
  /** The address and port it serves on: a request's Host must name them (no DNS rebinding), unless the address is a wildcard (`0.0.0.0`, `::`), which names none of the machine's own. */
  listen: string;
  port: number;
  /** The model its loopback connection names (`loopbackModel` of the extension it links to): what a completion says answered a request that names none. */
  model: string;
}

export interface RelayEnv {
  now(): number;
  /** 128 random bits as hex: a stream's or a request's name. */
  id(): string;
  log(text: string): void;
  tuning(): RuntimeTuning;
  /** The relay's secret now: what a request must prove it holds (`healthProof`) to be told how the runtime is on an address other machines reach. */
  secret(): string;
  /** The road for asks (`POST /x/ask`, asks.ts): handed every request on its path, once the Origin and the Host check out. */
  ask?(req: Request): Promise<Response>;
}

/** A tagged request handed to the turn: its tag and key, the body as Lumiverse sent it (the tag taken out), where its reply goes, and the request's own end (Lumiverse's Stop closes it). */
export interface TaggedRequest {
  request: string;
  tag: string;
  key: string;
  body: JsonObject;
  answer: Answer;
  signal: AbortSignal;
}

/** What the relay needs of the turns (turn.ts): one run per tagged request, which ends its answer whatever happens; and the writer's connection, which a passthrough goes on. */
export interface TurnRunner {
  run(request: TaggedRequest): Promise<void>;
  writerConnection(): Promise<string | null>;
  readonly count: number;
}

/** A request the relay is answering: its answer, how it ends, and what to tell when Lumiverse closes it. */
interface Call {
  id: string;
  answer: SseAnswer | JsonAnswer;
  /** Closes the SSE body, or answers the JSON request. */
  settle(): void;
  /** What Lumiverse closing the request ends: the turn's signal, or the passthrough's stream. */
  closed(): void;
  ended: boolean;
}

const encoder = new TextEncoder();

function json(status: number, body: JsonObject, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json", ...headers } });
}

/** The wait for the link the model list and a request passed through take ("Model list wait"), by its place in the transport's settings. */
const MODELS_WAIT = ["runtime", "modelsWaitMs"] as const;

const LOOPBACK_HOSTS: Record<string, true> = { "127.0.0.1": true, localhost: true, "[::1]": true, "::1": true };
/** Addresses that listen on every one of the machine's: a runtime on one is reached by whatever names the machine has, so there is none to hold the Host to. */
const WILDCARD_HOSTS: Record<string, true> = { "0.0.0.0": true, "::": true, "[::]": true };

export class Relay {
  private readonly calls = new Map<string, Call>();
  /** The proofs `GET /healthz` takes from the holder of the runtime's config (proof.ts): each once, and only near its time. */
  private readonly proofs = new HealthProofs(
    () => this.env.secret(),
    () => this.env.now(),
  );
  /** Set by `shutdown()`: from then on every request but the road's probe is refused (`fetch`). */
  private stopping = false;

  constructor(
    private readonly link: RuntimeLink,
    private readonly layer: Pick<ModelLayer, "passing" | "connections">,
    private readonly turns: TurnRunner,
    private readonly settings: RelaySettings,
    private readonly env: RelayEnv,
  ) {}

  /** The requests under way. */
  get count(): number {
    return this.calls.size;
  }

  /** Every second: keep each answer's stream alive; progress lines only while the extension answers, so they never claim work that isn't happening. */
  tick(): void {
    const now = this.env.now();
    const alive = this.link.out === null;
    const tuning = this.env.tuning();
    for (const call of this.calls.values()) if (call.answer instanceof SseAnswer) call.answer.keepAlive(now, alive, tuning);
  }

  /** The runtime is stopping: every request under way ends with words the chat shows, and every one that comes after is refused but the road's probe. */
  shutdown(): void {
    this.stopping = true;
    for (const call of [...this.calls.values()]) {
      call.closed();
      this.end(call, { message: "The runtime is restarting. Press Retry in a moment.", code: "unavailable" });
    }
  }

  /** Bun.serve's handler. */
  readonly fetch = async (req: Request): Promise<Response> => {
    const url = new URL(req.url);
    // Lumiverse's own request sends no Origin; a page in a browser always does, so it never drives the runtime.
    if (req.headers.get("origin") !== null) return json(403, errorJson("LumiAH's runtime answers Lumiverse's server, not a browser.", "forbidden"));
    if (!this.hostAllowed(req.headers.get("host"))) return json(421, errorJson(`This is LumiAH's runtime at ${this.settings.listen}:${this.settings.port}; it answers requests addressed to it alone.`, "misdirected"));
    // Stopping: the runtime keeps its port until its link has closed, since LumiAH sends the road's asks, the relay's secret with them, to the port for as long as it holds the link, and another program that took the port would be sent them. Nothing is answered meanwhile but the road's probe, by which a copy of this runtime that starts now knows it (cli.ts); the road takes the refusal for a failure, and asks over the link.
    if (this.stopping && (url.pathname !== ASK_PATH || req.headers.get(PROBE_HEADER) === null)) return json(503, errorJson("The runtime is restarting. Press Retry in a moment.", "unavailable"));
    // The asks' own road, reached through Lumiverse's proxy: its words are its own, and never say back what was asked.
    if (url.pathname === ASK_PATH && this.env.ask !== undefined) return this.env.ask(req);
    const path = url.pathname.replace(/\/+$/, "").replace(/^\/v1(?=\/)/, "");
    if (path === "/healthz" && req.method === "GET") return this.health(req);
    if (path === "/models" && req.method === "GET") return this.models(req);
    if (path === "/chat/completions" && req.method === "POST") return this.completions(req);
    return json(404, errorJson(`LumiAH's runtime has no ${req.method} ${url.pathname}: it serves POST /v1/chat/completions and GET /v1/models.`, "not_found"));
  };

  /** Whether the request is addressed to this runtime (no DNS rebinding): its Host names the runtime's own address and port, any loopback name for a loopback address; any Host on a wildcard address. */
  private hostAllowed(host: string | null): boolean {
    if (host === null) return false;
    const listen = this.settings.listen.toLowerCase();
    if (hasOwn(WILDCARD_HOSTS, listen)) return true;
    const at = host.lastIndexOf(":");
    const ported = at > 0 && !host.endsWith("]");
    const name = (ported ? host.slice(0, at) : host).toLowerCase();
    if ((ported ? Number(host.slice(at + 1)) : 80) !== this.settings.port) return false;
    return hasOwn(LOOPBACK_HOSTS, listen) ? hasOwn(LOOPBACK_HOSTS, name) : name === listen || name === `[${listen}]`;
  }

  /**
   * `GET /healthz`. On the machine's own loopback address it says how the runtime is to whoever
   * asks, since only that machine can. On any other address the same answer would tell every
   * machine that reaches the port whether the user is writing now (the replies under way) and what
   * is wrong with their setup (the link's state, a refusal's words), with no key asked. So there it
   * says that it is up and nothing else, unless the request shows it holds this runtime's config
   * (`healthProof`), as `lumiah status` and `up` do.
   */
  private async health(req: Request): Promise<Response> {
    const listen = this.settings.listen.toLowerCase();
    // The machine's own loopback: its names, and every address of 127.0.0.0/8.
    if (!hasOwn(LOOPBACK_HOSTS, listen) && !/^127(\.\d{1,3}){3}$/.test(listen)) {
      const shown = this.keyOf(req);
      if (shown === null || !(await this.proofs.holds(shown))) return json(200, { up: true });
    }
    // `link`: up, or why the extension is out of reach (down, silent, stopped, crashed), or refused.
    const out = this.link.out;
    return json(200, { ok: this.link.refused === null, link: this.link.refused !== null ? "refused" : (out?.why ?? (this.link.up ? "up" : "down")), backend: this.link.backendName ?? "LumiAH", turns: this.turns.count, requests: this.calls.size, ...(this.link.refused !== null ? { problem: this.link.refused } : {}) });
  }

  /** The bearer a request carries, as it came; null when it carries none. */
  private keyOf(req: Request): string | null {
    const auth = req.headers.get("authorization") ?? "";
    const key = /^Bearer\s+(.+)$/i.exec(auth.trim())?.[1]?.trim() ?? "";
    return key === "" ? null : key;
  }

  private noKey(): Response {
    return json(401, errorJson("This is LumiAH's runtime: set the connection's API key to your loopback key (LumiAH → Runtime).", "invalid_api_key"));
  }

  /** A key that isn't of the form the extension mints (`KEY_FORM`): refused here, with nothing of the request read and the extension not asked. */
  private notAKey(): Response {
    return json(401, errorJson("This is LumiAH's runtime: the connection's API key isn't a loopback key (one starts with lah_). Mint one on the Runtime page (LumiAH → Runtime): your linked runtime puts it in the connection.", "invalid_api_key"));
  }

  private async models(req: Request): Promise<Response> {
    const key = this.keyOf(req);
    if (key === null) return this.noKey();
    if (this.link.refused !== null) return json(503, errorJson(this.link.refused, "revoked"));
    if (!KEY_FORM.test(key)) return this.notAKey();
    try {
      const { models } = await this.link.request("models", { key }, this.env.tuning().modelsWaitMs, MODELS_WAIT);
      return json(200, { object: "list", data: models.map((m) => ({ id: m.id, object: "model", created: 0, owned_by: "lumiah" })) });
    } catch (error) {
      const p = problemOf(error, this.link.backendName);
      // A key the extension refused reads as a bad key to the connection's Test.
      const badKey = error instanceof LinkError && error.code === "forbidden";
      return json(badKey ? 401 : statusOf(p.code), errorJson(p.message, badKey ? "invalid_api_key" : p.code));
    }
  }

  private async completions(req: Request): Promise<Response> {
    const key = this.keyOf(req);
    if (key === null) return this.noKey();
    // Before any of the body is read: a request that shows no key the extension could have minted is refused as it stands. Whether the key is this user's own is the extension's to say, when the request reaches it.
    if (!KEY_FORM.test(key)) return this.notAKey();
    const cap = this.env.tuning().maxBodyBytes;
    const length = Number(req.headers.get("content-length") ?? "0");
    const tooLarge = (bytes: number): Response => json(413, errorJson(`This request is ${(bytes / 1048576).toFixed(1)} MiB, and the runtime reads at most ${(cap / 1048576).toFixed(1)} MiB (LumiAH → Settings → Transport → Runtime). Lower the history cutoff or the connection's context size.`, "too_large"));
    if (length > cap) return tooLarge(length);
    // Counted as it arrives, so a body sent without Content-Length stops at the cap instead of being read whole.
    const parts: Uint8Array[] = [];
    let bytes = 0;
    if (req.body !== null) {
      const reader = req.body.getReader();
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        bytes += value.byteLength;
        if (bytes > cap) {
          void reader.cancel().catch(() => {});
          return tooLarge(bytes);
        }
        parts.push(value);
      }
    }
    let body: unknown;
    try {
      body = JSON.parse(new TextDecoder().decode(Buffer.concat(parts)));
    } catch {
      return json(400, errorJson("The request body isn't JSON.", "invalid_request"));
    }
    if (!isRecord(body) || !Array.isArray(body.messages)) return json(400, errorJson("The request isn't a chat completion: it has no messages.", "invalid_request"));
    const tag = body[TAG_PARAM];
    if (tag !== undefined && (typeof tag !== "string" || tag === "")) return json(400, errorJson(`${TAG_PARAM} must be the turn's tag.`, "invalid_request"));
    const forwarded = { ...body } as JsonObject;
    delete forwarded[TAG_PARAM];
    // A turn's tag, or the untagged request as it is passed on, which goes whole or not at all: what in it can't be carried is said here, before anything is sent or answered.
    const work = typeof tag === "string" ? { tag } : passedRequest(forwarded);
    if ("refused" in work) return json(400, errorJson(work.refused, "invalid_request"));
    // A chat's reply is told what LumiAH does about it too; a request that is no chat's reply only why.
    const refused = "tag" in work ? refusedReply(this.link) : this.link.refused;
    if (refused !== null) return json(503, errorJson(refused, "revoked"));
    // A reply with no connection of the runtime's to call is refused before anything of it starts. One the runtime can't read its connections for goes on: its agents say why.
    if ("tag" in work && (await this.layer.connections.list().then((list) => list.length === 0, () => false))) return json(503, errorJson(this.noConnection("can't answer this reply"), "no_connection"));
    // What starts the work once its answer is open: the turn, or the request passed through, which is made ready first. What refuses that is the answer, before anything of it is answered or sent.
    let begin: (call: Call) => void;
    if ("tag" in work) begin = (call) => this.turn(call, work.tag, key, forwarded);
    else {
      const passing = await this.ready(key, work);
      if (passing instanceof Response) return passing;
      // Lumiverse closed the request while it was being made ready: there is nobody to answer, and nothing of it starts.
      if (req.signal.aborted) return json(503, errorJson("Lumiverse closed the request.", "closed"));
      begin = (call) => this.passthrough(call, passing);
    }
    const now = this.env.now();
    const id = this.env.id();
    const completion = { id: `chatcmpl-${id.slice(0, 24)}`, model: typeof body.model === "string" && body.model !== "" ? body.model : this.settings.model, created: Math.floor(now / 1000) };
    const jsonAnswer = new JsonAnswer(completion);
    const call: Call = { id, answer: jsonAnswer, settle: () => undefined, closed: () => undefined, ended: false };
    // Lumiverse's Stop force-closes the request: heard here, or as the body's cancel.
    req.signal.addEventListener("abort", () => this.close(call), { once: true });
    if (body.stream === true) {
      const stream = new ReadableStream<Uint8Array>({
        start: (controller) => {
          let open = true;
          const write = (piece: string): void => {
            if (!open) return;
            try {
              controller.enqueue(encoder.encode(piece));
            } catch {
              // The client is gone; its cancel ends the call.
              open = false;
            }
          };
          call.answer = new SseAnswer(completion, write, now);
          call.settle = () => {
            if (!open) return;
            open = false;
            try {
              controller.close();
            } catch {
              // Cancelled under it: nothing left to close.
            }
          };
        },
        cancel: () => this.close(call),
      });
      begin(call);
      return new Response(stream, { status: 200, headers: SSE_HEADERS });
    }
    const { promise, resolve } = Promise.withResolvers<Response>();
    call.settle = () => {
      const answer = jsonAnswer.answer;
      resolve(answer === null ? json(500, errorJson("The runtime ended this call without an answer.", "internal")) : json(answer.status, answer.body));
    };
    begin(call);
    return promise;
  }

  /** The answer as the turn writes it: each piece goes out, and the one that ends it settles the request. */
  private writer(call: Call): Answer {
    return {
      get ended() {
        return call.ended || call.answer.ended;
      },
      piece: (piece, now) => {
        if (call.ended) return;
        call.answer.piece(piece, now);
        if (call.answer.ended) this.finish(call);
      },
      fail: (message, code, now) => {
        if (call.ended) return;
        call.answer.fail(message, code, now);
        this.finish(call);
      },
    };
  }

  private turn(call: Call, tag: string, key: string, body: JsonObject): void {
    this.calls.set(call.id, call);
    const stop = new AbortController();
    call.closed = () => stop.abort(new Error("The reply was stopped in Lumiverse (it closed the request)."));
    const answer = this.writer(call);
    void this.turns
      .run({ request: call.id, tag, key, body, answer, signal: stop.signal })
      .catch((error: unknown) => {
        const p = problemOf(error, this.link.backendName);
        this.env.log(`a turn failed: ${p.message}`);
        answer.fail(p.message, p.code, this.env.now());
      })
      .finally(() => {
        // Whatever happened, the request is answered: a turn that ended without a word ends it here.
        if (!call.ended) answer.fail("The turn ended without a reply.", "internal", this.env.now());
      });
  }

  /** Where a person adds a connection, in words a reply or a request passed through ends with when the runtime has none to call. */
  private noConnection(what: string): string {
    const name = this.link.backendName ?? "LumiAH";
    return `${name}'s runtime has no connection to call a model on, so it ${what}. ${addConnectionWords(`${name}'s Runtime page, under Connections`)}`;
  }

  /**
   * A request passed through, made ready to go: the extension says its key is the user's own, then
   * the layer makes its call on the connection it goes on, sending nothing. What refuses it is the
   * answer, in OpenAI's error shape: a key that isn't the user's, what in it can't reach the model
   * there, no connection to call.
   */
  private async ready(key: string, passed: PassedRequest): Promise<Passing | Response> {
    try {
      // Whether the key is this user's loopback key is the extension's to say, before anything of the request goes out or anything of the runtime's connections is told.
      await this.link.request("models", { key }, this.env.tuning().modelsWaitMs, MODELS_WAIT);
      return await this.layer.passing(passed);
    } catch (error) {
      if (error instanceof NotCarried) return json(400, errorJson(notPassedWords(error.message), "invalid_request"));
      if (error instanceof NoConnection) return json(503, errorJson(this.noConnection("can't pass this request on"), "no_connection"));
      // A key the extension refused reads as a bad key, as it does to the model list.
      if (error instanceof LinkError && error.code === "forbidden") return json(401, errorJson(error.message, "invalid_api_key"));
      if (error instanceof LinkError || error instanceof LiveError) {
        const p = problemOf(error, this.link.backendName);
        return json(statusOf(p.code), errorJson(p.message, p.code));
      }
      return json(statusOf("model_failed"), errorJson(error instanceof Error ? error.message : String(error), "model_failed"));
    }
  }

  /** An untagged request (DESIGN §2), made ready (`ready`): run as given on the writer's connection (else the default), answered in kind, tools and non-stream included. */
  private passthrough(call: Call, passing: Passing): void {
    this.calls.set(call.id, call);
    const stop = new AbortController();
    call.closed = () => stop.abort(new Error("Lumiverse closed the request."));
    const answer = this.writer(call);
    const go = async (): Promise<void> => {
      const result = await passing.run(stop.signal, (delta) => {
        if (delta.content !== undefined) answer.piece({ kind: "content", text: delta.content }, this.env.now());
        else if (delta.reasoning !== undefined) answer.piece({ kind: "reasoning", text: delta.reasoning }, this.env.now());
      });
      const now = this.env.now();
      // Tool calls come whole with the answer's end; they go out as one fragment each, at their index.
      const calls = result.toolCalls ?? [];
      if (calls.length > 0) answer.piece({ kind: "tool_calls", calls: calls.map((c, index) => ({ index, id: c.callId, name: c.name, arguments: JSON.stringify(c.args) })) }, now);
      const piece: ReplyPiece = { kind: "finish", finish: result.finishReason || (calls.length > 0 ? "tool_calls" : "stop") };
      // The usage as the provider gave it, whole.
      if (result.usage !== undefined) piece.usage = result.usage;
      answer.piece(piece, now);
    };
    void go().catch((error: unknown) => {
      // Lumiverse closed the request: there is nobody left to answer.
      if (stop.signal.aborted) return;
      answer.fail(error instanceof Error ? error.message : String(error), "model_failed", this.env.now());
    });
  }

  private finish(call: Call): void {
    if (call.ended) return;
    call.ended = true;
    this.calls.delete(call.id);
    call.settle();
  }

  private end(call: Call, problem: { message: string; code: string }): void {
    if (call.ended) return;
    call.answer.fail(problem.message, problem.code, this.env.now());
    this.finish(call);
  }

  /** Lumiverse closed the request (Stop): the turn's signal ends, or the passthrough's stream is cancelled. */
  private close(call: Call): void {
    if (call.ended) return;
    call.closed();
    this.finish(call);
  }
}
