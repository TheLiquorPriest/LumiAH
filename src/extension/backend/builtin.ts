// The core where it runs built in (DESIGN §25): inside this extension, one harness for each user,
// over a host whose every port is this backend's own module called directly. No link, no runtime,
// no loopback connection: a model call goes to Lumiverse's generation API on the user's connection,
// a blob to their storage, a trace event straight into the live buffer.
//
// What isn't a reply runs here too, as it does in a runtime (`src/link/work.ts`): the jobs the core
// queues, a side session's turns, the user's words to a run, and whatever a page asks of the core.
//
// A user who also has a runtime has two cores over one store. Each chat's documents are written by
// the place the chat runs in, and what both write (the list of every job, the spend, the user's own
// files) is read again before each write. One document says which jobs a place has under way, so
// each place keeps its own: a restart of one must not take the other's jobs for cut off.

import type { HarnessExtension } from "../../core/extension";
import { createHarness, type Harness, type HarnessOptions } from "../../core/harness";
import { DOC } from "../../core/paths";
import type { ActivatedLore, BookPort, HarnessHost, JobView, JsonObject, JsonValue, PreparedTurn, TraceDelta, TraceRecord, TurnRequest, TurnResult } from "../../core/ports";
import type { RecallPorts } from "../../core/recall/ports";
import { refusalOf, Work, type WorkHarness } from "../../link/work";
import { type Approvals, holdCall } from "./approvals";
import { refused } from "./asks";
import type { Chats } from "./chat";
import type { Connections } from "./connections";
import { wordsOf } from "./errors";
import { type BackendExtension, harnessExtension, type RemoteTools } from "./extension";
import type { JobsBoard } from "./jobs";
import { BUILTIN, type LiveBuffer } from "./live";
import type { Models } from "./models";
import type { Lore, Presets, Storage } from "./reads";
import type { SettingsStore } from "./settings";
import type { BackendHost } from "./spindle";
import type { ChatSwitch } from "./switch";

/** The jobs that wait or run here, built in: the core's own document of them names a runtime's. */
const RUNNING_HERE = "jobs/running.builtin.json";

/** What this place reaches of the core's harness: a turn's two halves, what the work runner runs, and the forgetting of a chat (absent on a harness a test scripts). */
export type BuiltinHarness = WorkHarness & Pick<Harness, "prepare" | "complete" | "abandon"> & Partial<Pick<Harness, "chats">>;

/** What makes a user's harness over their host: the core's own `createHarness`, unless a test scripts one. */
export type HarnessMaker = (host: HarnessHost, options: HarnessOptions) => BuiltinHarness;

export interface BuiltinDeps {
  settings: SettingsStore;
  storage: Storage;
  chats: Chats;
  /** A chat's own choice of what counts as its story, and whether Lumiverse's Sovereign Hand is on for it, as the core reads them with the chat (§24.4). */
  chatSwitch: Pick<ChatSwitch, "info">;
  lore: Lore;
  presets: Presets;
  connections: Connections;
  models: Models;
  tools: RemoteTools;
  approvals: Approvals;
  live: LiveBuffer;
  jobs: JobsBoard;
  /** The entries Lumiverse activated for a generation, each with its text as stored (turns.ts). */
  activated(userId: string, chatId: string, generationId: string): Promise<ActivatedLore[]>;
  /** What the lore and history tools read beyond the lore and the chat (§24), and a chat's book (§23); absent: the core works from the lore and the chat alone. */
  recall?: { ports(userId: string): RecallPorts; book(userId: string): BookPort };
  /** What the extension LumiAH is built into supplies to the core; absent for LumiAH on its own. */
  extension: BackendExtension | undefined;
  /** The key the core's settings sit under. */
  coreKey: string;
  /** The extension as its pages show it. */
  name: string;
  now(): number;
  /** Runs `fn` once after `ms`; what it returns cancels that. */
  later(ms: number, fn: () => void): () => void;
  /** 128 random bits as hex: a side session turn's id. */
  id(): string;
  /** What makes a harness; absent: the core's own. */
  harness?: HarnessMaker;
}

/** A user's core: its harness, what runs its jobs and side sessions, and the bookkeeping the host needs. */
interface UserCore {
  harness: BuiltinHarness;
  work: Work;
  /**
   * The chat whose turn last named each preset. A preset's blocks are switched per chat, and the
   * core asks for them by the preset alone: here its turns run in one worker with nothing that says
   * which run asks, so the chat is the one the preset was last used in.
   */
  presetChat: Map<string, string>;
  /** The trace events still to reach the live buffer, and the sending of them: one batch at a time, so they arrive in the order the core traced them. */
  traced: TraceRecord[];
  sending: Promise<void>;
}

export class Builtin {
  private readonly users = new Map<string, UserCore>();

  constructor(
    private readonly host: Pick<BackendHost, "log">,
    private readonly deps: BuiltinDeps,
  ) {}

