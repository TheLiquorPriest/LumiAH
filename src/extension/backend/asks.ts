// What a page asks of the core (DESIGN §4, §8, §25). The core keeps the workspace, the jobs, the
// side sessions, the spend and the rest in documents in the user's storage, and it runs in the
// user's runtime. So a page's request for any of it is sent on to a runtime (the `ask` push), which
// does it with its core and answers (`ask.answer`). Which runtime:
//
// - about a chat on a loopback connection: the one that chat's replies reach (the one whose loopback
//   connection the chat generates on), since its jobs and side sessions run there; while that one
//   isn't linked there is nobody to ask, and the page is told so;
// - about a run under way, or a job that isn't over: the one it runs in;
// - about anything else (no chat, the user's own files, their definitions, the spend, the sweep, a
//   chat that generates elsewhere): the user's runtime, the one linked now that was heard from last.
//
// With no runtime linked there is nobody to ask, and the page is told that in plain words.

import type { JsonObject, JsonValue } from "../../core/ports";
import { LINK } from "../../link/contract";
import { isRecord } from "../../link/json";
import type { UiErrorCode, UiProblem } from "../../shared/ui";
import { UiRefused } from "./errors";
import type { Relays } from "./relays";
import type { SettingsStore } from "./settings";

/** What a page's request is about, which says where it is done. At most one of `chat`, `run`, `job` and `side`; none: about no chat. */
export interface Where {
  /** The chat it is about; null: none. */
  chat?: string | null;
  /** A run under way, by the stream it is followed under and its id. */
  run?: { stream: string; turn: string };
  /** A job, by its id. */
  job?: string;
  /** A side session, by its id. */
  side?: string;
  /** It takes as long as it takes (the sweep): a runtime is waited for as long as it stays linked. */
  patient?: boolean;
}

export interface AsksDeps {
  relays: Pick<Relays, "push" | "isLinked">;
  settings: Pick<SettingsStore, "transport">;
  /** Whether a chat generates on a loopback connection, so its replies reach a runtime; rejects (`not_found`) for a chat that isn't the user's. */
  onLoopback(userId: string, chatId: string): Promise<boolean>;
  /** The runtime a chat on a loopback connection generates on (the one whose loopback connection the chat is on), by its id; null while that runtime isn't linked. */
  runtimeOf(userId: string, chatId: string): Promise<string | null>;
  /** The user's runtime for what is about no chat: the one linked now that was heard from last; null while none is. */
  userRuntime(userId: string): Promise<string | null>;
  /** The runtime a run under way runs in; null when it isn't under way. */
  runOf(userId: string, stream: string, turn: string): string | null;
  /** The runtime a job that isn't over runs in; null when nothing was heard of it since the extension started. */
  jobOf(userId: string, job: string): string | null;
  /** The extension as its pages show it. */
  name: string;
  /** Runs `fn` once after `ms`; what it returns cancels that. */
  later(ms: number, fn: () => void): () => void;
  /** An id no other ask under way has. */
  id(): string;
}

interface Pending {
  userId: string;
  relay: string;
  settle(out: { value: JsonValue } | { error: Error }): void;
}

/** The codes a refusal may carry to a page; anything else its place says is a failure of its own. */
const CODES: Readonly<Record<string, UiErrorCode>> = { bad_request: "bad_request", not_found: "not_found", forbidden: "forbidden", unavailable: "unavailable", invalid: "invalid", conflict: "conflict" };

function problemsOf(raw: unknown): UiProblem[] | undefined {
  if (!Array.isArray(raw)) return undefined;
  const out: UiProblem[] = [];
  for (const one of raw) if (isRecord(one) && Array.isArray(one.path) && typeof one.message === "string") out.push({ path: one.path.filter((k): k is string | number => typeof k === "string" || typeof k === "number"), message: one.message });
  return out;
}

/** A refusal of the core's, or of the place that holds it, as a page is told it: its own code and words where it has one of the pages' codes, else a failure named as `who`'s. */
export function refused(refusal: { code?: unknown; message?: unknown; problems?: unknown }, who: string): UiRefused {
  const said = typeof refusal.message === "string" && refusal.message !== "" ? refusal.message : `${who} couldn't do that.`;
  const code = typeof refusal.code === "string" ? CODES[refusal.code] : undefined;
  return new UiRefused(code ?? "internal", code === undefined ? `${who} couldn't do that (${said}).` : said, problemsOf(refusal.problems));
}

export class Asks {
  private readonly pending = new Map<string, Pending>();

  constructor(private readonly deps: AsksDeps) {}

