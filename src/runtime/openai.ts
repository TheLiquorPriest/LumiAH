// An OpenAI-compatible request body, as Lumiverse's Custom connection posts it. A turn reads it into
// the core's own shapes: its messages (tool calls, tool results, images and audio included), its
// sampling parameters and answer room. An untagged request is passed through instead: its messages
// and tools as the runtime's model layer takes them (models/pass.ts), whole or not at all, with
// every other field of the body as it came.

import type { JsonObject, ModelMessage, ModelPart, RequestMessage, SamplingParams } from "../core/ports";
import { TAG_PARAM, contentMark } from "../link/contract";
import type { SourceMark } from "../link/contract";
import { isRecord } from "../link/json";

/** A part's text: a string as it is, a list of parts as its text parts joined. */
export function textOf(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content.map((p) => (isRecord(p) && (p.type === "text" || p.type === "input_text") && typeof p.text === "string" ? p.text : "")).join("");
}

/** A tool call's arguments as an object: OpenAI sends them as JSON text. */
function argsOf(raw: unknown): JsonObject {
  if (isRecord(raw)) return raw as JsonObject;
  if (typeof raw !== "string" || raw.trim() === "") return {};
  try {
    const parsed: unknown = JSON.parse(raw);
    return isRecord(parsed) ? (parsed as JsonObject) : {};
  } catch {
    return {};
  }
}

/** The media a content list carries, as Lumiverse sends it: an image as a `data:` URL, audio as its data and format. A picture named by an address is left out: nothing here downloads. */
function mediaOf(content: unknown): ModelPart[] {
  if (!Array.isArray(content)) return [];
  const out: ModelPart[] = [];
  for (const p of content) {
    if (!isRecord(p)) continue;
    if (p.type === "image_url" && isRecord(p.image_url) && typeof p.image_url.url === "string") {
      const found = /^data:([^;,]+);base64,(.*)$/s.exec(p.image_url.url);
      if (found) out.push({ type: "media", media: "image", mimeType: found[1] ?? "", data: found[2] ?? "" });
    } else if (p.type === "input_audio" && isRecord(p.input_audio) && typeof p.input_audio.data === "string") {
      out.push({ type: "media", media: "audio", mimeType: `audio/${typeof p.input_audio.format === "string" ? p.input_audio.format : "wav"}`, data: p.input_audio.data });
    }
  }
  return out;
}

/**
 * The body's messages as model messages: system (and `developer`) messages as system, an assistant's
 * tool calls as its `tool_use` parts and its reasoning carriers as given, each run of tool results as
 * one user message of `tool_result` parts, and a message's images and audio as its media parts.
 */
export function modelMessages(raw: unknown): ModelMessage[] {
  const out: ModelMessage[] = [];
  for (const m of Array.isArray(raw) ? raw : []) {
    if (!isRecord(m)) continue;
    const text = textOf(m.content);
    if (m.role === "tool") {
      const part: ModelPart = { type: "tool_result", toolUseId: typeof m.tool_call_id === "string" ? m.tool_call_id : "", content: text };
      const last = out.at(-1);
      if (last?.role === "user" && last.parts !== undefined && last.parts.every((p) => p.type === "tool_result")) {
        last.parts.push(part);
        last.content = `${last.content}\n${text}`;
      } else out.push({ role: "user", content: text, parts: [part] });
      continue;
    }
    const media = mediaOf(m.content);
    if (m.role === "assistant") {
      const reasoning = typeof m.reasoning_content === "string" && m.reasoning_content !== "" ? m.reasoning_content : undefined;
      const details = Array.isArray(m.reasoning_details) ? m.reasoning_details.filter(isRecord) : [];
      const calls = Array.isArray(m.tool_calls) ? m.tool_calls.filter(isRecord) : [];
      const uses: ModelPart[] = calls.map((c, i) => {
        const fn = isRecord(c.function) ? c.function : {};
        return { type: "tool_use", id: typeof c.id === "string" ? c.id : `call_${i}`, name: typeof fn.name === "string" ? fn.name : "", input: argsOf(fn.arguments) };
      });
      const parts: ModelPart[] = uses.length > 0 || media.length > 0 ? [...(text !== "" ? [{ type: "text" as const, text }] : []), ...media, ...uses] : [];
      out.push({ role: "assistant", content: text, ...(parts.length > 0 ? { parts } : {}), ...(reasoning !== undefined ? { reasoning } : {}), ...(details.length > 0 ? { reasoningDetails: details as JsonObject[] } : {}) });
      continue;
    }
    const role = m.role === "system" || m.role === "developer" ? "system" : "user";
    out.push({ role, content: text, ...(media.length > 0 ? { parts: [...(text !== "" ? [{ type: "text" as const, text }] : []), ...media] } : {}) });
  }
  return out;
}

