// The stand-in backend's chronicle and the learning of a story (dev/preview/mock/chronicle.ts, with
// the run the jobs' part plays for it) answer as the contract says. They are asked through the
// whole stand-in backend, on a clock the test turns, so what holds here is what the preview shows:
// the check worked out from the files and the messages as they stand, the files read and listed
// as workspace files, and a story's job that plans, writes, stops at its budget and carries on.

import { describe, expect, test } from "bun:test";
import { MockBackend, type MockOptions } from "../../dev/preview/mock-backend";
import { sampleSettings } from "../../dev/preview/sections";
import { carryOnGrant, learnBody, learnDraft } from "../../src/extension/frontend/chronicle-model";
import { type Channel, UiClient } from "../../src/extension/frontend/client";
import { citationsOf, type JobAllowance, type StoryView, type UiRequests, type UiRequestType } from "../../src/shared/ui";

const T0 = Date.UTC(2026, 10, 10, 9, 0, 0);
const DIR = "learned/chronicle/";
const FOUR = [`${DIR}outline.md`, `${DIR}facts.md`, `${DIR}threads.md`, `${DIR}cast.md`];
/** A budget too small for the long chat: its learning gets as far as the end of the winter on it. */
const SMALL: JobAllowance = { tokensIn: 400_000, tokensOut: 40_000, wallMs: 30 * 60_000 };

/** A page's client and the stand-in backend joined by a channel, on a clock the test turns by hand. */
function world(over: Partial<MockOptions> = {}) {
  let now = T0;
  let nextId = 0;
  let timers: { at: number; id: number; fn: () => void }[] = [];
  let toPage: (payload: unknown) => void = () => {};
  const settled = sampleSettings();
  const backend = new MockBackend((payload) => toPage(structuredClone(payload)), {
    scenario: "ready",
    turn: "none",
    sections: settled.sections,
    texts: settled.texts,
    delay: 0,
    page: 60,
    fail: new Set(),
    now: () => now,
    later: (fn, ms) => {
      const timer = { at: now + ms, id: (nextId += 1), fn };
      timers.push(timer);
      return () => {
        timers = timers.filter((t) => t !== timer);
      };
    },
    ...over,
  });
  const channel: Channel = {
    send: (payload) => backend.receive(structuredClone(payload)),
    subscribe: (handler) => {
      toPage = handler;
      return () => {
        toPage = () => {};
      };
    },
  };
  const client = new UiClient(channel, { timeoutMs: () => 60_000 });
  /** Turns the clock on by `ms`, running what falls due in order, with the page's own work settled between. */
  const pass = async (ms = 0): Promise<void> => {
    const until = now + ms;
    for (;;) {
      for (let i = 0; i < 20; i += 1) await Promise.resolve();
      const due = timers.filter((t) => t.at <= until).sort((a, b) => a.at - b.at || a.id - b.id)[0];
      if (!due) break;
      timers = timers.filter((t) => t !== due);
      now = Math.max(now, due.at);
      due.fn();
    }
    now = until;
  };
  /** A request and its answer, the clock turned just far enough for the backend to answer. */
  const ask = async <K extends UiRequestType>(type: K, body: UiRequests[K]["body"]): Promise<UiRequests[K]["result"]> => {
    const asked = client.request(type, body);
    // A refusal is awaited by the caller; this keeps a rejection from being unhandled meanwhile.
    asked.catch(() => {});
    await pass(0);
    return asked;
  };
  const story = (chatId: string): Promise<StoryView> => ask("lah.story.get", { chatId });
  /** The clock turned a quarter second at a time until the chat's story stands as asked; fails where it never does within two minutes. */
  const until = async (chatId: string, stands: (s: StoryView) => boolean): Promise<StoryView> => {
    for (let i = 0; i < 480; i += 1) {
      const s = await story(chatId);
      if (stands(s)) return s;
      await pass(250);
    }
    throw new Error("the story never came to stand as asked");
  };
  /** Learn this story, started as the page starts it: with what `lah.story.get` suggests and the budget the page sizes from its estimate, or the budget given in its place. */
  const learn = async (chatId: string, allowance?: JobAllowance): Promise<string> => {
    const read = await story(chatId);
    const body = learnBody(chatId, learnDraft(read));
    const { job } = await ask("lah.job.start", allowance !== undefined ? { ...body, allowance } : body);
    return job.id;
  };
  const text = async (chatId: string, name: string): Promise<string> => (await ask("lah.ws.read", { chatId, area: "learned", path: `chronicle/${name}` })).text;
  return { ask, pass, story, until, learn, text };
}

