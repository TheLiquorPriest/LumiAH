// A stand-in for LumiAH's extension backend, for the preview and the frontend's tests: it answers
// every request of `src/shared/ui.ts` and pushes the state and the live view as the real one does,
// from made-up data (fixtures.ts). It keeps settings as the real one does (the user's own values put
// whole at paths over the defaults, each section checking its own), plays a turn a step at a time so
// the live view fills as you watch (a call's answer arriving a few words at a time while it is in
// flight), and can be told to fail a request, so every state of every page can be reached without
// Lumiverse.

import { type BackendToFrontend, chatAnswered, type ChatView, isRecord, type JsonObject, type JsonValue, type LiveEnded, type LiveEvent, type LivePartial, type LiveView, type RelayView, type SessionView, type SettingPath, type SetupStepId, type TextDef, type TurnRow, type UiErrorCode, type UiProblem, type UiRequest, type UiRequests, type UiRequestType, type UiState, uiRequestOf, UI_VERSION, URL_SLOT } from "../../src/shared/ui";
import { CHATS, CONNECTIONS, failedTurn, fakeHash, finishedTurn, longTurn, MODELS, OTHER_CHAT, type PlayStep, playedTurn, storedTurns, SUMMARY, Trace } from "./fixtures";

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
  /** The chat's live turn when the preview opens: a finished one, a failed one, a long one, one that starts playing at once, or none. */
  turn: "done" | "failed" | "long" | "running" | "none";
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
}

class Refusal extends Error {
  constructor(
    readonly code: UiErrorCode,
    message: string,
    readonly problems?: UiProblem[],
  ) {
    super(message);
  }
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

interface Live {
  trace: Trace;
  view: LiveView;
  /** The steps still to play, and the cancel of what waits: the next step, and what the call in flight has yet to send. */
  steps: PlayStep[];
  cancel: (() => void) | null;
  /** What the calls in flight have sent so far. */
  partials: LivePartial[];
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

export class MockBackend {
  state: UiState;
  private own: { path: string[]; value: JsonValue }[] = [];
  private ownTexts: Record<string, string> = {};
  private readonly live = new Map<string, Live>();
  private readonly watching = new Set<string>();
  private readonly stored = new Map<string, { row: TurnRow; trace: Trace | null }[]>();
  private turns = 0;
  private minted = 0;