const NUMBERS = ["temperature", "top_p", "top_k", "min_p", "frequency_penalty", "presence_penalty", "repetition_penalty", "seed"] as const satisfies readonly (keyof SamplingParams)[];

/** The body's sampling parameters, as the preset set them. */
export function samplingOf(body: JsonObject): SamplingParams {
  const out: SamplingParams = {};
  for (const key of NUMBERS) {
    const v = body[key];
    if (typeof v === "number" && Number.isFinite(v)) out[key] = v;
  }
  const stop = typeof body.stop === "string" ? [body.stop] : Array.isArray(body.stop) ? body.stop.filter((s): s is string => typeof s === "string") : [];
  if (stop.length > 0) out.stop = stop;
  return out;
}

/** The answer room the body asks for; null when it names none. */
export function maxTokensOf(body: JsonObject): number | null {
  const v = body.max_tokens ?? body.max_completion_tokens;
  return typeof v === "number" && Number.isSafeInteger(v) && v > 0 ? v : null;
}

// ---------------------------------------------------------------- a request passed through
//
// A request with no tag goes to the writer's connection, else the runtime's default, through the
// runtime's model layer (models/pass.ts), which takes its messages in the shape below. What that
// shape has a place for is carried; what it has none for refuses the request, here or in the layer
// (which knows the connection's API), in words that name it. Nothing is left out on the way: a part
// dropped would change what the model is told, and neither Lumiverse nor the user would know. A
// cache mark (`cache_control`) is the one thing let go: the provider places its own, and a mark
// changes nothing of what the model is told.

/** Something of a request that can't be carried: its words go back to whoever sent the request. */
class NotCarried extends Error {}

/** The most of an address a refusal quotes. Not a setting: it only keeps one refusal's words short. */
const QUOTED = 80;

/** Whether a field holds nothing: absent, null, or an empty text, list or object. */
function holdsNothing(value: unknown): boolean {
  return value === undefined || value === null || value === "" || (Array.isArray(value) && value.length === 0) || (isRecord(value) && Object.keys(value).length === 0);
}

/** Refuses every field of `record` but those named, unless it holds nothing. */
function onlyFields(record: Record<string, unknown>, fields: readonly string[], what: string): void {
  for (const [field, value] of Object.entries(record)) {
    if (!fields.includes(field) && !holdsNothing(value)) throw new NotCarried(`${what} has the field \`${field}\`, which LumiAH has no way to pass on`);
  }
}

/**
 * Media given as a base64 `data:` URL, which is how the runtime's model calls take it: its type
 * (with whatever parameters the type has) and its data. Media named by an address can't be handed
 * on, since the runtime downloads nothing.
 */
function dataOf(url: unknown, what: string): { mimeType: string; data: string } {
  if (typeof url !== "string" || url === "") throw new NotCarried(`${what} has no data`);
  const found = /^data:([^,]+);base64,(.*)$/s.exec(url);
  if (found) return { mimeType: found[1] ?? "", data: found[2] ?? "" };
  if (url.startsWith("data:")) throw new NotCarried(`${what} is a \`data:\` URL of another form than \`data:<type>;base64,<data>\``);
  throw new NotCarried(`${what} is given by its address (${url.length > QUOTED ? `${url.slice(0, QUOTED)}…` : url}), and the runtime's model calls take media only as its data: send it as a base64 \`data:\` URL (the runtime downloads nothing)`);
}

