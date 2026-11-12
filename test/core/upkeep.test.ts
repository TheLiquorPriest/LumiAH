// Upkeep (DESIGN §20) on an in-memory host, with records and documents made by hand over blobs the
// core's own writers store: what a sweep keeps because something refers to it, what it removes
// because nothing does or because Settings no longer keep it, what it leaves alone within the grace
// time, and what the page is told is stored.

import { describe, expect, test } from "bun:test";
import { Blobs } from "../../src/core/blobs";
import { DOC, ROOT_AREA } from "../../src/core/paths";
import type { JobView, JsonValue, ModelMessage, TurnRecord } from "../../src/core/ports";
import { readCallPrompt } from "../../src/core/prompts";
import { HarnessRefusal } from "../../src/core/refusal";
import { pathHashes, type SessionSegment, Sessions } from "../../src/core/sessions";
import { defaultSettings, type Settings } from "../../src/core/settings";
import type { JobDoc, SideDoc } from "../../src/core/stored";
import type { PastTurn } from "../../src/core/tools";
import { TurnTrace } from "../../src/core/transcript";
import { Upkeep, type UpkeepSummary } from "../../src/core/upkeep";
import { emptyUsage } from "../../src/core/usage";
import type { AreaDoc, AreaIndex, FileVersion } from "../../src/core/workspace";
import { MemoryHost, until } from "./support/host";

const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const CHAT = "chat-1";

/**
 * A host at noon UTC on the first of May 2026, the keep times a test changes, and an `Upkeep` over
 * them; with what a test builds by hand: turns with their records, transcripts with their prompts,
 * workspace indexes with their files.
 */
function rig(change: (keep: Settings["keep"]) => void = () => undefined) {
  const host = new MemoryHost();
  host.clock.t = Date.UTC(2026, 4, 1, 12);
  const keep = defaultSettings().keep;
  change(keep);
  const blobs = new Blobs(host, () => 0);
  const sessions = new Sessions(host, blobs);
  const upkeep = new Upkeep({ host, blobs, keep: () => keep });
  let turns = 0;

  /**
   * One turn of a chat: the user speaks, the reply is saved, and the turn's record, made now, is
   * anchored on it. Its segment is a blob of its own; `fields` are whatever else the record holds.
   */
  async function turn(chatId: string, fields: Partial<TurnRecord> = {}) {
    const n = ++turns;
    host.say(chatId, "user", `Mara asks after the lighthouse, ${n}.`);
    const messageId = host.say(chatId, "assistant", `Joss answers, ${n}.`);
    const path = await host.chat.path(chatId);
    const reply = path.length - 1;
    const notes: SessionSegment = { v: 1, kind: "segment", reply, generationId: `gen-${n}`, turn: "new", at: host.clock.now(), request: { messages: reply, last: reply - 1 }, steps: [{ kind: "said", text: `Notes of turn ${n}.` }] };
    const segment = await sessions.segment(notes);
    const record: TurnRecord = { v: 1, generationId: `gen-${n}`, kind: "new", at: host.clock.now(), path: (await pathHashes(path))[reply] ?? "", segment, usage: emptyUsage(), ...fields };
    host.anchorOn(host.message(chatId, messageId), 0, record as unknown as JsonValue);
    const past: PastTurn = { reply, hash: segment, segment: notes };
    return { messageId, record, segment, past };
  }

  /** The transcript of a run in which one agent made `calls` model calls, as a run's trace writes it, each call's exact prompt kept: the transcript's blob, and the prompts'. */
  async function transcript(run: string, calls = 2) {
    const trace = new TurnTrace(host, { turn: run, chatId: CHAT }, blobs, true);
    const messages: ModelMessage[] = [{ role: "system", content: `You look things up for ${run}.` }];
    const prompts: string[] = [];
    for (let i = 1; i <= calls; i++) {
      messages.push({ role: "user", content: `Round ${i} of ${run}.` });
      const prompt = await trace.prompt("agent_1", { messages: [...messages], maxTokens: 800, connectionId: "conn-main", model: null });
      if (prompt === undefined) throw new Error("the call's prompt wasn't kept");
      prompts.push(prompt);
      trace.entry("agent_1", { kind: "answer", text: `Answer ${i}.`, calls: [], written: false, tools: "none", usage: { in: 10, cachedIn: 0, out: 5, reasoningOut: 0, estimated: [] }, model: "model-main", finishReason: "stop", ms: 5, at: host.clock.now(), prompt });
      messages.push({ role: "assistant", content: `Answer ${i}.` });
    }
    const whole = trace.transcript({ generation: "new", messageId: null, startedAt: host.clock.now(), ended: { status: "done", at: host.clock.now() } });
    return { hash: await blobs.putJson(whole, false), prompts };
  }

  /** An area's index: each file by its path, with its text now and the texts it had before, the newest first. The index's blob, and every body's. */
  async function index(files: Record<string, string[]>) {
    const bodies: string[] = [];
    const version = async (text: string): Promise<FileVersion> => {
      const hash = await blobs.put(text);
      bodies.push(hash);
      return { hash, chars: text.length, at: host.clock.now(), by: { who: "user" } };
    };
    const entries: AreaIndex["files"] = {};
    for (const [path, [now = "", ...before]] of Object.entries(files)) {
      const was: FileVersion[] = [];
      for (const text of before) was.push(await version(text));
      entries[path] = { ...(await version(now)), was, pins: [] };
    }
    const whole: AreaIndex = { v: 1, kind: "index", files: entries };
    return { hash: await blobs.putJson(whole as unknown as JsonValue), bodies };
  }

  /** A chat's session after a compaction: three turns, then a fourth that summarized the first two and keeps the third whole, and a fifth after it. */
  async function compacted() {
    const one = await turn(CHAT);
    const two = await turn(CHAT);
    const three = await turn(CHAT);
    const landed = await sessions.compact("Okoro keeps the lighthouse. Mara has asked twice.", [three.past], 2);
    const four = await turn(CHAT, landed);
    const five = await turn(CHAT);
    return { four, five, summary: landed.summary, segments: [one.segment, two.segment, three.segment, four.segment, five.segment] };
  }

  const sweep = (): Promise<UpkeepSummary> => upkeep.sweep(new AbortController().signal);
  /** Which of these blobs are still stored. */
  const stored = (...hashes: string[]): boolean[] => hashes.map((hash) => host.blobStore.has(hash));
  /** How big these blobs are together, as stored. */
  const bytes = (...hashes: string[]): number => hashes.reduce((n, hash) => n + new TextEncoder().encode(host.blobStore.get(hash) ?? "").length, 0);
  return { host, keep, blobs, upkeep, turn, transcript, index, compacted, sweep, stored, bytes };
}

