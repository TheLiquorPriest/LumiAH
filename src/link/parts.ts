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
}

interface Group {
  count: number;
  pieces: (string | undefined)[];
  got: number;
  units: number;
  at: number;
}

/** What `take` did with a part: the whole frame's text once its last part came, nothing yet, or why the frame is refused (`id` is the parts' id, to answer by). */
export type Joined = { text: string } | { waiting: true } | { refused: string; id: string };

/**
 * Joins the parts of the frames one peer sends. A frame whose parts stop coming (its socket closed
 * under it) is let go after `staleMs`; one larger than `maxUnits` is refused as its parts arrive, so
 * a peer can't make this end hold more than that.
 */
export class PartJoiner {
  private readonly groups = new Map<string, Group>();

  constructor(private readonly limits: () => JoinLimits) {}

  /** The frames it is still putting together. */
  get waiting(): number {
    return this.groups.size;
  }

  take(part: PartFrame, now: number): Joined {
    const { maxUnits, staleMs } = this.limits();
    for (const [id, g] of this.groups) if (now - g.at > staleMs) this.groups.delete(id);
    if (part.count * PART_UNITS - PART_UNITS >= maxUnits) {
      this.groups.delete(part.id);
      return { refused: `That frame is over ${(maxUnits / 1048576).toFixed(0)} million characters, the most LumiAH's link puts together.`, id: part.id };
    }
    let group = this.groups.get(part.id);
    if (group === undefined || group.count !== part.count) {
      group = { count: part.count, pieces: new Array<string | undefined>(part.count), got: 0, units: 0, at: now };
      this.groups.set(part.id, group);
    }
    if (group.pieces[part.index] === undefined) {
      group.pieces[part.index] = part.data;
      group.got++;
      group.units += part.data.length;
    }
    if (group.units > maxUnits) {
      this.groups.delete(part.id);
      return { refused: `That frame is over ${(maxUnits / 1048576).toFixed(0)} million characters, the most LumiAH's link puts together.`, id: part.id };
    }
    if (group.got < group.count) return { waiting: true };
    this.groups.delete(part.id);
    return { text: group.pieces.join("") };
  }

  /** Lets go of every frame half put together (the peer's socket closed). */
  clear(): void {
    this.groups.clear();
  }
}
