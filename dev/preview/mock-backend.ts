// A stand-in for LumiAH's extension backend, for the preview and the frontend's tests: it answers
// every request of `src/shared/ui.ts` and pushes the state and the live views as the real one does,
// from made-up data (fixtures.ts). It keeps settings as the real one does (the user's own values put
// whole at paths over the defaults, each section checking its own), plays a run a step at a time so
// a live view fills as you watch (a call's answer arriving a few words at a time while it is in
// flight, a tool call held until the user answers it, a turn paused and let go on), and can be told
// to fail a request, so every state of every page can be reached without Lumiverse. This file holds
// the state, the settings and the live views; each area's requests are answered by its own part
// under mock/.

import { STORY_DEFAULTS, storyHolds } from "../../src/core/story";
import {
  type ApprovalView,
  type KeptApproval,
  type BackendToFrontend,
  type CauseCode,
  chatAnswered,
  type ChatStoryView,
  type ChatView,
  type JobView,
  type JsonObject,
  type JsonValue,
  type LastTurn,
  type LiveEnded,
  type LiveEvent,
  type LivePartial,
  type LiveView,
  loreChangesOf,
  type RelayView,
  replyDid,
  isRecord,
  isReply,
  type SessionView,
  type SettingPath,
  type SetupStepId,
  type SignInProvider,
  type StreamId,
  type TextDef,
  type TurnRow,
  type UiProblem,
  type ServiceView,
  type UiRequest,
  type UiRequests,
  type UiRequestType,
  type UiState,
  uiRequestOf,
  UI_VERSION,
  URL_SLOT,
} from "../../src/shared/ui";
import { causeOf } from "../../src/extension/backend/cause";
import { LINK_VERSION, versionWords } from "../../src/link/contract";
import { briefedTurn, CHATS, CONNECTIONS, failedTurn, fakeHash, type HeldWord, longTurn, OTHER_CHAT, type PlayStep, playedTurn, storedTurns, SUMMARY, THEIR_CHAT, Trace, workedTurn, workingTurn } from "./fixtures";
import { chatDataMock } from "./mock/chatdata";
import { chronicleMock } from "./mock/chronicle";
import { connectionsMock } from "./mock/connections";
import { type Handlers, hashOf, type HomeCtx, type PlayedCall, type PlayOptions, Refusal, type StoryCtx } from "./mock/ctx";
import { defsMock } from "./mock/defs";
import { homeMock, missingPermissions } from "./mock/home";
import { storeMock } from "./mock/store";
import { previewRoad, timingsMock } from "./mock/timings";
import { jobsMock } from "./mock/jobs";
import { loreMock } from "./mock/lore";
import { spendMock } from "./mock/spend";
import { talkMock } from "./mock/talk";
import { workspaceMock } from "./mock/workspace";

/** One section of the settings, as the real backend holds them: its key, its defaults, its schema, and what it refuses. */
export interface MockSection {
  key: string;
  defaults(): JsonObject;
  schema: JsonObject;
  check(values: unknown): UiProblem[];
}

export type Scenario = "ready" | "fresh" | "trouble";

export interface MockOptions {
  scenario: Scenario;
  /**
   * The chat's live turn when the preview opens: a finished one, a failed one, a long one, one in
   * which the main agent started sub-agents that wrote files (`worked`), one that starts playing at
   * once (`running`), one that plays with sub-agents and a tool call it holds for the user's word
   * (`working`), or none.
   */
  turn: "done" | "failed" | "long" | "worked" | "running" | "working" | "none";
  /** The README's pictures (`?showcase=1`): the made-up story as it stands once it is learned to its end, so the Chronicle page opens on a whole chronicle. Left out, the story is as the scenario has it. */
  showcase?: boolean;
  sections: MockSection[];
  texts: { defs: readonly TextDef[]; check(id: string, text: string): string | null };
  /** How long each answer takes, in ms. */
  delay: number;
  /** The most events one read of a live view or a transcript answers. */
  page: number;
  /** Requests that fail, by type, for a page's failure states. */
  fail: ReadonlySet<string>;
  now(): number;
  /** Runs `fn` after `ms`; returns the cancel. Tests pass their own so nothing waits on a clock. */
  later(fn: () => void, ms: number): () => void;
  /** Closes the stand-in host's drawer, as Lumiverse does when LumiAH asks it to (`lah.drawer.close`). Left out where there is no drawer to close (a test's backend): the request then answers that nothing was closed, as a Lumiverse without that call does. */
  closeDrawer?(): void;
}

const clone = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;

function put(root: JsonObject, path: readonly string[], value: JsonValue): void {
  let node = root;
  for (const key of path.slice(0, -1)) {
    if (!isRecord(node[key])) node[key] = {};
    node = node[key] as JsonObject;
  }
  const last = path.at(-1);
  if (last !== undefined) node[last] = value;
}

const within = (path: readonly string[], under: readonly string[]): boolean => under.length <= path.length && under.every((key, i) => path[i] === key);

/** A run under a stream: its trace and view, the steps still to play, and how it is held. */
interface Live {
  stream: StreamId;
  /** Whether it answers a generation in a chat: a reply's turn leaves a record on its chat, any other run a transcript of its own. */
  reply: boolean;
  chatId: string | null;
  trace: Trace;
  view: LiveView;
  steps: PlayStep[];
  /** The cancel of what waits: the next step, and what the call in flight has yet to send. */
  cancel: (() => void) | null;
  /** What the calls in flight have sent so far. */
  partials: LivePartial[];
  /** The user holds it: its next step waits for `resume`. */
  paused: boolean;
  resume: (() => void) | null;
  /** What the user said since its last step, for its main agent's next round. */
  notes: string[];
  /** The call it holds for the user's word, and what answers it. */
  held: { id: string; answer(word: HeldWord): void } | null;
  options: PlayOptions;
}

/**
 * What a call in flight sends, cut into the pieces a provider streams and spread over the wait for
 * its answer: nothing for the wait's first third (a model takes a moment before its first word),
 * then its thinking, then its text, three words at a time. The pace is the preview's own.
 */
function piecesOf(says: NonNullable<PlayStep["says"]>, after: number): { at: number; reasoning?: string; text?: string }[] {
  const cut = (whole: string | undefined): string[] => {
    const words = whole?.match(/\S+\s*/g) ?? [];
    const out: string[] = [];
    for (let i = 0; i < words.length; i += 3) out.push(words.slice(i, i + 3).join(""));
    return out;
  };
  const pieces = [...cut(says.reasoning).map((reasoning) => ({ reasoning })), ...cut(says.text).map((text) => ({ text }))];
  return pieces.map((piece, i) => ({ ...piece, at: Math.round(after * (0.3 + (0.65 * i) / pieces.length)) }));
}

const START_SERVICE = `sudo -u lumiverse /usr/local/bin/bun --cwd / /srv/lumiverse/data/extensions/lumi_ah/dist/lumiah.js up --url ${URL_SLOT} --systemd`;
const START_FOREGROUND = `sudo -u lumiverse /usr/local/bin/bun --cwd / /srv/lumiverse/data/extensions/lumi_ah/dist/lumiah.js up --url ${URL_SLOT}`;
const BUILD = "4c1e9a70";

