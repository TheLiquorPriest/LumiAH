// The runtime's answers to Lumiverse's Custom connection, written for its reader (Lumiverse staging's
// src/llm/provider-sse.ts and the Custom provider's stream loop, openai-compatible.ts): one whole
// JSON object per `data:` line, then a blank line; reasoning only as `choices[0].delta.reasoning`,
// from the first chunk on (Lumiverse locks onto the first reasoning key it sees), and never in a
// chunk that also holds content (Lumiverse takes content equal to its reasoning as reasoning alone);
// a chunk with `finish_reason` (Lumiverse fails a stream without one), then the usage, then
// `data: [DONE]`; a failure as an `error` chunk, which Lumiverse throws as the provider's error;
// comments to keep the socket busy, which Lumiverse skips. Never `<think>` tags.
//
// The same pieces answer a request with `stream` off as one chat completion.

import type { JsonObject } from "../link/json";

/** What every chunk of one answer says of itself. */
export interface Completion {
  id: string;
  model: string;
  /** Seconds since the epoch. */
  created: number;
}

/** How long a quiet stream waits before a comment, and before a progress line into the thinking block. */
export interface KeepAlive {
  /** A comment after this long with nothing written. */
  commentMs: number;
  /** A progress line after this long without a token, since only tokens feed Lumiverse's no-token watchdog. */
  progressMs: number;
}

/** One tool call's fragment, as OpenAI streams them (`delta.tool_calls[]`): `name` and `arguments` are appended per `index`. */
export interface ToolCallPiece {
  index: number;
  id?: string;
  name?: string;
  arguments?: string;
}

/**
 * A piece of an answer. `reasoning` streams into the reply's thinking block, and so does `progress`:
 * a line saying what runs now, put on a line of its own (a model's reasoning often doesn't end with a
 * newline) and restated while nothing else flows. `content` is the reply's text; `tool_calls` the
 * request's tools being called (a passthrough's). `finish` and `error` end the answer.
 */
export type ReplyPiece =
  | { kind: "reasoning"; text: string }
  | { kind: "progress"; text: string }
  | { kind: "content"; text: string }
  | { kind: "tool_calls"; calls: ToolCallPiece[] }
  | { kind: "finish"; finish: string; usage?: JsonObject }
  | { kind: "error"; message: string; code: string };

export const SSE_HEADERS: Readonly<Record<string, string>> = {
  "Content-Type": "text/event-stream; charset=utf-8",
  "Cache-Control": "no-cache, no-transform",
  Connection: "keep-alive",
  // A proxy in front of the runtime (none by default) must not hold the stream back.
  "X-Accel-Buffering": "no",
};

export const DONE = "data: [DONE]\n\n";

const data = (value: JsonObject): string => `data: ${JSON.stringify(value)}\n\n`;

function frame(c: Completion, delta: JsonObject, finish: string | null): JsonObject {
  return { id: c.id, object: "chat.completion.chunk", created: c.created, model: c.model, choices: [{ index: 0, delta, finish_reason: finish }] };
}

function toolCallJson(t: ToolCallPiece): JsonObject {
  const fn: JsonObject = {};
  if (t.name !== undefined) fn.name = t.name;
  if (t.arguments !== undefined) fn.arguments = t.arguments;
  return { index: t.index, ...(t.id !== undefined ? { id: t.id, type: "function" } : {}), function: fn };
}

/** A failure as Lumiverse reads one, in a stream's `error` chunk or a refused request's body. */
export function errorJson(message: string, code: string): JsonObject {
  return { error: { message, type: "lumiah_error", code } };
}

/** Whole minutes, at least one, for a progress line's "(3 min)". */
const minutes = (ms: number): number => Math.max(1, Math.floor(ms / 60_000));

/** A progress line as one line: the newlines around it are the writer's to add, and any inside it would split the line its restatement repeats. */
const oneLine = (text: string): string => text.replace(/\s*\n\s*/g, " ").trim();

/** Whether an answer's pieces still go out: false once its finish or error is written. */
export interface Answer {
  readonly ended: boolean;
  piece(piece: ReplyPiece, now: number): void;
  fail(message: string, code: string, now: number): void;
}

/**
 * One answer as SSE, written as it comes. `write` takes each piece of text for the wire; the stream
 * is over once `ended` (a finish, an error), and anything after is dropped.
 */
export class SseAnswer implements Answer {
  private done = false;
  private lastWrite: number;
  private lastToken: number;
  /** Whether the reasoning written so far ends a line (true before any): a progress line starts on a line of its own. */
  private lineEnded = true;
  /** The latest progress line and when it came: restated while nothing else flows. */
  private progress: { text: string; at: number } | null = null;

  constructor(
    private readonly c: Completion,
    private readonly write: (text: string) => void,
    now: number,
  ) {
    this.lastWrite = now;
    this.lastToken = now;
    // The first chunk names the role and the reasoning key, so Lumiverse locks onto `reasoning` from the start.
    this.send(data(frame(c, { role: "assistant", reasoning: "" }, null)), now);
  }

  get ended(): boolean {
    return this.done;
  }

  private send(text: string, now: number): void {
    this.lastWrite = now;
    this.write(text);
  }

  private reasoning(text: string, now: number): void {
    if (text === "") return;
    this.lineEnded = text.endsWith("\n");
    this.lastToken = now;
    this.send(data(frame(this.c, { reasoning: text }, null)), now);
  }