  constructor(
    private readonly deliver: (payload: BackendToFrontend) => void,
    private readonly options: MockOptions,
  ) {
    const now = options.now();
    const ready = options.scenario !== "fresh";
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
        ? [relay({})]
        : options.scenario === "trouble"
          ? [
              relay({ link: "quiet", seenAt: now - 26 * 60_000, update: true, build: "3b7d2e15", session: { valid: false, endsAt: new Date(now - 3_600_000).toISOString() }, scheduler: "missing", problem: "Not heard from for 26 minutes. It may have stopped, or its Lumiverse session has ended." }),
              relay({ id: "relay-2", name: "mara-old", link: "refused", seenAt: now - 90_000, unit: null, build: "1f0a6c33", update: true, problem: "This runtime speaks link version 0 and LumiAH 1: update the runtime by running its start line on LumiAH's Runtime page again.", scheduler: "unknown", session: { valid: null, endsAt: null } }),
            ]
          : [];
    const done = (id: SetupStepId): boolean => (options.scenario === "ready" ? true : options.scenario === "trouble" ? id !== "runtime" : false);
    this.state = {
      rev: 1,
      runtime: { build: BUILD, link: 1, model: "lumiah", relays, start: { service: START_SERVICE, foreground: START_FOREGROUND, missing: [] }, issues: options.scenario === "trouble" ? ["LumiAH wasn't granted the generation permission, so no agent can call a model. Grant it in Lumiverse → Extensions → LumiAH."] : [] },
      setup: { steps: (["runtime", "key", "connection", "chat", "reply"] as const).map((id) => ({ id, done: done(id) })) },
      key: ready ? { set: true, print: "9f2c·41d0", at: now - 9 * 86_400_000 } : { set: false, print: null, at: null },
      chats: ready ? clone(CHATS) : [],
      running: [],
      connections: clone(ready ? CONNECTIONS : CONNECTIONS.filter((c) => !c.loopback)),
      settings: { values: {}, defaults: {}, schema: {} },
      texts: { defs: [...options.texts.defs], own: {} },
    };
    this.state.settings = this.settingsView();
    if (ready) {
      this.stored.set("chat-mara", storedTurns(now));
      const first = options.turn === "done" ? finishedTurn("chat-mara", "turn-0043", now - 3 * 60_000) : options.turn === "failed" ? failedTurn("chat-mara", "turn-0039", now - 26 * 60_000) : options.turn === "long" ? longTurn("chat-mara", "turn-0037", now - 44 * 60_000, 90) : null;
      if (first) this.live.set("chat-mara", { trace: first, view: this.viewOf(first, []), steps: [], cancel: null, partials: [] });
      const other = failedTurn("chat-brann", "turn-b-0007", now - 50 * 60_000);
      this.live.set("chat-brann", { trace: other, view: this.viewOf(other, []), steps: [], cancel: null, partials: [] });
      if (options.turn === "running") options.later(() => this.startTurn("chat-mara"), 400);
    }
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
      try {
        if (this.options.fail.has(request.type)) throw new Refusal("internal", `The preview was told to fail ${request.type}.`);
        // The handler table is keyed by the request's type, which TypeScript can't follow through the lookup.
        const body = (this.handlers[request.type] as (r: UiRequest) => unknown)(request);
        this.deliver({ lah: UI_VERSION, type: "lah.result", reqId: request.reqId, request: request.type, body } as BackendToFrontend);
      } catch (error) {
        const refusal = error instanceof Refusal ? error : new Refusal("internal", error instanceof Error ? error.message : String(error));
        this.deliver({ lah: UI_VERSION, type: "lah.error", reqId: request.reqId, code: refusal.code, message: refusal.message, ...(refusal.problems ? { problems: refusal.problems } : {}) });
      }
    }, this.options.delay);
  }

