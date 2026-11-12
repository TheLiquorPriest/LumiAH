// The core's host (DESIGN §4.2): its model calls and connections are the runtime's own (the model
// layer, models/), and the rest are requests over the link to the extension, which reaches Lumiverse
// for them (user storage, the chat, lore, the preset, a tool that runs in the extension, the user's
// word on a held call). Anything the extension answers that takes its time comes back as a stream
// (streams.ts); the trace goes out in batches (trace.ts). A host serves one user, the one the
// runtime signed in as.
//
// A read or a write whose socket closed under it is asked again: each is safe to repeat (a blob is
// stored by its hash, a document and an anchor are written whole, a read changes nothing).
//
// Also here: what an extension that LumiAH is built into supplies to the core (`HarnessExtension`,
// DESIGN §21), as the runtime hands it over. Its code runs in its backend, so each member is a
// request too, and the runtime is the same for every extension.

import type { AgentModelChoice, ChatClaim, ExtensionDefinitions, HarnessExtension } from "../core/extension";
import type { ApprovalAnswer, ConnectionsPort, HarnessHost, JobView, JsonValue, LogLevel, ModelMessage, ModelsPort, TraceDelta, TraceRecord } from "../core/ports";
import type { ActivatedEntry, LoreBookRead, RecallChatPort, RecallLorePort, RecallPorts, TimedMessage } from "../core/recall/ports";
import type { ExtensionMember, ExtensionOffer, LinkRequests, StreamChunk } from "../link/contract";
import { isRecord } from "../link/json";
import type { RuntimeTuning } from "../link/settings";
import { LinkError } from "./connection";
import type { AskType, Asked, RuntimeLink } from "./link";
import { LOST_WAIT } from "./link";
import { LiveError } from "./lumiverse";
import type { Streams } from "./streams";
import { problemOf } from "./streams";
import type { StoragePorts } from "./store";

export interface HostDeps {
  link: RuntimeLink;
  streams: Streams;
  /** The agents' model calls and connections: the runtime's model layer, which calls each provider itself. */
  models: ModelsPort;
  connections: ConnectionsPort;
  /** 128 random bits as hex: a stream's name. */
  id(): string;
  now(): number;
  tuning(): RuntimeTuning;
  log(level: LogLevel, message: string): void;
  /** Where a trace event goes (trace.ts). */
  trace(record: TraceRecord): void;
  /** Where a call's answer goes as it arrives, for the live view (trace.ts). */
  delta(delta: TraceDelta): void;
  /** That run's chat: a preset's blocks are read as they are switched for it; null outside a run. */
  chat(): string | null;
  /** The core queued a job: the runtime runs it when its time comes (jobs.ts). */
  jobQueued(job: JobView): void;
  /** A job changed: the extension is told, for its pages. */
  jobChanged(job: JobView): void;
}

/** Why a signal ended, as an Error: its own reason when it is one. */
function reasonOf(signal: AbortSignal): Error {
  const reason: unknown = signal.reason;
  return reason instanceof Error ? reason : new Error(typeof reason === "string" ? reason : "The call was cancelled.");
}

const SAME_BUILD = "update the runtime and LumiAH to the same build";

function toolOutcomeOf(value: JsonValue): { text: string; error?: boolean } | null {
  if (!isRecord(value) || typeof value.text !== "string") return null;
  return value.error === true ? { text: value.text, error: true } : { text: value.text };
}

function approvalAnswerOf(value: JsonValue): ApprovalAnswer | null {
  if (!isRecord(value)) return null;
  if (value.decision === "once" || value.decision === "chat") return { decision: value.decision };
  if (value.decision === "refused") return typeof value.reason === "string" && value.reason !== "" ? { decision: "refused", reason: value.reason } : { decision: "refused" };
  return null;
}

/**
 * What a backend answers a request it doesn't know, in every build there has been: the link has
 * no code of its own for it. One from before the recall ports and the book (DESIGN §23, §24)
 * answers their requests so.
 */
const NO_SUCH_REQUEST = /^There is no link request /;

/** Whether a request failed because the backend knows no such request: it is an older build than the runtime. */
function unknownRequest(error: unknown): boolean {
  const cause: unknown = error instanceof Error ? error.cause : undefined;
  return cause instanceof LinkError && cause.code === "bad_request" && NO_SUCH_REQUEST.test(cause.message);
}

