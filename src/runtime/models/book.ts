// The runtime's own connections and their secrets, on its disk (PI-BUILD-PLAN §4.2, §4.3):
// `connections.json` holds each connection (its provider, how it signs its calls, its address,
// model, effort and headers) and which one is the default; `secrets.json` holds the keys, by
// connection, and the sign-ins' tokens, by provider. Each file is written whole to a temporary file
// readable by its owner alone, then moved over the old one, in a folder only its owner may enter,
// so a reader never meets half a file and nobody else ever meets a secret. Writes go one at a time.
//
// The sign-ins' tokens are pi-ai's to keep fresh: they reach it through a `CredentialStore` over
// the same secrets, whose `modify` runs one change of a provider's sign-in at a time and saves it
// before the next begins. pi-ai refreshes a token inside it and looks again once it holds it, so two
// calls that find a token expired at once refresh it once, and the token a refresh rotated is on
// disk before anything can use the old one again.
//
// A file that can't be read stops the book with words that name it, rather than being written over
// with nothing: a hand edit gone wrong costs the user a fix, not their connections.

import { chmod, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import type { Credential, CredentialStore, ModelThinkingLevel, OAuthCredential } from "@earendil-works/pi-ai";
import { isRecord } from "../../core/ports";
import type { ConnectionAuth, ProviderKind } from "./kinds";
import { kindOf } from "./kinds";
import { errorWords } from "./words";

/** The files' format: one of another is read as no book, with words that say so. */
const FORMAT = 1;
/** A secret file's mode, and its folder's: its owner's alone. */
const FILE_MODE = 0o600;
const DIR_MODE = 0o700;

const LEVELS: readonly ModelThinkingLevel[] = ["off", "minimal", "low", "medium", "high", "xhigh", "max"];

/** A connection as the book keeps it. */
export interface StoredConnection {
  id: string;
  name: string;
  /** The provider kind's id (kinds.ts). */
  provider: string;
  auth: ConnectionAuth;
  /** Where its calls go in place of the provider's own address: a compatible server's, or a proxy's. */
  baseUrl?: string;
  /** The API a compatible server speaks, where it may speak more than one. */
  api?: string;
  /** Its model, for an agent that names none. */
  model?: string;
  /** Its own effort, for an agent's `auto` and `inherit`; absent: the provider's default. */
  effort?: ModelThinkingLevel;
  /** Headers every call on it sends. */
  headers?: Record<string, string>;
}

/** A connection to save: an `id` of one that exists changes it; none adds one. Null clears an optional field. */
export interface ConnectionInput {
  id?: string;
  name: string;
  provider: string;
  auth: ConnectionAuth;
  baseUrl?: string | null;
  api?: string | null;
  model?: string | null;
  effort?: ModelThinkingLevel | null;
  headers?: Record<string, string> | null;
}

interface Secrets {
  /** Each connection's key, by its id. */
  keys: Record<string, string>;
  /** Each sign-in, by pi-ai's id for its provider. */
  signins: Record<string, OAuthCredential>;
  /** This installation's id for the providers that ask for one (OpenAI's sign-in), made once. */
  device?: string;
}

/** The book's state as its files hold it. */
interface State {
  connections: StoredConnection[];
  default: string | null;
  secrets: Secrets;
}

export interface BookDeps {
  /** The runtime's folder: the two files live in it. */
  dir: string;
  log(text: string): void;
}

function isLevel(value: unknown): value is ModelThinkingLevel {
  return typeof value === "string" && (LEVELS as readonly string[]).includes(value);
}

function isStringRecord(value: unknown): value is Record<string, string> {
  return isRecord(value) && Object.values(value).every((v) => typeof v === "string");
}

/** A stored connection read from the file; null when it isn't one this build can use. */
function storedOf(raw: unknown): StoredConnection | null {
  if (!isRecord(raw)) return null;
  const { id, name, provider, auth, baseUrl, api, model, effort, headers } = raw;
  if (typeof id !== "string" || typeof name !== "string" || typeof provider !== "string" || (auth !== "key" && auth !== "signin" && auth !== "none")) return null;
  if ((baseUrl !== undefined && typeof baseUrl !== "string") || (api !== undefined && typeof api !== "string") || (model !== undefined && typeof model !== "string") || (effort !== undefined && !isLevel(effort)) || (headers !== undefined && !isStringRecord(headers))) return null;
  return { id, name, provider, auth, ...(baseUrl !== undefined ? { baseUrl } : {}), ...(api !== undefined ? { api } : {}), ...(model !== undefined ? { model } : {}), ...(effort !== undefined ? { effort } : {}), ...(headers !== undefined ? { headers } : {}) };
}

function isOAuth(value: unknown): value is OAuthCredential {
  return isRecord(value) && value.type === "oauth" && typeof value.access === "string" && typeof value.refresh === "string" && typeof value.expires === "number";
}

/** A header's name as HTTP allows one: a token of the characters a field name may hold. */
const HEADER_NAME = /^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/;

/** The address a connection gives, checked: an http or https URL, with the slashes it ends in taken off. */
function addressOf(raw: string): string {
  let url: URL;
  try {
    url = new URL(raw.trim());
  } catch {
    throw new Error(`"${raw}" isn't an address: give one such as https://example.com/v1.`);
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") throw new Error(`"${raw}" isn't an http or https address.`);
  return url.href.replace(/\/+$/, "");
}

/** A connection to save, checked against what its provider takes; throws the words a page shows. */
function checked(input: ConnectionInput, id: string): StoredConnection {
  const name = typeof input.name === "string" ? input.name.trim() : "";
  if (name === "") throw new Error("Give the connection a name.");
  const kind: ProviderKind | undefined = typeof input.provider === "string" ? kindOf(input.provider) : undefined;
  if (kind === undefined) throw new Error(`"${String(input.provider)}" isn't a provider the runtime offers.`);
  if (!kind.auth.includes(input.auth)) throw new Error(`${kind.name} connections can't use ${input.auth === "signin" ? "a sign-in" : input.auth === "none" ? "no key" : "a key"}.`);
  const baseUrl = typeof input.baseUrl === "string" && input.baseUrl.trim() !== "" ? addressOf(input.baseUrl) : undefined;
  if (kind.needsBaseUrl && baseUrl === undefined) throw new Error(`An ${kind.name} connection needs the server's address.`);
  const api = typeof input.api === "string" && input.api !== "" ? input.api : undefined;
  if (api !== undefined && !kind.apis.includes(api)) throw new Error(`${kind.name} connections speak ${kind.apis.join(" or ")}, not ${api}.`);
  const model = typeof input.model === "string" && input.model.trim() !== "" ? input.model.trim() : undefined;
  const effort = input.effort ?? undefined;
  if (effort !== undefined && !isLevel(effort)) throw new Error(`"${String(effort)}" isn't an effort: use one of ${LEVELS.join(", ")}.`);
  const headers = input.headers ?? undefined;
  if (headers !== undefined) {
    if (!isStringRecord(headers)) throw new Error("A connection's headers are names with text values.");
    const bad = Object.keys(headers).find((h) => !HEADER_NAME.test(h));
    if (bad !== undefined) throw new Error(`"${bad}" isn't a header's name.`);
  }
  return { id, name, provider: kind.id, auth: input.auth, ...(baseUrl !== undefined ? { baseUrl } : {}), ...(api !== undefined && kind.apis.length > 1 ? { api } : {}), ...(model !== undefined ? { model } : {}), ...(effort !== undefined ? { effort } : {}), ...(headers !== undefined && Object.keys(headers).length > 0 ? { headers } : {}) };
}

/** A file's text, or null when there is no file. */
async function textAt(path: string): Promise<string | null> {
  try {
    return await readFile(path, "utf8");
  } catch (error) {
    if (isRecord(error) && error.code === "ENOENT") return null;
    throw error;
  }
}

async function load(dir: string, log: (text: string) => void): Promise<State> {
  const books = `${dir}/connections.json`;
  const vault = `${dir}/secrets.json`;
  let raw: unknown = null;
  let secret: unknown = null;
  try {
    const text = await textAt(books);
    raw = text === null ? null : JSON.parse(text);
    const hidden = await textAt(vault);
    secret = hidden === null ? null : JSON.parse(hidden);
  } catch (error) {
    throw new Error(`The runtime's connections couldn't be read (${errorWords(error)}): fix or remove ${books} and ${vault}, then restart the runtime.`);
  }
  if (raw !== null && !(isRecord(raw) && raw.lumiah === FORMAT && Array.isArray(raw.connections))) throw new Error(`${books} isn't a list of connections this runtime reads: fix or remove it, then restart the runtime.`);
  if (secret !== null && !(isRecord(secret) && secret.lumiah === FORMAT && isRecord(secret.keys) && isRecord(secret.signins))) throw new Error(`${vault} isn't a set of secrets this runtime reads: fix or remove it, then restart the runtime.`);
  const connections: StoredConnection[] = [];
  for (const entry of isRecord(raw) && Array.isArray(raw.connections) ? raw.connections : []) {
    const c = storedOf(entry);
    if (c === null || kindOf(c.provider) === undefined) log(`left out a connection in ${books} that this runtime can't use`);
    else connections.push(c);
  }
  const keys: Record<string, string> = {};
  const signins: Record<string, OAuthCredential> = {};
  let device: string | undefined;
  if (isRecord(secret) && isRecord(secret.keys) && isRecord(secret.signins)) {
    for (const [id, key] of Object.entries(secret.keys)) if (typeof key === "string") keys[id] = key;
    for (const [provider, credential] of Object.entries(secret.signins)) if (isOAuth(credential)) signins[provider] = credential;
    if (typeof secret.device === "string") device = secret.device;
  }
  const chosen = isRecord(raw) && typeof raw.default === "string" ? raw.default : null;
  return { connections, default: chosen, secrets: { keys, signins, ...(device !== undefined ? { device } : {}) } };
}

/** The connections and their secrets, kept on disk. Each method waits for the files to be read first. */
export class Book {
  private readonly ready: Promise<State>;
  /** Every write, one after another. */
  private writes: Promise<void> = Promise.resolve();
  /** Each provider's sign-in changes, one after another. */
  private readonly signinChanges = new Map<string, Promise<unknown>>();

  constructor(private readonly deps: BookDeps) {
    this.ready = load(deps.dir, deps.log);
    // A failed read is answered by every method that waits on it.
    this.ready.catch(() => undefined);
  }

  /** Writes a file whole: a temporary file of its owner's alone, moved over the old one. */
  private async write(name: string, value: unknown): Promise<void> {
    const { dir } = this.deps;
    await mkdir(dir, { recursive: true, mode: DIR_MODE });
    await chmod(dir, DIR_MODE);
    const path = `${dir}/${name}`;
    const temp = `${path}.tmp`;
    await writeFile(temp, `${JSON.stringify(value, null, 2)}\n`, { mode: FILE_MODE });
    await chmod(temp, FILE_MODE);
    await rename(temp, path);
  }

  /** Queues a write of a file from the state as it is when its turn comes, so the last change always lands last. */
  private queue(name: "connections.json" | "secrets.json"): Promise<void> {
    const run = async (): Promise<void> => {
      const s = await this.ready;
      await this.write(name, name === "connections.json" ? { lumiah: FORMAT, default: s.default, connections: s.connections } : { lumiah: FORMAT, ...s.secrets });
    };
    const next = this.writes.then(run, run);
    this.writes = next.catch(() => undefined);
    return next;
  }

  /** Waits for every write queued so far. */
  async settled(): Promise<void> {
    await this.writes;
  }

  async connections(): Promise<readonly StoredConnection[]> {
    return (await this.ready).connections;
  }

  async defaultId(): Promise<string | null> {
    return (await this.ready).default;
  }

  /** One connection (null: the default); null when there is no such connection. */
  async connection(id: string | null): Promise<StoredConnection | null> {
    const s = await this.ready;
    const wanted = id ?? s.default;
    return wanted === null ? null : (s.connections.find((c) => c.id === wanted) ?? null);
  }

  async key(id: string): Promise<string | undefined> {
    return (await this.ready).secrets.keys[id];
  }

  /**
   * Adds a connection or changes one, and its key: a key given is kept, null takes it away, absent
   * leaves it as it was. A connection that no longer signs with a key keeps none. The first
   * connection is the default.
   */
  async save(input: ConnectionInput, key: string | null | undefined, newId: () => string): Promise<StoredConnection> {
    const s = await this.ready;
    const at = input.id === undefined ? -1 : s.connections.findIndex((c) => c.id === input.id);
    if (input.id !== undefined && at === -1) throw new Error("That connection is no longer there: reload the page.");
    const connection = checked(input, input.id ?? newId());
    if (key !== undefined && key !== null && (typeof key !== "string" || key.trim() === "")) throw new Error("A key can't be empty: leave it out to keep the one there is.");
    if (at === -1) s.connections.push(connection);
    else s.connections[at] = connection;
    if (s.default === null) s.default = connection.id;
    const before = s.secrets.keys[connection.id];
    if (connection.auth !== "key" || key === null) delete s.secrets.keys[connection.id];
    else if (typeof key === "string") s.secrets.keys[connection.id] = key.trim();
    const writes = [this.queue("connections.json")];
    if (s.secrets.keys[connection.id] !== before) writes.push(this.queue("secrets.json"));
    await Promise.all(writes);
    return connection;
  }

  /** Takes a connection away, with its key; when it was the default there is none until the user picks one. */
  async remove(id: string): Promise<void> {
    const s = await this.ready;
    const at = s.connections.findIndex((c) => c.id === id);
    if (at === -1) return;
    s.connections.splice(at, 1);
    if (s.default === id) s.default = null;
    const hadKey = s.secrets.keys[id] !== undefined;
    delete s.secrets.keys[id];
    await Promise.all([this.queue("connections.json"), ...(hadKey ? [this.queue("secrets.json")] : [])]);
  }

  async setDefault(id: string | null): Promise<void> {
    const s = await this.ready;
    if (id !== null && !s.connections.some((c) => c.id === id)) throw new Error("That connection is no longer there: reload the page.");
    s.default = id;
    await this.queue("connections.json");
  }

  /** This installation's id, made the first time it is asked for and kept. */
  async device(make: () => string): Promise<string> {
    const s = await this.ready;
    if (s.secrets.device === undefined) {
      s.secrets.device = make();
      await this.queue("secrets.json");
    }
    return s.secrets.device;
  }

  async signin(provider: string): Promise<OAuthCredential | undefined> {
    return (await this.ready).secrets.signins[provider];
  }

  /** Every secret the book holds, for words that must never show one. */
  async secretValues(): Promise<string[]> {
    const { secrets } = await this.ready;
    return [...Object.values(secrets.keys), ...Object.values(secrets.signins).flatMap((c) => [c.access, c.refresh])];
  }

  /**
   * Runs one change of a provider's sign-in after the ones before it. A wait the signal ends never
   * starts its change; a change that started finishes, since a refresh may already have rotated the
   * token it is saving.
   */
  private signinChange<T>(provider: string, change: () => Promise<T>, signal: AbortSignal | undefined): Promise<T> {
    const start = (): Promise<T> => {
      signal?.throwIfAborted();
      return change();
    };
    const run = (this.signinChanges.get(provider) ?? Promise.resolve()).then(start, start);
    const settled = run.catch(() => undefined);
    this.signinChanges.set(provider, settled);
    void settled.then(() => {
      if (this.signinChanges.get(provider) === settled) this.signinChanges.delete(provider);
    });
    if (signal === undefined) return run;
    // Only the wait gives way to the signal: once the change runs, its result stands.
    const { promise, resolve, reject } = Promise.withResolvers<T>();
    const stop = (): void => reject(signal.reason);
    signal.addEventListener("abort", stop, { once: true });
    void run.then(resolve, reject).finally(() => signal.removeEventListener("abort", stop));
    return promise;
  }

  /** pi-ai's view of the sign-ins: read, list, change one at a time per provider, and forget. */
  readonly credentials: CredentialStore = {
    read: async (providerId) => (await this.ready).secrets.signins[providerId],
    list: async () => Object.keys((await this.ready).secrets.signins).map((providerId) => ({ providerId, type: "oauth" as const })),
    modify: (providerId, fn, options) =>
      this.signinChange(
        providerId,
        async (): Promise<Credential | undefined> => {
          const s = await this.ready;
          const current = s.secrets.signins[providerId];
          const next = await fn(current);
          if (next === undefined) return current;
          // The book keeps sign-ins alone: a key is a connection's, never a provider's.
          if (next.type !== "oauth") throw new Error("The runtime keeps keys with their connections, not by provider.");
          s.secrets.signins[providerId] = next;
          await this.queue("secrets.json");
          return next;
        },
        options?.signal,
      ),
    delete: (providerId, options) =>
      this.signinChange(
        providerId,
        async () => {
          const s = await this.ready;
          if (s.secrets.signins[providerId] === undefined) return;
          delete s.secrets.signins[providerId];
          await this.queue("secrets.json");
        },
        options?.signal,
      ),
  };
}
