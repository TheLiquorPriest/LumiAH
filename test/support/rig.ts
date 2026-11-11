// A whole LumiAH for a test: the extension backend over a fake Lumiverse, a runtime registered and
// linked to it over the fake's event socket, with the core's own harness answering turns and a
// scripted model behind the backend. `setUp` adds what first-time setup does: a loopback key minted
// (the runtime makes the loopback connection with it) and a chat switched on.

import type * as Core from "../../src/core/index";
import { isRecord } from "../../src/link/json";
import { type Backend, type BackendOptions, createBackend } from "../../src/extension/backend/backend";
import type { LinkRequests } from "../../src/link/contract";
import { RUNTIME_DEFAULTS, type RuntimeTuning } from "../../src/link/settings";
import type { RuntimeConfig } from "../../src/runtime/config";
import { createRuntime, type Runtime, type RuntimeDeps } from "../../src/runtime/runtime";
import type { Harness } from "../../src/runtime/turn";
import { FakeHost } from "./fake-host";
import { FakeLumiverse, type FakePage, type Generated } from "./fake-lumiverse";

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
  /** Switches LumiAH on for a new chat with one message of Mara's, to run built in: no runtime, no key, the chat on the user's own connection; the chat's id. */
  setUpBuiltin(name?: string): Promise<string>;
  /** Lumiverse starts the extension's worker anew (an update, a reload, its own restart): everything the backend held in memory is gone, what Lumiverse and the user's storage hold stays, and a new backend is put together over them. The runtime and the page stay as they are. */
  restart(): Promise<void>;
  close(): void;
}

/** The runtime's timings for a test: nothing waits, so a test takes no longer than its work. */
export const FAST: RuntimeTuning = { ...RUNTIME_DEFAULTS, traceMs: 0, resendMs: 20, reconnectMs: 5, reconnectMaxMs: 20, stopGraceMs: 0 };

/** Where a harness a test scripts is made for: the runtime's process, or the extension's own (built in). */
export type RigPlace = "runtime" | "builtin";

/** What a rig may be given: the runtime's timings and build, a harness in place of the core's own in both places (a test of the transport alone scripts one, and is told which place each is made for), what an extension that builds LumiAH into itself gives its backend, and the runtime's way to Lumiverse where it isn't the fake's own (a test that kills a runtime's process pulls it: plug.ts). */
export interface RigOptions {
  tuning?: Partial<RuntimeTuning>;
  build?: string;
  harness?: (...args: [...Parameters<RuntimeDeps["harness"]>, place: RigPlace]) => Harness;
  backend?: BackendOptions;
  wire?: (lumiverse: FakeLumiverse) => Pick<FakeLumiverse, "http" | "openSocket">;
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
  return createRuntime(config, {
    http: wire.http,
    openSocket: wire.openSocket,
    now: () => Date.now(),
    log: (text) => void logs.push(text),
    build: options.build ?? BUILD,
    ran: { bun: "/opt/bun/bin/bun", script: "/home/mara/.local/share/lumiah/lumiah.js", unit: null },
    host: "harbour-box",
    credentials: () => config.session,
    secret: () => held,
    rotated: (next) => {
      held = next;
    },
    keepTuning: () => undefined,
    harness: scripted !== undefined ? (harnessHost, settings, extension) => scripted(harnessHost, settings, extension, "runtime") : (harnessHost, settings, extension) => core().createHarness(harnessHost, { settings, extension }),
    writerConnection: (values) => {
      const writer = isRecord(values) && isRecord(values.core) && isRecord(values.core.agents) ? values.core.agents.writer : undefined;
      return isRecord(writer) && typeof writer.connectionId === "string" ? writer.connectionId : null;
    },
  });
}

/**
 * The core, loaded when a test first needs its harness. A test of the transport alone scripts a
 * harness, and then loads none of the core: what it checks doesn't hang on the core's state.
 */
function core(): typeof Core {
  return require("../../src/core/index") as typeof Core;
}

export async function rig(options: RigOptions = {}): Promise<Rig> {
  // An extension that LumiAH is built into is installed under its own identifier: Lumiverse lists it by that, and its runtime links to it.
  const host = new FakeHost(options.backend?.identity?.identifier);
  const lumiverse = new FakeLumiverse(host, USER);
  const scripted = options.harness;
  // Put together again by `restart`, as Lumiverse does when it starts the extension's worker anew.
  const assemble = (): Backend =>
    createBackend(
      host,
      {
        now: () => Date.now(),
        later: (ms, fn) => {
          const timer = setTimeout(fn, ms);
          return () => clearTimeout(timer);
        },
        build: BUILD,
        // A scripted harness stands for the core in both places: built in, it answers what a page asks, and has no part in a reply (a test of a built-in turn runs the core's own).
        ...(scripted !== undefined
          ? {
              harness: (harnessHost, given) => ({
                prepare: async (turn) => ({ messages: turn.messages, part: "none" as const, reason: "This test's harness prepares no turn.", pending: false, usage: { calls: 0, toolTurns: 0, in: 0, cachedIn: 0, out: 0, reasoningOut: 0, estimated: false, ms: 0 } }),
                complete: async () => {
                  throw new Error("this test's harness completes no turn");
                },
                abandon: async () => ({ abandoned: true }),
                ...scripted(harnessHost, given.settings, given.extension ?? { name: "LumiAH" }, "builtin"),
              }),
            }
          : {}),
      },
      options.backend,
    );
  const backend = assemble();
  // The agents' own connection: the user's default.
  host.addConnection({ id: "conn-main", name: "Main", provider: "openai", model: "model-main", isDefault: true });
  // The stream's text isn't held back, so a test reads each piece as it is written.
  await backend.settings.change(USER, [{ path: ["transport", "streams", "coalesceMs"], value: 0 }], []);

  const registered = await lumiverse.raw({ type: "register", name: "mara", build: options.build ?? BUILD, host: "harbour-box", listen: "127.0.0.1", port: PORT });
  if (registered.type !== "result") throw new Error(`register failed: ${registered.message}`);
  const { relay, secret } = registered.body as LinkRequests["register"]["result"];
  const logs: string[] = [];
  const runtime = runtimeFor(lumiverse, { relay, secret }, logs, options);
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
    generate: (chatId, more = {}) => lumiverse.generate(runtime.fetch, chatId, { key: made.key, port: PORT, ...more }),
    async setUp() {
      await runtime.link.connect();
      const minted = await page.request("lah.key", { op: "mint" });
      if (minted.key === null || minted.connection === null) throw new Error("the runtime didn't make the loopback connection");
      made.key = minted.key;
      const chat = host.addChat(USER, "Harbour light");
      host.say(chat.id, "user", "Who keeps the harbour light now?");
      await page.request("lah.chat.set", { chatId: chat.id, on: true, place: "runtime" });
      return chat.id;
    },
    async setUpBuiltin(name = "Harbour light") {
      const chat = host.addChat(USER, name);
      host.say(chat.id, "user", "Who keeps the harbour light now?");
      await page.request("lah.chat.set", { chatId: chat.id, on: true, place: "builtin" });
      return chat.id;
    },
    async restart() {
      await made.backend.settle();
      host.reload();
      made.backend = assemble();
    },
    close() {
      clearInterval(ticker);
      runtime.shutdown();
      runtime.close();
    },
  };
  return made;
}
