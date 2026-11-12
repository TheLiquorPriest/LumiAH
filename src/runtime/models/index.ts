// The runtime's model layer (PI-BUILD-PLAN §4.3): every model call an agent makes, and every
// request passed through the loopback, goes from the runtime straight to its provider through
// pi-ai, on the runtime's own connections. `createModelLayer` gives the core's two ports over them
// (`models`, `connections`), the book the pages keep them with, the sign-ins to Anthropic and
// OpenAI, a connection's models for the pickers, the passthrough, and the end of an agent session's
// cache. Nothing here is the extension's: its backend runs where no call can go out.
//
// What the layer is handed (`ModelLayerDeps`) is everything it reaches the world through: its
// folder, the clock, ids, timers, `fetch`, the log, and per call the prompt cache to use.

import type { Provider } from "@earendil-works/pi-ai";
import { cleanupSessionResources } from "@earendil-works/pi-ai";
import { registerLazyOAuthFlows } from "@earendil-works/pi-ai/lazy-oauth";
import { createModels } from "@earendil-works/pi-ai/models";
import type { ConnectionInfo, ConnectionsPort, ModelDelta, ModelRequest, ModelResult, ModelsPort } from "../../core/ports";
import { isRecord } from "../../core/ports";
import type { PassedRequest } from "../openai";
import type { ConnectionInput, StoredConnection } from "./book";
import { Book } from "./book";
import type { CallCache, CallDeps, Job } from "./call";
import { makeCall } from "./call";
import { NotCarried } from "./convert";
import type { ConnectionAuth } from "./kinds";
import { KINDS, builtInProviders, kindOf } from "./kinds";
import { passedJob } from "./pass";
import type { SignIn } from "./signin";
import { SIGN_IN_MS, createSignIn } from "./signin";
import { errorWords, failureWords, redact } from "./words";

export type { ConnectionInput, StoredConnection } from "./book";
export type { CallCache } from "./call";
export type { ConnectionAuth, SignInProvider } from "./kinds";
export type { SignIn, SignInStart, SignInState } from "./signin";

export interface ModelLayerDeps {
  /** The runtime's folder (`runtimeDir`): `connections.json` and `secrets.json` live in it. */
  dir: string;
  now(): number;
  /** A new id: a connection's, a sign-in flow's. */
  id(): string;
  /** A new random UUID: this installation's id for OpenAI's sign-in, made once and kept. */
  uuid(): string;
  log(text: string): void;
  /** How HTTP goes out: a provider's calls, where pi-ai's client for its API takes it, and a server's list of models. */
  fetch: typeof globalThis.fetch;
  setTimeout(run: () => void, ms: number): unknown;
  clearTimeout(handle: unknown): void;
  /** A call's prompt cache: the agent session's key and how long the provider keeps it. A passthrough is asked with null. */
  caching(request: ModelRequest | null): CallCache;
  /** The connection a request passed through goes on (the writer's); null: the default. */
  passConnection(): Promise<string | null>;
  /** The connections the user's settings say take one tool call per answer. */
  serialTools?(): readonly string[];
  /** pi-ai providers that stand in for the built-in ones of the same id: tests give pi-ai's faux provider. */
  providers?: readonly Provider[];
  /** How long a sign-in flow stays open; `SIGN_IN_MS` when not given. */
  signInMs?: number;
}

/** A connection as the pages show it: never its key, only whether one is set and its last four characters; for a sign-in, whether the runtime is signed in. */
export interface ConnectionView extends StoredConnection {
  default: boolean;
  /** Null for a connection that signs with no key. */
  key: { set: boolean; last4: string | null } | null;
  signedIn?: boolean;
}

/** A provider the pages offer, with how its connections may sign and what they must give. */
export interface ProviderOffer {
  id: string;
  name: string;
  auth: readonly ConnectionAuth[];
  apis: readonly string[];
  needsBaseUrl: boolean;
}

export interface BookList {
  connections: ConnectionView[];
  default: string | null;
  providers: ProviderOffer[];
}

/** A test call's outcome: how long it took, and the model that answered or the provider's words. */
export type TestResult = { ok: true; ms: number; model: string } | { ok: false; ms: number; error: string };

export interface ModelChoice {
  id: string;
  name: string;
}

/** What the pages call to keep the runtime's connections. */
export interface ConnectionBook {
  list(): Promise<BookList>;
  /** Adds or changes a connection; `key` a new key, null to take it away, absent to keep it. */
  save(input: ConnectionInput, key?: string | null): Promise<ConnectionView>;
  remove(id: string): Promise<void>;
  setDefault(id: string | null): Promise<void>;
  /** One tiny call on the connection. */
  test(id: string): Promise<TestResult>;
}

