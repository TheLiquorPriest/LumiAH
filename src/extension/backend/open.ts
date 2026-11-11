// The turns that are owed something when the extension's worker stops (DESIGN §7): a runtime's
// turn whose record is still to be handed over, and a built-in turn that waits for its reply
// between its two halves. Lumiverse restarts a worker with an update, a reload or its own restart,
// and everything the worker held in memory goes with it. So each such turn is kept in the user's
// storage from the moment something is owed to it, and taken out when that is done:
//
// - a runtime's record is taken only for a turn the backend knows began here, in this worker or
//   the one before it;
// - a built-in turn whose reply was saved while no worker held it still gets its record, and one
//   whose reply never came is let go in words (hosted.ts).

import type { TurnKind } from "../../core/ports";
import { isRecord } from "../../link/json";
import type { NoPart, RunPlace } from "../../shared/ui";
import { UserDocs } from "./docs";
import type { BackendHost } from "./spindle";

/** A turn something is owed to: where its record goes, and what a built-in one's second half needs that only its first half knew. */
export interface OpenTurn {
  /** The turn's id: its generation's. */
  turn: string;
  chatId: string;
  place: RunPlace;
  kind: TurnKind;
  target: { message: string | null; swipe: number };
  /** When it became owed: a runtime's when its tag was spent, a built-in one's when its prompt was handed back. */
  at: number;
  /** Built in, for a continue: what the reply's swipe held before the generation, which isn't the turn's reply. */
  before?: string;
  /** Built in: why LumiAH had no part in the reply, where it had none. */
  noPart?: NoPart;
}

interface Stored {
  v: 1;
  open: Record<string, OpenTurn>;
}

const KINDS: Readonly<Record<string, true>> = { new: true, regenerate: true, swipe: true, continue: true };

function openOf(turn: string, raw: unknown): OpenTurn | null {
  if (!isRecord(raw) || typeof raw.chatId !== "string" || (raw.place !== "builtin" && raw.place !== "runtime") || typeof raw.kind !== "string" || !Object.hasOwn(KINDS, raw.kind) || typeof raw.at !== "number") return null;
  const target = raw.target;
  if (!isRecord(target) || !(target.message === null || typeof target.message === "string") || typeof target.swipe !== "number" || !Number.isSafeInteger(target.swipe) || target.swipe < 0) return null;
  const noPart = raw.noPart;
  const why = isRecord(noPart) ? noPart.why : undefined;
  return {
    turn,
    chatId: raw.chatId,
    place: raw.place,
    kind: raw.kind as TurnKind,
    target: { message: target.message, swipe: target.swipe },
    at: raw.at,
    ...(typeof raw.before === "string" ? { before: raw.before } : {}),
    ...(isRecord(noPart) && (why === "failed" || why === "time" || why === "stopped") && typeof noPart.text === "string" ? { noPart: { why, text: noPart.text } } : {}),
  };
}

function storedOf(raw: unknown): Stored | null {
  if (!isRecord(raw) || raw.v !== 1 || !isRecord(raw.open)) return null;
  const open: Record<string, OpenTurn> = {};
  for (const [turn, value] of Object.entries(raw.open)) {
    const one = openOf(turn, value);
    if (one !== null) open[turn] = one;
  }
  return { v: 1, open };
}

export class OpenTurns {
  private readonly docs: UserDocs<Stored>;

  /**
   * @param kept How many of a user's turns are kept at once, by their own settings: past it the
   * one owed longest is let go, as the turn itself is forgotten in memory past the same number.
   */
  constructor(
    host: Pick<BackendHost, "storage" | "log">,
    private readonly kept: (userId: string) => Promise<number>,
  ) {
    this.docs = new UserDocs<Stored>(host, "turns.json", storedOf, () => ({ v: 1, open: {} }));
  }

  /** Keeps a turn something is now owed to. */
  async put(userId: string, turn: OpenTurn): Promise<void> {
    const most = Math.max(1, await this.kept(userId));
    await this.docs.change(userId, (doc) => {
      // Put last, so the order of the keys is the order they became owed in.
      delete doc.open[turn.turn];
      doc.open[turn.turn] = turn;
      const ids = Object.keys(doc.open);
      for (const id of ids.slice(0, Math.max(0, ids.length - most))) delete doc.open[id];
    });
  }

  /** A turn of the user's that something is owed to; null when there is none by that id. */
  async get(userId: string, turn: string): Promise<OpenTurn | null> {
    const held = (await this.docs.get(userId)).open;
    return Object.hasOwn(held, turn) ? (held[turn] ?? null) : null;
  }

  /** Every turn of the user's something is owed to, the one owed longest first. */
  async list(userId: string): Promise<OpenTurn[]> {
    return Object.values((await this.docs.get(userId)).open);
  }

  /** What was owed to a turn is done, or never will be: it is kept no longer. Nothing is written for a turn that wasn't kept. */
  async drop(userId: string, turn: string): Promise<void> {
    if (!Object.hasOwn((await this.docs.get(userId)).open, turn)) return;
    await this.docs.change(userId, (doc) => {
      delete doc.open[turn];
    });
  }

  /** Resolves once every write is done (tests). */
  settle(): Promise<void> {
    return this.docs.settle();
  }
}
