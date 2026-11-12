// The runtime's model layer (PI-BUILD-PLAN §4.3): every model call an agent makes, and every
// request passed through the loopback, goes from the runtime straight to its provider through
// pi-ai, on the runtime's own connections. `createModelLayer` gives the core's two ports over them
// (`models`, `connections`), the book the pages keep them with, the sign-ins to Anthropic and
// OpenAI, a connection's models for the pickers, the passthrough, and the end of an agent session's
// cache. Nothing here is the extension's: its backend runs where no call can go out.
//
// What the layer is handed (`ModelLayerDeps`) is everything it reaches the world through: its
// folder, the clock, ids, timers, `fetch`, the log, the environment it takes the SDKs' own settings
// out of, per call the prompt cache to use, and its two waits (how long a stream may go silent, how
// long a provider may take to answer a connection's test or list its models), each a setting of the
// runtime's whose name and place its words give when it runs out.

import type { Provider } from "@earendil-works/pi-ai";
import { cleanupSessionResources } from "@earendil-works/pi-ai";
import { registerLazyOAuthFlows } from "@earendil-works/pi-ai/lazy-oauth";
import { createModels } from "@earendil-works/pi-ai/models";
import type { ConnectionInfo, ConnectionsPort, ModelDelta, ModelRequest, ModelResult, ModelsPort } from "../../core/ports";
import { isRecord } from "../../core/ports";
import { OWN_BACKEND } from "../../link/contract";
import { RUNTIME_DEFAULTS } from "../../link/settings";
import { transportWait } from "../../link/waits";
import type { SettingsOwner } from "../../shared/timeouts";
import type { PassedRequest } from "../openai";
import type { ConnectionInput, StoredConnection } from "./book";
import { Book, sentHeaders } from "./book";
import type { CallCache, CallDeps, Job } from "./call";
import { SILENT_MS, makeCall, shapeOf } from "./call";
import { NotCarried } from "./convert";
import type { ConnectionAuth } from "./kinds";
import { KINDS, builtInProviders, kindOf } from "./kinds";
import { passedJob } from "./pass";
import type { SignIn } from "./signin";
import { SIGN_IN_MS, createSignIn } from "./signin";
import { REDIRECT_REFUSED, REDIRECT_WORDS, durationWords, errorWords, failureWords, redact } from "./words";

export type { ConnectionInput, StoredConnection } from "./book";
export { NotCarried } from "./convert";
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
  caching(request: ModelRequest | null): CallCache | Promise<CallCache>;
  /** The connection a request passed through goes on (the writer's); null: the default. */
  passConnection(): Promise<string | null>;
  /** The connections the user's settings say take one tool call per answer. */
  serialTools?(): readonly string[] | Promise<readonly string[]>;
  /** pi-ai providers that stand in for the built-in ones of the same id: tests give pi-ai's faux provider. */
  providers?: readonly Provider[];
  /** How long a sign-in flow stays open; `SIGN_IN_MS` when not given. */
  signInMs?: number;
  /** The runtime's environment, `process.env` when not given: what the SDKs under pi-ai would read in it for themselves (`STEERING`) is taken out as the layer is made. */
  env?: Record<string, string | undefined>;
  /** How long a call whose answer has begun may go with nothing at all from its server before it is ended: `SILENT_MS` when not given, 0 for no limit. Asked at each call, so a setting's change holds from the next. */
  silentMs?(): number | Promise<number>;
  /** How long a connection's test call, or a server's list of its models, waits for its answer: `ASK_MS` when not given. Asked each time, so a setting's change holds from the next. */
  askMs?(): number | Promise<number>;
  /** Whose Settings show the runtime's waits (the extension it is linked to, as it last said): a wait that runs out names its setting and where it is changed there. LumiAH's own when not given. */
  owner?(): SettingsOwner;
}

/** A connection as the pages show it: never its key, only whether one is set and its last four characters; its headers by name, never a value, with whether each has one; for a sign-in, whether the runtime is signed in. */
export interface ConnectionView extends Omit<StoredConnection, "headers"> {
  headers?: { name: string; set: boolean }[];
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
  /** Adds or changes a connection; `key` a new key, null to take it away, absent to keep it. `create`: a new one made under `input.id` (a copy of one of Lumiverse's connections, which keeps its id). */
  save(input: ConnectionInput, key?: string | null, options?: { create?: true }): Promise<ConnectionView>;
  remove(id: string): Promise<void>;
  setDefault(id: string | null): Promise<void>;
  /** One tiny call on the connection. */
  test(id: string): Promise<TestResult>;
}

