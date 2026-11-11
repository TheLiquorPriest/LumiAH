// A run (DESIGN §4, §11 to §18): what a turn that answers a generation, a job's run and a turn of a
// side session have in common. Each is one or more agents at work under one budget, with one trace.
//
// A run reads everything the user may have changed when it starts: their settings and texts, their
// definitions merged with the extension's and the core's own (§13), the tools that run in the
// extension, what the extension supplies for the run's chat (§21), and the guidance its agents are
// given (§12). Then every agent of the run is started the same way (`Run.agent`): its definition's
// instructions under the guidance, the skills it may load, its tools built for it, the workspace as
// it may use it, and the files pinned for it. That is the one place an agent's prompt is put
// together, so the main agent, a sub-agent, a job's agent and a side session's are told the same
// things in the same order.

import type { AgentDefinition, AgentRegistry, ResolvedAgent } from "./agents";
import { approvalGate, ChatApprovals } from "./approval";
import type { Areas } from "./areas";
import type { Blobs } from "./blobs";
import { type Book, readBook } from "./book";
import type { CompactionMemo } from "./compaction";
import { type Definitions, mergeDefinitions } from "./definitions";
import { Delegator } from "./delegation";
import type { ChatClaim, HarnessExtension } from "./extension";
import { type GuidanceRead, guidanceGuard, guidancePrefix, readGuidance } from "./guidance";
import type { Jobs } from "./jobs";
import { type AgentDeps, type AgentHandle, AgentTurn, type RunWords, startAgent } from "./loop";
import type { AgentRef, AgentUsage, ChatInfo, FileChange, HarnessHost, ModelDelta, ModelMessage, RecordJob, RemoteTool, SamplingParams, TraceEvent, TurnRequest, TurnStatus, WorkspaceArea } from "./ports";
import { isRecord } from "./ports";
import type { AgentAccounts } from "./provider";
import { type RecallRun, recallOf } from "./recall/recall";
import type { Sessions } from "./sessions";
import { type AgentBudget, type Settings, settingsOf, type TurnBudget } from "./settings";
import type { SkillRegistry } from "./skills";
import type { Spend } from "./spend";
import { TEXT, TOOL, type Texts, textDef, textsOf } from "./texts";
import type { AgentTool, ChatView, DelegateChoice, JobStarted, JobTools, LoreView, PastTurn, RunInfo, ToolEnv, ToolOutcome, ToolRegistry } from "./tools";
import { TurnTrace } from "./transcript";
import { addUsage, countedIn, priced } from "./usage";
import { clip, errorText, type Limit, limitOf, timerMs } from "./util";
import { type AreaAccess, pinnedFiles, showPath, versionOf, type Workspace, type WorkspaceView } from "./workspace";

// ---------------------------------------------------------------- what a harness keeps across runs

/** What the host keeps for the user, as stored: their settings, their own texts by id, and their own definitions (§13). */
export interface StoredState {
  values: unknown;
  texts: unknown;
  definitions?: unknown;
}

export interface HarnessOptions {
  /**
   * The user's settings, texts and definitions as stored, read at the start of every run: the
   * core's settings object (whole or in part: the core fills in its defaults), the user's own texts
   * by id, and their own definitions. So whatever the user changed holds from the next run on.
   */
  settings(): Promise<StoredState>;
  /** What the extension that builds LumiAH into itself supplies (§21). */
  extension?: HarnessExtension;
  /**
   * Whose harness this is: the user every call of the extension's is said to be for. A turn says its
   * own (`TurnRequest.userId`), which stands for that turn. Without either, the extension is told
   * no user (`""`): enough where its backend serves one user, as behind a runtime's link.
   */
  userId?: string;
}

/** What a harness keeps across runs. */
export interface Shared {
  host: HarnessHost;
  options: HarnessOptions;
  /** What is written in code: the core's own tools, agent definitions and skills, and whatever was registered beside them. `core` names the core's own. */
  tools: ToolRegistry;
  agents: AgentRegistry;
  skills: SkillRegistry;
  core: { agents: ReadonlySet<string>; skills: ReadonlySet<string>; tools: ReadonlySet<string> };
  accounts: AgentAccounts;
  blobs: Blobs;
  sessions: Sessions;
  memo: CompactionMemo;
  workspace: Workspace;
  areas: Areas;
  spend: Spend;
  jobs: Jobs;
  /** The runs under way, by id: what the user talks to, holds and lets go (§18). */
  runs: Map<string, Run>;
  /** The settings of the run read last: what the memory limits and the caps are read from between runs. */
  latest: Settings;
}

