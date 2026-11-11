// A scripted model for a run in which several agents call at once (DESIGN §14, §15): two sub-agents
// at work in one round, a job beside a turn. A script by call number can't say what such a run does,
// since the order the calls arrive in isn't the test's to choose. Here each agent has a part: how its
// calls are told from the others' (by what the call itself holds: its system prompt, the tools it
// offers, what it was told), and its own lines, answered in order. A call no part takes, and a part
// with no line left, fail the call in words that say which.

import type { ModelRequest } from "../../src/core/ports";
import type { Answer, MadeCall } from "./fake-host";

/** One line of a part: an answer, or what gives it once the call is in (a test holds a call open by answering it later). */
export type Line = Answer | ((request: ModelRequest) => Answer | Promise<Answer>);

/** One agent's part: its name in the test, how its calls are known, and what it answers, call by call. */
export interface Part {
  name: string;
  is(request: ModelRequest): boolean;
  lines: Line[];
}

export interface Cast {
  /** What `FakeHost.script` takes. */
  script(call: MadeCall, n: number): Promise<Answer>;
  /** The calls a part has taken so far, in order, as the model was sent them. */
  calls(part: string): ModelRequest[];
  /** How many of a part's lines are still unsaid. */
  left(part: string): number;
}

/** The call offers this tool: `write_reply` is the main agent's alone, so it tells the main agent from every other. */
export const offers =
  (tool: string) =>
  (request: ModelRequest): boolean =>
    request.tools?.some((t) => t.name === tool) === true;

/** The call offers no tool at all, as the writer's does. */
export const bare = (request: ModelRequest): boolean => (request.tools?.length ?? 0) === 0;

/** One of the call's messages holds this text: an agent's own instructions, or the task it was handed. */
export const told =
  (text: string) =>
  (request: ModelRequest): boolean =>
    request.messages.some((m) => m.content.includes(text));

/** Every message of a call as one text, to look for what an agent was told. */
export const heard = (request: ModelRequest | undefined): string => (request?.messages ?? []).map((m) => m.content).join("\n");

/** A part's lines put behind one switch: its next call waits until `open()` is called. */
export function gate(): { held<T extends Answer>(answer: T): (request: ModelRequest) => Promise<T>; open(): void; readonly waiting: number } {
  const { promise, resolve } = Promise.withResolvers<void>();
  let waiting = 0;
  return {
    held: (answer) => async () => {
      waiting++;
      await promise;
      waiting--;
      return answer;
    },
    open: () => resolve(),
    get waiting() {
      return waiting;
    },
  };
}

/** The parts of one test, the first whose `is` holds taking a call: name the narrower part first. */
export function cast(...parts: Part[]): Cast {
  const taken = new Map<string, ModelRequest[]>(parts.map((part) => [part.name, []]));
  return {
    async script(call) {
      if (call.kind !== "call") throw new Error("the cast answers agents' calls, and this one was passed through");
      const part = parts.find((p) => p.is(call.request));
      if (part === undefined) throw new Error(`no part takes this call (its system prompt starts: ${JSON.stringify((call.request.messages[0]?.content ?? "").slice(0, 80))})`);
      const calls = taken.get(part.name) ?? [];
      const line = part.lines[calls.length];
      calls.push(call.request);
      taken.set(part.name, calls);
      if (line === undefined) throw new Error(`${part.name} has no line for its call ${calls.length}`);
      return typeof line === "function" ? line(call.request) : line;
    },
    calls: (part) => [...(taken.get(part) ?? [])],
    left: (part) => (parts.find((p) => p.name === part)?.lines.length ?? 0) - (taken.get(part)?.length ?? 0),
  };
}
