// What the model layer's tests share: a layer over a folder of its own, a scripted `fetch` that
// keeps what each request sent, answers written the way each provider's API streams them, and
// timers that fire only when a test says.

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Provider } from "@earendil-works/pi-ai";
import type { ModelRequest } from "../../../src/core/ports";
import type { CallCache, ModelLayer } from "../../../src/runtime/models";
import { createModelLayer } from "../../../src/runtime/models";

/** One request a scripted fetch was sent. */
export interface Sent {
  url: string;
  method: string;
  headers: Record<string, string>;
  /** The body as JSON where it is JSON, else its text. */
  body: unknown;
  text: string;
}

export type Script = (sent: Sent, index: number) => Response | Promise<Response>;

/** A fetch that answers from a script and keeps every request it was sent. */
export function scriptedFetch(script: Script): { fetch: typeof globalThis.fetch; sent: Sent[] } {
  const sent: Sent[] = [];
  const answer = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const request = new Request(input, init);
    const text = request.method === "GET" || request.method === "HEAD" ? "" : await request.text();
    let body: unknown = text;
    try {
      body = text === "" ? null : JSON.parse(text);
    } catch {
      // A form or plain text: kept as its text.
    }
    const one: Sent = { url: request.url, method: request.method, headers: Object.fromEntries(request.headers), body, text };
    sent.push(one);
    return script(one, sent.length - 1);
  };
  return { fetch: Object.assign(answer, { preconnect: (): void => undefined }), sent };
}

/** A body sent with a request, read as an object. */
export function bodyOf(sent: Sent | undefined): Record<string, unknown> {
  const body = sent?.body;
  if (typeof body !== "object" || body === null || Array.isArray(body)) throw new Error("the request had no JSON body");
  return body as Record<string, unknown>;
}

/** An event stream's response, its text given whole. */
export function eventStream(text: string): Response {
  return new Response(text, { status: 200, headers: { "content-type": "text/event-stream" } });
}

