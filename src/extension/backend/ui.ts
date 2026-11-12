// The pages' side of the backend (DESIGN §8; the contract is src/shared/ui.ts): every request a page
// sends is answered here with exactly one result or one error, and the state every page holds is
// pushed, part by part, whenever it changes. The state is the user's, the same for each of their
// pages; a page that can't follow the pushes says hello again and gets it whole.

import type { Harness as Core } from "../../core/harness";
import type { JobView, JsonValue } from "../../core/ports";
import { pathTurns } from "../../core/sessions";
import { type Settings, settingsOf } from "../../core/settings";
import { LINK } from "../../link/contract";
import { isRecord, toJsonObject } from "../../link/json";
import { TRANSPORT_KEY } from "../../link/settings";
import type { Timings } from "../../link/timings";
import { timingsViewOf } from "../../link/timings";
import type { BackendToFrontend, ChatDataView, ChatView, KeptApproval, KeyView, PermissionNeed, RuntimeView, SetupView, StoreStateView, TimingsPage, UiErrorCode, UiProblem, UiRequest, UiRequestType, UiRequests, UiState, UiStatePart } from "../../shared/ui";
import { UI_VERSION, chatAnswered, uiRequestOf } from "../../shared/ui";
import type { Asks, Where } from "./asks";
import type { Definitions } from "./defs";
import { type JobsBoard, jobOver } from "./jobs";
import type { Chats } from "./chat";
import type { CopyFeed } from "./copy";
import type { Connections } from "./connections";
import { KeyedQueue } from "./docs";
import { LinkRefused, UiRefused, wordsOf } from "./errors";
import type { Keys } from "./keys";
import type { LiveBuffer } from "./live";
import type { Approvals } from "./approvals";
import type { Notices } from "./notices";
import type { ProxyRoad } from "./proxy";
import type { RegistryStore } from "./registry";
import type { Relays } from "./relays";
import type { SessionsPage } from "./sessions";
import type { SettingsStore } from "./settings";
import { SettingsRefused } from "./settings";
import type { BackendHost } from "./spindle";
import { StoryJobs } from "./story";
import type { StreamRegistry } from "./streams";
import type { ChatSwitch } from "./switch";
import type { Turns } from "./turns";
import { agentNames, areaView, type ChatCharacter, changesView, chronicleView, citedView, embeddingView, fileChanged, fileRead, guidanceOf, guidanceView, jobOf, jobsOf, jobsPage, keptOf, loreEntry, loreSearch, loreView, pageOf, type SettingsNow, sideSession, sideStartedOf, sidesOf, sideTurns, sideTurnsOf, spendOf, spendView, storyOf, storyView, turnStarted, type UnkeptTurn, upkeepOf, upkeepView, versionsOf, versionsView } from "./views";

/** Where a request about a runtime's connections and sign-ins goes: the runtime the page names, else the user's runtime last heard from. */
function runtimeOf(r: { relay?: string }): Where {
  return r.relay !== undefined ? { relay: r.relay } : {};
}

export interface UiDeps {
  relays: Relays;
  registry: RegistryStore;
  settings: SettingsStore;
  streams: StreamRegistry;
  connections: Connections;
  chats: Chats;
  live: LiveBuffer;
  approvals: Approvals;
  notices: Notices;
  asks: Asks;
  /** The asks' road through Lumiverse's proxy, as the Runtime page shows it. */
  road: Pick<ProxyRoad, "view">;
  /** This end of the timing log (Runtime → Timings). */
  timings: Pick<Timings, "view">;
  jobs: JobsBoard;
  defs: Definitions;
  /** The key the core's settings sit under. */
  coreKey: string;
  switch: ChatSwitch;
  turns: Turns;
  sessions: SessionsPage;
  /** The runtime's copy of chat and lore: the database reader's switch, which is the operator's alone. */
  copy: Pick<CopyFeed, "databaseView" | "setDatabase">;
  keys: Keys;
  /** What keeps LumiAH from working that no permission and no runtime's row says, each in plain words. */
  issues(): string[];
  /** The permissions LumiAH lacks (§25), each with what it can't do without it and what to do; none when it has all it asks for. */
  permissions(): PermissionNeed[];
  now(): number;
}

/** A link refusal as a page's error: the codes both contracts share stay; a conflict is something that can't be done now. */
const LINK_CODES: Readonly<Record<string, UiErrorCode>> = { bad_request: "bad_request", forbidden: "forbidden", not_found: "not_found", conflict: "unavailable", unavailable: "unavailable", too_large: "bad_request" };

/** The parts of the core's harness a page's request reaches (the place that holds the core lists their methods: `PAGE_OPS`), and what a method of one takes: its one plain object. */
type CoreGroup = "workspace" | "guidance" | "definitions" | "session" | "jobs" | "sides" | "spend" | "recall" | "approvals";
type CoreInput<G extends CoreGroup, M extends keyof Core[G]> = Core[G][M] extends (input: infer I) => unknown ? I : never;

/**
 * A turn of a side session the user started here that the core hasn't kept yet. The core keeps a
 * turn once it has ended, so until then what was said in it is known here alone. `before`: how many
 * turns the session had kept when this one was said (one more says this one is kept: a session
 * takes one turn at a time).
 */
interface Said extends UnkeptTurn {
  before: number;
}

