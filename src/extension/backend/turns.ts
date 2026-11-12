// A turn from the extension's side (DESIGN §2, §25). The prompt interceptor sees every reply's
// prompt and decides whose it is:
//
// - On a loopback connection it is the runtime's: the generation is tagged with a single-use tag and
//   the messages the history cutoff hides are left out; the runtime shows the tag once and gets the
//   turn back; and the record the turn leaves is written on the reply's message once Lumiverse has
//   saved it.
// - Any other prompt is left exactly as it came.
//
// A generation is known from Lumiverse's own events: its start says which chat, what kind and which
// message it writes; its end says the message it saved. The turn's id is its generation's.
//
// Every account's bookkeeping is its own (DESIGN §7): its verdicts, generations, turns and waiting
// records sit in maps no other account's replies touch, and its own settings trim only them. What
// bounds the worker over all accounts is fixed (`CEILINGS`), and past it the account that holds the
// most gives up its oldest.

import type { ActivatedLore, JsonObject, TurnKind, TurnRecord } from "../../core/ports";
import { recordOf } from "../../core/sessions";
import type { Anchoring, SourceMark, TurnFacts } from "../../link/contract";
import { TAG_PARAM, contentMark } from "../../link/contract";
import { CEILINGS, TRANSPORT_DEFAULTS, type TransportSettings } from "../../link/settings";
import type { Chats } from "./chat";
import type { Connections } from "./connections";
import { randomHex } from "./docs";
import { LinkRefused, wordsOf, wrongKey } from "./errors";
import type { OpenTurns } from "./open";
import type { RegistryStore } from "./registry";
import type { SettingsStore } from "./settings";
import type { ActivatedInfo, BackendHost, GenerationEnded, GenerationStarted, GenerationStopped, HostGenerationType, InterceptorInput, InterceptorVerdict, PromptMessage } from "./spindle";

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
  /** That swipe was deleted while the generation ran: its turn's record has nowhere to go. */
  targetGone?: true;
  at: number;
  /** Lumiverse said it ended: the message it saved (null: none), and when. */
  ended: { messageId: string | null; at: number } | null;
  stopped: boolean;
}

/** Where a turn's record goes: the message, and the swipe as that message numbers it now. */
export interface Target {
  message: string | null;
  swipe: number;
  /** That swipe was deleted: the record has nowhere to go. */
  gone: boolean;
}

/** A generation LumiAH answers, and what became of it. */
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
  /** The World Info entries Lumiverse activated for the prompt, and how each got there where it said. */
  activated: ActivatedInfo[];
  at: number;
  /** The runtime's request that spent the tag, and the runtime it came from; null while unspent. */
  request: string | null;
  relay: string | null;
  /** The turn as the runtime was told, once its target is known. */
  facts: Promise<Omit<TurnFacts, "settings">> | null;
  /** Where its record goes, once it was fixed (the runtime's `begin`): moved down since by every swipe of that message deleted before it. */
  target: Target | null;
  /** The user stopped it from LumiAH's live view. */
  stoppedHere: boolean;
}

interface Pending {
  turn: string;
  userId: string;
  chatId: string;
  /** The turn's own target (`Turn.target`, the same object) while this extension holds the turn; else as the runtime said it. */
  target: Target;
  record: TurnRecord;
  at: number;
}

/** Whether a prompt is the runtime's: `true` on a loopback connection, `false` where it is none of LumiAH's. */
type Verdict = boolean;

/**
 * One account's part of the interceptor's bookkeeping. Nothing in it is another account's: a turn
 * is found by its account first, and what the account's own settings let go is its own.
 */
interface Account {
  userId: string;
  /**
   * Where a prompt of a chat on a connection is answered, as last checked: `<connection> <chat>`
   * to its verdict. A prompt known to be none of LumiAH's goes on without a wait, and a check that
   * fails or takes too long never fails or holds up a chat that isn't known to be answered.
   */
  mine: Map<string, Verdict>;
  /** The account's own wait for that check, how many verdicts and how many turns it keeps, as its settings last said; the defaults until they were first read. */
  checkMs: number;
  known: number;
  held: number;
  generations: Map<string, Generation>;
  /** The latest generation started in each chat: how a prompt finds its generation where Lumiverse's context doesn't name it. */
  latest: Map<string, string>;
  byTag: Map<string, Turn>;
  byTurn: Map<string, Turn>;
  /** Each chat's latest turn. */
  byChat: Map<string, Turn>;
  pending: Map<string, Pending>;
}

