// The provider session (DESIGN §4.1): how an agent's call reaches a model through the host's `models`
// port, and what comes back.
//
// Tool turns are native: an assistant turn goes back as its text and `tool_use` parts, the results as
// `tool_result` parts, which Lumiverse maps to each provider's own. For a connection that refuses
// tools, the older convention stays: the tools are offered as text, the results go back in a plain
// user message (`TEXT_TURNS`), and the calls the model writes are recovered from its text, as they
// are from any model that writes a call instead of making it. Both are one interface
// (`ToolTurnEncoding`), so the loop never asks which it has.
//
// Here too: the effort a call goes with, a prompt's order and its cache breakpoints (within the
// provider's limit, the connection's own counted), the usage request, whether a call streams, and the
// accounts kept per connection: its throttles, its calls under way at once, and whether it was seen
// refusing native tools. Every call reserves against its connection before it is sent.

import type { AgentStopCode, CallUsage, ConnectionProfile, HarnessHost, JsonObject, ModelDelta, ModelEffort, ModelMessage, ModelPart, ModelRequest, ModelResult, ModelThinkingBlock, ModelTool, SamplingParams } from "./ports";
import { isRecord } from "./ports";
import type { ConnectionThrottle, Settings } from "./settings";
import { renderDefault, TEXT, type Texts } from "./texts";
import { parseUsage, priced, promptTokens } from "./usage";
import { errorText, hasOwn, limitOf, parseJson, tokensOf } from "./util";

// ---------------------------------------------------------------- stops

/**
 * A budget, a throttle, a connection that can't be used, the loop detector or a cancel stopping an
 * agent, with its code and its words: a text id and what fills it, which the loop renders with the
 * user's texts; its message is the shipped wording, for logs.
 */
export class AgentStop extends Error {
  constructor(
    readonly code: AgentStopCode,
    readonly text: { id: string; vars?: Readonly<Record<string, string>> },
  ) {
    super(renderDefault(text.id, text.vars ?? {}));
    this.name = "AgentStop";
  }
}

/** A connection refused a call that offered tools natively: the agent asks again with them as text. */
export class ToolsRefused extends Error {
  constructor(cause: unknown) {
    super(`the connection refused native tools (${errorText(cause)})`, { cause });
    this.name = "ToolsRefused";
  }
}

/**
 * How providers say a model or endpoint takes no tools: OpenAI-compatible servers ("does not support
 * tools", "function calling is not supported", "tools unsupported", "Unsupported parameter: 'tools'",
 * "Unrecognized request argument supplied: tools"), OpenRouter's routing ("No endpoints found that
 * support tool use"), vLLM's (`"auto" tool choice requires --enable-auto-tool-choice`), llama.cpp's
 * ("tools param requires --jinja flag") and Gemini's ("Function calling is not enabled"). Only an
 * error that says so turns a connection's tools to text: any other failure is the call's own. Not
 * settings: they are the providers' own words, and a new one is a fix here.
 */