// ---------------------------------------------------------------- the extension, asked

/**
 * One call of the extension's, waited for no longer than Settings allow: its answer, or `fallback`
 * when it fails or doesn't come in time. An extension adds to a run and never holds one.
 */
export async function askExtension<T>(shared: Pick<Shared, "host" | "options">, what: string, waitMs: Limit, call: (() => Promise<T>) | undefined, fallback: T): Promise<T> {
  if (!call) return fallback;
  const { host } = shared;
  const over = new AbortController();
  const ms = timerMs(limitOf(waitMs));
  const late =
    ms === null
      ? null
      : host.clock.sleep(ms, over.signal).then(() => {
          throw new Error(`no answer in ${ms} ms (Wait for the extension)`);
        });
  // The wait that lost the race is ended below and rejects with nobody waiting on it.
  late?.catch(() => undefined);
  try {
    return await (late ? Promise.race([call(), late]) : call());
  } catch (error) {
    host.log("warn", `[LumiAH] ${shared.options.extension?.name ?? "the extension"} gave no ${what} (${errorText(error)}): the run goes on without it`);
    return fallback;
  } finally {
    over.abort();
  }
}

const TIERS: readonly string[] = ["read", "write", "external"];

/** The tools that run in the extension, as its port lists them now: outside data, so one that isn't a tool is left out, and a port that fails gives none. */
async function remoteTools(host: Pick<HarnessHost, "tools" | "log">, chatId: string): Promise<RemoteTool[]> {
  if (!host.tools) return [];
  let listed: unknown;
  try {
    listed = await host.tools.list(chatId);
  } catch (error) {
    host.log("warn", `[LumiAH] the extension's tools couldn't be listed (${errorText(error)}): this run has none of them`);
    return [];
  }
  return (Array.isArray(listed) ? listed : []).flatMap((tool: unknown): RemoteTool[] => {
    const ok = isRecord(tool) && typeof tool.name === "string" && tool.name !== "" && typeof tool.family === "string" && typeof tool.tier === "string" && TIERS.includes(tool.tier) && typeof tool.description === "string" && isRecord(tool.parameters) && (tool.source === "extension" || tool.source === "user");
    if (!ok) host.log("warn", `[LumiAH] a tool the extension listed isn't one (${isRecord(tool) && typeof tool.name === "string" && tool.name !== "" ? tool.name : "no name"}): it isn't offered`);
    return ok ? [tool as unknown as RemoteTool] : [];
  });
}

/** What the extension answered for a chat, read: outside data, so anything that isn't a claim's is left out. Null stays null: the chat isn't claimed. */
function claimOf(raw: unknown): ChatClaim | null {
  if (!isRecord(raw)) return null;
  const guidance = isRecord(raw.guidance) && typeof raw.guidance.name === "string" ? raw.guidance : null;
  return {
    ...(typeof raw.mainAgent === "string" ? { mainAgent: raw.mainAgent } : {}),
    ...(guidance && typeof guidance.path === "string" ? { guidance: { name: guidance.name as string, path: guidance.path } } : guidance && typeof guidance.text === "string" ? { guidance: { name: guidance.name as string, text: guidance.text } } : {}),
    ...(Array.isArray(raw.withdraw) ? { withdraw: raw.withdraw.filter((name): name is string => typeof name === "string") } : {}),
  };
}

// ---------------------------------------------------------------- what a run reads when it starts

/** What a run works with: whose it is, the user's settings and texts as they stand, the definitions merged from their three sources, the run's chat, and what the extension supplies for it. */
export interface Setup {
  userId: string;
  settings: Settings;
  texts: Texts;
  definitions: Definitions;
  chat: ChatInfo | null;
  claim: ChatClaim | null;
}