/** What a request came to: its result, or the error it was refused with. */
const outcome = (p: Promise<unknown>): Promise<unknown> => p.then((value) => value, (e: unknown) => e);

describe("the harbour chat's chronicle", () => {
  test("the check finds the four files, their paths as the agents write them, some thirty lines in all", async () => {
    const w = world();
    const view = await w.ask("lah.chronicle.get", { chatId: "chat-mara" });
    expect(view.files.map((f) => f.path)).toEqual(FOUR);
    const lines = view.files.reduce((sum, f) => sum + f.lines, 0);
    expect(lines).toBeGreaterThanOrEqual(28);
    expect(lines).toBeLessThanOrEqual(40);
    for (const f of view.files) expect(f.chars, f.path).toBe((await w.text("chat-mara", f.path.slice(DIR.length))).length);
    // Reading it again runs the check again, to the same end.
    expect(await w.ask("lah.chronicle.get", { chatId: "chat-mara" })).toEqual(view);
  });

  test("one line's message has changed, one's is gone, one's stands at another number, and a few lines cite nothing", async () => {
    const w = world();
    const view = await w.ask("lah.chronicle.get", { chatId: "chat-mara" });
    expect(view.failures.map((f) => [f.path, f.index, f.why])).toEqual([[`${DIR}facts.md`, 40, "changed"], [`${DIR}threads.md`, 49, "gone"]]);
    for (const f of view.failures) {
      const lines = (await w.text("chat-mara", f.path.slice(DIR.length))).split("\n");
      expect(lines[f.line - 1], "a failure names its line as the file has it").toBe(f.text);
      expect(f.text).toContain(f.citation);
    }
    expect(view.moved.map((m) => [m.path, m.index, m.now])).toEqual([[`${DIR}cast.md`, 45, 44]]);
    expect(view.uncited.length).toBe(3);
    for (const u of view.uncited) expect(citationsOf(u.text), u.text).toEqual([]);
    expect(view.files.map((f) => f.failed)).toEqual([0, 1, 1, 0]);
    for (const f of view.files) expect(f.cited, f.path).toBeGreaterThan(3);
  });

  test("a line's citations are read in one request, in the order asked, each as its message stands", async () => {
    const w = world();
    const view = await w.ask("lah.chronicle.get", { chatId: "chat-mara" });
    const [changed] = view.failures;
    if (!changed) throw new Error("the made-up chronicle has no failing line");
    const citations = citationsOf(changed.text).map((c) => c.citation);
    expect(citations.length).toBe(2);
    const { cited } = await w.ask("lah.chronicle.cited", { chatId: "chat-mara", citations });
    expect(cited.map((c) => [c.index, c.ok, c.why])).toEqual([[23, true, undefined], [40, false, "changed"]]);
    expect(cited[0]?.message).toMatchObject({ index: 23, role: "assistant", name: "Joss", text: expect.stringContaining("Closed for the count") });
    // The changed message is shown as it reads now, which is not what the line says.
    expect(cited[1]?.message?.text).toContain("There are two keys now");
    expect(cited[1]?.message?.at).toBeLessThan(T0);
  });

  test("a message that is gone has no text, and one that moved is read where it stands now", async () => {
    const w = world();
    const view = await w.ask("lah.chronicle.get", { chatId: "chat-mara" });
    const gone = view.failures.find((f) => f.why === "gone");
    const [moved] = view.moved;
    if (!gone || !moved) throw new Error("the made-up chronicle lacks a gone or a moved citation");
    const { cited } = await w.ask("lah.chronicle.cited", { chatId: "chat-mara", citations: [gone.citation, moved.citation] });
    expect(cited[0]).toEqual({ index: 49, ok: false, why: "gone", message: null });
    expect(cited[1]).toMatchObject({ index: 45, ok: true, why: "moved", now: 44, message: { index: 44, text: expect.stringContaining("Ilse has the night key") } });
  });

  test("every other citation of the four files holds", async () => {
    const w = world();
    const all: string[] = [];
    for (const name of ["outline.md", "facts.md", "threads.md", "cast.md"]) all.push(...citationsOf(await w.text("chat-mara", name)).map((c) => c.citation));
    expect(all.length).toBeGreaterThan(30);
    const { cited } = await w.ask("lah.chronicle.cited", { chatId: "chat-mara", citations: all });
    expect(cited.length).toBe(all.length);
    expect(cited.filter((c) => !c.ok).map((c) => c.index)).toEqual([40, 49]);
    expect(cited.filter((c) => c.why === "moved").map((c) => c.index)).toEqual([45]);
    for (const c of cited.filter((x) => x.ok && x.why === undefined)) expect(c.message?.index, `#${c.index}`).toBe(c.index);
  });

  test("a message named by its number alone is read as it stands, and what is no citation is refused in words", async () => {
    const w = world();
    const { cited } = await w.ask("lah.chronicle.cited", { chatId: "chat-mara", citations: ["#38", "[#7 a3f9c27e]"] });
    expect(cited[0]).toMatchObject({ index: 38, ok: true, message: { name: "Joss", text: expect.stringContaining("Okoro signed it on the first") } });
    // A message the made-up chronicle doesn't cite is there all the same, and its citation doesn't match it.
    expect(cited[1]).toMatchObject({ index: 7, ok: false, why: "changed", message: { index: 7 } });
    expect(await outcome(w.ask("lah.chronicle.cited", { chatId: "chat-mara", citations: ["the ledger"] }))).toMatchObject({ code: "invalid", message: expect.stringContaining("is no citation") });
  });

  test("its files are read as workspace files and listed in learned/, beside what the workspace holds there", async () => {
    const w = world();
    const read = await w.ask("lah.ws.read", { chatId: "chat-mara", area: "learned", path: "chronicle/facts.md" });
    expect(read.text.startsWith("# Established\n")).toBe(true);
    expect(read.file).toMatchObject({ path: "chronicle/facts.md", chars: read.text.length, by: { who: "job" } });
    expect(read.version).toBe(read.file.hash);
    const listed = (await w.ask("lah.ws.list", { chatId: "chat-mara", area: "learned" })).files.map((f) => f.path);
    for (const path of FOUR) expect(listed).toContain(path.slice("learned/".length));
    expect(listed.some((path) => !path.startsWith("chronicle/"))).toBe(true);
    // The chat's own area holds none of them, and a file the chronicle hasn't is the workspace's to answer for.
    expect((await w.ask("lah.ws.list", { chatId: "chat-mara", area: "chat" })).files.some((f) => f.path.startsWith("chronicle/"))).toBe(false);
    expect(await outcome(w.ask("lah.ws.read", { chatId: "chat-mara", area: "learned", path: "chronicle/plan.md" }))).toMatchObject({ code: "not_found" });
  });

  test("the story stands one message short of the chat, with nothing started, something to start it with and what that should take", async () => {
    const s = await world().story("chat-mara");
    expect(s).toMatchObject({ job: null, plan: null, messages: 48, covered: 47 });
    expect(s.suggested.task.length).toBeGreaterThan(40);
    expect(s.estimate.messages).toBe(1);
    expect(s.estimate.promptTokens).toBeGreaterThan(0);
    expect(s.estimate.usd).toBeGreaterThan(0);
  });
});

