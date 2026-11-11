// What the page bar and the strip under it say, worked out from the state: which pages have
// something under way or something that waits for the user, and where each thing that waits is
// shown. The shell (shell.tsx, attention.tsx) only renders what these give.

import { isReply, type ApprovalView, type Notice, type UiState } from "../../shared/ui";
import { GROUPS, type GroupId, type Nav, type PageId } from "./app";
import type { IconName } from "./icons";
import { plainWords } from "./prose-model";
import { neededPermissions, runtimeTrouble } from "./setup-model";

/** Each group's icon on the bar, and each page's on the bar and on Home's list of ways in. */
export const GROUP_ICON: Readonly<Record<GroupId, IconName>> = { home: "home", now: "pulse", story: "book", agents: "agent", system: "sliders" };

export const PAGE_ICON: Readonly<Record<PageId, IconName>> = { home: "home", live: "pulse", sessions: "layers", jobs: "clock", talk: "message", lore: "book", chronicle: "scroll", workspace: "folder", guidance: "edit", agents: "agent", skills: "sparkle", tools: "wrench", settings: "sliders", spend: "coins", upkeep: "database", runtime: "link" };

/** A page's mark on the bar: something of it is under way, or something of it waits for the user (which is said over the other). */
export type Mark = "busy" | "needs";

/** The pages that carry a mark. */
export function pageMarks(state: UiState | null): Partial<Record<PageId, Mark>> {
  if (state === null) return {};
  const marks: Partial<Record<PageId, Mark>> = {};
  const streams = new Map(state.running.map((r) => [r.stream, r.kind]));
  for (const r of state.running) {
    const page: PageId = isReply(r.kind) ? "live" : r.kind === "job" ? "jobs" : "talk";
    marks[page] = "busy";
  }
  if (state.jobs.active.some((j) => j.state === "running" || j.state === "queued")) marks.jobs = "busy";
  for (const a of state.approvals) marks[pageOfStream(streams.get(a.stream))] = "needs";
  if (state.notices.some((n) => NOTICE_NEEDS[n.kind])) marks.jobs = "needs";
  // Home is where a missing permission is granted and where what keeps LumiAH from working is said.
  if (neededPermissions(state).length > 0 || state.runtime.issues.length > 0) marks.home = "needs";
  // A runtime is an option (§25): it marks its page only for someone who uses one and whose runtime isn't ready.
  if (runtimeTrouble(state) !== null) marks.runtime = "needs";
  return marks;
}

function pageOfStream(kind: UiState["running"][number]["kind"] | undefined): PageId {
  return kind === undefined || isReply(kind) ? "live" : kind === "job" ? "jobs" : "talk";
}

/** A group's mark: the strongest of its pages' (of those the shell shows, where it shows only some). */
export function groupMark(group: GroupId, marks: Partial<Record<PageId, Mark>>, groups: readonly { id: GroupId; pages: readonly { id: PageId }[] }[] = GROUPS): Mark | null {
  const pages = groups.find((g) => g.id === group)?.pages ?? [];
  if (pages.some((p) => marks[p.id] === "needs")) return "needs";
  return pages.some((p) => marks[p.id] === "busy") ? "busy" : null;
}

/** Where a thing that waits is shown: the page, and what that page must have open. */
export type Target = Partial<Pick<Nav, "chatId" | "job" | "side" | "lore" | "chronicle" | "message" | "setting">> & { page: PageId };

/** Whether the strip under the bar shows over a page: everywhere but Home, which says what waits for the user itself, each thing with its one action. */
export function stripOver(page: PageId): boolean {
  return page !== "home";
}

/** Where a held call is answered: the live view of the run that holds it. */
export function approvalTarget(approval: ApprovalView, state: UiState): Target {
  const kind = state.running.find((r) => r.stream === approval.stream)?.kind;
  if (kind === "job") return { page: "jobs", job: approval.stream };
  if (kind === "side") return { page: "talk", side: approval.stream };
  return { page: "live", chatId: approval.stream };
}

/** Whether the pages already show a target: the user is looking at it, so nothing need point there. */
export function shows(nav: Nav, activeChat: string | null, target: Target): boolean {
  if (nav.page !== target.page) return false;
  if (target.page === "live") return (nav.chatId ?? activeChat) === target.chatId;
  if (target.page === "jobs") return nav.job === target.job;
  if (target.page === "talk") return nav.side === target.side;
  return true;
}

/** Whether a notice is something the user must act on (a job that failed, was cut off, or waits for them) rather than news (a job that finished): what needs them is said on every page, news on Home and by the Jobs tab's mark. */
export const NOTICE_NEEDS: Readonly<Record<Notice["kind"], boolean>> = { job_done: false, job_failed: true, job_interrupted: true, job_needs_user: true };

