// What a page asks of the core (DESIGN §4, §8, §25). The core keeps the workspace, the jobs, the
// side sessions, the spend and the rest in documents that only the place holding it writes, and
// there are two such places: this extension, for what runs built in, and the user's runtime. So a
// page's request for any of it is done in the place it belongs to:
//
// - about a chat: where that chat's turns run (in a runtime while the chat generates on a loopback
//   connection, else built in), since a chat's files, jobs and side sessions are written there;
// - about a run under way, or a job that isn't over: where it runs;
// - about no chat (the user's own files, their definitions, the spend, the sweep): built in, which
//   is always there.
//
// Built in, it is one call of the core here. In a runtime, it is sent on (the `ask` push), and the
// runtime does it with its core and answers (`ask.answer`). A user may have more than one runtime
// linked, and each keeps its own documents: what is asked about a chat goes to the one whose
// loopback connection the chat generates on, and while that one isn't linked there is nobody to
// ask, and the page is told so.

import type { JsonObject, JsonValue } from "../../core/ports";
import { LINK } from "../../link/contract";
import { isRecord } from "../../link/json";
import type { RunPlace, UiErrorCode, UiProblem } from "../../shared/ui";
import { UiRefused } from "./errors";
import { BUILTIN } from "./live";
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
  /** The core where it runs built in: one op of it, answered as the core answers; rejects with a `UiRefused`. */
  builtin(userId: string, op: string, args: JsonObject): Promise<JsonValue>;
  /** Where what is asked about a chat is done; rejects (`not_found`) for a chat that isn't the user's. */
  placeOf(userId: string, chatId: string): Promise<RunPlace>;
  /** The runtime a chat that runs in one generates on (the one whose loopback connection the chat is on), by its id; null while that runtime isn't linked. */
  runtimeOf(userId: string, chatId: string): Promise<string | null>;
  /** Whether the extension that answers a chat plays it only in a runtime, and its name; null where it doesn't. */
  needsRuntime(userId: string, chatId: string): Promise<{ by: string } | null>;
  /** The runtime a run under way runs in (`BUILTIN`: none, it runs here); null when it isn't under way. */
  runOf(userId: string, stream: string, turn: string): string | null;
  /** The runtime a job that isn't over runs in (`BUILTIN`: here); null when nothing was heard of it since the extension started. */
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

  /** The chat a job or a side session is about, as the built-in core reads it from the store both places share; null: none, or there is no such job or session. */
  private async chatOf(userId: string, op: "jobs.read" | "sides.turns", id: string): Promise<string | null> {
    try {
      const read = await this.deps.builtin(userId, op, { id });
      const row = isRecord(read) ? (op === "jobs.read" ? read.job : read.side) : undefined;
      return isRecord(row) && typeof row.chatId === "string" && row.chatId !== "" ? row.chatId : null;
    } catch (error) {
      // No such job or session: asked built in, the op itself says so in the core's own words.
      if (error instanceof UiRefused && error.code === "not_found") return null;
      throw error;
    }
  }

  /** Where a request is done: `BUILTIN`, or a runtime by its id; `{ chat }`: in that chat's runtime, which isn't linked. */
  private async place(userId: string, where: Where): Promise<string | { chat: string }> {
    if (where.run !== undefined) return this.deps.runOf(userId, where.run.stream, where.run.turn) ?? BUILTIN;
    let chat = where.chat ?? null;
    if (where.job !== undefined) {
      const runs = this.deps.jobOf(userId, where.job);
      if (runs !== null) return runs;
      chat = await this.chatOf(userId, "jobs.read", where.job);
    } else if (where.side !== undefined) chat = await this.chatOf(userId, "sides.turns", where.side);
    if (chat === null || (await this.deps.placeOf(userId, chat)) !== "runtime") return BUILTIN;
    return (await this.deps.runtimeOf(userId, chat)) ?? { chat };
  }

  /** What a page is told of a chat whose runtime isn't linked: to start it, and, where the chat may run built in, that it may. */
  private async awayWords(userId: string, chatId: string): Promise<string> {
    const start = `Start it (its line is on ${this.deps.name}'s Runtime page) and try again`;
    const needs = await this.deps.needsRuntime(userId, chatId).catch(() => null);
    return needs !== null ? `${needs.by} plays this chat only in your runtime, which isn't linked now. ${start}.` : `This chat runs in a runtime, and its runtime isn't linked. ${start}, or set the chat to run built in, which needs no runtime.`;
  }

  /**
   * Asks the core for `op` in the place `where` says: its own answer. Refused as the core or its
   * place refused it. In a runtime: `unavailable` when the chat's isn't linked, when the one asked
   * goes away, and when it doesn't answer in the time Settings give (`patient`: it is waited for as
   * long as it stays linked).
   */
  async ask(userId: string, op: string, args: JsonObject, where: Where = {}): Promise<JsonValue> {
    const relay = await this.place(userId, where);
    if (relay === BUILTIN) return this.deps.builtin(userId, op, args);
    if (typeof relay !== "string") throw new UiRefused("unavailable", await this.awayWords(userId, relay.chat));
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
