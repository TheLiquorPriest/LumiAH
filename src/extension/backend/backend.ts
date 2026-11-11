// The extension backend, put together (DESIGN §7): the prompt interceptor, the core where it runs
// built in, the link server for a runtime, the model calls, the stores in the user's storage, the
// anchors, the live buffer and the pages' requests, over one host (spindle.ts in Lumiverse, a fake
// in the tests).

import { checkSettings, defaultSettings, SETTINGS_SCHEMA, type SettingsScope, settingsOf } from "../../core/settings";
import { storyWordOf } from "../../core/story";
import { checkText, TEXT_DEFS } from "../../core/texts";
import type { JsonObject } from "../../core/ports";
import { LINK, loopbackModel, runtimeBase, sameBase } from "../../link/contract";
import { isRecord } from "../../link/json";
import { CEILINGS, checkTransport, TRANSPORT_KEY, TRANSPORT_SCHEMA, transportDefaults } from "../../link/settings";
import type { PermissionNeed, RunPlace } from "../../shared/ui";
import { Approvals } from "./approvals";
import { Asks } from "./asks";
import { Builtin, type HarnessMaker } from "./builtin";
import { type AnchorCodec, anchorsUnder, Chats, OWN_ANCHORS } from "./chat";
import { randomHex } from "./docs";
import { Definitions } from "./defs";
import { type BackendExtension, type BackendTools, RemoteTools } from "./extension";
import { HostedTurns } from "./hosted";
import { JobsBoard } from "./jobs";
import { Mcp } from "./mcp";
import { Notices } from "./notices";
import { OpenTurns } from "./open";
import { Connections } from "./connections";
import { wordsOf } from "./errors";
import { Keys } from "./keys";
import { BUILTIN, LiveBuffer } from "./live";
import { Models } from "./models";
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

export interface BackendEnv {
  now(): number;
  /** Runs `fn` once after `ms`; what it returns cancels that. */
  later(ms: number, fn: () => void): () => void;
  /** The build this bundle came from: runtimes compare theirs with it. */
  build: string;
  /** What makes a user's harness where the core runs built in; absent: the core's own (a test of the transport alone scripts one). */
  harness?: HarnessMaker;
}

/** The key the core's settings sit under, beside the transport's. */
export const CORE_KEY = "core";

/**
 * The settings' sections: the core's and the transport's. An extension that uses LumiAH's pieces
 * adds its own beside them. `scope` gives what a user's runs have beyond the core's own (their
 * extension's and MCP servers' tools, their own agents): with it, a setting that names one of those
 * is taken; without it, only the core's own names are.
 */
export function settingsSections(scope?: (userId: string) => Promise<SettingsScope | undefined>): SettingsSection[] {
  return [
    {
      key: CORE_KEY,
      defaults: () => defaultSettings() as unknown as JsonObject,
      schema: SETTINGS_SCHEMA,
      async check(values, userId) {
        const known = await scope?.(userId);
        const plain = checkSettings(values);
        if (known === undefined) return plain;
        // The user's scope is there to take more names, never fewer: a value is refused only when it is refused both ways. Checked by the scope alone, a tool the core has but this place doesn't offer just now (a port its Lumiverse lacks) would refuse the defaults that name it, and with them every change of any setting.
        const refused = new Set(plain.map((problem) => JSON.stringify(problem.path)));
        return checkSettings(values, known).filter((problem) => refused.has(JSON.stringify(problem.path)));
      },
    },
    { key: TRANSPORT_KEY, defaults: transportDefaults, schema: TRANSPORT_SCHEMA, check: checkTransport },
  ];
}

/**
 * What each permission is for (`what`, which completes "To …") and what is absent without it
 * (`without`, which completes "Without it, …"). Lumiverse lets the user grant each one apart, and
 * an extension that builds LumiAH in may ask for fewer, so every one but those marked `needed` is
 * optional: without it the route it opens is quietly absent, and the pages say so as information.
 * `needed`: without it LumiAH answers no chat at all. `chat_mutation` is one of those because
 * Lumiverse puts reading a chat's messages under it, not only changing them.
 */
