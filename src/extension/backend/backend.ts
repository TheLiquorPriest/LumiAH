// The extension backend, put together (DESIGN §7): the prompt interceptor that tags turns, the link
// server, the model calls, the stores in the user's storage, the anchors, the live buffer and the
// pages' requests, over one host (spindle.ts in Lumiverse, a fake in the tests).

import { checkSettings, defaultSettings, SETTINGS_SCHEMA } from "../../core/settings";
import { checkText, TEXT_DEFS } from "../../core/texts";
import type { JsonObject } from "../../core/ports";
import { LINK } from "../../link/contract";
import { checkTransport, TRANSPORT_KEY, TRANSPORT_SCHEMA, transportDefaults } from "../../link/settings";
import { Chats } from "./chat";
import { Connections } from "./connections";
import { wordsOf } from "./errors";
import { Keys } from "./keys";
import { LiveBuffer } from "./live";
import { Models } from "./models";
import { Lore, Presets, Storage } from "./reads";
import { RegistryStore } from "./registry";
import { Relays } from "./relays";
import { LinkServer } from "./server";
import { SessionsPage } from "./sessions";
import type { SettingsSection } from "./settings";
import { SettingsStore } from "./settings";
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
}

/** The key the core's settings sit under, beside the transport's. */
export const CORE_KEY = "core";

/** The settings' sections: the core's and the transport's. An extension that uses LumiAH's pieces adds its own beside them. */
export function settingsSections(): SettingsSection[] {
  return [
    { key: CORE_KEY, defaults: () => defaultSettings() as unknown as JsonObject, schema: SETTINGS_SCHEMA, check: (values) => checkSettings(values) },
    { key: TRANSPORT_KEY, defaults: transportDefaults, schema: TRANSPORT_SCHEMA, check: checkTransport },
  ];
}

/** What LumiAH can't do without each permission, for the Runtime page. */
const NEEDS: readonly (readonly [string, string])[] = [
  ["generation", "make its agents' model calls and hear when a reply starts and ends"],
  ["interceptor", "tag the replies it answers"],
  ["generation_parameters", "put a reply's tag in its request"],
  ["chats", "read a chat and switch LumiAH on for it"],
  ["chat_mutation", "write each turn's record on its reply"],
  ["world_books", "read the chat's lore"],
  ["presets", "read the preset's instructions"],
  ["characters", "find the world books attached to the chat's character"],
  ["personas", "find the world book attached to your persona"],
];

export interface Backend {
  /** Every second or so: what waits on time alone (a runtime gone quiet, a record never anchored, a stream never acknowledged, a turn never ended). */
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
}

