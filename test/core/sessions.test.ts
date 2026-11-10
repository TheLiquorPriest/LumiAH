// Sessions and anchors (DESIGN §5) through whole turns on an in-memory host: the session resuming on
// the next turn, after a swipe, a regenerate, an edit and a branch; a record off the path; a continue;
// compaction with the replaced span kept; and rollback.

import { describe, expect, test } from "bun:test";
import { createHarness } from "../../src/core/harness";
import type { ModelRequest, TraceEvent } from "../../src/core/ports";
import { pathTurns, recordOf, rollback, segmentOf, sessionAt } from "../../src/core/sessions";
import { defaultSettings, type Settings } from "../../src/core/settings";
import { parseJson } from "../../src/core/util";
import { call, MemoryHost, runTurn } from "./support/host";

const CHAT = "chat-1";
const SUMMARIZER = "You keep a main agent's notes short.";

/**
 * A chat, and a model scripted by who calls it: the main agent briefs the writer at once ("brief 1",
 * "brief 2", …, by the order of its turns), the writer answers "Reply N.", and the summarizer gives
 * the next of `summaries`.
 */
function rig(change: (s: Settings) => void = () => undefined) {
  const host = new MemoryHost();
  const summaries: (string | { content: string; finishReason: string })[] = [];
  let n = 0;
  host.script = (request) => {
    if (request.messages[0]?.content.startsWith(SUMMARIZER)) return summaries.shift() ?? "A summary of the earlier turns.";
    if (request.tools) return { toolCalls: [call("write_reply", { brief: `brief ${++n}` })] };
    return `Reply ${n}.`;
  };
  host.say(CHAT, "assistant", "The harbour is quiet tonight.");
  host.say(CHAT, "user", "I walk down to the lighthouse.");
  const stored = { values: defaultSettings(), texts: {} as Record<string, string> };
  change(stored.values);
  const harness = createHarness(host, { settings: async () => structuredClone(stored) });
  const turn = (chatId = CHAT, options: Parameters<typeof runTurn>[3] = {}) => runTurn(host, harness, chatId, options);
  /** The user speaks, and a new reply is written. */
  const exchange = (text: string, chatId = CHAT) => {
    host.say(chatId, "user", text);
    return turn(chatId);
  };
  return { host, harness, stored, summaries, turn, exchange };
}

const isMain = (request: ModelRequest): boolean => request.tools?.some((t) => t.name === "write_reply") === true;
/** What the main agent was sent on its latest call: everything it carries, and the turn's message. */
const carried = (host: MemoryHost): string => (host.calls.findLast(isMain)?.messages ?? []).slice(1).map((m) => `${m.role}: ${m.content}`).join("\n---\n");
const lastSession = (host: MemoryHost) => host.traced.map((r) => r.event).findLast((e): e is Extract<TraceEvent, { kind: "session" }> => e.kind === "session")?.session;