/** A kind's row of a summary, without the setting that keeps it. */
const row = (summary: UpkeepSummary, kind: string) => {
  const found = summary.kinds.find((k) => k.kind === kind);
  return found ? { count: found.count, bytes: found.bytes } : null;
};

describe("a blob nothing refers to", () => {
  test("is kept while it is younger than the grace time, and removed once it is older", async () => {
    const r = rig();
    const old = await r.blobs.put("A draft that no record ever named.");
    r.host.clock.advance(23 * HOUR);
    const young = await r.blobs.put("What a run still under way has stored so far.");
    // Nothing is 24 hours old yet: a run may still be about to write the record that names either.
    expect((await r.sweep()).lastSweep).toMatchObject({ removed: 0, bytes: 0 });
    expect(r.stored(old, young)).toEqual([true, true]);
    r.host.clock.advance(HOUR);
    const size = r.bytes(old);
    const swept = await r.sweep();
    expect(r.stored(old, young)).toEqual([false, true]);
    expect(swept.lastSweep).toEqual({ at: r.host.clock.now(), removed: 1, bytes: size, ms: 0 });
    // What is left that nothing refers to is what the grace time still covers.
    expect(swept.loose).toEqual({ count: 1, bytes: r.bytes(young), at: r.host.clock.now() });
    expect(swept.total).toEqual({ count: 1, bytes: r.bytes(young) });
    expect(r.host.logs.at(-1)).toMatchObject({ level: "info" });
    expect(r.host.logs.at(-1)?.message).toContain("the sweep removed 1 stored texts");
  });

  test("is removed in batches no bigger than the host's own pages", async () => {
    const r = rig();
    for (let i = 1; i <= 7; i++) await r.blobs.put(`Stray text ${i}.`);
    r.host.clock.advance(2 * DAY);
    const batches: number[] = [];
    const remove = r.host.blobs.remove;
    r.host.blobs.remove = async (hashes) => {
      batches.push(hashes.length);
      return remove(hashes);
    };
    expect((await r.sweep()).lastSweep?.removed).toBe(7);
    expect(batches).toEqual([3, 3, 1]);
    expect(r.host.blobStore.size).toBe(0);
  });
});