const TOOL_REFUSALS: readonly RegExp[] = [
  /\b(?:does|do)(?: not|n't) support (?:native )?(?:tools?|tool[ _-]?(?:use|calls?|calling)|function[ _-]?(?:calls?|calling)|functions)\b/i,
  /\b(?:tools?|tool[ _-]?(?:use|calls?|calling)|function[ _-]?(?:calls?|calling))\b[^.\n]{0,40}\b(?:is|are) not (?:supported|enabled|available)\b/i,
  /\b(?:tools?|tool[ _-]?(?:use|calls?|calling)|function[ _-]?(?:calls?|calling))(?: are| is)? unsupported\b/i,
  /\bno endpoints found that support tool use\b/i,
  /\bunsupported (?:parameter|argument|field)\b[^.\n]{0,8}\btools?\b/i,
  /\bunrecognized request arguments? supplied\b[^.\n]{0,8}\btools?\b/i,
  /--enable-auto-tool-choice\b/i,
  /\btools? param(?:eter)? requires --jinja\b/i,
  /\bfunction calling is not enabled\b/i,
];

/** Whether a failed call's error is its provider refusing native tools (`TOOL_REFUSALS`), in its message or its cause's. */
export function isToolRefusal(error: unknown): boolean {
  const texts = [errorText(error), error instanceof Error && error.cause !== undefined ? errorText(error.cause) : ""];
  return texts.some((text) => TOOL_REFUSALS.some((pattern) => pattern.test(text)));
}

/**
 * How a failure that would fail the same way again reads, though its status or its words read like
 * one that passes: an account out of quota or credit answers 429 as a rate limit does. Read first.
 */
const LASTING: readonly RegExp[] = [/\binsufficient[ _]quota\b/i, /\bcurrent quota\b/i, /\b(?:billing|payment required|credit balance)\b/i];

/**
 * How a failure that passes reads, in the words of whoever reports it: an HTTP status that says try
 * again (408, 425, 429 and the 500s) where the error leads with it or names it as a status; a
 * timeout; a rate limit or an overloaded provider; a gateway's or a server's own failure; and a
 * connection or a stream that dropped (Node's socket codes and Bun's, which Lumiverse runs on:
 * "The socket connection was closed unexpectedly", "Unable to connect", `ConnectionRefused`;
 * undici's "terminated" and "other side closed"; "fetch failed"). Only an error that says so is made
 * again: any other failure is the call's own. Not settings: they are the providers' and the
 * platform's own words, and a new one is a fix here.
 */
const TRANSIENT: readonly RegExp[] = [
  /(?:^\s*|\b(?:status(?: code)?|http(?:\/[\d.]+)?|error|code)[\s:=#(]*)(?:408|425|429|5\d\d)\b/i,
  /\b(?:timed[ -]?out|time[ -]?out|deadline exceeded)\b/i,
  /\b(?:rate[ _-]?limit|too many requests|overloaded|(?:at|over) capacity|resource[ _]exhausted)/i,
  /\b(?:temporarily unavailable|service unavailable|bad gateway|gateway time-?out|internal server error|server (?:error|is busy)|try again later)\b/i,
  /\b(?:ECONNRESET|ECONNREFUSED|ECONNABORTED|ETIMEDOUT|EPIPE|EAI_AGAIN|ENETUNREACH|EHOSTUNREACH|UND_ERR_[A-Z_]+|Connection(?:Refused|Closed|Reset)|FailedToOpenSocket)\b/,
  /\b(?:socket hang up|network error|connection error|fetch failed|unable to connect|other side closed|premature close|unexpected end of (?:stream|data|file|json input))\b/i,
  /\b(?:socket|connection)\b[^.\n]{0,30}\b(?:reset|closed|lost|refused|terminated|dropped)\b/i,
  /^\s*terminated\s*$/i,
  /\bstream\b[^.\n]{0,40}\b(?:cut|dropped|ended|closed|interrupted|reset|lost|terminated|broke|broken)\b/i,
];

/**
 * Whether a failed call's error is one that passes (`TRANSIENT`, and not `LASTING`), in its message
 * or its cause's. A call its own signal ended (a cancel, one of the user's time limits) never comes
 * here: the loop reads the signal first.
 */
export function isTransient(error: unknown): boolean {
  const texts = [errorText(error), error instanceof Error && error.cause !== undefined ? errorText(error.cause) : ""];
  return !texts.some((text) => LASTING.some((pattern) => pattern.test(text))) && texts.some((text) => TRANSIENT.some((pattern) => pattern.test(text)));
}

// ---------------------------------------------------------------- effort

/**
 * The effort one call goes with: while "Thinking in tool loops" is off, a call that offers tools,
 * natively or as text, goes with reasoning off, for a connection that can't carry a reasoning
 * model's thinking back after a tool call.
 */
function callEffort(effort: ModelEffort, offersTools: boolean, thinkingInToolLoops: boolean): ModelEffort {
  return offersTools && !thinkingInToolLoops ? "off" : effort;
}

// ---------------------------------------------------------------- tool turns

/** A tool call: its id (the provider's, or one the runtime gave a written call), its tool and arguments. */
export interface AgentCall {
  id: string;
  name: string;
  args: JsonObject;
  /** Google's opaque signature, sent back with the call. */
  thoughtSignature?: string;
}

/** A call's result as it goes back to the model: its text, and whether it is a failure. */
export interface ToolResult {
  call: AgentCall;
  text: string;
  error: boolean;
}

/** A model's answer as the next call sends it back: what it said, as written and without the calls recovered from it, the calls, and its reasoning carriers. */
export interface ModelTurn {
  text: string;
  raw: string;
  calls: readonly AgentCall[];
  reasoning?: string;
  thinkingBlocks?: ModelThinkingBlock[];
  reasoningDetails?: JsonObject[];
}

/** How a round of tool calls goes back to the model: the assistant's turn, then the results. */
export interface ToolTurnEncoding {
  readonly kind: "native" | "text";
  assistant(turn: ModelTurn): ModelMessage;
  results(results: readonly ToolResult[], texts: Texts): ModelMessage;
}

/**
 * Native tool turns: the assistant's text and `tool_use` parts, with its reasoning carriers (a
 * thinking model must be sent them again after a tool call), then a `tool_result` part per call.
 * Each message's `content` renders it as text for logs and estimates.
 */
export const NATIVE_TURNS: ToolTurnEncoding = {
  kind: "native",
  assistant(turn) {
    const parts: ModelPart[] = turn.text === "" ? [] : [{ type: "text", text: turn.text }];
    for (const c of turn.calls) parts.push({ type: "tool_use", id: c.id, name: c.name, input: c.args, ...(c.thoughtSignature !== undefined ? { thoughtSignature: c.thoughtSignature } : {}) });
    return {
      role: "assistant",
      content: [turn.text, ...turn.calls.map((c) => `${c.name} ${JSON.stringify(c.args)}`)].filter((s) => s !== "").join("\n"),
      parts,
      ...(turn.reasoning ? { reasoning: turn.reasoning } : {}),
      ...(turn.thinkingBlocks ? { thinkingBlocks: turn.thinkingBlocks } : {}),
      ...(turn.reasoningDetails ? { reasoningDetails: turn.reasoningDetails } : {}),
    };
  },
  results(results) {
    return { role: "user", content: results.map((r) => r.text).join("\n\n"), parts: results.map((r): ModelPart => ({ type: "tool_result", toolUseId: r.call.id, content: r.text, ...(r.error ? { isError: true as const } : {}) })) };
  },
};

/** Tool turns as text: the assistant's text as written, calls and all, then one user message with every result, in the editable wording. */
export const TEXT_TURNS: ToolTurnEncoding = {
  kind: "text",
  assistant: (turn) => ({ role: "assistant", content: turn.raw }),
  results(results, texts) {
    const each = results.map((r) => (r.error ? texts.render(TEXT.runtime.toolError, { name: r.call.name, error: r.text }) : texts.render(TEXT.runtime.toolResult, { name: r.call.name, result: r.text })));
    return { role: "user", content: texts.render(TEXT.runtime.toolResults, { results: each.join("\n\n") }) };
  },
};

/** Tools offered as text, for a connection that refuses them natively: how to call one, then each tool. */
function toolsAsText(tools: readonly ModelTool[], texts: Texts): string {
  const each = tools.map((t) => texts.render(TEXT.runtime.toolInText, { name: t.name, description: t.description, parameters: JSON.stringify(t.parameters) }));
  return texts.render(TEXT.runtime.toolsInText, { tools: each.join("\n\n") });
}

// ---------------------------------------------------------------- calls written as text

/** A call a model wrote as text instead of making it. */
export interface WrittenCall {
  name: string;
  args: JsonObject;
}

/** A written call's arguments as an object: an object, JSON text of one, or nothing for none; null when they're neither. */
function writtenArgs(v: unknown): JsonObject | null {
  if (v === undefined || v === null) return {};
  const parsed = typeof v === "string" ? parseJson(v) : v;
  return isRecord(parsed) ? (parsed as JsonObject) : null;
}

/**
 * A JSON value as written calls: one call or a list of them, each naming a tool the agent has, its
 * arguments under any of the names models use; null when it isn't that (a tool's description is no
 * call, so an object that has one isn't read as one).
 */
function callsFromJson(value: unknown, names: ReadonlySet<string>): WrittenCall[] | null {
  const list = Array.isArray(value) ? value : [value];
  if (list.length === 0) return null;
  const out: WrittenCall[] = [];
  for (const item of list) {
    if (!isRecord(item) || item.description !== undefined) return null;
    const fn = isRecord(item.function) ? item.function : null;
    const named = [item.name, item.tool, item.tool_name, item.function, fn?.name].find((n): n is string => typeof n === "string");
    if (named === undefined || !names.has(named)) return null;
    const args = writtenArgs(item.arguments ?? item.args ?? item.parameters ?? item.input ?? fn?.arguments);
    if (args === null) return null;
    out.push({ name: named, args });
  }
  return out;
}

/** A written argument's value: JSON where it parses (a number, a list), else its text. */
function writtenValue(text: string): JsonObject[string] {
  const trimmed = text.trim();
  const parsed = parseJson(trimmed);
  return parsed === undefined ? trimmed : (parsed as JsonObject[string]);
}

/** DeepSeek's own call tokens, leaked into text: `function<｜tool▁sep｜>name` and a fenced JSON (V3), or `name<｜tool▁sep｜>JSON` (V3.1). */
const DEEPSEEK_CALL = /<｜tool▁call▁begin｜>(?:function<｜tool▁sep｜>)?([^\n<]+?)(?:<｜tool▁sep｜>|\n)\s*(?:```(?:json)?\s*)?([\s\S]*?)\s*(?:```\s*)?<｜tool▁call▁end｜>/g;
/** Hermes and Qwen's form, and the one `toolsAsText` asks for. */
const TAGGED_CALL = /<tool_call>\s*([\s\S]*?)\s*<\/tool_call>/g;
/** Claude's XML form, with or without its namespace. */
const FUNCTION_CALLS = /<(?:antml:)?function_calls>([\s\S]*?)<\/(?:antml:)?function_calls>/g;
const INVOKE = /<(?:antml:)?invoke\s+name="([^"]+)"\s*>([\s\S]*?)<\/(?:antml:)?invoke>/g;
const PARAMETER = /<(?:antml:)?parameter\s+name="([^"]+)"\s*>([\s\S]*?)<\/(?:antml:)?parameter>/g;
/** Llama's `<function=name>{…}</function>`. */
const LLAMA_CALL = /<function=([^>\s]+)>\s*([\s\S]*?)\s*<\/function>/g;
/** Mistral's `[TOOL_CALLS]` and a JSON list. */
const MISTRAL_CALLS = /\[TOOL_CALLS\]\s*(\[[\s\S]*\]|\{[\s\S]*\})/g;
const FENCED = /```[A-Za-z_]*[ \t]*\n([\s\S]*?)\n?```/g;
/** What's left of a wrapper once the calls in it are taken out. */
const LEFTOVERS = /<｜tool▁calls▁begin｜>|<｜tool▁calls▁end｜>|<(?:antml:)?function_calls>\s*<\/(?:antml:)?function_calls>/g;

