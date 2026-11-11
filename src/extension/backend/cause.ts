// Why a turn failed or LumiAH had no part in a reply, as a code a page can act on (DESIGN §8, §25).
// The sentence beside it stays what the user reads; the code says which step mends it: another
// model for the agents, a limit raised. It is read from the run's own trace, so a run's live view
// and its stored transcript say the same of it. What the trace can't know (a permission that is
// missing, the user's skip, a first half that never returned) is said by whoever does know
// (live.ts, hosted.ts).

import type { AgentStopCode, TraceRecord } from "../../core/ports";
import { isRecord } from "../../link/json";
import type { CauseCode } from "../../shared/ui";

/** The stops that are one of the user's own limits reached: each has a setting that raises it. */
const LIMITS: Readonly<Partial<Record<AgentStopCode, true>>> = {
  revisions: true,
  call_tokens_in: true,
  tokens_in: true,
  tokens_out: true,
  tool_turns: true,
  turn_tokens_in: true,
  turn_tokens_out: true,
  turn_tool_turns: true,
  call_time: true,
  wall_time: true,
  turn_time: true,
  throttle: true,
  spend: true,
};

/**
 * What a run's trace says of why its main agent stopped short: the time before the reply ran out
 * (`time`), one of the user's limits was reached (`limit`), or its connection took no native tools
 * and, with the tools written into its prompt, its model called none (`no_tools`). Null where the
 * trace names none of these. Events are read by shape past their kind, since a stored transcript
 * may come from an earlier build.
 */
export function causeOf(events: readonly TraceRecord[]): CauseCode | null {
  let main: string | null = null;
  let refused = false;
  let called = false;
  let stop: string | null = null;
  for (const { event } of events) {
    if (event.kind === "agent_started") {
      // The main agent is the one no other agent started: the first of a run.
      if (main === null && isRecord(event.agent) && typeof event.agent.id === "string" && event.agent.parent === undefined) main = event.agent.id;
      continue;
    }
    if (event.kind !== "agent_entry" || main === null || event.agentId !== main || !isRecord(event.entry)) continue;
    const { entry } = event;
    if (entry.kind === "tools_refused") refused = true;
    else if (entry.kind === "answer" && Array.isArray(entry.calls) && entry.calls.length > 0) called = true;
    else if (entry.kind === "stop") stop = typeof entry.code === "string" ? entry.code : null;
  }
  if (stop === "reply_time") return "time";
  if (stop !== null && Object.hasOwn(LIMITS, stop)) return "limit";
  return refused && !called ? "no_tools" : null;
}
