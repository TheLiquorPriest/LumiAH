// The live buffer (DESIGN §2 step 6, §8 Live): the latest run of each stream as its agents' trace
// tells it, kept in memory while the extension runs, and the pages that opened a stream's live view,
// which hear every change of it. A stream is what a page follows: a chat's reply turns under the
// chat's id, a job's run under the job's id, a side session's turns under the session's id. A run's
// events are numbered from 1 with no gap; the buffer takes each once, in order, so what a page reads
// never has a hole in it.
//
// A reply's run begins when its tag is spent (`turn.begin`). A job's run and a side session's turn
// begin in the runtime, so the buffer learns of them from their first event.
//
// Beside the events, it holds what each agent's model call in flight has written so far (its
// partial), from the deltas the runtime sends as the answer arrives: a page that follows the stream
// hears each delta, and one that opens the view mid-call gets the partial with it. A partial is gone
// the moment its call's own entry arrives, which holds the whole answer; nothing of it is stored.
//
// Each account's runs are held apart: an account's settings and runs trim, crowd out and end only
// its own. What protects the worker all accounts share is bounded by ceilings no account sets
// (settings.ts `CEILINGS`): the events of one run, an account's chats kept and runs under way, and
// every account's events and runs together.

import type { RunKind, TraceDelta, TraceRecord } from "../../core/ports";
import { CEILINGS, type TransportSettings } from "../../link/settings";
import type { CauseCode, LiveChange, LiveEnded, LivePartial, LiveView, NoPart, RunningTurn, RunPlace, StreamId, UiDeltaPush, UiLivePush } from "../../shared/ui";
import { UI_VERSION } from "../../shared/ui";
import { causeOf } from "./cause";
import type { BackendHost } from "./spindle";

/** What a call in flight has written so far, and when its first delta arrived. */
interface InFlight {
  call: number;
  text: string;
  reasoning: string;
  at: number;
}

/**
 * The runtime a run that runs here, built in, is kept under (DESIGN §25): no runtime's. A runtime's
 * registration has an id of its own, never empty, so the two can't be taken for each other.
 */
export const BUILTIN = "";

/**
 * A run as it begins: the stream it is followed under, its chat (null: a side session about none),
 * its id, what it is, the message a reply targets, and, where its starter says, where it runs and
 * (a built-in reply's turn) when the time it has before the reply ends.
 */
export interface RunStart {
  stream: StreamId;
  chatId: string | null;
  turn: string;
  kind: RunKind;
  messageId: string | null;
  place?: RunPlace;
  replyBy?: number | null;
}

/** A run that ended, by its own word or lost. */
export interface RunOver extends RunStart {
  userId: string;
  ended: LiveEnded;
}

interface LiveTurn extends RunStart {
  userId: string;
  relay: string;
  startedAt: number;
  ended: LiveEnded | null;
  events: TraceRecord[];
  /** When Lumiverse said the turn's generation was over; null while it runs. */
  overAt: number | null;
  /** How many of its runtime's pings in a row didn't name it. */
  unnamed: number;
  /** Each agent's call in flight, by the agent's id. */
  partials: Map<string, InFlight>;
  /** How many answers each agent has given: its calls are counted as its answers are, so a delta of a call already answered is one that came late and is left. */
  answered: Map<string, number>;
  /** The user holds its agents at their next round (§18), as its trace last said. */
  paused: boolean;
  /** LumiAH had no part in the reply this turn was for (§25), and why: said with how the turn ended. */
  noPart: NoPart | null;
  /** Why, as a code a page can act on, where whoever said LumiAH had no part knew one the trace can't tell (the user's skip, a first half that never returned). */
  cause: CauseCode | null;
  /** The buffer was only told of it by a runtime's trace record: no generation of Lumiverse's stands behind it, so a runtime can start any number of them. */
  told: boolean;
}

