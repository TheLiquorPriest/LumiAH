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
// - A read whose answer may be long (a live view on open, a stored transcript) answers a page of
//   events and the `seq` to read from next (`next`, null once there are no more).
// - The frontend only renders what these messages carry and sends these requests: it reads nothing
//   else of Lumiverse, and never calls the network itself.

import { isRecord, type AgentUsage, type JsonObject, type JsonValue, type ModelRequest, type TraceRecord, type TurnKind, type TurnStatus } from "../core/ports";

// The trace is core's: the live view renders the events core's agents trace, as core shapes them.
export type { AgentStarted, AgentStatus, AgentStopCode, AgentUsage, CallUsage, JsonObject, JsonValue, ModelEffort, ModelMessage, ModelPart, ModelRequest, ModelTool, OfferedTools, SamplingParams, SessionTrace, ToolCallView, TraceEvent, TraceRecord, TranscriptEntry, TurnKind, TurnStatus, UsageField } from "../core/ports";
export { isRecord } from "../core/ports";

/** The level of this contract. A page and a backend of the same build always agree; the number is for a page left open across an update. */
export const UI_VERSION = 1;

// ---------------------------------------------------------------- the live view

/** How a turn ended: as core says (its reply written, failed, or stopped by the user), or lost with its runtime before core could say. */
export type LiveEndState = TurnStatus | "lost";