describe("the session resumes", () => {
  test("on the next turn: the main agent carries a receipt of the turn before, and never the chat's own messages", async () => {
    const r = rig();
    await r.turn();
    expect(lastSession(r.host)).toMatchObject({ turns: 0, summary: false });
    await r.exchange("I knock.");
    expect(lastSession(r.host)).toMatchObject({ turns: 1, summary: false, dropped: [], missing: 0 });
    const [told, receipt] = (r.host.calls.findLast(isMain)?.messages ?? []).slice(1);
    expect(told).toEqual({ role: "user", content: "Reply #2 (new): a request of 2 messages, ending at chat message #1." });
    expect(receipt).toEqual({ role: "assistant", content: 'What you did:\n- write_reply {"brief":"brief 1"}\n  → the writer wrote the reply (8 characters; it is chat message #2)' });
    // The session holds what the agent did, not what the chat said.
    const record = recordOf(r.host.message(CHAT, r.host.chats.get(CHAT)![2]!.id).anchors[0]);
    expect(r.host.blobStore.get(record?.segment ?? "")).not.toContain("lighthouse");
    await r.exchange("I wait.");
    expect(lastSession(r.host)?.turns).toBe(2);
    expect(carried(r.host)).toContain("Reply #4 (new): a request of 4 messages, ending at chat message #3.");
  });

  test("after a swipe: the swipe reads the session before its reply, and later turns read the swipe that is shown", async () => {
    const r = rig();
    await r.turn();
    await r.turn(CHAT, { kind: "swipe" });
    // The swipe is another answer to the same message: it carries nothing of the reply it stands beside.
    expect(lastSession(r.host)?.turns).toBe(0);
    const reply = r.host.last(CHAT);
    expect(reply.swipes).toEqual(["Reply 1.", "Reply 2."]);
    expect(Object.keys(reply.anchors)).toEqual(["0", "1"]);
    await r.exchange("I knock.");
    expect(carried(r.host)).toContain('"brief":"brief 2"');
    expect(carried(r.host)).not.toContain('"brief":"brief 1"');
    // Back on the first swipe, its own notes are read, and the turn made after the other swipe no longer fits.
    r.host.show(CHAT, reply.id, 0);
    await r.exchange("I wait.");
    expect(lastSession(r.host)).toMatchObject({ turns: 1, dropped: [4] });
    expect(carried(r.host)).toContain('"brief":"brief 1"');
    expect(carried(r.host)).not.toContain('"brief":"brief 2"');
  });

  test("after a regenerate: the new reply's record takes the old one's place", async () => {
    const r = rig();
    await r.turn();
    const before = recordOf(r.host.last(CHAT).anchors[0]);
    await r.turn(CHAT, { kind: "regenerate" });
    expect(lastSession(r.host)?.turns).toBe(0);
    const after = recordOf(r.host.last(CHAT).anchors[0]);
    expect(after?.kind).toBe("regenerate");
    expect(after?.path).toBe(before?.path ?? "");
    expect(after?.segment).not.toBe(before?.segment ?? "");
    await r.exchange("I knock.");
    expect(carried(r.host)).toContain("Reply #2 (regenerate)");
    expect(carried(r.host)).toContain('"brief":"brief 2"');
  });

  test("after a branch: the branch reads the records it was copied with, and each chat goes on alone", async () => {
    const r = rig();
    await r.turn();
    await r.exchange("I knock.");
    r.host.branch(CHAT, 5, "chat-branch");
    await r.exchange("In the branch, I leave.", "chat-branch");
    expect(lastSession(r.host)).toMatchObject({ turns: 2, dropped: [] });
    expect(carried(r.host)).toContain('"brief":"brief 1"');
    expect(carried(r.host)).toContain('"brief":"brief 2"');
    await r.exchange("In the first chat, I stay.");
    expect(lastSession(r.host)?.turns).toBe(2);
    expect(carried(r.host)).not.toContain('"brief":"brief 3"');
  });

  test("on a continue: the turn is told what it did for the reply before, and the record keeps both turns' steps", async () => {
    const r = rig();
    await r.turn();
    await r.turn(CHAT, { kind: "continue" });
    expect(carried(r.host)).toContain('You already worked on this reply before it was continued. What you did then:\nWhat you did:\n- write_reply {"brief":"brief 1"}');
    expect(r.host.last(CHAT).swipes).toEqual(["Reply 1.Reply 2."]);
    const record = recordOf(r.host.last(CHAT).anchors[0]);
    const segment = segmentOf(parseJson(r.host.blobStore.get(record?.segment ?? "") ?? ""));
    expect(segment?.steps.map((s) => (s.kind === "call" ? s.args.brief : s.kind))).toEqual(["brief 1", "brief 2"]);
  });
});

