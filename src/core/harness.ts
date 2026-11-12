// The harness (DESIGN §1): `createHarness(host, options)` gives everything the runtime calls.
//
// - `answer` answers one generation that reached the loopback connection (`turn.ts`), and `side`
//   one turn of a side session (`side.ts`).
// - `jobs.run` runs a job the host was told waits (`jobs.ts`).
// - Everything else is the user's side of it, as the page reaches it through the runtime: the
//   workspace, guidance, the definitions, jobs, side sessions, spend, upkeep, and talking to a run
//   that is under way. Each of those takes one plain object and resolves plain JSON, so each can be
//   a request over the link; a refusal rejects with a `HarnessRefusal`, whose message the user reads.

import { AgentRegistry, baseAgents } from "./agents";
import { forgetApproval, type KeptApproval, keptApprovals } from "./approved";
import { Areas, chatFolder } from "./areas";
import { Blobs } from "./blobs";
import { CompactionMemo } from "./compaction";
import type { AgentView, HeldTools, SkillView, ToolView } from "./definitions";
import { type GuidanceId, type GuidanceRead, guidanceGuard, readGuidance } from "./guidance";
import { jobEnded } from "./job-words";
import { Jobs } from "./jobs";
import { DOC, docKey, ROOT_AREA } from "./paths";
import type { FileAuthor, FileChange, JobAllowance, JobView, JobWhen, JsonObject, ReplySink, TurnRecord, TurnRequest, TurnResult, WorkspaceArea } from "./ports";
import { isRecord } from "./ports";
import { AgentAccounts } from "./provider";
import { chronicleRefusal, RECALL_SKILLS, recallAgents } from "./recall/definitions";
import { type RecallPage, recallPage } from "./recall/page";
import { HarnessRefusal } from "./refusal";
import { type HarnessOptions, readSetup, type Shared } from "./run";
import { askCompaction, pathTurns, rollback, Sessions } from "./sessions";
import { AGENT, type AgentSettings, agentRunSchema, defaultSettings, newAgentSettings, type Settings, type SettingsScope } from "./settings";
import { type SideResult, Sides, type SideTurnView } from "./side";
import { SkillRegistry } from "./skills";
import { Spend, type SpendSummary } from "./spend";
import type { SideRow } from "./stored";
import { TEXT, textsOf } from "./texts";
import { type JobRead, ToolRegistry } from "./tools";
import { BASE_TOOLS } from "./tools/base";
import { Turn } from "./turn";
import { Upkeep, type UpkeepSummary } from "./upkeep";
import { errorText } from "./util";
import { type AreaAccess, type FileRow, type FileVersion, fileChanges, type PageWorkspace, pageWorkspace, showPath, Workspace, type WorkspaceView, type WrittenFile } from "./workspace";

export type { HarnessOptions, StoredState } from "./run";

/** A request of the page's about the workspace says which chat's it means: null for the user's own area alone. */
type InChat<T> = T & { chatId: string | null };

/** A tool the user approved for a chat, as the page lists it: the chat, the tool, and when they said so (null: it was kept before the time was). */
export type ApprovalRow = KeptApproval & { chatId: string };

/**
 * Where the search vectors are kept in the store, apart for each embedding space and each owner:
 * `recall/vectors/<space>/<chat|book>/<owner>/…` (`recall/meaning.ts`, whose stored path this is).
 * Read here only to forget a chat's.
 */
const VECTORS = "recall/vectors/";

/**
 * A file an agent keeps through a tool that runs outside the core (`workspace.writeAs`): the chat
 * (`""`: a side session about none), the file by its area and its path within it, its whole text and
 * the version that text was based on (null: a new file), the agent it is for, and the run (`turn`)
 * and the tool call (`callId`) it is made in, all three as the extension's tool was handed them.
 */
export interface AgentWrite {
  chatId: string;
  area: WorkspaceArea;
  path: string;
  text: string;
  base: string | null;
  by: { agentId: string; role: string };
  turn: string;
  callId: string;
}

/** What forgetting a chat removed: every document, its jobs' and its side sessions' among them, and how many of each of those two. */
export interface ForgottenChat {
  documents: number;
  jobs: number;
  sides: number;
}

/** An area as the page shows it: its files and limits, the agent definitions a file may be pinned for, and, for the chat's own area, the reply whose record it stands on (null: no turn has left one). */
export interface AreaView {
  area: WorkspaceArea;
  files: FileRow[];
  chars: number;
  limits: { fileChars: number; files: number; areaChars: number; pinChars: number };
  agents: { id: string; name: string }[];
  basis: { messageId: string; swipe: number; index: number } | null;
}