/** What the buffer holds of one account: the same runs twice, by what a page follows and by their ids. */
interface Account {
  /** Each stream's latest run, the stream whose run began longest ago first. */
  streams: Map<StreamId, LiveTurn>;
  runs: Map<string, LiveTurn>;
}

export interface LiveEnv {
  now(): number;
  transport(userId: string): Promise<TransportSettings>;
  /** How long a runtime's link has been gone, in ms; null while it is linked. */
  linkGoneFor(userId: string, relay: string): number | null;
  /** Whether a permission LumiAH can answer no chat without is missing now: a turn that fails then fails for that. Absent: none is. */
  missing?(): boolean;
}

/**
 * The buffer's ceilings (settings.ts `CEILINGS`, which says what each bounds): fixed, because a
 * bound an account could raise would not protect the worker it shares with the others. A test gives
 * smaller ones, so it needn't fill a worker to reach one.
 */
export interface LiveCeilings {
  liveEvents: number;
  liveRunning: number;
  liveChats: number;
  liveEventsTotal: number;
  liveRunsTotal: number;
}

const SEP = "\u0000";
const streamKey = (userId: string, stream: StreamId): string => `${userId}${SEP}${stream}`;

/**
 * How many pings in a row must leave a running turn out before it counts as dropped. One may have
 * left the runtime just before the turn became its own; a second can't have. Not a setting: it is
 * the least number that tells the two apart.
 */
const PINGS_WITHOUT = 2;

/** The run a first event starts, when it is one the runtime began itself (a job's run, a side session's turn); null for anything else. */
function begunBy(record: TraceRecord): RunStart | null {
  const { event } = record;
  if (record.seq !== 1 || event.kind !== "turn_started") return null;
  const stream = event.generation === "job" ? (event.job ?? record.turn) : event.generation === "side" ? event.side : undefined;
  if (stream === undefined || stream === "") return null;
  return { stream, chatId: record.chatId === "" ? null : record.chatId, turn: record.turn, kind: event.generation, messageId: null };
}

/** An account's run that began longest ago among those that have ended. */
function oldestEnded(account: Account): LiveTurn | undefined {
  for (const turn of account.streams.values()) if (turn.ended !== null) return turn;
  return undefined;
}

/**
 * The run under way that gives way when more are under way than the buffer follows: the oldest it
 * was only told of by a trace record, since a runtime can start those at will and a reply's turn
 * should not pay for them; where every one is a reply's, the oldest of those, the likeliest to be
 * one whose end never arrived.
 */
function givesWay(account: Account): LiveTurn | undefined {
  let first: LiveTurn | undefined;
  for (const turn of account.streams.values()) {
    if (turn.ended !== null) continue;
    if (turn.told) return turn;
    first ??= turn;
  }
  return first;
}

const crowdedOut = (most: number, whose: string): string => `At most ${most} runs under way are followed ${whose}, and this was the one that gave way when another began: its live view ends here. The run itself wasn't stopped.`;

export class LiveBuffer {
  private readonly accounts = new Map<string, Account>();
  /** The runs and the events held for every account together, counted as they come and go so that no event has to sum them. */
  private held = 0;
  private kept = 0;
  /** The pages that opened each stream's live view, by their sessions. */
  private readonly watchers = new Map<string, Set<string>>();
  private readonly changed: ((userId: string) => void)[] = [];
  private readonly finished: ((run: RunOver) => void)[] = [];

  constructor(
    private readonly host: Pick<BackendHost, "frontend">,
    private readonly env: LiveEnv,
    private readonly ceilings: LiveCeilings = CEILINGS,
  ) {}

  /** The turns a user has under way, or the chats LumiAH answered, changed. */
  onChange(listener: (userId: string) => void): void {
    this.changed.push(listener);
  }

  /** A run ended, by its own word or lost. */
  onEnded(listener: (run: RunOver) => void): void {
    this.finished.push(listener);
  }

  private tell(userId: string): void {
    for (const listener of this.changed) listener(userId);
  }

