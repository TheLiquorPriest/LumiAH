// The extension backend, put together (DESIGN §7): the prompt interceptor, the link server for the
// runtime, the model calls, the stores in the user's storage, the anchors, the live buffer and the
// pages' requests, over one host (spindle.ts in Lumiverse, a fake in the tests).

import type { ClaimAsk } from "../../core/extension";
import type { HeldTools } from "../../core/definitions";
import { AGENT, CORE_AGENTS, CORE_TOOLS, checkSettings, defaultSettings, RETIRED_SETTINGS, SETTINGS_SCHEMA, type SettingsScope, settingsOf } from "../../core/settings";
import { checkText, TEXT_DEFS } from "../../core/texts";
import type { JsonObject } from "../../core/ports";
import { LINK, loopbackModel, runtimeBase, sameBase } from "../../link/contract";
import { isRecord } from "../../link/json";
import { CEILINGS, checkTransport, TRANSPORT_KEY, TRANSPORT_RETIRED, TRANSPORT_SCHEMA, transportDefaults } from "../../link/settings";
import { Timings } from "../../link/timings";
import type { PermissionNeed, RuntimeState, RuntimeView } from "../../shared/ui";
import { Approvals } from "./approvals";
import { Asks } from "./asks";
import { type AnchorCodec, anchorsUnder, Chats, OWN_ANCHORS } from "./chat";
import { CopyFeed, type OwnElsewhere } from "./copy";
import { randomHex } from "./docs";
import { Definitions } from "./defs";
import { type BackendExtension, type BackendTools, RemoteTools } from "./extension";
import { Forgotten } from "./forget";
import { JobsBoard } from "./jobs";
import { Mcp } from "./mcp";
import { Notices } from "./notices";
import { CORS_PROXY, ProxyRoad } from "./proxy";
import { OpenTurns } from "./open";
import { Connections } from "./connections";
import { wordsOf } from "./errors";
import { Keys } from "./keys";
import { LiveBuffer } from "./live";
import { Mirrors } from "./mirror";
import { Lore, Presets, Storage } from "./reads";
import { Recall } from "./recall";
import { RegistryStore } from "./registry";
import { Relays } from "./relays";
import { LinkServer } from "./server";
import { SessionsPage } from "./sessions";
import type { SettingsSection } from "./settings";
import { SettingsStore } from "./settings";
import { type BackendIdentity, identityOf } from "./identity";
import type { BackendHost } from "./spindle";
import { StreamRegistry } from "./streams";
import { ChatSwitch } from "./switch";
import { INTERCEPTOR_PRIORITY, TAGGED_TYPES, Turns } from "./turns";
import { Ui } from "./ui";
import { heldView } from "./views";

export interface BackendEnv {
  now(): number;
  /** Runs `fn` once after `ms`; what it returns cancels that. */
  later(ms: number, fn: () => void): () => void;
  /** The build this bundle came from: runtimes compare theirs with it. */
  build: string;
  /**
   * The runtime this build ships beside its backend (`dist/lumiah.js`): its sha256 (hex) and size,
   * which the build writes in beside the build id. A runtime that says hello on another build is
   * offered it. Absent, or not a whole hash and size (a development build): no runtime is offered it.
   */
  runtime?: { sha256: string; size: number };
}

/** The key the core's settings sit under, beside the transport's. */
export const CORE_KEY = "core";

/** Why a change that names an agent or tool only the runtime knows is refused while no runtime says what the user's runs have. */
const RUNTIME_JUDGES = "Only your runtime knows this agent or tool (your own agent, or an extension's or MCP server's tool), and it isn't linked now. Start the runtime (its line is on the Runtime page), then make this change again.";

/** A scope that takes every agent and every tool `values` names: what a check under it still refuses is wrong whatever the user's runs have, so it needs no runtime to judge. */
function namedScope(values: unknown): SettingsScope {
  const agents = isRecord(values) && isRecord(values.agents) ? values.agents : {};
  const tools = new Set(CORE_TOOLS);
  for (const agent of Object.values(agents)) if (isRecord(agent) && Array.isArray(agent.tools)) for (const tool of agent.tools) if (typeof tool === "string") tools.add(tool);
  // What an agent runs with by default is no part of what a check refuses.
  const defaults = defaultSettings().agents[AGENT.main];
  return { tools: [...tools], agents: Object.keys(agents).filter((id) => !CORE_AGENTS.includes(id)).map((id) => ({ id, label: id, note: "", defaults })) };
}

