// The runtime's own connections and their secrets, on its disk (PI-BUILD-PLAN §4.2, §4.3):
// `connections.json` holds each connection (its provider, how it signs its calls, its address,
// model, effort and headers) and which one is the default; `secrets.json` holds the keys, by
// connection, and the sign-ins' tokens, by provider. Each file is written whole to a new temporary
// file readable by its owner alone and flushed to the disk, then moved over the old one and the move
// flushed too, in a folder only its owner may enter: a reader never meets half a file, a crash
// leaves the old file or the new one whole, and nobody else ever meets a secret. Writes go one at a
// time.
//
// What was stored for one server goes to no other. A connection's key and its headers' values stay
// only while its provider and its address's origin do: a change of either keeps only what comes
// with it. A connection that signs in goes to its provider's own address, and an address holds no
// name or password.
//
// The sign-ins' tokens are pi-ai's to keep fresh: they reach it through a `CredentialStore` over
// the same secrets, whose `modify` runs one change of a provider's sign-in at a time and saves it
// before the next begins. pi-ai refreshes a token inside it and looks again once it holds it, so two
// calls that find a token expired at once refresh it once, and the token a refresh rotated is on
// disk before anything can use the old one again.
//
// A file that can't be read stops the book with words that name it, rather than being written over
// with nothing: a hand edit gone wrong costs the user a fix, not their connections. A connection in
// it that a save would refuse is left out, with a line in the log that says why; and a folder or a
// file other accounts could read is made its owner's alone as it is read, and the log says so.

import * as nodeFiles from "node:fs/promises";
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
  /** Headers every call on it sends, by name. Null: its value was dropped when its provider or its address changed, so it is sent no more until it is given again. */
  headers?: Record<string, string | null>;
}

/**
 * A connection to save: an `id` of one that exists changes it; none adds one. Null clears an optional
 * field, but for `headers`: absent keeps the ones stored; null takes them all away; a record is
 * exactly the headers kept, by name, a text setting a value and null keeping the one stored under
 * that name.
 */