export function startBackend(host: BackendHost, env: BackendEnv): Backend {
  const { now, later, build } = env;
  const warn = (what: string) => (error: unknown) => host.log("warn", `[LumiAH] ${what}: ${wordsOf(error)}`);

  const registry = new RegistryStore(host);
  const settings = new SettingsStore(host, settingsSections(), { defs: TEXT_DEFS, check: checkText });
  // The relays send through the server, which is made last: it needs everything it serves.
  const made: { server: LinkServer | null } = { server: null };
  const relays = new Relays(host, registry, settings, { now, build, send: (frame, userId, session) => made.server?.send(frame, userId, session) });
  const streams = new StreamRegistry({ now, later, push: (userId, relay, push) => relays.push(userId, relay, push) });
  const connections = new Connections(host, { bases: (userId) => relays.bases(userId), serialTools: async (userId) => (await settings.transport(userId)).connections.oneToolAtATime });
  const chats = new Chats(host, async (userId) => (await settings.transport(userId)).sessions.pathsKept);
  const turns = new Turns(host, { chats, connections, registry, settings, now });
  const storage = new Storage(host);
  const lore = new Lore(host, {
    persona: (userId, chatId) => turns.ofChat(userId, chatId)?.personaId,
    activatedBooks: (userId, chatId) => (turns.ofChat(userId, chatId)?.activated ?? []).flatMap((a) => (a.bookId !== null ? [a.bookId] : [])),
  });
  const presets = new Presets(host);
  const live = new LiveBuffer(host, { now, transport: (userId) => settings.transport(userId) });
  const models = new Models(host, { connections, streams, settings, registry });
  const keys = new Keys(host, { registry, relays, settings, now, later });
  const chatSwitch = new ChatSwitch(host, { chats, connections, now });
  const sessions = new SessionsPage({ chats, storage, settings, now });

  const issues = (): string[] => [
    ...NEEDS.filter(([permission]) => !host.granted(permission)).map(([permission, what]) => `LumiAH isn't granted "${permission}", which it needs to ${what}. Grant it in Lumiverse (Extensions → LumiAH → Permissions).`),
    ...(host.capability("chat-lean-messages-v1") ? [] : ["This Lumiverse can't write an extension's own entry on a message, so no turn's record can be kept and the session won't carry from one reply to the next. Update Lumiverse."]),
    ...(host.capability("frontend-session-routing-v1") ? [] : ["This Lumiverse doesn't say which connection a message comes from, so no runtime can link. Update Lumiverse."]),
  ];

  const ui = new Ui(host, { relays, registry, settings, streams, connections, chats, live, switch: chatSwitch, sessions, keys, issues, now });
  const server = new LinkServer(host, {
    relays,
    registry,
    settings,
    streams,
    models,
    turns,
    chats,
    storage,
    lore,
    presets,
    connections,
    live,
    connectionMade: (userId, ref, connection, problem) => {
      keys.made(userId, ref, connection, problem);
      ui.touch(userId, "connections", "setup", "chats");
    },
    now,
    later,
    build,
  });
  made.server = server;

  // ---------------------------------------------------------------- what changes the pages' state

  relays.onChange((userId) => ui.touch(userId, "runtime", "setup", "connections", "chats"));
  relays.onPing((userId, relay, named) => live.named(userId, relay, named));
  live.onChange((userId) => ui.touch(userId, "running", "chats", "setup"));
  settings.onChange((userId, revision) => {
    server.settingsChanged(userId);
    ui.touch(userId, "settings", "texts");
    // Every runtime of the user's reads them again before it next needs them.
    void registry
      .read(userId)
      .then((r) => {
        for (const relay of Object.keys(r.relays)) relays.push(userId, relay, { link: LINK, type: "settings", revision });
      })
      .catch(warn("the runtimes weren't told of the new settings"));
  });
  host.onPermission(() => ui.touchAll("runtime"));

  // ---------------------------------------------------------------- turns

  turns.onBegun((turn, facts) => void live.begin(turn.userId, turn.relay ?? "", facts).catch(warn("a turn's live view couldn't be started")));
  turns.onStopped((turn, why) => {
    // The runtime first, so it hears Stop before its calls end under it.
    if (turn.relay !== null) relays.push(turn.userId, turn.relay, { link: LINK, type: "stop", turn: turn.turn, why });
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
    if (event.action === "deleted") void chats.swipeDeleted(event.chatId, event.messageId, event.swipeId).catch(warn("a deleted swipe's record couldn't be let go"));
  });
  host.events.onChatTouched((chatId, gone) => (gone ? chats.dropped(chatId) : chats.touched(chatId)));
  host.events.onChatChanged((_chatId, userId) => {
    if (userId !== null) ui.touch(userId, "chats", "setup");
  });

  host.registerInterceptor((input) => turns.intercept(input), { priority: INTERCEPTOR_PRIORITY, types: TAGGED_TYPES, required: host.capability("required-interceptors-v1") });

  // ---------------------------------------------------------------- messages

  host.frontend.onMessage((payload, userId, session) => {
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
      await turns.tick();
      await live.tick();
    },
    async settle() {
      await registry.settle();
      await settings.settle();
      await chatSwitch.settle();
      await ui.settle();
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
  };
}
