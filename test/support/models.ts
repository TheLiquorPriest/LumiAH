// The models behind a test's runtime: the runtime's own model layer (src/runtime/models) with its
// providers scripted. Every provider the runtime offers is stood in for by one that answers from the
// made-up host's script (`FakeHost.script`), each answer streamed the way the host's scripted model
// streamed it before the runtime called its providers itself: its reasoning, then its text a word
// (or a scripted delta) at a time, then its tool calls. Nothing reaches the network.
//
// What the layer was asked is kept in `host.calls` (an agent's call, a request passed through, with
// the connection the writer names), what each provider was then sent in `host.providerCalls` (the
// key it carried and the messages among it), the agent sessions that ended in `host.endedSessions`,
// and a call its signal ended (a `hang` answer stopped) counts in `host.cancelled`. A connection's
// Test is answered "OK" by its provider, and kept there too.
//
// The runtime's folder starts as a user's would after adding a connection on the Runtime page: its
// connections and their keys on its disk, the first one the default (`MAIN` unless a test gives
// others, or none).

import { AsyncLocalStorage } from "node:async_hooks";
import { existsSync, writeFileSync } from "node:fs";
import type { Api, AssistantMessage, AssistantMessageEventStream, Message, Model, Provider, SimpleStreamOptions, StopReason, Usage } from "@earendil-works/pi-ai";
import { createAssistantMessageEventStream, createProvider } from "@earendil-works/pi-ai";
import type { JsonObject } from "../../src/core/ports";
import { isRecord } from "../../src/core/ports";
import type { ModelLayer, ModelLayerDeps } from "../../src/runtime/models";
import { createModelLayer } from "../../src/runtime/models";
import { builtInProviders } from "../../src/runtime/models/kinds";
import type { Answer, FakeHost, MadeCall } from "./fake-host";

/** A connection the runtime's folder holds when the test starts: signed with a made-up key. */
export interface SeedConnection {
  id: string;
  name: string;
  provider: string;
  model?: string;
  effort?: string;
  baseUrl?: string;
  key: string;
}

/** Mara's own connection, the runtime's default: the one every agent runs on unless a test says otherwise. */
export const MAIN: SeedConnection = { id: "conn-main", name: "Main", provider: "openai", model: "model-main", key: "sk-made-up-main-0123456789abcdef" };

/** Writes the runtime's two files as the book keeps them: its connections, the first the default, and their keys. A folder that has them already (a runtime started again on the same machine) keeps its own. */
function seed(dir: string, connections: readonly SeedConnection[]): void {
  if (connections.length === 0 || existsSync(`${dir}/connections.json`)) return;
  const listed = connections.map(({ key: _key, ...c }) => ({ ...c, auth: "key" }));
  writeFileSync(`${dir}/connections.json`, JSON.stringify({ lumiah: 1, default: connections[0]?.id ?? null, connections: listed }), { mode: 0o600 });
  writeFileSync(`${dir}/secrets.json`, JSON.stringify({ lumiah: 1, keys: Object.fromEntries(connections.map((c) => [c.id, c.key])), signins: {} }), { mode: 0o600 });
}

/** One answer of the script, read: its text alone becomes its content. */
type Scripted = Exclude<Answer, string>;

/** The call a provider is answering: the host whose script it plays, and the answer the script gave. */
interface Playing {
  host: FakeHost;
  answer: Scripted;
}

/** Which call of the layer's a provider's stream belongs to: set around each call, read where the provider is asked. */
const playing = new AsyncLocalStorage<Playing>();

/** What a scripted answer spent, as a provider reports it: the script's own counts in OpenAI's shape, else 120 in and 30 out. */
function usageOf(raw: JsonObject | undefined): Usage {
  const count = (value: unknown): number => (typeof value === "number" ? value : 0);
  const usage = raw ?? { prompt_tokens: 120, completion_tokens: 30, total_tokens: 150 };
  const cached = isRecord(usage.prompt_tokens_details) ? count(usage.prompt_tokens_details.cached_tokens) : 0;
  const input = count(usage.prompt_tokens) - cached;
  const output = count(usage.completion_tokens);
  return { input, output, cacheRead: cached, cacheWrite: 0, totalTokens: input + cached + output, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } };
}

/** Waits for the signal to end; never, without one. */
function ended(signal: AbortSignal | undefined): Promise<void> {
  const { promise, resolve } = Promise.withResolvers<void>();
  if (signal?.aborted) resolve();
  else signal?.addEventListener("abort", () => resolve(), { once: true });
  return promise;
}

