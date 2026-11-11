// The preset tool (DESIGN §4.3): the active preset's instruction blocks, as the preset has them, in
// order. The request marks the instructions that reached the prompt, macros filled; this reads what
// the preset's author wrote, those switched off among them.

import type { JsonObject, PresetBlock } from "../ports";
import { FAMILY, TEXT, TOOL } from "../texts";
import type { ToolDefinition, ToolEnv, ToolOutcome } from "../tools";
import { clip, textArg } from "../util";
import { fitted, listPage, pagerOf, readCursor, saidBack, textPage } from "./paging";

const presetInstructions: ToolDefinition = {
  name: TOOL.presetInstructions,
  family: FAMILY.preset,
  tier: "read",
  build(env: ToolEnv) {
    // A preset is a generation's: a job's run and a side session's turn answer none.
    const { texts, turn } = env;
    if (!turn) return null;
    const p = pagerOf(env, TOOL.presetInstructions);
    // Read once per turn, the first time the tool is called.
    let read: Promise<PresetBlock[]> | undefined;
    const instructions = (): Promise<PresetBlock[]> => (read ??= turn.presetId === null ? Promise.resolve([]) : env.host.preset.blocks(turn.presetId).then((blocks) => blocks.filter((b) => b.kind === "instruction")));
    const off = (b: PresetBlock): string => (b.enabled ? "" : texts.render(TEXT.answer.presetOff));
    return {
      name: TOOL.presetInstructions,
      description: texts.render(TEXT.tool(TOOL.presetInstructions)),
      parameters: { type: "object", properties: { block: { type: "string", description: texts.render(TEXT.toolArg(TOOL.presetInstructions, "block")) }, cursor: { type: "string", description: texts.render(TEXT.toolArg(TOOL.presetInstructions, "cursor")) } } },
      async run(args: JsonObject): Promise<ToolOutcome> {
        const cursor = readCursor(p, args);
        if ("text" in cursor) return cursor;
        const blocks = await instructions();
        if (blocks.length === 0) return { text: texts.render(TEXT.answer.presetNone) };
        const wanted = textArg(args.block)?.replace(/^\[|\]$/g, "");
        if (wanted === undefined) {
          return listPage(p, {
            total: blocks.length,
            noun: TEXT.word.block,
            cursor,
            item: (i) => {
              const b = blocks[i];
              return b ? texts.render(TEXT.answer.presetBlock, { id: b.id, name: b.name, role: b.role, flags: off(b), chars: String(b.content.length), excerpt: clip(b.content.replace(/\s+/g, " ").trim(), env.settings.tools.excerptChars) }) : "";
            },
          });
        }
        const block = blocks.find((b) => b.id === wanted) ?? blocks.find((b) => b.name.trim().toLowerCase() === wanted.toLowerCase());
        if (!block) return { text: fitted(p, blocks.map((b) => `“${b.name}” [${b.id}]`).join(", "), (list) => saidBack(p, wanted, (said) => texts.render(TEXT.answer.presetNoBlock, { block: said, blocks: list }))), error: true };
        return textPage(p, {
          text: block.content,
          from: cursor.at,
          given: cursor.given,
          frame: (part) => texts.render(TEXT.answer.presetRead, { name: block.name, id: block.id, role: block.role, flags: off(block), from: String(part.from), to: String(part.to), chars: String(block.content.length), text: part.text }),
        });
      },
    };
  },
};

export const PRESET_TOOLS: readonly ToolDefinition[] = [presetInstructions];