/**
 * The calls a model wrote as text instead of making them, in the forms models write them, each
 * naming a tool the agent has; and its text without them. A block that names another tool or doesn't
 * parse stays in the text, and a whole answer that is one JSON call counts only when nothing else did.
 */
export function recoverToolCalls(text: string, names: ReadonlySet<string>): { calls: WrittenCall[]; rest: string } {
  const calls: WrittenCall[] = [];
  let rest = text;
  // Each pattern's blocks that read as calls are taken out of the text, in turn; the rest stay.
  const take = (pattern: RegExp, read: (groups: string[]) => WrittenCall[] | null): void => {
    rest = rest.replace(pattern, (match: string, ...captures: unknown[]) => {
      const found = read(captures.slice(0, -2).map((g) => (typeof g === "string" ? g : "")));
      if (!found) return match;
      calls.push(...found);
      return "";
    });
  };
  const named = (name: string, args: string | undefined): WrittenCall[] | null => {
    const parsed = writtenArgs(args);
    return names.has(name) && parsed ? [{ name, args: parsed }] : null;
  };
  take(DEEPSEEK_CALL, ([name = "", args]) => named(name.trim(), args));
  take(TAGGED_CALL, ([body = ""]) => callsFromJson(parseJson(body.trim()), names));
  take(FUNCTION_CALLS, ([body = ""]) => {
    const invoked = [...body.matchAll(INVOKE)].map(([, name = "", inner = ""]) => ({ name, args: Object.fromEntries([...inner.matchAll(PARAMETER)].map(([, key = "", value = ""]) => [key, writtenValue(value)])) as JsonObject }));
    return invoked.length > 0 && invoked.every((c) => names.has(c.name)) ? invoked : null;
  });
  take(LLAMA_CALL, ([name = "", args]) => named(name, args));
  take(MISTRAL_CALLS, ([body = ""]) => callsFromJson(parseJson(body.trim()), names));
  take(FENCED, ([body = ""]) => callsFromJson(parseJson(body.trim()), names));
  if (calls.length === 0) {
    const whole = callsFromJson(parseJson(rest.trim()), names);
    if (whole) return { calls: whole, rest: "" };
  }
  return { calls, rest: calls.length > 0 ? rest.replace(LEFTOVERS, "").trim() : text };
}

