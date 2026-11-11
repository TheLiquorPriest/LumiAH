// The job tools (DESIGN §15): job_start, job_list, job_read and job_cancel. The run does the work
// (`JobTools`); these read the call and say what came of it.
//
// `job_start` is the one way an agent starts a job: its `run` below is the only caller of
// `JobTools.start`, and a test fails if anything else in the core is.
//
// The two that change something (`job_start`, `job_cancel`) read their signal before anything else:
// once the round that called them has ended, no job is queued and none is stopped. The two that
// look (`job_read`, `job_list`) say when what they look at is still moving (`AgentTool.state`): a
// job that hasn't ended is asked about anew each time, whatever words the last look gave, so
// waiting for one is never taken for a model going round. Once every job a look showed has ended,
// the state stands still, and asking the same again and again is a loop like any other.

import { jobBy, jobEnded, jobLeft, jobState } from "../job-words";
import type { JobView, JobWhen, JsonObject } from "../ports";
import { FAMILY, TEXT, TOOL } from "../texts";
import type { JobRead, ToolCtx, ToolDefinition, ToolEnv, ToolOutcome } from "../tools";
import { clip, textArg } from "../util";
import { listPage, needs, pagerOf, readCursor, saidBack, textPage } from "./paging";

/** When a call asks its job to run: after the reply unless it says now; null for anything else. */
function whenOf(raw: unknown): JobWhen | null {
  if (raw === undefined || raw === null || raw === "") return "after_reply";
  return raw === "now" || raw === "after_reply" ? raw : null;
}

const jobStart: ToolDefinition = {
  name: TOOL.jobStart,
  family: FAMILY.jobs,
  tier: "write",
  build(env: ToolEnv) {
    const { texts, jobs } = env;
    const start = jobs?.start?.bind(jobs);
    const choices = jobs?.agents() ?? [];
    if (!start || choices.length === 0) return null;
    const p = pagerOf(env, TOOL.jobStart);
    return {
      name: TOOL.jobStart,
      description: texts.render(TEXT.tool(TOOL.jobStart), { agents: choices.map((c) => texts.render(TEXT.agents.choice, { id: c.id, name: c.name, description: c.description })).join("\n") }),
      parameters: {
        type: "object",
        properties: {
          agent: { type: "string", enum: choices.map((c) => c.id), description: texts.render(TEXT.toolArg(TOOL.jobStart, "agent")) },
          task: { type: "string", description: texts.render(TEXT.toolArg(TOOL.jobStart, "task")) },
          when: { type: "string", enum: ["after_reply", "now"], description: texts.render(TEXT.toolArg(TOOL.jobStart, "when")) },
          again: { type: "string", description: texts.render(TEXT.toolArg(TOOL.jobStart, "again")) },
        },
      },
      async run(args: JsonObject, ctx: ToolCtx): Promise<ToolOutcome> {
        // As delegate does: a round that has ended starts no job.
        ctx.signal.throwIfAborted();
        const when = whenOf(args.when);
        if (when === null) return needs(p, "when");
        const again = textArg(args.again);
        const agent = textArg(args.agent);
        const task = textArg(args.task);
        if (again === null && (agent === null || task === null)) return { text: texts.render(TEXT.jobs.noTask), error: true };
        const started = await start(again !== null ? { again, when } : { agent: agent ?? "", task: task ?? "", when }, ctx);
        // A refusal says back the id or the agent the call gave, at most Line length of it (`createJob` writes it, for the page too), and names the agents there are: it is kept within Answer length here, as every answer is.
        if ("refused" in started) return { text: clip(started.refused, p.pageChars), error: true };
        return { text: texts.render(TEXT.jobs.started, { id: started.id, agent: started.agent, when: texts.render(when === "now" ? TEXT.jobs.whenNow : TEXT.jobs.whenAfter) }) };
      },
    };
  },
};

const jobList: ToolDefinition = {
  name: TOOL.jobList,
  family: FAMILY.jobs,
  tier: "read",
  build(env: ToolEnv) {
    const { texts, jobs } = env;
    if (!jobs) return null;
    const p = pagerOf(env, TOOL.jobList);
    // How many of its looks showed a job that hadn't ended: the state a call finds (`AgentTool.state`).
    let moving = 0;
    return {
      name: TOOL.jobList,
      description: texts.render(TEXT.tool(TOOL.jobList)),
      parameters: { type: "object", properties: { cursor: { type: "string", description: texts.render(TEXT.toolArg(TOOL.jobList, "cursor")) } } },
      state: () => moving,
      async run(args: JsonObject): Promise<ToolOutcome> {
        const cursor = readCursor(p, args);
        if ("text" in cursor) return cursor;
        const all = await jobs.list();
        if (all.length === 0) return { text: texts.render(TEXT.jobs.none) };
        // Whether the page holds a job that hasn't ended: the lines written for it say (one past its end, written and then left out for room, counts with them).
        let live = false;
        const page = listPage(p, {
          total: all.length,
          noun: TEXT.jobs.word,
          cursor,
          item: (i) => {
            const job = all[i];
            if (job && !jobEnded(job)) live = true;
            return job ? texts.render(TEXT.jobs.line, { id: job.id, agent: job.agent, state: jobState(job, texts), by: jobBy(job, texts), task: job.task, report: jobLeft(job, texts) }) : "";
          },
        });
        if (live) moving += 1;
        return page;
      },
    };
  },
};