/**
 * Reads what a run about `chatId` works with (`""`: about no chat), for the user the harness serves
 * or the one a turn names. Rejects when the user's settings can't be read: running on the defaults
 * would call models the user didn't choose.
 */
export async function readSetup(shared: Shared, chatId: string, userId: string = shared.options.userId ?? ""): Promise<Setup> {
  const { host, options } = shared;
  const stored = await options.settings();
  const extension = options.extension;
  // How long the extension is waited for is a setting too, so it is read before anything is asked of it.
  const { waitMs } = settingsOf(stored.values).extension;
  let chat: ChatInfo | null = null;
  if (chatId !== "") {
    try {
      chat = (await host.chat.info?.(chatId)) ?? null;
    } catch (error) {
      host.log("warn", `[LumiAH] the chat ${chatId} couldn't be read (${errorText(error)}): this run has no character's guidance`);
    }
  }
  const asked: ChatInfo = chat ?? { id: chatId, name: "", characterId: null, characterName: null, branchedFrom: null };
  const [own, claimed, remote] = await Promise.all([
    askExtension<unknown>(shared, "definitions", waitMs, extension?.definitions ? () => extension.definitions?.({ userId, chatId: chatId === "" ? null : chatId }) ?? Promise.resolve({}) : undefined, {}),
    chatId === "" ? null : askExtension<unknown>(shared, "answer for the chat", waitMs, extension?.claim ? () => extension.claim?.({ userId, chatId, chat: asked }) ?? Promise.resolve(null) : undefined, null),
    remoteTools(host, chatId),
  ]);
  const supplied = isRecord(own) ? own : {};
  const claim = claimOf(claimed);
  const definitions = mergeDefinitions(
    {
      code: { agents: shared.agents.all(), skills: shared.skills.all(), tools: shared.tools.all() },
      core: shared.core,
      extension: { agents: Array.isArray(supplied.agents) ? supplied.agents : [], skills: Array.isArray(supplied.skills) ? supplied.skills : [] },
      remote,
      user: stored.definitions,
      claim,
    },
    host,
  );
  const settings = settingsOf(stored.values, definitions.scope());
  shared.latest = settings;
  return { userId, settings, texts: textsOf(stored.texts), definitions, chat, claim };
}

/** An agent definition's instructions as they are sent: the user's text for a definition that names one of the core's, else its own. */
export function instructionsOf(definition: AgentDefinition, texts: Texts): string {
  return definition.text !== undefined && textDef(definition.text) ? texts.render(definition.text) : definition.instructions;
}

const choiceOf = (d: AgentDefinition): DelegateChoice => ({ id: d.id, name: d.name, description: d.description });

// ---------------------------------------------------------------- a run

/** What a run is, from its first moment: its id and kind, its budget and the words its budget stops with, and what its trace says it is the work of. */
export interface RunStart {
  info: RunInfo;
  budget: TurnBudget;
  words?: RunWords;
  startedAt: number;
  /** The message a turn's reply goes to. */
  messageId: string | null;
  /** The job this is the run of, or the side session this is a turn of. */
  job?: string;
  side?: string;
  /** The generation a turn answers. */
  turn?: TurnRequest;
  /** Hears every event of the run's trace as it is made. */
  heard?: (event: TraceEvent) => void;
  /** What earlier runs of the same work spent and how long they worked (a job carried on, §22): it counts against this run's budget from its first call. */
  spent?: { usage: AgentUsage; workedMs: number };
  /** Told when the user holds the run and when they let it go. */
  held?: (paused: boolean) => void;
  /** Where the host writes the reply (§25): when the reply is due, for the trace. */
  replyBy?: number;
}

/** What a run's agents read and write, once that is known: the chat and its lore, the workspace's areas, the main agent's earlier turns, and the turn a job started from this run belongs to. */
export interface Equipment {
  chat: ChatView;
  lore: LoreView;
  areas: Readonly<Record<WorkspaceArea, AreaAccess | null>>;
  past: readonly PastTurn[];
  basis: string | null;
}