/**
 * The settings' sections: the core's and the transport's. An extension that uses LumiAH's pieces
 * adds its own beside them. `scope` gives what a user's runs have beyond the core's own (their
 * extension's and MCP servers' tools, their own agents): with it, a setting that names one of those
 * is taken. Without it (no runtime is linked to say), what only the runtime can judge is judged
 * only where a change sets or resets it, and is refused there in words that say the runtime is needed.
 */
export function settingsSections(scope?: (userId: string) => Promise<SettingsScope | undefined>): SettingsSection[] {
  return [
    {
      key: CORE_KEY,
      defaults: () => defaultSettings() as unknown as JsonObject,
      schema: SETTINGS_SCHEMA,
      retired: RETIRED_SETTINGS,
      async check(values, userId, changed) {
        const known = await scope?.(userId);
        const plain = checkSettings(values);
        const key = (problem: { path: readonly (string | number)[] }): string => JSON.stringify(problem.path.map(String));
        if (known === undefined) {
          // Under a scope that takes every agent and tool the values name, what is still refused is wrong whatever the user's runs have. The rest is a name only the runtime knows: kept as it is when the change doesn't touch it, else refused for want of the runtime, never as "no such setting".
          // Inside an agent only the runtime knows, the linked check refuses nothing deeper than the agent itself (its names aren't known there), so a value kept there refuses only a change that sets or resets it: else one such value would refuse every change until the runtime links.
          const touched = (path: readonly (string | number)[]): boolean => changed.some((place) => place.every((k, i) => i >= path.length || String(path[i]) === k));
          const all = checkSettings(values, namedScope(values));
          const judged = new Set(all.map(key));
          const named = all.filter((problem) => !(problem.path[0] === "agents" && problem.path.length > 1 && !CORE_AGENTS.includes(String(problem.path[1]))) || touched(problem.path));
          return [...named, ...plain.filter((problem) => !judged.has(key(problem)) && touched(problem.path)).map((problem) => ({ path: problem.path, message: RUNTIME_JUDGES }))];
        }
        // The user's scope is there to take more names, never fewer: a value is refused only when it is refused both ways. Checked by the scope alone, a tool the core has but this place doesn't offer just now (a port its Lumiverse lacks) would refuse the defaults that name it, and with them every change of any setting.
        const refused = new Set(plain.map(key));
        return checkSettings(values, known).filter((problem) => refused.has(key(problem)));
      },
      // The tools of an agent an extension keeps as its own are the extension's to set.
      async fixed(userId) {
        const known = await scope?.(userId);
        return (known?.agents ?? []).filter((agent) => agent.owns?.includes("tools") === true).map((agent) => ["agents", agent.id, "tools"]);
      },
    },
    { key: TRANSPORT_KEY, defaults: transportDefaults, schema: TRANSPORT_SCHEMA, check: checkTransport, retired: TRANSPORT_RETIRED },
  ];
}

/**
 * What each permission is for (`what`, which completes "To …") and what is absent without it
 * (`without`, which completes "Without it, …"). Lumiverse lets the user grant each one apart, and
 * an extension that builds LumiAH in may ask for fewer, so every one but those marked `needed` is
 * optional: without it the route it opens is quietly absent, and the pages say so as information.
 * `needed`: without it LumiAH answers no chat at all. `chat_mutation` is one of those because
 * Lumiverse puts reading a chat's messages under it, not only changing them; `generation_parameters`
 * because the tag that leads a reply to the runtime rides on a request's parameters.
 */
const NEEDS: readonly { id: string; needed: boolean; what: string; without: string }[] = [
  { id: "interceptor", needed: true, what: "see a reply's prompt before it is sent", without: "no reply is worked on" },
  { id: "chats", needed: true, what: "read a chat and switch itself on for it", without: "no chat can be switched on" },
  { id: "generation", needed: true, what: "hear when a reply starts, ends or is stopped", without: "no reply is worked on" },
  { id: "chat_mutation", needed: true, what: "read the chat's messages and write each reply's record on it", without: "no reply is worked on" },
  { id: "generation_parameters", needed: true, what: "tag the replies your runtime answers", without: "no reply is worked on" },
  { id: "world_books", needed: false, what: "read your world books", without: "agents can't look up lore" },
  { id: "presets", needed: false, what: "read the preset's instructions", without: "the agents know the preset only by the prompt it made" },
  { id: "characters", needed: false, what: "find the world books attached to the chat's character, and tell which character a piece of guidance is for", without: "those books aren't found, and guidance written for one character isn't matched" },
  { id: "personas", needed: false, what: "find the world book attached to your persona", without: "that book isn't found" },
  { id: "mcp_servers", needed: false, what: "offer its agents the tools of the MCP servers you set up in Lumiverse", without: "agents have no MCP tools" },
  { id: "embeddings", needed: false, what: "search lore and the chat by meaning on your embedding connection", without: "search is by word" },
  { id: "memories", needed: false, what: "read Lumiverse's Memory Cortex", without: "the memory tools aren't offered" },
  { id: "databanks", needed: false, what: "read your databanks", without: "the databank tools aren't offered" },
  { id: "web_search", needed: false, what: "search the web with your own provider", without: "web_search isn't offered" },
  { id: CORS_PROXY, needed: false, what: "reach your runtime on this machine through Lumiverse's own proxy, so a page's request doesn't wait behind a reply's traffic on the link", without: "pages reach the runtime over the link alone" },
];