  /** A line of its own in the thinking block. */
  private line(text: string, now: number): void {
    this.reasoning(`${this.lineEnded ? "" : "\n"}${text}\n`, now);
  }

  piece(piece: ReplyPiece, now: number): void {
    if (this.done) return;
    switch (piece.kind) {
      case "reasoning":
        this.reasoning(piece.text, now);
        return;
      case "progress": {
        const text = oneLine(piece.text);
        if (text === "") return;
        this.progress = { text, at: now };
        this.line(text, now);
        return;
      }
      case "content":
        if (piece.text === "") return;
        this.lastToken = now;
        this.send(data(frame(this.c, { content: piece.text }, null)), now);
        return;
      case "tool_calls":
        this.lastToken = now;
        this.send(data(frame(this.c, { tool_calls: piece.calls.map(toolCallJson) }, null)), now);
        return;
      case "finish":
        this.done = true;
        this.send(data(frame(this.c, {}, piece.finish)), now);
        if (piece.usage !== undefined) this.send(data({ id: this.c.id, object: "chat.completion.chunk", created: this.c.created, model: this.c.model, choices: [], usage: piece.usage }), now);
        this.send(DONE, now);
        return;
      case "error":
        this.fail(piece.message, piece.code, now);
        return;
    }
  }

  /** Ends the stream with an error chunk Lumiverse shows in the chat. */
  fail(message: string, code: string, now: number): void {
    if (this.done) return;
    this.done = true;
    this.send(data(errorJson(message, code)), now);
  }

  /**
   * Called every second or so: a comment once nothing was written for `commentMs`, and, while the
   * work behind the answer is reachable (`alive`), a progress line once no token went out for
   * `progressMs`, restating the latest one with how long it has run.
   */
  keepAlive(now: number, alive: boolean, k: KeepAlive): void {
    if (this.done) return;
    if (alive && now - this.lastToken >= k.progressMs) {
      const p = this.progress;
      this.line(p === null ? `Still working (${minutes(now - this.lastToken)} min)` : `${p.text} (${minutes(now - p.at)} min)`, now);
      return;
    }
    if (now - this.lastWrite >= k.commentMs) this.send(": keep-alive\n\n", now);
  }
}

/** HTTP statuses for a refused request, by the extension's error code (the link's `LinkErrorCode`) or the runtime's own. */
export function statusOf(code: string): number {
  switch (code) {
    case "bad_request":
    case "invalid_request":
      return 400;
    case "invalid_api_key":
      return 401;
    case "forbidden":
      return 403;
    case "not_found":
      return 404;
    case "too_large":
      return 413;
    case "rate_limited":
      return 429;
    case "conflict":
      return 409;
    case "unavailable":
    case "unreachable":
    case "closed":
    case "lost":
    case "revoked":
    case "version":
    // The connection's own problems (connection.ts `LiveProblem`): the runtime can't serve until they're fixed.
    case "login":
    case "locked":
    case "insecure":
    case "not_installed":
    case "not_running":
    case "too_old":
    case "protocol":
      return 503;
    case "timeout":
    case "stalled":
      return 504;
    default:
      return 500;
  }
}

/** One answer as one chat completion, for a request with `stream` off: kept until its finish or error. */
export class JsonAnswer implements Answer {
  private content = "";
  private reasoningText = "";
  private readonly tools = new Map<number, { id: string; name: string; arguments: string }>();
  private result: { status: number; body: JsonObject } | null = null;

  constructor(private readonly c: Completion) {}

  get ended(): boolean {
    return this.result !== null;
  }

  /** The answer once it ended; null before. */
  get answer(): { status: number; body: JsonObject } | null {
    return this.result;
  }

  piece(piece: ReplyPiece): void {
    if (this.result !== null) return;
    switch (piece.kind) {
      case "reasoning":
        this.reasoningText += piece.text;
        return;
      case "progress": {
        const text = oneLine(piece.text);
        if (text !== "") this.reasoningText += `${this.reasoningText === "" || this.reasoningText.endsWith("\n") ? "" : "\n"}${text}\n`;
        return;
      }
      case "content":
        this.content += piece.text;
        return;
      case "tool_calls":
        for (const t of piece.calls) {
          const held = this.tools.get(t.index) ?? { id: "", name: "", arguments: "" };
          if (t.id !== undefined && held.id === "") held.id = t.id;
          held.name += t.name ?? "";
          held.arguments += t.arguments ?? "";
          this.tools.set(t.index, held);
        }
        return;
      case "finish": {
        const toolCalls = [...this.tools.entries()].sort(([a], [b]) => a - b).map(([, t]) => ({ id: t.id, type: "function", function: { name: t.name, arguments: t.arguments } }));
        const message: JsonObject = { role: "assistant", content: this.content === "" && toolCalls.length > 0 ? null : this.content };
        if (this.reasoningText !== "") message.reasoning = this.reasoningText;
        if (toolCalls.length > 0) message.tool_calls = toolCalls;
        this.result = {
          status: 200,
          body: { id: this.c.id, object: "chat.completion", created: this.c.created, model: this.c.model, choices: [{ index: 0, message, finish_reason: piece.finish }], ...(piece.usage !== undefined ? { usage: piece.usage } : {}) },
        };
        return;
      }
      case "error":
        this.fail(piece.message, piece.code);
        return;
    }
  }

  fail(message: string, code: string): void {
    if (this.result !== null) return;
    this.result = { status: statusOf(code), body: errorJson(message, code) };
  }
}