  private send(turn: LiveTurn, push: UiLivePush | UiDeltaPush): void {
    const sessions = this.watchers.get(streamKey(turn.userId, turn.stream));
    if (sessions === undefined) return;
    for (const session of sessions) this.host.frontend.send(push, turn.userId, session);
  }

  private say(turn: LiveTurn, change: LiveChange): void {
    this.send(turn, { lah: UI_VERSION, type: "lah.live", stream: turn.stream, change });
  }

  private viewOf(turn: LiveTurn, events: TraceRecord[]): LiveView {
    const partials = [...turn.partials].map(([agentId, p]): LivePartial => ({ agentId, call: p.call, text: p.text, reasoning: p.reasoning, at: p.at }));
    return { stream: turn.stream, chatId: turn.chatId, turn: turn.turn, kind: turn.kind, messageId: turn.messageId, startedAt: turn.startedAt, ended: turn.ended, events, partials, place: turn.place ?? (turn.relay === BUILTIN ? "builtin" : "runtime"), ...(turn.replyBy !== undefined ? { replyBy: turn.replyBy } : {}) };
  }

  /**
   * Why a turn that failed, or whose reply LumiAH had no part in, came to that, as a code a page
   * can act on (cause.ts): what its ender said, else a needed permission that is missing, else what
   * its own trace tells. Null for a turn that ended well, and where none of these is known.
   */
  private causeFor(turn: LiveTurn, ended: LiveEnded): CauseCode | null {
    if (ended.cause !== undefined) return ended.cause;
    if (turn.cause !== null) return turn.cause;
    const failed = ended.state === "failed" || turn.noPart?.why === "failed";
    if (!failed && turn.noPart === null) return null;
    return failed && this.env.missing?.() === true ? "permission" : causeOf(turn.events);
  }

  private end(turn: LiveTurn, ended: LiveEnded): void {
    if (turn.ended !== null) return;
    turn.partials.clear();
    const cause = this.causeFor(turn, ended);
    turn.ended = { ...ended, ...(turn.noPart !== null ? { noPart: turn.noPart } : {}), ...(cause !== null ? { cause } : {}) };
    turn.paused = false;
    this.tell(turn.userId);
    for (const listener of this.finished) listener({ userId: turn.userId, stream: turn.stream, chatId: turn.chatId, turn: turn.turn, kind: turn.kind, messageId: turn.messageId, ended: turn.ended });
  }

  private forget(turn: LiveTurn): void {
    const account = this.accounts.get(turn.userId);
    if (account === undefined || account.runs.get(turn.turn) !== turn) return;
    account.runs.delete(turn.turn);
    account.streams.delete(turn.stream);
    this.held--;
    this.kept -= turn.events.length;
    if (account.streams.size === 0) this.accounts.delete(turn.userId);
  }

  /**
   * Room for one more run under way of an account's. One still running is never let go for room,
   * so their number needs a bound of its own, and past it one must end: `givesWay` says which. Its
   * view ends as lost, in words; the run itself is not touched.
   */
  private uncrowd(userId: string): void {
    const account = this.accounts.get(userId);
    if (account === undefined) return;
    let under = 0;
    for (const turn of account.streams.values()) if (turn.ended === null) under++;
    if (under < this.ceilings.liveRunning) return;
    const going = givesWay(account);
    if (going !== undefined) this.lose(going, crowdedOut(this.ceilings.liveRunning, "for one account"));
  }

  /**
   * Room for one more run under every account's total: an ended run goes, the one begun longest
   * ago of the account that holds the most, so the account that fills the buffer is the one that
   * pays for it. Where no account has an ended one, a run under way of the account that holds the
   * most ends as lost and goes.
   */
  private roomForAll(): void {
    while (this.held >= this.ceilings.liveRunsTotal) {
      let fullest: Account | null = null;
      let spare: LiveTurn | null = null;
      let spareOf = 0;
      for (const account of this.accounts.values()) {
        if (fullest === null || account.streams.size > fullest.streams.size) fullest = account;
        if (spare !== null && account.streams.size <= spareOf) continue;
        const ended = oldestEnded(account);
        if (ended === undefined) continue;
        spare = ended;
        spareOf = account.streams.size;
      }
      const going = spare ?? (fullest === null ? undefined : givesWay(fullest));
      if (going === undefined) return;
      this.lose(going, crowdedOut(this.ceilings.liveRunsTotal, "for all accounts together"));
      this.forget(going);
      this.tell(going.userId);
    }
  }

