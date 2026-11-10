// The sending end of the link's streams (DESIGN §6: "Streams are numbered"): one per model call or
// passthrough the runtime asked for, named by the runtime. A stream's text is held back a moment to
// go with what follows it, every chunk is numbered and kept until the runtime acknowledges it, and a
// runtime that reconnects gets what it missed. The bookkeeping itself is src/link/stream.ts, shared
// with the runtime's reading end.

import type { ModelDelta, ModelResult } from "../../core/ports";
import type { ChunkPush, OpenStream, StreamChunk } from "../../link/contract";
import { LINK } from "../../link/contract";
import { StreamSender } from "../../link/stream";

interface Sent {
  userId: string;
  relay: string;
  stream: string;
  /** The turn the call serves, so Lumiverse's Stop ends it; null outside one. */
  turn: string | null;
  sender: StreamSender;
  abort: AbortController;
  /** Text held back to go with what follows it. */
  held: { kind: "content" | "reasoning"; text: string } | null;
  unhold: (() => void) | null;
  coalesceMs: number;
  keepMs: number;
  /** When its terminal chunk was numbered; null while it runs. */
  endedAt: number | null;
}

/** What a call writes its answer to. */
export interface StreamWriter {
  /** Ends when the runtime cancels the stream, or its turn is stopped. */
  signal: AbortSignal;
  delta(delta: ModelDelta): void;
  done(result: ModelResult): void;
  error(message: string, code: string): void;
}

export interface StreamsEnv {
  now(): number;
  /** Runs `fn` once after `ms`; what it returns cancels that. */
  later(ms: number, fn: () => void): () => void;
  /** Pushes a chunk to a runtime's session; false while it has none. */
  push(userId: string, relay: string, push: ChunkPush): boolean;
}

const key = (userId: string, stream: string): string => `${userId}\u0000${stream}`;

export class StreamRegistry {
  private readonly streams = new Map<string, Sent>();

  constructor(private readonly env: StreamsEnv) {}

  /** The streams held now. */
  get size(): number {
    return this.streams.size;
  }

  private emit(sent: Sent, chunk: StreamChunk): void {
    const numbered = sent.sender.push(chunk);
    if (numbered === null) return;
    // With no session to push to, the chunk waits here: the runtime's hello resumes the stream.
    this.env.push(sent.userId, sent.relay, { link: LINK, type: "chunk", stream: sent.stream, seq: numbered.seq, chunk });
  }

  private flush(sent: Sent): void {
    sent.unhold?.();
    sent.unhold = null;
    const held = sent.held;
    sent.held = null;
    if (held !== null) this.emit(sent, held);
  }

  private text(sent: Sent, kind: "content" | "reasoning", text: string): void {
    if (text === "" || sent.endedAt !== null) return;
    // Reasoning and text stay in the order they were written.
    if (sent.held !== null && sent.held.kind !== kind) this.flush(sent);
    sent.held = { kind, text: (sent.held?.text ?? "") + text };
    if (sent.coalesceMs <= 0) this.flush(sent);
    else if (sent.unhold === null)
      sent.unhold = this.env.later(sent.coalesceMs, () => {
        sent.unhold = null;
        this.flush(sent);
      });
  }

  private end(sent: Sent, chunk: StreamChunk): void {
    if (sent.endedAt !== null || this.streams.get(key(sent.userId, sent.stream)) !== sent) return;
    this.flush(sent);
    this.emit(sent, chunk);
    sent.endedAt = this.env.now();
  }

  /**
   * Opens the stream a request named. Null when it is open already: the runtime asked again after a
   * socket that closed under its request, and the call it asked for is the one under way.
   */
  open(userId: string, relay: string, stream: string, turn: string | null, tuning: { coalesceMs: number; keepMs: number }): StreamWriter | null {
    const k = key(userId, stream);
    if (this.streams.has(k)) return null;
    const sent: Sent = { userId, relay, stream, turn, sender: new StreamSender(), abort: new AbortController(), held: null, unhold: null, coalesceMs: tuning.coalesceMs, keepMs: tuning.keepMs, endedAt: null };
    this.streams.set(k, sent);
    return {
      signal: sent.abort.signal,
      delta: (delta) => {
        if (delta.reasoning !== undefined) this.text(sent, "reasoning", delta.reasoning);
        if (delta.content !== undefined) this.text(sent, "content", delta.content);
      },
      done: (result) => this.end(sent, { kind: "done", result }),
      error: (message, code) => this.end(sent, { kind: "error", message, code }),
    };
  }

