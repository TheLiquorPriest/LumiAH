// A request that reached the loopback with no turn's tag, answered through pi-ai on the writer's
// connection: read from its body as the relay reads it (runtime/openai.ts), streamed back as it
// comes, ended with its tool calls and its usage. Every other field of the body goes as it came to
// a server that speaks the body's own API; a provider with another takes what it has a place for.
// What has no way to the model refuses the request in words that name it.

import { afterEach, describe, expect, test } from "bun:test";
import { fauxAssistantMessage, fauxProvider, fauxText, fauxToolCall } from "@earendil-works/pi-ai";
import type { JsonObject, ModelDelta } from "../../../src/core/ports";
import type { PassedRequest } from "../../../src/runtime/openai";
import { passedRequest } from "../../../src/runtime/openai";
import type { Rig } from "./support";
import { anthropicStream, anthropicTurn, bodyOf, chatStream, chunk, eventStream, forever, rig } from "./support";

const LOOKUP = { type: "function", function: { name: "lookup", description: "Looks a thing up.", parameters: { type: "object", properties: { what: { type: "string" } } } } };

let r: Rig | undefined;
afterEach(async () => {
  await r?.done();
  r = undefined;
});

/** A body as Lumiverse posts it to the loopback, read as the relay reads it. */
function passed(body: JsonObject): PassedRequest {
  const read = passedRequest(body);
  if ("refused" in read) throw new Error(read.refused);
  return read;
}

const BODY: JsonObject = {
  model: "lumiah",
  stream: true,
  messages: [
    { role: "system", content: "You summarize harbour gossip." },
    { role: "user", content: "What happened at the mill?" },
  ],
  tools: [LOOKUP],
  max_tokens: 321,
  temperature: 0.4,
  top_p: 0.8,
  reasoning_effort: "low",
  parallel_tool_calls: false,
  response_format: { type: "json_object" },
  user: "harbour-reader",
  logit_bias: { "50256": -100 },
};

describe("a request passed through", () => {
  test("streams its text as it comes, and ends with its tool calls and its usage", async () => {
    const faux = fauxProvider({ provider: "groq", models: [{ id: "faux-1" }], tokenSize: { min: 1, max: 1 } });
    faux.setResponses([fauxAssistantMessage([fauxText("Let me look."), fauxToolCall("lookup", { what: "mill" }, { id: "call_9" })], { stopReason: "toolUse" })]);
    r = rig({ providers: [faux.provider], passConnection: "id1" });
    await r.layer.book.save({ name: "Writer", provider: "groq", auth: "key", model: "faux-1" }, "gsk_0123456789abcdefghij");
    const deltas: ModelDelta[] = [];
    const result = await r.layer.pass(passed(BODY), forever(), (d) => deltas.push(d));
    expect(deltas.map((d) => d.content ?? "").join("")).toBe("Let me look.");
    expect(result).toMatchObject({ content: "Let me look.", finishReason: "tool_calls", toolCalls: [{ callId: "call_9", name: "lookup", args: { what: "mill" } }] });
    expect(result.usage).toMatchObject({ prompt_tokens: expect.any(Number), completion_tokens: expect.any(Number), total_tokens: expect.any(Number) });
  });

  test("sends every other field of its body as it came to a server that speaks the body's own API", async () => {
    r = rig({ script: () => eventStream(chatStream([chunk({ role: "assistant", content: "The wheel broke." }), chunk({}, "stop")])), passConnection: "id1" });
    await r.layer.book.save({ name: "Writer", provider: "openai-compatible", auth: "none", baseUrl: "http://127.0.0.1:8080/v1", model: "served-model" });
    const result = await r.layer.pass(passed(BODY), forever(), () => undefined);
    expect(result.content).toBe("The wheel broke.");
    const body = bodyOf(r.sent[0]);
    expect(body).toMatchObject({ model: "served-model", temperature: 0.4, top_p: 0.8, reasoning_effort: "low", parallel_tool_calls: false, response_format: { type: "json_object" }, user: "harbour-reader", logit_bias: { "50256": -100 } });
    expect(body.max_completion_tokens ?? body.max_tokens).toBe(321);
  });

  test("gives a provider with another API what it has a place for, and continues a prefix where Anthropic can", async () => {
    r = rig({ script: () => eventStream(anthropicStream(anthropicTurn({ text: " broke at dawn." }))), passConnection: "id1" });
    await r.layer.book.save({ name: "Writer", provider: "anthropic", auth: "key", model: "claude-sonnet-4-5" }, "sk-ant-api03-0123456789abcdef");
    const messages = [...(BODY.messages as JsonObject[]), { role: "assistant", content: "The wheel", prefix: true }];
    await r.layer.pass(passed({ ...BODY, messages, reasoning_effort: "none" }), forever(), () => undefined);
    const body = bodyOf(r.sent[0]);
    expect(body).toMatchObject({ max_tokens: 321, temperature: 0.4, top_p: 0.8, thinking: { type: "disabled" }, tool_choice: { disable_parallel_tool_use: true } });
    for (const field of ["response_format", "user", "logit_bias", "reasoning_effort"]) expect(Object.keys(body)).not.toContain(field);
    const sent = body.messages as { role: string; content: unknown }[];
    expect(sent.at(-1)).toMatchObject({ role: "assistant", content: [{ type: "text", text: "The wheel" }] });
  });

  test("refuses what has no way to the model, in words that name it, and sends nothing", async () => {
    r = rig({ passConnection: "id1" });
    await r.layer.book.save({ name: "Writer", provider: "openai-compatible", auth: "none", baseUrl: "http://127.0.0.1:8080/v1", model: "served-model" });
    const user = (content: unknown, more: JsonObject = {}): JsonObject => ({ ...BODY, messages: [{ role: "user", content, ...more }] as JsonObject[] });
    const refusals: [JsonObject, string][] = [
      [user("Hello", { name: "Okoro" }), "message 1 names its speaker (`name`)"],
      [user([{ type: "input_audio", input_audio: { data: "UklGRiQAAAA=", format: "wav" } }]), "This call holds audio"],
      [{ ...BODY, tool_choice: "required" }, "it asks the model to call a tool (`tool_choice`: \"required\")"],
      [{ ...BODY, messages: [...(BODY.messages as JsonObject[]), { role: "assistant", content: "The wheel", prefix: true }] }, "message 3 is a prefix for the model to continue"],
    ];
    for (const [body, words] of refusals) await expect(r.layer.pass(passed(body), forever(), () => undefined)).rejects.toThrow(words);
    expect(r.sent).toEqual([]);
  });
});
