// The model calls the runtime asks for (DESIGN §7): each made through Lumiverse's generation API on
// the connection named, streamed, its usage as the provider gave it, its answer sent back on the
// stream the runtime named. An agent's call (`model.call`) is the core's own request; a passthrough
// is a request that reached the loopback with no tag, run as it came on the writer's connection.
//
// No call goes on a loopback connection: it would come back to the runtime and wait on itself.

import type { ModelDelta, ModelMessage, ModelRequest, ModelResult, ModelTool } from "../../core/ports";
import type { PassedMessage, PassedPart, PassedTool } from "../../link/contract";
import { STREAM_ID } from "../../link/contract";
import { isRecord, toJsonObject } from "../../link/json";
import type { Connections } from "./connections";
import { takesParallelFlag } from "./connections";
import { LinkRefused, wordsOf, wrongKey } from "./errors";
import type { RegistryStore } from "./registry";
import type { Caller } from "./relays";
import type { SettingsStore } from "./settings";
import type { BackendHost, HostConnection } from "./spindle";
import type { StreamRegistry, StreamWriter } from "./streams";

const isMessage = (m: unknown): m is ModelMessage => isRecord(m) && (m.role === "system" || m.role === "user" || m.role === "assistant") && typeof m.content === "string" && (m.parts === undefined || Array.isArray(m.parts));
const isTool = (t: unknown): t is ModelTool => isRecord(t) && typeof t.name === "string" && typeof t.description === "string" && isRecord(t.parameters);

/** A call's request as it crossed, its envelope checked; null when it isn't one. Past that it is the runtime's own, taken as the core made it. */
function requestOf(raw: unknown): ModelRequest | null {
  if (!isRecord(raw) || !Array.isArray(raw.messages) || !raw.messages.every(isMessage)) return null;
  if (typeof raw.maxTokens !== "number" || !Number.isFinite(raw.maxTokens) || raw.maxTokens <= 0) return null;
  if (!(raw.connectionId === null || typeof raw.connectionId === "string") || !(raw.model === null || typeof raw.model === "string")) return null;
  if (raw.tools !== undefined && !(Array.isArray(raw.tools) && raw.tools.every(isTool))) return null;
  return raw as unknown as ModelRequest;
}

/** Whether an object has no field but those named. A field this build doesn't know would be left out of what the model is sent, so a passed-through request that holds one is refused instead. */
const onlyKeys = (o: Record<string, unknown>, keys: readonly string[]): boolean => Object.keys(o).every((k) => keys.includes(k));

/** A part of a passed-through message as it crossed, checked. */
function isPassedPart(p: unknown): p is PassedPart {
  if (!isRecord(p) || !(p.cacheControl === undefined || isRecord(p.cacheControl))) return false;
  switch (p.type) {
    case "text":
      return typeof p.text === "string" && onlyKeys(p, ["type", "text", "cacheControl"]);
    case "media":
      return (p.media === "image" || p.media === "audio" || p.media === "video") && typeof p.data === "string" && typeof p.mimeType === "string" && onlyKeys(p, ["type", "media", "data", "mimeType", "cacheControl"]);
    case "tool_use":
      return typeof p.id === "string" && typeof p.name === "string" && isRecord(p.input) && onlyKeys(p, ["type", "id", "name", "input"]);
    case "tool_result":
      return typeof p.toolUseId === "string" && typeof p.content === "string" && onlyKeys(p, ["type", "toolUseId", "content", "cacheControl"]);
    default:
      return false;
  }
}

/** A passed-through message as it crossed, checked: the fields its type has, each of its type, and no other. */
function isPassedMessage(m: unknown): m is PassedMessage {
  if (!isRecord(m) || !(m.role === "system" || m.role === "user" || m.role === "assistant") || !onlyKeys(m, ["role", "content", "name", "prefix", "cacheControl", "reasoning", "reasoningDetails"])) return false;
  if (!(typeof m.content === "string" || (Array.isArray(m.content) && m.content.every(isPassedPart)))) return false;
  if (!(m.name === undefined || typeof m.name === "string") || !(m.prefix === undefined || m.prefix === true) || !(m.cacheControl === undefined || isRecord(m.cacheControl)) || !(m.reasoning === undefined || typeof m.reasoning === "string")) return false;
  return m.reasoningDetails === undefined || (Array.isArray(m.reasoningDetails) && m.reasoningDetails.every(isRecord));
}

const isPassedTool = (t: unknown): t is PassedTool => isRecord(t) && typeof t.name === "string" && typeof t.description === "string" && isRecord(t.parameters) && (t.strict === undefined || typeof t.strict === "boolean") && onlyKeys(t, ["name", "description", "parameters", "strict"]);

function streamOf(raw: unknown, name: string): string {
  if (typeof raw !== "string" || !STREAM_ID.test(raw)) throw new LinkRefused("bad_request", `A stream is named by 32 hex characters: update the runtime and ${name} to the same build.`);
  return raw;
}

/** A call that can't be made on its connection (there is none, or it is the loopback), with the link's code for which. */
class CallRefused extends Error {
  constructor(
    message: string,
    readonly code: "connection" | "loopback",
  ) {
    super(message);
    this.name = "CallRefused";
  }
}

export interface ModelsDeps {
  connections: Connections;
  streams: StreamRegistry;
  settings: SettingsStore;
  registry: RegistryStore;
  /** The extension as its pages show it: a call that can't be made says where to pick another connection. */
  name: string;
}

