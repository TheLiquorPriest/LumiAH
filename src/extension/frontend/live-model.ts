// A turn's trace as the Live and Sessions pages show it, pure so it is tested without a browser.
// `turnView` folds the trace's events into the turn's agents, in the order they started, each with
// what it was told and every step it took, how it stands, what it does now and what it spent.
// `feedOf` lays that out as the items the feed shows under a filter (one agent, kinds of step, one
// tool, only what went wrong), `findMatches` searches those items, `turnTotals` sums tokens, time
// and cost per call, per agent and for the turn, and `transcriptMarkdown` and `exportJson` are the
// turn as text, for Copy and Export. The view (transcript.tsx) only renders what these give.

import { type AgentStarted, type AgentStopCode, type AgentUsage, type CallPrompt, type CallUsage, type FileChange, isReply, type JobState, type JobView, type LiveEnded, type LivePartial, type LiveView, type LoreChanges, loreChangesOf, type PromptHeld, promptHeldOf, type ReplyDid, type RunKind, type SessionTrace, type ToolCallView, type ToolTier, type TraceEvent, type TranscriptEntry, type TurnKind } from "../../shared/ui";
import type { PageId } from "./app";
import { count, counted, duration, elapsed, money } from "./format";
import { whyWords } from "./lore-model";
import { plainWords } from "./prose-model";
import type { SettingLink } from "./setting-links";

type Ended = Extract<TraceEvent, { kind: "turn_ended" }>;
type Started = Extract<TraceEvent, { kind: "turn_started" }>;
export type Answer = Extract<TranscriptEntry, { kind: "answer" }>;
export type Result = Extract<TranscriptEntry, { kind: "result" }>;
export type Refusal = Extract<TranscriptEntry, { kind: "tools_refused" }>;
export type Retry = Extract<TranscriptEntry, { kind: "retry" }>;
export type Stop = Extract<TranscriptEntry, { kind: "stop" }>;
export type Asked = Extract<TranscriptEntry, { kind: "approval_asked" }>;
export type Worded = Extract<TranscriptEntry, { kind: "approval" }>;

/** One step of an agent's work, with its place in the turn. */
export interface Step {
  seq: number;
  entry: TranscriptEntry;
}

/** How an agent stands: at work, finished its message, failed, stopped short (a limit, the loop detector, the turn's end), or cancelled. */
export type AgentState = "working" | "done" | "failed" | "stopped" | "cancelled";

/** What an agent at work waits on: its model's answer, the results of the tools it called (by name), or the user's word on a tool call of its that is held for approval; and since when. */
export type AgentActivity = { waits: "model"; since: number } | { waits: "tools"; since: number; names: string[] } | { waits: "word"; since: number; tool: string };

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

/** Something that happened to a run as a whole, or was started from it, at its place in the run: the user held it or let it go on (DESIGN §18), one of its agents started a job (§15), or the runtime has something to tell the user about the run that is no agent's step: something that went wrong (its notes couldn't be stored), or, `info`, something that only says how it went. */
export type TurnMark = { seq: number; at: number; kind: "paused" | "resumed" } | { seq: number; at: number; kind: "job"; job: JobView } | { seq: number; at: number; kind: "notice"; text: string; info: boolean };

