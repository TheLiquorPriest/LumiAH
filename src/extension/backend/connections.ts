// The user's connections as the core's port and the pages see them (DESIGN §4.2 `connections`):
// which exist, each one's provider and model, what the loop must know of it (its cache breakpoints,
// whether it takes several tool calls in one answer), and which are loopbacks. A loopback connection
// is one whose calls come back to one of this extension's runtimes: LumiAH answers a chat exactly
// when the connection it generates on is one, and no agent's own call may go on one. The loopback
// of another extension that has LumiAH built in is none of this one's (DESIGN §21).

import type { ConnectionInfo, ConnectionProfile } from "../../core/ports";
import { EXTENSION_IDENTIFIER, MODEL_ID, loopsBack } from "../../link/contract";
import { isRecord } from "../../link/json";
import type { ConnectionView } from "../../shared/ui";
import type { BackendHost, HostChat, HostConnection } from "./spindle";

/** Lumiverse's provider for an OpenAI-compatible endpoint the user names: what a loopback connection is made as. */
export const LOOPBACK_PROVIDER = "custom";

/** Anthropic's most explicit cache breakpoints in one request, the connection's own included: a fifth fails the request. The provider's limit, so it can't be a setting. */
const ANTHROPIC_CACHE_BREAKPOINTS = 4;

/**
 * The explicit cache breakpoints a connection takes, as Lumiverse's own prompt caching reads its
 * `prompt_caching` (Lumiverse `src/services/caching/anthropic.ts`, `resolveConfig`): only Anthropic
 * reads `cache_control` on a part; when the connection caches, it marks the end of the leading
 * system messages unless told not to, the last message and the last tool (one breakpoint, however
 * many tools) only when told to, and its automatic mode is on unless switched off.
 */
export function cacheBreakpoints(provider: string, metadata: unknown): ConnectionProfile["cache"] {
  if (provider !== "anthropic") return null;
  const caching = isRecord(metadata) ? metadata.prompt_caching : undefined;
  const on = caching === true || isRecord(caching);
  const own = isRecord(caching) ? caching : {};
  const marks = isRecord(own.breakpoints) ? own.breakpoints : {};
  return { limit: ANTHROPIC_CACHE_BREAKPOINTS, system: on && marks.system !== false, lastMessage: on && marks.messages === true, tools: on && marks.tools === true, automatic: on && own.automatic !== false };
}

/**
 * The providers that refuse `parallel_tool_calls`, by Lumiverse's own names for them: it is an
 * OpenAI-style parameter, Google rejects a top-level field it doesn't know and Anthropic says the
 * same thing another way. Lumiverse passes a parameter it doesn't know straight to the provider, so
 * a call on one of these goes without it. (Carried from LumiAgent's backend, see NOTICE.) The
 * providers' own behaviour, so it can't be a setting.
 */
const NO_PARALLEL_FLAG: Readonly<Record<string, true>> = { google: true, google_vertex: true, anthropic: true };

/** Whether a provider takes `parallel_tool_calls` in a request's body. */
export function takesParallelFlag(provider: string): boolean {
  return !Object.hasOwn(NO_PARALLEL_FLAG, provider);
}

/**
 * The connection a chat generates on: which, whether it is this extension's loopback, and whether
 * it is another's (`foreign`: the loopback of another extension that has LumiAH built in, or
 * LumiAH's own seen from such an extension, by that extension's identifier; a reply there is that
 * extension's runtime's to answer, and none of this one's).
 */
export interface ChatConnection {
  id: string;
  name: string;
  loopback: boolean;
  foreign: string | null;
}

export interface ConnectionsDeps {
  /** The model this extension's loopback connection names (`loopbackModel`). */
  model: string;
  /** Where Lumiverse reaches each of the user's runtimes (`http://127.0.0.1:<port>/v1`). */
  bases(userId: string): Promise<string[]>;
  /** The connections the user's settings say take one tool call per answer, by id. */
  serialTools(userId: string): Promise<readonly string[]>;
}

export class Connections {
  /** The connection each user's page last said is selected in Lumiverse (null: none), for a Lumiverse that doesn't say so itself. One small entry a user, as long as the extension runs. */
  private readonly told = new Map<string, string | null>();

  constructor(
    private readonly host: Pick<BackendHost, "connections">,
    private readonly deps: ConnectionsDeps,
  ) {}

  /** A page of the user's says which connection is selected in Lumiverse, as it reads it there (null: none). True when that is news. */
  pageSaid(userId: string, active: string | null): boolean {
    if (this.told.has(userId) && this.told.get(userId) === active) return false;
    this.told.set(userId, active);
    return true;
  }

