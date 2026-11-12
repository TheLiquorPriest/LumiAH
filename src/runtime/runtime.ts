// A runtime, put together from its config (DESIGN §1): the link's client end, the streams it reads,
// the model layer its agents call their providers through (models/), the core's host (its model
// calls the runtime's own, the rest over the link), the turns, and the loopback endpoint Lumiverse
// calls. `serve` runs one under Bun.serve; the tests run one against a fake Lumiverse, calling its
// handler directly.

import type { HarnessExtension } from "../core/extension";
import { chatDocuments } from "../core/harness";
import type { CacheRetention, HarnessHost, JsonObject, JsonValue, LogLevel } from "../core/ports";
import { DEFAULT_CACHE_RETENTION } from "../core/ports";
import type { AskPush, ConnectionPush, ExtensionOffer, UpdatePush } from "../link/contract";
import { loopbackModel, runtimeBase } from "../link/contract";
import { linkedBackendOf } from "../link/frames";
import { timeoutPlace } from "../shared/timeouts";
import { isRecord } from "../link/json";
import type { RuntimeTuning } from "../link/settings";
import { TRANSPORT_KEY, transportOf } from "../link/settings";
import { Timings } from "../link/timings";
import { AskDesk } from "./asks";
import { bookOp, isBookOp } from "./book";
import type { RuntimeConfig } from "./config";
import type { OpenSocket } from "./connection";
import { asked, linkExtension, linkHost, linkStorage, refusedForGood, unknownRuntime, withdrawn } from "./host";
import { LinkClient, LOST_WAIT } from "./link";
import type { Http, StoredLogin } from "./lumiverse";
import { addConnectionProfile, connectionProfiles, loopbackProfile, setConnectionKey, stopGeneration, timedHttp } from "./lumiverse";
import type { ModelLayer, ModelLayerDeps } from "./models";
import { bothRoads, type ChatDataDeps, createChatData } from "./reads";
import { Relay } from "./relay";
import { RuntimeSettings } from "./settings";
import { Streams } from "./streams";
import { createWorkingStore, type WorkingStore, type WorkingStoreState } from "./store";
import { TraceSink } from "./trace";
import type { Harness } from "./turn";
import { Turns } from "./turn";
import type { Update } from "./update/update";
import { isWorkOp, OpRefused, Work } from "../link/work";

export interface RuntimeDeps {
  http: Http;
  openSocket: OpenSocket;
  now(): number;
  log(text: string): void;
  build: string;
  /** How it runs, for the Runtime page's lines: the Bun binary, its own script, the unit running it. */
  ran: { bun: string | null; script: string; unit: string | null };
  host: string;
  /** The runtime's own folder (`runtimeDir`, made by `serve` with RUNTIME_DIR_MODE): its connections, its keys and its working store go in it. */
  dir: string;
  /** Builds the runtime's model layer (`createModelLayer`) over what the runtime hands it: its folder, clock, ids, timers, log, and what only it can answer (a call's prompt cache, the writer's connection, the connections that take one tool per answer). A test builds one whose providers it scripts. */
  models(deps: ModelLayerDeps): ModelLayer;
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
   * its backend; `place` says where the user changes one of the core's settings, for the words of a
   * wait of the core's that ran out (`HarnessOptions.place`).
   */
  harness(host: HarnessHost, settings: () => Promise<{ values: unknown; texts: unknown; definitions?: unknown }>, extension: HarnessExtension, place: (path: readonly string[], title: string) => string): Harness;
  /** The writer's connection, from the settings' values; null: the user's default. */
  writerConnection(values: JsonObject): string | null;
  /** The runtime's update and the settings of how it is run (`createUpdate`), given what says a reply, a request or a job is under way here: an update waits for none of them to be. */
  update(busy: () => boolean): Update;
  /**
   * Where the core's reads of chats and world books are answered: from the runtime's own copy, over
   * the link where it can't vouch for one (`copy`, the default); every one over the link (`link`); or
   * both, each read asked of both roads and the answers compared, every difference handed to
   * `differed` and the link's answer given (`both`: a test's check that the two roads agree).
   */
  reads?: { road: "copy" } | { road: "link" } | { road: "both"; differed(what: string): void };
  /** Opens the database reader on Lumiverse's file where the operator switched it on (`createDbSource` when not given: a test gives one over a file it keeps). */
  database?: ChatDataDeps["database"];
  /** How long a route of Lumiverse's the copy reads is asked nothing once it didn't answer as expected for several different chats or books in a row (`PAUSE_MS` when not given: a test makes it short). */
  routePauseMs?: number;
  /** How often the link pings while idle, below the 5 s at least a user's "Ping while idle" may say: a test pings often, to see what a ping finds. As the settings say when not given. */
  idlePingMs?: number;
}

