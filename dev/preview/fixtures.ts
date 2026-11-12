// Synthetic turns, chats and settings for the preview and the frontend's tests. Nothing here is
// from anyone's chat: the story is made up, and its people are Mara, Joss, Ilse, Brann and Okoro.
// `Trace` writes a turn's events the way the core traces them (numbered from 1, a usage event with
// the agent's and the turn's tally after each call), so the pages are driven by what they will get.

import type { AgentStarted, AgentUsage, CallPrompt, CallUsage, ChatView, ConnectionView, FileChange, JobView, JsonObject, LiveEvent, LoreChanges, ModelEffort, PromptHeld, RunKind, SessionTrace, TextDef, ToolCallView, ToolTier, TraceEvent, TranscriptEntry, TurnKind, TurnRow, TurnStatus, UsageField } from "../../src/shared/ui";

/** A 64-character hash for a made-up blob: the same for the same name, and plainly not a real digest. */
export function fakeHash(name: string): string {
  let h = 2166136261;
  let out = "";
  for (let round = 0; round < 8; round += 1) {
    for (let i = 0; i < name.length; i += 1) h = Math.imul(h ^ name.charCodeAt(i), 16777619) >>> 0;
    h = Math.imul(h ^ round, 16777619) >>> 0;
    out += h.toString(16).padStart(8, "0");
  }
  return out;
}

const noUsage = (): AgentUsage => ({ calls: 0, toolTurns: 0, in: 0, cachedIn: 0, out: 0, reasoningOut: 0, estimated: false, ms: 0, cost: 0 });

function add(total: AgentUsage, call: CallUsage, ms: number, tools: boolean): AgentUsage {
  const next: AgentUsage = { ...total, calls: total.calls + 1, toolTurns: total.toolTurns + (tools ? 1 : 0), in: total.in + call.in, cachedIn: total.cachedIn + call.cachedIn, out: total.out + call.out, reasoningOut: total.reasoningOut + call.reasoningOut, estimated: total.estimated || call.estimated.length > 0, ms: total.ms + ms };
  // A tally has a cost only while every call so far had one.
  if (total.cost !== undefined && call.cost !== undefined) next.cost = total.cost + call.cost;
  else delete next.cost;
  return next;
}

export interface AnswerSpec {
  text?: string;
  reasoning?: string;
  calls?: ToolCallView[];
  in: number;
  cachedIn?: number;
  out: number;
  reasoningOut?: number;
  /** Null: the provider named no cost and no price is set. */
  cost?: number | null;
  estimated?: UsageField[];
  ms: number;
  model?: string;
  finishReason?: string;
  tools?: "native" | "text" | "none";
  written?: boolean;
  offered?: { tools: number; tokens: number };
  /** False: Settings keep no prompts, so the call names none. */
  prompt?: boolean;
}

/** A turn's trace, written an event at a time. Time moves on by what each step takes. */
export class Trace {
  readonly events: LiveEvent[] = [];
  /** Each call's exact prompt, by its hash. */
  readonly prompts = new Map<string, CallPrompt>();
  /** Whole texts kept apart from a clipped result, by hash. */
  readonly blobs = new Map<string, string>();
  now: number;
  /** A turn played as you watch reads the time from here, so each step happens when it is played; a turn written whole moves its own time on. */
  clock: (() => number) | null = null;
  private seq = 0;
  private turnTally = noUsage();
  private readonly tallies = new Map<string, AgentUsage>();
  private readonly agents = new Map<string, AgentStarted>();
  private readonly told = new Map<string, string[]>();

  constructor(
    readonly chatId: string,
    readonly turn: string,
    readonly startedAt: number,
  ) {
    this.now = startedAt;
  }

  /** Time passes: by `ms` in a turn written whole, to the clock's time in one played as you watch. */
  wait(ms: number): this {
    this.now = this.clock ? this.clock() : this.now + ms;
    return this;
  }

  private push(event: TraceEvent): this {
    this.seq += 1;
    this.events.push({ turn: this.turn, chatId: this.chatId, seq: this.seq, event });
    return this;
  }

  started(kind: RunKind, messageId: string | null, of: { job?: string; side?: string } = {}): this {
    return this.push({ kind: "turn_started", turn: this.turn, chatId: this.chatId, generation: kind, messageId, ...of, at: this.now });
  }

  /** What the prompt held, as the main agent was told (DESIGN §24.1). */
  held(held: PromptHeld): this {
    return this.push({ kind: "prompt_held", ...held, at: this.now });
  }

  session(session: SessionTrace): this {
    return this.push({ kind: "session", session, at: this.now });
  }

  agent(a: { id: string; role: string; system: string; model?: string | null; connectionId?: string | null; connectionName?: string; gone?: string; effort?: ModelEffort; prefix?: string[]; history?: number; parent?: string; task?: string }): this {
    const agent: AgentStarted = { id: a.id, role: a.role, connectionId: a.connectionId ?? null, ...(a.connectionName !== undefined ? { connectionName: a.connectionName } : {}), ...(a.gone !== undefined ? { gone: a.gone } : {}), model: a.model ?? null, effort: a.effort ?? "inherit", system: a.system, prefix: a.prefix ?? [], history: a.history ?? 0, ...(a.parent !== undefined ? { parent: a.parent } : {}), ...(a.task !== undefined ? { task: a.task } : {}), at: this.now };
    this.agents.set(a.id, agent);
    this.tallies.set(a.id, noUsage());
    this.told.set(a.id, []);
    return this.push({ kind: "agent_started", agent });
  }

  message(agentId: string, text: string): this {
    this.told.get(agentId)?.push(text);
    return this.push({ kind: "agent_entry", agentId, entry: { kind: "message", text, at: this.now } });
  }

  /** A call answers: the answer's step, then the usage after it. */
  answer(agentId: string, a: AnswerSpec): this {
    this.wait(a.ms);
    const agent = this.agents.get(agentId);
    const model = a.model ?? agent?.model ?? "deepseek-v4-flash";
    const call: CallUsage = { in: a.in, cachedIn: a.cachedIn ?? 0, out: a.out, reasoningOut: a.reasoningOut ?? 0, estimated: a.estimated ?? [], ...(a.cost === null ? {} : { cost: a.cost ?? (a.in * 0.14 + a.out * 0.28) / 1_000_000 }) };
    const calls = a.calls ?? [];
    const hash = a.prompt === false ? undefined : fakeHash(`prompt:${this.turn}:${this.seq + 1}`);
    if (hash !== undefined) this.prompts.set(hash, this.promptOf(agentId, model, calls.length > 0 || a.tools === "native"));
    this.push({ kind: "agent_entry", agentId, entry: { kind: "answer", text: a.text ?? "", ...(a.reasoning !== undefined ? { reasoning: a.reasoning } : {}), calls, written: a.written ?? false, tools: a.tools ?? (calls.length > 0 ? "native" : "none"), ...(a.offered ? { offered: a.offered } : {}), usage: call, model, finishReason: a.finishReason ?? (calls.length > 0 ? "tool_calls" : "stop"), ms: a.ms, at: this.now, ...(hash !== undefined ? { prompt: hash } : {}) } });
    const tally = add(this.tallies.get(agentId) ?? noUsage(), call, a.ms, calls.length > 0);
    this.tallies.set(agentId, tally);
    this.turnTally = add(this.turnTally, call, a.ms, calls.length > 0);
    return this.push({ kind: "usage", agentId, call, agent: tally, turn: this.turnTally, at: this.now });
  }