/** Streams one scripted answer as a provider does: it starts, its reasoning, its text in pieces, its tool calls, and its end; waiting, where the script says, after its reasoning and after each piece of its text. */
async function play(out: AssistantMessageEventStream, model: Model<Api>, messages: Message[], options: SimpleStreamOptions | undefined, now: Playing): Promise<void> {
  const { host, answer } = now;
  host.providerCalls.push({ provider: model.provider, model: model.id, api: model.api, key: options?.apiKey ?? null, reasoning: options?.reasoning ?? null, sessionId: options?.sessionId ?? null, cacheRetention: options?.cacheRetention ?? null, maxTokens: options?.maxTokens ?? null, messages: clone(messages) });
  // The script's waits in order; with none left, a piece takes at least a turn of the event loop, as a provider's next does.
  const waits = [...(answer.waits ?? [])];
  const calls = answer.toolCalls ?? [];
  const stopReason: StopReason = answer.finishReason === "length" ? "length" : calls.length > 0 ? "toolUse" : "stop";
  const message: AssistantMessage = { role: "assistant", content: [], api: model.api, provider: model.provider, model: model.id, usage: usageOf(answer.usage), stopReason, timestamp: Date.now() };
  const partial = (): AssistantMessage => ({ ...message, content: [...message.content] });
  out.push({ type: "start", partial: partial() });
  if (answer.hang) {
    await ended(options?.signal);
    host.cancelled++;
    const aborted: AssistantMessage = { ...message, stopReason: "aborted", errorMessage: "Request was aborted" };
    out.push({ type: "error", reason: "aborted", error: aborted });
    out.end(aborted);
    return;
  }
  if (answer.reasoning !== undefined) {
    const at = message.content.length;
    message.content.push({ type: "thinking", thinking: answer.reasoning });
    out.push({ type: "thinking_start", contentIndex: at, partial: partial() });
    out.push({ type: "thinking_delta", contentIndex: at, delta: answer.reasoning, partial: partial() });
    out.push({ type: "thinking_end", contentIndex: at, content: answer.reasoning, partial: partial() });
    await (waits.shift() ?? Promise.resolve());
  }
  const content = answer.content ?? "";
  const pieces = answer.deltas ?? (content === "" ? [] : (content.match(/\S+\s*/g) ?? [content]));
  if (content !== "" || pieces.length > 0) {
    const at = message.content.length;
    message.content.push({ type: "text", text: content });
    out.push({ type: "text_start", contentIndex: at, partial: partial() });
    for (const piece of pieces) {
      // Each piece is its own delta, as the provider sent it: what reads them sees it before the answer ends.
      if (options?.signal?.aborted) break;
      out.push({ type: "text_delta", contentIndex: at, delta: piece, partial: partial() });
      await (waits.shift() ?? Promise.resolve());
    }
    out.push({ type: "text_end", contentIndex: at, content, partial: partial() });
  }
  for (const call of calls) {
    const at = message.content.length;
    const block = { type: "toolCall" as const, id: call.callId, name: call.name, arguments: call.args, ...(call.thoughtSignature !== undefined ? { thoughtSignature: call.thoughtSignature } : {}) };
    message.content.push(block);
    out.push({ type: "toolcall_start", contentIndex: at, partial: partial() });
    out.push({ type: "toolcall_end", contentIndex: at, toolCall: block, partial: partial() });
  }
  if (answer.error !== undefined) {
    const failed: AssistantMessage = { ...message, stopReason: "error", errorMessage: answer.error };
    out.push({ type: "error", reason: "error", error: failed });
    out.end(failed);
    return;
  }
  out.push({ type: "done", reason: stopReason === "length" ? "length" : stopReason === "toolUse" ? "toolUse" : "stop", message });
  out.end(message);
}

/** Every provider the runtime offers, each with its own catalogue and sign-in, and each answering a call from the script of the call it is asked for. */
function scriptedProviders(): Provider[] {
  const streams = (model: Model<Api>, context: { messages: Message[] }, options?: SimpleStreamOptions): AssistantMessageEventStream => {
    const out = createAssistantMessageEventStream();
    const now = playing.getStore();
    if (now === undefined) throw new Error("a provider was asked for a call the test's layer didn't make");
    void play(out, model, context.messages, options, now).catch((error: unknown) => {
      const failed: AssistantMessage = { role: "assistant", content: [], api: model.api, provider: model.provider, model: model.id, usage: usageOf(undefined), stopReason: "error", errorMessage: error instanceof Error ? error.message : String(error), timestamp: Date.now() };
      out.push({ type: "error", reason: "error", error: failed });
      out.end(failed);
    });
    return out;
  };
  return builtInProviders().map((p) => createProvider({ id: p.id, name: p.name, auth: p.auth, models: [...p.getModels()], api: { stream: streams, streamSimple: streams } }));
}

const clone = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;

/**
 * What builds a test runtime's model layer (`RuntimeDeps.models`): the real layer over the runtime's
 * folder, seeded with `connections`, its providers answering from `host`'s script, each call kept
 * (see the head of this file). `userId`: whose runtime it is, as the calls are kept.
 */
export function scriptedModels(host: FakeHost, userId: string, connections: readonly SeedConnection[] = [MAIN]): (deps: ModelLayerDeps) => ModelLayer {
  return (deps) => {
    seed(deps.dir, connections);
    const layer = createModelLayer({ ...deps, providers: scriptedProviders() });
    /** The script's answer for the call, which is kept first: what a call ended before it began still shows it was asked. */
    const scripted = async (made: MadeCall, signal: AbortSignal): Promise<Scripted> => {
      const n = host.calls.length;
      host.calls.push(clone(made));
      signal.throwIfAborted();
      const answer = typeof host.script === "function" ? await host.script(made, n) : host.script[n];
      if (answer === undefined) throw new Error(`no answer scripted for call ${n + 1}`);
      return typeof answer === "string" ? { content: answer } : answer;
    };
    return {
      ...layer,
      models: {
        call: async (request, signal, onDelta) => {
          const answer = await scripted({ kind: "call", userId, request }, signal);
          return playing.run({ host, answer }, () => layer.models.call(request, signal, onDelta));
        },
        ended: (session) => {
          host.endedSessions.push(session);
          layer.models.ended?.(session);
        },
      },
      // A request passed through is kept once the layer made it ready and it runs: one the layer refused was never sent, and asks nothing of the script.
      passing: async (request) => {
        const ready = await layer.passing(request);
        return {
          connectionId: ready.connectionId,
          run: async (signal, onDelta) => {
            const answer = await scripted({ kind: "pass", userId, request: { connectionId: await deps.passConnection(), ...request } }, signal);
            return playing.run({ host, answer }, () => ready.run(signal, onDelta));
          },
        };
      },
      // A connection's Test is a call of the layer's own, answered by its provider with a word.
      book: { ...layer.book, test: (id) => playing.run({ host, answer: { content: "OK" } }, () => layer.book.test(id)) },
    };
  };
}
