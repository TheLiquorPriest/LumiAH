// A frame too large for Lumiverse's socket crosses in parts (DESIGN §6: the envelope is the link's).
// Lumiverse closes a client's socket on a frame over 4 MiB and may close a slow one it sends more
// to, and a blob (a transcript, a call's exact prompt) or a model call's request can be larger. The
// sender cuts the frame's text into `part` frames under one id; the receiver joins them in order and
// reads the whole as the frame it was. Both ends use this file, so they cut and join alike.

import type { PartFrame } from "./contract";
import { FRAME_LIMIT, LINK } from "./contract";
import { isRecord } from "./json";

/**
 * How many UTF-16 units of a frame's text one part carries. As a JSON string each unit is at most 6
 * bytes (a lone surrogate's escape), so a part never passes FRAME_LIMIT whatever its text holds; it
 * follows from Lumiverse's limit, so it can't be a setting.
 */
export const PART_UNITS = 512 * 1024;

/** What a part frame adds around its piece: the envelope's own fields, and whatever wraps the frame on its way (the socket frame's `type` and `extensionId`). */
const ENVELOPE_BYTES = 1024;

const encoder = new TextEncoder();

/** Whether a frame's text must cross in parts: only a long one is measured, since a UTF-16 unit is at most 3 bytes of UTF-8. */
export function needsParts(text: string): boolean {
  if (text.length * 3 + ENVELOPE_BYTES <= FRAME_LIMIT) return false;
  return encoder.encode(text).length + ENVELOPE_BYTES > FRAME_LIMIT;
}

/** A frame's text as the part frames that carry it, in order, under `id` (unique among the sender's frames in flight). */
export function splitFrame(text: string, id: string): PartFrame[] {
  const count = Math.max(1, Math.ceil(text.length / PART_UNITS));
  const parts: PartFrame[] = [];
  for (let index = 0; index < count; index++) parts.push({ link: LINK, type: "part", id, index, count, data: text.slice(index * PART_UNITS, (index + 1) * PART_UNITS) });
  return parts;
}

/** A part frame as it crossed, checked; null when it isn't one. */
export function partOf(raw: unknown): PartFrame | null {
  if (!isRecord(raw) || raw.link !== LINK || raw.type !== "part") return null;
  const { id, index, count, data } = raw;
  if (typeof id !== "string" || id === "" || typeof data !== "string") return null;
  if (typeof index !== "number" || typeof count !== "number" || !Number.isSafeInteger(index) || !Number.isSafeInteger(count) || count < 1 || index < 0 || index >= count) return null;
  return { link: LINK, type: "part", id, index, count, data };
}

export interface JoinLimits {
  /** The most UTF-16 units of one frame the joiner puts together: a larger one is refused. */
  maxUnits: number;
  /** How long a frame's first parts wait for the rest before they are let go. */
  staleMs: number;
  /** The most frames it puts together at once: one begun past it is refused. Absent: as many as come. */
  maxFrames?: number;
  /** The most UTF-16 units it holds of the frames it is putting together: the frame whose part passes it is refused. Absent: as many as come. */
  maxHeldUnits?: number;
  /**
   * Where several joiners share one bound (the extension's, over every account's joiner): the frames
   * this one may have under way, and the units it may hold, before what the others have fills that
   * bound. A frame refused for these is refused `over: "shared"`: no limit of this joiner's own was
   * passed, so its sender has nothing to raise and only to send again. Absent: nothing is shared.
   */
  shared?: { frames: number; units: number };
}

interface Group {
  /** Whose frame it is, where one joiner takes several senders' frames. */
  from: string;
  count: number;
  pieces: (string | undefined)[];
  got: number;
  units: number;
  at: number;
}

/**
 * What `take` did with a part: the whole frame's text once its last part came, nothing yet, or why
 * the frame is refused. `id` is the parts' id, to answer by; `over` is the limit it passed (one
 * frame's size, the frames under way, or what they hold together), so each end can say which of its
 * own settings that is; `shared` is the bound several joiners share, which is nobody's setting.
 */