  private add(userId: string, relay: string, run: RunStart, told: boolean): LiveTurn {
    const mine = this.accounts.get(userId);
    // The stream's earlier run gives way to this one, and so does a run that had its id.
    for (const earlier of [mine?.streams.get(run.stream), mine?.runs.get(run.turn)]) if (earlier !== undefined) this.forget(earlier);
    // Room is made before the run is held, so it is never the one that goes.
    this.uncrowd(userId);
    this.roomForAll();
    let account = this.accounts.get(userId);
    if (account === undefined) {
      account = { streams: new Map(), runs: new Map() };
      this.accounts.set(userId, account);
    }
    const turn: LiveTurn = { ...run, userId, relay, startedAt: this.env.now(), ended: null, events: [], overAt: null, unnamed: 0, partials: new Map(), answered: new Map(), paused: false, noPart: null, cause: null, told };
    // Put last, so the streams let go for room are the ones whose turns began longest ago.
    account.streams.set(run.stream, turn);
    account.runs.set(turn.turn, turn);
    this.held++;
    this.say(turn, { view: this.viewOf(turn, []) });
    this.tell(userId);
    return turn;
  }

  /** An account's streams, cut to its own "Chats kept" and the ceiling over it: only its own are let go. */
  private room(userId: string, chats: number): void {
    const account = this.accounts.get(userId);
    if (account === undefined) return;
    const most = Math.min(chats, this.ceilings.liveChats);
    for (const held of [...account.streams.values()]) {
      if (account.streams.size <= most) break;
      // A turn still running is never let go for room: its Stop must stay within reach.
      if (held.ended === null) continue;
      this.forget(held);
      this.tell(userId);
    }
  }

  /** A reply's run began (its tag was spent): it is its chat's live turn from now on. */
  async begin(userId: string, relay: string, run: RunStart): Promise<void> {
    this.add(userId, relay, run, false);
    this.room(userId, (await this.env.transport(userId)).live.chats);
  }

