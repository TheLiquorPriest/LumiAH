// The user's connections in Lumiverse as the pages see them: which exist, each one's provider and
// model, and which are loopbacks. A loopback connection is one whose calls come back to one of this
// extension's runtimes: LumiAH answers a chat exactly when the connection it generates on is one.
// The loopback of another extension that has LumiAH built in is none of this one's (DESIGN §21).
// The agents call their models on their runtime's own connections (runtime/models), never on
// these: what "Copy from Lumiverse" takes from here is a connection's name, provider, address and
// model, never its key.

import { EXTENSION_IDENTIFIER, MODEL_ID, loopsBack } from "../../link/contract";
import type { ConnectionView, LumiverseConnection } from "../../shared/ui";
import type { BackendHost, HostChat, HostConnection } from "./spindle";

/** Lumiverse's provider for an OpenAI-compatible endpoint the user names: what a loopback connection is made as. */
export const LOOPBACK_PROVIDER = "custom";

/** Whether a connection names the loopback model of LumiAH or of an extension that has it built in: every one is LumiAH's own or starts with it (`loopbackModel`). */
function anyLoopbackModel(c: HostConnection): boolean {
  return c.provider === LOOPBACK_PROVIDER && (c.model === MODEL_ID || c.model.startsWith(`${MODEL_ID}-`));
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

  /** The user's connections as Lumiverse lists them. */
  raw(userId: string): Promise<HostConnection[]> {
    return this.host.connections.list(userId);
  }

  async views(userId: string): Promise<ConnectionView[]> {
    const bases = await this.deps.bases(userId);
    return (await this.raw(userId)).map((c) => ({ id: c.id, name: c.name, provider: c.provider, model: c.model === "" ? null : c.model, loopback: this.loops(c, bases) }));
  }

  /** Lumiverse's connections a runtime's may be copied from ("Copy from Lumiverse"): every one but a loopback (LumiAH's own or another extension's), by its name, Lumiverse's provider, its address and model; never its key. */
  async lumiverse(userId: string): Promise<LumiverseConnection[]> {
    const bases = await this.deps.bases(userId);
    return (await this.raw(userId)).filter((c) => !this.loops(c, bases) && !anyLoopbackModel(c)).map((c) => ({ id: c.id, name: c.name, provider: c.provider, baseUrl: c.url === "" ? null : c.url, model: c.model === "" ? null : c.model }));
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

  /** The connection the user has selected in Lumiverse now (their active profile), by its id: Lumiverse's own word where it gives one, else the last word of a page of the user's; null where none is known. */
  private async selectedId(userId: string): Promise<string | null> {
    const said = await this.host.connections.active(userId);
    return said !== undefined ? said : (this.told.get(userId) ?? null);
  }

  /** The connection a reply goes on in a chat that pins none: the one selected, else the default, else the first listed. */
  private async unpinned(userId: string): Promise<HostConnection | null> {
    const selected = await this.selectedId(userId);
    const active = selected === null ? null : await this.host.connections.get(selected, userId);
    if (active !== null) return active;
    const all = await this.raw(userId);
    return all.find((c) => c.isDefault) ?? all[0] ?? null;
  }
}
