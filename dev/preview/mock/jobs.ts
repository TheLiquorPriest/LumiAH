// The stand-in backend's jobs (DESIGN §15): agent runs that outlive a reply. A dozen are there for
// the main chat when the preview opens, in every state a job can rest in, with their reports and
// transcripts; none runs then, since a running job is a run under way and the preview opens with
// nothing under way. Starting one by hand plays its run under the job's own id, so the Jobs page
// shows its work as it happens: it holds one tool call for the user's word, then reports. This part
// owns `UiState.jobs` and `UiState.notices`.

import { isReply, type AgentUsage, type JobAllowance, type JobState, type JobView, type JobsPage, type JobWhen, type Notice, type ToolCallView } from "../../../src/shared/ui";
import { fakeHash, type PlayStep, queuedJob, Trace } from "../fixtures";
import { storyRun } from "./chronicle";
import { type Handlers, MOCK_AGENTS, type MockCtx, type PlayEnd, Refusal } from "./ctx";

type Requests = "lah.jobs.list" | "lah.jobs.set" | "lah.job.start" | "lah.job.cancel" | "lah.job.again" | "lah.job.grant" | "lah.job.resume" | "lah.notice.dismiss";

const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;

/** The limits the made-up settings put on jobs. */
const LIMITS: JobsPage["limits"] = { atOnce: 2, tokensPerJob: 60_000, msPerJob: 15 * MIN, tokensPerDay: 400_000 };

/** The made-up settings' other bounds, as the real ones name them: a task's length, how much of a task a list shows and a notice names, how much of a report is its opening, and how long a held call waits. */
const TASK_CHARS = 4000;
const TASK_OPENS = 240;
const NAMED_CHARS = 80;
const OPENING_CHARS = 600;
const HOLD_MS = 5 * MIN;

const JOB_SYSTEM = "You run a job for this chat, unattended. Do the task you are given from what the chat and the workspace hold. Write what you find to the workspace, and end with a report: what you did, what you changed, and what is left.";

const NOTES = "# Timeline\n\n- #17 Joss: Brann locks the harbour office at dusk.\n- #29 Ilse: the lock was changed after the autumn storms.\n- #38 Okoro signed the pilot's ledger on the first.\n- #43 A page of the ledger is missing.";

const FOUND = '3 messages found, showing 3.\n\n#38 [Joss] "Okoro signed it on the first, same as every month."\n#43 [Mara] I turn the pages. One has been cut out, close to the spine.\n#47 [Ilse] "What does Joss think is in that office?"\n\nNo more results.';

const STATE_WORDS: Readonly<Record<JobState, string>> = { queued: "queued", running: "running", done: "done", failed: "failed", cancelled: "cancelled", interrupted: "interrupted", off_path: "off the path", spent: "out of allowance", paused: "paused" };

const noUsage = (): AgentUsage => ({ calls: 0, toolTurns: 0, in: 0, cachedIn: 0, out: 0, reasoningOut: 0, estimated: false, ms: 0, cost: 0 });

const over = (job: Pick<JobView, "state">): boolean => job.state !== "queued" && job.state !== "running";

const opens = (task: string): string => (task.length > TASK_OPENS ? `${task.slice(0, TASK_OPENS).trimEnd()}…` : task);

/** How a report opens: its first paragraph, as far as the made-up settings show of one. */
const openingOf = (report: string): string => (report.split("\n\n")[0] ?? "").slice(0, OPENING_CHARS);

const reportOf = (opening: string, did: string[], left: string[]): string => `${opening}\n\n## What I did\n${did.map((line) => `- ${line}`).join("\n")}\n\n## What is left\n${left.map((line) => `- ${line}`).join("\n")}`;

/** A job that ended before the preview opened: how long ago it was asked for, how long it waited, whether it ever started, how it ended, and the report it left. */
interface Past {
  id: string;
  chatId: string;
  agent: string;
  task: string;
  when: JobWhen;
  by: JobView["by"];
  /** The turn whose agent started it; null for one the user started, which belongs to the chat and writes `learned/`, never the chat's own area (DESIGN §22). */
  basis: string | null;
  ago: number;
  waited: number;
  ran: boolean;
  state: Exclude<JobState, "queued" | "running">;
  reason?: string;
  report?: string;
  /** The workspace file it wrote, in its transcript. */
  wrote?: string;
  /** Its counts are the runtime's estimate and a call had no price, as with a provider that reports no usage. */
  estimated?: true;
  /** What it spent, where the made-up data names the figures elsewhere, or its run's own tally would say too little for the story. */
  usage?: AgentUsage;
  /** What it worked in all, where that is more than its last run. */
  workedMs?: number;
  /** What this job alone may spend (DESIGN §22). */
  allowance?: JobAllowance;
  /** The job whose agent started it. */
  parent?: string;
}