export interface ConnectionInput {
  id?: string;
  name: string;
  provider: string;
  auth: ConnectionAuth;
  baseUrl?: string | null;
  api?: string | null;
  model?: string | null;
  effort?: ModelThinkingLevel | null;
  headers?: Record<string, string | null> | null;
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

/** The disk as the book uses it: Node's own, or a test's that watches what is done to it. */
export type BookFiles = Pick<typeof nodeFiles, "chmod" | "mkdir" | "open" | "readFile" | "rename" | "rm" | "stat">;

export interface BookDeps {
  /** The runtime's folder: the two files live in it. */
  dir: string;
  log(text: string): void;
  /** Node's own disk when not given. */
  files?: BookFiles;
}

function isLevel(value: unknown): value is ModelThinkingLevel {
  return typeof value === "string" && (LEVELS as readonly string[]).includes(value);
}

function isHeaderRecord(value: unknown): value is Record<string, string | null> {
  return isRecord(value) && Object.values(value).every((v) => typeof v === "string" || v === null);
}

/** A stored connection read from the file; null when it isn't one this build can read. */
function storedOf(raw: unknown): StoredConnection | null {
  if (!isRecord(raw)) return null;
  const { id, name, provider, auth, baseUrl, api, model, effort, headers } = raw;
  if (typeof id !== "string" || typeof name !== "string" || typeof provider !== "string" || (auth !== "key" && auth !== "signin" && auth !== "none")) return null;
  if ((baseUrl !== undefined && typeof baseUrl !== "string") || (api !== undefined && typeof api !== "string") || (model !== undefined && typeof model !== "string") || (effort !== undefined && !isLevel(effort)) || (headers !== undefined && !isHeaderRecord(headers))) return null;
  return { id, name, provider, auth, ...(baseUrl !== undefined ? { baseUrl } : {}), ...(api !== undefined ? { api } : {}), ...(model !== undefined ? { model } : {}), ...(effort !== undefined ? { effort } : {}), ...(headers !== undefined ? { headers } : {}) };
}

function isOAuth(value: unknown): value is OAuthCredential {
  return isRecord(value) && value.type === "oauth" && typeof value.access === "string" && typeof value.refresh === "string" && typeof value.expires === "number";
}

/** A header's name as HTTP allows one: a token of the characters a field name may hold. */
const HEADER_NAME = /^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/;

/**
 * The address a connection gives, checked: an http or https URL with no name or password in it (a
 * credential belongs in the key or a header, where words never show it), and no query or fragment
 * (the paths a call adds would land in them), with the slashes it ends in taken off. Its words never
 * repeat what was typed: it may hold a password.
 */
function addressOf(raw: string): string {
  let url: URL;
  try {
    url = new URL(raw.trim());
  } catch {
    throw new Error("That isn't an address: give one such as https://example.com/v1.");
  }
  if (url.username !== "" || url.password !== "") throw new Error("An address can't hold a name or a password: give the key in its own field, or a header.");
  if (url.protocol !== "http:" && url.protocol !== "https:") throw new Error(`An address starts with http:// or https://, not ${url.protocol}//.`);
  if (url.search !== "" || url.hash !== "" || url.href.includes("?")) throw new Error(`Give the address without what follows "?" or "#": ${url.origin}${url.pathname}`);
  return `${url.origin}${url.pathname}`.replace(/\/+$/, "");
}

/** A connection to save, checked against what its provider takes, its headers aside (`headersOf`); throws the words a page shows. */
function checked(input: ConnectionInput, id: string): StoredConnection {
  const name = typeof input.name === "string" ? input.name.trim() : "";
  if (name === "") throw new Error("Give the connection a name.");
  const kind: ProviderKind | undefined = typeof input.provider === "string" ? kindOf(input.provider) : undefined;
  if (kind === undefined) throw new Error(`"${String(input.provider)}" isn't a provider the runtime offers.`);
  if (!kind.auth.includes(input.auth)) throw new Error(`${kind.name} connections can't use ${input.auth === "signin" ? "a sign-in" : input.auth === "none" ? "no key" : "a key"}.`);
  const baseUrl = typeof input.baseUrl === "string" && input.baseUrl.trim() !== "" ? addressOf(input.baseUrl) : undefined;
  // A sign-in's token is good at its provider alone, so its calls go nowhere else.
  if (baseUrl !== undefined && input.auth === "signin") throw new Error(`A connection that signs in to ${kind.name} goes to ${kind.name}'s own address: leave the address out.`);
  if (kind.needsBaseUrl && baseUrl === undefined) throw new Error(`An ${kind.name} connection needs the server's address.`);
  const api = typeof input.api === "string" && input.api !== "" ? input.api : undefined;
  if (api !== undefined && !kind.apis.includes(api)) throw new Error(`${kind.name} connections speak ${kind.apis.join(" or ")}, not ${api}.`);
  const model = typeof input.model === "string" && input.model.trim() !== "" ? input.model.trim() : undefined;
  const effort = input.effort ?? undefined;
  if (effort !== undefined && !isLevel(effort)) throw new Error(`"${String(effort)}" isn't an effort: use one of ${LEVELS.join(", ")}.`);
  return { id, name, provider: kind.id, auth: input.auth, ...(baseUrl !== undefined ? { baseUrl } : {}), ...(api !== undefined && kind.apis.length > 1 ? { api } : {}), ...(model !== undefined ? { model } : {}), ...(effort !== undefined ? { effort } : {}) };
}

/**
 * The headers a saved connection keeps: with `given` absent, the ones it had; null, none; a record,
 * exactly those, a text setting a value and null keeping the one it had under that name. A value
 * stays only with the server it was given for: unless `carried` (the same provider at the same
 * origin), a value this save doesn't give is dropped and its name kept, so it is sent no more until
 * it is given again.
 */
function headersOf(given: ConnectionInput["headers"], had: StoredConnection["headers"], carried: boolean): StoredConnection["headers"] {
  if (given === null) return undefined;
  const asked: unknown = given ?? had ?? {};
  if (!isHeaderRecord(asked)) throw new Error("A connection's headers are names with text values.");
  const headers: Record<string, string | null> = {};
  for (const [name, value] of Object.entries(asked)) {
    // Not repeated: a name typed wrong is often a whole header pasted in, its credential with it.
    if (!HEADER_NAME.test(name)) throw new Error("A header's name is a single word, such as x-team, with no space or colon in it: give its value in its own field.");
    if (given === undefined || value === null) {
      headers[name] = carried ? (had?.[name] ?? null) : null;
      continue;
    }
    if (/[\r\n\0]/.test(value)) throw new Error(`The header "${name}" can't hold a line break.`);
    headers[name] = value;
  }
  return Object.keys(headers).length > 0 ? headers : undefined;
}

/** Where a connection's calls go, as far as a secret stored for them is concerned: its address's origin, or null for its provider's own. */
function originOf(baseUrl: string | undefined): string | null {
  return baseUrl === undefined ? null : new URL(baseUrl).origin;
}

/** The headers a call on a connection sends: those that have a value. */
export function sentHeaders(connection: StoredConnection): Record<string, string> | undefined {
  const sent = Object.entries(connection.headers ?? {}).filter((entry): entry is [string, string] => entry[1] !== null);
  return sent.length > 0 ? Object.fromEntries(sent) : undefined;
}

/** A file's text, or null when there is no file. */
async function textAt(files: BookFiles, path: string): Promise<string | null> {
  try {
    return await files.readFile(path, "utf8");
  } catch (error) {
    if (isRecord(error) && error.code === "ENOENT") return null;
    throw error;
  }
}

/** A file's JSON, or null when there is no file. The parser's own words are never given: they quote the file, which may hold a key. */
function jsonAt(text: string | null, path: string): unknown {
  if (text === null) return null;
  try {
    return JSON.parse(text);
  } catch {
    throw new Error(`${path} isn't valid JSON: fix or remove it, then restart the runtime.`);
  }
}

/**
 * Makes a folder or a file its owner's alone where other accounts could reach it, and says so in the
 * log: a copy restored by hand, or a folder made before the runtime's, would otherwise stay open
 * until the next write. Mode bits are POSIX's: Windows has none to keep.
 */
async function tightened(files: BookFiles, path: string, mode: number, log: (text: string) => void): Promise<void> {
  if (process.platform === "win32") return;
  let had: number;
  try {
    had = (await files.stat(path)).mode & 0o777;
  } catch (error) {
    if (isRecord(error) && error.code === "ENOENT") return;
    throw error;
  }
  if ((had & 0o077) === 0) return;
  await files.chmod(path, mode);
  log(`${path} was open to other accounts (mode ${had.toString(8)}): made it its owner's alone (${mode.toString(8)})`);
}

/** Flushes a folder's list of files to the disk, so a file just moved into it is still there after a crash. Windows opens no folder to flush, and keeps its list by itself. */
async function flushed(files: BookFiles, dir: string): Promise<void> {
  if (process.platform === "win32") return;
  const folder = await files.open(dir, "r");
  try {
    await folder.sync();
  } finally {
    await folder.close();
  }
}

async function load(dir: string, log: (text: string) => void, files: BookFiles): Promise<State> {
  const books = `${dir}/connections.json`;
  const vault = `${dir}/secrets.json`;
  let texts: [string | null, string | null];
  try {
    for (const [path, mode] of [[dir, DIR_MODE], [books, FILE_MODE], [vault, FILE_MODE]] as const) await tightened(files, path, mode, log);
    texts = [await textAt(files, books), await textAt(files, vault)];
  } catch (error) {
    throw new Error(`The runtime's connections couldn't be read (${errorWords(error)}): fix or remove ${books} and ${vault}, then restart the runtime.`);
  }
  const raw = jsonAt(texts[0], books);
  const secret = jsonAt(texts[1], vault);
  if (raw !== null && !(isRecord(raw) && raw.lumiah === FORMAT && Array.isArray(raw.connections))) throw new Error(`${books} isn't a list of connections this runtime reads: fix or remove it, then restart the runtime.`);
  if (secret !== null && !(isRecord(secret) && secret.lumiah === FORMAT && isRecord(secret.keys) && isRecord(secret.signins))) throw new Error(`${vault} isn't a set of secrets this runtime reads: fix or remove it, then restart the runtime.`);
  const connections: StoredConnection[] = [];
  for (const entry of isRecord(raw) && Array.isArray(raw.connections) ? raw.connections : []) {
    const stored = storedOf(entry);
    if (stored === null) {
      log(`left out a connection in ${books} that this runtime can't read`);
      continue;
    }
    // Held to what a save takes, so that a hand edit can't send a call where no save could: a sign-in's token to another address, or a compatible server's key to its SDK's own host.
    try {
      const headers = headersOf(stored.headers, stored.headers, true);
      connections.push({ ...checked(stored, stored.id), ...(headers !== undefined ? { headers } : {}) });
    } catch (error) {
      log(`left out the connection "${stored.name}" in ${books}: ${errorWords(error)}`);
    }
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

  private readonly files: BookFiles;

  constructor(private readonly deps: BookDeps) {
    this.files = deps.files ?? nodeFiles;
    this.ready = load(deps.dir, deps.log, this.files);
    // A failed read is answered by every method that waits on it.
    this.ready.catch(() => undefined);
  }

  /**
   * Writes a file whole: a new temporary file of its owner's alone, flushed to the disk, moved over
   * the old one, and the move flushed with its folder, so a crash at any point leaves the old file or
   * the new one whole: never an empty one, nor a token a refresh rotated lost.
   */
  private async write(name: string, value: unknown): Promise<void> {
    const { dir } = this.deps;
    const { files } = this;
    await files.mkdir(dir, { recursive: true, mode: DIR_MODE });
    await files.chmod(dir, DIR_MODE);
    const path = `${dir}/${name}`;
    const temp = `${path}.tmp`;
    // Made anew: what a crash left at that name is removed, and nothing found there is written through.
    await files.rm(temp, { force: true });
    const file = await files.open(temp, "wx", FILE_MODE);
    try {
      await file.writeFile(`${JSON.stringify(value, null, 2)}\n`);
      await file.sync();
    } finally {
      await file.close();
    }
    await files.chmod(temp, FILE_MODE);
    await files.rename(temp, path);
    await flushed(files, dir);
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
   * leaves it as it was. A connection that no longer signs with a key keeps none. What was stored
   * for one server goes to no other: a connection whose provider, or whose address's origin, changes
   * keeps its key and its headers' values only where this save gives them again, and a new one starts
   * with only what it is given. The first connection is the default. `create`: a new one made under
   * `input.id`, which no connection may hold yet (a copy of one of Lumiverse's connections keeps its
   * id).
   */
  async save(input: ConnectionInput, key: string | null | undefined, newId: () => string, create = false): Promise<StoredConnection> {
    const s = await this.ready;
    if (create && (typeof input.id !== "string" || input.id.trim() === "")) throw new Error("A copied connection keeps the id it had: give it.");
    if (create && s.connections.some((c) => c.id === input.id)) throw new Error("The runtime has a connection with that id already: reload the page.");
    const at = input.id === undefined || create ? -1 : s.connections.findIndex((c) => c.id === input.id);
    if (!create && input.id !== undefined && at === -1) throw new Error("That connection is no longer there: reload the page.");
    const connection = checked(input, input.id ?? newId());
    if (key !== undefined && key !== null && (typeof key !== "string" || key.trim() === "")) throw new Error("A key can't be empty: leave it out to keep the one there is.");
    const before = at === -1 ? undefined : s.connections[at];
    const carried = before !== undefined && before.provider === connection.provider && originOf(before.baseUrl) === originOf(connection.baseUrl);
    const headers = headersOf(input.headers, before?.headers, carried);
    const saved: StoredConnection = headers === undefined ? connection : { ...connection, headers };
    if (at === -1) s.connections.push(saved);
    else s.connections[at] = saved;
    if (s.default === null) s.default = saved.id;
    const had = s.secrets.keys[saved.id];
    if (saved.auth !== "key" || key === null || (key === undefined && !carried)) delete s.secrets.keys[saved.id];
    else if (typeof key === "string") s.secrets.keys[saved.id] = key.trim();
    const writes = [this.queue("connections.json")];
    if (s.secrets.keys[saved.id] !== had) writes.push(this.queue("secrets.json"));
    await Promise.all(writes);
    return saved;
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

  /** Every secret the book holds, for words that must never show one: keys, sign-ins' tokens, and headers' values, which may carry a gateway's or a proxy's credential. */
  async secretValues(): Promise<string[]> {
    const { secrets, connections } = await this.ready;
    const headerValues = connections.flatMap((c) => Object.values(c.headers ?? {}).filter((v): v is string => v !== null));
    return [...Object.values(secrets.keys), ...Object.values(secrets.signins).flatMap((c) => [c.access, c.refresh]), ...headerValues];
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
