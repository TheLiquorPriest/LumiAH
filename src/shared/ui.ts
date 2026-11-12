// The messages between LumiAH's frontend and its extension backend (DESIGN §1, §8), over Spindle's
// messaging (`ctx.sendToBackend` / `spindle.sendToFrontend`). Every message is an envelope
// `{ lah: UI_VERSION, type, … }`; the `lah.` prefix on every type keeps them apart from the messages
// of an extension that bundles LumiAH's pieces into its own.
//
// Rules both sides keep:
// - A request carries a `reqId` the page chose. The backend answers each with exactly one
//   `lah.result` (naming the request's type) or one `lah.error`, with the same `reqId`.
// - The page says `lah.hello` when it starts, and again whenever it can't follow the state: the
//   answer is the whole state (`UiState`). The state is the user's, the same for every page of
//   theirs. From then on the backend pushes `lah.state` to every page of the user whenever a part
//   of it changes: the parts that changed, whole, under the next `rev`. A page applies a push only
//   when its `rev` is the one after the `rev` it holds; else it says hello.
// - A page that opens a chat's live view (`lah.live.open`) hears `lah.live` pushes for that chat
//   until it closes the view or goes away. A turn's events are numbered from 1 with no gap
//   (`LiveEvent.seq`); a page that finds a gap reads the missing ones (`lah.live.events`).
// - While a model call is in flight the same pages hear `lah.live.delta`: what arrived of its
//   answer since the delta before, with how much had arrived before it. The view holds what a call
//   in flight has sent so far (`LiveView.partials`), so a page that opens mid-call shows it; the
//   call's `answer` entry, when it lands, takes the partial's place.
// - A live view is followed by its stream (`StreamId`): a chat's reply turns under the chat's own
//   id, a job's run and a side session's turns each under a stream of their own.
// - What needs the user reaches every page in the state: the tool calls held for their word
//   (`UiState.approvals`), the jobs under way (`UiState.jobs`) and the notices of jobs that
//   finished or need them (`UiState.notices`). A list a page reads on request (the definitions, a
//   chat's jobs) has a counter in the state that moves when it changes, so an open page reads again.
// - A workspace write names the version it was based on (§11): one that isn't the file's current
//   version is refused with `conflict`, and the page reads the file again.
// - A read whose answer may be long (a live view on open, a stored transcript) answers a page of
//   events and the `seq` to read from next (`next`, null once there are no more).
// - The frontend only renders what these messages carry and sends these requests: it reads nothing
//   else of Lumiverse, and never calls the network itself.
// - A chat's turns run in the runtime the user starts beside Lumiverse (§25): a chat switched on is
//   pinned to the loopback connection (`lah.chat.set`), and its replies reach the runtime there.
// - Each area of the pages keeps its part of this file under its own heading: a builder adds to
//   their own part, with the request's validator in `BODY`, and tells the backend's lane.

import type { AgentDefinition } from "../core/agents";
import { type AgentStopCode, type AgentUsage, type ApprovalAnswer, type ApprovalAsk, type DefinitionSource, type FileAuthor, type FileChange, isRecord, type JobView, type JobWhen, type JsonObject, type JsonValue, type ModelRequest, type RunKind, type ToolTier, type TraceEvent, type TraceRecord, type TranscriptEntry, type TurnKind, type TurnStatus, type WorkspaceArea } from "../core/ports";
import { citationsIn } from "../core/recall/cite";
import type { TimingsView } from "../link/timings";
import type { ChronicleCheck, CitedMessage, EmbedStatus, HeldWhy, LoreChange, LoreChanged, LoreHitView, LoreListing, LoreRow, LoreSearchView, PromptHeld, StoryStatus } from "../core/recall/shapes";
import type { Skill } from "../core/skills";
import { type StoryHolds, type StorySetting, STORY_MEMBERS, storyValue } from "../core/story";
import { TOOL } from "../core/text-def";

// The timing log is the link's: Runtime → Timings shows each end's as it sums it up.
export type { Crossing, OpTimes, Outcome, Road, Spread, TimingsView } from "../link/timings";

// The trace is core's: the live view renders the events core's agents trace, as core shapes them.
// So are a job, a definition, a file's author and a file a tool changed: the pages show core's own.
export type { AgentDefinition } from "../core/agents";
export type {
  AgentStarted,
  AgentStatus,
  AgentStopCode,
  AgentUsage,
  ApprovalAnswer,
  ApprovalAsk,
  CallUsage,
  DefinitionSource,
  FileAuthor,
  FileChange,
  JobState,
  JobView,
  JobWhen,
  JsonObject,
  JsonValue,
  ModelEffort,
  ModelMessage,
  ModelPart,
  ModelRequest,
  ModelTool,
  OfferedTools,
  RunKind,
  SamplingParams,
  SessionTrace,
  ToolCallView,
  ToolTier,
  TraceEvent,
  TraceRecord,
  TranscriptEntry,
  TurnKind,
  TurnStatus,
  UsageField,
  WorkspaceArea,
} from "../core/ports";
export { isRecord } from "../core/ports";
// The entry among an agent's tools that stands for every tool the user added: the pages give it words.
export { ADDED_TOOLS } from "../core/settings";
export type { Skill } from "../core/skills";

/** The level of this contract. A page and a backend of the same build always agree; the number is for a page left open across an update. */
export const UI_VERSION = 1;

// ---------------------------------------------------------------- the live view

/** How a turn ended: as core says (its reply written, failed, or stopped by the user), or lost with its runtime before core could say. */
export type LiveEndState = TurnStatus | "lost";

/** Why a turn failed, as a code a page can act on; the sentence beside it (`reason`) stays what is shown. `no_tools`: the main agent's model took no tools and called none as text; `permission`: a permission LumiAH needs is missing (`UiState.permissions`, those `needed`); `limit`: the main agent stopped at a limit (which: `LastTurn.did.stop.code`). */
export type CauseCode = "no_tools" | "permission" | "limit";

/** How and when a turn ended, with why in words where it didn't finish. */
export interface LiveEnded {
  state: LiveEndState;
  at: number;
  reason?: string;
  /** Absent where the backend knows no cause a page can act on. */
  cause?: CauseCode;
}

/** A trace event as core traced it: its turn and chat, and its place in the turn, numbered from 1 with no gap. */
export type LiveEvent = TraceRecord;

/**
 * What a model call in flight has sent so far: whose call, which of that agent's calls (counted from
 * 1, as its `answer` entries are), its text and its thinking as they have arrived, and when the
 * first of it did. It is gone once the call's entry lands (its answer, or the refusal, retry or stop
 * that ended it).
 */
export interface LivePartial {
  agentId: string;
  call: number;
  text: string;
  reasoning: string;
  at: number;
}

/**
 * A live view's id: a chat's id for its reply turns, a job's id for its run, a side session's id for
 * its turns. The three are ids of different things and never the same string.
 */
export type StreamId = string;

/** Whether a run answers a generation in a chat (a reply), rather than being a job's run or a side session's turn. */
export function isReply(kind: RunKind): kind is TurnKind {
  return kind !== "job" && kind !== "side";
}

/**
 * A run as the live view shows it: its stream, its chat (null for a side session about no chat),
 * the run's id, what it is (the kind of generation a reply answers, a job's run, a side session's
 * turn) and the message it targets (null for a new reply not yet saved, and for a run that is no
 * reply), when it started, how it ended (null while it runs), its events in order, and what its
 * calls in flight have sent so far (none for a stored transcript). A view read in pages (`next`)
 * holds the events read so far.
 */
export interface LiveView {
  stream: StreamId;
  chatId: string | null;
  turn: string;
  kind: RunKind;
  messageId: string | null;
  startedAt: number;
  ended: LiveEnded | null;
  events: LiveEvent[];
  partials: LivePartial[];
}

/** What a page hears of a chat's live view: a new turn's view, whole, or what turn `turn` added since, with how it stands now. */
export type LiveChange = { view: LiveView } | { turn: string; events: LiveEvent[]; ended: LiveEnded | null };

/**
 * What arrived of a model call in flight since the delta before it (core's `TraceDelta`), with how
 * much of that call's text and thinking had arrived before it (`before`, in the units a string's
 * `length` counts). `before` is what lets a page tell a delta it already holds (its snapshot was read
 * after the delta was sent) from the next one, and from one after a delta it never heard.
 */
export interface LiveDelta {
  turn: string;
  agentId: string;
  call: number;
  text?: string;
  reasoning?: string;
  before: { text: number; reasoning: number };
  at: number;
}

/** The entries that end a call in flight: its answer, or the refusal, the retry or the stop that took its place. */
const ENDS_CALL: Readonly<Record<string, true>> = { answer: true, tools_refused: true, retry: true, stop: true };

/** The partials left once `events` have landed and the turn stands as `ended`: an agent's is gone when its call's entry arrives, when the agent finishes, and when the turn ends. */
function partialsAfter(partials: readonly LivePartial[], events: readonly LiveEvent[], ended: LiveEnded | null): LivePartial[] {
  if (ended !== null || partials.length === 0) return [];
  const done = new Set<string>();
  for (const { event } of events) {
    if (event.kind === "agent_idle") done.add(event.agentId);
    else if (event.kind === "agent_entry" && ENDS_CALL[event.entry.kind]) done.add(event.agentId);
  }
  return done.size === 0 ? [...partials] : partials.filter((p) => !done.has(p.agentId));
}

/** Two reads of the same calls in flight, the fuller of each kept: a later call of an agent over an earlier one, and of the same call the one that holds more. */
function fullerPartials(a: readonly LivePartial[], b: readonly LivePartial[]): LivePartial[] {
  const out = new Map<string, LivePartial>();
  for (const p of [...a, ...b]) {
    const held = out.get(p.agentId);
    if (!held || p.call > held.call || (p.call === held.call && p.text.length + p.reasoning.length > held.text.length + held.reasoning.length)) out.set(p.agentId, p);
  }
  return [...out.values()];
}

/**
 * A page's live view after a change it heard: a new turn's view replaces it; events for the turn it
 * holds join it in order, any it holds already left out, and end the calls in flight they are the
 * entries of. `gap` when it can't follow: it holds another turn or none (read the view again), or
 * events are missing before these (read them from `from`). A view of the turn it holds already that
 * holds no more of it (one read while a newer one was on its way) changes only how the turn stands,
 * and where it holds as much, which of the two holds more of each call in flight.
 */
export function followLive(held: LiveView | null, change: LiveChange): LiveView | { gap: "view" } | { gap: "events"; from: number } {
  if ("view" in change) {
    if (held === null || held.turn !== change.view.turn || change.view.events.length > held.events.length) return change.view;
    const ended = held.ended ?? change.view.ended;
    const partials = ended !== null ? [] : change.view.events.length === held.events.length ? fullerPartials(held.partials, change.view.partials) : held.partials;
    return ended === held.ended && partials.length === held.partials.length && partials.every((p, i) => p === held.partials[i]) ? held : { ...held, ended, partials };
  }
  if (held === null || held.turn !== change.turn) return { gap: "view" };
  const last = held.events.at(-1)?.seq ?? 0;
  const fresh = change.events.filter((e) => e.seq > last);
  for (let i = 0; i < fresh.length; i += 1) if (fresh[i]?.seq !== last + 1 + i) return { gap: "events", from: last + 1 };
  const ended = change.ended ?? held.ended;
  return { ...held, events: fresh.length > 0 ? [...held.events, ...fresh] : held.events, ended, partials: partialsAfter(held.partials, fresh, ended) };
}

/** Where a delta's part stands against what the page holds of it: the next of it, some of it the page holds already, or one after a part it never heard. */
function partPlace(have: number, before: number, adds: number): "next" | "held" | "hole" {
  return before === have ? "next" : before + adds <= have ? "held" : "hole";
}

/**
 * A page's live view after a delta it heard: what arrived joins what the view holds of that call in
 * flight, and an agent's later call starts anew. A delta the view already holds changes nothing (the
 * view was read after the delta was sent, or the call's entry has landed). `gap` when the page can't
 * follow, and must read the view again: it holds another turn or none, or a delta before this one
 * never reached it.
 */
export function followDelta(held: LiveView | null, delta: LiveDelta): LiveView | { gap: "view" } {
  if (held === null || held.turn !== delta.turn) return { gap: "view" };
  if (held.ended !== null) return held;
  const now = held.partials.find((p) => p.agentId === delta.agentId);
  if (now && delta.call < now.call) return held;
  // The call's entry may have landed before a late delta of it: an agent's calls are counted as its answers are.
  if (!now || delta.call > now.call) {
    let answered = 0;
    for (const { event } of held.events) if (event.kind === "agent_entry" && event.agentId === delta.agentId && event.entry.kind === "answer") answered += 1;
    if (delta.call <= answered) return held;
  }
  const base = now && now.call === delta.call ? now : { agentId: delta.agentId, call: delta.call, text: "", reasoning: "", at: delta.at };
  const text = partPlace(base.text.length, delta.before.text, delta.text?.length ?? 0);
  const reasoning = partPlace(base.reasoning.length, delta.before.reasoning, delta.reasoning?.length ?? 0);
  if (text === "hole" || reasoning === "hole") return { gap: "view" };
  const next: LivePartial = { ...base, text: text === "next" ? base.text + (delta.text ?? "") : base.text, reasoning: reasoning === "next" ? base.reasoning + (delta.reasoning ?? "") : base.reasoning };
  if (now === base && next.text === base.text && next.reasoning === base.reasoning) return held;
  return { ...held, partials: [...held.partials.filter((p) => p.agentId !== delta.agentId), next] };
}

