// A call's usage, as pi-ai reports it, in the envelope the core reads (core/usage.ts `parseUsage`):
// Lumiverse's `usage` with the provider's own counts in `provider_raw`. parseUsage reads three
// shapes by the connection's provider, and this writes the one it will read: Anthropic's (the
// prompt with its cache reads and writes, the output), Gemini's (the thoughts as the total less the
// prompt and the candidates), and the OpenAI-compatible one for every other provider. Every count
// pi-ai has rides in each: the cache's under Anthropic's names (which the OpenAI-compatible reading
// takes too), the reasoning under `reasoning_tokens`.
//
// pi-ai's `input` leaves out what was read from the cache and written to it, and its `output`
// holds the reasoning; the core's prompt is the whole of what was sent.

import type { Api, Model, Usage } from "@earendil-works/pi-ai";
import type { JsonObject } from "../../core/ports";

/**
 * What a call cost as pi-ai knows it: the provider's own bill where it reported one (OpenRouter's),
 * else what the model's published price in pi-ai's catalogue makes of the counts, which is no bill
 * (the core shows it as an estimate, and a price the user set for the model stands over it). None
 * for a model pi-ai has no price for (a compatible server's), whose calls the user's own Prices then
 * price.
 */
function costOf(usage: Usage, model: Model<Api>): { cost: number } | { list_cost: number } | Record<string, never> {
  if (usage.cost.totalFromProvider === true) return { cost: usage.cost.total };
  const { input, output, cacheRead, cacheWrite } = model.cost;
  return input > 0 || output > 0 || cacheRead > 0 || cacheWrite > 0 ? { list_cost: usage.cost.total } : {};
}

/**
 * The usage envelope for a call on a connection of `provider`, as parseUsage reads that provider's.
 * A cache write is there where the provider reports writes: Anthropic's API always does (none is a
 * count), any other only when it wrote some.
 */
export function usageEnvelope(usage: Usage, provider: string, model: Model<Api>): JsonObject {
  const prompt = usage.input + usage.cacheRead + usage.cacheWrite;
  const cost = costOf(usage, model);
  const reportsWrites = model.api === "anthropic-messages" || usage.cacheWrite > 0;
  const own: JsonObject = {
    input_tokens: usage.input,
    output_tokens: usage.output,
    cache_read_input_tokens: usage.cacheRead,
    ...(reportsWrites ? { cache_creation_input_tokens: usage.cacheWrite } : {}),
    ...(usage.reasoning !== undefined ? { reasoning_tokens: usage.reasoning } : {}),
  };
  // Gemini's reading takes the thoughts as what the total holds beyond the prompt and the candidates.
  const completion = provider === "google" ? usage.output - (usage.reasoning ?? 0) : usage.output;
  return {
    prompt_tokens: prompt,
    completion_tokens: completion,
    total_tokens: prompt + usage.output,
    ...cost,
    provider_raw: own,
  };
}
