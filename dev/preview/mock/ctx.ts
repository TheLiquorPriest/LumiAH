// What the parts of the stand-in backend share (mock-backend.ts puts them together): the refusal a
// handler throws, the state and its pushes, the clock, a store of texts by hash (as the real store
// keeps a file's body, a report and a summary), and the way to play a run under a stream so a live
// view of it fills as you watch. Each part answers the requests of one area from made-up data of
// its own and keeps what the page changes for as long as the page lives.

import type { CallUsage, ChatView, JobView, JsonValue, LastTurn, LiveEndState, SettingPath, StreamId, UiErrorCode, UiProblem, UiRequest, UiRequests, UiRequestType, UiState } from "../../../src/shared/ui";
import type { PlayStep, Trace } from "../fixtures";

/** A request refused, as the real backend refuses one: a code, and words that say what to do. */
export class Refusal extends Error {
  constructor(
    readonly code: UiErrorCode,
    message: string,
    readonly problems?: UiProblem[],
  ) {
    super(message);
  }
}

/** The handlers of some requests, each given the request as it crossed and answering its result, at once or (where the real one takes a while) later; a `Refusal` thrown or rejected with is the request's error. */
export type Handlers<K extends UiRequestType> = { [P in K]: (r: Extract<UiRequest, { type: P }>) => UiRequests[P]["result"] | Promise<UiRequests[P]["result"]> };

/** How a run ended: its id, how, the hash its transcript is kept under (`lah.transcript.get`), and its trace. */
export interface PlayEnd {
  turn: string;
  state: LiveEndState;
  transcript: string;
  trace: Trace;
}

/**
 * A run to play: whether it answers a generation in a chat (only the chat's own turns do; a job's
 * run and a side session's turn don't), its chat (null: none), the id its trace goes by (a job's
 * run goes by the job's id; left out, one is made), how long a built-in reply's turn has before
 * the reply (left out: the story's usual time), and what to do when it has ended.
 */
export interface PlayOptions {
  reply: boolean;
  chatId: string | null;
  turn?: string;
  replyMs?: number;
  done?(end: PlayEnd): void;
}

/** A model call of a run played since the preview opened (a reply's turn, a job's run, a side session's turn), as Spend counts one: when, its chat (null: none), its agent's definition id (the role: "main", "archivist"), its connection id, its model, and what it used (`cost` absent: no price). */
export interface PlayedCall {
  at: number;
  chatId: string | null;
  agent: string;
  connection: string;
  model: string;
  usage: CallUsage;
}

export interface MockCtx {
  now(): number;
  /** Runs `fn` after `ms`; returns the cancel. Tests pass their own, so nothing waits on a clock. */
  later(fn: () => void, ms: number): () => void;
  /** False in the preview's `fresh` scenario, where nothing has been set up or run: a part then starts with nothing kept. */
  ready: boolean;
  /** The scenario the preview opened in, for a part whose story differs by it beyond `ready` (in `trouble`, something is missing that a set-up install has). Left out by a context made by hand, which is then taken as `ready` or `fresh` by `ready` alone. */
  scenario?: "ready" | "fresh" | "trouble";
  /** The README's pictures: the made-up story opens learned to its end. Left out: as the scenario has it. */
  showcase?: boolean;
  state(): UiState;
  /** The state changed: its parts that did go to the page under the next revision. */
  push(patch: Partial<Omit<UiState, "rev">>): void;
  /** Texts by hash (`lah.blob.get` reads them): `put` keeps one and answers its hash; `set` keeps one under a hash the made-up data names elsewhere (a version a turn's result points at). */
  blobs: { put(text: string): string; set(hash: string, text: string): void; get(hash: string): string | undefined };
  /**
   * Plays a run a step at a time under a stream (a job's id, a side session's id), as a reply's
   * turn is played: the pages that opened the stream see it fill, `UiState.running` lists it, and
   * it can be stopped, paused and talked to from the page. The steps' first must start the trace
   * (`t.started(...)`). Answers the run's id, or null while a run of that stream is under way.
   */
  play(stream: StreamId, steps: PlayStep[], options: PlayOptions): string | null;
  /** Stops a run under way, as the user's Stop does; false when none of that stream runs. */
  stop(stream: StreamId, why: string): boolean;
  /** Holds a run under way at its next step, or lets it go on, as `lah.turn.pause` does (its trace says so, and `UiState.running` shows it paused); false when none of that stream runs. */
  pause(stream: StreamId, on: boolean): boolean;
  /** Changes settings as `lah.settings.set` does (each `set` a whole value at a path, each `reset` a path back to its default): the state's settings follow, so the Settings page and a page that changes the same setting by another request stay in step. Throws the `Refusal` a section's check gives. */
  settings(set: { path: SettingPath; value: JsonValue }[], reset: SettingPath[]): void;
  /** Keeps the transcript of a run that ended before the preview opened (a job's, a side session's turn), written whole with `Trace`; answers the hash it is read by. */
  keep(stream: StreamId, trace: Trace): string;
  /** A job was started as the learning of a chat's story (`lah.job.start` with `story`): the part that answers `lah.story.get` names it from then on. Left out where no such part is put together. */
  learning?(chatId: string, jobId: string): void;
  /** Every model call of every run played since the preview opened, oldest first. Left out where no run can be played. */
  calls?(): readonly PlayedCall[];
}

/** What the part that answers Home's read needs beside: a chat as the backend has it, whether it is listed in the state or not, and its latest turn as the live views and the stored turns have it. */
export interface HomeCtx extends MockCtx {
  chat(chatId: string): ChatView;
  last(chatId: string): LastTurn | null;
}

/** What the part that answers for the learning of a story needs beside: the job started as it for a chat, as the jobs' part has it now; null where none was. */
export interface StoryCtx extends MockCtx {
  storyJob(chatId: string): JobView | null;
}

/** The agent definitions the made-up data names, by id: the same in every part, so a job's agent, a side session's and a definition agree. */
export const MOCK_AGENTS: readonly { id: string; name: string }[] = [
  { id: "main", name: "Main agent" },
  { id: "writer", name: "Writer" },
  { id: "summarizer", name: "Summarizer" },
  { id: "archivist", name: "Archivist" },
  { id: "reader", name: "Reader" },
  { id: "cartographer", name: "Cartographer" },
];

/** A hash-shaped name for a text: 64 hex characters that differ for different texts, which is all the pages ask of one. Not a real digest: the preview needs none. */
export function hashOf(text: string): string {
  let a = 0x811c9dc5;
  let b = 0x01000193;
  for (let i = 0; i < text.length; i += 1) {
    a = Math.imul(a ^ text.charCodeAt(i), 0x01000193) >>> 0;
    b = Math.imul(b + text.charCodeAt(i), 0x85ebca6b) >>> 0;
  }
  let out = "";
  for (let i = 0; i < 8; i += 1) {
    a = Math.imul(a ^ (a >>> 15), 0x2c1b3c6d) >>> 0;
    b = Math.imul(b ^ (b >>> 13), 0x297a2d39) >>> 0;
    out += ((a ^ b) >>> 0).toString(16).padStart(8, "0");
  }
  return out;
}