export class Ui {
  /** The users with a page that said hello, each with the revision of the state their pages hold and the parts that changed since. */
  private readonly users = new Map<string, { rev: number; dirty: Set<UiStatePart> }>();
  /** One thing at a time per user: a hello's answer and the pushes after it leave in the order the state changed. */
  private readonly queue = new KeyedQueue();
  /** The turn each side session waits on the core to keep, by user and session. In memory alone: after the extension starts again, a turn still under way shows once the core has kept it. */
  private readonly said = new Map<string, Map<string, Said>>();
  /** Which job is the learning of each chat's story: the core marks none, so it is remembered here (story.ts). */
  private readonly story: StoryJobs;

  constructor(
    private readonly host: Pick<BackendHost, "frontend" | "connections" | "log" | "storage" | "closeDrawer">,
    private readonly deps: UiDeps,
  ) {
    this.story = new StoryJobs(host);
  }

  // ---------------------------------------------------------------- the state

  private async key(userId: string): Promise<KeyView> {
    const key = (await this.deps.registry.read(userId)).key;
    return { set: key !== null, print: key?.print ?? null, at: key?.at ?? null };
  }

  /** First-time setup (§25): the permissions LumiAH can answer no chat without, a chat switched on, and a reply answered. The runtime's own steps are the Runtime page's. */
  private async setup(userId: string): Promise<SetupView> {
    const d = this.deps;
    const registry = await d.registry.read(userId);
    const chats = await d.switch.list(userId, d.live.chatsOf(userId));
    return {
      steps: [
        { id: "permissions", done: !d.permissions().some((need) => need.needed) },
        { id: "chat", done: chats.some((chat) => chat.on || chatAnswered(chat)) },
        { id: "reply", done: registry.replied },
      ],
    };
  }

  /** The runtime as the Runtime page shows it: each runtime's row, and the road the pages' requests take to it. */
  private async runtime(userId: string): Promise<RuntimeView> {
    const view = await this.deps.relays.view(userId, this.deps.issues());
    return { ...view, road: await this.deps.road.view(userId, view.relays.map((r) => ({ id: r.id, linked: r.link === "linked" }))) };
  }

  /** Runtime → Timings: this end's log, and each linked runtime's own, asked of it once (whichever road the ask takes, it goes in this end's log too). */
  private async timings(userId: string): Promise<TimingsPage> {
    const linked = await this.deps.relays.linked(userId);
    const runtimes = await Promise.all(
      linked.map(async (r) => {
        try {
          const timings = timingsViewOf(await this.deps.asks.ask(userId, "timings.read", {}, { relay: r.id }));
          return { id: r.id, name: r.name, timings, problem: timings === null ? "Its timings couldn't be read: update the runtime and the extension to the same build." : null };
        } catch (error) {
          return { id: r.id, name: r.name, timings: null, problem: wordsOf(error) };
        }
      }),
    );
    return { extension: this.deps.timings.view(), runtimes };
  }

  private async part<K extends UiStatePart>(userId: string, part: K): Promise<UiState[K]>;
  private async part(userId: string, part: UiStatePart): Promise<UiState[UiStatePart]> {
    const d = this.deps;
    switch (part) {
      case "runtime":
        return this.runtime(userId);
      case "setup":
        return this.setup(userId);
      case "key":
        return this.key(userId);
      case "chats":
        return d.switch.list(userId, d.live.chatsOf(userId));
      case "running":
        return d.live.runningOf(userId);
      case "connections":
        return d.connections.views(userId);
      case "settings":
        return d.settings.view(userId);
      case "texts":
        return d.settings.texts(userId);
      case "approvals":
        return d.approvals.views(userId);
      case "notices":
        return d.notices.list(userId);
      case "jobs":
        return this.jobsState(userId);
      case "defs":
        return d.defs.rev(userId);
      case "permissions":
        return d.permissions();
    }
  }

  /** The jobs part of the state: the jobs not yet over, and the user's two switches over all jobs, which are settings. */
  private async jobsState(userId: string): Promise<UiState["jobs"]> {
    const d = this.deps;
    const core = (await d.settings.values(userId))[d.coreKey];
    const off = isRecord(core) && isRecord(core.jobs) && core.jobs.enabled === false;
    return d.jobs.state(userId, off, (await d.settings.transport(userId)).jobs.paused);
  }

  /** A chat a request names is the user's own, or it names none. */
  private async chat(userId: string, chatId: string | null): Promise<string | null> {
    if (chatId !== null) await this.deps.chats.own(userId, chatId);
    return chatId;
  }

  /**
   * A request the core serves: `harness.<group>.<method>` is asked with the input the core's method
   * takes, of the runtime the request belongs to (`where`, asks.ts: what is about a chat, a job or a
   * side session is asked where that runs; what is about none of them, of the user's runtime), and
   * the core's own answer comes back, still to be read (views.ts).
   */
  private ask<G extends CoreGroup, M extends keyof Core[G] & string>(userId: string, group: G, method: M, input: CoreInput<G, M>, where: Where = {}): Promise<JsonValue> {
    return this.deps.asks.ask(userId, `${group}.${method}`, toJsonObject(input), where);
  }

