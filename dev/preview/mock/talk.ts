// The stand-in backend's side sessions (DESIGN §19): conversations with an agent that are no reply
// in a chat. Two are there when the preview opens, one with turns to read; saying something plays
// a turn under the session's own id, so the Talk page shows the agent at work as Live shows a reply.

import type { SideSession, SideTurn } from "../../../src/shared/ui";
import { fakeHash, type PlayStep, Trace } from "../fixtures";
import { type Handlers, MOCK_AGENTS, type MockCtx, Refusal } from "./ctx";

type Requests = "lah.side.list" | "lah.side.start" | "lah.side.turns" | "lah.side.send" | "lah.side.remove";

const INSTRUCTIONS: Readonly<Record<string, string>> = {
  archivist: "You keep this chat's notes. Read what the workspace holds before you write, write what is known and where it was said, and say what you changed.",
  main: "You are the main agent of this chat, asked something outside it. Answer from what the chat and the workspace hold, and say where you found it.",
};

const nameOf = (agent: string): string => MOCK_AGENTS.find((a) => a.id === agent)?.name ?? agent;

/** What the agent of a side session answers, made up from what was said: it looks one thing up, then answers. */
function answerTo(said: string): { looks: string; found: string; answer: string } {
  const about = said.toLowerCase().includes("okoro") ? "Okoro" : said.toLowerCase().includes("ilse") ? "Ilse" : "the ledger";
  return {
    looks: `notes about ${about}`,
    found: about === "Okoro" ? "learned/people/okoro.md · \"Audits the ledgers on the first of each month and signs the last page he read.\"" : about === "Ilse" ? "notes/ledger.md · \"Ilse holds the night key and asks what Joss thinks is in the office (#47).\"" : "notes/ledger.md · \"Okoro signed it on the first (#38). A page is missing; it went missing after the first (#43).\"",
    answer: about === "Okoro" ? "Okoro audits the ledgers on the first of each month and signs the last page he read. The notes hold nothing on where he is now; the last reply that names him is #43." : about === "Ilse" ? "Ilse holds the night key. At the door (#47) she asked what Joss thinks is in the office, and nothing since says she was answered." : "The notes say Okoro signed the ledger on the first (#38) and that the missing page went missing after that (#43). Nothing says who took it.",
  };
}

/** A side session's turn, as it plays. */
function steps(session: SideSession, said: string): PlayStep[] {
  const a = answerTo(said);
  const agentId = `${session.agent}-1`;
  const grep = { id: "call_grep_1", name: "workspace_grep", args: { query: a.looks } };
  return [
    { after: 0, run: (t) => void t.started("side", null, { side: session.id }) },
    { after: 250, run: (t) => void t.agent({ id: agentId, role: session.agent, system: INSTRUCTIONS[session.agent] ?? INSTRUCTIONS.main ?? "", connectionId: "conn-deepseek", history: session.turns * 2 }).message(agentId, said) },
    { after: 1800, says: { agentId, reasoning: "The workspace should have this. Look before answering." }, run: (t) => void t.answer(agentId, { reasoning: "The workspace should have this. Look before answering.", calls: [grep], in: 1420, cachedIn: 900, out: 46, reasoningOut: 18, ms: 1800 }) },
    { after: 500, run: (t) => void t.result(agentId, grep, `1 file matches.\n\n${a.found}`, 24) },
    { after: 2400, says: { agentId, text: a.answer }, run: (t) => void t.answer(agentId, { text: a.answer, in: 1610, cachedIn: 1420, out: 72, ms: 2400 }).idle(agentId) },
    { after: 150, run: (t) => void t.ended("done") },
  ];
}

/** A turn of a side session that ended before the preview opened, written whole. */
function pastTurn(session: SideSession, turn: string, at: number, said: string): { trace: Trace; answer: string } {
  const a = answerTo(said);
  const agentId = `${session.agent}-1`;
  const grep = { id: "call_grep_1", name: "workspace_grep", args: { query: a.looks } };
  const t = new Trace(session.chatId ?? "", turn, at);
  t.started("side", null, { side: session.id });
  t.wait(30).agent({ id: agentId, role: session.agent, system: INSTRUCTIONS[session.agent] ?? INSTRUCTIONS.main ?? "", connectionId: "conn-deepseek" });
  t.message(agentId, said);
  t.answer(agentId, { calls: [grep], in: 1380, cachedIn: 0, out: 40, ms: 1700 });
  t.result(agentId, grep, `1 file matches.\n\n${a.found}`, 22);
  t.answer(agentId, { text: a.answer, in: 1560, cachedIn: 1380, out: 70, ms: 2100 });
  t.idle(agentId);
  t.wait(20).ended("done");
  return { trace: t, answer: a.answer };
}

