// A whole LumiAH for a test: the extension backend over a fake Lumiverse, a runtime registered and
// linked to it over the fake's event socket, with the core's own harness answering turns and the
// runtime's own model layer calling scripted providers (models.ts) on its own connections. `setUp`
// adds what first-time setup does: a loopback key minted (the runtime makes the loopback connection
// with it) and a chat switched on.

import type * as Core from "../../src/core/index";
import { isRecord } from "../../src/link/json";
import { type Backend, type BackendOptions, createBackend } from "../../src/extension/backend/backend";
import type { LinkRequests } from "../../src/link/contract";
import { roadBase } from "../../src/link/road";
import { RUNTIME_DEFAULTS, type RuntimeTuning } from "../../src/link/settings";
import type { RuntimeConfig } from "../../src/runtime/config";
import type { ModelLayer } from "../../src/runtime/models/index";
import { createRuntime, type Runtime, type RuntimeDeps } from "../../src/runtime/runtime";
import type { Harness } from "../../src/runtime/turn";
import { FakeHost } from "./fake-host";
import { FakeLumiverse, type FakePage, type Generated } from "./fake-lumiverse";
import { tempFolder } from "./folders";
import { MAIN, scriptedModels, type SeedConnection } from "./models";
import { type Road, roads } from "./roads";
import { updating } from "./update";

export const USER = "user-mara";
export const PORT = 7871;
export const BUILD = "test-build";

/**
 * Waits until `done` holds, a turn of the event loop at a time; fails with `what` when it never does.
 * The rig's two ends are the real runtime and the real backend, talking over queued deliveries and
 * the runtime's own timers: there is no one promise to await and no single clock to move by hand,
 * so a test waits for the thing itself to have happened.
 */
export async function until(done: () => boolean, what: string, turns = 2_000): Promise<void> {
  for (let i = 0; i < turns; i++) {
    if (done()) return;
    const { promise, resolve } = Promise.withResolvers<void>();
    setTimeout(resolve, 1);
    await promise;
  }
  throw new Error(`timed out waiting for ${what}`);
}

export interface Rig {
  host: FakeHost;
  lumiverse: FakeLumiverse;
  /** The extension backend as it stands now: `restart` puts a new one in its place. */
  backend: Backend;
  runtime: Runtime;
  page: FakePage;
  /** What the runtime logged. */
  logs: string[];
  /** The runtime's registration with the extension: what a second runtime started on it (`runtimeFor`) links with, as the same one does after a restart. */
  registration: { relay: string; secret: string };
  /** The loopback key, once `setUp` minted it. */
  key: string;
  /** A generation in a chat: on the runtime's loopback endpoint where the chat generates there, else by Lumiverse's own generation on the chat's connection (`lumiverse.writes`). */
  generate(chatId: string, options?: Partial<Parameters<FakeLumiverse["generate"]>[2]>): Promise<Generated>;
  /** Mints the loopback key, which has the runtime make the loopback connection, and switches LumiAH on for a new chat with one message of Mara's, to run in the runtime; the chat's id. */
  setUp(): Promise<string>;
  /** Lumiverse starts the extension's worker anew (an update, a reload, its own restart): everything the backend held in memory is gone, what Lumiverse and the user's storage hold stays, and a new backend is put together over them. The runtime and the page stay as they are. */
  restart(): Promise<void>;
  /** The runtime's own folder: a runtime started again on the same machine is given it (`RigOptions.dir`), and finds there what it kept. */
  dir: string;
  /** Waits until the extension's storage holds everything the runtime saved: a test that looks into the storage after a turn looks once it is there, as the backend's own readers do. */
  mirrored(): Promise<void>;
  /** Stops the runtime: what it saved goes to the extension's storage first while its link is up. */
  close(): Promise<void>;
  /** Where the rig's runtime asks both roads (`RigOptions.reads` "both"): every read whose two answers differed, in words. */
  differences: string[];
}

/** The runtime's timings for a test: nothing waits, so a test takes no longer than its work. */
export const FAST: RuntimeTuning = { ...RUNTIME_DEFAULTS, traceMs: 0, reconnectMs: 5, reconnectMaxMs: 20, stopGraceMs: 0 };

