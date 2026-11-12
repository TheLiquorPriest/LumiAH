// One model call, from the runtime straight to its provider through pi-ai: the connection it goes on
// and how it signs, the model and what pi-ai knows of it, the effort, the room it may write in,
// the sampling parameters its provider takes, the prompt cache, and the answer as it streams.
//
// The core's contract for a call (core/ports.ts `ModelsPort`) holds here: deltas of text and of
// reasoning as they come, the whole answer as the result, the signal's reason when the signal ends
// it, and a failure in the provider's words with the status first. pi-ai's own retries stay off:
// the loop retries, as Settings allow.

import type { Api, AssistantMessage, CacheRetention, Model, ModelThinkingLevel, MutableModels, OpenAICompletionsCompat, OpenAIResponsesCompat, SimpleStreamOptions, ThinkingLevel, ToolChoice } from "@earendil-works/pi-ai";
import { DEFAULT_THINKING_BUDGETS, MIN_ANSWER_TOKENS, clampReasoning } from "@earendil-works/pi-ai/api/simple-options";
import { clampThinkingLevel } from "@earendil-works/pi-ai/models";
import type { JsonObject, ModelDelta, ModelEffort, ModelMessage, ModelResult, SamplingParams } from "../../core/ports";
import { isRecord } from "../../core/ports";
import type { Book, StoredConnection } from "./book";
import type { CallTool } from "./convert";
import { contextOf, resultOf } from "./convert";
import type { ProviderKind, SamplingName } from "./kinds";
import { kindOf, unlistedModel } from "./kinds";
import { usageEnvelope } from "./usage";
import { failureWords, redact } from "./words";

/** One call as the layer makes it: an agent's (`ModelRequest`) or a request passed through. */
export interface Job {
  connectionId: string | null;
  model: string | null;
  messages: readonly ModelMessage[];
  tools: readonly CallTool[];
  /** The most the answer may write, its reasoning included; null: the model's own most. */
  maxTokens: number | null;
  effort: ModelEffort | undefined;
  params: SamplingParams | undefined;
  /** The model may call one tool per answer at most. */
  serialTools: boolean;
  toolChoice?: ToolChoice;
  /** Fields of a passed-through request sent as they came, where the call speaks the request's own API (OpenAI's chat completions). */
  extras?: JsonObject;
  /** Hand each delta to `onDelta` as it arrives. */
  streamed: boolean;
}

/** A call's prompt cache: the session it belongs to (its cache key) and how long the provider keeps it. */
export interface CallCache {
  sessionId?: string;
  retention: CacheRetention;
}

export interface CallDeps {
  pi: MutableModels;
  book: Book;
  /** How HTTP goes out, where pi-ai's client for the API takes it. */
  fetch: typeof globalThis.fetch;
}

/** The answer room of a call that names none on a model whose own most nobody lists. Not a setting: a request passed through names its own, so this is only ever a floor under a call that forgot to. */
const UNNAMED_ROOM = 4096;

/** What a keyless call carries as its key: pi-ai's OpenAI and Anthropic clients need one, and a server that asks for none ignores it. */
const NO_KEY = "none";

/** The way a call on a connection signs: its key, the runtime's sign-in (read by pi-ai), or the key-shaped nothing of a keyless server. */
async function keyOf(book: Book, connection: StoredConnection, kind: ProviderKind): Promise<string | undefined> {
  if (connection.auth === "none") return NO_KEY;
  if (connection.auth === "signin") {
    if ((await book.signin(kind.id)) === undefined) throw new Error(`The runtime isn't signed in to ${kind.name}, which the connection "${connection.name}" uses: sign in on the Connections page.`);
    return undefined;
  }
  const key = await book.key(connection.id);
  if (key === undefined) throw new Error(`The connection "${connection.name}" has no key: add one on the Connections page.`);
  return key;
}

/**
 * The model a call goes to: its provider's catalogue entry where it lists the model, at the address
 * the connection gives where it gives one. A compatible server's model borrows how it reasons and
 * what it takes in from the catalogue that lists it under the same name (a proxy serves another
 * provider's models), but not its price, which is the server's own; nobody's is a model of
 * unknown limits.
 */
function modelFor(pi: MutableModels, kind: ProviderKind, connection: StoredConnection, id: string, room: number): Model<Api> {
  if (kind.needsBaseUrl) {
    const api = connection.api ?? kind.apis[0];
    const baseUrl = connection.baseUrl ?? "";
    const lent = kind.borrows === undefined ? undefined : pi.getModel(kind.borrows, id);
    if (lent === undefined) return unlistedModel(id, api, kind.id, baseUrl, room);
    const { compat, ...rest } = lent;
    // A definition's compatibility flags belong to its API: a server speaking another keeps its own.
    return { ...rest, ...(lent.api === api && compat !== undefined ? { compat } : {}), api, provider: kind.id, baseUrl, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } };
  }
  const listed = pi.getModel(kind.id, id) ?? unlistedModel(id, kind.apis[0], kind.id, pi.getProvider(kind.id)?.baseUrl ?? "", room);
  return connection.baseUrl !== undefined ? { ...listed, baseUrl: connection.baseUrl } : listed;
}