export interface TurnsDeps {
  chats: Chats;
  connections: Connections;
  registry: RegistryStore;
  settings: SettingsStore;
  /** The turns something is owed to across a restart of this worker (open.ts). */
  open: OpenTurns;
  /** A reply is about to go to a runtime (never a prompt preview): where that runtime isn't linked the user is told so, since nothing here answers in its place (§25). Not waited for. */
  toRuntime?(userId: string, chatId: string): void;
  /** The extension as its pages show it, for the words a reply that couldn't start is given. */
  name: string;
  now(): number;
  /** Runs `fn` once after `ms`; what it returns cancels that. */
  later(ms: number, fn: () => void): () => void;
}

/** The places of the history messages a prompt leaves out: all but the latest `count`, when only the latest are kept. */
export function cutoff(messages: readonly PromptMessage[], history: TransportSettings["history"]): number[] {
  if (history.keep === "all") return [];
  const places = messages.flatMap((m, i) => (m.history ? [i] : []));
  return places.slice(0, Math.max(0, places.length - history.count));
}

/** A wait as its words say it: in seconds, or in milliseconds where it is under one. */
const waitWords = (ms: number): string => (ms >= 1_000 ? `${Math.round(ms / 1_000)} s` : `${ms} ms`);

export class Turns {
  private readonly accounts = new Map<string, Account>();
  /** Where each generation, turn and waiting record is held, by its id: the one way to an account from an id alone (Lumiverse's events may not name the user). An id leaves it only when its own account holds nothing by it. */
  private readonly home = new Map<string, Account>();
  /** The generations whose account Lumiverse didn't name, until their prompt comes and says whose they are; and the latest of them in each chat. */
  private readonly unowned = new Map<string, Generation>();
  private readonly unownedLatest = new Map<string, string>();
  /** How many swipe deletions were heard: a target read from the chat while one came is read again. */
  private swipesDeleted = 0;
  private readonly begun: ((turn: Turn, facts: Omit<TurnFacts, "settings">) => void)[] = [];
  private readonly stopped: ((turn: Turn, why: string) => void)[] = [];
  private readonly over: ((generationId: string, chatId: string) => void)[] = [];
  private readonly answered: ((userId: string) => void)[] = [];

  constructor(
    private readonly host: Pick<BackendHost, "log" | "lore" | "granted">,
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
    return this.home.get(id)?.byTurn.get(id);
  }

  /** The latest turn of a user's chat that LumiAH answered; none when it has had none since the extension started. */
  ofChat(userId: string, chatId: string): Turn | undefined {
    return this.accounts.get(userId)?.byChat.get(chatId);
  }

  // ---------------------------------------------------------------- an account's own

  private of(userId: string): Account {
    let account = this.accounts.get(userId);
    if (account === undefined) {
      const { checkMs, known, held } = TRANSPORT_DEFAULTS.tags;
      account = { userId, mine: new Map(), checkMs, known, held, generations: new Map(), latest: new Map(), byTag: new Map(), byTurn: new Map(), byChat: new Map(), pending: new Map() };
      this.accounts.set(userId, account);
    }
    return account;
  }

  /** A generation by its id, whoever's it is. */
  private generation(id: string): Generation | undefined {
    return this.home.get(id)?.generations.get(id) ?? this.unowned.get(id);
  }

  /** Something an account held by an id is gone: the id's place is forgotten once the account holds nothing by it. */
  private let(account: Account, id: string): void {
    if (this.home.get(id) === account && !account.generations.has(id) && !account.byTurn.has(id) && !account.pending.has(id)) this.home.delete(id);
  }

  private keep(account: Account, generation: Generation): void {
    account.generations.set(generation.id, generation);
    this.home.set(generation.id, account);
  }

  private dropGeneration(account: Account, id: string): void {
    const generation = account.generations.get(id);
    if (generation === undefined) return;
    account.generations.delete(id);
    if (account.latest.get(generation.chatId) === id) account.latest.delete(generation.chatId);
    this.let(account, id);
  }

  /** A generation nobody was named for turns out to be this account's: its prompt came. */
  private adopt(account: Account, generation: Generation): void {
    this.unowned.delete(generation.id);
    if (this.unownedLatest.get(generation.chatId) === generation.id) this.unownedLatest.delete(generation.chatId);
    generation.userId = account.userId;
    this.keep(account, generation);
    account.latest.set(generation.chatId, generation.id);
  }

  private forget(account: Account, turn: Turn): void {
    account.byTag.delete(turn.tag);
    if (account.byTurn.get(turn.turn) === turn) account.byTurn.delete(turn.turn);
    if (account.byChat.get(turn.chatId) === turn) account.byChat.delete(turn.chatId);
    this.let(account, turn.turn);
  }

