// The provider session (DESIGN §4.1): how an agent's call reaches a model through the host's `models`
// port, and what comes back.
//
// Tool turns are native: an assistant turn goes back as its text and `tool_use` parts, the results as
// `tool_result` parts, which the host maps to each provider's own. For a connection's model that
// refuses tools, and for an agent set to have its tools as text, the older convention stays: the
// tools are offered as text, the results go back in a plain user message (`TEXT_TURNS`), and the
// calls the model writes are recovered from its text, as they are from any model that writes a call
// instead of making it, until its connection has made one natively in that agent's session: after
// that a call block in its text is something it quotes, not a call. Both are one interface
// (`ToolTurnEncoding`), so the loop never asks which it has.
//
// A tool's name in the registry may be one no provider takes natively (an MCP server's tool is
// `mcp:<server>:<tool>`, DESIGN §16). A call's native tools, and the tool calls in the messages it
// sends, go out under names a provider takes (`wireNames`), and a call that comes back is read back
// to its tool's own name: the request sent is the only place the names on the wire stand.
//
// Here too: the effort a call goes with, a prompt's order, the agent session its calls share the
// provider's prompt cache by and how long the provider keeps it, whether a call streams, and the
// accounts kept per connection: its throttles, its calls under way at once, and which of its models
// were seen refusing native tools, and when. Every call reserves against its connection before it is
// sent.

import type { AgentStopCode, CacheRetention, CallUsage, ConnectionProfile, HarnessHost, JsonObject, ModelDelta, ModelEffort, ModelMessage, ModelPart, ModelRequest, ModelResult, ModelThinkingBlock, ModelTool, SamplingParams } from "./ports";
import { isRecord } from "./ports";
import type { ConnectionThrottle, Settings, ToolCalls } from "./settings";
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
 * undici's "terminated" and "other side closed"; "fetch failed"); and an answer that arrived cut
 * or garbled, as the platform's JSON parser says it (Bun's "JSON Parse error: …", V8's "… is not
 * valid JSON"): the same call made again usually arrives whole. Only an error that says so is made
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
  /\bJSON Parse error\b|\bis not valid JSON\b|\bin JSON at position\b/i,
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

/**
 * How a failure reads that lies in what the call runs on, so that the same work run again meets it
 * again until the user changes that: a key its provider refused (401 and 403 where the error leads
 * with them or names them as a status, an invalid or missing key, a permission denied), and a model
 * it doesn't have (404 so named, a model not found or that doesn't exist). With `LASTING`'s account
 * out of quota or credit. Not settings, as `TRANSIENT` isn't: a new provider's words are a fix here.
 */