/** An effort as the level asked of the model; null: the provider's own default. `auto` and `inherit` are the connection's own effort. */
function askedLevel(effort: ModelEffort | undefined, connection: StoredConnection): ModelThinkingLevel | null {
  if (effort === undefined || effort === "inherit" || effort === "auto") return connection.effort ?? null;
  return effort;
}

/** Whether a model's compatibility flags say `name`: they differ in shape by API, so they are read as a record. */
function compatSays(model: Model<Api>, name: string): boolean {
  const compat: unknown = model.compat;
  return isRecord(compat) && compat[name] === true;
}

/** Sets payload fields from `values`, by the payload's own name for each, leaving out any value that isn't there. */
function setAll(payload: Record<string, unknown>, values: Partial<Record<string, unknown>>, names: Readonly<Record<string, string>>): void {
  for (const [ours, theirs] of Object.entries(names)) if (values[ours] !== undefined) payload[theirs] = values[ours];
}

/** What a call does to the request pi-ai built before it is sent: the sampling parameters its API names its own way, one tool per answer, and the fields a passed-through request sent. */
interface PayloadChanges {
  sampling: Partial<Record<SamplingName, unknown>>;
  serial: boolean;
  /** The provider's own default effort: pi-ai's switch for Gemini's thinking is taken away, so Gemini decides. */
  providerDefault: boolean;
  thinking: boolean;
  extras: JsonObject | undefined;
}

function changePayload(api: string, payload: unknown, changes: PayloadChanges): unknown {
  if (!isRecord(payload)) return undefined;
  const { sampling, serial, providerDefault, thinking, extras } = changes;
  const hasTools = Array.isArray(payload.tools) && payload.tools.length > 0;
  switch (api) {
    case "anthropic-messages":
      // Anthropic takes no top_p or top_k while its model thinks.
      if (!thinking) setAll(payload, sampling, { top_p: "top_p", top_k: "top_k" });
      setAll(payload, sampling, { stop: "stop_sequences" });
      if (serial && hasTools) payload.tool_choice = { ...(isRecord(payload.tool_choice) ? payload.tool_choice : { type: "auto" }), disable_parallel_tool_use: true };
      break;
    case "openai-completions":
    case "openai-responses":
      if (serial && hasTools) payload.parallel_tool_calls = false;
      if (api === "openai-completions" && extras !== undefined) for (const [k, v] of Object.entries(extras)) if (!(k in payload)) payload[k] = v;
      break;
    case "google-generative-ai": {
      const config = isRecord(payload.config) ? payload.config : {};
      setAll(config, sampling, { top_p: "topP", top_k: "topK", seed: "seed", stop: "stopSequences" });
      if (providerDefault) delete config.thinkingConfig;
      payload.config = config;
      break;
    }
    case "mistral-conversations":
      setAll(payload, sampling, { top_p: "topP", seed: "randomSeed", stop: "stop", frequency_penalty: "frequencyPenalty", presence_penalty: "presencePenalty" });
      if (serial && hasTools) payload.parallelToolCalls = false;
      break;
  }
  return payload;
}

/** Waits for `work`, or rejects with the signal's reason the moment it ends, whichever is first. */
function untilEnded<T>(work: Promise<T>, signal: AbortSignal): Promise<T> {
  const { promise, resolve, reject } = Promise.withResolvers<T>();
  const stop = (): void => reject(signal.reason);
  if (signal.aborted) stop();
  else signal.addEventListener("abort", stop, { once: true });
  work.then(resolve, reject).finally(() => signal.removeEventListener("abort", stop));
  return promise;
}

/** What a failed call says, refined where pi-ai's own words would mislead: a sign-in it couldn't renew. */
function failedWith(message: AssistantMessage, kind: ProviderKind): string {
  const said = message.errorMessage ?? "The model's answer ended in an error, with no words for it.";
  if (/^OAuth (?:refresh|auth derivation) failed\b/.test(said)) return `The ${kind.name} sign-in couldn't be renewed: sign in again on the Connections page.`;
  return failureWords(said);
}

/**
 * Makes one call (see the head of this file). Rejects with the signal's reason when the signal ends
 * it, with words that say what to do when its connection can't be used, and with the provider's
 * words when the call failed; no secret the runtime holds is ever in them.
 */
