// past_turn (DESIGN §4.3): the main agent's look back at an earlier turn of its own, in full. Its
// session carries past turns as receipts (`receipts.ts`), and each turn's segment keeps every step
// whole; this reads those, never anything the main agent wasn't sent. A turn is named by its reply's
// number in the chat, as the receipts name it. Without a reply, grep reads the latest turns.

import type { JsonObject } from "../ports";
import { stepText, toldOf } from "../receipts";
import type { SegmentStep } from "../sessions";
import { FAMILY, TEXT, TOOL } from "../texts";
import type { PastTurn, ToolDefinition, ToolEnv, ToolOutcome } from "../tools";
import { clip, textArg, wholeArg } from "../util";
import { around, fitted, grepLines, listPage, pagerOf, readCursor, saidBack, textPage } from "./paging";

const pastTurn: ToolDefinition = {
  name: TOOL.pastTurn,
  family: FAMILY.session,
  tier: "read",
  build(env: ToolEnv) {
    const { texts, past } = env;
    const p = pagerOf(env, TOOL.pastTurn);
    /** What a step is, in a few words: a tool call by its tool and arguments, a note, the reply, a stop. */
    const what = (step: SegmentStep, turn: PastTurn): string => {
      if (step.kind === "call") return texts.render(step.error ? TEXT.answer.pastFailed : TEXT.answer.pastCall, { tool: step.name, args: clip(JSON.stringify(step.args), env.settings.tools.lineChars) });
      if (step.kind === "said") return texts.render(TEXT.answer.pastSaid);
      return step.kind === "reply" ? texts.render(TEXT.answer.pastReply, { reply: String(turn.reply), chars: String(step.chars) }) : texts.render(TEXT.answer.pastStop);
    };
    return {
      name: TOOL.pastTurn,
      description: texts.render(TEXT.tool(TOOL.pastTurn)),
      parameters: {
        type: "object",
        properties: {
          reply: { type: "integer", description: texts.render(TEXT.toolArg(TOOL.pastTurn, "reply")) },
          step: { type: "integer", description: texts.render(TEXT.toolArg(TOOL.pastTurn, "step")) },
          grep: { type: "string", description: texts.render(TEXT.toolArg(TOOL.pastTurn, "grep")) },
          cursor: { type: "string", description: texts.render(TEXT.toolArg(TOOL.pastTurn, "cursor")) },
        },
      },
      async run(args: JsonObject): Promise<ToolOutcome> {
        const cursor = readCursor(p, args);
        if ("text" in cursor) return cursor;
        if (past.length === 0) return { text: texts.render(TEXT.answer.pastNone) };
        const reply = wholeArg(args.reply);
        const turn = reply === null ? undefined : past.findLast((t) => t.reply === reply);
        if (reply !== null && !turn) return { text: fitted(p, past.map((t) => `#${t.reply}`).join(", "), (list) => texts.render(TEXT.answer.pastNoTurn, { reply: String(reply), replies: list })), error: true };
        const needle = textArg(args.grep);
        if (needle !== null) {
          const read = turn ? [turn] : past.slice(-env.settings.tools.grepTurns);
          const steps = read.flatMap((t) => t.segment.steps.map((step, i) => ({ turn: t, n: i + 1, step })));
          const found = grepLines(steps.map((s) => stepText(s.step)), needle);
          const where = turn ? texts.render(TEXT.answer.pastWhereReply, { reply: String(turn.reply) }) : texts.render(TEXT.answer.pastWhereLatest, { turns: texts.counted(read.length, TEXT.word.turn) });
          if (found.length === 0) return { text: saidBack(p, needle, (said) => texts.render(TEXT.answer.pastGrepNothing, { where, query: said })) };
          return listPage(p, {
            total: found.length,
            noun: TEXT.word.line,
            cursor,
            item: (i) => {
              const line = found[i];
              const at = line ? steps[line.key] : undefined;
              return line && at ? texts.render(TEXT.answer.pastLine, { reply: String(at.turn.reply), n: String(at.n), line: String(line.line), text: around(line.text, line.at, needle.length, env.settings.tools.lineChars) }) : "";
            },
          });
        }
        if (!turn) {
          return listPage(p, {
            total: past.length,
            noun: TEXT.word.turn,
            cursor,
            lead: texts.render(TEXT.answer.pastTurns),
            item: (i) => {
              const t = past[i];
              return t ? texts.render(TEXT.answer.pastTurnLine, { told: toldOf(t.segment, texts), count: texts.counted(t.segment.steps.length, TEXT.word.step) }) : "";
            },
          });
        }
        const { steps } = turn.segment;
        const n = wholeArg(args.step);
        if (n === null) {
          if (steps.length === 0) return { text: `${toldOf(turn.segment, texts)}\n${texts.render(TEXT.session.receiptNothing)}` };
          return listPage(p, {
            total: steps.length,
            noun: TEXT.word.step,
            cursor,
            lead: texts.render(TEXT.answer.pastTurn, { told: toldOf(turn.segment, texts) }),
            item: (i) => {
              const step = steps[i];
              if (!step) return "";
              // A call's line already names its arguments: what it shows of the step is what came back.
              const shown = step.kind === "call" ? step.result : stepText(step);
              return texts.render(TEXT.answer.pastStep, { n: String(i + 1), what: what(step, turn), chars: String(stepText(step).length), first: clip(shown.replace(/\s+/g, " ").trim(), env.settings.tools.excerptChars) });
            },
          });
        }
        const step = steps[n - 1];
        if (!step || n < 1) return { text: texts.render(TEXT.answer.pastNoStep, { reply: String(turn.reply), count: texts.counted(steps.length, TEXT.word.step), last: String(steps.length) }), error: true };
        const whole = stepText(step);
        return textPage(p, {
          text: whole,
          from: cursor.at,
          given: cursor.given,
          frame: (part) => texts.render(TEXT.answer.pastRead, { reply: String(turn.reply), n: String(n), what: what(step, turn), from: String(part.from), to: String(part.to), chars: String(whole.length), text: part.text }),
        });
      },
    };
  },
};

export const PAST_TOOLS: readonly ToolDefinition[] = [pastTurn];