/** What a rig may be given: the runtime's timings and build, a harness in place of the core's own in the runtime (a test of the transport alone scripts one), what an extension that builds LumiAH into itself gives its backend, and the runtime's way to Lumiverse where it isn't the fake's own (a test that kills a runtime's process pulls it: plug.ts). */
export interface RigOptions {
  tuning?: Partial<RuntimeTuning>;
  build?: string;
  harness?: RuntimeDeps["harness"];
  backend?: BackendOptions;
  wire?: (lumiverse: FakeLumiverse) => Pick<FakeLumiverse, "http" | "openSocket">;
  /** The runtime's own folder: a new empty one unless one is given (a runtime started again on the same machine is given the one it had, `Rig.dir`). */
  dir?: string;
  /** The folder of the user's storage the backend keeps everything under, as an extension that builds LumiAH into itself may (LumiRPEngine keeps LumiAH's files under `harness/`); none: the storage's root. */
  storage?: string;
  /** The runtime's own connections when it starts: Mara's `MAIN`, its default, unless the test gives others (none: the runtime has no connection yet). */
  connections?: readonly SeedConnection[];
  /** The runtime's update (`updating()` in update.ts builds one a test can look into); by default one of a runtime set up before it could update itself, which every offer finds so. */
  update?: RuntimeDeps["update"];
  /** The runtime the backend's build ships (`BackendEnv.runtime`): with it, a runtime on another build is offered its update; none, as a development build. */
  shipped?: { sha256: string; size: number };
  /** Another runtime of Mara's keeps the extension's storage (who, in words), and the extension heard from it as it started: the rig's runtime keeps no copy of its own, and works straight on the storage. */
  heldElsewhere?: string;
  /** The road the runtime reads chats and world books by (roads.ts): its own copy (as every runtime does), the link alone, or both and compared; as the run's `LUMIAH_READS` (or the compare preload) says when not given. */
  reads?: Road;
  /** Told of every read whose two roads differed, where the runtime asks both. */
  differed?: (what: string) => void;
  /** The database reader the runtime opens where the operator switched it on (the reader over a file the test keeps); the real one when not given. */
  database?: RuntimeDeps["database"];
  /** How long the copy asks a route of Lumiverse's nothing once it didn't answer for several different chats or books in a row; a minute when not given. */
  routePauseMs?: number;
  /** How often the runtime pings while idle, below what a user's settings may say (5 s at least), so a test sees what a ping finds; as the settings say when not given. */
  idlePingMs?: number;
  /** The host as an extension that builds LumiAH into itself hands it to LumiAH's backend (its own records of a chat, its lore), over the host the rig made. */
  mount?: (host: FakeHost) => FakeHost;
  /** The runtime's model layer as the test changes it (one whose `ended` throws), over the scripted one it would have. */
  layer?: (made: ModelLayer) => ModelLayer;
}

/** A runtime over a fake Lumiverse, with the core's own harness unless the test gives one, as `lumiah serve` puts one together from its config. */
export function runtimeFor(lumiverse: FakeLumiverse, registration: { relay: string; secret: string }, logs: string[], options: RigOptions = {}): Runtime {
  return runtimeFrom({ name: "mara", base: lumiverse.base, extension: lumiverse.host.identifier, listen: "127.0.0.1", port: PORT, relay: registration.relay, secret: registration.secret, session: { username: "mara", token: lumiverse.token, savedAt: 0 }, tuning: { ...FAST, ...options.tuning } }, lumiverse, logs, options);
}

/** The same from a config as it stands, such as the one `lumiah up` wrote. */
export function runtimeFrom(config: RuntimeConfig, lumiverse: FakeLumiverse, logs: string[], options: RigOptions = {}): Runtime {
  let held = config.secret;
  const wire = options.wire?.(lumiverse) ?? lumiverse;
  const scripted = options.harness;
  const road = options.reads ?? roads.road;
  return createRuntime(config, {
    http: wire.http,
    openSocket: wire.openSocket,
    now: () => Date.now(),
    log: (text) => void logs.push(text),
    build: options.build ?? BUILD,
    ran: { bun: "/opt/bun/bin/bun", script: "/home/mara/.local/share/lumiah/lumiah.js", unit: null },
    host: "harbour-box",
    dir: options.dir ?? tempFolder(),
    // Its models: the runtime's own layer, its providers answering from the script of the host of the extension it links to.
    models: (deps) => {
      const made = scriptedModels(lumiverse.host.extensions.find((h) => h.identifier === config.extension) ?? lumiverse.host, lumiverse.userId, options.connections ?? [MAIN])(deps);
      return options.layer?.(made) ?? made;
    },
    credentials: () => config.session,
    secret: () => held,
    rotated: (next) => {
      held = next;
    },
    keepTuning: () => undefined,
    harness: scripted ?? ((harnessHost, settings, extension) => core().createHarness(harnessHost, { settings, extension })),
    writerConnection: (values) => {
      const writer = isRecord(values) && isRecord(values.core) && isRecord(values.core.agents) ? values.core.agents.writer : undefined;
      return isRecord(writer) && typeof writer.connectionId === "string" ? writer.connectionId : null;
    },
    update: options.update ?? updating(config, { source: null }).update,
    ...(options.database !== undefined ? { database: options.database } : {}),
    ...(options.routePauseMs !== undefined ? { routePauseMs: options.routePauseMs } : {}),
    ...(options.idlePingMs !== undefined ? { idlePingMs: options.idlePingMs } : {}),
    reads:
      road === "both"
        ? {
            road,
            differed: (what) => {
              // Under the compare preload, the test it happened in fails.
              if (roads.road === "both") roads.differences.push(what);
              options.differed?.(what);
            },
          }
        : { road },
  });
}