describe("what a record refers to is kept", () => {
  test("its segment, its summary and the segments it keeps whole, its transcript and each call's prompt, its workspace index with every file's body and earlier versions, and its jobs' reports", async () => {
    const r = rig();
    const summary = await r.blobs.put("Okoro keeps the lighthouse. The door has stayed shut through two visits.");
    const keptWhole = await r.blobs.put("The notes of an earlier turn, which the summary keeps whole.");
    const run = await r.transcript("gen-1", 3);
    const area = await r.index({ "notes/plan.md": ["Ask Okoro about the lamp oil.", "Ask Okoro.", "Ask someone."], "people.md": ["Ilse rows the mail boat."] });
    const report = await r.blobs.put("Brann read the whole chat: the lamp oil was never delivered.");
    const made = await r.turn(CHAT, { summary, kept: [keptWhole], folded: 2, transcript: run.hash, workspace: area.hash, jobs: [{ id: "job-1", agent: "summarizer", state: "done", report }, { id: "job-2", agent: "summarizer", state: "running" }] });
    const stray = await r.blobs.put("A version of the plan that its history no longer keeps.");
    r.host.clock.advance(25 * HOUR);

    const swept = await r.sweep();
    const all = [made.segment, summary, keptWhole, run.hash, ...run.prompts, area.hash, ...area.bodies, report];
    expect(r.stored(...all)).toEqual(all.map(() => true));
    expect(r.stored(stray)).toEqual([false]);
    expect(swept.lastSweep?.removed).toBe(1);
    // Each call's prompt can still be read whole, the ones it builds on with it.
    expect((await readCallPrompt(r.host.blobs, run.prompts[2] ?? ""))?.messages).toHaveLength(6);

    expect(row(swept, "segment")).toEqual({ count: 2, bytes: r.bytes(made.segment, keptWhole) });
    expect(row(swept, "summary")).toEqual({ count: 1, bytes: r.bytes(summary) });
    expect(row(swept, "transcript")).toEqual({ count: 1, bytes: r.bytes(run.hash) });
    expect(row(swept, "prompt")).toEqual({ count: 3, bytes: r.bytes(...run.prompts) });
    expect(row(swept, "index")).toEqual({ count: 1, bytes: r.bytes(area.hash) });
    expect(row(swept, "file")).toEqual({ count: 4, bytes: r.bytes(...area.bodies) });
    expect(row(swept, "report")).toEqual({ count: 1, bytes: r.bytes(report) });
    expect(row(swept, "side")).toEqual({ count: 0, bytes: 0 });
    expect(swept.total).toEqual({ count: all.length, bytes: r.bytes(...all) });
    expect(swept.loose).toMatchObject({ count: 0, bytes: 0 });
  });

  test("on a swipe the chat doesn't show, and on a reply an edit took off the path", async () => {
    const r = rig();
    const first = await r.turn(CHAT);
    const shown = await r.turn(CHAT);
    // The second reply has another swipe, with a record and a transcript of its own, and the chat shows the first.
    const other = await r.transcript("gen-swipe", 1);
    const notes = await r.blobs.put("The notes of the swipe that isn't shown.");
    const reply = r.host.message(CHAT, shown.messageId);
    reply.swipes.push("Joss answers another way.");
    r.host.anchorOn(reply, 1, { ...shown.record, generationId: "gen-swipe", kind: "swipe", segment: notes, transcript: other.hash } as unknown as JsonValue);
    // And the user rewrites their first message: both replies' records no longer fit the path.
    r.host.edit(CHAT, r.host.chats.get(CHAT)?.[0]?.id ?? "", "Mara asks after the harbour instead.");
    r.host.clock.advance(3 * DAY);
    expect((await r.sweep()).lastSweep?.removed).toBe(0);
    expect(r.stored(first.segment, shown.segment, notes, other.hash, ...other.prompts)).toEqual([true, true, true, true, true]);
  });

  test("and what isn't a record refers to nothing", async () => {
    const r = rig();
    const named = await r.blobs.put("Named by something that isn't a record of LumiAH's.");
    const made = await r.turn(CHAT);
    const message = r.host.message(CHAT, r.host.chats.get(CHAT)?.[0]?.id ?? "");
    r.host.anchorOn(message, 0, { v: 1, note: "written by something else", segment: named, transcript: named });
    r.host.clock.advance(2 * DAY);
    await r.sweep();
    expect(r.stored(named, made.segment)).toEqual([false, true]);
  });
});

describe("what Settings keep for a time", () => {
  test("a call's prompts go past Prompts kept for, the transcript past Transcripts kept for, and the turn's segment stays", async () => {
    const r = rig();
    const run = await r.transcript("gen-1");
    const made = await r.turn(CHAT, { transcript: run.hash });
    r.host.clock.advance(30 * DAY - 1);
    expect((await r.sweep()).lastSweep?.removed).toBe(0);
    // Thirty days after the turn ended, its prompts are no longer kept.
    r.host.clock.advance(1);
    const first = await r.sweep();
    expect(r.stored(...run.prompts, run.hash, made.segment)).toEqual([false, false, true, true]);
    expect(first.lastSweep?.removed).toBe(2);
    expect(row(first, "prompt")).toEqual({ count: 0, bytes: 0 });
    expect(row(first, "transcript")?.count).toBe(1);
    r.host.clock.advance(60 * DAY - 1);
    expect((await r.sweep()).lastSweep?.removed).toBe(0);
    r.host.clock.advance(1);
    expect((await r.sweep()).lastSweep?.removed).toBe(1);
    expect(r.stored(run.hash, made.segment)).toEqual([false, true]);
  });

  test("for good where the setting is none", async () => {
    const r = rig((keep) => {
      keep.promptDays = null;
      keep.transcriptDays = null;
    });
    const run = await r.transcript("gen-1");
    await r.turn(CHAT, { transcript: run.hash });
    r.host.clock.advance(4000 * DAY);
    expect((await r.sweep()).lastSweep?.removed).toBe(0);
    expect(r.stored(run.hash, ...run.prompts)).toEqual([true, true, true]);
  });

  test("a prompt is kept no longer than the transcript that names it, and as long as any transcript that does is young enough", async () => {
    const r = rig((keep) => void (keep.transcriptDays = 10));
    const old = await r.transcript("gen-old");
    await r.turn(CHAT, { transcript: old.hash });
    r.host.clock.advance(8 * DAY);
    // A later turn made the same first call: its prompt is the same blob.
    const young = await r.transcript("gen-old", 1);
    expect(young.prompts[0]).toBe(old.prompts[0] ?? "");
    await r.turn(CHAT, { transcript: young.hash });
    r.host.clock.advance(3 * DAY);
    await r.sweep();
    expect(r.stored(old.hash, old.prompts[1] ?? "", young.hash, young.prompts[0] ?? "")).toEqual([false, false, true, true]);
  });
});