  private readonly handlers: { [K in UiRequestType]: (r: Extract<UiRequest, { type: K }>) => UiRequests[K]["result"] } = {
    "lah.hello": () => this.state,
    "lah.chat.get": (r) => ({ chat: this.chat(r.chatId) }),
    "lah.chat.set": (r) => {
      const loopback = this.state.connections.find((c) => c.loopback);
      if (r.on && !loopback) throw new Refusal("unavailable", "There is no loopback connection to pin the chat to yet. Make it first: Runtime, first-time setup, step 3.");
      const before = this.chat(r.chatId);
      const chat: ChatView = r.on && loopback ? { ...before, on: true, since: this.options.now(), connection: { id: loopback.id, name: loopback.name, loopback: true } } : { ...before, on: false, since: null, connection: { id: "conn-deepseek", name: "Deepseek", loopback: false } };
      const chats = this.state.chats.some((c) => c.chatId === chat.chatId) ? this.state.chats.map((c) => (c.chatId === chat.chatId ? chat : c)) : [...this.state.chats, chat];
      this.push({ chats: chats.filter((c) => c.on || chatAnswered(c)), ...(r.on ? { setup: this.stepDone("chat") } : {}) });
      return { chat };
    },
    "lah.live.open": (r) => {
      this.watching.add(r.chatId);
      const held = this.live.get(r.chatId);
      if (!held) return { live: null, next: null };
      const events = held.view.events.slice(0, this.options.page);
      return { live: { ...held.view, events }, next: held.view.events.length > events.length ? events.length + 1 : null };
    },
    "lah.live.events": (r) => {
      const held = this.live.get(r.chatId);
      if (!held || held.view.turn !== r.turn) throw new Refusal("not_found", "That turn is no longer the chat's live turn.");
      return this.pageOf(held.view.events, r.from);
    },
    "lah.live.close": (r) => {
      this.watching.delete(r.chatId);
      return { closed: true };
    },
    "lah.turn.stop": (r) => {
      const held = this.live.get(r.chatId);
      if (!held || held.view.turn !== r.turn || held.view.ended !== null) return { stopped: false };
      held.cancel?.();
      held.steps = [];
      held.partials = [];
      const before = held.trace.events.length;
      for (const agentId of ["main-1", "writer-1"]) if (held.trace.events.some((e) => e.event.kind === "agent_started" && e.event.agent.id === agentId) && !held.trace.events.some((e) => e.event.kind === "agent_idle" && e.event.agentId === agentId)) held.trace.stop(agentId, "cancelled", "cancelled", "You stopped the turn.").idle(agentId);
      held.trace.ended("stopped", "You stopped it from the live view.");
      this.grew(r.chatId, held, before);
      return { stopped: true };
    },
    "lah.turns.list": (r) => {
      const all = this.stored.get(r.chatId) ?? [];
      const from = r.cursor === null ? 0 : Number(r.cursor);
      const rows = all.slice(from, from + r.limit).map((x) => x.row);
      return { turns: rows, next: from + r.limit < all.length ? String(from + r.limit) : null, total: all.length, session: this.session(r.chatId) };
    },
    "lah.transcript.get": (r) => {
      const found = [...this.stored.values()].flat().find((x) => x.row.transcript === r.transcript);
      if (!found?.trace) throw new Refusal("not_found", "The store no longer has that transcript.");
      const page = this.pageOf(found.trace.events, r.from);
      return { view: { ...this.viewOf(found.trace, []), events: page.events }, next: page.next };
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
    "lah.settings.set": (r) => {
      const next = [...this.own.filter((o) => !r.reset.some((under) => within(o.path, under)) && !r.set.some((s) => within(o.path, s.path))), ...r.set.map((s) => ({ path: s.path, value: clone(s.value) }))];
      const empty = r.set.find((s) => s.path.length === 0);
      if (empty) throw new Refusal("invalid", "A setting needs a place.", [{ path: [], message: "A setting needs a place." }]);
      const values = this.valuesOf(next);
      const problems = this.options.sections.flatMap((section) => section.check(values[section.key]).map((p) => ({ path: [section.key, ...p.path], message: p.message })));
      for (const key of Object.keys(values)) if (!this.options.sections.some((s) => s.key === key)) problems.push({ path: [key], message: "There is no such setting." });
      if (problems.length > 0) throw new Refusal("invalid", problems.length === 1 ? `Not saved: ${problems[0]?.message ?? ""}` : `Not saved: the settings refuse ${problems.length} of these values.`, problems);
      this.own = next;
      const settings = this.settingsView();
      this.push({ settings });
      return { settings };
    },
    "lah.models.list": (r) => {
      const models = MODELS[r.connectionId ?? ""];
      if (!models) throw new Refusal("unavailable", "its provider lists no models");
      return { models };
    },
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
      let setup = this.stepDone("key");
      if (loopback) setup = { steps: setup.steps.map((s) => (s.id === "connection" ? { ...s, done: true } : s)) };
      this.push({ key: view, connections, setup });
      return { key, view, connection: loopback ? { id: loopback.id, name: loopback.name } : null };
    },
    "lah.relay": (r) => {
      if (!this.state.runtime.relays.some((x) => x.id === r.relay)) throw new Refusal("not_found", "There is no such runtime.");
      const runtime = r.op === "forget" ? { ...this.state.runtime, relays: this.state.runtime.relays.filter((x) => x.id !== r.relay) } : this.state.runtime;
      if (r.op === "forget") this.push({ runtime });
      return { runtime };
    },
  };

  // ---------------------------------------------------------------- what the preview drives

  /** A runtime links, as after the start line ran: first-time setup's first step is done. */
  linkRuntime(): void {
    const now = this.options.now();
    const linked: RelayView = { id: "relay-1", name: "mara", build: BUILD, host: "harbour", url: "http://127.0.0.1:7861/v1", registeredAt: now, seenAt: now, link: "linked", problem: null, update: false, turns: 0, unit: "lumiah-mara.service", session: { valid: true, endsAt: new Date(now + 7 * 86_400_000).toISOString() }, scheduler: "excluded", lines: { update: null, login: null } };
    this.push({ runtime: { ...this.state.runtime, relays: [linked], issues: [] }, setup: this.stepDone("runtime") });
  }

