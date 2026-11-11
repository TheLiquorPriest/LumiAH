// A runtime, put together from its config (DESIGN §1): the link's client end, the streams it reads,
// the core's host over the link, the turns, and the loopback endpoint Lumiverse calls. `serve` runs
// one under Bun.serve; the tests run one against a fake Lumiverse, calling its handler directly.

import type { HarnessExtension } from "../core/extension";
import type { HarnessHost, JsonObject, JsonValue, LogLevel } from "../core/ports";
import type { AskPush, ConnectionPush, ExtensionOffer } from "../link/contract";
import { loopbackModel, runtimeBase } from "../link/contract";
import { linkedBackendOf } from "../link/frames";
import { isRecord } from "../link/json";
import type { RuntimeTuning } from "../link/settings";
import { TRANSPORT_KEY } from "../link/settings";
import type { RuntimeConfig } from "./config";
import type { OpenSocket } from "./connection";
import { asked, linkExtension, linkHost } from "./host";
import { LinkClient } from "./link";
import type { Http, StoredLogin } from "./lumiverse";
import { addConnectionProfile, connectionProfiles, loopbackProfile, setConnectionKey, stopGeneration } from "./lumiverse";
import { Relay } from "./relay";
import { RuntimeSettings } from "./settings";
import { Streams } from "./streams";
import { TraceSink } from "./trace";
import type { Harness } from "./turn";
import { Turns } from "./turn";
import { refusalOf, Work } from "../link/work";

export interface RuntimeDeps {
  http: Http;
  openSocket: OpenSocket;
  now(): number;
  log(text: string): void;
  build: string;
  /** How it runs, for the Runtime page's lines: the Bun binary, its own script, the unit running it. */
  ran: { bun: string | null; script: string; unit: string | null };
  host: string;
  /** The sign-in to use now: read again whenever the link opens. */
  credentials(): StoredLogin | null;
  /** The relay's secret now, and what keeps a new one. */
  secret(): string;
  rotated(secret: string): void;
  /** Keeps the limits and timings the user's settings now hold. */
  keepTuning(tuning: RuntimeTuning): void;
  /**
   * The core's harness over a host (`createHarness`). `settings` gives the core's own section of the
   * user's settings, their texts and their own definitions as stored, read at the start of every
   * run; `extension` is what the extension LumiAH is built into supplies, each member a request to
   * its backend.
   */
  harness(host: HarnessHost, settings: () => Promise<{ values: unknown; texts: unknown; definitions?: unknown }>, extension: HarnessExtension): Harness;
  /** The writer's connection, from the settings' values; null: the user's default. */
  writerConnection(values: JsonObject): string | null;
}

export interface Runtime {
  /** The loopback endpoint's handler (Bun.serve's `fetch`). */
  fetch(req: Request): Promise<Response>;
  /** Every second: the link, the streams and the answers' keep-alives. */
  tick(): void;
  /** Ends every request under way with words the chat shows; the caller closes the link once they have gone out. */
  shutdown(): void;
  close(): void;
  readonly link: LinkClient;
  readonly relay: Relay;
  readonly turns: Turns;
  readonly work: Work;
}

const hex = (bytes: number): string => [...crypto.getRandomValues(new Uint8Array(bytes))].map((b) => b.toString(16).padStart(2, "0")).join("");