export interface Runtime {
  /** The loopback endpoint's handler (Bun.serve's `fetch`). */
  fetch(req: Request): Promise<Response>;
  /** Every second: the link, the streams and the answers' keep-alives. */
  tick(): void;
  /** Ends every request under way with words the chat shows; the caller closes the link once they have gone out. */
  shutdown(): void;
  /** Hands what the runtime saved to the extension's storage while the link is up (waiting as long as the storage wait setting says), closes the working store (what didn't go waits on the disk for the next start), then the link. */
  close(): Promise<void>;
  readonly link: LinkClient;
  readonly relay: Relay;
  readonly turns: Turns;
  readonly work: Work;
  /** The core's documents and blobs on the runtime's disk, the extension's storage as their mirror. */
  readonly store: WorkingStore;
  /** Its update from the extension's own copy, and the settings of how it is run (the Runtime page's). */
  readonly update: Update;
  /** What the pages and an extension's tools ask of it: each ask done once, whichever road it came by, and the route Lumiverse's proxy reaches. */
  readonly asks: AskDesk;
  /** Its end of the timing log: every request its link sends the extension. */
  readonly timings: Timings;
}

/** The working store's state as the Runtime page reads it (`store.state`). */
function storeView(state: WorkingStoreState): JsonValue {
  const { open, mode, holder, lost, waiting, behindSince, lastError, lastSent, bytes, counting, takeover, refused } = state;
  return { open, mode, holder, lost, waiting, behindSince, lastError, lastSent, bytes, counting, takeover, refused };
}

/** How long a provider keeps the prompt cache of a request passed through: as the user's settings keep the agents' (the core's `cache.retention`), else its default. */
function passRetention(values: JsonObject): CacheRetention {
  const core = values.core;
  const kept = isRecord(core) && isRecord(core.cache) ? core.cache.retention : undefined;
  return kept === "none" || kept === "short" || kept === "long" ? kept : DEFAULT_CACHE_RETENTION;
}

const hex = (bytes: number): string => [...crypto.getRandomValues(new Uint8Array(bytes))].map((b) => b.toString(16).padStart(2, "0")).join("");