// ---------------------------------------------------------------- a call's prompt

/** The stable start of every call of an agent, in order: the cache key, the shared prefix, the agent's system prompt, and its tools when they go as text. */
export interface Opening {
  nonce: string | null;
  prefix: readonly string[];
  system: string;
  tools: string | null;
}

/** A message with a cache breakpoint after its last part (a text message becomes one text part). */
function marked(m: ModelMessage): ModelMessage {
  const parts: ModelPart[] = m.parts ? [...m.parts] : [{ type: "text", text: m.content }];
  const last = parts.at(-1);
  if (last) parts[parts.length - 1] = { ...last, cache: true };
  return { ...m, parts };
}

/**
 * One call's messages: the opening as the system message, then the conversation. With breakpoints to
 * spend, on a provider that takes them: the first after the opening, which every call of the agent
 * shares; the second after the conversation so far, so each round reads the rounds before it from the
 * cache; the third after the shared prefix, which other agents with the same prefix read too. With
 * none, the opening goes as one plain text, as every provider takes it. With no opening at all (the
 * writer, whose conversation is Lumiverse's messages as they came) the conversation goes as it is.
 */
export function assemble(opening: Opening, conversation: readonly ModelMessage[], breakpoints: number): ModelMessage[] {
  const head = opening.nonce !== null && opening.nonce !== "" ? [opening.nonce] : [];
  const texts = [...head, ...opening.prefix, opening.system, ...(opening.tools ? [opening.tools] : [])].filter((t) => t !== "");
  if (texts.length === 0) return [...conversation];
  const content = texts.join("\n\n");
  if (breakpoints <= 0) return [{ role: "system", content }, ...conversation];
  const parts = texts.map((text): ModelPart => ({ type: "text", text }));
  const lastPrefix = head.length + opening.prefix.filter((t) => t !== "").length - 1;
  parts[parts.length - 1] = { type: "text", text: texts[texts.length - 1] ?? "", cache: true };
  if (breakpoints >= 3 && lastPrefix >= 0 && lastPrefix < parts.length - 1) parts[lastPrefix] = { type: "text", text: texts[lastPrefix] ?? "", cache: true };
  const out: ModelMessage[] = [{ role: "system", content, parts }, ...conversation];
  if (breakpoints >= 2 && conversation.length > 0) out[out.length - 1] = marked(out[out.length - 1] as ModelMessage);
  return out;
}