/**
 * One model call exactly as core asked for it (`TranscriptEntry.prompt` names its blob): on which
 * connection and model, with which effort, sampling and answer room, whether it streamed, its
 * messages and the tools it offered.
 */
export type CallPrompt = ModelRequest;

// ---------------------------------------------------------------- the runtime

/** How the link to a runtime stands: up; registered but not heard from lately; refused (its link version differs); or down. */
export type LinkState = "linked" | "quiet" | "refused" | "down";

/**
 * Whether a runtime's address is in its account's local-inference scheduler exclusions: `excluded`;
 * `missing` (it isn't, and the runtime couldn't add it: with the scheduler on, a reply the runtime
 * answers holds the scheduler while its agents work); `unavailable` (this Lumiverse has no
 * scheduler); `unknown` (not asked yet).
 */
export type SchedulerView = "excluded" | "missing" | "unavailable" | "unknown";

/** A runtime registered for the user, as the Runtime page shows it. */
export interface RelayView {
  /** Its registration's id: what `lah.relay` names. */
  id: string;
  name: string;
  /** Its build, as it said on its hello; null before its first. */
  build: string | null;
  /** The machine it runs on, as it said. */
  host: string | null;
  /** Where Lumiverse reaches its loopback endpoint (`http://127.0.0.1:<port>/v1`): the loopback connection's base URL; null before its first hello. */
  url: string | null;
  registeredAt: number;
  /** When it last said hello or pinged since the extension started; null when it hasn't. */
  seenAt: number | null;
  link: LinkState;
  /** Why the link isn't up, in plain words that name which side to update when the versions differ. */
  problem: string | null;
  /** Its build differs from the extension's. */
  update: boolean;
  /** Turns it is answering now. */
  turns: number;
  /** The service that runs it (its unit's name); null when it runs in the foreground, or hasn't said. */
  unit: string | null;
  /** Its Lumiverse session as it last asked: whether it holds (null: it couldn't ask) and when it ends. */
  session: { valid: boolean | null; endsAt: string | null };
  scheduler: SchedulerView;
  /** Lines to copy for it: update and restart it, and sign it in again; null where its install isn't known yet. */
  lines: { update: string | null; login: string | null };
}

/**
 * Where a start line holds the address the user opens Lumiverse at. The backend can't know that
 * address and the state is the same for every page, so each page puts its own in (`startLine`).
 */
export const URL_SLOT = "{{url}}";

/** An origin a shell line can hold bare: a scheme, a host and a port, nothing a shell reads. */
const BARE_ORIGIN = /^https?:\/\/[A-Za-z0-9.\-[\]:]+$/;

/** A start line with the page's own address in its slot; with `<the address you open Lumiverse at>` where the page's address isn't one a shell line can hold. */
export function startLine(line: string, origin: string): string {
  return line.replaceAll(URL_SLOT, BARE_ORIGIN.test(origin) ? origin : "<the address you open Lumiverse at>");
}

/** The road a page's requests take to one runtime: through Lumiverse's proxy (`proxy`, the faster road) or over the link; why not the proxy, in plain words (null when it is); and when that was found (null: not yet). */
export interface RoadView {
  road: "proxy" | "link";
  why: string | null;
  at: number | null;
}

/** How the pages' requests reach the user's runtimes (PI-BUILD-PLAN §4.7): whether this extension holds the permission the faster road needs, what granting it does while it doesn't (null once it does), and each runtime's road, by its id. */
export interface RoadsView {
  granted: boolean;
  offer: string | null;
  relays: Record<string, RoadView>;
}

/** The timing log as Runtime → Timings shows it: this extension's end (the asks it sent its runtimes) and each linked runtime's (the requests its link sent), each read whole once; `problem`: why a runtime's couldn't be read. */
export interface TimingsPage {
  extension: TimingsView;
  runtimes: { id: string; name: string; timings: TimingsView | null; problem: string | null }[];
}

/** The runtime as the Runtime page shows it. */
export interface RuntimeView {
  /** The extension's own build and the link version it speaks. */
  build: string;
  link: number;
  /** The model the loopback connection names. */
  model: string;
  relays: RelayView[];
  /**
   * The line that installs and starts a runtime as a service, and the one that runs it in the
   * foreground, with this server's paths filled in and `URL_SLOT` where the address goes; null
   * where the backend can't fill them, with why in `missing`.
   */
  start: { service: string | null; foreground: string | null; missing: string[] };
  /** What keeps LumiAH from working that no permission (`UiState.permissions`) and no runtime's own row says (a Lumiverse too old to keep a turn's record, storage it can't write), each in plain words that say what to do; none when nothing does. */
  issues: string[];
  /** A runtime is there to answer (§25): one is linked, the loopback key is minted and the loopback connection is made, so a chat switched on is answered now. */
  ready: boolean;
  /** This build offers its own copy of the runtime to a runtime that says hello on another build, which then updates itself where it can (false for a development build, or where the extension's folder isn't known: each runtime's update line is the way then). */
  selfUpdate: boolean;
  /** The extension that builds LumiAH in switches its chats on in its own pages (LumiRPEngine): its name. LumiAH's pages then offer no switch of their own, and say where it is. Absent for LumiAH. */
  switchedBy?: string;
  /** How the pages' requests reach each runtime: the faster road through Lumiverse's proxy, or the link. */
  road: RoadsView;
}

/** What is under way in a runtime, which a restart ends: the replies it is answering, every request from Lumiverse (the replies among them), its jobs and the side sessions' turns. */
export interface UnderWay {
  replies: number;
  requests: number;
  jobs: number;
  sides: number;
}

/** How one runtime is run and kept, as it says itself (`lah.runtime.service.get`), with what is under way in it now. */
export interface ServiceView {
  /** The build it runs. */
  build: string;
  /** Its memory limit; and where nothing holds it to that limit, words that say so and what would (null: its systemd unit holds it). */
  memory: string;
  memoryNote: string | null;
  /** It takes an update by itself once nothing is under way; else only from the page's button. */
  autoUpdate: boolean;
  /** What restarts it: its systemd unit, which `unit` names, or the runtime itself. */
  runs: "systemd" | "itself";
  unit: string | null;
  /** The file it was set up from, the only one it takes an update from (null: set up before it could update itself); and the file it runs from. */
  source: string | null;
  installed: string;
  /** The update that waits, for nothing to be under way or for the button, and since when. */
  waiting: { build: string; since: number } | null;
  /** Something is under way: updating or restarting now ends it. */
  busy: boolean;
  /** A limit changed since it started holds only once it restarts. */
  restartNeeded: boolean;
  /** It is updating or restarting now. */
  updating: boolean;
  /** Why its last update or change didn't take, and the line to run where it can't do it itself. */
  problem: string | null;
  line: string | null;
  /** It was started by the runtime before it, which then left (a restart where a process can't be replaced in place: Windows), so whatever ran that one no longer watches this one. */
  handedOver: boolean;
  /** Another copy of it waits to serve on its port (one a task or service wrapper started while this one serves): its process and since when. */
  waitingCopy: { pid: number; since: number } | null;
  underWay: UnderWay;
}

/**
 * A user's runtime as an extension that builds LumiAH in reads it for its own pages
 * (`Backend.runtimeState`), without the pages' whole state. `linked`: a runtime is linked now; asked
 * about a chat, the one that chat's replies reach. `ready`: `RuntimeView.ready`. `connection`: a
 * loopback connection exists, so a chat can be pinned to it. `words`: null while linked, else why it
 * isn't, in plain words that say what to do (a refused link version names the side to update and
 * how). `start`: the Runtime page's two lines (`RuntimeView.start`).
 */
export interface RuntimeState {
  linked: boolean;
  ready: boolean;
  connection: boolean;
  words: string | null;
  start: RuntimeView["start"];
}

/**
 * First-time setup's steps, in order: the permissions LumiAH needs are granted, a chat is switched
 * on, a reply was answered. The runtime's own steps (start it, mint the key, have the connection)
 * are worked out by the Runtime page from `runtime`, `key` and `connections`, and shown there until
 * they are done: no chat is answered without it (§25).
 */
export type SetupStepId = "permissions" | "chat" | "reply";

export interface SetupView {
  steps: { id: SetupStepId; done: boolean }[];
}

/** The user's loopback key: whether one is set, its fingerprint and when it was made; never the key. */
export interface KeyView {
  set: boolean;
  print: string | null;
  at: number | null;
}

/**
 * A permission LumiAH was not granted: Lumiverse's name for it (what a page asks the host to grant),
 * what it is for (`what`, a phrase that completes "To …"), what is lost without it (`without`, a
 * clause that completes "Without it, …") and what to do about it where the page can't ask, each in
 * plain words, and whether LumiAH works on no reply without it (`needed`; false: only what
 * `without` names is missing, as an MCP server's tools are without `mcp_servers`).
 */
export interface PermissionNeed {
  id: string;
  what: string;
  without: string;
  todo: string;
  needed: boolean;
}

// ---------------------------------------------------------------- chats and connections

/**
 * A chat, and whether LumiAH answers it. Switched on, it is pinned to the loopback connection, and
 * the runtime answers its replies there (§25). A chat that generates on a loopback connection is
 * answered by the runtime though LumiAH didn't pin it there (`chatAnswered`).
 */
export interface ChatView {
  chatId: string;
  name: string | null;
  /** LumiAH is switched on for it (`lah.chat.set`). */
  on: boolean;
  /** Since when it is on (epoch ms); null while off. */
  since: number | null;
  /** The connection the chat generates on now (its own pin, else the user's active connection), and whether that is a loopback; null when Lumiverse names none. Switched on, it is the loopback it is pinned to. */
  connection: { id: string; name: string; loopback: boolean } | null;
  /** Another extension that has LumiAH built into itself (or LumiAH itself, seen from one) answers this chat: its identifier and its name. This backend then offers no switch for the chat: `on` is false, and switching it on is refused with `unavailable` in words that name the other. Absent where no other does. */
  other?: { identifier: string; name: string };
  /** The runtime that plays the chat while it is switched on and that runtime is linked: its relay id (`RelayView.id`) and its name. Its connections are the ones the chat's agents run on (`lah.connections.list` with this `relay`). Absent while the chat is off, or `away`. */
  runtime?: { id: string; name: string };
  /** The chat is switched on, and the runtime its replies reach isn't linked now, so they fail until it is back (`on` stays true). */
  away?: true;
}

/** Whether a reply in the chat reaches LumiAH now: it generates on a loopback connection, which a runtime serves. */
export function chatAnswered(chat: ChatView): boolean {
  return chat.connection?.loopback === true;
}

export type { StoryHolds, StorySetting, StorySource, StoryWord } from "../core/story";
export { STORY_MEMBERS, storyWordOf } from "../core/story";

/**
 * What counts as a chat's story (§24.4), as the pages show it: the chat's own choice (each member
 * left out follows Settings), Settings' choice, the word of the extension that answers the chat (its
 * name and the members it set; null where it set none: the page shows those as set by it, not to be
 * changed here), what Lumiverse says of its Sovereign Hand (null: it doesn't tell extensions), and
 * what holds, member by member, with whose word settled each.
 */
export interface ChatStoryView {
  chatId: string;
  chosen: Partial<StorySetting>;
  setting: StorySetting;
  claimed: { by: string; story: Partial<StorySetting> } | null;
  sovereignHand: boolean | null;
  holds: StoryHolds;
}

/**
 * Who leads a chat's replies, as the extension that answers this backend's chats claims it
 * (`lah.chat.lead.get`): its name (`by`), the id of the agent its claim names to lead them (null: it
 * names none, so LumiAH's main agent leads), and whether the reply is only what the agents release
 * (`released`: no writer writes it). `unanswered`: it gave no answer for the chat, with why; a reply
 * there doesn't start without one.
 */
export type ChatLeadView = { by: string; lead: string | null; released: boolean } | { by: string; unanswered: string };

/** A run under way: a reply LumiAH is answering, a job, or a side session's turn. `paused`: the user holds its agents at their next round (§18). */
export interface RunningTurn {
  stream: StreamId;
  chatId: string | null;
  turn: string;
  kind: RunKind;
  startedAt: number;
  paused: boolean;
}

/** One of the user's connections: its provider and model, and whether it is the loopback (which no agent may use: its calls would come back to the runtime). */
export interface ConnectionView {
  id: string;
  name: string;
  provider: string;
  model: string | null;
  loopback: boolean;
}