/** One part of a message's content list. */
function partOf(raw: unknown, what: string): PassedPart {
  if (!isRecord(raw) || typeof raw.type !== "string") throw new NotCarried(`${what} isn't a content part`);
  /** The object a part of this kind keeps its media in, with no field but those named. */
  const held = (field: string, fields: readonly string[]): Record<string, unknown> => {
    onlyFields(raw, ["type", field, "cache_control"], what);
    const inner = raw[field];
    if (!isRecord(inner)) throw new NotCarried(`${what} has no \`${field}\``);
    onlyFields(inner, fields, what);
    return inner;
  };
  switch (raw.type) {
    case "text":
    case "input_text":
      onlyFields(raw, ["type", "text", "cache_control"], what);
      if (typeof raw.text !== "string") throw new NotCarried(`${what} has no text`);
      return { type: "text", text: raw.text };
    case "image_url": {
      const image = held("image_url", ["url", "detail"]);
      // `auto` is what a provider does when nothing is said.
      if (!holdsNothing(image.detail) && image.detail !== "auto") throw new NotCarried(`${what} asks for its image at \`detail: ${String(image.detail)}\`, which the runtime's model calls have no place for: leave \`detail\` out`);
      return { type: "media", media: "image", ...dataOf(image.url, what) };
    }
    case "video_url":
      return { type: "media", media: "video", ...dataOf(held("video_url", ["url"]).url, what) };
    case "input_audio": {
      const audio = held("input_audio", ["data", "format"]);
      if (typeof audio.data !== "string" || audio.data === "" || typeof audio.format !== "string" || audio.format === "") throw new NotCarried(`${what} is audio without its data or its format`);
      return { type: "media", media: "audio", mimeType: `audio/${audio.format}`, data: audio.data };
    }
    default:
      throw new NotCarried(`${what} is a part of the kind \`${raw.type}\`, which the runtime has no way to pass on`);
  }
}

/** A message's content: text as it came, or its list of parts as parts. */
function contentOf(raw: unknown, what: string): string | PassedPart[] {
  if (raw === undefined || raw === null) return "";
  if (typeof raw === "string") return raw;
  if (!Array.isArray(raw)) throw new NotCarried(`${what}'s content is neither text nor a list of parts`);
  return raw.map((part, i) => partOf(part, `${what}'s part ${i + 1}`));
}

/** One of an assistant message's tool calls (`tool_calls[]`). */
function toolUseOf(raw: unknown, what: string): PassedPart {
  if (!isRecord(raw)) throw new NotCarried(`${what} isn't a tool call`);
  onlyFields(raw, ["id", "type", "function"], what);
  const fn = raw.function;
  if (!(raw.type === undefined || raw.type === "function") || !isRecord(fn)) throw new NotCarried(`${what} isn't a function call, the one kind of tool call the runtime passes on`);
  onlyFields(fn, ["name", "arguments"], what);
  if (typeof raw.id !== "string" || raw.id === "" || typeof fn.name !== "string" || fn.name === "") throw new NotCarried(`${what} has no id, or names no function`);
  // OpenAI writes the arguments as JSON text; a call that gives none takes none.
  let input: unknown = fn.arguments ?? {};
  if (typeof input === "string") {
    try {
      input = input.trim() === "" ? {} : JSON.parse(input);
    } catch {
      input = null;
    }
  }
  if (!isRecord(input)) throw new NotCarried(`${what}'s arguments aren't a JSON object`);
  return { type: "tool_use", id: raw.id, name: fn.name, input: input as JsonObject };
}

const MESSAGE_FIELDS = ["role", "content", "name", "cache_control"];
const ASSISTANT_FIELDS = [...MESSAGE_FIELDS, "prefix", "partial", "tool_calls", "reasoning_content", "reasoning", "reasoning_details"];
const TOOL_FIELDS = [...MESSAGE_FIELDS, "tool_call_id"];

/**
 * The body's messages as the runtime's model layer takes them. `developer` messages are system
 * messages; an assistant's tool calls follow its content as `tool_use` parts; each run of `tool`
 * messages is one user message of `tool_result` parts; `prefix: true` (or `partial: true`) on an
 * assistant message is its mark as a prefix.
 */
