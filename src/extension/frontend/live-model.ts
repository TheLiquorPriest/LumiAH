// A turn's trace as the Live and Sessions pages show it, pure so it is tested without a browser.
// `turnView` folds the trace's events into the turn's agents, in the order they started, each with
// what it was told and every step it took, how it stands, what it does now and what it spent.
// `feedOf` lays that out as the items the feed shows under a filter (one agent, kinds of step, one
// tool, only what went wrong), `findMatches` searches those items, `turnTotals` sums tokens, time
// and cost per call, per agent and for the turn, and `transcriptMarkdown` and `exportJson` are the
// turn as text, for Copy and Export. The view (transcript.tsx) only renders what these give.

import type { AgentStarted, AgentUsage, CallPrompt, CallUsage, LivePartial, LiveView, SessionTrace, ToolCallView, TraceEvent, TranscriptEntry, TurnKind } from "../../shared/ui";
import { count, counted, duration, money } from "./format";

type Ended = Extract<TraceEvent, { kind: "turn_ended" }>;
type Started = Extract<TraceEvent, { kind: "turn_started" }>;
export type Answer = Extract<TranscriptEntry, { kind: "answer" }>;
export type Result = Extract<TranscriptEntry, { kind: "result" }>;
export type Refusal = Extract<TranscriptEntry, { kind: "tools_refused" }>;
export type Retry = Extract<TranscriptEntry, { kind: "retry" }>;
export type Stop = Extract<TranscriptEntry, { kind: "stop" }>;

/** One step of an agent's work, with its place in the turn. */
export interface Step {
  seq: number;
  entry: TranscriptEntry;
}

/** How an agent stands: at work, finished its message, failed, stopped short (a limit, the loop detector, the turn's end), or cancelled. */
export type AgentState = "working" | "done" | "failed" | "stopped" | "cancelled";

/** What an agent at work waits on: its model's answer, or the results of the tools it called (by name), and since when. */
export type AgentActivity = { waits: "model"; since: number } | { waits: "tools"; since: number; names: string[] };

export interface AgentView {
  start: AgentStarted;
  /** Its place in the turn when it started. */
  seq: number;
  steps: Step[];
  /** It finished working its message, with what it had spent by then; null while it works. */
  idle: { spent: AgentUsage; at: number } | null;
  /** Core's tally of what it has spent so far; null before its first call's usage. */
  spent: AgentUsage | null;
  state: AgentState;
  /** What it waits on while it works; null once it doesn't. */
  activity: AgentActivity | null;
  /** The agents it started, in the order they started. */
  children: AgentView[];
  depth: number;
  /** When it last did anything. */
  lastAt: number;
}

export interface TurnView {
  view: LiveView;
  started: Started | null;
  session: SessionTrace | null;
  /** The agents no other agent started (the main agent), with the rest under them. */
  roots: AgentView[];
  /** Every agent, in the order it started. */
  agents: AgentView[];
  /** Core's tally for the turn: after its latest call, or what it ended with. */
  spent: AgentUsage | null;
  ended: Ended | null;
  /** What the call in flight of each agent at work has sent so far, by the agent's id. */
  partials: ReadonlyMap<string, LivePartial>;
}

/** The calls in flight worth showing: of an agent still at work, a call it hasn't answered yet, with something of its answer arrived. */
function partialsOf(view: LiveView, agents: readonly AgentView[]): Map<string, LivePartial> {
  const out = new Map<string, LivePartial>();
  for (const p of view.partials) {
    const a = agents.find((x) => x.start.id === p.agentId);
    if (!a || a.state !== "working" || (p.text === "" && p.reasoning === "")) continue;
    if (p.call > a.steps.reduce((n, s) => n + (s.entry.kind === "answer" ? 1 : 0), 0)) out.set(p.agentId, p);
  }
  return out;
}

/**
 * A turn as the pages show it. `before` is the turn as it was folded last: a delta of a call in
 * flight changes none of the turn's events, so their fold stands and only the calls in flight are
 * read again (a long turn would otherwise be folded anew for every word that arrives).
 */
export function turnView(view: LiveView, before?: TurnView | null): TurnView {
  const folded = before && before.view.events === view.events && before.view.ended === view.ended ? before : foldEvents(view);
  return { ...folded, view, partials: partialsOf(view, folded.agents) };
}

function foldEvents(view: LiveView): Omit<TurnView, "partials"> {
  const byId = new Map<string, AgentView>();
  const agents: AgentView[] = [];
  let started: Started | null = null;
  let session: SessionTrace | null = null;
  let spent: AgentUsage | null = null;
  let ended: Ended | null = null;
  for (const { seq, event } of view.events) {
    switch (event.kind) {
      case "turn_started":
        started = event;
        break;
      case "session":
        session = event.session;
        break;
      case "agent_started": {
        const a: AgentView = { start: event.agent, seq, steps: [], idle: null, spent: null, state: "working", activity: null, children: [], depth: 0, lastAt: event.agent.at };
        byId.set(event.agent.id, a);
        agents.push(a);
        break;
      }
      case "agent_entry": {
        const a = byId.get(event.agentId);
        if (!a) break;
        // A message after it finished starts it on that message: it works again.
        if (event.entry.kind === "message") a.idle = null;
        a.steps.push({ seq, entry: event.entry });
        a.lastAt = Math.max(a.lastAt, event.entry.at);
        break;
      }
      case "usage": {
        const a = byId.get(event.agentId);
        if (a) {
          a.spent = event.agent;
          a.lastAt = Math.max(a.lastAt, event.at);
        }
        spent = event.turn;
        break;
      }
      case "agent_idle": {
        const a = byId.get(event.agentId);
        if (!a) break;
        a.idle = { spent: event.spent, at: event.at };
        // The tally after its latest call is the agent's whole; what it finished with stands in only where no call reported one.
        a.spent ??= event.spent;
        a.lastAt = Math.max(a.lastAt, event.at);
        break;
      }
      case "turn_ended":
        ended = event;
        spent = event.usage;
        break;
    }
  }
  const roots: AgentView[] = [];
  const over = view.ended !== null || ended !== null;
  for (const a of agents) {
    const parent = a.start.parent !== undefined ? byId.get(a.start.parent) : undefined;
    if (parent && parent !== a) {
      parent.children.push(a);
      a.depth = parent.depth + 1;
    } else roots.push(a);
    a.state = agentState(a, over);
    a.activity = a.state === "working" ? agentActivity(a) : null;
  }
  return { view, started, session, roots, agents, spent, ended };
}