/**
 * The breakpoints a connection's own prompt caching puts on every request on it: they count against
 * the provider's limit. Its tools' caching marks the last tool alone, so it takes one breakpoint
 * however many tools the call offers, and none with no tools.
 */
export function ownBreakpoints(cache: NonNullable<ConnectionProfile["cache"]>, nativeTools: number): number {
  return (cache.system ? 1 : 0) + (cache.lastMessage ? 1 : 0) + (cache.automatic ? 1 : 0) + (cache.tools && nativeTools > 0 ? 1 : 0);
}

// ---------------------------------------------------------------- accounts

/** A throttle's period. Not a setting: the throttles' settings are per minute, as providers state their own limits. */
const MINUTE_MS = 60_000;

/** What a call holds of its connection's calls at once when the connection has no such limit: nothing to free. */
const NOTHING_HELD = (): void => undefined;

/**
 * A connection's calls under way at once (`ConnectionThrottle.atOnce`): each takes a place, and one
 * past the limit waits in line. A place that frees is handed straight to the first in line, so a
 * call that comes just then never takes it ahead of one that waited; a call whose signal aborts
 * while it waits leaves the line.
 */
class ConnectionGate {
  private running = 0;
  /** The limit as the call that came last read it from Settings. */
  private most = 0;
  private readonly queue: (() => void)[] = [];

  /** A place among the calls under way: at once while there is room under `most` and nobody waits, else when the line reaches this call. Its release frees it, once. */
  async take(most: number, signal: AbortSignal): Promise<() => void> {
    this.most = most;
    // A limit raised since the line formed lets those in it through before this call.
    this.fill();
    if (this.queue.length === 0 && this.running < most) this.running++;
    else await this.wait(signal);
    let held = true;
    return () => {
      if (!held) return;
      held = false;
      this.running--;
      this.fill();
    };
  }

  /** Hands the places that are free to the calls in line, the first to come first: each wakes already holding its place. */
  private fill(): void {
    while (this.queue.length > 0 && this.running < this.most) {
      this.running++;
      this.queue.shift()?.();
    }
  }

  private wait(signal: AbortSignal): Promise<void> {
    signal.throwIfAborted();
    const { promise, resolve, reject } = Promise.withResolvers<void>();
    const wake = (): void => {
      signal.removeEventListener("abort", abort);
      resolve();
    };
    const abort = (): void => {
      const at = this.queue.indexOf(wake);
      if (at >= 0) this.queue.splice(at, 1);
      reject(signal.reason);
    };
    this.queue.push(wake);
    signal.addEventListener("abort", abort, { once: true });
    return promise;
  }
}

/** A call's hold on its connection, from `reserve` until `settle`. */
export interface Reservation {
  connection: string;
  /** Its entry in the connection's last minute, corrected to what it spent once it settles. */
  entry: { at: number; tokens: number };
  /** Frees its place among the connection's calls at once. */
  release: () => void;
}

/** What the accounts read of the settings: each connection's throttle, and the calls at once of one that sets none. */
export type AccountSettings = Settings["connections"];