export type Joined = { text: string } | { waiting: true } | { refused: string; id: string; over: "frame" | "frames" | "held" | "shared" };

/** A count of UTF-16 units as the refusals say it. */
const millions = (units: number): string => (units / 1048576).toFixed(0);

/**
 * Joins the parts of the frames its peers send. A frame whose parts stop coming (its socket closed
 * under it) is let go after `staleMs`. One larger than `maxUnits` is refused as its parts arrive, and
 * so is one that would have the joiner put together more than `maxFrames` frames or hold more than
 * `maxHeldUnits`: what a peer can make this end hold is what its limits say, and no more.
 */
export class PartJoiner {
  private readonly groups = new Map<string, Group>();
  private units = 0;

  constructor(private readonly limits: () => JoinLimits) {}

  /** The frames it is still putting together. */
  get waiting(): number {
    return this.groups.size;
  }

  /** The UTF-16 units it holds of them. */
  get held(): number {
    return this.units;
  }

  /** `from` says whose frame the part belongs to, where one joiner takes the frames of several senders: two senders' frames under one id stay apart. */
  take(part: PartFrame, now: number, from = ""): Joined {
    const { maxUnits, maxFrames, maxHeldUnits, shared } = this.limits();
    this.purge(now);
    const key = `${from}\u0000${part.id}`;
    const tooLarge = (): Joined => {
      this.drop(key);
      return { refused: `That frame is over ${millions(maxUnits)} million characters, the most LumiAH's link puts together.`, id: part.id, over: "frame" };
    };
    if (part.count * PART_UNITS - PART_UNITS >= maxUnits) return tooLarge();
    let group = this.groups.get(key);
    if (group === undefined || group.count !== part.count) {
      this.drop(key);
      if (maxFrames !== undefined && this.groups.size >= maxFrames) return { refused: `LumiAH's link is already putting together ${this.groups.size} frames that came in parts, the most it does at once.`, id: part.id, over: "frames" };
      if (shared !== undefined && this.groups.size >= shared.frames) return { refused: "LumiAH is busy: its link is putting together as many frames that came in parts as it does at once, for every account together.", id: part.id, over: "shared" };
      group = { from, count: part.count, pieces: new Array<string | undefined>(part.count), got: 0, units: 0, at: now };
      this.groups.set(key, group);
    }
    if (group.pieces[part.index] === undefined) {
      group.pieces[part.index] = part.data;
      group.got++;
      group.units += part.data.length;
      this.units += part.data.length;
    }
    if (group.units > maxUnits) return tooLarge();
    if (maxHeldUnits !== undefined && this.units > maxHeldUnits) {
      this.drop(key);
      return { refused: `That frame would have LumiAH's link hold over ${millions(maxHeldUnits)} million characters of frames that come in parts, the most it holds at once.`, id: part.id, over: "held" };
    }
    if (shared !== undefined && this.units > shared.units) {
      this.drop(key);
      return { refused: "LumiAH is busy: its link holds as much as it does at once of frames that come in parts, for every account together.", id: part.id, over: "shared" };
    }
    if (group.got < group.count) return { waiting: true };
    this.drop(key);
    return { text: group.pieces.join("") };
  }

  /** Lets go of every frame whose first part has waited longer than `staleMs` for the rest. */
  purge(now: number): void {
    const { staleMs } = this.limits();
    for (const [key, group] of this.groups) if (now - group.at > staleMs) this.drop(key);
  }

  /** Lets go of every frame half put together (the peer's socket closed); with `from`, of that sender's alone. */
  clear(from?: string): void {
    for (const [key, group] of this.groups) if (from === undefined || group.from === from) this.drop(key);
  }

  private drop(key: string): void {
    const group = this.groups.get(key);
    if (group === undefined) return;
    this.groups.delete(key);
    this.units -= group.units;
  }
}
