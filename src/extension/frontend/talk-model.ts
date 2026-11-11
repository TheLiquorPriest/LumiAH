// What the Talk page shows of side sessions (DESIGN §19), worked out from what the backend gives:
// the list's order and each row's words, a conversation's turns in the order they were said, how a
// turn that gave no answer is put, and the chats a new conversation can be about. The page
// (pages/talk.tsx) only renders these.

import type { AgentView, ChatView, LiveEndState, SideSession, SideTurn } from "../../shared/ui";
import { counted } from "./format";

/** The sessions as the list shows them: the one last talked in first. */
export function sessionsInOrder(sessions: readonly SideSession[]): SideSession[] {
  return [...sessions].sort((a, b) => b.lastAt - a.lastAt || a.id.localeCompare(b.id));
}

/** A chat's name where it has one, else enough of its id to tell two apart. */
function chatName(chatId: string, chats: readonly Pick<ChatView, "chatId" | "name">[]): string {
  const name = chats.find((c) => c.chatId === chatId)?.name;
  return name !== undefined && name !== null && name !== "" ? name : `Chat ${chatId.slice(0, 8)}`;
}

/** What a conversation is about, in words. */
export function aboutWords(session: Pick<SideSession, "chatId">, chats: readonly Pick<ChatView, "chatId" | "name">[]): string {
  return session.chatId === null ? "about no chat" : `about ${chatName(session.chatId, chats)}`;
}

/** A session's line under its title: with whom, about what, and how much has been said. */
export function sessionSub(session: SideSession, chats: readonly Pick<ChatView, "chatId" | "name">[]): string {
  return `${session.agentName} · ${aboutWords(session, chats)} · ${session.turns === 0 ? "nothing said yet" : counted(session.turns, "turn")}`;
}

/** A conversation's turns as it reads: the backend gives the newest first, a reader wants the oldest first. */
export function turnsInOrder(newestFirst: readonly SideTurn[]): SideTurn[] {
  return [...newestFirst].reverse();
}

const NO_ANSWER: Readonly<Record<LiveEndState, string>> = {
  done: "It finished without saying anything.",
  failed: "It failed before it answered.",
  stopped: "It was stopped before it answered.",
  lost: "It was lost with its runtime before it answered.",
};

/** What stands where a turn's answer would be when it gave none; null while it works or where it answered. */
export function noAnswerWords(turn: Pick<SideTurn, "state" | "answer">): string | null {
  if (turn.state === "running" || turn.answer !== null) return null;
  return NO_ANSWER[turn.state];
}

/** The agents a conversation can be started with: those switched on, by name. */
export function talkAgents(agents: readonly Pick<AgentView, "id" | "name" | "description" | "off">[]): { id: string; name: string; description: string }[] {
  return agents
    .filter((a) => !a.off)
    .map((a) => ({ id: a.id, name: a.name !== "" ? a.name : a.id, description: a.description }))
    .sort((a, b) => a.name.localeCompare(b.name));
}

/** The chats a new conversation can be about: the one the pages show first, then the others LumiAH knows, each once. */
export function aboutChoices(shown: string | null, chats: readonly Pick<ChatView, "chatId" | "name">[]): { chatId: string; label: string }[] {
  const ids = [...new Set([...(shown !== null ? [shown] : []), ...chats.map((c) => c.chatId)])];
  return ids.map((chatId) => ({ chatId, label: chatName(chatId, chats) }));
}

/** Whether what is typed can be sent: something other than blank space. */
export function canSend(text: string): boolean {
  return text.trim() !== "";
}