  /**
   * The user's core, made when it is first needed. Once made, the jobs a restart of the extension
   * cut off are marked interrupted and those that still waited are run, and the user's hold on
   * jobs is read.
   */
  private of(userId: string): UserCore {
    const held = this.users.get(userId);
    if (held !== undefined) return held;
    const { deps } = this;
    const extension: HarnessExtension | undefined = deps.extension === undefined ? undefined : harnessExtension(deps.extension, userId);
    // The host hands the core's jobs to the work runner, which needs the harness the host is for.
    const made: { core: UserCore | null } = { core: null };
    const harness = (deps.harness ?? createHarness)(this.hostFor(userId, made), {
      settings: async () => {
        const snapshot = await deps.settings.snapshot(userId);
        return { values: snapshot.values[deps.coreKey], texts: snapshot.texts, ...(snapshot.definitions !== undefined ? { definitions: snapshot.definitions } : {}) };
      },
      ...(extension !== undefined ? { extension } : {}),
      userId,
      // A claim that says its chat plays only in a runtime is refused here, by the core.
      place: "builtin",
    });
    const core: UserCore = {
      harness,
      work: new Work(harness, {
        log: (text) => this.host.log("info", `[LumiAH] ${text}`),
        id: deps.id,
        within: (_run, fn) => fn(),
        traced: () => core.sending,
        tell: (job) => void deps.jobs.took(userId, job, BUILTIN).catch((error: unknown) => this.host.log("warn", `[LumiAH] the pages weren't told of job ${job.id.slice(0, 8)} (${wordsOf(error)})`)),
        words: {
          notYet: `This build of ${deps.name} can't do that.`,
          noSuch: (op) => `There is nothing ${deps.name} does by the name ${op}: reload the page.`,
          ending: `${deps.name} is restarting.`,
        },
      }),
      presetChat: new Map(),
      traced: [],
      sending: Promise.resolve(),
    };
    made.core = core;
    this.users.set(userId, core);
    void core.work.recover();
    this.held(userId);
    return core;
  }

  /** The core's host for one user: each port is this backend's own module, called with that user. */
  private hostFor(userId: string, made: { core: UserCore | null }): HarnessHost {
    const { deps } = this;
    const recall = deps.recall;
    // Each place keeps its own list of the jobs it has under way.
    const doc = (path: string): string => (path === DOC.runningJobs ? RUNNING_HERE : path);
    const reasonOf = (signal: AbortSignal): Error => (signal.reason instanceof Error ? signal.reason : new Error("The wait was cancelled."));
    return {
      models: { call: (request, signal, onDelta) => deps.models.direct(userId, request, signal, onDelta) },
      connections: {
        list: () => deps.connections.list(userId),
        get: (connectionId) => deps.connections.profile(userId, connectionId),
      },
      blobs: {
        put: (hash, text) => deps.storage.putBlob(userId, hash, text),
        get: (hash) => deps.storage.blob(userId, hash),
        list: (cursor) => deps.storage.blobs(userId, cursor ?? null),
        remove: (hashes) => deps.storage.removeBlobs(userId, [...hashes]),
      },
      store: {
        read: (path) => deps.storage.doc(userId, doc(path)),
        write: (path, value) => deps.storage.putDoc(userId, doc(path), value),
        remove: (path) => deps.storage.removeDoc(userId, doc(path)),
        list: (prefix) => deps.storage.docs(userId, prefix),
      },
      chat: {
        path: (chatId) => deps.chats.path(userId, chatId),
        messages: (chatId, from, to) => deps.chats.messages(userId, chatId, from, to),
        anchor: (chatId, messageId, swipeId, record) => deps.chats.anchor(userId, chatId, messageId, swipeId, record),
        info: async (chatId) => {
          const info = await deps.chatSwitch.info(userId, chatId);
          if (info === null) return null;
          // The connection the chat generates on is its agents' where they name none; a loopback is none an agent may call.
          const on = await deps.connections.ofChat(userId, await deps.chats.own(userId, chatId));
          return { ...info, connectionId: on !== null && !on.loopback ? on.id : null };
        },
        anchors: (cursor) => deps.chats.anchors(userId, cursor ?? null),
      },
      lore: {
        books: async (chatId) => deps.lore.books(userId, await deps.chats.own(userId, chatId)),
        entries: (bookId) => deps.lore.entries(userId, bookId),
        activated: (chatId, generationId) => deps.activated(userId, chatId, generationId),
      },
      preset: { blocks: (presetId) => deps.presets.blocks(userId, presetId, made.core?.presetChat.get(presetId) ?? null) },
      tools: {
        list: (chatId) => deps.tools.list(userId, chatId),
        call: (call, signal) => deps.tools.call(userId, call, signal),
      },
      approvals: { ask: (ask, signal) => holdCall(deps, userId, ask, signal) },
      jobs: {
        queued: (job: JobView) => made.core?.work.queued(job),
        changed: (job: JobView) => made.core?.work.changed(job),
      },
      ...(recall !== undefined ? { book: recall.book(userId), recall: recall.ports(userId) } : {}),
      trace: {
        event: (record) => this.traced(userId, made.core, record),
        delta: (delta: TraceDelta) => deps.live.deltas(userId, BUILTIN, [delta]),
      },
      clock: {
        now: deps.now,
        sleep: (ms, signal) => {
          if (signal.aborted) return Promise.reject(reasonOf(signal));
          const { promise, resolve, reject } = Promise.withResolvers<void>();
          const ended = (): void => {
            unwait();
            reject(reasonOf(signal));
          };
          const unwait = deps.later(ms, () => {
            signal.removeEventListener("abort", ended);
            resolve();
          });
          signal.addEventListener("abort", ended, { once: true });
          return promise;
        },
      },
      // The core's finer notes have no level in Lumiverse's log.
      log: (level, message) => {
        if (level !== "debug") this.host.log(level, message);
      },
    };
  }