/** A level of guidance as the page shows it: whose it is, its text and version, where its file is, and whether the page may edit it (`locked` says why not). */
export interface GuidanceLevelView {
  id: GuidanceId;
  whose: string;
  text: string;
  path: string | null;
  hash: string | null;
  at: number | null;
  by: FileAuthor | null;
  editable: boolean;
  locked?: string;
}

export interface GuidanceView {
  levels: GuidanceLevelView[];
  /** The characters Settings allow each level: what is over is cut when it is given. */
  limit: number;
  agentsEdit: boolean;
}

/** Every definition, with the form of what an agent runs with (a schema in the settings' dialect), what a new agent starts from, and what Settings are read against where these definitions stand (`scope`: for `checkSettings` and `settingsSchema`, so a page takes every tool and agent a run would). */
export interface DefinitionsAnswer {
  agents: AgentView[];
  skills: SkillView[];
  tools: ToolView[];
  agentSchema: JsonObject;
  agentDefaults: AgentSettings;
  scope: SettingsScope;
}

export interface JobsPage {
  jobs: JobView[];
  /** The cursor that reads the page after this one; null on the last. */
  next: string | null;
  /** What jobs sent and wrote in the last 24 hours as Job tokens per day counts it (a cached re-read at its weight), and, in `sent`, with every token counted in full. */
  today: { tokens: number; sent?: number };
  /** The agent definitions a job may be given to. */
  agents: { id: string; name: string }[];
  /** The user holds every job. */
  paused: boolean;
}