/**
 * The accounts kept with each connection: the throttles' last minute, the calls under way at once,
 * and connections seen refusing native tools. Every call `reserve`s before it is sent and `settle`s
 * after. A throttle waits for its minute to have room, and refuses only a call bigger than its whole
 * minute. Kept in memory: a restart starts every minute afresh.
 */
export class AgentAccounts {
  /** Each connection's requests in the last minute: when, and their tokens. */
  private readonly window = new Map<string, { at: number; tokens: number }[]>();
  /** Connections seen refusing native tools since the runtime started. */
  private readonly refusing = new Set<string>();
  /** Each connection's calls under way at once. */
  private readonly gates = new Map<string, ConnectionGate>();

  constructor(private readonly host: Pick<HarnessHost, "log" | "clock">) {}

  /** Whether a connection was seen refusing native tools. */
  refusesTools(connection: string): boolean {
    return this.refusing.has(connection);
  }

  refuseTools(connection: string, reason: string): void {
    if (this.refusing.has(connection)) return;
    this.refusing.add(connection);
    this.host.log("info", `connection ${connection} refused native tools (${reason}); its agents are offered them as text from now on`);
  }

  /** Waits until the connection's throttle has room this minute; refuses a call bigger than the whole minute. */
  private async throttle(connection: string, tokens: number, throttle: ConnectionThrottle | undefined, texts: Texts, signal: AbortSignal): Promise<void> {
    if (!throttle) return;
    const requests = limitOf(throttle.requestsPerMinute);
    const perMinute = limitOf(throttle.tokensPerMinute);
    if (tokens > perMinute) throw new AgentStop("throttle", { id: TEXT.stop.throttle, vars: { tokens: texts.counted(tokens, TEXT.word.token), limit: String(perMinute) } });
    for (;;) {
      const now = this.host.clock.now();
      const recent = (this.window.get(connection) ?? []).filter((e) => e.at > now - MINUTE_MS);
      this.window.set(connection, recent);
      const used = recent.reduce((n, e) => n + e.tokens, 0);
      const oldest = recent[0];
      if (!oldest || (recent.length < requests && used + tokens <= perMinute)) return;
      await this.host.clock.sleep(oldest.at + MINUTE_MS - now, signal);
    }
  }

  /**
   * Holds a call's tokens on its connection before it is sent: a place among its calls at once first,
   * so a call waiting for one holds nothing of its minute, then its throttle. Throws an `AgentStop`
   * when it may not go.
   */
  async reserve(input: { connection: string; tokensIn: number; tokensOut: number; settings: Readonly<AccountSettings>; texts: Texts; signal: AbortSignal }): Promise<Reservation> {
    const { connection, settings } = input;
    const throttle = hasOwn(settings.throttles, connection) ? settings.throttles[connection] : undefined;
    const release = await this.atOnce(connection, settings, input.signal);
    try {
      await this.throttle(connection, input.tokensIn + input.tokensOut, throttle, input.texts, input.signal);
    } catch (error) {
      release();
      throw error;
    }
    // Only a throttled connection keeps its minute; settling a call corrects its entry to what it spent.
    const entry = { at: this.host.clock.now(), tokens: input.tokensIn + input.tokensOut };
    if (throttle) this.window.set(connection, [...(this.window.get(connection) ?? []), entry]);
    return { connection, entry, release };
  }

  /**
   * A place among the connection's calls under way at once: its throttle's `atOnce`, else every
   * connection's; past the limit a call waits for one to free, and one whose signal aborts meanwhile
   * throws its reason. Its release frees it. A connection with no limit holds nothing.
   */
  async atOnce(connection: string, settings: Readonly<AccountSettings>, signal: AbortSignal): Promise<() => void> {
    const own = hasOwn(settings.throttles, connection) ? settings.throttles[connection]?.atOnce : undefined;
    const most = limitOf(own ?? settings.atOnce);
    if (most === Number.POSITIVE_INFINITY) return NOTHING_HELD;
    let gate = this.gates.get(connection);
    if (!gate) {
      gate = new ConnectionGate();
      this.gates.set(connection, gate);
    }
    return gate.take(most, signal);
  }

  /** Ends a call's hold with what it spent; one that failed after it was sent reported nothing, so its minute keeps the estimate. */
  settle(r: Reservation, usage: CallUsage | null): void {
    r.release();
    if (usage) r.entry.tokens = usage.in + usage.out;
  }
}

// ---------------------------------------------------------------- one agent's calls

/** What a session reads of the settings: the loop's, the connections' throttles, and the user's prices. */
export type ProviderSettings = Pick<Settings, "loop" | "connections" | "prices">;

