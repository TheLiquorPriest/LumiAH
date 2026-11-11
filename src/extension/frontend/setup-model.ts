// First-time setup and where a chat runs (DESIGN §25), worked out from the state every page holds.
// Home and the Runtime page render what these give. Built in is the default and needs nothing
// installed, so setup is three steps (LumiAH's permissions, a chat switched on, a reply). A runtime
// is an option with steps of its own, which show only to someone who asks for one.

import type { ChatView, PermissionNeed, RunPlace, RuntimeView, SetupStepId, UiState } from "../../shared/ui";
import { count, counted } from "./format";

export const PLACE_LABEL: Readonly<Record<RunPlace, string>> = { builtin: "Built in", runtime: "Runtime" };

/** What each place is, in one line, said wherever the choice is made. */
export const PLACE_ABOUT: Readonly<Record<RunPlace, string>> = {
  builtin: "LumiAH works inside Lumiverse before each reply. Nothing to install.",
  runtime: "A program you start beside Lumiverse, for turns that need longer than Lumiverse allows before a reply.",
};

/** Where a step stands: done, the one to do now, or one that comes after it. */
export type StepAt = "done" | "now" | "todo";

/** A step of first-time setup as Home shows it. Lumiverse's permissions are no step of their own: switching a chat on asks for them, so a newcomer has one thing to do and then a message to send. */
export interface SetupStep {
  id: "chat" | "reply";
  at: StepAt;
  title: string;
}

/** First-time setup's steps as the backend says they stand: switch LumiAH on for a chat, then send a message. */
export function setupSteps(state: Pick<UiState, "setup"> & { runtime?: Pick<RuntimeView, "only"> }): SetupStep[] {
  const done = (id: SetupStepId): boolean => state.setup.steps.find((s) => s.id === id)?.done ?? true;
  const chat = done("chat");
  // An extension that plays its chats only in a runtime switches a chat on in its own pages.
  const only = state.runtime?.only;
  return [
    { id: "chat", at: chat ? "done" : "now", title: only !== undefined ? `Switch this chat on in ${only}'s own pages` : "Switch LumiAH on for this chat" },
    { id: "reply", at: done("reply") ? "done" : chat ? "now" : "todo", title: "Send a message in the chat" },
  ];
}

/** Whether first-time setup is behind the user: Home then shows the chat's switch alone, without the steps. A permission taken away later doesn't bring the steps back: it is said among what needs the user. */
export function setupDone(state: Pick<UiState, "setup">): boolean {
  return setupSteps(state).every((s) => s.at === "done");
}

/** The permissions LumiAH lacks and can't answer without. */
export function neededPermissions(state: Pick<UiState, "permissions">): PermissionNeed[] {
  return state.permissions.filter((p) => p.needed);
}

/** The permissions LumiAH lacks that only a part of it rests on. */
export function optionalPermissions(state: Pick<UiState, "permissions">): PermissionNeed[] {
  return state.permissions.filter((p) => !p.needed);
}

/** Why the page asks Lumiverse for permissions, shown in Lumiverse's own confirmation: how many of those asked for LumiAH can't work without, and that the rest each add a part. It says "can't work without these" only of a list that holds nothing optional: the list a newcomer is asked for has both. */
export function grantReason(permissions: readonly PermissionNeed[]): string {
  const needed = permissions.filter((p) => p.needed).length;
  const others = permissions.length - needed;
  const rest = needed === 0 ? "LumiAH works without these; each adds a part of it." : others === 0 ? "It can't work on a reply without these." : `It can't work on a reply without ${needed === 1 ? "one" : count(needed)} of these; the other ${others === 1 ? "one adds" : `${count(others)} each add`} a part of it.`;
  return `LumiAH reads the chat and its lore and adds to the prompt before a reply. ${rest}`;
}

/**
 * What switching LumiAH on first asks Lumiverse for, said under the switch before it is pressed:
 * each permission it can't work without by what it is for, in the backend's own words, and how many
 * more it asks for that each only add a part. Empty where it lacks none.
 */
export function asksWords(permissions: readonly PermissionNeed[]): string {
  const needed = permissions.filter((p) => p.needed);
  const others = permissions.length - needed.length;
  if (permissions.length === 0) return "";
  const lead = "Switching it on first asks Lumiverse to allow LumiAH";
  const adds = others === 1 ? "one thing that adds a part of it" : `${count(others)} things that each add a part of it`;
  if (needed.length === 0) return `${lead} ${adds}.`;
  const more = others === 0 ? "" : ` It also asks for ${adds}; all ${count(permissions.length)} are listed below.`;
  return `${lead} the ${needed.length === 1 ? "one thing" : `${count(needed.length)} things`} it can't work on a reply without: to ${needed.map((p) => p.what).join("; to ")}.${more}`;
}

/**
 * How a chat stands, said under its switch: whether its replies reach LumiAH, one line that says so
 * (and what is wrong where something is), the one press that mends it where one can, and, for a
 * chat another extension holds, that extension's name: the chat can be taken over from it.
 */
export interface ChatStanding {
  answered: boolean;
  tone: "pos" | "neutral" | "warn";
  line: string;
  fix: { label: string; place: RunPlace } | null;
  takeover: string | null;
}

