// A request that reached the loopback with no turn's tag (runtime/relay.ts), answered through pi-ai
// on the connection the runtime passes such requests to (the writer's), streamed back as it comes:
// its messages and tools whole, its answer room, sampling, effort and tool choice read from its
// body, and every other field of its body sent as it came where the call speaks the body's own API
// (OpenAI's chat completions). A provider with another API takes what it has a place for, as
// Lumiverse's own provider for it did.
//
// What has no way to the model refuses the request, in words that name it, as the passthrough did
// before (runtime/openai.ts): a speaker's name, a prefix to continue on an API that can't continue
// one, a tool choice other than letting the model choose or not, audio and video. Dropped, any of
// them would change what the model is told and nobody would know.

import type { ToolChoice } from "@earendil-works/pi-ai";
import type { JsonObject, ModelEffort, ModelMessage, ModelPart } from "../../core/ports";
import { isRecord } from "../../core/ports";
import type { PassedMessage, PassedPart } from "../../link/contract";
import type { PassedRequest } from "../openai";
import { maxTokensOf, samplingOf } from "../openai";
import type { Job } from "./call";
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

/** The effort the body asks for (OpenAI's `reasoning_effort`, or OpenRouter's `reasoning.effort`); `auto` where it asks none. OpenAI's `none` is off. */
function effortOf(body: JsonObject): ModelEffort {
  const asked = typeof body.reasoning_effort === "string" ? body.reasoning_effort : isRecord(body.reasoning) && typeof body.reasoning.effort === "string" ? body.reasoning.effort : undefined;
  if (asked === "none") return "off";
  return EFFORTS.find((e) => e === asked) ?? "auto";
}

/** The body's tool choice, as the runtime's calls can make it: the model chooses, or calls none. */
function toolChoiceOf(raw: unknown): ToolChoice | undefined {
  if (raw === undefined || raw === null) return undefined;
  if (raw === "auto" || raw === "none") return raw;
  throw new NotCarried(`it asks the model to call a tool (\`tool_choice\`: ${JSON.stringify(raw)}), and the runtime's model calls let the model choose or call none`);
}

function partOf(p: PassedPart): ModelPart {
  switch (p.type) {
    case "text":
      return { type: "text", text: p.text };
    case "media":
      return { type: "media", media: p.media, data: p.data, mimeType: p.mimeType };
    case "tool_use":
      return { type: "tool_use", id: p.id, name: p.name, input: p.input };
    case "tool_result":
      return { type: "tool_result", toolUseId: p.toolUseId, content: p.content };
  }
}

/**
 * The body's messages as the core's. A message's cache marks are left to pi-ai, which marks the
 * cache itself; `prefix` stands only on the last message and only where the API continues an
 * assistant's message it is given (Anthropic's).
 */
function messagesOf(messages: readonly PassedMessage[], continues: boolean): ModelMessage[] {
  return messages.map((m, i): ModelMessage => {
    const what = `message ${i + 1}`;
    if (m.name !== undefined) throw new NotCarried(`${what} names its speaker (\`name\`), and the runtime's model calls have no place for a name`);
    if (m.prefix === true && !(continues && m.role === "assistant" && i === messages.length - 1)) throw new NotCarried(`${what} is a prefix for the model to continue, which this connection's API can't continue`);
    const parts = typeof m.content === "string" ? undefined : m.content.map(partOf);
    const content = parts === undefined ? (m.content as string) : parts.flatMap((p) => (p.type === "text" ? [p.text] : p.type === "tool_result" ? [p.content] : [])).join("\n");
    return { role: m.role, content, ...(parts !== undefined ? { parts } : {}), ...(m.reasoning !== undefined ? { reasoning: m.reasoning } : {}), ...(m.reasoningDetails !== undefined ? { reasoningDetails: m.reasoningDetails } : {}) };
  });
}

/**
 * A passed-through request as one call on `connectionId`. `continues`: the connection's API
 * continues an assistant's message given last. Throws `NotCarried` for what can't reach the model.
 */
export function passedJob(request: PassedRequest, connectionId: string | null, continues: boolean): Job {
  const body = request.parameters;
  const extras: JsonObject = {};
  for (const [key, value] of Object.entries(body)) if (!Object.hasOwn(READ, key)) extras[key] = value;
  const toolChoice = request.tools.length > 0 ? toolChoiceOf(body.tool_choice) : undefined;
  return {
    connectionId,
    model: null,
    messages: messagesOf(request.messages, continues),
    tools: request.tools.map((t) => ({ name: t.name, description: t.description, parameters: t.parameters, ...(t.strict !== undefined ? { strict: t.strict } : {}) })),
    maxTokens: maxTokensOf(body),
    effort: effortOf(body),
    params: samplingOf(body),
    serialTools: body.parallel_tool_calls === false,
    ...(toolChoice !== undefined ? { toolChoice } : {}),
    ...(Object.keys(extras).length > 0 ? { extras } : {}),
    streamed: true,
  };
}
