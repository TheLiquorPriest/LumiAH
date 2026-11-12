// A request that reached the loopback with no turn's tag (runtime/relay.ts), answered through pi-ai
// on the connection the runtime passes such requests to (the writer's), streamed back as it comes:
// its messages and tools whole, its answer room, sampling, effort and tool choice read from its
// body, and every other field of its body sent as it came where the call speaks the body's own API
// (OpenAI's chat completions). A provider with another API takes what it has a place for, as
// Lumiverse's own provider for it did.
//
// What has no way to the model refuses the request before anything of it is sent, in words that
// name it and say what to do: a speaker's name, audio and video, an image in a system message or in
// a message of the model's own, a tool choice other than letting the model choose or not, and a
// prefix to continue where the call can't continue one. Dropped, any of them would change what the
// model is told and nobody would know. A message is named by its place in the body, where each
// tool's result was a message of its own.
//
// Of the APIs a connection speaks, only Anthropic's continues an assistant's message given last,
// and Anthropic refuses that prefix to Claude 4.6 and later whatever they are asked, and to an
// earlier model while it thinks (its "Thinking" documentation: "Response prefill and forced tool
// use"). pi-ai's catalogue marks the models from 4.6 on as thinking adaptively, and sends its own
// effort mark after the last message to those of them that take one, so the prefix wouldn't even
// be last. A prefix is therefore looked at against the call itself: the model it goes to, and how
// that model is asked to think (call.ts `CallShape`).

import type { ToolChoice } from "@earendil-works/pi-ai";
import type { JsonObject, ModelEffort, ModelMessage, ModelPart } from "../../core/ports";
import { isRecord } from "../../core/ports";
import type { PassedMessage, PassedPart, PassedRequest } from "../openai";
import { maxTokensOf, samplingOf } from "../openai";
import type { CallShape, Job } from "./call";
import { compatSays } from "./call";
import { NotCarried } from "./convert";

/** The fields of a body this conversion reads itself; every other one is sent as it came, where it can be. */
const READ: Readonly<Record<string, true>> = {
  max_tokens: true,
  max_completion_tokens: true,
  temperature: true,
  top_p: true,
  top_k: true,
  min_p: true,
  frequency_penalty: true,
  presence_penalty: true,
  repetition_penalty: true,
  seed: true,
  stop: true,
  reasoning_effort: true,
  reasoning: true,
  parallel_tool_calls: true,
  tool_choice: true,
};

const EFFORTS: readonly ModelEffort[] = ["off", "auto", "minimal", "low", "medium", "high", "xhigh", "max"];

/** The effort the body names, with the field it names it in (OpenAI's `reasoning_effort`, or OpenRouter's `reasoning.effort`); null where it names none. */
function askedEffort(body: JsonObject): { field: string; value: string } | null {
  if (typeof body.reasoning_effort === "string") return { field: "reasoning_effort", value: body.reasoning_effort };
  if (isRecord(body.reasoning) && typeof body.reasoning.effort === "string") return { field: "reasoning.effort", value: body.reasoning.effort };
  return null;
}

/** The effort the body asks for; `auto` (the connection's own) where it asks none, or one there is no such effort as. OpenAI's `none` is off. */
function effortOf(body: JsonObject): ModelEffort {
  const asked = askedEffort(body)?.value;
  if (asked === "none") return "off";
  return EFFORTS.find((e) => e === asked) ?? "auto";
}

/** The body's tool choice, as the runtime's calls can make it: the model chooses, or calls none. */
function toolChoiceOf(raw: unknown): ToolChoice | undefined {
  if (raw === undefined || raw === null) return undefined;
  if (raw === "auto" || raw === "none") return raw;
  throw new NotCarried(`it asks the model to call a tool (\`tool_choice\`: ${JSON.stringify(raw)}), and the runtime's model calls let the model choose a tool or call none: set \`tool_choice\` to "auto" or "none", or leave it out`);
}

/** One part of a message, `what` naming it by its place in the body, `role` the message's. */
function partOf(p: PassedPart, what: string, role: PassedMessage["role"]): ModelPart {
  switch (p.type) {
    case "text":
      return { type: "text", text: p.text };
    case "media":
      if (p.media !== "image") throw new NotCarried(`${what} is ${p.media === "audio" ? "audio" : "a video"}, and the runtime's model calls carry text and images only: leave it out, or give what it holds as text`);
      if (role === "system") throw new NotCarried(`${what} is an image in a system message, and the runtime's model calls carry a system message's text only: put the image in a user's message, or leave it out`);
      if (role === "assistant") throw new NotCarried(`${what} is an image in a message of the model's own, and the runtime's model calls carry only the text, reasoning and tool calls of one: put the image in a user's message, or leave it out`);
      return { type: "media", media: p.media, data: p.data, mimeType: p.mimeType };
    case "tool_use":
      return { type: "tool_use", id: p.id, name: p.name, input: p.input };
    case "tool_result":
      return { type: "tool_result", toolUseId: p.toolUseId, content: p.content };
  }
}