  result(agentId: string, call: ToolCallView, text: string, ms: number, options: { error?: boolean; whole?: string; files?: FileChange[]; lore?: LoreChanges } = {}): this {
    this.wait(ms);
    const scratch = options.whole !== undefined ? fakeHash(`scratch:${this.turn}:${call.id}`) : undefined;
    if (scratch !== undefined && options.whole !== undefined) this.blobs.set(scratch, options.whole);
    const entry: TranscriptEntry = { kind: "result", callId: call.id, name: call.name, text, error: options.error === true, ...(scratch !== undefined ? { scratch } : {}), ...(options.files ? { files: options.files } : {}), ms, at: this.now };
    // What `write_reply` did to the writer's lore rides on its result (§24.3; `loreChangesOf` in ui.ts reads it by shape).
    return this.push({ kind: "agent_entry", agentId, entry: options.lore ? ({ ...entry, lore: options.lore } as TranscriptEntry) : entry });
  }

  /** Something the user said to the run, as its main agent (the first it started) receives it at its next round. */
  note(text: string): this {
    const main = [...this.agents.keys()][0];
    if (main === undefined) return this;
    this.told.get(main)?.push(text);
    return this.push({ kind: "agent_entry", agentId: main, entry: { kind: "note", text, at: this.now } });
  }

  paused(): this {
    return this.push({ kind: "turn_paused", at: this.now });
  }

  resumed(): this {
    return this.push({ kind: "turn_resumed", at: this.now });
  }

  /** A tool call held for the user's word. */
  asked(agentId: string, call: ToolCallView, tier: ToolTier, until: number | null): this {
    return this.push({ kind: "agent_entry", agentId, entry: { kind: "approval_asked", callId: call.id, tool: call.name, tier, args: call.args, until, at: this.now } });
  }

  /** How a held call's wait ended, and how long it was: `ms` in a turn written whole; in one played as you watch, the time since it was asked. */
  approval(agentId: string, call: ToolCallView, word: HeldWord, ms?: number): this {
    this.wait(ms ?? 0);
    const asked = this.events.findLast((e) => e.event.kind === "agent_entry" && e.event.entry.kind === "approval_asked" && e.event.entry.callId === call.id)?.event;
    const since = asked?.kind === "agent_entry" ? asked.entry.at : this.now;
    return this.push({ kind: "agent_entry", agentId, entry: { kind: "approval", callId: call.id, decision: word.decision, ...(word.reason !== undefined ? { reason: word.reason } : {}), ms: ms ?? Math.max(0, this.now - since), at: this.now } });
  }

  /** Something the runtime told an agent beside a round's results (how few rounds of tool calls it has left). */
  runtimeNotice(agentId: string, text: string): this {
    return this.push({ kind: "agent_entry", agentId, entry: { kind: "notice", text, at: this.now } });
  }

  /** Something the user should know about the run that is no agent's step. */
  runNotice(text: string): this {
    return this.push({ kind: "notice", text, at: this.now });
  }

  /** A job one of the run's agents started, as it stood when it was queued. */
  job(job: JobView): this {
    return this.push({ kind: "job", job, at: this.now });
  }

  /** The agents that have started and not yet come to rest. */
  working(): string[] {
    const idle = new Set(this.events.flatMap((e) => (e.event.kind === "agent_idle" ? [e.event.agentId] : [])));
    return [...this.agents.keys()].filter((id) => !idle.has(id));
  }

  /** How many workspace files the run's tool calls changed. */
  changed(): number {
    const files = new Set<string>();
    for (const e of this.events) if (e.event.kind === "agent_entry" && e.event.entry.kind === "result") for (const f of e.event.entry.files ?? []) files.add(`${f.area}:${f.path}`);
    return files.size;
  }

  refused(agentId: string, reason: string, ms: number): this {
    this.wait(ms);
    return this.push({ kind: "agent_entry", agentId, entry: { kind: "tools_refused", reason, ms, at: this.now } });
  }

  /** A call fails in passing and is made again: the failure's step with its prompt, then the wait before the next try. */
  retry(agentId: string, reason: string, attempt: number, of: number, waitMs: number, ms: number): this {
    this.wait(ms);
    const hash = fakeHash(`prompt:${this.turn}:${this.seq + 1}`);
    this.prompts.set(hash, this.promptOf(agentId, this.agents.get(agentId)?.model ?? "deepseek-v4-flash", true));
    this.push({ kind: "agent_entry", agentId, entry: { kind: "retry", reason, attempt, of, waitMs, ms, at: this.now, prompt: hash } });
    return this.wait(waitMs);
  }

  stop(agentId: string, status: "refused" | "stopped" | "cancelled" | "failed", code: "tool_turns" | "loop" | "cancelled" | "failed" | "wall_time" | "tokens_out", reason: string): this {
    return this.push({ kind: "agent_entry", agentId, entry: { kind: "stop", status, code, reason, at: this.now } });
  }

  idle(agentId: string): this {
    return this.push({ kind: "agent_idle", agentId, spent: this.tallies.get(agentId) ?? noUsage(), at: this.now });
  }

  ended(status: TurnStatus, reason?: string): this {
    return this.push({ kind: "turn_ended", status, ...(reason !== undefined ? { reason } : {}), usage: this.turnTally, at: this.now });
  }

  get tally(): AgentUsage {
    return this.turnTally;
  }

  /** What a call of the agent was sent, as the core would keep it. */
  private promptOf(agentId: string, model: string, tools: boolean): CallPrompt {
    const agent = this.agents.get(agentId);
    const told = this.told.get(agentId) ?? [];
    return {
      connectionId: agent?.connectionId ?? null,
      model,
      maxTokens: agent?.role === "writer" ? 8192 : 16_000,
      effort: agent?.effort ?? "inherit",
      stream: true,
      ...(agent?.role === "writer" ? { params: { temperature: 0.9, top_p: 0.95 } } : {}),
      messages: [{ role: "system", content: agent?.system ?? "" }, ...told.map((text) => ({ role: "user" as const, content: text }))],
      ...(tools ? { tools: TOOL_DEFS } : {}),
    };
  }
}

const TOOL_DEFS: CallPrompt["tools"] = [
  { name: "chat_search", description: "Searches the chat's messages for words and says where they are.", parameters: { type: "object", properties: { query: { type: "string" }, cursor: { type: "string" } }, required: ["query"] } },
  { name: "lore_search", description: "Searches the world books that apply to this chat.", parameters: { type: "object", properties: { query: { type: "string" } }, required: ["query"] } },
  { name: "lore_read", description: "Reads one lore entry whole, by its id.", parameters: { type: "object", properties: { id: { type: "string" } }, required: ["id"] } },
  { name: "preset_instructions", description: "The instruction blocks of the active preset: what the reply must achieve.", parameters: { type: "object", properties: {} } },
  { name: "write_reply", description: "Hands the writer a brief and ends your work on this turn.", parameters: { type: "object", properties: { brief: { type: "string" } }, required: ["brief"] } },
];

export const MAIN_SYSTEM = `You are the main agent of this chat. Each turn you are given the request Lumiverse assembled, as a document to read, and what you carry from earlier turns.

Work out what the reply needs: who is present, what they know, what was promised earlier. Use your tools to look things up rather than guess. When you have what the reply needs, call write_reply with a brief for the writer: what happens, what must be kept true, and what the preset's instructions ask of the prose.

Do not write the reply yourself.`;

