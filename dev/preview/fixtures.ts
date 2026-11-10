// Synthetic turns, chats and settings for the preview and the frontend's tests. Nothing here is
// from anyone's chat: the story is made up, and its people are Mara, Joss, Ilse, Brann and Okoro.
// `Trace` writes a turn's events the way the core traces them (numbered from 1, a usage event with
// the agent's and the turn's tally after each call), so the pages are driven by what they will get.

import type { AgentStarted, AgentUsage, CallPrompt, CallUsage, ChatView, ConnectionView, JsonObject, LiveEvent, ModelEffort, SessionTrace, TextDef, ToolCallView, TraceEvent, TurnKind, TurnRow, TurnStatus, UsageField } from "../../src/shared/ui";

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

  started(kind: TurnKind, messageId: string | null): this {
    return this.push({ kind: "turn_started", turn: this.turn, chatId: this.chatId, generation: kind, messageId, at: this.now });
  }

  session(session: SessionTrace): this {
    return this.push({ kind: "session", session, at: this.now });
  }

  agent(a: { id: string; role: string; system: string; model?: string | null; connectionId?: string | null; effort?: ModelEffort; prefix?: string[]; history?: number; parent?: string; task?: string }): this {
    const agent: AgentStarted = { id: a.id, role: a.role, connectionId: a.connectionId ?? null, model: a.model ?? null, effort: a.effort ?? "inherit", system: a.system, prefix: a.prefix ?? [], history: a.history ?? 0, ...(a.parent !== undefined ? { parent: a.parent } : {}), ...(a.task !== undefined ? { task: a.task } : {}), at: this.now };
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

  result(agentId: string, call: ToolCallView, text: string, ms: number, options: { error?: boolean; whole?: string } = {}): this {
    this.wait(ms);
    const scratch = options.whole !== undefined ? fakeHash(`scratch:${this.turn}:${call.id}`) : undefined;
    if (scratch !== undefined && options.whole !== undefined) this.blobs.set(scratch, options.whole);
    return this.push({ kind: "agent_entry", agentId, entry: { kind: "result", callId: call.id, name: call.name, text, error: options.error === true, ...(scratch !== undefined ? { scratch } : {}), ms, at: this.now } });
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
      usage: true,
      ...(agent?.role === "writer" ? { params: { temperature: 0.9, top_p: 0.95 } } : {}),
      messages: [{ role: "system", content: agent?.system ?? "", parts: [{ type: "text", text: agent?.system ?? "", cache: true }] }, ...told.map((text) => ({ role: "user" as const, content: text }))],
      ...(tools ? { tools: TOOL_DEFS } : {}),
    };
  }
}