  /** A loopback: an OpenAI-compatible connection that names this extension's loopback model, or whose address is one of the user's runtimes' and that names no other extension's. The runtime looks for the same when it puts the key in one. */
  private loops(c: HostConnection, bases: readonly string[]): boolean {
    return c.provider === LOOPBACK_PROVIDER && loopsBack(c, this.deps.model, bases);
  }

  private info(c: HostConnection, bases: readonly string[]): ConnectionInfo {
    return { id: c.id, name: c.name, provider: c.provider, model: c.model === "" ? null : c.model, loopback: this.loops(c, bases) };
  }

  /** The user's connections as Lumiverse lists them. */
  raw(userId: string): Promise<HostConnection[]> {
    return this.host.connections.list(userId);
  }

  async list(userId: string): Promise<ConnectionInfo[]> {
    const bases = await this.deps.bases(userId);
    return (await this.raw(userId)).map((c) => this.info(c, bases));
  }

  async views(userId: string): Promise<ConnectionView[]> {
    return (await this.list(userId)).map((c) => ({ id: c.id, name: c.name, provider: c.provider, model: c.model, loopback: c.loopback }));
  }

  /**
   * One connection as Lumiverse has it; null when there is none. `connectionId` null is the user's
   * default: where Lumiverse runs a call that names no connection, which is the connection marked
   * default and no other (its `resolveConnection`). The connection the user has selected counts
   * for a chat's own replies alone (`ofChat`).
   */
  async one(userId: string, connectionId: string | null): Promise<HostConnection | null> {
    if (connectionId !== null) return this.host.connections.get(connectionId, userId);
    return (await this.raw(userId)).find((c) => c.isDefault) ?? null;
  }

  /** `connections.get`: one connection as the loop needs it (null: the user's default). */
  async profile(userId: string, connectionId: string | null): Promise<ConnectionProfile | null> {
    const c = await this.one(userId, connectionId);
    if (c === null) return null;
    const serial = await this.deps.serialTools(userId);
    return { ...this.info(c, await this.deps.bases(userId)), cache: cacheBreakpoints(c.provider, c.metadata), parallelTools: !serial.includes(c.id) };
  }

  /** The user's loopback connections. */
  async loopbacks(userId: string): Promise<HostConnection[]> {
    const bases = await this.deps.bases(userId);
    return (await this.raw(userId)).filter((c) => this.loops(c, bases));
  }

  /** One connection (null: the user's default) and whether a call on it would come back to a runtime; null when there is no such connection. */
  async resolve(userId: string, connectionId: string | null): Promise<{ connection: HostConnection; loopback: boolean } | null> {
    const c = await this.one(userId, connectionId);
    return c === null ? null : { connection: c, loopback: this.loops(c, await this.deps.bases(userId)) };
  }

  /** Whether a call on this connection (null: the user's default) would come back to a runtime. An unknown connection is none. */
  async isLoopback(userId: string, connectionId: string | null): Promise<boolean> {
    return (await this.resolve(userId, connectionId))?.loopback === true;
  }

  /**
   * The connection a chat generates on now, by the order Lumiverse itself takes for a reply (its
   * `resolveChatGenerationConnection`): the chat's own pin while that connection is there; else the
   * connection the user has selected (their active profile); else their default; else the first of
   * their connections as Lumiverse lists them, the one changed last. Null when they have none.
   */
  async ofChat(userId: string, chat: HostChat): Promise<ChatConnection | null> {
    const pin = chat.metadata.connection_profile_id;
    const pinned = typeof pin === "string" && pin.trim() !== "" ? await this.host.connections.get(pin.trim(), userId) : null;
    const c = pinned ?? (await this.unpinned(userId));
    if (c === null) return null;
    // Every extension's loopback model is LumiAH's own or starts with it (`loopbackModel`).
    const theirs = c.provider === LOOPBACK_PROVIDER && c.model !== this.deps.model ? (c.model === MODEL_ID ? EXTENSION_IDENTIFIER : c.model.startsWith(`${MODEL_ID}-`) ? c.model.slice(MODEL_ID.length + 1) : null) : null;
    return { id: c.id, name: c.name, loopback: this.loops(c, await this.deps.bases(userId)), foreign: theirs };
  }

  /** The connection a reply goes on in a chat that pins none. Which one is selected is Lumiverse's own word where it gives one, else the last word of a page of the user's. */
  private async unpinned(userId: string): Promise<HostConnection | null> {
    const said = await this.host.connections.active(userId);
    const selected = said !== undefined ? said : (this.told.get(userId) ?? null);
    const active = selected === null ? null : await this.host.connections.get(selected, userId);
    if (active !== null) return active;
    const all = await this.raw(userId);
    return all.find((c) => c.isDefault) ?? all[0] ?? null;
  }
}