  /** Lets go of the account's oldest turns past its own "Tags remembered", and of its oldest generations past twice that: the generations are a superset of the turns (those on other connections are here too). */
  private trim(account: Account): void {
    while (account.byTag.size > account.held) {
      const oldest = account.byTag.values().next().value;
      if (oldest === undefined) break;
      this.forget(account, oldest);
    }
    while (account.generations.size > account.held * 2) {
      const oldest = account.generations.keys().next().value;
      if (oldest === undefined) break;
      this.dropGeneration(account, oldest);
    }
  }

  /** Over every account: past `most`, the account that holds the most gives up its oldest, until the total fits. An account at work pays for its own numbers, never another's for them. */
  private shed(most: number, count: (account: Account) => number, drop: (account: Account) => void): void {
    let total = 0;
    for (const account of this.accounts.values()) total += count(account);
    while (total > most) {
      let largest: Account | undefined;
      for (const account of this.accounts.values()) if (largest === undefined || count(account) > count(largest)) largest = account;
      if (largest === undefined || count(largest) === 0) return;
      drop(largest);
      total--;
    }
  }

  /** The worker's own bounds over all accounts (`CEILINGS`): none of them is any account's setting. */
  private bound(): void {
    this.shed(
      CEILINGS.turnsTotal,
      (a) => a.byTag.size,
      (a) => {
        const oldest = a.byTag.values().next().value;
        if (oldest !== undefined) this.forget(a, oldest);
      },
    );
    this.shed(
      CEILINGS.turnsTotal * 2,
      (a) => a.generations.size,
      (a) => this.dropGeneration(a, a.generations.keys().next().value ?? ""),
    );
    this.shed(
      CEILINGS.verdictsTotal,
      (a) => a.mine.size,
      (a) => void a.mine.delete(a.mine.keys().next().value ?? ""),
    );
    this.shed(
      CEILINGS.recordsTotal,
      (a) => a.pending.size,
      (a) => this.early(a),
    );
    while (this.unowned.size > CEILINGS.generationsUnowned) {
      const oldest = this.unowned.values().next().value;
      if (oldest === undefined) break;
      this.unowned.delete(oldest.id);
      if (this.unownedLatest.get(oldest.chatId) === oldest.id) this.unownedLatest.delete(oldest.chatId);
    }
  }

  /** An account's oldest waiting record is written now, where its reply is, for want of room to wait. */
  private early(account: Account): void {
    const oldest = account.pending.values().next().value;
    if (oldest === undefined) return;
    account.pending.delete(oldest.turn);
    this.let(account, oldest.turn);
    void this.write(oldest, null);
  }

  // ---------------------------------------------------------------- Lumiverse's events

  started(event: GenerationStarted): void {
    const held = this.generation(event.generationId);
    if (held !== undefined) {
      // Said again once the reply's message is staged: what it adds is kept, nothing it leaves out is lost.
      held.targetMessageId = event.targetMessageId ?? held.targetMessageId;
      held.targetSwipeId = event.targetSwipeId ?? held.targetSwipeId;
      if (held.userId === null && event.userId !== null) this.adopt(this.of(event.userId), held);
      return;
    }
    const generation: Generation = { id: event.generationId, chatId: event.chatId, userId: event.userId, type: event.type, targetMessageId: event.targetMessageId, targetSwipeId: event.targetSwipeId, at: this.deps.now(), ended: null, stopped: false };
    if (event.userId === null) {
      this.unowned.set(generation.id, generation);
      this.unownedLatest.set(generation.chatId, generation.id);
    } else {
      const account = this.of(event.userId);
      this.keep(account, generation);
      account.latest.set(generation.chatId, generation.id);
      this.trim(account);
    }
    this.bound();
  }

  ended(event: GenerationEnded): void {
    const generation = this.generation(event.generationId);
    const ended = { messageId: event.messageId, at: this.deps.now() };
    if (generation !== undefined) generation.ended = ended;
    else {
      // One whose start wasn't heard (the extension started mid-generation) is kept as ended, so its turn's record, handed over later, goes on its message at once.
      const made: Generation = { id: event.generationId, chatId: event.chatId, userId: event.userId, type: "other", targetMessageId: null, targetSwipeId: null, at: ended.at, ended, stopped: false };
      if (event.userId === null) this.unowned.set(made.id, made);
      else this.keep(this.of(event.userId), made);
      this.bound();
    }
    this.handed(event.generationId, event.messageId);
    void this.clear(event.generationId, event.messageId);
    for (const listener of this.over) listener(event.generationId, event.chatId);
  }

  stoppedBy(event: GenerationStopped): void {
    const generation = this.generation(event.generationId);
    if (generation !== undefined) generation.stopped = true;
    const turn = this.turn(event.generationId);
    if (turn !== undefined) for (const listener of this.stopped) listener(turn, "You stopped the reply in Lumiverse.");
    // Lumiverse keeps what a stopped reply had written, on the message it was writing: a record already handed over goes there.
    this.handed(event.generationId, null);
    void this.clear(event.generationId, null);
    for (const listener of this.over) listener(event.generationId, event.chatId);
  }