export function chatStanding(chat: ChatView, state: Pick<UiState, "permissions" | "runtime">): ChatStanding {
  const stands = (answered: boolean, tone: ChatStanding["tone"], line: string, fix: ChatStanding["fix"] = null): ChatStanding => ({ answered, tone, line, fix, takeover: null });
  // Another extension that has LumiAH built into itself holds the chat: this one offers no switch for it, and says whose it is. A page can't tell whether that extension is still installed (a mark on the chat outlives it), so it offers both ways on.
  if (chat.other !== undefined) return { ...stands(false, "neutral", `${chat.other.name} has this chat, with LumiAH built into it: switch it on or off on ${chat.other.name}'s own pages. If ${chat.other.name} is no longer installed, take the chat over here.`), takeover: chat.other.name };
  const connection = chat.connection?.name ?? "a connection LumiAH can't see";
  if (!chat.on) {
    // A chat on the runtime's connection reaches the runtime whether LumiAH pinned it or not.
    if (chat.connection?.loopback === true) return stands(true, "warn", `Switched off here, yet it generates on ${connection}, the runtime's connection, so the runtime still works on its replies. Choose another connection for the chat in Lumiverse to stop that.`);
    const only = state.runtime.only;
    if (only !== undefined) return stands(false, "neutral", `${only} plays this chat only in your runtime, and it is off. Switch it on in ${only}'s own pages.`);
    if (chat.needsRuntime !== undefined) return stands(false, "neutral", `${chat.needsRuntime.by} plays this chat only in your runtime, and it is off. Switched on, it is pinned to the runtime by itself.`);
    return stands(false, "neutral", "LumiAH is off for this chat.");
  }
  if (neededPermissions(state).length > 0) return stands(false, "warn", "Switched on, but LumiAH can't work on a reply until it is allowed what it needs.");
  if (chat.place === "builtin") return stands(true, "pos", "LumiAH prepares each reply in this chat, built in.");
  // A chat its extension plays only in a runtime has no built-in way: what is wrong is said, with no press that would run it built in.
  const only = chat.needsRuntime;
  // Its runtime isn't linked now: nothing stands in for it, so a reply may fail until it is back, or until the chat is set to run built in, which is one press.
  if (chat.away === true) return only !== undefined ? stands(false, "warn", `${only.by} plays this chat only in your runtime, which isn't answering, so it can't play until the runtime is back. Its line is on the Runtime page.`) : stands(false, "warn", "Set to run in your runtime, which isn't answering, so replies here may fail until it is back.", { label: "Run it built in", place: "builtin" });
  if (chat.connection?.loopback !== true) {
    const fix = only !== undefined || state.runtime.ready ? { label: "Pin it back", place: "runtime" as const } : { label: "Run it built in", place: "builtin" as const };
    return stands(false, "warn", `Set to run in the runtime, but it generates on ${connection}, which isn't the runtime's connection, so its replies don't reach LumiAH.`, fix);
  }
  if (!state.runtime.ready) return only !== undefined ? stands(false, "warn", `${only.by} plays this chat only in your runtime, and none is ready now, so it can't play until one is. See the Runtime page.`) : stands(false, "warn", "Set to run in the runtime, but none is linked now, so its replies fail until one is.", { label: "Run it built in", place: "builtin" });
  return stands(true, "pos", "LumiAH prepares each reply in this chat, in your runtime.");
}

/** A runtime's own steps, for someone who asked for one: start it, mint the key that proves a request is theirs, have the connection that points at it. */
export type RuntimeStepId = "start" | "key" | "connection";

export interface RuntimeStep {
  id: RuntimeStepId;
  at: StepAt;
  title: string;
}

const RUNTIME_STEP_TITLE: Readonly<Record<RuntimeStepId, string>> = {
  start: "Start the runtime beside Lumiverse",
  key: "Mint your loopback key",
  connection: "Have the loopback connection",
};

/** The runtime's steps as the state says they stand, in order, the first one not done marked as the one to do now. */
export function runtimeSteps(state: Pick<UiState, "runtime" | "key" | "connections">): RuntimeStep[] {
  const done: Readonly<Record<RuntimeStepId, boolean>> = {
    start: state.runtime.relays.some((r) => r.link === "linked"),
    key: state.key.set,
    connection: state.connections.some((c) => c.loopback),
  };
  const ids: readonly RuntimeStepId[] = ["start", "key", "connection"];
  const now = ids.find((id) => !done[id]) ?? null;
  return ids.map((id) => ({ id, at: done[id] ? "done" : id === now ? "now" : "todo", title: RUNTIME_STEP_TITLE[id] }));
}

/** Whether the user has begun with a runtime (one registered, a key minted, a loopback connection made, or a chat set to run in one): the Runtime page then shows its steps and parts without being asked. */
export function runtimeBegun(state: Pick<UiState, "runtime" | "key" | "connections" | "chats">): boolean {
  return state.runtime.relays.length > 0 || state.key.set || state.connections.some((c) => c.loopback) || state.chats.some((c) => c.on && c.place === "runtime");
}

/** What is wrong with the runtime that its user should hear of, in a line; null for someone who uses none, and while one is ready. */
export function runtimeTrouble(state: Pick<UiState, "runtime" | "key" | "connections" | "chats">): string | null {
  if (state.runtime.ready || !runtimeBegun(state)) return null;
  const waiting = state.chats.filter((c) => c.on && c.place === "runtime");
  // A chat its extension plays only in the runtime can't be set to run built in: the way out is said only where some chat can.
  if (waiting.length > 0) return `${counted(waiting.length, "chat is", "chats are")} set to run in the runtime, and none is ready: replies there may fail until one is${waiting.some((c) => c.needsRuntime === undefined) ? ", or until the chat is set to run built in" : ""}.`;
  if (state.runtime.relays.length > 0 && !state.runtime.relays.some((r) => r.link === "linked")) return "Your runtime isn't linked. No chat is set to run in it, so nothing is lost.";
  return null;
}