// ---------------------------------------------------------------- the runtime's connections (PI-BUILD-PLAN §4.3)
//
// The agents call their providers on a runtime's own connections, kept on that runtime's disk with
// their keys and sign-ins. A user may have several runtimes linked, each with connections of its
// own: every request about them under the same heading below names the runtime by its relay id
// (`ToRuntime`: `RelayView.id`; left out, the user's runtime last heard from), and the list names
// the runtime it is of (`ConnectionsView.relay`). The backend passes each to that runtime (its
// `connections.*` and `signin.*` page ops), so each is refused with `unavailable`, in words that
// say what to do, while it isn't linked. A key goes to the runtime once, in
// `lah.connections.save`, and never comes back: a connection shows only whether it has one and its
// last four characters. `lah.connections.lumiverse` is the backend's own: Lumiverse's connections
// to copy from, never with a key. The list is read on request; the page that changes it takes the
// answer, and a page reads it again when it comes back into view and when the runtimes linked
// change.

/** A request addressed to one of the user's runtimes by its relay id (`RelayView.id`); left out, to the user's runtime last heard from. */
export interface ToRuntime {
  relay?: string;
}

/** How a runtime's connection signs its calls: with its own key, with the runtime's sign-in to its provider, or with nothing (a local server that asks for none). */
export type ConnectionAuth = "key" | "signin" | "none";

/** The providers the runtime signs in to. */
export type SignInProvider = "anthropic" | "openai";

/** How much a connection's model thinks when an agent leaves it to the connection: not at all, or one of the levels up to the most its model allows. */
export type ConnectionEffort = "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max";

/** One of the runtime's connections as the pages show it: never its key, only whether one is set and its last four characters (null for a key too short to show any of); for one that signs in, whether the runtime is signed in to its provider. */
export interface RuntimeConnection {
  id: string;
  name: string;
  /** Its provider's id (`ProviderOffer.id`). */
  provider: string;
  auth: ConnectionAuth;
  /** Where its calls go in place of the provider's own address: a compatible server's, or a proxy's. */
  baseUrl?: string;
  /** The API a compatible server speaks, where its provider offers more than one. */
  api?: string;
  /** Its model, for an agent that names none. */
  model?: string;
  /** Its own effort, for an agent whose effort is `auto` or `inherit`; absent: the provider's default. */
  effort?: ConnectionEffort;
  /** The headers every call on it sends, by name: never a value (one may hold a credential). `set` false: its value was dropped when the connection's provider or address changed, so it is sent no more until it is typed again. Absent: none. */
  headers?: { name: string; set: boolean }[];
  /** It is the default: an agent that names no connection, or one that is gone, runs on it. */
  default: boolean;
  /** Null for a connection that signs with no key. */
  key: { set: boolean; last4: string | null } | null;
  signedIn?: boolean;
}

/** A provider the runtime offers: how its connections may sign (the first, a new one's), the APIs a connection of it may speak (the first, its default), and whether it needs the address of the user's own server (a compatible one) rather than taking one in place of its own (a proxy). */
export interface ProviderOffer {
  id: string;
  name: string;
  auth: ConnectionAuth[];
  apis: string[];
  needsBaseUrl: boolean;
}

/** A runtime's connections, which one is the default (null: none is), the providers it offers, and the runtime they are of: its relay id and its name. */
export interface ConnectionsView {
  connections: RuntimeConnection[];
  default: string | null;
  providers: ProviderOffer[];
  relay: { id: string; name: string };
}

/**
 * A connection to save, whole: an `id` of one of the runtime's changes it, none makes one. Null or
 * absent leaves an optional field out, but for `headers`: absent keeps the stored ones as they are;
 * null takes them all away; a record is exactly the headers kept, by name, a text setting a value
 * and null keeping the value stored under that name. A change of a connection's provider, or of its
 * address's origin, takes its key away unless one comes with it, and unsets every header value the
 * change doesn't give again (one may hold a gateway's credential for the old server), so nothing
 * stored goes to a server it wasn't given for. A connection that signs in takes no address, and an
 * address with a name and password in it is refused.
 */
export interface ConnectionInput {
  id?: string;
  name: string;
  provider: string;
  auth: ConnectionAuth;
  baseUrl?: string | null;
  api?: string | null;
  model?: string | null;
  effort?: ConnectionEffort | null;
  headers?: Record<string, string | null> | null;
}

/** A test call's outcome: how long it took, and the model that answered or the provider's words. */
export type ConnectionTest = { ok: true; ms: number; model: string } | { ok: false; ms: number; error: string };

/** A model a connection offers: its id, which is what is stored, and its name. */
export interface ModelChoice {
  id: string;
  name: string;
}

/** A sign-in begun: the flow to finish, the address to open, and what to know first, in the runtime's words. */
export interface SignInStart {
  flow: string;
  url: string;
  note: string;
}

/** How the runtime stands with a provider's sign-in: signed in, until when its current token holds (the runtime renews it by itself when a call finds it ran out; null when not signed in), the flow open for it, if one is, and why its last flow ended without signing in (cancelled, left open too long, the provider's words, the port taken; null once a flow starts again or a sign-in holds). */
export interface SignInState {
  provider: SignInProvider;
  signedIn: boolean;
  until: number | null;
  flow: string | null;
  ended: string | null;
}

/** One of Lumiverse's connection profiles, as "Copy from Lumiverse" lists it: never its key. `provider` is Lumiverse's own name for it; `baseUrl` null where the profile names none. */
export interface LumiverseConnection {
  id: string;
  name: string;
  provider: string;
  baseUrl: string | null;
  model: string | null;
}

// ---------------------------------------------------------------- settings and texts

// The settings' schema is JSON Schema, written by hand. The Settings page builds a form from the
// keywords below and shows a node it has no form for as JSON to edit, so no setting is out of reach:
// - `title` (the label; absent: the key) and `description` (the help), on every node.
// - `type`: "object", "integer", "number", "boolean", "string" or "array"; or a pair with "null"
//   (`["integer", "null"]`) for a setting that may be none, which `x-none` says in words
//   ("No limit", "The connection's own").
// - An object's `properties`, in the order written: a group of settings. An object with
//   `additionalProperties: <schema>` and no `properties` is a table the user adds rows to and
//   removes them from; `x-keys` says what names a row: "connection" (the id of one of the user's
//   connections), "model" (a model's name), absent (any name).
// - `enum`, or `oneOf` of `{ const, title, description? }`: one of several choices, the latter with
//   words for each.
// - `oneOf` of objects that each fix the same property with `const` (and name themselves with
//   `title`): one of several shapes, chosen by that property.
// - A number's `minimum`, `maximum` and `multipleOf`, and `x-unit`, its unit in words ("tokens",
//   "ms", "USD per million tokens"); a number in "ms" also shows as a length of time.
// - A string's `maxLength`, and `format`: "connection" (the id of one of the runtime's connections),
//   "model" (a model's name: the page suggests the models of the connection the same object names
//   in its `format: "connection"` property, read with `lah.connections.models`), "multiline" (text of
//   several lines).
// - An array's `items`: choices (`enum` or `oneOf` of `const`) with `uniqueItems`, a set of them
//   ticked; strings, a list the user adds to and removes from.
// `values` is the settings whole, the user's own over the defaults; `defaults` is them with nothing
// of the user's: a setting whose value differs from its default shows as changed, with Reset.

/** The user's settings: whole with defaults filled in, the defaults alone, and the schema the Settings page builds its forms from. */
export interface SettingsView {
  values: JsonObject;
  defaults: JsonObject;
  schema: JsonObject;
}

/** Where a setting sits: the keys from the settings' root down to it. */
export type SettingPath = string[];

/** A placeholder a text may use: `{{name}}`, filled with what `text` says; `required` when the text can't work without it. */
export interface TextVar {
  name: string;
  text: string;
  required?: true;
}

/** One text sent to a model: its id, where it sits, what it is for, its default and its placeholders. */
export interface TextDef {
  id: string;
  group: string;
  label: string;
  note: string;
  text: string;
  vars: TextVar[];
}

/** Every text, and the user's own text for each they replaced, by id. */
export interface TextsView {
  defs: TextDef[];
  own: Record<string, string>;
}

// ---------------------------------------------------------------- the state every page holds

/** What every page holds. `rev` counts the backend's pushes; a page follows them in order. */
export interface UiState {
  rev: number;
  runtime: RuntimeView;
  setup: SetupView;
  key: KeyView;
  /** The chats LumiAH is switched on for, and those it has answered since the extension started. */
  chats: ChatView[];
  /** The turns under way: replies, jobs and side sessions' turns. */
  running: RunningTurn[];
  connections: ConnectionView[];
  settings: SettingsView;
  texts: TextsView;
  /** The tool calls held for the user's word, in every chat of theirs (§17). */
  approvals: ApprovalView[];
  /** The jobs not yet over, the user's switches over all jobs, and a counter that moves whenever any job changes (a page showing a job list reads it again). */
  jobs: { active: JobView[]; off: boolean; paused: boolean; changed: number };
  /** What the user hasn't yet been told and dismissed: jobs that finished, failed, or need them. */
  notices: Notice[];
  /** A counter that moves whenever a definition changes: an agent's, a skill's, a tool's switch or its approval, an MCP server's switch. */
  defs: number;
  /** The permissions LumiAH lacks (§25), each with what to do; none when it has all it asks for. */
  permissions: PermissionNeed[];
}

/** The parts of the state a push can carry, each whole. */
export type UiStatePart = Exclude<keyof UiState, "rev">;

/** The state after a push: the parts it carries replace the page's; null when the page must say hello again (it missed a push, or the backend started again). */
export function followState(held: UiState, push: { rev: number; patch: Partial<Omit<UiState, "rev">> }): UiState | null {
  if (push.rev !== held.rev + 1) return null;
  return { ...held, ...push.patch, rev: push.rev };
}

// ---------------------------------------------------------------- sessions

/**
 * Whether the compaction a turn made can be rolled back: `available` (it is the one the session
 * stands on); `pending` (asked for: the chat's next turn reads the turns it replaced again);
 * `done` (a rollback undid it); `none` (a later compaction stands on it, or the turns it replaced
 * are no longer kept).
 */
export type RollbackState = "none" | "available" | "pending" | "done";

/** A turn of a chat, as the Sessions page lists it, from the record on its reply's message (DESIGN §5). */
export interface TurnRow {
  turn: string;
  messageId: string;
  /** The reply's place in the chat, from 0, and the swipe the record is for. */
  index: number;
  swipe: number;
  at: number;
  kind: TurnKind;
  /** The record's path hash still matches the messages before it; false: an earlier message changed, and the session no longer reads this turn. */
  onPath: boolean;
  /** The reply's opening words, to find it by. */
  preview: string;
  /** The turn's transcript, by its blob's hash (`lah.transcript.get`); null when none was kept. */
  transcript: string | null;
  /** The compaction made at this turn: its summary's blob (`lah.blob.get`), how many earlier turns it replaced, and whether it can be rolled back. */
  compaction: { summary: string; replaced: number; rollback: RollbackState } | null;
  usage: AgentUsage | null;
  /** How many workspace files the turn's change set names (`lah.ws.changes`). */
  changes: number;
}

/** A chat's session as it stands at the end of its active path: what the main agent would carry into the next turn. */
export interface SessionView {
  /** The turns it reads in full, and their tokens as estimated. */
  turns: number;
  tokens: number;
  /** A summary stands for the turns before those. */
  summary: boolean;
  /** Turns whose records are off the path (an earlier message changed), which it doesn't read. */
  dropped: number;
  /** Stored parts it names that the store no longer has. */
  missing: number;
  /** When the user asked for the notes to be summarized at the next turn, while that still stands; absent or null: not asked. */
  asked?: number | null;
  /** A rollback holds the notes as they are: they aren't summarized again until they have grown by Settings' margin, or the user asks. Absent: the backend doesn't say. */
  held?: boolean;
  /** The session was read from the extension's storage before the runtime said it had sent everything it saved: why, and that what is shown may lack the newest. Absent: it had. */
  behind?: string;
}

export interface TurnsPage {
  turns: TurnRow[];
  /** The cursor that reads the page after this one; null on the last. */
  next: string | null;
  total: number;
  session: SessionView;
}

// ---------------------------------------------------------------- approval and talking to a turn (§17, §18)

/** Whether a tool's call goes ahead or waits for the user's word. */
export type ApprovalChoice = "allow" | "ask";

/** A tool call held for the user's word, as core asks it (`chatId` is "" for a side session about no chat; `until` null: the wait has no bound), with the id it is answered by and the stream of the run that waits. */
export interface ApprovalView extends ApprovalAsk {
  id: string;
  stream: StreamId;
}

/** A tool the user approved "for this chat" when a call of it was held: its calls in that chat run without asking until the user takes that back. */
export interface KeptApproval {
  chatId: string;
  /** The chat's name; null where Lumiverse gives none. */
  chat: string | null;
  tool: string;
  /** When the user approved it. */
  at: number;
}