describe("the segments a compaction replaced", () => {
  test("are removed once the summary is older than Summarized turns kept for, and the rest of the session stays", async () => {
    const r = rig((keep) => void (keep.spanDays = 7));
    const c = await r.compacted();
    r.host.clock.advance(7 * DAY - 1);
    expect((await r.sweep()).lastSweep?.removed).toBe(0);
    r.host.clock.advance(1);
    const swept = await r.sweep();
    // The two it replaced are gone; the one it keeps whole, its own and the one after it are what the session reads.
    expect(r.stored(...c.segments, c.summary)).toEqual([false, false, true, true, true, true]);
    expect(swept.lastSweep?.removed).toBe(2);
    expect(row(swept, "segment")?.count).toBe(3);
  });

  test("are kept for good where the setting is none", async () => {
    const r = rig();
    const c = await r.compacted();
    r.host.clock.advance(4000 * DAY);
    expect((await r.sweep()).lastSweep?.removed).toBe(0);
    expect(r.stored(...c.segments)).toEqual([true, true, true, true, true]);
  });

  test("are kept while another chat's path still reads them: a branch made before the summary", async () => {
    const r = rig((keep) => void (keep.spanDays = 7));
    const c = await r.compacted();
    // The branch holds the first two turns, records and all, and no summary: its session reads their segments.
    r.host.branch(CHAT, 4, "chat-branch");
    r.host.clock.advance(30 * DAY);
    expect((await r.sweep()).lastSweep?.removed).toBe(0);
    expect(r.stored(...c.segments)).toEqual([true, true, true, true, true]);
    // The branch deleted, nothing reads them any more.
    r.host.chats.delete("chat-branch");
    expect((await r.sweep()).lastSweep?.removed).toBe(2);
    expect(r.stored(...c.segments)).toEqual([false, false, true, true, true]);
  });

  test("are gone from a branch too when the branch was made after the summary", async () => {
    const r = rig((keep) => void (keep.spanDays = 7));
    const c = await r.compacted();
    r.host.branch(CHAT, 10, "chat-branch");
    r.host.clock.advance(30 * DAY);
    await r.sweep();
    expect(r.stored(...c.segments)).toEqual([false, false, true, true, true]);
  });

  test("are kept when the summary was rolled back, or stands on a swipe the chat doesn't show, or is off the path", async () => {
    const rolled = rig((keep) => void (keep.spanDays = 7));
    const a = await rolled.compacted();
    rolled.host.anchorOn(rolled.host.message(CHAT, a.four.messageId), 0, { ...a.four.record, rolledBack: rolled.host.clock.now() } as unknown as JsonValue);
    rolled.host.clock.advance(30 * DAY);
    expect((await rolled.sweep()).lastSweep?.removed).toBe(0);

    const swiped = rig((keep) => void (keep.spanDays = 7));
    const b = await swiped.compacted();
    const reply = swiped.host.message(CHAT, b.four.messageId);
    const notes = await swiped.blobs.put("The notes of a swipe that summarized nothing.");
    reply.swipes.push("Joss answers another way.");
    swiped.host.anchorOn(reply, 1, { ...b.four.record, generationId: "gen-swipe", segment: notes, summary: undefined, kept: undefined, folded: undefined } as unknown as JsonValue);
    swiped.host.show(CHAT, reply.id, 1);
    swiped.host.clock.advance(30 * DAY);
    expect((await swiped.sweep()).lastSweep?.removed).toBe(0);
    expect(swiped.stored(...b.segments, notes)).toEqual([true, true, true, true, true, true]);

    const edited = rig((keep) => void (keep.spanDays = 7));
    const c = await edited.compacted();
    // The third turn's question is rewritten: the summary's record no longer fits the path, and the session reads the first two turns again.
    edited.host.edit(CHAT, edited.host.chats.get(CHAT)?.[4]?.id ?? "", "Mara asks something else.");
    edited.host.clock.advance(30 * DAY);
    expect((await edited.sweep()).lastSweep?.removed).toBe(0);
    expect(edited.stored(...c.segments)).toEqual([true, true, true, true, true]);
  });

  test("only up to the latest summary that stands, whatever an earlier one replaced", async () => {
    const r = rig((keep) => void (keep.spanDays = 7));
    const c = await r.compacted();
    r.host.clock.advance(30 * DAY);
    // A second summary, made now: it replaced everything before it but the turn it keeps whole, and it is young.
    const later = await r.blobs.put("Okoro keeps the lighthouse; the lamp oil is late.");
    const six = await r.turn(CHAT, { summary: later, kept: [c.five.segment], folded: 2 });
    expect((await r.sweep()).lastSweep?.removed).toBe(0);
    r.host.clock.advance(7 * DAY);
    await r.sweep();
    // The third turn's segment stays: the first summary's record still keeps it whole.
    expect(r.stored(...c.segments, six.segment, c.summary, later)).toEqual([false, false, true, false, true, true, true, true]);
  });
});

