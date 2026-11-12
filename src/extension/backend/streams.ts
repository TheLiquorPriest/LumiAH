// The sending end of the link's streams (DESIGN §6: "Streams are numbered"): one per tool that runs
// here or tool call held for the user's word that the runtime asked for, named by the runtime. Its
// one chunk, the outcome, is numbered and kept until the runtime acknowledges it, and a runtime that
// reconnects gets it again. The bookkeeping itself is src/link/stream.ts.

import type { JsonValue } from "../../core/ports";
import type { ChunkPush, OpenStream, StreamChunk } from "../../link/contract";
import { LINK } from "../../link/contract";
import { CEILINGS } from "../../link/settings";
import { StreamSender } from "../../link/stream";
import { LinkRefused } from "./errors";

interface Sent {
  userId: string;
  relay: string;
  stream: string;
  /** The turn the call serves, so Lumiverse's Stop ends it; null outside one. */
  turn: string | null;
  sender: StreamSender;
  abort: AbortController;
  keepMs: number;
  /** When its chunk was numbered; null while it runs. */
  endedAt: number | null;
}

/** What a call writes its outcome to: a tool's run in the extension, the user's word on a held call (`value`), or its failure (`error`). */
export interface StreamWriter {
  /** Ends when the runtime cancels the stream, or its turn is stopped. */
  signal: AbortSignal;
  value(value: JsonValue): void;
  error(message: string, code: string): void;
}

export interface StreamsEnv {
  now(): number;
  /** Pushes a chunk to a runtime's session; false while it has none. */
  push(userId: string, relay: string, push: ChunkPush): boolean;
}

const key = (userId: string, stream: string): string => `${userId}\u0000${stream}`;

export class StreamRegistry {
  private readonly streams = new Map<string, Sent>();
  /** How many of them each account has: an account with none has no entry. */
  private readonly held = new Map<string, number>();

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

  private end(sent: Sent, chunk: StreamChunk): void {
    if (sent.endedAt !== null || this.streams.get(key(sent.userId, sent.stream)) !== sent) return;
    this.emit(sent, chunk);
    sent.endedAt = this.env.now();
  }

  /**
   * Opens the stream a request named. Null when it is open already: the runtime asked again after a
   * socket that closed under its request, and the call it asked for is the one under way.
   *
   * A stream is held until its runtime acknowledges its end, so what a runtime opens and never
   * acknowledges adds up in the worker every account shares. Past what one account may have held,
   * or all of them together, the request is refused aloud: a null here would tell its caller the
   * call is under way, and the runtime would wait for an answer nothing is writing.
   */
  open(userId: string, relay: string, stream: string, turn: string | null, tuning: { keepMs: number }): StreamWriter | null {
    const k = key(userId, stream);
    if (this.streams.has(k)) return null;
    const own = this.held.get(userId) ?? 0;
    if (own >= CEILINGS.streams) throw new LinkRefused("unavailable", `This account already has ${own} calls on LumiAH's link that are under way or whose answers its runtimes haven't acknowledged, the most one account may have at once. Try again once some have ended.`);
    if (this.streams.size >= CEILINGS.streamsTotal) throw new LinkRefused("unavailable", "LumiAH is busy: its link holds as many calls' answers as it does at once, for every account together. Try again in a moment.");
    const sent: Sent = { userId, relay, stream, turn, sender: new StreamSender(), abort: new AbortController(), keepMs: Math.min(tuning.keepMs, CEILINGS.streamKeepMs), endedAt: null };
    this.streams.set(k, sent);
    this.held.set(userId, own + 1);
    return {
      signal: sent.abort.signal,
      value: (value) => this.end(sent, { kind: "value", value }),
      error: (message, code) => this.end(sent, { kind: "error", message, code }),
    };
  }

  private of(userId: string, relay: string, stream: string): Sent | null {
    const sent = this.streams.get(key(userId, stream));
    return sent !== undefined && sent.relay === relay ? sent : null;
  }

  private drop(sent: Sent): void {
    if (!this.streams.delete(key(sent.userId, sent.stream))) return;
    const left = (this.held.get(sent.userId) ?? 1) - 1;
    if (left > 0) this.held.set(sent.userId, left);
    else this.held.delete(sent.userId);
  }

  /** `stream.ack`: the runtime holds every chunk through `seq`. True once the stream is over and forgotten (or was never known: there is nothing left to acknowledge). */
  ack(userId: string, relay: string, stream: string, seq: number): boolean {
    const sent = this.of(userId, relay, stream);
    if (sent === null) return true;
    if (!sent.sender.ack(seq)) return false;
    this.drop(sent);
    return true;
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