/** How one agent of a run is started. */
export interface AgentStart {
  /** How deep it stands: 0 for the agent the run starts with, 1 for one that agent started, and so on. */
  depth: number;
  parent?: string;
  task?: string;
  /** Its instructions, in place of its definition's. */
  system?: string;
  /** What follows its instructions for this kind of run (a side session says what it is). */
  about?: string;
  history?: readonly ModelMessage[];
  params?: SamplingParams;
  onDelta?: (delta: ModelDelta) => void;
  budget?: AgentBudget;
  /** The earlier turns `past_turn` reads, where they aren't the run's own. */
  past?: readonly PastTurn[];
  writeReply?: ToolEnv["writeReply"];
  /** The tools it may hold at most: one its definition names and this doesn't is left out (§14: what the agent that starts it may grant). */
  grant?: ReadonlySet<string>;
  /** It takes no tools, whatever its settings say (the summary of the main agent's notes is one call). */
  toolless?: true;
  /** Nothing of LumiAH's is added to what it is sent: no guidance, no list of skills, no pinned files. For a call whose prompt is somebody else's to write (the writer's is the user's preset's). */
  plain?: true;
  /** What the user says to the run reaches this agent (§18). */
  notes?: true;
  /** It is the run's main agent: the one the run starts with (a turn's main agent, a job's agent, a side session's). */
  main?: true;
  /** What the run tells this agent as it works, asked at the start of each round (how little time is left before the reply is due, §25). */
  notices?: () => string[];
  /** Its calls are made whatever the caps on a day's spend say (`AgentSpec.uncapped`): the writer's call of the reply the user waits for. */
  uncapped?: true;
}

/** An agent of a run, started: its handle, what leads its first message (the files pinned for it; empty for none), and the workspace as it holds it. */
export interface StartedAgent {
  agent: AgentHandle;
  lead: string;
  view: WorkspaceView;
}

export class Run {
  readonly info: RunInfo;
  /** Whose run it is, as the extension is told. */
  readonly userId: string;
  readonly settings: Settings;
  readonly texts: Texts;
  readonly definitions: Definitions;
  readonly chat: ChatInfo | null;
  readonly claim: ChatClaim | null;
  readonly startedAt: number;
  readonly trace: TurnTrace;
  readonly agents: AgentTurn;
  readonly deps: AgentDeps;
  /** The jobs this run's agents started, as a turn's record lists them. A job that ends while the run is under way is written here. */
  readonly jobs: RecordJob[] = [];
  /** The workspace files its agents' tool calls changed, in the order they did. */
  readonly wrote: FileChange[] = [];
  /** The request the run answers, as its first agent reads it: what a sub-agent whose definition is given the request gets with its task. */
  request: { count: string; text: string } | null = null;
  /** The levels of guidance its agents are given. */
  guidance: readonly GuidanceRead[] = [];

  private equipment: Equipment | null = null;
  /** The chat's book (§23), read once when the run is equipped; null where the chat has none. */
  private book: Book | null = null;
  /** The run's view of the lore and the chat (§24), made when the run is equipped: every tool of the run reads through the same one. */
  recall: RecallRun | null = null;
  private prefix: string[] = [];
  private guard: WorkspaceView["guard"] = () => null;
  /** What the user said to the run since its first agent last looked. */
  private readonly said: string[] = [];
  /** Its first agent reads no notes now: what the user says would reach nobody. */
  private deaf = false;
  /** Each agent's definition, by the agent's id: a call's spend is recorded under it. */
  private readonly roles = new Map<string, string>();
  /** Each agent it started with the agents over it, from the run's main agent down to itself, by the agent's id: what an agent it starts has above it. */
  private readonly lines = new Map<string, readonly AgentRef[]>();
  private readonly delegator: Delegator;
  /** The extension's hooks that nothing waits for, one after another in the order they were made. */
  private hooks: Promise<unknown> = Promise.resolve();