/** What the strip under the bar says: the held calls the user isn't looking at, each with the way to it, and the notices that need them, newest first. A job that only finished is no reason to take room from every page, and a job's own page already says what its notice would. */
export interface Attention {
  held: { approval: ApprovalView; target: Target }[];
  notices: Notice[];
}

export function attentionOf(state: UiState | null, nav: Nav, activeChat: string | null): Attention {
  if (state === null) return { held: [], notices: [] };
  const held = state.approvals.map((approval) => ({ approval, target: approvalTarget(approval, state) })).filter((h) => !shows(nav, activeChat, h.target));
  return { held, notices: state.notices.filter((n) => NOTICE_NEEDS[n.kind] && !shows(nav, activeChat, { page: "jobs", job: n.jobId })).sort((a, b) => b.at - a.at) };
}

/** A notice as the strip and Home say it: its words with no marks of markdown in them (a job's result is written by a model), and the chat it is about where that isn't the one open, since the words alone don't say whose job it was. */
export function noticeWords(notice: Notice, state: Pick<UiState, "chats">, activeChat: string | null): string {
  const words = plainWords(notice.text);
  if (notice.chatId === "" || notice.chatId === activeChat) return words;
  const name = state.chats.find((c) => c.chatId === notice.chatId)?.name;
  return `${words} (${name ?? "another chat"})`;
}

/** What the pages call ending LumiAH's work on a built-in reply: Lumiverse then writes the reply without it. One name, on Live, on Home and in Lumiverse's input bar. */
export const SKIP_REPLY = "Skip LumiAH for this reply";

/** What that does, in the one line said beside it: it is no Stop, and the reply's own Stop is Lumiverse's. */
export const SKIP_ABOUT = "It ends the agents' work, and Lumiverse writes the reply without them. To stop the reply itself, use Lumiverse's own Stop.";

/** The mark the tab's badge shows while LumiAH prepares a reply for the open chat. A sign, so no setting. */
const WORKING_MARK = "…";

/**
 * The drawer tab's badge, which shows with the drawer shut or on another tab: how many things wait
 * for the user while any does (held tool calls, jobs that failed or need them; a job that only
 * finished is news, told on Home); else a working mark while LumiAH prepares a reply for the open
 * chat, since a reply that takes longer says nothing of why with the drawer shut; else how many
 * other runs are under way; null for none.
 */
export function badgeOf(state: UiState | null, activeChat: string | null): string | null {
  if (state === null) return null;
  const waiting = state.approvals.length + state.notices.filter((n) => NOTICE_NEEDS[n.kind]).length;
  if (waiting > 0) return `${waiting}!`;
  if (activeChat !== null && state.running.some((r) => r.chatId === activeChat && isReply(r.kind))) return WORKING_MARK;
  return state.running.length > 0 ? String(state.running.length) : null;
}

/**
 * The reply LumiAH is preparing built in for the open chat, which the user may skip from outside
 * the drawer; null where there is none: no reply under way there, or one that runs in a runtime
 * (ending that one is a real stop, done from Live, where what it stops is in view).
 */
export function skippable(state: UiState | null, activeChat: string | null): { stream: string; turn: string } | null {
  if (state === null || activeChat === null) return null;
  const run = state.running.find((r) => r.chatId === activeChat && isReply(r.kind));
  if (!run) return null;
  const chat = state.chats.find((c) => c.chatId === activeChat);
  // The run says where it runs where the backend tells; else the chat does, and a chat whose runtime isn't answering runs built in meanwhile.
  const builtin = run.place !== undefined ? run.place === "builtin" : chat !== undefined && (chat.place === "builtin" || chat.away === true);
  return builtin ? { stream: run.stream, turn: run.turn } : null;
}

/** The groups a shell shows: all of them, or (for an extension that mounts only some pages) those that hold a page it names, each with only those pages, in the usual order. */
export function shownGroups(only?: readonly PageId[]): typeof GROUPS {
  if (only === undefined) return GROUPS;
  return GROUPS.map((g) => ({ ...g, pages: g.pages.filter((p) => only.includes(p.id)) })).filter((g) => g.pages.length > 0);
}

/** The page a shell shows when `asked` is wanted: that page where the shell has it, else its first (something led to a page this shell was not given). */
export function shownPage(groups: typeof GROUPS, asked: PageId): PageId {
  return groups.some((g) => g.pages.some((p) => p.id === asked)) ? asked : (groups[0]?.pages[0]?.id ?? asked);
}
