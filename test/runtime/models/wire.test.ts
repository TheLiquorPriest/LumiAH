// What a call sends its provider: the room it may write in (its thinking within it), the effort as
// the provider takes it (`off` none; a level as pi-ai's, or the nearest the model takes; `auto` and
// `inherit` the connection's own, else the provider's default), the sampling parameters the
// provider takes and none it would refuse, one tool per answer when the connection asks it, the
// prompt cache the session gives, and the prompt with each system message where the API takes it.

import { afterEach, describe, expect, test } from "bun:test";
import type { ModelThinkingLevel } from "@earendil-works/pi-ai";
import type { ModelEffort, ModelMessage, ModelTool } from "../../../src/core/ports";
import type { CallCache } from "../../../src/runtime/models";
import type { Rig } from "./support";
import { anthropicStream, anthropicTurn, bodyOf, chatStream, chunk, eventStream, forever, request, rig } from "./support";

const LOOKUP: ModelTool = { name: "lookup", description: "Looks a thing up.", parameters: { type: "object", properties: { what: { type: "string" } } } };
const EVERY = { temperature: 0.7, top_p: 0.9, top_k: 40, min_p: 0.05, frequency_penalty: 0.3, presence_penalty: 0.2, repetition_penalty: 1.1, seed: 7, stop: ["THE END"] };
/** A prompt with two system messages leading it and one in the middle of the chat. */
const PROMPT: ModelMessage[] = [
  { role: "system", content: "You narrate a harbour town." },
  { role: "system", content: "Okoro keeps the ledger." },
  { role: "user", content: "Where is Ilse?" },
  { role: "assistant", content: "At the mill." },
  { role: "system", content: "(The tide is out.)" },
  { role: "user", content: "And now?" },
];

let r: Rig | undefined;
afterEach(async () => {
  await r?.done();
  r = undefined;
});

/** The body an Anthropic call on `model` sent, with the connection's own effort as given. */
async function anthropicBody(model: string, fields: { effort?: ModelEffort; own?: ModelThinkingLevel; maxTokens?: number; serial?: boolean; cache?: CallCache; params?: typeof EVERY } = {}): Promise<Record<string, unknown>> {
  r = rig({ script: () => eventStream(anthropicStream(anthropicTurn({ text: "At the quay." }))), ...(fields.cache ? { caching: () => fields.cache as CallCache } : {}) });
  await r.layer.book.save({ name: "Claude", provider: "anthropic", auth: "key", model, ...(fields.own ? { effort: fields.own } : {}) }, "sk-ant-api03-0123456789abcdef");
  await r.layer.models.call(request({ messages: PROMPT, tools: [LOOKUP], maxTokens: fields.maxTokens ?? 3000, ...(fields.effort ? { effort: fields.effort } : {}), ...(fields.serial ? { parallelToolCalls: false as const } : {}), ...(fields.params ? { params: fields.params } : {}) }), forever());
  return bodyOf(r.sent[0]);
}