  constructor(
    readonly shared: Shared,
    setup: Setup,
    private readonly start: RunStart,
  ) {
    const { host } = shared;
    this.info = start.info;
    this.userId = setup.userId;
    this.settings = setup.settings;
    this.texts = setup.texts;
    this.definitions = setup.definitions;
    this.chat = setup.chat;
    this.claim = setup.claim;
    this.startedAt = start.startedAt;
    this.trace = new TurnTrace(host, { turn: this.info.id, chatId: this.info.chatId }, shared.blobs, this.settings.keep.prompts, (event) => this.hear(event));
    // Work carried on counts what it spent before: its time as if it had started that much earlier, its tokens and rounds as already used.
    this.agents = new AgentTurn(start.budget, start.startedAt - (start.spent?.workedMs ?? 0), this.trace, start.words);
    if (start.spent) addUsage(this.agents.usage, start.spent.usage);
    this.trace.turn = this.agents;
    // Where the host writes the reply (§25): no call of the run's agents is given longer than the time left before it is due.
    this.agents.replyBy = start.replyBy ?? null;
    const job = this.info.kind === "job";
    // A cap on a day's spend is asked about each call before it is made, with its prompt as estimated and that prompt's cost where the user priced its model; the call then holds that much against the caps while it is under way. A call that is made whatever they say only holds.
    this.agents.limits = (call) => {
      const cost = priced({ in: call.estimate, cachedIn: 0, out: 0, reasoningOut: 0, estimated: [] }, [call.model], this.settings.prices).cost ?? 0;
      const asked = { job, tokens: call.estimate, cost };
      return (call.always ? null : shared.spend.refusal({ ...asked, texts: this.texts })) ?? shared.spend.hold(asked);
    };
    const approved = this.info.chatId === "" ? null : new ChatApprovals(host, this.info.chatId);
    this.approved = approved;
    this.deps = { host, settings: this.settings, texts: this.texts, accounts: shared.accounts, turn: this.agents, approval: approvalGate(host, this.settings, this.info, approved) };
    this.delegator = new Delegator(this);
    shared.runs.set(this.info.id, this);
    // Where the core runs inside Lumiverse (§25), an agent with no connection set uses the one this generation runs on, else the chat's own.
    this.ownConnection = start.turn?.connectionId ?? setup.chat?.connectionId ?? null;
    this.trace.emit({
      kind: "turn_started",
      turn: this.info.id,
      chatId: this.info.chatId,
      generation: this.info.kind,
      messageId: start.messageId,
      ...(start.job !== undefined ? { job: start.job } : {}),
      ...(start.side !== undefined ? { side: start.side } : {}),
      ...(start.replyBy !== undefined ? { replyBy: start.replyBy } : {}),
      at: start.startedAt,
    });
  }

  private readonly approved: ChatApprovals | null;
  private readonly ownConnection: string | null;

  /** The guidance its agents are given, each level as their instructions hold it (§12): what the writer is given beside the brief where Settings say so. */
  guidanceLines(): readonly string[] {
    return this.prefix;
  }

  /** Lets go of the agents its agents started: their work is cancelled and their handles are gone. A turn handing its reply over does this (§25); a run that ends does it too. */
  letGo(): void {
    this.delegator.close();
  }

  /**
   * Gives the run what its agents read and write, reads the guidance they are given and the tools
   * the user approved for the chat, and tells the extension the run begins: nothing of the run has
   * been sent to a model yet, and nothing is until the extension answered or its wait ran out.
   */
  async equip(equipment: Equipment): Promise<void> {
    const { settings, texts, shared } = this;
    this.equipment = equipment;
    const [guidance, book] = await Promise.all([
      readGuidance({ areas: equipment.areas, chat: this.chat, claim: this.claim, texts, pathChars: settings.workspace.pathChars, log: shared.host.log }),
      readBook(shared.host, this.info.chatId),
      this.approved?.load(),
    ]);
    this.guidance = guidance;
    this.book = book;
    // What the user has set up of what the lore and history tools rest on (§24) is read before any tool is built.
    this.recall = recallOf({ host: shared.host, run: this.info, ...(this.start.turn ? { turn: this.start.turn } : {}), settings, texts, chat: equipment.chat, ...(book ? { book } : {}) });
    await this.recall.ready();
    this.prefix = guidancePrefix(guidance, settings, texts);
    this.guard = guidanceGuard(guidance, settings, texts);
    const extension = shared.options.extension;
    await askExtension(shared, "answer to a run beginning", settings.extension.waitMs, extension?.runBegan ? () => extension.runBegan?.({ userId: this.userId, chatId: this.info.chatId, turn: this.info.id, kind: this.info.kind }) ?? Promise.resolve() : undefined, undefined);
  }