/** Why a chat can't be switched on with no loopback connection, in the backend's own words. */
const NO_RUNTIME = "There is no runtime to answer this chat yet. Start one with its line on LumiAH's Runtime page and mint its key there, then switch the chat on.";

/** What a turn's trace counts up to for the first screen: the agents that worked, their tool calls, the lore entries added to and dropped from what the writer saw, and the jobs started. */
function countsOf(trace: Trace): Pick<LastTurn, "agents" | "tools" | "lore" | "jobs"> {
  const counts = { agents: 0, tools: 0, lore: { added: 0, dropped: 0 }, jobs: new Set<string>() };
  for (const { event } of trace.events) {
    if (event.kind === "agent_started") counts.agents += 1;
    if (event.kind === "job") counts.jobs.add(event.job.id);
    if (event.kind !== "agent_entry") continue;
    if (event.entry.kind === "answer") counts.tools += event.entry.calls.length;
    const lore = loreChangesOf(event.entry);
    if (lore !== null) counts.lore = { added: counts.lore.added + lore.added.length, dropped: counts.lore.dropped + lore.dropped.length };
  }
  return { ...counts, jobs: counts.jobs.size };
}

export class MockBackend {
  state: UiState;
  private own: { path: string[]; value: JsonValue }[] = [];
  private ownTexts: Record<string, string> = {};
  private readonly live = new Map<StreamId, Live>();
  private readonly watching = new Set<StreamId>();
  private readonly stored = new Map<string, { row: TurnRow; trace: Trace | null }[]>();
  /** The tools the user approved "for this chat", newest first. */
  private approved: KeptApproval[] = [];
  /** When the user asked for a chat's notes to be summarized at its next turn. */
  private readonly summaryAsked = new Map<string, number>();
  /** The transcripts kept of runs that are no reply (a job's, a side session's turn), by hash. */
  private readonly kept = new Map<string, { trace: Trace; stream: StreamId }>();
  private readonly texts = new Map<string, string>();
  private turns = 0;
  /** The trace of every run played since the preview opened, in the order they began: what Spend counts beside the story's own figures. */
  private readonly played: Trace[] = [];
  private minted = 0;
  /** The job started as the learning of each chat's story (`lah.job.start` with `story`), by chat. */
  private readonly story = new Map<string, string>();
  private readonly handlers: Handlers<UiRequestType>;
  /** Finishes the open sign-in to a provider as if the browser ran on the runtime's machine, where it finishes by itself: for the preview's console. */
  readonly finishSignIn: (provider: SignInProvider) => void;
  private starting = true;

  constructor(
    private readonly deliver: (payload: BackendToFrontend) => void,
    private readonly options: MockOptions,
  ) {
    const now = options.now();
    const ready = options.scenario !== "fresh";
    // In the story as set up, the user once approved the archivist's writes for the open chat: the Tools page lists it, to be taken back.
    if (options.scenario === "ready") this.approved = [{ chatId: "chat-mara", chat: "Mara at the harbour", tool: "workspace_write", at: now - 2 * 60 * 60_000 }];
    const relay = (over: Partial<RelayView>): RelayView => ({
      id: "relay-1",
      name: "mara",
      build: BUILD,
      host: "harbour",
      url: "http://127.0.0.1:7861/v1",
      registeredAt: now - 9 * 86_400_000,
      seenAt: now - 8000,
      link: "linked",
      problem: null,
      update: false,
      turns: 0,
      unit: "lumiah-mara.service",
      session: { valid: true, endsAt: new Date(now + 6 * 86_400_000).toISOString() },
      scheduler: "excluded",
      lines: { update: "sudo -u lumiverse /usr/local/bin/bun --cwd / /srv/lumiverse/data/extensions/lumi_ah/dist/lumiah.js up --name mara --systemd", login: "sudo -u lumiverse /usr/local/bin/bun --cwd / /var/lib/lumiah/lumiah.js login --name mara" },
      ...over,
    });
    const relays =
      options.scenario === "ready"
        ? // On the build before the extension's: the extension offered its own, which waits for the reply under way (the Runtime page's update and settings show it).
          [relay({ build: "1f0a6c33", update: true })]
        : options.scenario === "trouble"
          ? [
              relay({ link: "quiet", seenAt: now - 26 * 60_000, update: true, build: "3b7d2e15", session: { valid: false, endsAt: new Date(now - 3_600_000).toISOString() }, scheduler: "missing", problem: "Not heard from for 26 minutes. It may have stopped, or its Lumiverse session has ended." }),
              relay({ id: "relay-2", name: "mara-old", link: "refused", seenAt: now - 90_000, unit: null, build: "1f0a6c33", update: true, problem: versionWords(LINK_VERSION - 1, LINK_VERSION), scheduler: "unknown", session: { valid: null, endsAt: null } }),
            ]
          : [];
    const permissions = missingPermissions(options.scenario);
    const steps: Readonly<Record<SetupStepId, boolean>> = { permissions: !permissions.some((p) => p.needed), chat: ready, reply: ready };
    this.state = {
      rev: 1,
      runtime: { build: BUILD, link: LINK_VERSION, model: "lumiah", relays, start: { service: START_SERVICE, foreground: START_FOREGROUND, missing: [] }, issues: [], ready: false, selfUpdate: true, road: previewRoad(options.scenario === "ready", relays, now) },
      setup: { steps: (["permissions", "chat", "reply"] as const).map((id) => ({ id, done: steps[id] })) },
      key: ready ? { set: true, print: "9f2c·41d0", at: now - 9 * 86_400_000 } : { set: false, print: null, at: null },
      chats: ready ? clone(CHATS) : [],
      running: [],
      connections: clone(ready ? CONNECTIONS : CONNECTIONS.filter((c) => !c.loopback)),
      settings: { values: {}, defaults: {}, schema: {} },
      texts: { defs: [...options.texts.defs], own: {} },
      approvals: [],
      jobs: { active: [], off: false, paused: false, changed: 0 },
      notices: [],
      defs: 0,
      permissions,
    };
    this.state.runtime.ready = this.readyOf(this.state);
    this.state.chats = this.state.chats.map((c) => this.withRuntime(c));
    this.state.settings = this.settingsView();
    // The jobs' part is made after the context it takes, so what reads its list is bound once it is there.
    let jobsOf: (chatId: string) => JobView[] = () => [];
    const ctx: HomeCtx & StoryCtx = {
      now: options.now,
      later: options.later,
      ready,
      scenario: options.scenario,
      showcase: options.showcase === true,
      state: () => this.state,
      push: (patch) => this.push(patch),
      blobs: {
        put: (text) => {
          const hash = hashOf(text);
          this.texts.set(hash, text);
          return hash;
        },
        set: (hash, text) => void this.texts.set(hash, text),
        get: (hash) => this.texts.get(hash),
      },
      play: (stream, steps, play) => this.play(stream, steps, play),
      stop: (stream, why) => this.stop(stream, why),
      pause: (stream, on) => this.pause(stream, on),
      settings: (set, reset) => void this.setSettings(set, reset),
      keep: (stream, trace) => {
        const transcript = fakeHash(`transcript:${trace.turn}`);
        this.kept.set(transcript, { trace, stream });
        return transcript;
      },
      learning: (chatId, jobId) => void this.story.set(chatId, jobId),
      chat: (chatId) => this.chat(chatId),
      last: (chatId) => this.last(chatId),
      storyJob: (chatId) => jobsOf(chatId).find((j) => j.id === this.story.get(chatId)) ?? null,
      calls: () => this.calls(),
    };
    const workspace = workspaceMock(ctx);
    const chronicle = chronicleMock(ctx);
    const { finishByItself, ...connections } = connectionsMock(ctx);
    this.finishSignIn = finishByItself;
    const jobs = jobsMock(ctx);
    jobsOf = (chatId) => {
      const page = jobs["lah.jobs.list"]({ lah: UI_VERSION, type: "lah.jobs.list", reqId: "story", chatId, cursor: null, limit: 1000 });
      return page instanceof Promise ? [] : page.jobs;
    };
    // The chronicle's files are read as any workspace file is: its part answers for those it holds, the workspace's for the rest.
    // What counts as each chat's story: the chat's own choice over Settings' as shipped. No extension has a word on it here, and Lumiverse says nothing of its Sovereign Hand, as the one there is now.
    const stories = new Map<string, ChatStoryView["chosen"]>();
    const storyAt = (chatId: string): ChatStoryView => {
      const chosen = stories.get(chatId) ?? {};
      return { chatId, chosen, setting: { ...STORY_DEFAULTS }, claimed: null, sovereignHand: null, holds: storyHolds({ chat: chosen, user: STORY_DEFAULTS, sovereignHand: null }) };
    };
    this.handlers = {
      ...this.ownHandlers(),
      ...workspace,
      ...defsMock(ctx),
      ...jobs,
      ...spendMock(ctx),
      ...talkMock(ctx),
      ...homeMock(ctx),
      ...storeMock(() => this.options.now()),
      ...chatDataMock(() => this.options.now()),
      ...timingsMock(
        () => this.options.now(),
        () => this.state.runtime.relays,
      ),
      ...loreMock(ctx),
      ...chronicle.handlers,
      ...connections,
      "lah.ws.read": (r) => chronicle.read(r) ?? workspace["lah.ws.read"](r),
      "lah.ws.list": (r) => {
        const view = workspace["lah.ws.list"](r);
        return view instanceof Promise ? view.then((v) => chronicle.list(r, v)) : chronicle.list(r, view);
      },
      "lah.chat.story.get": (r) => ({ story: storyAt(r.chatId) }),
      "lah.chat.story.set": (r) => {
        stories.set(r.chatId, { ...r.story });
        return { story: storyAt(r.chatId) };
      },
      // No extension answers the preview's chats: LumiAH's own main agent leads each.
      "lah.chat.lead.get": () => ({ lead: null }),
    };
    if (ready) {
      this.stored.set("chat-mara", storedTurns(now));
      // The open chat is pinned to the loopback connection, so the runtime answers it.
      const first =
        options.turn === "done"
          ? briefedTurn("chat-mara", "turn-0043", now - 3 * 60_000, { messageId: "msg-0043" })
          : options.turn === "failed"
            ? failedTurn("chat-mara", "turn-0039", now - 26 * 60_000)
            : options.turn === "long"
              ? longTurn("chat-mara", "turn-0037", now - 44 * 60_000, 90)
              : options.turn === "worked"
                ? workedTurn("chat-mara", "turn-0045", now - 2 * 60_000)
                : null;
      if (first) this.hold("chat-mara", first, { reply: true, chatId: "chat-mara" });
      this.hold("chat-brann", failedTurn("chat-brann", "turn-b-0007", now - 50 * 60_000), { reply: true, chatId: "chat-brann" });
      if (options.turn === "running") options.later(() => this.startTurn("chat-mara"), 400);
      if (options.turn === "working") options.later(() => this.startTurn("chat-mara", workingTurn()), 400);
    }
    this.starting = false;
  }

