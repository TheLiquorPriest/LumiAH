// Compaction (DESIGN §5): once what the main agent carries passes Summarize past, the turn summarizes
// all but its latest turns in one call, and the summary lands with the turn's record. This file is
// the call's inputs (`foldOf`), the guard on its answer (`summaryOf`) and the memory of summaries
// already made (`CompactionMemo`); the turn makes the call and lands it (`harness.ts`).
//
// A summary whose call was cut off at its limit never lands: the session goes on whole, the trace
// says so, and the next turn tries again.

import { partsHash } from "./hash";
import { type AgentReply, cutShort } from "./loop";
import { receiptOf, toldOf } from "./receipts";
import { TEXT, type Texts } from "./texts";
import type { PastTurn } from "./tools";
import { errorText } from "./util";

/** A compaction's call: its instructions and its message, the turns it folds into the summary, and those that stay whole after it. */
export interface Fold {
  system: string;
  message: string;
  folded: readonly PastTurn[];
  kept: readonly PastTurn[];
}

/**
 * The call that compacts `session`: all but its latest `keep` turns fold into one summary, asked to
 * be at most `limit` tokens long; the summary so far and the receipts of the turns to fold are its
 * message. Null when the session holds no more than `keep` turns: there is nothing to fold.
 */
export function foldOf(session: { summary: string | null; turns: readonly PastTurn[] }, input: { keep: number; limit: number; receiptChars: number; receiptArgChars: number; texts: Texts }): Fold | null {
  const { texts } = input;
  const cut = Math.max(0, session.turns.length - input.keep);
  const folded = session.turns.slice(0, cut);
  if (folded.length === 0) return null;
  const turns = folded.map((t) => texts.render(TEXT.session.summarizerTurn, { told: toldOf(t.segment, texts), receipt: receiptOf(t.segment, input, texts) }));
  return {
    system: texts.render(TEXT.session.summarizer, { keep: texts.counted(input.keep, TEXT.word.turn), limit: String(input.limit) }),
    message: texts.render(TEXT.session.summarizerInput, { summary: session.summary ?? texts.render(TEXT.session.none), turns: turns.join("\n\n") }),
    folded,
    kept: session.turns.slice(cut),
  };
}

/** A fold's outcome: the summary, or why there is none (`cut`: its call stopped at its limit). */
export type FoldResult = { summary: string } | { failed: string; cut?: true };

/**
 * The summary a compaction's call answered, or why it can't land: its call failed or answered
 * nothing, or its answer stopped at its limit. Whether it was cut is told from how the call ended
 * (`cutShort`: the provider's finish reason) and never from its words: a whole summary may end on
 * any word, and one taken for cut would never land.
 */
export function summaryOf(reply: Pick<AgentReply, "status" | "text" | "reason" | "finish">, texts: Texts): FoldResult {
  const summary = reply.text.trim();
  if (reply.status !== "answered") return { failed: reply.reason ?? texts.render(TEXT.session.failedNothing) };
  if (summary === "") return { failed: texts.render(TEXT.session.failedNothing) };
  if (cutShort(reply.finish)) return { failed: texts.render(TEXT.session.failedCut), cut: true };
  return { summary };
}

/** A fold's key: a digest of every input of its call, so a key that hits is the very call that would be made now. */
export function foldKey(input: { connectionId: string | null; model: string | null; effort: string; callTokensOut: number; system: string; message: string }): Promise<string> {
  return partsHash("lumiah.fold", input.connectionId ?? "", input.model ?? "", input.effort, String(input.callTokensOut), input.system, input.message);
}

interface Entry {
  result: Promise<FoldResult>;
}

/**
 * The summaries made lately, by their call's key, in memory. A swipe or a regenerate of a turn that
 * compacted reads the session at the same point, so it finds the same fold and makes no second call;
 * two turns asking at once share one call. A summary that was cut stays as the failure it is, so the
 * turns that find it go on whole without calling again; any other failure goes, so whoever asks next
 * calls again. Nothing here survives a restart: the next turn then makes its fold once more.
 */
export class CompactionMemo {
  private readonly folds = new Map<string, Entry>();

  /** `cap`: how many folds are kept (a setting, read each time), the latest used last. */
  constructor(private readonly cap: () => number) {}

  /** The fold under `key`: the one made or under way, else `make`'s, started now, once for every asker. */
  run(key: string, make: () => Promise<FoldResult>): Promise<FoldResult> {
    const had = this.folds.get(key);
    if (had) {
      this.touch(key, had);
      return had.result;
    }
    const entry: Entry = { result: Promise.resolve<FoldResult>({ failed: "" }) };
    entry.result = make()
      .catch((error: unknown): FoldResult => ({ failed: errorText(error) }))
      .then((result) => {
        // A failure that isn't a cut summary goes, so the next asker calls again.
        if ("failed" in result && result.cut !== true && this.folds.get(key) === entry) this.folds.delete(key);
        return result;
      });
    this.touch(key, entry);
    return entry.result;
  }

  /** How many folds are kept now. */
  get size(): number {
    return this.folds.size;
  }

  private touch(key: string, entry: Entry): void {
    this.folds.delete(key);
    this.folds.set(key, entry);
    const cap = Math.max(0, this.cap());
    for (const old of this.folds.keys()) {
      if (this.folds.size <= cap || old === key) break;
      this.folds.delete(old);
    }
  }
}
