// A turn from the extension's side (DESIGN §2): the prompt interceptor tags a generation on the
// loopback connection with a single-use tag and leaves out the messages the history cutoff hides;
// the runtime shows the tag once and gets the turn back; and the record the turn leaves is written
// on the reply's message once Lumiverse has saved it.
//
// A generation is known from Lumiverse's own events: its start says which chat, what kind and which
// message it writes; its end says the message it saved. The turn's id is its generation's.

import type { ActivatedLore, JsonValue, TurnKind, TurnRecord } from "../../core/ports";
import { recordOf } from "../../core/sessions";
import type { Anchoring, SourceMark, TurnFacts } from "../../link/contract";
import { TAG_PARAM, contentMark } from "../../link/contract";
import { TRANSPORT_DEFAULTS, type TransportSettings } from "../../link/settings";
import type { Chats } from "./chat";
import type { Connections } from "./connections";
import { randomHex } from "./docs";
import { LinkRefused, wordsOf } from "./errors";
import type { RegistryStore } from "./registry";
import type { SettingsStore } from "./settings";
import type { BackendHost, GenerationEnded, GenerationStarted, GenerationStopped, HostGenerationType, InterceptorInput, InterceptorVerdict, PromptMessage } from "./spindle";

/**
 * The interceptor's priority: Lumiverse runs the lowest first, so the largest number there is runs
 * last and sees the prompt as it will be sent (DESIGN §7). Not a setting: any lower value would let
 * another extension change the prompt after the cutoff and the tag.
 */
export const INTERCEPTOR_PRIORITY = Number.MAX_SAFE_INTEGER;

/** The generations LumiAH answers, and the kind of turn each is. Any other (an impersonation, a quiet call of another extension) goes through the loopback untagged, so the runtime passes it on as it came. */
const KINDS: Readonly<Partial<Record<HostGenerationType, TurnKind>>> = { normal: "new", regenerate: "regenerate", swipe: "swipe", continue: "continue" };

export const TAGGED_TYPES: readonly HostGenerationType[] = ["normal", "regenerate", "swipe", "continue"];

interface Generation {
  id: string;
  chatId: string;
  userId: string | null;
  type: HostGenerationType;
  targetMessageId: string | null;
  targetSwipeId: number | null;
  at: number;
  /** Lumiverse said it ended: the message it saved (null: none), and when. */
  ended: { messageId: string | null; at: number } | null;
  stopped: boolean;
}

/** A generation LumiAH tagged, and what became of it. */
export interface Turn {
  /** The turn's id: its generation's. */
  turn: string;
  tag: string;
  userId: string;
  chatId: string;
  kind: TurnKind;
  presetId: string | null;
  /** The persona the prompt was assembled for, where Lumiverse said: its attached world book applies to the chat. */
  personaId: string | null;
  sources: SourceMark[];
  /** The World Info entries Lumiverse activated for the prompt. */
  activated: { entryId: string; bookId: string | null; title: string }[];
  at: number;
  /** The runtime's request that spent the tag, and the runtime it came from; null while unspent. */
  request: string | null;
  relay: string | null;
  /** The turn as the runtime was told, once its target is known. */
  facts: Promise<Omit<TurnFacts, "settings">> | null;
}

interface Pending {
  turn: string;
  userId: string;
  chatId: string;
  target: { message: string | null; swipe: number };
  record: TurnRecord;
  at: number;
}

export interface TurnsDeps {
  chats: Chats;
  connections: Connections;
  registry: RegistryStore;
  settings: SettingsStore;
  now(): number;
}

/** The places of the history messages a prompt leaves out: all but the latest `count`, when only the latest are kept. */
export function cutoff(messages: readonly PromptMessage[], history: TransportSettings["history"]): number[] {
  if (history.keep === "all") return [];
  const places = messages.flatMap((m, i) => (m.history ? [i] : []));
  return places.slice(0, Math.max(0, places.length - history.count));
}