// ---------------------------------------------------------------- the workspace (§11) and guidance (§12)

/**
 * A file as an area's index holds it: its path within the area, its body's hash, its length in
 * characters (what Settings bound, as core measures), when and by whom it was last written, and
 * the agent definitions it is pinned for, by id (a pinned file is put in that agent's context each
 * turn).
 */
export interface WorkspaceFile {
  path: string;
  hash: string;
  chars: number;
  at: number;
  by: FileAuthor;
  pins: string[];
}

/**
 * An area as it stands: its files, their characters together, the bounds Settings put on it (a
 * file's characters, how many files, the area's characters, the characters pinned for one agent),
 * and the agent definitions a file may be pinned for. For the chat's area, `basis` is the reply
 * whose record it stands on (null: no turn has written to it).
 */
export interface WorkspaceView {
  area: WorkspaceArea;
  files: WorkspaceFile[];
  chars: number;
  limits: { fileChars: number; files: number; areaChars: number; pinChars: number };
  agents: { id: string; name: string }[];
  basis: { messageId: string; swipe: number; index: number } | null;
}

/** A version of a file, newest first in a history: its body's hash (null: the file was deleted then), its length in characters, and the reply whose turn made it, where a turn did. */
export interface FileVersion {
  hash: string | null;
  chars: number;
  at: number;
  by: FileAuthor;
  turn: { messageId: string; swipe: number; index: number } | null;
}

/** One file of a turn's change set: what core says of a file a tool changed (its version before and after; a file moved is one gone and one there with the same hash), and who wrote it. */
export interface ChangedFile extends FileChange {
  by: FileAuthor;
}

/** A level of guidance (§12): the user's, the middle one (a plain chat's character's; an extension names its own), and the chat's. */
export type GuidanceLevelId = "user" | "middle" | "chat";

/** A guidance level as the page shows it: whose it is in words, its text, its version (null: nothing written yet), and whether the page may edit it (`locked` says why not). */
export interface GuidanceLevel {
  id: GuidanceLevelId;
  label: string;
  note: string;
  text: string;
  hash: string | null;
  at: number | null;
  by: FileAuthor | null;
  editable: boolean;
  locked?: string;
}

/** The guidance an agent of a chat is given, in the order it is given: the levels, the characters Settings allow each level (what is over is cut when it is given, and the page says so), and whether an agent may edit the chat's level. */
export interface GuidanceView {
  levels: GuidanceLevel[];
  limit: number;
  agentsEdit: boolean;
}

// ---------------------------------------------------------------- definitions (§13, §16)

/**
 * Where a definition comes from, and how it stands: its source; for a user's definition that
 * stands over a built-in or an extension's of the same id, which (`over`: removing the user's
 * restores that original); and whether it is switched off. Core's own shape (`Sourced`).
 */
export interface Sourced {
  source: DefinitionSource;
  over?: "builtin" | "extension";
  off: boolean;
}

/**
 * An agent definition as core has it (its id, name and description, which is what a delegating
 * agent reads when choosing; its instructions; what it is given; and what it runs with: its tools
 * by name or `@family`, connection, model, effort and budget), with where it comes from. The page
 * edits what it runs with through `DefsView.agentSchema`, as it builds Settings. `owns`: the fields
 * the extension keeps as its own, which the page shows and doesn't edit. `lacks`: for the user's
 * version over an original, the tools the original names now that the user's doesn't give.
 */
export type AgentView = AgentDefinition & Sourced & { lacks?: string[] };

/** A skill: a procedure an agent may load by name (`skill_load` returns `body`), with where it comes from, whom it is for (`agents`), and whether the extension keeps it as its own (`owned`). */
export type SkillView = Skill & Sourced;

/** A tool of the registry: its family and tier, what a model is told it does, its arguments' schema, where it runs, where it comes from, whether it is off, the user's own approval choice for it (null: its tier's), and whether its calls wait for the user now. An MCP server's tool is named `mcp:<server>:<tool>`. */
export interface ToolRow {
  name: string;
  family: string;
  tier: ToolTier;
  description: string;
  parameters?: JsonObject;
  runs: "runtime" | "extension";
  source: DefinitionSource;
  off: boolean;
  approval: ApprovalChoice | null;
  asks: boolean;
}

/** An MCP server the user has set up in Lumiverse (§16): whether its tools are switched off for agents (they are until the user switches them on), how the server stands in Lumiverse, and how many tools it offers. */
export interface McpServerView {
  id: string;
  name: string;
  off: boolean;
  status: "ready" | "stopped" | "failed";
  problem?: string;
  tools: number;
}

/**
 * Every definition: the agents, the skills, the tools, the MCP servers; the form of what an agent
 * runs with (a schema in the settings' dialect over an agent definition's `connectionId`, `model`,
 * `effort`, `tools`, `budget` and `given`, with the values a new agent starts from); and what each
 * tier's calls do unless a tool says otherwise.
 */
export interface DefsView {
  agents: AgentView[];
  skills: SkillView[];
  tools: ToolRow[];
  mcp: McpServerView[];
  agentSchema: JsonObject;
  agentDefaults: JsonObject;
  tiers: Record<ToolTier, ApprovalChoice>;
}

// ---------------------------------------------------------------- jobs (§15)

// A job is core's `JobView`: its chat and agent, how its task opens, when it was to start, who
// started it, the turn it belongs to, how it stands (and `paused`), what it spent, its report's
// blob with its opening, why it ended badly, and its transcript's blob once it ended. While it
// runs, its work is followed under its own id (`StreamId`).

/** A page of jobs, newest first, with the limits Settings put on jobs and what today has spent of the day's. */
export interface JobsPage {
  jobs: JobView[];
  next: string | null;
  total: number;
  limits: { atOnce: number; tokensPerJob: number | null; msPerJob: number | null; tokensPerDay: number | null };
  /** The tokens jobs used in the last 24 hours as the day's limit counts them (a prompt token re-read from the provider's cache counts as the share Settings give), and `sent`, the tokens truly sent and written, where that differs. */
  today: { tokens: number; sent?: number };
  /** The agent definitions a job may be started as, by id, for the page to name each job's agent and to offer when starting one by hand. */
  agents: { id: string; name: string }[];
}

/** Something the user should hear of: a job that finished, failed, was interrupted, or needs them. Kept until dismissed. */
export interface Notice {
  id: string;
  at: number;
  kind: "job_done" | "job_failed" | "job_interrupted" | "job_needs_user";
  chatId: string;
  jobId: string;
  text: string;
}

// ---------------------------------------------------------------- side sessions (§19)

/** A conversation with an agent that is no reply in a chat: with which agent (its definition's id and name), about which chat (null: none), its title (its first message's opening), and how many turns it has. Its turns are followed under its own id (`StreamId`). */
export interface SideSession {
  id: string;
  agent: string;
  agentName: string;
  chatId: string | null;
  title: string;
  createdAt: number;
  lastAt: number;
  turns: number;
}

/** A turn of a side session: what the user said, what the agent answered (null while it works, and where it gave none), how it stands, its transcript once kept, and what it spent. */
export interface SideTurn {
  turn: string;
  at: number;
  said: string;
  answer: string | null;
  state: "running" | LiveEndState;
  transcript: string | null;
  usage: AgentUsage | null;
}

// ---------------------------------------------------------------- spend and upkeep (§20)

/** Spend under one key (a day, a chat, an agent, a connection, a model): calls, tokens, cost, and the calls no price was known for. */
export interface SpendRow {
  key: string;
  label: string;
  calls: number;
  in: number;
  cachedIn: number;
  out: number;
  cost: number;
  unpriced: number;
}

/** A cap in force: the setting that holds it, what it bounds in words, its limit (null: none set), what has been used of it, and whether it is reached (the next call is refused, naming the setting). */
export interface SpendCap {
  path: SettingPath;
  label: string;
  unit: "tokens" | "usd" | "calls" | "ms";
  limit: number | null;
  used: number;
  /** For a cap on tokens: the tokens truly sent and written, each counted in full, where that differs from `used` (which counts a prompt token re-read from the provider's cache as the share Settings give). Absent where the two are the same. */
  sent?: number;
  reached: boolean;
}

/** Spend over the days asked for (each day by its date, oldest first), and the same spend by chat, agent, connection and model, with the caps in force. */
export interface SpendView {
  days: SpendRow[];
  chats: SpendRow[];
  agents: SpendRow[];
  connections: SpendRow[];
  models: SpendRow[];
  total: SpendRow;
  caps: SpendCap[];
}

/** One kind of thing the store keeps (prompts, transcripts, the spans compactions replaced, workspace files, reports): how many, how big, how long Settings keep it, and its oldest. */
export interface StoredKind {
  kind: string;
  label: string;
  count: number;
  bytes: number;
  kept: { path: SettingPath; words: string } | null;
  oldestAt: number | null;
}

/** What is stored and how big it is; the blobs nothing refers to, as last counted (null: never counted); and the last sweep. */
export interface UpkeepView {
  kinds: StoredKind[];
  total: { count: number; bytes: number };
  loose: { count: number; bytes: number; at: number } | null;
  lastSweep: { at: number; removed: number; bytes: number; ms: number } | null;
  sweeping: boolean;
}

// ---------------------------------------------------------------- home

/**
 * What a reply's turn came to, read from its events (`replyDid`): the brief the main agent gave the
 * model that writes the reply (the `brief` of its last `write_reply` call that was taken; its last
 * answer where it made no such call and never stopped, which the turn takes for one; null where it
 * gave none), the lore entries that call added to what the writer saw and those it left out of the
 * prompt, by title (§24.3), and, where the main agent stopped short of a brief, its stop: the code
 * and its words (null where it didn't).
 */
export interface ReplyDid {
  brief: string | null;
  lore: { added: string[]; dropped: string[] };
  stop: { code: AgentStopCode; reason: string } | null;
}

/**
 * What a run's events say its turn came to. The one reader of it: a page reads the live view it
 * follows with it, and the backend the same events for `LastTurn.did`, so the first screen and the
 * head of Live never say two things of one turn. Events are read by shape past their kind, since a
 * stored transcript may come from an earlier build.
 */
export function replyDid(events: readonly TraceRecord[]): ReplyDid {
  let main: string | null = null;
  const briefs = new Map<string, string>();
  let brief: string | null = null;
  let lore: ReplyDid["lore"] = { added: [], dropped: [] };
  let answer: string | null = null;
  let stop: ReplyDid["stop"] = null;
  for (const { event } of events) {
    if (event.kind === "agent_started") {
      // The main agent is the one no other agent started: the first of a run.
      if (main === null && event.agent.parent === undefined) main = event.agent.id;
      continue;
    }
    if (event.kind !== "agent_entry" || event.agentId !== main) continue;
    const { entry } = event;
    if (entry.kind === "answer") {
      const calls = Array.isArray(entry.calls) ? entry.calls : [];
      for (const call of calls) if (call.name === TOOL.writeReply && isRecord(call.args) && typeof call.args.brief === "string") briefs.set(call.id, call.args.brief);
      answer = calls.length === 0 && typeof entry.text === "string" && entry.text.trim() !== "" ? entry.text : null;
      stop = null;
    } else if (entry.kind === "result") {
      // What the writer saw is what the last `write_reply` that was taken left it: an earlier brief and its lore gave way to it.
      if (entry.name !== TOOL.writeReply || entry.error === true) continue;
      brief = briefs.get(entry.callId) ?? brief;
      const changed = loreChangesOf(entry);
      lore = { added: changed?.added.map((e) => e.title) ?? [], dropped: changed?.dropped.map((e) => e.title) ?? [] };
    } else if (entry.kind === "stop") stop = { code: entry.code, reason: entry.reason };
  }
  if (brief !== null) return { brief, lore, stop: null };
  return { brief: stop === null ? answer : null, lore, stop };
}

/**
 * A chat's latest turn in what the first screen says of it: the run and the message its reply is
 * on (null: none saved), when it began and how it ended (null while it runs),
 * what it spent, how many agents worked and how many tool calls they made, the lore entries the
 * main agent added to and dropped from what the writer saw (§24.3), the workspace files it changed,
 * the jobs it started, its transcript where one is kept (`lah.transcript.get`), and what it came
 * to in words (`did`: `replyDid` of the run's events; absent where the backend has no events of
 * the run to read, or doesn't say).
 */
export interface LastTurn {
  turn: string;
  kind: TurnKind;
  messageId: string | null;
  startedAt: number;
  ended: LiveEnded | null;
  usage: AgentUsage | null;
  agents: number;
  tools: number;
  lore: { added: number; dropped: number };
  changes: number;
  jobs: number;
  transcript: string | null;
  did?: ReplyDid;
}

/**
 * What the first screen reads at once: the chat (null: none was named, or Lumiverse has none of
 * that id) and its latest turn (null: LumiAH has worked on no reply in it). The rest of what Home
 * shows is in the state every page holds: what needs the user (`approvals`, `notices`,
 * `permissions`), what runs (`running`), and first-time setup (`setup`).
 */