/**
 * The body's messages as the core's. A message's cache marks are left to pi-ai, which marks the
 * cache itself; `prefix` stands only on the last message, the model's own, and is looked at against
 * the call (`prefixRefusal`).
 */
function messagesOf(messages: readonly PassedMessage[]): ModelMessage[] {
  let read = 0;
  return messages.map((m, i): ModelMessage => {
    const what = `message ${read + 1}`;
    // A run of the body's tool messages is one message of their results here: each was a message of the body's.
    read += typeof m.content !== "string" && m.content.length > 0 && m.content.every((p) => p.type === "tool_result") ? m.content.length : 1;
    if (m.name !== undefined) throw new NotCarried(`${what} names its speaker (\`name\`), which the runtime's model calls have no place for: put the name in the message's text, or leave it out`);
    if (m.prefix === true && !(m.role === "assistant" && i === messages.length - 1)) throw new NotCarried(`${what} is marked as a prefix to continue (\`prefix\`), and only the last message, the model's own, can be one: take the mark off`);
    const parts = typeof m.content === "string" ? undefined : m.content.map((p, j) => partOf(p, `${what}'s part ${j + 1}`, m.role));
    const content = parts === undefined ? (m.content as string) : parts.flatMap((p) => (p.type === "text" ? [p.text] : p.type === "tool_result" ? [p.content] : [])).join("\n");
    return { role: m.role, content, ...(parts !== undefined ? { parts } : {}), ...(m.reasoning !== undefined ? { reasoning: m.reasoning } : {}), ...(m.reasoningDetails !== undefined ? { reasoningDetails: m.reasoningDetails } : {}) };
  });
}

/** Why a call of this shape can't continue the prefix the request ends in (see the head of this file); null where it can. */
function prefixRefusal(shape: CallShape, body: JsonObject): string | null {
  const { connection, kind, model } = shape;
  const prefix = `the last message is a prefix to continue (\`prefix\`), and the connection "${connection.name}" (${kind.name}, ${model.id})`;
  if (model.api !== "anthropic-messages") return `${prefix} can't continue one: only Anthropic's API continues a message given to it. Take the mark off to send the message as one the model wrote before, or have the writer use a connection to an earlier Claude model than 4.6`;
  if (compatSays(model, "forceAdaptiveThinking")) return `${prefix} can't continue one: Anthropic refuses a prefix to Claude 4.6 and later. Leave the message out, or have the writer use a connection to an earlier Claude model`;
  if (shape.reasoning === undefined) return null;
  const asked = askedEffort(body);
  // The effort that has the model think: the request's own, or the connection's where the request leaves it to the connection.
  return effortOf(body) !== "auto" && asked !== null
    ? `${prefix} can't continue one while its model thinks, as the request asks it to (\`${asked.field}\`: ${JSON.stringify(asked.value)}): send "none" there instead`
    : `${prefix} can't continue one while its model thinks, as the connection's effort (${connection.effort ?? "its provider's"}) has it do: send \`reasoning_effort\`: "none" with the request, or set the connection's effort to off`;
}

/**
 * A passed-through request as one call on `connectionId`, made before anything of it is sent:
 * rejects with `NotCarried` for what can't reach the model. `shape` tells what the call goes to and
 * how it asks its model to think; it is asked only where the request ends in a prefix to continue,
 * which some calls can't.
 */
export async function passedJob(request: PassedRequest, connectionId: string, shape: (job: Job) => Promise<CallShape>): Promise<Job> {
  const body = request.parameters;
  const extras: JsonObject = {};
  for (const [key, value] of Object.entries(body)) if (!Object.hasOwn(READ, key)) extras[key] = value;
  const toolChoice = request.tools.length > 0 ? toolChoiceOf(body.tool_choice) : undefined;
  const job: Job = {
    connectionId,
    model: null,
    messages: messagesOf(request.messages),
    tools: request.tools.map((t) => ({ name: t.name, description: t.description, parameters: t.parameters, ...(t.strict !== undefined ? { strict: t.strict } : {}) })),
    maxTokens: maxTokensOf(body),
    effort: effortOf(body),
    params: samplingOf(body),
    serialTools: body.parallel_tool_calls === false,
    ...(toolChoice !== undefined ? { toolChoice } : {}),
    ...(Object.keys(extras).length > 0 ? { extras } : {}),
    streamed: true,
  };
  if (request.messages.at(-1)?.prefix === true) {
    const refused = prefixRefusal(await shape(job), body);
    if (refused !== null) throw new NotCarried(refused);
  }
  return job;
}
