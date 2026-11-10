// The live buffer (DESIGN §2 step 6, §8 Live): the latest turn of each chat as its agents' trace
// tells it, kept in memory while the extension runs, and the pages that opened a chat's live view,
// which hear every change of it. A turn's events are numbered from 1 with no gap; the buffer takes
// each once, in order, so what a page reads never has a hole in it.
//
// Beside the events, it holds what each agent's model call in flight has written so far (its
// partial), from the deltas the runtime sends as the answer arrives: a page that follows the chat
// hears each delta, and one that opens the view mid-call gets the partial with it. A partial is gone
// the moment its call's own entry arrives, which holds the whole answer; nothing of it is stored.

import type { TraceDelta, TraceRecord, TurnKind } from "../../core/ports";
import type { TurnFacts } from "../../link/contract";
import type { TransportSettings } from "../../link/settings";
import type { LiveChange, LiveEnded, LivePartial, LiveView, RunningTurn, UiDeltaPush, UiLivePush } from "../../shared/ui";
import { UI_VERSION } from "../../shared/ui";
import type { BackendHost } from "./spindle";

/** What a call in flight has written so far, and when its first delta arrived. */
interface InFlight {
  call: number;
  text: string;
  reasoning: string;
  at: number;
}

interface LiveTurn {
  userId: string;
  chatId: string;
  turn: string;
  relay: string;
  kind: TurnKind;
  messageId: string | null;
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
}

export interface LiveEnv {
  now(): number;
  transport(userId: string): Promise<TransportSettings>;
}

const SEP = "\u0000";
const chatKey = (userId: string, chatId: string): string => `${userId}${SEP}${chatId}`;

/**
 * How many pings in a row must leave a running turn out before it counts as dropped. One may have
 * left the runtime just before the turn became its own; a second can't have. Not a setting: it is
 * the least number that tells the two apart.
 */
const PINGS_WITHOUT = 2;

export class LiveBuffer {
  /** Each chat's latest turn, the chat whose turn began longest ago first. */
  private readonly byChat = new Map<string, LiveTurn>();
  private readonly byTurn = new Map<string, LiveTurn>();
  /** The pages that opened each chat's live view, by their sessions. */
  private readonly watchers = new Map<string, Set<string>>();
  private readonly changed: ((userId: string) => void)[] = [];

  constructor(
    private readonly host: Pick<BackendHost, "frontend">,
    private readonly env: LiveEnv,
  ) {}

  /** The turns a user's chats are running, or the chats LumiAH answered, changed. */
  onChange(listener: (userId: string) => void): void {
    this.changed.push(listener);
  }

  private tell(userId: string): void {
    for (const listener of this.changed) listener(userId);
  }

  private send(turn: LiveTurn, push: UiLivePush | UiDeltaPush): void {
    const sessions = this.watchers.get(chatKey(turn.userId, turn.chatId));
    if (sessions === undefined) return;
    for (const session of sessions) this.host.frontend.send(push, turn.userId, session);
  }

  private say(turn: LiveTurn, change: LiveChange): void {
    this.send(turn, { lah: UI_VERSION, type: "lah.live", chatId: turn.chatId, change });
  }

  private viewOf(turn: LiveTurn, events: TraceRecord[]): LiveView {
    const partials = [...turn.partials].map(([agentId, p]): LivePartial => ({ agentId, call: p.call, text: p.text, reasoning: p.reasoning, at: p.at }));
    return { chatId: turn.chatId, turn: turn.turn, kind: turn.kind, messageId: turn.messageId, startedAt: turn.startedAt, ended: turn.ended, events, partials };
  }