const jobRead: ToolDefinition = {
  name: TOOL.jobRead,
  family: FAMILY.jobs,
  tier: "read",
  build(env: ToolEnv) {
    const { texts, jobs } = env;
    if (!jobs) return null;
    const p = pagerOf(env, TOOL.jobRead);
    // How many of its reads found a job that hadn't ended: the state a call finds (`AgentTool.state`).
    let moving = 0;
    /** What heads the answer. Its first page gives the task whole; a later page, which the model asked for by cursor, gives how it opens, so the page keeps its room for the report. */
    const head = (read: JobRead, whole: boolean): string => {
      const { job } = read;
      // A job that ended without its report says why; one still under way, or done, has nothing to add here.
      const reason = job.reason !== undefined && job.state !== "done" ? ` ${clip(job.reason, env.settings.tools.lineChars)}.` : "";
      return texts.render(TEXT.jobs.read, { id: job.id, agent: job.agent, state: jobState(job, texts), by: jobBy(job, texts), tokens: texts.counted(job.usage.in + job.usage.out, TEXT.word.token), calls: texts.counted(job.usage.calls, TEXT.jobs.wordCall), reason, task: whole ? read.task : job.task });
    };
    return {
      name: TOOL.jobRead,
      description: texts.render(TEXT.tool(TOOL.jobRead)),
      parameters: {
        type: "object",
        properties: { job: { type: "string", description: texts.render(TEXT.toolArg(TOOL.jobRead, "job")) }, cursor: { type: "string", description: texts.render(TEXT.toolArg(TOOL.jobRead, "cursor")) } },
        required: ["job"],
      },
      state: () => moving,
      async run(args: JsonObject): Promise<ToolOutcome> {
        const cursor = readCursor(p, args);
        if ("text" in cursor) return cursor;
        const id = textArg(args.job);
        if (id === null) return needs(p, "job");
        const read = await jobs.read(id);
        // The id asked for is said back clipped: a model that sends a page of text for an id doesn't get the page back.
        if (!read) return { text: saidBack(p, id, (said) => texts.render(TEXT.jobs.noJob, { id: said })), error: true };
        if (!jobEnded(read.job)) moving += 1;
        const heading = head(read, !cursor.given);
        const { report } = read;
        if (report === null) return { text: texts.render(TEXT.jobs.noReport, { head: heading }) };
        return textPage(p, { text: report, from: cursor.at, given: cursor.given, frame: (part) => texts.render(TEXT.jobs.reportPage, { head: heading, from: String(part.from), to: String(part.to), total: String(report.length), text: part.text }) });
      },
    };
  },
};

const jobCancel: ToolDefinition = {
  name: TOOL.jobCancel,
  family: FAMILY.jobs,
  tier: "write",
  build(env: ToolEnv) {
    const { texts, jobs } = env;
    if (!jobs) return null;
    const p = pagerOf(env, TOOL.jobCancel);
    return {
      name: TOOL.jobCancel,
      description: texts.render(TEXT.tool(TOOL.jobCancel)),
      parameters: { type: "object", properties: { job: { type: "string", description: texts.render(TEXT.toolArg(TOOL.jobCancel, "job")) } }, required: ["job"] },
      async run(args: JsonObject, ctx: ToolCtx): Promise<ToolOutcome> {
        // As job_start does: a round that has ended stops no job.
        ctx.signal.throwIfAborted();
        const id = textArg(args.job);
        if (id === null) return needs(p, "job");
        const done = await jobs.cancel(id, ctx);
        if (!done) return { text: saidBack(p, id, (said) => texts.render(TEXT.jobs.noJob, { id: said })), error: true };
        const job: JobView = done.job;
        return done.cancelled ? { text: texts.render(TEXT.jobs.cancelled, { id: job.id }) } : { text: texts.render(TEXT.jobs.ended, { id: job.id, state: jobState(job, texts) }) };
      },
    };
  },
};

export const JOB_TOOLS: readonly ToolDefinition[] = [jobStart, jobList, jobRead, jobCancel];