  // ---------------------------------------------------------------- what the page sends

  receive(raw: unknown): void {
    const read = uiRequestOf(raw);
    if (read === null) return;
    if ("malformed" in read) {
      if (read.reqId !== null) this.deliver({ lah: UI_VERSION, type: "lah.error", reqId: read.reqId, code: "bad_request", message: read.malformed });
      return;
    }
    const request = read.request;
    this.options.later(() => {
      const refuse = (error: unknown): void => {
        const refusal = error instanceof Refusal ? error : new Refusal("internal", error instanceof Error ? error.message : String(error));
        this.deliver({ lah: UI_VERSION, type: "lah.error", reqId: request.reqId, code: refusal.code, message: refusal.message, ...(refusal.problems ? { problems: refusal.problems } : {}) });
      };
      const answer = (body: unknown): void => this.deliver({ lah: UI_VERSION, type: "lah.result", reqId: request.reqId, request: request.type, body } as BackendToFrontend);
      try {
        if (this.options.fail.has(request.type)) throw new Refusal("internal", `The preview was told to fail ${request.type}.`);
        // The handler table is keyed by the request's type, which TypeScript can't follow through the lookup. A handler may answer later (a sweep takes a while).
        const body = (this.handlers[request.type] as (r: UiRequest) => unknown)(request);
        if (body instanceof Promise) body.then(answer, refuse);
        else answer(body);
      } catch (error) {
        refuse(error);
      }
    }, this.options.delay);
  }

