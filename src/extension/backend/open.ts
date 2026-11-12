// The turns that are owed something when the extension's worker stops (DESIGN §7): a runtime's
// turn whose record is still to be handed over. Lumiverse restarts a worker with an update, a reload
// or its own restart, and everything the worker held in memory goes with it. So each such turn is
// kept in the user's storage from the moment its tag is spent, and taken out when its record is in
// hand: a runtime's record is taken only for a turn the backend knows began here, in this worker or
// the one before it. A turn kept by a build that could run a chat inside Lumiverse (LumiAH's `main`
// branch) reads as any other, and is let go once its tag's life is over.

import type { TurnKind } from "../../core/ports";
import { isRecord } from "../../link/json";
import { UserDocs } from "./docs";
import type { BackendHost } from "./spindle";

/** A turn something is owed to: where its record goes. */
export interface OpenTurn {
  /** The turn's id: its generation's. */
  turn: string;
  chatId: string;
  kind: TurnKind;
  target: { message: string | null; swipe: number };
  /** When it became owed: when its tag was spent. */
  at: number;
}

interface Stored {
  v: 1;
  open: Record<string, OpenTurn>;
}

const KINDS: Readonly<Record<string, true>> = { new: true, regenerate: true, swipe: true, continue: true };

function openOf(turn: string, raw: unknown): OpenTurn | null {
  if (!isRecord(raw) || typeof raw.chatId !== "string" || typeof raw.kind !== "string" || !Object.hasOwn(KINDS, raw.kind) || typeof raw.at !== "number") return null;
  const target = raw.target;
  if (!isRecord(target) || !(target.message === null || typeof target.message === "string") || typeof target.swipe !== "number" || !Number.isSafeInteger(target.swipe) || target.swipe < 0) return null;
  return { turn, chatId: raw.chatId, kind: raw.kind as TurnKind, target: { message: target.message, swipe: target.swipe }, at: raw.at };
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