/** A request passed through the loopback, made ready on the connection it goes on: nothing of it has been sent yet. */
export interface Passing {
  /** The connection it goes on: the writer's, else the default. */
  connectionId: string;
  /** Sends it, and streams its answer back as it comes. */
  run(signal: AbortSignal, onDelta: (delta: ModelDelta) => void): Promise<ModelResult>;
}

export interface ModelLayer {
  models: ModelsPort;
  connections: ConnectionsPort;
  book: ConnectionBook;
  signIn: SignIn;
  /** The models a connection offers, for a picker (null: the default): its provider's catalogue, or a compatible server's own list. */
  modelsOf(connectionId: string | null): Promise<ModelChoice[]>;
  /** The models a provider's catalogue lists, for a connection of it not yet saved; none for a compatible server, whose list needs its address. */
  catalogue(provider: string): ModelChoice[];
  /**
   * A request passed through the loopback (runtime/relay.ts), made ready on the writer's connection
   * (`passConnection`), else on the default, with nothing of it sent: rejects with `NoConnection`
   * when there is neither, and with `NotCarried` for what in it can't reach the model on that
   * connection, in words that say what to do.
   */
  passing(request: PassedRequest): Promise<Passing>;
  /** Ends open sign-ins and waits for the files to be written. */
  close(): Promise<void>;
}

/** What a test call asks, and the room it gives: enough for any provider's smallest answer (OpenAI asks at least 16), little enough to cost nothing to speak of. */
const TEST_PROMPT = "Reply with the word OK.";
const TEST_ROOM = 64;
/** How long a test call or a server's list of models may take unless the layer is told otherwise (the setting's own default): past that, the page is told the provider didn't answer. */
const ASK_MS = RUNTIME_DEFAULTS.providerMs;
/** The most of a server's list of models read: lists of hundreds of models run to a few megabytes, and an answer without end would otherwise grow until the runtime is restarted. */
const LIST_MAX = 8 * 1024 * 1024;

/** pi-ai reads credentials from nowhere but the book: no environment variable, no file of another program's, ever signs a call. */
const NOWHERE = { env: async (): Promise<string | undefined> => undefined, fileExists: async (): Promise<boolean> => false };

/**
 * What the SDKs under pi-ai, and pi-ai itself, read in the environment for themselves, past pi-ai's
 * own lookup (`NOWHERE`): each could sign a call, send it or a sign-in somewhere else, add to what a
 * call carries, or write what it sent to the log. Only the book's connections may decide those, so
 * they are taken out of the environment before anything reads them. Some are read today only where
 * pi-ai passes no value of its own (a key, an address): they go too, so that a pi-ai that stops
 * passing one lets none in.
 */
const STEERING: readonly string[] = [
  // Anthropic's SDK: headers added to every call after its key (an `x-api-key` line replaces the key), its own key, token and address, its log of requests with their headers, and its profiles and workload federation (pi-ai reads the federation's too).
  "ANTHROPIC_CUSTOM_HEADERS",
  "ANTHROPIC_API_KEY",
  "ANTHROPIC_AUTH_TOKEN",
  "ANTHROPIC_BASE_URL",
  "ANTHROPIC_LOG",
  "ANTHROPIC_PROFILE",
  "ANTHROPIC_CONFIG_DIR",
  "ANTHROPIC_ORGANIZATION_ID",
  "ANTHROPIC_WORKSPACE_ID",
  "ANTHROPIC_FEDERATION_RULE_ID",
  "ANTHROPIC_SERVICE_ACCOUNT_ID",
  "ANTHROPIC_IDENTITY_TOKEN",
  "ANTHROPIC_IDENTITY_TOKEN_FILE",
  "ANTHROPIC_SCOPE",
  // OpenAI's SDK, which calls OpenRouter, DeepSeek, Groq, xAI and the compatible servers too: headers added to every call, the organization and project sent with each, its keys and address, its log of requests.
  "OPENAI_CUSTOM_HEADERS",
  "OPENAI_ORG_ID",
  "OPENAI_PROJECT_ID",
  "OPENAI_API_KEY",
  "OPENAI_ADMIN_KEY",
  "OPENAI_BASE_URL",
  "OPENAI_LOG",
  // Google's SDK: Vertex AI in place of the Gemini API, another address, its keys.
  "GOOGLE_GENAI_USE_VERTEXAI",
  "GOOGLE_GENAI_USE_ENTERPRISE",
  "GOOGLE_GEMINI_BASE_URL",
  "GOOGLE_VERTEX_BASE_URL",
  "GOOGLE_API_KEY",
  "GEMINI_API_KEY",
  // pi-ai: the address a sign-in's callback listens on, and a prompt cache kept longer than a call asks.
  "PI_OAUTH_CALLBACK_HOST",
  "PI_CACHE_RETENTION",
];