export interface Harness {
  /** What is written in code: the core's tools, agent definitions and skills, and whatever an extension that runs beside the core registers. A run merges them with the extension's and the user's own (§13). */
  readonly tools: ToolRegistry;
  readonly agents: AgentRegistry;
  readonly skills: SkillRegistry;
  /**
   * Answers one turn. The reply streams to `sink`, which gets exactly one `done` or one `error`;
   * `signal` stops the turn. Never rejects: how the turn ended is in what it returns, with its record
   * for the caller to anchor on the reply's message.
   */
  answer(turn: TurnRequest, sink: ReplySink, signal: AbortSignal): Promise<TurnResult>;
  /** One turn of a side session (§19): `generationId` is the turn's id, which its trace bears. */
  side(input: { session: string; generationId: string; text: string }, sink: ReplySink, signal: AbortSignal): Promise<SideResult>;
  /** Talking to a run that is under way (§18), by its id: a turn's generation, a job, a side session's turn. A note reaches the run's first agent at its next round; a hold stops every agent of it at its next round. */
  say(input: { run: string; text: string }): Promise<{ said: true }>;
  pause(input: { run: string }): Promise<{ paused: boolean }>;
  resume(input: { run: string }): Promise<{ paused: boolean }>;
  workspace: {
    list(input: InChat<{ area: WorkspaceArea }>): Promise<AreaView>;
    /** A file's text as it stands, or as one of its versions held it (`version`, from `history`): the page compares two versions with two reads, and restores one by writing its text based on `file.hash`. */
    read(input: InChat<{ area: WorkspaceArea; path: string; version?: string }>): Promise<{ file: FileRow; text: string; version: FileVersion }>;
    write(input: InChat<{ area: WorkspaceArea; path: string; text: string; base: string | null }>): Promise<{ file: FileRow }>;
    move(input: InChat<{ area: WorkspaceArea; from: string; to: string; base: string }>): Promise<{ file: FileRow }>;
    delete(input: InChat<{ area: WorkspaceArea; path: string; base: string }>): Promise<{ deleted: true }>;
    pin(input: InChat<{ area: WorkspaceArea; path: string; on: boolean; role?: string }>): Promise<{ file: FileRow }>;
    history(input: InChat<{ area: WorkspaceArea; path: string }>): Promise<{ versions: FileVersion[] }>;
    /** The change set of the turn recorded on a reply's shown swipe (§11): what its agents and its jobs wrote. */
    changes(input: { chatId: string; messageId: string; swipe: number }): Promise<{ changes: (FileChange & { by: FileAuthor })[] }>;
    /**
     * A file an agent keeps through a tool that runs outside the core (a mounting extension's own,
     * §21): the versioned write `workspace_write` makes, in the same areas, under the same limits and
     * the same guard, recorded as that agent's. `turn` and `callId` are the run and the tool call it is
     * made in, and `by` the agent, all as the extension's tool was handed them: the file is then in that
     * turn's change set, and the call's result names it in the live view. `path` is within its area and
     * `base` the version the text was based on (null: a new file), as `write` takes them. Refused in
     * words as `write` is; and (`conflict`) for the chat's own area once that run is no longer under
     * way, since that area is kept turn by turn. `learned/` and `~/` take the write after the run too.
     */
    writeAs(input: AgentWrite): Promise<WrittenFile>;
  };
  guidance: {
    get(input: { chatId: string | null }): Promise<GuidanceView>;
    /** Writes a level as the user: a versioned write like any other (`base`: the version it was based on, null for a level nothing was written to yet). */
    set(input: { chatId: string | null; level: GuidanceId; text: string; base: string | null }): Promise<GuidanceView>;
  };
  definitions: {
    /** Every definition as a run about `chatId` would have it (none: about no chat). */
    get(input: { chatId?: string | null }): Promise<DefinitionsAnswer>;
    /** Each agent that can run in `chatId`, with the tools it holds there and each tool it names that it can't use, with why. */
    held(input: { chatId: string }): Promise<{ agents: HeldTools[] }>;
  };
  session: {
    /** Rolls back the summary made at a turn (§5). Refused in plain words where it would change nothing. */
    rollback(input: { chatId: string; messageId: string; swipe: number }): Promise<{ record: TurnRecord }>;
    /** The user asks for the chat's notes to be summarized: the next turn does it, whatever their length and whatever a rollback holds. */
    summarize(input: { chatId: string }): Promise<{ asked: number }>;
  };
  jobs: {
    list(input: { chatId: string | null; cursor: string | null; limit: number }): Promise<JobsPage>;
    read(input: { id: string }): Promise<JobRead>;
    /** The user starts a job (§15, §22): it belongs to the chat and to no turn. `area: "chat"`: it may write the chat's own area too, at the latest reply on the path; `plan`: the plan file it is asked to keep, where not `learned/plans/<id>.md`; `planWords`: for a plan file whoever starts it keeps with tools of its own, what its agent is told of the plan, in place of being asked to write one. */
    start(input: { chatId: string; agent: string; task: string; when: JobWhen; allowance?: JobAllowance; area?: "chat"; plan?: string; planWords?: string }): Promise<{ job: JobView }>;
    /** Runs a job that stopped short again, from the start, as a new job: the same job, with the same agent, task, `as`, lane and due, for the same turn (refused, in words for the user, once that turn's reply is off the chat's path). */
    again(input: { id: string }): Promise<{ job: JobView }>;
    cancel(input: { id: string }): Promise<{ job: JobView }>;
    /** Grants a job that stopped at its allowance more: it carries on from its own session (§22). */
    grant(input: { id: string; allowance: JobAllowance }): Promise<{ job: JobView }>;
    /** Holds every job, or lets them go. */
    hold(input: { paused: boolean }): Promise<{ paused: boolean }>;
    /** Runs a job that waits. The host calls this, when it will, for each job it was told of (`JobsPort.queued`); nothing else runs a job. */
    run(input: { id: string }, signal: AbortSignal): Promise<JobView>;
    /** After a restart: what became of the jobs that waited or ran when the runtime stopped. Those that waited are the host's to run again. */
    recover(): Promise<{ interrupted: JobView[]; paused: JobView[]; queued: JobView[] }>;
  };
  sides: {
    list(input: { chatId?: string | null }): Promise<{ sides: SideRow[] }>;
    start(input: { chatId: string | null; agent?: string }): Promise<{ side: SideRow }>;
    turns(input: { id: string }): Promise<{ side: SideRow; turns: SideTurnView[] }>;
    remove(input: { id: string }): Promise<{ removed: true }>;
  };
  spend: {
    get(input: { days: number }): Promise<SpendSummary>;
  };
  upkeep: {
    get(): Promise<UpkeepSummary>;
    sweep(signal?: AbortSignal): Promise<UpkeepSummary>;
  };
  chats: {
    /**
     * Forgets a chat Lumiverse no longer has: everything LumiAH keeps for it, and nothing of another's.
     * Its jobs are cancelled and go with their reports; its side sessions go; and so do its `learned/`
     * area and every head of its own area, what the user approved for it, what they asked of its
     * session, how its lore last stood, and its search vectors. The texts those named are left to the
     * sweep (`upkeep.sweep`), which removes what nothing refers to any more. The answer counts what
     * went: every document, its jobs' and its side sessions' among them, and how many of each of those
     * two. Refused (`conflict`) while a reply or a side session's answer is being worked on in the
     * chat: that run would write the chat's documents again behind this.
     */
    forget(input: { chatId: string }): Promise<ForgottenChat>;
  };
  /** What the user approved "for this chat" (§17), for the page to show and take back. */
  approvals: {
    /** The tools approved for a chat, the newest first; for every chat of the user's where `chatId` is null. */
    kept(input: { chatId: string | null }): Promise<{ kept: ApprovalRow[] }>;
    /** Takes a tool out of what is approved for a chat: every run that begins from then on asks about it again. The chat's approvals after. */
    forget(input: { chatId: string; tool: string }): Promise<{ kept: ApprovalRow[] }>;
  };
  /** What the pages read of a chat's lore and history (§24): its lore with each entry's state, the agents' own search, the chronicle's check, and how far the story's learning has come. */
  recall: RecallPage;
}