  /** The chat a job or a side session is about, as the user's runtime reads it from the store; null: none, or there is no such job or session. */
  private async chatOf(userId: string, op: "jobs.read" | "sides.turns", id: string): Promise<string | null> {
    try {
      const read = await this.ask(userId, op, { id });
      const row = isRecord(read) ? (op === "jobs.read" ? read.job : read.side) : undefined;
      return isRecord(row) && typeof row.chatId === "string" && row.chatId !== "" ? row.chatId : null;
    } catch (error) {
      // No such job or session: the core says so in its own words, asked about it again where it runs.
      if (error instanceof UiRefused && error.code === "not_found") return null;
      throw error;
    }
  }

  /** The runtime a request goes to, by its id; `{ chat }`: that chat's runtime, which isn't linked; null: no runtime of the user's is linked. */
  private async place(userId: string, where: Where): Promise<string | { chat: string } | null> {
    const running = where.run !== undefined ? this.deps.runOf(userId, where.run.stream, where.run.turn) : null;
    if (running !== null) return running;
    let chat = where.chat ?? null;
    if (where.job !== undefined) {
      const runs = this.deps.jobOf(userId, where.job);
      if (runs !== null) return runs;
      chat = await this.chatOf(userId, "jobs.read", where.job);
    } else if (where.side !== undefined) chat = await this.chatOf(userId, "sides.turns", where.side);
    if (chat !== null && (await this.deps.onLoopback(userId, chat))) return (await this.deps.runtimeOf(userId, chat)) ?? { chat };
    return this.deps.userRuntime(userId);
  }

  /**
   * Asks the core for `op` in the runtime `where` says: its own answer. Refused as the core or the
   * runtime refused it; `unavailable`, in words that say what to do, when no runtime of the user's
   * is linked, when the chat's isn't, when the one asked goes away, and when it doesn't answer in
   * the time Settings give (`patient`: it is waited for as long as it stays linked).
   */
  async ask(userId: string, op: string, args: JsonObject, where: Where = {}): Promise<JsonValue> {
    const relay = await this.place(userId, where);
    const start = `Start it (its line is on ${this.deps.name}'s Runtime page) and try again.`;
    if (relay === null) throw new UiRefused("unavailable", `${this.deps.name} needs its runtime for this, and none is linked now. ${start}`);
    if (typeof relay !== "string") throw new UiRefused("unavailable", `This chat runs in a runtime, and that runtime isn't linked now. ${start}`);
    const waitMs = (await this.deps.settings.transport(userId)).pages.askMs;
    const id = this.deps.id();
    const { promise, resolve, reject } = Promise.withResolvers<JsonValue>();
    const unwait = where.patient
      ? (): void => undefined
      : this.deps.later(waitMs, () => this.settle(id, { error: new UiRefused("unavailable", `The runtime didn't answer within ${Math.round(waitMs / 1000)} seconds. It may be busy or restarting: try again in a moment.`) }));
    this.pending.set(id, {
      userId,
      relay,
      settle: (out) => {
        unwait();
        if ("error" in out) reject(out.error);
        else resolve(out.value);
      },
    });
    if (!this.deps.relays.push(userId, relay, { link: LINK, type: "ask", ask: id, op, args })) this.settle(id, { error: new UiRefused("unavailable", "The runtime's link just dropped. Try again once the Runtime page shows it linked.") });
    return promise;
  }

  private settle(id: string, out: { value: JsonValue } | { error: Error }): void {
    const pending = this.pending.get(id);
    if (pending === undefined) return;
    this.pending.delete(id);
    pending.settle(out);
  }

  /** `ask.answer`: what a runtime answered. One that names no ask of this runtime's (answered late, or twice) is left. */
  answered(userId: string, relay: string, ask: unknown, value: unknown, refusal: unknown): void {
    if (typeof ask !== "string") return;
    const pending = this.pending.get(ask);
    if (pending === undefined || pending.userId !== userId || pending.relay !== relay) return;
    if (isRecord(refusal)) {
      this.settle(ask, { error: refused(refusal, "The runtime") });
      return;
    }
    this.settle(ask, { value: value === undefined ? null : (value as JsonValue) });
  }

  /** A user's runtimes changed how they stand: what one whose link is gone was asked, and hasn't answered, fails now. */
  recheck(userId: string): void {
    const gone = new Set<string>();
    for (const pending of this.pending.values()) if (pending.userId === userId && !this.deps.relays.isLinked(userId, pending.relay)) gone.add(pending.relay);
    for (const relay of gone) this.relayGone(userId, relay);
  }

  /** A runtime's link went away, or it was forgotten: what it was asked and hasn't answered fails now. */
  relayGone(userId: string, relay: string): void {
    for (const [id, pending] of [...this.pending]) {
      if (pending.userId === userId && pending.relay === relay) this.settle(id, { error: new UiRefused("unavailable", "The runtime's link dropped before it answered. Try again once the Runtime page shows it linked.") });
    }
  }
}
