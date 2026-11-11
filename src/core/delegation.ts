// Delegation (DESIGN §14): an agent hands a task to another, which works in a session of its own
// and answers; the handle its answer names lives until the run ends, and `agent_message` goes on
// with that agent under its own revision cap.
//
// Every limit is a setting: how deep delegation goes, how many sub-agents work at once in a run,
// how many a run may start, what a sub-agent may be given (never more than the agent that started
// it holds, unless Settings say its own definition's), and how much of the files a task names goes
// with it. A sub-agent is started like every agent of the run (`Run.agent`), so it has the run's
// guidance, its own pinned files and the workspace under its own name: its writes are versioned
// writes of its own. Its steps go to the run's trace under the agent that started it.

import type { AgentDefinition } from "./agents";
import { Gate } from "./gate";
import { type AgentHandle, type AgentReply, cutShort } from "./loop";
import type { Run } from "./run";
import { TEXT } from "./texts";
import type { DelegateChoice, Delegation, ToolCtx, ToolOutcome } from "./tools";
import { clip, limitOf } from "./util";
import { readFile, showPath, versionOf, type WorkspaceView } from "./workspace";

/** The agent that delegates, as the run started it: its definition, how deep it stands, the tools it holds (filled once they are built), and the workspace as it holds it. */
export interface Delegating {
  definition: string;
  depth: number;
  held: ReadonlySet<string>;
  view: WorkspaceView;
}

/** A sub-agent of the run: its handle, the definition it runs as, and the agent that started it, which alone may message it. */
interface Started {
  agent: AgentHandle;
  definition: string;
  owner: string;
}

const choiceOf = (d: AgentDefinition): DelegateChoice => ({ id: d.id, name: d.name, description: d.description });

export class Delegator {
  /** Sub-agents at work at once in the run: one past the setting waits its turn. */
  private readonly gate: Gate;
  private readonly started = new Map<string, Started>();
  /**
   * The places taken of Sub-agents per turn: every sub-agent the run started, and every start
   * still being made. A start asks for its place and takes it in one step, with no wait between:
   * the calls of one answer run at once, and each has to find the place the one before it took.
   */
  private taken = 0;

  constructor(private readonly run: Run) {
    this.gate = new Gate(() => run.settings.delegation.atOnce);
  }

  /** Delegation as one agent of the run has it; undefined where Settings' depth gives it none. */
  for(from: Delegating): Delegation | undefined {
    const { run } = this;
    if (from.depth >= run.settings.delegation.depth) return undefined;
    return {
      agents: () => run.definitions.workers(from.definition).map(choiceOf),
      start: (input, ctx) => this.start(from, input, ctx),
      message: (input, ctx) => this.message(input, ctx),
    };
  }

  /** The run ended: its sub-agents' handles end with it. */
  close(): void {
    for (const { agent } of this.started.values()) agent.cancel();
    this.started.clear();
  }

