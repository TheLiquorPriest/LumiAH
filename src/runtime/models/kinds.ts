// The providers a runtime's connection can name, and what each takes: how a connection of it signs
// its calls, the API a model it doesn't list is called with, whether it needs an address of the
// user's, which of the core's sampling parameters reach it, and which provider's catalogue lends a
// compatible server's model its definition. A connection names one by its id, and its calls go
// through pi-ai's provider of that id; the two compatible ones are the runtime's own, each call
// sent to the address its connection gives.
//
// Only these providers' factories are imported, so the runtime's bundle carries their code and no
// other provider's (pi-ai's `providers/all` would bring every one).

import type { Api, Model, Provider } from "@earendil-works/pi-ai";
import { anthropicMessagesApi } from "@earendil-works/pi-ai/api/anthropic-messages.lazy";
import { openAICompletionsApi } from "@earendil-works/pi-ai/api/openai-completions.lazy";
import { openAIResponsesApi } from "@earendil-works/pi-ai/api/openai-responses.lazy";
import { createProvider } from "@earendil-works/pi-ai/models";
import { anthropicProvider } from "@earendil-works/pi-ai/providers/anthropic";
import { deepseekProvider } from "@earendil-works/pi-ai/providers/deepseek";
import { googleProvider } from "@earendil-works/pi-ai/providers/google";
import { groqProvider } from "@earendil-works/pi-ai/providers/groq";
import { mistralProvider } from "@earendil-works/pi-ai/providers/mistral";
import { openaiProvider } from "@earendil-works/pi-ai/providers/openai";
import { openrouterProvider } from "@earendil-works/pi-ai/providers/openrouter";
import { xaiProvider } from "@earendil-works/pi-ai/providers/xai";
import type { SamplingParams } from "../../core/ports";

/** How a connection signs its calls: with its own key, with the runtime's sign-in to the provider, or with nothing (a local server that asks for none). */
export type ConnectionAuth = "key" | "signin" | "none";

/** The providers the runtime can sign in to, by pi-ai's ids for them. */
export type SignInProvider = "anthropic" | "openai";

export function isSignInProvider(value: unknown): value is SignInProvider {
  return value === "anthropic" || value === "openai";
}

export type SamplingName = keyof SamplingParams;

export interface ProviderKind {
  id: string;
  /** Its name, as the pages show it. */
  name: string;
  /** How a connection of it may sign its calls, the first the one a new connection takes. */
  auth: readonly ConnectionAuth[];
  /** For a named provider, the API a model its catalogue doesn't list is called with; for a compatible server, those a connection may choose from, the first its default. */
  apis: readonly Api[];
  /** A connection of it must give its address (a compatible server); else it may give one in place of the provider's own (a proxy). */
  needsBaseUrl: boolean;
  /**
   * The sampling parameters its calls take, by the core's names: any other is left out of the call,
   * never sent to fail it. A compatible server takes them all, as Lumiverse's custom connection sent
   * them.
   */
  sampling: readonly SamplingName[];
  /** The catalogue a compatible server's model is looked up in, for how it reasons and what it takes in: a proxy serves another provider's models under their own names. */
  borrows?: string;
}

const EVERY_PARAMETER: readonly SamplingName[] = ["temperature", "top_p", "top_k", "min_p", "frequency_penalty", "presence_penalty", "repetition_penalty", "seed", "stop"];

/**
 * The providers offered, in the order the pages list them. What each one's sampling list leaves out
 * is what its API refuses or has no field for: Anthropic has no penalties or seed; OpenAI's and
 * xAI's Responses API takes temperature and top_p alone; Groq refuses `top_k`, `min_p` and
 * `repetition_penalty`; Gemini refuses penalties on some of its models.
 */
export const KINDS: readonly ProviderKind[] = [
  { id: "anthropic", name: "Anthropic", auth: ["key", "signin"], apis: ["anthropic-messages"], needsBaseUrl: false, sampling: ["temperature", "top_p", "top_k", "stop"] },
  { id: "openai", name: "OpenAI", auth: ["key", "signin"], apis: ["openai-responses"], needsBaseUrl: false, sampling: ["temperature", "top_p"] },
  { id: "google", name: "Google Gemini", auth: ["key"], apis: ["google-generative-ai"], needsBaseUrl: false, sampling: ["temperature", "top_p", "top_k", "seed", "stop"] },
  { id: "openrouter", name: "OpenRouter", auth: ["key"], apis: ["openai-completions"], needsBaseUrl: false, sampling: EVERY_PARAMETER },
  { id: "deepseek", name: "DeepSeek", auth: ["key"], apis: ["openai-completions"], needsBaseUrl: false, sampling: ["temperature", "top_p", "frequency_penalty", "presence_penalty", "stop"] },
  { id: "xai", name: "xAI", auth: ["key"], apis: ["openai-responses"], needsBaseUrl: false, sampling: ["temperature", "top_p"] },
  { id: "groq", name: "Groq", auth: ["key"], apis: ["openai-completions"], needsBaseUrl: false, sampling: ["temperature", "top_p", "frequency_penalty", "presence_penalty", "seed", "stop"] },
  { id: "mistral", name: "Mistral", auth: ["key"], apis: ["mistral-conversations"], needsBaseUrl: false, sampling: ["temperature", "top_p", "frequency_penalty", "presence_penalty", "seed", "stop"] },
  { id: "openai-compatible", name: "OpenAI-compatible", auth: ["key", "none"], apis: ["openai-completions", "openai-responses"], needsBaseUrl: true, sampling: EVERY_PARAMETER, borrows: "openai" },
  { id: "anthropic-compatible", name: "Anthropic-compatible", auth: ["key", "none"], apis: ["anthropic-messages"], needsBaseUrl: true, sampling: ["temperature", "top_p", "top_k", "stop"], borrows: "anthropic" },
];

export function kindOf(id: string): ProviderKind | undefined {
  return KINDS.find((k) => k.id === id);
}

/** A compatible server's key, as the connection gives it; one that asks for none is still configured, so the call goes out keyless. */
function compatibleAuth(name: string): Provider["auth"] {
  return { apiKey: { name, resolve: async ({ credential }) => ({ auth: credential?.key ? { apiKey: credential.key } : {} }) } };
}

/**
 * pi-ai's providers for the kinds offered: the named ones from their factories, the compatible
 * ones built here with no models of their own (each call names its model and address).
 */
export function builtInProviders(): Provider[] {
  return [
    anthropicProvider(),
    openaiProvider(),
    googleProvider(),
    openrouterProvider(),
    deepseekProvider(),
    xaiProvider(),
    groqProvider(),
    mistralProvider(),
    createProvider({ id: "openai-compatible", name: "OpenAI-compatible", auth: compatibleAuth("OpenAI-compatible key"), models: [], api: { "openai-completions": openAICompletionsApi(), "openai-responses": openAIResponsesApi() } }),
    createProvider({ id: "anthropic-compatible", name: "Anthropic-compatible", auth: compatibleAuth("Anthropic-compatible key"), models: [], api: anthropicMessagesApi() }),
  ];
}

/** A model nobody's catalogue lists: it may reason and see images, and its limits are unknown, so pi-ai fits nothing to them. */
export function unlistedModel(id: string, api: Api, provider: string, baseUrl: string, maxTokens: number): Model<Api> {
  return { id, name: id, api, provider, baseUrl, reasoning: true, input: ["text", "image"], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 0, maxTokens };
}
