// delegate and agent_message (DESIGN §14): how an agent hands a task to another and asks it more.
// The run does the work (`Delegation`: whom this agent may start, how many at once, what the
// sub-agent is given and may hold, and the reply where this agent may hand it on); these read the
// call and say what the run answered. Each reads its signal before anything else: an agent set to
// work spends the user's tokens, so none is once the round that called it has ended.

import type { JsonObject } from "../ports";
import { FAMILY, TEXT, TOOL } from "../texts";
import type { ToolCtx, ToolDefinition, ToolEnv, ToolOutcome } from "../tools";
import { textArg } from "../util";
import { needs, pagerOf } from "./paging";

/** The paths a call names: a list of them, or one written alone. */
function pathsOf(raw: unknown): string[] {
  const list = Array.isArray(raw) ? raw : raw === undefined || raw === null ? [] : [raw];
  return list.flatMap((item) => textArg(item) ?? []);
}

const delegate: ToolDefinition = {
  name: TOOL.delegate,
  family: FAMILY.agents,
  tier: "read",
  build(env: ToolEnv) {
    const { texts, delegation } = env;
    const choices = delegation?.agents() ?? [];
    // With nobody to hand a task to, the tool would only ever say so.
    if (!delegation || choices.length === 0) return null;
    const p = pagerOf(env, TOOL.delegate);
    return {
      name: TOOL.delegate,
      description: texts.render(TEXT.tool(TOOL.delegate), { agents: choices.map((c) => texts.render(TEXT.agents.choice, { id: c.id, name: c.name, description: c.description })).join("\n") }),
      parameters: {
        type: "object",
        properties: {
          agent: { type: "string", enum: choices.map((c) => c.id), description: texts.render(TEXT.toolArg(TOOL.delegate, "agent")) },
          task: { type: "string", description: texts.render(TEXT.toolArg(TOOL.delegate, "task")) },
          files: { type: "array", items: { type: "string" }, description: texts.render(TEXT.toolArg(TOOL.delegate, "files")) },
          // Offered only where they mean something, so an agent that can use neither is sent delegate as it always was.
          ...(delegation.offersAs ? { as: { type: "string", description: texts.render(TEXT.toolArg(TOOL.delegate, "as")) } } : {}),
          ...(delegation.toReply ? { to_reply: { type: "boolean", description: texts.render(TEXT.toolArg(TOOL.delegate, "to_reply")) } } : {}),
        },
        required: ["agent", "task"],
      },
      async run(args: JsonObject, ctx: ToolCtx): Promise<ToolOutcome> {
        // Read here whatever the loop read before it: nothing that starts an agent trusts its caller to have looked.
        ctx.signal.throwIfAborted();
        const agent = textArg(args.agent);
        if (agent === null) return needs(p, "agent");
        const task = textArg(args.task);
        if (task === null) return needs(p, "task");
        const as = delegation.offersAs && args.as !== undefined && args.as !== null ? textArg(args.as) : undefined;
        if (as === null) return needs(p, "as");
        // A model that writes a flag as the word is taken at its word.
        const toReply = args.to_reply === true || args.to_reply === "true";
        return delegation.start({ agent, task, files: pathsOf(args.files), ...(as !== undefined ? { as } : {}), ...(toReply ? { toReply: true } : {}) }, ctx);
      },
    };
  },
};

const agentMessage: ToolDefinition = {
  name: TOOL.agentMessage,
  family: FAMILY.agents,
  tier: "read",
  build(env: ToolEnv) {
    const { texts, delegation } = env;
    if (!delegation || delegation.agents().length === 0) return null;
    const p = pagerOf(env, TOOL.agentMessage);
    return {
      name: TOOL.agentMessage,
      description: texts.render(TEXT.tool(TOOL.agentMessage)),
      parameters: {
        type: "object",
        properties: {
          handle: { type: "string", description: texts.render(TEXT.toolArg(TOOL.agentMessage, "handle")) },
          text: { type: "string", description: texts.render(TEXT.toolArg(TOOL.agentMessage, "text")) },
        },
        required: ["handle", "text"],
      },
      async run(args: JsonObject, ctx: ToolCtx): Promise<ToolOutcome> {
        // As delegate does: a round that has ended sends no agent another message.
        ctx.signal.throwIfAborted();
        const handle = textArg(args.handle);
        if (handle === null) return needs(p, "handle");
        const text = textArg(args.text);
        if (text === null) return needs(p, "text");
        return delegation.message({ handle, text }, ctx);
      },
    };
  },
};

export const AGENT_TOOLS: readonly ToolDefinition[] = [delegate, agentMessage];