const NEEDS: readonly { id: string; needed: boolean; what: string; without: string }[] = [
  { id: "interceptor", needed: true, what: "see a reply's prompt before it is sent", without: "no reply is worked on" },
  { id: "chats", needed: true, what: "read a chat and switch itself on for it", without: "no chat can be switched on" },
  { id: "generation", needed: true, what: "make its agents' model calls and hear when a reply starts and ends", without: "its agents can call no model" },
  { id: "chat_mutation", needed: true, what: "read the chat's messages and write each reply's record on it", without: "no reply is worked on" },
  { id: "generation_parameters", needed: false, what: "tag the replies a runtime answers", without: "no chat can run in a runtime (a chat that runs built in needs it for nothing)" },
  { id: "world_books", needed: false, what: "read your world books", without: "agents can't look up lore" },
  { id: "presets", needed: false, what: "read the preset's instructions", without: "the agents know the preset only by the prompt it made" },
  { id: "characters", needed: false, what: "find the world books attached to the chat's character, and tell which character a piece of guidance is for", without: "those books aren't found, and guidance written for one character isn't matched" },
  { id: "personas", needed: false, what: "find the world book attached to your persona", without: "that book isn't found" },
  { id: "mcp_servers", needed: false, what: "offer its agents the tools of the MCP servers you set up in Lumiverse", without: "agents have no MCP tools" },
  { id: "embeddings", needed: false, what: "search lore and the chat by meaning on your embedding connection", without: "search is by word" },
  { id: "memories", needed: false, what: "read Lumiverse's Memory Cortex", without: "the memory tools aren't offered" },
  { id: "databanks", needed: false, what: "read your databanks", without: "the databank tools aren't offered" },
  { id: "web_search", needed: false, what: "search the web with your own provider", without: "web_search isn't offered" },
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
  readonly builtin: Builtin;
  readonly hosted: HostedTurns;
}

