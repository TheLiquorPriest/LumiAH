// MCP tools (DESIGN §16). A server the user set up in Lumiverse offers its tools to LumiAH's agents
// once the user switches it on for them: each tool is named `mcp:<server>:<tool>`, and a call goes
// through Lumiverse (`spindle.mcp`), which holds the connection and applies its own rules on what a
// server may reach. LumiAH never sees where a server is or what secrets it takes.
//
// `<server>` is the server's name made safe for a tool's name (lowercase letters, digits and `-`),
// so an agent definition that names a tool keeps naming it while the server keeps its name.

import type { JsonObject } from "../../core/ports";
import { spanWords, transportWait } from "../../link/waits";
import type { BackendHost, HostMcpServer } from "./spindle";

/** What every MCP tool's name starts with. */
export const MCP_PREFIX = "mcp:";

/** A tool of an MCP server as the registry lists it. */
export interface McpTool {
  /** `mcp:<server>:<tool>`. */
  name: string;
  /** `mcp:<server>`: what an agent definition names to be given every tool of the server. */
  family: string;
  serverId: string;
  serverName: string;
  /** The tool's name on its server. */
  tool: string;
  description: string;
  /** Its arguments' JSON Schema, as the server gives it. */
  parameters: JsonObject;
}

/** One of the user's MCP servers as the page shows it. */
export interface McpServerState {
  id: string;
  name: string;
  /** Its part of its tools' names. */
  slug: string;
  /** Switched on in Lumiverse. */
  enabled: boolean;
  /** Switched on for LumiAH's agents. */
  on: boolean;
  /** Its tools' names (`mcp:<server>:<tool>`) while it is on and connected; none otherwise. */
  tools: string[];
  /** Why its tools aren't offered though it is on, in plain words that say what to do; null when they are, or it is off. */
  problem: string | null;
}

export interface McpDeps {
  /** The servers the user switched on for agents, by id. */
  on(userId: string): Promise<readonly string[]>;
  /** How long one call may take, as the user's settings say. */
  callMs(userId: string): Promise<number>;
  /** Runs `fn` once after `ms`; what it returns cancels that. */
  later(ms: number, fn: () => void): () => void;
  /** The extension's name, as a call that runs out of time names where its setting is: `<name>'s Settings`. */
  name: string;
  /** Where its Settings are shown, where that isn't "<name>'s Settings" (`BackendIdentity.settingsAt`). */
  settingsAt?: string;
}

/** A server's name as part of a tool's name: lowercase letters, digits and `-`; `server` for a name with none of them. The length is the most a tool's name leaves room for; a format, not a limit. */
export function mcpSlug(name: string): string {
  const slug = name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 32)
    .replace(/-+$/, "");
  return slug === "" ? "server" : slug;
}

/** Each server's slug, one of a kind among them: where two names come to the same, the server made later takes a number. */
export function mcpSlugs(servers: readonly HostMcpServer[]): Map<string, string> {
  const out = new Map<string, string>();
  const taken = new Set<string>();
  for (const s of [...servers].sort((a, b) => a.createdAt - b.createdAt || (a.id < b.id ? -1 : 1))) {
    const base = mcpSlug(s.name);
    let slug = base;
    for (let n = 2; taken.has(slug); n++) slug = `${base}-${n}`;
    taken.add(slug);
    out.set(s.id, slug);
  }
  return out;
}

/** A tool's name taken apart: its server's slug and the tool's own name there; null when it isn't an MCP tool's. */
export function mcpNameOf(name: string): { slug: string; tool: string } | null {
  if (!name.startsWith(MCP_PREFIX)) return null;
  const rest = name.slice(MCP_PREFIX.length);
  const at = rest.indexOf(":");
  return at <= 0 || at === rest.length - 1 ? null : { slug: rest.slice(0, at), tool: rest.slice(at + 1) };
}

const words = (error: unknown): string => (error instanceof Error ? error.message : String(error));

export class Mcp {
  constructor(
    private readonly host: Pick<BackendHost, "mcp" | "granted" | "log">,
    private readonly deps: McpDeps,
  ) {}

