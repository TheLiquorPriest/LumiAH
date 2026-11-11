// The texts of side sessions (DESIGN §19): what an agent is told a side conversation is, and how a
// long one is summarized.

import { GROUP, type TextDef, v } from "../text-def";

export const SIDE_TEXT = {
  about: "side.about",
  aboutChat: "side.about.chat",
  aboutNothing: "side.about.nothing",
  summary: "side.summary",
  summarizer: "side.summarizer",
  summarizerInput: "side.summarizer.input",
  asked: "side.summarizer.asked",
  answered: "side.summarizer.answered",
  unanswered: "side.unanswered",
} as const;

const SIDE = GROUP.side;

export const SIDE_TEXTS: TextDef[] = [
  { id: SIDE_TEXT.about, group: SIDE, label: "What a side session is", note: "Follows the instructions of an agent in a side session.", text: "This is a side conversation with the user, on LumiAH's page: not a reply in a chat. Answer the user directly, as yourself. Nothing you write here goes into a chat's messages, and there is no writer: your answer is what they read. {{about}}", vars: [v("about", "what the conversation is about, as the two texts below say it", true)] },
  { id: SIDE_TEXT.aboutChat, group: SIDE, label: "A side session about a chat", note: "Fills {{about}} for a side session about a chat.", text: "It is about the chat “{{chat}}”: your chat, lore and workspace tools read that chat as it stands now.", vars: [v("chat", "the chat's name", true)] },
  { id: SIDE_TEXT.aboutNothing, group: SIDE, label: "A side session about no chat", note: "Fills {{about}} for a side session about nothing in particular.", text: "It is about no chat in particular: there is no chat or lore to read, and of the workspace only the user's own files (~/).", vars: [] },
  { id: SIDE_TEXT.summary, group: SIDE, label: "The summary, in a side session", note: "Leads a side session's conversation once its older part was summarized.", text: "[The earlier part of this conversation, summarized:]\n{{summary}}", vars: [v("summary", "the summary", true)] },
  {
    id: SIDE_TEXT.summarizer,
    group: SIDE,
    label: "Side session summary: instructions",
    note: "The instructions of the call that summarizes the older part of a long side session.",
    text: "You are given the earlier part of a conversation between a user and an agent, and a summary of what came before it, if there is one. Write one summary that stands for all of it, for the agent to go on from: what the user asked for and why, what was decided, what the agent found or did (with the names of files it wrote), and what is still open. Keep it under {{limit}} tokens. Answer with the summary alone.",
    vars: [v("limit", "Summary length", true)],
  },
  { id: SIDE_TEXT.summarizerInput, group: SIDE, label: "Side session summary: what it is given", note: "The message of the call that summarizes a side session.", text: "The summary so far:\n{{summary}}\n\nThe conversation since:\n\n{{turns}}", vars: [v("summary", "the summary so far, or that there is none", true), v("turns", "each exchange, as the two texts below write it", true)] },
  { id: SIDE_TEXT.asked, group: SIDE, label: "Side session summary: the user", note: "What the user said, in what the summarizer is given.", text: "The user:\n{{text}}", vars: [v("text", "the user's words", true)] },
  { id: SIDE_TEXT.answered, group: SIDE, label: "Side session summary: the agent", note: "What the agent answered, in what the summarizer is given.", text: "The agent:\n{{text}}", vars: [v("text", "the agent's answer", true)] },
  { id: SIDE_TEXT.unanswered, group: SIDE, label: "A side session turn without an answer", note: "Stands for the agent's answer, in its conversation, to a message it didn't answer.", text: "(You didn't answer this: {{reason}}.)", vars: [v("reason", "why", true)] },
];