export interface HomeView {
  chat: ChatView | null;
  last: LastTurn | null;
}

/**
 * A runtime's working store as Runtime → System shows it: the core's documents and blobs on the
 * runtime's own disk, this extension's storage as their mirror. Whether it is open (it may read and
 * save now); whether it keeps its own copy (`mode`: `held`), works without one straight on the
 * storage (`direct`: another runtime, `holder`, keeps the storage; `lost`: since it lost it, to whom
 * and with how many changes the storage never had), or waits to know which (`waiting`, `opening`);
 * how many paths the storage doesn't have as they stand there and since when (null: none wait), the
 * storage's last failure, when it last took a change, the bytes on the runtime's disk (`counting`:
 * still being counted), the last time this runtime threw its copy away for the storage's, and the
 * changes the storage refused for good, the latest first.
 */
export interface StoreStateView {
  open: boolean;
  mode: "waiting" | "opening" | "held" | "direct";
  holder: string | null;
  lost: { at: number; to: string | null; dropped: number } | null;
  waiting: number;
  behindSince: number | null;
  lastError: { words: string; at: number } | null;
  lastSent: number | null;
  bytes: number;
  counting: boolean;
  takeover: { from: string | null; at: number; dropped: number } | null;
  refused: { name: string; doc: boolean; words: string; at: number }[];
}

/** A chat or a world book the runtime's copy keeps, as Runtime → Chat data shows it. */
export interface ChatDataKept {
  id: string;
  /** Where its rows were read from: `http` (Lumiverse, as the runtime's signed-in user) or `database` (Lumiverse's own file). */
  from: string;
  /** Its messages, or its entries. */
  rows: number;
  chars: number;
  /** When it was last read whole, and why. */
  read: { at: number; why: string };
  /** When it was last found current, by a read or a check. */
  checkedAt: number;
  /** What that last read or check could see, and what it couldn't (null: all an agent reads of it). */
  check: { saw: string; missed: string | null };
  /** Why it is to be read again before it is next used; null: it is current. */
  stale: string | null;
}

/** One read the database reader made, as it reports it. */
export interface ChatDataReaderRead {
  at: number;
  what: string;
  rows: number;
  chars: number;
  ms: number;
  outcome: string;
}

/**
 * The runtime's copy of chat and lore as Runtime → Chat data shows it for one linked runtime: where
 * the agents' reads of chats and world books are answered now and why, the copy's source and why,
 * the database reader's own state where the operator switched it on for this runtime, the runtime's
 * sign-in to Lumiverse where it needs renewing, what the copy holds (each chat's and book's last read
 * and why, what its last check could and couldn't see), what it found too large to keep beside all it
 * may keep and the runtime's memory limit, the latest reads whole, every read it sent to this
 * extension instead and why, and Lumiverse's events heard with every one found lost on the way.
 */
export interface ChatDataView {
  /** `copy`: answered from the runtime's copy, by this extension wherever the copy can't vouch for one; `link`: every one by this extension. */
  road: "copy" | "link";
  /** Why, in plain words. */
  why: string;
  /** The copy's source now: `database` or `http`; null without a copy. */
  source: string | null;
  sourceWhy: string | null;
  /** Words for the runtime's sign-in to Lumiverse when it needs renewing; null while it holds. */
  signIn: string | null;
  /** The direct database reader: null where it isn't switched on for this runtime. */
  reader: { path: string; on: boolean; why: string | null; open: boolean; schema: { checkedAt: number | null; matches: boolean | null; difference: string | null }; lastRead: ChatDataReaderRead | null; lastCheck: ChatDataReaderRead | null } | null;
  /** Characters kept and the most that may be, beside the runtime's memory limit and what holds it there. */
  memory: { kept: number; most: number; limit: string; note: string | null };
  chats: ChatDataKept[];
  books: ChatDataKept[];
  /** Found larger than all the copy may keep: read from this extension every time. */
  tooLarge: { chats: { id: string; chars: number }[]; books: { id: string; chars: number }[] };
  /** The latest reads whole, the newest last. */
  reads: { at: number; what: "chat" | "book"; id: string; why: string; outcome: string }[];
  /** Reads sent to this extension because the copy couldn't vouch for its answer: how many in all, and the latest, the newest last. */
  fallbacks: { total: number; latest: { at: number; what: "chat" | "book"; id: string; why: string }[] };
  /**
   * Reads sent to this extension because one of Lumiverse's routes the copy reads didn't answer as the
   * copy expects (they are no interface Lumiverse promises to keep): how many in all, and the latest,
   * the newest last, each with the route, what it answered, and until when the copy asks it nothing
   * (null: it is asked again at the next read).
   */
  routes: { total: number; latest: { at: number; what: "chat" | "book"; id: string; why: string; route: string; status: number; until: number | null }[] };
  /** Lumiverse's events heard since the runtime started, and the times one was found lost on the way, when the copy was read again whole. */
  events: { heard: number; gaps: number; lastGap: { at: number; why: string } | null };
}

/** The direct database reader's switch, as the user's page is shown it: only the operator is shown it, and only to them is the file named. */
export interface DatabaseSwitchView {
  /** The user is this Lumiverse's operator: the switch is theirs alone. */
  operator: boolean;
  on: boolean;
  /** Lumiverse's database file; null for anyone but the operator, and where it can't be told from where the extension is installed. */
  path: string | null;
}

// ---------------------------------------------------------------- lore (§24.1 to §24.5)
//
// These are core's own shapes (`src/core/recall/shapes.ts`) under the names the pages use: the
// backend passes what core answers through as it is, so a page can't drift from core.

/** A lore entry's state for the chat's last turn: Lumiverse put it in the prompt; the main agent added it for the writer (§24.3); the main agent dropped it from what the writer saw; it wasn't in the prompt; the user has it switched off. */
export type { LoreState } from "../core/recall/shapes";

/** How an entry came to be in the prompt (§24.1): a key matched (null: Lumiverse didn't say which), a match by meaning with its score (null: not given), it is always on, or Lumiverse gave no detail. */
export type LoreWhy = HeldWhy;

/** A world book that applies to the chat, and how many entries it has. */
export type LoreBookView = LoreListing["books"][number];

/**
 * An entry of a chat's books: its id and the short name the agents' tools print it under, its book,
 * title and keys, its text's length in characters and in tokens as estimated, whether it is
 * switched on, always on (`constant`) and kept as a vector for search by meaning (`vectorized`), its
 * state for the last turn, and how it came to be in the prompt where it was.
 */
export type { LoreRow } from "../core/recall/shapes";

/**
 * Search by meaning as it stands for a chat (§24.5): the embedding connection it uses (null: none is
 * set, so search is by word), whether Settings allow it (off until the user switches it on), how
 * many lore entries and chat messages have a vector of how many, how many texts wait for one and
 * what they come to in tokens as estimated (`pendingTokens`, worked out while the switch is off
 * too: it is what switching it on would send), whether they are being embedded now, what the last
 * 24 hours' embedding came to against the daily cap (in tokens; null: none), and what it has come
 * to in all (a cost is null where no price is set). Core's own shape.
 */
export type EmbeddingStatus = EmbedStatus;

/** A chat's lore as the Lore page shows it: its books, every entry with its state for the last turn (`last`; null: LumiAH has had no turn in the chat, so each entry is only off or not in the prompt), and search by meaning as it stands. */
export interface LoreView extends LoreListing {
  embedding: EmbeddingStatus;
}

/**
 * One hit of the agents' own `lore_search` (§24.2): the entry, its score, how it matched (by word,
 * by meaning, or both), in which fields and on which words, how alike it is by meaning where that
 * was asked, and its best lines, each with its number in the entry's text.
 */
export type LoreHit = LoreHitView;

/** What a search found: each query with its hits, best first, and how many it found in all; and whether matches by meaning were merged in (`off`: Settings don't allow it; `none`: no embedding connection is set). */
export type LoreSearch = LoreSearchView;

// What the prompt held (§24.1) and the lore the writer saw (§24.3) reach the pages in the trace, as
// core's turn traces them: an event `{ kind: "prompt_held", at } & PromptHeld`, and `lore` on the
// `result` entry of a `write_reply` call. The two readers below take them from a trace by their
// shape, so a page reads a transcript kept by a build whose trace types had neither. Nothing of
// them is a request.

/**
 * What the prompt held, as the main agent was told (§24.1). `lore`: each entry Lumiverse activated,
 * with its size, how it got there, and which message of the request holds it (from 1; null: it sits
 * inside a block with other text). `index`: the entries not in the prompt that were listed, and how
 * many more there are. `history`: the chat's messages the prompt holds word for word and those it
 * doesn't, as ranges of message numbers, and what stands in for the rest, each named.
 */
export type { PromptHeld } from "../core/recall/shapes";

/** An entry the main agent added to or dropped from what the writer saw (§24.3). */
export type { LoreChanged } from "../core/recall/shapes";

/** What a `write_reply` call did to the writer's lore: the entries added, those dropped, and those it named that were refused, each with why (`entryId` is the reference as the agent gave it where it named no entry). */
export type LoreChanges = LoreChange;

/** What the prompt held, where a trace event says it; null for any other event. */
export function promptHeldOf(event: TraceEvent): (PromptHeld & { at: number }) | null {
  // Read by shape: a stored transcript may come from a build whose trace named no such event.
  const e: unknown = event;
  if (!isRecord(e) || e.kind !== "prompt_held" || !Array.isArray(e.lore) || !isRecord(e.index) || !Array.isArray(e.index.listed) || !isRecord(e.history) || !Array.isArray(e.history.held) || !Array.isArray(e.history.missing) || !Array.isArray(e.history.stands)) return null;
  return e as unknown as PromptHeld & { at: number };
}

/** What a tool's result says the call did to the writer's lore; null for an entry that says nothing of it. */
export function loreChangesOf(entry: TranscriptEntry): LoreChanges | null {
  // Read by shape, for the same reason as `promptHeldOf`.
  const e: unknown = entry;
  if (!isRecord(e) || e.kind !== "result" || !isRecord(e.lore) || !Array.isArray(e.lore.added) || !Array.isArray(e.lore.dropped)) return null;
  return { added: e.lore.added as LoreChanged[], dropped: e.lore.dropped as LoreChanged[], refused: Array.isArray(e.lore.refused) ? (e.lore.refused as LoreChanges["refused"]) : [] };
}

// ---------------------------------------------------------------- the chronicle (§24.7)
//
// The chronicle is four files the agents write as `learned/chronicle/outline.md`, `facts.md`,
// `threads.md` and `cast.md` (learning a story adds `plan.md` and `unverified.md` beside them).
// Every path here is in that form, as the agents write it; a page reads a file's text as it reads
// any workspace file (`lah.ws.read` with `area: "learned"` and `learnedPath(path)`). Each line is
// a markdown bullet that cites the messages it rests on. These too are core's own shapes.

const LEARNED = "learned/";

/** A path as the agents write it (`learned/chronicle/facts.md`), as a workspace request takes it within the `learned` area (`chronicle/facts.md`). */
export function learnedPath(path: string): string {
  return path.startsWith(LEARNED) ? path.slice(LEARNED.length) : path;
}

/** A citation as a chronicle line carries it, `[#412 a3f9c27e]`: the message's number in the chat and the first characters of the hash of its text; `citation` is it whole, as `lah.chronicle.cited` takes it, and `start` is where in the line it begins. */
export interface Citation {
  citation: string;
  index: number;
  hash: string;
  start: number;
}

/** The citations in a line of the chronicle, in the order written, as core reads them. */
export function citationsOf(line: string): Citation[] {
  let from = 0;
  return citationsIn(line).map((c) => {
    const start = line.indexOf(c.text, from);
    from = start + c.text.length;
    return { citation: c.text, index: c.index, hash: c.hash, start };
  });
}

/** A file of the chronicle: its path, its length, its lines, how many of them cite a message, and how many the check fails. */
export type ChronicleFile = ChronicleCheck["files"][number];

/** A line the check fails: its file and its number in it (from 1), its text, the citation that fails and the message it names, and why: the message is gone, or its text has changed (a swipe, an edit). Such a line is left out of what the main agent is given. */
export type { ChronicleFailure } from "../core/recall/shapes";

/**
 * The chronicle as `chronicle_check` finds it, worked out by code each time it is read (so reading
 * it runs the check): its files (none: the chat has no chronicle yet), the lines that fail, the
 * lines whose message still says the same but stands at another number now (`moved`; they pass),
 * and the lines that cite nothing.
 */
export type ChronicleView = ChronicleCheck;

/** The message a citation names: its number, whether it still says what was cited (`why` where it doesn't, or where it does at another number, `now`), and the message as it stands (null: gone). */
export type CitedView = CitedMessage;

// ---------------------------------------------------------------- learning a story (§22)

