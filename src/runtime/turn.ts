// A turn (DESIGN §2 steps 4 to 8): a tagged request's tag is checked with the extension, which
// answers with the turn (the user, the chat, the generation and its kind, the message it targets);
// the core's harness answers it, its progress and its reply streaming into the request's answer;
// and the record the turn leaves is handed to the extension, which anchors it on the reply's message
// once Lumiverse has saved it.
//
// One turn runs per chat at a time: a new one for a chat whose earlier turn hasn't ended stops that
// one first and waits for it, since Lumiverse has already let its generation go. A turn stops when
// Lumiverse closes its request (Stop), when the extension says so (Stop in the live view, or
// Lumiverse's own stop heard there), or when the runtime shuts down; the core hears each as its
// signal, and its model calls under way are cancelled with it.

import { AsyncLocalStorage } from "node:async_hooks";
import type { AgentUsage, JsonObject, ReplySink, TurnRequest, TurnResult } from "../core/ports";
import type { StopPush, TurnFacts } from "../link/contract";
import type { RuntimeTuning } from "../link/settings";
import type { RuntimeLink } from "./link";
import { LiveError } from "./lumiverse";
import { maxTokensOf, modelMessages, samplingOf, withSources } from "./openai";
import type { TaggedRequest, TurnRunner } from "./relay";
import type { RuntimeSettings } from "./settings";
import { problemOf } from "./streams";
import type { TraceSink } from "./trace";

/** What answers a turn: the core's harness (`createHarness(host, …).answer`). It never rejects, and ends the sink with one `done` or one `error`. */
export interface Harness {
  answer(turn: TurnRequest, sink: ReplySink, signal: AbortSignal): Promise<TurnResult>;
}

export interface TurnsEnv {
  now(): number;
  log(text: string): void;
  tuning(): RuntimeTuning;
  /** The writer's connection, from the settings' values (the core's section names it); null: the user's default. */
  writerConnection(values: JsonObject): string | null;
}

interface Running {
  turn: string;
  chat: string;
  stop: AbortController;
  /** Resolves once the turn has let go of everything: the next turn of its chat may start. */
  done: Promise<void>;
}

/** The turn's usage as an OpenAI completion says usage, with the turn's id and the harness's own counts beside it: Lumiverse keeps the whole object with the reply. */
export function usageJson(usage: AgentUsage, turn: string): JsonObject {
  return {
    prompt_tokens: usage.in,
    completion_tokens: usage.out,
    total_tokens: usage.in + usage.out,
    prompt_tokens_details: { cached_tokens: usage.cachedIn },
    completion_tokens_details: { reasoning_tokens: usage.reasoningOut },
    lumiah_turn: turn,
    lumiah: { calls: usage.calls, tool_turns: usage.toolTurns, ms: usage.ms, estimated: usage.estimated, ...(usage.cost !== undefined ? { cost: usage.cost } : {}) },
  };
}

export class Turns implements TurnRunner {
  private readonly byTurn = new Map<string, Running>();
  private readonly byChat = new Map<string, Running>();
  /** The turn the code now running works for, and its chat: a model call names the turn, so the extension can end the call when Lumiverse stops it. */
  private readonly scope = new AsyncLocalStorage<{ turn: string; chat: string }>();

  constructor(
    private readonly link: RuntimeLink,
    private readonly harness: Harness,
    private readonly settings: RuntimeSettings,
    private readonly trace: TraceSink,
    private readonly env: TurnsEnv,
  ) {}

  /** The turns under way. */
  get count(): number {
    return this.byTurn.size;
  }

  ids(): string[] {
    return [...this.byTurn.keys()];
  }

  /** The turn the caller works for; null outside one. */
  readonly current = (): string | null => this.scope.getStore()?.turn ?? null;

  /** The chat of the turn the caller works for; null outside one. */
  readonly currentChat = (): string | null => this.scope.getStore()?.chat ?? null;

  async writerConnection(): Promise<string | null> {
    return this.env.writerConnection((await this.settings.get()).values);
  }

  /** The extension says a turn is to stop: the user pressed Stop. */
  stop(push: StopPush): void {
    this.byTurn.get(push.turn)?.stop.abort(new Error(push.why));
  }

  /** The runtime is stopping: every turn ends. */
  shutdown(): void {
    for (const running of this.byTurn.values()) running.stop.abort(new Error("The runtime is restarting."));
  }

