// Home, worked out from the state every page holds and two reads of the open chat (`lah.home.get`,
// `lah.story.get`): first-time setup while it isn't behind the user, the chat's switch and how it
// stands, what needs the user (each thing with its one action), what LumiAH did for the last reply
// in a sentence (the brief, the lore by name, how long and how much; where it failed, the cause and
// the step that mends it), the offer to learn a long story nobody has learned, and the ways into
// the other pages. The page (pages/home.tsx) only renders what `homeOf` gives.

import { type ChatView, type HomeView, isReply, type LastTurn, type Notice, type RunPlace, type StoryView, type UiState } from "../../shared/ui";
import { type PageEntry, type PageId, PAGES } from "./app";
import { estimateWords, storyCard } from "./chronicle-model";
import { ago, counted, duration } from "./format";
import type { IconName } from "./icons";
import { loreNamesWords, type Mend, mendOf, roleLabel, spentWords, tookWords } from "./live-model";
import { approvalTarget, type Mark, NOTICE_NEEDS, pageMarks, skippable, type Target } from "./nav-model";
import { SETTING_LINKS } from "./setting-links";
import { settingPlace, valueAt } from "./settings-model";
import { type ChatStanding, chatStanding, neededPermissions, optionalPermissions, PLACE_LABEL, runtimeTrouble, type SetupStep, setupDone, setupSteps } from "./setup-model";

/** What a need's one button does: asks Lumiverse to grant permissions, or goes to where the thing is dealt with. */
export type NeedAction = { do: "grant"; label: string; permissions: string[] } | { do: "go"; label: string; target: Target };

/**
 * Something that needs the user: what it is in a line or two, how grave (`neg`: LumiAH can't work
 * until it is dealt with), its one action (null: only the words can say what to do), what to do
 * where the action can't (a permission Lumiverse won't let a page ask for), and the notice it comes
 * from where dismissing that is the other thing the user may do.
 */
export interface Need {
  key: string;
  kind: "permission" | "issue" | "held" | "job" | "runtime" | "optional";
  icon: IconName;
  tone: "warn" | "neg";
  text: string;
  todo: string | null;
  action: NeedAction | null;
  notice: string | null;
}

/** How the chat's latest turn stands. */
export type LastState = "none" | "running" | "done" | "failed" | "stopped" | "lost" | "no_part";

/**
 * What LumiAH did for the chat's latest reply (ux B1, B2): a title (how it ended, how long it took
 * and what it cost, and when; or that it is working), the brief it gave the model that writes the
 * reply and the lore it added and left out by name, a sentence where there is more to say, the
 * counts and tokens for the fold, the way to it, and:
 * - while one runs built in, its time before the reply (`clock`: when it began and when that time
 *   ends; the page counts down with `replyClock`) and the reply to skip (`skip`);
 * - where it failed or LumiAH had no part in it, the cause as the title, what happened as the
 *   sentence, and the step that mends it (`mend`; null where the user skipped it themselves).
 */
export interface LastLine {
  state: LastState;
  icon: IconName;
  tone: "neutral" | "accent" | "pos" | "warn" | "neg";
  title: string;
  brief: string | null;
  lore: string;
  detail: string | null;
  counts: string | null;
  clock: { startedAt: number; replyBy: number } | null;
  skip: { stream: string; turn: string } | null;
  mend: Mend | null;
  action: { label: string; target: Target } | null;
}

/** A way into another page: its name, what it is for, and its mark where something of it is under way or waits. */
export interface Way {
  id: PageId;
  label: string;
  about: string;
  mark: Mark | null;
}

/** The offer to learn a long chat's story, where nobody has: what it says, and what learning it should take. */
export interface LearnOffer {
  title: string;
  text: string;
}