describe("an Anthropic call", () => {
  test("with reasoning off takes the sampling Anthropic has, in its names, and none it hasn't; one tool per answer; system messages where Anthropic takes them", async () => {
    const body = await anthropicBody("claude-sonnet-4-5", { effort: "off", serial: true, params: EVERY });
    expect(body).toMatchObject({ model: "claude-sonnet-4-5", max_tokens: 3000, temperature: 0.7, top_p: 0.9, top_k: 40, stop_sequences: ["THE END"], thinking: { type: "disabled" }, tool_choice: { type: "auto", disable_parallel_tool_use: true } });
    for (const refused of ["min_p", "frequency_penalty", "presence_penalty", "repetition_penalty", "seed", "stop"]) expect(Object.keys(body)).not.toContain(refused);
    expect((body.tools as { name: string }[]).map((t) => t.name)).toEqual(["lookup"]);
    // The leading system messages are the system prompt; the one in the middle stays where it stood, as the user's turn there.
    expect((body.system as { text: string }[]).map((s) => s.text)).toEqual(["You narrate a harbour town.\n\nOkoro keeps the ledger."]);
    const messages = body.messages as { role: string; content: unknown }[];
    expect(messages.map((m) => m.role)).toEqual(["user", "assistant", "user", "user"]);
    expect(JSON.stringify(messages[2])).toContain("(The tide is out.)");
  });

  test("that thinks to a budget keeps its thinking within the room it was given, shown summarized, and drops what thinking refuses", async () => {
    const body = await anthropicBody("claude-sonnet-4-5", { effort: "high", maxTokens: 20_000, params: EVERY });
    expect(body.max_tokens).toBe(20_000);
    expect(body.thinking).toEqual({ type: "enabled", budget_tokens: 16_384, display: "summarized" });
    for (const refused of ["temperature", "top_p", "top_k"]) expect(Object.keys(body)).not.toContain(refused);
    expect(body.stop_sequences).toEqual(["THE END"]);
  });

  test("on a model that chooses how long to think takes the level asked, or the nearest it has", async () => {
    expect((await anthropicBody("claude-opus-4-7", { effort: "xhigh" })).output_config).toEqual({ effort: "xhigh" });
    await r?.done();
    // claude-sonnet-4-6 has no `xhigh`: the nearest level it has is asked for.
    const nearest = await anthropicBody("claude-sonnet-4-6", { effort: "xhigh" });
    expect(nearest).toMatchObject({ thinking: { type: "adaptive", display: "summarized" }, output_config: { effort: "max" } });
  });

  test("`auto` and `inherit` take the connection's own effort, and with none the provider's default: no word of thinking at all", async () => {
    expect((await anthropicBody("claude-opus-4-7", { effort: "auto", own: "low" })).output_config).toEqual({ effort: "low" });
    await r?.done();
    expect((await anthropicBody("claude-opus-4-7", { effort: "inherit", own: "low" })).output_config).toEqual({ effort: "low" });
    await r?.done();
    const plain = await anthropicBody("claude-opus-4-7", { effort: "auto" });
    expect(Object.keys(plain)).not.toContain("thinking");
    expect(Object.keys(plain)).not.toContain("output_config");
  });

  test("marks the prompt cache as the session's retention says, and not at all for none", async () => {
    const kept = await anthropicBody("claude-sonnet-4-5", { cache: { sessionId: "agent-session-7", retention: "long" } });
    expect((kept.system as { cache_control?: unknown }[])[0]?.cache_control).toEqual({ type: "ephemeral", ttl: "1h" });
    await r?.done();
    const none = await anthropicBody("claude-sonnet-4-5", { cache: { retention: "none" } });
    expect(JSON.stringify(none)).not.toContain("cache_control");
  });
});

/** The body a chat-completions call sent on a connection of `provider`. */
async function chatBody(provider: string, model: string, fields: { effort?: ModelEffort; serial?: boolean; baseUrl?: string; cache?: CallCache } = {}): Promise<Record<string, unknown>> {
  r = rig({ script: () => eventStream(chatStream([chunk({ role: "assistant", content: "At the quay." }), chunk({}, "stop")])), ...(fields.cache ? { caching: () => fields.cache as CallCache } : {}) });
  await r.layer.book.save({ name: provider, provider, auth: "key", model, ...(fields.baseUrl ? { baseUrl: fields.baseUrl } : {}) }, "sk-test-0123456789abcdefghij");
  await r.layer.models.call(request({ messages: PROMPT, tools: [LOOKUP], params: EVERY, ...(fields.effort ? { effort: fields.effort } : {}), ...(fields.serial ? { parallelToolCalls: false as const } : {}) }), forever());
  return bodyOf(r.sent[0]);
}

describe("a chat-completions call", () => {
  test("to an OpenAI-compatible server takes every sampling parameter as Lumiverse's custom connection sent them, keeps each system message where it stood, and asks one tool per answer", async () => {
    const body = await chatBody("openai-compatible", "served-model", { baseUrl: "http://127.0.0.1:8080/v1", serial: true, effort: "medium" });
    expect(r?.sent[0]?.url).toBe("http://127.0.0.1:8080/v1/chat/completions");
    expect(body).toMatchObject({ model: "served-model", ...EVERY, parallel_tool_calls: false, reasoning_effort: "medium" });
    const messages = body.messages as { role: string; content: unknown }[];
    expect(messages.map((m) => m.role)).toEqual(["system", "user", "assistant", "system", "user"]);
    expect(messages[3]).toMatchObject({ content: "(The tide is out.)" });
  });

  test("to Groq leaves out what Groq refuses", async () => {
    const body = await chatBody("groq", "llama-3.3-70b-versatile");
    expect(body).toMatchObject({ temperature: 0.7, top_p: 0.9, frequency_penalty: 0.3, presence_penalty: 0.2, seed: 7, stop: ["THE END"] });
    for (const refused of ["top_k", "min_p", "repetition_penalty"]) expect(Object.keys(body)).not.toContain(refused);
  });

  test("never asks more room than the model can write", async () => {
    r = rig({ script: () => eventStream(chatStream([chunk({ role: "assistant", content: "Yes." }), chunk({}, "stop")])) });
    await r.layer.book.save({ name: "Groq", provider: "groq", auth: "key", model: "llama-3.3-70b-versatile" }, "gsk_0123456789abcdefghij");
    await r.layer.models.call(request({ messages: [{ role: "user", content: "Ready?" }], maxTokens: 900_000 }), forever());
    const body = bodyOf(r.sent[0]);
    expect(body.max_completion_tokens ?? body.max_tokens).toBe(32_768);
  });
});