  private equipped(): Equipment {
    if (!this.equipment) throw new Error("the run has nothing to work with yet");
    return this.equipment;
  }

  /** The workspace's areas as this run has them. */
  get areas(): Readonly<Record<WorkspaceArea, AreaAccess | null>> {
    return this.equipped().areas;
  }

  // ---------------------------------------------------------------- the trace

  private hear(event: TraceEvent): void {
    if (event.kind === "agent_started") this.roles.set(event.agent.id, event.agent.role);
    if (event.kind === "agent_entry" && event.entry.kind === "result" && event.entry.files) this.wrote.push(...event.entry.files);
    if (event.kind === "usage" && event.connection !== undefined && event.model !== undefined) {
      const { call } = event;
      const { info, start } = this;
      this.shared.spend.add({
        at: event.at,
        run: info.id,
        kind: info.kind,
        chatId: info.chatId,
        ...(start.job !== undefined ? { job: start.job } : {}),
        ...(start.side !== undefined ? { side: start.side } : {}),
        agent: this.roles.get(event.agentId) ?? "",
        agentId: event.agentId,
        connection: event.connection,
        model: event.model,
        in: call.in,
        cachedIn: call.cachedIn,
        out: call.out,
        reasoningOut: call.reasoningOut,
        ...(call.cost !== undefined ? { cost: call.cost } : {}),
        estimated: call.estimated.length > 0,
      });
    }
    this.start.heard?.(event);
  }

  /** The run ended: its trace says how, the agents its agents started are let go, and what it spent is written. */
  close(ended: { status: TurnStatus; reason?: string; at: number }, usage: AgentUsage): void {
    this.trace.emit({ kind: "turn_ended", status: ended.status, ...(ended.reason !== undefined ? { reason: ended.reason } : {}), usage, at: ended.at });
    this.delegator.close();
    this.shared.runs.delete(this.info.id);
    this.shared.spend.flush().catch((error: unknown) => this.shared.host.log("warn", `[LumiAH] what the run spent couldn't be written (${errorText(error)})`));
  }

  /** A hook of the extension's that nothing waits for: called after those before it, and bounded like every call of its. */
  hook(what: string, call: (() => Promise<void>) | undefined): void {
    if (!call) return;
    this.hooks = this.hooks.then(() => askExtension(this.shared, what, this.settings.extension.waitMs, call, undefined));
  }

  // ---------------------------------------------------------------- the user, while it works (§18)

  /**
   * Something the user says to the run: its first agent receives it at the start of its next round.
   * False when that agent reads no more notes now (`quiet`): the note would reach nobody.
   */
  say(text: string): boolean {
    if (this.deaf) return false;
    this.said.push(text);
    return true;
  }

  /** The run's first agent is past its rounds for now (the writer is writing its reply), or back at them. */
  quiet(on: boolean): void {
    this.deaf = on;
  }

  /** Holds every agent of the run at its next round; false when it is held already. */
  pause(): boolean {
    const at = this.shared.host.clock.now();
    if (!this.agents.pause(at)) return false;
    this.trace.emit({ kind: "turn_paused", at });
    this.start.held?.(true);
    return true;
  }

  /** Lets a held run go on; false when it wasn't held. */
  resume(): boolean {
    const at = this.shared.host.clock.now();
    if (!this.agents.resume(at)) return false;
    this.trace.emit({ kind: "turn_resumed", at });
    this.start.held?.(false);
    return true;
  }

  // ---------------------------------------------------------------- an agent of the run

  /** How `id` runs in this run; undefined when there is no such definition, or it is switched off. */
  resolve(id: string): ResolvedAgent | undefined {
    return this.definitions.resolve(id, this.settings);
  }

