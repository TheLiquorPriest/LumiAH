// Token usage per model call: what a call sent (and how much of it the provider read from its cache,
// and wrote to it), what it wrote (and how much of that was reasoning), and what it cost, read per
// provider from the usage Lumiverse passes on, the provider's own fields in `provider_raw`. A count a
// provider never reports is the runtime's estimate, flagged as one: Lumiverse passes no cached count
// for Gemini or OpenAI's Responses API, and Anthropic bills thinking as output without saying how
// much. What a call wrote to the cache is no estimate: it is there only when the provider says. Cost
// is the provider's own where it reports one (OpenRouter's `cost`), else what the user's prices for
// the model make of the counts, flagged as an estimate, else unknown.

import type { AgentUsage, CallUsage, JsonObject, ModelMessage, ModelTool, UsageField } from "./ports";
import { isRecord } from "./ports";
import type { ModelPrice } from "./settings";
import { hasOwn, tokensOf } from "./util";

/** The runtime's own estimate of a call, for whatever its provider doesn't report: the prompt, the answer and its reasoning. */
export interface UsageEstimate {
  in: number;
  out: number;
  reasoningOut: number;
}

/** A message's text as the estimate counts it: its text, or each part's text, call and result (media counts as nothing: its tokens are the provider's to tell). */
export function messageText(m: ModelMessage): string {
  if (!m.parts) return m.content;
  return m.parts.map((p) => (p.type === "text" ? p.text : p.type === "tool_use" ? `${p.name} ${JSON.stringify(p.input)}` : p.type === "tool_result" ? p.content : "")).join("\n");
}

/** What tools weigh in a call's prompt, as estimated: each one's name, description and schema. */
export function toolTokens(tools: readonly ModelTool[], charsPerToken: number): number {
  let tokens = 0;
  for (const t of tools) tokens += tokensOf(`${t.name} ${t.description} ${JSON.stringify(t.parameters)}`, charsPerToken);
  return tokens;
}

/** A call's prompt as estimated before it is sent: every message, and each tool (`toolTokens`). */
export function promptTokens(messages: readonly ModelMessage[], tools: readonly ModelTool[], charsPerToken: number): number {
  let tokens = toolTokens(tools, charsPerToken);
  for (const m of messages) tokens += tokensOf(messageText(m), charsPerToken);
  return tokens;
}

/** A reported count: a finite number of zero or more, else none. */
function count(o: unknown, key: string): number | undefined {
  if (!isRecord(o)) return undefined;
  const v = o[key];
  return typeof v === "number" && Number.isFinite(v) && v >= 0 ? v : undefined;
}

/**
 * A call's usage from Lumiverse's `usage` (`prompt_tokens`, `completion_tokens`, `total_tokens`, and
 * the provider's own in `provider_raw`) by its connection's provider; `estimate` fills each count it
 * lacks, listed in `estimated`.
 * - Anthropic: `input_tokens` leaves out what was read from the cache and written to it, which the
 *   host's prompt tokens add back; `cache_read_input_tokens` is the cached part, and
 *   `cache_creation_input_tokens` what it wrote to the cache. Thinking is billed as output and never
 *   reported apart, so the reasoning is always an estimate.
 * - Gemini (Google, Vertex): the host passes the prompt and candidate counts and the total, which
 *   also holds the thoughts, so the thoughts are the rest; it passes no cached count.
 * - Everything else is OpenAI-compatible: the provider's usage object whole, its cached tokens under
 *   `prompt_tokens_details.cached_tokens` (DeepSeek: `prompt_cache_hit_tokens`; some routers
 *   `cache_read_input_tokens` or `cached_tokens`), what it wrote to the cache where it says, under
 *   `prompt_tokens_details.cache_write_tokens` (OpenRouter; some routers Anthropic's own
 *   `cache_creation_input_tokens`, or `cache_creation_tokens`), and its reasoning under
 *   `completion_tokens_details.reasoning_tokens`.
 * The cost is the provider's `cost` (in the usage or in `provider_raw`) where it reports one.
 */