/** How and when a turn ended, with why in words where it didn't finish. */
export interface LiveEnded {
  state: LiveEndState;
  at: number;
  reason?: string;
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
 * A chat's turn as the live view shows it: the turn's id, what kind of generation it answers and the
 * message it targets (null for a new reply not yet saved), when it started, how it ended (null while
 * it runs), its events in order, and what its calls in flight have sent so far (none for a stored
 * transcript). A view read in pages (`next`) holds the events read so far.
 */
export interface LiveView {
  chatId: string;
  turn: string;
  kind: TurnKind;
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
 * `missing` (it isn't, and the runtime couldn't add it: with the scheduler on, a turn would wait on
 * its own calls); `unavailable` (this Lumiverse has no scheduler); `unknown` (not asked yet).
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
  /** What keeps LumiAH from answering that no runtime's own row says (a permission it wasn't granted, storage it can't write), each in plain words that say what to do; none when nothing does. */
  issues: string[];
}

/** First-time setup's steps, in order: a runtime linked, a loopback key minted, a loopback connection made, a chat switched on, a reply answered. */
export type SetupStepId = "runtime" | "key" | "connection" | "chat" | "reply";

export interface SetupView {
  steps: { id: SetupStepId; done: boolean }[];
}

/** The user's loopback key: whether one is set, its fingerprint and when it was made; never the key. */
export interface KeyView {
  set: boolean;
  print: string | null;
  at: number | null;
}

// ---------------------------------------------------------------- chats and connections

/** A chat, and whether LumiAH answers it. LumiAH answers a chat exactly when the connection it generates on is a loopback connection (`chatAnswered`). */
export interface ChatView {
  chatId: string;
  name: string | null;
  /** LumiAH is switched on for it: `lah.chat.set` pinned it to the loopback connection. */
  on: boolean;
  /** Since when it is on (epoch ms); null while off. */
  since: number | null;
  /** The connection the chat generates on now (its own pin, else the user's active connection), and whether that is a loopback; null when Lumiverse names none. */
  connection: { id: string; name: string; loopback: boolean } | null;
}

/** Whether a reply in the chat reaches LumiAH now. */
export function chatAnswered(chat: ChatView): boolean {
  return chat.connection?.loopback === true;
}

/** A turn LumiAH is answering now. */
export interface RunningTurn {
  chatId: string;
  turn: string;
  kind: TurnKind;
  startedAt: number;
}

/** One of the user's connections: its provider and model, and whether it is the loopback (which no agent may use: its calls would come back to the runtime). */
export interface ConnectionView {
  id: string;
  name: string;
  provider: string;
  model: string | null;
  loopback: boolean;
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
// - A string's `maxLength`, and `format`: "connection" (the id of one of the user's connections),
//   "model" (a model's name: the page suggests the models of the connection the same object names
//   in its `format: "connection"` property, read with `lah.models.list`), "multiline" (text of
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
  /** The turns LumiAH is answering now. */
  running: RunningTurn[];
  connections: ConnectionView[];
  settings: SettingsView;
  texts: TextsView;
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
}

export interface TurnsPage {
  turns: TurnRow[];
  /** The cursor that reads the page after this one; null on the last. */
  next: string | null;
  total: number;
  session: SessionView;
}

// ---------------------------------------------------------------- requests

/** Each request's body and its result. */
export interface UiRequests {
  /** The page starts (or lost the state's thread): the whole state. */
  "lah.hello": { body: Record<string, never>; result: UiState };
  /** A chat as the pages show it, whether LumiAH answers it or not. */
  "lah.chat.get": { body: { chatId: string }; result: { chat: ChatView } };
  /** Switches LumiAH on for a chat (pinning it to the loopback connection) or off (restoring the connection it had). */
  "lah.chat.set": { body: { chatId: string; on: boolean }; result: { chat: ChatView } };
  /** Opens a chat's live view: its latest turn, or null when it has had none since the extension started; from then on the page hears `lah.live` for it. */
  "lah.live.open": { body: { chatId: string }; result: { live: LiveView | null; next: number | null } };
  /** A turn's events from `from` on, while it is the chat's live turn. */
  "lah.live.events": { body: { chatId: string; turn: string; from: number }; result: { events: LiveEvent[]; next: number | null } };
  "lah.live.close": { body: { chatId: string }; result: { closed: true } };
  /** Stops a running turn; false when it had already ended. */
  "lah.turn.stop": { body: { chatId: string; turn: string }; result: { stopped: boolean } };
  /** A chat's turns, newest first, from `cursor` (null: the first page), with its session as it stands. */
  "lah.turns.list": { body: { chatId: string; cursor: string | null; limit: number }; result: TurnsPage };
  /** A stored transcript (`TurnRow.transcript`), its events from `from` on. */
  "lah.transcript.get": { body: { chatId: string; transcript: string; from: number }; result: { view: LiveView; next: number | null } };
  /** The exact request of a model call (`TranscriptEntry.prompt`). */
  "lah.prompt.get": { body: { prompt: string }; result: { prompt: CallPrompt } };
  /** A stored text by its hash: a compaction's summary (`TurnRow.compaction.summary`). */
  "lah.blob.get": { body: { hash: string }; result: { text: string } };
  /** Asks for the rollback of the compaction made at a turn (`RollbackState`): the session reads the turns it replaced again. */
  "lah.session.rollback": { body: { chatId: string; messageId: string; swipe: number }; result: { turn: TurnRow; session: SessionView } };
  /**
   * Changes settings: each `set` puts a value at a path, whole; each `reset` takes the user's own
   * value at a path away, so its default stands (an empty path: every setting). All of them are
   * kept or, when the settings refuse one (`invalid`, with `problems`), none.
   */
  "lah.settings.set": { body: { set: { path: SettingPath; value: JsonValue }[]; reset: SettingPath[] }; result: { settings: SettingsView } };
  /** The models a connection offers, as its provider lists them (null: the user's default connection); `unavailable` where Lumiverse can't ask. */
  "lah.models.list": { body: { connectionId: string | null }; result: { models: string[] } };
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
}

export type UiRequestType = keyof UiRequests;

/** A request as it crosses: its envelope, its id and its body. */
export type UiRequest = { [K in UiRequestType]: { lah: typeof UI_VERSION; type: K; reqId: string } & UiRequests[K]["body"] }[UiRequestType];

export type UiRequestOf<K extends UiRequestType> = Extract<UiRequest, { type: K }>;

export type UiResultMessage = { [K in UiRequestType]: { lah: typeof UI_VERSION; type: "lah.result"; reqId: string; request: K; body: UiRequests[K]["result"] } }[UiRequestType];

/** Why a request failed: malformed, not found, not allowed, not possible now (no runtime linked), a value the settings refuse, or a failure of the backend's own. */
export type UiErrorCode = "bad_request" | "not_found" | "forbidden" | "unavailable" | "invalid" | "internal";

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

/** What a chat's live view did since: to the pages that opened it. */
export interface UiLivePush {
  lah: typeof UI_VERSION;
  type: "lah.live";
  chatId: string;
  change: LiveChange;
}

/** What a model call in flight of a chat's turn sent since its last delta: to the pages that opened the chat's live view. */
export interface UiDeltaPush {
  lah: typeof UI_VERSION;
  type: "lah.live.delta";
  chatId: string;
  delta: LiveDelta;
}

export type FrontendToBackend = UiRequest;
export type BackendToFrontend = UiResultMessage | UiErrorMessage | UiStatePush | UiLivePush | UiDeltaPush;

// ---------------------------------------------------------------- reading what crossed

type Fields = Record<string, unknown>;

/** An id the backend looks up. Ids are the host's and LumiAH's own (uuids, hashes, short names), so a longer string is no id and is refused before any lookup: not a setting, since no id grows with use. */
const isId = (v: unknown): v is string => typeof v === "string" && v.length > 0 && v.length <= 256;
const isCount = (v: unknown): v is number => typeof v === "number" && Number.isSafeInteger(v) && v >= 0;
const isSeq = (v: unknown): v is number => typeof v === "number" && Number.isSafeInteger(v) && v >= 1;
const isPath = (v: unknown): v is SettingPath => Array.isArray(v) && v.every((key) => typeof key === "string");

/** Each request's body fields, checked. */
const BODY: { [K in UiRequestType]: (r: Fields) => boolean } = {
  "lah.hello": () => true,
  "lah.chat.get": (r) => isId(r.chatId),
  "lah.chat.set": (r) => isId(r.chatId) && typeof r.on === "boolean",
  "lah.live.open": (r) => isId(r.chatId),
  "lah.live.events": (r) => isId(r.chatId) && isId(r.turn) && isSeq(r.from),
  "lah.live.close": (r) => isId(r.chatId),
  "lah.turn.stop": (r) => isId(r.chatId) && isId(r.turn),
  "lah.turns.list": (r) => isId(r.chatId) && (r.cursor === null || isId(r.cursor)) && isCount(r.limit) && r.limit > 0,
  "lah.transcript.get": (r) => isId(r.chatId) && isId(r.transcript) && isSeq(r.from),
  "lah.prompt.get": (r) => isId(r.prompt),
  "lah.blob.get": (r) => isId(r.hash),
  "lah.session.rollback": (r) => isId(r.chatId) && isId(r.messageId) && isCount(r.swipe),
  "lah.settings.set": (r) => Array.isArray(r.set) && r.set.every((s) => isRecord(s) && isPath(s.path) && s.value !== undefined) && Array.isArray(r.reset) && r.reset.every(isPath),
  "lah.models.list": (r) => r.connectionId === null || isId(r.connectionId),
  "lah.text.set": (r) => isId(r.id) && typeof r.text === "string",
  "lah.text.reset": (r) => isId(r.id),
  "lah.key": (r) => r.op === "mint" || r.op === "forget",
  "lah.relay": (r) => (r.op === "rotate" || r.op === "forget") && isId(r.relay),
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