  /** A reply is asked for in a chat: its turn plays a step at a time. False when the chat isn't answered, or a turn of it runs already. */
  startTurn(chatId: string, steps: PlayStep[] = playedTurn()): boolean {
    const before = this.live.get(chatId);
    if (!chatAnswered(this.chat(chatId)) || (before && before.view.ended === null)) return false;
    this.turns += 1;
    const trace = new Trace(chatId, `turn-live-${String(this.turns).padStart(3, "0")}`, this.options.now());
    trace.clock = this.options.now;
    const held: Live = { trace, view: this.viewOf(trace, []), steps: [...steps], cancel: null, partials: [] };
    this.live.set(chatId, held);
    this.advance(chatId, held, true);
    return true;
  }

  /** A push the page never hears: the next one leaves a gap for it to mend. */
  dropNextLive = false;

  // ---------------------------------------------------------------- inside

  private advance(chatId: string, held: Live, first: boolean): void {
    const step = held.steps.shift();
    if (!step) return;
    const says = step.says;
    const waiting = says ? piecesOf(says, step.after).map((piece) => this.options.later(() => this.streamed(chatId, held, says.agentId, piece), piece.at)) : [];
    waiting.push(
      this.options.later(() => {
        const before = held.trace.events.length;
        held.trace.now = Math.max(held.trace.now, this.options.now());
        // The call's entry lands: it takes the place of what the call had sent.
        if (says) held.partials = held.partials.filter((p) => p.agentId !== says.agentId);
        step.run(held.trace);
        this.grew(chatId, held, first ? -1 : before);
        this.advance(chatId, held, false);
      }, step.after),
    );
    held.cancel = () => {
      for (const cancel of waiting) cancel();
    };
  }

  /** A call in flight sent a piece: the view holds it, and the pages watching hear what arrived, with how much had arrived before. */
  private streamed(chatId: string, held: Live, agentId: string, piece: { reasoning?: string; text?: string }): void {
    if (held.view.ended !== null) return;
    const call = held.trace.events.filter((e) => e.event.kind === "agent_entry" && e.event.agentId === agentId && e.event.entry.kind === "answer").length + 1;
    const now = this.options.now();
    const had = held.partials.find((p) => p.agentId === agentId && p.call === call) ?? { agentId, call, text: "", reasoning: "", at: now };
    held.partials = [...held.partials.filter((p) => p.agentId !== agentId), { ...had, text: had.text + (piece.text ?? ""), reasoning: had.reasoning + (piece.reasoning ?? "") }];
    held.view = { ...held.view, partials: held.partials };
    if (!this.watching.has(chatId)) return;
    if (this.dropNextLive) {
      this.dropNextLive = false;
      return;
    }
    this.deliver({ lah: UI_VERSION, type: "lah.live.delta", chatId, delta: { turn: held.view.turn, agentId, call, ...(piece.text !== undefined ? { text: piece.text } : {}), ...(piece.reasoning !== undefined ? { reasoning: piece.reasoning } : {}), before: { text: had.text.length, reasoning: had.reasoning.length }, at: now } });
  }

  /** The trace gained events: the view follows, the pages watching hear, and the state says what runs. `before` is how many events the pages had (-1: a new turn, sent whole). */
  private grew(chatId: string, held: Live, before: number): void {
    const view = this.viewOf(held.trace, held.partials);
    held.view = view;
    held.partials = view.partials;
    const running = this.state.running.some((x) => x.turn === view.turn);
    if (view.ended === null && !running) this.push({ running: [...this.state.running, { chatId, turn: view.turn, kind: view.kind, startedAt: view.startedAt }], runtime: this.withTurns(1) });
    if (view.ended !== null && running) {
      this.push({ running: this.state.running.filter((x) => x.turn !== view.turn), runtime: this.withTurns(-1), setup: view.ended.state === "done" ? this.stepDone("reply") : this.state.setup });
      this.keep(chatId, held);
    }
    if (!this.watching.has(chatId)) return;
    if (this.dropNextLive) {
      this.dropNextLive = false;
      return;
    }
    this.deliver({ lah: UI_VERSION, type: "lah.live", chatId, change: before < 0 ? { view } : { turn: view.turn, events: view.events.slice(before), ended: view.ended } });
  }