export interface HomeModel {
  /** First-time setup's steps, while one is still to do; null once it is behind the user. */
  setup: SetupStep[] | null;
  /** The chat open in Lumiverse with how it stands; null: none is open, or it isn't known yet. */
  chat: { view: ChatView; standing: ChatStanding } | null;
  needs: Need[];
  /** Jobs that finished, newest first: nothing to do about them but look, or dismiss. */
  news: Notice[];
  last: LastLine;
  /** Learn this story, offered for a long chat nobody has learned; null where there is nothing to offer. */
  learn: LearnOffer | null;
  /** The pages most people need, and those few do (folded away until asked for). */
  ways: { main: Way[]; more: Way[] };
}

export interface HomeInput {
  state: UiState;
  /** What `lah.home.get` answered for the open chat; null until it has. */
  home: HomeView | null;
  /** What `lah.story.get` answered for the open chat, with the chat it was read for; null until it has, and where it wasn't asked (LumiAH is off for the chat). */
  story?: { chatId: string; view: StoryView } | null;
  /** The chat open in Lumiverse. */
  active: string | null;
  now: number;
  /** The pages the shell shows, where it shows only some (an extension that mounts LumiAH's pages). */
  pages?: readonly PageId[] | null;
}

/** The open chat as best known: as the state lists it, else as the read (or the last switch) answered it. */
function openChat(state: UiState, home: HomeView | null, active: string | null): ChatView | null {
  if (active === null) return null;
  return state.chats.find((c) => c.chatId === active) ?? (home?.chat?.chatId === active ? home.chat : null);
}

/** What a turn did, in a few counted words; "" where it did nothing to count. */
export function didWords(last: Pick<LastTurn, "agents" | "tools" | "lore" | "changes" | "jobs">): string {
  const parts = [
    last.agents > 0 ? counted(last.agents, "agent") : null,
    last.tools > 0 ? counted(last.tools, "tool call") : null,
    last.lore.added > 0 ? `${counted(last.lore.added, "lore entry", "lore entries")} added` : null,
    last.lore.dropped > 0 ? `${counted(last.lore.dropped, "lore entry", "lore entries")} left out of this prompt` : null,
    last.changes > 0 ? `${counted(last.changes, "file")} changed` : null,
    last.jobs > 0 ? `${counted(last.jobs, "job")} started` : null,
  ];
  return parts.filter((p) => p !== null).join(", ");
}

const sentence = (words: string): string | null => (words === "" ? null : `${words.charAt(0).toUpperCase()}${words.slice(1)}.`);

/** The counts and the tokens of a turn, for the fold under what it did: "1 agent, 2 tool calls, built in. 3 calls · 12,345 in · 456 out · 4.2 s · $0.0018". */
function countsWords(last: LastTurn): string | null {
  const did = didWords(last);
  const counts = sentence(`${did === "" ? "" : `${did}, `}${PLACE_LABEL[last.place].toLowerCase()}`);
  return [counts, ...(last.usage !== null ? [spentWords(last.usage)] : [])].filter((p) => p !== null).join(" ") || null;
}