const REFUSED: readonly RegExp[] = [
  /(?:^\s*|\b(?:status(?: code)?|http(?:\/[\d.]+)?|error|code)[\s:=#(]*)(?:401|403|404)\b/i,
  /\b(?:unauthori[sz]ed|forbidden|permission[ _-]denied|access[ _-]denied|authentication (?:failed|error|required))\b/i,
  /\b(?:invalid|incorrect|missing|expired|revoked)[ _-](?:x-)?(?:api[ _-]?)?key\b/i,
  /\bapi[ _-]?key\b[^.\n]{0,30}\b(?:invalid|incorrect|missing|not valid|expired|revoked)\b/i,
  /\b(?:model[ _]not[ _]found|no such model|unknown model|invalid model)\b/i,
  /\bmodel\b[^.\n]{0,80}\b(?:not found|does(?: not|n't) exist|is not available|isn't available)\b/i,
];

/**
 * Whether a failed call's error lasts (`REFUSED`, `LASTING`), in its message or its cause's: it lies
 * in the key, the model or the account the call runs on, so running the work again fails the same
 * way until the user changes that.
 */
export function isLasting(error: unknown): boolean {
  const texts = [errorText(error), error instanceof Error && error.cause !== undefined ? errorText(error.cause) : ""];
  return texts.some((text) => LASTING.some((pattern) => pattern.test(text)) || REFUSED.some((pattern) => pattern.test(text)));
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

/** A native assistant turn as text, for logs and estimates: what it said, then each call as its tool and arguments, a line each. */
function turnText(parts: readonly ModelPart[]): string {
  return parts.flatMap((p) => (p.type === "text" ? [p.text] : p.type === "tool_use" ? [`${p.name} ${JSON.stringify(p.input)}`] : [])).join("\n");
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
      content: turnText(parts),
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

// ---------------------------------------------------------------- tool names on the wire

/**
 * A native tool's name as a provider takes it: letters, digits, `_` and `-`, one to 64 of them. It
 * is OpenAI's rule and Anthropic's, and a call that offers or carries one name outside it fails
 * whole, while a name in the registry may be anything: an MCP server's tool is
 * `mcp:<server>:<tool>` (DESIGN §16), and an extension names its tools as it likes. Not settings:
 * the rule is the providers', not a limit of LumiAH's, and a provider that changes it is a fix here.
 */
const WIRE_NAME = /^[A-Za-z0-9_-]{1,64}$/;
const WIRE_NAME_LENGTH = 64;
/** One character a provider refuses in a tool's name, read whole: a character outside the basic plane is one, not the two halves it is written in. */
const REFUSED_IN_NAME = /[^A-Za-z0-9_-]/gu;

/** A name made one a provider takes, from the name alone: each character it refuses an underscore, cut at the length it takes, and one underscore for a name of nothing. A name it takes already is itself. */
function wireName(name: string): string {
  if (WIRE_NAME.test(name)) return name;
  return name.replace(REFUSED_IN_NAME, "_").slice(0, WIRE_NAME_LENGTH) || "_";
}

/** An agent's tools by name, both ways. */
interface WireNames {
  /** The name each tool goes by on the wire, by its own. */
  out: ReadonlyMap<string, string>;
  /** The tool a call names, by each name it may come under: the one its tool goes by on the wire, and the tool's own. */
  back: ReadonlyMap<string, string>;
}

/**
 * The names an agent's tools go by on the wire, no two alike. A tool whose name a provider takes
 * keeps it, whatever the other tools are and wherever it stands among them. Each other tool, in the
 * list's order, goes by its name as `wireName` makes it; where that is taken, by a tool's own name
 * or by an earlier tool's (two names that differ only in characters replaced, or past the cut), its
 * last places hold a number instead: `_2`, `_3`, and on. One list of tools in one order always gives
 * the same names, so every call of a session sends the same, and a prompt its provider cached still
 * matches.
 */
function wireNames(tools: readonly ModelTool[]): WireNames {
  const out = new Map<string, string>();
  const back = new Map<string, string>();
  for (const { name } of tools) {
    if (!WIRE_NAME.test(name)) continue;
    out.set(name, name);
    back.set(name, name);
  }
  for (const { name } of tools) {
    if (out.has(name)) continue;
    const fitted = wireName(name);
    let wire = fitted;
    for (let n = 2; back.has(wire); n++) {
      const ending = `_${n}`;
      wire = `${fitted.slice(0, WIRE_NAME_LENGTH - ending.length)}${ending}`;
    }
    out.set(name, wire);
    back.set(wire, name);
    // A model has read the tool's own name wherever the core names its tools (a result, the tools as text), and may call it by that: it is the tool's too.
    back.set(name, name);
  }
  return { out, back };
}

/**
 * A message as it goes out: each tool call in it under the name its tool goes by on the wire (a
 * call of a tool the agent no longer has, under that name as `wireName` makes it), and its text,
 * where that renders its parts (`NATIVE_TURNS`), rendered from them again. A message whose calls
 * keep their names is itself: the conversation the agent keeps is never written to.
 */
function onWire(m: ModelMessage, names: ReadonlyMap<string, string>): ModelMessage {
  if (!m.parts) return m;
  let parts: ModelPart[] | undefined;
  for (const [i, part] of m.parts.entries()) {
    if (part.type !== "tool_use") continue;
    const name = names.get(part.name) ?? wireName(part.name);
    if (name === part.name) continue;
    parts ??= [...m.parts];
    parts[i] = { ...part, name };
  }
  return parts ? { ...m, content: m.content === turnText(m.parts) ? turnText(parts) : m.content, parts } : m;
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
function callsFromJson(value: unknown, names: Pick<ReadonlySet<string>, "has">): WrittenCall[] | null {
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

// A model's answer is read here as it came, and it may be anything: a tag opened and never closed,
// with a page of blank lines after it, is an answer a model has written. A pattern that takes
// "anything up to the closing tag" reads the rest of such an answer once for every way of splitting
// what it has read, and again for every opening tag after it, and nothing else runs meanwhile. So a
// form's blocks are found a tag at a time: an opening tag, then the first closing tag after it by
// `indexOf`, and a form whose opening tag has no closing tag is done with, since no tag after it has
// one either. Every search starts where the one before it ended, and each pattern left reads one tag
// and none of the text between two, so an answer is read in time in line with its length, whatever
// it holds.

/** A block one of the forms encloses: where it stands in the text, the name its opening tag carries (`""` for a form whose tag has none), and what stands between its tags. */
interface Block {
  start: number;
  end: number;
  name: string;
  body: string;
}

/** An opening tag: where its block starts, where the block's body starts, and the name it carries. */
interface OpeningTag {
  at: number;
  body: number;
  name: string;
}

/** A form's opening tags in one text: the first at or after `from`, or null when the text has no more. Asked from places that only move forward. */
type OpeningTags = (from: number) => OpeningTag | null;

/** A form calls are written in: how its blocks open, and the tags that close them. */
interface Form {
  open: (text: string) => OpeningTags;
  close: readonly string[];
}

/**
 * Where the first of `tags` next stands in `text`, for searches that only move forward. Each tag's
 * last find answers every search before it, and a tag the text has no more of is never looked for
 * again, so all the searches for one tag read the text once between them.
 */
function seeker(text: string, tags: readonly string[]): (from: number) => { at: number; end: number } | null {
  const next = tags.map((tag) => text.indexOf(tag));
  return (from) => {
    let first: { at: number; end: number } | null = null;
    for (const [i, tag] of tags.entries()) {
      let at = next[i] ?? -1;
      if (at >= 0 && at < from) next[i] = at = text.indexOf(tag, from);
      if (at >= 0 && (first === null || at < first.at)) first = { at, end: at + tag.length };
    }
    return first;
  };
}

/**
 * Opening tags that start with one of `tags` and go on as `head` reads (a sticky pattern: the rest
 * of the tag, its first group the name the tag carries); with no `head`, each of `tags` is a whole tag.
 */
function tagged(tags: readonly string[], head?: RegExp): (text: string) => OpeningTags {
  return (text) => {
    const seek = seeker(text, tags);
    return (from) => {
      for (let tag = seek(from); tag; tag = seek(tag.at + 1)) {
        if (!head) return { at: tag.at, body: tag.end, name: "" };
        head.lastIndex = tag.end;
        const rest = head.exec(text);
        if (rest) return { at: tag.at, body: head.lastIndex, name: rest[1] ?? "" };
      }
      return null;
    };
  };
}

/** What ends the name a Llama tag carries: the `>` that closes the tag, or a space, which no name holds. */
const NAME_END = /[>\s]/g;

/** Llama's opening tags: `<function=name>`, the name anything but a space, up to the `>`. */
function llamaTags(text: string): OpeningTags {
  const seek = seeker(text, ["<function="]);
  return (from) => {
    for (let tag = seek(from); tag; ) {
      NAME_END.lastIndex = tag.end;
      const stop = NAME_END.exec(text);
      // No name ends from here on, so no tag does.
      if (!stop) return null;
      if (stop[0] === ">" && stop.index > tag.end) return { at: tag.at, body: stop.index + 1, name: text.slice(tag.end, stop.index) };
      // A tag that starts inside this name would end where it does, on what closes no tag: the search goes on from there.
      tag = seek(stop.index);
    }
    return null;
  };
}

/** The name an XML tag of Claude's carries, and the tag's end. */
const NAME_ATTRIBUTE = /\s+name="([^"]+)"\s*>/y;
/** A DeepSeek call's head: the tool's name, after `function` and a separator (V3) or alone (V3.1), up to a separator or the line's end. */
const DEEPSEEK_NAME = /(?:function<｜tool▁sep｜>)?([^\n<]+?)(?:<｜tool▁sep｜>|\n)/y;
/** The rest of the line a code fence opens on: its language, where it names one. */
const FENCE_LINE = /[A-Za-z_]*[ \t]*\n/y;

/** The namespace a tag of Claude's XML form may carry before its name. */
const NAMESPACE = "antml:";

/** A tag pair of Claude's XML form, each tag written with or without its namespace; `head` reads the rest of an opening tag that carries a name. */
function xml(name: string, head?: RegExp): Form {
  const opens = head ? name : `${name}>`;
  return { open: tagged([`<${opens}`, `<${NAMESPACE}${opens}`], head), close: [`</${name}>`, `</${NAMESPACE}${name}>`] };
}

/** DeepSeek's own call tokens, leaked into text: `function<｜tool▁sep｜>name` and a fenced JSON (V3), or `name<｜tool▁sep｜>JSON` (V3.1). */
const DEEPSEEK_CALL: Form = { open: tagged(["<｜tool▁call▁begin｜>"], DEEPSEEK_NAME), close: ["<｜tool▁call▁end｜>"] };
/** Hermes and Qwen's form, and the one `toolsAsText` asks for. */
const TAGGED_CALL: Form = { open: tagged(["<tool_call>"]), close: ["</tool_call>"] };
/** Claude's XML form: the calls of one answer, each an `invoke` that names its tool and holds a `parameter` per argument. */
const FUNCTION_CALLS = xml("function_calls");
const INVOKE = xml("invoke", NAME_ATTRIBUTE);
const PARAMETER = xml("parameter", NAME_ATTRIBUTE);
/** Llama's `<function=name>{…}</function>`. */
const LLAMA_CALL: Form = { open: llamaTags, close: ["</function>"] };
/** A code fence that holds a call as JSON. */
const FENCED: Form = { open: tagged(["```"], FENCE_LINE), close: ["```"] };
/** What's left of a wrapper once the calls in it are taken out. */
const LEFTOVERS = /<｜tool▁calls▁begin｜>|<｜tool▁calls▁end｜>|<(?:antml:)?function_calls>\s*<\/(?:antml:)?function_calls>/g;

/** Every block of `form` in `text`, in order, none inside another: each is looked for from where the one before it ended. */
function blocksOf(text: string, form: Form): Block[] {
  const open = form.open(text);
  const close = seeker(text, form.close);
  const out: Block[] = [];
  for (let opened = open(0); opened; ) {
    const closed = close(opened.body);
    // No closing tag from here on, so none for any opening tag after this one: the form is done with.
    if (!closed) break;
    out.push({ start: opened.at, end: closed.end, name: opened.name, body: text.slice(opened.body, closed.at) });
    opened = open(closed.end);
  }
  return out;
}

/** Space, read from where a search stands. */
const SPACE = /\s*/y;

/**
 * Mistral's `[TOOL_CALLS]` and the JSON after it: a list or an object, taken to the last bracket of
 * its kind in the text, since a JSON value that holds others ends on its outermost one.
 */
function mistralBlocks(text: string): Block[] {
  const seek = seeker(text, ["[TOOL_CALLS]"]);
  const closes = { "[": text.lastIndexOf("]"), "{": text.lastIndexOf("}") };
  const out: Block[] = [];
  for (let tag = seek(0); tag; ) {
    SPACE.lastIndex = tag.end;
    SPACE.exec(text);
    const at = SPACE.lastIndex;
    const opens = text[at];
    const close = opens === "[" || opens === "{" ? closes[opens] : -1;
    // No value here (no bracket, or one that nothing closes): a later `[TOOL_CALLS]` may still hold one.
    if (close <= at) {
      tag = seek(tag.end);
      continue;
    }
    out.push({ start: tag.at, end: close + 1, name: "", body: text.slice(at, close + 1) });
    tag = seek(close + 1);
  }
  return out;
}

/** What may stand before a DeepSeek call's arguments: space, and the opening of a code fence. */
const FENCE_OPENS = /^\s*(?:```(?:json)?\s*)?/;

/** A DeepSeek call's arguments, without the space and the code fence V3 wraps them in. */
function unfenced(body: string): string {
  const args = body.replace(FENCE_OPENS, "").trimEnd();
  return args.endsWith("```") ? args.slice(0, -3).trimEnd() : args;
}

/**
 * The calls a model wrote as text instead of making them, in the forms models write them, each
 * naming a tool the agent has (`names`: a set of names, or a map by them); and its text without
 * them. A block that names another tool or doesn't parse stays in the text, and a whole answer that
 * is one JSON call counts only when nothing else did.
 */
export function recoverToolCalls(text: string, names: Pick<ReadonlySet<string>, "has">): { calls: WrittenCall[]; rest: string } {
  const calls: WrittenCall[] = [];
  let rest = text;
  // Each form's blocks that read as calls are taken out of the text, in turn; the rest stay.
  const take = (blocks: readonly Block[], read: (block: Block) => WrittenCall[] | null): void => {
    let kept = "";
    let from = 0;
    for (const block of blocks) {
      const found = read(block);
      if (!found) continue;
      calls.push(...found);
      kept += rest.slice(from, block.start);
      from = block.end;
    }
    if (from > 0) rest = kept + rest.slice(from);
  };
  const named = (name: string, args: string): WrittenCall[] | null => {
    const parsed = writtenArgs(args);
    return names.has(name) && parsed ? [{ name, args: parsed }] : null;
  };
  const json = ({ body }: Block): WrittenCall[] | null => callsFromJson(parseJson(body.trim()), names);
  take(blocksOf(rest, DEEPSEEK_CALL), ({ name, body }) => named(name.trim(), unfenced(body)));
  take(blocksOf(rest, TAGGED_CALL), json);
  take(blocksOf(rest, FUNCTION_CALLS), ({ body }) => {
    const invoked = blocksOf(body, INVOKE).map(({ name, body: inner }) => ({ name, args: Object.fromEntries(blocksOf(inner, PARAMETER).map(({ name: key, body: value }) => [key, writtenValue(value)])) as JsonObject }));
    return invoked.length > 0 && invoked.every((c) => names.has(c.name)) ? invoked : null;
  });
  take(blocksOf(rest, LLAMA_CALL), ({ name, body }) => named(name, body.trim()));
  take(mistralBlocks(rest), json);
  take(blocksOf(rest, FENCED), json);
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

/**
 * One call's messages: the opening as one system message, then the conversation. With no opening
 * at all (the writer, whose conversation is Lumiverse's messages as they came) the conversation
 * goes as it is. Every call of an agent starts with the same opening, which the provider keeps in
 * its prompt cache for the agent's session.
 */
export function assemble(opening: Opening, conversation: readonly ModelMessage[]): ModelMessage[] {
  const head = opening.nonce !== null && opening.nonce !== "" ? [opening.nonce] : [];
  const texts = [...head, ...opening.prefix, opening.system, ...(opening.tools ? [opening.tools] : [])].filter((t) => t !== "");
  if (texts.length === 0) return [...conversation];
  return [{ role: "system", content: texts.join("\n\n") }, ...conversation];
}

// ---------------------------------------------------------------- accounts

/** A minute, in milliseconds: the throttles' period, and what a refusal of native tools is kept by. Not a setting: it is the unit those settings are in, as providers state their own limits per minute. */
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

/** What the accounts read of the settings: each connection's throttle, the calls at once of one that sets none, and how long a refusal of native tools is remembered. */
export type AccountSettings = Settings["connections"];

/**
 * The accounts kept with each connection: the throttles' last minute, the calls under way at once,
 * and which of its models were seen refusing native tools, and when. Every call `reserve`s before
 * it is sent and `settle`s after. A throttle waits for its minute to have room, and refuses only a
 * call bigger than its whole minute. Kept in memory: a restart starts every minute afresh, and
 * forgets every refusal.
 */
export class AgentAccounts {
  /** Each connection's requests in the last minute: when, and their tokens. */
  private readonly window = new Map<string, { at: number; tokens: number }[]>();
  /** When each model of a connection was last seen refusing native tools: by the two as one key, which JSON keeps apart whatever they hold. */
  private readonly refusals = new Map<string, number>();
  /** Each connection's calls under way at once. */
  private readonly gates = new Map<string, ConnectionGate>();

  constructor(private readonly host: Pick<HarnessHost, "log" | "clock">) {}

  /**
   * Whether a connection's model was seen refusing native tools, and that still stands. A refusal
   * stands for `toolRefusalMinutes` (null: until the runtime restarts); one that old is dropped, so
   * native tools are tried again: the model behind a name, or the server behind a connection, may
   * have changed since. Another model of the connection is never taken for it.
   */
  refusesTools(connection: string, model: string, settings: Readonly<AccountSettings>): boolean {
    const key = JSON.stringify([connection, model]);
    const at = this.refusals.get(key);
    if (at === undefined) return false;
    if (this.host.clock.now() - at < limitOf(settings.toolRefusalMinutes) * MINUTE_MS) return true;
    this.refusals.delete(key);
    return false;
  }

  /** Remembers, as of now, that a connection's model refused native tools. */
  refuseTools(connection: string, model: string, reason: string): void {
    const key = JSON.stringify([connection, model]);
    // Logged when it is first remembered: a model seen refusing again while that stands only renews it.
    if (!this.refusals.has(key)) this.host.log("info", `model ${model} on connection ${connection} refused native tools (${reason}); agents on it are offered them as text until native tools are tried again`);
    this.refusals.set(key, this.host.clock.now());
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
 * its prompt cache (the agent session its calls belong to, which the provider keeps their shared
 * prompt by, how long it keeps it, and the cache key that heads the prompt), how its tools are
 * offered (absent: `auto`), the sampling parameters it sends, and where a streamed answer's deltas
 * go.
 */
export interface CallSpec {
  connectionId: string | null;
  model: string | null;
  effort: ModelEffort;
  system: string;
  prefix: readonly string[];
  cache: { session: string; retention: CacheRetention; key: string };
  toolCalls?: ToolCalls;
  params?: SamplingParams;
  onDelta?: (delta: ModelDelta) => void;
}

/** One call, assembled and estimated, ready for the budgets to check and then to send. */
export interface PreparedCall {
  messages: ModelMessage[];
  /** The tools offered natively (none when they go as text), each under its name on the wire (`wireNames`). */
  tools: ModelTool[];
  /** The agent's tools by name, natively or as text. */
  names: ReadonlySet<string>;
  /** The tool a call names, by each name it may come under, made or written: the one its tool goes by on the wire, and the tool's own. */
  called: ReadonlyMap<string, string>;
  /** The tools go as text: the agent is set to have them so, or its connection's model refused them natively. */
  textTools: boolean;
  /** The prompt's tokens, as estimated. */
  estimate: number;
  /** The connection's id and the model it answers with. */
  connection: string;
  /** The connection the request names: the agent's own (null: the default), or the default's id where the agent's is gone. */
  connectionId: string | null;
  model: string;
  /** The connection takes several tool calls in one answer. */
  parallel: boolean;
}

/** The exact request of a call, as it goes to the host. */
export function requestOf(spec: CallSpec, p: PreparedCall, maxTokens: number, settings: Readonly<ProviderSettings>): ModelRequest {
  return {
    messages: p.messages,
    maxTokens,
    connectionId: p.connectionId,
    model: spec.model,
    ...(p.tools.length > 0 ? { tools: p.tools } : {}),
    ...(p.tools.length > 0 && !p.parallel ? { parallelToolCalls: false as const } : {}),
    effort: callEffort(spec.effort, p.names.size > 0, settings.loop.thinkingInToolLoops),
    ...(spec.params && Object.keys(spec.params).length > 0 ? { params: spec.params } : {}),
    // Streamed, the provider's connection carries a long answer as it is written, never idle until it is whole.
    ...(settings.loop.stream || spec.onDelta ? { stream: true as const } : {}),
    session: spec.cache.session,
    cacheRetention: spec.cache.retention,
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
 * An agent's calls: its connection read once (one that is gone leaves the agent on the default
 * connection; with neither, the agent stops before any call), each call assembled with its cache
 * key and named by its session, whose prompt the provider keeps cached, sent with its effort, and
 * decoded. How its tools are offered is the spec's (`toolCalls`): natively, and as text once its
 * connection's model refuses them (`ToolsRefused`), which the accounts
 * remember for that model of the connection once a call so made works; always natively, a refusal
 * then being the call's own failure; or as text from the first call. Natively its tools go out under
 * names a provider takes, and its calls come back under their tools' own (`wireNames`).
 *
 * A call a model writes as text where its tools went natively is recovered only until the session
 * has seen the connection make a call natively. From then on its native tools are known to work, so
 * a call block in its text is something it quotes (from the chat, a lore entry, a tool's result),
 * and recovering it would run whatever text reached the model.
 */
export class ProviderSession {
  private profile: ConnectionProfile | undefined;
  /** The connection its requests name: the spec's own, until that turns out to be gone and the default stands in for it. */
  private named: string | null;
  /** The read `connect` started ahead of the first call, which that call takes, whatever it came to: one that failed is asked again by the call after it. */
  private reading: Promise<ConnectionProfile> | null = null;
  private readonly toolCalls: ToolCalls;
  /** The agent's tools go as text: it is set to have them so, or its connection's model refused them natively. */
  textTools: boolean;
  /** Why the connection refused native tools, until a call with them as text has worked. */
  private refusal: string | null = null;
  private written = 0;
  /** The connection has made a tool call natively in this session. */
  private madeNative = false;
  /** How many calls of the host's models this session has made, answered or not: what tells a call that failed on its way to its connection (a throttle refused it, its wait there was ended) from one a provider was sent and may bill. */
  made = 0;

  constructor(
    private readonly deps: ProviderDeps,
    private readonly spec: CallSpec,
  ) {
    this.toolCalls = spec.toolCalls ?? "auto";
    this.textTools = this.toolCalls === "text";
    this.named = spec.connectionId;
  }

  /**
   * Reads the connection ahead of the first call, so the agent's start names the connection its
   * calls go on: the first `prepare` takes this read, a failure included, and asks nothing more.
   */
  connect(): Promise<ConnectionProfile> {
    this.reading ??= this.connection();
    return this.reading;
  }

  /** The connection its spec names where that is none of the host's connections, so the default stands in for it; null otherwise, and before the connection is read. */
  get gone(): string | null {
    return this.profile !== undefined && this.spec.connectionId !== null && this.named !== this.spec.connectionId ? this.spec.connectionId : null;
  }

  /** The connection as the host reads it, once: the agent's own, else, where that is gone, the default; an `AgentStop` when neither can be used. */
  private async connection(): Promise<ConnectionProfile> {
    if (this.profile !== undefined) return this.profile;
    const asked = this.spec.connectionId;
    let profile: ConnectionProfile | null;
    try {
      profile = await this.deps.host.connections.get(asked);
      // One that is gone (taken away, or one of Lumiverse's own from before the runtime kept its connections) leaves the agent on the default, which its page says.
      if (profile === null && asked !== null) {
        profile = await this.deps.host.connections.get(null);
        if (profile !== null) this.named = profile.id;
      }
    } catch (error) {
      throw new AgentStop("connection", { id: TEXT.stop.connectionUnread, vars: { connection: asked ?? "", error: errorText(error) } });
    }
    if (profile === null) throw new AgentStop("connection", asked === null ? { id: TEXT.stop.noDefault } : { id: TEXT.stop.noConnection, vars: { connection: asked } });
    this.profile = profile;
    return profile;
  }

  /** Turns to tools as text after the connection refused them natively: what answers `ToolsRefused`, which only a session free to turn throws. */
  refuseNativeTools(reason: string): void {
    if (this.toolCalls !== "auto") return;
    this.textTools = true;
    this.refusal = reason;
  }

  async prepare(conversation: readonly ModelMessage[], tools: readonly ModelTool[]): Promise<PreparedCall> {
    const { settings, texts, accounts } = this.deps;
    const read = this.reading ?? this.connection();
    this.reading = null;
    const profile = await read;
    const model = this.spec.model ?? profile.model ?? "";
    // A session free to turn starts as text where this model of its connection was seen refusing native tools, for as long as that is remembered.
    if (this.toolCalls === "auto" && !this.textTools && tools.length > 0 && accounts.refusesTools(profile.id, model, settings.connections)) this.textTools = true;
    const wires = wireNames(tools);
    const offered = this.textTools
      ? []
      : tools.map((t): ModelTool => {
          const name = wires.out.get(t.name) ?? t.name;
          return name === t.name ? t : { ...t, name };
        });
    const { key } = this.spec.cache;
    // An agent with no instructions of its own (the writer) sends no cache key: its conversation goes as it came.
    const hasOpening = this.spec.system !== "" || this.spec.prefix.some((text) => text !== "");
    const opening: Opening = { nonce: key === "" || !hasOpening ? null : texts.render(TEXT.runtime.cacheNonce, { nonce: key }), prefix: this.spec.prefix, system: this.spec.system, tools: this.textTools && tools.length > 0 ? toolsAsText(tools, texts) : null };
    const messages = assemble(opening, conversation);
    // A provider reads a call's name by the same rule wherever the call stands, so the calls in the conversation go out under their tools' names on the wire with the tools as text too. `assemble` made this list for this call: a message is replaced in it, and the conversation's own is left as it is.
    for (const [i, m] of messages.entries()) messages[i] = onWire(m, wires.out);
    return { messages, tools: offered, names: new Set(tools.map((t) => t.name)), called: wires.back, textTools: this.textTools && tools.length > 0, estimate: promptTokens(messages, offered, settings.loop.charsPerToken), connection: profile.id, connectionId: this.named, model, parallel: profile.parallelTools };
  }

  /**
   * Sends a prepared call: held on its connection first (`AgentAccounts.reserve`, which may refuse
   * it), then made, decoded and settled. A call with native tools whose provider says it takes no
   * tools (`isToolRefusal`) throws `ToolsRefused` where the session may turn to tools as text; for a
   * session set to native tools that failure is the call's own, as any other is.
   */
  async send(p: PreparedCall, request: ModelRequest, signal: AbortSignal): Promise<ModelReply> {
    const { host, settings, texts, accounts } = this.deps;
    const held = await accounts.reserve({ connection: p.connection, tokensIn: p.estimate, tokensOut: request.maxTokens, settings: settings.connections, texts, signal });
    const t0 = host.clock.now();
    let result: ModelResult;
    try {
      this.made += 1;
      result = await host.models.call(request, signal, this.spec.onDelta);
    } catch (error) {
      accounts.settle(held, null);
      if (!signal.aborted && p.tools.length > 0 && this.toolCalls === "auto" && isToolRefusal(error)) throw new ToolsRefused(error);
      throw error;
    }
    // A call comes back under the name its tool went out by, and the loop is given the tool's own; a name that is no tool's passes as it came, for the loop to answer.
    const native = (result.toolCalls ?? []).map((c): AgentCall => ({ id: c.callId, name: p.called.get(c.name) ?? c.name, args: c.args, ...(c.thoughtSignature !== undefined ? { thoughtSignature: c.thoughtSignature } : {}) }));
    if (native.length > 0) this.madeNative = true;
    // With the tools as text, written calls are how the model calls, and are always read. With them native, only until the connection has made a native call in this session.
    const reads = native.length === 0 && p.names.size > 0 && (p.textTools || !this.madeNative);
    const recovered: { calls: WrittenCall[]; rest: string } = reads ? recoverToolCalls(result.content, p.called) : { calls: [], rest: result.content };
    const calls = native.length > 0 ? native : recovered.calls.map((c): AgentCall => ({ id: `written_${++this.written}`, name: p.called.get(c.name) ?? c.name, args: c.args }));
    const model = result.model ?? p.model;
    const { charsPerToken } = settings.loop;
    const estimate = { in: p.estimate, out: tokensOf(`${result.content}${native.map((c) => `${c.name} ${JSON.stringify(c.args)}`).join("")}`, charsPerToken), reasoningOut: tokensOf(result.reasoning ?? "", charsPerToken) };
    const usage = priced(parseUsage(result.usage, this.profile?.provider ?? null, estimate), result.model === undefined ? [p.model] : [result.model, p.model], settings.prices);
    accounts.settle(held, usage);
    if (this.refusal !== null && p.textTools) {
      accounts.refuseTools(p.connection, p.model, this.refusal);
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