  /** A generation is over: the record that waited for it is written, on the message Lumiverse saved (`saved`), else on the one the turn targeted. */
  private handed(generationId: string, saved: string | null): void {
    const account = this.home.get(generationId);
    const pending = account?.pending.get(generationId);
    if (account === undefined || pending === undefined) return;
    account.pending.delete(generationId);
    this.let(account, generationId);
    void this.write(pending, saved);
  }

  /** The user stopped a turn from LumiAH's live view: remembered, so the empty reply that may leave is taken away once its generation is over. */
  stoppedFromLive(userId: string, turnId: string): void {
    const turn = this.accounts.get(userId)?.byTurn.get(turnId);
    if (turn !== undefined) turn.stoppedHere = true;
  }

  /**
   * A swipe of a message was deleted, and the message's later swipes moved down by one. So does the
   * place of every record still to be written on one of them: of the generations under way there,
   * of the turns begun, and of the records waiting for their reply to be saved. One whose own swipe
   * is the deleted one has nowhere to go: written where it was aimed, it would land on another reply.
   */
  swipeDeleted(chatId: string, messageId: string, deleted: number): void {
    this.swipesDeleted++;
    const moved = (generation: Generation): void => {
      if (generation.chatId !== chatId || generation.targetMessageId !== messageId || generation.targetSwipeId === null || generation.targetGone) return;
      if (generation.targetSwipeId > deleted) generation.targetSwipeId--;
      else if (generation.targetSwipeId === deleted) generation.targetGone = true;
    };
    for (const generation of this.unowned.values()) moved(generation);
    // The event names no user: the chat is looked for in every account's own.
    for (const account of this.accounts.values()) {
      for (const generation of account.generations.values()) moved(generation);
      // A turn and its waiting record share one target: each is moved once.
      const targets = new Set<Target>();
      for (const turn of account.byTurn.values()) if (turn.chatId === chatId && turn.target !== null) targets.add(turn.target);
      for (const pending of account.pending.values()) if (pending.chatId === chatId) targets.add(pending.target);
      for (const target of targets) {
        if (target.message !== messageId || target.gone) continue;
        if (target.swipe > deleted) target.swipe--;
        else if (target.swipe === deleted) target.gone = true;
      }
      for (const pending of [...account.pending.values()]) {
        if (pending.chatId !== chatId || !pending.target.gone) continue;
        account.pending.delete(pending.turn);
        this.let(account, pending.turn);
        this.host.log("warn", `[LumiAH] turn ${pending.turn.slice(0, 8)}: the swipe its reply was written on was deleted, so its record wasn't written`);
      }
    }
  }

  /**
   * A generation is over. A new reply stopped from the live view before it had any text can leave
   * its message behind, empty: Lumiverse keeps it when its Stop found thinking written, and saves it
   * as a finished reply when the runtime couldn't make it stop the generation. That message goes.
   * Never a regenerate's, a swipe's or a continue's, whose message was there before, and never one
   * with text (`deleteEmpty`). `saved` is the message Lumiverse said it saved; null: the one the turn
   * targeted. Without the permission to change a chat's messages nothing is deleted, and nothing is
   * said of it: the pages say what that permission is for.
   */
  private async clear(generationId: string, saved: string | null): Promise<void> {
    const turn = this.turn(generationId);
    if (turn === undefined || !turn.stoppedHere || turn.kind !== "new" || !this.host.granted("chat_mutation")) return;
    try {
      const messageId = saved ?? (await turn.facts)?.target.message ?? null;
      if (messageId !== null) await this.deps.chats.deleteEmpty(turn.userId, turn.chatId, messageId);
    } catch (error) {
      this.host.log("warn", `[LumiAH] turn ${turn.turn.slice(0, 8)}: the empty reply its stop left couldn't be deleted (${wordsOf(error)})`);
    }
  }

  // ---------------------------------------------------------------- the interceptor

  /** What may have changed which connections or chats are answered here (a runtime registered, the loopback connection was made, a chat was switched): the user's verdicts are checked again before they are used. */
  unsure(userId: string): void {
    this.accounts.get(userId)?.mine.clear();
  }

  /**
   * Whether a prompt is the runtime's, as Lumiverse has the connections now: it is on a loopback
   * connection, so its request reaches the runtime there, whatever the switch says.
   */
  private async placeNow(input: InterceptorInput): Promise<Verdict> {
    const { connections, chats } = this.deps;
    if (input.connectionId !== null) return connections.isLoopback(input.userId, input.connectionId);
    return (await connections.ofChat(input.userId, await chats.own(input.userId, input.chatId)))?.loopback === true;
  }