export function createRuntime(config: RuntimeConfig, deps: RuntimeDeps): Runtime {
  let settings: RuntimeSettings | null = null;
  const tuning = (): RuntimeTuning => settings?.tuning() ?? config.tuning;
  const idlePingMs = deps.idlePingMs;
  /** Its end of the timing log (Runtime → Timings): every request its link sends the extension, never what it carried. */
  const timings = new Timings();
  /** Its HTTP to Lumiverse, each request held to the Lumiverse wait, whose words name where the extension it links to shows that setting. */
  const http = timedHttp(deps.http, () => tuning().lumiverseMs, () => linkedBackendOf(link.hello?.backend));
  const link = new LinkClient({
    base: config.base,
    identifier: config.extension,
    credentials: deps.credentials,
    http,
    openSocket: deps.openSocket,
    timings,
    relay: config.relay,
    secret: deps.secret,
    rotated: deps.rotated,
    name: config.name,
    build: deps.build,
    runtime: deps.ran,
    host: deps.host,
    listen: config.listen,
    port: config.port,
    // A test's own pace of idle pings, where it gives one; the user's settings otherwise.
    tuning: idlePingMs === undefined ? tuning : (): RuntimeTuning => ({ ...tuning(), heartbeatMs: idlePingMs }),
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
  // The agents' model calls go from here straight to each provider, on the runtime's own connections: nothing of them crosses the link.
  const layer = deps.models({
    dir: deps.dir,
    now: deps.now,
    id: () => hex(16),
    uuid: () => crypto.randomUUID(),
    log: deps.log,
    fetch: globalThis.fetch,
    setTimeout: (run, ms) => setTimeout(run, ms),
    clearTimeout: (handle) => clearTimeout(handle as Timer),
    // An agent's call names its session and how long its cache is kept (the core's settings); a request passed through keeps it as the user's settings keep the agents'.
    caching: async (request) => (request !== null ? { retention: request.cacheRetention ?? DEFAULT_CACHE_RETENTION, ...(request.session !== undefined ? { sessionId: request.session } : {}) } : { retention: passRetention((await held.get()).values) }),
    passConnection: async () => (turns === null ? null : turns.writerConnection()),
    serialTools: async () => transportOf((await held.get()).values[TRANSPORT_KEY]).connections.oneToolAtATime,
    // Its waits are the runtime's settings, read at each use; their words name them where the extension it links to shows its Settings.
    silentMs: () => tuning().answerSilentMs,
    askMs: () => tuning().providerMs,
    signInMs: () => tuning().signInMs,
    owner: () => linkedBackendOf(link.hello?.backend),
  });
  const host = linkHost({
    link,
    streams,
    models: layer.models,
    connections: layer.connections,
    id: () => hex(16),
    now: deps.now,
    tuning,
    log: (level: LogLevel, message: string) => deps.log(level === "info" || level === "debug" ? message : `${level}: ${message}`),
    trace: (record) => trace.event(turns?.traced(record) ?? record),
    delta: (delta) => trace.delta(delta),
    chat: () => turns?.currentChat() ?? null,
    jobQueued: (job) => jobs?.queued(job),
    jobChanged: (job) => jobs?.changed(job),
  });
  // The core's reads of chats and world books: answered over the runtime's own copy of chat and lore, which reads Lumiverse itself (the database file where the operator allows it, else HTTP as the runtime's user), and over the link wherever it can't vouch for one (reads.ts).
  const road = deps.reads ?? { road: "copy" };
  const linkReads = { chat: host.chat, lore: host.lore, recall: host.recall };
  const chatData = createChatData({
    link,
    viaLink: linkReads,
    base: config.base,
    credentials: deps.credentials,
    http: deps.http,
    now: deps.now,
    tuning,
    log: (level, message) => deps.log(level === "info" || level === "debug" ? message : `${level}: ${message}`),
    owner: () => linkedBackendOf(link.hello?.backend),
    pathKeeping: async () => {
      const { pathsKept, pathMs } = transportOf((await held.get()).values[TRANSPORT_KEY]).sessions;
      return { chats: pathsKept, ms: pathMs };
    },
    sleep: (ms) => Bun.sleep(ms),
    ...(deps.database !== undefined ? { database: deps.database } : {}),
    ...(deps.routePauseMs !== undefined ? { routePauseMs: deps.routePauseMs } : {}),
    ...(road.road === "link" ? { off: "This runtime was started to read every chat and world book over its link." } : {}),
  });
  const reads = road.road === "both" ? bothRoads(linkReads, chatData.reads, road.differed) : road.road === "link" ? linkReads : chatData.reads;
  // The core's documents and blobs: on the runtime's own disk, the extension's storage behind them as their mirror (store/), while the extension lets this runtime hold the mirror; else straight on the storage.
  const holding = hex(16);
  const working = createWorkingStore({
    dir: `${deps.dir}/store`,
    identity: { lumiverse: config.base, user: config.session.username, extension: config.extension },
    remote: linkStorage({ link, now: deps.now, tuning }, holding),
    direct: linkStorage({ link, now: deps.now, tuning }),
    holding,
    owner: `${config.name} (${deps.host})`,
    now: deps.now,
    later: (ms, fn) => {
      const timer = setTimeout(fn, ms);
      return () => clearTimeout(timer);
    },
    id: () => hex(16),
    log: (level, message) => deps.log(level === "info" || level === "debug" ? message : `${level}: ${message}`),
    chatDocuments,
    limits: () => ({ waitMs: tuning().storeWaitMs }),
    waitsOwner: () => linkedBackendOf(link.hello?.backend),
    refusedForGood,
    withdrawn,
    // The extension no longer knows this runtime (forgotten, or registered anew), or its link is refused: nobody will take what it sends, and its stop doesn't wait for anybody.
    disowned: (error) => link.refused !== null || unknownRuntime(error),
    release: async () => {
      await asked({ link, now: deps.now, tuning }, "mirror.release", { mirror: holding });
    },
  });
  /** Waits until the extension's storage holds what the runtime saved before something that names it goes out; when it doesn't in time, says so and lets it go: the runtime's copy holds it, and it follows. */
  const settled = async (what: string): Promise<void> => {
    await working.settle().catch((error: unknown) => deps.log(`${what} went out before the extension's storage had everything it names: ${error instanceof Error ? error.message : String(error)}`));
  };
  const ported: HarnessHost = {
    ...host,
    store: working.store,
    blobs: working.blobs,
    // A record on a message names blobs and heads that the extension's readers then fetch from its storage.
    chat: {
      ...host.chat,
      ...reads.chat,
      anchor: async (chatId, messageId, swipeId, record) => {
        await settled("a record");
        const written = await host.chat.anchor(chatId, messageId, swipeId, record);
        // The copy of the chat waits for Lumiverse's word of the write, so no read misses it, unless it holds the record already.
        if (written) chatData.written(chatId, messageId, { swipe: swipeId, record });
        return written;
      },
    },
    lore: { ...host.lore, ...reads.lore },
    recall: { ...host.recall, lore: { ...host.recall.lore, ...reads.recall.lore }, chat: reads.recall.chat },
  };
  const harness = deps.harness(
    ported,
    async () => {
      const snapshot = await held.get();
      return { values: snapshot.values.core, texts: snapshot.texts, ...(snapshot.definitions !== undefined ? { definitions: snapshot.definitions } : {}) };
    },
    linkExtension({ link, now: deps.now, tuning, offer: () => offer }),
    // The core's settings are under "core", beside the transport's: shown where the extension the runtime links to says its Settings are, as the runtime's own waits name them.
    (path, title) => timeoutPlace(["core", ...path], title, linkedBackendOf(link.hello?.backend)),
  );
  const work = new Work(harness, {
    log: deps.log,
    id: () => hex(16),
    within: (run, fn) => {
      // A job's run reads its chat: the copy checks the chat before the run's first read of it.
      if (run.chat !== "") chatData.began(run.chat);
      return turns === null ? fn() : turns.within(run, fn);
    },
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
      return stopGeneration(http, config.base, token, generation, chat);
    },
    settle: () => working.settle(),
    began: (chatId) => chatData.began(chatId),
    committed: (chatId, messageId, swipe, record) => chatData.written(chatId, messageId, { swipe, record: record as unknown as JsonValue }),
  });
  turns = running;
  // What the pages and an extension's tools ask: each ask done once, whichever road it came by (asks.ts). The relay hands it `/x/ask`, which answers only the ops an `ask` push over the link is answered.
  const desk = new AskDesk({
    relay: config.relay,
    secret: deps.secret,
    now: deps.now,
    log: deps.log,
    knows: (op) => isBookOp(op) || Object.hasOwn(storeOps, op) || Object.hasOwn(serviceOps, op) || Object.hasOwn(roadOps, op) || Object.hasOwn(copyOps, op) || isWorkOp(op),
    answer: (op, args) => dispatch(op, args),
  });
  const relay = new Relay(link, layer, running, { listen: config.listen, port: config.port, model: loopbackModel(config.extension) }, { now: deps.now, id: () => hex(16), log: deps.log, tuning, secret: deps.secret, ask: desk.fetch });
  // An update waits while a reply, a request from Lumiverse, a job or a side session's turn is under way: a restart would end it.
  const update = deps.update(() => relay.count > 0 || running.count > 0 || work.ids().length > 0);

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
      const found = loopbackProfile(await connectionProfiles(http, config.base, token, tuning().connectionsRead), url, model);
      if (found !== null) {
        await setConnectionKey(http, config.base, token, found.id, push.key);
        made = { id: found.id, name: found.name };
      } else {
        const added = await addConnectionProfile(http, config.base, token, { name: push.name ?? linkedBackendOf(link.hello?.backend).connection, provider: "custom", apiUrl: url, model, apiKey: push.key });
        made = { id: added.id, name: added.name };
      }
      deps.log(`put the loopback key in the connection "${made.name}"`);
    } catch (error) {
      problem = error instanceof Error ? error.message : String(error);
      deps.log(`couldn't put the loopback key in a connection: ${problem}`);
    }
    await link.request("setup.connection", { ref: push.ref, connection: made, problem }, tuning().lostMs, LOST_WAIT).catch((error: unknown) => deps.log(`couldn't tell LumiAH about the connection: ${error instanceof Error ? error.message : String(error)}`));
  }

  /**
   * The page ops the runtime answers itself, beside the core's (`work.ask`): its working store's
   * (Runtime → System, and the barrier the extension's readers ask for before they read its
   * storage), and the forgetting of a deleted chat, which the store finishes after the core.
   */
  const storeOps: Readonly<Record<string, (args: JsonObject) => Promise<JsonValue>>> = {
    "store.settle": async () => {
      try {
        await working.settle();
      } catch (error) {
        throw new OpRefused("unavailable", error instanceof Error ? error.message : String(error));
      }
      return { settled: true };
    },
    "store.state": async () => storeView(working.state()),
    "chats.forget": async (args) => {
      // The core forgets what it kept of the chat (its jobs, its side sessions, its documents); then whatever of it is still on the runtime's disk or waits for the extension's storage goes too, and the storage holds none of it.
      const forgot = await work.ask("chats.forget", args);
      const left = await working.forget(String(args.chatId));
      return isRecord(forgot) && typeof forgot.documents === "number" ? { ...forgot, documents: forgot.documents + left.documents } : forgot;
    },
  };

  /** What a restart would cut off now: the replies under way and every request from Lumiverse (replies among them), the jobs and the side sessions' turns. */
  const underWay = (): JsonObject => ({ replies: running.count, requests: relay.count, ...work.runs() });
  /**
   * The page ops of how the runtime is run and kept (Runtime page): its settings and its update,
   * with what is under way. Asked of this runtime by its relay, by its own user's pages only (the
   * extension asks a user's own runtimes alone).
   */
  const serviceOps: Readonly<Record<string, (args: JsonObject) => Promise<JsonValue>>> = {
    "runtime.service.get": async () => ({ service: { ...update.get(), underWay: underWay() } }),
    "runtime.service.set": async (args) => {
      const done = await update.set(args);
      return { service: { ...done.view, underWay: underWay() }, restart: done.restart };
    },
    "runtime.update.apply": async () => {
      // Taken at once whatever is under way: what that was is what the restart cuts off, and the page says so.
      const cut = underWay();
      const view = await update.applyNow();
      return { service: { ...view, underWay: underWay() }, cut };
    },
  };

  /** The runtime's own answer beside the store's and the service's: its end of the timing log (Runtime → Timings), read whole in one ask. */
  const roadOps: Readonly<Record<string, (args: JsonObject) => Promise<JsonValue>>> = {
    "timings.read": async () => timings.view() as unknown as JsonValue,
  };

  /** Runtime → Chat data: the runtime's copy of chat and lore as it stands, with the memory limit the runtime runs under beside the copy's own cap. */
  const copyOps: Readonly<Record<string, (args: JsonObject) => Promise<JsonValue>>> = {
    "copy.state": async () => {
      const { memory, memoryNote } = update.get();
      return chatData.state({ limit: memory, note: memoryNote }) as unknown as JsonValue;
    },
  };

  /** A page op's answer, whichever road its ask came by: the runtime's connections and sign-ins (the model layer's to keep, book.ts), its own ops, else the core's. */
  async function dispatch(op: string, args: JsonObject): Promise<JsonValue> {
    const own = Object.hasOwn(storeOps, op) ? storeOps[op] : Object.hasOwn(serviceOps, op) ? serviceOps[op] : Object.hasOwn(roadOps, op) ? roadOps[op] : Object.hasOwn(copyOps, op) ? copyOps[op] : undefined;
    return isBookOp(op) ? bookOp(layer, op, args, { id: config.relay, name: config.name }) : own !== undefined ? own(args) : work.ask(op, args);
  }

  /** Something a page asked of the core (the `ask` push): done once, whichever road it also came by, and answered by its name, whichever way it went. */
  async function answer(push: AskPush): Promise<void> {
    const { value, refusal, took } = await desk.run(push.ask, push.op, push.args, "link");
    await asked({ link, now: deps.now, tuning }, "ask.answer", { ask: push.ask, value, refusal, took }).catch((error: unknown) => deps.log(`couldn't answer LumiAH's ${push.op}: ${error instanceof Error ? error.message : String(error)}`));
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
    update: (push: UpdatePush) => {
      void update.offer(push).then((outcome) => {
        if ("taken" in outcome && outcome.taken === "current") deps.log(`build ${push.build} offered: this runtime runs it already`);
      });
    },
    turns: () => [...running.ids(), ...work.ids()],
    // Whether this runtime keeps its own copy of the extension's storage is the extension's to say, on each hello and when it changes.
    mirrorAsk: () => working.ask(),
    mirror: (word) => working.heard(word),
    // What the runtime's copy of chat and lore may read, on each hello; Lumiverse's events and what else the copy is told, numbered; and the count the extension says at each ping, which shows one lost.
    copied: (said) => chatData.copied(said),
    news: (push) => chatData.news(push),
    told: (count) => chatData.told(count),
  });

  return {
    fetch: relay.fetch,
    tick() {
      link.tick();
      streams.tick();
      relay.tick();
      chatData.tick();
      void update.tick().catch((error: unknown) => deps.log(`the update's tick failed: ${error instanceof Error ? error.message : String(error)}`));
    },
    shutdown() {
      running.shutdown();
      work.shutdown();
      relay.shutdown();
      streams.shutdown();
    },
    async close() {
      // What the runtime saved goes to the extension's storage while the link is up, and the mirror is let go so the next runtime may keep it at once; what doesn't go in time waits on the runtime's disk, and goes at its next start.
      if (link.up) {
        await working.settle().catch((error: unknown) => deps.log(`stopping before the extension's storage had everything: ${error instanceof Error ? error.message : String(error)}`));
        await working.release().catch((error: unknown) => deps.log(`couldn't let the extension's storage go: ${error instanceof Error ? error.message : String(error)}`));
      }
      await working.close();
      // Open sign-ins end, and what the layer was writing of the runtime's connections is written.
      await layer.close();
      link.close();
      chatData.close();
    },
    link,
    relay,
    turns: running,
    work,
    store: working,
    update,
    asks: desk,
    timings,
  };
}