export function createHarness(host: Shared["host"], options: HarnessOptions): Harness {
  const tools = new ToolRegistry();
  tools.register(...BASE_TOOLS);
  const agents = new AgentRegistry();
  // The chronicler and the two skills of lore and history (§24.7) are the core's own, like the three agents a turn can't do without.
  agents.register(...baseAgents(), ...recallAgents());
  const skills = new SkillRegistry();
  skills.register(...RECALL_SKILLS);
  const blobs = new Blobs(host, () => shared.latest.keep.blobChars);
  const workspace = new Workspace({ host, blobs, limits: () => shared.latest.workspace });
  const shared: Shared = {
    host,
    options,
    tools,
    agents,
    skills,
    // The core's own, as they stand before anything is registered beside them: whatever joins the registries later is an extension's.
    core: { agents: new Set(agents.all().map((d) => d.id)), skills: new Set(skills.all().map((s) => s.id)), tools: new Set(tools.all().map((d) => d.name)) },
    accounts: new AgentAccounts(host),
    blobs,
    sessions: new Sessions(host, blobs),
    memo: new CompactionMemo(() => shared.latest.keep.summaries),
    workspace,
    areas: new Areas(host, workspace, () => shared.latest.jobs.recordWaitMs),
    spend: new Spend(host, () => shared.latest),
    jobs: new Jobs(() => shared),
    runs: new Map(),
    latest: defaultSettings(),
  };
  const sides = new Sides(() => shared);
  const upkeep = new Upkeep({ host, blobs, keep: () => shared.latest.keep });
  // The caps count what earlier runs of the process spent once the last day's calls are read; until then, what this one spent.
  shared.spend.ready().catch((error: unknown) => host.log("warn", `[LumiAH] the last day's spend couldn't be read (${errorText(error)}): the caps count from now`));

  /** The workspace as the user holds it on the page: every file is theirs to read and write, and what they write is recorded as theirs. What they write to the chat's own area is kept through a regenerate or a swipe of the newest reply (§11). */
  const userView = async (chatId: string | null): Promise<WorkspaceView> => {
    const areas: Record<WorkspaceArea, AreaAccess | null> = chatId === null ? { chat: null, learned: null, user: shared.areas.user() } : { chat: shared.areas.now(chatId, { throughSwipe: true }), learned: await shared.areas.learned(chatId), user: shared.areas.user() };
    return { author: { who: "user" }, role: AGENT.main, areas, guard: () => null };
  };
  const page = async (chatId: string | null): Promise<PageWorkspace> => pageWorkspace(await userView(chatId), () => shared.latest.workspace);
  /** A change the user made on the page: where it was to the chat's own area, the records it went beside carry it (§11), so a branch cut there has it. Gives back what the change gave. */
  const kept = async <T>(input: { chatId: string | null; area: WorkspaceArea }, done: T): Promise<T> => {
    if (input.chatId !== null && input.area === "chat") await shared.jobs.anchorNewest(input.chatId).catch((error: unknown) => host.log("warn", `[LumiAH] a change to the chat's area couldn't be put on the reply's record (${errorText(error)}): a branch cut there won't have it`));
    return done;
  };

  /** The levels of guidance of a chat (none: the user's alone), read as a run's are. */
  const levels = async (chatId: string | null): Promise<{ levels: GuidanceRead[]; view: WorkspaceView; limit: number; agentsEdit: boolean }> => {
    const setup = await readSetup(shared, chatId ?? "");
    const view = await userView(chatId);
    const read = await readGuidance({ areas: view.areas, chat: setup.chat, claim: setup.claim, texts: setup.texts, pathChars: setup.settings.workspace.pathChars, log: host.log });
    return { levels: read, view, limit: setup.settings.guidance.chars, agentsEdit: setup.settings.guidance.agentsEdit };
  };
  const guidanceView = (read: { levels: GuidanceRead[]; limit: number; agentsEdit: boolean }): GuidanceView => ({
    levels: read.levels.map((level) => ({
      id: level.id,
      whose: level.whose,
      text: level.text,
      path: level.file ? showPath(level.file.area, level.file.path) : null,
      hash: level.version,
      at: level.at,
      by: level.by,
      editable: level.file !== null,
      ...(level.file === null ? { locked: "This level is kept by the extension that answers this chat: it is edited there." } : {}),
    })),
    limit: read.limit,
    agentsEdit: read.agentsEdit,
  });

  /** A job the user asked about, or the refusal that says there is none. */
  const jobOf = async (id: unknown): Promise<JobRead> => {
    const read = typeof id === "string" ? await shared.jobs.read(null, id) : null;
    if (!read) throw new HarnessRefusal("not_found", "There is no such job.");
    return read;
  };

  /** A chat's kept approvals as the page lists them: the newest first, one kept before the time was last, and of two kept at once the one approved later first. */
  const approvalRows = (chatId: string, kept: readonly KeptApproval[]): ApprovalRow[] => kept.map((k) => ({ chatId, ...k })).reverse();
  const newestFirst = (a: ApprovalRow, b: ApprovalRow): number => (b.at ?? -1) - (a.at ?? -1);
  /** The chat a document's path names in its second part (`chats/<chat>/…`), read back from how `docKey` wrote it; null where that part is none. */
  const chatOf = (path: string): string | null => {
    const key = path.split("/")[1];
    if (key === undefined) return null;
    try {
      return decodeURIComponent(key);
    } catch {
      return null;
    }
  };

  return {
    tools,
    agents,
    skills,
    answer: (turn, sink, signal) => new Turn(shared, turn, sink, signal).answer(),
    side: (input, sink, signal) => sides.turn(input, sink, signal),

    async say(input) {
      const text = typeof input.text === "string" ? input.text.trim() : "";
      if (text === "") throw new HarnessRefusal("bad_request", "Say something first.");
      const run = shared.runs.get(input.run);
      if (!run) throw new HarnessRefusal("not_found", "That run isn't under way any more, so there is nobody to tell.");
      // Its first agent is past its rounds (the writer is writing the reply): a note kept now would reach nobody, and the user would take it for heard.
      if (!run.say(text)) throw new HarnessRefusal("conflict", "The reply is being written now, so the agent reads no more notes this turn. Say it in the chat, or in a side session.");
      return { said: true };
    },
    async pause(input) {
      const run = shared.runs.get(input.run);
      if (run) {
        run.pause();
        return { paused: true };
      }
      // A job that waits to run has no run to hold yet: it is marked, and begins held.
      if (await shared.jobs.pauseWaiting(input.run)) return { paused: true };
      throw new HarnessRefusal("not_found", "That run isn't under way any more, so there is nothing to pause.");
    },
    async resume(input) {
      const run = shared.runs.get(input.run);
      if (run) {
        run.resume();
        return { paused: false };
      }
      if (await shared.jobs.resumeWaiting(input.run)) return { paused: false };
      throw new HarnessRefusal("not_found", "That run isn't under way any more, so there is nothing to resume.");
    },

    workspace: {
      async list(input) {
        const listed = await (await page(input.chatId)).list(input);
        const setup = await readSetup(shared, input.chatId ?? "");
        const latest = input.chatId !== null && listed.area === "chat" ? await shared.areas.latest(input.chatId) : null;
        return { ...listed, agents: setup.definitions.agents().map((d) => ({ id: d.id, name: d.name })), basis: latest ? { messageId: latest.messageId, swipe: latest.swipeId, index: latest.index } : null };
      },
      read: async (input) => (await page(input.chatId)).read(input),
      write: async (input) => kept(input, { file: (await (await page(input.chatId)).write(input)).file }),
      move: async (input) => kept(input, await (await page(input.chatId)).move(input)),
      delete: async (input) => kept(input, await (await page(input.chatId)).delete(input)),
      pin: async (input) => kept(input, await (await page(input.chatId)).pin(input)),
      history: async (input) => (await page(input.chatId)).history(input),
      async changes(input) {
        const turns = await pathTurns(await host.chat.path(input.chatId));
        const turn = turns.find((t) => t.messageId === input.messageId);
        if (!turn) throw new HarnessRefusal("not_found", "That reply has no record of LumiAH's on the chat's active path.");
        if (turn.swipeId !== input.swipe) throw new HarnessRefusal("not_found", "The chat shows another swipe of that reply now: a turn's changes are read for the swipe the chat shows.");
        return { changes: await shared.areas.changes(input.chatId, turns, turn) };
      },
      async writeAs(input) {
        // It comes from an extension's tool, over the link where the core runs apart: nothing in it is taken on trust.
        const asked: Readonly<Record<string, unknown>> = isRecord(input) ? input : {};
        const by: Readonly<Record<string, unknown>> = isRecord(asked.by) ? asked.by : {};
        const { agentId, role } = by;
        const { turn, callId } = asked;
        if (typeof agentId !== "string" || agentId === "" || typeof role !== "string" || role === "") throw new HarnessRefusal("bad_request", "An agent's write says whose it is: by.agentId and by.role, as the tool call that makes it was handed them.");
        if (typeof turn !== "string" || turn === "" || typeof callId !== "string" || callId === "") throw new HarnessRefusal("bad_request", "An agent's write says which run and which tool call it is made in: turn and callId, as the tool call was handed them.");
        const chatId = typeof asked.chatId === "string" ? asked.chatId : "";
        const found = shared.runs.get(turn);
        const run = found?.info.chatId === chatId ? found : undefined;
        const noAgent = (): HarnessRefusal => new HarnessRefusal("not_found", `There is no agent "${role}" here: it may have been removed or switched off.`);
        let view: WorkspaceView;
        let limits: () => Settings["workspace"];
        if (run) {
          if (!run.resolve(role)) throw noAgent();
          // The run's own areas and its own guard: the write lands where the agent's workspace_write would, and is refused where that would be. A job's agent writes as the job, as its own tools do.
          view = { author: run.info.kind === "job" ? { who: "job", id: run.info.id, role } : { who: "agent", id: agentId, role }, role, areas: run.areas, guard: guidanceGuard(run.guidance, run.settings, run.texts) };
          limits = () => run.settings.workspace;
        } else {
          // The chat's own area is kept turn by turn: with no turn under way to write it in, the file would be in no reply's change set, and a swipe would not take it back.
          if (asked.area === "chat") throw new HarnessRefusal("conflict", "That run isn't under way in this chat any more, and a file in the chat's own area belongs to the turn that writes it: an agent's write there is made while its run is. learned/ and ~/ take one after.");
          const setup = await readSetup(shared, chatId);
          if (!setup.definitions.resolve(role, setup.settings)) throw noAgent();
          const user = await userView(chatId === "" ? null : chatId);
          const read = await readGuidance({ areas: user.areas, chat: setup.chat, claim: setup.claim, texts: setup.texts, pathChars: setup.settings.workspace.pathChars, log: host.log });
          view = { author: { who: "agent", id: agentId, role }, role, areas: user.areas, guard: guidanceGuard(read, setup.settings, setup.texts) };
          limits = () => setup.settings.workspace;
        }
        const written = await pageWorkspace(view, limits).write({ area: asked.area, path: asked.path, text: asked.text, base: asked.base } as Parameters<PageWorkspace["write"]>[0]);
        if (run) fileChanges(run.info, callId, written.changes);
        return written;
      },
    },

    guidance: {
      get: async (input) => guidanceView(await levels(input.chatId)),
      async set(input) {
        const read = await levels(input.chatId);
        const level = read.levels.find((l) => l.id === input.level);
        if (!level) throw new HarnessRefusal("not_found", "There is no such level of guidance here: the middle level needs a chat with a character, and the chat's needs a chat.");
        if (!level.file) throw new HarnessRefusal("forbidden", "This level is kept by the extension that answers this chat: it is edited there.");
        await pageWorkspace(read.view, () => shared.latest.workspace).write({ area: level.file.area, path: level.file.path, text: input.text, base: input.base });
        return guidanceView(await levels(input.chatId));
      },
    },

    definitions: {
      async get(input) {
        const setup = await readSetup(shared, isRecord(input) && typeof input.chatId === "string" ? input.chatId : "");
        const scope = setup.definitions.scope();
        return { ...setup.definitions.view(setup.settings, setup.texts), agentSchema: agentRunSchema(scope.tools), agentDefaults: newAgentSettings(), scope };
      },
      async held(input) {
        const setup = await readSetup(shared, isRecord(input) && typeof input.chatId === "string" ? input.chatId : "");
        return { agents: setup.definitions.held(setup.settings) };
      },
    },

    session: {
      async rollback(input) {
        const done = await rollback(host, input.chatId, input.messageId, input.swipe);
        if ("refused" in done) throw new HarnessRefusal("conflict", done.refused);
        return done;
      },
      summarize: (input) => askCompaction(host, input.chatId),
    },

    jobs: {
      async list(input) {
        const listed = await shared.jobs.page(input);
        const setup = await readSetup(shared, input.chatId ?? "");
        const cap = (await shared.spend.get({ days: 1 })).caps.find((c) => c.setting.join(".") === "jobs.tokensPerDay");
        // Whom the user may give a job: any agent but the writer, whose prompt is a chat's preset.
        return { ...listed, today: { tokens: cap?.used ?? 0, sent: cap?.sent ?? 0 }, agents: setup.definitions.agents().flatMap((d) => (d.id === AGENT.writer ? [] : [{ id: d.id, name: d.name }])), paused: shared.jobs.held };
      },
      read: (input) => jobOf(input.id),
      async start(input) {
        if (!host.jobs) throw new HarnessRefusal("unavailable", "This runtime can't run jobs.");
        const setup = await readSetup(shared, input.chatId);
        // The user's own start: the job belongs to the chat and to no turn (§22).
        const plan = typeof input.plan === "string" && input.plan.trim() !== "" ? input.plan.trim() : null;
        if (plan !== null && plan.length > setup.settings.workspace.pathChars) throw new HarnessRefusal("invalid", `The plan's path is ${plan.length} characters, and a path may be ${setup.settings.workspace.pathChars} at most (Path length).`);
        // Words of a plan its starter keeps stand in place of the ask to write it, so they come with the plan file they are about, and are held to Task length as the task is.
        const planWords = typeof input.planWords === "string" && input.planWords.trim() !== "" ? input.planWords.trim() : null;
        if (planWords !== null && plan === null) throw new HarnessRefusal("invalid", "Words of a plan its starter keeps need the plan file they are about (plan).");
        if (planWords !== null && planWords.length > setup.settings.jobs.taskChars) throw new HarnessRefusal("invalid", `The plan's words are ${planWords.length} characters, and may be ${setup.settings.jobs.taskChars} at most (Task length).`);
        const started = await shared.jobs.createJob({ chatId: input.chatId, when: input.when === "now" ? "now" : "after_reply", what: { agent: input.agent, task: input.task }, by: { who: "user" }, basis: null, ...(isRecord(input.allowance) ? { allowance: allowanceOf(input.allowance) } : {}), ...(input.area === "chat" ? { area: "chat" as const } : {}), ...(plan !== null ? { plan } : {}), ...(planWords !== null ? { planWords } : {}) }, setup);
        if ("refused" in started) throw new HarnessRefusal("invalid", started.refused);
        return { job: started };
      },
      async again(input) {
        if (!host.jobs) throw new HarnessRefusal("unavailable", "This runtime can't run jobs.");
        const { job } = await jobOf(input.id);
        const setup = await readSetup(shared, job.chatId);
        // Run again by the user, it is the same job again (`createJob` keeps who started it and the turn it belongs to); it runs now, since the reply it waited for is long written.
        const started = await shared.jobs.createJob({ chatId: job.chatId, when: "now", what: { again: job.id }, by: { who: "user" }, basis: null, ...(job.allowance ? { allowance: job.allowance } : {}) }, setup);
        if ("refused" in started) throw new HarnessRefusal("conflict", started.refused);
        return { job: started };
      },
      async cancel(input) {
        await jobOf(input.id);
        const setup = await readSetup(shared, "");
        const done = await shared.jobs.cancel(null, input.id, setup.texts.render(TEXT.jobs.whyCancelledByUser));
        if (!done) throw new HarnessRefusal("not_found", "There is no such job.");
        return { job: done.job };
      },
      async grant(input) {
        if (!isRecord(input.allowance)) throw new HarnessRefusal("bad_request", "Say how much more the job may spend.");
        return { job: await shared.jobs.grant(input.id, allowanceOf(input.allowance)) };
      },
      hold: async (input) => shared.jobs.hold(input.paused === true),
      run: (input, signal) => shared.jobs.run(input, signal),
      recover: () => shared.jobs.recover(),
    },

    sides: {
      list: (input) => sides.list(isRecord(input) ? input : {}),
      start: (input) => sides.start(input),
      turns: (input) => sides.turns(input),
      remove: (input) => sides.remove(input),
    },

    spend: { get: (input) => shared.spend.get(input) },
    upkeep: {
      get: async () => {
        // The keep times a count reads are the user's as they stand now.
        await readSetup(shared, "").catch(() => undefined);
        return upkeep.get();
      },
      sweep: async (signal) => {
        await readSetup(shared, "").catch(() => undefined);
        return upkeep.sweep(signal ?? new AbortController().signal);
      },
    },

    chats: {
      async forget(input) {
        const chatId = isRecord(input) && typeof input.chatId === "string" ? input.chatId : "";
        if (chatId === "") throw new HarnessRefusal("bad_request", "Say which chat to forget.");
        // A job of the chat is LumiAH's own to stop, below. A reply or a side session's answer is not: it ends first.
        if ([...shared.runs.values()].some((run) => run.info.chatId === chatId && run.info.kind !== "job")) throw new HarnessRefusal("conflict", "A reply or a side session's answer is being worked on in that chat. Stop it or let it end, then forget the chat.");
        const { store } = host;
        // The words a cancelled job is given are the user's own where their texts can be read, and the shipped ones where they can't: the job goes either way.
        const texts = await readSetup(shared, "").then(
          (setup) => setup.texts,
          () => textsOf(null),
        );
        // Each job that waits or runs is cancelled and has ended, written for the last time, before its documents go.
        const listed = await shared.jobs.list(chatId);
        for (const job of listed) if (!jobEnded(job)) await shared.jobs.cancel(chatId, job.id, texts.render(TEXT.jobs.whyCancelledByUser));
        const about = (await sides.list({ chatId })).sides;
        for (const side of about) await sides.remove({ id: side.id });

        // The two lists that name every chat's jobs lose this chat's, in a step among the jobs' own writes: nothing a job was writing lands after it, and nothing is written for the chat from then on.
        const jobs = new Set([...listed.map((job) => job.id), ...(await shared.jobs.forget(chatId))]);

        // Nothing of the chat is answered from memory or written back once its documents are gone.
        shared.areas.forget(chatId);
        const folder = chatFolder(chatId);
        const paths = new Set<string>();
        for (const id of jobs) paths.add(DOC.job(id));
        if (store.list) {
          for (const path of await store.list(folder)) paths.add(path);
          const owner = `/chat/${docKey(chatId)}/`;
          for (const path of await store.list(VECTORS)) if (path.includes(owner)) paths.add(path);
        } else {
          // A store that can't list gives up the documents a chat's id names; the heads its turns left under their own ids and its vectors can't be found there.
          for (const path of [DOC.learned(chatId), DOC.chatArea(chatId, ROOT_AREA), DOC.approvals(chatId), DOC.session(chatId), DOC.chatJobs(chatId)]) if ((await store.read(path)) !== null) paths.add(path);
          host.log("warn", `[LumiAH] this runtime can't list its documents, so forgetting chat ${chatId} left what its turns kept under their own ids and its search vectors`);
        }
        for (const path of paths) await store.remove(path);
        return { documents: paths.size + about.length, jobs: jobs.size, sides: about.length };
      },
    },

    approvals: {
      async kept(input) {
        const chatId = isRecord(input) && typeof input.chatId === "string" ? input.chatId : null;
        if (chatId !== null) return { kept: approvalRows(chatId, await keptApprovals(host.store, chatId)).sort(newestFirst) };
        if (!host.store.list) throw new HarnessRefusal("unavailable", "This runtime can't list its documents, so what you approved can be read for one chat at a time only.");
        // Every chat's approvals are a document of that name in the chat's folder: where chats are kept is read from where one chat's is.
        const sample = DOC.approvals("x");
        const rows: ApprovalRow[] = [];
        for (const path of await host.store.list(sample.slice(0, sample.indexOf("x")))) {
          const of = chatOf(path);
          if (of !== null && DOC.approvals(of) === path) rows.push(...approvalRows(of, await keptApprovals(host.store, of)));
        }
        return { kept: rows.sort(newestFirst) };
      },
      async forget(input) {
        const asked: Readonly<Record<string, unknown>> = isRecord(input) ? input : {};
        const { chatId, tool } = asked;
        if (typeof chatId !== "string" || chatId === "" || typeof tool !== "string" || tool === "") throw new HarnessRefusal("bad_request", "Say which tool to forget, and for which chat.");
        return { kept: approvalRows(chatId, await forgetApproval(host, chatId, tool)).sort(newestFirst) };
      },
    },

    recall: recallPage({
      host,
      setup: async (chatId) => {
        const setup = await readSetup(shared, chatId);
        return { ...setup, story: setup.story.source, chronicle: chronicleRefusal(setup.definitions, shared.options.extension?.name ?? null) };
      },
      learned: (chatId) => shared.areas.learned(chatId),
    }),
  };
}

/** An allowance as a page sent it, read: each member that is a whole number of zero or more, or null for no limit; anything else is left out. */
function allowanceOf(raw: Readonly<Record<string, unknown>>): JobAllowance {
  const out: JobAllowance = {};
  for (const key of ["tokensIn", "tokensOut", "toolTurns", "wallMs"] as const) {
    const value = raw[key];
    if (value === null || (typeof value === "number" && Number.isSafeInteger(value) && value >= 0)) out[key] = value;
  }
  return out;
}