/** An agent's steps since the last message it was sent. */
function sinceLastMessage(a: AgentView): Step[] {
  let last = -1;
  a.steps.forEach((s, i) => {
    if (s.entry.kind === "message") last = i;
  });
  return a.steps.slice(last + 1);
}

/** An agent's state: by its stop, if it stopped short after its last message; done once it finished that message; else at work, or stopped once the turn ended without it finishing. */
function agentState(a: AgentView, turnEnded: boolean): AgentState {
  const stop = sinceLastMessage(a).findLast((s) => s.entry.kind === "stop");
  if (stop?.entry.kind === "stop") return stop.entry.status === "cancelled" ? "cancelled" : stop.entry.status === "failed" ? "failed" : "stopped";
  if (a.idle !== null) return "done";
  return turnEnded ? "stopped" : "working";
}

/** What an agent at work waits on: the results of its latest answer's calls while any is missing, else its model. */
function agentActivity(a: AgentView): AgentActivity | null {
  const last = a.steps.at(-1);
  if (!last) return { waits: "model", since: a.start.at };
  const answer = a.steps.findLast((s) => s.entry.kind === "answer")?.entry;
  if (answer?.kind === "answer" && answer.calls.length > 0) {
    const answered = new Set(a.steps.flatMap((s) => (s.entry.kind === "result" ? [s.entry.callId] : [])));
    const waiting = answer.calls.filter((c) => !answered.has(c.id));
    if (waiting.length > 0) return { waits: "tools", since: answer.at, names: waiting.map((c) => c.name) };
  }
  // An answer with no call is its last word: it finishes its message next.
  if (last.entry.kind === "answer" && last.entry.calls.length === 0) return null;
  if (last.entry.kind === "stop") return null;
  return { waits: "model", since: last.entry.at };
}

/** The model an agent ran on: the one its latest answer names, else the one its settings named; null for its connection's own, not yet heard. */
export function agentModel(a: AgentView): string | null {
  const answered = a.steps.findLast((s) => s.entry.kind === "answer");
  return answered?.entry.kind === "answer" && answered.entry.model !== "" ? answered.entry.model : a.start.model;
}

/** How long an agent has worked: from its start to its finish, or to `now` while it works. */
export function agentMs(a: AgentView, now: number): number {
  return Math.max(0, (a.state === "working" ? now : a.lastAt) - a.start.at);
}

/** What the agent was told first: its instructions, the prefix it shares with other agents before them. */
export function agentInstructions(start: AgentStarted): string {
  return [...start.prefix, start.system].filter((t) => t !== "").join("\n\n");
}

// ---------------------------------------------------------------- words

export const TURN_KIND_WORDS: Readonly<Record<TurnKind, string>> = { new: "New reply", regenerate: "Regenerate", swipe: "Swipe", continue: "Continue" };

export const AGENT_STATE_WORDS: Readonly<Record<AgentState, string>> = { working: "working", done: "done", failed: "failed", stopped: "stopped", cancelled: "cancelled" };

export const END_STATE_WORDS: Readonly<Record<NonNullable<LiveView["ended"]>["state"], string>> = { done: "done", failed: "failed", stopped: "stopped", lost: "lost with its runtime" };

/** How a turn ended, as the start of the line that says how long it took: "Finished in 15.2 s". */
export const END_LINE_WORDS: Readonly<Record<NonNullable<LiveView["ended"]>["state"], string>> = { done: "Finished in", failed: "Failed after", stopped: "Stopped after", lost: "Lost with its runtime after" };

/** How a turn ended, as a sentence: "The turn was stopped: …". */
export const END_SENTENCE_WORDS: Readonly<Record<NonNullable<LiveView["ended"]>["state"], string>> = { done: "The turn finished", failed: "The turn failed", stopped: "The turn was stopped", lost: "The turn was lost with its runtime" };

/** A role as a heading: "main" → "Main agent", "writer" → "Writer", anything else with its first letter raised. */
export function roleLabel(role: string): string {
  if (role === "main") return "Main agent";
  const words = role.replace(/[_-]+/g, " ").trim();
  return words === "" ? "Agent" : words.charAt(0).toUpperCase() + words.slice(1);
}

/** Which of a call's counts are estimates, by name. A tally only says that some are (`AgentUsage.estimated`), not which, so its figures are marked as a whole (`spentWords`). */
type Estimated = readonly string[];

const marked = (estimated: Estimated, field: string): string => (estimated.includes(field) ? "≈" : "");