  /**
   * The account's own settings for its bookkeeping, read before they are used, so that they hold
   * from its first reply on. They are in memory after their first read; that first read is given
   * the default wait for a check and no more, so a storage that doesn't answer holds no reply
   * longer than the check itself may. Failing or late, what the account had stands.
   */
  private async tune(account: Account): Promise<TransportSettings | null> {
    const read = this.deps.settings.transport(account.userId).then((transport) => {
      account.checkMs = transport.tags.checkMs;
      account.known = Math.min(transport.tags.known, CEILINGS.tagsKnown);
      account.held = Math.min(transport.tags.held, CEILINGS.tagsHeld);
      return transport;
    });
    const late = Promise.withResolvers<null>();
    const unwait = this.deps.later(TRANSPORT_DEFAULTS.tags.checkMs, () => late.resolve(null));
    try {
      return await Promise.race([read, late.promise]);
    } catch {
      return null;
    } finally {
      unwait();
      read.catch(() => undefined);
    }
  }

  /**
   * Whether this prompt is the runtime's. The check asks Lumiverse, which can fail (a permission
   * revoked) or be slow. Nothing here may fail or hold up a chat that isn't LumiAH's, and nothing
   * may cost a reply (the interceptor isn't required: a failure here leaves the prompt as it came):
   * - known to be none of LumiAH's: it goes on at once, and the check runs behind it, for the next reply;
   * - not known: the check is waited for, a bounded time; failing or late, the prompt goes on untouched;
   * - known to be the runtime's: failing or late, the prompt is left untagged, in words Lumiverse
   *   shows: tagged blindly, a connection that is no loopback any more would be sent the tag. The
   *   runtime passes an untagged request on to the writer, so the reply is still written.
   * A chat that became LumiAH's since it was last seen is so answered from its second reply on.
   */
  private async where(input: InterceptorInput): Promise<Verdict> {
    const account = this.of(input.userId);
    const key = `${input.connectionId ?? ""}\u0000${input.chatId}`;
    const held = account.mine.get(key);
    const began = this.deps.now();
    const check = this.placeNow(input).then((verdict) => {
      account.mine.delete(key);
      account.mine.set(key, verdict);
      for (const oldest of account.mine.keys()) {
        if (account.mine.size <= account.known) break;
        account.mine.delete(oldest);
      }
      this.bound();
      return verdict;
    });
    // Whoever waits for it below hears how it went; nobody waiting is no failure of its own.
    check.catch(() => undefined);
    if (held === false) return false;
    await this.tune(account);
    const { checkMs } = account;
    const late = Promise.withResolvers<never>();
    const unwait = this.deps.later(Math.max(0, checkMs - (this.deps.now() - began)), () => late.reject(new Error(`Lumiverse didn't say within ${waitWords(checkMs)}`)));
    try {
      return await Promise.race([check, late.promise]);
    } catch (error) {
      if (held === undefined) {
        this.host.log("warn", `[LumiAH] a reply's connection couldn't be checked (${wordsOf(error)}), so it was left as it is`);
        return false;
      }
      throw new Error(`${this.deps.name} answers this chat in its runtime, and couldn't check its connection now (${wordsOf(error)}), so its agents had no part in this reply. Try again in a moment; if it keeps happening, see ${this.deps.name}'s Runtime page.`);
    } finally {
      unwait();
    }
  }

  /** The generation a prompt belongs to: the one its context names, else the latest started in its chat that isn't tagged yet. Never another account's. */
  private generationOf(input: InterceptorInput): Generation | null {
    const account = this.of(input.userId);
    if (input.generationId !== null) {
      const holder = this.home.get(input.generationId);
      if (holder !== undefined && holder !== account) return null;
      const named = account.generations.get(input.generationId);
      if (named !== undefined) return named;
      const nobodys = this.unowned.get(input.generationId);
      if (nobodys !== undefined) {
        this.adopt(account, nobodys);
        return nobodys;
      }
      // Its start wasn't heard (the extension started mid-generation): what the context says of it is enough to tag it.
      const made: Generation = { id: input.generationId, chatId: input.chatId, userId: input.userId, type: input.type, targetMessageId: null, targetSwipeId: null, at: this.deps.now(), ended: null, stopped: false };
      this.keep(account, made);
      return made;
    }
    // The latest started in the chat, whether Lumiverse named its account or not.
    const named = account.generations.get(account.latest.get(input.chatId) ?? "");
    const nobodys = this.unowned.get(this.unownedLatest.get(input.chatId) ?? "");
    const generation = named !== undefined && nobodys !== undefined ? (nobodys.at > named.at ? nobodys : named) : (named ?? nobodys);
    if (generation === undefined || generation.ended !== null || generation.stopped || generation.type !== input.type) return null;
    if (generation.userId === null) this.adopt(account, generation);
    return account.byTurn.get(generation.id)?.request != null ? null : generation;
  }