export class Turns {
  private readonly generations = new Map<string, Generation>();
  /** The latest generation started in each chat: how a prompt finds its generation where Lumiverse's context doesn't name it. */
  private readonly latest = new Map<string, string>();
  private readonly byTag = new Map<string, Turn>();
  private readonly byTurn = new Map<string, Turn>();
  /** Each chat's latest tagged turn, by `user chat`. */
  private readonly byChat = new Map<string, Turn>();
  private readonly pending = new Map<string, Pending>();
  private readonly begun: ((turn: Turn, facts: Omit<TurnFacts, "settings">) => void)[] = [];
  private readonly stopped: ((turn: Turn, why: string) => void)[] = [];
  private readonly over: ((generationId: string, chatId: string) => void)[] = [];
  private readonly answered: ((userId: string) => void)[] = [];

  constructor(
    private readonly host: Pick<BackendHost, "log" | "lore">,
    private readonly deps: TurnsDeps,
  ) {}

  /** A turn began: its tag was spent by a runtime. */
  onBegun(listener: (turn: Turn, facts: Omit<TurnFacts, "settings">) => void): void {
    this.begun.push(listener);
  }

  /** Lumiverse stopped a turn's generation. */
  onStopped(listener: (turn: Turn, why: string) => void): void {
    this.stopped.push(listener);
  }

  /** A generation ended or was stopped, whether LumiAH answered it or not. */
  onOver(listener: (generationId: string, chatId: string) => void): void {
    this.over.push(listener);
  }

  /** A reply of the user's was answered and its record written. */
  onAnswered(listener: (userId: string) => void): void {
    this.answered.push(listener);
  }

  turn(id: string): Turn | undefined {
    return this.byTurn.get(id);
  }

  /** The latest turn tagged in a user's chat; none when it has had none since the extension started. */
  ofChat(userId: string, chatId: string): Turn | undefined {
    return this.byChat.get(`${userId}\u0000${chatId}`);
  }

  // ---------------------------------------------------------------- Lumiverse's events

  started(event: GenerationStarted): void {
    const held = this.generations.get(event.generationId);
    if (held !== undefined) {
      // Said again once the reply's message is staged: what it adds is kept, nothing it leaves out is lost.
      held.targetMessageId = event.targetMessageId ?? held.targetMessageId;
      held.targetSwipeId = event.targetSwipeId ?? held.targetSwipeId;
      held.userId = event.userId ?? held.userId;
      return;
    }
    this.generations.set(event.generationId, { id: event.generationId, chatId: event.chatId, userId: event.userId, type: event.type, targetMessageId: event.targetMessageId, targetSwipeId: event.targetSwipeId, at: this.deps.now(), ended: null, stopped: false });
    this.latest.set(event.chatId, event.generationId);
  }

  ended(event: GenerationEnded): void {
    const generation = this.generations.get(event.generationId);
    const ended = { messageId: event.messageId, at: this.deps.now() };
    if (generation !== undefined) generation.ended = ended;
    // One whose start wasn't heard (the extension started mid-generation) is kept as ended, so its turn's record, handed over later, goes on its message at once.
    else this.generations.set(event.generationId, { id: event.generationId, chatId: event.chatId, userId: event.userId, type: "other", targetMessageId: null, targetSwipeId: null, at: ended.at, ended, stopped: false });
    const pending = this.pending.get(event.generationId);
    if (pending !== undefined) {
      this.pending.delete(event.generationId);
      void this.write(pending, event.messageId);
    }
    for (const listener of this.over) listener(event.generationId, event.chatId);
  }

  stoppedBy(event: GenerationStopped): void {
    const generation = this.generations.get(event.generationId);
    if (generation !== undefined) generation.stopped = true;
    const turn = this.byTurn.get(event.generationId);
    if (turn !== undefined) for (const listener of this.stopped) listener(turn, "You stopped the reply in Lumiverse.");
    // Lumiverse keeps what a stopped reply had written, on the message it was writing: a record already handed over goes there.
    const pending = this.pending.get(event.generationId);
    if (pending !== undefined) {
      this.pending.delete(event.generationId);
      void this.write(pending, null);
    }
    for (const listener of this.over) listener(event.generationId, event.chatId);
  }

