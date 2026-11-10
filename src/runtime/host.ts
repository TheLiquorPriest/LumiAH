// The core's host (DESIGN §4.2), implemented over the link: every port is a request to the extension,
// which reaches Lumiverse for it (a model call on the user's connection, user storage, the chat, lore,
// the preset). A model call's answer comes back as a stream (streams.ts); the trace goes out in
// batches (trace.ts). A host serves one user, the one the runtime signed in as.
//
// A read or a write whose socket closed under it is asked again: each is safe to repeat (a blob is
// stored by its hash, a document and an anchor are written whole, a read changes nothing).

import type { HarnessHost, LogLevel, ModelDelta, ModelRequest, ModelResult, TraceDelta, TraceRecord } from "../core/ports";
import type { LinkRequests } from "../link/contract";
import type { RuntimeTuning } from "../link/settings";
import type { AskType, Asked, RuntimeLink } from "./link";
import { LiveError } from "./lumiverse";
import type { Streams } from "./streams";
import { problemOf } from "./streams";

/** A model call that failed, with the provider's or Lumiverse's own words as its message and the link's code for what failed. */
export class ModelCallError extends Error {
  constructor(
    message: string,
    readonly code: string,
  ) {
    super(message);
    this.name = "ModelCallError";
  }
}

export interface HostDeps {
  link: RuntimeLink;
  streams: Streams;
  /** 128 random bits as hex: a stream's name. */
  id(): string;
  now(): number;
  tuning(): RuntimeTuning;
  log(level: LogLevel, message: string): void;
  /** Where a trace event goes (trace.ts). */
  trace(record: TraceRecord): void;
  /** Where a call's answer goes as it arrives, for the live view (trace.ts). */
  delta(delta: TraceDelta): void;
  /** The turn the caller works for, so the extension can end its calls when Lumiverse stops it; null outside one. */
  turn(): string | null;
  /** That turn's chat: a preset's blocks are read as they are switched for it; null outside a turn. */
  chat(): string | null;
}

/** Why a signal ended, as an Error: its own reason when it is one. */
function reasonOf(signal: AbortSignal): Error {
  const reason: unknown = signal.reason;
  return reason instanceof Error ? reason : new Error(typeof reason === "string" ? reason : "The call was cancelled.");
}

export function linkHost(deps: HostDeps): HarnessHost {
  const { link, streams } = deps;

  /** One request of a port, asked again while its socket closes under it and the link's allowance lasts. */
  async function ask<T extends AskType>(type: T, fields: Asked<T>): Promise<LinkRequests[T]["result"]> {
    const first = deps.now();
    for (;;) {
      const wait = deps.tuning().lostMs;
      try {
        return await link.request(type, fields, wait);
      } catch (error) {
        if (error instanceof LiveError && error.problem === "closed" && deps.now() - first < wait) continue;
        // The ports' callers read a failure's words, so they are the ones a person can act on.
        throw new Error(problemOf(error).message, { cause: error });
      }
    }
  }

  function call(request: ModelRequest, signal: AbortSignal, onDelta?: (delta: ModelDelta) => void): Promise<ModelResult> {
    if (signal.aborted) return Promise.reject(reasonOf(signal));
    const stream = deps.id();
    const turn = deps.turn();
    const { promise, resolve, reject } = Promise.withResolvers<ModelResult>();
    const cancel = (): void => {
      streams.cancel(stream, "cancelled");
      reject(reasonOf(signal));
    };
    signal.addEventListener("abort", cancel, { once: true });
    streams.start(
      stream,
      {
        chunk: (chunk) => {
          switch (chunk.kind) {
            case "content":
              onDelta?.({ content: chunk.text });
              return;
            case "reasoning":
              onDelta?.({ reasoning: chunk.text });
              return;
            case "done":
              signal.removeEventListener("abort", cancel);
              resolve(chunk.result);
              return;
            case "error":
              signal.removeEventListener("abort", cancel);
              reject(new ModelCallError(chunk.message, chunk.code));
              return;
          }
        },
      },
      () => link.request("model.call", { stream, turn, request }, deps.tuning().lostMs),
    );
    return promise;
  }

  return {
    models: { call },
    connections: {
      list: async () => (await ask("connections.list", {})).connections,
      get: async (connectionId) => (await ask("connections.get", { connection: connectionId })).profile,
    },
    blobs: {
      put: async (hash, text) => {
        await ask("blob.put", { hash, text });
      },
      get: async (hash) => (await ask("blob.get", { hash })).text,
    },
    store: {
      read: async (path) => (await ask("doc.get", { path })).doc,
      write: async (path, value) => {
        await ask("doc.put", { path, doc: value });
      },
      remove: async (path) => {
        await ask("doc.remove", { path });
      },
    },
    chat: {
      path: async (chatId) => (await ask("chat.path", { chat: chatId })).messages,
      messages: async (chatId, from, to) => (await ask("chat.messages", { chat: chatId, from, to })).messages,
      anchor: async (chatId, messageId, swipeId, record) => (await ask("chat.anchor", { chat: chatId, message: messageId, swipe: swipeId, record })).written,
    },
    lore: {
      books: async (chatId) => (await ask("lore.books", { chat: chatId })).books,
      entries: async (bookId) => (await ask("lore.entries", { book: bookId })).entries,
      activated: async (chatId, generationId) => (await ask("lore.activated", { chat: chatId, generation: generationId })).entries,
    },
    preset: {
      blocks: async (presetId) => (await ask("preset.blocks", { preset: presetId, chat: deps.chat() })).blocks,
    },
    trace: { event: (record) => deps.trace(record), delta: (delta) => deps.delta(delta) },
    clock: {
      now: deps.now,
      sleep: (ms, signal) => {
        if (signal.aborted) return Promise.reject(reasonOf(signal));
        const { promise, resolve, reject } = Promise.withResolvers<void>();
        const ended = (): void => {
          clearTimeout(timer);
          reject(reasonOf(signal));
        };
        const timer = setTimeout(() => {
          signal.removeEventListener("abort", ended);
          resolve();
        }, ms);
        signal.addEventListener("abort", ended, { once: true });
        return promise;
      },
    },
    log: deps.log,
  };
}