/**
 * The learning of a chat's story: a long objective (§22) that builds the chronicle. Core marks no
 * job as it, so the backend remembers the job a page started with `story: true` (`lah.job.start`).
 * `job` is the latest such job of the chat (null: none was started); a job started again from it
 * (`lah.job.again`) takes its place. The rest is core's own (`StoryStatus`): `plan` is its plan
 * file's path as the agents write it (`learned/chronicle/plan.md`) once the file is there (read
 * with `lah.ws.read` and `learnedPath`); `messages` and `covered` say how far it has come: the
 * chat's messages, and how many of them the chronicle's outline spans; `estimate` is what learning
 * the rest is expected to take; `suggested` is what the page fills in before the user starts one:
 * the objective's words (a text the user can replace) and the agent (the chronicler). The page
 * sizes the budget it offers from the estimate; the backend suggests none. The job is steered,
 * paused, resumed and granted more as any job is.
 */
export type StoryView = StoryStatus & { job: JobView | null };

/**
 * What learning the rest of a chat's story is expected to take (§22), as core reckons it: the
 * messages and characters no line of the outline covers yet, the stretches it will be read in, the
 * prompt tokens of every model call of the job, the tokens written, the prompt tokens as limits
 * count them (`weighedTokens`: a job's `tokensIn` is sized from this), the rounds of tool calls,
 * and the cost at the price of the model that does it (null: it has none). Zeros where nothing is
 * left to learn. Before the first job the rest is the whole chat, so one member serves the offer
 * and "Carry on to the end".
 */
export type { StoryEstimate } from "../core/recall/shapes";

// ---------------------------------------------------------------- requests

/** Each request's body and its result. */
export interface UiRequests {
  /**
   * The page starts (or lost the state's thread): the whole state. `active` is the connection
   * profile active in Lumiverse as the page reads it then (its id; null: none is; left out where the
   * host doesn't say): a chat with no connection of its own generates on it, and only a page can
   * know which it is. A page says hello again whenever it may have changed (the drawer opened or
   * brought to another tab, the page shown again).
   */
  "lah.hello": { body: { active?: string | null }; result: UiState };
  /** A chat as the pages show it, whether LumiAH answers it or not. */
  "lah.chat.get": { body: { chatId: string }; result: { chat: ChatView } };
  /** Switches LumiAH on for a chat or off. On, the chat is pinned to the loopback connection, so the runtime answers its replies (§25); off, it gets back the connection it had. Refused with `unavailable`, in words that say what to do, where there is no loopback connection to pin it to yet, and where a permission LumiAH needs is missing. */
  "lah.chat.set": { body: { chatId: string; on: boolean }; result: { chat: ChatView } };
  /** Takes over a chat that bears another backend's mark (`ChatView.other`): that mark is removed, the chat gets back the connection it had, and it is switched on here, pinned to this backend's loopback connection. */
  "lah.chat.takeover": { body: { chatId: string }; result: { chat: ChatView } };
  /** What counts as a chat's story (§24.4): the chat's own choice, Settings', the word of the extension that answers it, what Lumiverse says of Sovereign Hand, and what holds. */
  "lah.chat.story.get": { body: { chatId: string }; result: { story: ChatStoryView } };
  /** The chat's own choice, whole: each member given stands over Settings for this chat, each left out follows them. A member the extension that answers the chat set is its to set: the chat's choice of it is kept, and doesn't hold while the extension's word does. */
  "lah.chat.story.set": { body: { chatId: string; story: Partial<StorySetting> }; result: { story: ChatStoryView } };
  /** Who leads the chat's replies, as the extension that answers this backend's chats claims it; null where it doesn't claim the chat, or there is no such extension (LumiAH's main agent leads). */
  "lah.chat.lead.get": { body: { chatId: string }; result: { lead: ChatLeadView | null } };
  /** Opens a live view (`StreamId`): its latest turn, or null when it has had none since the extension started; from then on the page hears `lah.live` and `lah.live.delta` for it. */
  "lah.live.open": { body: { stream: StreamId }; result: { live: LiveView | null; next: number | null } };
  /** A turn's events from `from` on, while it is the stream's live turn. */
  "lah.live.events": { body: { stream: StreamId; turn: string; from: number }; result: { events: LiveEvent[]; next: number | null } };
  "lah.live.close": { body: { stream: StreamId }; result: { closed: true } };
  /** Stops a running turn; false when it had already ended. */
  "lah.turn.stop": { body: { stream: StreamId; turn: string }; result: { stopped: boolean } };
  /** A note from the user the turn's main agent receives at its next round, marked as theirs (§18); false when the turn had already ended. */
  "lah.turn.say": { body: { stream: StreamId; turn: string; text: string }; result: { said: boolean } };
  /** Holds every agent of the turn at its next round, or lets them go on (§18); `paused` is how the turn stands after. */
  "lah.turn.pause": { body: { stream: StreamId; turn: string; on: boolean }; result: { paused: boolean } };
  /** The user's word on a held tool call (§17), as core takes it: this once, for this tool in this chat from now on, or refused with a reason the agent is given. `answered` false when it was no longer waiting (answered elsewhere, or its wait ran out). */
  "lah.approval.answer": { body: { id: string; answer: ApprovalAnswer }; result: { answered: boolean } };
  /** The tools the user approved "for this chat" (`ApprovalAnswer` `chat`), newest first: one chat's, or (null) every chat's. */
  "lah.approvals.kept": { body: { chatId: string | null }; result: { kept: KeptApproval[] } };
  /** Takes back an approval "for this chat": the tool's next call in that chat is held again, where its tier or its own choice asks first. Answers what is still kept, as `lah.approvals.kept` with the same `chatId` would. */
  "lah.approval.forget": { body: { chatId: string; tool: string }; result: { kept: KeptApproval[] } };
  /** A chat's turns, newest first, from `cursor` (null: the first page), with its session as it stands. */
  "lah.turns.list": { body: { chatId: string; cursor: string | null; limit: number }; result: TurnsPage };
  /** A stored transcript (`TurnRow.transcript`, `JobView.transcript`, `SideTurn.transcript`), its events from `from` on. */
  "lah.transcript.get": { body: { transcript: string; from: number }; result: { view: LiveView; next: number | null } };
  /** The exact request of a model call (`TranscriptEntry.prompt`). */
  "lah.prompt.get": { body: { prompt: string }; result: { prompt: CallPrompt } };
  /** A stored text by its hash: a compaction's summary (`TurnRow.compaction.summary`). */
  "lah.blob.get": { body: { hash: string }; result: { text: string } };
  /** Asks for the rollback of the compaction made at a turn (`RollbackState`): the session reads the turns it replaced again. */
  "lah.session.rollback": { body: { chatId: string; messageId: string; swipe: number }; result: { turn: TurnRow; session: SessionView } };
  /** Asks for the chat's notes to be summarized at its next turn, whatever their length and whatever a rollback holds (§10): the session then says it was asked. */
  "lah.session.summarize": { body: { chatId: string }; result: { session: SessionView } };
  /**
   * Changes settings: each `set` puts a value at a path, whole; each `reset` takes the user's own
   * value at a path away, so its default stands (an empty path: every setting). All of them are
   * kept or, when the settings refuse one (`invalid`, with `problems`), none.
   */
  "lah.settings.set": { body: { set: { path: SettingPath; value: JsonValue }[]; reset: SettingPath[] }; result: { settings: SettingsView } };
  /** The user's own text for `id`. */
  "lah.text.set": { body: { id: string; text: string }; result: { texts: TextsView } };
  /** Back to `id`'s default. */
  "lah.text.reset": { body: { id: string }; result: { texts: TextsView } };
  /**
   * `mint` mints the loopback key (rotating it when one is set: the old one stops working at once)
   * and has the user's linked runtime put it in the loopback connection, making that connection
   * when there is none: `connection` names it, or is null when no runtime was linked to do it.
   * `key` is the new key, shown this once: the user pastes it into the connection themselves when
   * no runtime did. `forget` forgets the key (`key` and `connection` null).
   */
  "lah.key": { body: { op: "mint" | "forget" }; result: { key: string | null; view: KeyView; connection: { id: string; name: string } | null } };
  /** Rotates a runtime's relay secret (the runtime takes the new one over its link; the old one stops working), or forgets the runtime (it must register again). */
  "lah.relay": { body: { op: "rotate" | "forget"; relay: string }; result: { runtime: RuntimeView } };
  /** Closes Lumiverse's drawer for this user, so the chat shows (on a phone the drawer covers it, and a page has no way to close it itself). `closed` false where the host has no such call. */
  "lah.drawer.close": { body: Record<string, never>; result: { closed: boolean } };
  /** How one of the user's runtimes is run and kept, as it says itself: its build, its memory limit and what holds it there, whether it updates by itself, an update that waits and why, what is under way. Asked of that runtime alone: refused `unavailable` while it isn't linked. */
  "lah.runtime.service.get": { body: { relay: string }; result: { service: ServiceView } };
  /** Changes how it is kept: its memory limit, whether it updates by itself; `restart` restarts it where a limit holds only once it does. What the change did: it holds now (`none`), once it restarts (`needed`), or it is restarting. */
  "lah.runtime.service.set": { body: { relay: string; memory?: string; autoUpdate?: boolean; restart?: boolean }; result: { service: ServiceView; restart: "none" | "needed" | "restarting" } };
  /** Takes the update that waits, now, whatever is under way: what was (`cut`) ends with the restart. */
  "lah.runtime.update.apply": { body: { relay: string }; result: { service: ServiceView; cut: UnderWay } };

  /** An area of the workspace as it stands (§11). `chatId` null reads the user's own area without a chat; the chat's area and `learned/` need one. */
  "lah.ws.list": { body: { chatId: string | null; area: WorkspaceArea }; result: WorkspaceView };
  /**
   * A file's text as it stands, or as one of its versions held it (`version`: a hash from
   * `lah.ws.history`). `file` is the file as it stands; `version` is the hash of the version whose
   * text this is (the standing one where none was asked for). Two versions are compared with two
   * reads; one is restored by writing its text based on `file.hash`, so it becomes a new version and
   * nothing is lost. Refused with `not_found` where the file, or that version of it, is no longer
   * kept. A workspace body is read no other way: `lah.blob.get` doesn't give it.
   */
  "lah.ws.read": { body: { chatId: string | null; area: WorkspaceArea; path: string; version?: string }; result: { file: WorkspaceFile; text: string; version: string } };
  /** Writes a file as the user: `base` is the hash of the version the text was based on, null for a new file. Refused with `conflict` when the file's current version is another (or, for a new file, when one is there). */
  "lah.ws.write": { body: { chatId: string | null; area: WorkspaceArea; path: string; text: string; base: string | null }; result: { file: WorkspaceFile } };
  /** Moves a file within its area; refused with `conflict` like a write, and when `to` is taken. */
  "lah.ws.move": { body: { chatId: string | null; area: WorkspaceArea; from: string; to: string; base: string }; result: { file: WorkspaceFile } };
  "lah.ws.delete": { body: { chatId: string | null; area: WorkspaceArea; path: string; base: string }; result: { deleted: true } };
  /** Pins a file for an agent definition (it is put in that agent's context each turn) or unpins it. */
  "lah.ws.pin": { body: { chatId: string | null; area: WorkspaceArea; path: string; agent: string; on: boolean }; result: { file: WorkspaceFile } };
  /** A file's versions, newest first, a deletion among them. */
  "lah.ws.history": { body: { chatId: string | null; area: WorkspaceArea; path: string }; result: { versions: FileVersion[] } };
  /** The change set of the turn recorded on a reply: what its agents and the jobs it started wrote. */
  "lah.ws.changes": { body: { chatId: string; messageId: string; swipe: number }; result: { changes: ChangedFile[] } };
  /** The guidance an agent of the chat is given (§12); with no chat, the user's level alone. */
  "lah.guidance.get": { body: { chatId: string | null }; result: GuidanceView };
  /** Writes a level as the user, versioned like any workspace write (`base`; `conflict`). */
  "lah.guidance.set": { body: { chatId: string | null; level: GuidanceLevelId; text: string; base: string | null }; result: GuidanceView };

  /** Every definition (§13) and MCP server (§16). */
  "lah.defs.get": { body: Record<string, never>; result: DefsView };
  /** Makes an agent definition of the user's, or replaces theirs of that id. One with the id of a built-in or an extension's stands over it. Refused with `invalid` and `problems` (paths within the definition) where the settings refuse what it runs with. */
  "lah.agent.save": { body: { agent: AgentDefinition }; result: DefsView };
  "lah.skill.save": { body: { skill: Skill }; result: DefsView };
  /** Removes the user's own definition: one of theirs alone is deleted; one that stood over an original is reset to it. */
  "lah.def.remove": { body: { kind: "agent" | "skill"; id: string }; result: DefsView };
  /** Switches a definition off or back on: an agent, a skill, a tool (by name), or an MCP server's tools for agents. */
  "lah.def.switch": { body: { kind: "agent" | "skill" | "tool" | "mcp"; id: string; off: boolean }; result: DefsView };
  /** What a tool's calls do: go ahead, wait for the user, or (null) what its tier's do (§17). */
  "lah.tool.approval": { body: { name: string; approval: ApprovalChoice | null }; result: DefsView };
  /** What a tier's calls do unless a tool says otherwise. The same setting Settings holds. */
  "lah.tier.approval": { body: { tier: ToolTier; approval: ApprovalChoice }; result: DefsView };

