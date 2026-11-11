// The streams the runtime reads from the extension (DESIGN §6): each model call's answer and each
// passthrough's. A stream is named before its request goes out, so no chunk can come for one the
// runtime doesn't know. Its chunks arrive numbered from 1: in order they go to its reader at once;
// ahead of a gap they wait, and the gap is asked for again; one that came twice counts once
// (src/link/stream.ts keeps that count). The terminal chunk is always acknowledged, and every
// `ackEvery` chunks are while it runs, so the extension can let go of them. `tick()` (every second)
// asks again after a gap, and gives up a stream that stalled, or whose extension stayed out of reach
// too long, with words a person can act on, so a hung or restarted extension never leaves a call
// hanging.

import type { ChunkPush, OpenStream, StreamChunk } from "../link/contract";
import type { RuntimeTuning } from "../link/settings";
import { StreamReceiver } from "../link/stream";
import { LinkError } from "./connection";
import type { RuntimeLink } from "./link";
import { stoppedWords } from "./link";
import { LiveError } from "./lumiverse";

/** Who reads a stream: its chunks in order, the terminal one last; nothing follows it. */
export interface StreamReader {
  chunk(chunk: StreamChunk): void;
}

interface Stream {
  id: string;
  reader: StreamReader;
  receiver: StreamReceiver;
  /** Its start request, from sending to its answer (or failure). */
  started: Promise<boolean>;
  /** The extension answered its start: only then is it the extension's to resume after a reconnect. */
  begun: boolean;
  /** When the extension last said anything of it. */
  heard: number;
  gap: { asked: number; tries: number } | null;
  /** When it started. */
  at: number;
  ended: boolean;
  /** It waits on a person (a tool call held for the user's word), so silence isn't a stall: only the extension out of reach, or no longer holding it, ends it. */
  patient: boolean;
}

export interface StreamsEnv {
  now(): number;
  log(text: string): void;
  tuning(): RuntimeTuning;
}

/** A failure's words and code: the extension's own (`error` frames), the link's, or the runtime's. */
export function problemOf(error: unknown): { message: string; code: string } {
  if (error instanceof LinkError) return { message: error.message, code: error.code };
  if (error instanceof LiveError) {
    if (error.problem === "login") return { message: "The runtime's Lumiverse session has ended, so it can't reach LumiAH. Sign it in again on the machine it runs on: lumiah login (LumiAH's Runtime page shows the line).", code: "login" };
    if (error.problem === "timeout") return { message: "LumiAH didn't answer the runtime in time: it may be restarting or busy. Press Retry in a moment.", code: "timeout" };
    return { message: `The runtime couldn't reach LumiAH: ${error.message}`, code: error.problem === "forbidden" ? "unreachable" : error.problem };
  }
  return { message: error instanceof Error ? error.message : String(error), code: "internal" };
}

export class Streams {
  private readonly streams = new Map<string, Stream>();

  constructor(
    private readonly link: RuntimeLink,
    private readonly env: StreamsEnv,
  ) {}

  /** The streams under way. */
  get count(): number {
    return this.streams.size;
  }

  /** The streams to resume after a reconnect, with the last chunk each holds in order. One whose start is still unanswered is sent again instead. */
  open(): OpenStream[] {
    return [...this.streams.values()].filter((s) => s.begun).map((s) => ({ stream: s.id, seq: s.receiver.seq }));
  }

  /**
   * Starts a stream: `send` asks the extension for it, and is asked again after a socket that closed
   * under it (the extension takes a stream's start once, so a second is answered as the first), until
   * it is answered or the extension has been out of reach for `lostMs`.
   */
  start(id: string, reader: StreamReader, send: () => Promise<unknown>, patient = false): void {
    const now = this.env.now();
    const stream: Stream = { id, reader, receiver: new StreamReceiver(), started: Promise.resolve(false), begun: false, heard: now, gap: null, at: now, ended: false, patient };
    this.streams.set(id, stream);
    const run = async (): Promise<boolean> => {
      const first = this.env.now();
      for (;;) {
        try {
          await send();
          stream.heard = this.env.now();
          stream.begun = true;
          return true;
        } catch (error) {
          // A socket that closed under the request may or may not have delivered it: the start is taken once per stream, so it goes again.
          if (error instanceof LiveError && error.problem === "closed" && !stream.ended && this.env.now() - first < this.env.tuning().lostMs) continue;
          this.end(stream, problemOf(error), false);
          return false;
        }
      }
    };
    stream.started = run();
  }

  /** A chunk of a stream: in order it goes out at once; ahead of a gap it waits, and the gap is asked for. */
  chunk(push: ChunkPush): void {
    const stream = this.streams.get(push.stream);
    if (stream === undefined || stream.ended) return;
    stream.heard = this.env.now();
    const got = stream.receiver.take(push.seq, push.chunk, this.env.tuning().ackEvery);
    for (const chunk of got.deliver) {
      if (stream.receiver.ended && chunk === got.deliver.at(-1)) {
        stream.ended = true;
        this.streams.delete(stream.id);
      }
      stream.reader.chunk(chunk);
    }
    if (got.ack !== null) void this.link.request("stream.ack", { stream: stream.id, seq: got.ack }, 0).catch(() => undefined);
    if (stream.ended) return;
    if (got.missing === null) stream.gap = null;
    else if (stream.gap === null) this.askAgain(stream);
  }