  /**
   * `trace.push`: a runtime's trace records, in the order its runs traced them. Each is taken when
   * it is the next of its run; one the buffer holds already counts and is left out; one past a gap,
   * past the most a run keeps or every account's runs keep together, or of a run that isn't this
   * user's live one, is left. The first event of a job's run or a side session's turn starts that
   * run's view. How many counted.
   */
  async push(userId: string, relay: string, records: readonly unknown[]): Promise<number> {
    const { live } = await this.env.transport(userId);
    const most = Math.min(live.events, this.ceilings.liveEvents);
    let taken = 0;
    const fresh = new Map<LiveTurn, TraceRecord[]>();
    for (const raw of records) {
      const record = raw as Partial<TraceRecord> | null;
      if (record === null || typeof record !== "object" || typeof record.turn !== "string" || typeof record.seq !== "number" || typeof record.event !== "object" || record.event === null) continue;
      let turn = this.accounts.get(userId)?.runs.get(record.turn);
      if (turn === undefined) {
        const run = begunBy({ turn: record.turn, chatId: typeof record.chatId === "string" ? record.chatId : "", seq: record.seq, event: record.event });
        if (run === null) continue;
        turn = this.add(userId, relay, run, true);
        this.room(userId, live.chats);
      }
      if (record.seq <= turn.events.length) {
        taken++;
        continue;
      }
      if (record.seq !== turn.events.length + 1 || turn.events.length >= most || this.kept >= this.ceilings.liveEventsTotal) continue;
      const kept: TraceRecord = { turn: turn.turn, chatId: typeof record.chatId === "string" ? record.chatId : (turn.chatId ?? ""), seq: record.seq, event: record.event };
      turn.events.push(kept);
      this.kept++;
      taken++;
      const list = fresh.get(turn) ?? [];
      list.push(kept);
      fresh.set(turn, list);
      const event = kept.event;
      if (event.kind === "turn_started") turn.startedAt = event.at;
      // The entry that ends a call holds all the call wrote (or why it wrote nothing more): its partial has done its work. A call made again after a retry keeps its number and starts its partial anew.
      if (event.kind === "agent_entry" && (event.entry.kind === "answer" || event.entry.kind === "tools_refused" || event.entry.kind === "retry" || event.entry.kind === "stop")) turn.partials.delete(event.agentId);
      if (event.kind === "agent_entry" && event.entry.kind === "answer") turn.answered.set(event.agentId, (turn.answered.get(event.agentId) ?? 0) + 1);
      if (event.kind === "agent_idle") turn.partials.delete(event.agentId);
      if ((event.kind === "turn_paused" || event.kind === "turn_resumed") && turn.ended === null && turn.paused !== (event.kind === "turn_paused")) {
        turn.paused = event.kind === "turn_paused";
        this.tell(userId);
      }
      if (event.kind === "turn_ended") this.end(turn, { state: event.status, at: event.at, ...(event.reason !== undefined ? { reason: event.reason } : {}) });
    }
    // A run a later record of the same batch replaced or pushed out has no view left to add to.
    for (const [turn, events] of fresh) if (this.accounts.get(userId)?.runs.get(turn.turn) === turn) this.say(turn, { turn: turn.turn, events, ended: turn.ended });
    return taken;
  }

  /**
   * A runtime's deltas (`trace.deltas`), in the order they arrived: each joins its agent's partial
   * and goes on to the pages following the stream, saying how much of the call's text and reasoning
   * came before it, so a page can tell a delta it holds already from one it missed. One of a turn
   * that isn't this runtime's live one, or of a call that is over, is left.
   */
  deltas(userId: string, relay: string, deltas: readonly TraceDelta[]): void {
    for (const delta of deltas) {
      const turn = this.accounts.get(userId)?.runs.get(delta.turn);
      if (turn === undefined || turn.relay !== relay || turn.ended !== null) continue;
      if (delta.text === undefined && delta.reasoning === undefined) continue;
      let partial = turn.partials.get(delta.agentId);
      if (delta.call <= (turn.answered.get(delta.agentId) ?? 0) || (partial !== undefined && delta.call < partial.call)) continue;
      // A call later than the one held is the agent's next: its partial starts empty.
      if (partial === undefined || delta.call > partial.call) {
        partial = { call: delta.call, text: "", reasoning: "", at: delta.at };
        turn.partials.set(delta.agentId, partial);
      }
      const before = { text: partial.text.length, reasoning: partial.reasoning.length };
      if (delta.text !== undefined) partial.text += delta.text;
      if (delta.reasoning !== undefined) partial.reasoning += delta.reasoning;
      this.send(turn, { lah: UI_VERSION, type: "lah.live.delta", stream: turn.stream, delta: { turn: turn.turn, agentId: delta.agentId, call: delta.call, ...(delta.text !== undefined ? { text: delta.text } : {}), ...(delta.reasoning !== undefined ? { reasoning: delta.reasoning } : {}), before, at: delta.at } });
    }
  }

  private lose(turn: LiveTurn, reason: string): void {
    if (turn.ended !== null) return;
    this.end(turn, { state: "lost", at: this.env.now(), reason });
    this.say(turn, { turn: turn.turn, events: [], ended: turn.ended });
  }