  /** A turn began (its tag was spent): it is its chat's live turn from now on. */
  async begin(userId: string, relay: string, facts: Omit<TurnFacts, "settings">): Promise<void> {
    const key = chatKey(userId, facts.chat);
    const earlier = this.byChat.get(key);
    if (earlier !== undefined) this.byTurn.delete(earlier.turn);
    const turn: LiveTurn = { userId, chatId: facts.chat, turn: facts.turn, relay, kind: facts.kind, messageId: facts.target.message, startedAt: this.env.now(), ended: null, events: [], overAt: null, unnamed: 0, partials: new Map(), answered: new Map() };
    // Put last, so the chats let go for room are the ones whose turns began longest ago.
    this.byChat.delete(key);
    this.byChat.set(key, turn);
    this.byTurn.set(turn.turn, turn);
    this.say(turn, { view: this.viewOf(turn, []) });
    this.tell(userId);
    const most = (await this.env.transport(userId)).live.chats;
    for (const [k, held] of [...this.byChat]) {
      if (this.byChat.size <= most) break;
      // A turn still running is never let go for room: its Stop must stay within reach.
      if (held.ended === null) continue;
      this.byChat.delete(k);
      this.byTurn.delete(held.turn);
      this.tell(held.userId);
    }
  }

  /**
   * `trace.push`: a runtime's trace records, in the order its turns traced them. Each is taken when
   * it is the next of its turn; one the buffer holds already counts and is left out; one past a gap,
   * past the most a turn keeps, or of a turn that isn't this user's live one, is left. How many
   * counted.
   */
  async push(userId: string, records: readonly unknown[]): Promise<number> {
    const most = (await this.env.transport(userId)).live.events;
    let taken = 0;
    const fresh = new Map<LiveTurn, TraceRecord[]>();
    for (const raw of records) {
      const record = raw as Partial<TraceRecord> | null;
      if (record === null || typeof record !== "object" || typeof record.turn !== "string" || typeof record.seq !== "number" || typeof record.event !== "object" || record.event === null) continue;
      const turn = this.byTurn.get(record.turn);
      if (turn === undefined || turn.userId !== userId) continue;
      if (record.seq <= turn.events.length) {
        taken++;
        continue;
      }
      if (record.seq !== turn.events.length + 1 || turn.events.length >= most) continue;
      const kept: TraceRecord = { turn: turn.turn, chatId: turn.chatId, seq: record.seq, event: record.event };
      turn.events.push(kept);
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
      if (event.kind === "turn_ended") {
        turn.partials.clear();
        if (turn.ended === null) {
          turn.ended = { state: event.status, at: event.at, ...(event.reason !== undefined ? { reason: event.reason } : {}) };
          this.tell(turn.userId);
        }
      }
    }
    for (const [turn, events] of fresh) this.say(turn, { turn: turn.turn, events, ended: turn.ended });
    return taken;
  }

  /**
   * A runtime's deltas (`trace.deltas`), in the order they arrived: each joins its agent's partial
   * and goes on to the pages following the chat, saying how much of the call's text and reasoning
   * came before it, so a page can tell a delta it holds already from one it missed. One of a turn
   * that isn't this runtime's live one, or of a call that is over, is left.
   */
  deltas(userId: string, relay: string, deltas: readonly TraceDelta[]): void {
    for (const delta of deltas) {
      const turn = this.byTurn.get(delta.turn);
      if (turn === undefined || turn.userId !== userId || turn.relay !== relay || turn.ended !== null) continue;
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
      this.send(turn, { lah: UI_VERSION, type: "lah.live.delta", chatId: turn.chatId, delta: { turn: turn.turn, agentId: delta.agentId, call: delta.call, ...(delta.text !== undefined ? { text: delta.text } : {}), ...(delta.reasoning !== undefined ? { reasoning: delta.reasoning } : {}), before, at: delta.at } });
    }
  }

  private lose(turn: LiveTurn, reason: string): void {
    if (turn.ended !== null) return;
    turn.partials.clear();
    turn.ended = { state: "lost", at: this.env.now(), reason };
    this.say(turn, { turn: turn.turn, events: [], ended: turn.ended });
    this.tell(turn.userId);
  }