describe("a chat with no chronicle", () => {
  test("the long chat has none yet, and nothing of its 2,412 messages is covered", async () => {
    const w = world();
    expect(await w.ask("lah.chronicle.get", { chatId: "chat-brann" })).toEqual({ files: [], failures: [], moved: [], uncited: [] });
    expect(await w.story("chat-brann")).toMatchObject({ job: null, plan: null, messages: 2412, covered: 0 });
    expect((await w.ask("lah.ws.list", { chatId: "chat-brann", area: "learned" })).files.some((f) => f.path.startsWith("chronicle/"))).toBe(false);
  });

  test("a chat with no made-up story has nothing, and neither has any chat of a fresh install", async () => {
    const w = world();
    expect((await w.ask("lah.chronicle.get", { chatId: "chat-ilse" })).files).toEqual([]);
    expect(await w.story("chat-ilse")).toMatchObject({ job: null, plan: null, messages: 0, covered: 0 });
    const fresh = world({ scenario: "fresh" });
    expect((await fresh.ask("lah.chronicle.get", { chatId: "chat-mara" })).files).toEqual([]);
    expect(await fresh.story("chat-mara")).toMatchObject({ job: null, plan: null, messages: 0, covered: 0 });
    expect((await fresh.ask("lah.chronicle.cited", { chatId: "chat-mara", citations: ["[#38 a3f9c27e]"] })).cited).toEqual([{ index: 38, ok: false, why: "gone", message: null }]);
  });
});