export interface ModelLayer {
  models: ModelsPort;
  connections: ConnectionsPort;
  book: ConnectionBook;
  signIn: SignIn;
  /** The models a connection offers, for a picker (null: the default): its provider's catalogue, or a compatible server's own list. */
  modelsOf(connectionId: string | null): Promise<ModelChoice[]>;
  /** A request passed through the loopback (runtime/relay.ts), answered on the connection `passConnection` names. */
  pass(request: PassedRequest, signal: AbortSignal, onDelta: (delta: ModelDelta) => void): Promise<ModelResult>;
  /** An agent session ended: what pi-ai keeps for its cache (Anthropic's message threads) is let go. */
  ended(sessionId: string): void;
  /** Ends open sign-ins and waits for the files to be written. */
  close(): Promise<void>;
}

/** What a test call asks, and the room it gives: enough for any provider's smallest answer (OpenAI asks at least 16), little enough to cost nothing to speak of. */
const TEST_PROMPT = "Reply with the word OK.";
const TEST_ROOM = 64;
/** How long a test call or a server's list of models may take: past that, the page is told the provider didn't answer. */
const ASK_MS = 60_000;

/** pi-ai reads credentials from nowhere but the book: no environment variable, no file of another program's, ever signs a call. */
const NOWHERE = { env: async (): Promise<string | undefined> => undefined, fileExists: async (): Promise<boolean> => false };

function infoOf(c: StoredConnection): ConnectionInfo {
  return { id: c.id, name: c.name, provider: c.provider, model: c.model ?? null, loopback: false };
}

/** A key's last four characters, for a key long enough that they don't give it away. */
const SHOWN_FROM = 12;

