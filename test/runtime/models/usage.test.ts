// A call's usage comes back in the envelope the core already reads (core/usage.ts `parseUsage`),
// read here by parseUsage itself: what was sent, what of it was read from the provider's cache and
// written to it, what was written and how much of that was reasoning, and the cost: the provider's
// own bill where it sent one, else what pi-ai's published price for the model makes of the counts,
// which is an estimate, never a bill. A model it has no price for leaves the cost to the user's own
// Prices.

import { afterEach, describe, expect, test } from "bun:test";
import type { Api, Model, Usage } from "@earendil-works/pi-ai";
import { anthropicProvider } from "@earendil-works/pi-ai/providers/anthropic";
import { deepseekProvider } from "@earendil-works/pi-ai/providers/deepseek";
import { parseUsage, priced } from "../../../src/core/usage";
import { usageEnvelope } from "../../../src/runtime/models/usage";
import type { Rig } from "./support";
import { anthropicStream, anthropicTurn, chatStream, chunk, eventStream, forever, request, rig } from "./support";

/** What the runtime would have guessed, for the counts a provider doesn't report: never the answer here, so a guess shows. */
const GUESS = { in: 1, out: 1, reasoningOut: 1 };

let r: Rig | undefined;
afterEach(async () => {
  await r?.done();
  r = undefined;
});

function listed(models: readonly Model<Api>[], id: string): Model<Api> {
  const model = models.find((m) => m.id === id);
  if (model === undefined) throw new Error(`pi-ai lists no ${id}`);
  return model;
}

describe("a call's usage, read by parseUsage", () => {
  test("Anthropic: everything sent, the cache's reads and writes, what was written, and the catalogue's price as an estimate", async () => {
    r = rig({ script: () => eventStream(anthropicStream(anthropicTurn({ text: "At the quay.", usage: { input: 100, output: 40, cacheRead: 900, cacheWrite: 50, thinking: 12 } }))) });
    await r.layer.book.save({ name: "Claude", provider: "anthropic", auth: "key", model: "claude-sonnet-4-5" }, "sk-ant-api03-0123456789abcdef");
    const result = await r.layer.models.call(request({ messages: [{ role: "user", content: "Where is Ilse?" }] }), forever());
    const usage = parseUsage(result.usage, "anthropic", GUESS);
    const price = listed(anthropicProvider().getModels(), "claude-sonnet-4-5").cost;
    expect(usage).toMatchObject({ in: 1050, cachedIn: 900, cacheWrite: 50, out: 40 });
    // The published price is no bill, so the cost is an estimate; Anthropic's reading never takes a reasoning count, as before: it is the runtime's guess.
    expect(usage.estimated).toEqual(["cost", "reasoningOut"]);
    expect(usage.cost).toBeCloseTo((100 * price.input + 40 * price.output + 900 * price.cacheRead + 50 * price.cacheWrite) / 1_000_000, 12);
  });

  test("an OpenAI-compatible server: everything sent, its cache's reads, what was written and its reasoning; no cost, so the user's own price prices it", async () => {
    const usageChunk = { id: "chatcmpl-1", object: "chat.completion.chunk", created: 1, model: "served-model", choices: [], usage: { prompt_tokens: 1000, completion_tokens: 200, total_tokens: 1200, prompt_tokens_details: { cached_tokens: 600 }, completion_tokens_details: { reasoning_tokens: 50 } } };
    r = rig({ script: () => eventStream(chatStream([chunk({ role: "assistant", content: "Yes." }), chunk({}, "stop"), usageChunk])) });
    await r.layer.book.save({ name: "Local", provider: "openai-compatible", auth: "none", baseUrl: "http://127.0.0.1:8080/v1", model: "served-model" });
    const result = await r.layer.models.call(request({ messages: [{ role: "user", content: "Ready?" }] }), forever());
    const usage = parseUsage(result.usage, "openai-compatible", GUESS);
    expect(usage).toEqual({ in: 1000, cachedIn: 600, out: 200, reasoningOut: 50, estimated: [] });
    expect(priced(usage, ["served-model"], { "served-model": { in: 1, cachedIn: 0.1, out: 2 } })).toMatchObject({ cost: (400 * 1 + 600 * 0.1 + 200 * 2) / 1_000_000, pricedAs: "served-model", estimated: ["cost"] });
  });

  test("DeepSeek: the catalogue's price comes with the counts, as an estimate", async () => {
    const usageChunk = { id: "chatcmpl-1", object: "chat.completion.chunk", created: 1, model: "deepseek-flash", choices: [], usage: { prompt_tokens: 2000, completion_tokens: 100, total_tokens: 2100, prompt_cache_hit_tokens: 1500 } };
    r = rig({ script: () => eventStream(chatStream([chunk({ role: "assistant", content: "Yes." }), chunk({}, "stop"), usageChunk])) });
    await r.layer.book.save({ name: "DeepSeek", provider: "deepseek", auth: "key", model: "deepseek-flash" }, "sk-deepseek-0123456789abcdef");
    const result = await r.layer.models.call(request({ messages: [{ role: "user", content: "Ready?" }], effort: "off" }), forever());
    const usage = parseUsage(result.usage, "deepseek", GUESS);
    const price = listed(deepseekProvider().getModels(), "deepseek-flash").cost;
    expect(usage).toMatchObject({ in: 2000, cachedIn: 1500, out: 100 });
    expect(usage.estimated).toContain("cost");
    expect(usage.cost).toBeCloseTo((500 * price.input + 100 * price.output + 1500 * price.cacheRead) / 1_000_000, 12);
  });
});

describe("the envelope for the providers parseUsage reads its own way", () => {
  const model = (cost: Model<Api>["cost"]): Model<Api> => ({ id: "m", name: "m", api: "openai-completions", provider: "x", baseUrl: "", reasoning: true, input: ["text"], cost, contextWindow: 0, maxTokens: 0 });
  const usage = (fields: Partial<Usage>): Usage => ({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 }, ...fields });

  test("Gemini: its thoughts are read as the rest of the total, and its output holds them", () => {
    const env = usageEnvelope(usage({ input: 300, cacheRead: 700, output: 250, reasoning: 100 }), "google", model({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }));
    expect(parseUsage(env, "google", GUESS)).toMatchObject({ in: 1000, out: 250, reasoningOut: 100 });
  });

  test("a cost the provider billed is its own, whatever the catalogue says", () => {
    const env = usageEnvelope(usage({ input: 10, output: 10, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0.0042, totalFromProvider: true } }), "openrouter", model({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }));
    expect(parseUsage(env, "openrouter", GUESS).cost).toBe(0.0042);
  });
});
