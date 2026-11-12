// First-time setup and how a chat stands (DESIGN §25), worked out from the state every page holds.
// Home and the Runtime page render what these give. Setup is three steps (LumiAH's permissions, a
// chat switched on, a reply); the runtime has steps of its own (start it, mint its key, have its
// connection), which the Runtime page shows until they are done: no chat is answered without it.

import type { ChatView, PermissionNeed, RuntimeView, SetupStepId, UiState } from "../../shared/ui";
import { count, counted } from "./format";

/** Where a step stands: done, the one to do now, or one that comes after it. */
export type StepAt = "done" | "now" | "todo";

/** A step of first-time setup as Home shows it. Lumiverse's permissions are no step of their own: switching a chat on asks for them, so a newcomer has one thing to do and then a message to send. */
export interface SetupStep {
  id: "chat" | "reply";
  at: StepAt;
  title: string;
}

/** First-time setup's steps as the backend says they stand: switch LumiAH on for a chat, then send a message. */
export function setupSteps(state: Pick<UiState, "setup"> & { runtime?: Pick<RuntimeView, "switchedBy"> }): SetupStep[] {
  const done = (id: SetupStepId): boolean => state.setup.steps.find((s) => s.id === id)?.done ?? true;
  const chat = done("chat");
  // An extension that switches its chats on in its own pages says where.
  const by = state.runtime?.switchedBy;
  return [
    { id: "chat", at: chat ? "done" : "now", title: by !== undefined ? `Switch this chat on in ${by}'s own pages` : "Switch LumiAH on for this chat" },
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
  fix: { label: string } | null;
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
    const by = state.runtime.switchedBy;
    return stands(false, "neutral", by !== undefined ? `LumiAH is off for this chat. Switch it on in ${by}'s own pages.` : "LumiAH is off for this chat.");
  }
  if (neededPermissions(state).length > 0) return stands(false, "warn", "Switched on, but LumiAH can't work on a reply until it is allowed what it needs.");
  // Its runtime isn't linked now: nothing stands in for it, so its replies fail until it is back.
  if (chat.away === true) return stands(false, "warn", "Switched on, but your runtime isn't answering, so its replies fail until it is back. Its line is on the Runtime page.");
  if (chat.connection?.loopback !== true) return stands(false, "warn", `Switched on, but it generates on ${connection}, which isn't the runtime's connection, so its replies don't reach LumiAH.`, { label: "Pin it back" });
  if (!state.runtime.ready) return stands(false, "warn", "Switched on, but no runtime is ready now, so its replies fail until one is. See the Runtime page.");
  return stands(true, "pos", "LumiAH prepares each reply in this chat, in your runtime.");
}

/** The runtime's own steps: start it, mint the key that proves a request is the user's, have the connection that points at it. */
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

/** What is wrong with the runtime that its user should hear of, in a line; null while one is ready. No chat is answered without one, so a user with none set up hears that too. */
export function runtimeTrouble(state: Pick<UiState, "runtime" | "chats">): string | null {
  if (state.runtime.ready) return null;
  const waiting = state.chats.filter((c) => c.on);
  if (waiting.length > 0) return `${counted(waiting.length, "chat is", "chats are")} switched on, and no runtime is ready: ${waiting.length === 1 ? "its" : "their"} replies fail until one is.`;
  if (state.runtime.relays.length > 0 && !state.runtime.relays.some((r) => r.link === "linked")) return "Your runtime isn't linked. No chat is switched on, so nothing is lost yet.";
  return "No chat is answered until your runtime is set up: its steps are on the Runtime page.";
}