/**
 * What an extension that builds LumiAH into its own backend gives it (DESIGN §21). LumiAH's own
 * backend gives none of it. Everything here runs in this backend: the core where it runs built in
 * is handed it directly, and a runtime, which stays the same for every extension, asks over the link.
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
  /** Why no chat can be switched on in a place now: a permission it can't do without there is missing. */
  const blocked = (place: RunPlace): string | null => {
    const missing = NEEDS.filter((need) => (need.needed || (place === "runtime" && need.id === "generation_parameters")) && !host.granted(need.id)).map((need) => `"${need.id}"`);
    if (missing.length === 0) return null;
    return `${name} can't answer a chat${place === "runtime" ? " in a runtime" : ""} without the permission${missing.length === 1 ? "" : "s"} ${missing.join(", ")}. ${missing.length === 1 ? "Grant it" : "Grant them"} in Lumiverse (Extensions → ${name} → Permissions).`;
  };

  // ---------------------------------------------------------------- the parts

  const registry = new RegistryStore(host);
  // The parts below need each other in a ring (the settings' check asks the core, the core reads the settings): each is reached through this once all are made.
  const made: { server: LinkServer | null; builtin: Builtin | null; connections: Connections | null; chatSwitch: ChatSwitch | null } = { server: null, builtin: null, connections: null, chatSwitch: null };
  /** What a user's runs have beyond the core's own names, as their built-in core merges it; none when it can't be read, and the core's own names are then all a setting may hold. */
  const scope = async (userId: string): Promise<SettingsScope | undefined> => {
    try {
      const read = await made.builtin?.ask(userId, "definitions.get", {});
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
    send: (frame, userId, session) => made.server?.send(frame, userId, session),
    hasLoopback: async (userId) => ((await made.connections?.loopbacks(userId)) ?? []).length > 0,
  });
  const streams = new StreamRegistry({ now, later, push: (userId, relay, push) => relays.push(userId, relay, push) });
  const connections = new Connections(host, { model: loopbackModel(identity.identifier), bases: (userId) => relays.bases(userId), serialTools: async (userId) => (await settings.transport(userId)).connections.oneToolAtATime });
  made.connections = connections;
  // Lumiverse keys an extension's entry on a message by its identifier: that key means the entry itself, any other a place inside it.
  const chats = new Chats(host, async (userId) => (await settings.transport(userId)).sessions.pathsKept, options.anchor ?? (identity.anchorKey === identity.identifier ? OWN_ANCHORS : anchorsUnder(identity.anchorKey)));
  // As many turns are kept across a restart as the account's own "Tags remembered" keeps in memory.
  const open = new OpenTurns(host, async (userId) => Math.min((await settings.transport(userId)).tags.held, CEILINGS.tagsHeld));
  /** The linked runtime a chat's replies reach: the one at the address of the loopback connection the chat generates on. Where no address matches (a connection kept by its model's name under another address), the one runtime linked, when there is just one. Null: that runtime isn't linked. */
  const runtimeOf = async (userId: string, chatId: string): Promise<string | null> => {
    const on = await connections.ofChat(userId, await chats.own(userId, chatId));
    const url = on === null ? undefined : (await connections.loopbacks(userId)).find((c) => c.id === on.id)?.url;
    if (url === undefined) return null;
    const linked = await relays.linked(userId);
    return (linked.find((r) => sameBase(runtimeBase(r.listen, r.port), url)) ?? (linked.length === 1 ? linked[0] : undefined))?.id ?? null;
  };
  /** What is being said of a reply's runtime now: `settle` waits for it. */
  const telling = new Set<Promise<void>>();
  /** A reply is about to go to a runtime that isn't linked. Nothing answers it there and nothing here does in its place (§25), so the user is told before it fails, wherever they are in Lumiverse. The prompt isn't held for it. */
  const warnAway = (userId: string, chatId: string): void => {
    const told = (async (): Promise<void> => {
      if ((await runtimeOf(userId, chatId)) !== null) return;
      host.toast(userId, "warning", `${name}'s runtime isn't answering, so this reply may fail. On ${name}'s Home, set this chat to Built in, or start the runtime.`);
    })()
      .catch(warn("whether a reply's runtime is linked couldn't be told"))
      .finally(() => telling.delete(told));
    telling.add(told);
  };
  const turns = new Turns(host, {
    chats,
    connections,
    registry,
    settings,
    open,
    builtin: async (userId, chatId) => (await made.chatSwitch?.builtin(userId, chatId)) === true,
    toRuntime: warnAway,
    name,
    now,
    later,
  });
  const storage = new Storage(host);
  const lore = new Lore(host, {
    persona: (userId, chatId) => turns.ofChat(userId, chatId)?.personaId,
    activatedBooks: (userId, chatId) => (turns.ofChat(userId, chatId)?.activated ?? []).flatMap((a) => (a.bookId !== null ? [a.bookId] : [])),
  });
  const presets = new Presets(host);
  const recall = new Recall(host, { chats, lore, activated: (userId, chatId, generationId) => turns.activatedInfo(userId, chatId, generationId), now });
  // A turn that fails while a permission LumiAH can't do without is missing fails for that: the live view says so beside the sentence.
  const live = new LiveBuffer(host, { now, transport: (userId) => settings.transport(userId), linkGoneFor: (userId, relay) => relays.goneFor(userId, relay), missing: () => permissions().some((need) => need.needed) });
  const models = new Models(host, { connections, streams, settings, registry, name });
  const keys = new Keys(host, { registry, relays, settings, connectionName: identity.connectionName, now, later });
  const chatSwitch = new ChatSwitch(host, {
    chats,
    connections,
    runtimeReady: (userId) => relays.ready(userId),
    runtimeLinked: async (userId, chatId) => (await runtimeOf(userId, chatId)) !== null,
    blocked,
    identity,
    now,
    storySetting: async (userId) => settingsOf((await settings.values(userId))[CORE_KEY]).story,
    // What the page shows as the extension's word is what its claim says: a claim that fails or says nothing of the story leaves the chat's and the user's to stand.
    claimed: async (ask, userId) => {
      const extension = options.extension;
      if (extension?.claim === undefined) return null;
      try {
        const story = storyWordOf((await extension.claim(ask, userId))?.story);
        return Object.keys(story).length > 0 ? { by: extension.name, story } : null;
      } catch (error) {
        warn(`${extension.name} gave no answer for chat ${ask.chatId}, so its word on the story isn't shown`)(error);
        return null;
      }
    },
  });
  made.chatSwitch = chatSwitch;
  const sessions = new SessionsPage({ chats, storage, settings, now });
  const approvals = new Approvals({ id: () => randomHex(64) });
  const notices = new Notices(host, { now, id: () => randomHex(64), kept: async (userId) => (await settings.transport(userId)).pages.noticesKept });
  const jobs = new JobsBoard(notices, now, async (userId) => (await settings.transport(userId)).pages.noticeChars);
  // The MCP servers a user switched on are kept with their definitions, which list the servers through this.
  const mcp: Mcp = new Mcp(host, { on: (userId) => defs.mcpOn(userId), callMs: async (userId) => (await settings.transport(userId)).mcp.callMs });
  const tools = new RemoteTools(options.tools, mcp, (level, message) => host.log(level, message));
  const builtin = new Builtin(host, {
    settings,
    storage,
    chats,
    chatSwitch,
    lore,
    presets,
    connections,
    models,
    tools,
    approvals,
    live,
    jobs,
    activated: (userId, chatId, generationId) => turns.activated(userId, chatId, generationId),
    recall,
    extension: options.extension,
    coreKey: CORE_KEY,
    name,
    now,
    later,
    id: () => randomHex(128),
    ...(env.harness !== undefined ? { harness: env.harness } : {}),
  });
  made.builtin = builtin;
  const hosted = new HostedTurns(host, { turns, chats, connections, settings, live, builtin, open, name, now, later });
  turns.hostedBy((input, turn, omit) => hosted.intercept(input, turn, omit));
  const asks = new Asks({
    relays,
    settings,
    builtin: (userId, op, args) => builtin.ask(userId, op, args),
    placeOf: (userId, chatId) => chatSwitch.placeOf(userId, chatId),
    runOf: (userId, stream, turn) => live.running(userId, stream, turn)?.relay ?? null,
    jobOf: (userId, job) => jobs.runsIn(userId, job),
    runtimeOf,
    name,
    later,
    id: () => randomHex(64),
  });
  const defs = new Definitions({ settings, asks, mcp, coreKey: CORE_KEY }, now);

  /** What keeps LumiAH from working that no permission and no runtime's own row says, each in plain words that say what to do. */
  const issues = (): string[] => [
    ...(host.capability("chat-lean-messages-v1") ? [] : ["This Lumiverse can't write an extension's own entry on a message, so no turn's record can be kept and the session won't carry from one reply to the next. Update Lumiverse."]),
    ...(host.capability("frontend-session-routing-v1") ? [] : ["This Lumiverse doesn't say which connection a message comes from, so no runtime can link (a chat that runs built in needs none). Update Lumiverse."]),
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
    jobs,
    defs,
    coreKey: CORE_KEY,
    switch: chatSwitch,
    turns,
    sessions,
    keys,
    issues,
    permissions,
    // A reply's turn that runs here, then a job's run or a side session's turn that does.
    stopHere: (userId, turn, why) => hosted.stopFromLive(userId, turn) || builtin.stop(userId, turn, why),
    now,
  });
  const server = new LinkServer(host, {
    relays,
    registry,
    settings,
    streams,
    models,
    turns,
    chats,
    chatSwitch,
    storage,
    lore,
    presets,
    recall,
    connections,
    live,
    tools,
    approvals,
    asks,
    jobs,
    extension: options.extension,
    connectionMade: (userId, ref, connection, problem) => {
      keys.made(userId, ref, connection, problem);
      // A loopback connection may be new, or have a new address: which connections are answered here is checked again.
      turns.unsure(userId);
      ui.touch(userId, "connections", "setup", "chats", "runtime");
    },
    now,
    later,
    build,
    identity,
  });
  made.server = server;

  // ---------------------------------------------------------------- what changes the pages' state

  relays.onChange((userId) => {
    ui.touch(userId, "runtime", "setup", "connections", "chats");
    // A runtime's address is what makes a connection a loopback.
    turns.unsure(userId);
    // What a runtime that is gone was asked will never be answered.
    asks.recheck(userId);
  });
  relays.onPing((userId, relay, named) => live.named(userId, relay, named));
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
    // The user's hold on jobs reaches the core here as it reaches a runtime's.
    builtin.held(userId);
    // Every runtime of the user's reads them again before it next needs them.
    void registry
      .read(userId)
      .then((r) => {
        for (const relay of Object.keys(r.relays)) relays.push(userId, relay, { link: LINK, type: "settings", revision });
      })
      .catch(warn("the runtimes weren't told of the new settings"));
  });
  host.onPermission(() => ui.touchAll("runtime", "permissions", "setup"));

  // ---------------------------------------------------------------- turns

  turns.onBegun((turn, facts) => void live.begin(turn.userId, turn.relay ?? BUILTIN, { stream: facts.chat, chatId: facts.chat, turn: facts.turn, kind: facts.kind, messageId: facts.target.message, place: "runtime" }).catch(warn("a turn's live view couldn't be started")));
  turns.onStopped((turn, why) => {
    if (turn.place === "builtin") {
      hosted.stopped(turn, why);
      return;
    }
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
    // After the turn's own bookkeeping: a turn that ran here is completed with the saved reply, and its record goes where that bookkeeping says.
    hosted.ended(event);
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
    // What the core kept of a chat goes with the chat (its learned files, its jobs and their reports, its approvals, its vectors), where Lumiverse says whose it was.
    if (userId !== null) void builtin.forget(userId, chatId);
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

  // Never required. Lumiverse keeps one interceptor for an extension, and it serves both ways to run: a required one that failed or ran out of time would fail the reply, and a chat that runs built in must never lose one to LumiAH (§25). Not required, whatever goes wrong here leaves Lumiverse to send the prompt as it was.
  host.registerInterceptor((input) => turns.intercept(input), { priority: INTERCEPTOR_PRIORITY, types: TAGGED_TYPES, required: false });

  // ---------------------------------------------------------------- messages

  host.frontend.onMessage((payload, userId, session) => {
    // A user with a page or a runtime is here: what a restart of the extension cut off of their built-in jobs is found now.
    builtin.wake(userId);
    // And the replies' turns that waited for their replies when the worker before this one stopped.
    hosted.recover(userId);
    void (async () => {
      if (await server.frame(payload, userId, session)) return;
      await ui.message(payload, userId, session);
    })().catch(warn("a message couldn't be handled"));
  });
  host.frontend.onClosed((session) => {
    relays.sessionClosed(session);
    live.sessionClosed(session);
    server.sessionClosed(session);
  });

  return {
    async tick() {
      await relays.tick();
      streams.sweep();
      server.sweep();
      await turns.tick();
      await hosted.tick();
      await live.tick();
    },
    async settle() {
      await registry.settle();
      await settings.settle();
      await chatSwitch.settle();
      await open.settle();
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
    builtin,
    hosted,
  };
}
