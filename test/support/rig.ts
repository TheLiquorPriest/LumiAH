// A whole LumiAH for a test: the extension backend over a fake Lumiverse, a runtime registered and
// linked to it over the fake's event socket, with the core's own harness answering turns and a
// scripted model behind the backend. `setUp` adds what first-time setup does: a loopback key minted
// (the runtime makes the loopback connection with it) and a chat switched on.

import { AGENT, createHarness, isRecord, settingsOf } from "../../src/core/index";
import { type Backend, startBackend } from "../../src/extension/backend/backend";
import type { LinkRequests } from "../../src/link/contract";
import { RUNTIME_DEFAULTS, type RuntimeTuning } from "../../src/link/settings";
import type { RuntimeConfig } from "../../src/runtime/config";
import { createRuntime, type Runtime } from "../../src/runtime/runtime";
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
  backend: Backend;
  runtime: Runtime;
  page: FakePage;
  /** What the runtime logged. */
  logs: string[];
  /** The loopback key, once `setUp` minted it. */
  key: string;
  /** A generation in a chat, on the runtime's loopback endpoint. */
  generate(chatId: string, options?: Partial<Parameters<FakeLumiverse["generate"]>[2]>): Promise<Generated>;
  /** Mints the loopback key, which has the runtime make the loopback connection, and switches LumiAH on for a new chat with one message of Mara's; the chat's id. */
  setUp(): Promise<string>;
  close(): void;
}

/** The runtime's timings for a test: nothing waits, so a test takes no longer than its work. */
export const FAST: RuntimeTuning = { ...RUNTIME_DEFAULTS, traceMs: 0, resendMs: 20, reconnectMs: 5, reconnectMaxMs: 20, stopGraceMs: 0 };

/** A runtime over a fake Lumiverse, with the core's own harness, as `lumiah serve` puts one together from its config. */
export function runtimeFor(lumiverse: FakeLumiverse, registration: { relay: string; secret: string }, logs: string[], options: { tuning?: Partial<RuntimeTuning>; build?: string } = {}): Runtime {
  const config: RuntimeConfig = { name: "mara", base: lumiverse.base, listen: "127.0.0.1", port: PORT, relay: registration.relay, secret: registration.secret, session: { username: "mara", token: lumiverse.token, savedAt: 0 }, tuning: { ...FAST, ...options.tuning } };
  let held = registration.secret;
  return createRuntime(config, {
    http: lumiverse.http,
    openSocket: lumiverse.openSocket,
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
    harness: (harnessHost, settings) => createHarness(harnessHost, { settings }),
    writerConnection: (values) => settingsOf(isRecord(values) ? values.core : undefined).agents[AGENT.writer]?.connectionId ?? null,
  });
}

export async function rig(options: { tuning?: Partial<RuntimeTuning>; build?: string } = {}): Promise<Rig> {
  const host = new FakeHost();
  const lumiverse = new FakeLumiverse(host, USER);
  const backend = startBackend(host, {
    now: () => Date.now(),
    later: (ms, fn) => {
      const timer = setTimeout(fn, ms);
      return () => clearTimeout(timer);
    },
    build: BUILD,
  });
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
    key: "",
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
    close() {
      clearInterval(ticker);
      runtime.shutdown();
      runtime.close();
    },
  };
  return made;
}
