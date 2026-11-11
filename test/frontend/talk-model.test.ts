// What the Talk page shows of side sessions: the list's order and words, a conversation in the
// order it was said, a turn that gave no answer, and what a new conversation can be with and about.

import { describe, expect, test } from "bun:test";
import { aboutChoices, aboutWords, canSend, noAnswerWords, sessionSub, sessionsInOrder, talkAgents, turnsInOrder } from "../../src/extension/frontend/talk-model";
import type { SideSession, SideTurn } from "../../src/shared/ui";

const T0 = Date.UTC(2026, 10, 10, 9, 0, 0);
const CHATS = [
  { chatId: "chat-mara", name: "Mara at the harbour" },
  { chatId: "chat-brann", name: null },
];
const session = (over: Partial<SideSession>): SideSession => ({ id: "s1", agent: "archivist", agentName: "Archivist", chatId: "chat-mara", title: "What do the notes say?", createdAt: T0, lastAt: T0, turns: 2, ...over });
const turn = (over: Partial<SideTurn>): SideTurn => ({ turn: "t1", at: T0, said: "What of Okoro?", answer: "He audits the ledgers.", state: "done", transcript: "a".repeat(64), usage: null, ...over });

describe("the list of conversations", () => {
  test("the one last talked in comes first", () => {
    const list = sessionsInOrder([session({ id: "old", lastAt: T0 }), session({ id: "new", lastAt: T0 + 60_000 }), session({ id: "mid", lastAt: T0 + 30_000 })]);
    expect(list.map((s) => s.id)).toEqual(["new", "mid", "old"]);
  });

  test("a row says with whom, about what and how much", () => {
    expect(sessionSub(session({}), CHATS)).toBe("Archivist · about Mara at the harbour · 2 turns");
    expect(sessionSub(session({ chatId: null, turns: 0 }), CHATS)).toBe("Archivist · about no chat · nothing said yet");
    // A chat with no name is told apart by its id's start.
    expect(aboutWords({ chatId: "chat-brann" }, CHATS)).toBe("about Chat chat-bra");
    expect(aboutWords({ chatId: "9f2c41d0-aaaa" }, [])).toBe("about Chat 9f2c41d0");
  });
});

describe("a conversation", () => {
  test("reads oldest first, though the backend gives the newest first", () => {
    expect(turnsInOrder([turn({ turn: "t3" }), turn({ turn: "t2" }), turn({ turn: "t1" })]).map((t) => t.turn)).toEqual(["t1", "t2", "t3"]);
  });

  test("a turn that gave no answer says how it ended; one that works or answered says nothing in its place", () => {
    expect(noAnswerWords(turn({}))).toBeNull();
    expect(noAnswerWords(turn({ state: "running", answer: null }))).toBeNull();
    expect(noAnswerWords(turn({ state: "stopped", answer: null }))).toBe("It was stopped before it answered.");
    expect(noAnswerWords(turn({ state: "failed", answer: null }))).toBe("It failed before it answered.");
    expect(noAnswerWords(turn({ state: "lost", answer: null }))).toBe("It was lost with its runtime before it answered.");
    expect(noAnswerWords(turn({ state: "done", answer: null }))).toBe("It finished without saying anything.");
  });

  test("blank space is nothing to send", () => {
    expect(canSend("  \n ")).toBe(false);
    expect(canSend(" What of Ilse? ")).toBe(true);
  });
});

describe("starting a conversation", () => {
  test("only agents that are switched on are offered, by name", () => {
    const offered = talkAgents([
      { id: "writer", name: "Writer", description: "Writes the reply.", off: false },
      { id: "reader", name: "", description: "", off: false },
      { id: "cartographer", name: "Cartographer", description: "", off: true },
      { id: "archivist", name: "Archivist", description: "Keeps the notes.", off: false },
    ]);
    expect(offered.map((a) => a.name)).toEqual(["Archivist", "reader", "Writer"]);
  });

  test("it can be about the chat the pages show, any chat LumiAH knows, or none", () => {
    expect(aboutChoices("chat-ilse", CHATS).map((c) => c.chatId)).toEqual(["chat-ilse", "chat-mara", "chat-brann"]);
    expect(aboutChoices("chat-mara", CHATS).map((c) => c.label)).toEqual(["Mara at the harbour", "Chat chat-bra"]);
    expect(aboutChoices(null, [])).toEqual([]);
  });
});