  /** A trace event of a run here: it goes to the live buffer after those traced before it. */
  private traced(userId: string, core: UserCore | null, record: TraceRecord): void {
    if (core === null) return;
    core.traced.push(record);
    if (core.traced.length > 1) return;
    core.sending = core.sending.then(async () => {
      while (core.traced.length > 0) {
        const batch = core.traced.splice(0);
        // The buffer takes each in its place and leaves what it can't follow: nothing here is asked again.
        await this.deps.live.push(userId, BUILTIN, batch).catch((error: unknown) => this.host.log("warn", `[LumiAH] a run's steps didn't reach the live view (${wordsOf(error)})`));
      }
    });
  }

  /** The user's core is made now, if it wasn't: what a restart of the extension cut off is found without waiting for their next reply. */
  wake(userId: string): void {
    this.of(userId);
  }

  /** The user's hold on all jobs, as their settings have it now: told to their core. */
  held(userId: string): void {
    const core = this.users.get(userId);
    if (core === undefined) return;
    void this.deps.settings
      .transport(userId)
      .then((transport) => core.work.setHold(transport.jobs.paused))
      .catch((error: unknown) => this.host.log("warn", `[LumiAH] whether jobs are held couldn't be read (${wordsOf(error)})`));
  }

  /** One op of the core (`asks.ts`): its own answer; rejects with what refused it, as a page is told it. */
  async ask(userId: string, op: string, args: JsonObject): Promise<JsonValue> {
    try {
      return await this.of(userId).work.ask(op, args);
    } catch (error) {
      const refusal = refusalOf(error);
      if (refusal.code === "internal") this.host.log("error", `[LumiAH] ${op} failed: ${refusal.message}`);
      throw refused(refusal, this.deps.name);
    }
  }

  // ---------------------------------------------------------------- a reply's turn, in its two halves

  /** The first half of a turn (the core's `prepare`): never rejects. */
  prepare(userId: string, turn: TurnRequest, replyBy: number | null, signal: AbortSignal): Promise<PreparedTurn> {
    const core = this.of(userId);
    if (turn.presetId !== null) core.presetChat.set(turn.presetId, turn.chatId);
    return core.harness.prepare(turn, { replyBy }, signal);
  }

  /** The second half (the core's `complete`): the reply as Lumiverse's generation wrote it. */
  complete(userId: string, input: { generationId: string; reply: string; finish: string }): Promise<TurnResult> {
    return this.of(userId).harness.complete(input);
  }

  /** Gives a turn up between its halves (the core's `abandon`): no reply is coming. A turn that isn't waiting is left. */
  async abandon(userId: string, generationId: string, reason: string): Promise<void> {
    await this.of(userId)
      .harness.abandon({ generationId, reason })
      .catch(() => undefined);
  }

  /** A reply turn of a chat is over, however it ended: the jobs that waited for the reply may start. */
  replied(userId: string, chatId: string): void {
    this.users.get(userId)?.work.replied(chatId);
  }

  /**
   * Lumiverse deleted a chat: the core forgets what it kept of it (its files under `learned/`, its
   * jobs with their reports, its side sessions, its approvals, its search vectors). The store is
   * the user's own, shared by both places, so what a runtime wrote of the chat goes too. Never
   * rejects: the core refuses while a reply is still worked on in the chat, and whatever stays is
   * said in the log.
   */
  async forget(userId: string, chatId: string): Promise<void> {
    try {
      await this.of(userId).harness.chats?.forget({ chatId });
    } catch (error) {
      this.host.log("warn", `[LumiAH] what was kept of the deleted chat ${chatId} couldn't be forgotten (${wordsOf(error)})`);
    }
  }

  /** Stops a job's run or a side session's turn that runs here; false when it isn't one under way here. */
  stop(userId: string, run: string, why: string): boolean {
    return this.users.get(userId)?.work.stop(run, why) ?? false;
  }

  /** The jobs' runs and side sessions' turns under way here, by their ids. */
  runs(userId: string): string[] {
    return this.users.get(userId)?.work.ids() ?? [];
  }

  /** Resolves once every trace event the user's runs here have traced so far has reached the live buffer. */
  async drained(userId: string): Promise<void> {
    await this.users.get(userId)?.sending;
  }
}