const YOU: JobView["by"] = { who: "user" };
const MAIN: JobView["by"] = { who: "agent", id: "main-1", role: "main" };

const PAST: readonly Past[] = [
  {
    id: "job-timeline-1",
    chatId: "chat-mara",
    agent: "archivist",
    task: "Start notes/timeline.md from the replies so far.",
    // The figures Live's worked turn says the main agent was told of this job.
    usage: { calls: 4, toolTurns: 3, in: 9200, cachedIn: 6100, out: 410, reasoningOut: 60, estimated: false, ms: 21_400, cost: 0.0014 },
    when: "after_reply",
    by: MAIN,
    basis: "turn-0043",
    ago: 16 * MIN,
    waited: 900,
    ran: true,
    state: "done",
    wrote: "notes/timeline.md",
    report: reportOf("Started notes/timeline.md: 14 lines, one a reply, from #17 to #43.", ["Read replies #17 to #43 and kept one line for each that says who did what, and when.", "Wrote notes/timeline.md (14 lines). Each line names the reply it comes from."], ["Replies #44 on are not in it yet.", "#29 and #31 disagree on when the lock was changed; both are noted, neither is settled."]),
  },
  {
    id: "job-ledger-1",
    chatId: "chat-mara",
    agent: "archivist",
    task: "Go through every reply that names the pilot's ledger and note in learned/ledger.md who had it, when, and who said so. Where two replies disagree, keep both and say which came later.",
    when: "now",
    by: YOU,
    basis: null,
    ago: 40 * MIN,
    waited: 300,
    ran: true,
    state: "interrupted",
    reason: "The runtime restarted while it ran. What it had read and written is kept.",
  },
  {
    id: "job-people-1",
    chatId: "chat-mara",
    agent: "cartographer",
    task: "List who was where on the night of the first, from the replies, as a table in learned/night-of-the-first.md.",
    when: "now",
    by: YOU,
    basis: null,
    ago: 2 * HOUR,
    waited: 400,
    ran: true,
    state: "done",
    wrote: "learned/night-of-the-first.md",
    report: reportOf("Wrote learned/night-of-the-first.md: five people, where each was at dusk, at midnight and at dawn.", ["Joss was at the tavern by the long pier all night (#12, #19).", "Brann locked the harbour office at dusk and went home (#17).", "Ilse held the night key and says she never used it (#31).", "Okoro signed the ledger in the office before dusk (#38)."], ["Nobody says where Mara's contact was after midnight."]),
  },
  {
    id: "job-index-1",
    chatId: "chat-mara",
    agent: "reader",
    task: "Find every reply in which Brann locks or unlocks the harbour office, and say which key he used.",
    when: "after_reply",
    by: MAIN,
    basis: "turn-0041",
    ago: 3 * HOUR,
    waited: 2 * MIN,
    ran: true,
    state: "failed",
    reason: "Its connection refused the call: the provider answered 401 three times. Check the connection's key in Lumiverse, then start it again.",
  },
  {
    id: "job-audit-1",
    chatId: "chat-mara",
    agent: "reader",
    task: "Check notes/ledger.md against the replies, line by line, and list what no reply says.",
    when: "now",
    by: YOU,
    basis: null,
    ago: 5 * HOUR,
    waited: 300,
    ran: true,
    state: "cancelled",
    reason: "You cancelled it.",
  },
  {
    id: "job-tides-1",
    chatId: "chat-mara",
    agent: "archivist",
    task: "Note the tide times Joss gave, in notes/tides.md.",
    when: "after_reply",
    by: MAIN,
    basis: "turn-0039",
    ago: 26 * HOUR,
    waited: 3 * MIN,
    ran: true,
    state: "off_path",
    wrote: "notes/tides.md",
    reason: "Reply 39 was written again while it ran, so the turn that started it is no longer on the chat's path.",
    report: reportOf("Wrote notes/tides.md from what Joss said in #39: high water at four, slack at ten.", ["Read #39 and the two replies before it.", "Wrote notes/tides.md (3 lines)."], ["The times are Joss's word alone; no other reply gives any."]),
  },
  {
    id: "job-letters-1",
    chatId: "chat-mara",
    agent: "summarizer",
    task: "Summarize what Okoro's letters say, for learned/people/okoro.md.",
    when: "after_reply",
    by: YOU,
    basis: null,
    ago: 28 * HOUR,
    waited: 4 * MIN,
    ran: true,
    state: "done",
    wrote: "learned/people/okoro.md",
    report: reportOf("Added a section on the letters to learned/people/okoro.md: three letters, all about the audit.", ["Read the three letters quoted in #22, #24 and #31.", "Wrote what each asks for and what Okoro promises in return."], ["The second letter is quoted only in part."]),
  },
  {
    id: "job-story-so-far",
    chatId: "chat-mara",
    agent: "main",
    task: "Learn the story of this chat so far. Read every reply from the first, and write what is established to learned/story.md: who is who, what happened in what order, and what is promised. Keep a plain list of what you have not verified.",
    when: "now",
    by: YOU,
    basis: null,
    ago: 2 * DAY + HOUR,
    waited: 300,
    ran: true,
    state: "spent",
    allowance: { tokensIn: 200_000, tokensOut: 20_000, wallMs: 30 * MIN },
    usage: { calls: 38, toolTurns: 31, in: 200_840, cachedIn: 151_200, out: 9420, reasoningOut: 1800, estimated: false, ms: 11 * MIN, cost: 0.031 },
    workedMs: 14 * MIN,
    wrote: "learned/story.md",
    reason: "It reached its allowance of 200,000 tokens in. Grant it more and it carries on from its own session.",
    report: reportOf("Stopped at my allowance, with replies #1 to #31 read closely and learned/story.md written as far as the autumn storms.", ["Wrote learned/story-plan.md first: read #1 to #20 closely, summarize the storm days, read from #30 on closely again.", "Wrote learned/story.md: who is who, and what happened up to the lock being changed.", "Started the roster as a job of its own, so the names are kept apart."], ["Replies #32 to #47 are not read yet: the audit, the missing page and Ilse's question.", "Not verified: when the lock was changed (#29 and #31 disagree), and who the pilot is."]),
  },
  {
    id: "job-paused",
    chatId: "chat-mara",
    agent: "archivist",
    task: "Put the workspace in order: one file a subject under learned/, each fact with the reply it comes from, and nothing said twice.",
    when: "now",
    by: YOU,
    basis: null,
    ago: 90 * MIN,
    waited: 300,
    ran: true,
    state: "paused",
    allowance: { tokensIn: 120_000, wallMs: null },
    reason: "A runtime restart came while you held it. Resume it and it carries on from its own session.",
  },
  {
    id: "job-roster-1",
    chatId: "chat-mara",
    agent: "archivist",
    task: "Keep a roster of everyone named so far in learned/roster.md: a line each, with the reply that first names them.",
    when: "now",
    by: MAIN,
    basis: null,
    parent: "job-story-so-far",
    ago: 2 * DAY,
    waited: 2 * MIN,
    ran: true,
    state: "done",
    estimated: true,
    wrote: "learned/roster.md",
    report: reportOf("Wrote learned/roster.md: five names, each with the reply that first has it.", ["Mara (#1), Joss (#2), Brann (#9), Ilse (#14), Okoro (#22)."], ["Two people are spoken of without a name: the pilot, and the clerk at the customs shed."]),
  },
  {
    id: "job-map-1",
    chatId: "chat-mara",
    agent: "cartographer",
    task: "Draw up the harbour as the replies describe it: the long pier, the office, the customs shed, the tavern.",
    when: "after_reply",
    by: MAIN,
    basis: "turn-0033",
    ago: 2 * DAY + 3 * HOUR,
    waited: 90_000,
    ran: false,
    state: "cancelled",
    reason: "The main agent cancelled it with a job_cancel call before it started.",
  },
  {
    id: "job-keys-1",
    chatId: "chat-mara",
    agent: "reader",
    task: "Read the whole chat and list every time a key changes hands.",
    when: "now",
    by: YOU,
    basis: null,
    ago: 3 * DAY,
    waited: 300,
    ran: true,
    state: "failed",
    reason: "It passed its limit of 60,000 tokens a job and was stopped. Give it a narrower task, or raise the limit in Settings.",
  },
  {
    id: "job-storm-1",
    chatId: "chat-mara",
    agent: "archivist",
    task: "Note what the autumn storms changed at the harbour, in learned/storms.md.",
    when: "now",
    by: YOU,
    basis: null,
    ago: 4 * DAY,
    waited: 300,
    ran: true,
    state: "done",
    wrote: "learned/storms.md",
    report: reportOf("Wrote learned/storms.md: the lock on the office was changed, and Ilse was given the night key.", ["Read #14 to #21, where the storms are spoken of.", "Wrote learned/storms.md (5 lines)."], ["Nobody says who changed the lock."]),
  },
  {
    id: "job-brann-1",
    chatId: "chat-brann",
    agent: "archivist",
    task: "List the ships Brann logged on his long watch, in notes/ships.md.",
    when: "after_reply",
    by: MAIN,
    basis: "turn-b-0005",
    ago: 22 * HOUR,
    waited: 2 * MIN,
    ran: true,
    state: "done",
    wrote: "notes/ships.md",
    report: reportOf("Wrote notes/ships.md: four ships, each with the hour Brann logged it.", ["Read Brann's log as the replies quote it.", "Wrote notes/ships.md (4 lines)."], ["One entry is smudged; its hour is a guess, and says so."]),
  },
  {
    id: "job-brann-2",
    chatId: "chat-brann",
    agent: "reader",
    task: "Find where Brann says he saw a light on the water, and what he took it for.",
    when: "now",
    by: YOU,
    basis: null,
    ago: 50 * MIN,
    waited: 300,
    ran: true,
    state: "interrupted",
    reason: "The runtime restarted while it ran. What it had read and written is kept.",
  },
];