  /** A runtime pinged, naming the turns it answers: a running turn of its own that it leaves out twice running was dropped without a word. */
  named(userId: string, relay: string, turns: readonly string[]): void {
    const named = new Set(turns);
    for (const turn of this.byTurn.values()) {
      if (turn.userId !== userId || turn.relay !== relay || turn.ended !== null) continue;
      if (named.has(turn.turn)) turn.unnamed = 0;
      else if (++turn.unnamed >= PINGS_WITHOUT) this.lose(turn, "The runtime stopped answering this reply without saying how it ended (it restarted, or its trace never arrived).");
    }
  }

  /** Lumiverse said a generation is over. */
  over(generationId: string): void {
    const turn = this.byTurn.get(generationId);
    if (turn !== undefined && turn.overAt === null) turn.overAt = this.env.now();
  }

  /** Every so often: a turn whose generation ended a while ago and that never said it ended is lost. */
  async tick(): Promise<void> {
    const now = this.env.now();
    for (const turn of [...this.byTurn.values()]) {
      if (turn.ended !== null || turn.overAt === null) continue;
      const lostMs = (await this.env.transport(turn.userId)).live.lostMs;
      if (now - turn.overAt > lostMs) this.lose(turn, "Lumiverse ended this reply's generation and the runtime never said how its turn ended.");
    }
  }

  /** The runtime answering a turn that still runs; null when it has ended or isn't this user's. */
  relayOf(userId: string, chatId: string, turnId: string): string | null {
    const turn = this.byTurn.get(turnId);
    return turn !== undefined && turn.userId === userId && turn.chatId === chatId && turn.ended === null ? turn.relay : null;
  }

  /** The turns LumiAH is answering for a user now. */
  runningOf(userId: string): RunningTurn[] {
    const out: RunningTurn[] = [];
    for (const turn of this.byChat.values()) if (turn.userId === userId && turn.ended === null) out.push({ chatId: turn.chatId, turn: turn.turn, kind: turn.kind, startedAt: turn.startedAt });
    return out;
  }

  /** The chats of a user's that LumiAH has answered since the extension started and still remembers. */
  chatsOf(userId: string): string[] {
    const out: string[] = [];
    for (const turn of this.byChat.values()) if (turn.userId === userId) out.push(turn.chatId);
    return out;
  }

  /** `lah.live.open`: the chat's latest turn with its first page of events and its calls in flight, and the page hears the chat's changes from now on. */
  async open(userId: string, chatId: string, session: string | undefined): Promise<{ live: LiveView | null; next: number | null }> {
    const key = chatKey(userId, chatId);
    if (session !== undefined) {
      const sessions = this.watchers.get(key) ?? new Set<string>();
      sessions.add(session);
      this.watchers.set(key, sessions);
    }
    const turn = this.byChat.get(key);
    if (turn === undefined) return { live: null, next: null };
    const page = (await this.env.transport(userId)).live.page;
    // The view is put together in one go, after the last wait: no delta can arrive between its events and its partials.
    const events = turn.events.slice(0, page);
    return { live: this.viewOf(turn, events), next: turn.events.length > events.length ? events.length + 1 : null };
  }

  /** `lah.live.events`: a turn's events from `from` on, a page of them; null when the turn is no longer its chat's live one. */
  async events(userId: string, chatId: string, turnId: string, from: number): Promise<{ events: TraceRecord[]; next: number | null } | null> {
    const turn = this.byChat.get(chatKey(userId, chatId));
    if (turn === undefined || turn.turn !== turnId) return null;
    const page = (await this.env.transport(userId)).live.page;
    const events = turn.events.slice(from - 1, from - 1 + page);
    const read = from - 1 + events.length;
    return { events, next: turn.events.length > read ? read + 1 : null };
  }

  /** `lah.live.close`: the page stops hearing the chat. */
  close(userId: string, chatId: string, session: string | undefined): void {
    if (session === undefined) return;
    const key = chatKey(userId, chatId);
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