  /** The requests this file answers itself: the state, chats, live views and what the user does to a run, sessions, settings, texts, the key and the runtime. */
  private ownHandlers() {
    type Own = "lah.hello" | "lah.chat.get" | "lah.chat.set" | "lah.chat.takeover" | "lah.live.open" | "lah.live.events" | "lah.live.close" | "lah.turn.stop" | "lah.turn.say" | "lah.turn.pause" | "lah.approval.answer" | "lah.approvals.kept" | "lah.approval.forget" | "lah.turns.list" | "lah.transcript.get" | "lah.prompt.get" | "lah.blob.get" | "lah.session.rollback" | "lah.session.summarize" | "lah.settings.set" | "lah.text.set" | "lah.text.reset" | "lah.key" | "lah.relay" | "lah.drawer.close" | "lah.runtime.service.get" | "lah.runtime.service.set" | "lah.runtime.update.apply";
    // How each linked runtime of the preview is run and kept, as it would say itself: a systemd service on a build behind the extension's, with that build waiting for the reply under way.
    const services = new Map<string, ServiceView>();
    const service = (relay: string): ServiceView => {
      const r = this.state.runtime.relays.find((x) => x.id === relay);
      if (r === undefined || r.link !== "linked") throw new Refusal("unavailable", "That runtime isn't linked now. Start it (its line is on LumiAH's Runtime page) and try again.");
      const made = services.get(relay) ?? { build: r.build ?? BUILD, memory: "1G", memoryNote: null, autoUpdate: true, runs: "systemd", unit: r.unit, source: "/srv/lumiverse/extensions/lumi_ah/dist/lumiah.js", installed: "/home/mara/.local/share/lumiah/lumiah.js", waiting: r.update ? { build: BUILD, since: this.options.now() } : null, busy: r.turns > 0, restartNeeded: false, updating: false, problem: null, line: null, handedOver: false, waitingCopy: null, underWay: { replies: r.turns, requests: r.turns, jobs: 0, sides: 0 } };
      services.set(relay, made);
      return made;
    };
    const handlers: { [K in Own]: (r: Extract<UiRequest, { type: K }>) => UiRequests[K]["result"] } = {
      "lah.hello": () => this.state,
      "lah.chat.get": (r) => ({ chat: this.chat(r.chatId) }),
      "lah.chat.set": (r) => {
        const before = this.chat(r.chatId);
        if (r.on && this.state.permissions.some((p) => p.needed)) throw new Refusal("unavailable", "LumiAH can't answer a chat yet: Lumiverse hasn't allowed it what it needs. Allow it on Home, then switch the chat on.");
        const loopback = this.state.connections.find((c) => c.loopback);
        if (r.on && loopback === undefined) throw new Refusal("unavailable", NO_RUNTIME);
        // Switched on, a chat is pinned to the loopback connection, so the runtime answers it; switched off, it gets its own back.
        const connection = r.on && loopback ? { id: loopback.id, name: loopback.name, loopback: true } : { id: "conn-deepseek", name: "Deepseek", loopback: false };
        const chat: ChatView = this.withRuntime({ ...before, on: r.on, since: r.on ? (before.on && before.since !== null ? before.since : this.options.now()) : null, connection });
        const chats = this.state.chats.some((c) => c.chatId === chat.chatId) ? this.state.chats.map((c) => (c.chatId === chat.chatId ? chat : c)) : [...this.state.chats, chat];
        this.push({ chats: chats.filter((c) => c.on || chatAnswered(c)), ...(r.on ? { setup: this.stepDone("chat") } : {}) });
        return { chat };
      },
      "lah.chat.takeover": (r) => {
        const before = this.chat(r.chatId);
        if (before.other === undefined) throw new Refusal("conflict", "No other extension answers this chat, so there is nothing to take over. Switch LumiAH on for it instead.");
        const loopback = this.state.connections.find((c) => c.loopback);
        if (loopback === undefined) throw new Refusal("unavailable", NO_RUNTIME);
        // The other's mark goes, and the chat is switched on here: pinned to the loopback connection, so the runtime answers it.
        const { other: _mark, ...mine } = before;
        const chat: ChatView = this.withRuntime({ ...mine, on: true, since: this.options.now(), connection: { id: loopback.id, name: loopback.name, loopback: true } });
        const chats = this.state.chats.some((c) => c.chatId === chat.chatId) ? this.state.chats.map((c) => (c.chatId === chat.chatId ? chat : c)) : [...this.state.chats, chat];
        this.push({ chats });
        return { chat };
      },
      "lah.live.open": (r) => {
        this.watching.add(r.stream);
        const held = this.live.get(r.stream);
        if (!held) return { live: null, next: null };
        const events = held.view.events.slice(0, this.options.page);
        return { live: { ...held.view, events }, next: held.view.events.length > events.length ? events.length + 1 : null };
      },
      "lah.live.events": (r) => {
        const held = this.live.get(r.stream);
        if (!held || held.view.turn !== r.turn) throw new Refusal("not_found", "That turn is no longer the live one.");
        return this.pageOf(held.view.events, r.from);
      },
      "lah.live.close": (r) => {
        this.watching.delete(r.stream);
        return { closed: true };
      },
      "lah.turn.stop": (r) => {
        const held = this.live.get(r.stream);
        if (!held || held.view.turn !== r.turn || held.view.ended !== null) return { stopped: false };
        this.stop(r.stream, "You stopped it from the live view.");
        return { stopped: true };
      },
      "lah.turn.say": (r) => {
        const held = this.live.get(r.stream);
        if (!held || held.view.turn !== r.turn || held.view.ended !== null) return { said: false };
        held.notes.push(r.text);
        return { said: true };
      },
      "lah.turn.pause": (r) => {
        const held = this.live.get(r.stream);
        if (!held || held.view.turn !== r.turn || held.view.ended !== null) return { paused: false };
        this.pause(r.stream, r.on);
        return { paused: held.paused };
      },
      "lah.approval.answer": (r) => {
        const held = [...this.live.values()].find((x) => x.held?.id === r.id);
        if (!held?.held) return { answered: false };
        const asked = this.state.approvals.find((a) => a.id === r.id);
        // Approved for this chat, the tool is kept as that until the user takes it back on the Tools page.
        if (r.answer.decision === "chat" && asked && asked.chatId !== "" && !this.approved.some((k) => k.chatId === asked.chatId && k.tool === asked.tool)) this.approved = [{ chatId: asked.chatId, chat: this.chat(asked.chatId).name, tool: asked.tool, at: this.options.now() }, ...this.approved];
        held.held.answer(r.answer);
        return { answered: true };
      },
      "lah.approvals.kept": (r) => ({ kept: this.approved.filter((k) => r.chatId === null || k.chatId === r.chatId) }),
      "lah.approval.forget": (r) => {
        this.approved = this.approved.filter((k) => !(k.chatId === r.chatId && k.tool === r.tool));
        return { kept: this.approved.filter((k) => k.chatId === r.chatId) };
      },
      "lah.turns.list": (r) => {
        const all = this.stored.get(r.chatId) ?? [];
        const from = r.cursor === null ? 0 : Number(r.cursor);
        const rows = all.slice(from, from + r.limit).map((x) => x.row);
        return { turns: rows, next: from + r.limit < all.length ? String(from + r.limit) : null, total: all.length, session: this.session(r.chatId) };
      },
      "lah.transcript.get": (r) => {
        const reply = [...this.stored.values()].flat().find((x) => x.row.transcript === r.transcript);
        const other = this.kept.get(r.transcript);
        const trace = reply?.trace ?? other?.trace;
        if (!trace) throw new Refusal("not_found", "The store no longer has that transcript.");
        const page = this.pageOf(trace.events, r.from);
        return { view: { ...this.viewOf(other?.stream ?? trace.chatId, trace.chatId === "" ? null : trace.chatId, trace, [], reply ? { reply: true } : undefined), events: page.events }, next: page.next };
      },
      "lah.prompt.get": (r) => {
        for (const trace of this.traces()) {
          const prompt = trace.prompts.get(r.prompt);
          if (prompt) return { prompt };
        }
        throw new Refusal("not_found", "The store no longer has that prompt.");
      },
      "lah.blob.get": (r) => {
        if (r.hash === fakeHash("summary:1") || r.hash === fakeHash("summary:0")) return { text: SUMMARY };
        const kept = this.texts.get(r.hash);
        if (kept !== undefined) return { text: kept };
        for (const trace of this.traces()) {
          const text = trace.blobs.get(r.hash);
          if (text !== undefined) return { text };
        }
        throw new Refusal("not_found", "The store no longer has that text.");
      },
      "lah.session.rollback": (r) => {
        const found = (this.stored.get(r.chatId) ?? []).find((x) => x.row.messageId === r.messageId && x.row.swipe === r.swipe);
        if (!found?.row.compaction) throw new Refusal("not_found", "That turn made no compaction.");
        if (found.row.compaction.rollback !== "available") throw new Refusal("unavailable", "That compaction can't be rolled back now.");
        found.row = { ...found.row, compaction: { ...found.row.compaction, rollback: "pending" } };
        return { turn: found.row, session: this.session(r.chatId) };
      },
      "lah.session.summarize": (r) => {
        if (!this.stored.has(r.chatId)) throw new Refusal("not_found", "LumiAH has no session for that chat.");
        this.summaryAsked.set(r.chatId, this.options.now());
        return { session: this.session(r.chatId) };
      },
      "lah.settings.set": (r) => ({ settings: this.setSettings(r.set, r.reset) }),
      "lah.text.set": (r) => {
        if (!this.options.texts.defs.some((d) => d.id === r.id)) throw new Refusal("not_found", `There is no text ${r.id}.`);
        const refused = this.options.texts.check(r.id, r.text);
        if (refused !== null) throw new Refusal("invalid", refused, [{ path: [r.id], message: refused }]);
        this.ownTexts = { ...this.ownTexts, [r.id]: r.text };
        return { texts: this.pushTexts() };
      },
      "lah.text.reset": (r) => {
        const { [r.id]: _dropped, ...rest } = this.ownTexts;
        this.ownTexts = rest;
        return { texts: this.pushTexts() };
      },
      "lah.key": (r) => {
        if (r.op === "forget") {
          const view = { set: false, print: null, at: null };
          this.push({ key: view });
          return { key: null, view, connection: null };
        }
        // A key differs from the one before however fast it is asked for.
        this.minted += 1;
        const key = `lah_${fakeHash(`key:${this.options.now()}:${this.minted}`).slice(0, 40)}`;
        const view = { set: true, print: `${key.slice(4, 8)}·${key.slice(8, 12)}`, at: this.options.now() };
        const linked = this.state.runtime.relays.some((x) => x.link === "linked");
        const connections = linked && !this.state.connections.some((c) => c.loopback) ? [CONNECTIONS[0] as (typeof CONNECTIONS)[number], ...this.state.connections] : this.state.connections;
        const loopback = linked ? connections.find((c) => c.loopback) : undefined;
        this.push({ key: view, connections });
        return { key, view, connection: loopback ? { id: loopback.id, name: loopback.name } : null };
      },
      "lah.relay": (r) => {
        if (!this.state.runtime.relays.some((x) => x.id === r.relay)) throw new Refusal("not_found", "There is no such runtime.");
        const runtime = r.op === "forget" ? { ...this.state.runtime, relays: this.state.runtime.relays.filter((x) => x.id !== r.relay) } : this.state.runtime;
        if (r.op === "forget") this.push({ runtime, chats: this.state.chats.map((c) => this.withRuntime(c, runtime.relays)) });
        return { runtime };
      },
      "lah.drawer.close": () => {
        const close = this.options.closeDrawer;
        close?.();
        return { closed: close !== undefined };
      },
      "lah.runtime.service.get": (r) => ({ service: service(r.relay) }),
      "lah.runtime.service.set": (r) => {
        const before = service(r.relay);
        const after: ServiceView = { ...before, ...(r.memory !== undefined ? { memory: r.memory, restartNeeded: r.memory !== "1G" } : {}), ...(r.autoUpdate !== undefined ? { autoUpdate: r.autoUpdate } : {}) };
        services.set(r.relay, r.restart === true && after.restartNeeded ? { ...after, updating: true } : after);
        return { service: service(r.relay), restart: r.restart === true && after.restartNeeded ? "restarting" : after.restartNeeded ? "needed" : "none" };
      },
      "lah.runtime.update.apply": (r) => {
        const before = service(r.relay);
        if (before.waiting === null) throw new Refusal("unavailable", "There is no update to take: this runtime is on the build LumiAH offered, or LumiAH hasn't offered one since it started.");
        services.set(r.relay, { ...before, waiting: null, updating: true });
        return { service: service(r.relay), cut: before.underWay };
      },
    };
    return handlers;
  }