export async function makeCall(deps: CallDeps, job: Job, cache: CallCache, signal: AbortSignal, onDelta?: (delta: ModelDelta) => void): Promise<ModelResult> {
  if (signal.aborted) throw signal.reason;
  const { pi, book } = deps;
  try {
    const connection = await book.connection(job.connectionId);
    if (connection === null) throw new Error(job.connectionId === null ? "There is no default connection: add one on the Connections page, or pick one for this agent." : "This call's connection is no longer there: pick another on the Connections page.");
    const kind = kindOf(connection.provider);
    if (kind === undefined) throw new Error(`The connection "${connection.name}" names a provider this runtime doesn't offer.`);
    const id = job.model ?? connection.model;
    if (id === undefined || id === "") throw new Error(`The connection "${connection.name}" names no model, and neither does this call: pick one on the Connections page or in the agent's settings.`);
    const apiKey = await keyOf(book, connection, kind);
    let model = modelFor(pi, kind, connection, id, job.maxTokens ?? UNNAMED_ROOM);
    // A call never asks more room than its model can write.
    const room = Math.min(job.maxTokens ?? (model.maxTokens > 0 ? model.maxTokens : UNNAMED_ROOM), model.maxTokens > 0 ? model.maxTokens : Number.POSITIVE_INFINITY);
    const openAI = model.api === "openai-completions" || model.api === "openai-responses";
    // On OpenAI's two APIs a system message may stand anywhere, as Lumiverse's custom connections sent it, and a compatible server is sent the `system` role every server knows, not OpenAI's newer `developer`. Both APIs' flags have these fields.
    if (openAI) model = { ...model, compat: { ...(model.compat as OpenAICompletionsCompat | OpenAIResponsesCompat | undefined), supportsMidConvoSystemMessages: true, ...(kind.needsBaseUrl ? { supportsDeveloperRole: false } : {}) } };

    const asked = askedLevel(job.effort, connection);
    let reasoning: ThinkingLevel | undefined;
    if (asked === null) {
      // The provider's own default: pi-ai sends no switch for a level it has no value for.
      model = { ...model, thinkingLevelMap: { ...model.thinkingLevelMap, off: null } };
    } else {
      const level = clampThinkingLevel(model, asked);
      reasoning = level === "off" ? undefined : level;
    }
    // An Anthropic model that thinks to a budget gets the budget on top of the room it was asked for; the budget is taken out of the room instead, so the call writes no more than the core allowed.
    let budget: Pick<SimpleStreamOptions, "maxTokens" | "thinkingBudgets"> = { maxTokens: room };
    const budgetLevel = clampReasoning(reasoning);
    if (reasoning !== undefined && budgetLevel !== undefined && model.api === "anthropic-messages" && !compatSays(model, "forceAdaptiveThinking")) {
      const thinking = Math.min(DEFAULT_THINKING_BUDGETS[budgetLevel] ?? MIN_ANSWER_TOKENS, room - MIN_ANSWER_TOKENS);
      if (thinking >= MIN_ANSWER_TOKENS) budget = { maxTokens: room - thinking, thinkingBudgets: { [budgetLevel]: thinking } };
    }

    // The sampling parameters its provider takes; the rest are left out. OpenAI's reasoning models refuse a temperature or a top_p.
    const taken: Partial<Record<SamplingName, unknown>> = {};
    for (const name of kind.sampling) if (job.params?.[name] !== undefined) taken[name] = job.params[name];
    if (model.api === "openai-responses" && model.reasoning) {
      delete taken.temperature;
      delete taken.top_p;
    }
    const { temperature, ...rest } = taken;
    const target = { api: model.api, provider: model.provider, model: model.id, systemInPlace: openAI || compatSays(model, "supportsMidConvoSystemMessages") };
    const context = contextOf(job.messages, job.tools, target);
    // Under the provider's own default its model may think, so what thinking refuses is left out then too.
    const changes: PayloadChanges = { sampling: openAI ? {} : rest, serial: job.serialTools && job.tools.length > 0, providerDefault: asked === null, thinking: reasoning !== undefined || asked === null, extras: job.extras };
    const options: SimpleStreamOptions = {
      signal,
      fetch: deps.fetch,
      ...budget,
      ...(reasoning !== undefined ? { reasoning } : {}),
      ...(typeof temperature === "number" ? { temperature } : {}),
      ...(openAI && Object.keys(rest).length > 0 ? { samplingParams: rest } : {}),
      ...(apiKey !== undefined ? { apiKey } : {}),
      ...(connection.headers !== undefined ? { headers: connection.headers } : {}),
      ...(job.toolChoice !== undefined ? { toolChoice: job.toolChoice } : {}),
      cacheRetention: cache.retention,
      ...(cache.sessionId !== undefined ? { sessionId: cache.sessionId } : {}),
      maxRetries: 0,
      onPayload: (payload) => changePayload(model.api, payload, changes),
    };

    const events = pi.streamSimple(model, context, options);
    const answer = (async (): Promise<AssistantMessage> => {
      for await (const event of events) {
        if (signal.aborted || !job.streamed || onDelta === undefined) continue;
        if (event.type === "text_delta" && event.delta !== "") onDelta({ content: event.delta });
        else if (event.type === "thinking_delta" && event.delta !== "") onDelta({ reasoning: event.delta });
      }
      return events.result();
    })();
    const message = await untilEnded(answer, signal);
    if (signal.aborted) throw signal.reason;
    if (message.stopReason === "error" || message.stopReason === "aborted") throw new Error(failedWith(message, kind));
    return resultOf(message, usageEnvelope(message.usage, connection.provider, model));
  } catch (error) {
    if (signal.aborted) throw signal.reason;
    // Whatever words leave here, no key or token the runtime holds is in them.
    const secrets = await book.secretValues().catch(() => []);
    throw new Error(redact(error instanceof Error ? error.message : String(error), secrets));
  }
}