describe("a record off the path", () => {
  test("after an edit: the notes from that point are dropped, and the main agent is told", async () => {
    const r = rig();
    await r.turn();
    await r.exchange("I knock.");
    // The second message of the user's changes: the first turn's record still fits, the second's doesn't.
    r.host.edit(CHAT, r.host.chats.get(CHAT)![3]!.id, "I knock twice.");
    const { sink } = await r.exchange("I wait.");
    expect(lastSession(r.host)).toMatchObject({ turns: 1, dropped: [4] });
    expect(carried(r.host)).toContain('"brief":"brief 1"');
    expect(carried(r.host)).not.toContain('"brief":"brief 2"');
    expect(carried(r.host)).toContain("An earlier message of this chat was changed or removed, so your notes from reply #4 no longer fit it and were dropped");
    expect(sink.progressLines).toContain("An earlier message changed, so its notes from reply #4 were dropped.");
  });

  test("an edit before every turn drops them all; editing a reply's own text keeps that reply's notes", async () => {
    const r = rig();
    await r.turn();
    await r.exchange("I knock.");
    r.host.edit(CHAT, r.host.chats.get(CHAT)![2]!.id, "Reply 1, as the user rewrote it.");
    await r.exchange("I wait.");
    expect(lastSession(r.host)).toMatchObject({ turns: 1, dropped: [4] });
    r.host.edit(CHAT, r.host.chats.get(CHAT)![1]!.id, "I row out to the lighthouse.");
    await r.exchange("I wait longer.");
    expect(lastSession(r.host)).toMatchObject({ turns: 0, dropped: [2, 4, 6] });
    expect(carried(r.host)).toContain("your notes from replies #2, #4, #6 no longer fit");
  });

  test("after a deleted message, and for anything that isn't a record", async () => {
    const r = rig();
    await r.turn();
    await r.exchange("I knock.");
    const messages = r.host.chats.get(CHAT)!;
    // Something else wrote under LumiAH's key on a message of the user's: it reads as no record at all.
    messages[3]!.anchors[0] = { v: 1, segment: "not a hash", note: "written by something else" };
    r.host.remove(CHAT, messages[0]!.id);
    await r.exchange("I wait.");
    // Every message moved up one, and both replies' records were made on a path that had the deleted message.
    expect(lastSession(r.host)).toMatchObject({ turns: 0, dropped: [1, 3] });
  });

  test("the Sessions page reads which records are on the path", async () => {
    const r = rig();
    await r.turn();
    await r.exchange("I knock.");
    r.host.edit(CHAT, r.host.chats.get(CHAT)![3]!.id, "I knock twice.");
    const turns = await pathTurns(await r.host.chat.path(CHAT));
    expect(turns.map((t) => [t.index, t.onPath, t.record.kind])).toEqual([[2, true, "new"], [4, false, "new"]]);
    expect(sessionAt(turns)).toMatchObject({ summary: null, segments: [turns[0]!.record.segment], dropped: [4] });
  });

  test("a stored body that is gone is left out, and the main agent is told", async () => {
    const r = rig();
    await r.turn();
    const record = recordOf(r.host.last(CHAT).anchors[0]);
    r.host.blobStore.delete(record?.segment ?? "");
    const fresh = createHarness(r.host, { settings: async () => structuredClone(r.stored) });
    r.host.say(CHAT, "user", "I knock.");
    await runTurn(r.host, fresh, CHAT);
    expect(lastSession(r.host)).toMatchObject({ turns: 0, missing: 1 });
    expect(carried(r.host)).toContain("1 part of your stored notes couldn't be read and are left out.");
  });
});