  /** A turn that ended leaves its record: the chat's stored turns gain it, and a rollback asked for is made. */
  private keep(chatId: string, held: Live): void {
    const all = (this.stored.get(chatId) ?? []).map((x) => (x.row.compaction?.rollback === "pending" ? { ...x, row: { ...x.row, compaction: { ...x.row.compaction, rollback: "done" as const } } } : x));
    const index = (all[0]?.row.index ?? 1) + 2;
    const said = held.trace.events.flatMap((e) => (e.event.kind === "agent_entry" && e.event.agentId === "writer-1" && e.event.entry.kind === "answer" ? [e.event.entry.text] : []))[0] ?? "";
    const row: TurnRow = { turn: held.view.turn, messageId: `msg-${String(index).padStart(4, "0")}`, index, swipe: 0, at: held.view.startedAt, kind: held.view.kind, onPath: true, preview: said.slice(0, 96), transcript: fakeHash(`transcript:${held.view.turn}`), compaction: null, usage: held.trace.tally };
    this.stored.set(chatId, [{ row, trace: held.trace }, ...all]);
  }

  private viewOf(trace: Trace, partials: LivePartial[]): LiveView {
    const started = trace.events.find((e) => e.event.kind === "turn_started")?.event;
    const last = trace.events.at(-1)?.event;
    const ended: LiveEnded | null = last?.kind === "turn_ended" ? { state: last.status, at: last.at, ...(last.reason !== undefined ? { reason: last.reason } : {}) } : null;
    return { chatId: trace.chatId, turn: trace.turn, kind: started?.kind === "turn_started" ? started.generation : "new", messageId: started?.kind === "turn_started" ? started.messageId : null, startedAt: trace.startedAt, ended, events: [...trace.events], partials: ended !== null ? [] : partials };
  }

  private pageOf(events: readonly LiveEvent[], from: number): { events: LiveEvent[]; next: number | null } {
    const page = events.filter((e) => e.seq >= from).slice(0, this.options.page);
    const last = page.at(-1)?.seq ?? from - 1;
    return { events: page, next: events.some((e) => e.seq > last) ? last + 1 : null };
  }

  private traces(): Trace[] {
    return [...[...this.live.values()].map((x) => x.trace), ...[...this.stored.values()].flat().flatMap((x) => (x.trace ? [x.trace] : []))];
  }

  private chat(chatId: string): ChatView {
    return this.state.chats.find((c) => c.chatId === chatId) ?? (chatId === OTHER_CHAT.chatId ? OTHER_CHAT : { chatId, name: null, on: false, since: null, connection: { id: "conn-deepseek", name: "Deepseek", loopback: false } });
  }

  private session(chatId: string): SessionView {
    const all = this.stored.get(chatId) ?? [];
    const rolled = all.some((x) => x.row.compaction?.rollback === "done");
    const onPath = all.filter((x) => x.row.onPath);
    const summary = !rolled && onPath.some((x) => x.row.compaction !== null);
    const since = summary ? onPath.findIndex((x) => x.row.compaction !== null) + 1 : onPath.length;
    return { turns: since, tokens: since * 1390, summary, dropped: all.length - onPath.length, missing: 0 };
  }

  private stepDone(id: SetupStepId): UiState["setup"] {
    return { steps: this.state.setup.steps.map((s) => (s.id === id ? { ...s, done: true } : s)) };
  }

  private withTurns(by: number): UiState["runtime"] {
    return { ...this.state.runtime, relays: this.state.runtime.relays.map((r, i) => (i === 0 ? { ...r, turns: Math.max(0, r.turns + by) } : r)) };
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

  /** The state changed: its parts that did go to the page under the next revision. */
  private push(patch: Partial<Omit<UiState, "rev">>): void {
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
