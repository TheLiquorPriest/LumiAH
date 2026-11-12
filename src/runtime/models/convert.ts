// A call's messages as pi-ai takes them, and pi-ai's answer as the core takes it back.
//
// Going out: the leading system messages are the system prompt; a later one stays where it stands
// on an API that takes system messages mid-conversation (OpenAI's two, and a model whose catalogue
// says it takes them), and is a user message elsewhere, as Lumiverse's Anthropic provider sent one;
// a tool's result is pi-ai's tool result, named after the call it answers; an image is an image.
// Audio and video have no place in pi-ai's messages, so a call holding either is refused in words
// that say so: dropped, it would change what the model is told and nobody would know.
//
// Coming back, an answer's reasoning rides in the core's carriers so the next call of a tool loop
// sends the assistant's turn back exactly as the model gave it (a thinking model must be shown its
// own signed thinking again): each thinking block in `thinkingBlocks` (its text with its signature,
// or a redacted block's data; for OpenAI that signature is the reasoning item itself, for a
// chat-completions server the field its reasoning came in, or OpenRouter's reasoning details),
// Google's thought signatures on the tool calls, and in `reasoningDetails` one record of the turn:
// the model that wrote it, which pi-ai checks before it sends a signature back (one is good only
// for the model that made it), and the order of its blocks with their text signatures.
//
// A turn written before this build carries Lumiverse's shapes instead, with no record of its model.
// What of them maps to the call's API goes back as that model's own, which is what Lumiverse did:
// Anthropic's signed thinking blocks to an Anthropic call, DeepSeek's reasoning text and
// OpenRouter's reasoning details to a chat-completions call, Google's thought signatures to a
// Gemini call. Anything else is left out, and the turn's text and calls go back as they are.

import type { AssistantMessage, Context, ImageContent, Message, StopReason, TextContent, ThinkingContent, Tool, ToolCall } from "@earendil-works/pi-ai";
import { isRecord } from "../../core/ports";
import type { JsonObject, ModelMessage, ModelPart, ModelResult, ModelThinkingBlock } from "../../core/ports";
import { toJsonObject } from "../../link/json";

/** Something a call holds that has no way to the model: the call is refused with these words. */
export class NotCarried extends Error {
  constructor(message: string) {
    super(message);
    this.name = "NotCarried";
  }
}

/** The model a call goes to, as the conversion needs it: who it is (for the turns it wrote), and whether it takes a system message mid-conversation. */
export interface CallTarget {
  api: string;
  provider: string;
  model: string;
  systemInPlace: boolean;
}

/** A tool a call offers; `strict` where the request said whether its arguments must keep to the schema. */
export interface CallTool {
  name: string;
  description: string;
  parameters: JsonObject;
  strict?: boolean;
}

/** What the record of a turn is known by among the reasoning details. */
const RECORD = "lumiah.pi";

/** A block of a turn, in its order: a thinking block (by its place in `thinkingBlocks`), text of a length (with its signature), or a tool call. */
type RecordBlock = { thinking: number } | { text: number; signature?: string } | { call: string };

interface TurnRecord {
  api: string;
  provider: string;
  model: string;
  blocks: RecordBlock[];
}

const NO_USAGE: AssistantMessage["usage"] = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } };

/** A message's text: its text parts together, or its content when it has no parts. */
function textOf(m: ModelMessage): string {
  return m.parts ? m.parts.flatMap((p) => (p.type === "text" ? [p.text] : [])).join("") : m.content;
}

function recordBlock(raw: unknown): RecordBlock | null {
  if (!isRecord(raw)) return null;
  if (typeof raw.thinking === "number") return { thinking: raw.thinking };
  if (typeof raw.call === "string") return { call: raw.call };
  if (typeof raw.text === "number") return { text: raw.text, ...(typeof raw.signature === "string" ? { signature: raw.signature } : {}) };
  return null;
}

/** The record of a turn among its reasoning details, read; null when it has none this build reads. */
function recordOf(details: readonly JsonObject[] | undefined): TurnRecord | null {
  const raw = details?.find((d) => d.type === RECORD);
  if (raw === undefined || typeof raw.api !== "string" || typeof raw.provider !== "string" || typeof raw.model !== "string" || !Array.isArray(raw.blocks)) return null;
  const blocks = raw.blocks.map(recordBlock);
  return blocks.every((b) => b !== null) ? { api: raw.api, provider: raw.provider, model: raw.model, blocks: blocks as RecordBlock[] } : null;
}

/** A carried thinking block as pi-ai's: a redacted block's data is its signature. */
function thinkingOf(b: ModelThinkingBlock): ThinkingContent {
  if (b.type === "redacted_thinking") return { type: "thinking", thinking: "", thinkingSignature: typeof b.data === "string" ? b.data : "", redacted: true };
  return { type: "thinking", thinking: typeof b.thinking === "string" ? b.thinking : "", ...(typeof b.signature === "string" && b.signature !== "" ? { thinkingSignature: b.signature } : {}) };
}