export class Models {
  constructor(
    private readonly host: Pick<BackendHost, "models" | "log">,
    private readonly deps: ModelsDeps,
  ) {}

  /**
   * The connection a call goes on (`connectionId` null: the user's default), once it is known to be
   * one a call may go on. Rejects with why not, in words that say where to pick another, and the
   * link's code for it.
   */
  private async connectionFor(userId: string, connectionId: string | null, who: string): Promise<HostConnection> {
    const found = await this.deps.connections.resolve(userId, connectionId);
    const { name } = this.deps;
    if (found === null) throw new CallRefused(connectionId === null ? `${who} uses your default connection, and this account has none. Pick a connection in ${name}'s settings, or set a default one in Lumiverse.` : `${who} uses a connection that is no longer there. Pick another in ${name}'s settings.`, "connection");
    if (found.loopback) throw new CallRefused(`${who} is set to "${found.connection.name}", which is ${name}'s own loopback connection: a call on it would come back to the runtime and wait on itself. Pick another connection in ${name}'s settings${connectionId === null ? " (it is your default connection now)" : ""}.`, "loopback");
    return found.connection;
  }

  /** One call of an agent as Lumiverse takes it. A provider that refuses `parallel_tool_calls` gets the call without it: the loop still takes one tool call at a time from what comes back. */
  private agentCall(userId: string, connection: HostConnection, request: ModelRequest, signal: AbortSignal, onDelta: (delta: ModelDelta) => void): Promise<ModelResult> {
    const { parallelToolCalls: _serial, ...plain } = request;
    return this.host.models.call(request.parallelToolCalls === false && !takesParallelFlag(connection.provider) ? plain : request, userId, signal, onDelta);
  }

  /**
   * Runs one call and writes its answer, or what kept it from one, to its stream. `connectionId` null
   * is the user's default connection. `make` gets the connection the call goes on.
   */
  private async run(userId: string, writer: StreamWriter, connectionId: string | null, who: string, make: (connection: HostConnection, onDelta: (delta: ModelDelta) => void) => Promise<ModelResult>, deltas: boolean): Promise<void> {
    try {
      const connection = await this.connectionFor(userId, connectionId, who);
      writer.done(await make(connection, deltas ? writer.delta : () => undefined));
    } catch (error) {
      if (error instanceof CallRefused) writer.error(error.message, error.code);
      // The provider's or Lumiverse's own words: the core reads a refusal of native tools from them.
      else writer.error(wordsOf(error), writer.signal.aborted ? "cancelled" : "model_failed");
    }
  }

  /**
   * One call of an agent where the core runs here, built in (DESIGN §25): made as a runtime's is,
   * and answered to the caller. Rejects with the provider's or Lumiverse's own words, or with why
   * the connection can't be used; the signal ends the call.
   */
  async direct(userId: string, request: ModelRequest, signal: AbortSignal, onDelta?: (delta: ModelDelta) => void): Promise<ModelResult> {
    const connection = await this.connectionFor(userId, request.connectionId, "This agent");
    return this.agentCall(userId, connection, request, signal, request.stream === true && onDelta !== undefined ? onDelta : () => undefined);
  }

  /** `model.call`: one call of an agent, answered on the stream it names. Asked again for a stream already open (after a reconnect), the call under way is the answer. */
  async call(caller: Caller, fields: Record<string, unknown>): Promise<{ accepted: true }> {
    const stream = streamOf(fields.stream, this.deps.name);
    const request = requestOf(fields.request);
    if (request === null) throw new LinkRefused("bad_request", `The model call is malformed: update the runtime and ${this.deps.name} to the same build.`);
    const turn = typeof fields.turn === "string" && fields.turn !== "" ? fields.turn : null;
    const { streams, settings } = this.deps;
    const writer = streams.open(caller.userId, caller.relay.id, stream, turn, (await settings.transport(caller.userId)).streams);
    if (writer === null) return { accepted: true };
    void this.run(caller.userId, writer, request.connectionId, "This agent", (connection, onDelta) => this.agentCall(caller.userId, connection, request, writer.signal, onDelta), request.stream === true);
    return { accepted: true };
  }

  /** `passthrough`: an untagged request, run as it came on the connection named (the writer's), answered on the stream it names. */
  async pass(caller: Caller, fields: Record<string, unknown>): Promise<{ accepted: true }> {
    const stream = streamOf(fields.stream, this.deps.name);
    const { key, connection, messages, tools, parameters } = fields;
    if (typeof key !== "string" || !(connection === null || typeof connection === "string") || !Array.isArray(messages) || !messages.every(isPassedMessage) || !Array.isArray(tools) || !tools.every(isPassedTool) || !isRecord(parameters)) {
      throw new LinkRefused("bad_request", `The passed-through request is malformed: update the runtime and ${this.deps.name} to the same build.`);
    }
    if (!(await this.deps.registry.keyIs(caller.userId, key))) throw wrongKey(this.deps.name);
    const { streams, settings } = this.deps;
    const writer = streams.open(caller.userId, caller.relay.id, stream, null, (await settings.transport(caller.userId)).streams);
    if (writer === null) return { accepted: true };
    void this.run(caller.userId, writer, connection, `A request that reached ${this.deps.name}'s loopback without a turn is passed to the writer, which`, (_connection, onDelta) => this.host.models.pass({ connectionId: connection, messages, tools, parameters: toJsonObject(parameters) }, caller.userId, writer.signal, onDelta), true);
    return { accepted: true };
  }
}