  /** A runtime pinged, naming the runs it works on: a running one of its own that it leaves out twice running was dropped without a word. */
  named(userId: string, relay: string, turns: readonly string[]): void {
    const named = new Set(turns);
    for (const turn of this.accounts.get(userId)?.runs.values() ?? []) {
      if (turn.relay !== relay || turn.ended !== null) continue;
      if (named.has(turn.turn)) turn.unnamed = 0;
      else if (++turn.unnamed >= PINGS_WITHOUT) this.lose(turn, "The runtime stopped working on this without saying how it ended (it restarted, or its trace never arrived).");
    }
  }

  /**
   * Lumiverse said a generation is over. It names no account here, and a run's id is its account's
   * own to give (a runtime names its jobs' runs), so each account is asked for a run by this id: no
   * index across accounts exists for one of them to write over.
   */
  over(generationId: string): void {
    for (const account of this.accounts.values()) {
      const turn = account.runs.get(generationId);
      if (turn !== undefined && turn.overAt === null) turn.overAt = this.env.now();
    }
  }

  /**
   * Every so often: a turn whose generation ended a while ago and that never said it ended is
   * lost, and so is a run in a runtime whose link has been gone for as long as a runtime itself
   * waits for the extension before it ends its work (`runtime.lostMs`): neither a ping nor a
   * generation's end would ever come to end it.
   */
  async tick(): Promise<void> {
    const now = this.env.now();
    for (const [userId, account] of [...this.accounts]) {
      const waiting = [...account.streams.values()].filter((turn) => turn.ended === null && (turn.overAt !== null || turn.relay !== BUILTIN));
      if (waiting.length === 0) continue;
      const { live, runtime } = await this.env.transport(userId);
      for (const turn of waiting) {
        // The wait may have seen it end, replaced or let go.
        if (turn.ended !== null || account.runs.get(turn.turn) !== turn) continue;
        if (turn.overAt !== null && now - turn.overAt > live.lostMs) {
          this.lose(turn, turn.relay === BUILTIN ? "Lumiverse ended this reply's generation, and the turn never said how it ended." : "Lumiverse ended this reply's generation and the runtime never said how its turn ended.");
          continue;
        }
        if (turn.relay === BUILTIN) continue;
        const gone = this.env.linkGoneFor(userId, turn.relay);
        if (gone !== null && gone >= runtime.lostMs) this.lose(turn, `The runtime this ran in went away: its link has been gone for ${Math.round(gone / 1000)} seconds. The run ended with the runtime${turn.kind === "job" ? "; once the runtime is back, the job shows as interrupted" : ""}.`);
      }
    }
  }

  /** A run of the user's that still runs, by its stream and id: the runtime working on it, and what it is; null when it has ended or isn't theirs. */
  running(userId: string, stream: StreamId, turnId: string): { relay: string; kind: RunKind; chatId: string | null; paused: boolean } | null {
    const turn = this.accounts.get(userId)?.runs.get(turnId);
    return turn !== undefined && turn.stream === stream && turn.ended === null ? { relay: turn.relay, kind: turn.kind, chatId: turn.chatId, paused: turn.paused } : null;
  }

  /** The stream a run of the user's is followed under, while the buffer holds it; null when it doesn't. */
  streamOf(userId: string, turnId: string): StreamId | null {
    return this.accounts.get(userId)?.runs.get(turnId)?.stream ?? null;
  }

  /**
   * LumiAH had no part in the reply a turn was for (§25): said with how the turn ended, now when it
   * has ended already, else when it does. `cause`: why, as a code, where the caller knows one the
   * turn's trace can't tell.
   */
  noPart(userId: string, turnId: string, noPart: NoPart, cause?: CauseCode): void {
    const turn = this.accounts.get(userId)?.runs.get(turnId);
    if (turn === undefined) return;
    turn.noPart = noPart;
    if (cause !== undefined) turn.cause = cause;
    if (turn.ended === null) return;
    const { cause: _before, ...ended } = turn.ended;
    const why = this.causeFor(turn, ended);
    turn.ended = { ...ended, noPart, ...(why !== null ? { cause: why } : {}) };
    this.say(turn, { turn: turn.turn, events: [], ended: turn.ended });
    this.tell(userId);
  }