  // ---------------------------------------------------------------- the interceptor

  /** The generation a prompt belongs to: the one its context names, else the latest started in its chat that isn't tagged yet. */
  private generationOf(input: InterceptorInput): Generation | null {
    if (input.generationId !== null) {
      const named = this.generations.get(input.generationId);
      if (named !== undefined) return named;
      // Its start wasn't heard (the extension started mid-generation): what the context says of it is enough to tag it.
      const made: Generation = { id: input.generationId, chatId: input.chatId, userId: input.userId, type: input.type, targetMessageId: null, targetSwipeId: null, at: this.deps.now(), ended: null, stopped: false };
      this.generations.set(made.id, made);
      return made;
    }
    const id = this.latest.get(input.chatId);
    const generation = id === undefined ? undefined : this.generations.get(id);
    if (generation === undefined || generation.ended !== null || generation.stopped || generation.type !== input.type) return null;
    if (generation.userId !== null && generation.userId !== input.userId) return null;
    return this.byTurn.get(generation.id)?.request != null ? null : generation;
  }

  /**
   * The prompt interceptor (DESIGN §2 step 2). A prompt on any other connection than a loopback is
   * left as it is. On a loopback, the messages the history cutoff hides are left out, and the
   * generation is tagged: the tag goes into the request's body, where the runtime finds it. A prompt
   * preview (a dry run) shows the cutoff and gets no tag, since nothing will be sent.
   */
  async intercept(input: InterceptorInput): Promise<InterceptorVerdict> {
    const kind = KINDS[input.type];
    if (kind === undefined) return {};
    const { connections, chats, settings } = this.deps;
    const loopback = input.connectionId !== null ? await connections.isLoopback(input.userId, input.connectionId) : (await connections.ofChat(input.userId, await chats.own(input.userId, input.chatId)))?.loopback === true;
    if (!loopback) return {};
    const transport = await settings.transport(input.userId);
    const omit = cutoff(input.messages, transport.history);
    if (input.dryRun) return { omit };
    const generation = this.generationOf(input);
    if (generation === null) throw new Error("LumiAH couldn't tell which generation this prompt belongs to, so the reply wasn't started. Send the message again.");
    const left = new Set(omit);
    const sources = input.messages.flatMap((m, i): SourceMark[] => (m.history && !left.has(i) && m.sourceId !== undefined && m.sourceIndex !== undefined ? [{ mark: contentMark(m.role, m.text), source: { kind: "history", messageId: m.sourceId, index: m.sourceIndex } }] : []));
    const earlier = this.byTurn.get(generation.id);
    if (earlier !== undefined) this.byTag.delete(earlier.tag);
    const turn: Turn = { turn: generation.id, tag: randomHex(128), userId: input.userId, chatId: input.chatId, kind, presetId: input.presetId, personaId: input.personaId, sources, activated: input.activated, at: this.deps.now(), request: null, relay: null, facts: null };
    this.byTag.set(turn.tag, turn);
    this.byTurn.set(turn.turn, turn);
    this.byChat.set(`${turn.userId}\u0000${turn.chatId}`, turn);
    this.trim(transport.tags.held);
    return { omit, parameters: { [TAG_PARAM]: turn.tag } };
  }

  /** Lets go of the oldest tags past `held`, and their generations with them. */
  private trim(held: number): void {
    while (this.byTag.size > held) {
      const oldest = this.byTag.values().next().value;
      if (oldest === undefined) return;
      this.forget(oldest);
    }
    // The generations are a superset of the tagged ones (those on other connections are here too): bounded by the same number.
    while (this.generations.size > held * 2) {
      const oldest = this.generations.keys().next().value;
      if (oldest === undefined) return;
      const generation = this.generations.get(oldest);
      this.generations.delete(oldest);
      if (generation !== undefined && this.latest.get(generation.chatId) === oldest) this.latest.delete(generation.chatId);
    }
  }