  // ---------------------------------------------------------------- what the preview drives

  /** A runtime links, as after the start line ran: the runtime's own first step is done. */
  linkRuntime(): void {
    const now = this.options.now();
    const linked: RelayView = { id: "relay-1", name: "mara", build: BUILD, host: "harbour", url: "http://127.0.0.1:7861/v1", registeredAt: now, seenAt: now, link: "linked", problem: null, update: false, turns: 0, unit: "lumiah-mara.service", session: { valid: true, endsAt: new Date(now + 7 * 86_400_000).toISOString() }, scheduler: "excluded", lines: { update: null, login: null } };
    this.push({ runtime: { ...this.state.runtime, relays: [linked], road: previewRoad(this.state.runtime.road.granted, [linked], now) }, chats: this.state.chats.map((c) => this.withRuntime(c, [linked])) });
  }

  /** Lumiverse grants LumiAH permissions, as after the user agreed in its confirmation: first-time setup's first step is done once none it needs is missing. */
  grant(ids: readonly string[]): void {
    const permissions = this.state.permissions.filter((p) => !ids.includes(p.id));
    this.push({ permissions, ...(permissions.some((p) => p.needed) ? {} : { setup: this.stepDone("permissions") }) });
  }

  /** A reply is asked for in a chat: its turn plays a step at a time (`steps`; left out, a plain turn whose writer writes the reply). False when the chat isn't answered (it is off, LumiAH lacks a permission, or no runtime is ready), or a turn of it runs already. */
  startTurn(chatId: string, steps?: PlayStep[]): boolean {
    if (!chatAnswered(this.chat(chatId)) || this.state.permissions.some((p) => p.needed) || !this.state.runtime.ready) return false;
    return this.play(chatId, steps ?? playedTurn(), { reply: true, chatId }) !== null;
  }

  /** A push the page never hears: the next one leaves a gap for it to mend. */
  dropNextLive = false;

  // ---------------------------------------------------------------- runs

  /** A run that is over (or was read whole) stands under its stream. */
  private hold(stream: StreamId, trace: Trace, options: PlayOptions): Live {
    const held: Live = { stream, reply: options.reply, chatId: options.chatId, trace, view: this.viewOf(stream, options.chatId, trace, [], { reply: options.reply }), steps: [], cancel: null, partials: [], paused: false, resume: null, notes: [], held: null, options };
    this.live.set(stream, held);
    return held;
  }

  /** Plays a run under a stream; the turn's id, or null while a run of that stream is under way. */
  private play(stream: StreamId, steps: PlayStep[], options: PlayOptions): string | null {
    const before = this.live.get(stream);
    if (before && before.view.ended === null) return null;
    this.turns += 1;
    const trace = new Trace(options.chatId ?? "", options.turn ?? `turn-live-${String(this.turns).padStart(3, "0")}`, this.options.now());
    trace.clock = this.options.now;
    this.played.push(trace);
    const held = this.hold(stream, trace, options);
    held.steps = [...steps];
    this.advance(held, true);
    return trace.turn;
  }