  /** A generation becomes a turn of LumiAH's: known by its generation's id, by its chat and, for a runtime's, by its tag. The messages the cutoff hides are left out of what it says of the prompt's sources. */
  private take(input: InterceptorInput, kind: TurnKind, generation: Generation, omit: readonly number[]): Turn {
    const account = this.of(input.userId);
    const left = new Set(omit);
    const sources = input.messages.flatMap((m, i): SourceMark[] => {
      if (left.has(i)) return [];
      if (m.history && m.sourceId !== undefined && m.sourceIndex !== undefined) return [{ mark: contentMark(m.role, m.text), source: { kind: "history", messageId: m.sourceId, index: m.sourceIndex } }];
      // A World Info entry Lumiverse put there as a message of its own (§24.1): which entry it is, the core works out from its text.
      return m.lore ? [{ mark: contentMark(m.role, m.text), source: { kind: "lore" } }] : [];
    });
    const earlier = account.byTurn.get(generation.id);
    if (earlier !== undefined) account.byTag.delete(earlier.tag);
    const turn: Turn = { turn: generation.id, tag: randomHex(128), userId: input.userId, chatId: input.chatId, kind, presetId: input.presetId, personaId: input.personaId, sources, activated: input.activated, at: this.deps.now(), request: null, relay: null, facts: null, target: null, stoppedHere: false };
    account.byTag.set(turn.tag, turn);
    account.byTurn.set(turn.turn, turn);
    account.byChat.set(turn.chatId, turn);
    this.home.set(turn.turn, account);
    this.trim(account);
    this.bound();
    return turn;
  }

  /**
   * The prompt interceptor (DESIGN §2 step 2, §25). A prompt that is none of LumiAH's is left as it
   * is. On a loopback, the messages the history cutoff hides are left out, and the generation is
   * tagged: the tag goes into the request's body, where the runtime finds it. A prompt preview (a
   * dry run) shows the cutoff and nothing else, since nothing will be sent.
   */
  async intercept(input: InterceptorInput): Promise<InterceptorVerdict> {
    const kind = KINDS[input.type];
    if (kind === undefined) return {};
    if (!(await this.where(input))) return {};
    if (!input.dryRun) this.deps.toRuntime?.(input.userId, input.chatId);
    // Without the permission to set a request's parameters the tag can't travel, so nothing is changed and the reply is the connection's own, whole. The pages say what that permission is for.
    if (!this.host.granted("generation_parameters")) return {};
    const transport = await this.deps.settings.transport(input.userId);
    const omit = cutoff(input.messages, transport.history);
    if (input.dryRun) return { omit };
    const generation = this.generationOf(input);
    if (generation === null) throw new Error(`${this.deps.name} couldn't tell which generation this prompt belongs to, so its agents had no part in this reply. Send the message again.`);
    const turn = this.take(input, kind, generation, omit);
    return { omit, parameters: { [TAG_PARAM]: turn.tag } };
  }

  // ---------------------------------------------------------------- the runtime's requests

  /**
   * The message and swipe a turn's reply is written to, as far as Lumiverse has said or the chat
   * shows. Read again when a swipe was deleted meanwhile: the one the chat showed may have moved.
   */
  private async targetOf(turn: Turn): Promise<Target> {
    for (;;) {
      const heard = this.swipesDeleted;
      const generation = this.generation(turn.turn);
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
      if (this.swipesDeleted === heard) return { message, swipe: swipe ?? 0, gone: generation?.targetGone === true };
    }
  }

