// The user's word on a held tool call (DESIGN §17), as the backend passes it on: exactly as it was
// given. What a word means is the core's to read, and the core fails closed (only a word that is
// exactly an approval runs the call). So the backend, which stands between the page and the core
// in both ways to run, must never make an approval of a word that is none, nor change one that is.

import { describe, expect, test } from "bun:test";
import type { ApprovalAnswer, ApprovalAsk } from "../../../src/core/ports";
import { Approvals } from "../../../src/extension/backend/approvals";

const MARA = "user-mara";
const ASK: ApprovalAsk = { turn: "gen-1", chatId: "chat-1", agentId: "a1", role: "main", callId: "call_1", tool: "mcp:tide:table", tier: "external", args: { harbour: "north quay" }, at: 1, until: null };

/** A call of Mara's held for her word: what holds it, the wait for her answer, and the id her page answers by. */
function held() {
  const approvals = new Approvals({ id: () => "held-1" });
  const waiting = approvals.ask(MARA, "chat-1", ASK, new AbortController().signal);
  return { approvals, waiting, id: "held-1" };
}

describe("the user's word on a held call", () => {
  test("reaches the asking side exactly as it was given: an approval as it is, a refusal with its reason untouched", async () => {
    for (const word of [{ decision: "once" }, { decision: "chat" }, { decision: "refused" }, { decision: "refused", reason: "  The quay is closed.  " }] satisfies ApprovalAnswer[]) {
      const { approvals, waiting, id } = held();
      expect(approvals.answer(MARA, id, word)).toBe(true);
      // The very word, not a reading of it.
      expect(await waiting).toBe(word);
      expect(approvals.views(MARA)).toEqual([]);
    }
  });

  test("is never made an approval on the way: a word that is none is passed on as it came, for the core to refuse", async () => {
    for (const word of [{}, { decision: "expired" }, { decision: "Refused" }, { error: "the page went away" }, "once"]) {
      const { approvals, waiting, id } = held();
      expect(approvals.answer(MARA, id, word as unknown as ApprovalAnswer)).toBe(true);
      expect(await waiting).toBe(word as unknown as ApprovalAnswer);
    }
  });

  test("is taken from the user the call is held for, and from nobody else", async () => {
    const { approvals, waiting, id } = held();
    expect(approvals.answer("user-joss", id, { decision: "once" })).toBe(false);
    expect(approvals.views(MARA)).toHaveLength(1);
    expect(approvals.views("user-joss")).toEqual([]);
    expect(approvals.answer(MARA, id, { decision: "refused" })).toBe(true);
    expect(await waiting).toEqual({ decision: "refused" });
    // Answered once: a second word finds nothing waiting.
    expect(approvals.answer(MARA, id, { decision: "once" })).toBe(false);
  });
});
