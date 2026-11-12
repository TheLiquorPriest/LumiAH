// Forgetting a chat (DESIGN §20): once Lumiverse no longer has a chat, `harness.chats.forget` removes
// what LumiAH keeps for it (its `learned/` area and its own area's heads, its jobs and their reports,
// its approvals, its side sessions, what was asked of its session, how its lore last stood, its
// search vectors) and nothing of another chat's, and the sweep then takes the texts nothing names.

import { describe, expect, test } from "bun:test";
import { keepApproval } from "../../src/core/approved";
import { createHarness } from "../../src/core/harness";
import { textHash } from "../../src/core/hash";
import { DOC } from "../../src/core/paths";
import type { JsonValue, ModelRequest, StorePort } from "../../src/core/ports";
import { HarnessRefusal } from "../../src/core/refusal";
import { defaultSettings } from "../../src/core/settings";
import { type Answer, call, idle, MemoryHost, runTurn, until } from "./support/host";

/** The chat that is forgotten, and one whose id begins with the same characters: nothing of it may go. */
const GONE = "chat-1";
const KEPT = "chat-10";
const TASK = "Note who holds the lighthouse key.";
const HOUR = 3_600_000;
const never = new AbortController().signal;

const facts = (chat: string): string => `What ${chat} learned: Brann holds the lighthouse key.`;
const report = (chat: string): string => `The report of ${chat}: Okoro keeps the key now.`;
const isJob = (request: ModelRequest): boolean => (request.messages.find((m) => m.role === "user")?.content ?? "").startsWith("You are running as a job");
const hasResults = (request: ModelRequest): boolean => request.messages.at(-1)?.parts?.some((part) => part.type === "tool_result") === true;
const vectors = (owner: "chat" | "book", id: string): string => `recall/vectors/embedder~model~own/${owner}/${id}/0a.json`;

/** A host and a harness; `job` answers a job's calls (a report, unless a test hangs it), and a turn's main agent writes a file to each of the chat's two areas before it has the reply written. */
function rig() {
  const host = new MemoryHost();
  const state = { chat: GONE, job: (chat: string): Answer => report(chat) };
  host.script = (request) => {
    if (isJob(request)) return state.job(state.chat);
    if (!request.tools) return "The door opens.";
    if (hasResults(request)) return { toolCalls: [call("write_reply", { brief: "Okoro opens the door." }, "w1")] };
    return { toolCalls: [call("workspace_write", { path: "learned/facts.md", content: facts(state.chat), base: "new" }, "a1"), call("workspace_write", { path: "/notes/plan.md", content: `The plan of ${state.chat}.`, base: "new" }, "a2")] };
  };
  const stored = { values: defaultSettings(), texts: {} as Record<string, string> };
  const harness = createHarness(host, { settings: async () => structuredClone(stored) });
  /** Everything LumiAH keeps for a chat: a turn's files and records, an approval, an asked summary, a job that ran and one that waits, a side session, and vectors. */
  const fill = async (chat: string): Promise<{ done: string; waiting: string; side: string }> => {
    state.chat = chat;
    host.say(chat, "assistant", "The harbour is quiet tonight.");
    host.say(chat, "user", "I walk down to the lighthouse and knock.");
    await runTurn(host, harness, chat);
    await keepApproval(host, chat, "workspace_write");
    await harness.session.summarize({ chatId: chat });
    const done = (await harness.jobs.start({ chatId: chat, agent: "summarizer", task: TASK, when: "now" })).job.id;
    await harness.jobs.run({ id: done }, never);
    const waiting = (await harness.jobs.start({ chatId: chat, agent: "summarizer", task: TASK, when: "now" })).job.id;
    const side = (await harness.sides.start({ chatId: chat })).side.id;
    host.documents.set(vectors("chat", chat), { v: 1, dims: 0, vectors: {} });
    await idle();
    return { done, waiting, side };
  };
  const paths = (): string[] => [...host.documents.keys()].sort();
  return { host, harness, state, fill, paths };
}