  /** The extension no longer holds these streams: it restarted mid-call, with the socket up or not. */
  lost(ids: readonly string[]): void {
    for (const id of ids) {
      const stream = this.streams.get(id);
      if (stream) this.end(stream, { message: "LumiAH restarted during this call, so it stopped here. Press Retry, or swipe.", code: "lost" }, false);
    }
  }

  /** Lumiverse stopped the extension, or it crashed: every stream ends at once, with nothing to cancel. */
  stopped(why: "stopped" | "crashed", detail: string | null): void {
    for (const stream of [...this.streams.values()]) this.end(stream, { message: stoppedWords(why, detail), code: "unavailable" }, false);
  }

  /** The runtime is stopping: every stream ends with words the chat shows. */
  shutdown(): void {
    for (const stream of [...this.streams.values()]) this.end(stream, { message: "The runtime is restarting. Press Retry in a moment.", code: "unavailable" }, true);
  }

  /** The stream's reader gave it up (its call was cancelled): nothing more reaches the reader, and the extension is told once its start was answered. */
  cancel(id: string, reason: string): void {
    const stream = this.streams.get(id);
    if (stream === undefined || stream.ended) return;
    stream.ended = true;
    this.streams.delete(id);
    this.tell(stream, reason);
  }

  /**
   * Every second: ask again after a gap, and give up what stalled, or what the extension stayed out of
   * reach for (its link down, or the extension silent), each stream getting the whole allowance from
   * when it started, however long the extension was out before.
   */
  tick(): void {
    const now = this.env.now();
    const tuning = this.env.tuning();
    const up = this.link.up;
    const out = this.link.out;
    const refused = this.link.refused;
    for (const stream of [...this.streams.values()]) {
      if (stream.ended) continue;
      if (refused !== null) {
        this.end(stream, { message: `The runtime can't reach LumiAH: ${refused}`, code: "revoked" }, false);
        continue;
      }
      if (out !== null && now - Math.max(out.since, stream.at) >= tuning.lostMs) {
        const seconds = Math.round((now - Math.max(out.since, stream.at)) / 1000);
        const problem =
          out.why === "silent"
            ? { message: `LumiAH stopped answering the runtime during this call (nothing for ${seconds} s): it may have restarted or hung. Press Retry, or swipe.`, code: "stalled" }
            : out.why === "down"
              ? { message: `The runtime lost its connection to Lumiverse for ${seconds} s during this call. Press Retry once it is back (lumiah status says how it is).`, code: "lost" }
              : { message: stoppedWords(out.why, out.detail), code: "unavailable" };
        // A stopped or crashed extension has nothing to cancel.
        this.end(stream, problem, out.why === "silent" || out.why === "down");
        continue;
      }
      if (up && stream.gap !== null && now - stream.gap.asked >= tuning.resendMs) {
        if (stream.gap.tries >= tuning.resendTries) {
          this.end(stream, { message: `Part of this answer never reached the runtime (chunk ${stream.receiver.seq + 1} is missing). Press Retry.`, code: "lost" }, true);
          continue;
        }
        this.askAgain(stream);
      }
      if (out === null && !stream.patient && now - stream.heard >= tuning.stallMs) this.end(stream, { message: `LumiAH sent nothing for this call in ${Math.round(tuning.stallMs / 60_000)} minutes, so the runtime gave it up. Press Retry.`, code: "stalled" }, true);
    }
  }

  private askAgain(stream: Stream): void {
    stream.gap = { asked: this.env.now(), tries: (stream.gap?.tries ?? 0) + 1 };
    void this.link.request("stream.resend", { stream: stream.id, from: stream.receiver.seq + 1 }, 0).catch(() => undefined);
  }

  /** Ends a stream on the runtime's side: its words to its reader, and the extension told (`cancel`) once its start was answered. */
  private end(stream: Stream, problem: { message: string; code: string }, cancel: boolean): void {
    if (stream.ended) return;
    stream.ended = true;
    this.streams.delete(stream.id);
    stream.reader.chunk({ kind: "error", message: problem.message, code: problem.code });
    if (cancel) this.tell(stream, problem.code);
  }

  /** Told after the stream's start was answered, so a cancel never overtakes its start. */
  private tell(stream: Stream, reason: string): void {
    void stream.started
      .then((started) => {
        if (started) return this.link.request("stream.cancel", { stream: stream.id, reason }, this.env.tuning().lostMs);
      })
      .catch((error: unknown) => this.env.log(`the cancel of stream ${stream.id.slice(0, 8)} wasn't delivered: ${error instanceof Error ? error.message : String(error)}`));
  }
}