export function parseUsage(raw: JsonObject | undefined, provider: string | null, estimate: UsageEstimate): CallUsage {
  const estimated: UsageField[] = [];
  const guess = (field: UsageField, value: number): number => {
    estimated.push(field);
    return value;
  };
  const prompt = count(raw, "prompt_tokens");
  const completion = count(raw, "completion_tokens");
  const own = raw && isRecord(raw.provider_raw) ? raw.provider_raw : {};
  const cost = count(raw, "cost") ?? count(own, "cost");
  const priced = cost !== undefined ? { cost } : {};
  if (provider === "anthropic") {
    const fresh = count(own, "input_tokens");
    const read = count(own, "cache_read_input_tokens");
    const written = count(own, "cache_creation_input_tokens");
    const sent = prompt ?? (fresh === undefined ? undefined : fresh + (read ?? 0) + (written ?? 0));
    const out = count(own, "output_tokens") ?? completion;
    return { in: sent ?? guess("in", estimate.in), cachedIn: read ?? guess("cachedIn", 0), ...(written !== undefined ? { cacheWrite: written } : {}), out: out ?? guess("out", estimate.out + estimate.reasoningOut), reasoningOut: guess("reasoningOut", estimate.reasoningOut), estimated, ...priced };
  }
  if (provider === "google" || provider === "google_vertex") {
    const total = count(raw, "total_tokens");
    const thoughts = total !== undefined && prompt !== undefined && completion !== undefined ? Math.max(0, total - prompt - completion) : undefined;
    return {
      in: prompt ?? guess("in", estimate.in),
      cachedIn: guess("cachedIn", 0),
      out: completion !== undefined ? completion + (thoughts ?? 0) : guess("out", estimate.out + estimate.reasoningOut),
      reasoningOut: thoughts ?? guess("reasoningOut", estimate.reasoningOut),
      estimated,
      ...priced,
    };
  }
  const promptDetails = isRecord(own.prompt_tokens_details) ? own.prompt_tokens_details : {};
  const completionDetails = isRecord(own.completion_tokens_details) ? own.completion_tokens_details : {};
  const cached = count(promptDetails, "cached_tokens") ?? count(own, "prompt_cache_hit_tokens") ?? count(own, "cache_read_input_tokens") ?? count(own, "cached_tokens");
  const written = count(promptDetails, "cache_write_tokens") ?? count(own, "cache_creation_input_tokens") ?? count(own, "cache_creation_tokens");
  const reasoning = count(completionDetails, "reasoning_tokens") ?? count(own, "reasoning_tokens");
  return {
    in: prompt ?? guess("in", estimate.in),
    cachedIn: cached ?? guess("cachedIn", 0),
    ...(written !== undefined ? { cacheWrite: written } : {}),
    out: completion ?? guess("out", estimate.out + estimate.reasoningOut),
    reasoningOut: reasoning ?? guess("reasoningOut", estimate.reasoningOut),
    estimated,
    ...priced,
  };
}

/**
 * A call's usage with its cost: the provider's where it said, else what the user's price for the
 * model makes of the counts (flagged as an estimate), else none. Prices are per million tokens.
 */
export function priced(usage: CallUsage, model: string, prices: Readonly<Record<string, ModelPrice>>): CallUsage {
  const price = hasOwn(prices, model) ? prices[model] : undefined;
  if (usage.cost !== undefined || !price) return usage;
  const fresh = Math.max(0, usage.in - usage.cachedIn);
  const cost = (fresh * price.in + usage.cachedIn * price.cachedIn + usage.out * price.out) / 1_000_000;
  return { ...usage, cost, estimated: [...usage.estimated, "cost"] };
}

export function emptyUsage(): AgentUsage {
  return { calls: 0, toolTurns: 0, in: 0, cachedIn: 0, out: 0, reasoningOut: 0, estimated: false, ms: 0, cost: 0 };
}

/** Adds one call's usage to each tally: its cache write only when its provider said, and its cost only while every call's was known (one unknown makes the tally's unknown). */
export function addCall(call: CallUsage, ms: number, ...tallies: AgentUsage[]): void {
  for (const t of tallies) {
    t.calls += 1;
    t.in += call.in;
    t.cachedIn += call.cachedIn;
    if (call.cacheWrite !== undefined) t.cacheWrite = (t.cacheWrite ?? 0) + call.cacheWrite;
    t.out += call.out;
    t.reasoningOut += call.reasoningOut;
    t.estimated ||= call.estimated.length > 0;
    t.ms += ms;
    if (t.cost !== undefined) {
      if (call.cost === undefined) delete t.cost;
      else t.cost += call.cost;
    }
  }
}

/** Adds one usage to another: several agents' work counted as one turn's. */
export function addUsage(into: AgentUsage, from: AgentUsage): void {
  into.calls += from.calls;
  into.toolTurns += from.toolTurns;
  into.in += from.in;
  into.cachedIn += from.cachedIn;
  if (from.cacheWrite !== undefined) into.cacheWrite = (into.cacheWrite ?? 0) + from.cacheWrite;
  into.out += from.out;
  into.reasoningOut += from.reasoningOut;
  into.estimated ||= from.estimated;
  into.ms += from.ms;
  if (into.cost !== undefined) {
    if (from.cost === undefined) delete into.cost;
    else into.cost += from.cost;
  }
}