export function createRuntime(config: RuntimeConfig, deps: RuntimeDeps): Runtime {
  let settings: RuntimeSettings | null = null;
  const tuning = (): RuntimeTuning => settings?.tuning() ?? config.tuning;
  const link = new LinkClient({
    base: config.base,
    identifier: config.extension,
    credentials: deps.credentials,
    http: deps.http,
    openSocket: deps.openSocket,
    relay: config.relay,
    secret: deps.secret,
    rotated: deps.rotated,
    name: config.name,
    build: deps.build,
    runtime: deps.ran,
    host: deps.host,
    listen: config.listen,
    port: config.port,
    tuning,
    now: deps.now,
    log: deps.log,
  });
  settings = new RuntimeSettings(link, { tuning: config.tuning, keep: deps.keepTuning, log: deps.log });
  const held = settings;
  const streams = new Streams(link, { now: deps.now, log: deps.log, tuning });
  const trace = new TraceSink(link, { now: deps.now, log: deps.log, tuning });
  // The turns and the host need each other: the host names the turn a model call serves.
  let turns: Turns | null = null;
  // The host hands the core's jobs to the work runner, which needs the harness the host is for.
  let jobs: Work | null = null;
  let offer: ExtensionOffer | null = null;
  const host = linkHost({
    link,
    streams,
    id: () => hex(16),
    now: deps.now,
    tuning,
    log: (level: LogLevel, message: string) => deps.log(level === "info" || level === "debug" ? message : `${level}: ${message}`),
    trace: (record) => trace.event(turns?.traced(record) ?? record),
    delta: (delta) => trace.delta(delta),
    turn: () => turns?.current() ?? null,
    chat: () => turns?.currentChat() ?? null,
    jobQueued: (job) => jobs?.queued(job),
    jobChanged: (job) => jobs?.changed(job),
  });
  const harness = deps.harness(
    host,
    async () => {
      const snapshot = await held.get();
      return { values: snapshot.values.core, texts: snapshot.texts, ...(snapshot.definitions !== undefined ? { definitions: snapshot.definitions } : {}) };
    },
    linkExtension({ link, now: deps.now, tuning, offer: () => offer }),
  );
  const work = new Work(harness, {
    log: deps.log,
    id: () => hex(16),
    within: (run, fn) => (turns === null ? fn() : turns.within(run, fn)),
    traced: async (run) => {
      await trace.drained();
      trace.forget(run);
    },
    tell: (job) => void asked({ link, now: deps.now, tuning }, "job.changed", { job }).catch((error: unknown) => deps.log(`couldn't tell LumiAH about job ${job.id.slice(0, 8)}: ${error instanceof Error ? error.message : String(error)}`)),
    words: {
      notYet: "This runtime's build can't do that yet: update the runtime with its update line on the Runtime page.",
      noSuch: (op) => `There is nothing the runtime does by the name ${op}: update the runtime and the extension to the same build.`,
      ending: "The runtime is restarting.",
    },
  });
  jobs = work;
  const running = new Turns(link, harness, held, trace, {
    now: deps.now,
    log: deps.log,
    tuning,
    writerConnection: deps.writerConnection,
    replied: (chatId) => work.replied(chatId),
    stopGeneration: async (generation, chat) => {
      const token = deps.credentials()?.token;
      if (token === undefined) throw new Error("the runtime isn't signed in to Lumiverse");
      return stopGeneration(deps.http, config.base, token, generation, chat);
    },
  });
  turns = running;
  const relay = new Relay(link, streams, running, { listen: config.listen, port: config.port, model: loopbackModel(config.extension) }, { now: deps.now, id: () => hex(16), log: deps.log, tuning, secret: deps.secret });

  /**
   * First-time setup, and every new loopback key (the `connection` push): the key goes into the
   * user's loopback connection, made here when they have none. The key is used for that and let go.
   * The connection is this extension's own: it names the extension's loopback model, and one made
   * here is called what the extension said (on the push, else on the last hello).
   */
  async function connection(push: ConnectionPush): Promise<void> {
    const url = runtimeBase(config.listen, config.port);
    const model = loopbackModel(config.extension);
    let made: { id: string; name: string } | null = null;
    let problem: string | null = null;
    try {
      const token = deps.credentials()?.token;
      if (token === undefined) throw new Error("the runtime isn't signed in to Lumiverse");
      const found = loopbackProfile(await connectionProfiles(deps.http, config.base, token, tuning().connectionsRead), url, model);
      if (found !== null) {
        await setConnectionKey(deps.http, config.base, token, found.id, push.key);
        made = { id: found.id, name: found.name };
      } else {
        const added = await addConnectionProfile(deps.http, config.base, token, { name: push.name ?? linkedBackendOf(link.hello?.backend).connection, provider: "custom", apiUrl: url, model, apiKey: push.key });
        made = { id: added.id, name: added.name };
      }
      deps.log(`put the loopback key in the connection "${made.name}"`);
    } catch (error) {
      problem = error instanceof Error ? error.message : String(error);
      deps.log(`couldn't put the loopback key in a connection: ${problem}`);
    }
    await link.request("setup.connection", { ref: push.ref, connection: made, problem }, tuning().lostMs).catch((error: unknown) => deps.log(`couldn't tell LumiAH about the connection: ${error instanceof Error ? error.message : String(error)}`));
  }

  /** Something a page asked of the core (the `ask` push): done, and answered by its name, whichever way it went. */
  async function answer(push: AskPush): Promise<void> {
    let value: JsonValue = null;
    let refusal: { code: string; message: string; problems?: JsonValue } | null = null;
    try {
      value = await work.ask(push.op, push.args);
    } catch (error) {
      refusal = refusalOf(error);
      if (refusal.code === "internal") deps.log(`${push.op} failed: ${refusal.message}`);
    }
    await asked({ link, now: deps.now, tuning }, "ask.answer", { ask: push.ask, value, refusal }).catch((error: unknown) => deps.log(`couldn't answer LumiAH's ${push.op}: ${error instanceof Error ? error.message : String(error)}`));
  }

  /** The user's hold on all jobs, as their settings have it now. */
  async function hold(): Promise<void> {
    try {
      const transport = (await held.get()).values[TRANSPORT_KEY];
      await work.setHold(isRecord(transport) && isRecord(transport.jobs) && transport.jobs.paused === true);
    } catch (error) {
      deps.log(`couldn't read whether jobs are held: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  link.attach({
    chunk: (push) => streams.chunk(push),
    open: () => streams.open(),
    lost: (ids) => streams.lost(ids),
    stopped: (why, detail) => streams.stopped(why, detail),
    stop: (push) => {
      running.stop(push);
      work.stop(push.turn, push.why);
    },
    settings: (revision) => {
      held.note(revision);
      void hold();
    },
    connection: (push) => void connection(push),
    ask: (push) => void answer(push),
    offer: (said) => {
      offer = said;
      // The link is up: what a restart cut off is found, and the user's hold on jobs is read.
      void work.recover();
      void hold();
    },
    turns: () => [...running.ids(), ...work.ids()],
  });

  return {
    fetch: relay.fetch,
    tick() {
      link.tick();
      streams.tick();
      relay.tick();
    },
    shutdown() {
      running.shutdown();
      work.shutdown();
      relay.shutdown();
      streams.shutdown();
    },
    close: () => link.close(),
    link,
    relay,
    turns: running,
    work,
  };
}