  async run(request: TaggedRequest): Promise<void> {
    const { answer } = request;
    let facts: TurnFacts;
    try {
      facts = await this.begin(request);
    } catch (error) {
      const p = problemOf(error);
      answer.fail(p.message, p.code === "forbidden" ? "invalid_api_key" : p.code, this.env.now());
      return;
    }
    const stop = new AbortController();
    const closed = (): void => stop.abort(request.signal.reason instanceof Error ? request.signal.reason : new Error("Lumiverse closed the request (Stop)"));
    if (request.signal.aborted) closed();
    else request.signal.addEventListener("abort", closed, { once: true });
    const finished = Promise.withResolvers<void>();
    const running: Running = { turn: facts.turn, chat: facts.chat, stop, done: finished.promise };
    try {
      if (!(await this.takeChat(running))) {
        answer.fail("The chat's earlier reply hasn't stopped yet, so this one wasn't started. Try again in a moment.", "conflict", this.env.now());
        return;
      }
      this.settings.note(facts.settings);
      const turn: TurnRequest = {
        userId: facts.user,
        chatId: facts.chat,
        generationId: facts.generation,
        kind: facts.kind,
        target: { messageId: facts.target.message, swipeId: facts.target.swipe },
        presetId: facts.preset,
        messages: withSources(modelMessages(request.body.messages), facts.sources),
        params: samplingOf(request.body),
        maxTokens: maxTokensOf(request.body),
      };
      const sink: ReplySink = {
        progress: (text) => answer.piece({ kind: "progress", text }, this.env.now()),
        reasoning: (text) => answer.piece({ kind: "reasoning", text }, this.env.now()),
        content: (text) => answer.piece({ kind: "content", text }, this.env.now()),
        done: (finish, usage) => answer.piece({ kind: "finish", finish: finish === "" ? "stop" : finish, usage: usageJson(usage, facts.turn) }, this.env.now()),
        // A turn that was stopped ends with the stop's own words (who stopped it, and where), which say more than the core's.
        error: (message, code) => answer.fail(stop.signal.aborted && stop.signal.reason instanceof Error ? stop.signal.reason.message : message, code ?? "turn_failed", this.env.now()),
      };
      const result = await this.scope.run({ turn: facts.turn, chat: facts.chat }, () => this.harness.answer(turn, sink, stop.signal));
      if (!answer.ended) answer.fail(result.reason ?? "The turn ended without a reply.", "turn_failed", this.env.now());
      if (result.record !== null) await this.commit(facts, result.record);
      else if (result.status !== "done") this.env.log(`turn ${facts.turn.slice(0, 8)} ${result.status}${result.reason !== undefined ? `: ${result.reason}` : ""}`);
    } catch (error) {
      // The harness never rejects; whatever did is the runtime's own failure, said in the chat.
      const p = problemOf(error);
      this.env.log(`turn ${facts.turn.slice(0, 8)} failed: ${p.message}`);
      answer.fail(`LumiAH's turn failed: ${p.message}`, p.code, this.env.now());
    } finally {
      request.signal.removeEventListener("abort", closed);
      // The live view hears the turn's end before the turn lets go of its chat.
      await this.trace.drained().catch(() => undefined);
      this.trace.forget(facts.turn);
      if (this.byTurn.get(facts.turn) === running) this.byTurn.delete(facts.turn);
      if (this.byChat.get(facts.chat) === running) this.byChat.delete(facts.chat);
      finished.resolve();
    }
  }

  /** The tag checked and spent (DESIGN §2 step 4). Asked again after a socket that closed under it: the extension answers a request it already took as before. */
  private async begin(request: TaggedRequest): Promise<TurnFacts> {
    const first = this.env.now();
    for (;;) {
      const wait = this.env.tuning().lostMs;
      try {
        return await this.link.request("turn.begin", { key: request.key, tag: request.tag, request: request.request }, wait);
      } catch (error) {
        if (error instanceof LiveError && error.problem === "closed" && !request.signal.aborted && this.env.now() - first < wait) continue;
        throw error;
      }
    }
  }

  /** Makes `running` its chat's one turn: the chat's earlier turn is stopped and waited for. False when that one doesn't end in time. */
  private async takeChat(running: Running): Promise<boolean> {
    const earlier = this.byChat.get(running.chat);
    if (earlier !== undefined) {
      earlier.stop.abort(new Error("Another reply was asked for in this chat."));
      const { promise: late, resolve } = Promise.withResolvers<"late">();
      const timer = setTimeout(() => resolve("late"), this.env.tuning().turnWaitMs);
      const outcome = await Promise.race([earlier.done.then(() => "ended" as const), late]);
      clearTimeout(timer);
      if (outcome === "late") return false;
      // Another turn of the chat may have got in first while this one waited.
      if (this.byChat.has(running.chat)) return this.takeChat(running);
    }
    this.byChat.set(running.chat, running);
    this.byTurn.set(running.turn, running);
    return true;
  }

  /** Hands the turn's record to the extension (DESIGN §2 step 8). */
  private async commit(facts: TurnFacts, record: NonNullable<TurnResult["record"]>): Promise<void> {
    const { turn } = facts;
    const first = this.env.now();
    for (;;) {
      const wait = this.env.tuning().lostMs;
      try {
        const { anchoring } = await this.link.request("turn.commit", { turn, chat: facts.chat, target: facts.target, record }, wait);
        if (anchoring === "never") this.env.log(`turn ${turn.slice(0, 8)}: its record wasn't anchored (the reply's message is gone)`);
        return;
      } catch (error) {
        if (error instanceof LiveError && error.problem === "closed" && this.env.now() - first < wait) continue;
        this.env.log(`turn ${turn.slice(0, 8)}: its record wasn't handed to LumiAH, so the session won't carry this turn (${problemOf(error).message})`);
        return;
      }
    }
  }
}