  /**
   * `turn.begin` (DESIGN §2 step 4): the loopback key and the tag checked, the tag spent, the turn
   * answered. A tag admits one request: the same request asked again (after a reconnect) is answered
   * as before, and any other is refused. A tag is looked for among the caller's own alone: another
   * account's is no tag at all to this one.
   */
  async begin(userId: string, relay: string, key: unknown, tag: unknown, request: unknown): Promise<TurnFacts> {
    const { name } = this.deps;
    if (typeof key !== "string" || typeof tag !== "string" || typeof request !== "string" || request === "") throw new LinkRefused("bad_request", `The turn's request is malformed: update the runtime and ${name} to the same build.`);
    if (!(await this.deps.registry.keyIs(userId, key))) throw wrongKey(name);
    const lifeMs = (await this.deps.settings.transport(userId)).tags.lifeMs;
    const settings = await this.deps.settings.revision(userId);
    const turn = this.accounts.get(userId)?.byTag.get(tag);
    if (turn === undefined || this.deps.now() - turn.at > lifeMs) throw new LinkRefused("not_found", `${name} doesn't know this reply's tag: the extension started again since the reply was asked for, or the tag is too old. Send the message again.`);
    if (turn.request !== null && turn.request !== request) throw new LinkRefused("conflict", "This reply's tag was already used. A tag admits one request, so this one wasn't answered: send the message again.");
    if (turn.facts === null) {
      turn.request = request;
      turn.relay = relay;
      turn.facts = this.targetOf(turn).then((target) => {
        // Kept apart from what the runtime is told: a swipe deleted later moves this one, and the runtime's copy stays as it was said.
        turn.target = target;
        // The record this turn leaves is handed over when the turn ends, which may be after this worker was restarted: what says the turn began here outlives it.
        void this.deps.open.put(userId, { turn: turn.turn, chatId: turn.chatId, kind: turn.kind, target: { message: target.message, swipe: target.swipe }, at: this.deps.now() }).catch((error: unknown) => this.host.log("warn", `[LumiAH] turn ${turn.turn.slice(0, 8)} couldn't be kept across a restart (${wordsOf(error)})`));
        const facts: Omit<TurnFacts, "settings"> = { turn: turn.turn, user: turn.userId, chat: turn.chatId, generation: turn.turn, kind: turn.kind, target: { message: target.message, swipe: target.swipe }, preset: turn.presetId, sources: turn.sources };
        for (const listener of this.begun) listener(turn, facts);
        return facts;
      });
    }
    return { ...(await turn.facts), settings };
  }

  /**
   * `turn.commit` (DESIGN §2 step 8): the turn's record goes on the reply's message, now when
   * Lumiverse has saved the reply, else when it says it has. A record is taken only for a turn the
   * backend knows began here: one this worker holds, or one the worker before it kept (open.ts).
   */
  async commit(userId: string, turnId: unknown, chatId: unknown, target: unknown, rawRecord: unknown): Promise<Anchoring> {
    const { name, open } = this.deps;
    const record = recordOf(rawRecord);
    const where = target as { message?: unknown; swipe?: unknown } | null;
    if (typeof turnId !== "string" || typeof chatId !== "string" || record === null || where === null || typeof where !== "object" || !(where.message === null || typeof where.message === "string") || typeof where.swipe !== "number" || !Number.isSafeInteger(where.swipe) || where.swipe < 0) {
      throw new LinkRefused("bad_request", `The turn's record is malformed: update the runtime and ${name} to the same build.`);
    }
    await this.deps.chats.own(userId, chatId);
    const account = this.of(userId);
    const known = account.byTurn.get(turnId);
    const kept = known === undefined ? await open.get(userId, turnId) : null;
    if ((known?.chatId ?? kept?.chatId) !== chatId) throw new LinkRefused("not_found", `${name} knows no such turn in that chat, so its record wasn't taken: a record is kept only for a reply that began here.`);
    // What was owed to the turn is in hand now.
    void open.drop(userId, turnId).catch(() => undefined);
    // The runtime says the target it was told at `begin`. Where this extension still holds the turn, its own stands: a swipe deleted since has moved it.
    const pending: Pending = { turn: turnId, userId, chatId, target: known?.target ?? { message: where.message, swipe: where.swipe, gone: false }, record, at: this.deps.now() };
    if (pending.target.gone) {
      this.host.log("warn", `[LumiAH] turn ${turnId.slice(0, 8)}: the swipe its reply was written on was deleted, so its record wasn't written`);
      return "never";
    }
    // A generation this worker doesn't know began before it started, and its end may have been said while nobody listened: the chat shows whether the reply is saved.
    if (this.generation(turnId) === undefined && (await this.saved(pending))) return (await this.write(pending, null)) ? "now" : "never";
    // Read after that look at the chat: the generation's end may have been said meanwhile.
    const generation = this.generation(turnId);
    if (generation?.ended != null) return (await this.write(pending, generation.ended.messageId)) ? "now" : "never";
    if (generation?.stopped === true) return (await this.write(pending, null)) ? "now" : "never";
    account.pending.set(turnId, pending);
    this.home.set(turnId, account);
    // The account's own "Records waiting", and no other's: past it, its own oldest is written where its reply is now.
    const held = Math.min((await this.deps.settings.transport(userId)).anchors.held, CEILINGS.recordsWaiting);
    while (account.pending.size > held) this.early(account);
    this.bound();
    return "on_save";
  }

  /**
   * Whether the chat shows a record's reply as saved: its message shows the swipe the turn wrote, and
   * that swipe holds text. Lumiverse leaves a new reply's, a swipe's and a regenerate's swipe empty
   * until it saves it. A continue's held text before it began, so it tells nothing; nor does a read
   * that fails. The record then waits as it would have.
   */
  private async saved(pending: Pending): Promise<boolean> {
    const { message, swipe } = pending.target;
    if (message === null || pending.record.kind === "continue") return false;
    const shown = await this.deps.chats.find(pending.chatId, message).catch(() => null);
    return shown !== null && shown.swipeId === swipe && shown.content !== "";
  }

