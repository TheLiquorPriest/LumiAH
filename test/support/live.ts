// What a test reads of a run in the live view (DESIGN §8), as a page that opens its stream gets it:
// the run's events in order, the agents it started, each agent's steps, and the tools an agent
// called with what each call came back with.

import type { AgentStarted, TraceEvent, TranscriptEntry } from "../../src/core/ports";
import type { LiveView } from "../../src/shared/ui";
import type { Rig } from "./rig";

/** A stream's live view as a page that opens it now gets it: its run, and every event of that run in order, read page by page as a page reads a long one. */
export async function live(it: Rig, stream: string): Promise<{ view: LiveView; events: TraceEvent[] }> {
  const opened = await it.page.request("lah.live.open", { stream });
  if (opened.live === null) throw new Error(`nothing is followed under ${stream}`);
  const records = [...opened.live.events];
  for (let from = opened.next; from !== null; ) {
    const more = await it.page.request("lah.live.events", { stream, turn: opened.live.turn, from });
    records.push(...more.events);
    from = more.next;
  }
  return { view: opened.live, events: records.map((record) => record.event) };
}

/** The agents a trace started as one definition, in the order they started. */
export function startedAs(events: readonly TraceEvent[], role: string): AgentStarted[] {
  return events.flatMap((e) => (e.kind === "agent_started" && e.agent.role === role ? [e.agent] : []));
}

/** One agent's steps, in order. */
export function stepsOf(events: readonly TraceEvent[], agentId: string | undefined): TranscriptEntry[] {
  return events.flatMap((e) => (e.kind === "agent_entry" && e.agentId === agentId ? [e.entry] : []));
}

/** The tools an agent called, in the order it called them, with what each call came back with. */
export function callsOf(steps: readonly TranscriptEntry[]): { name: string; text: string; error: boolean }[] {
  const results = new Map(steps.flatMap((s) => (s.kind === "result" ? [[s.callId, s] as const] : [])));
  return steps.flatMap((s) => (s.kind === "answer" ? s.calls : [])).map((call) => ({ name: call.name, text: results.get(call.id)?.text ?? "", error: results.get(call.id)?.error ?? false }));
}