async function refusal(asked: Promise<unknown>): Promise<{ code: string; message: string }> {
  try {
    await asked;
  } catch (error) {
    if (error instanceof HarnessRefusal) return { code: error.code, message: error.message };
    throw error;
  }
  throw new Error("the request wasn't refused");
}

describe("forgetting a chat", () => {
  test("removes everything kept for it and nothing of another chat's; the sweep then takes the texts nothing names", async () => {
    const r = rig();
    const gone = await r.fill(GONE);
    const kept = await r.fill(KEPT);
    // A world book whose id is the chat's: its vectors are a book's, not the chat's.
    r.host.documents.set(vectors("book", GONE), { v: 1, dims: 0, vectors: {} });
    const mine = (path: string): boolean => path.startsWith(`chats/${GONE}/`) || path === vectors("chat", GONE) || [`jobs/${gone.done}.json`, `jobs/${gone.waiting}.json`, `sides/${gone.side}.json`].includes(path);
    const before = new Map<string, JsonValue>(structuredClone([...r.host.documents]));
    expect(r.paths().filter(mine)).toEqual(
      [`chats/${GONE}/approvals.json`, `chats/${GONE}/jobs.json`, `chats/${GONE}/learned.json`, `chats/${GONE}/recall.json`, `chats/${GONE}/session.json`, vectors("chat", GONE), `jobs/${gone.done}.json`, `jobs/${gone.waiting}.json`, `sides/${gone.side}.json`, ...r.paths().filter((path) => path.startsWith(`chats/${GONE}/area/`))].sort(),
    );
    expect(r.paths().filter((path) => path.startsWith(`chats/${GONE}/area/`)).length).toBeGreaterThan(0);

    // Lumiverse deletes the chat, and the backend asks the core to forget it.
    r.host.chats.delete(GONE);
    const forgot = await r.harness.chats.forget({ chatId: GONE });
    await idle();
    expect(r.paths().filter(mine)).toEqual([]);
    expect(forgot).toEqual({ documents: [...before.keys()].filter(mine).length, jobs: 2, sides: 1 });

    // Every other document is as it was, but for the three lists that named the chat's jobs and side session.
    const lists = ["jobs/all.json", "jobs/running.json", "sides.json"];
    for (const [path, doc] of before) if (!mine(path) && !lists.includes(path)) expect([path, r.host.documents.get(path)]).toEqual([path, doc]);
    expect(r.host.documents.get("jobs/all.json")).toMatchObject({ kind: "job_ids", jobs: [{ id: kept.done, chatId: KEPT }, { id: kept.waiting, chatId: KEPT }] });
    expect(r.host.documents.get("jobs/running.json")).toMatchObject({ kind: "running", ids: [kept.waiting] });
    expect((await r.harness.sides.list({})).sides.map((side) => side.id)).toEqual([kept.side]);
    expect((await refusal(r.harness.jobs.read({ id: gone.done }))).code).toBe("not_found");
    expect((await r.harness.jobs.list({ chatId: GONE, cursor: null, limit: 10 })).jobs).toEqual([]);
    expect((await r.harness.jobs.list({ chatId: null, cursor: null, limit: 10 })).jobs.map((job) => job.id)).toEqual([kept.waiting, kept.done]);
    expect((await r.harness.approvals.kept({ chatId: null })).kept.map((row) => row.chatId)).toEqual([KEPT]);
    // Nothing of it is answered from memory either, and the other chat reads as before.
    expect((await r.harness.workspace.list({ chatId: GONE, area: "learned" })).files).toEqual([]);
    expect((await r.harness.workspace.read({ chatId: KEPT, area: "learned", path: "facts.md" })).text).toBe(facts(KEPT));
    expect((await r.harness.workspace.read({ chatId: KEPT, area: "chat", path: "notes/plan.md" })).text).toBe(`The plan of ${KEPT}.`);
    expect((await r.harness.jobs.read({ id: kept.done })).report).toBe(report(KEPT));

    // The texts are still stored until the sweep: nothing names the forgotten chat's any more, so past the grace time they go.
    expect(r.host.blobStore.has(await textHash(facts(GONE)))).toBe(true);
    r.host.clock.advance(25 * HOUR);
    await r.harness.upkeep.sweep();
    for (const text of [facts(GONE), `The plan of ${GONE}.`, report(GONE)]) expect([text, r.host.blobStore.has(await textHash(text))]).toEqual([text, false]);
    for (const text of [facts(KEPT), `The plan of ${KEPT}.`, report(KEPT)]) expect([text, r.host.blobStore.has(await textHash(text))]).toEqual([text, true]);
  });

  test("cancels a job of the chat that is running, and the job writes nothing back once it has ended", async () => {
    const r = rig();
    r.state.job = () => ({ hang: true });
    r.host.say(GONE, "user", "I walk down to the lighthouse and knock.");
    const id = (await r.harness.jobs.start({ chatId: GONE, agent: "summarizer", task: TASK, when: "now" })).job.id;
    const running = r.harness.jobs.run({ id }, never);
    await until(() => r.host.calls.some(isJob));
    r.host.chats.delete(GONE);
    expect(await r.harness.chats.forget({ chatId: GONE })).toMatchObject({ jobs: 1, sides: 0 });
    expect((await running).state).toBe("cancelled");
    await idle();
    expect(r.paths().filter((path) => path.includes(GONE) || path === `jobs/${id}.json`)).toEqual([]);
    expect(r.host.documents.get("jobs/all.json")).toMatchObject({ jobs: [] });
    expect(r.host.documents.get("jobs/running.json")).toMatchObject({ ids: [] });
  });

  test("is refused in words while a reply is being worked on in the chat, and changes nothing then", async () => {
    const r = rig();
    await r.fill(GONE);
    r.host.say(GONE, "user", "I wait.");
    r.host.script = () => ({ hang: true });
    const made = r.host.calls.length;
    const stop = new AbortController();
    const turn = runTurn(r.host, r.harness, GONE, { signal: stop.signal });
    await until(() => r.host.calls.length > made);
    const before = r.paths();
    expect(await refusal(r.harness.chats.forget({ chatId: GONE }))).toEqual({ code: "conflict", message: "A reply or a side session's answer is being worked on in that chat. Stop it or let it end, then forget the chat." });
    expect(r.paths()).toEqual(before);
    stop.abort(new Error("stopped by the user"));
    await turn;
    expect((await r.harness.chats.forget({ chatId: GONE })).documents).toBeGreaterThan(0);
    expect(r.paths().filter((path) => path.startsWith(`chats/${GONE}/`))).toEqual([]);
    expect(await refusal(r.harness.chats.forget({ chatId: "" }))).toEqual({ code: "bad_request", message: "Say which chat to forget." });
  });

  test("on a store that can't list its documents, removes those the chat's id names and says what it left", async () => {
    const r = rig();
    await r.fill(GONE);
    // The port's `list` is optional: this host has none.
    const store: StorePort = r.host.store;
    delete store.list;
    r.host.chats.delete(GONE);
    await r.harness.chats.forget({ chatId: GONE });
    expect(r.paths().filter((path) => path.startsWith(`chats/${GONE}/`) && !path.startsWith(`chats/${GONE}/area/`) && path !== `chats/${GONE}/recall.json`)).toEqual([]);
    expect(r.paths().filter((path) => path.startsWith("jobs/") && !["jobs/all.json", "jobs/running.json"].includes(path))).toEqual([]);
    expect(r.host.logs.some((line) => line.message.includes("can't list its documents") && line.message.includes(GONE))).toBe(true);
  });
});
