// What counts as a chat's story (DESIGN §24.4), as Home shows it in the chat's fold: what holds in
// the chat and why, and the chat's own choice of each member over Settings'. The decisions are here;
// setup-parts.tsx sends the requests.

import { type ChatStoryView, STORY_MEMBERS, type StorySetting, type StoryWord, storyWordOf } from "../../shared/ui";
import type { SegOption } from "./components";

type Member = keyof StorySetting;

/** The choice that names nothing of the chat's own: the member follows Settings. */
const FOLLOW = "settings";

/** Each member's name, and its choices for one chat: Settings' first, then its own values as Settings names them. */
const MEMBERS: { readonly [K in Member]: { label: string; options: readonly SegOption<StorySetting[K] | typeof FOLLOW>[] } } = {
  hidden: {
    label: "Hidden messages",
    options: [
      { value: FOLLOW, label: "As Settings" },
      { value: "leave_out", label: "Leave out" },
      { value: "include", label: "Read them" },
    ],
  },
  from: {
    label: "Whose messages",
    options: [
      { value: FOLLOW, label: "As Settings" },
      { value: "lumiverse", label: "As Lumiverse" },
      { value: "everyone", label: "Everyone's" },
      { value: "replies", label: "Replies only" },
    ],
  },
  newest: {
    label: "Your newest message",
    options: [
      { value: FOLLOW, label: "As Settings" },
      { value: "directive", label: "As direction" },
      { value: "leave_out", label: "Leave out" },
    ],
  },
};

/** Said under Whose messages where Lumiverse doesn't tell extensions about its Sovereign Hand. */
const UNTOLD = "This Lumiverse doesn't tell LumiAH whether Sovereign Hand is on, so As Lumiverse counts everyone's messages.";

/** A member's value as the page names it. */
function labelOf(member: Member, value: string): string {
  const options: readonly SegOption<string>[] = MEMBERS[member].options;
  return options.find((option) => option.value === value)?.label ?? value;
}

/** Whose word settled a member, in a few words. */
function why(view: ChatStoryView, word: StoryWord): string {
  if (word === "claim") return `set by ${view.claimed?.by ?? "the extension that answers this chat"}`;
  return word === "chat" ? "as this chat is set" : "as in Settings";
}

/** One member of the chat's choice, as the fold shows it. */
export interface StoryRow {
  member: Member;
  label: string;
  /** The chat's own choice, or "settings" where it follows Settings: the choice shown pressed. */
  value: string;
  options: readonly SegOption<string>[];
  /** What the extension that answers the chat set, in words: it can't be chosen here. Null where the chat chooses. */
  claimed: string | null;
  /** A line under the choice; "" for none. */
  help: string;
}

/** The members the chat chooses: Your newest message only where only the model's replies are the story, since only then is it anything. */
export function storyRows(view: ChatStoryView): StoryRow[] {
  return STORY_MEMBERS.filter((member) => member !== "newest" || view.holds.source.from === "replies").map((member) => {
    const set = view.claimed?.story[member];
    return {
      member,
      label: MEMBERS[member].label,
      value: view.chosen[member] ?? FOLLOW,
      options: MEMBERS[member].options,
      claimed: set !== undefined && view.claimed !== null ? `Set by ${view.claimed.by}: ${labelOf(member, set).toLowerCase()}.` : null,
      help: member === "from" && set === undefined && view.sovereignHand === null ? UNTOLD : "",
    };
  });
}

/** The chat's whole choice once `member` is set to `value`; "settings" takes the member back to following Settings. */
export function storyChosen(view: ChatStoryView, member: Member, value: string): Partial<StorySetting> {
  return storyWordOf({ ...view.chosen, [member]: value === FOLLOW ? undefined : value });
}

/** The fold's line: whose messages count as the story in the chat. */
export function storySummary(view: ChatStoryView): string {
  return `What counts as the story: ${view.holds.source.from === "replies" ? "the replies" : "everyone's messages"}`;
}

/** What holds in the chat and why, member by member, in short sentences. */
export function storyWhy(view: ChatStoryView): string {
  const { source, by, sovereignHand } = view.holds;
  const whose = source.from === "replies" ? "Only the model's replies are the story" : "Everyone's messages are the story";
  // Following Lumiverse, the reason is what Lumiverse said of its Sovereign Hand, or that it said nothing.
  const reason = sovereignHand === undefined ? why(view, by.from) : sovereignHand === null ? "since this Lumiverse doesn't say whether Sovereign Hand is on" : `since Sovereign Hand is ${sovereignHand ? "on" : "off"} in Lumiverse`;
  const hidden = `Hidden messages are ${source.hidden === "include" ? "read too" : "left out"}, ${why(view, by.hidden)}.`;
  const newest = source.from === "replies" ? ` Your newest message is ${source.newest === "directive" ? "given as the direction" : "left out too"}, ${why(view, by.newest)}.` : "";
  return `${whose}, ${reason}. ${hidden}${newest}`;
}