/** A failed request's response: its status and its JSON body. */
export function failed(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

/** A JSON response. */
export function json(body: unknown): Response {
  return new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
}

/** Anthropic's events as its Messages API streams them. */
export function anthropicStream(events: readonly Record<string, unknown>[]): string {
  return events.map((e) => `event: ${String(e.type)}\ndata: ${JSON.stringify(e)}\n\n`).join("");
}

export interface AnthropicTurn {
  model?: string;
  thinking?: { text: string; signature: string };
  text?: string;
  tool?: { id: string; name: string; input: Record<string, unknown> };
  usage?: { input: number; output: number; cacheRead?: number; cacheWrite?: number; thinking?: number };
}

/** The events of one whole Anthropic answer: its thinking, its text and its tool call, each a block, then its end and its usage. */
export function anthropicTurn(turn: AnthropicTurn): Record<string, unknown>[] {
  const usage = turn.usage ?? { input: 10, output: 5 };
  const events: Record<string, unknown>[] = [
    { type: "message_start", message: { id: "msg_1", type: "message", role: "assistant", model: turn.model ?? "claude-sonnet-4-5", content: [], stop_reason: null, usage: { input_tokens: usage.input, output_tokens: 1, cache_read_input_tokens: usage.cacheRead ?? 0, cache_creation_input_tokens: usage.cacheWrite ?? 0 } } },
  ];
  let index = 0;
  if (turn.thinking) {
    events.push(
      { type: "content_block_start", index, content_block: { type: "thinking", thinking: "", signature: "" } },
      { type: "content_block_delta", index, delta: { type: "thinking_delta", thinking: turn.thinking.text } },
      { type: "content_block_delta", index, delta: { type: "signature_delta", signature: turn.thinking.signature } },
      { type: "content_block_stop", index },
    );
    index += 1;
  }
  if (turn.text !== undefined) {
    events.push({ type: "content_block_start", index, content_block: { type: "text", text: "" } }, { type: "content_block_delta", index, delta: { type: "text_delta", text: turn.text } }, { type: "content_block_stop", index });
    index += 1;
  }
  if (turn.tool) {
    events.push(
      { type: "content_block_start", index, content_block: { type: "tool_use", id: turn.tool.id, name: turn.tool.name, input: {} } },
      { type: "content_block_delta", index, delta: { type: "input_json_delta", partial_json: JSON.stringify(turn.tool.input) } },
      { type: "content_block_stop", index },
    );
  }
  events.push(
    { type: "message_delta", delta: { stop_reason: turn.tool ? "tool_use" : "end_turn" }, usage: { output_tokens: usage.output, ...(usage.thinking !== undefined ? { output_tokens_details: { thinking_tokens: usage.thinking } } : {}) } },
    { type: "message_stop" },
  );
  return events;
}

/** OpenAI's chat-completion chunks as a stream, ended as OpenAI ends one. */
export function chatStream(chunks: readonly Record<string, unknown>[]): string {
  return `${chunks.map((c) => `data: ${JSON.stringify(c)}\n\n`).join("")}data: [DONE]\n\n`;
}

/** A chat-completion chunk with one choice's delta, and its finish where it has one. */
export function chunk(delta: Record<string, unknown>, finish: string | null = null): Record<string, unknown> {
  return { id: "chatcmpl-1", object: "chat.completion.chunk", created: 1, model: "served-model", choices: [{ index: 0, delta, finish_reason: finish }] };
}

/** Timers that fire only when a test fires them. */
export class Timers {
  private next = 0;
  readonly pending = new Map<number, { run: () => void; ms: number }>();
  set = (run: () => void, ms: number): unknown => {
    this.next += 1;
    this.pending.set(this.next, { run, ms });
    return this.next;
  };
  clear = (handle: unknown): void => {
    if (typeof handle === "number") this.pending.delete(handle);
  };
  fireAll(): void {
    for (const [handle, timer] of [...this.pending]) {
      this.pending.delete(handle);
      timer.run();
    }
  }
}

export interface RigOptions {
  script?: Script;
  providers?: readonly Provider[];
  caching?: (request: ModelRequest | null) => CallCache;
  passConnection?: string | null;
  serialTools?: readonly string[];
  /** A folder of the test's own, for a layer that reads another's files. */
  dir?: string;
}

export interface Rig {
  layer: ModelLayer;
  dir: string;
  sent: Sent[];
  timers: Timers;
  logs: string[];
  /** Closes the layer and takes its folder away. */
  done(): Promise<void>;
}

/** The installation id the rig's layers make for OpenAI's sign-in. */
export const DEVICE = "0f8e6a52-1c3b-4d7a-9e2f-5b6c7d8e9f01";

/** A model layer over a folder of its own, its HTTP scripted, its ids counted and its timers held. */
export function rig(options: RigOptions = {}): Rig {
  const dir = options.dir ?? mkdtempSync(join(tmpdir(), "lumiah-models-"));
  const { fetch, sent } = scriptedFetch(options.script ?? (() => failed(500, { error: { message: "nothing scripted" } })));
  const timers = new Timers();
  const logs: string[] = [];
  let ids = 0;
  let clock = 1_000_000;
  const layer = createModelLayer({
    dir,
    now: () => (clock += 5),
    id: () => `id${++ids}`,
    uuid: () => DEVICE,
    log: (text) => logs.push(text),
    fetch,
    setTimeout: timers.set,
    clearTimeout: timers.clear,
    caching: options.caching ?? (() => ({ retention: "short" })),
    passConnection: async () => options.passConnection ?? null,
    ...(options.serialTools ? { serialTools: () => options.serialTools ?? [] } : {}),
    ...(options.providers ? { providers: options.providers } : {}),
  });
  return {
    layer,
    dir,
    sent,
    timers,
    logs,
    async done() {
      await layer.close();
      if (options.dir === undefined) rmSync(dir, { recursive: true, force: true });
    },
  };
}

/** A request of the core's for a call, with the rest of its fields as the test gives them. */
export function request(fields: Partial<ModelRequest> & Pick<ModelRequest, "messages">): ModelRequest {
  return { maxTokens: 1000, connectionId: null, model: null, ...fields };
}

/** A signal that never ends. */
export function forever(): AbortSignal {
  return new AbortController().signal;
}