  /** Starts an agent of the run as `resolved` runs. */
  async agent(resolved: ResolvedAgent, how: AgentStart): Promise<StartedAgent> {
    const { settings, texts, shared, info, start } = this;
    const equipment = this.equipped();
    const { definition } = resolved;
    // Its id is known only once it started, and its tools are built before: its writes are recorded under the author set just below.
    const view: WorkspaceView = { author: { who: "agent", id: "", role: definition.id }, role: definition.id, areas: equipment.areas, guard: this.guard };
    const held = new Set<string>();
    const delegation = how.toolless ? undefined : this.delegator.for({ definition: definition.id, depth: how.depth, held, view });
    const jobs = how.toolless ? undefined : this.jobTools({ held, depth: how.depth });
    const skills = this.definitions.skills();
    // The agents over it: those over the agent that started it, and that agent. One the run started itself has nobody above.
    const above = how.parent !== undefined ? (this.lines.get(how.parent) ?? []) : [];
    const env: ToolEnv = {
      host: shared.host,
      run: info,
      ...(start.turn ? { turn: start.turn } : {}),
      settings,
      texts,
      agent: definition.id,
      depth: how.depth,
      standing: { main: how.main === true, above },
      chat: equipment.chat,
      lore: equipment.lore,
      past: how.past ?? equipment.past,
      ...(how.writeReply ? { writeReply: how.writeReply } : {}),
      workspace: view,
      skills,
      ...(delegation ? { delegation } : {}),
      ...(jobs ? { jobs } : {}),
      ...(this.book ? { book: this.book } : {}),
    };
    const names = how.toolless ? [] : this.definitions.names(resolved.tools).filter((name) => !how.grant || how.grant.has(name));
    const tools: AgentTool[] = this.definitions.build(names, env);
    for (const tool of tools) held.add(tool.name);
    const own = how.system ?? instructionsOf(definition, texts);
    const system = [own, how.about ?? "", !how.plain && held.has(TOOL.skillLoad) ? this.skillList() : ""].filter((part) => part !== "").join("\n\n");
    const agent = startAgent(
      {
        role: definition.id,
        connectionId: resolved.connectionId ?? this.ownConnection,
        model: resolved.model,
        effort: resolved.effort,
        system,
        prefix: how.plain ? [] : this.prefix,
        tools,
        toolCalls: resolved.toolCalls,
        budget: how.budget ?? resolved.budget,
        ...(how.history ? { history: how.history } : {}),
        ...(how.params ? { params: how.params } : {}),
        ...(how.onDelta ? { onDelta: how.onDelta } : {}),
        ...(how.uncapped ? { uncapped: true as const } : {}),
        ...(how.parent !== undefined ? { parent: how.parent } : {}),
        ...(how.task !== undefined ? { task: how.task } : {}),
        ...(how.notes ? { notes: () => this.said.splice(0) } : {}),
        ...(how.notices ? { notices: how.notices } : {}),
      },
      this.deps,
    );
    view.author = info.kind === "job" ? { who: "job", id: info.id, role: definition.id } : { who: "agent", id: agent.id, role: definition.id };
    this.lines.set(agent.id, [...above, { agentId: agent.id, role: definition.id }]);
    return { agent, lead: how.plain ? "" : await this.pinned(view), view };
  }

  /** The skills an agent may load, as its instructions list them: as many as Settings give room for, and how many more there are. */
  private skillList(): string {
    const { texts } = this;
    const skills = this.definitions.skills();
    if (skills.length === 0) return "";
    const lines: string[] = [];
    let used = 0;
    const room = this.settings.skills.listChars;
    for (const skill of skills) {
      const line = texts.render(TEXT.agents.skill, { id: skill.id, name: skill.name, description: skill.description });
      if (used + line.length + 1 > room) {
        // Not even the first fits: it is named as far as the room goes, so an agent that holds skill_load is never told of none.
        if (lines.length === 0) lines.push(clip(line, room));
        break;
      }
      lines.push(line);
      used += line.length + 1;
    }
    return texts.render(TEXT.agents.skills, { skills: lines.join("\n"), more: skills.length > lines.length ? texts.render(TEXT.agents.skillsMore, { count: String(skills.length - lines.length) }) : "" });
  }