describe("compaction and rollback", () => {
  /** A receipt of one of these turns is about 57 tokens: two fit under the limit, three don't, so the fourth turn compacts all but the latest. */
  const tight = (s: Settings): void => void (s.session = { ...s.session, summarizeAtTokens: 140, keepTurns: 1 });

  async function compacted() {
    const r = rig(tight);
    await r.turn();
    await r.exchange("I knock.");
    await r.exchange("I wait.");
    r.summaries.push("Okoro keeps the lighthouse. The door has stayed shut through two visits.");
    const fourth = await r.exchange("I call out.");
    return { ...r, fourth };
  }

  test("past its token setting the session is summarized: the summary lands with the turn's record, and the latest turns stay whole", async () => {
    const r = await compacted();
    const summarizer = r.host.calls.find((c) => c.messages[0]?.content.startsWith(SUMMARIZER));
    expect(summarizer?.tools).toBeUndefined();
    expect(summarizer?.messages[0]?.content).toContain("The latest 1 turn stay whole after your summary");
    expect(summarizer?.messages[1]?.content).toStartWith("The summary so far:\n(none)\n\nThe turns to fold into it, oldest first:\n\nReply #2 (new)");
    expect(summarizer?.messages[1]?.content).toContain('"brief":"brief 2"');
    expect(summarizer?.messages[1]?.content).not.toContain('"brief":"brief 3"');
    // The turn that compacted reads the summary and the turn kept whole.
    expect(carried(r.host)).toStartWith("user: Your notes from this chat's earlier turns, summarized:\nOkoro keeps the lighthouse. The door has stayed shut through two visits.\n\nReply #6 (new)");
    expect(carried(r.host)).not.toContain('"brief":"brief 1"');
    const record = r.fourth.result.record;
    expect(r.host.blobStore.get(record?.summary ?? "")).toBe("Okoro keeps the lighthouse. The door has stayed shut through two visits.");
    expect(record?.folded).toBe(2);
    expect(record?.kept).toHaveLength(1);
    expect(lastSession(r.host)).toMatchObject({ turns: 1, summary: true, compacted: { folded: 2, kept: 1, summary: record?.summary ?? "" } });
    expect(r.fourth.sink.progressLines).toContain("Summarizing its notes from 2 turns…");
    // The turns the summary replaced stay on their own records: nothing was rewritten.
    const turns = await pathTurns(await r.host.chat.path(CHAT));
    expect(turns.map((t) => t.record.summary !== undefined)).toEqual([false, false, false, true]);
  });

  test("the next turn reads from the summary: the kept turn, the compacting turn's own segment, and nothing before", async () => {
    const r = await compacted();
    r.stored.values.session.summarizeAtTokens = null;
    await r.exchange("I listen.");
    expect(lastSession(r.host)).toMatchObject({ turns: 2, summary: true });
    expect(lastSession(r.host)?.compacted).toBeUndefined();
    const text = carried(r.host);
    expect(text).toContain("Okoro keeps the lighthouse.");
    expect(text).toContain('"brief":"brief 3"');
    expect(text).toContain('"brief":"brief 4"');
    expect(text).not.toContain('"brief":"brief 2"');
  });

  test("a summary cut off at its limit never lands: the session goes on whole, and the next turn tries again", async () => {
    const r = rig(tight);
    await r.turn();
    await r.exchange("I knock.");
    await r.exchange("I wait.");
    r.summaries.push({ content: "Okoro keeps the lighthouse and", finishReason: "length" });
    const { result, sink } = await r.exchange("I call out.");
    expect(result.record?.summary).toBeUndefined();
    expect(lastSession(r.host)).toMatchObject({ turns: 3, summary: false });
    expect(sink.progressLines).toContain("Its notes weren't summarized (its summary was cut off at its limit (the summarizer's Answer per call)); they go on whole.");
    r.summaries.push("Okoro keeps the lighthouse.");
    expect((await r.exchange("I call again.")).result.record?.summary).toBeDefined();
  });

  test("a swipe of the turn that compacted finds the summary made: no second call", async () => {
    const r = await compacted();
    const count = (): number => r.host.calls.filter((c) => c.messages[0]?.content.startsWith(SUMMARIZER)).length;
    expect(count()).toBe(1);
    const swipe = await r.turn(CHAT, { kind: "swipe" });
    expect(count()).toBe(1);
    expect(swipe.result.record?.summary).toBe(r.fourth.result.record?.summary ?? "");
  });

  test("a rollback marks the record, and the session reads the turns its summary replaced again", async () => {
    const r = await compacted();
    r.stored.values.session.summarizeAtTokens = null;
    const reply = r.host.last(CHAT);
    const rolled = await rollback(r.host, CHAT, reply.id, reply.swipeId);
    expect("record" in rolled && rolled.record.rolledBack).toBe(r.host.clock.now());
    expect(recordOf(reply.anchors[reply.swipeId])?.rolledBack).toBe(r.host.clock.now());
    await r.exchange("I listen.");
    expect(lastSession(r.host)).toMatchObject({ turns: 4, summary: false, rolledBack: { summary: r.fourth.result.record?.summary ?? "" } });
    const text = carried(r.host);
    for (const n of [1, 2, 3, 4]) expect(text).toContain(`"brief":"brief ${n}"`);
    expect(text).not.toContain("Okoro keeps the lighthouse.");
    expect(text).toContain("The user rolled back a summary of your notes: the turns it had replaced are back as their own receipts.");
  });

  test("a rollback is refused, in plain words, where there is nothing to roll back", async () => {
    const r = await compacted();
    const reply = r.host.last(CHAT);
    const plain = r.host.chats.get(CHAT)![2]!;
    expect(await rollback(r.host, CHAT, plain.id, 0)).toEqual({ refused: "No summary was made at that turn, so there is nothing to roll back." });
    expect(await rollback(r.host, CHAT, "m-gone", 0)).toEqual({ refused: "That reply is no longer on the chat's active path." });
    expect(await rollback(r.host, CHAT, reply.id, 3)).toMatchObject({ refused: expect.stringContaining("shows another swipe") as unknown as string });
    expect(await rollback(r.host, CHAT, reply.id, reply.swipeId)).toHaveProperty("record");
    expect(await rollback(r.host, CHAT, reply.id, reply.swipeId)).toEqual({ refused: "That summary was already rolled back." });
  });
});
