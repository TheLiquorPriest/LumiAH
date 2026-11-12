// Who leads the open chat's replies, as the Agents page says it (DESIGN §21): the page's opening
// words, and a mark on each agent the open chat's claim changes the part of. An extension that
// builds LumiAH into itself may claim a chat and name the agent that leads its replies: LumiAH's own
// main agent then takes no part in them, and neither does the writer where the reply is only what
// the agents release. Either still answers what is started with it outside a reply. The open chat's
// claim is read with `lah.chat.lead.get`; pages/agents.tsx only renders what this gives.

import type { AgentView, ChatLeadView } from "../../shared/ui";
import type { Tone } from "./components";
import { MAIN_AGENT } from "./workspace-model";

/** The core's writer (`AGENT.writer`): the agent that writes a reply from a brief. */
const WRITER = "writer";

/** How the open chat's lead stands as the page knows it: no chat is open; it isn't read yet (or couldn't be); or the backend's answer for that chat. */
export type LeadRead = { chat: null } | { chat: string; read: null } | { chat: string; read: { lead: ChatLeadView | null } };

/** An agent's part in the open chat's replies, where the claim changes it: it leads them, it takes no part, or it would lead them and can't. */
export interface LeadMark {
  words: string;
  tone: Tone;
}

/** What the Agents page says of who leads: its opening words, and each agent's mark by its id. */
export interface LeadWords {
  about: string;
  marks: ReadonlyMap<string, LeadMark>;
}

const OPEN = "Open one to see what it is told, the tools it is given and the model it runs with.";

/** The page's words where the open chat is LumiAH's own, as they always were. */
export const OWN_ABOUT = `The main agent works on every reply and hands work to the others; a job or a conversation starts with one. ${OPEN}`;

/** The page's words where no chat is open, or what its claim says isn't known yet: how it goes, without saying which way it goes here. */
export const GENERAL_ABOUT = `In a chat LumiAH answers as its own, the main agent works on every reply and hands work to the others. In a chat an extension answers, that extension may name another agent to lead its replies. A job or a conversation starts with any of them. ${OPEN}`;

const LEADS: LeadMark = { words: "leads this chat's replies", tone: "accent" };
const NO_PART: LeadMark = { words: "no part in this chat's replies", tone: "neutral" };
const LEADS_OFF: LeadMark = { words: "leads this chat's replies: switched off", tone: "warn" };

/**
 * What the Agents page says of who leads the open chat's replies (`read`), with the agents as the
 * page lists them: the opening words, and the marks. Where no chat is open, or its claim isn't read,
 * the words say how it goes in general; where no extension claims it, as they always did.
 */
export function leadWords(read: LeadRead, agents: readonly AgentView[]): LeadWords {
  const marks = new Map<string, LeadMark>();
  if (read.chat === null || read.read === null) return { about: GENERAL_ABOUT, marks };
  const claim = read.read.lead;
  if (claim === null) return { about: OWN_ABOUT, marks };
  const { by } = claim;
  if ("unanswered" in claim) return { about: `Who leads this chat's replies isn't known: ${by} gave no answer for it (${claim.unanswered}), and a reply there doesn't start without one. A job or a conversation starts with any agent. ${OPEN}`, marks };
  // No writer writes a reply that is only what the agents release.
  if (claim.released) marks.set(WRITER, NO_PART);
  const lead = claim.lead;
  if (lead === null || lead === MAIN_AGENT) {
    const writer = claim.released ? ` In this chat no writer writes the reply: ${by} has the agents release it themselves.` : "";
    return { about: `The main agent works on every reply and hands work to the others.${writer} A job or a conversation starts with any agent. ${OPEN}`, marks };
  }
  marks.set(MAIN_AGENT, NO_PART);
  const listed = agents.find((a) => a.id === lead);
  const name = listed?.name ?? lead;
  const leads = listed === undefined ? `${by} names ${lead} to lead every reply in this chat, and no agent of that id is listed here: its replies don't start while it is missing.` : listed.off ? `${by} names ${name} to lead every reply in this chat, and it is switched off, so its replies don't start until you switch it on.` : `In this chat ${by} has ${name} lead every reply: it works on each and hands work to the others.`;
  if (listed !== undefined) marks.set(lead, listed.off ? LEADS_OFF : LEADS);
  const others = claim.released ? "LumiAH's Main agent and Writer take no part in this chat's replies: the agents release the reply themselves." : `LumiAH's Main agent takes no part in this chat's replies: ${name} briefs the Writer in its place.`;
  return { about: `${leads} ${others} A job or a conversation starts with any of them, the Main agent too. ${OPEN}`, marks };
}