describe("the store's documents keep what they name", () => {
  const job = (fields: Partial<JobView>): JobView => ({ id: "job-1", chatId: CHAT, agent: "summarizer", task: "Read the whole chat.", when: "after_reply", state: "done", by: { who: "user" }, basis: null, createdAt: 0, usage: emptyUsage(), ...fields });

  test("area heads, job documents and side sessions", async () => {
    const r = rig();
    const now = r.host.clock.now();
    const user = await r.index({ "GUIDANCE.md": ["Write plainly.", "Write."] });
    const learned = await r.index({ "GUIDANCE.md": ["Okoro never lies."] });
    const root = await r.index({ "notes.md": ["Before any turn."] });
    const later = await r.index({ "notes.md": ["After the first turn.", "Before any turn."] });
    const head = (hash: string | null): JsonValue => ({ v: 1, kind: "area", head: hash, at: now }) satisfies AreaDoc;
    r.host.documents.set(DOC.userArea, head(user.hash));
    r.host.documents.set(DOC.learned(CHAT), head(learned.hash));
    r.host.documents.set(DOC.chatArea(CHAT, ROOT_AREA), head(root.hash));
    r.host.documents.set(DOC.chatArea(CHAT, "gen-1"), head(later.hash));
    r.host.documents.set(DOC.learned("chat-empty"), head(null));

    const report = await r.blobs.put("Brann read the whole chat: nothing was promised.");
    const session = await r.blobs.putJson([{ role: "user", content: "Read the whole chat." }, { role: "assistant", content: "Brann has read up to message 400." }]);
    const jobRun = await r.transcript("job-1");
    r.host.documents.set(DOC.job("job-1"), { v: 1, kind: "job", job: job({ createdAt: now, startedAt: now, endedAt: now, report, transcript: jobRun.hash }), task: "Read the whole chat.", session } satisfies JobDoc as unknown as JsonValue);
    // The lists of jobs name the same blobs and are no job's own document.
    r.host.documents.set(DOC.allJobs, { v: 1, kind: "job_ids", jobs: [{ id: "job-1", chatId: CHAT, at: now }] });
    r.host.documents.set(DOC.runningJobs, { v: 1, kind: "running", ids: [] });

    const asked = await r.blobs.put("Ilse asks what the agent has noted about the harbour.");
    const answered = await r.blobs.put("Three things, the lamp oil first.");
    const unanswered = await r.blobs.put("Ilse asks again.");
    const notes = await r.blobs.put("The notes of the side session's first turn.");
    const recap = await r.blobs.put("So far: Ilse asked about the harbour.");
    const sideRun = await r.transcript("side-turn-1");
    const side: SideDoc = { v: 1, kind: "side", id: "side-1", chatId: CHAT, agent: "main", title: "Ilse asks", createdAt: now, lastAt: now, summary: { text: recap, turns: 1 }, turns: [{ turn: "side-turn-1", at: now, asked, answered, status: "done", segment: notes, transcript: sideRun.hash, usage: emptyUsage() }, { turn: "side-turn-2", at: now, asked: unanswered, answered: null, status: "failed", reason: "the call failed", usage: emptyUsage() }] };
    r.host.documents.set(DOC.side("side-1"), side as unknown as JsonValue);
    r.host.documents.set(DOC.sides, { v: 1, kind: "sides", sides: [] });

    const stray = await r.blobs.put("An index's body that no head points at any more.");
    r.host.clock.advance(25 * HOUR);
    const swept = await r.sweep();
    const all = [user.hash, ...user.bodies, learned.hash, ...learned.bodies, root.hash, ...root.bodies, later.hash, ...later.bodies, report, session, jobRun.hash, ...jobRun.prompts, asked, answered, unanswered, notes, recap, sideRun.hash, ...sideRun.prompts];
    expect(r.stored(...all)).toEqual(all.map(() => true));
    expect(r.stored(stray)).toEqual([false]);
    expect(swept.lastSweep?.removed).toBe(1);
    expect(row(swept, "index")?.count).toBe(4);
    // "Before any turn." is one body, however many indexes hold it.
    expect(row(swept, "file")?.count).toBe(5);
    expect(row(swept, "report")?.count).toBe(1);
    expect(row(swept, "session")).toEqual({ count: 1, bytes: r.bytes(session) });
    expect(row(swept, "transcript")?.count).toBe(2);
    expect(row(swept, "prompt")?.count).toBe(4);
    expect(row(swept, "segment")?.count).toBe(1);
    expect(row(swept, "side")).toEqual({ count: 4, bytes: r.bytes(asked, answered, unanswered, recap) });

    // A job's and a side turn's transcripts are kept by the same two settings, counted from when each ended; the rest for as long as its document is there.
    r.host.clock.advance(90 * DAY);
    await r.sweep();
    expect(r.stored(jobRun.hash, ...jobRun.prompts, sideRun.hash, ...sideRun.prompts)).toEqual([false, false, false, false, false, false]);
    expect(r.stored(report, session, asked, answered, notes, recap, user.hash)).toEqual([true, true, true, true, true, true, true]);
    r.host.documents.delete(DOC.job("job-1"));
    await r.sweep();
    expect(r.stored(report, session, asked)).toEqual([false, false, true]);
  });

  test("what built-in mode left (turns that waited for their replies, its own list of the jobs it ran) is removed by a sweep, damaged or not, with what only it named; a count removes nothing", async () => {
    const r = rig();
    const draft = await r.blobs.put("The notes of a turn that waited for its reply.");
    const report = await r.blobs.put("The report of a job the turn started.");
    const handed = await r.index({ "notes.md": ["As it stood at the hand-over."] });
    const named = [draft, report, handed.hash, ...handed.bodies];
    // Built in stored them before this build: older than the grace time.
    r.host.clock.advance(25 * HOUR);
    const at = r.host.clock.now();
    const left: Record<string, JsonValue> = {
      "pending/gen-waiting.json": { v: 1, kind: "pending", at, until: null, userId: "user-1", chatId: CHAT, generationId: "gen-waiting", turn: "new", began: at, path: "", draft, replied: [], asBrief: null, basis: null, workspace: handed.hash, jobs: [{ id: "job-1", agent: "summarizer", state: "done", report }] },
      "pending/gen-damaged.json": { v: 1, kind: "pending", chatId: CHAT },
      "jobs/running.builtin.json": { v: 1, kind: "running", ids: ["job-1"] },
    };
    for (const [path, doc] of Object.entries(left)) r.host.documents.set(path, doc);
    // The runtime's own list of running jobs is no leftover.
    r.host.documents.set(DOC.runningJobs, { v: 1, kind: "running", ids: [] });
    const paths = [...Object.keys(left), DOC.runningJobs];

    // A count only looks.
    await r.upkeep.get();
    expect(paths.map((path) => r.host.documents.has(path))).toEqual([true, true, true, true]);
    expect(r.stored(...named)).toEqual(named.map(() => true));

    // A sweep removes each document whole, and what only they named with them, as anything nothing names.
    expect((await r.sweep()).lastSweep).toMatchObject({ removed: new Set(named).size });
    expect(paths.map((path) => r.host.documents.has(path))).toEqual([false, false, false, true]);
    expect(r.stored(...named)).toEqual(named.map(() => false));
  });

  test("a document or a blob that doesn't read as what it should be refers to nothing, and the sweep goes on", async () => {
    const r = rig();
    const now = r.host.clock.now();
    const text = await r.blobs.put("Plain text where an index should be.");
    const wrong = await r.blobs.put("Named by a document that isn't a job's.");
    const kept = await r.blobs.put("A report a real job's document names.");
    const made = await r.turn(CHAT, { workspace: text, transcript: text });
    // A record that names its transcript as its workspace too: read as an index it holds no file, and as a transcript it still names its prompts.
    const run = await r.transcript("gen-2");
    await r.turn(CHAT, { workspace: run.hash, transcript: run.hash });
    r.host.documents.set(DOC.job("job-odd"), { v: 2, kind: "job", job: { report: wrong } });
    r.host.documents.set(DOC.side("side-odd"), ["not", "a", "side", "session"]);
    r.host.documents.set(DOC.userArea, { v: 1, kind: "area", head: "not a hash", at: now });
    r.host.documents.set(DOC.job("job-1"), { v: 1, kind: "job", job: job({ createdAt: now, report: kept }), task: "Read." } satisfies JobDoc as unknown as JsonValue);
    r.host.clock.advance(2 * DAY);
    const swept = await r.sweep();
    expect(r.stored(wrong, kept, made.segment, text, run.hash, ...run.prompts)).toEqual([false, true, true, true, true, true, true]);
    // A blob a record names twice is counted once, under the kind listed first.
    expect([row(swept, "transcript")?.count, row(swept, "index")?.count, row(swept, "prompt")?.count]).toEqual([2, 0, 2]);
  });

  test("a read that fails ends the sweep with nothing removed", async () => {
    const r = rig();
    const stray = await r.blobs.put("Nothing names this.");
    r.host.documents.set(DOC.job("job-1"), { v: 1, kind: "job", job: job({}), task: "Read." } satisfies JobDoc as unknown as JsonValue);
    r.host.clock.advance(2 * DAY);
    const read = r.host.store.read;
    r.host.store.read = async (path) => {
      if (path === DOC.job("job-1")) throw new Error("the store timed out");
      return read(path);
    };
    await expect(r.sweep()).rejects.toThrow("the store timed out");
    expect(r.stored(stray)).toEqual([true]);
    r.host.store.read = read;
    expect((await r.sweep()).lastSweep?.removed).toBe(1);
  });
});

