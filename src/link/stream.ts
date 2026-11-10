// A stream's bookkeeping at both ends (DESIGN §6: "Streams are numbered"). The sender numbers a
// stream's chunks from 1 and keeps each until the receiver acknowledges it, so it can give them again
// from any point. The receiver hands chunks on in order whatever order they came in, counts one that
// came twice once, says which chunk is missing after a gap, and says when to acknowledge: every
// `ackEvery` chunks, and always the terminal one. Neither holds a timer or sends anything itself: the
// extension's stream registry and the runtime's reader do that around them.

import type { StreamChunk } from "./contract";
import { terminal } from "./contract";

/** A chunk with its place in its stream. */
export interface Numbered {
  seq: number;
  chunk: StreamChunk;
}

/** The sending end of one stream. */
export class StreamSender {
  private readonly held = new Map<number, StreamChunk>();
  private count = 0;
  private finished = false;

  /** The seq of the last chunk it numbered; 0 before any. */
  get last(): number {
    return this.count;
  }

  /** Whether its terminal chunk has been numbered: nothing more is taken. */
  get done(): boolean {
    return this.finished;
  }

  /** How many chunks it still keeps for a resend. */
  get kept(): number {
    return this.held.size;
  }

  /** Numbers a chunk and keeps it; null once the stream has ended, since nothing follows a terminal chunk. */
  push(chunk: StreamChunk): Numbered | null {
    if (this.finished) return null;
    const seq = ++this.count;
    this.held.set(seq, chunk);
    if (terminal(chunk)) this.finished = true;
    return { seq, chunk };
  }

  /** The chunks it keeps from `from` on, in order: what a resend, or a resume after a reconnect, sends again. */
  from(from: number): Numbered[] {
    const out: Numbered[] = [];
    for (let seq = Math.max(1, from); seq <= this.count; seq++) {
      const chunk = this.held.get(seq);
      if (chunk !== undefined) out.push({ seq, chunk });
    }
    return out;
  }

  /** The receiver holds every chunk through `seq`: they are let go. True once the stream is over and its terminal chunk is among them, so the stream can be forgotten. */
  ack(seq: number): boolean {
    for (const held of [...this.held.keys()]) if (held <= seq) this.held.delete(held);
    return this.finished && seq >= this.count;
  }
}

/** What a receiver did with a chunk: the chunks now in order (none while it waits on a gap), the first chunk still missing (null when none is), and the seq to acknowledge now (null when not yet). */
export interface Received {
  deliver: StreamChunk[];
  missing: number | null;
  ack: number | null;
}

/** The receiving end of one stream. */
export class StreamReceiver {
  private next = 1;
  private readonly ahead = new Map<number, StreamChunk>();
  private sinceAck = 0;
  private finished = false;

  /** The last chunk it holds in order; 0 before any. A resume asks for the one after it. */
  get seq(): number {
    return this.next - 1;
  }

  /** Whether its terminal chunk was delivered: whatever comes after is dropped. */
  get ended(): boolean {
    return this.finished;
  }

  /** The first chunk it is missing while later ones wait; null when it waits on none. */
  get missing(): number | null {
    return this.ahead.size > 0 ? this.next : null;
  }

  /** Takes a chunk as it came. `ackEvery`: how many chunks go by between acknowledgements while the stream runs. */
  take(seq: number, chunk: StreamChunk, ackEvery: number): Received {
    const out: Received = { deliver: [], missing: null, ack: null };
    // One that came already, in order or ahead: counted once.
    if (this.finished || seq < this.next || this.ahead.has(seq)) {
      out.missing = this.missing;
      return out;
    }
    this.ahead.set(seq, chunk);
    for (let held = this.ahead.get(this.next); held !== undefined; held = this.ahead.get(this.next)) {
      this.ahead.delete(this.next);
      this.next++;
      out.deliver.push(held);
      if (terminal(held)) {
        this.finished = true;
        this.ahead.clear();
        out.ack = this.next - 1;
        return out;
      }
      if (++this.sinceAck >= ackEvery) {
        this.sinceAck = 0;
        out.ack = this.next - 1;
      }
    }
    out.missing = this.missing;
    return out;
  }
}