  /** A request about a chat's lore, its chronicle or the learning of its story (`harness.recall`, DESIGN §24, §22): asked where the chat's turns run, once the chat is known to be the user's. The input is the page's own body, and the answer a shape of the core's own. */
  private async recall<M extends keyof Core["recall"] & string>(userId: string, method: M, input: CoreInput<"recall", M> & { chatId: string }): Promise<JsonValue> {
    await this.deps.chats.own(userId, input.chatId);
    return this.ask(userId, "recall", method, input, { chat: input.chatId });
  }

  /**
   * The job remembered as the learning of a chat's story, as the core has it now; null when none
   * was started. One the core keeps no more is forgotten here too, so the page offers to start one.
   */
  private async storyJob(userId: string, chatId: string): Promise<JobView | null> {
    const id = await this.story.of(userId, chatId);
    if (id === null) return null;
    try {
      return jobOf(await this.deps.asks.ask(userId, "jobs.read", { id }, { job: id }));
    } catch (error) {
      if (!(error instanceof UiRefused && error.code === "not_found")) throw error;
    }
    await this.remembered(this.story.gone(userId, chatId, id));
    return null;
  }

  /** Waits for what is remembered of a story's job to be kept. Where it can't be kept the job itself stands all the same, so the request is answered with it and the log says what was lost. */
  private async remembered(kept: Promise<void>): Promise<void> {
    await kept.catch((error: unknown) => this.host.log("warn", `[LumiAH] which job learns a chat's story couldn't be kept (${wordsOf(error)})`));
  }

  /** The core's own settings as the user has them. */
  private async coreSettings(userId: string): Promise<Settings> {
    return settingsOf((await this.deps.settings.values(userId))[this.deps.coreKey]);
  }

  /** The user's settings as a view names one of the core's by: its title on the Settings page, and what it holds. */
  private async settingsNow(userId: string): Promise<SettingsNow> {
    const d = this.deps;
    return { coreKey: d.coreKey, schema: d.settings.schema(), values: await d.settings.values(userId) };
  }

  /** The character a chat of the user's is with, where it is with one: the middle level of its guidance is that character's unless an extension names its own (§12). */
  private async character(userId: string, chatId: string | null): Promise<ChatCharacter | null> {
    const info = chatId === null ? null : await this.deps.chats.info(userId, chatId);
    return info === null || info.characterId === null ? null : { id: info.characterId, name: info.characterName };
  }

  /** The agent definitions' names by id, as the core has them for the user now: what names an agent where the core gives its definition's id alone. */
  private async agentNames(userId: string): Promise<Map<string, string>> {
    return agentNames(await this.ask(userId, "definitions", "get", {}));
  }

  /** The names of chats by id, as Lumiverse has them now: null for one that is no longer the user's. */
  private async chatNames(userId: string, chatIds: readonly string[]): Promise<Map<string, string | null>> {
    const named = await Promise.all(
      chatIds.map(async (chatId): Promise<[string, string | null]> => {
        try {
          return [chatId, (await this.deps.chats.own(userId, chatId)).name];
        } catch (error) {
          if (error instanceof LinkRefused && error.code === "not_found") return [chatId, null];
          throw error;
        }
      }),
    );
    return new Map(named);
  }

  /** The tools approved "for this chat" as the core lists them (views.ts `keptOf`), each with its chat's name as Lumiverse has it now. One of a chat that is no longer the user's is left out: there is nothing left to take back in it. */
  private async kept(userId: string, raw: JsonValue): Promise<KeptApproval[]> {
    const rows = keptOf(raw);
    const names = await this.chatNames(userId, [...new Set(rows.map((row) => row.chatId))]);
    return rows.flatMap((row): KeptApproval[] => {
      const name = names.get(row.chatId);
      // One kept before its time was shows as the oldest.
      return name === undefined || name === null ? [] : [{ chatId: row.chatId, chat: name === "" ? null : name, tool: row.tool, at: row.at ?? 0 }];
    });
  }

  /** The turn of a side session the core hasn't kept yet; null when there is none, or the session has kept a turn since this one was said. */
  private unkept(userId: string, side: { id: string; turns: number }): Said | null {
    const mine = this.said.get(userId);
    const held = mine?.get(side.id);
    if (mine === undefined || held === undefined) return null;
    if (side.turns <= held.before) return held;
    mine.delete(side.id);
    return null;
  }

  /**
   * How a turn the core hasn't kept stands, by its run in the live buffer: running while its run
   * is under way, and in the moment between its run's end and the core's keeping it; lost when its
   * runtime went away with it. A turn whose run isn't followed here (its first event is still on its
   * way, it never came, or the buffer has let the run go) is running for as long as Settings give a
   * turn that says nothing before it counts as lost, and lost after.
   */
  private async standing(userId: string, session: string, held: Said): Promise<"running" | "lost"> {
    const d = this.deps;
    if (d.live.running(userId, session, held.turn) !== null) return "running";
    if (d.live.streamOf(userId, held.turn) === null) return d.now() - held.at <= (await d.settings.transport(userId)).live.lostMs ? "running" : "lost";
    const view = (await d.live.open(userId, session, undefined)).live;
    return view !== null && view.turn === held.turn && view.ended?.state === "lost" ? "lost" : "running";
  }