/**
 * A request's answer, given up when its caller's signal ends: the caller is let go at once and the
 * answer is dropped when it comes. A request can't be taken back at the extension, as a stream can.
 */
function letGo<T>(work: () => Promise<T>, signal: AbortSignal | undefined): Promise<T> {
  if (signal === undefined) return work();
  if (signal.aborted) return Promise.reject(reasonOf(signal));
  const { promise, resolve, reject } = Promise.withResolvers<T>();
  const ended = (): void => reject(reasonOf(signal));
  signal.addEventListener("abort", ended, { once: true });
  work()
    .then(resolve, reject)
    .finally(() => signal.removeEventListener("abort", ended));
  return promise;
}

/** One request, asked again while its socket closes under it and the link's allowance (Extension lost after, which its words name when it runs out) lasts. */
export async function asked<T extends AskType>(deps: Pick<HostDeps, "link" | "now" | "tuning">, type: T, fields: Asked<T>): Promise<LinkRequests[T]["result"]> {
  const first = deps.now();
  for (;;) {
    const wait = deps.tuning().lostMs;
    try {
      return await deps.link.request(type, fields, wait, LOST_WAIT);
    } catch (error) {
      if (error instanceof LiveError && error.problem === "closed" && deps.now() - first < wait) continue;
      // The ports' callers read a failure's words, so they are the ones a person can act on.
      throw new Error(problemOf(error).message, { cause: error });
    }
  }
}

/**
 * The extension's storage, over the link (`doc.*`, `blob.*`): where the core's documents and blobs
 * are kept for good. The runtime's working store (store/) keeps its own copy and mirrors it here, its
 * writes naming the process that holds the mirror (`mirror`), which the extension takes only from
 * that one, and how long ago each document's change was made (`ago`); without `mirror`, they are the
 * runtime's own, as a runtime that keeps no copy writes.
 */
export function linkStorage(deps: Pick<HostDeps, "link" | "now" | "tuning">, mirror?: string): StoragePorts {
  const ask = <T extends AskType>(type: T, fields: Asked<T>): Promise<LinkRequests[T]["result"]> => asked(deps, type, fields);
  const as = mirror === undefined ? {} : { mirror };
  return {
    blobs: {
      put: async (hash, text) => {
        await ask("blob.put", { hash, text, ...as });
      },
      get: async (hash) => (await ask("blob.get", { hash })).text,
      list: async (cursor) => {
        const page = await ask("blob.list", { cursor: cursor ?? null });
        return { blobs: page.blobs, next: page.next };
      },
      remove: async (hashes) => {
        if (hashes.length > 0) await ask("blob.remove", { hashes: [...hashes], ...as });
      },
    },
    store: {
      read: async (path) => (await ask("doc.get", { path })).doc,
      write: async (path, value, ago) => {
        await ask("doc.put", { path, doc: value, ...as, ...(ago === undefined ? {} : { ago }) });
      },
      remove: async (path, ago) => {
        await ask("doc.remove", { path, ...as, ...(ago === undefined ? {} : { ago }) });
      },
      list: async (prefix) => (await ask("doc.list", { prefix })).paths,
    },
  };
}

/** Whether the extension refused a write of the working copy's because this runtime doesn't hold the mirror (another does now, or none): the copy ends, as when the extension says so on a hello or a push. */
export function withdrawn(error: unknown): boolean {
  const cause: unknown = error instanceof Error ? error.cause : undefined;
  return cause instanceof LinkError && cause.code === "conflict";
}

/**
 * Whether the extension refused a request by a rule of its own that asking again doesn't change:
 * a request it doesn't take (`bad_request`), a frame larger than the largest it puts together
 * (`too_large`), or a working copy's change older than another runtime's later write of the
 * document (`superseded`). A lack of room just now (`unavailable`), a link that dropped and every
 * other failure pass, and are asked again.
 */
export function refusedForGood(error: unknown): boolean {
  const cause: unknown = error instanceof Error ? error.cause : undefined;
  return cause instanceof LinkError && (cause.code === "bad_request" || cause.code === "too_large" || cause.code === "superseded");
}