export interface TurnView {
  view: LiveView;
  started: Started | null;
  session: SessionTrace | null;
  /** What the prompt held, as the main agent was told (DESIGN §24.1); null where the trace doesn't say (a run that answers no generation, a transcript kept before it was traced). */
  held: (PromptHeld & { at: number }) | null;
  /** The agents no other agent started (the main agent), with the rest under them. */
  roots: AgentView[];
  /** Every agent, in the order it started. */
  agents: AgentView[];
  /** Every agent, each right under the agent that started it: the order the feed and the outline show them in, so an agent's sub-agents never stand under another's. */
  nested: AgentView[];
  /** The user holds the run: its agents wait before their next round. */
  paused: boolean;
  marks: TurnMark[];
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
  let held: TurnView["held"] = null;
  let spent: AgentUsage | null = null;
  let ended: Ended | null = null;
  let paused = false;
  const marks: TurnMark[] = [];
  for (const { seq, event } of view.events) {
    // What the prompt held is read by its shape (`promptHeldOf` says why), so it is taken before the events core's union names.
    const prompt = promptHeldOf(event);
    if (prompt !== null) {
      held = prompt;
      continue;
    }
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
      case "turn_paused":
        paused = true;
        marks.push({ seq, at: event.at, kind: "paused" });
        break;
      case "turn_resumed":
        paused = false;
        marks.push({ seq, at: event.at, kind: "resumed" });
        break;
      case "job":
        marks.push({ seq, at: event.at, kind: "job", job: event.job });
        break;
      case "notice":
        // Whether a notice is no problem is read by its shape: a transcript kept by a build whose trace didn't say takes every one as a problem, as it was shown then.
        marks.push({ seq, at: event.at, kind: "notice", text: event.text, info: "info" in event && event.info === true });
        break;
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
  const nested: AgentView[] = [];
  const walk = (a: AgentView): void => {
    nested.push(a);
    for (const child of a.children) walk(child);
  };
  for (const root of roots) walk(root);
  return { view, started, session, held, roots, agents, nested, paused: paused && !over, marks, spent, ended };
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

/** What an agent at work waits on: the user's word while a call of its is held; else the results of its latest answer's calls while any is missing; else its model. */
function agentActivity(a: AgentView): AgentActivity | null {
  const last = a.steps.at(-1);
  if (!last) return { waits: "model", since: a.start.at };
  const asked = a.steps.findLast((s) => s.entry.kind === "approval_asked")?.entry;
  if (asked?.kind === "approval_asked" && !a.steps.some((s) => s.entry.kind === "approval" && s.entry.callId === asked.callId)) return { waits: "word", since: asked.at, tool: asked.tool };
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

/** What a run is called at its head: a reply by the generation it answers, a job's run and a side session's turn by what they are. */
export const RUN_KIND_WORDS: Readonly<Record<RunKind, string>> = { ...TURN_KIND_WORDS, job: "Job", side: "Conversation turn" };

export function runTitle(view: Pick<LiveView, "kind">): string {
  return RUN_KIND_WORDS[view.kind];
}

/** A tool's tier in a word, as a badge says it. */
export const TIER_WORDS: Readonly<Record<ToolTier, string>> = { read: "reads", write: "writes", external: "reaches outside" };

export const AGENT_STATE_WORDS: Readonly<Record<AgentState, string>> = { working: "working", done: "done", failed: "failed", stopped: "stopped", cancelled: "cancelled" };

export const END_STATE_WORDS: Readonly<Record<NonNullable<LiveView["ended"]>["state"], string>> = { done: "done", failed: "failed", stopped: "stopped", lost: "lost with its runtime" };

/** How a turn ended, as the start of the line that says how long it took: "Finished in 15.2 s". */
export const END_LINE_WORDS: Readonly<Record<NonNullable<LiveView["ended"]>["state"], string>> = { done: "Finished in", failed: "Failed after", stopped: "Stopped after", lost: "Lost with its runtime after" };

/** How a turn ended, as a sentence: "The turn was stopped: …". */
export const END_SENTENCE_WORDS: Readonly<Record<NonNullable<LiveView["ended"]>["state"], string>> = { done: "The turn finished", failed: "The turn failed", stopped: "The turn was stopped", lost: "The turn was lost with its runtime" };

// ---------------------------------------------------------------- what a reply's turn came to, in words (the head of Live, Home's last reply)

/**
 * How much of a brief shows before the rest folds behind "Show all of it": about four lines of a
 * phone's card. Not a setting: nothing is hidden for good, it only says where the fold is.
 */
const BRIEF_SHOWN_CHARS = 280;

/** A brief's opening as plain words, cut at a word's end; null where the brief is short enough to show whole. */
export function briefOpening(brief: string): string | null {
  const words = plainWords(brief);
  if (words.length <= BRIEF_SHOWN_CHARS) return null;
  const cut = words.slice(0, BRIEF_SHOWN_CHARS);
  const space = cut.lastIndexOf(" ");
  return `${(space > BRIEF_SHOWN_CHARS / 2 ? cut.slice(0, space) : cut).replace(/[\s,;:]+$/, "")}…`;
}

/** Names in a row, each in quotes: “The night key” and “Joss”. */
function named(titles: readonly string[]): string {
  return listed(titles.map((title) => `“${title}”`));
}

/** What the main agent did to the lore the model that writes the reply saw, by name: "Added “The night key”. Left out of this prompt: “Joss”." Empty where it changed none. */
export function loreNamesWords(lore: ReplyDid["lore"]): string {
  return [...(lore.added.length > 0 ? [`Added ${named(lore.added)}.`] : []), ...(lore.dropped.length > 0 ? [`Left out of this prompt: ${named(lore.dropped)}.`] : [])].join(" ");
}

/** How long a turn took and what it cost, as its head and Home say it: "12.4 s, $0.0018"; the time alone where no cost is known. */
export function tookWords(ms: number, usage: { cost?: number } | null): string {
  const time = duration(Math.max(0, ms));
  return usage?.cost !== undefined ? `${time}, ${money(usage.cost)}` : time;
}

/** The step that mends a reply that failed: a setting to change, a page to go to, permissions to grant, or the steps that went wrong to look at. */
export type MendStep = { go: "setting"; link: SettingLink } | { go: "page"; page: PageId } | { go: "grant" } | { go: "problems" };

/**
 * What a reply that failed says of itself (ux B2): the cause in plain words, what happened in the
 * backend's own sentence (never the cause over again), and the one step that mends it.
 */
export interface Mend {
  title: string;
  text: string;
  tone: "neutral" | "warn" | "neg";
  action: { label: string; step: MendStep };
}

/** The limits a stop may name, by whose they are: the place each is raised. */
const LIMIT_OF: Partial<Record<AgentStopCode, "agent" | "turn" | "day">> = {
  call_tokens_in: "agent",
  tokens_in: "agent",
  tokens_out: "agent",
  tool_turns: "agent",
  call_time: "agent",
  wall_time: "agent",
  revisions: "agent",
  turn_tokens_in: "turn",
  turn_tokens_out: "turn",
  turn_tool_turns: "turn",
  turn_time: "turn",
  spend: "day",
};

const LIMIT_MEND: Readonly<Record<"agent" | "turn" | "day", Pick<Mend, "title" | "action">>> = {
  agent: { title: "The main agent reached one of its limits", action: { label: "Raise the main agent's limits", step: { go: "setting", link: "agentLimits" } } },
  turn: { title: "The reply's agents reached a limit they share", action: { label: "Raise the limits of a reply", step: { go: "setting", link: "turnLimits" } } },
  day: { title: "A day's spending limit was reached", action: { label: "See the day's limits", step: { go: "page", page: "spend" } } },
};

/** A sentence without the phrase it would only say over again at its start ("The turn failed. …" under that very heading), its first letter raised. */
export function withoutPhrase(text: string, phrase: string): string {
  const said = text.trim();
  if (!said.toLowerCase().startsWith(phrase.toLowerCase())) return said;
  const rest = said.slice(phrase.length).replace(/^[\s.:;,]+/, "");
  return rest === "" ? "" : `${rest.charAt(0).toUpperCase()}${rest.slice(1)}`;
}

/**
 * The cause and the step for a turn as it ended; null for one that needs neither (it finished, or
 * the user stopped it). `did` is what the run's events say it came to (`replyDid`; null where they
 * aren't at hand), and `lacking` whether a permission LumiAH needs is missing now. The backend's
 * cause code decides where it sends one; else what the page can tell for itself does.
 */
export function mendOf(ended: LiveEnded, did: Pick<ReplyDid, "stop"> | null, lacking: boolean): Mend | null {
  if (ended.state === "done" || ended.state === "stopped") return null;
  const said = ended.reason ?? "";
  const stop = did?.stop ?? null;
  const limit = stop !== null ? LIMIT_OF[stop.code] : undefined;
  const cause = ended.cause ?? (lacking ? "permission" : limit !== undefined ? "limit" : null);
  const of = (title: string, tone: Mend["tone"], action: Mend["action"]): Mend => ({ title, text: withoutPhrase(said, title), tone, action });
  switch (cause) {
    case "no_tools":
      return of("The agents' model can't call tools", "neg", { label: "Choose another model for the agents", step: { go: "setting", link: "agentsModel" } });
    case "permission":
      return of("LumiAH is missing a permission it needs", "neg", { label: "Allow it", step: { go: "grant" } });
    case "limit": {
      const mend = limit !== undefined ? LIMIT_MEND[limit] : { title: "A limit was reached", action: { label: "Show what went wrong", step: { go: "problems" as const } } };
      return of(mend.title, "warn", mend.action);
    }
    case null:
      break;
  }
  if (ended.state === "lost") return of("The turn was lost with its runtime", "neg", { label: "Open Runtime", step: { go: "page", page: "runtime" } });
  // A connection that can't be used is mended where the agents' model is chosen, whatever else the stop says.
  if (stop?.code === "connection") return of("The agents have no model they can use", "neg", { label: "Choose another model for the agents", step: { go: "setting", link: "agentsModel" } });
  return of("The turn failed", "neg", { label: "Show what went wrong", step: { go: "problems" } });
}

// ---------------------------------------------------------------- what the prompt held (§24.1) and the lore the writer saw (§24.3)

/** Things in a row, as a sentence joins them: "a", "a and b", "a, b and c". */
function listed(parts: readonly string[]): string {
  if (parts.length <= 1) return parts[0] ?? "";
  return `${parts.slice(0, -1).join(", ")} and ${parts.at(-1) ?? ""}`;
}

/** Runs of message numbers in words: "#30 to #47", "#1 to #12 and #20 to #29". */
export function rangesWords(ranges: readonly (readonly [number, number])[]): string {
  return listed(ranges.map(([from, to]) => (from === to ? `#${from}` : `#${from} to #${to}`)));
}

/** How many messages runs of them hold. */
export function rangeCount(ranges: readonly (readonly [number, number])[]): number {
  return ranges.reduce((n, [from, to]) => n + Math.max(0, to - from + 1), 0);
}

/** What the prompt held, in a line for its fold: how much lore, and how much of the chat word for word. */
export function heldLine(held: PromptHeld): string {
  const tokens = held.lore.reduce((n, e) => n + e.tokens, 0);
  const inPrompt = rangeCount(held.history.held);
  const all = inPrompt + rangeCount(held.history.missing);
  const lore = held.lore.length === 0 ? "no lore" : `${counted(held.lore.length, "lore entry", "lore entries")} (≈${count(tokens)} tokens)`;
  const chat = all === 0 ? "none of the chat" : inPrompt === all ? `all ${counted(all, "message")} of the chat` : `${count(inPrompt)} of the chat's ${counted(all, "message")}`;
  return `${lore} and ${chat}`;
}

/** The entries not in the prompt that the main agent was shown, in a sentence. */
export function indexWords(index: PromptHeld["index"]): string {
  if (index.listed.length === 0 && index.more === 0) return "Every entry of the chat's books is in the prompt.";
  if (index.listed.length === 0) return `${counted(index.more, "more entry is", "more entries are")} in the chat's books. None was listed for the main agent; it looks them up with its tools.`;
  return `The main agent was shown ${counted(index.listed.length, "entry", "entries")} that ${index.listed.length === 1 ? "isn't" : "aren't"} in the prompt, by title and keys, to look up if the reply needs ${index.listed.length === 1 ? "it" : "them"}${index.more > 0 ? `; ${count(index.more)} more ${index.more === 1 ? "was" : "were"} only counted` : ""}.`;
}

const STAND_WORDS: Readonly<Record<PromptHeld["history"]["stands"][number]["kind"], (name: string) => string>> = {
  book: (name) => `the chat's book (${name})`,
  summary: (name) => `Lumiverse's summary (${name})`,
  memories: (name) => `Lumiverse's memories (${name})`,
};

/** The chat's messages in the prompt, a sentence a line: which it holds word for word, which it doesn't, and what stands in for those. */
export function historyWords(history: PromptHeld["history"]): string[] {
  const lines: string[] = [];
  const inPrompt = rangeCount(history.held);
  lines.push(inPrompt === 0 ? "None of the chat's messages is in the prompt word for word." : `${inPrompt === 1 ? "Message" : "Messages"} ${rangesWords(history.held)} ${inPrompt === 1 ? "is" : "are"} in the prompt word for word.`);
  const missing = rangeCount(history.missing);
  if (missing === 0) return lines;
  const stands = history.stands.map((s) => STAND_WORDS[s.kind](s.name));
  const what = stands.length === 0 ? "Nothing stands in for them: the main agent reads them with its tools when the reply needs them." : `${listed(stands)} ${stands.length === 1 ? "stands" : "stand"} in for them.`;
  lines.push(`${rangesWords(history.missing)} ${missing === 1 ? "is" : "are"} not. ${what.charAt(0).toUpperCase()}${what.slice(1)}`);
  return lines;
}

/** What a `write_reply` call did to the lore the model that writes the reply saw, in a line. */
export function loreChangeLine(lore: LoreChanges): string {
  const did = [lore.added.length > 0 ? `added ${counted(lore.added.length, "lore entry", "lore entries")}` : null, lore.dropped.length > 0 ? `left ${count(lore.dropped.length)} out of this prompt` : null].filter((p) => p !== null);
  const refused = lore.refused.length > 0 ? `${counted(lore.refused.length, "entry", "entries")} it named ${lore.refused.length === 1 ? "was" : "were"} refused` : null;
  if (did.length === 0) return refused !== null ? `The main agent changed no lore: ${refused}.` : "The main agent left the lore in the prompt as Lumiverse had it.";
  return `The main agent ${did.join(" and ")}${refused !== null ? `; ${refused}` : ""}.`;
}

/** The same, an entry a line: what a search reads, and what Copy and Export say. */
export function loreChangeText(lore: LoreChanges): string {
  return [...lore.added.map((e) => `Added: ${e.title}`), ...lore.dropped.map((e) => `Left out of this prompt: ${e.title}`), ...lore.refused.map((r) => `Refused: ${r.entryId} (${r.reason})`)].join("\n");
}

/** What the prompt held, as Markdown, for Copy and Export. */
function heldMarkdown(held: PromptHeld): string {
  const lore = held.lore.map((e) => `- ${e.title} (${counted(e.chars, "character")}): ${whyWords(e.why)}`);
  return [`What the prompt held: ${heldLine(held)}.`, ...lore, indexWords(held.index), ...historyWords(held.history)].join("\n");
}

/** An agent as its steps and totals name it: its role as a heading, and which instance of its definition it is where whoever started it said (`as`): "Character (okoro)". */
export function agentLabel(start: { role: string; as?: string }): string {
  return start.as !== undefined && start.as !== "" ? `${roleLabel(start.role)} (${start.as})` : roleLabel(start.role);
}

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

export const JOB_STATE_WORDS: Readonly<Record<JobState, string>> = { queued: "queued", running: "running", done: "done", failed: "failed", cancelled: "cancelled", interrupted: "interrupted", off_path: "off the path", spent: "out of budget", paused: "paused" };

/** What the main agent carries into the turn, a sentence a line. */
export function sessionWords(s: SessionTrace): string[] {
  const lines: string[] = [];
  lines.push(s.turns === 0 && !s.summary ? "Starts a new session: no earlier turn is carried." : `Carries ${counted(s.turns, "earlier turn")} (≈${count(s.tokens)} tokens)${s.summary ? ", after a summary of the ones before" : ""}.`);
  if (s.dropped.length > 0) lines.push(`Its notes from ${s.dropped.length === 1 ? "reply" : "replies"} ${s.dropped.map((i) => `#${i}`).join(", ")} were dropped: an earlier message changed, so they no longer fit the chat.`);
  if (s.missing > 0) lines.push(`${counted(s.missing, "stored part")} ${s.missing === 1 ? "was" : "were"} missing and left out.`);
  if (s.compacted) lines.push(`This turn compacted the session: ${counted(s.compacted.folded, "turn")} summarized, ${count(s.compacted.kept)} kept as ${s.compacted.kept === 1 ? "it was" : "they were"}.`);
  if (s.rolledBack) lines.push("A compaction was rolled back: the turns it summarized are read again in full.");
  if (s.jobs && s.jobs.length > 0) lines.push(`Told of ${counted(s.jobs.length, "job")} that ended since its last turn: ${s.jobs.map((j) => `${roleLabel(j.agent)} (${JOB_STATE_WORDS[j.state]})`).join(", ")}.`);
  return lines;
}

/** Words that carry no news of their own in a reason: "the turn was stopped" says only "stopped". */
const FILLER: Readonly<Record<string, true>> = { the: true, a: true, an: true, agent: true, turn: true, run: true, was: true, were: true, is: true, it: true, its: true, has: true, had: true, been: true, by: true };

const wordsOf = (text: string): string[] => text.toLowerCase().match(/[a-z0-9]+/g) ?? [];

/**
 * Whether `text` says something `said` doesn't. A reason that only repeats the state it stands
 * beside ("Stopped: the turn was stopped", "cancelled, cancelled") is said once: the page drops it.
 */
export function addsTo(text: string, said: string): boolean {
  const known = new Set(wordsOf(said));
  return wordsOf(text).some((word) => !Object.hasOwn(FILLER, word) && !known.has(word));
}

/** Why a run ended, where that says more than the words it stands beside. */
export function endReason(ended: LiveEnded, beside: string): string | null {
  return ended.reason !== undefined && addsTo(ended.reason, beside) ? ended.reason : null;
}

/** How a run ended, as a sentence, with why where that says more: "The turn was stopped: you stopped it from the live view." */
export function endSentence(ended: LiveEnded): string {
  const said = END_SENTENCE_WORDS[ended.state];
  const reason = endReason(ended, said);
  return reason !== null ? `${said}: ${reason}` : `${said}.`;
}

const STOP_STATUS_WORDS: Readonly<Record<Stop["status"], string>> = { answered: "Answered", refused: "Refused", stopped: "Stopped", cancelled: "Cancelled", failed: "Failed" };

/**
 * A stop in a sentence: how the agent's work ended, core's short name for why where it isn't that
 * over again (a search may look for `tool turns`), and the reason where it says more than both.
 */
export function stopWords(e: Stop): string {
  const status = STOP_STATUS_WORDS[e.status];
  const code = e.code.replace(/_/g, " ");
  const said = addsTo(code, status) ? `${status} (${code})` : status;
  return addsTo(e.reason, said) ? `${said}: ${e.reason}` : `${said}.`;
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
  if (activity.waits === "word") return `Waiting for your word on ${activity.tool}`;
  return activity.names.length === 1 ? `Running ${activity.names[0]}` : `Running ${activity.names.length} tools: ${activity.names.join(", ")}`;
}

/** A held tool call in a sentence: that it was held and for what, and how the wait ended. */
export function wordWords(asked: Asked, ended: Worded | null): string {
  const held = `Held for your word (it ${TIER_WORDS[asked.tier]})`;
  if (ended === null) return `${held}: waiting.`;
  const after = `after ${duration(ended.ms)}`;
  switch (ended.decision) {
    case "once":
      return `${held}: you approved it this once ${after}.`;
    case "chat":
      return `${held}: you approved this tool for this chat from now on ${after}.`;
    case "refused":
      return `${held}: you refused it ${after}${ended.reason ? `: ${ended.reason}` : "."}`;
    case "timed_out":
      return `${held}: no answer came in ${duration(ended.ms)}, so it was refused.`;
  }
}

/** A workspace file as agents write its path and as the Workspace page says it: bare in the chat's area (`notes/ledger.md`), then `learned/…`, and `~/…` for the user's own. */
export function filePath(file: Pick<FileChange, "area" | "path">): string {
  return `${file.area === "chat" ? "" : file.area === "learned" ? "learned/" : "~/"}${file.path}`;
}

/** What a tool call did to a workspace file, in a word. */
export function fileChangeWord(change: FileChange): string {
  return change.before === null ? "made" : change.after === null ? "deleted" : "changed";
}

/** A job a run's agent started, in a sentence. */
export function jobWords(job: JobView): string {
  return `Started a job as ${roleLabel(job.agent)}, to run ${job.when === "now" ? "beside this turn" : "once this reply is written"}: ${job.task}`;
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

/** How a tool call stands: waiting for its result, held for the user's word, answered, failed, or left with none (its agent stopped first). */
export type CallState = "running" | "held" | "done" | "error" | "none";

export function callState(result: Result | null, agentWorking: boolean, held = false): CallState {
  if (result) return result.error ? "error" : "done";
  return agentWorking ? (held ? "held" : "running") : "none";
}

/**
 * One thing the feed shows of an agent, by a key that stays the same as the turn grows:
 * its instructions; the messages of its session it takes up; a message it was told; something the
 * user said to it while it worked (`note`); a call's line (`call`: its number among the agent's
 * calls) with the call's thinking, text and tool calls as items of their own (a tool call with the
 * user's word on it where it was held, and the workspace files it changed); a result no call shown
 * asked for, and a held call whose call isn't shown (`word`); a refusal; a retry; a stop; the user
 * holding the run and letting it go on (`hold`); a job it started; what it waits on now, or the
 * call in flight with what has arrived of its thinking and its answer (`live`); and its finish.
 */
export type FeedItem =
  | { key: string; kind: "instructions"; seq: number; text: string }
  | { key: string; kind: "history"; seq: number; messages: number }
  | { key: string; kind: "told"; seq: number; text: string; at: number }
  | { key: string; kind: "note"; seq: number; text: string; at: number }
  | { key: string; kind: "call"; seq: number; entry: Answer; call: number }
  | { key: string; kind: "thinking"; seq: number; text: string; live?: true }
  | { key: string; kind: "said"; seq: number; text: string; live?: true }
  | { key: string; kind: "tool"; seq: number; call: ToolCallView; args: string; result: Result | null; state: CallState; word: { asked: Asked; ended: Worded | null } | null; files: readonly FileChange[]; lore: LoreChanges | null }
  | { key: string; kind: "result"; seq: number; entry: Result }
  | { key: string; kind: "word"; seq: number; asked: Asked; ended: Worded | null; text: string }
  | { key: string; kind: "refused"; seq: number; entry: Refusal; text: string }
  | { key: string; kind: "retry"; seq: number; entry: Retry; text: string }
  | { key: string; kind: "stop"; seq: number; entry: Stop; text: string }
  | { key: string; kind: "hold"; seq: number; on: boolean; at: number }
  | { key: string; kind: "job"; seq: number; job: JobView; at: number; text: string }
  | { key: string; kind: "notice"; seq: number; text: string; at: number; of: "agent" | "run"; info?: true }
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

/** The agents a filter shows, each under the agent that started it: the one it names and those it started, or all. */
export function agentsShown(turn: TurnView, agent: string | null): AgentView[] {
  if (agent === null) return turn.nested;
  const root = turn.agents.find((a) => a.start.id === agent);
  if (!root) return turn.nested;
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
    const asks = new Map<string, Asked>();
    const words = new Map<string, Worded>();
    for (const s of a.steps) {
      if (s.entry.kind === "result") results.set(s.entry.callId, s.entry);
      else if (s.entry.kind === "approval_asked") asks.set(s.entry.callId, s.entry);
      else if (s.entry.kind === "approval") words.set(s.entry.callId, s.entry);
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
        case "notice":
          // What the runtime told it beside a round's results (how few rounds of tool calls it has left): among what it was told.
          if (kinds.has("told") && !filter.problems) items.push({ key: `u:${s.seq}`, kind: "notice", seq: s.seq, text: `The runtime told it: ${e.text}`, at: e.at, of: "agent" });
          break;
        case "note":
          if (kinds.has("told") && !filter.problems) items.push({ key: `n:${s.seq}`, kind: "note", seq: s.seq, text: e.text, at: e.at });
          break;
        case "approval_asked":
          // A held call shows in its call's card; one whose call isn't in the transcript stands on its own.
          if (called.has(e.callId) || !kinds.has("tools") || filter.problems) break;
          if (filter.tool !== null && e.tool !== filter.tool) break;
          items.push({ key: `q:${s.seq}`, kind: "word", seq: s.seq, asked: e, ended: words.get(e.callId) ?? null, text: `${e.tool}: ${wordWords(e, words.get(e.callId) ?? null)}` });
          break;
        case "approval":
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
              const asked = asks.get(c.id);
              const word = asked ? { asked, ended: words.get(c.id) ?? null } : null;
              parts.push({ key: `c:${s.seq}:${c.id}`, kind: "tool", seq: s.seq, call: c, args: JSON.stringify(c.args, null, 2), result, state: callState(result, a.state === "working", word !== null && word.ended === null), word, files: result?.files ?? [], lore: result ? loreChangesOf(result) : null });
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
    // What happened to the run as a whole stands in the feed of the agent it concerns, at its place: a job in its starter's; the user's holds, and what the runtime says of the run, in the first agent's. What the runtime says of the run is something that went wrong, so it shows under that filter too.
    const first = turn.roots[0]?.start.id;
    const mine = turn.marks.filter((m) => {
      if (m.seq < from) return false;
      if (m.kind === "job") return !filter.problems && kinds.has("tools") && (m.job.by.who === "agent" ? m.job.by.id : first) === id;
      return kinds.has("stops") && first === id && (m.kind === "notice" ? !(m.info && filter.problems) : !filter.problems);
    });
    if (mine.length > 0) {
      for (const m of mine) items.push(m.kind === "job" ? { key: `j:${m.seq}`, kind: "job", seq: m.seq, job: m.job, at: m.at, text: jobWords(m.job) } : m.kind === "notice" ? { key: `v:${m.seq}`, kind: "notice", seq: m.seq, text: m.text, at: m.at, of: "run", ...(m.info ? { info: true as const } : {}) } : { key: `p:${m.seq}`, kind: "hold", seq: m.seq, on: m.kind === "paused", at: m.at });
      // Steps are in order already and the sort keeps equal places as they stand, so only the marks move, each to its place.
      items.sort((x, y) => x.seq - y.seq);
    }
    if (!filter.problems) {
      const end = Math.max(a.steps.at(-1)?.seq ?? a.seq, mine.at(-1)?.seq ?? 0) + 0.5;
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
    case "note":
    case "thinking":
    case "said":
    case "word":
    case "refused":
    case "retry":
    case "stop":
    case "job":
    case "notice":
      return [item.text];
    case "call":
      return [callWords(item.entry)];
    case "tool":
      return [item.call.name, item.args, item.result?.text ?? "", item.lore ? loreChangeText(item.lore) : ""];
    case "result":
      return [item.entry.name, item.entry.text];
    case "history":
    case "hold":
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
  // In the nested order, so the outline and the table list a sub-agent under the agent that started it, as the feed does.
  for (const a of turn.nested) {
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
  const instance = new Map(totals.agents.map((t) => [t.agent.start.id, t.agent.start.as ?? ""]));
  const head = ["agent", "role", "as", "call", "model", "started", "ms", "in", "cached_in", "cache_write", "out", "reasoning_out", "estimated", "cost_usd", "finish", "tool_calls", "tool_ms", "prompt"];
  // A cost worked out from prices carries the arithmetic's noise in its last places (0.0007761600000000001): ten significant digits keep every digit that means something.
  const rows = totals.calls.map((c) => [c.agentId, role.get(c.agentId) ?? "", instance.get(c.agentId) ?? "", c.call, c.model, new Date(c.startedAt).toISOString(), c.ms, c.usage.in, c.usage.cachedIn, c.usage.cacheWrite ?? 0, c.usage.out, c.usage.reasoningOut, c.usage.estimated.join(" "), c.usage.cost === undefined ? "" : Number(c.usage.cost.toPrecision(10)), c.finishReason, c.tools, c.toolMs, c.prompt ?? ""]);
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
    case "note":
      return `**The user said** · ${new Date(item.at).toISOString()}\n${fenced(item.text)}`;
    case "call":
      return `**Call ${item.call}** · ${callWords(item.entry)}${item.entry.tools === "text" ? " · tools as text" : ""}${item.entry.prompt ? ` · prompt ${item.entry.prompt}` : ""}`;
    case "thinking":
      return `Thinking${item.live ? " (so far)" : ""}:\n${fenced(item.text)}`;
    case "said":
      return `Answer${item.live ? " (so far)" : ""}:\n${fenced(item.text)}`;
    case "tool": {
      const head = `→ \`${item.call.name}\` ${JSON.stringify(item.call.args)}${item.word ? `\n${wordWords(item.word.asked, item.word.ended)}` : ""}`;
      if (!item.result) return `${head}\n← ${item.state === "running" ? "(still running)" : item.state === "held" ? "(held for the user's word)" : "(no result: its agent stopped first)"}`;
      const files = item.files.map((f) => `\n${filePath(f)} ${fileChangeWord(f)}${f.after !== null ? ` (version ${f.after.slice(0, 12)})` : ""}`).join("");
      const lore = item.lore ? `\n${loreChangeLine(item.lore)}\n${loreChangeText(item.lore)}` : "";
      return `${head}\n← ${item.result.error ? "failed" : "result"} · ${duration(item.result.ms)}${item.result.scratch ? ` · clipped, the whole kept as ${item.result.scratch}` : ""}\n${fenced(item.result.text)}${files}${lore}`;
    }
    case "result":
      return `← \`${item.entry.name}\`${item.entry.error ? " (failed)" : ""} · ${duration(item.entry.ms)}\n${fenced(item.entry.text)}`;
    case "word":
    case "refused":
    case "retry":
    case "stop":
    case "job":
    case "notice":
      return item.text;
    case "hold":
      return item.on ? "(The user paused the run here.)" : "(The user let the run go on.)";
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
  out.push(`# ${runTitle(view)} · turn ${view.turn}`);
  const why = view.ended ? endReason(view.ended, END_LINE_WORDS[view.ended.state]) : null;
  const ended = view.ended ? `${END_LINE_WORDS[view.ended.state].toLowerCase()} ${duration(view.ended.at - view.startedAt)}${why !== null ? `: ${why}` : ""}` : "still running";
  out.push(`${view.chatId !== null ? `Chat ${view.chatId}` : "No chat"}${view.messageId ? ` · message ${view.messageId}` : ""} · started ${new Date(view.startedAt).toISOString()} · ${ended}`);
  out.push(`Spent: ${totalsWords(totals.turn)}`);
  if (turn.session) out.push(`Session: ${sessionWords(turn.session).join(" ")}`);
  if (turn.held) out.push(heldMarkdown(turn.held));
  if (totals.agents.length > 0) {
    const rows = totals.agents.map((t) => `| ${agentLabel(t.agent.start)} | ${t.calls} | ${count(t.in)} | ${count(t.cachedIn)} | ${count(t.out)} | ${count(t.reasoningOut)} | ${duration(t.modelMs)} | ${duration(t.toolMs)} | ${totalCostWords(t)} |`);
    out.push(["| Agent | Calls | In | Cached | Out | Reasoning | Model time | Tool time | Cost |", "|---|---:|---:|---:|---:|---:|---:|---:|---:|", ...rows].join("\n"));
  }
  for (const feed of feeds) {
    const a = feed.agent;
    out.push(`## ${agentLabel(a.start)}${a.start.task ? ` · ${a.start.task}` : ""} · ${AGENT_STATE_WORDS[a.state]}`);
    out.push(`${agentModel(a) ?? "the connection's model"}${a.start.connectionId ? ` on ${a.start.connectionId}` : ""} · effort ${a.start.effort}${a.start.parent ? ` · started by ${a.start.parent}` : ""}`);
    if (feed.hidden > 0) out.push(`(${counted(feed.hidden, "earlier step")} not shown)`);
    for (const item of feed.items) {
      const text = itemMarkdown(item);
      if (text !== null) out.push(text);
    }
  }
  const whyEnded = view.ended ? endReason(view.ended, END_STATE_WORDS[view.ended.state]) : null;
  if (view.ended) out.push(`## Ended: ${END_STATE_WORDS[view.ended.state]}${whyEnded !== null ? `: ${whyEnded}` : ""}`);
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