/** Tokens in and out in words: "12,345 in (8,000 cached) · 456 out (120 reasoning)". Counts the runtime estimated are marked ≈. */
export function tokensWords(u: { in: number; out: number; cachedIn?: number; reasoningOut?: number }, estimated: Estimated = []): string {
  const cached = u.cachedIn ? ` (${marked(estimated, "cachedIn")}${count(u.cachedIn)} cached)` : "";
  const reasoning = u.reasoningOut ? ` (${marked(estimated, "reasoningOut")}${count(u.reasoningOut)} reasoning)` : "";
  return `${marked(estimated, "in")}${count(u.in)} in${cached} · ${marked(estimated, "out")}${count(u.out)} out${reasoning}`;
}

/** A cost in words: the provider's, or ≈ one worked out from the price settings; "cost unknown" when neither said. */
export function costWords(u: { cost?: number; estimated?: Estimated | boolean }): string {
  if (u.cost === undefined) return "cost unknown";
  return `${Array.isArray(u.estimated) ? marked(u.estimated, "cost") : ""}${money(u.cost)}`;
}

/** One call's figures in a line: model, tokens, time, cost, how it finished. */
export function callWords(e: Answer): string {
  return [e.model || "model", tokensWords(e.usage, e.usage.estimated), duration(e.ms), costWords(e.usage), e.finishReason || "stop"].join(" · ");
}

/** A usage tally in a line: calls, tokens, model time, cost, and whether some of it is the runtime's estimate. */
export function spentWords(u: AgentUsage): string {
  return [counted(u.calls, "call"), tokensWords(u), duration(u.ms), costWords(u), ...(u.estimated ? ["some of it estimated"] : [])].join(" · ");
}