  /**
   * A run ends by the backend's own word: its core never traced how it ended (it never began, or
   * the prompt had to go on without it). One that has ended already is left as it ended.
   */
  finish(userId: string, turnId: string, ended: LiveEnded): void {
    const turn = this.accounts.get(userId)?.runs.get(turnId);
    if (turn === undefined || turn.ended !== null) return;
    this.end(turn, ended);
    this.say(turn, { turn: turn.turn, events: [], ended: turn.ended });
  }

  /** A stream's latest run, whole: every event the buffer holds of it. Null when the stream has had none since the extension started, or the buffer has let it go. */
  whole(userId: string, stream: StreamId): LiveView | null {
    const turn = this.accounts.get(userId)?.streams.get(stream);
    return turn === undefined ? null : this.viewOf(turn, [...turn.events]);
  }

  /** The turns under way for a user: replies, jobs and side sessions' turns. */
  runningOf(userId: string): RunningTurn[] {
    const out: RunningTurn[] = [];
    for (const turn of this.accounts.get(userId)?.streams.values() ?? []) {
      if (turn.ended !== null) continue;
      out.push({ stream: turn.stream, chatId: turn.chatId, turn: turn.turn, kind: turn.kind, startedAt: turn.startedAt, paused: turn.paused, place: turn.place ?? (turn.relay === BUILTIN ? "builtin" : "runtime"), ...(turn.replyBy !== undefined ? { replyBy: turn.replyBy } : {}) });
    }
    return out;
  }

  /** The chats of a user's whose replies LumiAH has answered since the extension started and still remembers. */
  chatsOf(userId: string): string[] {
    const out: string[] = [];
    for (const turn of this.accounts.get(userId)?.streams.values() ?? []) if (turn.chatId !== null && turn.stream === turn.chatId) out.push(turn.chatId);
    return out;
  }

  /** `lah.live.open`: the stream's latest turn with its first page of events and its calls in flight, and the page hears the stream's changes from now on. */
  async open(userId: string, stream: StreamId, session: string | undefined): Promise<{ live: LiveView | null; next: number | null }> {
    if (session !== undefined) {
      const key = streamKey(userId, stream);
      const sessions = this.watchers.get(key) ?? new Set<string>();
      sessions.add(session);
      this.watchers.set(key, sessions);
    }
    const page = (await this.env.transport(userId)).live.page;
    // The view is put together in one go, after the last wait: no delta can arrive between its events and its partials.
    const turn = this.accounts.get(userId)?.streams.get(stream);
    if (turn === undefined) return { live: null, next: null };
    const events = turn.events.slice(0, page);
    return { live: this.viewOf(turn, events), next: turn.events.length > events.length ? events.length + 1 : null };
  }

  /** `lah.live.events`: a turn's events from `from` on, a page of them; null when the turn is no longer its stream's live one. */
  async events(userId: string, stream: StreamId, turnId: string, from: number): Promise<{ events: TraceRecord[]; next: number | null } | null> {
    const page = (await this.env.transport(userId)).live.page;
    const turn = this.accounts.get(userId)?.streams.get(stream);
    if (turn === undefined || turn.turn !== turnId) return null;
    const events = turn.events.slice(from - 1, from - 1 + page);
    const read = from - 1 + events.length;
    return { events, next: turn.events.length > read ? read + 1 : null };
  }

  /** `lah.live.close`: the page stops hearing the stream. */
  close(userId: string, stream: StreamId, session: string | undefined): void {
    if (session === undefined) return;
    const key = streamKey(userId, stream);
    const sessions = this.watchers.get(key);
    if (sessions === undefined) return;
    sessions.delete(session);
    if (sessions.size === 0) this.watchers.delete(key);
  }

  /** A page went away: it hears nothing more. */
  sessionClosed(session: string): void {
    for (const [key, sessions] of this.watchers) {
      sessions.delete(session);
      if (sessions.size === 0) this.watchers.delete(key);
    }
  }
}