describe("a sweep", () => {
  test("is refused as unavailable on a host that can't list or remove what is stored, in words that say what is missing", async () => {
    const lacking = (...missing: ["blobs" | "store" | "chat", "list" | "remove" | "anchors"][]) => {
      const r = rig();
      for (const [port, method] of missing) Reflect.deleteProperty(r.host[port], method);
      return r;
    };
    const refusal = async (asked: Promise<unknown>): Promise<HarnessRefusal> => {
      const refused: unknown = await asked.then(
        () => null,
        (error: unknown) => error,
      );
      if (!(refused instanceof HarnessRefusal)) throw new Error(`it wasn't refused: ${String(refused)}`);
      expect(refused.code).toBe("unavailable");
      return refused;
    };
    const noList = lacking(["blobs", "list"]);
    expect((await refusal(noList.sweep())).message).toBe("What LumiAH has stored can't be swept here: the runtime and the extension it is linked to have no way to list the texts it has stored. Update both to the same build, then try again.");
    expect((await refusal(noList.upkeep.get())).message).toStartWith("What LumiAH has stored can't be counted here:");

    const bare = lacking(["blobs", "remove"], ["store", "list"], ["chat", "anchors"]);
    expect((await refusal(bare.sweep())).message).toContain("have no way to remove a stored text, list its documents or list the records kept on your chats' messages.");

    // A host that can list and can't remove still says what is stored.
    const noRemove = lacking(["blobs", "remove"]);
    await noRemove.blobs.put("Stored, and never to be removed here.");
    expect((await noRemove.upkeep.get()).total.count).toBe(1);
    await refusal(noRemove.sweep());
  });

  test("asked for twice at once is one sweep", async () => {
    const r = rig();
    await r.blobs.put("Nothing names this.");
    r.host.clock.advance(2 * DAY);
    let listings = 0;
    const list = r.host.blobs.list;
    r.host.blobs.list = async (cursor) => {
      if (cursor === undefined) listings++;
      return list(cursor);
    };
    const signal = new AbortController().signal;
    const first = r.upkeep.sweep(signal);
    const second = r.upkeep.sweep(signal);
    expect(second).toBe(first);
    expect(await second).toBe(await first);
    expect(listings).toBe(1);
    // Once it is over, the next one asked for is a new sweep.
    expect(r.upkeep.sweep(signal)).not.toBe(first);
    await r.sweep();
    expect(listings).toBe(2);
  });

  test("ends when its signal does, between two steps: what it hadn't removed yet stays, and what it had is on record", async () => {
    const r = rig();
    const strays: string[] = [];
    for (let i = 1; i <= 5; i++) strays.push(await r.blobs.put(`Stray text ${i}.`));
    const removed = r.bytes(...strays.slice(0, 3));
    r.host.clock.advance(2 * DAY);
    // Stopped before it began: nothing is removed, and nothing is put on record.
    const before = new AbortController();
    before.abort(new Error("The runtime is restarting."));
    await expect(r.upkeep.sweep(before.signal)).rejects.toThrow("The runtime is restarting.");
    expect(r.host.blobStore.size).toBe(5);
    expect(r.host.documents.has(DOC.upkeep)).toBe(false);

    // Stopped after the first batch was removed: the rest stay, and the next sweep takes them.
    const stop = new AbortController();
    const remove = r.host.blobs.remove;
    r.host.blobs.remove = async (hashes) => {
      await remove(hashes);
      stop.abort(new Error("Stopped by the user."));
    };
    await expect(r.upkeep.sweep(stop.signal)).rejects.toThrow("Stopped by the user.");
    expect(r.stored(...strays)).toEqual([false, false, false, true, true]);
    expect(r.host.logs.at(-1)).toEqual({ level: "warn", message: "the sweep ended early (Stopped by the user.), having removed 3 of the 5 stored texts it was to remove" });
    const cut = await r.upkeep.get();
    expect(cut.lastSweep).toEqual({ at: r.host.clock.now(), removed: 3, bytes: removed, ms: 0 });
    expect(cut.loose).toEqual({ count: 2, bytes: r.bytes(...strays.slice(3)), at: r.host.clock.now() });
    expect(cut.total).toEqual({ count: 2, bytes: r.bytes(...strays.slice(3)) });
    r.host.blobs.remove = remove;
    expect((await r.sweep()).lastSweep?.removed).toBe(2);
    expect(r.host.blobStore.size).toBe(0);
  });
});