  /** Jobs, newest first, of one chat or (null) of every chat of the user's (§15). */
  "lah.jobs.list": { body: { chatId: string | null; cursor: string | null; limit: number }; result: JobsPage };
  /** The user's switches over all jobs: off (none may start), paused (those running are held at their next round). */
  "lah.jobs.set": { body: { off?: boolean; paused?: boolean }; result: { off: boolean; paused: boolean } };
  /** Starts a job by hand (§15; a long objective, §22): the agent, its task in the user's words, whether it runs now or after the chat's next reply, and what this job alone may spend (left out: Settings' limits for each job). `story`: it is the learning of the chat's story, which `lah.story.get` names from then on. */
  "lah.job.start": { body: { chatId: string; agent: string; task: string; when: JobWhen; allowance?: JobAllowance; story?: true }; result: { job: JobView } };
  "lah.job.cancel": { body: { id: string }; result: { job: JobView } };
  /** Starts an interrupted, failed or cancelled job again, as a new job with the same agent and task. */
  "lah.job.again": { body: { id: string }; result: { job: JobView } };
  /** Has a job that stopped at a limit (`spent`) carry on from its own session (§22). One its own allowance stopped (`stoppedAt: "allowance"`) is granted more: each member of `allowance` given stands in place of what it had. One a day's limit stopped (`stoppedAt: "day"`) needs no more of its own, and is granted nothing (`{}`): where that limit still stands it stops there again, having made no call. */
  "lah.job.grant": { body: { id: string; allowance: JobAllowance }; result: { job: JobView } };
  /** Lets a job go on that is `paused` with no run under way (a runtime restart came while the user held it): it runs again from its own session (§22). A job that runs is held and let go through its run (`lah.turn.pause` on its stream). */
  "lah.job.resume": { body: { id: string }; result: { job: JobView } };
  /** Dismisses a notice, or (null) every one. */
  "lah.notice.dismiss": { body: { id: string | null }; result: { notices: Notice[] } };

  /** The user's side sessions, the latest first (§19). */
  "lah.side.list": { body: Record<string, never>; result: { sessions: SideSession[] } };
  /** Starts a side session with an agent, about a chat or (null) about none. */
  "lah.side.start": { body: { agent: string; chatId: string | null }; result: { session: SideSession } };
  /** A side session's turns, newest first. */
  "lah.side.turns": { body: { session: string; cursor: string | null; limit: number }; result: { turns: SideTurn[]; next: string | null } };
  /** Says something in a side session: starts its next turn (followed under the session's stream). Refused with `unavailable` while a turn of it runs. */
  "lah.side.send": { body: { session: string; text: string }; result: { session: SideSession; turn: string } };
  "lah.side.remove": { body: { session: string }; result: { removed: true } };

  /** Spend over the last `days` days, today among them (§20). */
  /** `timeZone`: the user's own (an IANA name, as `Intl.DateTimeFormat().resolvedOptions().timeZone` gives it), so a day is the user's day; left out, or a name the backend doesn't know, days are UTC's. */
  "lah.spend.get": { body: { days: number; timeZone?: string }; result: SpendView };
  /** What the store keeps. */
  "lah.upkeep.get": { body: Record<string, never>; result: UpkeepView };
  /** Runs the sweep: removes what Settings no longer keep and the blobs nothing refers to. Answers when it is done. */
  "lah.upkeep.sweep": { body: Record<string, never>; result: UpkeepView };

  // -------------------------------- home
  /** What the first screen shows of a chat (null: none is open): the chat with its switch, and its latest turn. */
  "lah.home.get": { body: { chatId: string | null }; result: HomeView };
  /** A linked runtime's working store, by the runtime's relay id (Runtime → System). */
  "lah.runtime.store": { body: { relay: string }; result: { state: StoreStateView } };
  /** A linked runtime's copy of chat and lore, by the runtime's relay id, with the database reader's switch as this user is shown it (Runtime → Chat data). */
  "lah.runtime.chatdata": { body: { relay: string }; result: { state: ChatDataView; database: DatabaseSwitchView } };
  /** The operator switches the direct database reader on or off for their own runtimes; refused (`forbidden`) to anyone else. */
  "lah.runtime.database": { body: { on: boolean }; result: { database: DatabaseSwitchView } };
  /** Runtime → Timings: this extension's end of the timing log and each linked runtime's, one ask each, never one a row. */
  "lah.timings.get": { body: Record<string, never>; result: TimingsPage };

  // -------------------------------- lore (§24)
  /** A chat's books and entries, each entry with its state for the last turn, and search by meaning as it stands. */
  "lah.lore.get": { body: { chatId: string }; result: LoreView };
  /** One entry whole: its row and its text. */
  "lah.lore.entry": { body: { chatId: string; entryId: string }; result: { entry: LoreRow; text: string } };
  /** Runs the agents' own `lore_search` over the chat's books: several queries at once, each answered with its hits (`limit` a query; left out: Settings'). */
  "lah.lore.search": { body: { chatId: string; queries: string[]; limit?: number }; result: LoreSearch };
  /** Search by meaning as it stands for a chat; `start` has what waits for a vector embedded now, in the background, under the daily cap. */
  "lah.lore.embed": { body: { chatId: string; start: boolean }; result: { embedding: EmbeddingStatus } };

  // -------------------------------- the chronicle (§24.7)
  /** A chat's chronicle with the check run over it: its files, and the lines that fail. */
  "lah.chronicle.get": { body: { chatId: string }; result: ChronicleView };
  /** The messages citations name (`[#412 a3f9c27e]`), each as it stands now, in the order asked: a line's citations are read at once. */
  "lah.chronicle.cited": { body: { chatId: string; citations: string[] }; result: { cited: CitedView[] } };

  // -------------------------------- learning a story (§22)
  /** The learning of a chat's story: its job, its plan, how far it has come, and what to start one with. */
  "lah.story.get": { body: { chatId: string }; result: StoryView };

  // -------------------------------- the runtime's connections (PI-BUILD-PLAN §4.3)
  /** The runtime's connections, which is the default, and the providers it offers. */
  "lah.connections.list": { body: ToRuntime; result: ConnectionsView };
  /**
   * Adds a connection or changes one, whole, with its key: `key` a new one (it goes to the runtime
   * and never comes back), null takes the one there is away, absent keeps it. `create` makes it under
   * `connection.id` (a copy of one of Lumiverse's connections, which keeps its id). The first
   * connection becomes the default. Refused with `invalid`, in words, where the runtime refuses what
   * it holds. Answers the connection saved and the connections as they then stand.
   */
  "lah.connections.save": { body: ToRuntime & { connection: ConnectionInput; key?: string | null; create?: true }; result: { saved: RuntimeConnection; view: ConnectionsView } };
  /** Takes a connection away, with its key; removing the default leaves none until another is chosen. */
  "lah.connections.remove": { body: ToRuntime & { id: string }; result: ConnectionsView };
  /** Makes a connection the default, or (null) none. */
  "lah.connections.default": { body: ToRuntime & { id: string | null }; result: ConnectionsView };
  /** One tiny call on a connection. */
  "lah.connections.test": { body: ToRuntime & { id: string }; result: { test: ConnectionTest } };
  /** The models a connection offers (null: the default), or a provider's own list before a connection of it is saved (none for a compatible server, whose list needs its address): for a picker. */
  "lah.connections.models": { body: ToRuntime & ({ connectionId: string | null } | { provider: string }); result: { models: ModelChoice[] } };
  /** Lumiverse's connection profiles, to copy from: never a key. The backend answers it itself, with no runtime. */
  "lah.connections.lumiverse": { body: Record<string, never>; result: { connections: LumiverseConnection[] } };
  /** Begins a sign-in: the address to open and what to know first. One flow at a time for a provider: beginning another ends the one open. */
  "lah.signin.start": { body: ToRuntime & { provider: SignInProvider }; result: SignInStart };
  /** Finishes a flow with what the user pasted back: the code the provider showed, or the address the browser was sent to. Refused with `invalid`, in the provider's words, where it fails. Answers the sign-in and the connections as they then stand. */
  "lah.signin.finish": { body: ToRuntime & { flow: string; code: string }; result: { state: SignInState; view: ConnectionsView } };
  "lah.signin.cancel": { body: ToRuntime & { flow: string }; result: { cancelled: true } };
  /** Signs the runtime out of a provider: its tokens are forgotten. */
  "lah.signin.out": { body: ToRuntime & { provider: SignInProvider }; result: { state: SignInState; view: ConnectionsView } };
  /** How the runtime stands with a provider's sign-in: a page asks while a flow is open, since OpenAI's can finish by itself. */
  "lah.signin.state": { body: ToRuntime & { provider: SignInProvider }; result: SignInState };
}

/** What one job may spend (DESIGN §22), as core has it: each member given stands in place of Settings' limit for each job (null: no limit). */
export type JobAllowance = NonNullable<JobView["allowance"]>;

const isLimit = (v: unknown): boolean => v === undefined || v === null || (typeof v === "number" && Number.isSafeInteger(v) && v >= 0);
const isAllowance = (v: unknown): boolean => isRecord(v) && isLimit(v.tokensIn) && isLimit(v.tokensOut) && isLimit(v.toolTurns) && isLimit(v.wallMs);

export type UiRequestType = keyof UiRequests;

/** A request as it crosses: its envelope, its id and its body. */
export type UiRequest = { [K in UiRequestType]: { lah: typeof UI_VERSION; type: K; reqId: string } & UiRequests[K]["body"] }[UiRequestType];

export type UiRequestOf<K extends UiRequestType> = Extract<UiRequest, { type: K }>;

export type UiResultMessage = { [K in UiRequestType]: { lah: typeof UI_VERSION; type: "lah.result"; reqId: string; request: K; body: UiRequests[K]["result"] } }[UiRequestType];

/** Why a request failed: malformed, not found, not allowed, not possible now (no runtime linked), a value the settings refuse, a write based on a version that is no longer the file's, or a failure of the backend's own. */
export type UiErrorCode = "bad_request" | "not_found" | "forbidden" | "unavailable" | "invalid" | "conflict" | "internal";

/** A value the settings (or a text) refused: where it is, and why. */
export interface UiProblem {
  path: (string | number)[];
  message: string;
}

export interface UiErrorMessage {
  lah: typeof UI_VERSION;
  type: "lah.error";
  reqId: string;
  code: UiErrorCode;
  /** In plain words, saying what to do. */
  message: string;
  problems?: UiProblem[];
}

/** The parts of the state that changed, each whole: to every page of the user. */
export interface UiStatePush {
  lah: typeof UI_VERSION;
  type: "lah.state";
  rev: number;
  patch: Partial<Omit<UiState, "rev">>;
}

/** What a live view did since: to the pages that opened its stream. */
export interface UiLivePush {
  lah: typeof UI_VERSION;
  type: "lah.live";
  stream: StreamId;
  change: LiveChange;
}

/** What a model call in flight of a stream's turn sent since its last delta: to the pages that opened the stream. */
export interface UiDeltaPush {
  lah: typeof UI_VERSION;
  type: "lah.live.delta";
  stream: StreamId;
  delta: LiveDelta;
}

export type FrontendToBackend = UiRequest;
export type BackendToFrontend = UiResultMessage | UiErrorMessage | UiStatePush | UiLivePush | UiDeltaPush;

// ---------------------------------------------------------------- reading what crossed

type Fields = Record<string, unknown>;