/** What the main agent carries into the turn, a sentence a line. */
export function sessionWords(s: SessionTrace): string[] {
  const lines: string[] = [];
  lines.push(s.turns === 0 && !s.summary ? "Starts a new session: no earlier turn is carried." : `Carries ${counted(s.turns, "earlier turn")} (≈${count(s.tokens)} tokens)${s.summary ? ", after a summary of the ones before" : ""}.`);
  if (s.dropped.length > 0) lines.push(`Its notes from ${s.dropped.length === 1 ? "reply" : "replies"} ${s.dropped.map((i) => `#${i}`).join(", ")} were dropped: an earlier message changed, so they no longer fit the chat.`);
  if (s.missing > 0) lines.push(`${counted(s.missing, "stored part")} ${s.missing === 1 ? "was" : "were"} missing and left out.`);
  if (s.compacted) lines.push(`This turn compacted the session: ${counted(s.compacted.folded, "turn")} summarized, ${count(s.compacted.kept)} kept as ${s.compacted.kept === 1 ? "it was" : "they were"}.`);
  if (s.rolledBack) lines.push("A compaction was rolled back: the turns it summarized are read again in full.");
  return lines;
}

/** A stop in a sentence. */
export function stopWords(e: Stop): string {
  return `Stopped (${e.status}, ${e.code}): ${e.reason}`;
}

/** A refusal of native tools in a sentence. */
export function refusalWords(e: Refusal): string {
  return `Its connection refused native tools, so the call went again with them as text: ${e.reason}`;
}

/** A call that failed in passing and is made again, in a sentence: how long it took to fail, the wait, which try of how many, and the failure's own words. */
export function retryWords(e: Retry): string {
  return `Its call failed after ${duration(e.ms)} and is made again${e.waitMs > 0 ? ` after ${duration(e.waitMs)}` : ""}, try ${e.attempt} of ${e.of}: ${e.reason}`;
}

/** What a working agent waits on, in words. */
export function activityWords(activity: AgentActivity): string {
  if (activity.waits === "model") return "Waiting for its model";
  return activity.names.length === 1 ? `Running ${activity.names[0]}` : `Running ${activity.names.length} tools: ${activity.names.join(", ")}`;
}

/** A call in flight, in words: which of the agent's calls it is and how much of its thinking and its answer has arrived. */
export function streamingWords(item: { call: number; text: number; reasoning: number }): string {
  const parts = [...(item.reasoning > 0 ? [[item.reasoning, "thinking"] as const] : []), ...(item.text > 0 ? [[item.text, "its answer"] as const] : [])];
  // "characters" is said once, of the first: "1,280 characters of thinking, 11 of its answer".
  const arrived = parts.map(([n, what], i) => `${count(n)}${i === 0 ? " characters" : ""} of ${what}`);
  return `Call ${item.call} is answering · ${arrived.join(", ")} so far`;
}

// ---------------------------------------------------------------- the feed

/** The kinds of step a filter shows: what an agent was told (its instructions and messages), its thinking, its answers, its tool calls with their results, and its stops. */
export type StepKind = "told" | "thinking" | "answer" | "tools" | "stops";

export const STEP_KIND_WORDS: Readonly<Record<StepKind, string>> = { told: "Told", thinking: "Thinking", answer: "Answers", tools: "Tool calls", stops: "Stops" };

export const ALL_KINDS: readonly StepKind[] = ["told", "thinking", "answer", "tools", "stops"];

export interface Filter {
  /** The one agent shown (and the agents it started); null for every agent. */
  agent: string | null;
  kinds: readonly StepKind[];
  /** Among tool calls, only this tool's; null for every tool's. */
  tool: string | null;
  /** Only what went wrong: failed tool calls, stops, refusals, and calls that finished short. */
  problems: boolean;
  query: string;
}

export const NO_FILTER: Filter = { agent: null, kinds: ALL_KINDS, tool: null, problems: false, query: "" };

/** How a tool call stands: waiting for its result, answered, failed, or left with none (its agent stopped first). */
export type CallState = "running" | "done" | "error" | "none";

export function callState(result: Result | null, agentWorking: boolean): CallState {
  if (result) return result.error ? "error" : "done";
  return agentWorking ? "running" : "none";
}

/**
 * One thing the feed shows of an agent, by a key that stays the same as the turn grows:
 * its instructions; the messages of its session it takes up; a message it was told; a call's line
 * (`call`: its number among the agent's calls) with the call's thinking, text and tool calls as
 * items of their own; a result no call shown asked for; a refusal; a retry; a stop; what it waits on
 * now, or the call in flight with what has arrived of its thinking and its answer (`live`); and its
 * finish.
 */
export type FeedItem =
  | { key: string; kind: "instructions"; seq: number; text: string }
  | { key: string; kind: "history"; seq: number; messages: number }
  | { key: string; kind: "told"; seq: number; text: string; at: number }
  | { key: string; kind: "call"; seq: number; entry: Answer; call: number }
  | { key: string; kind: "thinking"; seq: number; text: string; live?: true }
  | { key: string; kind: "said"; seq: number; text: string; live?: true }
  | { key: string; kind: "tool"; seq: number; call: ToolCallView; args: string; result: Result | null; state: CallState }
  | { key: string; kind: "result"; seq: number; entry: Result }
  | { key: string; kind: "refused"; seq: number; entry: Refusal; text: string }
  | { key: string; kind: "retry"; seq: number; entry: Retry; text: string }
  | { key: string; kind: "stop"; seq: number; entry: Stop; text: string }
  | { key: string; kind: "activity"; seq: number; activity: AgentActivity }
  | { key: string; kind: "streaming"; seq: number; call: number; since: number; text: number; reasoning: number }
  | { key: string; kind: "finished"; seq: number; spent: AgentUsage; at: number };

export interface AgentFeed {
  agent: AgentView;
  items: FeedItem[];
  /** Steps before the window, not shown. */
  hidden: number;
}

/**
 * How a provider says a call finished short of its answer (out of room, filtered, failed). These are
 * the providers' own words, matched loosely because each spells them its own way; a setting couldn't
 * list them better than the providers do.
 */
const SHORT_FINISH = /length|max_tokens|filter|error/i;

/** Whether a call finished short of a whole answer. */
export function finishedShort(e: Answer): boolean {
  return SHORT_FINISH.test(e.finishReason);
}

/** The agents a filter shows: the one it names and those it started, or all. */
export function agentsShown(turn: TurnView, agent: string | null): AgentView[] {
  if (agent === null) return turn.agents;
  const root = turn.agents.find((a) => a.start.id === agent);
  if (!root) return turn.agents;
  const out: AgentView[] = [];
  const walk = (a: AgentView): void => {
    out.push(a);
    for (const c of a.children) walk(c);
  };
  walk(root);
  return out;
}

/** The tools a turn's agents called, by name, each once, in the order first called. */
export function toolsCalled(turn: TurnView): string[] {
  const names = new Set<string>();
  for (const a of turn.agents) for (const s of a.steps) if (s.entry.kind === "answer") for (const c of s.entry.calls) names.add(c.name);
  return [...names];
}

/**
 * The feed under a filter: each agent shown, with the items of its steps from `from` on (a step's
 * place in the turn; 0 for all). An agent with nothing to show under "only what went wrong" is left
 * out. A call's line shows whenever any part of the call does, so nothing shows without its call.
 */
export function feedOf(turn: TurnView, filter: Filter, from = 0): AgentFeed[] {
  const kinds = new Set(filter.kinds);
  const out: AgentFeed[] = [];
  for (const a of agentsShown(turn, filter.agent)) {
    const id = a.start.id;
    const items: FeedItem[] = [];
    const results = new Map<string, Result>();
    const called = new Set<string>();
    for (const s of a.steps) {
      if (s.entry.kind === "result") results.set(s.entry.callId, s.entry);
      // A call counts as shown only where its answer is in the window: a result whose call scrolled out of it stands on its own.
      else if (s.entry.kind === "answer" && s.seq >= from) for (const c of s.entry.calls) called.add(c.id);
    }
    if (kinds.has("told") && !filter.problems) {
      const text = agentInstructions(a.start);
      if (text !== "") items.push({ key: `i:${id}`, kind: "instructions", seq: a.seq, text });
      if (a.start.history > 0) items.push({ key: `h:${id}`, kind: "history", seq: a.seq, messages: a.start.history });
    }
    let calls = 0;
    let hidden = 0;
    for (const s of a.steps) {
      const e = s.entry;
      if (e.kind === "answer") calls += 1;
      if (s.seq < from) {
        hidden += 1;
        continue;
      }
      switch (e.kind) {
        case "message":
          if (kinds.has("told") && !filter.problems) items.push({ key: `m:${s.seq}`, kind: "told", seq: s.seq, text: e.text, at: e.at });
          break;
        case "answer": {
          const parts: FeedItem[] = [];
          if (kinds.has("thinking") && !filter.problems && e.reasoning !== undefined && e.reasoning !== "") parts.push({ key: `r:${s.seq}`, kind: "thinking", seq: s.seq, text: e.reasoning });
          if (kinds.has("answer") && !filter.problems && e.text.trim() !== "") parts.push({ key: `t:${s.seq}`, kind: "said", seq: s.seq, text: e.text });
          if (kinds.has("tools"))
            for (const c of e.calls) {
              const result = results.get(c.id) ?? null;
              if (filter.tool !== null && c.name !== filter.tool) continue;
              if (filter.problems && result?.error !== true) continue;
              parts.push({ key: `c:${s.seq}:${c.id}`, kind: "tool", seq: s.seq, call: c, args: JSON.stringify(c.args, null, 2), result, state: callState(result, a.state === "working") });
            }
          const own = filter.problems ? finishedShort(e) && kinds.has("answer") : kinds.has("answer");
          if (own || parts.length > 0) items.push({ key: `a:${s.seq}`, kind: "call", seq: s.seq, entry: e, call: calls }, ...parts);
          break;
        }
        case "result":
          // A result shows in its call's card; one whose call isn't in the transcript stands on its own.
          if (called.has(e.callId) || !kinds.has("tools")) break;
          if (filter.tool !== null && e.name !== filter.tool) break;
          if (filter.problems && !e.error) break;
          items.push({ key: `o:${s.seq}`, kind: "result", seq: s.seq, entry: e });
          break;
        case "tools_refused":
          if (kinds.has("stops")) items.push({ key: `x:${s.seq}`, kind: "refused", seq: s.seq, entry: e, text: refusalWords(e) });
          break;
        case "retry":
          // A call that failed, though it was made again: among what went wrong, beside the refusals and the stops.
          if (kinds.has("stops")) items.push({ key: `y:${s.seq}`, kind: "retry", seq: s.seq, entry: e, text: retryWords(e) });
          break;
        case "stop":
          if (kinds.has("stops")) items.push({ key: `s:${s.seq}`, kind: "stop", seq: s.seq, entry: e, text: stopWords(e) });
          break;
      }
    }
    if (!filter.problems) {
      const end = (a.steps.at(-1)?.seq ?? a.seq) + 0.5;
      const live = turn.partials.get(id);
      if (live) {
        // The call in flight, in place of "waiting for its model": a line that says so, then what has arrived of its thinking and of its answer, each growing as it comes.
        items.push({ key: `l:${id}:${live.call}`, kind: "streaming", seq: end, call: live.call, since: a.activity?.since ?? live.at, text: live.text.length, reasoning: live.reasoning.length });
        if (kinds.has("thinking") && live.reasoning !== "") items.push({ key: `lr:${id}:${live.call}`, kind: "thinking", seq: end, text: live.reasoning, live: true });
        if (kinds.has("answer") && live.text !== "") items.push({ key: `lt:${id}:${live.call}`, kind: "said", seq: end, text: live.text, live: true });
      } else if (a.activity) items.push({ key: `w:${id}`, kind: "activity", seq: end, activity: a.activity });
      else if (a.idle) items.push({ key: `f:${id}`, kind: "finished", seq: end, spent: a.idle.spent, at: a.idle.at });
    }
    if (filter.problems && items.length === 0) continue;
    out.push({ agent: a, items, hidden });
  }
  return out;
}

/**
 * The steps shown when a transcript is long: the latest `shown` of them, by their place in the turn;
 * the seq of the first one shown (every step from it on shows), and how many come before it.
 */
export function stepWindow(turn: TurnView, shown: number): { from: number; hidden: number } {
  const seqs = turn.agents.flatMap((a) => a.steps.map((s) => s.seq)).sort((x, y) => x - y);
  if (seqs.length <= shown) return { from: 0, hidden: 0 };
  const from = seqs[seqs.length - shown] ?? 0;
  return { from, hidden: seqs.length - shown };
}

// ---------------------------------------------------------------- search

/** The texts of an item a search reads, in the order the item shows them. */
export function itemTexts(item: FeedItem): string[] {
  switch (item.kind) {
    case "instructions":
    case "told":
    case "thinking":
    case "said":
    case "refused":
    case "retry":
    case "stop":
      return [item.text];
    case "call":
      return [callWords(item.entry)];
    case "tool":
      return [item.call.name, item.args, item.result?.text ?? ""];
    case "result":
      return [item.entry.name, item.entry.text];
    case "history":
    case "activity":
    case "streaming":
    case "finished":
      return [];
  }
}

/** Where a search found its query: an item's text (`field`, as `itemTexts` orders them), and how many times. */
export interface MatchGroup {
  key: string;
  agentId: string;
  seq: number;
  field: number;
  count: number;
}

function occurrences(text: string, q: string): number {
  if (text.length < q.length) return 0;
  const lower = text.toLowerCase();
  let n = 0;
  for (let at = lower.indexOf(q); at !== -1; at = lower.indexOf(q, at + q.length)) n += 1;
  return n;
}

/** Every place the query is found in the feed, in the feed's order; none for an empty query. Case is ignored. */
export function findMatches(feeds: readonly AgentFeed[], query: string): MatchGroup[] {
  const q = query.trim().toLowerCase();
  if (q === "") return [];
  const out: MatchGroup[] = [];
  for (const feed of feeds)
    for (const item of feed.items)
      itemTexts(item).forEach((text, field) => {
        const n = occurrences(text, q);
        if (n > 0) out.push({ key: item.key, agentId: feed.agent.start.id, seq: item.seq, field, count: n });
      });
  return out;
}

/** How many times the query was found in all. */
export function matchTotal(groups: readonly MatchGroup[]): number {
  return groups.reduce((sum, g) => sum + g.count, 0);
}

/** The `index`th find (from 0, wrapping round): the text it is in and its place among that text's finds; null when there are none. */
export function matchAt(groups: readonly MatchGroup[], index: number): { group: MatchGroup; nth: number } | null {
  const total = matchTotal(groups);
  if (total === 0) return null;
  let left = ((index % total) + total) % total;
  for (const group of groups) {
    if (left < group.count) return { group, nth: left };
    left -= group.count;
  }
  return null;
}

/** How many times the query was found in each item, by the item's key. */
export function matchCounts(groups: readonly MatchGroup[]): Map<string, number> {
  const out = new Map<string, number>();
  for (const g of groups) out.set(g.key, (out.get(g.key) ?? 0) + g.count);
  return out;
}

/** A text cut where the query is found, for marking: the pieces in order, each a find or not. Case is ignored. */
export function markPieces(text: string, query: string): { text: string; hit: boolean }[] {
  const q = query.trim().toLowerCase();
  if (q === "") return [{ text, hit: false }];
  const lower = text.toLowerCase();
  const out: { text: string; hit: boolean }[] = [];
  let from = 0;
  for (let at = lower.indexOf(q); at !== -1; at = lower.indexOf(q, at + q.length)) {
    if (at > from) out.push({ text: text.slice(from, at), hit: false });
    out.push({ text: text.slice(at, at + q.length), hit: true });
    from = at + q.length;
  }
  if (from < text.length) out.push({ text: text.slice(from), hit: false });
  return out;
}

// ---------------------------------------------------------------- totals

/** Sums of tokens, time and cost. `cost` is what the priced calls came to, and `unpriced` how many calls had no cost, so a sum that misses some says so. */
export interface Totals {
  calls: number;
  toolCalls: number;
  toolErrors: number;
  in: number;
  cachedIn: number;
  cacheWrite: number;
  out: number;
  reasoningOut: number;
  /** Some of the token counts are the runtime's estimate. */
  estimated: boolean;
  /** Some of the cost was worked out from the price settings, not said by a provider. */
  costEstimated: boolean;
  /** The time its model calls took, and its tools. */
  modelMs: number;
  toolMs: number;
  cost: number;
  unpriced: number;
}

/** One model call, as the totals list it. */
export interface CallRow {
  agentId: string;
  seq: number;
  /** Its number among its agent's calls, from 1. */
  call: number;
  model: string;
  /** When it was asked (its answer's time less how long it took) and how long it took. */
  startedAt: number;
  ms: number;
  usage: CallUsage;
  finishReason: string;
  /** The tools it called, and how long they took together. */
  tools: number;
  toolMs: number;
  prompt: string | null;
}

export interface AgentTotals extends Totals {
  agent: AgentView;
  /** From its start to the last thing it did. */
  wallMs: number;
}

export interface TurnTotals {
  agents: AgentTotals[];
  calls: CallRow[];
  turn: Totals & { wallMs: number };
}

const noTotals = (): Totals => ({ calls: 0, toolCalls: 0, toolErrors: 0, in: 0, cachedIn: 0, cacheWrite: 0, out: 0, reasoningOut: 0, estimated: false, costEstimated: false, modelMs: 0, toolMs: 0, cost: 0, unpriced: 0 });

function addCall(t: Totals, e: Answer): void {
  t.calls += 1;
  t.in += e.usage.in;
  t.cachedIn += e.usage.cachedIn;
  t.cacheWrite += e.usage.cacheWrite ?? 0;
  t.out += e.usage.out;
  t.reasoningOut += e.usage.reasoningOut;
  t.estimated ||= e.usage.estimated.some((field) => field !== "cost");
  t.costEstimated ||= e.usage.estimated.includes("cost");
  t.modelMs += e.ms;
  if (e.usage.cost === undefined) t.unpriced += 1;
  else t.cost += e.usage.cost;
}

/**
 * Core's tally over the sums of the steps, where core gave one: its counts are the whole (a call a
 * connection refused spent time no answer shows), while the steps say how many calls went unpriced
 * and which counts are estimates (a tally only says that some are, the cost's among them).
 */
function withTally(sum: Totals, tally: AgentUsage | null): void {
  if (tally === null) return;
  // No answer to say which counts are estimates: the tally's word stands for the tokens.
  if (sum.calls === 0) sum.estimated ||= tally.estimated;
  sum.calls = Math.max(sum.calls, tally.calls);
  sum.in = tally.in;
  sum.cachedIn = tally.cachedIn;
  sum.cacheWrite = tally.cacheWrite ?? sum.cacheWrite;
  sum.out = tally.out;
  sum.reasoningOut = tally.reasoningOut;
  sum.modelMs = Math.max(sum.modelMs, tally.ms);
  if (tally.cost !== undefined) {
    sum.cost = tally.cost;
    sum.unpriced = 0;
  }
}

/**
 * Tokens, time and cost per call, per agent and for the turn. `now` ends the time of what still
 * runs. A turn's sums are its agents' together, with core's tally for the turn over them.
 */
export function turnTotals(turn: TurnView, now: number): TurnTotals {
  const calls: CallRow[] = [];
  const agents: AgentTotals[] = [];
  const all = noTotals();
  for (const a of turn.agents) {
    const sum = noTotals();
    let n = 0;
    const row = new Map<string, CallRow>();
    for (const s of a.steps) {
      const e = s.entry;
      if (e.kind === "answer") {
        n += 1;
        addCall(sum, e);
        sum.toolCalls += e.calls.length;
        const r: CallRow = { agentId: a.start.id, seq: s.seq, call: n, model: e.model, startedAt: e.at - e.ms, ms: e.ms, usage: e.usage, finishReason: e.finishReason, tools: e.calls.length, toolMs: 0, prompt: e.prompt ?? null };
        calls.push(r);
        for (const c of e.calls) row.set(c.id, r);
      } else if (e.kind === "result") {
        sum.toolMs += e.ms;
        if (e.error) sum.toolErrors += 1;
        const r = row.get(e.callId);
        if (r) r.toolMs += e.ms;
      } else if (e.kind === "tools_refused" || e.kind === "retry") sum.modelMs += e.ms;
    }
    withTally(sum, a.spent);
    agents.push({ ...sum, agent: a, wallMs: agentMs(a, now) });
    all.calls += sum.calls;
    all.toolCalls += sum.toolCalls;
    all.toolErrors += sum.toolErrors;
    all.in += sum.in;
    all.cachedIn += sum.cachedIn;
    all.cacheWrite += sum.cacheWrite;
    all.out += sum.out;
    all.reasoningOut += sum.reasoningOut;
    all.estimated ||= sum.estimated;
    all.costEstimated ||= sum.costEstimated;
    all.modelMs += sum.modelMs;
    all.toolMs += sum.toolMs;
    all.cost += sum.cost;
    all.unpriced += sum.unpriced;
  }
  withTally(all, turn.spent);
  const end = turn.view.ended?.at ?? turn.ended?.at ?? now;
  return { agents, calls, turn: { ...all, wallMs: Math.max(0, end - turn.view.startedAt) } };
}

/** A sum's cost in words: "$0.012", "≈$0.012" when worked out from the price settings, "$0.012 + 2 calls unpriced" when some had none, "cost unknown" when none had. */
export function totalCostWords(t: Totals): string {
  if (t.calls === 0) return "$0";
  if (t.unpriced >= t.calls && t.cost === 0) return "cost unknown";
  const cost = `${t.costEstimated ? "≈" : ""}${money(t.cost)}`;
  return t.unpriced > 0 ? `${cost} + ${counted(t.unpriced, "call")} unpriced` : cost;
}

/** A value as a CSV field: quoted where it holds a comma, a quote or a line break. */
function csvField(value: string | number): string {
  const text = String(value);
  return /[",\n\r]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
}

/** Tokens, time and cost per call as CSV, a call a row, for a spreadsheet: which agent made it, on which model, when, how long it took, what it spent (and which of those counts are estimates), how it finished, and the tools it called. */
export function totalsCsv(totals: TurnTotals): string {
  const role = new Map(totals.agents.map((t) => [t.agent.start.id, t.agent.start.role]));
  const head = ["agent", "role", "call", "model", "started", "ms", "in", "cached_in", "cache_write", "out", "reasoning_out", "estimated", "cost_usd", "finish", "tool_calls", "tool_ms", "prompt"];
  // A cost worked out from prices carries the arithmetic's noise in its last places (0.0007761600000000001): ten significant digits keep every digit that means something.
  const rows = totals.calls.map((c) => [c.agentId, role.get(c.agentId) ?? "", c.call, c.model, new Date(c.startedAt).toISOString(), c.ms, c.usage.in, c.usage.cachedIn, c.usage.cacheWrite ?? 0, c.usage.out, c.usage.reasoningOut, c.usage.estimated.join(" "), c.usage.cost === undefined ? "" : Number(c.usage.cost.toPrecision(10)), c.finishReason, c.tools, c.toolMs, c.prompt ?? ""]);
  return `${[head, ...rows].map((row) => row.map(csvField).join(",")).join("\n")}\n`;
}


// ---------------------------------------------------------------- the transcript as text

function fenced(text: string): string {
  const fence = text.includes("```") ? "~~~~" : "```";
  return `${fence}\n${text}\n${fence}`;
}

function itemMarkdown(item: FeedItem): string | null {
  switch (item.kind) {
    case "instructions":
      return `**Instructions**\n${fenced(item.text)}`;
    case "history":
      return `Takes up ${counted(item.messages, "message")} of its session.`;
    case "told":
      return `**Told** · ${new Date(item.at).toISOString()}\n${fenced(item.text)}`;
    case "call":
      return `**Call ${item.call}** · ${callWords(item.entry)}${item.entry.tools === "text" ? " · tools as text" : ""}${item.entry.prompt ? ` · prompt ${item.entry.prompt}` : ""}`;
    case "thinking":
      return `Thinking${item.live ? " (so far)" : ""}:\n${fenced(item.text)}`;
    case "said":
      return `Answer${item.live ? " (so far)" : ""}:\n${fenced(item.text)}`;
    case "tool": {
      const head = `→ \`${item.call.name}\` ${JSON.stringify(item.call.args)}`;
      if (!item.result) return `${head}\n← ${item.state === "running" ? "(still running)" : "(no result: its agent stopped first)"}`;
      return `${head}\n← ${item.result.error ? "failed" : "result"} · ${duration(item.result.ms)}${item.result.scratch ? ` · clipped, the whole kept as ${item.result.scratch}` : ""}\n${fenced(item.result.text)}`;
    }
    case "result":
      return `← \`${item.entry.name}\`${item.entry.error ? " (failed)" : ""} · ${duration(item.entry.ms)}\n${fenced(item.entry.text)}`;
    case "refused":
    case "retry":
    case "stop":
      return item.text;
    case "activity":
      return `(${activityWords(item.activity)}…)`;
    case "streaming":
      return `(${streamingWords(item)}…)`;
    case "finished":
      return `Finished its message · ${spentWords(item.spent)}`;
  }
}

/**
 * The turn as Markdown, for Copy and Export: what it answered and how it went, its totals, its
 * session, then each agent of `feeds` (the whole turn's, or what a filter shows) with every item in
 * order; and how the turn ended.
 */
export function transcriptMarkdown(turn: TurnView, feeds: readonly AgentFeed[] = feedOf(turn, NO_FILTER), now: number = turn.view.ended?.at ?? turn.view.startedAt): string {
  const { view } = turn;
  const totals = turnTotals(turn, now);
  const out: string[] = [];
  out.push(`# ${TURN_KIND_WORDS[view.kind]} · turn ${view.turn}`);
  const ended = view.ended ? `${END_LINE_WORDS[view.ended.state].toLowerCase()} ${duration(view.ended.at - view.startedAt)}${view.ended.reason ? `: ${view.ended.reason}` : ""}` : "still running";
  out.push(`Chat ${view.chatId}${view.messageId ? ` · message ${view.messageId}` : ""} · started ${new Date(view.startedAt).toISOString()} · ${ended}`);
  out.push(`Spent: ${totalsWords(totals.turn)}`);
  if (turn.session) out.push(`Session: ${sessionWords(turn.session).join(" ")}`);
  if (totals.agents.length > 0) {
    const rows = totals.agents.map((t) => `| ${roleLabel(t.agent.start.role)} | ${t.calls} | ${count(t.in)} | ${count(t.cachedIn)} | ${count(t.out)} | ${count(t.reasoningOut)} | ${duration(t.modelMs)} | ${duration(t.toolMs)} | ${totalCostWords(t)} |`);
    out.push(["| Agent | Calls | In | Cached | Out | Reasoning | Model time | Tool time | Cost |", "|---|---:|---:|---:|---:|---:|---:|---:|---:|", ...rows].join("\n"));
  }
  for (const feed of feeds) {
    const a = feed.agent;
    out.push(`## ${roleLabel(a.start.role)}${a.start.task ? ` · ${a.start.task}` : ""} · ${AGENT_STATE_WORDS[a.state]}`);
    out.push(`${agentModel(a) ?? "the connection's model"}${a.start.connectionId ? ` on ${a.start.connectionId}` : ""} · effort ${a.start.effort}${a.start.parent ? ` · started by ${a.start.parent}` : ""}`);
    if (feed.hidden > 0) out.push(`(${counted(feed.hidden, "earlier step")} not shown)`);
    for (const item of feed.items) {
      const text = itemMarkdown(item);
      if (text !== null) out.push(text);
    }
  }
  if (view.ended) out.push(`## Ended: ${END_STATE_WORDS[view.ended.state]}${view.ended.reason ? `: ${view.ended.reason}` : ""}`);
  return `${out.join("\n\n")}\n`;
}

/** A sum's tokens in words; ≈ where some of the counts are the runtime's estimate. */
export function totalTokensWords(t: Totals): string {
  const est = t.estimated ? "≈" : "";
  return `${est}${count(t.in)} in${t.cachedIn > 0 ? ` (${count(t.cachedIn)} cached)` : ""} · ${est}${count(t.out)} out${t.reasoningOut > 0 ? ` (${count(t.reasoningOut)} reasoning)` : ""}`;
}

/** A sum in a line: calls, tokens, time, cost. */
export function totalsWords(t: Totals): string {
  return [counted(t.calls, "call"), totalTokensWords(t), `${duration(t.modelMs)} in the model`, ...(t.toolCalls > 0 ? [`${counted(t.toolCalls, "tool call")} (${duration(t.toolMs)})`] : []), totalCostWords(t)].join(" · ");
}

/** The level of the export's shape, so a reader of the file can tell. */
export const EXPORT_VERSION = 1;

/** The turn as JSON, for Export: the view with every event as traced and, where they were read, each call's exact prompt by its hash. */
export function exportJson(view: LiveView, prompts: Readonly<Record<string, CallPrompt>> | null, exportedAt: number): string {
  return JSON.stringify({ lumiah: "turn", version: EXPORT_VERSION, exportedAt: new Date(exportedAt).toISOString(), view, ...(prompts !== null ? { prompts } : {}) }, null, 2);
}

/** The hashes of every call's exact prompt in the turn, each once, in the turn's order. */
export function promptHashes(view: LiveView): string[] {
  const out = new Set<string>();
  for (const { event } of view.events) if (event.kind === "agent_entry" && (event.entry.kind === "answer" || event.entry.kind === "tools_refused" || event.entry.kind === "retry" || event.entry.kind === "stop") && event.entry.prompt) out.add(event.entry.prompt);
  return [...out];
}

/** A file name for a turn's export: `lumiah-<kind>-<turn>[-<what>].<ext>`, in characters every file system takes; `what` tells two files of one kind apart (the events with their prompts, a transcript of only what is shown). A turn's id is its generation's (a uuid's 36 characters); the cut at 60 only keeps an odd one from making a name too long for some systems. */
export function exportName(view: LiveView, ext: "md" | "json" | "csv", what?: string): string {
  return `lumiah-${view.kind}-${view.turn.replace(/[^A-Za-z0-9_-]+/g, "-").slice(0, 60)}${what ? `-${what}` : ""}.${ext}`;
}