export function talkMock(ctx: MockCtx): Handlers<Requests> {
  const now = ctx.now();
  let made = 0;
  let sessions: SideSession[] = [];
  const turns = new Map<string, SideTurn[]>();
  if (ctx.ready) {
    const notes: SideSession = { id: "side-notes", agent: "archivist", agentName: nameOf("archivist"), chatId: "chat-mara", title: "What do the notes say about the ledger?", createdAt: now - 3 * 3_600_000, lastAt: now - 40 * 60_000, turns: 2 };
    const empty: SideSession = { id: "side-plain", agent: "main", agentName: nameOf("main"), chatId: null, title: "New conversation", createdAt: now - 26 * 3_600_000, lastAt: now - 26 * 3_600_000, turns: 0 };
    sessions = [notes, empty];
    const past = [
      { turn: "side-notes-t1", at: notes.createdAt, said: "What do the notes say about the ledger?" },
      { turn: "side-notes-t2", at: notes.lastAt, said: "And what do we know of Okoro?" },
    ].map((x): SideTurn => {
      const made = pastTurn(notes, x.turn, x.at, x.said);
      return { turn: x.turn, at: x.at, said: x.said, answer: made.answer, state: "done", transcript: ctx.keep(notes.id, made.trace), usage: made.trace.tally };
    });
    turns.set(notes.id, past.reverse());
    turns.set(empty.id, []);
  }
  const find = (id: string): SideSession => {
    const session = sessions.find((s) => s.id === id);
    if (!session) throw new Refusal("not_found", "There is no such conversation: it may have been deleted on another page.");
    return session;
  };
  const replace = (session: SideSession): void => {
    sessions = [session, ...sessions.filter((s) => s.id !== session.id)];
  };
  return {
    "lah.side.list": () => ({ sessions }),
    "lah.side.start": (r) => {
      if (!MOCK_AGENTS.some((a) => a.id === r.agent)) throw new Refusal("not_found", `There is no agent ${r.agent}.`);
      made += 1;
      const at = ctx.now();
      const session: SideSession = { id: `side-new-${made}`, agent: r.agent, agentName: nameOf(r.agent), chatId: r.chatId, title: "New conversation", createdAt: at, lastAt: at, turns: 0 };
      replace(session);
      turns.set(session.id, []);
      return { session };
    },
    "lah.side.turns": (r) => {
      find(r.session);
      const all = turns.get(r.session) ?? [];
      const from = r.cursor === null ? 0 : Number(r.cursor);
      return { turns: all.slice(from, from + r.limit), next: from + r.limit < all.length ? String(from + r.limit) : null };
    },
    "lah.side.send": (r) => {
      const session = find(r.session);
      const at = ctx.now();
      const turn = ctx.play(session.id, steps(session, r.text), {
        reply: false,
        chatId: session.chatId,
        done: (end) => {
          const answer = end.trace.events.flatMap((e) => (e.event.kind === "agent_entry" && e.event.entry.kind === "answer" && e.event.entry.calls.length === 0 ? [e.event.entry.text] : [])).at(-1) ?? null;
          turns.set(session.id, (turns.get(session.id) ?? []).map((t) => (t.turn === end.turn ? { ...t, state: end.state, answer: end.state === "done" ? answer : null, transcript: end.transcript, usage: end.trace.tally } : t)));
        },
      });
      if (turn === null) throw new Refusal("unavailable", "It is still working on what you last said: wait for its answer, or stop it.");
      turns.set(session.id, [{ turn, at, said: r.text, answer: null, state: "running", transcript: null, usage: null }, ...(turns.get(session.id) ?? [])]);
      const next: SideSession = { ...session, title: session.turns === 0 ? r.text.slice(0, 80) : session.title, lastAt: at, turns: session.turns + 1 };
      replace(next);
      return { session: next, turn };
    },
    "lah.side.remove": (r) => {
      find(r.session);
      ctx.stop(r.session, "Its conversation was deleted.");
      sessions = sessions.filter((s) => s.id !== r.session);
      turns.delete(r.session);
      return { removed: true };
    },
  };
}

/** The hash a made-up report or summary is kept under. */
export const sideHash = (name: string): string => fakeHash(`side:${name}`);