function infoOf(c: StoredConnection): ConnectionInfo {
  return { id: c.id, name: c.name, provider: c.provider, model: c.model ?? null };
}

/** A request passed through the loopback has no connection to go on: the writer names none of the runtime's, and the runtime has no default. */
export class NoConnection extends Error {
  constructor() {
    super("There is no connection to pass this request to: the writer's connection isn't one of the runtime's, and the runtime has no default connection.");
    this.name = "NoConnection";
  }
}

/** A key's last four characters, for a key long enough that they don't give it away. */
const SHOWN_FROM = 12;

/** A response's body as text, or null when it runs past `max` bytes: no more of it than that is read. */
async function cappedText(response: Response, max: number): Promise<string | null> {
  if (response.body === null) return "";
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > max) {
      await reader.cancel();
      return null;
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks).toString("utf8");
}

export function createModelLayer(deps: ModelLayerDeps): ModelLayer {
  const env = deps.env ?? process.env;
  const steering = STEERING.filter((name) => env[name] !== undefined);
  for (const name of steering) delete env[name];
  // Their names alone: a value may be a credential.
  if (steering.length > 0) deps.log(`took out of the runtime's environment what would sign or steer its model calls and sign-ins: ${steering.join(", ")}`);
  // pi-ai loads its sign-in flows by a path a single-file bundle can't follow; these load them from the bundle. pi-ai registers all its flows at once (its other providers' too, some 88 KB): it has no way to register two alone.
  registerLazyOAuthFlows();
  const book = new Book({ dir: deps.dir, log: deps.log });
  const pi = createModels({ credentials: book.credentials, authContext: NOWHERE });
  for (const provider of [...builtInProviders(), ...(deps.providers ?? [])]) pi.setProvider(provider);
  const callDeps: CallDeps = { pi, book, fetch: deps.fetch, now: deps.now, setTimeout: deps.setTimeout, clearTimeout: deps.clearTimeout, silentMs: async () => (await deps.silentMs?.()) ?? SILENT_MS, silentSetting: () => transportWait(["runtime", "answerSilentMs"], deps.owner?.() ?? OWN_BACKEND) };
  const signIn = createSignIn({ pi, book, id: deps.id, uuid: deps.uuid, now: deps.now, log: deps.log, setTimeout: deps.setTimeout, clearTimeout: deps.clearTimeout, signInMs: deps.signInMs ?? SIGN_IN_MS });

  /** A signal the layer's own wait ends after the provider wait (`askMs`, else `ASK_MS`), with words that say what didn't come in time (`late`, given the wait in words) and where that wait is changed; and its timer's release. */
  const deadline = async (late: (wait: string) => string): Promise<{ signal: AbortSignal; clear(): void }> => {
    const ms = (await deps.askMs?.()) ?? ASK_MS;
    const stop = new AbortController();
    const timer = deps.setTimeout(() => stop.abort(new Error(`${late(durationWords(ms))} ${transportWait(["runtime", "providerMs"], deps.owner?.() ?? OWN_BACKEND)} says how long the runtime waits for it.`)), ms);
    return { signal: stop.signal, clear: () => deps.clearTimeout(timer) };
  };

  const viewOf = async (c: StoredConnection, chosen: string | null): Promise<ConnectionView> => {
    const key = c.auth === "key" ? await book.key(c.id) : undefined;
    const { headers, ...shown } = c;
    return {
      ...shown,
      ...(headers !== undefined ? { headers: Object.entries(headers).map(([name, value]) => ({ name, set: value !== null })) } : {}),
      default: c.id === chosen,
      key: c.auth === "key" ? { set: key !== undefined, last4: key !== undefined && key.length >= SHOWN_FROM ? key.slice(-4) : null } : null,
      ...(c.auth === "signin" ? { signedIn: (await book.signin(c.provider)) !== undefined } : {}),
    };
  };

  /** A compatible server's own list of its models (`GET …/models`, Anthropic's under `/v1`): no redirect followed, since its key and headers would go with it, and no more of it read than `LIST_MAX`. */
  const serverModels = async (c: StoredConnection, api: string): Promise<ModelChoice[]> => {
    const key = c.auth === "key" ? await book.key(c.id) : undefined;
    const anthropic = api === "anthropic-messages";
    const signs: Record<string, string> = key === undefined ? {} : anthropic ? { "x-api-key": key } : { authorization: `Bearer ${key}` };
    const wait = await deadline((ms) => `it didn't answer within ${ms}.`);
    try {
      const response = await deps.fetch(`${c.baseUrl ?? ""}${anthropic ? "/v1/models" : "/models"}`, { headers: { accept: "application/json", ...(anthropic ? { "anthropic-version": "2023-06-01" } : {}), ...signs, ...sentHeaders(c) }, redirect: "error", signal: wait.signal });
      const text = await cappedText(response, LIST_MAX);
      if (text === null) throw new Error(`${response.ok ? "" : `${response.status}: `}its answer is larger than ${LIST_MAX / 1024 / 1024} MB, more than the runtime reads.`);
      if (!response.ok) throw new Error(failureWords(`${response.status}: ${text}`));
      let body: unknown;
      try {
        body = JSON.parse(text);
      } catch {
        // Said plainly: the parser's own words quote whatever the server sent.
        throw new Error("its answer isn't JSON.");
      }
      const list: unknown[] = Array.isArray(body) ? body : isRecord(body) && Array.isArray(body.data) ? body.data : isRecord(body) && Array.isArray(body.models) ? body.models : [];
      return list.flatMap((m): ModelChoice[] => {
        if (!isRecord(m) || typeof m.id !== "string") return [];
        const name = typeof m.display_name === "string" ? m.display_name : typeof m.name === "string" ? m.name : m.id;
        return [{ id: m.id, name }];
      });
    } catch (error) {
      const words = errorWords(wait.signal.aborted ? wait.signal.reason : error);
      throw new Error(redact(`The server didn't list its models: ${REDIRECT_REFUSED.test(words) ? REDIRECT_WORDS : words}`, await book.secretValues()));
    } finally {
      wait.clear();
    }
  };

  const models: ModelsPort = {
    // pi-ai reports every call's usage, and a model's thinking comes back summarized wherever a provider has the choice (Anthropic's thinking display, OpenAI's reasoning summary): a request asks for neither.
    async call(request, signal, onDelta) {
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
      return makeCall(callDeps, job, await deps.caching(request), signal, onDelta);
    },
    // What pi-ai keeps for an agent session's cache (Anthropic's message threads) is let go with the session.
    ended(session) {
      cleanupSessionResources(session);
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
      return { ...infoOf(c), parallelTools: !((await deps.serialTools?.()) ?? []).includes(c.id) };
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
      async save(input, key, options) {
        const saved = await book.save(input, key, deps.id, options?.create === true);
        return viewOf(saved, await book.defaultId());
      },
      remove: (id) => book.remove(id),
      setDefault: (id) => book.setDefault(id),
      async test(id) {
        const t0 = deps.now();
        const wait = await deadline((ms) => `The provider didn't answer within ${ms}.`);
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
    catalogue(provider) {
      const kind = kindOf(provider);
      if (kind === undefined) throw new Error(`"${provider}" isn't a provider the runtime offers.`);
      return kind.needsBaseUrl ? [] : pi.getModels(kind.id).map((m) => ({ id: m.id, name: m.name }));
    },
    async passing(request) {
      // The writer's connection, where it is one of the runtime's; else the default, as an agent whose connection is gone runs on it.
      const named = await deps.passConnection();
      const c = (named === null ? null : await book.connection(named)) ?? (await book.connection(null));
      if (c === null) throw new NoConnection();
      let job: Job;
      try {
        job = await passedJob(request, c.id, (made) => shapeOf(callDeps, made));
      } catch (error) {
        // Whatever words leave here, no key, token or header's value the runtime holds is in them.
        const words = redact(error instanceof Error ? error.message : String(error), await book.secretValues().catch(() => []));
        throw error instanceof NotCarried ? new NotCarried(words) : new Error(words);
      }
      return { connectionId: c.id, run: async (signal, onDelta) => makeCall(callDeps, job, await deps.caching(null), signal, onDelta) };
    },
    async close() {
      signIn.close();
      await book.settled();
    },
  };
}