function lastLine(state: UiState, home: HomeView | null, chat: ChatView | null, standing: ChatStanding | null, now: number): LastLine {
  const live: Target = { page: "live", chatId: null };
  const plain = { brief: null, lore: "", counts: null, clock: null, skip: null, mend: null };
  const running = chat === null ? undefined : state.running.find((r) => isReply(r.kind) && r.chatId === chat.chatId);
  const last = home?.last ?? null;
  // What runs is the state's to say (it is pushed); the read says it only until the next one.
  const working = running ?? (last !== null && last.ended === null ? last : undefined);
  if (working !== undefined) {
    const place: RunPlace | undefined = working.place;
    const replyBy = working.replyBy ?? null;
    return {
      ...plain,
      state: "running",
      icon: "pulse",
      tone: "accent",
      title: "Working on a reply now",
      detail: place === undefined ? null : place === "builtin" ? "Built in: once the main agent has briefed it, Lumiverse writes the reply." : "In your runtime.",
      clock: replyBy === null ? null : { startedAt: working.startedAt, replyBy },
      // Skipping is offered for the run the state names: only that one can be told to end.
      skip: running !== undefined ? skippable(state, chat?.chatId ?? null) : null,
      action: { label: "Watch it live", target: live },
    };
  }
  if (last === null || last.ended === null) {
    const detail = chat === null ? "Open a chat in Lumiverse, and what LumiAH did for its last reply shows here." : standing?.answered === true ? "Send a message in this chat. LumiAH works before the reply, and what it did shows here." : "Once LumiAH is switched on for this chat, what it did for each reply shows here.";
    return { ...plain, state: "none", icon: "clock", tone: "neutral", title: "No reply yet", detail, action: null };
  }
  const ended = last.ended;
  const ms = Math.max(0, ended.at - last.startedAt);
  const took = duration(ms);
  const when = ago(now, ended.at);
  const did = last.did ?? null;
  const counts = countsWords(last);
  const mend = mendOf(ended, did, neededPermissions(state).length > 0);
  if (mend !== null) {
    const lastState: LastState = ended.noPart !== undefined ? "no_part" : ended.state === "lost" ? "lost" : ended.state === "stopped" ? "stopped" : "failed";
    // What the user did themselves (a skip) is no failure: the card says it plainly, with nothing to mend. Else the cause stands as the card's title, over what happened and the step that mends it.
    const own = mend.action === null;
    return { ...plain, state: lastState, icon: own ? "info" : "alert", tone: mend.tone, title: `${mend.title}, ${when}`, detail: mend.text === "" ? null : mend.text, counts, mend: own ? null : mend, action: { label: own ? "See what it did" : "See what happened", target: live } };
  }
  if (ended.state === "done") {
    const brief = did?.brief ?? null;
    const lore = did !== null ? loreNamesWords(did.lore) : "";
    // Where the backend says nothing of what the turn came to, the counts are all there is to say, so they aren't folded away.
    const said = brief !== null || lore !== "";
    return { ...plain, state: "done", icon: "check", tone: "pos", title: `Prepared in ${tookWords(ms, last.usage)}, ${when}`, brief, lore, detail: said ? null : counts, counts: said ? counts : null, action: { label: "See what it did", target: live } };
  }
  const reason = ended.reason !== undefined && ended.reason !== "" ? ended.reason : null;
  return { ...plain, state: "stopped", icon: "stop", tone: "neutral", title: `Stopped after ${took}, ${when}`, detail: reason ?? sentence(didWords(last)), action: { label: "See what it did", target: live } };
}

function needsOf(state: UiState, active: string | null): Need[] {
  const needs: Need[] = [];
  const needed = neededPermissions(state);
  if (needed.length > 0) {
    // One confirmation covers all of them: Lumiverse is asked for everything LumiAH lacks, the optional among it.
    needs.push({ key: "permissions", kind: "permission", icon: "shield", tone: "neg", text: `LumiAH can't work on a reply yet: Lumiverse hasn't allowed it ${counted(needed.length, "thing")} it needs.`, todo: needed[0]?.todo ?? null, action: { do: "grant", label: "Allow them", permissions: state.permissions.map((p) => p.id) }, notice: null });
  }
  for (const issue of state.runtime.issues) needs.push({ key: `issue:${issue}`, kind: "issue", icon: "alert", tone: "neg", text: issue, todo: null, action: null, notice: null });
  for (const approval of state.approvals) {
    needs.push({ key: `held:${approval.id}`, kind: "held", icon: "shield", tone: "warn", text: `${roleLabel(approval.role)} asks permission to use ${approval.tool}.`, todo: null, action: { do: "go", label: "Answer", target: approvalTarget(approval, state) }, notice: null });
  }
  for (const notice of [...state.notices].sort((a, b) => b.at - a.at)) {
    if (!NOTICE_NEEDS[notice.kind]) continue;
    needs.push({ key: `notice:${notice.id}`, kind: "job", icon: notice.kind === "job_needs_user" ? "shield" : "alert", tone: "warn", text: notice.text, todo: null, action: { do: "go", label: "Open the job", target: { page: "jobs", job: notice.jobId, chatId: notice.chatId === active ? null : notice.chatId } }, notice: notice.id });
  }
  const trouble = runtimeTrouble(state);
  if (trouble !== null) needs.push({ key: "runtime", kind: "runtime", icon: "link", tone: "warn", text: trouble, todo: null, action: { do: "go", label: "Open Runtime", target: { page: "runtime" } }, notice: null });
  const optional = optionalPermissions(state);
  if (needed.length === 0 && optional.length > 0) {
    needs.push({ key: "optional", kind: "optional", icon: "shield", tone: "warn", text: `A part of LumiAH is off: it isn't allowed to ${optional.map((p) => p.what).join("; or to ")}.`, todo: optional[0]?.todo ?? null, action: { do: "grant", label: optional.length === 1 ? "Allow it" : "Allow them", permissions: optional.map((p) => p.id) }, notice: null });
  }
  return needs;
}

