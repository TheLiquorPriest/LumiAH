// The model calls the runtime asks for (DESIGN §7): each made through Lumiverse's generation API on
// the connection named, streamed, its usage as the provider gave it, its answer sent back on the
// stream the runtime named. An agent's call (`model.call`) is the core's own request; a passthrough
// is a request that reached the loopback with no tag, run as it came on the writer's connection.
//
// No call goes on a loopback connection: it would come back to the runtime and wait on itself.

import type { ModelDelta, ModelMessage, ModelRequest, ModelResult, ModelTool } from "../../core/ports";
import { STREAM_ID } from "../../link/contract";
import { isRecord, toJsonObject } from "../../link/json";
import type { Connections } from "./connections";
import { takesParallelFlag } from "./connections";
import { LinkRefused, wordsOf } from "./errors";
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

function streamOf(raw: unknown): string {
  if (typeof raw !== "string" || !STREAM_ID.test(raw)) throw new LinkRefused("bad_request", "A stream is named by 32 hex characters: update the runtime and LumiAH to the same build.");
  return raw;
}

export interface ModelsDeps {
  connections: Connections;
  streams: StreamRegistry;
  settings: SettingsStore;
  registry: RegistryStore;
}

export class Models {
  constructor(
    private readonly host: Pick<BackendHost, "models" | "log">,
    private readonly deps: ModelsDeps,
  ) {}

  /**
   * Runs one call and writes its answer, or what kept it from one, to its stream. `connectionId` null
   * is the user's default connection. `make` gets the connection the call goes on.
   */
  private async run(userId: string, writer: StreamWriter, connectionId: string | null, who: string, make: (connection: HostConnection, onDelta: (delta: ModelDelta) => void) => Promise<ModelResult>, deltas: boolean): Promise<void> {
    try {
      const found = await this.deps.connections.resolve(userId, connectionId);
      if (found === null) {
        writer.error(connectionId === null ? `${who} uses your default connection, and this account has none. Pick a connection in LumiAH's settings, or set a default one in Lumiverse.` : `${who} uses a connection that is no longer there. Pick another in LumiAH's settings.`, "connection");
        return;
      }
      if (found.loopback) {
        writer.error(`${who} is set to "${found.connection.name}", which is LumiAH's own loopback connection: a call on it would come back to the runtime and wait on itself. Pick another connection in LumiAH's settings${connectionId === null ? " (it is your default connection now)" : ""}.`, "loopback");
        return;
      }
      writer.done(await make(found.connection, deltas ? writer.delta : () => undefined));
    } catch (error) {
      // The provider's or Lumiverse's own words: the core reads a refusal of native tools from them.
      writer.error(wordsOf(error), writer.signal.aborted ? "cancelled" : "model_failed");
    }
  }

  /** `model.call`: one call of an agent, answered on the stream it names. Asked again for a stream already open (after a reconnect), the call under way is the answer. */
  async call(caller: Caller, fields: Record<string, unknown>): Promise<{ accepted: true }> {
    const stream = streamOf(fields.stream);
    const request = requestOf(fields.request);
    if (request === null) throw new LinkRefused("bad_request", "The model call is malformed: update the runtime and LumiAH to the same build.");
    const turn = typeof fields.turn === "string" && fields.turn !== "" ? fields.turn : null;
    const { streams, settings } = this.deps;
    const writer = streams.open(caller.userId, caller.relay.id, stream, turn, (await settings.transport(caller.userId)).streams);
    if (writer === null) return { accepted: true };
    void this.run(
      caller.userId,
      writer,
      request.connectionId,
      "This agent",
      (connection, onDelta) => {
        // A provider that refuses `parallel_tool_calls` gets the call without it: the loop still takes one tool call at a time from what comes back.
        const { parallelToolCalls: _serial, ...plain } = request;
        return this.host.models.call(request.parallelToolCalls === false && !takesParallelFlag(connection.provider) ? plain : request, caller.userId, writer.signal, onDelta);
      },
      request.stream === true,
    );
    return { accepted: true };
  }

  /** `passthrough`: an untagged request, run as it came on the connection named (the writer's), answered on the stream it names. */
  async pass(caller: Caller, fields: Record<string, unknown>): Promise<{ accepted: true }> {
    const stream = streamOf(fields.stream);
    const { key, connection, messages, tools, parameters } = fields;
    if (typeof key !== "string" || !(connection === null || typeof connection === "string") || !Array.isArray(messages) || !messages.every(isMessage) || !Array.isArray(tools) || !tools.every(isTool) || !isRecord(parameters)) {
      throw new LinkRefused("bad_request", "The passed-through request is malformed: update the runtime and LumiAH to the same build.");
    }
    if (!(await this.deps.registry.keyIs(caller.userId, key))) throw new LinkRefused("forbidden", "The key in the loopback connection isn't this account's loopback key. Mint a new one on LumiAH's Runtime page: your linked runtime puts it in the connection.");
    const { streams, settings } = this.deps;
    const writer = streams.open(caller.userId, caller.relay.id, stream, null, (await settings.transport(caller.userId)).streams);
    if (writer === null) return { accepted: true };
    void this.run(caller.userId, writer, connection, "A request that reached LumiAH's loopback without a turn is passed to the writer, which", (_connection, onDelta) => this.host.models.pass({ connectionId: connection, messages, tools, parameters: toJsonObject(parameters) }, caller.userId, writer.signal, onDelta), true);
    return { accepted: true };
  }
}
