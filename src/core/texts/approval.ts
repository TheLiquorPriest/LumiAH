// The texts of approval (DESIGN §17): what an agent is told when a call of its that waited for the
// user's word wasn't run, and what its transcript says of an answer that was none.

import { GROUP, type TextDef, v } from "../text-def";

export const APPROVAL_TEXT = {
  refused: "approval.refused",
  refusedReason: "approval.refused.reason",
  timedOut: "approval.timed_out",
  noWay: "approval.no_way",
  failed: "approval.failed",
  unread: "approval.unread",
  unreadWhy: "approval.unread.why",
} as const;

const APPROVAL = GROUP.approval;

export const APPROVAL_TEXTS: TextDef[] = [
  { id: APPROVAL_TEXT.refused, group: APPROVAL, label: "A call the user refused", note: "The result of a tool call the user refused.", text: "Not run: the user refused this call of {{tool}}. Don't make it again unless they ask for it; go on without it, or say in your answer what you needed it for.{{reason}}", vars: [v("tool", "the tool", true), v("reason", "the user's reason, where they gave one")] },
  { id: APPROVAL_TEXT.refusedReason, group: APPROVAL, label: "A call the user refused: their reason", note: "Fills {{reason}} where the user gave one: on a line of its own, so the user's words end where the text does.", text: "\nTheir reason: {{reason}}", vars: [v("reason", "the user's words", true)] },
  { id: APPROVAL_TEXT.timedOut, group: APPROVAL, label: "A call nobody answered for", note: "The result of a tool call that waited for the user's word longer than Wait for your word.", text: "Not run: this call of {{tool}} needs the user's approval, and none came in the {{seconds}} seconds it may wait (Wait for your word). Go on without it, or say in your answer what you needed it for.", vars: [v("tool", "the tool", true), v("seconds", "how long it waited, in seconds")] },
  { id: APPROVAL_TEXT.noWay, group: APPROVAL, label: "A call nobody can be asked about", note: "The result of a tool call that needs the user's approval on a runtime that has no way to ask.", text: "Not run: this call of {{tool}} needs the user's approval, and there is no way to ask them here. Go on without it, or say in your answer what you needed it for.", vars: [v("tool", "the tool", true)] },
  { id: APPROVAL_TEXT.failed, group: APPROVAL, label: "A call the user couldn't be asked about", note: "The result of a tool call that needs the user's approval when asking for it failed.", text: "Not run: this call of {{tool}} needs the user's approval, and asking for it failed ({{error}}). Go on without it, or say in your answer what you needed it for.", vars: [v("tool", "the tool", true), v("error", "why the ask failed", true)] },
  { id: APPROVAL_TEXT.unread, group: APPROVAL, label: "A call whose answer wasn't one", note: "The result of a tool call that needs the user's approval when what came back was neither an approval nor a refusal: nobody gave their word, so the call isn't run.", text: "Not run: this call of {{tool}} needs the user's approval, and what came back was neither an approval nor a refusal, so nobody gave their word for it. Go on without it, or say in your answer what you needed it for.", vars: [v("tool", "the tool", true)] },
  { id: APPROVAL_TEXT.unreadWhy, group: APPROVAL, label: "A call whose answer wasn't one: on the record", note: "What the agent's transcript says of such a call, where a refusal's reason stands.", text: "what came back was neither an approval nor a refusal", vars: [] },
];