/** How far a chat may be past its chronicle before that counts as behind, as Settings have it; null where the settings shown hold no such setting. */
function chronicleTail(state: UiState): number | null {
  const place = settingPlace(state.settings.schema, SETTING_LINKS.chronicleTail);
  const value = place === null ? undefined : valueAt(state.settings.values, place);
  return typeof value === "number" ? value : null;
}

/**
 * Learn this story, offered on Home for a long chat nobody has learned: LumiAH is switched on for
 * it, more of it is uncovered than the upkeep trails by (Settings' "Bring up to date after"), and
 * no job is at it. The Chronicle page is where it is started, and where a job that is at it shows.
 */
function learnOf(state: UiState, chat: ChatView | null, story: StoryView | null): LearnOffer | null {
  if (chat === null || !chat.on || story === null) return null;
  const tail = chronicleTail(state);
  if (tail === null || story.estimate.messages <= tail) return null;
  const card = storyCard({ story, active: state.jobs.active, held: new Set(), switches: { off: state.jobs.off, paused: state.jobs.paused }, has: story.covered > 0, on: true });
  if (!card.learn) return null;
  const title = story.covered > 0 ? `The chronicle is ${counted(story.estimate.messages, "message")} behind this chat` : `This chat's ${counted(story.messages, "message")} haven't been learned`;
  return { title, text: `Until they are, the agents know the earlier story only by what they look up reply by reply. ${estimateWords(story.estimate)}` };
}

function waysOf(state: UiState, pages: readonly PageId[] | null | undefined): HomeModel["ways"] {
  const marks = pageMarks(state);
  const shown = PAGES.filter((p) => p.id !== "home" && (pages === null || pages === undefined || pages.includes(p.id)));
  const way = (p: PageEntry): Way => ({ id: p.id, label: p.label, about: p.about, mark: marks[p.id] ?? null });
  return { main: shown.filter((p) => p.far !== true).map(way), more: shown.filter((p) => p.far === true).map(way) };
}

export function homeOf(input: HomeInput): HomeModel {
  const { state, home, active, now } = input;
  const view = openChat(state, home, active);
  const chat = view === null ? null : { view, standing: chatStanding(view, state) };
  // What the read says of a turn belongs to the chat it was read for: after the user opens another, it is that chat's no longer.
  const mine = home !== null && home.chat?.chatId === active ? home : null;
  const story = input.story !== null && input.story !== undefined && input.story.chatId === active ? input.story.view : null;
  const setup = setupDone(state) ? null : setupSteps(state);
  return {
    setup,
    chat,
    // Where a chat is open its switch says that LumiAH lacks what it needs, and asks for it: it isn't said twice.
    needs: needsOf(state, active).filter((n) => chat === null || n.kind !== "permission"),
    news: state.notices.filter((n) => !NOTICE_NEEDS[n.kind]).sort((a, b) => b.at - a.at),
    last: lastLine(state, mine, view, chat?.standing ?? null, now),
    // While setup is still to do there is one thing to press, and it isn't this.
    learn: setup === null ? learnOf(state, view, story) : null,
    ways: waysOf(state, input.pages),
  };
}