type ToolUse = Extract<ModelPart, { type: "tool_use" }>;

function callOf(u: ToolUse, keepSignature: boolean): ToolCall {
  return { type: "toolCall", id: u.id, name: u.name, arguments: u.input, ...(keepSignature && u.thoughtSignature !== undefined ? { thoughtSignature: u.thoughtSignature } : {}) };
}

/**
 * A turn's blocks in the order its record gives, the text cut back into its blocks, when the turn
 * is still what the record describes (its text as long, its calls the same, its thinking all
 * there); null when the core changed it, which then goes back thinking first.
 */
function inRecordOrder(record: TurnRecord, text: string, uses: readonly ToolUse[], thinking: readonly ThinkingContent[]): AssistantMessage["content"] | null {
  let length = 0;
  const calls: string[] = [];
  let thoughts = 0;
  for (const b of record.blocks) {
    if ("text" in b) length += b.text;
    else if ("call" in b) calls.push(b.call);
    else if (b.thinking < 0 || b.thinking >= thinking.length) return null;
    else thoughts += 1;
  }
  if (length !== text.length || thoughts !== thinking.length || calls.length !== uses.length || calls.some((id, i) => uses[i]?.id !== id)) return null;
  const content: AssistantMessage["content"] = [];
  let at = 0;
  let call = 0;
  for (const b of record.blocks) {
    if ("text" in b) {
      content.push({ type: "text", text: text.slice(at, at + b.text), ...(b.signature !== undefined ? { textSignature: b.signature } : {}) });
      at += b.text;
    } else if ("call" in b) content.push(callOf(uses[call++] as ToolUse, true));
    else content.push(thinking[b.thinking] as ThinkingContent);
  }
  return content;
}

/** Thinking carried in Lumiverse's shapes that maps to a call on `api`, as that model's own; none for any other API. */
function lumiverseThinking(m: ModelMessage, api: string): ThinkingContent[] {
  if (api === "anthropic-messages") {
    // Only a signed block goes back: Anthropic takes no thinking it didn't sign.
    return (m.thinkingBlocks ?? []).map(thinkingOf).filter((t) => (t.thinkingSignature ?? "") !== "");
  }
  if (api === "openai-completions") {
    const details = (m.reasoningDetails ?? []).filter((d) => d.type !== RECORD);
    if (details.length > 0) return [{ type: "thinking", thinking: m.reasoning ?? "", thinkingSignature: JSON.stringify(details) }];
    // Lumiverse sent the reasoning text back as `reasoning_content`, the field DeepSeek reads.
    if (m.reasoning) return [{ type: "thinking", thinking: m.reasoning, thinkingSignature: "reasoning_content" }];
  }
  return [];
}

/** An assistant turn as pi-ai's message, with what it carries of its reasoning (see the head of this file). */
function assistantOf(m: ModelMessage, target: CallTarget): AssistantMessage {
  const parts: readonly ModelPart[] = m.parts ?? (m.content !== "" ? [{ type: "text", text: m.content }] : []);
  const text = parts.flatMap((p) => (p.type === "text" ? [p.text] : [])).join("");
  const uses = parts.filter((p): p is ToolUse => p.type === "tool_use");
  const said: TextContent[] = text !== "" ? [{ type: "text", text }] : [];
  const record = recordOf(m.reasoningDetails);
  let content: AssistantMessage["content"];
  let who: { api: string; provider: string; model: string };
  if (record !== null) {
    const thinking = (m.thinkingBlocks ?? []).map(thinkingOf);
    content = inRecordOrder(record, text, uses, thinking) ?? [...thinking, ...said, ...uses.map((u) => callOf(u, true))];
    who = record;
  } else {
    // A thought signature means something to Gemini alone.
    const keepSignatures = target.api === "google-generative-ai";
    content = [...lumiverseThinking(m, target.api), ...said, ...uses.map((u) => callOf(u, keepSignatures))];
    who = target;
  }
  const stopReason: StopReason = content.some((b) => b.type === "toolCall") ? "toolUse" : "stop";
  return { role: "assistant", content, api: who.api, provider: who.provider, model: who.model, usage: NO_USAGE, stopReason, timestamp: 0 };
}

