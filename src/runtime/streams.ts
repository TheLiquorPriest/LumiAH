// The streams the runtime reads from the extension (DESIGN §6): each tool that runs in the extension
// and each tool call held for the user's word is answered on one. A stream is named before its
// request goes out, so no chunk can come for one the runtime doesn't know. It carries one chunk, its
// outcome, which goes to its reader at once and is acknowledged, so the extension can let it go; one
// that comes again (a resume sends it again) finds the stream gone. `tick()` (every second) gives up
// a stream that stalled, or whose extension stayed out of reach too long, with words a person can act
// on, so a hung or restarted extension never leaves a call hanging.

import type { ChunkPush, OpenStream, StreamChunk } from "../link/contract";
import { OWN_BACKEND } from "../link/contract";
import type { RuntimeTuning } from "../link/settings";
import { spanWords, transportWait } from "../link/waits";
import { LinkError } from "./connection";
import type { RuntimeLink } from "./link";
import { LOST_WAIT, stoppedWords } from "./link";
import { LiveError, WaitError } from "./lumiverse";

/** Who reads a stream: its one chunk, its outcome; nothing follows it. */
export interface StreamReader {
  chunk(chunk: StreamChunk): void;
}

interface Stream {
  id: string;
  reader: StreamReader;
  /** Its start request, from sending to its answer (or failure). */
  started: Promise<boolean>;
  /** The extension answered its start: only then is it the extension's to resume after a reconnect. */
  begun: boolean;
  /** When the extension last said anything of it. */
  heard: number;
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

/** A failure's words and code: the extension's own (`error` frames), the link's, or the runtime's; a wait that ran out (`WaitError`) in its own words, which name its setting and where it is changed. `name`: the extension the runtime links to, as the words name it. */
export function problemOf(error: unknown, name = "LumiAH"): { message: string; code: string } {
  if (error instanceof LinkError) return { message: error.message, code: error.code };
  if (error instanceof LiveError) {
    if (error.problem === "login") return { message: `The runtime's Lumiverse session has ended, so it can't reach ${name}. Sign it in again on the machine it runs on: lumiah login (${name}'s Runtime page shows the line).`, code: "login" };
    if (error.problem === "timeout") return { message: error instanceof WaitError ? error.message : `${name} didn't answer the runtime in time: it may be restarting or busy. Press Retry in a moment.`, code: "timeout" };
    return { message: `The runtime couldn't reach ${name}: ${error.message}`, code: error.problem === "forbidden" ? "unreachable" : error.problem };
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

  /** The streams to resume after a reconnect, each holding no chunk yet (its chunk ends it). One whose start is still unanswered is sent again instead. */
  open(): OpenStream[] {
    return [...this.streams.values()].filter((s) => s.begun).map((s) => ({ stream: s.id, seq: 0 }));
  }

  /**
   * Starts a stream: `send` asks the extension for it, and is asked again after a socket that closed
   * under it (the extension takes a stream's start once, so a second is answered as the first), until
   * it is answered or the extension has been out of reach for `lostMs`.
   */
  start(id: string, reader: StreamReader, send: () => Promise<unknown>, patient = false): void {
    const now = this.env.now();
    const stream: Stream = { id, reader, started: Promise.resolve(false), begun: false, heard: now, at: now, ended: false, patient };
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
          this.end(stream, problemOf(error, this.link.backendName), false);
          return false;
        }
      }
    };
    stream.started = run();
  }

  /** A stream's chunk: it ends the stream, goes to its reader, and is acknowledged, so the extension can let it go. One that came again finds the stream gone. */
  chunk(push: ChunkPush): void {
    const stream = this.streams.get(push.stream);
    if (stream === undefined || stream.ended) return;
    stream.ended = true;
    this.streams.delete(stream.id);
    stream.reader.chunk(push.chunk);
    void this.link.request("stream.ack", { stream: stream.id, seq: push.seq }, 0).catch(() => undefined);
  }

  /** The extension no longer holds these streams: it restarted mid-call, with the socket up or not. */
  lost(ids: readonly string[]): void {
    for (const id of ids) {
      const stream = this.streams.get(id);
      if (stream) this.end(stream, { message: `${this.link.backendName ?? "LumiAH"} restarted during this call, so it stopped here. Press Retry, or swipe.`, code: "lost" }, false);
    }
  }

  /** Lumiverse stopped the extension, or it crashed: every stream ends at once, with nothing to cancel. */
  stopped(why: "stopped" | "crashed", detail: string | null): void {
    for (const stream of [...this.streams.values()]) this.end(stream, { message: stoppedWords(why, detail, this.link.backendName), code: "unavailable" }, false);
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
   * Every second: give up what stalled, or what the extension stayed out of reach for (its link down,
   * or the extension silent), each stream getting the whole allowance from when it started, however
   * long the extension was out before.
   */
  tick(): void {
    const now = this.env.now();
    const tuning = this.env.tuning();
    const out = this.link.out;
    const refused = this.link.refused;
    for (const stream of [...this.streams.values()]) {
      if (stream.ended) continue;
      if (refused !== null) {
        this.end(stream, { message: `The runtime can't reach ${this.link.backendName ?? "LumiAH"}: ${refused}`, code: "revoked" }, false);
        continue;
      }
      if (out !== null && now - Math.max(out.since, stream.at) >= tuning.lostMs) {
        const seconds = Math.round((now - Math.max(out.since, stream.at)) / 1000);
        const waited = `${transportWait(LOST_WAIT, this.link.owner ?? OWN_BACKEND)} says how long the runtime waits for it.`;
        const problem =
          out.why === "silent"
            ? { message: `${this.link.backendName ?? "LumiAH"} stopped answering the runtime during this call (nothing for ${seconds} s): it may have restarted or hung. Press Retry, or swipe. ${waited}`, code: "stalled" }
            : out.why === "down"
              ? { message: `The runtime lost its connection to Lumiverse for ${seconds} s during this call. Press Retry once it is back (lumiah status says how it is). ${waited}`, code: "lost" }
              : { message: `${stoppedWords(out.why, out.detail, this.link.backendName)} ${waited}`, code: "unavailable" };
        // A stopped or crashed extension has nothing to cancel.
        this.end(stream, problem, out.why === "silent" || out.why === "down");
        continue;
      }
      if (out === null && !stream.patient && now - stream.heard >= tuning.stallMs) {
        const words = `${this.link.backendName ?? "LumiAH"} sent nothing for this call in ${spanWords(tuning.stallMs)}, so the runtime gave it up. Press Retry. ${transportWait(["runtime", "stallMs"], this.link.owner ?? OWN_BACKEND)} says how long the runtime waits for a call that sends nothing.`;
        this.end(stream, { message: words, code: "stalled" }, true);
      }
    }
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
        if (started) return this.link.request("stream.cancel", { stream: stream.id, reason }, this.env.tuning().lostMs, LOST_WAIT);
      })
      .catch((error: unknown) => this.env.log(`the cancel of stream ${stream.id.slice(0, 8)} wasn't delivered: ${error instanceof Error ? error.message : String(error)}`));
  }
}