/**
 * Whether the extension refused a storage request because it doesn't know this runtime any more
 * (forgotten on the Runtime page, or registered anew by `lumiah up`): its secret speaks for nothing
 * now, and no wait mends that while this process runs. A storage request carries no key, so its
 * `forbidden` says nothing else.
 */
export function unknownRuntime(error: unknown): boolean {
  const cause: unknown = error instanceof Error ? error.cause : undefined;
  return cause instanceof LinkError && cause.code === "forbidden";
}

/** The core's host over the link, with the recall ports' lore and chat reads it always carries named: the runtime's copy answers those in its place (reads.ts). */
export type LinkedHost = HarnessHost & { recall: RecallPorts & { lore: RecallLorePort; chat: RecallChatPort } };

export function linkHost(deps: HostDeps): LinkedHost {
  const { link, streams } = deps;
  const ask = <T extends AskType>(type: T, fields: Asked<T>): Promise<LinkRequests[T]["result"]> => asked(deps, type, fields);

  /**
   * Something the extension answers on a stream: started by `send`, read by `take`, which settles it
   * with the stream's one chunk. The signal gives it up: the stream is cancelled at the
   * extension, and the promise rejects with the signal's reason. `patient`: it waits on a person, so
   * silence is no stall.
   */
  function streamed<T>(signal: AbortSignal, send: (stream: string) => Promise<unknown>, take: (chunk: StreamChunk, settle: { resolve(value: T): void; reject(error: Error): void }) => void, patient = false): Promise<T> {
    if (signal.aborted) return Promise.reject(reasonOf(signal));
    const stream = deps.id();
    const { promise, resolve, reject } = Promise.withResolvers<T>();
    const cancel = (): void => {
      streams.cancel(stream, "cancelled");
      reject(reasonOf(signal));
    };
    signal.addEventListener("abort", cancel, { once: true });
    const settle = {
      resolve: (value: T): void => {
        signal.removeEventListener("abort", cancel);
        resolve(value);
      },
      reject: (error: Error): void => {
        signal.removeEventListener("abort", cancel);
        reject(error);
      },
    };
    streams.start(stream, { chunk: (chunk) => take(chunk, settle) }, () => send(stream), patient);
    return promise;
  }

  /** Something that ends with one value: a tool's run in the extension, the user's word on a held call. */
  function valued<T>(what: string, signal: AbortSignal, send: (stream: string) => Promise<unknown>, read: (value: JsonValue) => T | null, patient: boolean): Promise<T> {
    return streamed<T>(
      signal,
      send,
      (chunk, settle) => {
        if (chunk.kind === "value") {
          const value = read(chunk.value);
          if (value === null) settle.reject(new Error(`LumiAH answered ${what} with something else: ${SAME_BUILD}.`));
          else settle.resolve(value);
        } else settle.reject(new Error(chunk.message));
      },
      patient,
    );
  }

  /**
   * A read of the recall ports or the book, which a backend from before them doesn't know: what it
   * answers; or, where it says it knows no such request, what `without` gives in its place (what
   * the older requests read, or that nothing is set up), so an older backend costs a turn nothing
   * it had before. Asked every time: a backend updated under a running runtime answers from then on.
   */
  async function since<T extends AskType, R>(type: T, fields: Asked<T>, read: (result: LinkRequests[T]["result"]) => R, without: () => R | Promise<R>): Promise<R> {
    try {
      return read(await ask(type, fields));
    } catch (error) {
      if (!unknownRequest(error)) throw error;
      return without();
    }
  }

  return {
    models: {
      ...deps.models,
      // What the model library kept for an agent's session is let go once its run has ended: housekeeping after the run's work, so a letting-go that throws is logged as such, and neither the run's end nor what follows it (the other sessions, its spend, its record) is touched.
      ended: (session) => {
        try {
          deps.models.ended?.(session);
        } catch (error) {
          deps.log("warn", `what the model library kept for agent session ${session} couldn't be let go after its run (${error instanceof Error ? error.message : String(error)}). This is housekeeping only: the run stands as it ended.`);
        }
      },
    },
    connections: deps.connections,
    ...linkStorage(deps),
    chat: {
      path: async (chatId) => (await ask("chat.path", { chat: chatId })).messages,
      messages: async (chatId, from, to) => (await ask("chat.messages", { chat: chatId, from, to })).messages,
      anchor: async (chatId, messageId, swipeId, record) => (await ask("chat.anchor", { chat: chatId, message: messageId, swipe: swipeId, record })).written,
      info: async (chatId) => (await ask("chat.info", { chat: chatId })).chat,
      anchors: async (cursor) => {
        const page = await ask("chat.anchors", { cursor: cursor ?? null });
        return { anchors: page.anchors, next: page.next };
      },
    },
    lore: {
      books: async (chatId) => (await ask("lore.books", { chat: chatId })).books,
      entries: async (bookId) => (await ask("lore.entries", { book: bookId })).entries,
      activated: async (chatId, generationId) => (await ask("lore.activated", { chat: chatId, generation: generationId })).entries,
    },
    preset: {
      blocks: async (presetId) => (await ask("preset.blocks", { preset: presetId, chat: deps.chat() })).blocks,
    },
    book: {
      read: (chatId) => since("book.read", { chat: chatId }, (r) => r.book, () => null),
    },
    recall: {
      lore: {
        read: (chatId, known) =>
          since("recall.lore.read", { chat: chatId, known: { ...known } }, (r) => r.books, async (): Promise<LoreBookRead[]> => {
            // As the core itself reads lore from a host without this port: the books and their entries, with no state beside.
            const { books } = await ask("lore.books", { chat: chatId });
            return Promise.all(books.map(async (book) => ({ ...book, source: null, updatedAt: 0, entries: (await ask("lore.entries", { book: book.id })).entries.map((e) => ({ ...e, vectorized: false, regex: false, role: null, order: 0, updatedAt: 0 })) })));
          }),
        activated: (chatId, generationId) =>
          since(
            "recall.lore.activated",
            { chat: chatId, generation: generationId },
            (r) => r.entries,
            async (): Promise<ActivatedEntry[]> => (await ask("lore.activated", { chat: chatId, generation: generationId })).entries.map((e) => ({ entryId: e.entryId, bookId: e.bookId, title: e.title, how: null, content: e.content })),
          ),
      },
      chat: {
        messages: (chatId, from, to) =>
          since(
            "recall.chat.messages",
            { chat: chatId, from, to },
            (r) => r.messages,
            async (): Promise<TimedMessage[]> => (await ask("chat.messages", { chat: chatId, from, to })).messages.map((m) => ({ ...m, at: null })),
          ),
      },
      embeddings: {
        connection: () => since("recall.embedder", {}, (r) => r.connection, () => null),
        embed: (texts, kind, signal) => letGo(() => ask("recall.embed", { texts: [...texts], kind }), signal),
      },
      memory: {
        enabled: (chatId) => since("recall.memory.enabled", { chat: chatId }, (r) => r.enabled, () => false),
        search: (chatId, query, options, signal) => letGo(() => since("recall.memory.search", { chat: chatId, query, limit: options.limit, entities: [...(options.entities ?? [])] }, (r) => r.hits, () => []), signal),
        entity: (chatId, name) => since("recall.memory.entity", { chat: chatId, name }, (r) => r.entity, () => null),
        entities: (chatId, limit) => since("recall.memory.entities", { chat: chatId, limit }, (r) => r.entities, () => []),
        arcs: (chatId) => since("recall.memory.arcs", { chat: chatId }, (r) => r.arcs, () => []),
      },
      databanks: {
        list: (chatId) => since("recall.databanks.list", { chat: chatId }, (r) => r.databanks, () => []),
        documents: (databankId) => since("recall.databanks.documents", { databank: databankId }, (r) => r.documents, () => []),
        content: (documentId) => since("recall.databanks.content", { document: documentId }, (r) => r.text, () => null),
      },
      web: {
        enabled: () => since("recall.web.enabled", {}, (r) => r.enabled, () => false),
        search: (query, options, signal) => letGo(() => since("recall.web.search", { query, count: options.count, pages: options.pages }, (r) => r.results, () => []), signal),
      },
    },
    tools: {
      list: async (chatId) => (await ask("tools.list", { chat: chatId })).tools,
      call: (toolCall, signal) => valued("a tool's call", signal, (stream) => link.request("tool.call", { stream, call: toolCall }, deps.tuning().lostMs, LOST_WAIT), toolOutcomeOf, false),
    },
    approvals: {
      ask: (held, signal) => valued("a held call", signal, (stream) => link.request("approval.ask", { stream, ask: held }, deps.tuning().lostMs, LOST_WAIT), approvalAnswerOf, true),
    },
    jobs: { queued: (job) => deps.jobQueued(job), changed: (job) => deps.jobChanged(job) },
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

export interface ExtensionDeps {
  link: RuntimeLink;
  now(): number;
  tuning(): RuntimeTuning;
  /** What the extension said it supplies on the link's last hello; null: nothing (LumiAH on its own). */
  offer(): ExtensionOffer | null;
}

function messagesOf(value: JsonValue | undefined): ModelMessage[] | null {
  if (!Array.isArray(value)) return null;
  // The extension's own rewrite of the writer's request: its messages are taken as it gave them once each has a role and a text.
  return value.every((m) => isRecord(m) && typeof m.role === "string" && typeof m.content === "string") ? (value as unknown as ModelMessage[]) : null;
}

/**
 * What the extension LumiAH is built into supplies to the core, over the link. A member the
 * extension said it doesn't have is answered here as the core takes "not supplied" (no definitions,
 * no claim, the request as the core built it, the definition's own model, a passage let go, nothing
 * for a hook), without a request. What reads (its definitions, a claim, the writer's request, an
 * agent's model) is asked again after a socket that closed under it. A hook, and the check before a
 * passage goes out (`releasing`, which may do work in the extension), are sent once, so the
 * extension never hears one twice: one whose answer is lost fails, as the core takes a check that
 * failed.
 */
export function linkExtension(deps: ExtensionDeps): HarnessExtension {
  const has = (member: ExtensionMember): boolean => deps.offer()?.members.includes(member) === true;

  async function read(member: ExtensionMember, arg: JsonValue): Promise<JsonValue | undefined> {
    if (!has(member)) return undefined;
    const answer = await asked(deps, "extension.call", { member, arg });
    return answer.supplied ? answer.value : undefined;
  }

  /** Sent once: its answer (undefined where it has none), or a failure in the link's words. */
  async function once(member: ExtensionMember, arg: JsonValue): Promise<JsonValue | undefined> {
    if (!has(member)) return undefined;
    try {
      const answer = await deps.link.request("extension.call", { member, arg }, deps.tuning().lostMs, LOST_WAIT);
      return answer.supplied ? answer.value : undefined;
    } catch (error) {
      throw new Error(problemOf(error).message, { cause: error });
    }
  }

  async function tell(member: ExtensionMember, arg: JsonValue): Promise<void> {
    await once(member, arg);
  }

  // What the core hands a member is JSON by its contract (extension.ts); the cast says so to the link.
  const json = (value: unknown): JsonValue => value as JsonValue;

  return {
    get name() {
      return deps.offer()?.name ?? "LumiAH";
    },
    // Each ask goes as the core made it; the backend takes the user from the runtime's own registration, whatever an ask names.
    definitions: async (ask) => {
      const value = await read("definitions", json(ask));
      return isRecord(value) ? (value as unknown as ExtensionDefinitions) : {};
    },
    claim: async (ask) => {
      const value = await read("claim", json(ask));
      return isRecord(value) ? (value as unknown as ChatClaim) : null;
    },
    writerRequest: async (request) => messagesOf(await read("writerRequest", json(request))),
    agentModel: async (ask) => {
      const value = await read("agentModel", json(ask));
      return isRecord(value) ? (value as unknown as AgentModelChoice) : null;
    },
    runBegan: (run) => tell("runBegan", json(run)),
    releasing: async (release) => {
      const value = await once("releasing", json(release));
      return isRecord(value) && typeof value.refused === "string" ? { refused: value.refused } : null;
    },
    released: (release) => tell("released", json(release)),
    replyWritten: (reply) => tell("replyWritten", json(reply)),
    runEnded: (run) => tell("runEnded", json(run)),
  };
}