export interface Backend {
  /** Every second or so: what waits on time alone (a runtime gone quiet, a record never anchored, a stream never acknowledged, a turn never ended, a frame whose parts stopped coming). */
  tick(): Promise<void>;
  /** Resolves once every write and push under way is done (tests). */
  settle(): Promise<void>;
  readonly registry: RegistryStore;
  readonly settings: SettingsStore;
  readonly relays: Relays;
  readonly streams: StreamRegistry;
  readonly turns: Turns;
  readonly live: LiveBuffer;
  readonly chats: Chats;
  readonly ui: Ui;
  readonly server: LinkServer;
  readonly approvals: Approvals;
  readonly notices: Notices;
  readonly asks: Asks;
  readonly jobs: JobsBoard;
  readonly defs: Definitions;
  /** The asks' road through Lumiverse's proxy to each runtime, as it stands. */
  readonly road: ProxyRoad;
  /** This end of the timing log: the asks it sent its runtimes. */
  readonly timings: Timings;
  /**
   * What each agent can really use in a chat, for the pages of an extension that builds LumiAH in:
   * each agent that can run there, the tools it holds, and each tool it names that it can't use,
   * with why (`off`: the user switched it off; `withdrawn`: the extension's claim withdraws it;
   * `unknown`: nothing of that name is registered). Asked of the runtime the chat's replies reach.
   */
  readonly agents: { held(userId: string, chatId: string): Promise<HeldTools[]> };
  /**
   * A user's runtime, for the pages of an extension that builds LumiAH in: whether it is linked
   * (asked about a chat, the one that chat's replies reach), whether it is there to choose, whether
   * a loopback connection exists, plain words for what to do while it isn't linked, and the Runtime
   * page's two lines. Reads what is held in memory and the user's cached documents: no page state
   * is built for it.
   */
  runtimeState(userId: string, chatId?: string | null): Promise<RuntimeState>;
  /** Hears when a user's runtime links, drops or is refused, and when a loopback connection is made: what `runtimeState` says may then differ. What it returns stops it. */
  onRuntime(listener: (userId: string) => void): () => void;
}

/**
 * What an extension that builds LumiAH into its own backend gives it (DESIGN §21). LumiAH's own
 * backend gives none of it. Everything here runs in this backend: the runtime, which stays the same
 * for every extension, asks for it over the link.
 */
export interface BackendOptions {
  /** Who this backend is in Lumiverse: what it names of itself over LumiAH's own. */
  identity?: Partial<BackendIdentity>;
  /** What it supplies to the core: its agent definitions and skills, the chats it claims (their main agent, their guidance level, the tools of LumiAH's it takes away there), the writer's request rewritten, and its hooks around a run. */
  extension?: BackendExtension;
  /** Its own tools: listed to the core beside the tools of the user's MCP servers, and run here. */
  tools?: BackendTools;
  /** Where LumiAH's record sits in its own record of a message; absent: where `identity.anchorKey` says (by default its entry on the message is nothing but the records). */
  anchor?: AnchorCodec;
  /**
   * The permissions its manifest chose not to ask Lumiverse for (LumiAH's own asks for all of
   * `NEEDS`): what rests on one is absent, as for a permission the user didn't grant, and the pages
   * say nothing of it, since there is nothing for the user to grant.
   */
  declined?: readonly string[];
  /**
   * Its own pages switch a chat on and off (LumiRPEngine): LumiAH's pages then offer no switch of
   * their own, and say where it is, by this extension's name. Absent: LumiAH's pages switch a chat.
   */
  ownSwitch?: true;
  /**
   * The ids of built-in agents this backend leaves out (LumiRPEngine: `chronicler`, `story-reader`).
   * Such an agent isn't listed on the Agents page and can't be started by `job_start`, `delegate` or
   * the user, a call that names one is told it isn't offered here, and nothing built in starts it
   * (the chronicle's upkeep and "Learn this story" are off without the chronicler). None by default.
   */
  withoutAgents?: readonly string[];
  /**
   * Where it keeps LumiAH's record of a message when not on the message itself (LumiRPEngine keeps it
   * in its ledger, and its host's `chats.messages` puts it in as each message's `own`): a reader of a
   * chat's records and a way to say they changed, which the runtime's copy of chat and lore reads and
   * hears, so its rows are the ones that host gives.
   */
  ownElsewhere?: OwnElsewhere;
  /** It gives LumiAH no lore (LumiRPEngine: its host's `lore` answers none): the runtime's copy keeps none either. */
  declinesLore?: true;
}

