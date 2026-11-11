// write_reply (DESIGN §3.1, §3.2, §24.3): the main agent hands the writer its brief, and the writer's
// reply goes to the user. The turn makes the writer's call (`ToolEnv.writeReply`); the tool is offered
// only where a writer writes this turn's reply, and its result ends the main agent's send. With the
// brief it may name lore entries to add to what the writer is sent and entries to take out of it.

import type { JsonObject } from "../ports";
import { recallOf } from "../recall/recall";
import { planWriterLore } from "../recall/writer";
import { FAMILY, TEXT, TOOL } from "../texts";
import type { ToolCtx, ToolDefinition, ToolEnv, ToolOutcome } from "../tools";
import { textArg } from "../util";

const writeReply: ToolDefinition = {
  name: TOOL.writeReply,
  family: FAMILY.reply,
  // The reply is the turn's own work, and changes nothing LumiAH keeps: holding it for approval would hold every reply.
  tier: "read",
  build(env: ToolEnv) {
    const { texts, writeReply: write } = env;
    if (!write) return null;
    const { add, drop, addEntries, addChars } = env.settings.recall.writer;
    const ids = (description: string): JsonObject => ({ type: "array", items: { type: "string" }, description });
    return {
      name: TOOL.writeReply,
      description: texts.render(TEXT.tool(TOOL.writeReply)),
      // Its result ends the main agent's send: of one answer's calls the loop runs the first alone, so the brief of one never goes with the lore of another.
      ends: true,
      parameters: {
        type: "object",
        properties: {
          brief: { type: "string", description: texts.render(TEXT.toolArg(TOOL.writeReply, "brief")) },
          // An argument Settings switch off isn't shown: the model is never offered what would only be refused.
          ...(add && addEntries > 0 ? { add: ids(texts.render(TEXT.toolArg(TOOL.writeReply, "add"), { entries: texts.counted(addEntries, TEXT.recall.word.entry), chars: String(addChars) })) } : {}),
          ...(drop ? { drop: ids(texts.render(TEXT.toolArg(TOOL.writeReply, "drop"))) } : {}),
        },
        required: ["brief"],
      },
      async run(args: JsonObject, ctx: ToolCtx): Promise<ToolOutcome> {
        const brief = textArg(args.brief);
        if (brief === null) return { text: texts.render(TEXT.answer.replyNoBrief), error: true };
        // Planned on every call, before the writer is asked: a second call after a writer that failed starts from what it names, not from the first call's entries. The plan never holds the reply.
        const lore = await planWriterLore(recallOf(env), { add: args.add, drop: args.drop });
        const outcome = await write(brief, ctx);
        return lore.added.length + lore.dropped.length + lore.refused.length > 0 ? { ...outcome, lore } : outcome;
      },
    };
  },
};

export const REPLY_TOOLS: readonly ToolDefinition[] = [writeReply];
