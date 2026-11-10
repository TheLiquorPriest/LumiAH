// write_reply (DESIGN §3.1, §3.2): the main agent hands the writer its brief, and the writer's reply
// goes to the user. The turn makes the writer's call (`ToolEnv.writeReply`); the tool is offered only
// where a writer writes this turn's reply, and its result ends the main agent's send.

import type { JsonObject } from "../ports";
import { TEXT, TOOL } from "../texts";
import type { ToolCtx, ToolDefinition, ToolEnv, ToolOutcome } from "../tools";
import { textArg } from "../util";

const writeReply: ToolDefinition = {
  name: TOOL.writeReply,
  build(env: ToolEnv) {
    const { texts, writeReply: write } = env;
    if (!write) return null;
    return {
      name: TOOL.writeReply,
      description: texts.render(TEXT.tool(TOOL.writeReply)),
      parameters: { type: "object", properties: { brief: { type: "string", description: texts.render(TEXT.toolArg(TOOL.writeReply, "brief")) } }, required: ["brief"] },
      async run(args: JsonObject, ctx: ToolCtx): Promise<ToolOutcome> {
        const brief = textArg(args.brief);
        return brief === null ? { text: texts.render(TEXT.answer.replyNoBrief), error: true } : write(brief, ctx);
      },
    };
  },
};

export const REPLY_TOOLS: readonly ToolDefinition[] = [writeReply];