/** The run of a job that ended before the preview opened, written whole: it reads, then writes and reports, fails, or is cut off. */
function pastRun(p: Past, startedAt: number): Trace {
  const agentId = `${p.agent}-1`;
  const read: ToolCallView = { id: "call_ws_read_1", name: "workspace_read", args: { path: "notes/timeline.md" } };
  const search: ToolCallView = { id: "call_search_1", name: "chat_search", args: { query: "ledger first signed" } };
  const plan = "Read what the notes hold before looking further, so nothing is written twice.";
  const t = new Trace(p.chatId, p.id, startedAt);
  t.started("job", null, { job: p.id });
  t.wait(30).agent({ id: agentId, role: p.agent, system: JOB_SYSTEM, connectionId: "conn-deepseek" });
  t.message(agentId, p.task);
  t.answer(agentId, { reasoning: plan, calls: [read, search], in: 2140, cachedIn: 0, out: 58, reasoningOut: 22, ms: 1900 });
  t.result(agentId, read, NOTES, 18);
  t.result(agentId, search, FOUND, 160);
  if (p.report !== undefined) {
    const write: ToolCallView = { id: "call_ws_write_1", name: "workspace_write", args: { path: p.wrote ?? "notes/report.md", text: p.report } };
    t.answer(agentId, { calls: [write], in: 2620, cachedIn: 2140, out: 240, ms: 3100 });
    t.result(agentId, write, `Wrote ${p.wrote ?? "notes/report.md"} (${p.report.split("\n").length} lines).`, 24);
    t.answer(agentId, { text: p.report, in: 2900, cachedIn: 2620, out: Math.ceil(p.report.length / 4), ms: 2600 });
    t.idle(agentId);
    t.wait(20).ended("done");
  } else if (p.state === "failed") {
    t.stop(agentId, "failed", "failed", p.reason ?? "").idle(agentId);
    t.wait(20).ended("failed", p.reason);
  } else if (p.state === "interrupted" || p.state === "paused") {
    // The runtime went down under it: no agent said a last word.
    t.wait(4000).ended("failed", p.reason);
  } else {
    t.stop(agentId, "cancelled", "cancelled", "the agent was cancelled").idle(agentId);
    t.wait(20).ended("stopped", p.reason);
  }
  return t;
}