export function createModelLayer(deps: ModelLayerDeps): ModelLayer {
  // pi-ai loads its sign-in flows by a path a single-file bundle can't follow; these load them from the bundle. pi-ai registers all its flows at once (its other providers' too, some 88 KB): it has no way to register two alone.
  registerLazyOAuthFlows();
  const book = new Book({ dir: deps.dir, log: deps.log });
  const pi = createModels({ credentials: book.credentials, authContext: NOWHERE });
  for (const provider of [...builtInProviders(), ...(deps.providers ?? [])]) pi.setProvider(provider);
  const callDeps: CallDeps = { pi, book, fetch: deps.fetch };
  const signIn = createSignIn({ pi, book, id: deps.id, uuid: deps.uuid, log: deps.log, setTimeout: deps.setTimeout, clearTimeout: deps.clearTimeout, signInMs: deps.signInMs ?? SIGN_IN_MS });

  /** A signal the layer's own wait ends after `ASK_MS`, and its timer's release. */
  const deadline = (why: string): { signal: AbortSignal; clear(): void } => {
    const stop = new AbortController();
    const timer = deps.setTimeout(() => stop.abort(new Error(why)), ASK_MS);
    return { signal: stop.signal, clear: () => deps.clearTimeout(timer) };
  };

  const viewOf = async (c: StoredConnection, chosen: string | null): Promise<ConnectionView> => {
    const key = c.auth === "key" ? await book.key(c.id) : undefined;
    return {
      ...c,
      default: c.id === chosen,
      key: c.auth === "key" ? { set: key !== undefined, last4: key !== undefined && key.length >= SHOWN_FROM ? key.slice(-4) : null } : null,
      ...(c.auth === "signin" ? { signedIn: (await book.signin(c.provider)) !== undefined } : {}),
    };
  };

  /** A compatible server's own list of its models (`GET …/models`, Anthropic's under `/v1`). */
  const serverModels = async (c: StoredConnection, api: string): Promise<ModelChoice[]> => {
    const key = c.auth === "key" ? await book.key(c.id) : undefined;
    const anthropic = api === "anthropic-messages";
    const signs: Record<string, string> = key === undefined ? {} : anthropic ? { "x-api-key": key } : { authorization: `Bearer ${key}` };
    const wait = deadline("The server didn't list its models within a minute.");
    try {
      const response = await deps.fetch(`${c.baseUrl ?? ""}${anthropic ? "/v1/models" : "/models"}`, { headers: { accept: "application/json", ...(anthropic ? { "anthropic-version": "2023-06-01" } : {}), ...signs, ...c.headers }, signal: wait.signal });
      const text = await response.text();
      if (!response.ok) throw new Error(failureWords(`${response.status}: ${text}`));
      const body: unknown = JSON.parse(text);
      const list: unknown[] = Array.isArray(body) ? body : isRecord(body) && Array.isArray(body.data) ? body.data : isRecord(body) && Array.isArray(body.models) ? body.models : [];
      return list.flatMap((m): ModelChoice[] => {
        if (!isRecord(m) || typeof m.id !== "string") return [];
        const name = typeof m.display_name === "string" ? m.display_name : typeof m.name === "string" ? m.name : m.id;
        return [{ id: m.id, name }];
      });
    } catch (error) {
      throw new Error(redact(`The server didn't list its models: ${errorWords(wait.signal.aborted ? wait.signal.reason : error)}`, await book.secretValues()));
    } finally {
      wait.clear();
    }
  };

  const models: ModelsPort = {
    // Two fields of the request need nothing here: pi-ai reports every call's usage, and its thinking comes back summarized wherever a provider has the choice (Anthropic's thinking display, OpenAI's reasoning summary), which is what `thinkingDisplay` asks.
    call(request, signal, onDelta) {
      const job: Job = {
        connectionId: request.connectionId,
        model: request.model,
        messages: request.messages,
        tools: request.tools ?? [],
        maxTokens: request.maxTokens,
        effort: request.effort,
        params: request.params,
        serialTools: request.parallelToolCalls === false,
        streamed: request.stream === true,
      };
      return makeCall(callDeps, job, deps.caching(request), signal, onDelta);
    },
  };

  const connections: ConnectionsPort = {
    async list() {
      return (await book.connections()).map(infoOf);
    },
    async get(connectionId) {
      const c = await book.connection(connectionId);
      if (c === null) return null;
      // Every provider offered takes several tool calls in one answer; the user may hold a connection to one.
      return { ...infoOf(c), cache: null, parallelTools: !(deps.serialTools?.() ?? []).includes(c.id) };
    },
  };

  return {
    models,
    connections,
    book: {
      async list() {
        const chosen = await book.defaultId();
        const views = await Promise.all((await book.connections()).map((c) => viewOf(c, chosen)));
        return { connections: views, default: chosen, providers: KINDS.map((k) => ({ id: k.id, name: k.name, auth: k.auth, apis: k.apis, needsBaseUrl: k.needsBaseUrl })) };
      },
      async save(input, key) {
        const saved = await book.save(input, key, deps.id);
        return viewOf(saved, await book.defaultId());
      },
      remove: (id) => book.remove(id),
      setDefault: (id) => book.setDefault(id),
      async test(id) {
        const t0 = deps.now();
        const wait = deadline("The provider didn't answer within a minute.");
        const job: Job = { connectionId: id, model: null, messages: [{ role: "user", content: TEST_PROMPT }], tools: [], maxTokens: TEST_ROOM, effort: "off", params: undefined, serialTools: false, streamed: false };
        try {
          const result = await makeCall(callDeps, job, { retention: "none" }, wait.signal);
          return { ok: true, ms: deps.now() - t0, model: result.model ?? "" };
        } catch (error) {
          return { ok: false, ms: deps.now() - t0, error: errorWords(error) };
        } finally {
          wait.clear();
        }
      },
    },
    signIn,
    async modelsOf(connectionId) {
      const c = await book.connection(connectionId);
      if (c === null) throw new Error(connectionId === null ? "There is no default connection to list models for." : "That connection is no longer there: reload the page.");
      const kind = kindOf(c.provider);
      if (kind === undefined) throw new Error(`The connection "${c.name}" names a provider this runtime doesn't offer.`);
      if (!kind.needsBaseUrl) return pi.getModels(kind.id).map((m) => ({ id: m.id, name: m.name }));
      return serverModels(c, c.api ?? kind.apis[0] ?? "");
    },
    async pass(request, signal, onDelta) {
      const connectionId = await deps.passConnection();
      const c = await book.connection(connectionId);
      const kind = c === null ? undefined : kindOf(c.provider);
      // Anthropic's API continues an assistant's message given last; the others start a new one.
      const continues = c !== null && kind !== undefined && (c.api ?? kind.apis[0]) === "anthropic-messages";
      let job: Job;
      try {
        job = passedJob(request, connectionId, continues);
      } catch (error) {
        if (!(error instanceof NotCarried)) throw error;
        throw new Error(`The runtime didn't pass this request on: ${error.message}. A request that is no reply of a chat's goes to the writer's connection whole or not at all, so that nothing of a prompt is dropped on the way.`);
      }
      return makeCall(callDeps, job, deps.caching(null), signal, onDelta);
    },
    ended(sessionId) {
      cleanupSessionResources(sessionId);
    },
    async close() {
      signIn.close();
      await book.settled();
    },
  };
}