  private of(userId: string, relay: string, stream: string): Sent | null {
    const sent = this.streams.get(key(userId, stream));
    return sent !== undefined && sent.relay === relay ? sent : null;
  }

  private drop(sent: Sent): void {
    sent.unhold?.();
    sent.unhold = null;
    sent.held = null;
    this.streams.delete(key(sent.userId, sent.stream));
  }

  /** `stream.ack`: the runtime holds every chunk through `seq`. True once the stream is over and forgotten (or was never known: there is nothing left to acknowledge). */
  ack(userId: string, relay: string, stream: string, seq: number): boolean {
    const sent = this.of(userId, relay, stream);
    if (sent === null) return true;
    if (!sent.sender.ack(seq)) return false;
    this.drop(sent);
    return true;
  }

  /** `stream.resend`: pushes the stream's chunks again from `from`. The last chunk held; null when the stream isn't. */
  resend(userId: string, relay: string, stream: string, from: number): number | null {
    const sent = this.of(userId, relay, stream);
    if (sent === null) return null;
    for (const { seq, chunk } of sent.sender.from(from)) this.env.push(userId, relay, { link: LINK, type: "chunk", stream, seq, chunk });
    return sent.sender.last;
  }

  /** `stream.cancel`: the runtime gave the stream up, so its call ends and nothing more is sent. False when the stream wasn't held. */
  cancel(userId: string, relay: string, stream: string, reason: string): boolean {
    const sent = this.of(userId, relay, stream);
    if (sent === null) return false;
    this.drop(sent);
    sent.abort.abort(new Error(reason === "" ? "The runtime cancelled the call." : reason));
    return true;
  }

  /**
   * A runtime said hello, naming the streams it still reads and the last chunk it holds of each: each
   * it names gets its later chunks again, and the ones named that aren't held here are `lost` (the
   * extension started again). A stream of that runtime it didn't name has no reader any more: its
   * call ends.
   */
  resume(userId: string, relay: string, open: readonly OpenStream[]): string[] {
    const lost: string[] = [];
    const named = new Set<string>();
    for (const { stream, seq } of open) {
      named.add(stream);
      const sent = this.of(userId, relay, stream);
      if (sent === null) lost.push(stream);
      else for (const n of sent.sender.from(seq + 1)) this.env.push(userId, relay, { link: LINK, type: "chunk", stream, seq: n.seq, chunk: n.chunk });
    }
    for (const sent of [...this.streams.values()]) {
      if (sent.userId !== userId || sent.relay !== relay || named.has(sent.stream)) continue;
      this.drop(sent);
      sent.abort.abort(new Error("The runtime no longer reads this call's answer."));
    }
    return lost;
  }

  /** Which of the streams a runtime's ping names aren't held here: they end at once at its end. */
  missing(userId: string, relay: string, streams: readonly string[]): string[] {
    return streams.filter((stream) => this.of(userId, relay, stream) === null);
  }

  /** Lumiverse stopped a turn: its calls under way end, each stream with the error its call then gives. How many there were. */
  stopTurn(userId: string, turn: string, why: string): number {
    let n = 0;
    for (const sent of this.streams.values()) {
      if (sent.userId !== userId || sent.turn !== turn || sent.endedAt !== null) continue;
      sent.abort.abort(new Error(why));
      n++;
    }
    return n;
  }

  /** A runtime is gone for good (forgotten): its calls end and its streams are let go. */
  forget(userId: string, relay: string): void {
    for (const sent of [...this.streams.values()]) {
      if (sent.userId !== userId || sent.relay !== relay) continue;
      this.drop(sent);
      sent.abort.abort(new Error("The runtime was forgotten."));
    }
  }

  /** Lets go of the finished streams whose acknowledgement never came. */
  sweep(): void {
    const now = this.env.now();
    for (const sent of [...this.streams.values()]) if (sent.endedAt !== null && now - sent.endedAt > sent.keepMs) this.drop(sent);
  }
}
