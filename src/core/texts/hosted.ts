// The texts of a turn whose reply Lumiverse's own generation writes (DESIGN §25, built in): what
// the main agent is told of the time it has, what `write_reply` answers there, why its work stopped
// when the reply was due, and what the live view says was handed to the writer.

import { GROUP, type TextDef, v } from "../text-def";

export const HOSTED_TEXT = {
  replyBy: "hosted.reply_by",
  replySoon: "hosted.reply_soon",
  stop: "stop.reply_time",
  handed: "tool.answer.reply_handed",
  noticeBrief: "hosted.notice.brief",
  noticeAnswer: "hosted.notice.answer",
  noticeNone: "hosted.notice.none",
  whyLapsed: "hosted.why.lapsed",
  whyAbandoned: "hosted.why.abandoned",
} as const;

export const HOSTED_TEXTS: TextDef[] = [
  {
    id: HOSTED_TEXT.replyBy,
    group: GROUP.main,
    label: "The time before the reply, built in",
    note: "Ends the main agent's message for a turn whose reply Lumiverse's own generation writes: how long it has before the reply is due.",
    text: "[The reply is due in about {{seconds}} seconds: Lumiverse waits no longer than that before it writes. Call write_reply by then with what you have. When the time is up your work stops where it is, and the writer writes from the prompt alone. Work that needs longer belongs in a job (job_start, where you hold it): a job has no such limit and goes on after the reply.]",
    vars: [v("seconds", "the seconds left before the reply is due", true)],
  },
  {
    id: HOSTED_TEXT.replySoon,
    group: GROUP.runtime,
    label: "The reply is nearly due",
    note: "Told to the main agent with a round's results once the time left before the reply is due is as short as Warn before the reply is due.",
    text: "[About {{seconds}} seconds are left before the reply is due. Call write_reply now with what you have; what is left to do belongs in a job.]",
    vars: [v("seconds", "the seconds left before the reply is due", true)],
  },
  { id: HOSTED_TEXT.stop, group: GROUP.stops, label: "The reply was due", note: "Why the main agent stopped when the time Lumiverse waits for LumiAH before a reply was up.", text: "the reply was due before its work was done: Lumiverse waits only so long before it writes", vars: [] },
  { id: HOSTED_TEXT.handed, group: GROUP.answers, label: "write_reply: handed to Lumiverse's writer", note: "write_reply's answer where Lumiverse's own generation writes the reply.", text: "Handed over: Lumiverse writes the reply now, from the prompt with your brief. Your turn ends here.", vars: [] },
  { id: HOSTED_TEXT.noticeBrief, group: GROUP.progress, label: "Built in: the brief was handed over", note: "What the live view says when the main agent's brief went to Lumiverse's own generation.", text: "Lumiverse writes the reply from its prompt with the main agent's brief.", vars: [] },
  { id: HOSTED_TEXT.noticeAnswer, group: GROUP.progress, label: "Built in: an answer handed over as the brief", note: "What the live view says when the main agent ended without calling write_reply and its last answer went to Lumiverse's own generation in the brief's place.", text: "The main agent ended without calling write_reply; Lumiverse writes the reply from its prompt with the agent's last answer as the brief.", vars: [] },
  { id: HOSTED_TEXT.noticeNone, group: GROUP.progress, label: "Built in: LumiAH had no part in the reply", note: "What the live view says when Lumiverse writes a reply from its prompt as it was.", text: "LumiAH had no part in this reply ({{reason}}): Lumiverse writes it from its prompt as it was.", vars: [v("reason", "why", true)] },
  { id: HOSTED_TEXT.whyLapsed, group: GROUP.progress, label: "Built in: the reply never came", note: "Why a turn was given up when its reply wasn't written in the time Give up a reply that isn't written allows.", text: "its reply wasn't written within {{seconds}} seconds of the hand-over (Give up a reply that isn't written), so its run was let go; if the reply is still saved, the turn gets its record then", vars: [v("seconds", "the time waited, in seconds", true)] },
  { id: HOSTED_TEXT.whyAbandoned, group: GROUP.progress, label: "Built in: the generation wrote no reply", note: "Why a turn was given up when Lumiverse's generation failed or was stopped and no reason came with it.", text: "Lumiverse's generation wrote no reply, so no record of the turn is kept", vars: [] },
];
