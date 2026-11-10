// The core's public surface (DESIGN §1): what the runtime, the extension backend, the frontend's
// shared contract and an extension that uses LumiAH as a package take from it.

export * from "./ports";
export { type Harness, type HarnessOptions, createHarness } from "./harness";
export { type AgentDeps, type AgentHandle, type AgentReply, type AgentSpec, type AgentTrace, type AgentTranscript, AgentTurn, cutShort, startAgent } from "./loop";
export { type AgentTool, type ChatView, type LoreItem, type LoreView, type PastTurn, type ToolCtx, type ToolDefinition, type ToolEnv, type ToolOutcome, ToolRegistry } from "./tools";
export { BASE_TOOLS } from "./tools/base";
export { type AgentDefinition, AgentRegistry, baseAgents, type ResolvedAgent } from "./agents";
export { AGENT, type AgentBudget, type AgentSettings, agentSettings, type BriefPlace, checkSettings, type ConnectionThrottle, defaultSettings, MAIN_TOOLS, type ModelPrice, type Settings, SETTINGS_SCHEMA, type SettingsProblem, type SettingsScope, settingsOf, settingsSchema, type TurnBudget } from "./settings";
export { checkText, renderDefault, SCRATCH_READ, TEXT, TEXT_DEFS, type TextDef, type TextVar, Texts, textDef, textsOf, TOOL } from "./texts";
export { type Compaction, type PathTurn, pathHashes, pathTurns, recordOf, type ResumedSession, rollback, type SegmentStep, segmentOf, sessionAt, type SessionRefs, type SessionSegment, Sessions } from "./sessions";
export { type TurnTranscript, transcriptOf } from "./transcript";
export { readCallPrompt } from "./prompts";
export { Blobs } from "./blobs";
export { isHash, nextPath, partsHash, ROOT_PATH, textHash } from "./hash";
export { AgentAccounts, AgentStop, isToolRefusal, recoverToolCalls } from "./provider";
export { addCall, addUsage, emptyUsage, parseUsage } from "./usage";
export { type Limit, limitOf } from "./util";