const TOOL_DEFS: CallPrompt["tools"] = [
  { name: "chat_search", description: "Searches the chat's messages for words and says where they are.", parameters: { type: "object", properties: { query: { type: "string" }, cursor: { type: "string" } }, required: ["query"] } },
  { name: "lore_search", description: "Searches the world books that apply to this chat.", parameters: { type: "object", properties: { query: { type: "string" } }, required: ["query"] } },
  { name: "lore_read", description: "Reads one lore entry whole, by its id.", parameters: { type: "object", properties: { id: { type: "string" } }, required: ["id"] } },
  { name: "preset_instructions", description: "The instruction blocks of the active preset: what the reply must achieve.", parameters: { type: "object", properties: {} } },
  { name: "write_reply", description: "Hands the writer a brief and ends your work on this turn.", parameters: { type: "object", properties: { brief: { type: "string" } }, required: ["brief"] }, cache: true },
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

/** One step of a turn as it plays in the preview: what to wait, then what the trace gains. `says` is what the call that answers at the wait's end sends while it is in flight, which the stand-in backend streams over the wait. */
export interface PlayStep {
  after: number;
  says?: { agentId: string; reasoning?: string; text?: string };
  run(t: Trace): void;
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

// ---------------------------------------------------------------- chats, connections, sessions

export const CONNECTIONS: ConnectionView[] = [
  { id: "conn-loopback", name: "LumiAH loopback", provider: "custom", model: "lumiah", loopback: true },
  { id: "conn-deepseek", name: "Deepseek", provider: "deepseek", model: "deepseek-v4-flash", loopback: false },
  { id: "conn-local", name: "Local llama", provider: "llamacpp", model: "llama-local", loopback: false },
];

export const MODELS: Readonly<Record<string, string[]>> = { "conn-deepseek": ["deepseek-v4-flash", "deepseek-v4-pro"], "": ["deepseek-v4-flash", "deepseek-v4-pro"] };

const LOOPBACK = { id: "conn-loopback", name: "LumiAH loopback", loopback: true };

export const CHATS: ChatView[] = [
  { chatId: "chat-mara", name: "Mara at the harbour", on: true, since: Date.UTC(2026, 9, 28, 18, 5), connection: LOOPBACK },
  { chatId: "chat-brann", name: "Brann's long watch", on: true, since: Date.UTC(2026, 10, 2, 9, 30), connection: LOOPBACK },
  { chatId: "chat-okoro", name: "Okoro audits", on: true, since: Date.UTC(2026, 10, 4, 12, 0), connection: { id: "conn-deepseek", name: "Deepseek", loopback: false } },
];

/** A chat LumiAH doesn't answer, which the preview opens with `?chat=chat-ilse`. */
export const OTHER_CHAT: ChatView = { chatId: "chat-ilse", name: "Ilse, after the storm", on: false, since: null, connection: { id: "conn-deepseek", name: "Deepseek", loopback: false } };

export const SUMMARY = `What has happened so far

Mara came to the harbour town looking for the pilot's ledger. Joss, who keeps the tavern by the long pier, has been helping her since she paid Brann's tab. Brann keeps the day key to the harbour office; Ilse has held the night key since the autumn storms.

What is promised
- Joss will walk Mara to the office before it shuts.
- Mara owes Okoro an answer about the missing page by the first of the month.

What the main agent should remember
- Mara does not trust Brann, and has not said why.`;

/** A chat's stored turns, newest first, as the Sessions page lists them: one compacted, one off the path, one with no transcript. */
export function storedTurns(now: number): { row: TurnRow; trace: Trace | null }[] {
  const at = (minutesAgo: number): number => now - minutesAgo * 60_000;
  const turns: { index: number; ago: number; kind: TurnKind; preview: string; trace: "done" | "failed" | "long" | null; compaction?: TurnRow["compaction"]; onPath?: boolean }[] = [
    { index: 43, ago: 3, kind: "new", preview: "Joss was already reaching for the lamp. \"Brann, by day,\" he said, \"but it is past five…", trace: "done" },
    { index: 41, ago: 9, kind: "swipe", preview: "Joss wiped the counter down and nodded at the door. \"Harbourmaster's office shuts at six.", trace: "done", compaction: { summary: fakeHash("summary:1"), replaced: 6, rollback: "available" } },
    { index: 39, ago: 26, kind: "regenerate", preview: "", trace: "failed" },
    { index: 37, ago: 44, kind: "new", preview: "The rain had not let up since noon. Brann stood in the door of the office with his arms folded.", trace: "long" },
    { index: 35, ago: 71, kind: "continue", preview: "\"You paid his tab,\" Joss said slowly, as if the words cost him something.", trace: null },
    { index: 31, ago: 190, kind: "new", preview: "Ilse did not look up from the nets. \"Ask Okoro. He reads everything twice.\"", trace: "done", compaction: { summary: fakeHash("summary:0"), replaced: 9, rollback: "none" }, onPath: false },
  ];
  return turns.map((x) => {
    const id = `turn-${String(x.index).padStart(4, "0")}`;
    const trace = x.trace === "done" ? finishedTurn("chat-mara", id, at(x.ago), { kind: x.kind, messageId: `msg-${String(x.index).padStart(4, "0")}` }) : x.trace === "failed" ? failedTurn("chat-mara", id, at(x.ago)) : x.trace === "long" ? longTurn("chat-mara", id, at(x.ago), 90) : null;
    const row: TurnRow = { turn: id, messageId: `msg-${String(x.index).padStart(4, "0")}`, index: x.index, swipe: x.kind === "swipe" ? 1 : 0, at: at(x.ago), kind: x.kind, onPath: x.onPath ?? true, preview: x.preview, transcript: trace ? fakeHash(`transcript:${id}`) : null, compaction: x.compaction ?? null, usage: trace ? trace.tally : { calls: 2, toolTurns: 1, in: 4100, cachedIn: 3000, out: 260, reasoningOut: 0, estimated: false, ms: 5100, cost: 0.00065 } };
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