export function createBackend(host: BackendHost, env: BackendEnv, options: BackendOptions = {}): Backend {
  const identity = identityOf({ identifier: host.identifier, ...options.identity });
  const { now, later, build } = env;
  const { name } = identity;
  const warn = (what: string) => (error: unknown) => host.log("warn", `[LumiAH] ${what}: ${wordsOf(error)}`);

  // ---------------------------------------------------------------- permissions

  const declined = new Set(options.declined ?? []);
  const grant = `Grant it in Lumiverse (Extensions → ${name} → Permissions).`;
  /** The permissions the manifest asks for that the user hasn't granted, each with what it is for and what is absent without it. */
  const permissions = (): PermissionNeed[] => NEEDS.filter((need) => !declined.has(need.id) && !host.granted(need.id)).map((need) => ({ id: need.id, what: need.what, without: need.without, todo: grant, needed: need.needed }));
  /** Why no chat can be switched on now: a permission it can't do without is missing. */
  const blocked = (): string | null => {
    const missing = NEEDS.filter((need) => need.needed && !host.granted(need.id)).map((need) => `"${need.id}"`);
    if (missing.length === 0) return null;
    return `${name} can't answer a chat without the permission${missing.length === 1 ? "" : "s"} ${missing.join(", ")}. ${missing.length === 1 ? "Grant it" : "Grant them"} in Lumiverse (Extensions → ${name} → Permissions).`;
  };

  // ---------------------------------------------------------------- the parts

  const registry = new RegistryStore(host);
  // The parts below need each other in a ring (the settings' check asks the core, the core reads the settings): each is reached through this once all are made.
  const made: { server: LinkServer | null; asks: Asks | null; connections: Connections | null; chatSwitch: ChatSwitch | null } = { server: null, asks: null, connections: null, chatSwitch: null };
  /** What a user's runs have beyond the core's own names, as the runtime's core merges it; none when it can't be read (no runtime is linked), and the core's own names are then all a setting may hold. */
  const scope = async (userId: string): Promise<SettingsScope | undefined> => {
    try {
      const read = await made.asks?.ask(userId, "definitions.get", {});
      // The core always has tools of its own: a scope that names none isn't one (a harness that answers the pages without the core's definitions).
      const said = isRecord(read) && isRecord(read.scope) ? read.scope : null;
      return said !== null && Array.isArray(said.tools) && said.tools.length > 0 && Array.isArray(said.agents) ? (said as unknown as SettingsScope) : undefined;
    } catch {
      return undefined;
    }
  };
  const settings = new SettingsStore(host, settingsSections(scope), { defs: TEXT_DEFS, check: checkText });
  const relays = new Relays(host, registry, settings, {
    now,
    build,
    identity,
    ...(options.ownSwitch === true ? { switchedBy: name } : {}),
    ...(env.runtime !== undefined ? { runtime: env.runtime } : {}),
    send: (frame, userId, session) => made.server?.send(frame, userId, session),
    hasLoopback: async (userId) => ((await made.connections?.loopbacks(userId)) ?? []).length > 0,
  });
  const streams = new StreamRegistry({ now, push: (userId, relay, push) => relays.push(userId, relay, push) });
  const connections = new Connections(host, { model: loopbackModel(identity.identifier), bases: (userId) => relays.bases(userId) });
  made.connections = connections;
  // Lumiverse keys an extension's entry on a message by its identifier: that key means the entry itself, any other a place inside it.
  const codec = options.anchor ?? (identity.anchorKey === identity.identifier ? OWN_ANCHORS : anchorsUnder(identity.anchorKey));
  const chats = new Chats(
    host,
    async (userId) => {
      const { pathsKept, pathMs } = (await settings.transport(userId)).sessions;
      return { chats: pathsKept, ms: pathMs };
    },
    now,
    codec,
  );
  // As many turns are kept across a restart as the account's own "Tags remembered" keeps in memory.
  const open = new OpenTurns(host, async (userId) => Math.min((await settings.transport(userId)).tags.held, CEILINGS.tagsHeld));
  /** The linked runtime a chat's replies reach: the one at the address of the loopback connection the chat generates on. Where no address matches (a connection kept by its model's name under another address), the one runtime linked, when there is just one. Null: that runtime isn't linked. */
  const relayOf = async (userId: string, chatId: string): Promise<{ id: string; name: string } | null> => {
    const on = await connections.ofChat(userId, await chats.own(userId, chatId));
    const url = on === null ? undefined : (await connections.loopbacks(userId)).find((c) => c.id === on.id)?.url;
    if (url === undefined) return null;
    const linked = await relays.linked(userId);
    const found = linked.find((r) => sameBase(runtimeBase(r.listen, r.port), url)) ?? (linked.length === 1 ? linked[0] : undefined);
    return found === undefined ? null : { id: found.id, name: found.name };
  };
  const runtimeOf = async (userId: string, chatId: string): Promise<string | null> => (await relayOf(userId, chatId))?.id ?? null;
  /** What is being said of a reply's runtime now: `settle` waits for it. */
  const telling = new Set<Promise<void>>();
  /** A reply is about to go to a runtime that isn't linked. Nothing answers it there and nothing here does in its place (§25), so the user is told before it fails, wherever they are in Lumiverse. The prompt isn't held for it. */
  const warnAway = (userId: string, chatId: string): void => {
    const told = (async (): Promise<void> => {
      if ((await runtimeOf(userId, chatId)) !== null) return;
      host.toast(userId, "warning", `${name}'s runtime isn't answering, so this reply will fail. Start the runtime (its line is on ${name}'s Runtime page), then send your message again.`);
    })()
      .catch(warn("whether a reply's runtime is linked couldn't be told"))
      .finally(() => telling.delete(told));
    telling.add(told);
  };
  /** Who hears that a user's runtime changed (`Backend.onRuntime`). */
  const runtimeHeard = new Set<(userId: string) => void>();
  const tellRuntime = (userId: string): void => {
    for (const listener of runtimeHeard) {
      try {
        listener(userId);
      } catch (error) {
        warn("a listener to the runtime's state failed")(error);
      }
    }
  };
  /** The extension LumiAH is built into, whose claims say which chats it answers and how. */
  const claimer = options.extension;
  const turns = new Turns(host, {
    chats,
    connections,
    registry,
    settings,
    open,
    toRuntime: warnAway,
    name,
    settingsAt: identity.settingsAt,
    now,
    later,
    // Where the extension claims chats, a reply whose connection can't be confirmed is stopped in a chat it leads rather than written by the writer alone. A claim that can't be read at all is no answer either.
    ...(claimer?.claim !== undefined
      ? { lead: async (userId: string, chatId: string) => (made.chatSwitch === null ? null : made.chatSwitch.lead(userId, chatId).catch((error: unknown) => ({ by: claimer.name, unanswered: wordsOf(error) }))) }
      : {}),
  });
  const storage = new Storage(host);
  // Which runtime holds each user's mirror of what the runtimes keep: one at a time keeps a copy of its own (mirror.ts).
  const mirror = new Mirrors(host, { now, quietMs: async (userId) => (await settings.transport(userId)).link.quietMs, send: (push, userId, session) => made.server?.send(push, userId, session), name });
  const lore = new Lore(host, {
    persona: (userId, chatId) => turns.ofChat(userId, chatId)?.personaId,
    activatedBooks: (userId, chatId) => (turns.ofChat(userId, chatId)?.activated ?? []).flatMap((a) => (a.bookId !== null ? [a.bookId] : [])),
  });
  const presets = new Presets(host);
  const recall = new Recall(host, { chats, lore, activated: (userId, chatId, generationId) => turns.activatedInfo(userId, chatId, generationId), now });
  const copy = new CopyFeed(host, { relays, registry, chats, turns, ...(options.ownElsewhere !== undefined ? { ownElsewhere: options.ownElsewhere } : {}), declinesLore: options.declinesLore === true, records: codec.reads ?? null, name });
  // A turn that fails while a permission LumiAH can't do without is missing fails for that: the live view says so beside the sentence.
  const live = new LiveBuffer(host, { now, transport: (userId) => settings.transport(userId), linkGoneFor: (userId, relay) => relays.goneFor(userId, relay), missing: () => permissions().some((need) => need.needed) });
  const keys = new Keys(host, { registry, relays, settings, connectionName: identity.connectionName, now, later });
  const chatSwitch = new ChatSwitch(host, {
    chats,
    connections,
    runtimeOf: relayOf,
    blocked,
    identity,
    now,
    later,
    storySetting: async (userId) => settingsOf((await settings.values(userId))[CORE_KEY]).story,
    extensionWait: async (userId) => settingsOf((await settings.values(userId))[CORE_KEY]).extension.waitMs,
    // A claim that fails is no answer, with why: the log says so, the story's page shows the chat's and the user's words, and the Agents page says who leads isn't known.
    ...(claimer?.claim !== undefined
      ? {
          claimer: {
            name: claimer.name,
            claim: async (ask: ClaimAsk, userId: string) => {
              try {
                const claim = await claimer.claim?.(ask, userId);
                return claim === null || claim === undefined ? null : { claim };
              } catch (error) {
                warn(`${claimer.name} gave no answer for chat ${ask.chatId}, so its claim on it isn't known`)(error);
                return { failed: wordsOf(error) };
              }
            },
          },
        }
      : {}),
  });
  made.chatSwitch = chatSwitch;
  const sessions = new SessionsPage({
    chats,
    storage,
    settings,
    now,
    name,
    later,
    // The runtime that writes the core's documents sends what it saved before they are read here; with none linked, the storage is all there is.
    settle: async (userId, chatId) => {
      if ((await relays.linked(userId)).length === 0) return false;
      await asks.ask(userId, "store.settle", {}, chatId === null ? {} : { chat: chatId });
      return true;
    },
  });
  const approvals = new Approvals({ id: () => randomHex(64) });
  const notices = new Notices(host, { now, id: () => randomHex(64), kept: async (userId) => (await settings.transport(userId)).pages.noticesKept });
  const jobs = new JobsBoard(notices, now, async (userId) => (await settings.transport(userId)).pages.noticeChars);
  // The MCP servers a user switched on are kept with their definitions, which list the servers through this.
  const mcp: Mcp = new Mcp(host, { on: (userId) => defs.mcpOn(userId), callMs: async (userId) => (await settings.transport(userId)).mcp.callMs, later, name, ...(identity.settingsAt !== undefined ? { settingsAt: identity.settingsAt } : {}) });
  const tools = new RemoteTools(options.tools, mcp, (level, message) => host.log(level, message));
  /** This end of the timing log (Runtime → Timings): every ask it sends a runtime, by its op, road, size and time. */
  const timings = new Timings();
  // The asks' own road, where Lumiverse's proxy reaches a runtime on this machine (proxy.ts). The Runtime page says how it stands.
  const road = new ProxyRoad({
    host,
    declined,
    address: async (userId, relay) => {
      const held = (await registry.read(userId)).relays[relay];
      return held === undefined ? null : { listen: held.report?.listen ?? held.listen, port: held.report?.port ?? held.port };
    },
    transport: (userId) => settings.transport(userId),
    now,
    nonce: () => randomHex(128),
    isLinked: (userId, relay) => relays.isLinked(userId, relay),
    changed: (userId) => ui.touch(userId, "runtime"),
    name,
    ...(identity.settingsAt !== undefined ? { settingsAt: identity.settingsAt } : {}),
  });
  const asks = new Asks({
    relays,
    settings,
    onLoopback: async (userId, chatId) => (await connections.ofChat(userId, await chats.own(userId, chatId)))?.loopback === true,
    runOf: (userId, stream, turn) => live.running(userId, stream, turn)?.relay ?? null,
    jobOf: (userId, job) => jobs.runsIn(userId, job),
    runtimeOf,
    userRuntime: async (userId) => (await relays.linked(userId))[0]?.id ?? null,
    name,
    ...(identity.settingsAt !== undefined ? { settingsAt: identity.settingsAt } : {}),
    now,
    later,
    id: () => randomHex(64),
    road,
    timings,
  });
  made.asks = asks;
  const forgotten = new Forgotten(host, { asks, isLinked: async (userId) => (await relays.linked(userId)).length > 0, now });
  const defs = new Definitions({ settings, asks, mcp, coreKey: CORE_KEY }, now);

  /** What keeps LumiAH from working that no permission and no runtime's own row says, each in plain words that say what to do. */
  const issues = (): string[] => [
    ...(host.capability("chat-lean-messages-v1") ? [] : ["This Lumiverse can't write an extension's own entry on a message, so no turn's record can be kept and the session won't carry from one reply to the next. Update Lumiverse."]),
    ...(host.capability("frontend-session-routing-v1") ? [] : ["This Lumiverse doesn't say which connection a message comes from, so no runtime can link. Update Lumiverse."]),
  ];

  const ui = new Ui(host, {
    relays,
    registry,
    settings,
    streams,
    connections,
    chats,
    live,
    approvals,
    notices,
    asks,
    road,
    timings,
    jobs,
    defs,
    coreKey: CORE_KEY,
    switch: chatSwitch,
    turns,
    sessions,
    copy,
    keys,
    issues,
    permissions,
    now,
  });
  const server = new LinkServer(host, {
    without: options.withoutAgents ?? [],
    relays,
    registry,
    settings,
    streams,
    turns,
    chats,
    chatSwitch,
    storage,
    mirror,
    lore,
    presets,
    recall,
    copy,
    connections,
    live,
    tools,
    approvals,
    asks,
    road,
    jobs,
    extension: options.extension,
    connectionMade: (userId, ref, connection, problem) => {
      keys.made(userId, ref, connection, problem);
      // A loopback connection may be new, or have a new address: which connections are answered here is checked again.
      turns.unsure(userId);
      ui.touch(userId, "connections", "setup", "chats", "runtime");
      tellRuntime(userId);
    },
    now,
    later,
    build,
    identity,
  });
  made.server = server;
  // What a runtime's copy of chat and lore is told is heard from before any runtime says hello.
  copy.start();
  // The link server hears runtimes from here on: every runtime linked before this start says hello again now, not at its next ping.
  relays.start();

  // ---------------------------------------------------------------- what changes the pages' state

  relays.onChange((userId) => {
    ui.touch(userId, "runtime", "setup", "connections", "chats");
    // A runtime's address is what makes a connection a loopback.
    turns.unsure(userId);
    // What a runtime that is gone was asked will never be answered.
    asks.recheck(userId);
    // A runtime whose link is gone takes its secret and its road with it.
    road.sweep(userId);
    // A runtime that links now is handed the chats deleted while none was.
    forgotten.handOver(userId);
    tellRuntime(userId);
  });
  relays.onPing((userId, relay, named) => {
    live.named(userId, relay, named);
    forgotten.pinged(userId);
    void mirror.pinged(userId, relay).catch(warn("a ping couldn't be noted for the runtime that keeps the storage"));
  });
  live.onChange((userId) => ui.touch(userId, "running", "chats", "setup"));
  approvals.onChange((userId) => ui.touch(userId, "approvals"));
  notices.onChange((userId) => ui.touch(userId, "notices"));
  jobs.onChange((userId) => ui.touch(userId, "jobs"));
  defs.onChange((userId) => ui.touch(userId, "defs"));
  // A call can only wait while its run does.
  live.onEnded((run) => approvals.dropRun(run.userId, run.turn, "The run this call belonged to is over."));
  settings.onChange((userId, revision) => {
    server.settingsChanged(userId);
    // The jobs' two switches and what a tool's calls do are settings too.
    ui.touch(userId, "settings", "texts", "jobs", "defs");
    // Every runtime of the user's reads them again before it next needs them.
    void registry
      .read(userId)
      .then((r) => {
        for (const relay of Object.keys(r.relays)) relays.push(userId, relay, { link: LINK, type: "settings", revision });
      })
      .catch(warn("the runtimes weren't told of the new settings"));
  });
  host.onPermission(() => ui.touchAll("runtime", "permissions", "setup"));
  // The asks' road follows its permission at once: granted, every linked runtime's address is checked; taken away, the link carries every ask from now.
  host.onPermission((permission, granted) => {
    if (permission === CORS_PROXY) road.permission(granted);
  });

  // ---------------------------------------------------------------- turns

  turns.onBegun((turn, facts) => {
    if (turn.relay !== null) void live.begin(turn.userId, turn.relay, { stream: facts.chat, chatId: facts.chat, turn: facts.turn, kind: facts.kind, messageId: facts.target.message }).catch(warn("a turn's live view couldn't be started"));
  });
  turns.onStopped((turn, why) => {
    // The runtime first, so it hears Stop before its calls end under it.
    if (turn.relay !== null) relays.push(turn.userId, turn.relay, { link: LINK, type: "stop", turn: turn.turn, why, by: "lumiverse" });
    streams.stopTurn(turn.userId, turn.turn, why);
  });
  turns.onOver((generationId) => live.over(generationId));
  turns.onAnswered((userId) => {
    void registry
      .read(userId)
      .then(async (r) => {
        if (r.replied) return;
        await registry.change(userId, (doc) => {
          doc.replied = true;
        });
        ui.touch(userId, "setup");
      })
      .catch(warn("first-time setup's last step couldn't be kept"));
  });

  // ---------------------------------------------------------------- Lumiverse's events

  host.events.onGenerationStarted((event) => turns.started(event));
  host.events.onGenerationEnded((event) => {
    chats.touched(event.chatId);
    turns.ended(event);
  });
  host.events.onGenerationStopped((event) => {
    chats.touched(event.chatId);
    turns.stoppedBy(event);
  });
  host.events.onSwipe((event) => {
    if (event.action !== "deleted") return;
    // The records still to be written on that message's later swipes move with them, as the ones already written do.
    turns.swipeDeleted(event.chatId, event.messageId, event.swipeId);
    void chats.swipeDeleted(event.chatId, event.messageId, event.swipeId).catch(warn("a deleted swipe's record couldn't be let go"));
  });
  host.events.onChatTouched((chatId, gone, userId) => {
    if (!gone) {
      chats.touched(chatId);
      return;
    }
    chats.dropped(chatId);
    // What the core kept of a chat goes with the chat (its learned files, its jobs and their reports, its approvals, its vectors), where Lumiverse says whose it was: the runtime forgets it, now or once one links.
    if (userId !== null) forgotten.deleted(userId, chatId);
  });
  host.events.onChatChanged((_chatId, userId) => {
    if (userId === null) return;
    ui.touch(userId, "chats", "setup");
    // The chat's own connection may have changed, or another extension's mark on it.
    turns.unsure(userId);
  });
  host.events.onSelectedConnection((userId) => {
    if (userId === null) return;
    // A chat that pins no connection generates on the one selected.
    ui.touch(userId, "chats", "setup");
    turns.unsure(userId);
  });

  // Never required. Lumiverse keeps one interceptor for an extension, and a required one that failed or ran out of time would fail the reply. Not required, whatever goes wrong here leaves Lumiverse to send the prompt as it was.
  host.registerInterceptor((input) => turns.intercept(input), { priority: INTERCEPTOR_PRIORITY, types: TAGGED_TYPES, required: false });

  // ---------------------------------------------------------------- messages

  host.frontend.onMessage((payload, userId, session) => {
    void (async () => {
      if (await server.frame(payload, userId, session)) return;
      await ui.message(payload, userId, session);
    })().catch(warn("a message couldn't be handled"));
  });
  host.frontend.onClosed((session) => {
    relays.sessionClosed(session);
    mirror.sessionClosed(session);
    live.sessionClosed(session);
    server.sessionClosed(session);
  });

  /** Why the runtime isn't linked, in plain words that say what to do: a refused link's own words (which side to update, and how), else how to start it, or to set one up. */
  const downWords = (view: Pick<RuntimeView, "relays">, chatId: string | null): string => {
    const refused = view.relays.find((r) => r.link === "refused" && r.problem !== null);
    if (refused?.problem) return refused.problem;
    if (view.relays.length === 0) return `No runtime is set up for ${name} yet. Start one with the line on ${name}'s Runtime page.`;
    const linked = view.relays.some((r) => r.link === "linked");
    if (chatId !== null && linked) return `The runtime this chat's replies reach isn't linked now. Start it again with its line on ${name}'s Runtime page.`;
    const unit = view.relays.find((r) => r.unit !== null)?.unit ?? null;
    const quiet = view.relays.some((r) => r.link === "quiet");
    return `${name}'s runtime ${quiet ? "has gone quiet" : "isn't linked now"}. Start it again${unit !== null ? ` (systemctl --user restart ${unit})` : ""} with its line on ${name}'s Runtime page.`;
  };
  const runtimeState = async (userId: string, chatId: string | null = null): Promise<RuntimeState> => {
    const [view, loops] = await Promise.all([relays.view(userId, issues()), connections.loopbacks(userId)]);
    const linked = chatId !== null ? (await runtimeOf(userId, chatId)) !== null : view.relays.some((r) => r.link === "linked");
    return { linked, ready: view.ready, connection: loops.length > 0, words: linked ? null : downWords(view, chatId), start: view.start };
  };

  return {
    async tick() {
      await relays.tick();
      streams.sweep();
      server.sweep();
      await turns.tick();
      await live.tick();
    },
    async settle() {
      await registry.settle();
      await settings.settle();
      await chatSwitch.settle();
      await open.settle();
      await forgotten.settle();
      await mirror.settle();
      await copy.settle();
      await ui.settle();
      await Promise.all(telling);
    },
    registry,
    settings,
    relays,
    streams,
    turns,
    live,
    chats,
    ui,
    server,
    approvals,
    notices,
    asks,
    jobs,
    defs,
    road,
    timings,
    agents: {
      held: async (userId, chatId) => heldView(await asks.ask(userId, "definitions.held", { chatId }, { chat: chatId })),
    },
    runtimeState,
    onRuntime(listener) {
      runtimeHeard.add(listener);
      return () => void runtimeHeard.delete(listener);
    },
  };
}