  /**
   * Writes a record on its reply: on the message Lumiverse saved (`saved`), else on the message the
   * turn targeted, if that is there. On the swipe the turn targeted when the message is the one it
   * targeted; on the swipe the message shows otherwise (a reply whose message was made as it was
   * saved). False when there is no message to write it on.
   */
  private async write(pending: Pending, saved: string | null): Promise<boolean> {
    const { target } = pending;
    const messageId = saved ?? target.message;
    const turn = pending.turn.slice(0, 8);
    // Without the permission to change a chat's messages no record can be written. The pages say what that costs; it isn't logged reply after reply as something that went wrong.
    if (!this.host.granted("chat_mutation")) return false;
    try {
      if (messageId === null) {
        this.host.log("warn", `[LumiAH] turn ${turn}: its reply wasn't saved, so its record wasn't written`);
        return false;
      }
      const own = messageId === target.message;
      for (;;) {
        if (own && target.gone) {
          this.host.log("warn", `[LumiAH] turn ${turn}: the swipe its reply was written on was deleted, so its record wasn't written`);
          return false;
        }
        const aimed = target.swipe;
        const written = await this.deps.chats.anchor(pending.userId, pending.chatId, messageId, own ? () => target.swipe : null, pending.record as unknown as JsonObject);
        if (written) {
          for (const listener of this.answered) listener(pending.userId);
          return true;
        }
        // No place for it where it was aimed. A swipe deleted while it was being written moved the turn's own: once more, where that is now.
        if (own && (target.gone || target.swipe !== aimed)) continue;
        this.host.log("warn", `[LumiAH] turn ${turn}: its reply's message is gone, so its record wasn't written`);
        return false;
      }
    } catch (error) {
      this.host.log("error", `[LumiAH] turn ${turn}: its record couldn't be written (${wordsOf(error)})`);
      return false;
    }
  }

  /** `lore.activated`: the entries Lumiverse activated for a generation, each with its text as stored. */
  async activated(userId: string, chatId: string, generationId: string): Promise<ActivatedLore[]> {
    const out: ActivatedLore[] = [];
    for (const a of this.activatedInfo(userId, chatId, generationId)) {
      const entry = await this.host.lore.entry(a.entryId, userId).catch(() => null);
      if (entry !== null) out.push({ entryId: a.entryId, bookId: a.bookId ?? entry.bookId, title: a.title !== "" ? a.title : entry.title, content: entry.content });
    }
    return out;
  }

  /** The entries Lumiverse activated for a generation, each as its prompt's context named it: which, of which book, and how it got there (§24.1). None for a generation LumiAH had no turn in. */
  activatedInfo(userId: string, chatId: string, generationId: string): ActivatedInfo[] {
    const turn = this.accounts.get(userId)?.byTurn.get(generationId);
    return turn === undefined || turn.chatId !== chatId ? [] : turn.activated;
  }

  /** Every so often: a record whose reply was never said saved is written where it can be, and what is too old is let go, account by account and each by its own settings. */
  async tick(): Promise<void> {
    const now = this.deps.now();
    for (const account of [...this.accounts.values()]) {
      const transport = await this.deps.settings.transport(account.userId).catch(() => TRANSPORT_DEFAULTS);
      for (const pending of [...account.pending.values()]) {
        if (now - pending.at <= transport.anchors.waitMs) continue;
        account.pending.delete(pending.turn);
        this.let(account, pending.turn);
        void this.write(pending, null);
      }
      for (const turn of [...account.byTag.values()]) if (now - turn.at > transport.tags.lifeMs && !account.pending.has(turn.turn)) this.forget(account, turn);
      for (const [id, generation] of [...account.generations]) if (now - generation.at > transport.tags.lifeMs && !account.byTurn.has(id) && !account.pending.has(id)) this.dropGeneration(account, id);
      // A turn whose record never came (the runtime went away for good) is owed nothing past its tag's life.
      for (const kept of await this.deps.open.list(account.userId).catch(() => [])) if (now - kept.at > transport.tags.lifeMs) await this.deps.open.drop(account.userId, kept.turn).catch(() => undefined);
    }
    for (const [id, generation] of [...this.unowned]) {
      if (now - generation.at <= TRANSPORT_DEFAULTS.tags.lifeMs) continue;
      this.unowned.delete(id);
      if (this.unownedLatest.get(generation.chatId) === id) this.unownedLatest.delete(generation.chatId);
    }
  }
}
