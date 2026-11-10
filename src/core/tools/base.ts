// The base tools (DESIGN §4.3): what every harness starts with. `scratch_read` isn't here: the loop
// gives it to any agent that has tools. A later slice adds workspace tools, delegation, scheduling,
// summarize and MCP tools through the same registry.

import type { ToolDefinition } from "../tools";
import { CHAT_TOOLS } from "./chat";
import { LORE_TOOLS } from "./lore";
import { PAST_TOOLS } from "./past-turn";
import { PRESET_TOOLS } from "./preset";
import { REPLY_TOOLS } from "./write-reply";

export const BASE_TOOLS: readonly ToolDefinition[] = [...CHAT_TOOLS, ...LORE_TOOLS, ...PRESET_TOOLS, ...PAST_TOOLS, ...REPLY_TOOLS];
