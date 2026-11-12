// Delegation (DESIGN §14): an agent hands a task to another, which works in a session of its own
// and answers; the handle its answer names lives until the run ends, and `agent_message` goes on
// with that agent under its own revision cap. An agent that may write the reply itself may hand it
// on (`to_reply`): the sub-agent's answer then streams into the reply as it is written, and is the
// call's result too.
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
import type { ModelDelta } from "./ports";
import type { Run } from "./run";
import { TEXT } from "./texts";
import type { DelegateChoice, Delegation, ReplyStream, ToolCtx, ToolOutcome } from "./tools";
import { clip, limitOf } from "./util";
import { readFile, showPath, versionOf, type WorkspaceView } from "./workspace";

/** The agent that delegates, as the run started it: its definition, how deep it stands, the tools it holds (filled once they are built), the workspace as it holds it, and the reply where it may hand that on. */
export interface Delegating {
  definition: string;
  depth: number;
  held: ReadonlySet<string>;
  view: WorkspaceView;
  reply?: ReplyStream;
}

/**
 * A sub-agent's answer on its way into the reply (`to_reply`): the text of each of its model calls
 * is held until it is `hold` characters long or the call ends without a tool call, then released;
 * what a call that ends in tool calls had held is never released. `released` is all it let out.
 */
class ReplyHold {
  /** The text of the call under way, as it streamed, and how much of it is out. */
  private seen = "";
  private sent = 0;
  released = "";

  constructor(
    private readonly reply: ReplyStream,
    private readonly hold: number,
  ) {}

  /** A piece of a call's answer as it arrives. Its reasoning stays the agent's own: the reply's thinking block is the user's to read, and an agent's thoughts may hold what the user's character doesn't know. */
  delta(delta: ModelDelta): void {
    if (delta.content === undefined || delta.content === "") return;
    this.seen += delta.content;
    if (this.seen.length >= this.hold) this.out(this.seen.slice(this.sent));
  }

  /** A call came back: with no tool call it is the answer, all of it out (a host that streams nothing gives it whole here); with tool calls, what it held is let go. */
  call(answer: { text: string; calls: number }): void {
    if (answer.calls === 0) this.out((answer.text.startsWith(this.seen) ? answer.text : this.seen).slice(this.sent));
    this.seen = "";
    this.sent = 0;
  }

  private out(text: string): void {
    if (text === "") return;
    this.sent += text.length;
    // What went nowhere (the turn was stopped) was never released.
    if (this.reply.stream(text)) this.released += text;
  }
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
      // `as` names an instance for an extension's tools and its model hook: a harness without an extension offers delegate as it always did.
      offersAs: run.shared.options.extension !== undefined,
      toReply: from.reply !== undefined,
      start: (input, ctx) => this.start(from, input, ctx),
      message: (input, ctx) => this.message(input, ctx),
    };
  }

  /** The run ended: its sub-agents' handles end with it. */
  close(): void {
    for (const { agent } of this.started.values()) agent.cancel();
    this.started.clear();
  }

  private async start(from: Delegating, input: { agent: string; task: string; files: readonly string[]; as?: string; toReply?: boolean }, ctx: ToolCtx): Promise<ToolOutcome> {
    const { run } = this;
    const { settings, texts } = run;
    const workers = run.definitions.workers(from.definition);
    const resolved = workers.some((d) => d.id === input.agent) ? run.resolve(input.agent) : undefined;
    if (!resolved) return run.definitions.without.has(input.agent) ? run.refusal(TEXT.agents.notOffered, { agent: clip(input.agent, settings.tools.lineChars) }) : run.refusal(TEXT.agents.noAgent, { agent: clip(input.agent, settings.tools.lineChars), agents: workers.map((d) => d.id).join(", ") });
    if (input.as !== undefined && input.as.length > settings.delegation.asChars) return run.refusal(TEXT.agents.asLong, { chars: String(input.as.length), limit: String(settings.delegation.asChars) });
    // Only an agent that may write the reply hands it on, and only while the reply can take text: never while the writer or another agent's answer is at it.
    const reply = input.toReply === true ? from.reply : undefined;
    if (input.toReply === true && !reply) return run.refusal(TEXT.agents.noReply);
    const shut = reply?.refused() ?? null;
    if (shut !== null) return { text: shut, error: true };
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
        const hold = reply ? new ReplyHold(reply, settings.delegation.replyHoldChars) : null;
        const { agent, lead } = await run.agent(resolved, {
          depth: from.depth + 1,
          parent: ctx.agentId,
          task: clip(input.task, settings.reply.progressChars),
          // What the agent that starts it holds itself, unless its own definition says it keeps its tools whoever starts it, or, where the definition says nothing, Settings give a sub-agent whatever its definition names.
          ...((resolved.definition.grant ?? settings.delegation.grant) === "own" ? { grant: from.held } : {}),
          ...(input.as !== undefined ? { as: input.as } : {}),
          standing: "sub",
          by: run.ref(ctx.agentId) ?? { agentId: ctx.agentId, role: ctx.role },
          // An agent whose answer is the reply writes it as its answer: it is given no reply of its own to write besides.
          ...(hold ? { onDelta: (delta: ModelDelta) => hold.delta(delta), onCall: (answer: { text: string; calls: number }) => hold.call(answer), replying: true as const } : {}),
        });
        this.started.set(agent.id, { agent, definition: resolved.definition.id, owner: ctx.agentId });
        began = true;
        const { request } = run;
        const task = texts.render(TEXT.agents.task, {
          task: input.task,
          files: files.length > 0 ? texts.render(TEXT.agents.taskFiles, { files: files.join("\n\n") }) : "",
          request: resolved.definition.given === "request" && request ? (request.newest ? texts.render(TEXT.agents.taskNewest, { request: request.text }) : texts.render(TEXT.agents.taskRequest, { count: request.count, request: request.text })) : "",
        });
        const sent = lead === "" ? task : `${lead}\n\n${task}`;
        if (!reply || !hold) return this.answered(resolved.definition.id, agent.id, await agent.send(sent, ctx.signal));
        // Asked again at the last moment, and the reply held in the same step: two agents' answers released at once would interleave.
        const late = reply.refused();
        if (late !== null) return { text: late, error: true };
        const letGo = reply.hold(run.ref(agent.id) ?? { agentId: agent.id, role: resolved.definition.id, ...(input.as !== undefined ? { as: input.as } : {}) });
        try {
          const answer = await agent.send(sent, ctx.signal);
          // Its result is what reached the reply: all of its answers' text that was released, in order.
          return this.answered(resolved.definition.id, agent.id, hold.released === "" ? answer : { ...answer, text: hold.released });
        } finally {
          letGo(hold.released);
        }
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