/** What a session needs: the host's model calls, connections and clock, the settings, the user's texts, and the accounts. */
export interface ProviderDeps {
  host: Pick<HarnessHost, "models" | "connections" | "clock">;
  settings: Readonly<ProviderSettings>;
  texts: Texts;
  accounts: AgentAccounts;
}

/**
 * What of an agent's spec its calls are made from: its connection, model and effort, its opening,
 * whether it marks cache breakpoints and the cache key it sends, the sampling parameters it sends,
 * and where a streamed answer's deltas go.
 */
export interface CallSpec {
  connectionId: string | null;
  model: string | null;
  effort: ModelEffort;
  system: string;
  prefix: readonly string[];
  cache: { breakpoints: boolean; key: string };
  params?: SamplingParams;
  onDelta?: (delta: ModelDelta) => void;
}

/** One call, assembled and estimated, ready for the budgets to check and then to send. */
export interface PreparedCall {
  messages: ModelMessage[];
  /** The tools offered natively (none when they go as text). */
  tools: ModelTool[];
  /** The agent's tools by name, natively or as text: what a written call may name. */
  names: ReadonlySet<string>;
  /** The tools go as text: the connection refuses them natively. */
  textTools: boolean;
  /** The prompt's tokens, as estimated. */
  estimate: number;
  /** The connection's id and the model it answers with. */
  connection: string;
  model: string;
  /** The connection takes several tool calls in one answer. */
  parallel: boolean;
}

/** The exact request of a call, as it goes to the host. */
export function requestOf(spec: CallSpec, p: PreparedCall, maxTokens: number, settings: Readonly<ProviderSettings>): ModelRequest {
  return {
    messages: p.messages,
    maxTokens,
    connectionId: spec.connectionId,
    model: spec.model,
    ...(p.tools.length > 0 ? { tools: p.tools } : {}),
    ...(p.tools.length > 0 && !p.parallel ? { parallelToolCalls: false as const } : {}),
    effort: callEffort(spec.effort, p.names.size > 0, settings.loop.thinkingInToolLoops),
    // With thinking in tool loops, the model's thinking comes back as text, so the trace shows it.
    ...(settings.loop.thinkingInToolLoops ? { thinkingDisplay: "summarized" as const } : {}),
    ...(spec.params && Object.keys(spec.params).length > 0 ? { params: spec.params } : {}),
    usage: true,
    // Streamed, the provider's connection carries a long answer as it is written, never idle until it is whole.
    ...(settings.loop.stream || spec.onDelta ? { stream: true as const } : {}),
  };
}

/** A model's answer, decoded: what it said, its calls (made, or recovered from its text), its reasoning, and what the call spent. */
export interface ModelReply extends ModelTurn {
  calls: AgentCall[];
  /** The calls were written as text, so their results go back as text. */
  written: boolean;
  usage: CallUsage;
  model: string;
  finishReason: string;
  ms: number;
}

/**
 * An agent's calls: its connection read once (a loopback connection, or one that isn't there, stops
 * the agent before any call), each call assembled with its cache key and breakpoints, sent with its
 * effort and a usage request, and decoded. A connection that refuses native tools turns the session
 * to tools as text (`ToolsRefused`), kept for the connection once a call so made works.
 */
export class ProviderSession {
  private profile: ConnectionProfile | undefined;
  /** The agent's tools go as text: its connection refused them natively. */
  textTools = false;
  /** Why the connection refused native tools, until a call with them as text has worked. */
  private refusal: string | null = null;
  private written = 0;

  constructor(
    private readonly deps: ProviderDeps,
    private readonly spec: CallSpec,
  ) {}

  /** The connection as the host reads it, once; an `AgentStop` when it can't be used. */
  private async connection(): Promise<ConnectionProfile> {
    if (this.profile !== undefined) return this.profile;
    const asked = this.spec.connectionId;
    let profile: ConnectionProfile | null;
    try {
      profile = await this.deps.host.connections.get(asked);
    } catch (error) {
      throw new AgentStop("connection", { id: TEXT.stop.connectionUnread, vars: { connection: asked ?? "", error: errorText(error) } });
    }
    if (profile === null) throw new AgentStop("connection", asked === null ? { id: TEXT.stop.noDefault } : { id: TEXT.stop.noConnection, vars: { connection: asked } });
    // A call on a loopback connection would come back to the runtime as a request of its own.
    if (profile.loopback) throw new AgentStop("connection", { id: TEXT.stop.loopback, vars: { connection: profile.name } });
    this.profile = profile;
    return profile;
  }

  /** Turns to tools as text after the connection refused them natively. */
  refuseNativeTools(reason: string): void {
    this.textTools = true;
    this.refusal = reason;
  }