/** The run of a job started by hand, as it plays: the agent reads, asks to write (held for the user's word), and reports what became of it. `landed` hears the trace after each step, so the job's spend follows its run. */
function playSteps(job: JobView, task: string, landed: (t: Trace) => void): PlayStep[] {
  const agentId = `${job.agent}-1`;
  // A job the user started belongs to the chat, not to a turn, so it writes `learned/`: no swipe changes that.
  const path = `learned/jobs/${job.id}.md`;
  const read: ToolCallView = { id: "call_ws_read_1", name: "workspace_read", args: { path: "notes/timeline.md" } };
  const write: ToolCallView = { id: "call_ws_write_1", name: "workspace_write", args: { path, text: `# ${opens(task.split("\n")[0] ?? task)}\n\n- Okoro signed the pilot's ledger on the first (#38).\n- A page went missing after the first (#43).\n- Ilse asks what Joss thinks is in the office (#47).` } };
  const plan = "Read what the notes hold first, then write only what the replies add.";
  let wrote = false;
  const report = (): string =>
    wrote
      ? reportOf(`Wrote ${path}: three lines the notes did not have, each with its reply.`, ["Read notes/timeline.md, which ends at #43.", `Wrote ${path} (5 lines) once you allowed the write.`], ["Nobody has answered Ilse's question in #47 yet."])
      : reportOf(`Nothing was written: the write to ${path} was not allowed.`, ["Read notes/timeline.md, which ends at #43.", "Asked to write three lines the notes did not have; the call was refused, so I stopped there."], ["The three lines are in this job's transcript, under the refused call."]);
  const step = (after: number, run: PlayStep["run"], more: Pick<PlayStep, "says" | "asks"> = {}): PlayStep => ({
    after,
    ...more,
    run: (t, word) => {
      run(t, word);
      landed(t);
    },
  });
  return [
    step(0, (t) => void t.started("job", null, { job: job.id })),
    step(300, (t) => void t.agent({ id: agentId, role: job.agent, system: JOB_SYSTEM, connectionId: "conn-deepseek" }).message(agentId, task)),
    step(1800, (t) => void t.answer(agentId, { reasoning: plan, calls: [read], in: 2140, cachedIn: 0, out: 52, reasoningOut: 20, ms: 1800 }), { says: { agentId, reasoning: plan } }),
    step(400, (t) => void t.result(agentId, read, NOTES, 20)),
    step(2200, (t) => void t.answer(agentId, { calls: [write], in: 2480, cachedIn: 2140, out: 160, ms: 2200 })),
    step(
      200,
      (t, word) => {
        const how = word ?? { decision: "once" };
        t.approval(agentId, write, how);
        wrote = how.decision === "once" || how.decision === "chat";
        if (wrote) t.result(agentId, write, `Wrote ${path} (5 lines).`, 24);
        else t.result(agentId, write, how.decision === "refused" ? `The user refused this call${how.reason ? `: ${how.reason}` : "."} Do not make it again unless they ask.` : "No answer came before the wait ran out, so the call was refused.", 0, { error: true });
      },
      { asks: { agentId, role: job.agent, call: write, tier: "write", wait: HOLD_MS } },
    ),
    {
      after: 2600,
      // What it reports depends on the user's word on the write, which isn't known when the steps are made: the report is read when this step begins, after the write's step has landed.
      get says() {
        return { agentId, text: report() };
      },
      run: (t) => {
        const text = report();
        t.answer(agentId, { text, in: 2760, cachedIn: 2480, out: Math.ceil(text.length / 4), ms: 2600 }).idle(agentId);
        landed(t);
      },
    },
    step(150, (t) => void t.ended("done")),
  ];
}