describe("what the page is told", () => {
  test("before any sweep: a count of what is stored, kind by kind, made once and stored", async () => {
    const r = rig();
    const run = await r.transcript("gen-1");
    const made = await r.turn(CHAT, { transcript: run.hash });
    const stray = await r.blobs.put("Nothing names this, and it is old.");
    r.host.clock.advance(2 * DAY);
    const young = await r.blobs.put("Nothing names this yet.");
    let listings = 0;
    const list = r.host.blobs.list;
    r.host.blobs.list = async (cursor) => {
      if (cursor === undefined) listings++;
      return list(cursor);
    };

    const [got, same] = await Promise.all([r.upkeep.get(), r.upkeep.get()]);
    expect(same).toEqual(got);
    expect(listings).toBe(1);
    const made0 = Date.UTC(2026, 4, 1, 12);
    expect(got.kinds).toEqual([
      { kind: "segment", count: 1, bytes: r.bytes(made.segment), oldestAt: made0, keep: ["keep", "spanDays"] },
      { kind: "summary", count: 0, bytes: 0, oldestAt: null, keep: null },
      { kind: "transcript", count: 1, bytes: r.bytes(run.hash), oldestAt: made0, keep: ["keep", "transcriptDays"] },
      { kind: "prompt", count: 2, bytes: r.bytes(...run.prompts), oldestAt: made0, keep: ["keep", "promptDays"] },
      { kind: "index", count: 0, bytes: 0, oldestAt: null, keep: null },
      { kind: "file", count: 0, bytes: 0, oldestAt: null, keep: null },
      { kind: "report", count: 0, bytes: 0, oldestAt: null, keep: null },
      { kind: "session", count: 0, bytes: 0, oldestAt: null, keep: null },
      { kind: "side", count: 0, bytes: 0, oldestAt: null, keep: null },
    ]);
    // Counting removes nothing: what a sweep would take is counted with what the grace time covers.
    expect(r.stored(stray, young)).toEqual([true, true]);
    expect(got.loose).toEqual({ count: 2, bytes: r.bytes(stray, young), at: r.host.clock.now() });
    expect(got.total).toEqual({ count: 6, bytes: r.bytes(made.segment, run.hash, ...run.prompts, stray, young) });
    expect(got.lastSweep).toBeNull();
    expect(got.sweeping).toBe(false);

    // What it found is stored: asked again, even by another `Upkeep`, nothing is counted anew.
    await r.blobs.put("Stored after the count.");
    expect(await r.upkeep.get()).toEqual(got);
    expect(await new Upkeep({ host: r.host, blobs: r.blobs, keep: () => r.keep }).get()).toEqual(got);
    expect(listings).toBe(1);
    expect(r.host.documents.has(DOC.upkeep)).toBe(true);
  });

  test("after a sweep: what is stored now, and what the sweep removed and how long it took", async () => {
    const r = rig();
    const made = await r.turn(CHAT);
    const stray = await r.blobs.put("Nothing names this, and it is old.");
    r.host.clock.advance(2 * DAY);
    await r.upkeep.get();
    const size = r.bytes(stray);
    const list = r.host.blobs.list;
    r.host.blobs.list = async (cursor) => {
      r.host.clock.advance(40);
      return list(cursor);
    };
    const swept = await r.sweep();
    expect(swept.lastSweep).toEqual({ at: r.host.clock.now(), removed: 1, bytes: size, ms: 40 });
    expect(swept.sweeping).toBe(false);
    expect(await r.upkeep.get()).toEqual(swept);
    expect(swept.total).toEqual({ count: 1, bytes: r.bytes(made.segment) });
    expect(swept.loose).toEqual({ count: 0, bytes: 0, at: r.host.clock.now() });
  });

  test("while a sweep is under way: the last findings, and that it is", async () => {
    const r = rig();
    await r.blobs.put("Nothing names this, and it is old.");
    r.host.clock.advance(2 * DAY);
    const counted = await r.upkeep.get();
    const gate = Promise.withResolvers<void>();
    let removing = false;
    const remove = r.host.blobs.remove;
    r.host.blobs.remove = async (hashes) => {
      removing = true;
      await gate.promise;
      return remove(hashes);
    };
    const sweeping = r.sweep();
    await until(() => removing);
    expect(await r.upkeep.get()).toEqual({ ...counted, sweeping: true });
    gate.resolve();
    const swept = await sweeping;
    expect(await r.upkeep.get()).toEqual(swept);
    expect(swept.lastSweep?.removed).toBe(1);
  });

  test("where nothing was counted yet and a sweep is under way, the sweep's findings once it is done", async () => {
    const r = rig();
    await r.blobs.put("Nothing names this, and it is old.");
    r.host.clock.advance(2 * DAY);
    const sweeping = r.sweep();
    const got = r.upkeep.get();
    expect(await got).toEqual(await sweeping);
    expect((await got).lastSweep?.removed).toBe(1);
  });

  test("where nothing was counted yet and the sweep under way ends short, a count of its own", async () => {
    const r = rig();
    await r.blobs.put("Nothing names this, and it is old.");
    r.host.clock.advance(2 * DAY);
    const stop = new AbortController();
    stop.abort(new Error("Stopped by the user."));
    const sweeping = r.upkeep.sweep(stop.signal);
    const got = r.upkeep.get();
    await expect(sweeping).rejects.toThrow("Stopped by the user.");
    expect(await got).toMatchObject({ total: { count: 1 }, loose: { count: 1 }, lastSweep: null, sweeping: false });
    expect(r.host.blobStore.size).toBe(1);
  });
});