  /** Holds a run that is under way at its next step, or lets it go on; false when none of that stream runs. */
  private pause(stream: StreamId, on: boolean): boolean {
    const held = this.live.get(stream);
    if (!held || held.view.ended !== null) return false;
    if (held.paused === on) return true;
    held.paused = on;
    const before = held.trace.events.length;
    held.trace.now = Math.max(held.trace.now, this.options.now());
    if (on) held.trace.paused();
    else held.trace.resumed();
    this.grew(held, before);
    this.push({ running: this.state.running.map((x) => (x.stream === stream && x.turn === held.view.turn ? { ...x, paused: on } : x)) });
    if (!on) {
      const resume = held.resume;
      held.resume = null;
      resume?.();
    }
    return true;
  }

  /** Stops a run that is under way, as the user's Stop does. */
  private stop(stream: StreamId, why: string): boolean {
    const held = this.live.get(stream);
    if (!held || held.view.ended !== null) return false;
    held.cancel?.();
    held.steps = [];
    held.partials = [];
    held.resume = null;
    if (held.held) this.release(held);
    const before = held.trace.events.length;
    held.trace.now = Math.max(held.trace.now, this.options.now());
    // The words the core's own stop carries: the page says each thing once, and is shown here against what it will really get.
    for (const agentId of held.trace.working()) held.trace.stop(agentId, "cancelled", "cancelled", "the agent was cancelled").idle(agentId);
    held.trace.ended("stopped", why);
    this.grew(held, before);
    return true;
  }

  private advance(held: Live, first: boolean): void {
    if (held.paused) {
      held.resume = () => this.advance(held, first);
      return;
    }
    const step = held.steps.shift();
    if (!step) return;
    const says = step.says;
    const waiting = says ? piecesOf(says, step.after).map((piece) => this.options.later(() => this.streamed(held, says.agentId, piece), piece.at)) : [];
    const land = (word?: HeldWord): void => {
      const before = held.trace.events.length;
      held.trace.now = Math.max(held.trace.now, this.options.now());
      // What the user said since the last step reaches the main agent before its next round.
      for (const note of held.notes.splice(0)) held.trace.note(note);
      // The call's entry lands: it takes the place of what the call had sent.
      if (says) held.partials = held.partials.filter((p) => p.agentId !== says.agentId);
      step.run(held.trace, word);
      this.grew(held, first ? -1 : before);
      this.advance(held, false);
    };
    waiting.push(
      this.options.later(() => {
        const asks = step.asks;
        if (!asks) return land();
        // The call waits for the user's word, or for its wait to run out.
        const now = this.options.now();
        const approval: ApprovalView = { id: `held-${held.trace.turn}-${asks.call.id}`, stream: held.stream, turn: held.trace.turn, chatId: held.chatId ?? "", agentId: asks.agentId, role: asks.role, callId: asks.call.id, tool: asks.call.name, tier: asks.tier, args: asks.call.args, at: now, until: now + asks.wait };
        const before = held.trace.events.length;
        held.trace.now = Math.max(held.trace.now, now);
        held.trace.asked(asks.agentId, asks.call, asks.tier, approval.until);
        this.grew(held, first ? -1 : before);
        first = false;
        const timeout = this.options.later(() => answer({ decision: "timed_out" }), asks.wait);
        const answer = (word: HeldWord): void => {
          timeout();
          this.release(held);
          land(word);
        };
        held.held = { id: approval.id, answer };
        held.cancel = timeout;
        this.push({ approvals: [...this.state.approvals, approval] });
      }, step.after),
    );
    held.cancel = () => {
      for (const cancel of waiting) cancel();
    };
  }

  /** A held call is held no longer. */
  private release(held: Live): void {
    const id = held.held?.id;
    held.held = null;
    if (id !== undefined) this.push({ approvals: this.state.approvals.filter((a) => a.id !== id) });
  }

  /** A call in flight sent a piece: the view holds it, and the pages watching hear what arrived, with how much had arrived before. */
  private streamed(held: Live, agentId: string, piece: { reasoning?: string; text?: string }): void {
    if (held.view.ended !== null) return;
    const call = held.trace.events.filter((e) => e.event.kind === "agent_entry" && e.event.agentId === agentId && e.event.entry.kind === "answer").length + 1;
    const now = this.options.now();
    const had = held.partials.find((p) => p.agentId === agentId && p.call === call) ?? { agentId, call, text: "", reasoning: "", at: now };
    held.partials = [...held.partials.filter((p) => p.agentId !== agentId), { ...had, text: had.text + (piece.text ?? ""), reasoning: had.reasoning + (piece.reasoning ?? "") }];
    held.view = { ...held.view, partials: held.partials };
    if (!this.watching.has(held.stream)) return;
    if (this.dropNextLive) {
      this.dropNextLive = false;
      return;
    }
    this.deliver({ lah: UI_VERSION, type: "lah.live.delta", stream: held.stream, delta: { turn: held.view.turn, agentId, call, ...(piece.text !== undefined ? { text: piece.text } : {}), ...(piece.reasoning !== undefined ? { reasoning: piece.reasoning } : {}), before: { text: had.text.length, reasoning: had.reasoning.length }, at: now } });
  }

  /** The trace gained events: the view follows, the pages watching hear, and the state says what runs. `before` is how many events the pages had (-1: a new turn, sent whole). */
  private grew(held: Live, before: number): void {
    const view = this.viewOf(held.stream, held.chatId, held.trace, held.partials, held);
    held.view = view;
    held.partials = view.partials;
    const running = this.state.running.some((x) => x.turn === view.turn);
    if (view.ended === null && !running) this.push({ running: [...this.state.running, { stream: held.stream, chatId: held.chatId, turn: view.turn, kind: view.kind, startedAt: view.startedAt, paused: held.paused }], ...(held.reply ? { runtime: this.withTurns(1) } : {}) });
    if (view.ended !== null && running) {
      this.push({ running: this.state.running.filter((x) => x.turn !== view.turn), ...(held.reply ? { runtime: this.withTurns(-1), setup: view.ended.state === "done" ? this.stepDone("reply") : this.state.setup } : {}) });
      const transcript = fakeHash(`transcript:${view.turn}`);
      // A reply's turn is recorded on the chat only where its reply was written, as core records one; the transcript of one that ended without its reply is still read while the live view holds it.
      if (held.reply && held.chatId !== null && view.ended.state === "done") this.keep(held.chatId, held, transcript);
      else this.kept.set(transcript, { trace: held.trace, stream: held.stream });
      held.options.done?.({ turn: view.turn, state: view.ended.state, transcript, trace: held.trace });
    }
    if (!this.watching.has(held.stream)) return;
    if (this.dropNextLive) {
      this.dropNextLive = false;
      return;
    }
    this.deliver({ lah: UI_VERSION, type: "lah.live", stream: held.stream, change: before < 0 ? { view } : { turn: view.turn, events: view.events.slice(before), ended: view.ended } });
  }

