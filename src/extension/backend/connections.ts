// The user's connections as the core's port and the pages see them (DESIGN §4.2 `connections`):
// which exist, each one's provider and model, what the loop must know of it (its cache breakpoints,
// whether it takes several tool calls in one answer), and which are loopbacks. A loopback connection
// is one whose calls come back to a runtime: LumiAH answers a chat exactly when the connection it
// generates on is one, and no agent's own call may go on one.

import type { ConnectionInfo, ConnectionProfile } from "../../core/ports";
import { MODEL_ID } from "../../link/contract";
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

const sameUrl = (a: string, b: string): boolean => a.trim().replace(/\/+$/, "").toLowerCase() === b.trim().replace(/\/+$/, "").toLowerCase();

export interface ConnectionsDeps {
  /** Where Lumiverse reaches each of the user's runtimes (`http://127.0.0.1:<port>/v1`). */
  bases(userId: string): Promise<string[]>;
  /** The connections the user's settings say take one tool call per answer, by id. */
  serialTools(userId: string): Promise<readonly string[]>;
}

export class Connections {
  constructor(
    private readonly host: Pick<BackendHost, "connections">,
    private readonly deps: ConnectionsDeps,
  ) {}

  /** A loopback: an OpenAI-compatible connection that names LumiAH's model, or whose address is one of the user's runtimes'. The runtime looks for the same when it puts the key in one. */
  private loops(c: HostConnection, bases: readonly string[]): boolean {
    return c.provider === LOOPBACK_PROVIDER && (c.model === MODEL_ID || bases.some((base) => sameUrl(base, c.url)));
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

  /** One connection as Lumiverse has it (null: the user's default); null when there is none. */
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

  /** The connection a chat generates on now: its own pin, else the user's default; null when Lumiverse names none. */
  async ofChat(userId: string, chat: HostChat): Promise<{ id: string; name: string; loopback: boolean } | null> {
    const pin = chat.metadata.connection_profile_id;
    const all = await this.raw(userId);
    const c = (typeof pin === "string" && pin !== "" ? all.find((x) => x.id === pin) : undefined) ?? all.find((x) => x.isDefault) ?? null;
    return c === null ? null : { id: c.id, name: c.name, loopback: this.loops(c, await this.deps.bases(userId)) };
  }
}