  private async start(from: Delegating, input: { agent: string; task: string; files: readonly string[] }, ctx: ToolCtx): Promise<ToolOutcome> {
    const { run } = this;
    const { settings, texts } = run;
    const workers = run.definitions.workers(from.definition);
    const resolved = workers.some((d) => d.id === input.agent) ? run.resolve(input.agent) : undefined;
    if (!resolved) return run.refusal(TEXT.agents.noAgent, { agent: clip(input.agent, settings.tools.lineChars), agents: workers.map((d) => d.id).join(", ") });
    // The files a task names go with it whole while Settings give them room; one that doesn't fit is named, for the sub-agent to read itself.
    let room = settings.delegation.fileChars;
    const files: string[] = [];
    for (const raw of input.files) {
      const file = await readFile(from.view, raw, settings.workspace.pathChars);
      if (!file) return run.refusal(TEXT.agents.noFile, { path: clip(raw, settings.tools.lineChars) });
      const path = showPath(file.area, file.path);
      if (file.text.length > room) files.push(texts.render(TEXT.agents.fileNamed, { path, chars: String(file.text.length) }));
      else {
        room -= file.text.length;
        files.push(texts.render(TEXT.agents.file, { path, chars: String(file.text.length), version: versionOf(file.entry.hash), text: file.text }));
      }
    }
    // Only now, with its files read: a call refused for a file that isn't there never holds a place that another call of the same answer is then refused for.
    // A turn's sub-agents are counted against Sub-agents per turn; a job's against Delegations per job, which as shipped is no limit: what the job may spend bounds them.
    const job = run.info.kind === "job";
    const most = job ? settings.jobs.delegations : settings.delegation.perRun;
    if (this.taken >= limitOf(most)) return run.refusal(job ? TEXT.jobs.tooManyDelegated : TEXT.agents.tooMany, { limit: texts.counted(most ?? 0, TEXT.agents.wordSubAgent) });
    this.taken++;
    let began = false;
    try {
      const leave = await this.gate.enter(ctx.signal);
      try {
        const { agent, lead } = await run.agent(resolved, {
          depth: from.depth + 1,
          parent: ctx.agentId,
          task: clip(input.task, settings.reply.progressChars),
          // What the agent that starts it holds itself, unless its own definition says it keeps its tools whoever starts it, or, where the definition says nothing, Settings give a sub-agent whatever its definition names.
          ...((resolved.definition.grant ?? settings.delegation.grant) === "own" ? { grant: from.held } : {}),
        });
        this.started.set(agent.id, { agent, definition: resolved.definition.id, owner: ctx.agentId });
        began = true;
        const { request } = run;
        const task = texts.render(TEXT.agents.task, {
          task: input.task,
          files: files.length > 0 ? texts.render(TEXT.agents.taskFiles, { files: files.join("\n\n") }) : "",
          request: resolved.definition.given === "request" && request ? texts.render(TEXT.agents.taskRequest, { count: request.count, request: request.text }) : "",
        });
        return this.answered(resolved.definition.id, agent.id, await agent.send(lead === "" ? task : `${lead}\n\n${task}`, ctx.signal));
      } finally {
        leave();
      }
    } finally {
      // A start that failed before its agent was made (its wait for a place at work was ended, the agent couldn't be started) started nobody: its place is free again.
      if (!began) this.taken--;
    }
  }

  private async message(input: { handle: string; text: string }, ctx: ToolCtx): Promise<ToolOutcome> {
    const { run } = this;
    const { settings } = run;
    // A handle is the agent's own to use: an agent messages those it started, never another's.
    const own = [...this.started.entries()].filter(([, started]) => started.owner === ctx.agentId);
    const found = own.find(([id]) => id === input.handle)?.[1];
    if (!found) return own.length === 0 ? run.refusal(TEXT.agents.noHandles) : run.refusal(TEXT.agents.noHandle, { handle: clip(input.handle, settings.tools.lineChars), handles: own.map(([id]) => id).join(", ") });
    const leave = await this.gate.enter(ctx.signal);
    try {
      return this.answered(found.definition, found.agent.id, await found.agent.send(input.text, ctx.signal));
    } finally {
      leave();
    }
  }

  /** What the delegating agent is told: the sub-agent's answer with its handle, or that it stopped short, why, and what it had last written. An answer cut at its length is told as one that stopped short: it isn't the whole of what the agent meant to say. */
  private answered(definition: string, handle: string, reply: AgentReply): ToolOutcome {
    const { texts } = this.run;
    const cut = reply.status === "answered" && cutShort(reply.finish);
    if (reply.status === "answered" && !cut && reply.text.trim() !== "") return { text: texts.render(TEXT.agents.answer, { answer: reply.text, agent: definition, handle }) };
    const reason = cut ? texts.render(TEXT.agents.cut) : (reply.reason ?? texts.render(TEXT.answer.replyEmpty));
    return { text: texts.render(TEXT.agents.stopped, { agent: definition, handle, reason, said: reply.text.trim() === "" ? "" : texts.render(TEXT.agents.stoppedSaid, { text: reply.text }) }), error: true };
  }
}