export const WRITER_SYSTEM = "You are a collaborative fiction writer. Stay in the scene, write in the third person, past tense, and never speak for Mara.";

const REQUEST = `# The request

## Instructions the reply must achieve (from the preset)
- Third person, past tense. Two to four paragraphs.
- Never decide what Mara says or does.
- End on something Mara can answer.

## The conversation
[#41, Joss] Joss wiped the counter down and nodded at the door. "Harbourmaster's office shuts at six. If the ledger is anywhere, it is there."
[#42, Mara] I pull my coat on. "Then we go now. Who keeps the key, Ilse or Brann?"

## Lore Lumiverse activated for this reply
- The harbour office (entry lore-harbour-office)`;

const HARBOUR_ENTRY = `The harbour office

A two-room brick building at the foot of the long pier. Brann keeps the day key; Ilse has held the night key since the autumn storms, when the old lock was changed. The ledgers stand in the back room, in a cabinet that sticks in wet weather.

Okoro audits the ledgers on the first of each month and signs the last page he read.`;

const REPLY = `Joss was already reaching for the lamp. "Brann, by day," he said, "but it is past five, and Brann goes home with the tide." He checked the window, where the light over the pier had gone the colour of weak tea. "After dark it is Ilse. She has had the night key since the storms."

He set the lamp on the counter between them and did not light it yet. Outside, a cart rattled down toward the water and was gone.

"One thing," Joss said. "Okoro signed that ledger on the first. If a page is missing, it went missing after." He looked at her over the unlit lamp. "So which do you want to find first, the key or the man who last read it?"`;

/** A whole, finished turn: the main agent looks things up (one tool fails, one result comes back clipped), briefs the writer, and the writer writes. */
export function finishedTurn(chatId: string, turn: string, startedAt: number, options: { kind?: TurnKind; messageId?: string | null; session?: SessionTrace } = {}): Trace {
  const t = new Trace(chatId, turn, startedAt);
  const search: ToolCallView = { id: "call_search_1", name: "chat_search", args: { query: "ledger key harbour office" } };
  const lore: ToolCallView = { id: "call_lore_1", name: "lore_read", args: { id: "lore-harbor-office" } };
  const preset: ToolCallView = { id: "call_preset_1", name: "preset_instructions", args: {} };
  const lore2: ToolCallView = { id: "call_lore_2", name: "lore_read", args: { id: "lore-harbour-office" } };
  const write: ToolCallView = { id: "call_write_1", name: "write_reply", args: { brief: "Joss answers Mara's question plainly: Brann keeps the day key, Ilse the night key since the autumn storms, and it is past five, so it is Ilse now. He adds that Okoro signed the ledger on the first, so any missing page went missing after that. Keep Joss practical and a little dry. End on a choice for Mara: the key, or Okoro." } };
  t.started(options.kind ?? "new", options.messageId ?? "msg-0043");
  t.session(options.session ?? { turns: 3, tokens: 4180, summary: true, dropped: [], missing: 0 });
  t.wait(40).agent({ id: "main-1", role: "main", system: MAIN_SYSTEM, connectionId: "conn-deepseek", history: 6 });
  t.message("main-1", REQUEST);
  t.answer("main-1", { reasoning: "Mara asks who keeps the key. The request names an activated lore entry for the harbour office; I should read it rather than guess. I also want to know whether the chat already said who has the key, and what the preset asks of the prose.", calls: [search, lore, preset], in: 5120, cachedIn: 3900, out: 212, reasoningOut: 96, ms: 2840, offered: { tools: 5, tokens: 610 } });
  t.result("main-1", search, "3 messages found, showing 3.\n\n#17 [Joss] \"Brann locks up at dusk, or he used to.\"\n#29 [Mara] I ask Ilse about the lock. She says it was changed after the storms.\n#41 [Joss] \"Harbourmaster's office shuts at six. If the ledger is anywhere, it is there.\"\n\nNo more results.", 180);
  t.result("main-1", lore, "No lore entry has the id lore-harbor-office. Ids are spelled as lore_search shows them: search for the entry, then read it by the id in the result.", 12, { error: true });
  t.result("main-1", preset, "3 instruction blocks.\n\n1. Third person, past tense. Two to four paragraphs.\n2. Never decide what Mara says or does.\n3. End on something Mara can answer.", 9);
  t.answer("main-1", { reasoning: "The id was misspelled. The request spells it lore-harbour-office.", calls: [lore2], in: 5610, cachedIn: 5120, out: 64, reasoningOut: 31, ms: 1320 });
  t.result("main-1", lore2, `${HARBOUR_ENTRY.slice(0, 180)}…\n\n[Clipped: 180 of ${HARBOUR_ENTRY.length} characters. scratch_read reads the rest.]`, 14, { whole: HARBOUR_ENTRY });
  t.answer("main-1", { text: "I have what the reply needs.", calls: [write], in: 5890, cachedIn: 5610, out: 148, reasoningOut: 22, ms: 1980 });
  t.wait(30).agent({ id: "writer-1", role: "writer", system: WRITER_SYSTEM, connectionId: "conn-deepseek", model: "deepseek-v4-flash", parent: "main-1", task: "write the reply from the brief" });
  t.message("writer-1", `${REQUEST}\n\n## The brief\n${String(write.args.brief)}`);
  t.answer("writer-1", { text: REPLY, in: 2210, out: 236, ms: 4350 });
  t.idle("writer-1");
  t.result("main-1", write, `The writer wrote the reply (${REPLY.length} characters).`, 4400);
  t.idle("main-1");
  t.wait(20).ended("done");
  return t;
}

// ---------------------------------------------------------------- turns that read what the prompt held (DESIGN §24.1, §24.3)

/** The reply the story's briefed turn ends with: what LumiAH's writer wrote from the main agent's brief. */
const KEY_REPLY = "The door opened a hand's width. Ilse stood behind it with the night key already in her fist, as if she had heard the knock coming up the lane.";

/** What the prompt of the story's turns held (§24.1), as core traces it: the entries Lumiverse activated, the entries listed for the main agent that it didn't, and the chat's messages it holds word for word. The ids are the Lore page's (mock/lore.ts). */
export const PROMPT_HELD: PromptHeld = {
  lore: [
    { entryId: "lore-town-rules", bookId: "book-harbour", title: "How the town speaks", chars: 96, tokens: 24, why: { by: "constant" }, message: 2 },
    { entryId: "lore-harbour-office", bookId: "book-harbour", title: "The harbour office", chars: 212, tokens: 53, why: { by: "key", key: "harbour office" }, message: 3 },
    { entryId: "lore-joss", bookId: "book-people", title: "Joss", chars: 131, tokens: 33, why: { by: "vector", score: 0.71 }, message: null },
  ],
  index: {
    listed: [
      { entryId: "lore-night-key", bookId: "book-harbour", title: "The night key", keys: ["night key"], chars: 118 },
      { entryId: "lore-okoro", bookId: "book-people", title: "Okoro", keys: ["Okoro", "audit"], chars: 102 },
    ],
    more: 24,
  },
  // A stand-in is named by what holds it: here the preset's block that carries Lumiverse's summary.
  history: { held: [[30, 47]], missing: [[1, 29]], stands: [{ kind: "summary", name: "Story so far" }] },
};