  /** A reply's turn that ended leaves its record: the chat's stored turns gain it, and a rollback asked for is made. */
  private keep(chatId: string, held: Live, transcript: string): void {
    const all = (this.stored.get(chatId) ?? []).map((x) => (x.row.compaction?.rollback === "pending" ? { ...x, row: { ...x.row, compaction: { ...x.row.compaction, rollback: "done" as const } } } : x));
    const index = (all[0]?.row.index ?? 1) + 2;
    const said = held.trace.events.flatMap((e) => (e.event.kind === "agent_entry" && e.event.agentId === "writer-1" && e.event.entry.kind === "answer" ? [e.event.entry.text] : []))[0] ?? "";
    const row: TurnRow = { turn: held.view.turn, messageId: `msg-${String(index).padStart(4, "0")}`, index, swipe: 0, at: held.view.startedAt, kind: isReply(held.view.kind) ? held.view.kind : "new", onPath: true, preview: said.slice(0, 96), transcript, compaction: null, usage: held.trace.tally, changes: held.trace.changed() };
    this.stored.set(chatId, [{ row, trace: held.trace }, ...all]);
  }

  /** A run's view from its trace. `where` says whether it answers a generation: a reply's turn that failed names its cause. */
  private viewOf(stream: StreamId, chatId: string | null, trace: Trace, partials: LivePartial[], where?: { reply: boolean }): LiveView {
    const started = trace.events.find((e) => e.event.kind === "turn_started")?.event;
    const last = trace.events.at(-1)?.event;
    // Why a reply's turn failed, as the code a page acts on: read from the trace with the real backend's reader, so the preview names the cause the extension would.
    const cause: CauseCode | null = where?.reply === true && last?.kind === "turn_ended" && last.status === "failed" ? causeOf(trace.events) : null;
    const ended: LiveEnded | null = last?.kind === "turn_ended" ? { state: last.status, at: last.at, ...(last.reason !== undefined ? { reason: last.reason } : {}), ...(cause !== null ? { cause } : {}) } : null;
    return { stream, chatId, turn: trace.turn, kind: started?.kind === "turn_started" ? started.generation : "new", messageId: started?.kind === "turn_started" ? started.messageId : null, startedAt: trace.startedAt, ended, events: [...trace.events], partials: ended !== null ? [] : partials };
  }

  /** A chat's latest turn as the first screen reads it: the run its live view holds, else the newest of its stored turns. */
  private last(chatId: string): LastTurn | null {
    const held = this.live.get(chatId);
    if (held?.reply === true) {
      const view = held.view;
      return { turn: view.turn, kind: isReply(view.kind) ? view.kind : "new", messageId: view.messageId, startedAt: view.startedAt, ended: view.ended, usage: held.trace.tally, ...countsOf(held.trace), changes: held.trace.changed(), transcript: view.ended !== null ? fakeHash(`transcript:${view.turn}`) : null, did: replyDid(held.trace.events) };
    }
    const stored = this.stored.get(chatId)?.[0];
    if (!stored) return null;
    const { row, trace } = stored;
    const counts = trace ? countsOf(trace) : { agents: 0, tools: 0, lore: { added: 0, dropped: 0 }, jobs: 0 };
    return { turn: row.turn, kind: row.kind, messageId: row.messageId, startedAt: row.at, ended: { state: "done", at: row.at + (row.usage?.ms ?? 0) }, usage: row.usage, ...counts, changes: row.changes, transcript: row.transcript, ...(trace ? { did: replyDid(trace.events) } : {}) };
  }

  private pageOf(events: readonly LiveEvent[], from: number): { events: LiveEvent[]; next: number | null } {
    const page = events.filter((e) => e.seq >= from).slice(0, this.options.page);
    const last = page.at(-1)?.seq ?? from - 1;
    return { events: page, next: events.some((e) => e.seq > last) ? last + 1 : null };
  }

  private traces(): Trace[] {
    return [...[...this.live.values()].map((x) => x.trace), ...[...this.stored.values()].flat().flatMap((x) => (x.trace ? [x.trace] : [])), ...[...this.kept.values()].map((x) => x.trace)];
  }

  /** Every model call of the runs played since the preview opened, oldest first. An agent on the user's default connection is counted under the first connection that isn't the loopback, which is the story's default. */
  private calls(): PlayedCall[] {
    const usual = this.state.connections.find((c) => !c.loopback)?.id ?? "";
    const out: PlayedCall[] = [];
    for (const trace of this.played) {
      const agents = new Map<string, { role: string; connectionId: string | null }>();
      for (const { event } of trace.events) {
        if (event.kind === "agent_started") agents.set(event.agent.id, event.agent);
        else if (event.kind === "agent_entry" && event.entry.kind === "answer") {
          const agent = agents.get(event.agentId);
          out.push({ at: event.entry.at, chatId: trace.chatId === "" ? null : trace.chatId, agent: agent?.role ?? "main", connection: agent?.connectionId ?? usual, model: event.entry.model, usage: event.entry.usage });
        }
      }
    }
    return out.sort((a, b) => a.at - b.at);
  }

  // ---------------------------------------------------------------- inside

  /** A chat as the backend fills it in: the runtime that plays it while it is switched on, pinned to the loopback and a runtime is linked (the one heard from last); none else. */
  private withRuntime(chat: ChatView, relays: readonly RelayView[] = this.state.runtime.relays): ChatView {
    const { runtime: _was, ...rest } = chat;
    const plays = relays.filter((r) => r.link === "linked").sort((a, b) => (b.seenAt ?? 0) - (a.seenAt ?? 0))[0];
    return rest.on && chatAnswered(rest) && plays !== undefined ? { ...rest, runtime: { id: plays.id, name: plays.name } } : rest;
  }

  /** A chat as the backend has it: as the state lists it, else as Lumiverse knows it (its name, switched off, on its own connection). */
  private chat(chatId: string): ChatView {
    const listed = this.state.chats.find((c) => c.chatId === chatId);
    if (listed) return listed;
    // Another extension answers this one, until it is taken over (it is then among the chats listed).
    if (chatId === THEIR_CHAT.chatId) return { ...THEIR_CHAT };
    const name = [...CHATS, OTHER_CHAT].find((c) => c.chatId === chatId)?.name ?? null;
    return { chatId, name, on: false, since: null, connection: { id: "conn-deepseek", name: "Deepseek", loopback: false } };
  }

  /** Whether a runtime is there to choose: one linked, the key minted, the loopback connection made. */
  private readyOf(state: Pick<UiState, "runtime" | "key" | "connections">): boolean {
    return state.runtime.relays.some((r) => r.link === "linked") && state.key.set && state.connections.some((c) => c.loopback);
  }

  private session(chatId: string): SessionView {
    const all = this.stored.get(chatId) ?? [];
    const rolled = all.some((x) => x.row.compaction?.rollback === "done");
    const onPath = all.filter((x) => x.row.onPath);
    const summary = !rolled && onPath.some((x) => x.row.compaction !== null);
    const since = summary ? onPath.findIndex((x) => x.row.compaction !== null) + 1 : onPath.length;
    return { turns: since, tokens: since * 1390, summary, dropped: all.length - onPath.length, missing: 0, asked: this.summaryAsked.get(chatId) ?? null, held: rolled };
  }

