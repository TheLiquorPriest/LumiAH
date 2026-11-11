// The core's own tools (DESIGN §4.3, §11, §13 to §15, §23, §24): what every harness starts with.
// `scratch_read` isn't here: the loop gives it to any agent that has tools. An extension's tools and
// the tools of MCP servers aren't either: they run in the extension and are read from the host at
// the start of every run (`definitions.ts`).

import type { ToolDefinition } from "../tools";
import { AGENT_TOOLS } from "./agents";
import { BOOK_TOOLS } from "./book";
import { CHAT_TOOLS } from "./chat";
import { CHRONICLE_TOOLS } from "./chronicle";
import { DATABANK_TOOLS } from "./databanks";
import { JOB_TOOLS } from "./jobs";
import { LORE_TOOLS } from "./lore";
import { MEMORY_TOOLS } from "./memory";
import { PAST_TOOLS } from "./past-turn";
import { PRESET_TOOLS } from "./preset";
import { SKILL_TOOLS } from "./skills";
import { WEB_TOOLS } from "./web";
import { WORKSPACE_TOOLS } from "./workspace";
import { REPLY_TOOLS } from "./write-reply";

export const BASE_TOOLS: readonly ToolDefinition[] = [...CHAT_TOOLS, ...BOOK_TOOLS, ...LORE_TOOLS, ...PRESET_TOOLS, ...PAST_TOOLS, ...REPLY_TOOLS, ...WORKSPACE_TOOLS, ...SKILL_TOOLS, ...AGENT_TOOLS, ...JOB_TOOLS, ...CHRONICLE_TOOLS, ...MEMORY_TOOLS, ...DATABANK_TOOLS, ...WEB_TOOLS];