/** What the story's `write_reply` did to the lore the writer saw (§24.3): the night key's entry added, Joss's own dropped, and one it named that the books don't have. */
export const LORE_CHANGE: LoreChanges = {
  added: [{ entryId: "lore-night-key", bookId: "book-harbour", title: "The night key", chars: 118 }],
  dropped: [{ entryId: "lore-joss", bookId: "book-people", title: "Joss", chars: 131 }],
  refused: [{ entryId: "lore-ilse", reason: "The chat's books have no entry lore-ilse. lore_index lists the entries there are." }],
};

/** What the main agent is told of the prompt in the request itself (§24.1), as the story's request ends. */
const HELD_NOTES = `## Lore in the prompt
- How the town speaks (lore-town-rules, 96 characters): always on
- The harbour office (lore-harbour-office, 212 characters): a key matched ("harbour office")
- Joss (lore-joss, 131 characters): close in meaning (0.71)

## Lore not in the prompt (2 of 26 listed)
- The night key (lore-night-key): night key
- Okoro (lore-okoro): Okoro, audit

## History in the prompt
Messages #30 to #47 are here word for word. #1 to #29 are not: Lumiverse's summary stands in for them.`;

const KEY_BRIEF = "Ilse comes to the door with the night key already in her hand. She will let Mara in, but she wants to know why Joss sent her. Keep it short and wary. End on Ilse's question.";

/** `write_reply` in the runtime: LumiAH's writer writes the reply from the brief, with the lore the main agent added for it and dropped (§24.3), and the turn ends with the reply. */
function writeReply(t: Trace, write: ToolCallView): Trace {
  t.wait(30).agent({ id: "writer-1", role: "writer", system: WRITER_SYSTEM, connectionId: "conn-deepseek", model: "deepseek-v4-flash", parent: "main-1", task: "write the reply from the brief" });
  t.message("writer-1", `${REQUEST.replace("Who keeps the key, Ilse or Brann?", "I knock at Ilse's door.")}\n\n## The brief\n${String(write.args.brief)}`);
  t.answer("writer-1", { text: KEY_REPLY, in: 2210, out: 64, ms: 3100 });
  t.idle("writer-1");
  t.result("main-1", write, `The writer wrote the reply (${KEY_REPLY.length} characters).`, 3200, { lore: LORE_CHANGE });
  t.idle("main-1");
  return t.wait(20).ended("done");
}

/**
 * A whole, finished turn whose main agent is told what the prompt holds, looks up what it
 * doesn't, and briefs the writer with one lore entry added for it and one dropped.
 */
export function briefedTurn(chatId: string, turn: string, startedAt: number, options: { kind?: TurnKind; messageId?: string | null; session?: SessionTrace } = {}): Trace {
  const t = new Trace(chatId, turn, startedAt);
  const lore: ToolCallView = { id: "call_lore_1", name: "lore_search", args: { queries: ["night key", "who may open the harbour office"] } };
  const chat: ToolCallView = { id: "call_search_1", name: "chat_search", args: { queries: ["Ilse night key"] } };
  const write: ToolCallView = { id: "call_write_1", name: "write_reply", args: { brief: KEY_BRIEF, add: ["lore-night-key", "lore-ilse"], drop: ["lore-joss"] } };
  t.started(options.kind ?? "new", options.messageId ?? "msg-0047");
  t.session(options.session ?? { turns: 4, tokens: 5230, summary: true, dropped: [], missing: 0 });
  t.held(PROMPT_HELD);
  t.wait(40).agent({ id: "main-1", role: "main", system: MAIN_SYSTEM, connectionId: "conn-deepseek", history: 8 });
  t.message("main-1", `${REQUEST.replace("Who keeps the key, Ilse or Brann?", "I knock at Ilse's door.")}\n\n${HELD_NOTES}`);
  t.answer("main-1", { reasoning: "Mara is at Ilse's door. The prompt already holds the harbour office and how the town speaks. Nothing on the night key itself is in it, though the list of what isn't shows an entry for it. One search will say whether it bears on this, and what the chat last said of the key.", calls: [lore, chat], in: 6020, cachedIn: 5890, out: 132, reasoningOut: 58, ms: 2600, offered: { tools: 14, tokens: 1720 } });
  t.result("main-1", lore, "2 queries.\n\nnight key: 2 entries found, showing 2.\n1. The night key [lore-night-key] · The harbour town · not in the prompt · its title and keys hold: night, key\n   1: The night key opens the harbour office after six.\n2. The harbour office [lore-harbour-office] · The harbour town · in the prompt · its text holds: night, key\n   2: Brann holds the day key; Ilse has held the night key since the autumn storms.\n\nwho may open the harbour office: 1 entry found, showing 1.\n1. The harbour office [lore-harbour-office] · The harbour town · in the prompt · its title holds: harbour, office", 240);
  t.result("main-1", chat, "1 query.\n\nIlse night key: 2 messages found in 1 stretch, showing 2.\n#29 [Mara] I ask Ilse about the lock. She says it was changed after the storms. [#29 7c1e]\n#43 [Joss] \"Brann, by day, but it is past five. Ilse has the night key.\" [#43 b20a]", 190);
  t.answer("main-1", { text: "The night key's own entry belongs in front of the writer. Joss's entry doesn't bear on this scene: he isn't in it.", calls: [write], in: 6410, cachedIn: 6020, out: 148, reasoningOut: 20, ms: 2200 });
  return writeReply(t, write);
}

/** A turn that failed: a call failed in passing and was made again, its connection refused native tools, and then the main agent ran out of tool rounds. */
export function failedTurn(chatId: string, turn: string, startedAt: number): Trace {
  const t = new Trace(chatId, turn, startedAt);
  t.started("regenerate", "msg-0031");
  t.session({ turns: 1, tokens: 1320, summary: false, dropped: [4], missing: 1 });
  t.wait(30).agent({ id: "main-1", role: "main", system: MAIN_SYSTEM, connectionId: "conn-local", model: "llama-local" });
  t.message("main-1", REQUEST);
  t.retry("main-1", "The connection closed before the model answered.", 1, 2, 2000, 900);
  t.refused("main-1", "400: this model does not support tools", 420);
  for (let round = 1; round <= 3; round += 1) {
    const call: ToolCallView = { id: `call_text_${round}`, name: "chat_search", args: { query: "night key" } };
    t.answer("main-1", { text: `<tool_call>{"name":"chat_search","arguments":{"query":"night key"}}</tool_call>`, calls: [call], in: 2400 + round * 310, out: 44, ms: 5200, model: "llama-local", cost: null, estimated: ["in", "out"], tools: "text", written: true, prompt: round !== 3 });
    t.result("main-1", call, "0 messages found for night key. Try fewer words, or chat_grep for an exact phrase.", 150);
  }
  t.stop("main-1", "stopped", "loop", "It made the same call, chat_search with the same arguments, 3 times running on the same state, so it was stopped.");
  t.idle("main-1");
  t.wait(15).ended("failed", "The main agent stopped before it wrote a brief, and Settings say a turn fails then.");
  return t;
}