/**
 * The core, loaded when a test first needs its harness. A test of the transport alone scripts a
 * harness, and then loads none of the core: what it checks doesn't hang on the core's state.
 */
function core(): typeof Core {
  return require("../../src/core/index") as typeof Core;
}

/** The host as an extension that builds LumiAH into itself may hand it to LumiAH's backend: every path of the user's storage under `folder` (LumiRPEngine's mount does so). */
function storedUnder(host: FakeHost, folder: string): FakeHost {
  const under = (path: string): string => `${folder}/${path}`;
  const storage: FakeHost["storage"] = {
    read: (path, userId) => host.storage.read(under(path), userId),
    write: (path, text, userId) => host.storage.write(under(path), text, userId),
    remove: (path, userId) => host.storage.remove(under(path), userId),
    stat: (path, userId) => host.storage.stat(under(path), userId),
    list: (dir, userId) => host.storage.list(under(dir), userId),
  };
  return new Proxy(host, { get: (target, key) => (key === "storage" ? storage : Reflect.get(target, key, target)) });
}

export async function rig(options: RigOptions = {}): Promise<Rig> {
  // An extension that LumiAH is built into is installed under its own identifier: Lumiverse lists it by that, and its runtime links to it.
  const host = new FakeHost(options.backend?.identity?.identifier);
  const lumiverse = new FakeLumiverse(host, USER);
  // Put together again by `restart`, as Lumiverse does when it starts the extension's worker anew.
  const assemble = (): Backend =>
    createBackend(
      (options.mount ?? ((made: FakeHost) => made))(options.storage === undefined ? host : storedUnder(host, options.storage)),
      {
        now: () => Date.now(),
        later: (ms, fn) => {
          const timer = setTimeout(fn, ms);
          return () => clearTimeout(timer);
        },
        build: BUILD,
        ...(options.shipped !== undefined ? { runtime: options.shipped } : {}),
      },
      options.backend,
    );
  const backend = assemble();
  // The user's own connection in Lumiverse, their default there: what a chat generates on until LumiAH is switched on in it. The agents run on the runtime's own (`options.connections`).
  host.addConnection({ id: "conn-main", name: "Main", provider: "openai", model: "model-main", isDefault: true });
  if (options.heldElsewhere !== undefined) {
    const holder = { relay: "relay-elsewhere", copy: "e".repeat(32), process: "e".repeat(32), owner: options.heldElsewhere };
    await (options.storage === undefined ? host : storedUnder(host, options.storage)).storage.write("mirror-holder.json", JSON.stringify({ v: 1, holder, gen: 0 }), USER);
  }

  const registered = await lumiverse.raw({ type: "register", name: "mara", build: options.build ?? BUILD, host: "harbour-box", listen: "127.0.0.1", port: PORT });
  if (registered.type !== "result") throw new Error(`register failed: ${registered.message}`);
  const { relay, secret } = registered.body as LinkRequests["register"]["result"];
  const logs: string[] = [];
  const dir = options.dir ?? tempFolder();
  const differences: string[] = [];
  const runtime = runtimeFor(lumiverse, { relay, secret }, logs, {
    ...options,
    dir,
    differed: (what) => {
      differences.push(what);
      options.differed?.(what);
    },
  });
  // Lumiverse's proxy reaches the runtime's loopback server on this machine, once a test grants the extension `cors_proxy`.
  host.servers.set(roadBase("127.0.0.1", PORT), (request) => runtime.fetch(request));
  const page = lumiverse.page();
  // The runtime's own clockwork (a gap asked about again, a ping), which `lumiah serve` runs every second, runs here every few milliseconds.
  const ticker = setInterval(() => runtime.tick(), 5);
  const made: Rig = {
    host,
    lumiverse,
    backend,
    runtime,
    page,
    logs,
    registration: { relay, secret },
    key: "",
    dir,
    mirrored: () => runtime.store.settle(),
    generate: (chatId, more = {}) => lumiverse.generate(runtime.fetch, chatId, { key: made.key, port: PORT, ...more }),
    async setUp() {
      await runtime.link.connect();
      const minted = await page.request("lah.key", { op: "mint" });
      if (minted.key === null || minted.connection === null) throw new Error("the runtime didn't make the loopback connection");
      made.key = minted.key;
      const chat = host.addChat(USER, "Harbour light");
      host.say(chat.id, "user", "Who keeps the harbour light now?");
      await page.request("lah.chat.set", { chatId: chat.id, on: true });
      return chat.id;
    },
    async restart() {
      await made.backend.settle();
      host.reload();
      made.backend = assemble();
    },
    async close() {
      clearInterval(ticker);
      runtime.shutdown();
      await runtime.close();
    },
    differences,
  };
  return made;
}