  private async state(userId: string, rev: number): Promise<UiState> {
    const [runtime, setup, key, chats, connections, settings, texts, notices, jobs, defs] = await Promise.all([this.part(userId, "runtime"), this.part(userId, "setup"), this.part(userId, "key"), this.part(userId, "chats"), this.part(userId, "connections"), this.part(userId, "settings"), this.part(userId, "texts"), this.part(userId, "notices"), this.part(userId, "jobs"), this.part(userId, "defs")]);
    return { rev, runtime, setup, key, chats, running: this.deps.live.runningOf(userId), connections, settings, texts, approvals: this.deps.approvals.views(userId), jobs, notices, defs, permissions: this.deps.permissions() };
  }

  /** Parts of a user's state changed: their pages are told, once whatever is being sent to them has gone. */
  touch(userId: string, ...parts: UiStatePart[]): void {
    const user = this.users.get(userId);
    if (user === undefined) return;
    const idle = user.dirty.size === 0;
    for (const part of parts) user.dirty.add(part);
    if (idle && user.dirty.size > 0) void this.queue.run(userId, () => this.flush(userId));
  }

  /** Parts of every user's state changed (a permission was granted or taken away). */
  touchAll(...parts: UiStatePart[]): void {
    for (const userId of this.users.keys()) this.touch(userId, ...parts);
  }

  private async flush(userId: string): Promise<void> {
    const user = this.users.get(userId);
    if (user === undefined || user.dirty.size === 0) return;
    const parts = [...user.dirty];
    user.dirty.clear();
    const patch: Partial<Omit<UiState, "rev">> = {};
    for (const part of parts) {
      try {
        Object.assign(patch, { [part]: await this.part(userId, part) });
      } catch (error) {
        this.host.log("warn", `[LumiAH] the pages' ${part} couldn't be read (${wordsOf(error)})`);
      }
    }
    if (Object.keys(patch).length === 0) return;
    user.rev++;
    this.send({ lah: UI_VERSION, type: "lah.state", rev: user.rev, patch }, userId, undefined);
  }

  /** Resolves once every answer and push under way has gone (tests). */
  async settle(): Promise<void> {
    await this.story.settle();
    for (const userId of this.users.keys()) await this.queue.run(userId, async () => undefined);
  }

  // ---------------------------------------------------------------- requests

  private send(message: BackendToFrontend, userId: string, session: string | undefined): void {
    this.host.frontend.send(message, userId, session);
  }

  private fail(reqId: string, userId: string, session: string | undefined, code: UiErrorCode, message: string, problems?: UiProblem[]): void {
    this.send({ lah: UI_VERSION, type: "lah.error", reqId, code, message, ...(problems !== undefined ? { problems } : {}) }, userId, session);
  }

  /** One message from a page. True when it was one of the contract's (answered, or refused as malformed). */
  async message(payload: unknown, userId: string, session: string | undefined): Promise<boolean> {
    const read = uiRequestOf(payload);
    if (read === null) return false;
    if ("malformed" in read) {
      if (read.reqId !== null) this.fail(read.reqId, userId, session, "bad_request", read.malformed);
      return true;
    }
    const { request } = read;
    try {
      if (request.type === "lah.hello") {
        // The page read which connection is selected in Lumiverse. Where Lumiverse doesn't say that itself, a chat with no connection of its own goes by the page's word: what changes with it is checked again, and the user's other pages hear.
        if (request.active !== undefined && this.deps.connections.pageSaid(userId, request.active)) {
          this.deps.turns.unsure(userId);
          this.touch(userId, "chats", "setup");
        }
        // The state is read and answered inside the user's queue, so no push leaves between the two: the page's next push is the revision after the one it was given.
        await this.queue.run(userId, async () => {
          let user = this.users.get(userId);
          if (user === undefined) {
            // A revision no page can hold from before this start, so a page that outlived a restart says hello again rather than apply a push to a state it no longer follows.
            user = { rev: this.deps.now(), dirty: new Set() };
            this.users.set(userId, user);
          }
          const body = await this.state(userId, user.rev);
          this.send({ lah: UI_VERSION, type: "lah.result", reqId: request.reqId, request: "lah.hello", body }, userId, session);
        });
        return true;
      }
      const body = await this.serve(request, userId, session);
      this.send({ lah: UI_VERSION, type: "lah.result", reqId: request.reqId, request: request.type, body } as BackendToFrontend, userId, session);
    } catch (error) {
      if (error instanceof UiRefused) this.fail(request.reqId, userId, session, error.code, error.message, error.problems);
      else if (error instanceof SettingsRefused) this.fail(request.reqId, userId, session, "invalid", error.message, error.problems);
      else if (error instanceof LinkRefused) this.fail(request.reqId, userId, session, LINK_CODES[error.code] ?? "internal", error.message);
      else {
        this.host.log("error", `[LumiAH] ${request.type} failed: ${wordsOf(error)}`);
        this.fail(request.reqId, userId, session, "internal", `LumiAH couldn't do that (${wordsOf(error)}).`);
      }
    }
    return true;
  }