function passedMessages(raw: unknown): PassedMessage[] {
  if (!Array.isArray(raw)) throw new NotCarried("it has no list of messages");
  const out: PassedMessage[] = [];
  // The parts of the user message a run of tool results goes into, while the run lasts.
  let results: PassedPart[] | null = null;
  raw.forEach((m: unknown, i) => {
    const what = `message ${i + 1}`;
    if (!isRecord(m)) throw new NotCarried(`${what} isn't a message`);
    const content = contentOf(m.content, what);
    if (m.role === "tool") {
      // A result's `name` repeats its call's, which is sent: nothing is lost with it.
      onlyFields(m, TOOL_FIELDS, what);
      if (typeof m.tool_call_id !== "string" || m.tool_call_id === "") throw new NotCarried(`${what}, a tool's result, names no tool call`);
      if (typeof content !== "string" && content.some((p) => p.type !== "text")) throw new NotCarried(`${what}, a tool's result, holds more than text, and the runtime passes a result on as one text`);
      const part: PassedPart = { type: "tool_result", toolUseId: m.tool_call_id, content: typeof content === "string" ? content : content.map((p) => (p.type === "text" ? p.text : "")).join("") };
      if (results === null) out.push({ role: "user", content: (results = [part]) });
      else results.push(part);
      return;
    }
    results = null;
    const role = m.role === "developer" ? "system" : m.role;
    if (role !== "system" && role !== "user" && role !== "assistant") throw new NotCarried(`${what} has the role \`${String(m.role)}\`, and LumiAH passes on system, developer, user, assistant and tool messages`);
    onlyFields(m, role === "assistant" ? ASSISTANT_FIELDS : MESSAGE_FIELDS, what);
    if (!holdsNothing(m.name) && typeof m.name !== "string") throw new NotCarried(`${what} has a name that isn't text`);
    const message: PassedMessage = { role, content, ...(typeof m.name === "string" && m.name !== "" ? { name: m.name } : {}) };
    if (role === "assistant") {
      if (!holdsNothing(m.tool_calls)) {
        if (!Array.isArray(m.tool_calls)) throw new NotCarried(`${what}'s tool calls aren't a list`);
        const said: PassedPart[] = typeof content !== "string" ? content : content === "" ? [] : [{ type: "text", text: content }];
        message.content = [...said, ...m.tool_calls.map((call, n) => toolUseOf(call, `${what}'s tool call ${n + 1}`))];
      }
      for (const mark of [m.prefix, m.partial]) if (!holdsNothing(mark) && typeof mark !== "boolean") throw new NotCarried(`${what}'s mark as a prefix isn't true or false`);
      if (m.prefix === true || m.partial === true) message.prefix = true;
      // The model's reasoning text goes by either name; two that differ can't both be it.
      const reasoning = [m.reasoning_content, m.reasoning].filter((r) => !holdsNothing(r));
      if (reasoning.some((r) => typeof r !== "string") || (reasoning.length === 2 && reasoning[0] !== reasoning[1])) throw new NotCarried(`${what}'s reasoning isn't one text (\`reasoning_content\`, or \`reasoning\`)`);
      if (typeof reasoning[0] === "string") message.reasoning = reasoning[0];
      if (!holdsNothing(m.reasoning_details)) {
        if (!Array.isArray(m.reasoning_details) || !m.reasoning_details.every(isRecord)) throw new NotCarried(`${what}'s reasoning details aren't a list of objects`);
        message.reasoningDetails = m.reasoning_details as JsonObject[];
      }
    }
    out.push(message);
  });
  return out;
}

/** The body's tools (`[{type: "function", function: {name, description, parameters, strict}}]`) as the runtime's model calls offer them: functions, the one kind they have. */
function passedTools(raw: unknown): PassedTool[] {
  if (holdsNothing(raw)) return [];
  if (!Array.isArray(raw)) throw new NotCarried("its tools aren't a list");
  return raw.map((tool: unknown, i): PassedTool => {
    const what = `tool ${i + 1}`;
    if (!isRecord(tool)) throw new NotCarried(`${what} isn't a tool`);
    onlyFields(tool, ["type", "function"], what);
    const fn = tool.function;
    if (!(tool.type === undefined || tool.type === "function") || !isRecord(fn)) throw new NotCarried(`${what} isn't a function, the one kind of tool the runtime's model calls offer a model`);
    onlyFields(fn, ["name", "description", "parameters", "strict"], what);
    const { name, description, parameters, strict } = fn;
    if (typeof name !== "string" || name === "") throw new NotCarried(`${what} names no function`);
    if ((!holdsNothing(description) && typeof description !== "string") || (!holdsNothing(parameters) && !isRecord(parameters)) || (strict !== undefined && strict !== null && typeof strict !== "boolean")) throw new NotCarried(`${what} isn't a function as OpenAI writes one (a description, its parameters as a JSON Schema, \`strict\` as true or false)`);
    // A function given no parameters takes none, which a schema says as an object without properties.
    return { name, description: typeof description === "string" ? description : "", parameters: isRecord(parameters) ? (parameters as JsonObject) : { type: "object", properties: {} }, ...(typeof strict === "boolean" ? { strict } : {}) };
  });
}