  private forget(turn: Turn): void {
    this.byTag.delete(turn.tag);
    if (this.byTurn.get(turn.turn) === turn) this.byTurn.delete(turn.turn);
    const chat = `${turn.userId}\u0000${turn.chatId}`;
    if (this.byChat.get(chat) === turn) this.byChat.delete(chat);
  }

  // ---------------------------------------------------------------- the runtime's requests

  /** The message and swipe a turn's reply is written to, as far as Lumiverse has said or the chat shows. */
  private async targetOf(turn: Turn): Promise<{ message: string | null; swipe: number }> {
    const generation = this.generations.get(turn.turn);
    let message = generation?.targetMessageId ?? null;
    let swipe = generation?.targetSwipeId ?? null;
    if (message === null) {
      // Lumiverse didn't name it. A swipe, a regenerate and a continue write the chat's last message; a new reply writes the empty message staged for it, when there is one.
      const last = await this.deps.chats.last(turn.chatId);
      if (last !== null && last.role === "assistant" && (turn.kind !== "new" || last.content === "")) {
        message = last.id;
        swipe = last.swipeId;
      }
    } else if (swipe === null) swipe = (await this.deps.chats.find(turn.chatId, message))?.swipeId ?? null;
    return { message, swipe: swipe ?? 0 };
  }

  /**
   * `turn.begin` (DESIGN §2 step 4): the loopback key and the tag checked, the tag spent, the turn
   * answered. A tag admits one request: the same request asked again (after a reconnect) is answered
   * as before, and any other is refused.
   */
  async begin(userId: string, relay: string, key: unknown, tag: unknown, request: unknown): Promise<TurnFacts> {
    if (typeof key !== "string" || typeof tag !== "string" || typeof request !== "string" || request === "") throw new LinkRefused("bad_request", "The turn's request is malformed: update the runtime and LumiAH to the same build.");
    if (!(await this.deps.registry.keyIs(userId, key))) throw new LinkRefused("forbidden", "The key in the loopback connection isn't this account's loopback key. Mint a new one on LumiAH's Runtime page: your linked runtime puts it in the connection.");
    const lifeMs = (await this.deps.settings.transport(userId)).tags.lifeMs;
    const settings = await this.deps.settings.revision(userId);
    const turn = this.byTag.get(tag);
    if (turn === undefined || this.deps.now() - turn.at > lifeMs) throw new LinkRefused("not_found", "LumiAH doesn't know this reply's tag: the extension started again since the reply was asked for, or the tag is too old. Send the message again.");
    if (turn.userId !== userId) throw new LinkRefused("forbidden", "This reply's tag belongs to another account.");
    if (turn.request !== null && turn.request !== request) throw new LinkRefused("conflict", "This reply's tag was already used. A tag admits one request, so this one wasn't answered: send the message again.");
    if (turn.facts === null) {
      turn.request = request;
      turn.relay = relay;
      turn.facts = this.targetOf(turn).then((target) => {
        const facts: Omit<TurnFacts, "settings"> = { turn: turn.turn, user: turn.userId, chat: turn.chatId, generation: turn.turn, kind: turn.kind, target, preset: turn.presetId, sources: turn.sources };
        for (const listener of this.begun) listener(turn, facts);
        return facts;
      });
    }
    return { ...(await turn.facts), settings };
  }

