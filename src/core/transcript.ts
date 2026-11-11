// A run's trace (DESIGN §4.2 `trace`, §8 Live): every step of every agent of a turn, a job's run or
// a side session's turn, numbered from 1 with no gap, handed to the host's trace port as it happens
// and kept for the run's transcript: the blob a turn's record, a job or a side session's turn names,
// so a past run is shown with the same feed as a live one.

import type { Blobs } from "./blobs";
import type { AgentTrace, AgentTurn } from "./loop";
import type { AgentStarted, AgentUsage, CallUsage, HarnessHost, JsonObject, ModelRequest, RunKind, TraceEvent, TraceRecord, TranscriptEntry, TurnStatus } from "./ports";
import { isRecord } from "./ports";
import { PromptKeeper } from "./prompts";
import { errorText, parseJson } from "./util";

/** A run's transcript as stored: the run (`turn`: its id; `chatId` `""` for a side session about no chat), how it ended, and every trace record of it in order. */
export interface TurnTranscript {
  v: 1;
  kind: "transcript";
  turn: string;
  chatId: string;
  generation: RunKind;
  messageId: string | null;
  startedAt: number;
  ended: { status: TurnStatus; at: number; reason?: string };
  events: TraceRecord[];
}

/** A stored transcript, read; null when the blob isn't one. Past its envelope its events are taken as the core wrote them. */
export function transcriptOf(text: string): TurnTranscript | null {
  const raw = parseJson(text);
  if (!isRecord(raw) || raw.v !== 1 || raw.kind !== "transcript" || typeof raw.turn !== "string" || typeof raw.chatId !== "string" || typeof raw.startedAt !== "number" || !isRecord(raw.ended) || !Array.isArray(raw.events)) return null;
  return raw as unknown as TurnTranscript;
}

/**
 * One turn's trace: what the turn and its agents do, each event numbered and handed to the host as
 * it is made. It is the loop's `AgentTrace` for the turn's agents, and it keeps each call's exact
 * prompt while Settings keep prompts.
 */
export class TurnTrace implements AgentTrace {
  private readonly records: TraceRecord[] = [];
  private readonly prompts: PromptKeeper | null;
  /** The turn's agents' tally, which each usage event reports beside the agent's own. */
  turn: AgentTurn | null = null;

  constructor(
    private readonly host: Pick<HarnessHost, "trace" | "clock" | "log">,
    private readonly ids: { turn: string; chatId: string },
    blobs: Blobs,
    keepPrompts: boolean,
    /** Hears every event after the host does (the turn's progress lines). */
    private readonly heard: (event: TraceEvent) => void = () => undefined,
  ) {
    this.prompts = keepPrompts ? new PromptKeeper(blobs) : null;
  }

  /** One event: numbered, kept, and handed to the host. A host whose trace port throws loses the event, never the turn. */
  emit(event: TraceEvent): void {
    const record: TraceRecord = { turn: this.ids.turn, chatId: this.ids.chatId, seq: this.records.length + 1, event };
    this.records.push(record);
    try {
      this.host.trace.event(record);
    } catch (error) {
      this.host.log("warn", `a trace event wasn't delivered (${errorText(error)})`);
    }
    this.heard(event);
  }

  start(agent: AgentStarted): void {
    this.emit({ kind: "agent_started", agent });
  }

  entry(agentId: string, entry: TranscriptEntry): void {
    this.emit({ kind: "agent_entry", agentId, entry });
  }

  usage(agentId: string, call: CallUsage, agent: AgentUsage, on: { connection: string; model: string }): void {
    this.emit({ kind: "usage", agentId, call, agent, turn: { ...(this.turn?.usage ?? agent) }, connection: on.connection, model: on.model, at: this.host.clock.now() });
  }

  idle(agentId: string, spent: AgentUsage): void {
    this.emit({ kind: "agent_idle", agentId, spent, at: this.host.clock.now() });
  }

  /** A piece of a streaming call's answer, for the live view alone: handed to a host that takes them, never numbered and never kept. One the host's port throws on is lost, as the entry that follows replaces it anyway. */
  delta(agentId: string, call: number, piece: { text?: string; reasoning?: string }): void {
    try {
      this.host.trace.delta?.({ turn: this.ids.turn, chatId: this.ids.chatId, agentId, call, ...piece, at: this.host.clock.now() });
    } catch (error) {
      this.host.log("debug", `a piece of a streaming answer wasn't delivered to the live view (${errorText(error)})`);
    }
  }

  async prompt(agentId: string, request: ModelRequest): Promise<string | undefined> {
    if (!this.prompts) return undefined;
    try {
      return await this.prompts.keep(agentId, request);
    } catch (error) {
      this.host.log("warn", `a call's prompt wasn't kept (${errorText(error)})`);
      return undefined;
    }
  }

  /** The run's transcript as it stands, for its blob. */
  transcript(turn: { generation: RunKind; messageId: string | null; startedAt: number; ended: TurnTranscript["ended"] }): JsonObject {
    const transcript: TurnTranscript = { v: 1, kind: "transcript", turn: this.ids.turn, chatId: this.ids.chatId, ...turn, events: [...this.records] };
    return transcript as unknown as JsonObject;
  }
}