/** How a task is named in a notice: its opening, on one line. */
function named(job: JobView): string {
  const task = job.task.replace(/\s+/g, " ").trim();
  return `"${task.length > NAMED_CHARS ? `${task.slice(0, NAMED_CHARS).trimEnd()}…` : task}"`;
}

/** The notice a job's end calls for, in the real backend's words; null for an end the user brought about themselves. */
function endNotice(job: JobView, at: number): Notice | null {
  const base = { id: `notice-${job.id}`, at, chatId: job.chatId, jobId: job.id };
  if (job.state === "done") return { ...base, kind: "job_done", text: `The job ${named(job)} finished${job.opening !== undefined && job.opening.trim() !== "" ? `: ${job.opening.trim()}` : "."}` };
  if (job.state === "failed") return { ...base, kind: "job_failed", text: `The job ${named(job)} failed${job.reason !== undefined ? `: ${job.reason}` : "."}` };
  if (job.state === "interrupted") return { ...base, kind: "job_interrupted", text: `The job ${named(job)} was cut off by a runtime restart. Start it again from the Jobs page.` };
  return null;
}

const OFF_WORDS = "Jobs are switched off, so none may start. Switch them on at the top of the Jobs page, then start it.";

export function jobsMock(ctx: MockCtx): Handlers<Requests> {
  let jobs: JobView[] = [];
  let notices: Notice[] = [];
  let off = false;
  let paused = false;
  let changed = 0;
  let made = 0;
  let today = 0;
  /** Each job's whole task: a list shows only how it opens. */
  const tasks = new Map<string, string>();
  /** Why a running job was stopped, where this part stopped it. */
  const whys = new Map<string, string>();
  /** The jobs started as the learning of a chat's story, which play a run of their own (mock/chronicle.ts), and why the run of one stops before the story is learned: its allowance. */
  const stories = new Set<string>();
  const stops = new Map<string, string>();
  /** The jobs waiting for a reply: those that saw one of their chat under way, and those whose reply has since been written. */
  const sawReply = new Set<string>();
  const due = new Set<string>();

  const put = (job: JobView): JobView => {
    jobs = jobs.some((j) => j.id === job.id) ? jobs.map((j) => (j.id === job.id ? job : j)) : [job, ...jobs];
    return job;
  };
  const find = (id: string): JobView => {
    const job = jobs.find((j) => j.id === id);
    if (!job) throw new Refusal("not_found", "There is no such job: read the list again.");
    return job;
  };
  const publish = (): void => {
    changed += 1;
    ctx.push({ jobs: { active: jobs.filter((j) => !over(j)), off, paused, changed } });
  };
  const tell = (job: JobView): void => {
    const notice = endNotice(job, ctx.now());
    if (!notice) return;
    notices = [notice, ...notices.filter((n) => n.id !== notice.id)];
    ctx.push({ notices });
  };

  /** What each job under way had spent and worked before this run of it, and when the run began: a job that carries on adds to what it had. */
  const runs = new Map<string, { since: number; had: AgentUsage; worked: number }>();
  const withRun = (had: AgentUsage, tally: AgentUsage): AgentUsage => {
    const sum: AgentUsage = { calls: had.calls + tally.calls, toolTurns: had.toolTurns + tally.toolTurns, in: had.in + tally.in, cachedIn: had.cachedIn + tally.cachedIn, out: had.out + tally.out, reasoningOut: had.reasoningOut + tally.reasoningOut, estimated: had.estimated || tally.estimated, ms: had.ms + tally.ms };
    // A tally has a cost only while every call so far had one.
    if (had.cost !== undefined && tally.cost !== undefined) sum.cost = had.cost + tally.cost;
    return sum;
  };

  /** A job's run moved on: its spend follows, said to the pages whenever another call has answered. */
  const spent = (id: string, tally: AgentUsage): void => {
    const job = jobs.find((j) => j.id === id);
    const run = runs.get(id);
    if (!job || !run || over(job)) return;
    const usage = withRun(run.had, tally);
    if (usage.calls === job.usage.calls) return;
    put({ ...job, usage });
    publish();
  };

  const finish = (id: string, end: PlayEnd): void => {
    const job = jobs.find((j) => j.id === id);
    if (!job || over(job)) return;
    const now = ctx.now();
    const run = runs.get(id) ?? { since: now, had: noUsage(), worked: 0 };
    runs.delete(id);
    const base: JobView = { ...job, endedAt: now, usage: withRun(run.had, end.trace.tally), workedMs: run.worked + (now - run.since), transcript: end.transcript };
    delete base.paused;
    today += end.trace.tally.in + end.trace.tally.out;
    if (end.state === "done") {
      const text = end.trace.events.flatMap((e) => (e.event.kind === "agent_entry" && e.event.entry.kind === "answer" && e.event.entry.calls.length === 0 ? [e.event.entry.text] : [])).at(-1) ?? "";
      const reported: JobView = { ...base, report: ctx.blobs.put(text), reportChars: text.length, opening: openingOf(text) };
      // A story's run that used its allowance up stops with its report, and waits to be granted more.
      const why = stops.get(id);
      if (why !== undefined) put({ ...reported, state: "spent", reason: why });
      else tell(put({ ...reported, state: "done" }));
    } else if (end.state === "stopped") {
      put({ ...base, state: "cancelled", reason: whys.get(id) ?? "You stopped it from its live view." });
    } else {
      tell(put({ ...base, state: "failed", reason: "Its run ended before it could report." }));
    }
    whys.delete(id);
    stops.delete(id);
    publish();
    startDue();
  };

  /** A job's run begins: its first, or (granted more, or resumed) the next, which carries on from what it had done. */
  const begin = (job: JobView): void => {
    const now = ctx.now();
    runs.set(job.id, { since: now, had: job.usage, worked: job.workedMs ?? 0 });
    const next: JobView = { ...job, state: "running", startedAt: job.startedAt ?? now };
    delete next.endedAt;
    delete next.reason;
    put(next);
    const task = tasks.get(job.id) ?? job.task;
    // The learning of a story plays its own run; each time it writes, the pages are told, so they read the story again.
    const story = stories.has(job.id) ? storyRun(ctx, job, task, { landed: (t) => spent(job.id, t.tally), wrote: publish }) : null;
    if (story !== null && story.spent !== null) stops.set(job.id, story.spent);
    else stops.delete(job.id);
    ctx.play(job.id, story?.steps ?? playSteps(job, task, (t) => spent(job.id, t.tally)), { reply: false, chatId: job.chatId, turn: job.id, done: (end) => finish(job.id, end) });
  };

  /**
   * Starts what may start: the oldest waiting job first, while fewer run than may at once. A job
   * that waits for its chat's next reply is due once a reply of that chat was seen under way and
   * is under way no longer. The stand-in looks only when a page asks it something, which the Jobs
   * page does whenever it is shown again.
   */
  function startDue(): void {
    const replying = new Set(ctx.state().running.flatMap((r) => (isReply(r.kind) && r.chatId !== null ? [r.chatId] : [])));
    for (const job of jobs) {
      if (job.state !== "queued" || job.when !== "after_reply" || due.has(job.id)) continue;
      if (replying.has(job.chatId)) sawReply.add(job.id);
      else if (sawReply.has(job.id)) due.add(job.id);
    }
    if (off || paused) return;
    let started = false;
    for (const job of jobs.filter((j) => j.state === "queued").sort((a, b) => a.createdAt - b.createdAt)) {
      if (jobs.filter((j) => j.state === "running").length >= LIMITS.atOnce) break;
      if (job.when === "after_reply" && !due.has(job.id)) continue;
      begin(job);
      started = true;
    }
    if (started) publish();
  }

  const create = (from: { chatId: string; agent: string; task: string; when: JobWhen; again?: string; allowance?: JobAllowance; story?: true }): JobView => {
    made += 1;
    const job: JobView = { id: `job-new-${made}`, chatId: from.chatId, agent: from.agent, task: opens(from.task), when: from.when, state: "queued", by: YOU, basis: null, ...(from.again !== undefined ? { again: from.again } : {}), ...(from.allowance !== undefined ? { allowance: from.allowance } : {}), createdAt: ctx.now(), usage: noUsage() };
    tasks.set(job.id, from.task);
    // Marked before it may begin, so its first run is the story's own; the part that answers `lah.story.get` names it from now on.
    if (from.story) {
      stories.add(job.id);
      ctx.learning?.(from.chatId, job.id);
    }
    put(job);
    publish();
    startDue();
    return find(job.id);
  };

  if (ctx.ready) {
    const now = ctx.now();
    const waiting = queuedJob(now - 2 * MIN, { id: "main-1", role: "main" });
    tasks.set(waiting.id, waiting.task);
    jobs = [waiting];
    for (const p of PAST) {
      const createdAt = now - p.ago;
      const base: JobView = { id: p.id, chatId: p.chatId, agent: p.agent, task: opens(p.task), when: p.when, state: p.state, by: p.by, basis: p.basis, ...(p.parent !== undefined ? { parent: p.parent } : {}), ...(p.allowance !== undefined ? { allowance: p.allowance } : {}), createdAt, usage: noUsage(), ...(p.reason !== undefined ? { reason: p.reason } : {}) };
      tasks.set(p.id, p.task);
      if (!p.ran) {
        jobs.push({ ...base, endedAt: createdAt + p.waited });
        continue;
      }
      const startedAt = createdAt + p.waited;
      const trace = pastRun(p, startedAt);
      const usage: AgentUsage = p.usage !== undefined ? { ...p.usage } : { ...trace.tally, ...(p.estimated ? { estimated: true } : {}) };
      if (p.estimated) delete usage.cost;
      // It ran at least as long as its calls took and as it worked, so the figures the made-up data names stay in step with its times.
      const ran = Math.max(trace.now - startedAt, usage.ms, p.workedMs ?? 0);
      // A job a restart left paused has not ended: it is held, with no run under way.
      const job: JobView = { ...base, startedAt, ...(p.state === "paused" ? { paused: true as const } : { endedAt: startedAt + ran }), usage, workedMs: p.workedMs ?? ran, transcript: ctx.keep(p.id, trace) };
      if (p.report !== undefined) {
        // A report is kept under a hash the made-up data can name elsewhere: Live's worked turn points at the first timeline job's.
        const hash = fakeHash(`report:${p.id}`);
        ctx.blobs.set(hash, p.report);
        jobs.push({ ...job, report: hash, reportChars: p.report.length, opening: openingOf(p.report) });
      } else jobs.push(job);
      if (startedAt + ran > now - DAY) today += usage.in + usage.out;
    }
    for (const id of ["job-timeline-1", "job-ledger-1"]) {
      const job = jobs.find((j) => j.id === id);
      const notice = job ? endNotice(job, job.endedAt ?? now) : null;
      if (notice) notices.push(notice);
    }
    ctx.push({ jobs: { active: jobs.filter((j) => !over(j)), off, paused, changed }, notices });
  }

  return {
    "lah.jobs.list": (r) => {
      startDue();
      const all = jobs.filter((j) => r.chatId === null || j.chatId === r.chatId).sort((a, b) => b.createdAt - a.createdAt || (a.id < b.id ? 1 : -1));
      // A page starts after the last job the page before it gave, so a job started meanwhile shifts nothing.
      const last = r.cursor === null ? -1 : all.findIndex((j) => j.id === r.cursor);
      if (r.cursor !== null && last < 0) throw new Refusal("invalid", "That place in the list isn't one this list gave: read the list again from the top.");
      const page = all.slice(last + 1, last + 1 + r.limit);
      return { jobs: page, next: last + 1 + r.limit < all.length ? (page.at(-1)?.id ?? null) : null, total: all.length, limits: LIMITS, today: { tokens: today }, agents: MOCK_AGENTS.map((a) => ({ ...a })) };
    },
    "lah.jobs.set": (r) => {
      const was = paused;
      if (r.off !== undefined) off = r.off;
      if (r.paused !== undefined) paused = r.paused;
      if (paused !== was) {
        for (const job of jobs) {
          if (job.state !== "running") continue;
          ctx.pause(job.id, paused);
          const next: JobView = { ...job, ...(paused ? { paused: true as const } : {}) };
          if (!paused) delete next.paused;
          put(next);
        }
      }
      publish();
      startDue();
      return { off, paused };
    },
    "lah.job.start": (r) => {
      if (!ctx.state().chats.some((c) => c.chatId === r.chatId)) throw new Refusal("not_found", "LumiAH doesn't know that chat: open one it answers, or pick one in the bar above.");
      if (!MOCK_AGENTS.some((a) => a.id === r.agent)) throw new Refusal("not_found", `There is no agent "${r.agent}": pick one of those the form offers.`);
      if (r.task.trim() === "") throw new Refusal("invalid", "A job needs a task: say what it is to do.", [{ path: ["task"], message: "Write what the job is to do." }]);
      if (r.task.length > TASK_CHARS) throw new Refusal("invalid", `A job's task holds ${TASK_CHARS} characters at most: put the details in a workspace file and name the file in the task.`, [{ path: ["task"], message: `${r.task.length} characters; ${TASK_CHARS} at most.` }]);
      if (off) throw new Refusal("unavailable", OFF_WORDS);
      const job = create({ chatId: r.chatId, agent: r.agent, task: r.task.trim(), when: r.when, ...(r.allowance !== undefined ? { allowance: r.allowance } : {}), ...(r.story === true ? { story: true as const } : {}) });
      return { job };
    },
    "lah.job.cancel": (r) => {
      const job = find(r.id);
      if (over(job)) throw new Refusal("conflict", `It is over already (${STATE_WORDS[job.state]}), so there is nothing to cancel.`);
      if (job.state === "running") {
        whys.set(job.id, "You cancelled it.");
        ctx.stop(job.id, "You cancelled the job.");
      }
      // A job that waited has no run to stop; one whose run is gone (none was held under its id) ends here too.
      const now = find(r.id);
      if (!over(now)) {
        const ended: JobView = { ...now, state: "cancelled", endedAt: ctx.now(), reason: job.state === "running" ? "You cancelled it." : "You cancelled it before it started." };
        delete ended.paused;
        put(ended);
        whys.delete(job.id);
        publish();
        startDue();
      }
      return { job: find(r.id) };
    },
    "lah.job.again": (r) => {
      const job = find(r.id);
      if (job.state !== "interrupted" && job.state !== "failed" && job.state !== "cancelled") throw new Refusal("conflict", `Only a job that was interrupted, failed or was cancelled can be started again; this one is ${STATE_WORDS[job.state]}.`);
      if (off) throw new Refusal("unavailable", OFF_WORDS);
      // Started again, the learning of a story is still that: the new job takes the old one's place as the chat's.
      return { job: create({ chatId: job.chatId, agent: job.agent, task: tasks.get(job.id) ?? job.task, when: "now", again: job.id, ...(stories.has(job.id) ? { story: true as const } : {}) }) };
    },
    "lah.job.grant": (r) => {
      const job = find(r.id);
      if (job.state !== "spent") throw new Refusal("conflict", `Only a job that stopped at its allowance can be granted more; this one is ${STATE_WORDS[job.state]}.`);
      // It waits its turn like any other, and runs on from what it had done: while jobs are off or paused it stays queued.
      const next: JobView = { ...job, state: "queued", allowance: r.allowance };
      delete next.endedAt;
      delete next.reason;
      put(next);
      publish();
      startDue();
      return { job: find(r.id) };
    },
    "lah.job.resume": (r) => {
      const job = find(r.id);
      if (job.state !== "paused") throw new Refusal("conflict", job.state === "running" ? "It is running: hold it and let it go on from the bar under its work." : `Only a job that is paused with no run under way can be resumed; this one is ${STATE_WORDS[job.state]}.`);
      const next: JobView = { ...job, state: "queued" };
      delete next.paused;
      delete next.reason;
      put(next);
      publish();
      startDue();
      return { job: find(r.id) };
    },
    "lah.notice.dismiss": (r) => {
      // A notice dismissed on another page a moment ago is gone already: saying so again is no failure.
      notices = r.id === null ? [] : notices.filter((n) => n.id !== r.id);
      ctx.push({ notices });
      return { notices };
    },
  };
}
