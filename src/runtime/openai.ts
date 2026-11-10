// An OpenAI-compatible request body, as Lumiverse's Custom connection posts it, read into the core's
// own shapes: its messages (tool calls, tool results, images and audio included), its tools, its
// sampling parameters and answer room. A turn hands these to the core; an untagged request passes
// them through with every other field of the body as it came.

import type { JsonObject, ModelMessage, ModelPart, ModelTool, RequestMessage, SamplingParams } from "../core/ports";
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

/** The body's tools (`[{type: "function", function: {name, description, parameters}}]`) as a model call offers them. */
export function modelTools(raw: unknown): ModelTool[] {
  return (Array.isArray(raw) ? raw : []).flatMap((t): ModelTool[] => {
    if (!isRecord(t)) return [];
    const fn = isRecord(t.function) ? t.function : t;
    if (typeof fn.name !== "string" || fn.name === "") return [];
    return [{ name: fn.name, description: typeof fn.description === "string" ? fn.description : "", parameters: isRecord(fn.parameters) ? (fn.parameters as JsonObject) : { type: "object", properties: {} } }];
  });
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

/** The fields of a body that say what to send and how to answer, which a passthrough sets itself: every other field is the request's own and goes on as it came. */
const OWN_FIELDS: Readonly<Record<string, true>> = { messages: true, tools: true, model: true, stream: true, stream_options: true, [TAG_PARAM]: true };

/** Every field of the body a passthrough sends on as given: its sampling, its answer room, its `tool_choice` (only with tools to choose from) and whatever else the preset put there. */
export function passedParameters(body: JsonObject): JsonObject {
  const out: JsonObject = {};
  const tools = Array.isArray(body.tools) && body.tools.length > 0;
  for (const [key, value] of Object.entries(body)) {
    if (Object.hasOwn(OWN_FIELDS, key) || (key === "tool_choice" && !tools)) continue;
    out[key] = value;
  }
  return out;
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