/** A long turn, for paging and search: the main agent reads the chat a batch at a time. */
export function longTurn(chatId: string, turn: string, startedAt: number, rounds: number): Trace {
  const t = new Trace(chatId, turn, startedAt);
  t.started("new", "msg-0101");
  t.wait(20).agent({ id: "main-1", role: "main", system: MAIN_SYSTEM, connectionId: "conn-deepseek" });
  t.message("main-1", REQUEST);
  for (let round = 1; round <= rounds; round += 1) {
    const call: ToolCallView = { id: `call_read_${round}`, name: "chat_read", args: { from: (round - 1) * 20, to: round * 20 } };
    t.answer("main-1", { reasoning: `Batch ${round}: nothing about the ledger yet.`, calls: [call], in: 3000 + round * 40, cachedIn: 2900, out: 30, ms: 600 });
    t.result("main-1", call, `Messages ${(round - 1) * 20} to ${round * 20 - 1}.\n${Array.from({ length: 6 }, (_, i) => `#${(round - 1) * 20 + i} [${["Mara", "Joss", "Ilse", "Brann", "Okoro"][(round + i) % 5]}] A line of the chat, number ${(round - 1) * 20 + i}.`).join("\n")}`, 40);
  }
  t.answer("main-1", { text: "Nothing more to read.", in: 9000, cachedIn: 8000, out: 20, ms: 700 });
  t.idle("main-1");
  t.ended("done");
  return t;
}

/** How a held call's wait ended: the user's word, or the wait running out. */
export interface HeldWord {
  decision: "once" | "chat" | "refused" | "timed_out";
  reason?: string;
}

/**
 * One step of a turn as it plays in the preview: what to wait, then what the trace gains. `says` is
 * what the call that answers at the wait's end sends while it is in flight, which the stand-in
 * backend streams over the wait. `asks` holds the step for the user's word on a tool call (for
 * `wait` ms at most), and `run` is then given how that ended.
 */
export interface PlayStep {
  after: number;
  says?: { agentId: string; reasoning?: string; text?: string };
  asks?: { agentId: string; role: string; call: ToolCallView; tier: ToolTier; wait: number };
  run(t: Trace, word?: HeldWord): void;
}

/**
 * A turn played a step at a time, for a live view that fills as you watch. The waits are the
 * preview's own pace (a real call takes seconds; these take long enough to see each state).
 */
export function playedTurn(): PlayStep[] {
  const search: ToolCallView = { id: "call_search_1", name: "chat_search", args: { query: "Okoro signed the ledger" } };
  const lore: ToolCallView = { id: "call_lore_1", name: "lore_search", args: { query: "night key" } };
  const write: ToolCallView = { id: "call_write_1", name: "write_reply", args: { brief: "Ilse comes to the door with the night key already in her hand. She will let Mara in, but she wants to know why Joss sent her. Keep it short and wary. End on Ilse's question." } };
  const wonders = "Mara is at Ilse's door. What does Ilse know of the ledger, and has she met Mara before? The request names no lore for Ilse, so the chat and the lore are both worth a look before the brief.";
  const enough = "Enough to brief the writer.";
  const reply = "The door opened a hand's width. Ilse stood behind it with the night key already in her fist, as if she had heard the knock coming up the lane.\n\n\"Joss sent you,\" she said. It was not a question. Her eyes went past Mara to the dark street and came back. \"He does not send people to me after dark for nothing. What does he think is in that office?\"";
  return [
    { after: 0, run: (t) => void t.started("new", null).session({ turns: 4, tokens: 5230, summary: true, dropped: [], missing: 0 }) },
    { after: 300, run: (t) => void t.agent({ id: "main-1", role: "main", system: MAIN_SYSTEM, connectionId: "conn-deepseek", history: 8 }).message("main-1", REQUEST.replace("Who keeps the key, Ilse or Brann?", "I knock at Ilse's door.")) },
    { after: 2600, says: { agentId: "main-1", reasoning: wonders }, run: (t) => void t.answer("main-1", { reasoning: wonders, calls: [search, lore], in: 6020, cachedIn: 5890, out: 120, reasoningOut: 48, ms: 2600 }) },
    { after: 900, run: (t) => void t.result("main-1", search, "1 message found, showing 1.\n\n#38 [Joss] \"Okoro signed it on the first. I watched him do it.\"\n\nNo more results.", 900) },
    { after: 700, run: (t) => void t.result("main-1", lore, "2 entries found, showing 2.\n\nlore-harbour-office · The harbour office · \"…Ilse has held the night key since the autumn storms…\"\nlore-ilse · Ilse · \"…does not open the office for anyone Brann has not vouched for…\"", 700) },
    { after: 2200, says: { agentId: "main-1", text: enough }, run: (t) => void t.answer("main-1", { text: enough, calls: [write], in: 6410, cachedIn: 6020, out: 132, reasoningOut: 20, ms: 2200 }) },
    { after: 400, run: (t) => void t.agent({ id: "writer-1", role: "writer", system: WRITER_SYSTEM, connectionId: "conn-deepseek", model: "deepseek-v4-flash", parent: "main-1", task: "write the reply from the brief" }).message("writer-1", `${REQUEST}\n\n## The brief\n${String(write.args.brief)}`) },
    { after: 3800, says: { agentId: "writer-1", text: reply }, run: (t) => void t.answer("writer-1", { text: reply, in: 2380, out: 118, ms: 3800 }).idle("writer-1") },
    { after: 200, run: (t) => void t.result("main-1", write, "The writer wrote the reply (341 characters).", 4400).idle("main-1") },
    { after: 150, run: (t) => void t.ended("done") },
  ];
}

// ---------------------------------------------------------------- turns with sub-agents, workspace writes and a held call

const ARCHIVIST_SYSTEM = "You keep this chat's notes. Read what the workspace holds before you write, write what is known and where it was said, and say what you changed.";
const READER_SYSTEM = "You read the chat for one question and answer it with the messages that bear on it, by number.";

/** The versions the made-up workspace writes move between: the same names the workspace part of the stand-in backend keeps (mock/workspace.ts), so a result's file leads to a file that is there. */
export const NOTE_FILES = {
  ledger: { area: "chat", path: "notes/ledger.md" },
  okoro: { area: "learned", path: "people/okoro.md" },
  timeline: { area: "chat", path: "notes/timeline.md" },
} as const satisfies Record<string, Pick<FileChange, "area" | "path">>;

/** A job as a turn's agent queued it. */
export function queuedJob(now: number, by: { id: string; role: string }): JobView {
  return { id: "job-timeline-2", chatId: "chat-mara", agent: "archivist", task: "Bring notes/timeline.md up to date with the last ten replies, one line a reply.", when: "after_reply", state: "queued", by: { who: "agent", ...by }, basis: "turn-0045", createdAt: now, usage: { calls: 0, toolTurns: 0, in: 0, cachedIn: 0, out: 0, reasoningOut: 0, estimated: false, ms: 0, cost: 0 } };
}

/**
 * A whole, finished turn in which the main agent has others work for it: it delegates to an
 * archivist, who has a reader search the chat (a sub-agent of a sub-agent) and then writes two
 * workspace files, one after the user approved the call; it starts a job; it is told a job that
 * ended since its last turn; the user said something part-way; and LumiAH's writer writes the reply.
 */
export function workedTurn(chatId: string, turn: string, startedAt: number): Trace {
  const t = new Trace(chatId, turn, startedAt);
  const delegate: ToolCallView = { id: "call_delegate_1", name: "delegate", args: { agent: "archivist", task: "Note what we now know of the pilot's ledger and of Okoro, with where each thing was said." } };
  const ask: ToolCallView = { id: "call_delegate_2", name: "delegate", args: { agent: "reader", task: "Which replies say who signed the ledger, and when?" } };
  const search: ToolCallView = { id: "call_search_1", name: "chat_search", args: { query: "signed the ledger" } };
  const read: ToolCallView = { id: "call_ws_read_1", name: "workspace_read", args: { path: "notes/ledger.md" } };
  // The arguments are core's own (`workspace_write` takes the file's text as `content`, and `base: "new"` for a file that isn't there yet): the approval card draws the change from them.
  const write1: ToolCallView = { id: "call_ws_write_1", name: "workspace_write", args: { path: "notes/ledger.md", content: "# The pilot's ledger\n\n- Kept in the harbour office, back room cabinet (#41).\n- Okoro signed it on the first (#38).\n- A page is missing; it went missing after the first (#43).", base: fakeHash("ws:ledger:2") } };
  const write2: ToolCallView = { id: "call_ws_write_2", name: "workspace_write", args: { path: "learned/people/okoro.md", content: "# Okoro\n\nAudits the ledgers on the first of each month and signs the last page he read. Reads everything twice (Ilse, #31).", base: "new" } };
  const job: ToolCallView = { id: "call_job_1", name: "job_start", args: { agent: "archivist", task: "Bring notes/timeline.md up to date with the last ten replies, one line a reply.", when: "after_reply" } };
  const write: ToolCallView = { id: "call_write_1", name: "write_reply", args: { brief: "Joss tells Mara what the notes now hold: Okoro signed on the first, so the page went missing after. Keep him dry. End on a question for Mara." } };
  const done: JobView = { id: "job-timeline-1", chatId, agent: "archivist", task: "Start notes/timeline.md from the replies so far.", when: "after_reply", state: "done", by: { who: "agent", id: "main-1", role: "main" }, basis: "turn-0043", createdAt: startedAt - 4 * 60_000, startedAt: startedAt - 4 * 60_000 + 900, endedAt: startedAt - 3 * 60_000, usage: { calls: 4, toolTurns: 3, in: 9200, cachedIn: 6100, out: 410, reasoningOut: 60, estimated: false, ms: 21_400, cost: 0.0014 }, report: fakeHash("report:job-timeline-1"), opening: "Started notes/timeline.md: 14 lines, one a reply, from #17 to #43." };
  t.started("new", "msg-0045");
  t.session({ turns: 4, tokens: 5610, summary: true, dropped: [], missing: 0, jobs: [done] });
  t.wait(40).agent({ id: "main-1", role: "main", system: MAIN_SYSTEM, connectionId: "conn-deepseek", history: 8, prefix: ["~/GUIDANCE.md", "learned/GUIDANCE.md"] });
  t.message("main-1", REQUEST);
  t.answer("main-1", { reasoning: "The ledger has come up three times now and nothing of it is written down. Have the archivist note it before I brief the writer.", calls: [delegate], in: 6120, cachedIn: 5200, out: 96, reasoningOut: 40, ms: 2100, offered: { tools: 12, tokens: 1480 } });
  t.wait(60).agent({ id: "archivist-1", role: "archivist", system: ARCHIVIST_SYSTEM, connectionId: "conn-deepseek", parent: "main-1", task: String(delegate.args.task) });
  t.message("archivist-1", String(delegate.args.task));
  t.answer("archivist-1", { reasoning: "I need the replies that say who signed it. A reader can find them while I read the note that is there.", calls: [ask, read], in: 1840, out: 88, reasoningOut: 30, ms: 1500 });
  t.wait(40).agent({ id: "reader-1", role: "reader", system: READER_SYSTEM, connectionId: "conn-local", model: "llama-local", parent: "archivist-1", task: String(ask.args.task) });
  t.message("reader-1", String(ask.args.task));
  t.answer("reader-1", { calls: [search], in: 620, out: 30, ms: 900, cost: null });
  t.result("reader-1", search, "2 messages found, showing 2.\n\n#38 [Joss] \"Okoro signed it on the first. I watched him do it.\"\n#43 [Joss] \"If a page is missing, it went missing after.\"\n\nNo more results.", 140);
  t.answer("reader-1", { text: "#38 says Okoro signed the ledger on the first, and that Joss saw it. #43 adds that a missing page went missing after that.", in: 760, out: 44, ms: 1100, cost: null });
  t.idle("reader-1");
  t.result("archivist-1", ask, "#38 says Okoro signed the ledger on the first, and that Joss saw it. #43 adds that a missing page went missing after that.", 2300);
  t.result("archivist-1", read, "# The pilot's ledger\n\n- Kept in the harbour office, back room cabinet (#41).", 16);
  t.answer("archivist-1", { calls: [write1, write2], in: 2260, cachedIn: 1840, out: 190, ms: 2400 });
  t.result("archivist-1", write1, "Wrote notes/ledger.md (3 lines).", 22, { files: [{ ...NOTE_FILES.ledger, before: fakeHash("ws:ledger:2"), after: fakeHash("ws:ledger:3") }] });
  t.asked("archivist-1", write2, "write", t.now + 5 * 60_000);
  t.note("Keep Okoro's note short: one paragraph.");
  t.approval("archivist-1", write2, { decision: "chat" }, 8200);
  t.result("archivist-1", write2, "Wrote learned/people/okoro.md (1 paragraph).", 19, { files: [{ ...NOTE_FILES.okoro, before: null, after: fakeHash("ws:okoro:1") }] });
  t.answer("archivist-1", { text: "Noted. notes/ledger.md now says who signed it and when the page went missing, each with its reply. learned/people/okoro.md is new: who he is and how he audits.", in: 2610, cachedIn: 2260, out: 72, ms: 1300 });
  t.idle("archivist-1");
  t.result("main-1", delegate, "Noted. notes/ledger.md now says who signed it and when the page went missing, each with its reply. learned/people/okoro.md is new: who he is and how he audits.", 16_900);
  t.answer("main-1", { calls: [job, write], in: 6480, cachedIn: 6120, out: 150, reasoningOut: 18, ms: 1900 });
  t.result("main-1", job, "Started job job-timeline-2 as archivist: it runs once this reply is written.", 30);
  t.job(queuedJob(t.now, { id: "main-1", role: "main" }));
  t.wait(30).agent({ id: "writer-1", role: "writer", system: WRITER_SYSTEM, connectionId: "conn-deepseek", model: "deepseek-v4-flash", parent: "main-1", task: "write the reply from the brief" });
  t.message("writer-1", `${REQUEST}\n\n## The brief\n${String(write.args.brief)}`);
  t.answer("writer-1", { text: REPLY, in: 2260, out: 236, ms: 4100 });
  t.idle("writer-1");
  t.result("main-1", write, `The writer wrote the reply (${REPLY.length} characters).`, 4200);
  t.idle("main-1");
  t.wait(20).ended("done");
  return t;
}

/**
 * A turn played a step at a time in which the main agent delegates to an archivist whose
 * workspace write is held for the user's word: the live view shows the sub-agent under the agent
 * that started it, the card, and what the answer does; then LumiAH's writer writes the reply.
 */
export function workingTurn(): PlayStep[] {
  const delegate: ToolCallView = { id: "call_delegate_1", name: "delegate", args: { agent: "archivist", task: "Note what Ilse said at the door, in notes/ledger.md." } };
  const read: ToolCallView = { id: "call_ws_read_1", name: "workspace_read", args: { path: "notes/ledger.md" } };
  const edit: ToolCallView = { id: "call_ws_write_1", name: "workspace_write", args: { path: "notes/ledger.md", content: "# The pilot's ledger\n\n- Kept in the harbour office, back room cabinet (#41).\n- Okoro signed it on the first (#38).\n- A page is missing; it went missing after the first (#43).\n- Ilse holds the night key and asks what Joss thinks is in the office (#47).", base: fakeHash("ws:ledger:3") } };
  const write: ToolCallView = { id: "call_write_1", name: "write_reply", args: { brief: "Ilse lets Mara in, but only as far as the front room. End on what Mara sees on the desk." } };
  const plan = "Ilse has spoken for the first time in a while. The archivist should note it, then I brief the writer.";
  const reply = "Ilse let the door swing a little wider, no more than that. \"Front room,\" she said. \"You do not go in the back without Brann.\"\n\nThe lamp on the desk was already lit, and under it lay a ledger page that had no business being loose.";
  const written: PlayStep[] = [
    { after: 300, run: (t) => void t.agent({ id: "writer-1", role: "writer", system: WRITER_SYSTEM, connectionId: "conn-deepseek", model: "deepseek-v4-flash", parent: "main-1", task: "write the reply from the brief" }).message("writer-1", `${REQUEST}\n\n## The brief\n${String(write.args.brief)}`) },
    { after: 3200, says: { agentId: "writer-1", text: reply }, run: (t) => void t.answer("writer-1", { text: reply, in: 2300, out: 96, ms: 3200 }).idle("writer-1") },
    { after: 200, run: (t) => void t.result("main-1", write, `The writer wrote the reply (${reply.length} characters).`, 3700).idle("main-1") },
    { after: 150, run: (t) => void t.ended("done") },
  ];
  return [
    { after: 0, run: (t) => void t.started("new", null).session({ turns: 5, tokens: 6020, summary: true, dropped: [], missing: 0 }) },
    { after: 300, run: (t) => void t.agent({ id: "main-1", role: "main", system: MAIN_SYSTEM, connectionId: "conn-deepseek", history: 8 }).message("main-1", REQUEST.replace("Who keeps the key, Ilse or Brann?", "I tell Ilse what Joss said.")) },
    { after: 2200, says: { agentId: "main-1", reasoning: plan }, run: (t) => void t.answer("main-1", { reasoning: plan, calls: [delegate], in: 6240, cachedIn: 5900, out: 84, reasoningOut: 36, ms: 2200 }) },
    { after: 300, run: (t) => void t.agent({ id: "archivist-1", role: "archivist", system: ARCHIVIST_SYSTEM, connectionId: "conn-deepseek", parent: "main-1", task: String(delegate.args.task) }).message("archivist-1", String(delegate.args.task)) },
    { after: 1600, run: (t) => void t.answer("archivist-1", { calls: [read], in: 1210, out: 26, ms: 1600 }) },
    { after: 400, run: (t) => void t.result("archivist-1", read, "# The pilot's ledger\n\n- Kept in the harbour office, back room cabinet (#41).\n- Okoro signed it on the first (#38).\n- A page is missing; it went missing after the first (#43).", 18) },
    { after: 1800, run: (t) => void t.answer("archivist-1", { calls: [edit], in: 1480, cachedIn: 1210, out: 140, ms: 1800 }) },
    {
      after: 200,
      asks: { agentId: "archivist-1", role: "archivist", call: edit, tier: "write", wait: 5 * 60_000 },
      run: (t, word) => {
        const how = word ?? { decision: "once" };
        t.approval("archivist-1", edit, how);
        if (how.decision === "once" || how.decision === "chat") t.result("archivist-1", edit, "Wrote notes/ledger.md (4 lines).", 24, { files: [{ ...NOTE_FILES.ledger, before: fakeHash("ws:ledger:3"), after: fakeHash("ws:ledger:4") }] });
        else t.result("archivist-1", edit, how.decision === "refused" ? `The user refused this call${how.reason ? `: ${how.reason}` : "."} Do not make it again unless they ask.` : "No answer came before the wait ran out, so the call was refused.", 0, { error: true });
      },
    },
    { after: 1500, says: { agentId: "archivist-1", text: "Done as far as I was let." }, run: (t) => void t.answer("archivist-1", { text: "Done as far as I was let.", in: 1700, cachedIn: 1480, out: 20, ms: 1500 }).idle("archivist-1") },
    { after: 200, run: (t) => void t.result("main-1", delegate, "Done as far as I was let.", 5800) },
    { after: 2000, run: (t) => void t.answer("main-1", { text: "Enough to brief the writer.", calls: [write], in: 6520, cachedIn: 6240, out: 110, ms: 2000 }) },
    ...written,
  ];
}

// ---------------------------------------------------------------- chats, connections, sessions

export const CONNECTIONS: ConnectionView[] = [
  { id: "conn-loopback", name: "LumiAH loopback", provider: "custom", model: "lumiah", loopback: true },
  { id: "conn-deepseek", name: "Deepseek", provider: "deepseek", model: "deepseek-v4-flash", loopback: false },
  { id: "conn-local", name: "Local llama", provider: "llamacpp", model: "llama-local", loopback: false },
];

const LOOPBACK = { id: "conn-loopback", name: "LumiAH loopback", loopback: true };
const OWN = { id: "conn-deepseek", name: "Deepseek", loopback: false };

/** The chats LumiAH is switched on for: two pinned to the loopback connection, so the runtime answers them, and one whose connection the user changed since, so its replies don't reach LumiAH. */
export const CHATS: ChatView[] = [
  { chatId: "chat-mara", name: "Mara at the harbour", on: true, since: Date.UTC(2026, 9, 28, 18, 5), connection: LOOPBACK },
  { chatId: "chat-brann", name: "Brann's long watch", on: true, since: Date.UTC(2026, 10, 2, 9, 30), connection: LOOPBACK },
  { chatId: "chat-okoro", name: "Okoro audits", on: true, since: Date.UTC(2026, 10, 4, 12, 0), connection: OWN },
];

/** A chat LumiAH doesn't answer, which the preview opens with `?chat=chat-ilse`. */
export const OTHER_CHAT: ChatView = { chatId: "chat-ilse", name: "Ilse, after the storm", on: false, since: null, connection: OWN };

/** A chat another extension answers, one that carries LumiAH inside it: the preview opens it with `?chat=chat-joss`, to see what LumiAH says of it and to take it over. */
export const THEIR_CHAT: ChatView = { chatId: "chat-joss", name: "Joss keeps the tavern", on: false, since: null, connection: OWN, other: { identifier: "harbour_tales", name: "Harbour Tales" } };

export const SUMMARY = `What has happened so far

Mara came to the harbour town looking for the pilot's ledger. Joss, who keeps the tavern by the long pier, has been helping her since she paid Brann's tab. Brann keeps the day key to the harbour office; Ilse has held the night key since the autumn storms.

What is promised
- Joss will walk Mara to the office before it shuts.
- Mara owes Okoro an answer about the missing page by the first of the month.

What the main agent should remember
- Mara does not trust Brann, and has not said why.`;

/** How many workspace files each stored turn changed, by its reply's place in the chat: what the workspace part of the stand-in backend answers a change set for (mock/workspace.ts). */
export const STORED_CHANGES: Readonly<Record<number, number>> = { 43: 3, 41: 1, 37: 2 };

/**
 * A chat's stored turns, newest first, as the Sessions page lists them: one made a compaction, one
 * failed, one has no transcript, and one is off the path.
 */
export function storedTurns(now: number): { row: TurnRow; trace: Trace | null }[] {
  const at = (minutesAgo: number): number => now - minutesAgo * 60_000;
  const turns: { index: number; ago: number; kind: TurnKind; preview: string; trace: "briefed" | "done" | "failed" | "long" | null; compaction?: TurnRow["compaction"]; onPath?: boolean }[] = [
    { index: 43, ago: 3, kind: "new", preview: "Joss was already reaching for the lamp. \"Brann, by day,\" he said, \"but it is past five…", trace: "briefed" },
    { index: 41, ago: 9, kind: "swipe", preview: "Joss wiped the counter down and nodded at the door. \"Harbourmaster's office shuts at six.", trace: "briefed", compaction: { summary: fakeHash("summary:1"), replaced: 6, rollback: "available" } },
    { index: 39, ago: 26, kind: "regenerate", preview: "", trace: "failed" },
    { index: 37, ago: 44, kind: "new", preview: "The rain had not let up since noon. Brann stood in the door of the office with his arms folded.", trace: "long" },
    { index: 35, ago: 71, kind: "continue", preview: "\"You paid his tab,\" Joss said slowly, as if the words cost him something.", trace: null },
    { index: 33, ago: 120, kind: "new", preview: "Brann shrugged and looked out at the water. \"Ask at the office in the morning,\" he said.", trace: "done" },
    { index: 31, ago: 190, kind: "new", preview: "Ilse did not look up from the nets. \"Ask Okoro. He reads everything twice.\"", trace: "done", compaction: { summary: fakeHash("summary:0"), replaced: 9, rollback: "none" }, onPath: false },
  ];
  return turns.map((x) => {
    const id = `turn-${String(x.index).padStart(4, "0")}`;
    const messageId = `msg-${String(x.index).padStart(4, "0")}`;
    const trace =
      x.trace === "briefed"
        ? briefedTurn("chat-mara", id, at(x.ago), { kind: x.kind, messageId })
        : x.trace === "done"
          ? finishedTurn("chat-mara", id, at(x.ago), { kind: x.kind, messageId })
          : x.trace === "failed"
            ? failedTurn("chat-mara", id, at(x.ago))
            : x.trace === "long"
              ? longTurn("chat-mara", id, at(x.ago), 90)
              : null;
    const row: TurnRow = { turn: id, messageId, index: x.index, swipe: x.kind === "swipe" ? 1 : 0, at: at(x.ago), kind: x.kind, onPath: x.onPath ?? true, preview: x.preview, transcript: trace ? fakeHash(`transcript:${id}`) : null, compaction: x.compaction ?? null, usage: trace ? trace.tally : { calls: 2, toolTurns: 1, in: 4100, cachedIn: 3000, out: 260, reasoningOut: 0, estimated: false, ms: 5100, cost: 0.00065 }, changes: STORED_CHANGES[x.index] ?? 0 };
    return { row, trace };
  });
}

// ---------------------------------------------------------------- a sample of settings and texts

/** A settings section that uses every keyword the Settings page reads, for the tests and for `?settings=sample`. */
export const SAMPLE_SCHEMA: JsonObject = {
  type: "object",
  title: "Sample",
  properties: {
    reply: {
      type: "object",
      title: "The reply",
      description: "Who writes the reply.",
      properties: {
        writer: { title: "Who writes the reply", description: "A separate writer, or the main agent itself.", type: "string", oneOf: [{ const: "writer", title: "The writer", description: "A second call writes the prose." }, { const: "main", title: "The main agent", description: "Its final answer is the reply." }] },
        progress: { title: "Progress lines", description: "Write what the main agent is doing into the thinking block.", type: "boolean" },
      },
    },
    agents: {
      type: "object",
      title: "Agents",
      description: "What each agent runs with.",
      properties: {
        main: {
          type: "object",
          title: "Main agent",
          description: "Works out what the reply needs.",
          properties: {
            connectionId: { title: "Connection", type: ["string", "null"], format: "connection", "x-none": "Your default connection" },
            model: { title: "Model", type: ["string", "null"], format: "model", "x-none": "The connection's own" },
            effort: { title: "Effort", type: "string", enum: ["inherit", "off", "low", "medium", "high"] },
            tools: { title: "Tools", type: "array", uniqueItems: true, items: { type: "string", oneOf: [{ const: "chat_search", title: "chat_search", description: "Searches the chat." }, { const: "lore_read", title: "lore_read", description: "Reads a lore entry." }, { const: "write_reply", title: "write_reply", description: "Briefs the writer." }] } },
            budget: { type: "object", title: "Budget", properties: { toolTurns: { title: "Tool rounds", type: ["integer", "null"], minimum: 0, "x-unit": "rounds", "x-none": "No limit" }, wallMs: { title: "Time", type: ["integer", "null"], minimum: 1, "x-unit": "ms", "x-none": "No limit" } } },
          },
        },
        writer: {
          type: "object",
          title: "Writer",
          properties: { connectionId: { title: "Connection", type: ["string", "null"], format: "connection", "x-none": "Your default connection" }, model: { title: "Model", type: ["string", "null"], format: "model", "x-none": "The connection's own" } },
        },
      },
    },
    history: {
      title: "History cutoff",
      description: "Which of the chat's messages stay in the prompt.",
      oneOf: [
        { title: "Every message", type: "object", properties: { keep: { const: "all" } } },
        { title: "The latest", type: "object", properties: { keep: { const: "last" }, count: { title: "Messages kept", type: "integer", minimum: 1, maximum: 10000, "x-unit": "messages" } } },
      ],
    },
    prices: { type: "object", title: "Prices", description: "Per model.", "x-keys": "model", additionalProperties: { type: "object", default: { in: 0, out: 0 }, properties: { in: { title: "Prompt", type: "number", minimum: 0, "x-unit": "USD per million tokens" }, out: { title: "Answer", type: "number", minimum: 0, "x-unit": "USD per million tokens" } } } },
    stops: { title: "Stop words", description: "One a line.", type: "array", items: { type: "string" } },
    notes: { title: "Notes", type: "string", format: "multiline", maxLength: 2000 },
    odd: { title: "Something the page has no form for", type: "array", items: { type: "object" } },
  },
};

export function sampleDefaults(): JsonObject {
  return {
    reply: { writer: "writer", progress: true },
    agents: { main: { connectionId: null, model: null, effort: "inherit", tools: ["chat_search", "lore_read", "write_reply"], budget: { toolTurns: 24, wallMs: null } }, writer: { connectionId: null, model: null } },
    history: { keep: "last", count: 40 },
    prices: {},
    stops: [],
    notes: "",
    odd: [],
  };
}

export const SAMPLE_TEXTS: TextDef[] = [
  { id: "main.system", group: "Main agent", label: "Instructions", note: "What the main agent is told first, every turn.", text: MAIN_SYSTEM, vars: [] },
  { id: "main.request", group: "Main agent", label: "The request", note: "How the request Lumiverse assembled is put to the main agent.", text: "# The request\n\n{{instructions}}\n\n## The conversation\n{{conversation}}", vars: [{ name: "instructions", text: "The preset's instruction blocks.", required: true }, { name: "conversation", text: "The messages Lumiverse assembled.", required: true }, { name: "lore", text: "The lore Lumiverse activated." }] },
  { id: "writer.brief", group: "Writer", label: "The brief's heading", note: "What stands over the main agent's brief in the writer's prompt.", text: "## The brief\n{{brief}}", vars: [{ name: "brief", text: "The main agent's brief.", required: true }] },
  { id: "tool.chat_search", group: "Tools", label: "chat_search", note: "What the model is told chat_search does.", text: "Searches the chat's messages for words and says where they are.", vars: [] },
];