  private stepDone(id: SetupStepId): UiState["setup"] {
    return { steps: this.state.setup.steps.map((s) => (s.id === id ? { ...s, done: true } : s)) };
  }

  private withTurns(by: number): UiState["runtime"] {
    return { ...this.state.runtime, relays: this.state.runtime.relays.map((r, i) => (i === 0 ? { ...r, turns: Math.max(0, r.turns + by) } : r)) };
  }

  /** Changes settings as `lah.settings.set` does: all of them are kept or, when a section refuses one, none. */
  private setSettings(set: readonly { path: SettingPath; value: JsonValue }[], reset: readonly SettingPath[]): UiState["settings"] {
    const next = [...this.own.filter((o) => !reset.some((under) => within(o.path, under)) && !set.some((s) => within(o.path, s.path))), ...set.map((s) => ({ path: s.path, value: clone(s.value) }))];
    const empty = set.find((s) => s.path.length === 0);
    if (empty) throw new Refusal("invalid", "A setting needs a place.", [{ path: [], message: "A setting needs a place." }]);
    const values = this.valuesOf(next);
    const problems = this.options.sections.flatMap((section) => section.check(values[section.key]).map((p) => ({ path: [section.key, ...p.path], message: p.message })));
    for (const key of Object.keys(values)) if (!this.options.sections.some((s) => s.key === key)) problems.push({ path: [key], message: "There is no such setting." });
    if (problems.length > 0) throw new Refusal("invalid", problems.length === 1 ? `Not saved: ${problems[0]?.message ?? ""}` : `Not saved: the settings refuse ${problems.length} of these values.`, problems);
    this.own = next;
    const settings = this.settingsView();
    this.push({ settings });
    return settings;
  }

  private valuesOf(own: readonly { path: string[]; value: JsonValue }[]): JsonObject {
    const values: JsonObject = {};
    for (const section of this.options.sections) values[section.key] = section.defaults();
    // A value nearer the root first, so one put deeper since stands over it.
    for (const o of [...own].sort((a, b) => a.path.length - b.path.length)) put(values, o.path, clone(o.value));
    return values;
  }

  private settingsView(): UiState["settings"] {
    const properties: JsonObject = {};
    const defaults: JsonObject = {};
    for (const section of this.options.sections) {
      properties[section.key] = section.schema;
      defaults[section.key] = section.defaults();
    }
    return { values: this.valuesOf(this.own), defaults, schema: { type: "object", additionalProperties: false, properties } };
  }

  private pushTexts(): UiState["texts"] {
    const texts = { defs: [...this.options.texts.defs], own: this.ownTexts };
    this.push({ texts });
    return texts;
  }

  /** The state changed: its parts that did go to the page under the next revision. Whether a runtime is there to choose follows from the parts it rests on, so it is worked out again here. */
  private push(change: Partial<Omit<UiState, "rev">>): void {
    const next = { ...this.state, ...change };
    const ready = this.readyOf(next);
    const patch = ready === next.runtime.ready ? change : { ...change, runtime: { ...next.runtime, ready } };
    // What a part of the story sets while the backend is being made is the state it starts with (revision 1), not a change to tell a page of: none has said hello yet.
    if (this.starting) {
      this.state = { ...this.state, ...patch };
      return;
    }
    this.state = { ...this.state, ...patch, rev: this.state.rev + 1 };
    this.deliver({ lah: UI_VERSION, type: "lah.state", rev: this.state.rev, patch });
  }
}

/** A check for a section whose schema is plain: each value's type, its bounds, and that a choice is one of its choices. What the preview's sample section is checked with. */
export function checkAgainst(schema: JsonObject, value: unknown, path: (string | number)[] = []): UiProblem[] {
  const types = Array.isArray(schema.type) ? schema.type : typeof schema.type === "string" ? [schema.type] : [];
  if (value === null) return types.includes("null") ? [] : [{ path, message: "It can't be none." }];
  if (value === undefined) return [];
  if (Array.isArray(schema.oneOf) && schema.oneOf.every((o) => isRecord(o) && Object.hasOwn(o, "const"))) return schema.oneOf.some((o) => isRecord(o) && o.const === value) ? [] : [{ path, message: "It isn't one of the choices." }];
  if (Array.isArray(schema.enum)) return schema.enum.includes(value as JsonValue) ? [] : [{ path, message: "It isn't one of the choices." }];
  if (Object.hasOwn(schema, "const")) return schema.const === value ? [] : [{ path, message: "It isn't what this shape holds here." }];
  if (Array.isArray(schema.oneOf)) {
    // Shapes: the value is checked against the one whose fixed property it carries.
    const fits = schema.oneOf.find((shape) => isRecord(shape) && isRecord(shape.properties) && isRecord(value) && Object.entries(shape.properties).every(([key, p]) => !isRecord(p) || !Object.hasOwn(p, "const") || p.const === value[key]));
    return isRecord(fits) ? checkAgainst(fits as JsonObject, value, path) : [{ path, message: "It isn't one of the shapes this setting has." }];
  }
  if (isRecord(schema.properties)) {
    if (!isRecord(value)) return [{ path, message: "It must be a group of settings." }];
    const out: UiProblem[] = [];
    for (const [key, node] of Object.entries(schema.properties)) if (isRecord(node)) out.push(...checkAgainst(node as JsonObject, value[key], [...path, key]));
    for (const key of Object.keys(value)) if (!Object.hasOwn(schema.properties, key)) out.push({ path: [...path, key], message: "There is no such setting." });
    return out;
  }
  if (isRecord(schema.additionalProperties)) {
    if (!isRecord(value)) return [{ path, message: "It must be a table of rows." }];
    return Object.entries(value).flatMap(([key, row]) => checkAgainst(schema.additionalProperties as JsonObject, row, [...path, key]));
  }
  if (types.includes("integer") || types.includes("number")) {
    if (typeof value !== "number" || !Number.isFinite(value)) return [{ path, message: "It must be a number." }];
    if (types.includes("integer") && !Number.isInteger(value)) return [{ path, message: "It must be a whole number." }];
    if (typeof schema.minimum === "number" && value < schema.minimum) return [{ path, message: `It can't be under ${schema.minimum}.` }];
    if (typeof schema.maximum === "number" && value > schema.maximum) return [{ path, message: `It can't be over ${schema.maximum}.` }];
    return [];
  }
  if (types.includes("boolean")) return typeof value === "boolean" ? [] : [{ path, message: "It must be on or off." }];
  if (types.includes("string")) {
    if (typeof value !== "string") return [{ path, message: "It must be text." }];
    return typeof schema.maxLength === "number" && value.length > schema.maxLength ? [{ path, message: `It can't be longer than ${schema.maxLength} characters.` }] : [];
  }
  if (types.includes("array")) return Array.isArray(value) ? [] : [{ path, message: "It must be a list." }];
  return [];
}