  async prepare(conversation: readonly ModelMessage[], tools: readonly ModelTool[]): Promise<PreparedCall> {
    const { settings, texts, accounts } = this.deps;
    const profile = await this.connection();
    if (!this.textTools && tools.length > 0 && accounts.refusesTools(profile.id)) this.textTools = true;
    const offered = this.textTools ? [] : [...tools];
    const { cache: own } = this.spec;
    // An agent with no instructions of its own (the writer) sends no cache key: its conversation goes as it came.
    const hasOpening = this.spec.system !== "" || this.spec.prefix.some((text) => text !== "");
    const opening: Opening = { nonce: own.key === "" || !hasOpening ? null : texts.render(TEXT.runtime.cacheNonce, { nonce: own.key }), prefix: this.spec.prefix, system: this.spec.system, tools: this.textTools && tools.length > 0 ? toolsAsText(tools, texts) : null };
    const cache = profile.cache;
    const breakpoints = own.breakpoints && cache ? Math.max(0, cache.limit - ownBreakpoints(cache, offered.length)) : 0;
    // A provider that takes breakpoints reads native tools first: with a third to spend, it goes after
    // the last tool (the tool block alone, which every call offering the same tools reads, whatever its
    // opening) instead of after the shared prefix. A connection that marks its tools itself keeps them.
    const toolMark = offered.length > 0 && cache !== null && !cache.tools && breakpoints >= 3;
    const native = toolMark ? offered.map((t, i): ModelTool => (i === offered.length - 1 ? { ...t, cache: true } : t)) : offered;
    const messages = assemble(opening, conversation, toolMark ? breakpoints - 1 : breakpoints);
    return { messages, tools: native, names: new Set(tools.map((t) => t.name)), textTools: this.textTools && tools.length > 0, estimate: promptTokens(messages, native, settings.loop.charsPerToken), connection: profile.id, model: this.spec.model ?? profile.model ?? "", parallel: profile.parallelTools };
  }

  /**
   * Sends a prepared call: held on its connection first (`AgentAccounts.reserve`, which may refuse
   * it), then made, decoded and settled. A call with native tools whose provider says it takes no
   * tools (`isToolRefusal`) throws `ToolsRefused`; any other failure is the call's own.
   */
  async send(p: PreparedCall, request: ModelRequest, signal: AbortSignal): Promise<ModelReply> {
    const { host, settings, texts, accounts } = this.deps;
    const held = await accounts.reserve({ connection: p.connection, tokensIn: p.estimate, tokensOut: request.maxTokens, settings: settings.connections, texts, signal });
    const t0 = host.clock.now();
    let result: ModelResult;
    try {
      result = await host.models.call(request, signal, this.spec.onDelta);
    } catch (error) {
      accounts.settle(held, null);
      if (!signal.aborted && p.tools.length > 0 && isToolRefusal(error)) throw new ToolsRefused(error);
      throw error;
    }
    const native = (result.toolCalls ?? []).map((c): AgentCall => ({ id: c.callId, name: c.name, args: c.args, ...(c.thoughtSignature !== undefined ? { thoughtSignature: c.thoughtSignature } : {}) }));
    const recovered: { calls: WrittenCall[]; rest: string } = native.length === 0 && p.names.size > 0 ? recoverToolCalls(result.content, p.names) : { calls: [], rest: result.content };
    const calls = native.length > 0 ? native : recovered.calls.map((c): AgentCall => ({ id: `written_${++this.written}`, ...c }));
    const model = result.model ?? p.model;
    const { charsPerToken } = settings.loop;
    const estimate = { in: p.estimate, out: tokensOf(`${result.content}${native.map((c) => `${c.name} ${JSON.stringify(c.args)}`).join("")}`, charsPerToken), reasoningOut: tokensOf(result.reasoning ?? "", charsPerToken) };
    const usage = priced(parseUsage(result.usage, this.profile?.provider ?? null, estimate), model, settings.prices);
    accounts.settle(held, usage);
    if (this.refusal !== null && p.textTools) {
      accounts.refuseTools(p.connection, this.refusal);
      this.refusal = null;
    }
    return {
      text: native.length > 0 ? result.content : recovered.rest,
      raw: result.content,
      calls,
      written: native.length === 0 && calls.length > 0,
      ...(result.reasoning !== undefined ? { reasoning: result.reasoning } : {}),
      ...(result.thinkingBlocks ? { thinkingBlocks: result.thinkingBlocks } : {}),
      ...(result.reasoningDetails ? { reasoningDetails: result.reasoningDetails } : {}),
      usage,
      model,
      finishReason: result.finishReason,
      ms: host.clock.now() - t0,
    };
  }
}