describe("learning the long chat's story", () => {
  test("started as the page starts it, with the budget sized to the estimate, the whole chat is learned in one run", async () => {
    const w = world();
    const before = await w.story("chat-brann");
    expect(before.estimate).toMatchObject({ messages: 2412, promptTokens: 459_000, weighedTokens: 459_000, writtenTokens: 30_600 });
    const id = await w.learn("chat-brann");
    expect((await w.story("chat-brann")).job).toMatchObject({ id, state: "running", allowance: { tokensIn: 689_000, tokensOut: 46_000, toolTurns: 20 } });
    const done = await w.until("chat-brann", (s) => s.job !== null && s.job.state !== "running" && s.job.state !== "queued");
    expect(done).toMatchObject({ covered: 2412, messages: 2412, job: { id, state: "done" } });
    expect(done.job?.usage.in).toBeLessThanOrEqual(689_000);
    // Nothing is left to learn, and the estimate says so.
    expect(done.estimate).toMatchObject({ messages: 0, promptTokens: 0, usd: 0 });
  });

  test("out of a budget chosen too small, one press carries it on to the end", async () => {
    const w = world();
    const id = await w.learn("chat-brann", { tokensIn: 200_000 });
    const spent = await w.until("chat-brann", (s) => s.job?.state === "spent");
    expect(spent).toMatchObject({ covered: 1300, estimate: { messages: 1112, promptTokens: 189_000 } });
    if (spent.job === null) throw new Error("the story has no job");
    const grant = carryOnGrant(spent.job, spent.estimate);
    expect(grant.tokensIn).toBe(485_000);
    await w.ask("lah.job.grant", { id, allowance: grant });
    const done = await w.until("chat-brann", (s) => s.job !== null && s.job.state !== "running" && s.job.state !== "queued");
    expect(done).toMatchObject({ covered: 2412, job: { id, state: "done" } });
    expect(done.job?.usage.in).toBeLessThanOrEqual(485_000);
  });

  test("it writes its plan first, covers the chat a part at a time, and stops at a budget too small for it with a report", async () => {
    const w = world();
    const id = await w.learn("chat-brann", SMALL);
    expect(await w.story("chat-brann")).toMatchObject({ job: { id, state: "running", allowance: { tokensIn: 400_000 } }, plan: null, covered: 0 });

    // The plan comes before any of the chronicle: it can be read while the chat still has none.
    const planned = await w.until("chat-brann", (s) => s.plan !== null);
    expect(planned).toMatchObject({ plan: `${DIR}plan.md`, covered: 0, job: { state: "running" } });
    expect((await w.ask("lah.chronicle.get", { chatId: "chat-brann" })).files).toEqual([]);
    const plan = await w.text("chat-brann", "plan.md");
    expect(plan.startsWith("# Plan\n")).toBe(true);
    expect(plan).toContain("400,000 tokens in, 40,000 tokens out, 30 minutes");
    expect(plan).toContain("the watch begins: read closely. Next.");

    // Then the chat, a part at a time: what the outline spans grows, and the files appear.
    const seen: number[] = [];
    const spent = await w.until("chat-brann", (s) => {
      if (seen.at(-1) !== s.covered) seen.push(s.covered);
      return s.job?.state === "spent";
    });
    expect(seen).toEqual([0, 400, 1300]);
    expect(spent).toMatchObject({ covered: 1300, messages: 2412, job: { id, state: "spent", reason: expect.stringContaining("400,000 tokens read") } });
    expect(spent.job?.usage.in).toBeGreaterThanOrEqual(400_000);
    expect(spent.job?.usage.toolTurns).toBe(6);
    expect(spent.job?.opening).toBe("Stopped at my allowance with #1 to #1,300 learned: the chronicle is written as far as the end of the winter.");
    expect((await w.ask("lah.blob.get", { hash: spent.job?.report ?? "" })).text).toContain("## What is left");
    expect(spent.job?.transcript).toBeDefined();

    const view = await w.ask("lah.chronicle.get", { chatId: "chat-brann" });
    expect(view.files.map((f) => f.path)).toEqual(FOUR);
    expect(view.failures).toEqual([]);
    const listed = (await w.ask("lah.ws.list", { chatId: "chat-brann", area: "learned" })).files.filter((f) => f.path.startsWith("chronicle/"));
    expect(listed.map((f) => f.path).sort()).toEqual(["chronicle/cast.md", "chronicle/facts.md", "chronicle/outline.md", "chronicle/plan.md", "chronicle/threads.md", "chronicle/unverified.md"]);
    for (const f of listed) expect(f.by, f.path).toEqual({ who: "job", id, role: "archivist" });
    expect(await w.text("chat-brann", "plan.md")).toContain("the winter: by the outline, and closely only where a ship, the light or the watch book is named. Done.");
    // A job out of budget is over as the stand-in counts them: the state no longer holds it.
    expect((await w.ask("lah.hello", {})).jobs.active.some((j) => j.id === id)).toBe(false);
  });

  test("granted more, it carries on from where it stopped and finishes within what it was granted", async () => {
    const w = world();
    const id = await w.learn("chat-brann", SMALL);
    const spent = await w.until("chat-brann", (s) => s.job?.state === "spent");
    const { job } = await w.ask("lah.job.grant", { id, allowance: { ...spent.job?.allowance, tokensIn: 800_000 } });
    expect(job).toMatchObject({ id, state: "running", allowance: { tokensIn: 800_000, tokensOut: 40_000 } });

    const seen: number[] = [];
    const done = await w.until("chat-brann", (s) => {
      if (seen.at(-1) !== s.covered) seen.push(s.covered);
      return s.job?.state === "done";
    });
    expect(seen).toEqual([1300, 2100, 2412]);
    expect(done).toMatchObject({ covered: 2412, messages: 2412, job: { id, state: "done" } });
    expect(done.job?.usage.in).toBeGreaterThan(spent.job?.usage.in ?? 0);
    expect(done.job?.usage.in).toBeLessThanOrEqual(800_000);
    expect(done.job?.usage.out).toBeLessThanOrEqual(40_000);
    expect(done.job?.opening).toContain("#2,412");

    const view = await w.ask("lah.chronicle.get", { chatId: "chat-brann" });
    expect(view.failures).toEqual([]);
    expect(view.moved).toEqual([]);
    expect(view.uncited).toEqual([]);
    const plan = await w.text("chat-brann", "plan.md");
    expect(plan.match(/ Done\./g)?.length).toBe(4);
    expect(plan).toContain("800,000 tokens in");
    expect((await w.text("chat-brann", "unverified.md")).split("\n").filter((line) => line.startsWith("- ")).length).toBe(4);
    // Its lines cite messages of the long chat, and each reads as cited.
    const citations = citationsOf(await w.text("chat-brann", "outline.md")).map((c) => c.citation);
    const { cited } = await w.ask("lah.chronicle.cited", { chatId: "chat-brann", citations });
    expect(cited.every((c) => c.ok && c.message?.text !== undefined)).toBe(true);
    expect(cited.at(-1)).toMatchObject({ index: 2412, message: { name: "Brann" } });
  });

  test("granted nothing on the limit it ran out at, it stops again at once and says so", async () => {
    const w = world();
    const id = await w.learn("chat-brann", SMALL);
    const spent = await w.until("chat-brann", (s) => s.job?.state === "spent");
    await w.ask("lah.job.grant", { id, allowance: { ...spent.job?.allowance, wallMs: 90 * 60_000 } });
    expect((await w.story("chat-brann")).job?.state).toBe("running");
    const again = await w.until("chat-brann", (s) => s.job?.state === "spent");
    expect(again).toMatchObject({ covered: 1300, job: { id, reason: expect.stringContaining("400,000 tokens read"), opening: expect.stringContaining("Nothing more was done") } });
  });

  test("with no bound on its tokens it reads to the chat's end in one run", async () => {
    const w = world();
    const id = await w.learn("chat-brann", { wallMs: 30 * 60_000 });
    const done = await w.until("chat-brann", (s) => s.job !== null && s.job.state !== "running" && s.job.state !== "queued");
    expect(done).toMatchObject({ covered: 2412, job: { id, state: "done" } });
    expect(await w.text("chat-brann", "plan.md")).toContain("Allowance: 30 minutes.");
  });

  test("stopped half-way, what it wrote stays; started again, the new job is the chat's story and carries on", async () => {
    const w = world();
    const id = await w.learn("chat-brann");
    await w.until("chat-brann", (s) => s.covered === 400);
    expect((await w.ask("lah.job.cancel", { id })).job.state).toBe("cancelled");
    expect(await w.story("chat-brann")).toMatchObject({ covered: 400, plan: `${DIR}plan.md`, job: { id, state: "cancelled" } });

    const { job } = await w.ask("lah.job.again", { id });
    expect(job).toMatchObject({ again: id, state: "running" });
    expect((await w.story("chat-brann")).job?.id).toBe(job.id);
    // It reads on from the part after the last one written, and nothing bounds it now.
    const done = await w.until("chat-brann", (s) => s.job?.state === "done");
    expect(done).toMatchObject({ covered: 2412, job: { id: job.id } });
    expect(done.job?.usage.toolTurns).toBe(6);
  });

  test("a job started without the mark is no story, and plays the ordinary run", async () => {
    const w = world();
    const { suggested } = await w.story("chat-brann");
    const { job } = await w.ask("lah.job.start", { chatId: "chat-brann", agent: suggested.agent, task: suggested.task, when: "now" });
    // Long enough for the ordinary run to reach the call it holds for the user's word, which a story's run never does.
    await w.pass(6000);
    expect(await w.story("chat-brann")).toMatchObject({ job: null, plan: null, covered: 0 });
    expect((await w.ask("lah.hello", {})).approvals.some((a) => a.stream === job.id)).toBe(true);
  });
});

