// A stream's bookkeeping at the extension's end (DESIGN §6: "Streams are numbered"). A stream carries
// one chunk, its outcome (`value` or `error`), numbered 1 and kept until the runtime acknowledges
// it, so a runtime that reconnected is sent it again. It holds no timer and sends nothing itself: the
// extension's stream registry does that around it. The runtime's reading end (runtime/streams.ts)
// keeps nothing of the kind: a stream's chunk ends it there, and one that comes again finds it gone.

import type { StreamChunk } from "./contract";

/** A chunk with its place in its stream. */
export interface Numbered {
  seq: number;
  chunk: StreamChunk;
}

/** The sending end of one stream. */
export class StreamSender {
  private held: StreamChunk | null = null;
  private finished = false;

  /** Numbers the stream's chunk and keeps it; null once it has one, since a stream carries one. */
  push(chunk: StreamChunk): Numbered | null {
    if (this.finished) return null;
    this.finished = true;
    this.held = chunk;
    return { seq: 1, chunk };
  }

  /** The chunk it keeps from `from` on: what a resume after a reconnect sends again. */
  from(from: number): Numbered[] {
    return this.held !== null && from <= 1 ? [{ seq: 1, chunk: this.held }] : [];
  }

  /** The runtime holds every chunk through `seq`: true once that takes in the stream's chunk, which is let go, so the stream can be forgotten. */
  ack(seq: number): boolean {
    if (!this.finished || seq < 1) return false;
    this.held = null;
    return true;
  }
}