  private async serve(r: Exclude<UiRequest, { type: "lah.hello" }>, userId: string, session: string | undefined): Promise<UiRequests[Exclude<UiRequestType, "lah.hello">]["result"]> {
    const d = this.deps;
    switch (r.type) {
      case "lah.chat.get":
        return { chat: await d.switch.view(userId, r.chatId) };
      case "lah.chat.set": {
        const chat = await d.switch.set(userId, r.chatId, r.on);
        d.turns.unsure(userId);
        this.touch(userId, "chats", "setup");
        return { chat };
      }
      case "lah.chat.takeover": {
        // The page asked the user first. The chat is taken from the backend whose mark it bears, whether or not that extension is still installed, and switched on here.
        const chat = await d.switch.set(userId, r.chatId, true, true);
        d.turns.unsure(userId);
        this.touch(userId, "chats", "setup");
        return { chat };
      }
      case "lah.chat.story.get":
        return { story: await d.switch.story(userId, r.chatId) };
      // The core reads the chat's choice with the chat at each run's start: nothing to push.
      case "lah.chat.story.set":
        return { story: await d.switch.setStory(userId, r.chatId, r.story) };
      // Asked of the extension each time, as each run asks it: nothing of it is kept here.
      case "lah.chat.lead.get":
        return { lead: await d.switch.lead(userId, r.chatId) };
      case "lah.live.open":
        return d.live.open(userId, r.stream, session);
      case "lah.live.events": {
        const page = await d.live.events(userId, r.stream, r.turn, r.from);
        if (page === null) throw new UiRefused("not_found", "That turn is no longer the live one here: open the live view again.");
        return page;
      }
      case "lah.live.close":
        d.live.close(userId, r.stream, session);
        return { closed: true };
      case "lah.turn.stop": {
        const running = d.live.running(userId, r.stream, r.turn);
        if (running === null) return { stopped: false };
        const relay = running.relay;
        const why = "You stopped the reply from LumiAH's live view.";
        // Lumiverse hasn't heard of this stop: where the runtime can't make it stop the generation, the empty reply it then saves is taken away.
        d.turns.stoppedFromLive(userId, r.turn);
        // The runtime is told, and the turn's calls under way are ended here too, so a runtime out of reach doesn't keep a model running.
        const told = d.relays.push(userId, relay, { link: LINK, type: "stop", turn: r.turn, why, by: "live" });
        return { stopped: d.streams.stopTurn(userId, r.turn, why) > 0 || told };
      }
      case "lah.turns.list":
        return d.sessions.list(userId, r.chatId, r.cursor, r.limit);
      case "lah.transcript.get":
        return d.sessions.transcript(userId, r.transcript, r.from);
      case "lah.prompt.get":
        return { prompt: await d.sessions.prompt(userId, r.prompt) };
      case "lah.blob.get":
        return { text: await d.sessions.blob(userId, r.hash) };
      case "lah.session.rollback":
        return d.sessions.rollback(userId, r.chatId, r.messageId, r.swipe);
      case "lah.session.summarize":
        await d.chats.own(userId, r.chatId);
        // The ask is kept in a document of the core's, which the place the chat runs in writes; the session is then read as it stands, which says it was asked.
        await this.ask(userId, "session", "summarize", { chatId: r.chatId }, { chat: r.chatId });
        return { session: await d.sessions.view(userId, r.chatId) };
      case "lah.settings.set":
        return { settings: await d.settings.change(userId, r.set, r.reset) };
      // The runtime's connections and sign-ins are its own: each of these goes to the runtime the page names (else the user's runtime), which answers it through its model layer (runtime/book.ts). A key goes there in `lah.connections.save` and never comes back.
      case "lah.connections.list":
        return (await d.asks.ask(userId, "connections.list", {}, runtimeOf(r))) as unknown as UiRequests["lah.connections.list"]["result"];
      case "lah.connections.save":
        return (await d.asks.ask(userId, "connections.save", { connection: toJsonObject(r.connection), ...(r.key !== undefined ? { key: r.key } : {}), ...(r.create === true ? { create: true } : {}) }, runtimeOf(r))) as unknown as UiRequests["lah.connections.save"]["result"];
      case "lah.connections.remove":
        return (await d.asks.ask(userId, "connections.remove", { id: r.id }, runtimeOf(r))) as unknown as UiRequests["lah.connections.remove"]["result"];
      case "lah.connections.default":
        return (await d.asks.ask(userId, "connections.default", { id: r.id }, runtimeOf(r))) as unknown as UiRequests["lah.connections.default"]["result"];
      case "lah.connections.test":
        return (await d.asks.ask(userId, "connections.test", { id: r.id }, runtimeOf(r))) as unknown as UiRequests["lah.connections.test"]["result"];
      case "lah.connections.models":
        return (await d.asks.ask(userId, "connections.models", "provider" in r ? { provider: r.provider } : { connectionId: r.connectionId }, runtimeOf(r))) as unknown as UiRequests["lah.connections.models"]["result"];
      case "lah.connections.lumiverse":
        return { connections: await d.connections.lumiverse(userId) };
      case "lah.signin.start":
        return (await d.asks.ask(userId, "signin.start", { provider: r.provider }, runtimeOf(r))) as unknown as UiRequests["lah.signin.start"]["result"];
      case "lah.signin.finish":
        return (await d.asks.ask(userId, "signin.finish", { flow: r.flow, code: r.code }, runtimeOf(r))) as unknown as UiRequests["lah.signin.finish"]["result"];
      case "lah.signin.cancel":
        return (await d.asks.ask(userId, "signin.cancel", { flow: r.flow }, runtimeOf(r))) as unknown as UiRequests["lah.signin.cancel"]["result"];
      case "lah.signin.out":
        return (await d.asks.ask(userId, "signin.out", { provider: r.provider }, runtimeOf(r))) as unknown as UiRequests["lah.signin.out"]["result"];
      case "lah.signin.state":
        return (await d.asks.ask(userId, "signin.state", { provider: r.provider }, runtimeOf(r))) as unknown as UiRequests["lah.signin.state"]["result"];
      case "lah.text.set":
        return { texts: await d.settings.text(userId, r.id, r.text) };
      case "lah.text.reset":
        return { texts: await d.settings.text(userId, r.id, null) };
      case "lah.key": {
        const out = r.op === "mint" ? await d.keys.mint(userId) : await d.keys.forget(userId);
        // Whether a runtime is there to choose hangs on the key too (`RuntimeView.ready`).
        this.touch(userId, "key", "runtime", "setup", "connections", "chats");
        return { ...out, view: await this.key(userId) };
      }
      case "lah.relay": {
        if (r.op === "rotate") await d.relays.rotate(userId, r.relay);
        else {
          await d.relays.forget(userId, r.relay);
          d.streams.forget(userId, r.relay);
        }
        return { runtime: await this.runtime(userId) };
      }
      case "lah.drawer.close":
        return { closed: await this.host.closeDrawer(userId) };
      // Asked of that runtime alone, and only of one of this user's (asks.ts: another user's is never linked for them): how it is run and kept, and its update.
      case "lah.runtime.service.get":
        return (await d.asks.ask(userId, "runtime.service.get", {}, { relay: r.relay })) as unknown as UiRequests["lah.runtime.service.get"]["result"];
      case "lah.runtime.service.set":
        return (await d.asks.ask(userId, "runtime.service.set", { ...(r.memory !== undefined ? { memory: r.memory } : {}), ...(r.autoUpdate !== undefined ? { autoUpdate: r.autoUpdate } : {}), ...(r.restart !== undefined ? { restart: r.restart } : {}) }, { relay: r.relay })) as unknown as UiRequests["lah.runtime.service.set"]["result"];
      case "lah.runtime.update.apply":
        return (await d.asks.ask(userId, "runtime.update.apply", {}, { relay: r.relay })) as unknown as UiRequests["lah.runtime.update.apply"]["result"];
      case "lah.turn.say": {
        if (d.live.running(userId, r.stream, r.turn) === null) return { said: false };
        const out = await d.asks.ask(userId, "run.say", { run: r.turn, text: r.text }, { run: { stream: r.stream, turn: r.turn } });
        return { said: isRecord(out) && out.said === true };
      }
      case "lah.turn.pause": {
        if (d.live.running(userId, r.stream, r.turn) === null) return { paused: false };
        const out = await d.asks.ask(userId, "run.pause", { run: r.turn, on: r.on }, { run: { stream: r.stream, turn: r.turn } });
        return { paused: isRecord(out) && out.paused === true };
      }
      case "lah.approval.answer":
        return { answered: d.approvals.answer(userId, r.id, r.answer) };
      case "lah.approvals.kept": {
        // One chat's are read where that chat runs; every chat's, of the user's runtime, from the store they all share.
        const chatId = await this.chat(userId, r.chatId);
        return { kept: await this.kept(userId, await this.ask(userId, "approvals", "kept", { chatId }, { chat: chatId })) };
      }
      case "lah.approval.forget":
        await d.chats.own(userId, r.chatId);
        return { kept: await this.kept(userId, await this.ask(userId, "approvals", "forget", { chatId: r.chatId, tool: r.tool }, { chat: r.chatId })) };
      case "lah.ws.list": {
        const chatId = await this.chat(userId, r.chatId);
        return areaView(await this.ask(userId, "workspace", "list", { chatId, area: r.area }, { chat: chatId }));
      }
      case "lah.ws.read": {
        const chatId = await this.chat(userId, r.chatId);
        return fileRead(await this.ask(userId, "workspace", "read", { chatId, area: r.area, path: r.path, version: r.version }, { chat: chatId }));
      }
      case "lah.ws.write": {
        const chatId = await this.chat(userId, r.chatId);
        return fileChanged(await this.ask(userId, "workspace", "write", { chatId, area: r.area, path: r.path, text: r.text, base: r.base }, { chat: chatId }));
      }
      case "lah.ws.move": {
        const chatId = await this.chat(userId, r.chatId);
        return fileChanged(await this.ask(userId, "workspace", "move", { chatId, area: r.area, from: r.from, to: r.to, base: r.base }, { chat: chatId }));
      }
      case "lah.ws.delete": {
        const chatId = await this.chat(userId, r.chatId);
        await this.ask(userId, "workspace", "delete", { chatId, area: r.area, path: r.path, base: r.base }, { chat: chatId });
        return { deleted: true };
      }
      case "lah.ws.pin": {
        const chatId = await this.chat(userId, r.chatId);
        // The page names the agent definition a file is pinned for; the core calls it the role.
        return fileChanged(await this.ask(userId, "workspace", "pin", { chatId, area: r.area, path: r.path, on: r.on, role: r.agent }, { chat: chatId }));
      }
      case "lah.ws.history": {
        const chatId = await this.chat(userId, r.chatId);
        const versions = versionsOf(await this.ask(userId, "workspace", "history", { chatId, area: r.area, path: r.path }, { chat: chatId }));
        // The reply whose turn made a version is one of the chat's: with no chat there is none to name.
        return versionsView(versions, chatId === null ? [] : await pathTurns(await d.chats.path(userId, chatId)));
      }
      case "lah.ws.changes":
        await d.chats.own(userId, r.chatId);
        return changesView(await this.ask(userId, "workspace", "changes", { chatId: r.chatId, messageId: r.messageId, swipe: r.swipe }, { chat: r.chatId }));
      case "lah.guidance.get": {
        const chatId = await this.chat(userId, r.chatId);
        return guidanceView(guidanceOf(await this.ask(userId, "guidance", "get", { chatId }, { chat: chatId })), await this.character(userId, chatId));
      }
      case "lah.guidance.set": {
        const chatId = await this.chat(userId, r.chatId);
        return guidanceView(guidanceOf(await this.ask(userId, "guidance", "set", { chatId, level: r.level, text: r.text, base: r.base }, { chat: chatId })), await this.character(userId, chatId));
      }
      case "lah.defs.get":
        return d.defs.view(userId);
      case "lah.agent.save":
        return d.defs.saveAgent(userId, r.agent);
      case "lah.skill.save":
        return d.defs.saveSkill(userId, r.skill);
      case "lah.def.remove":
        return d.defs.remove(userId, r.kind, r.id);
      case "lah.def.switch":
        return d.defs.switch(userId, r.kind, r.id, r.off);
      case "lah.tool.approval":
        return d.defs.toolApproval(userId, r.name, r.approval);
      case "lah.tier.approval":
        return d.defs.tierApproval(userId, r.tier, r.approval);
      case "lah.jobs.list": {
        // One chat's jobs are listed where that chat runs; every chat's, of the user's runtime, from the list kept in the store.
        const chatId = await this.chat(userId, r.chatId);
        const page = jobsOf(await this.ask(userId, "jobs", "list", { chatId, cursor: r.cursor, limit: r.limit }, { chat: chatId }));
        // The extension started again while jobs ran: what a first list says of the ones still under way fills the state.
        if (r.chatId === null && r.cursor === null && !d.jobs.known(userId)) {
          d.jobs.seed(userId, page.jobs.filter((job) => !jobOver(job)));
          this.touch(userId, "jobs");
        }
        return jobsPage(page, (await this.coreSettings(userId)).jobs, r.cursor);
      }
      case "lah.jobs.set": {
        const set: { path: string[]; value: JsonValue }[] = [];
        if (r.off !== undefined) set.push({ path: [d.coreKey, "jobs", "enabled"], value: !r.off });
        if (r.paused !== undefined) set.push({ path: [TRANSPORT_KEY, "jobs", "paused"], value: r.paused });
        await d.settings.change(userId, set, []);
        const now = await this.jobsState(userId);
        return { off: now.off, paused: now.paused };
      }
      case "lah.job.start": {
        await d.chats.own(userId, r.chatId);
        const job = jobOf(await this.ask(userId, "jobs", "start", { chatId: r.chatId, agent: r.agent, task: r.task, when: r.when, allowance: r.allowance }, { chat: r.chatId }));
        if (r.story === true) await this.remembered(this.story.started(userId, r.chatId, job.id));
        return { job };
      }
      case "lah.job.cancel":
        return { job: jobOf(await this.ask(userId, "jobs", "cancel", { id: r.id }, { job: r.id })) };
      case "lah.job.again": {
        const job = jobOf(await this.ask(userId, "jobs", "again", { id: r.id }, { job: r.id }));
        // Started again, the learning of a story goes on as the new job.
        await this.remembered(this.story.again(userId, job.chatId, r.id, job.id));
        return { job };
      }
      case "lah.job.grant":
        return { job: jobOf(await this.ask(userId, "jobs", "grant", { id: r.id, allowance: r.allowance }, { job: r.id })) };
      case "lah.job.resume":
        // A job a restart left held has no run to let go: the place it runs in has the core queue it again, and answers the job as it then reads.
        return { job: jobOf(await d.asks.ask(userId, "job.resume", { id: r.id }, { job: r.id })) };
      case "lah.notice.dismiss":
        return { notices: await d.notices.dismiss(userId, r.id) };
      case "lah.side.list": {
        // Every side session is in the store, so the list is asked of the user's runtime.
        const rows = sidesOf(await this.ask(userId, "sides", "list", {})).sides;
        const mine = this.said.get(userId);
        // A session removed on another page takes the turn it waited on with it.
        for (const id of [...(mine?.keys() ?? [])]) if (!rows.some((row) => row.id === id)) mine?.delete(id);
        const names = rows.length === 0 ? new Map<string, string>() : await this.agentNames(userId);
        const { progressChars } = (await this.coreSettings(userId)).reply;
        return { sessions: rows.map((row) => sideSession(row, names, this.unkept(userId, row), progressChars)) };
      }
      case "lah.side.start": {
        const chatId = await this.chat(userId, r.chatId);
        const { side } = sideStartedOf(await this.ask(userId, "sides", "start", { chatId, agent: r.agent }, { chat: chatId }));
        return { session: sideSession(side, await this.agentNames(userId), null, 0) };
      }
      case "lah.side.turns": {
        const core = sideTurnsOf(await this.ask(userId, "sides", "turns", { id: r.session }, { side: r.session }));
        const held = this.unkept(userId, core.side);
        const page = pageOf(sideTurns(core.turns, held === null ? null : { turn: held.turn, said: held.said, at: held.at, state: await this.standing(userId, r.session, held) }), r.cursor, r.limit);
        if (page === null) throw new UiRefused("bad_request", "That page of the conversation's turns isn't one LumiAH gave.");
        return { turns: page.rows, next: page.next };
      }
      case "lah.side.send": {
        // The session is read before its turn starts: how many turns it has kept by then is what later says the core has kept this one.
        const side = sidesOf(await this.ask(userId, "sides", "list", {})).sides.find((row) => row.id === r.session);
        if (side === undefined) throw new UiRefused("not_found", "That side session is no longer there.");
        const turn = turnStarted(await d.asks.ask(userId, "side.send", { session: r.session, text: r.text }, { side: r.session }));
        const held: Said = { turn, said: r.text, at: d.now(), before: side.turns };
        this.said.set(userId, (this.said.get(userId) ?? new Map<string, Said>()).set(r.session, held));
        return { session: sideSession(side, await this.agentNames(userId), held, (await this.coreSettings(userId)).reply.progressChars), turn };
      }
      case "lah.side.remove":
        await this.ask(userId, "sides", "remove", { id: r.session }, { side: r.session });
        this.said.get(userId)?.delete(r.session);
        return { removed: true };
      case "lah.spend.get": {
        const spend = spendOf(await this.ask(userId, "spend", "get", { days: r.days }));
        // A side session about no chat spends under none: there is no chat to read a name of.
        const chats = spend.chats.flatMap((row) => (row.key === "" ? [] : [row.key]));
        // The connections a call ran on are the runtime's own, and named as it names them now.
        const [chatNames, agents, held] = await Promise.all([this.chatNames(userId, chats), spend.agents.length === 0 ? new Map<string, string>() : this.agentNames(userId), d.asks.ask(userId, "connections.list", {}).catch(() => null)]);
        const listed = isRecord(held) && Array.isArray(held.connections) ? held.connections : [];
        const connections = new Map(listed.flatMap((c) => (isRecord(c) && typeof c.id === "string" && typeof c.name === "string" ? [[c.id, c.name] as const] : [])));
        return spendView(spend, { chats: chatNames, agents, connections }, await this.settingsNow(userId));
      }
      case "lah.upkeep.get":
        return upkeepView(upkeepOf(await d.asks.ask(userId, "upkeep.get", {})), await this.settingsNow(userId));
      case "lah.upkeep.sweep":
        // The sweep takes as long as the store is big: it is waited for as long as it takes.
        return upkeepView(upkeepOf(await d.asks.ask(userId, "upkeep.sweep", {}, { patient: true })), await this.settingsNow(userId));
      case "lah.timings.get":
        return this.timings(userId);
      case "lah.runtime.store": {
        // That runtime's working store, as it says it stands: its own answer, passed on.
        const state = await d.asks.ask(userId, "store.state", {}, { relay: r.relay });
        if (!isRecord(state) || typeof state.waiting !== "number") throw new UiRefused("internal", "The runtime answered with something that isn't its store's state: update the runtime and the extension to the same build.");
        return { state: state as unknown as StoreStateView };
      }
      case "lah.runtime.chatdata": {
        // That runtime's copy of chat and lore, as it says it stands; and the database reader's switch as this user is to see it, asked now.
        const [state, database] = await Promise.all([d.asks.ask(userId, "copy.state", {}, { relay: r.relay }), d.copy.databaseView(userId)]);
        if (!isRecord(state) || (state.road !== "copy" && state.road !== "link")) throw new UiRefused("internal", "The runtime answered with something that isn't its copy's state: update the runtime and the extension to the same build.");
        return { state: state as unknown as ChatDataView, database };
      }
      case "lah.runtime.database":
        return { database: await d.copy.setDatabase(userId, r.on) };
      case "lah.home.get": {
        if (r.chatId === null) return { chat: null, last: null };
        let chat: ChatView;
        try {
          chat = await d.switch.view(userId, r.chatId);
        } catch (error) {
          // A chat Lumiverse no longer has (deleted while its tab stayed open) is no chat to show, not a failure.
          if (error instanceof LinkRefused && error.code === "not_found") return { chat: null, last: null };
          throw error;
        }
        // The chat's reply turns are followed under the chat's own id.
        return { chat, last: await d.sessions.last(userId, r.chatId, d.live.whole(userId, r.chatId)) };
      }
      case "lah.lore.get":
        return loreView(await this.recall(userId, "lore", { chatId: r.chatId }));
      case "lah.lore.entry":
        return loreEntry(await this.recall(userId, "entry", { chatId: r.chatId, entryId: r.entryId }));
      case "lah.lore.search":
        return loreSearch(await this.recall(userId, "search", { chatId: r.chatId, queries: r.queries, ...(r.limit !== undefined ? { limit: r.limit } : {}) }));
      case "lah.lore.embed":
        return embeddingView(await this.recall(userId, "embed", { chatId: r.chatId, start: r.start }));
      case "lah.chronicle.get":
        return chronicleView(await this.recall(userId, "chronicle", { chatId: r.chatId }));
      case "lah.chronicle.cited":
        return citedView(await this.recall(userId, "cited", { chatId: r.chatId, citations: r.citations }));
      case "lah.story.get": {
        const status = storyOf(await this.recall(userId, "story", { chatId: r.chatId }));
        return storyView(status, await this.storyJob(userId, r.chatId));
      }
    }
  }
}