describe("learning the rest of the harbour chat's story", () => {
  test("a short story is learned in one run: the chronicle reaches the chat's end and every line holds again", async () => {
    const w = world();
    const id = await w.learn("chat-mara");
    const done = await w.until("chat-mara", (s) => s.job !== null && s.job.state !== "running" && s.job.state !== "queued");
    expect(done).toMatchObject({ covered: 48, messages: 48, plan: `${DIR}plan.md`, job: { id, state: "done" } });
    const view = await w.ask("lah.chronicle.get", { chatId: "chat-mara" });
    expect(view.failures).toEqual([]);
    expect(view.moved).toEqual([]);
    expect(view.uncited.length).toBe(3);
    expect(await w.text("chat-mara", "facts.md")).toContain("Two keys open it");
    expect(done.job?.opening).toContain("up to #48");
  });
});

describe("the README's pictures", () => {
  test("in showcase the harbour chat opens with its story learned to its end: whole, every line cited, nothing left to learn", async () => {
    const w = world({ showcase: true });
    expect(await w.story("chat-mara")).toMatchObject({ job: null, plan: null, covered: 48, messages: 48, estimate: { messages: 0, promptTokens: 0 } });
    const view = await w.ask("lah.chronicle.get", { chatId: "chat-mara" });
    expect(view.files.map((f) => f.path)).toEqual(FOUR);
    expect([view.failures, view.moved, view.uncited]).toEqual([[], [], []]);
  });
});
