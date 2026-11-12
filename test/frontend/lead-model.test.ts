// What the Agents page says of who leads the open chat's replies (lead-model.ts): its opening words
// and the marks on the agents the open chat's claim changes the part of, for a chat an extension
// claims and names a lead for (on, switched off, not there), one it claims without naming one, one it
// doesn't claim, one whose claim got no answer, and no open chat at all.

import { describe, expect, test } from "bun:test";
import { GENERAL_ABOUT, type LeadRead, leadWords, OWN_ABOUT } from "../../src/extension/frontend/lead-model";
import type { AgentView, ChatLeadView } from "../../src/shared/ui";

/** An agent as the page lists it: the model reads its id, its name and whether it is switched off. */
function agent(id: string, name: string, source: AgentView["source"], off = false): AgentView {
  return { id, name, source, off } as unknown as AgentView;
}

const MAIN = agent("main", "Main agent", "builtin");
const WRITER = agent("writer", "Writer", "builtin");
const AUTHOR = agent("author", "Author", "extension");
const AGENTS = [MAIN, WRITER, AUTHOR];

/** The page's read of the open chat's claim. */
const open = (lead: ChatLeadView | null): LeadRead => ({ chat: "chat-1", read: { lead } });

/** Each mark's words by agent id, for an easy comparison. */
const marksOf = (read: LeadRead, agents: readonly AgentView[] = AGENTS): Record<string, string> => Object.fromEntries([...leadWords(read, agents).marks].map(([id, mark]) => [id, mark.words]));

describe("who leads the open chat's replies, as the Agents page says it", () => {
  test("an extension names its agent to lead, and the reply is only what the agents release: that agent leads, LumiAH's Main agent and Writer take no part", () => {
    const read = open({ by: "LumiRPEngine", lead: "author", released: true });
    expect(marksOf(read)).toEqual({ author: "leads this chat's replies", main: "no part in this chat's replies", writer: "no part in this chat's replies" });
    const { about } = leadWords(read, AGENTS);
    expect(about).toContain("LumiRPEngine has Author lead every reply");
    expect(about).toContain("LumiAH's Main agent and Writer take no part in this chat's replies");
    // They still answer what is started with them outside a reply.
    expect(about).toContain("A job or a conversation starts with any of them, the Main agent too.");
    expect(about).not.toContain("The main agent works on every reply");
  });

  test("an extension names its agent to lead, and a writer still writes: only LumiAH's Main agent takes no part", () => {
    const read = open({ by: "Tide keeper", lead: "author", released: false });
    expect(marksOf(read)).toEqual({ author: "leads this chat's replies", main: "no part in this chat's replies" });
    expect(leadWords(read, AGENTS).about).toContain("Author briefs the Writer in its place");
  });

  test("the agent it names is switched off: it is marked so, and the words say the chat's replies don't start until it is on", () => {
    const words = leadWords(open({ by: "LumiRPEngine", lead: "author", released: true }), [MAIN, WRITER, agent("author", "Author", "extension", true)]);
    expect(words.marks.get("author")).toEqual({ words: "leads this chat's replies: switched off", tone: "warn" });
    expect(words.marks.get("main")?.words).toBe("no part in this chat's replies");
    for (const fact of ["LumiRPEngine names Author", "switched off", "don't start until you switch it on"]) expect(words.about).toContain(fact);
  });

  test("the agent it names isn't listed: nothing is marked as leading, and the words say its replies don't start while it is missing", () => {
    const words = leadWords(open({ by: "LumiRPEngine", lead: "author", released: true }), [MAIN, WRITER]);
    expect([...words.marks.keys()].sort()).toEqual(["main", "writer"]);
    for (const fact of ["LumiRPEngine names author", "no agent of that id is listed here", "don't start while it is missing"]) expect(words.about).toContain(fact);
  });

  test("a claim that names no lead leaves LumiAH's main agent at work; one whose reply is only what is released marks the Writer as taking no part", () => {
    const named = open({ by: "Tide keeper", lead: null, released: false });
    expect(marksOf(named)).toEqual({});
    expect(leadWords(named, AGENTS).about).toStartWith("The main agent works on every reply");
    const released = open({ by: "Tide keeper", lead: null, released: true });
    expect(marksOf(released)).toEqual({ writer: "no part in this chat's replies" });
    expect(leadWords(released, AGENTS).about).toContain("In this chat no writer writes the reply: Tide keeper has the agents release it themselves.");
  });

  test("a chat no extension claims reads as it always did, with no marks", () => {
    expect(leadWords(open(null), AGENTS)).toEqual({ about: OWN_ABOUT, marks: new Map() });
    expect(OWN_ABOUT).toBe("The main agent works on every reply and hands work to the others; a job or a conversation starts with one. Open one to see what it is told, the tools it is given and the model it runs with.");
  });

  test("a claim that got no answer says who leads isn't known, and why, with no marks", () => {
    const words = leadWords(open({ by: "LumiRPEngine", unanswered: "the link dropped" }), AGENTS);
    expect(words.marks.size).toBe(0);
    for (const fact of ["Who leads this chat's replies isn't known", "LumiRPEngine gave no answer", "the link dropped", "doesn't start"]) expect(words.about).toContain(fact);
  });

  test("with no chat open, or the open chat's claim not read yet, the page says how it goes in general and claims neither way", () => {
    for (const read of [{ chat: null }, { chat: "chat-1", read: null }] as const) expect(leadWords(read, AGENTS)).toEqual({ about: GENERAL_ABOUT, marks: new Map() });
    expect(GENERAL_ABOUT).toContain("In a chat LumiAH answers as its own, the main agent works on every reply");
    expect(GENERAL_ABOUT).toContain("In a chat an extension answers, that extension may name another agent to lead its replies.");
  });
});
