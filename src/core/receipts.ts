// What the main agent carries from earlier turns (DESIGN §3.1): the last compaction summary, and a
// receipt for each turn since. A receipt says what the turn was for and each thing the agent did in
// it, with the start of each result and how to read it whole (`past_turn`), so a session of many
// turns stays short while nothing in it is lost: the segment keeps every step in full.
//
// Receipts are rendered when a turn reads its session, from the segments as stored and the user's
// texts and settings as they stand, so a changed Receipt length or a replaced text takes effect on
// the next turn without touching anything stored.

import type { ModelMessage } from "./ports";
import type { SegmentStep, SessionSegment } from "./sessions";
import { TEXT, type Texts } from "./texts";
import type { PastTurn } from "./tools";
import { cutAt, tokensOf } from "./util";

/** What an earlier turn was for, in a line: its reply, its kind, and what its request was. */
export function toldOf(segment: SessionSegment, texts: Texts): string {
  const vars = { reply: String(segment.reply), kind: segment.turn, count: texts.counted(segment.request.messages, TEXT.word.message) };
  return segment.request.last === null ? texts.render(TEXT.session.toldUnplaced, vars) : texts.render(TEXT.session.told, { ...vars, last: String(segment.request.last) });
}

/**
 * A step's text in full, which `past_turn` reads and greps: what the agent wrote, a call's arguments
 * whole and then what it gave back, why it stopped. A reply it wrote itself has none: it is in the chat.
 */
export function stepText(step: SegmentStep): string {
  if (step.kind === "said") return step.text;
  if (step.kind === "call") return `${JSON.stringify(step.args)}\n${step.result}`;
  return step.kind === "stop" ? step.reason : "";
}

/** A turn's receipt: each step in a line or two, a text longer than `chars` kept as its start with how to read the rest. */
export function receiptOf(segment: SessionSegment, chars: number, texts: Texts): string {
  const reply = String(segment.reply);
  const short = (text: string): string => (text.length <= chars ? text : texts.render(TEXT.session.receiptClipped, { text: text.slice(0, cutAt(text, chars)), chars: String(text.length), reply }));
  const lines = segment.steps.map((step): string => {
    if (step.kind === "said") return texts.render(TEXT.session.receiptSaid, { text: short(step.text) });
    if (step.kind === "call") return texts.render(step.error ? TEXT.session.receiptFailed : TEXT.session.receiptCall, { tool: step.name, args: JSON.stringify(step.args), result: short(step.result) });
    if (step.kind === "reply") return texts.render(TEXT.session.receiptReply, { chars: String(step.chars), reply });
    return texts.render(TEXT.session.receiptStop, { reason: step.reason });
  });
  return texts.render(TEXT.session.receipt, { steps: lines.length > 0 ? lines.join("\n") : texts.render(TEXT.session.receiptNothing) });
}

/** What the main agent carries into a turn, as it is sent. */
export interface Carried {
  /** The conversation it takes up: for each earlier turn, what it was for (the user's) and its receipt (the agent's), the summary leading the first. */
  history: ModelMessage[];
  /** The summary, framed, when no turn follows it to lead: the turn's own message carries it then. */
  lead: string | null;
  /** All of it in tokens, as estimated: what Summarize past is measured against. */
  tokens: number;
}

/** What `session` comes to as the main agent carries it. */
export function carriedOf(session: { summary: string | null; turns: readonly PastTurn[] }, input: { receiptChars: number; charsPerToken: number; texts: Texts }): Carried {
  const { texts } = input;
  const summary = session.summary === null ? null : texts.render(TEXT.session.summary, { summary: session.summary });
  const history = session.turns.flatMap((turn, i): ModelMessage[] => [
    { role: "user", content: i === 0 && summary !== null ? `${summary}\n\n${toldOf(turn.segment, texts)}` : toldOf(turn.segment, texts) },
    { role: "assistant", content: receiptOf(turn.segment, input.receiptChars, texts) },
  ]);
  const lead = history.length === 0 ? summary : null;
  let tokens = lead === null ? 0 : tokensOf(lead, input.charsPerToken);
  for (const m of history) tokens += tokensOf(m.content, input.charsPerToken);
  return { history, lead, tokens };
}