/** An id the backend looks up. Ids are the host's and LumiAH's own (uuids, hashes, short names), so a longer string is no id and is refused before any lookup: not a setting, since no id grows with use. */
const isId = (v: unknown): v is string => typeof v === "string" && v.length > 0 && v.length <= 256;
const isIdOrNull = (v: unknown): v is string | null => v === null || isId(v);
const isCount = (v: unknown): v is number => typeof v === "number" && Number.isSafeInteger(v) && v >= 0;
const isSeq = (v: unknown): v is number => typeof v === "number" && Number.isSafeInteger(v) && v >= 1;
const isPath = (v: unknown): v is SettingPath => Array.isArray(v) && v.every((key) => typeof key === "string");
const isBool = (v: unknown): v is boolean => typeof v === "boolean";
const isText = (v: unknown): v is string => typeof v === "string";
const AREAS: Readonly<Record<string, true>> = { chat: true, learned: true, user: true };
const isArea = (v: unknown): v is WorkspaceArea => typeof v === "string" && Object.hasOwn(AREAS, v);
/** A workspace path as a request may name it: some text. Whether it is a sound path within its area is the workspace's to say (§11), in words the user can act on; its length is bounded by the same reasoning as an id's. */
const isFilePath = (v: unknown): v is string => typeof v === "string" && v.length > 0 && v.length <= 1024;
/** Whose area a request names: the chat's and `learned/` need a chat; the user's own may go without. */
const inArea = (r: Fields): boolean => isArea(r.area) && (r.area === "user" ? isIdOrNull(r.chatId) : isId(r.chatId));
const isPage = (r: Fields): boolean => isIdOrNull(r.cursor) && isCount(r.limit) && r.limit > 0;
const isChoice = (v: unknown): v is ApprovalChoice => v === "allow" || v === "ask";
const AUTHS: Readonly<Record<string, true>> = { key: true, signin: true, none: true };
const EFFORTS: Readonly<Record<string, true>> = { off: true, minimal: true, low: true, medium: true, high: true, xhigh: true, max: true };
const isSignInProvider = (v: unknown): v is SignInProvider => v === "anthropic" || v === "openai";
/** Text a connection holds (its name, address, model, a header's value): bounded like a file's path, since none grows with use. Whether it is one the runtime takes is the runtime's to say, in words. */
const isShort = (v: unknown): v is string => typeof v === "string" && v.length <= 1024;
const isShortOrGone = (v: unknown): boolean => v === undefined || v === null || isShort(v);
/** What a user pastes for a provider (a key, a sign-in's code or the address it sent the browser to): bounded well past any of them. */
const isPasted = (v: unknown): v is string => typeof v === "string" && v.length > 0 && v.length <= 8192;
/** The runtime a request about connections names, where it names one. */
const toRuntime = (r: Fields): boolean => r.relay === undefined || isId(r.relay);

/** Each request's body fields, checked. */
const BODY: { [K in UiRequestType]: (r: Fields) => boolean } = {
  "lah.hello": (r) => r.active === undefined || isIdOrNull(r.active),
  "lah.chat.get": (r) => isId(r.chatId),
  "lah.chat.set": (r) => isId(r.chatId) && typeof r.on === "boolean",
  "lah.chat.takeover": (r) => isId(r.chatId),
  "lah.chat.story.get": (r) => isId(r.chatId),
  "lah.chat.story.set": (r) => isId(r.chatId) && isRecord(r.story) && Object.entries(r.story).every(([member, value]) => STORY_MEMBERS.includes(member as keyof StorySetting) && storyValue(member as keyof StorySetting, value)),
  "lah.chat.lead.get": (r) => isId(r.chatId),
  "lah.live.open": (r) => isId(r.stream),
  "lah.live.events": (r) => isId(r.stream) && isId(r.turn) && isSeq(r.from),
  "lah.live.close": (r) => isId(r.stream),
  "lah.turn.stop": (r) => isId(r.stream) && isId(r.turn),
  "lah.turn.say": (r) => isId(r.stream) && isId(r.turn) && isText(r.text) && r.text.trim() !== "",
  "lah.turn.pause": (r) => isId(r.stream) && isId(r.turn) && isBool(r.on),
  "lah.approval.answer": (r) => isId(r.id) && isRecord(r.answer) && (r.answer.decision === "once" || r.answer.decision === "chat" || (r.answer.decision === "refused" && (r.answer.reason === undefined || isText(r.answer.reason)))),
  "lah.approvals.kept": (r) => isIdOrNull(r.chatId),
  "lah.approval.forget": (r) => isId(r.chatId) && isId(r.tool),
  "lah.turns.list": (r) => isId(r.chatId) && isPage(r),
  "lah.transcript.get": (r) => isId(r.transcript) && isSeq(r.from),
  "lah.prompt.get": (r) => isId(r.prompt),
  "lah.blob.get": (r) => isId(r.hash),
  "lah.session.rollback": (r) => isId(r.chatId) && isId(r.messageId) && isCount(r.swipe),
  "lah.session.summarize": (r) => isId(r.chatId),
  "lah.settings.set": (r) => Array.isArray(r.set) && r.set.every((s) => isRecord(s) && isPath(s.path) && s.value !== undefined) && Array.isArray(r.reset) && r.reset.every(isPath),
  "lah.text.set": (r) => isId(r.id) && typeof r.text === "string",
  "lah.text.reset": (r) => isId(r.id),
  "lah.key": (r) => r.op === "mint" || r.op === "forget",
  "lah.relay": (r) => (r.op === "rotate" || r.op === "forget") && isId(r.relay),
  "lah.drawer.close": () => true,
  "lah.runtime.service.get": (r) => isId(r.relay),
  "lah.runtime.service.set": (r) => isId(r.relay) && (r.memory === undefined || (typeof r.memory === "string" && r.memory.length <= 32)) && (r.autoUpdate === undefined || typeof r.autoUpdate === "boolean") && (r.restart === undefined || typeof r.restart === "boolean"),
  "lah.runtime.update.apply": (r) => isId(r.relay),
  "lah.ws.list": (r) => inArea(r),
  "lah.ws.read": (r) => inArea(r) && isFilePath(r.path) && (r.version === undefined || isId(r.version)),
  "lah.ws.write": (r) => inArea(r) && isFilePath(r.path) && isText(r.text) && isIdOrNull(r.base),
  "lah.ws.move": (r) => inArea(r) && isFilePath(r.from) && isFilePath(r.to) && isId(r.base),
  "lah.ws.delete": (r) => inArea(r) && isFilePath(r.path) && isId(r.base),
  "lah.ws.pin": (r) => inArea(r) && isFilePath(r.path) && isId(r.agent) && isBool(r.on),
  "lah.ws.history": (r) => inArea(r) && isFilePath(r.path),
  "lah.ws.changes": (r) => isId(r.chatId) && isId(r.messageId) && isCount(r.swipe),
  "lah.guidance.get": (r) => isIdOrNull(r.chatId),
  "lah.guidance.set": (r) => isIdOrNull(r.chatId) && (r.level === "user" || ((r.level === "middle" || r.level === "chat") && isId(r.chatId))) && isText(r.text) && isIdOrNull(r.base),
  "lah.defs.get": () => true,
  "lah.agent.save": (r) => isRecord(r.agent) && isId(r.agent.id) && isText(r.agent.name) && isText(r.agent.description) && isText(r.agent.instructions),
  "lah.skill.save": (r) => isRecord(r.skill) && isId(r.skill.id) && isText(r.skill.name) && isText(r.skill.description) && isText(r.skill.body),
  "lah.def.remove": (r) => (r.kind === "agent" || r.kind === "skill") && isId(r.id),
  "lah.def.switch": (r) => (r.kind === "agent" || r.kind === "skill" || r.kind === "tool" || r.kind === "mcp") && isId(r.id) && isBool(r.off),
  "lah.tool.approval": (r) => isId(r.name) && (r.approval === null || isChoice(r.approval)),
  "lah.tier.approval": (r) => (r.tier === "read" || r.tier === "write" || r.tier === "external") && isChoice(r.approval),
  "lah.jobs.list": (r) => isIdOrNull(r.chatId) && isPage(r),
  "lah.jobs.set": (r) => (r.off === undefined || isBool(r.off)) && (r.paused === undefined || isBool(r.paused)) && (r.off !== undefined || r.paused !== undefined),
  "lah.job.start": (r) => isId(r.chatId) && isId(r.agent) && isText(r.task) && r.task.trim() !== "" && (r.when === "now" || r.when === "after_reply") && (r.allowance === undefined || isAllowance(r.allowance)) && (r.story === undefined || r.story === true),
  "lah.job.cancel": (r) => isId(r.id),
  "lah.job.again": (r) => isId(r.id),
  "lah.job.grant": (r) => isId(r.id) && isAllowance(r.allowance),
  "lah.job.resume": (r) => isId(r.id),
  "lah.notice.dismiss": (r) => isIdOrNull(r.id),
  "lah.side.list": () => true,
  "lah.side.start": (r) => isId(r.agent) && isIdOrNull(r.chatId),
  "lah.side.turns": (r) => isId(r.session) && isPage(r),
  "lah.side.send": (r) => isId(r.session) && isText(r.text) && r.text.trim() !== "",
  "lah.side.remove": (r) => isId(r.session),
  "lah.spend.get": (r) => isCount(r.days) && r.days > 0 && (r.timeZone === undefined || isText(r.timeZone)),
  "lah.upkeep.get": () => true,
  "lah.upkeep.sweep": () => true,
  "lah.home.get": (r) => isIdOrNull(r.chatId),
  "lah.runtime.store": (r) => isId(r.relay),
  "lah.runtime.chatdata": (r) => isId(r.relay),
  "lah.runtime.database": (r) => typeof r.on === "boolean",
  "lah.timings.get": () => true,
  "lah.lore.get": (r) => isId(r.chatId),
  "lah.lore.entry": (r) => isId(r.chatId) && isId(r.entryId),
  "lah.lore.search": (r) => isId(r.chatId) && Array.isArray(r.queries) && r.queries.length > 0 && r.queries.every((q) => isText(q) && q.trim() !== "") && (r.limit === undefined || (isCount(r.limit) && r.limit > 0)),
  "lah.lore.embed": (r) => isId(r.chatId) && isBool(r.start),
  "lah.chronicle.get": (r) => isId(r.chatId),
  "lah.chronicle.cited": (r) => isId(r.chatId) && Array.isArray(r.citations) && r.citations.length > 0 && r.citations.every(isId),
  "lah.story.get": (r) => isId(r.chatId),
  "lah.connections.list": toRuntime,
  "lah.connections.save": (r) => {
    const c = r.connection;
    if (!isRecord(c) || !(c.id === undefined || isId(c.id)) || !isShort(c.name) || !isId(c.provider) || typeof c.auth !== "string" || !Object.hasOwn(AUTHS, c.auth)) return false;
    if (!isShortOrGone(c.baseUrl) || !isShortOrGone(c.api) || !isShortOrGone(c.model) || !(c.effort === undefined || c.effort === null || (typeof c.effort === "string" && Object.hasOwn(EFFORTS, c.effort)))) return false;
    if (!(c.headers === undefined || c.headers === null || (isRecord(c.headers) && Object.entries(c.headers).every(([name, value]) => name.length > 0 && name.length <= 256 && (value === null || isPasted(value)))))) return false;
    return toRuntime(r) && (r.key === undefined || r.key === null || isPasted(r.key)) && (r.create === undefined || (r.create === true && isId(c.id)));
  },
  "lah.connections.remove": (r) => toRuntime(r) && isId(r.id),
  "lah.connections.default": (r) => toRuntime(r) && isIdOrNull(r.id),
  "lah.connections.test": (r) => toRuntime(r) && isId(r.id),
  "lah.connections.models": (r) => toRuntime(r) && (r.provider === undefined ? isIdOrNull(r.connectionId) : isId(r.provider) && r.connectionId === undefined),
  "lah.connections.lumiverse": () => true,
  "lah.signin.start": (r) => toRuntime(r) && isSignInProvider(r.provider),
  "lah.signin.finish": (r) => toRuntime(r) && isId(r.flow) && isPasted(r.code),
  "lah.signin.cancel": (r) => toRuntime(r) && isId(r.flow),
  "lah.signin.out": (r) => toRuntime(r) && isSignInProvider(r.provider),
  "lah.signin.state": (r) => toRuntime(r) && isSignInProvider(r.provider),
};

/**
 * A page's message as the backend reads it: a request of this contract with its fields checked; a
 * `reqId` to answer `bad_request` to when it is one of ours but malformed; null when it isn't ours
 * (another extension's message on the same channel, or not an envelope at all).
 */
export function uiRequestOf(raw: unknown): { request: UiRequest } | { malformed: string; reqId: string | null } | null {
  if (!isRecord(raw) || raw.lah === undefined || typeof raw.type !== "string" || !raw.type.startsWith("lah.")) return null;
  const reqId = typeof raw.reqId === "string" && raw.reqId !== "" ? raw.reqId : null;
  if (raw.lah !== UI_VERSION) return { malformed: `This page speaks version ${String(raw.lah)} of LumiAH's messages and the extension speaks ${UI_VERSION}: reload the page.`, reqId };
  if (reqId === null) return { malformed: "The request has no reqId.", reqId };
  if (!Object.hasOwn(BODY, raw.type)) return { malformed: `There is no request ${raw.type}.`, reqId };
  const check = BODY[raw.type as UiRequestType];
  if (!check(raw)) return { malformed: `The request ${raw.type} is malformed.`, reqId };
  return { request: raw as UiRequest };
}

const BACKEND_TYPES: Readonly<Record<string, true>> = { "lah.result": true, "lah.error": true, "lah.state": true, "lah.live": true, "lah.live.delta": true };

/** A backend message as a page reads it; null when it isn't one of ours. The backend is the page's own extension, so past the envelope its fields are taken as sent. */
export function uiMessageOf(raw: unknown): BackendToFrontend | null {
  if (!isRecord(raw) || raw.lah !== UI_VERSION || typeof raw.type !== "string" || !Object.hasOwn(BACKEND_TYPES, raw.type)) return null;
  return raw as unknown as BackendToFrontend;
}