  /** The files pinned for an agent, as they lead what it is sent first: each whole while Settings give room, the rest named. Empty for none, and when they can't be read (the log says why). */
  private async pinned(view: WorkspaceView): Promise<string> {
    const { texts } = this;
    try {
      const pins = await pinnedFiles(view);
      if (pins.length === 0) return "";
      let room = this.settings.workspace.pinChars;
      const files: string[] = [];
      for (const pin of pins) {
        const path = showPath(pin.area, pin.path);
        const text = pin.entry.chars <= room ? ((await view.areas[pin.area]?.text(pin.entry.hash)) ?? null) : null;
        if (text === null) files.push(texts.render(TEXT.agents.fileNamed, { path, chars: String(pin.entry.chars) }));
        else {
          room -= text.length;
          files.push(texts.render(TEXT.agents.file, { path, chars: String(text.length), version: versionOf(pin.entry.hash), text }));
        }
      }
      return texts.render(TEXT.agents.pinned, { files: files.join("\n\n") });
    } catch (error) {
      this.shared.host.log("warn", `[LumiAH] the pinned files couldn't be read (${errorText(error)}): the agent starts without them`);
      return "";
    }
  }

  // ---------------------------------------------------------------- jobs, as this run's agents have them (§15)

  /**
   * The job tools' side of this run, as one of its agents has them (`starter`: the tools it holds, filled once they are built, and how deep it stands); undefined where there are no jobs: Settings switch them off, the host can't run them, or the run is about no chat.
   */
  private jobTools(starter: { held: ReadonlySet<string>; depth: number }): JobTools | undefined {
    const { settings, texts, shared, info } = this;
    if (!settings.jobs.enabled || !shared.host.jobs || info.chatId === "") return undefined;
    const { basis } = this.equipped();
    const tools: JobTools = {
      agents: () => this.definitions.workers().map(choiceOf),
      list: () => shared.jobs.list(info.chatId),
      read: (id) => shared.jobs.read(info.chatId, id),
      cancel: (id, ctx) => shared.jobs.cancel(info.chatId, id, texts.render(TEXT.jobs.whyCancelledByAgent, { role: ctx.role })),
    };
    // A job's own agents start jobs only where Settings let jobs start jobs. One so started belongs to the same turn, may spend no more than is left of this one, and counts against it. Whoever starts a job, its agent is given no more than the starter holds and stands one deeper (§14).
    if (info.kind !== "job" || settings.jobs.chain) {
      // Starts still being made, counted with the jobs started: the calls of one answer run at once, and each has to find the place the one before it took.
      let starting = 0;
      tools.start = async (input, ctx): Promise<JobStarted> => {
        if (this.jobs.length + starting >= limitOf(settings.jobs.perRun)) return { refused: texts.render(TEXT.jobs.tooMany, { limit: texts.counted(settings.jobs.perRun ?? 0, TEXT.jobs.word) }) };
        const { when, ...what } = input;
        starting++;
        let started: JobStarted;
        try {
          started = await shared.jobs.createJob({ chatId: info.chatId, when, what, by: { who: "agent", id: ctx.agentId, role: ctx.role }, basis, starter: { held: [...starter.held], depth: starter.depth }, ...(info.kind === "job" ? { parent: { id: info.id, left: this.left() } } : {}) }, this);
          if (!("refused" in started)) this.jobs.push({ id: started.id, agent: started.agent, state: started.state });
        } finally {
          starting--;
        }
        if ("refused" in started) return started;
        this.trace.emit({ kind: "job", job: started, at: shared.host.clock.now() });
        return started;
      };
    }
    return tools;
  }

  /** What is left of the run's own budget: each limit less what its agents have used, none where there is no limit. */
  left(): TurnBudget {
    const { budget, usage, startedAt } = this.agents;
    const now = this.shared.host.clock.now();
    const less = (limit: Limit, used: number): Limit => (limit === null ? null : Math.max(0, limit - used));
    // Prompt tokens as the limit counts them: a cached re-read at its weight.
    return { tokensIn: less(budget.tokensIn, countedIn(usage, this.settings.spend.cachedWeight)), tokensOut: less(budget.tokensOut, usage.out), toolTurns: less(budget.toolTurns, usage.toolTurns), wallMs: less(budget.wallMs, now - startedAt - this.agents.held(now)) };
  }

  /** What a tool answers, as an error, in the user's words for `id`. */
  refusal(id: string, vars: Readonly<Record<string, string>> = {}): ToolOutcome {
    return { text: this.texts.render(id, vars), error: true };
  }
}