  /** The servers and what each offers now. A server that is on but whose tools can't be had says why, and offers none. */
  private async read(userId: string): Promise<{ states: McpServerState[]; tools: McpTool[] }> {
    const servers = await this.host.mcp.servers(userId);
    const on = await this.deps.on(userId);
    const slugs = mcpSlugs(servers);
    const tools: McpTool[] = [];
    const states: McpServerState[] = [];
    for (const server of servers) {
      const slug = slugs.get(server.id) ?? mcpSlug(server.name);
      const state: McpServerState = { id: server.id, name: server.name, slug, enabled: server.enabled, on: on.includes(server.id), tools: [], problem: null };
      states.push(state);
      if (!state.on) continue;
      if (!server.enabled) {
        state.problem = `"${server.name}" is switched off in Lumiverse, so its tools aren't offered. Switch it on in Lumiverse's MCP settings.`;
        continue;
      }
      try {
        for (const t of await this.host.mcp.tools(server.id, userId)) {
          const tool: McpTool = { name: `${MCP_PREFIX}${slug}:${t.name}`, family: `${MCP_PREFIX}${slug}`, serverId: server.id, serverName: server.name, tool: t.name, description: t.description, parameters: t.parameters };
          tools.push(tool);
          state.tools.push(tool.name);
        }
      } catch (error) {
        state.problem = `"${server.name}" couldn't be reached, so its tools aren't offered (${words(error)}). Check it in Lumiverse's MCP settings.`;
      }
    }
    return { states, tools };
  }

  /** The user's servers as the page shows them. Without the permission, there are none to show: the page says so from the backend's issues. */
  async servers(userId: string): Promise<McpServerState[]> {
    return (await this.read(userId)).states;
  }

  /** Every tool of every server the user switched on for agents, as the registry lists them. */
  async tools(userId: string): Promise<McpTool[]> {
    // No server is on for most users: then Lumiverse isn't asked at all.
    if ((await this.deps.on(userId)).length === 0) return [];
    return (await this.read(userId)).tools;
  }

  /**
   * Calls the tool `name` names, with `args`. Refused, in words the agent can act on, when the name
   * is no tool of a server that is on. The signal ends the wait; Lumiverse has no way to end the call
   * itself, which then runs to its own end or its time limit. That limit is the user's Call time,
   * waited here too from before Lumiverse is asked, so a call that runs out of it says so in words
   * that name the setting and where it is changed, ahead of Lumiverse's own.
   */
  async call(userId: string, name: string, args: JsonObject, signal: AbortSignal): Promise<string> {
    const named = mcpNameOf(name);
    if (named === null) throw new Error(`"${name}" isn't an MCP tool's name: one is ${MCP_PREFIX}<server>:<tool>.`);
    const servers = await this.host.mcp.servers(userId);
    const slugs = mcpSlugs(servers);
    const server = servers.find((s) => slugs.get(s.id) === named.slug);
    if (server === undefined) throw new Error(`There is no MCP server "${named.slug}" now: it was removed or renamed in Lumiverse.`);
    if (!(await this.deps.on(userId)).includes(server.id)) throw new Error(`The MCP server "${server.name}" isn't switched on for LumiAH's agents.`);
    if (!server.enabled) throw new Error(`The MCP server "${server.name}" is switched off in Lumiverse.`);
    signal.throwIfAborted();
    const { promise, resolve, reject } = Promise.withResolvers<string>();
    const ended = (): void => reject(signal.reason instanceof Error ? signal.reason : new Error("The call was cancelled."));
    signal.addEventListener("abort", ended, { once: true });
    const callMs = await this.deps.callMs(userId);
    const late = this.deps.later(callMs, () => reject(new Error(`The MCP tool ${name} didn't answer within ${spanWords(callMs)}. ${transportWait(["mcp", "callMs"], this.deps)} says how long one call may take.`)));
    this.host.mcp.call(server.id, named.tool, args, callMs, userId).then(resolve, reject);
    try {
      return await promise;
    } finally {
      late();
      signal.removeEventListener("abort", ended);
    }
  }
}