/** The fields of a body that say what to send and how to answer, which a passthrough sets itself: every other field is the request's own and goes on as it came. */
const OWN_FIELDS: Readonly<Record<string, true>> = { messages: true, tools: true, model: true, stream: true, stream_options: true, [TAG_PARAM]: true };

/** Every field of the body a passthrough sends on as given: its sampling, its answer room, its `tool_choice` (only with tools to choose from) and whatever else the preset put there. */
function passedParameters(body: JsonObject): JsonObject {
  const out: JsonObject = {};
  const tools = Array.isArray(body.tools) && body.tools.length > 0;
  for (const [key, value] of Object.entries(body)) {
    if (Object.hasOwn(OWN_FIELDS, key) || (key === "tool_choice" && !tools)) continue;
    out[key] = value;
  }
  return out;
}

/** A part of a passed-through message: text, media as its data (an image, audio or video, base64), a tool call the model made, or a tool's result going back. */
export type PassedPart =
  | { type: "text"; text: string }
  | { type: "media"; media: "image" | "audio" | "video"; data: string; mimeType: string }
  | { type: "tool_use"; id: string; name: string; input: JsonObject }
  | { type: "tool_result"; toolUseId: string; content: string };

/**
 * A message of a request passed through (one with no tag), as read here. Its content is its text as
 * it came, or its parts where the request gave parts, tool calls or tool results. `name` is the
 * participant's name; `prefix` marks an assistant message the model is to continue (`prefix: true`
 * or `partial: true` in the request); `reasoning` and `reasoningDetails` are an assistant turn's
 * reasoning, sent back as the model gave it (`reasoning_content`, `reasoning_details`). What a
 * request holds beyond these, and what of these the connection's API can't take, refuses the
 * request: nothing is dropped.
 */
export interface PassedMessage {
  role: "system" | "user" | "assistant";
  content: string | PassedPart[];
  name?: string;
  prefix?: true;
  reasoning?: string;
  reasoningDetails?: JsonObject[];
}

/** A tool a passed-through request offers: a function, its parameters as a JSON Schema, and `strict` where the request said it. */
export interface PassedTool {
  name: string;
  description: string;
  parameters: JsonObject;
  strict?: boolean;
}

/** An untagged request as the runtime's model layer takes it (`ModelLayer.passing`). */
export interface PassedRequest {
  messages: PassedMessage[];
  tools: PassedTool[];
  parameters: JsonObject;
}

/** The words a request passed through is refused in, `what` saying what of it can't be carried and what to do. */
export function notPassedWords(what: string): string {
  return `LumiAH didn't pass this request on: ${what}. A request that is no reply of a chat's goes to the writer's connection whole or not at all, so that nothing of a prompt is dropped on the way.`;
}

/**
 * An untagged request's body as it is passed on: its messages and its tools whole, and its other
 * fields as the call's parameters. Where something in it can't be carried, `refused` says what, for
 * the answer to whoever sent the request, which then goes nowhere.
 */
export function passedRequest(body: JsonObject): PassedRequest | { refused: string } {
  try {
    return { messages: passedMessages(body.messages), tools: passedTools(body.tools), parameters: passedParameters(body) };
  } catch (error) {
    if (!(error instanceof NotCarried)) throw error;
    return { refused: notPassedWords(error.message) };
  }
}

/** How far ahead the next source is looked for when a message of the body matches none: a few of the prompt's history messages may have been merged or dropped on the way. Not a setting: it only bounds a search that has no effect on what is sent. */
const LOOKAHEAD = 64;

/**
 * The body's messages with where each came from, where the extension could tell (`TurnFacts.sources`,
 * in the prompt's order): each message of the body takes the next source whose mark is its own.
 * Lumiverse may merge or drop messages after the interceptor ran; one that changed matches nothing
 * and carries no source.
 */
export function withSources(messages: readonly ModelMessage[], sources: readonly SourceMark[]): RequestMessage[] {
  let next = 0;
  return messages.map((m): RequestMessage => {
    if (next >= sources.length) return m;
    const mark = contentMark(m.role, m.content);
    for (let i = next; i < Math.min(sources.length, next + LOOKAHEAD); i++) {
      const candidate = sources[i];
      if (candidate !== undefined && candidate.mark === mark) {
        next = i + 1;
        return { ...m, source: candidate.source };
      }
    }
    return m;
  });
}