/** A user's message as pi-ai's: each tool result first, as a result of its own, then what else it holds. */
function userOf(m: ModelMessage, callNames: ReadonlyMap<string, string>): Message[] {
  if (m.parts === undefined) return [{ role: "user", content: m.content, timestamp: 0 }];
  const out: Message[] = [];
  const blocks: (TextContent | ImageContent)[] = [];
  for (const p of m.parts) {
    switch (p.type) {
      case "tool_result":
        out.push({ role: "toolResult", toolCallId: p.toolUseId, toolName: callNames.get(p.toolUseId) ?? "", content: [{ type: "text", text: p.content }], isError: p.isError === true, timestamp: 0 });
        break;
      case "text":
        blocks.push({ type: "text", text: p.text });
        break;
      case "media":
        if (p.media !== "image") throw new NotCarried(`This call holds ${p.media === "audio" ? "audio" : "a video"}, and the runtime's model calls carry text and images only.`);
        blocks.push({ type: "image", data: p.data, mimeType: p.mimeType });
        break;
      case "tool_use":
        throw new NotCarried(`A user's message in this call holds a call to the tool "${p.name}", which only the model's own turn can hold.`);
    }
  }
  if (blocks.length > 0) out.push({ role: "user", content: blocks, timestamp: 0 });
  return out;
}

function toolOf(t: CallTool): Tool {
  return { name: t.name, description: t.description, parameters: t.parameters, ...(t.strict !== undefined ? { constrainedSampling: t.strict ? { type: "json_schema", strict: "require" } : false } : {}) };
}

/** A call's messages and tools as pi-ai's context (see the head of this file). */
export function contextOf(messages: readonly ModelMessage[], tools: readonly CallTool[], target: CallTarget): Context {
  let lead = 0;
  const prompt: string[] = [];
  for (; lead < messages.length && messages[lead]?.role === "system"; lead += 1) prompt.push(textOf(messages[lead] as ModelMessage));
  const out: Message[] = [];
  const callNames = new Map<string, string>();
  for (const m of messages.slice(lead)) {
    if (m.role === "assistant") {
      const turn = assistantOf(m, target);
      for (const b of turn.content) if (b.type === "toolCall") callNames.set(b.id, b.name);
      out.push(turn);
    } else if (m.role === "system") {
      out.push(target.systemInPlace ? { role: "system", content: textOf(m), timestamp: 0 } : { role: "user", content: textOf(m), timestamp: 0 });
    } else out.push(...userOf(m, callNames));
  }
  return { ...(prompt.length > 0 ? { systemPrompt: prompt.join("\n\n") } : {}), messages: out, ...(tools.length > 0 ? { tools: tools.map(toolOf) } : {}) };
}

/** How the call ended, in the words the core and Lumiverse read (OpenAI's). */
function finishOf(reason: StopReason): string {
  switch (reason) {
    case "toolUse":
      return "tool_calls";
    case "length":
      return "length";
    default:
      return "stop";
  }
}

function blockOf(t: ThinkingContent): ModelThinkingBlock {
  return t.redacted === true ? { type: "redacted_thinking", data: t.thinkingSignature ?? "" } : { type: "thinking", thinking: t.thinking, ...(t.thinkingSignature !== undefined && t.thinkingSignature !== "" ? { signature: t.thinkingSignature } : {}) };
}

/**
 * A finished answer as the core's result: its text, its calls, its reasoning and the carriers that
 * send its turn back exactly (see the head of this file), the model that answered, and its usage.
 * A plain answer, with nothing of its reasoning to send back, carries no record.
 */
export function resultOf(message: AssistantMessage, usage: JsonObject): ModelResult {
  const text: string[] = [];
  const thinking: ThinkingContent[] = [];
  const calls: ToolCall[] = [];
  const blocks: RecordBlock[] = [];
  let signed = false;
  for (const b of message.content) {
    if (b.type === "text") {
      text.push(b.text);
      blocks.push({ text: b.text.length, ...(b.textSignature !== undefined ? { signature: b.textSignature } : {}) });
      signed ||= b.textSignature !== undefined;
    } else if (b.type === "thinking") {
      blocks.push({ thinking: thinking.length });
      thinking.push(b);
    } else {
      blocks.push({ call: b.id });
      calls.push(b);
      signed ||= b.thoughtSignature !== undefined;
    }
  }
  const reasoning = thinking.flatMap((t) => (t.redacted === true || t.thinking === "" ? [] : [t.thinking])).join("\n\n");
  const record: JsonObject = { type: RECORD, api: message.api, provider: message.provider, model: message.model, blocks: blocks.map((b) => ({ ...b })) };
  return {
    content: text.join(""),
    finishReason: finishOf(message.stopReason),
    model: message.responseModel ?? message.model,
    ...(calls.length > 0 ? { toolCalls: calls.map((c) => ({ callId: c.id, name: c.name, args: toJsonObject(c.arguments), ...(c.thoughtSignature !== undefined ? { thoughtSignature: c.thoughtSignature } : {}) })) } : {}),
    ...(reasoning !== "" ? { reasoning } : {}),
    ...(thinking.length > 0 ? { thinkingBlocks: thinking.map(blockOf) } : {}),
    ...(thinking.length > 0 || signed ? { reasoningDetails: [record] } : {}),
    usage,
  };
}