  /**
   * `turn.commit` (DESIGN §2 step 8): the turn's record goes on the reply's message, now when
   * Lumiverse has saved the reply, else when it says it has.
   */
  async commit(userId: string, turnId: unknown, chatId: unknown, target: unknown, rawRecord: unknown): Promise<Anchoring> {
    const record = recordOf(rawRecord);
    const where = target as { message?: unknown; swipe?: unknown } | null;
    if (typeof turnId !== "string" || typeof chatId !== "string" || record === null || where === null || typeof where !== "object" || !(where.message === null || typeof where.message === "string") || typeof where.swipe !== "number" || !Number.isSafeInteger(where.swipe) || where.swipe < 0) {
      throw new LinkRefused("bad_request", "The turn's record is malformed: update the runtime and LumiAH to the same build.");
    }
    await this.deps.chats.own(userId, chatId);
    const known = this.byTurn.get(turnId);
    if (known !== undefined && (known.userId !== userId || known.chatId !== chatId)) throw new LinkRefused("forbidden", "That turn isn't this account's.");
    const pending: Pending = { turn: turnId, userId, chatId, target: { message: where.message, swipe: where.swipe }, record, at: this.deps.now() };
    const generation = this.generations.get(turnId);
    if (generation?.ended != null) return (await this.write(pending, generation.ended.messageId)) ? "now" : "never";
    if (generation?.stopped === true) return (await this.write(pending, null)) ? "now" : "never";
    this.pending.set(turnId, pending);
    const held = (await this.deps.settings.transport(userId)).anchors.held;
    while (this.pending.size > held) {
      const oldest = this.pending.values().next().value;
      if (oldest === undefined) break;
      this.pending.delete(oldest.turn);
      void this.write(oldest, null);
    }
    return "on_save";
  }

  /**
   * Writes a record on its reply: on the message Lumiverse saved (`saved`), else on the message the
   * turn targeted, if that is there. On the swipe the turn targeted when the message is the one it
   * targeted; on the swipe the message shows otherwise (a reply whose message was made as it was
   * saved). False when there is no message to write it on.
   */
  private async write(pending: Pending, saved: string | null): Promise<boolean> {
    const messageId = saved ?? pending.target.message;
    try {
      if (messageId === null) {
        this.host.log("warn", `[LumiAH] turn ${pending.turn.slice(0, 8)}: its reply wasn't saved, so its record wasn't written`);
        return false;
      }
      const swipe = messageId === pending.target.message ? pending.target.swipe : null;
      const written = await this.deps.chats.anchor(pending.userId, pending.chatId, messageId, swipe, pending.record as unknown as JsonValue);
      if (!written) this.host.log("warn", `[LumiAH] turn ${pending.turn.slice(0, 8)}: its reply's message is gone, so its record wasn't written`);
      else for (const listener of this.answered) listener(pending.userId);
      return written;
    } catch (error) {
      this.host.log("error", `[LumiAH] turn ${pending.turn.slice(0, 8)}: its record couldn't be written (${wordsOf(error)})`);
      return false;
    }
  }

  /** `lore.activated`: the entries Lumiverse activated for a generation, each with its text as stored. */
  async activated(userId: string, chatId: string, generationId: string): Promise<ActivatedLore[]> {
    const turn = this.byTurn.get(generationId);
    if (turn === undefined || turn.userId !== userId || turn.chatId !== chatId) return [];
    const out: ActivatedLore[] = [];
    for (const a of turn.activated) {
      const entry = await this.host.lore.entry(a.entryId, userId).catch(() => null);
      if (entry !== null) out.push({ entryId: a.entryId, bookId: a.bookId ?? entry.bookId, title: a.title !== "" ? a.title : entry.title, content: entry.content });
    }
    return out;
  }

  /** Every so often: a record whose reply was never said saved is written where it can be, and what is too old is let go. */
  async tick(): Promise<void> {
    const now = this.deps.now();
    const of = async (userId: string | null): Promise<TransportSettings> => (userId === null ? TRANSPORT_DEFAULTS : this.deps.settings.transport(userId).catch(() => TRANSPORT_DEFAULTS));
    for (const pending of [...this.pending.values()]) {
      if (now - pending.at <= (await of(pending.userId)).anchors.waitMs) continue;
      this.pending.delete(pending.turn);
      void this.write(pending, null);
    }
    for (const turn of [...this.byTag.values()]) if (now - turn.at > (await of(turn.userId)).tags.lifeMs && !this.pending.has(turn.turn)) this.forget(turn);
    for (const [id, generation] of [...this.generations]) {
      if (now - generation.at <= (await of(generation.userId)).tags.lifeMs || this.byTurn.has(id) || this.pending.has(id)) continue;
      this.generations.delete(id);
      if (this.latest.get(generation.chatId) === id) this.latest.delete(generation.chatId);
    }
  }
}
