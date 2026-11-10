#!/usr/bin/env bun
// @bun

// src/runtime/main.ts
import { execFile } from "child_process";
import { chmodSync, copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, realpathSync, renameSync, rmSync, statSync, writeFileSync } from "fs";
import { homedir, hostname } from "os";
import { dirname } from "path";
import { createInterface } from "readline";
import { fileURLToPath } from "url";
// package.json
var package_default = {
  name: "lumi-ah",
  version: "0.0.1",
  private: true,
  type: "module",
  description: "Lumiverse Agentic Harness: a main agent with tools, sub-agents, sessions and a workspace that answers Lumiverse's main generation.",
  license: "MIT",
  repository: "github:TheLiquorPriest/LumiAH",
  bin: {
    lumiah: "dist/lumiah.js"
  },
  engines: {
    bun: ">=1.4"
  },
  exports: {
    "./core": "./src/core/index.ts",
    "./link": "./src/link/index.ts",
    "./runtime": "./src/runtime/index.ts",
    "./extension/backend": "./src/extension/backend/index.ts",
    "./extension/frontend": "./src/extension/frontend/index.ts",
    "./shared": "./src/shared/index.ts",
    "./package.json": "./package.json"
  },
  scripts: {
    build: "bun scripts/build.ts",
    typecheck: "tsc --noEmit -p . && tsc --noEmit -p tsconfig.core.json",
    test: "bun test"
  },
  dependencies: {
    preact: "^11.0.1"
  },
  devDependencies: {
    "bun-types": "^1.4.2",
    "lumiverse-spindle-types": "0.6.79",
    typescript: "7.0.2"
  }
};

// src/core/ports.ts
function isRecord(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
// src/core/util.ts
function limitOf(limit) {
  return limit === null ? Number.POSITIVE_INFINITY : limit;
}
var TIMER_MAX_MS = 2147483647;
function timerMs(left) {
  return left >= TIMER_MAX_MS ? null : Math.max(0, left);
}
function cutAt(text, at) {
  const unit = text.charCodeAt(at - 1);
  return at > 0 && at < text.length && unit >= 55296 && unit <= 56319 ? at - 1 : at;
}
function clip(text, max) {
  return text.length <= max ? text : `${text.slice(0, cutAt(text, Math.max(0, max - 1)))}\u2026`;
}
function hasOwn(o, key) {
  return Object.prototype.hasOwnProperty.call(o, key);
}
function jsonEqual(a, b) {
  if (a === b)
    return true;
  if (Array.isArray(a) && Array.isArray(b))
    return a.length === b.length && a.every((v, i) => jsonEqual(v, b[i]));
  if (isRecord(a) && isRecord(b)) {
    const keys = Object.keys(a);
    return keys.length === Object.keys(b).length && keys.every((k) => hasOwn(b, k) && jsonEqual(a[k], b[k]));
  }
  return false;
}
function wholeArg(v) {
  const n = typeof v === "string" && v.trim() !== "" ? Number(v) : v;
  return typeof n === "number" && Number.isSafeInteger(n) ? n : null;
}
function textArg(v) {
  if (typeof v !== "string")
    return null;
  const t = v.trim();
  return t === "" ? null : t;
}
function tokensOf(text, charsPerToken) {
  return Math.ceil(text.length / charsPerToken);
}
function errorText(error) {
  return error instanceof Error ? error.message : String(error);
}
function parseJson(text) {
  try {
    return JSON.parse(text);
  } catch {
    return;
  }
}

// src/core/texts.ts
var SCRATCH_READ = "scratch_read";
var TOOL = {
  chatSearch: "chat_search",
  chatGrep: "chat_grep",
  chatRead: "chat_read",
  loreIndex: "lore_index",
  loreSearch: "lore_search",
  loreGrep: "lore_grep",
  loreRead: "lore_read",
  activeLore: "active_lore",
  presetInstructions: "preset_instructions",
  pastTurn: "past_turn",
  writeReply: "write_reply"
};
var TEXT = {
  runtime: {
    scratchRead: "runtime.scratch_read",
    scratchHandle: "runtime.scratch_read.handle",
    scratchOffset: "runtime.scratch_read.offset",
    scratchLength: "runtime.scratch_read.length",
    scratchPart: "runtime.scratch_part",
    scratchMissing: "runtime.scratch_missing",
    clipped: "runtime.clipped",
    unknownTool: "runtime.unknown_tool",
    toolFailed: "runtime.tool_failed",
    tooManyCalls: "runtime.too_many_calls",
    toolsInText: "runtime.tools_in_text",
    toolInText: "runtime.tool_in_text",
    toolResults: "runtime.tool_results",
    toolResult: "runtime.tool_result",
    toolError: "runtime.tool_error",
    cacheNonce: "runtime.cache_nonce"
  },
  stop: {
    cancelled: "stop.cancelled",
    busy: "stop.busy",
    revisions: "stop.revisions",
    wallTime: "stop.wall_time",
    turnTime: "stop.turn_time",
    callTime: "stop.call_time",
    callTokensIn: "stop.call_tokens_in",
    tokensIn: "stop.tokens_in",
    tokensOut: "stop.tokens_out",
    turnTokensIn: "stop.turn_tokens_in",
    turnTokensOut: "stop.turn_tokens_out",
    loop: "stop.loop",
    toolTurns: "stop.tool_turns",
    turnToolTurns: "stop.turn_tool_turns",
    failed: "stop.failed",
    throttle: "stop.throttle",
    connectionUnread: "stop.connection_unread",
    noDefault: "stop.no_default",
    noConnection: "stop.no_connection",
    loopback: "stop.loopback"
  },
  main: {
    system: "main.system",
    systemWrites: "main.system.writes",
    turn: "main.turn",
    kindNew: "main.turn.new",
    kindRegenerate: "main.turn.regenerate",
    kindSwipe: "main.turn.swipe",
    kindContinue: "main.turn.continue",
    ask: "main.turn.ask",
    askWrites: "main.turn.ask.writes",
    noteDropped: "main.turn.dropped",
    noteRolledBack: "main.turn.rolled_back",
    noteMissing: "main.turn.missing",
    noteSummary: "main.turn.summary",
    noteContinued: "main.turn.continued",
    replyOne: "main.turn.reply_one",
    replyMany: "main.turn.reply_many"
  },
  request: {
    message: "request.message",
    instruction: "request.instruction",
    fromHistory: "request.from.history",
    fromBlock: "request.from.block",
    fromMarker: "request.from.marker",
    media: "request.media",
    empty: "request.empty"
  },
  writer: {
    brief: "writer.brief"
  },
  session: {
    summary: "session.summary",
    told: "session.told",
    toldUnplaced: "session.told.unplaced",
    receipt: "session.receipt",
    receiptCall: "session.receipt.call",
    receiptFailed: "session.receipt.failed",
    receiptSaid: "session.receipt.said",
    receiptReply: "session.receipt.reply",
    receiptStop: "session.receipt.stop",
    receiptClipped: "session.receipt.clipped",
    receiptNothing: "session.receipt.nothing",
    replyWritten: "session.reply_written",
    summarizer: "session.summarizer",
    summarizerInput: "session.summarizer.input",
    summarizerTurn: "session.summarizer.turn",
    none: "session.none",
    failedNothing: "session.summary_failed.nothing",
    failedCut: "session.summary_failed.cut",
    failedMidSentence: "session.summary_failed.mid_sentence"
  },
  answer: {
    more: "tool.answer.more",
    end: "tool.answer.end",
    found: "tool.answer.found",
    chatSearchNothing: "tool.answer.chat_search_nothing",
    chatGrepNothing: "tool.answer.chat_grep_nothing",
    loreSearchNothing: "tool.answer.lore_search_nothing",
    loreGrepNothing: "tool.answer.lore_grep_nothing",
    pastGrepNothing: "tool.answer.past_grep_nothing",
    pastWhereReply: "tool.answer.past_where.reply",
    pastWhereLatest: "tool.answer.past_where.latest",
    badCursor: "tool.answer.bad_cursor",
    needs: "tool.answer.needs",
    cut: "tool.answer.cut",
    chatHit: "tool.answer.chat_hit",
    chatLine: "tool.answer.chat_line",
    chatMessage: "tool.answer.chat_message",
    chatRead: "tool.answer.chat_read",
    chatNoMessage: "tool.answer.chat_no_message",
    chatEmpty: "tool.answer.chat_empty",
    loreBook: "tool.answer.lore_book",
    loreEntry: "tool.answer.lore_entry",
    loreHit: "tool.answer.lore_hit",
    loreLine: "tool.answer.lore_line",
    loreRead: "tool.answer.lore_read",
    loreNoEntry: "tool.answer.lore_no_entry",
    loreNoBook: "tool.answer.lore_no_book",
    loreNoBooks: "tool.answer.lore_no_books",
    loreOff: "tool.answer.lore_off",
    loreAlways: "tool.answer.lore_always",
    activeEntry: "tool.answer.active_entry",
    activeNone: "tool.answer.active_none",
    presetBlock: "tool.answer.preset_block",
    presetRead: "tool.answer.preset_read",
    presetNoBlock: "tool.answer.preset_no_block",
    presetNone: "tool.answer.preset_none",
    presetOff: "tool.answer.preset_off",
    pastTurns: "tool.answer.past_turns",
    pastTurnLine: "tool.answer.past_turn_line",
    pastTurn: "tool.answer.past_turn",
    pastStep: "tool.answer.past_step",
    pastRead: "tool.answer.past_read",
    pastLine: "tool.answer.past_line",
    pastNone: "tool.answer.past_none",
    pastNoTurn: "tool.answer.past_no_turn",
    pastNoStep: "tool.answer.past_no_step",
    pastSaid: "tool.answer.past_step.said",
    pastCall: "tool.answer.past_step.call",
    pastFailed: "tool.answer.past_step.failed",
    pastReply: "tool.answer.past_step.reply",
    pastStop: "tool.answer.past_step.stop",
    loreAmbiguous: "tool.answer.lore_ambiguous",
    replyBusy: "tool.answer.reply_busy",
    replyFailed: "tool.answer.reply_failed",
    replyNoBrief: "tool.answer.reply_no_brief",
    replyEmpty: "tool.answer.reply_empty"
  },
  progress: {
    session: "progress.session",
    sessionSummary: "progress.session_summary",
    fresh: "progress.fresh",
    dropped: "progress.dropped",
    compacting: "progress.compacting",
    compacted: "progress.compacted",
    notCompacted: "progress.not_compacted",
    call: "progress.call",
    writing: "progress.writing",
    writingAlone: "progress.writing_alone",
    retry: "progress.retry",
    stopped: "progress.stopped",
    turnStopped: "progress.turn_stopped"
  },
  word: {
    message: "word.message",
    line: "word.line",
    entry: "word.entry",
    step: "word.step",
    turn: "word.turn",
    earlierTurn: "word.earlier_turn",
    part: "word.part",
    token: "word.token",
    round: "word.round",
    revision: "word.revision",
    time: "word.time",
    tool: "word.tool",
    block: "word.instruction_block"
  },
  tool: (name) => `tool.${name}`,
  toolArg: (name, arg) => `tool.${name}.${arg}`
};
var v = (name, text, required) => required ? { name, text, required } : { name, text };
var RUNTIME = "Every agent";
var STOPS = "Why an agent stopped";
var MAIN = "Main agent";
var REQUEST = "The request, as the main agent reads it";
var WRITER = "Writer";
var SESSION = "Session";
var TOOLS = "Tools";
var ANSWERS = "Tool answers";
var PROGRESS = "Progress lines";
var WORDS = "Words";
var word = (id, one, many) => ({ id, group: WORDS, label: `${one}, ${many}`, note: `The word a count of these takes in answers, notes and stops: for one, then for several, with | between ("1 ${one}", "3 ${many}").`, text: `${one}|${many}`, vars: [] });
var stop = (id, label, note, text, vars = []) => ({ id, group: STOPS, label, note: `${note} The reason an agent that stopped so gives, in the live view and to whoever started it.`, text, vars });
function tool(name, description, args) {
  return [
    { id: TEXT.tool(name), group: TOOLS, label: `${name}: what it does`, note: `The description of the ${name} tool, as the model is offered it.`, text: description, vars: [] },
    ...Object.entries(args).map(([arg, text]) => ({ id: TEXT.toolArg(name, arg), group: TOOLS, label: `${name}: ${arg}`, note: `The description of ${name}'s ${arg} argument.`, text, vars: [] }))
  ];
}
var CURSOR = "Where to go on from: the cursor the last answer gave you. Leave it out to start at the beginning.";
var RUNTIME_TEXTS = [
  { id: TEXT.runtime.scratchRead, group: RUNTIME, label: "scratch_read: what it does", note: "The description of the built-in tool that reads the rest of a clipped tool result.", text: "Read more of a tool result that came back clipped. Give the scratch handle the clipped result names and where to start; you get the next part.", vars: [] },
  { id: TEXT.runtime.scratchHandle, group: RUNTIME, label: "scratch_read: handle", note: "The description of scratch_read's handle argument.", text: "The scratch handle the clipped result names, such as s1.", vars: [] },
  { id: TEXT.runtime.scratchOffset, group: RUNTIME, label: "scratch_read: offset", note: "The description of scratch_read's offset argument.", text: "The character to start from; 0 is the start.", vars: [] },
  { id: TEXT.runtime.scratchLength, group: RUNTIME, label: "scratch_read: length", note: "The description of scratch_read's length argument.", text: "How many characters to read, at most {{max}}.", vars: [v("max", "the most one read returns: Tool results clipped past")] },
  {
    id: TEXT.runtime.scratchPart,
    group: RUNTIME,
    label: "scratch_read: its answer",
    note: "What scratch_read returns.",
    text: `[Scratch {{handle}}, characters {{from}} to {{to}} of {{total}}.]
{{text}}`,
    vars: [v("handle", "the scratch handle read", true), v("from", "the first character returned"), v("to", "the character after the last one returned"), v("total", "the whole result's length"), v("text", "the characters read", true)]
  },
  { id: TEXT.runtime.scratchMissing, group: RUNTIME, label: "scratch_read: no such handle", note: "scratch_read's answer to a handle that doesn't exist.", text: "There's no scratch {{handle}}. Scratch holds: {{handles}}. Give one of those as the handle.", vars: [v("handle", "the handle asked for"), v("handles", "the handles there are, or none")] },
  {
    id: TEXT.runtime.clipped,
    group: RUNTIME,
    label: "A clipped tool result",
    note: "Follows the part of a long tool result that reaches the model.",
    text: "[Clipped: the first {{shown}} of {{total}} characters. The rest is in scratch {{handle}}; read it with scratch_read from offset {{shown}}.]",
    vars: [v("shown", "the characters shown"), v("total", "the result's length"), v("handle", "where the whole result waits", true)]
  },
  { id: TEXT.runtime.unknownTool, group: RUNTIME, label: "A tool that doesn't exist", note: "The result of a call to a tool the agent wasn't given.", text: "There's no tool {{name}}. The tools are: {{tools}}. Call one of those.", vars: [v("name", "the name the model called"), v("tools", "the agent's tools")] },
  { id: TEXT.runtime.toolFailed, group: RUNTIME, label: "A tool that failed", note: "The result of a tool call that failed.", text: "{{name}} failed: {{error}}", vars: [v("name", "the tool"), v("error", "why", true)] },
  {
    id: TEXT.runtime.tooManyCalls,
    group: RUNTIME,
    label: "Too many calls in one answer",
    note: "The result of each call past Tool calls per answer.",
    text: "Not run: one answer may call at most {{limit}} {{tools}}. Call {{name}} again in your next answer if you still need it.",
    vars: [v("limit", "Tool calls per answer"), v("tools", '"tool" for 1, else "tools"'), v("name", "the tool not run")]
  },
  {
    id: TEXT.runtime.toolsInText,
    group: RUNTIME,
    label: "Tools offered as text",
    note: "Follows an agent's instructions on a connection that refuses native tools, offering them as text instead.",
    text: `You can use tools. To call one, write a block like this and stop there:
<tool_call>{"name": "the tool's name", "arguments": {"an argument": "its value"}}</tool_call>
Write several blocks to call several tools. The results come back in the next message. Once you have what you need, answer with no tool call.

The tools:
{{tools}}`,
    vars: [v("tools", "each tool, as Each tool offered as text writes it", true)]
  },
  { id: TEXT.runtime.toolInText, group: RUNTIME, label: "Each tool offered as text", note: "One tool in Tools offered as text.", text: `{{name}}: {{description}}
Arguments (JSON Schema): {{parameters}}`, vars: [v("name", "the tool's name", true), v("description", "what it does"), v("parameters", "its arguments' JSON Schema")] },
  { id: TEXT.runtime.toolResults, group: RUNTIME, label: "Tool results sent as text", note: "The message that brings tool calls written as text their results.", text: `Results of your tool calls:

{{results}}`, vars: [v("results", "each result, as A tool result as text writes it", true)] },
  { id: TEXT.runtime.toolResult, group: RUNTIME, label: "A tool result as text", note: "One result in Tool results sent as text.", text: `<tool_result name="{{name}}">
{{result}}
</tool_result>`, vars: [v("name", "the tool"), v("result", "its result", true)] },
  { id: TEXT.runtime.toolError, group: RUNTIME, label: "A failed tool result as text", note: "One failed result in Tool results sent as text.", text: `<tool_result name="{{name}}" error="true">
{{error}}
</tool_result>`, vars: [v("name", "the tool"), v("error", "why it failed", true)] },
  { id: TEXT.runtime.cacheNonce, group: RUNTIME, label: "Cache key", note: "Heads an agent's prompt while Settings hold a cache key, so the provider's cached prompt no longer matches.", text: "Cache key {{nonce}}; ignore it.", vars: [v("nonce", "the key", true)] }
];
var STOP_TEXTS = [
  stop(TEXT.stop.cancelled, "Cancelled", "The agent was cancelled: the turn was stopped, or whoever started it stopped it.", "the agent was cancelled"),
  stop(TEXT.stop.busy, "Still working", "A message sent while the agent still works on its last one.", "the agent is still working on its last message"),
  stop(TEXT.stop.revisions, "Out of revisions", "A message after its first answer, once it has had every revision its budget allows (Revisions).", "it has had the {{revisions}} it may have after its first answer (Revisions)", [v("revisions", 'the revisions it may have, with the word: "2 revisions"', true)]),
  stop(TEXT.stop.wallTime, "Out of time", "The agent's own time ran out (Time per agent).", "the agent's time ran out (Time per agent)"),
  stop(TEXT.stop.turnTime, "The turn out of time", "The turn's time ran out (Time per turn).", "the turn's time ran out (Time per turn)"),
  stop(TEXT.stop.callTime, "A call too slow", "One call took longer than Time per call.", "the call took longer than Time per call"),
  stop(TEXT.stop.callTokensIn, "A prompt too long", "A call whose prompt, as estimated, is past Prompt per call.", "the call's prompt, about {{tokens}}, is past Prompt per call ({{limit}})", [v("tokens", `the prompt's estimate, with the word: "9000 tokens"`, true), v("limit", "Prompt per call", true)]),
  stop(TEXT.stop.tokensIn, "The agent's prompt tokens spent", "A call that would take the agent's prompt tokens past Prompt tokens per agent.", "the call would take the agent's prompt tokens past {{limit}} (Prompt tokens per agent)", [v("limit", "Prompt tokens per agent", true)]),
  stop(TEXT.stop.tokensOut, "The agent's answer tokens spent", "The agent has written all Answer tokens per agent allows.", "the agent has written its {{tokens}} (Answer tokens per agent)", [v("tokens", 'Answer tokens per agent, with the word: "4000 tokens"', true)]),
  stop(TEXT.stop.turnTokensIn, "The turn's prompt tokens spent", "A call that would take the turn's prompt tokens past Prompt tokens per turn.", "the call would take the turn's prompt tokens past {{limit}} (Prompt tokens per turn)", [v("limit", "Prompt tokens per turn", true)]),
  stop(TEXT.stop.turnTokensOut, "The turn's answer tokens spent", "The turn's agents have written all Answer tokens per turn allows.", "the turn's agents have written its {{tokens}} (Answer tokens per turn)", [v("tokens", 'Answer tokens per turn, with the word: "20000 tokens"', true)]),
  stop(TEXT.stop.loop, "The loop detector", "The agent called one tool with the same arguments as many times in a row as the loop detector allows.", "the agent called {{tool}} with the same arguments {{times}} in a row (Loop detector)", [v("tool", "the tool's name", true), v("times", 'how many times, with the word: "3 times"', true)]),
  stop(TEXT.stop.toolTurns, "The agent's tool rounds spent", "The agent has had every round of tool calls Tool rounds per agent allows.", "the agent has had its {{rounds}} of tool calls (Tool rounds per agent)", [v("rounds", 'Tool rounds per agent, with the word: "8 rounds"', true)]),
  stop(TEXT.stop.turnToolTurns, "The turn's tool rounds spent", "The turn's agents have had every round of tool calls Tool rounds per turn allows.", "the turn's agents have had its {{rounds}} of tool calls (Tool rounds per turn)", [v("rounds", 'Tool rounds per turn, with the word: "40 rounds"', true)]),
  stop(TEXT.stop.failed, "A call failed", "A call that failed: the connection's or Lumiverse's error, as it gave it; words of your own may go around it.", "{{error}}", [v("error", "the error, as the connection or Lumiverse gave it", true)]),
  stop(TEXT.stop.throttle, "Past a connection's throttle", "A call that needs more tokens than its connection's throttle lets through in a minute.", "the call needs {{tokens}}, more than this connection's throttle lets through in a minute ({{limit}})", [v("tokens", 'the tokens the call needs, with the word: "9000 tokens"', true), v("limit", "the tokens the throttle lets through in a minute", true)]),
  stop(TEXT.stop.connectionUnread, "A connection that couldn't be read", "The agent's connection couldn't be read from Lumiverse.", "the connection {{connection}} couldn't be read ({{error}}): check that the runtime is linked, then try again", [v("connection", "the connection's id; empty for the default connection"), v("error", "why", true)]),
  stop(TEXT.stop.noDefault, "No default connection", "The agent runs on your default connection, and Lumiverse has none.", "there is no default connection: choose one in Lumiverse, or give this agent a connection in LumiAH's Settings"),
  stop(TEXT.stop.noConnection, "A connection that is gone", "The agent's connection isn't among your connections any more.", "the connection {{connection}} no longer exists: give this agent another in LumiAH's Settings", [v("connection", "the connection's id", true)]),
  stop(TEXT.stop.loopback, "The loopback connection", "The agent is set to run on the loopback connection, whose calls come back to LumiAH itself.", "the connection {{connection}} is LumiAH's own loopback: a call on it would come straight back here. Give this agent a connection to a model in LumiAH's Settings", [v("connection", "the connection's name", true)])
];
var MAIN_TEXTS = [
  {
    id: TEXT.main.system,
    group: MAIN,
    label: "Instructions",
    note: "The main agent's instructions while a separate writer writes the reply (Who writes the reply: the writer).",
    text: [
      "You are the main agent behind a roleplay chat in Lumiverse. The user never reads you: they read the reply. Each turn a reply is needed. Your work is to find out what that reply needs and hand it to the writer, who writes the prose from the same prompt Lumiverse assembled, plus your brief.",
      `What you are given each turn:
- The request: every message Lumiverse assembled for this reply, numbered, in order. A message marked as a preset instruction is the preset author's: the reply must achieve it. The rest is context: the character, the persona, the lore Lumiverse activated, and the chat's recent messages, ending with what the user just sent.
- Your notes: what you did on your earlier turns in this chat, as a summary of the older ones and a receipt of each turn since. They are yours, not the story's. past_turn reads an earlier turn of yours in full.`,
      `How to work:
- Decide what this reply turns on: who is present, what was promised or left open, what the lore says about what is in play, and what the preset's instructions ask of this reply in particular.
- Use your tools for what the request doesn't show. chat_search, chat_grep and chat_read reach every message of the chat, those too old to be in the request among them. lore_index, lore_search, lore_grep and lore_read reach every entry of the world books that apply, those Lumiverse didn't activate among them; active_lore lists the ones it did. preset_instructions lists the preset's instruction blocks.
- Call several tools in one answer when none of them depends on another's result. Don't read again what the request already shows. A result that says it was clipped, or that there is more, names the handle or the cursor to read on with.
- Stop looking once you have what the reply needs. Most replies need little.`,
      "Then call write_reply with your brief. The writer already has the whole prompt, so give it only what it would miss or get wrong without you: facts to keep straight (names, places, who knows what, what happened before), lore that bears on this moment, the thread to pick up, an instruction the last replies drifted from. Be specific, quote exact wording where it matters, and keep it short. Don't write the reply's prose, and don't restate the preset. When the prompt already holds everything, say so in one line. write_reply ends your turn. If you answer without calling it, your answer is taken as the brief."
    ].join(`

`),
    vars: []
  },
  {
    id: TEXT.main.systemWrites,
    group: MAIN,
    label: "Instructions, when it writes the reply itself",
    note: "The main agent's instructions while it writes the reply itself (Who writes the reply: the main agent).",
    text: [
      "You are the main agent behind a roleplay chat in Lumiverse. Each turn a reply is needed, and you write it. The user reads only your final answer.",
      `What you are given each turn:
- The request: every message Lumiverse assembled for this reply, numbered, in order. A message marked as a preset instruction is the preset author's: the reply must achieve it. The rest is context: the character, the persona, the lore Lumiverse activated, and the chat's recent messages, ending with what the user just sent.
- Your notes: what you did on your earlier turns in this chat, as a summary of the older ones and a receipt of each turn since. They are yours, not the story's. past_turn reads an earlier turn of yours in full.`,
      `How to work:
- Decide what this reply turns on: who is present, what was promised or left open, what the lore says about what is in play, and what the preset's instructions ask of this reply in particular.
- Use your tools for what the request doesn't show. chat_search, chat_grep and chat_read reach every message of the chat, those too old to be in the request among them. lore_index, lore_search, lore_grep and lore_read reach every entry of the world books that apply, those Lumiverse didn't activate among them; active_lore lists the ones it did. preset_instructions lists the preset's instruction blocks.
- Call several tools in one answer when none of them depends on another's result. Don't read again what the request already shows. A result that says it was clipped, or that there is more, names the handle or the cursor to read on with.
- Stop looking once you have what the reply needs. Most replies need little.`,
      "Then answer with the reply itself. Your final answer, the one with no tool call, goes to the user exactly as you write it: no notes, no preamble, nothing about your tools or your work. It must achieve every preset instruction in the request, in the form they ask for."
    ].join(`

`),
    vars: []
  },
  {
    id: TEXT.main.turn,
    group: MAIN,
    label: "A turn's message",
    note: "What the main agent is sent each turn: why a reply is needed, anything that changed about its notes, the request, and what to do.",
    text: `{{kind}}

{{notes}}The request, as Lumiverse assembled it for this reply ({{count}}, in order):

{{request}}

{{ask}}`,
    vars: [v("kind", "why a reply is needed, in the words below", true), v("notes", "what changed about its notes since its last turn, each ending in a blank line; nothing when nothing did"), v("count", 'how many messages the request has, with the word: "42 messages"'), v("request", "the request's messages, each framed as below", true), v("ask", "what to do with it, in the words below", true)]
  },
  { id: TEXT.main.kindNew, group: MAIN, label: "Why: a new reply", note: "Fills {{kind}} for a new reply.", text: "The user sent a message: a reply is needed.", vars: [] },
  { id: TEXT.main.kindRegenerate, group: MAIN, label: "Why: a regenerate", note: "Fills {{kind}} when the user regenerated the reply.", text: "The user asked for this reply again (a regenerate): the last one is gone, and a new reply is needed in its place.", vars: [] },
  { id: TEXT.main.kindSwipe, group: MAIN, label: "Why: a swipe", note: "Fills {{kind}} when the user swiped for another reply.", text: "The user asked for another version of this reply (a swipe): the earlier versions stay beside it, and a different reply is needed.", vars: [] },
  { id: TEXT.main.kindContinue, group: MAIN, label: "Why: a continue", note: "Fills {{kind}} when the user continued the last reply.", text: "The user asked to continue the last reply: the request ends with it, and the new text carries on from where it stops.", vars: [] },
  { id: TEXT.main.ask, group: MAIN, label: "What to do: brief the writer", note: "Fills {{ask}} while a separate writer writes the reply.", text: "Work out what this reply needs, then call write_reply with your brief.", vars: [] },
  { id: TEXT.main.askWrites, group: MAIN, label: "What to do: write the reply", note: "Fills {{ask}} while the main agent writes the reply itself.", text: "Work out what this reply needs, then answer with the reply itself.", vars: [] },
  { id: TEXT.main.noteDropped, group: MAIN, label: "Notes dropped", note: "Leads a turn's message when an earlier message of the chat was edited or deleted, so the notes of the turns after it no longer fit the chat.", text: "An earlier message of this chat was changed or removed, so your notes from {{replies}} no longer fit it and were dropped: you don't have them, and what they said may no longer be true.", vars: [v("replies", 'the replies whose notes were dropped: "reply #12" or "replies #12, #14"', true)] },
  { id: TEXT.main.noteRolledBack, group: MAIN, label: "A summary rolled back", note: "Leads a turn's message when the user rolled back a summary of its notes: the turns it summarized are read again.", text: "The user rolled back a summary of your notes: the turns it had replaced are back as their own receipts.", vars: [] },
  { id: TEXT.main.noteMissing, group: MAIN, label: "Notes missing", note: "Leads a turn's message when some stored notes couldn't be read.", text: "{{count}} of your stored notes couldn't be read and are left out.", vars: [v("count", 'how many, with the word: "2 parts"', true)] },
  { id: TEXT.main.noteSummary, group: MAIN, label: "Notes summarized, nothing after", note: "Leads a turn's message with the summary of the main agent's notes when no turn's receipt follows it.", text: "{{summary}}", vars: [v("summary", "the summary, framed as The summary frames it", true)] },
  { id: TEXT.main.noteContinued, group: MAIN, label: "The turn continued", note: "Leads a turn's message when it continues a reply the main agent already worked on: what it did then.", text: `You already worked on this reply before it was continued. What you did then:
{{receipt}}`, vars: [v("receipt", "the receipt of that work", true)] },
  { id: TEXT.main.replyOne, group: MAIN, label: "Notes dropped: one reply", note: "Fills {{replies}} in Notes dropped, and in its progress line, when one reply's notes were dropped.", text: "reply {{list}}", vars: [v("list", `the reply's number: "#12"`, true)] },
  { id: TEXT.main.replyMany, group: MAIN, label: "Notes dropped: several replies", note: "Fills {{replies}} in Notes dropped, and in its progress line, when several replies' notes were dropped.", text: "replies {{list}}", vars: [v("list", `the replies' numbers: "#12, #14"`, true)] }
];
var REQUEST_TEXTS = [
  { id: TEXT.request.message, group: REQUEST, label: "A message", note: "One message of the request that isn't a preset instruction.", text: `[{{n}}] {{role}}{{from}}
{{text}}`, vars: [v("n", "its number in the request, from 1", true), v("role", "whose it is: system, user or assistant"), v("from", "where it came from, in the words below; nothing when that isn't known"), v("text", "its text", true)] },
  { id: TEXT.request.instruction, group: REQUEST, label: "A preset instruction", note: "One message of the request that is an instruction block of the preset: what the reply must achieve.", text: `[{{n}}] {{role}} \xB7 preset instruction \u201C{{name}}\u201D: the reply must achieve this
{{text}}`, vars: [v("n", "its number in the request, from 1", true), v("role", "whose it is: system, user or assistant"), v("name", "the block's name in the preset"), v("text", "its text", true)] },
  { id: TEXT.request.fromHistory, group: REQUEST, label: "From the chat", note: "Fills {{from}} for a message of the chat's history.", text: " \xB7 chat message #{{index}}{{name}}", vars: [v("index", "the message's number in the chat, as the chat tools take it", true), v("name", "who wrote it, after a comma; nothing when that isn't known")] },
  { id: TEXT.request.fromBlock, group: REQUEST, label: "From a preset block", note: "Fills {{from}} for a message from a preset block that the preset, as it reads now, no longer has.", text: " \xB7 preset block {{name}}", vars: [v("name", "the block's id", true)] },
  { id: TEXT.request.fromMarker, group: REQUEST, label: "From a marker", note: "Fills {{from}} for something Lumiverse put where a preset's marker stands: the character's description, World Info.", text: " \xB7 {{marker}}, placed by \u201C{{name}}\u201D", vars: [v("marker", "what Lumiverse put there, by the marker's own name", true), v("name", "the block's name in the preset")] },
  { id: TEXT.request.media, group: REQUEST, label: "Attached media", note: "Stands in a message's text for an image, audio or video it carries: the main agent is sent text only.", text: "[{{media}} attached]", vars: [v("media", "image, audio or video", true)] },
  { id: TEXT.request.empty, group: REQUEST, label: "An empty request", note: "The request when Lumiverse sent no messages.", text: "(the request holds no messages)", vars: [] }
];
var WRITER_TEXTS = [
  {
    id: TEXT.writer.brief,
    group: WRITER,
    label: "The brief",
    note: "The writer's instructions: how the main agent's brief is put to it, as one message among those Lumiverse assembled (where it goes, and as whose, are settings). Everything else the writer is sent is your preset's.",
    text: `[Notes for this reply, from a planner that has read the whole chat and its lore. Follow them where they bear on what you write; never mention them, and never quote them.]
{{brief}}`,
    vars: [v("brief", "the main agent's brief", true)]
  }
];
var SESSION_TEXTS = [
  { id: TEXT.session.summary, group: SESSION, label: "The summary", note: "Opens what the main agent carries once its notes were summarized: the summary stands for the turns it replaced.", text: `Your notes from this chat's earlier turns, summarized:
{{summary}}`, vars: [v("summary", "the summary", true)] },
  { id: TEXT.session.told, group: SESSION, label: "An earlier turn: what it was for", note: "How the main agent's notes say what an earlier turn of its was for. The request itself isn't kept: Lumiverse sends the chat with every request.", text: "Reply #{{reply}} ({{kind}}): a request of {{count}}, ending at chat message #{{last}}.", vars: [v("reply", "the reply's number in the chat", true), v("kind", "new, regenerate, swipe or continue"), v("count", 'how many messages the request had, with the word: "42 messages"'), v("last", "the last chat message the request held")] },
  { id: TEXT.session.toldUnplaced, group: SESSION, label: "An earlier turn, its request's end unknown", note: "As above, when no message of the request could be traced to the chat.", text: "Reply #{{reply}} ({{kind}}): a request of {{count}}.", vars: [v("reply", "the reply's number in the chat", true), v("kind", "new, regenerate, swipe or continue"), v("count", 'how many messages the request had, with the word: "42 messages"')] },
  { id: TEXT.session.receipt, group: SESSION, label: "A receipt", note: "What the main agent carries of an earlier turn of its own: each thing it did, one line or two each. past_turn reads the turn in full.", text: `What you did:
{{steps}}`, vars: [v("steps", "each step, as below", true)] },
  { id: TEXT.session.receiptCall, group: SESSION, label: "A receipt: a tool call", note: "One tool call in a receipt, with the start of its result.", text: `- {{tool}} {{args}}
  \u2192 {{result}}`, vars: [v("tool", "the tool", true), v("args", "its arguments, as JSON"), v("result", "the start of its result")] },
  { id: TEXT.session.receiptFailed, group: SESSION, label: "A receipt: a failed tool call", note: "One tool call that failed, in a receipt.", text: `- {{tool}} {{args}}
  \u2192 failed: {{result}}`, vars: [v("tool", "the tool", true), v("args", "its arguments, as JSON"), v("result", "the start of why it failed")] },
  { id: TEXT.session.receiptSaid, group: SESSION, label: "A receipt: something it wrote", note: "Something the main agent wrote beside its tool calls, in a receipt.", text: "- you noted: {{text}}", vars: [v("text", "the start of what it wrote", true)] },
  { id: TEXT.session.receiptReply, group: SESSION, label: "A receipt: it wrote the reply", note: "In a receipt, a turn whose reply the main agent wrote itself. The reply isn't kept: it is in the chat.", text: "- you wrote the reply yourself ({{chars}} characters; it is chat message #{{reply}})", vars: [v("chars", "the reply's length"), v("reply", "the reply's number in the chat")] },
  { id: TEXT.session.receiptStop, group: SESSION, label: "A receipt: it stopped short", note: "In a receipt, a turn the main agent didn't finish.", text: "- you stopped before you were done: {{reason}}", vars: [v("reason", "why", true)] },
  { id: TEXT.session.receiptClipped, group: SESSION, label: "A receipt: a clipped text", note: "Ends a text a receipt keeps only the start of (Receipt length).", text: "{{text}}\u2026 ({{chars}} characters in all; past_turn with reply {{reply}} reads it whole)", vars: [v("text", "the start of the text", true), v("chars", "its whole length"), v("reply", "the reply's number in the chat")] },
  { id: TEXT.session.receiptNothing, group: SESSION, label: "A receipt: nothing done", note: "A receipt of a turn in which the main agent did nothing on record.", text: "- nothing on record", vars: [] },
  { id: TEXT.session.replyWritten, group: SESSION, label: "write_reply's result, as kept", note: "What the main agent's notes keep in place of write_reply's result. The reply isn't kept: it is in the chat.", text: "the writer wrote the reply ({{chars}} characters; it is chat message #{{reply}})", vars: [v("chars", "the reply's length"), v("reply", "the reply's number in the chat")] },
  {
    id: TEXT.session.summarizer,
    group: SESSION,
    label: "Summarizer: instructions",
    note: "The instructions of the call that summarizes the main agent's notes once they pass Summarize past.",
    text: "You keep a main agent's notes short. The agent works behind a roleplay chat: each turn it looks things up and briefs a writer. You get the summary of its notes so far, if there is one, and the receipts of the turns that now fold into it. Write one summary the agent can keep working from: what the story's people, places and open threads are as its notes have them, what it looked up and found, what it told the writer to keep straight, and anything it noted for itself. Keep names, numbers and exact wording that matter as they are, and leave out what no later turn needs. The latest {{keep}} stay whole after your summary, so don't repeat them. Keep the summary under {{limit}} tokens, and finish it: a summary cut off is thrown away. Answer with the summary alone.",
    vars: [v("keep", 'how many of the latest turns stay whole, with the word: "3 turns"'), v("limit", "how long the summary may be, in tokens (Summary length)")]
  },
  { id: TEXT.session.summarizerInput, group: SESSION, label: "Summarizer: what it summarizes", note: "The summarizing call's message: the summary so far and the turns to fold into it.", text: `The summary so far:
{{summary}}

The turns to fold into it, oldest first:

{{turns}}`, vars: [v("summary", "the summary so far, or the text for nothing"), v("turns", "the turns to summarize, each framed as below", true)] },
  { id: TEXT.session.summarizerTurn, group: SESSION, label: "Summarizer: one turn", note: "One turn in what the summarizer is sent.", text: `{{told}}
{{receipt}}`, vars: [v("told", "what the turn was for", true), v("receipt", "its receipt", true)] },
  { id: TEXT.session.none, group: SESSION, label: "Nothing", note: "Stands in for a part that is empty.", text: "(none)", vars: [] },
  { id: TEXT.session.failedNothing, group: SESSION, label: "No summary: nothing answered", note: "Why the main agent's notes weren't summarized, when the summarizing call answered nothing.", text: "the summarizing call answered nothing", vars: [] },
  { id: TEXT.session.failedCut, group: SESSION, label: "No summary: cut off", note: "Why the notes weren't summarized, when the summary stopped at its limit.", text: "its summary was cut off at its limit (the summarizer's Answer per call)", vars: [] },
  { id: TEXT.session.failedMidSentence, group: SESSION, label: "No summary: mid-sentence", note: "Why the notes weren't summarized, when the summary stops mid-sentence.", text: "its summary stops mid-sentence", vars: [] }
];
var TOOL_TEXTS = [
  ...tool(TOOL.chatSearch, "Search this chat's messages by words, best match first: every message, those too old to be in the request among them. Each hit names its message and shows the excerpt that matched best; chat_read reads a message whole. The answer says how many it found and which it shows.", { query: "The words to look for. Names and rare words find the most.", cursor: CURSOR }),
  ...tool(TOOL.chatGrep, "Find every line of this chat that holds some exact text, in any letter case, oldest first, each with its message and line number. Use it for a name, a phrase or a number; use chat_search when you only know roughly what was said.", { text: "The text to find, as written; letter case doesn't matter.", cursor: CURSOR }),
  ...tool(TOOL.chatRead, "Read messages of this chat by their number, as the request and the other chat tools name them (#12): one message, or a run of them from one number to another. A long read comes a page at a time.", { from: "The first message to read, by its number.", to: "The last message to read, by its number; leave it out to read one message.", cursor: CURSOR }),
  ...tool(TOOL.loreIndex, "List the world books that apply to this chat, and each one's entries: an entry's id, its title, its keys and its length. Entries switched off are marked. Give book to list one book alone.", { book: "A book's id or name, to list that book alone.", cursor: CURSOR }),
  ...tool(TOOL.loreSearch, "Search the entries of this chat's world books by words, best match first: titles, keys and text, entries Lumiverse didn't activate among them. Each hit names its entry and shows the excerpt that matched best; lore_read reads an entry whole.", { query: "The words to look for.", cursor: CURSOR }),
  ...tool(TOOL.loreGrep, "Find every line of this chat's world books that holds some exact text, in any letter case, each with its entry and line number.", { text: "The text to find, as written; letter case doesn't matter.", cursor: CURSOR }),
  ...tool(TOOL.loreRead, "Read one entry of this chat's world books whole, by the id lore_index and the lore searches give. A long entry comes a page at a time.", { id: "The entry's id, as lore_index and the lore searches give it.", cursor: CURSOR }),
  ...tool(TOOL.activeLore, "List the lore entries Lumiverse activated for this reply: their text is already in the request. Use it to tell what the writer has from what it lacks.", { cursor: CURSOR }),
  ...tool(TOOL.presetInstructions, "List the active preset's instruction blocks in order, those switched off marked: what the preset's author tells the model, as written in the preset, before Lumiverse fills in its macros. Give block to read one whole.", { block: "A block's id or name, to read that block whole.", cursor: CURSOR }),
  ...tool(TOOL.pastTurn, "Read or search an earlier turn of yours in full: every tool call you made with what came back, and your brief, where your notes keep only a receipt. Without arguments it lists your turns. Give reply to list that turn's steps; add step to read one whole; give grep to find the lines that hold some text, in that turn or, without reply, in your latest turns.", { reply: "The reply's number in the chat, as your receipts name it (reply #12).", step: "Which of the turn's steps to read whole, by its number in the turn's list.", grep: "Text to find, in any letter case: every line that holds it, with its reply, step and line.", cursor: CURSOR }),
  ...tool(TOOL.writeReply, "Hand the writer your brief and have it write the reply, which goes to the user. This ends your turn: call it once, when you have what the reply needs, and call nothing else beside it.", { brief: "What the writer needs that the prompt doesn't already give it: facts to keep straight, lore that bears on this moment, the thread to pick up. Short and specific; no prose for the reply itself." })
];
var ANSWER_TEXTS = [
  { id: TEXT.answer.more, group: ANSWERS, label: "There is more", note: "Ends a tool's answer that has more to give.", text: '[There is more: call {{tool}} again with the same arguments and cursor "{{cursor}}".]', vars: [v("tool", "the tool"), v("cursor", "where the next page starts", true)] },
  { id: TEXT.answer.end, group: ANSWERS, label: "That is all", note: "Ends the last page of an answer that came in pages.", text: "[That is the end.]", vars: [] },
  { id: TEXT.answer.found, group: ANSWERS, label: "What a search found", note: "Heads a search's or a listing's answer: how many it found and which of them this page shows.", text: "{{total}} found; showing {{from}} to {{to}}.", vars: [v("total", 'how many it found, with the word: "37 messages"', true), v("from", "the first shown, counted from 1"), v("to", "the last shown")] },
  { id: TEXT.answer.chatSearchNothing, group: ANSWERS, label: "chat_search: nothing found", note: "chat_search's answer when no message matches, with what to try next.", text: "No message of this chat matches \u201C{{query}}\u201D. Try fewer or other words (names and rare words find the most), or chat_grep for an exact phrase.", vars: [v("query", "what was looked for", true)] },
  { id: TEXT.answer.chatGrepNothing, group: ANSWERS, label: "chat_grep: nothing found", note: "chat_grep's answer when no line holds the text, with what to try next.", text: "No line of this chat holds \u201C{{query}}\u201D. Try a shorter piece of it, or chat_search for the words in any order.", vars: [v("query", "what was looked for", true)] },
  { id: TEXT.answer.loreSearchNothing, group: ANSWERS, label: "lore_search: nothing found", note: "lore_search's answer when no entry matches, with what to try next.", text: "No lore entry matches \u201C{{query}}\u201D. Try fewer or other words, or lore_index to see what the books hold.", vars: [v("query", "what was looked for", true)] },
  { id: TEXT.answer.loreGrepNothing, group: ANSWERS, label: "lore_grep: nothing found", note: "lore_grep's answer when no line holds the text, with what to try next.", text: "No line of the lore holds \u201C{{query}}\u201D. Try a shorter piece of it, or lore_search for the words in any order.", vars: [v("query", "what was looked for", true)] },
  { id: TEXT.answer.pastGrepNothing, group: ANSWERS, label: "past_turn: grep found nothing", note: "past_turn's answer when no line of the turns it read holds the text.", text: "No line of {{where}} holds \u201C{{query}}\u201D. Try a shorter piece of it, or give reply to search one turn.", vars: [v("where", "the turns it read, in the words below"), v("query", "what was looked for", true)] },
  { id: TEXT.answer.pastWhereReply, group: ANSWERS, label: "past_turn: where it looked, one turn", note: "Fills {{where}} when the grep read one turn.", text: "reply #{{reply}}", vars: [v("reply", "the reply's number", true)] },
  { id: TEXT.answer.pastWhereLatest, group: ANSWERS, label: "past_turn: where it looked, the latest turns", note: "Fills {{where}} when the grep read the latest turns.", text: "your latest {{turns}}", vars: [v("turns", 'how many turns it read, with the word: "8 turns"', true)] },
  { id: TEXT.answer.badCursor, group: ANSWERS, label: "A cursor that isn't one", note: "The answer to a cursor the tool never gave.", text: "\u201C{{cursor}}\u201D isn't a cursor {{tool}} gave. Pass the cursor exactly as the last answer wrote it, or leave it out to start at the beginning.", vars: [v("cursor", "the cursor given", true), v("tool", "the tool")] },
  { id: TEXT.answer.needs, group: ANSWERS, label: "A missing argument", note: "The answer to a call that lacks an argument the tool can't do without.", text: "{{tool}} needs {{arg}}: {{what}} Call it again with {{arg}}.", vars: [v("tool", "the tool"), v("arg", "the argument's name", true), v("what", "what the argument is, from its description")] },
  { id: TEXT.answer.cut, group: ANSWERS, label: "An item cut to fit", note: "Ends an item too long for one page of a listing.", text: "{{text}}\u2026 (cut to fit)", vars: [v("text", "the start of the item", true)] },
  { id: TEXT.answer.chatHit, group: ANSWERS, label: "chat_search: a hit", note: "One message chat_search found.", text: "- #{{index}} ({{who}}, {{chars}} characters): {{excerpt}}", vars: [v("index", "the message's number", true), v("who", "who wrote it"), v("chars", "the message's length"), v("excerpt", "the excerpt that matched best")] },
  { id: TEXT.answer.chatLine, group: ANSWERS, label: "chat_grep: a line", note: "One line chat_grep found.", text: "- #{{index}} ({{who}}), line {{line}}: {{text}}", vars: [v("index", "the message's number", true), v("who", "who wrote it"), v("line", "the line's number in the message"), v("text", "the line, around what was found", true)] },
  { id: TEXT.answer.chatMessage, group: ANSWERS, label: "chat_read: a message", note: "One message, or the part of one a page holds, in chat_read's answer.", text: `#{{index}} ({{who}}), characters {{from}} to {{to}} of {{chars}}:
{{text}}`, vars: [v("index", "the message's number", true), v("who", "who wrote it"), v("from", "the first character shown"), v("to", "the character after the last shown"), v("chars", "the message's length"), v("text", "the text", true)] },
  { id: TEXT.answer.chatRead, group: ANSWERS, label: "chat_read: its answer", note: "Heads chat_read's answer.", text: "Chat messages #{{from}} to #{{to}} ({{count}} asked for):", vars: [v("from", "the first message asked for"), v("to", "the last message asked for"), v("count", "how many that is")] },
  { id: TEXT.answer.chatNoMessage, group: ANSWERS, label: "chat_read: no such message", note: "chat_read's answer to a number the chat doesn't have.", text: "There is no chat message #{{index}}: this turn reads messages #{{first}} to #{{last}}. Give a number in that range.", vars: [v("index", "the number asked for", true), v("first", "the first message's number"), v("last", "the last message's number")] },
  { id: TEXT.answer.chatEmpty, group: ANSWERS, label: "The chat is empty", note: "A chat tool's answer when the chat has no message before this reply.", text: "This chat has no messages before this reply, so there is nothing to read here. Work from the request.", vars: [] },
  { id: TEXT.answer.loreBook, group: ANSWERS, label: "lore_index: a book", note: "A book's heading in lore_index's answer.", text: "Book \u201C{{name}}\u201D [{{id}}], {{count}}{{description}}:", vars: [v("name", "the book's name", true), v("id", "the book's id"), v("count", 'how many entries it has, with the word: "12 entries"'), v("description", "its description, after a dash; nothing when it has none")] },
  { id: TEXT.answer.loreEntry, group: ANSWERS, label: "lore_index: an entry", note: "One entry in lore_index's answer.", text: "- [{{id}}] {{title}}{{flags}} \xB7 keys: {{keys}} \xB7 {{chars}} characters", vars: [v("id", "the entry's id, as lore_read takes it", true), v("title", "its title"), v("flags", "whether it is switched off, or always sent, in the words below"), v("keys", "its keys, or the text for nothing"), v("chars", "its length")] },
  { id: TEXT.answer.loreHit, group: ANSWERS, label: "lore_search: a hit", note: "One entry lore_search found.", text: "- [{{id}}] {{title}}{{flags}} (book \u201C{{book}}\u201D, {{chars}} characters): {{excerpt}}", vars: [v("id", "the entry's id, as lore_read takes it", true), v("title", "its title"), v("flags", "whether it is switched off, or always sent"), v("book", "its book's name"), v("chars", "its length"), v("excerpt", "the excerpt that matched best")] },
  { id: TEXT.answer.loreLine, group: ANSWERS, label: "lore_grep: a line", note: "One line lore_grep found.", text: "- [{{id}}] {{title}}, line {{line}}: {{text}}", vars: [v("id", "the entry's id, as lore_read takes it", true), v("title", "its title"), v("line", "the line's number in the entry"), v("text", "the line, around what was found", true)] },
  { id: TEXT.answer.loreRead, group: ANSWERS, label: "lore_read: its answer", note: "lore_read's answer: an entry, or the part of it a page holds.", text: `[{{id}}] {{title}}{{flags}} (book \u201C{{book}}\u201D) \xB7 keys: {{keys}} \xB7 characters {{from}} to {{to}} of {{chars}}:
{{text}}`, vars: [v("id", "the entry's id", true), v("title", "its title"), v("flags", "whether it is switched off, or always sent"), v("book", "its book's name"), v("keys", "its keys, or the text for nothing"), v("from", "the first character shown"), v("to", "the character after the last shown"), v("chars", "the entry's length"), v("text", "the text", true)] },
  { id: TEXT.answer.loreNoEntry, group: ANSWERS, label: "lore_read: no such entry", note: "lore_read's answer to an id no entry has.", text: "There is no lore entry {{id}} in the books that apply to this chat. Take an id from lore_index or a lore search, written as it gives it.", vars: [v("id", "the id asked for", true)] },
  { id: TEXT.answer.loreNoBook, group: ANSWERS, label: "lore_index: no such book", note: "lore_index's answer to a book that isn't among those that apply.", text: "No book \u201C{{book}}\u201D applies to this chat. The books are: {{books}}. Give one of those, or leave book out to list them all.", vars: [v("book", "the book asked for", true), v("books", "the books that apply, by name and id")] },
  { id: TEXT.answer.loreNoBooks, group: ANSWERS, label: "No world books", note: "A lore tool's answer when no world book applies to the chat.", text: "No world book applies to this chat, so there is no lore to read here. Work from the request.", vars: [] },
  { id: TEXT.answer.loreOff, group: ANSWERS, label: "An entry switched off", note: "Marks an entry that is switched off in its book, in the lore tools' answers.", text: " (switched off)", vars: [] },
  { id: TEXT.answer.loreAlways, group: ANSWERS, label: "An entry always sent", note: "Marks an entry its book always sends, in the lore tools' answers.", text: " (always sent)", vars: [] },
  { id: TEXT.answer.activeEntry, group: ANSWERS, label: "active_lore: an entry", note: "One entry in active_lore's answer.", text: "- [{{id}}] {{title}} (book \u201C{{book}}\u201D, {{chars}} characters): {{excerpt}}", vars: [v("id", "the entry's id, as lore_read takes it", true), v("title", "its title"), v("book", "its book's name"), v("chars", "the length of the text Lumiverse put in the prompt"), v("excerpt", "the start of that text")] },
  { id: TEXT.answer.activeNone, group: ANSWERS, label: "active_lore: none", note: "active_lore's answer when Lumiverse activated no entry.", text: "Lumiverse activated no lore entry for this reply. lore_search and lore_index reach the books that apply.", vars: [] },
  { id: TEXT.answer.presetBlock, group: ANSWERS, label: "preset_instructions: a block", note: "One instruction block in preset_instructions' answer.", text: "- [{{id}}] \u201C{{name}}\u201D ({{role}}{{flags}}, {{chars}} characters): {{excerpt}}", vars: [v("id", "the block's id", true), v("name", "its name in the preset"), v("role", "whose message it becomes"), v("flags", "that it is switched off, in the words below; nothing when it is on"), v("chars", "its length"), v("excerpt", "the start of its text")] },
  { id: TEXT.answer.presetRead, group: ANSWERS, label: "preset_instructions: a block read", note: "preset_instructions' answer for one block: its text, or the part a page holds.", text: `Preset instruction \u201C{{name}}\u201D [{{id}}] ({{role}}{{flags}}), characters {{from}} to {{to}} of {{chars}}:
{{text}}`, vars: [v("name", "the block's name", true), v("id", "its id"), v("role", "whose message it becomes"), v("flags", "that it is switched off; nothing when it is on"), v("from", "the first character shown"), v("to", "the character after the last shown"), v("chars", "the block's length"), v("text", "the text", true)] },
  { id: TEXT.answer.presetNoBlock, group: ANSWERS, label: "preset_instructions: no such block", note: "preset_instructions' answer to a block the preset doesn't have among its instructions.", text: "The preset has no instruction block \u201C{{block}}\u201D. Its instruction blocks are: {{blocks}}. Give one of those, or leave block out to list them.", vars: [v("block", "the block asked for", true), v("blocks", "the instruction blocks, by name and id")] },
  { id: TEXT.answer.presetNone, group: ANSWERS, label: "preset_instructions: none", note: "preset_instructions' answer when the preset has no instruction block, or the chat has no preset.", text: "This reply's preset has no instruction blocks to list. The instructions that reached the request are marked in it.", vars: [] },
  { id: TEXT.answer.presetOff, group: ANSWERS, label: "A block switched off", note: "Marks a block that is switched off in the preset, in preset_instructions' answers.", text: ", switched off", vars: [] },
  { id: TEXT.answer.pastTurns, group: ANSWERS, label: "past_turn: your turns", note: "Leads past_turn's answer without arguments: the turns it can read, one line each after it.", text: "Your earlier turns in this chat, oldest first. Give reply to list one turn's steps.", vars: [] },
  { id: TEXT.answer.pastTurnLine, group: ANSWERS, label: "past_turn: one turn", note: "One turn in past_turn's list of turns.", text: "- {{told}} You took {{count}}.", vars: [v("told", "what the turn was for", true), v("count", 'how many steps it took, with the word: "5 steps"')] },
  { id: TEXT.answer.pastTurn, group: ANSWERS, label: "past_turn: a turn's steps", note: "Leads past_turn's answer for a reply: what the turn was for; its steps follow, one line each.", text: `{{told}}
Its steps, in full as they were; read one whole with step:`, vars: [v("told", "what the turn was for", true)] },
  { id: TEXT.answer.pastStep, group: ANSWERS, label: "past_turn: one step", note: "One step in past_turn's list.", text: "{{n}}. {{what}} ({{chars}} characters): {{first}}", vars: [v("n", "its number in the turn", true), v("what", "what the step is: a tool call with its arguments, a note, the reply, a stop"), v("chars", "how long its text is"), v("first", "the start of its text")] },
  { id: TEXT.answer.pastRead, group: ANSWERS, label: "past_turn: a step read", note: "past_turn's answer for one step: its text, or the part a page holds.", text: `Reply #{{reply}}, step {{n}}: {{what}}, characters {{from}} to {{to}} of {{chars}}:
{{text}}`, vars: [v("reply", "the reply's number", true), v("n", "the step's number"), v("what", "what the step is"), v("from", "the first character shown"), v("to", "the character after the last shown"), v("chars", "how long its text is"), v("text", "the text", true)] },
  { id: TEXT.answer.pastLine, group: ANSWERS, label: "past_turn: a line found", note: "One line past_turn's grep found.", text: "- reply #{{reply}}, step {{n}}, line {{line}}: {{text}}", vars: [v("reply", "the reply's number", true), v("n", "the step's number"), v("line", "the line's number in the step"), v("text", "the line, around what was found", true)] },
  { id: TEXT.answer.pastNone, group: ANSWERS, label: "past_turn: no turns", note: "past_turn's answer when the main agent has no earlier turn in the chat.", text: "You have no earlier turn in this chat: this is your first, or your notes from before were dropped. Work from the request and your other tools.", vars: [] },
  { id: TEXT.answer.pastNoTurn, group: ANSWERS, label: "past_turn: no such turn", note: "past_turn's answer for a reply that is no turn of the main agent's.", text: "Reply #{{reply}} is no turn of yours on this chat. Your turns are replies {{replies}}. Give one of those.", vars: [v("reply", "the reply asked for", true), v("replies", "the replies that are")] },
  { id: TEXT.answer.pastNoStep, group: ANSWERS, label: "past_turn: no such step", note: "past_turn's answer for a step number the turn doesn't have.", text: "Reply #{{reply}} has {{count}}: give step 1 to {{last}}.", vars: [v("reply", "the reply's number", true), v("count", 'how many steps it has, with the word: "5 steps"'), v("last", "its last step's number")] },
  { id: TEXT.answer.pastSaid, group: ANSWERS, label: "past_turn: a note", note: "Names a step that is something the main agent wrote beside its tool calls.", text: "a note of yours", vars: [] },
  { id: TEXT.answer.pastCall, group: ANSWERS, label: "past_turn: a tool call", note: "Names a step that is a tool call: its text is what came back.", text: "{{tool}} {{args}}", vars: [v("tool", "the tool", true), v("args", "its arguments, as JSON")] },
  { id: TEXT.answer.pastFailed, group: ANSWERS, label: "past_turn: a failed tool call", note: "Names a step that is a tool call that failed.", text: "{{tool}} {{args}}, which failed", vars: [v("tool", "the tool", true), v("args", "its arguments, as JSON")] },
  { id: TEXT.answer.pastReply, group: ANSWERS, label: "past_turn: the reply", note: "Names the step in which the main agent wrote the reply itself. The reply isn't kept: it is in the chat.", text: "the reply, which you wrote yourself (not kept here: it is chat message #{{reply}}, {{chars}} characters)", vars: [v("reply", "the reply's number in the chat"), v("chars", "the reply's length")] },
  { id: TEXT.answer.pastStop, group: ANSWERS, label: "past_turn: a stop", note: "Names the step at which the main agent stopped short.", text: "where you stopped short", vars: [] },
  { id: TEXT.answer.loreAmbiguous, group: ANSWERS, label: "lore_read: an id that names several", note: "lore_read's answer to an id several entries start with.", text: "{{id}} names several entries: {{entries}}. Give more of the id.", vars: [v("id", "the id asked for", true), v("entries", "the entries it names, by id and title")] },
  { id: TEXT.answer.replyBusy, group: ANSWERS, label: "write_reply: already writing", note: "write_reply's answer to a second call while the writer is at work on the first.", text: "The writer is already writing this reply from your other write_reply call. Call write_reply once.", vars: [] },
  { id: TEXT.answer.replyFailed, group: ANSWERS, label: "write_reply: the writer failed", note: "write_reply's answer when the writer's call failed before any of the reply was sent.", text: "The writer couldn't write the reply: {{reason}}. Nothing was sent to the user. Call write_reply again to try once more.", vars: [v("reason", "why", true)] },
  { id: TEXT.answer.replyNoBrief, group: ANSWERS, label: "write_reply: no brief", note: "write_reply's answer to a call without a brief.", text: "write_reply needs brief: what the writer needs that the prompt doesn't already give it. When the prompt holds everything, say that in a line. Call write_reply again with brief.", vars: [] },
  { id: TEXT.answer.replyEmpty, group: ANSWERS, label: "write_reply: an empty reply", note: "Fills {{reason}} in The writer failed, and the turn's error, when the writer's model answered with nothing.", text: "its model answered with nothing", vars: [] }
];
var PROGRESS_TEXTS = [
  { id: TEXT.progress.session, group: PROGRESS, label: "Notes carried", note: "The first line a turn writes into the reply's thinking block: what the main agent carries from earlier turns.", text: "LumiAH: the main agent carries its notes from {{turns}}.", vars: [v("turns", 'how many earlier turns, with the word: "4 earlier turns"', true)] },
  { id: TEXT.progress.sessionSummary, group: PROGRESS, label: "Notes carried, after a summary", note: "The first line of a turn whose main agent carries a summary of its older turns.", text: "LumiAH: the main agent carries its notes from {{turns}}, after a summary of the ones before.", vars: [v("turns", 'how many earlier turns, with the word: "4 earlier turns"', true)] },
  { id: TEXT.progress.fresh, group: PROGRESS, label: "No notes yet", note: "The first line of a turn whose main agent carries nothing.", text: "LumiAH: the main agent starts without notes from earlier turns.", vars: [] },
  { id: TEXT.progress.dropped, group: PROGRESS, label: "Notes dropped", note: "A line for notes that no longer fit the chat.", text: "An earlier message changed, so its notes from {{replies}} were dropped.", vars: [v("replies", 'the replies: "reply #12" or "replies #12, #14"', true)] },
  { id: TEXT.progress.compacting, group: PROGRESS, label: "Summarizing", note: "A line while the main agent's notes are summarized.", text: "Summarizing its notes from {{turns}}\u2026", vars: [v("turns", 'how many turns fold into the summary, with the word: "6 turns"', true)] },
  { id: TEXT.progress.compacted, group: PROGRESS, label: "Summarized", note: "A line once the summary is made.", text: "Summarized {{folded}}; the latest {{kept}} stay whole.", vars: [v("folded", 'how many turns the summary took in, with the word: "6 turns"', true), v("kept", "how many stay whole")] },
  { id: TEXT.progress.notCompacted, group: PROGRESS, label: "Not summarized", note: "A line when the summary couldn't be made: the notes go on whole.", text: "Its notes weren't summarized ({{reason}}); they go on whole.", vars: [v("reason", "why", true)] },
  { id: TEXT.progress.call, group: PROGRESS, label: "A tool call", note: "A line for each tool the main agent calls.", text: "{{tool}} {{args}}", vars: [v("tool", "the tool", true), v("args", "its arguments, shortened")] },
  { id: TEXT.progress.writing, group: PROGRESS, label: "Writing", note: "A line when the writer starts on the reply.", text: "Writing the reply from the main agent's brief\u2026", vars: [] },
  { id: TEXT.progress.writingAlone, group: PROGRESS, label: "Writing without a brief", note: "A line when the writer starts with no brief, because the main agent stopped short of one.", text: "The main agent stopped before its brief ({{reason}}); the writer writes from your preset alone.", vars: [v("reason", "why the main agent stopped", true)] },
  { id: TEXT.progress.retry, group: PROGRESS, label: "Trying a call again", note: "A line each time a model call that failed in passing is made again, whichever of the turn's agents made it.", text: "A model call failed ({{reason}}); trying again, {{attempt}} of {{retries}}\u2026", vars: [v("reason", "the failure, in the provider's own words", true), v("attempt", "which try this is"), v("retries", "how many Settings allow")] },
  { id: TEXT.progress.stopped, group: PROGRESS, label: "Stopped", note: "A line when the turn ends without a reply.", text: "No reply: {{reason}}.", vars: [v("reason", "why", true)] },
  { id: TEXT.progress.turnStopped, group: PROGRESS, label: "Why: the turn was stopped", note: "The reason a turn gives when it was stopped before its agents could say why.", text: "the turn was stopped", vars: [] }
];
var WORD_TEXTS = [
  word(TEXT.word.message, "message", "messages"),
  word(TEXT.word.line, "line", "lines"),
  word(TEXT.word.entry, "entry", "entries"),
  word(TEXT.word.step, "step", "steps"),
  word(TEXT.word.turn, "turn", "turns"),
  word(TEXT.word.earlierTurn, "earlier turn", "earlier turns"),
  word(TEXT.word.part, "part", "parts"),
  word(TEXT.word.token, "token", "tokens"),
  word(TEXT.word.round, "round", "rounds"),
  word(TEXT.word.revision, "revision", "revisions"),
  word(TEXT.word.time, "time", "times"),
  word(TEXT.word.tool, "tool", "tools"),
  word(TEXT.word.block, "instruction block", "instruction blocks")
];
var TEXT_DEFS = [...MAIN_TEXTS, ...REQUEST_TEXTS, ...WRITER_TEXTS, ...SESSION_TEXTS, ...TOOL_TEXTS, ...ANSWER_TEXTS, ...RUNTIME_TEXTS, ...STOP_TEXTS, ...PROGRESS_TEXTS, ...WORD_TEXTS];
var BY_ID = new Map(TEXT_DEFS.map((d) => [d.id, d]));
var BRACES = /\{\{[\s\S]*?\}\}/g;
function placeholder(name) {
  return `{{${name}}}`;
}
function checkText(id, text) {
  const def = BY_ID.get(id);
  if (!def)
    return `There is no text "${id}".`;
  const missing = def.vars.filter((x) => x.required && !text.includes(placeholder(x.name)));
  if (missing.length > 0)
    return `It must keep ${missing.map((x) => `${placeholder(x.name)} (${x.text})`).join(" and ")}.`;
  const known = new Set(def.vars.map((x) => placeholder(x.name)));
  const unknown = [...new Set([...text.matchAll(BRACES)].map((m) => m[0]))].filter((token) => !known.has(token));
  if (unknown.length > 0)
    return def.vars.length > 0 ? `${unknown.join(", ")} isn't one of this text's placeholders (${def.vars.map((x) => placeholder(x.name)).join(", ")}).` : `${unknown.join(", ")} isn't a placeholder: this text has none.`;
  return null;
}
function fill(def, text, vars) {
  const names = new Set(def.vars.map((x) => x.name));
  return text.replace(BRACES, (token) => {
    const name = token.slice(2, -2);
    return names.has(name) && hasOwn(vars, name) ? vars[name] ?? "" : "";
  });
}
function defOf(id) {
  const def = BY_ID.get(id);
  if (!def)
    throw new Error(`LumiAH has no text "${id}"`);
  return def;
}
function renderDefault(id, vars = {}) {
  const def = defOf(id);
  return fill(def, def.text, vars);
}

class Texts {
  own;
  constructor(own = {}) {
    const kept = new Map;
    for (const [id, text] of Object.entries(own))
      if (typeof text === "string" && checkText(id, text) === null)
        kept.set(id, text);
    this.own = kept;
  }
  text(id) {
    return this.own.get(id) ?? defOf(id).text;
  }
  render(id, vars = {}) {
    return fill(defOf(id), this.text(id), vars);
  }
  noun(n, id) {
    const [one = "", many = one] = this.text(id).split("|");
    return n === 1 ? one : many;
  }
  counted(n, id) {
    return `${n} ${this.noun(n, id)}`;
  }
  replaced(id) {
    return this.own.has(id);
  }
}
function textsOf(own) {
  const texts = {};
  if (isRecord(own)) {
    for (const [id, text] of Object.entries(own))
      if (typeof text === "string")
        texts[id] = text;
  }
  return new Texts(texts);
}

// src/core/settings.ts
var AGENT = { main: "main", writer: "writer", summarizer: "summarizer" };
var MAIN_TOOLS = [TOOL.chatSearch, TOOL.chatGrep, TOOL.chatRead, TOOL.loreIndex, TOOL.loreSearch, TOOL.loreGrep, TOOL.loreRead, TOOL.activeLore, TOOL.presetInstructions, TOOL.pastTurn, TOOL.writeReply];
function defaultSettings() {
  const unlimited = { callTokensIn: null, callMs: null, callTools: null, tokensIn: null, tokensOut: null, wallMs: null };
  return {
    reply: { writer: "writer", briefAt: "before_last_user", briefRole: "system", withoutBrief: "write", progress: true, progressChars: 160 },
    agents: {
      [AGENT.main]: { connectionId: null, model: null, effort: "inherit", tools: [...MAIN_TOOLS], budget: { ...unlimited, callTokensOut: 16000, toolTurns: 24, revisions: 2, concurrency: 4 } },
      [AGENT.writer]: { connectionId: null, model: null, effort: "inherit", tools: [], budget: { ...unlimited, callTokensOut: 8192, toolTurns: 8, revisions: 1, concurrency: 4 } },
      [AGENT.summarizer]: { connectionId: null, model: null, effort: "inherit", tools: [], budget: { ...unlimited, callTokensOut: 16000, toolTurns: 4, revisions: 0, concurrency: 1 } }
    },
    turn: { tokensIn: null, tokensOut: null, toolTurns: null, wallMs: null },
    loop: { repeats: 3, clipChars: 6000, thinkingInToolLoops: true, stream: true, charsPerToken: 3.2, retries: 2, retryWaitMs: 2000 },
    cache: { breakpoints: true, key: "" },
    connections: { atOnce: null, throttles: {} },
    prices: {},
    session: { summarizeAtTokens: 32000, keepTurns: 3, summaryTokens: 6000, receiptChars: 600 },
    tools: { pageChars: 4000, pageItems: 10, lineChars: 300, excerptChars: 400, pieceChars: 600, chatBatch: 200, grepTurns: 40 },
    keep: { prompts: true, transcripts: true, blobChars: 4000000, summaries: 32 },
    trace: { deltaMs: 200 }
  };
}
function agentSettings(settings, id, fallback) {
  return hasOwn(settings.agents, id) ? settings.agents[id] ?? fallback : fallback;
}
var limit = (title, description, unit, minimum = 1) => ({ title, description, type: ["integer", "null"], minimum, "x-unit": unit, "x-none": "No limit" });
var whole = (title, description, minimum, unit, maximum) => ({ title, description, type: "integer", minimum, ...maximum !== undefined ? { maximum } : {}, ...unit !== undefined ? { "x-unit": unit } : {} });
var flag = (title, description) => ({ title, description, type: "boolean" });
var choice = (title, description, options) => ({ title, description, type: "string", oneOf: options.map(([value, name, about]) => ({ const: value, title: name, ...about !== undefined ? { description: about } : {} })) });
var EFFORTS = [
  ["inherit", "As the connection has it", "The connection's own reasoning setting, else yours in Lumiverse."],
  ["off", "Off"],
  ["auto", "Set by the model", "For a model that chooses its own effort."],
  ["minimal", "Minimal"],
  ["low", "Low"],
  ["medium", "Medium"],
  ["high", "High"],
  ["xhigh", "Extra high"],
  ["max", "Maximum"]
];
var BUDGET_SCHEMA = {
  title: "Budget",
  description: "What this agent may spend on one message it is sent. A limit that stops it says so in the live view.",
  type: "object",
  properties: {
    callTokensIn: limit("Prompt per call", "The most one call may send, in tokens, as estimated before it is sent. A call past it isn't made.", "tokens"),
    callTokensOut: whole("Answer per call", "The most one call may write, its reasoning included (max_tokens). The writer's is the request's own where the request names one.", 1, "tokens"),
    callMs: limit("Time per call", "How long one call may take before it is given up.", "ms"),
    callTools: limit("Tool calls per answer", "The most tools one answer may call. Calls past it aren't run, and the model is told.", "calls"),
    tokensIn: limit("Prompt tokens per agent", "The most all of its calls may send.", "tokens"),
    tokensOut: limit("Answer tokens per agent", "The most all of its calls may write.", "tokens"),
    toolTurns: limit("Tool rounds per agent", "The most answers that call tools. Past it the agent is stopped.", "rounds", 0),
    wallMs: limit("Time per agent", "How long it may work from the moment it is sent its first message.", "ms"),
    revisions: whole("Revisions", "Messages it may be sent after its first answer.", 0, "messages"),
    concurrency: whole("Tool calls at once", "How many of one answer's tool calls run at the same time.", 1, "calls")
  }
};
function agentSchema(title, description, noConnection, noModel, tools) {
  return {
    title,
    description,
    type: "object",
    properties: {
      connectionId: { title: "Connection", description: "The connection its calls go on. Never the loopback connection: its calls would come back to LumiAH.", type: ["string", "null"], format: "connection", "x-none": noConnection },
      model: { title: "Model", description: "A model of that connection to use instead of the connection's own.", type: ["string", "null"], format: "model", "x-none": noModel },
      effort: choice("Effort", "How hard its model reasons on each call.", EFFORTS),
      tools: { title: "Tools", description: "The tools it is given. scratch_read comes with any of them, for results that come back clipped.", type: "array", items: { type: "string", enum: [...tools] }, uniqueItems: true },
      budget: BUDGET_SCHEMA
    }
  };
}
var price = (title, description) => ({ title, description, type: "number", minimum: 0, "x-unit": "USD per million tokens" });
var CORE_SCOPE = { tools: MAIN_TOOLS, agents: [] };
function agentsSchema(scope) {
  return {
    title: "Agents",
    description: "What each agent runs with. Its instructions are among the texts.",
    type: "object",
    properties: {
      [AGENT.main]: agentSchema("Main agent", "Works out what each reply needs, with tools, then briefs the writer or writes the reply itself.", "Your default connection", "The connection's own", scope.tools),
      [AGENT.writer]: agentSchema("Writer", "Writes the reply from the prompt Lumiverse assembled and the main agent's brief. Its sampling and answer length are your preset's. It has no tools unless you give it some; with tools, whatever it writes beside its calls is part of the reply.", "Your default connection", "The connection's own", scope.tools),
      [AGENT.summarizer]: agentSchema("Summarizer", "Summarizes the main agent's notes once they grow past Summarize past. With no connection of its own it runs where the main agent does.", "The main agent's", "The main agent's, or its own connection's", scope.tools),
      ...Object.fromEntries(scope.agents.map((a) => [a.id, agentSchema(a.label, a.note, "Your default connection", "The connection's own", scope.tools)]))
    }
  };
}
var SETTINGS_SCHEMA = {
  title: "LumiAH",
  type: "object",
  properties: {
    reply: {
      title: "The reply",
      description: "Who writes the reply, and how the main agent's brief reaches the writer.",
      type: "object",
      properties: {
        writer: choice("Who writes the reply", "A separate writer keeps your preset in charge of the prose. The main agent writing it itself saves a call.", [
          ["writer", "The writer", "The main agent hands a brief to the writer, whose call is the prompt Lumiverse assembled with the brief put in."],
          ["main", "The main agent", "The main agent's final answer is the reply. There is no second call."]
        ]),
        briefAt: choice("Where the brief goes", "Where the brief is put among the messages Lumiverse assembled.", [
          ["before_last_user", "Before your last message", "Just before the last message of yours in the prompt, so whatever your preset puts after it stays last."],
          ["end", "At the end", "After every message of the prompt."],
          ["start", "At the start", "Before every message of the prompt."]
        ]),
        briefRole: choice("The brief is sent as", "Whose message the brief is.", [
          ["system", "A system message"],
          ["user", "A user message"]
        ]),
        withoutBrief: choice("If the main agent stops short", "What happens when a limit or a failed call stops the main agent before its brief.", [
          ["write", "Write the reply anyway", "The writer writes from the prompt Lumiverse assembled alone, as it would without LumiAH, and the thinking block says why."],
          ["fail", "Fail the turn", "No reply is written, and the error says why."]
        ]),
        progress: flag("Progress lines", "Write what the main agent is doing into the reply's thinking block as it works."),
        progressChars: whole("Progress line length", "The most characters one progress line holds.", 20, "characters")
      }
    },
    agents: agentsSchema(CORE_SCOPE),
    turn: {
      title: "The turn",
      description: "What every agent of one turn may spend together.",
      type: "object",
      properties: {
        tokensIn: limit("Prompt tokens per turn", "The most all of a turn's calls may send.", "tokens"),
        tokensOut: limit("Answer tokens per turn", "The most all of a turn's calls may write.", "tokens"),
        toolTurns: limit("Tool rounds per turn", "The most answers that call tools, over every agent of the turn.", "rounds", 0),
        wallMs: limit("Time per turn", "How long a turn's agents may work from the moment the turn starts.", "ms")
      }
    },
    loop: {
      title: "The agent loop",
      type: "object",
      properties: {
        repeats: whole("Loop detector", "An agent that makes the same tool call, on the same state, this many times in a row is stopped.", 2, "calls"),
        clipChars: whole("Tool results clipped past", "A tool result longer than this reaches the model clipped; scratch_read reads the rest.", 200, "characters"),
        thinkingInToolLoops: flag("Thinking in tool loops", "Let a model reason on calls that offer tools. Turn it off for a connection that fails when a reasoning model's thinking must be sent back after a tool call."),
        stream: flag("Streaming", "Take every answer as the provider streams it, so a long answer's connection is never idle. The writer's reply streams either way."),
        charsPerToken: { title: "Characters per token", description: "For token estimates made before a provider reports its own count: budgets, and the length of the main agent's notes.", type: "number", minimum: 1, maximum: 8 },
        retries: whole("Retries", "A model call that fails in passing (a timeout, a rate limit, a provider error in the 500s, a stream that drops) is made again up to this many times, each shown in the live view. Never once part of the reply has reached you, and never a call one of your own limits stopped. 0 turns retries off.", 0, "retries"),
        retryWaitMs: whole("Wait before a retry", "How long to wait before a failed call is made again. The agent's and the turn's time limits still run while it waits.", 0, "ms", TIMER_MAX_MS)
      }
    },
    cache: {
      title: "Prompt caching",
      type: "object",
      properties: {
        breakpoints: flag("Cache breakpoints", "Mark the stable start of each agent's prompt for providers that take explicit cache breakpoints, within the provider's limit."),
        key: { title: "Cache key", description: "Text put at the head of every agent's prompt. Change it to make a provider's cached prompts miss; leave it empty to send none. The writer's prompt is your preset's alone and never carries it.", type: "string", maxLength: 64 }
      }
    },
    connections: {
      title: "Connections",
      description: "How fast agents may call each connection.",
      type: "object",
      properties: {
        atOnce: limit("Calls at once", "Calls under way at once on any connection whose own throttle sets none. A call past it waits.", "calls"),
        throttles: {
          title: "Throttles",
          description: "Per connection. A call past a limit waits for the minute to have room.",
          type: "object",
          "x-keys": "connection",
          additionalProperties: {
            type: "object",
            default: { requestsPerMinute: null, tokensPerMinute: null, atOnce: null },
            properties: {
              requestsPerMinute: limit("Requests per minute", "The most calls sent in any one minute.", "requests"),
              tokensPerMinute: limit("Tokens per minute", "The most tokens sent and written in any one minute.", "tokens"),
              atOnce: limit("Calls at once", "Calls under way at once on this connection.", "calls")
            }
          }
        }
      }
    },
    prices: {
      title: "Prices",
      description: "Per model. Where a provider reports no cost, a call's cost is worked out from these and shown as an estimate.",
      type: "object",
      "x-keys": "model",
      additionalProperties: {
        type: "object",
        default: { in: 0, cachedIn: 0, out: 0 },
        properties: {
          in: price("Prompt", "What a million tokens sent cost."),
          cachedIn: price("Cached prompt", "What a million tokens read from the provider's cache cost."),
          out: price("Answer", "What a million tokens written cost.")
        }
      }
    },
    session: {
      title: "The main agent's notes",
      description: "What the main agent carries from turn to turn, and when it is summarized.",
      type: "object",
      properties: {
        summarizeAtTokens: limit("Summarize past", "Once the notes pass this many tokens, the older turns are summarized. The summarized turns are kept, so a rollback on the Sessions page brings them back.", "tokens"),
        keepTurns: whole("Recent turns kept whole", "The latest turns that stay as they are after a summary.", 0, "turns"),
        summaryTokens: whole("Summary length", "How long a summary may be, as its instructions ask.", 100, "tokens"),
        receiptChars: whole("Receipt length", "How much of each tool result the notes keep of a past turn. past_turn reads the whole.", 0, "characters")
      }
    },
    tools: {
      title: "Tool answers",
      description: "How much one tool answer holds. A longer one comes in pages, each naming the cursor for the next.",
      type: "object",
      properties: {
        pageChars: whole("Answer length", "The most characters one tool answer holds. Keep it under Tool results clipped past, so answers are paged and not clipped.", 200, "characters"),
        pageItems: whole("Hits per page", "The most hits or lines one page of a search or a listing shows.", 1, "items"),
        lineChars: whole("Line length", "A line a grep found is shown at most this long, around what it found.", 40, "characters"),
        excerptChars: whole("Excerpt length", "A search hit's excerpt, at most.", 40, "characters"),
        pieceChars: whole("Search piece", "A text is indexed for search in pieces of about this size; a hit shows the piece that matched best.", 100, "characters"),
        chatBatch: whole("Chat read batch", "Messages read from the chat in one request to Lumiverse.", 1, "messages"),
        grepTurns: whole("Turns a grep reads", "How many of the main agent's latest turns past_turn searches when no reply is named.", 1, "turns")
      }
    },
    keep: {
      title: "What is kept",
      type: "object",
      properties: {
        prompts: flag("Exact prompts", "Store each model call's exact prompt, for the live view and the Sessions page."),
        transcripts: flag("Transcripts", "Store each turn's transcript, for the Sessions page."),
        blobChars: whole("Texts in memory", "Characters of stored texts the runtime keeps in memory once read.", 0, "characters"),
        summaries: whole("Summaries in memory", "Summaries the runtime remembers, so a swipe of a turn that summarized makes no second call.", 0, "summaries")
      }
    },
    trace: {
      title: "The live view",
      type: "object",
      properties: {
        deltaMs: whole("Live answer every", "While a model's answer streams, the live view is sent what has arrived at most once in this long, so you watch it being written. 0 turns it off: the view then shows each answer once it is whole.", 0, "ms")
      }
    }
  }
};
function typesOf(schema) {
  const type = schema.type;
  return Array.isArray(type) ? type.filter((t) => typeof t === "string") : typeof type === "string" ? [type] : [];
}
function allowed(schema) {
  if (Array.isArray(schema.enum))
    return schema.enum;
  if (Array.isArray(schema.oneOf))
    return schema.oneOf.flatMap((option) => isRecord(option) && option.const !== undefined ? [option.const] : []);
  return null;
}
function clone(value) {
  return JSON.parse(JSON.stringify(value));
}
function read(schema, fallback, value, path, problems) {
  if (value === undefined)
    return clone(fallback);
  const refuse = (message) => {
    problems.push({ path, message });
    return clone(fallback);
  };
  const types = typesOf(schema);
  if (value === null)
    return types.includes("null") ? null : refuse("It can't be none.");
  if (types.includes("object")) {
    if (!isRecord(value))
      return refuse("It must be a group of settings.");
    const out = {};
    if (isRecord(schema.properties)) {
      const base = isRecord(fallback) ? fallback : {};
      for (const [key, node] of Object.entries(schema.properties))
        if (isRecord(node))
          out[key] = read(node, base[key] ?? null, value[key], [...path, key], problems);
      for (const key of Object.keys(value))
        if (!hasOwn(schema.properties, key))
          problems.push({ path: [...path, key], message: "There is no such setting." });
      return out;
    }
    const row = isRecord(schema.additionalProperties) ? schema.additionalProperties : null;
    if (!row)
      return refuse("It can't be set.");
    for (const [key, item] of Object.entries(value)) {
      if (key.trim() === "")
        problems.push({ path: [...path, key], message: "A row needs a name." });
      else
        out[key] = read(row, row.default ?? null, item, [...path, key], problems);
    }
    return out;
  }
  if (types.includes("array")) {
    if (!Array.isArray(value))
      return refuse("It must be a list.");
    const items = isRecord(schema.items) ? schema.items : {};
    const choices = allowed(items);
    const out = [];
    value.forEach((item, i) => {
      if (typeof item !== "string")
        problems.push({ path: [...path, i], message: "It must be text." });
      else if (choices && !choices.includes(item))
        problems.push({ path: [...path, i], message: `It must be one of: ${choices.join(", ")}.` });
      else if (schema.uniqueItems === true && out.includes(item))
        problems.push({ path: [...path, i], message: "It is listed twice." });
      else
        out.push(item);
    });
    return out;
  }
  if (types.includes("boolean"))
    return typeof value === "boolean" ? value : refuse("It must be on or off.");
  if (types.includes("integer") || types.includes("number")) {
    if (typeof value !== "number" || !Number.isFinite(value))
      return refuse("It must be a number.");
    if (types.includes("integer") && !Number.isSafeInteger(value))
      return refuse("It must be a whole number.");
    if (typeof schema.minimum === "number" && value < schema.minimum)
      return refuse(`It must be at least ${schema.minimum}.`);
    if (typeof schema.maximum === "number" && value > schema.maximum)
      return refuse(`It must be at most ${schema.maximum}.`);
    return value;
  }
  if (types.includes("string")) {
    if (typeof value !== "string")
      return refuse("It must be text.");
    const choices = allowed(schema);
    if (choices && !choices.includes(value))
      return refuse(`It must be one of: ${choices.join(", ")}.`);
    if (typeof schema.maxLength === "number" && value.length > schema.maxLength)
      return refuse(`It must be at most ${schema.maxLength} characters.`);
    return value;
  }
  return refuse("It can't be set.");
}
function settingsSchema(scope) {
  return { ...SETTINGS_SCHEMA, properties: { ...SETTINGS_SCHEMA.properties, agents: agentsSchema(scope) } };
}
function shapeOf(scope) {
  const defaults = defaultSettings();
  if (!scope)
    return { schema: SETTINGS_SCHEMA, defaults };
  for (const a of scope.agents)
    defaults.agents[a.id] ??= a.defaults;
  return { schema: settingsSchema(scope), defaults };
}
function settingsOf(values, scope) {
  const { schema, defaults } = shapeOf(scope);
  return read(schema, defaults, isRecord(values) ? values : {}, [], []);
}

// src/core/agents.ts
function baseAgents() {
  const defaults = defaultSettings().agents;
  const of = (id) => defaults[id];
  return [
    { id: AGENT.main, instructions: TEXT.main.system, defaults: of(AGENT.main) },
    { id: AGENT.writer, instructions: TEXT.writer.brief, defaults: of(AGENT.writer) },
    { id: AGENT.summarizer, instructions: TEXT.session.summarizer, follows: AGENT.main, defaults: of(AGENT.summarizer) }
  ];
}

class AgentRegistry {
  byId = new Map;
  register(...definitions) {
    for (const d of definitions)
      this.byId.set(d.id, d);
  }
  get(id) {
    return this.byId.get(id);
  }
  ids() {
    return [...this.byId.keys()];
  }
  extra() {
    const core = Object.values(AGENT);
    return [...this.byId.values()].filter((d) => !core.includes(d.id)).map((d) => ({ id: d.id, label: d.label ?? d.id, note: d.note ?? "", defaults: d.defaults }));
  }
  resolve(id, settings) {
    const definition = this.byId.get(id);
    if (!definition)
      return;
    const own = agentSettings(settings, id, definition.defaults);
    const followed = definition.follows !== undefined && definition.follows !== id && own.connectionId === null ? this.byId.get(definition.follows) : undefined;
    const base = followed ? agentSettings(settings, followed.id, followed.defaults) : null;
    return { definition, connectionId: base ? base.connectionId : own.connectionId, model: base ? own.model ?? base.model : own.model, effort: own.effort, tools: own.tools, budget: own.budget };
  }
}

// src/core/hash.ts
var HEX = /^[0-9a-f]{64}$/;
function isHash(value) {
  return typeof value === "string" && HEX.test(value);
}
function hex(buffer) {
  let out = "";
  for (const byte of new Uint8Array(buffer))
    out += byte.toString(16).padStart(2, "0");
  return out;
}
async function textHash(text) {
  return hex(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text)));
}
function partsHash(...parts) {
  return textHash(JSON.stringify(parts));
}
var ROOT_PATH = "";
function nextPath(parent, role, hash) {
  return partsHash("lumiah.path", parent, role, hash);
}

// src/core/blobs.ts
class Blobs {
  host;
  keep;
  kept = new Map;
  chars = 0;
  writing = new Map;
  constructor(host, keep) {
    this.host = host;
    this.keep = keep;
  }
  async put(text, kept = true) {
    const hash = await textHash(text);
    const under = this.writing.get(hash);
    if (under) {
      await under;
      return hash;
    }
    const write = this.host.blobs.put(hash, text);
    this.writing.set(hash, write);
    try {
      await write;
    } finally {
      this.writing.delete(hash);
    }
    if (kept)
      this.remember(hash, text);
    return hash;
  }
  putJson(value, kept = true) {
    return this.put(JSON.stringify(value), kept);
  }
  async get(hash) {
    if (!isHash(hash))
      return null;
    const known = this.kept.get(hash);
    if (known !== undefined) {
      this.remember(hash, known);
      return known;
    }
    await this.writing.get(hash)?.catch(() => {
      return;
    });
    const text = await this.host.blobs.get(hash);
    if (text === null)
      return null;
    if (await textHash(text) !== hash) {
      this.host.log("warn", `the stored blob ${hash} doesn't match its hash, so it is read as missing`);
      return null;
    }
    this.remember(hash, text);
    return text;
  }
  async getJson(hash) {
    const text = await this.get(hash);
    return text === null ? undefined : parseJson(text);
  }
  remember(hash, text) {
    const limit2 = this.keep();
    const before = this.kept.get(hash);
    if (before !== undefined) {
      this.kept.delete(hash);
      this.chars -= before.length;
    }
    if (text.length <= limit2) {
      this.kept.set(hash, text);
      this.chars += text.length;
    }
    for (const [old, held] of this.kept) {
      if (this.chars <= limit2)
        break;
      this.kept.delete(old);
      this.chars -= held.length;
    }
  }
}

// src/core/usage.ts
function messageText(m) {
  if (!m.parts)
    return m.content;
  return m.parts.map((p) => p.type === "text" ? p.text : p.type === "tool_use" ? `${p.name} ${JSON.stringify(p.input)}` : p.type === "tool_result" ? p.content : "").join(`
`);
}
function toolTokens(tools, charsPerToken) {
  let tokens = 0;
  for (const t of tools)
    tokens += tokensOf(`${t.name} ${t.description} ${JSON.stringify(t.parameters)}`, charsPerToken);
  return tokens;
}
function promptTokens(messages, tools, charsPerToken) {
  let tokens = toolTokens(tools, charsPerToken);
  for (const m of messages)
    tokens += tokensOf(messageText(m), charsPerToken);
  return tokens;
}
function count(o, key) {
  if (!isRecord(o))
    return;
  const v2 = o[key];
  return typeof v2 === "number" && Number.isFinite(v2) && v2 >= 0 ? v2 : undefined;
}
function parseUsage(raw, provider, estimate) {
  const estimated = [];
  const guess = (field, value) => {
    estimated.push(field);
    return value;
  };
  const prompt = count(raw, "prompt_tokens");
  const completion = count(raw, "completion_tokens");
  const own = raw && isRecord(raw.provider_raw) ? raw.provider_raw : {};
  const cost = count(raw, "cost") ?? count(own, "cost");
  const priced = cost !== undefined ? { cost } : {};
  if (provider === "anthropic") {
    const fresh = count(own, "input_tokens");
    const read2 = count(own, "cache_read_input_tokens");
    const written2 = count(own, "cache_creation_input_tokens");
    const sent = prompt ?? (fresh === undefined ? undefined : fresh + (read2 ?? 0) + (written2 ?? 0));
    const out = count(own, "output_tokens") ?? completion;
    return { in: sent ?? guess("in", estimate.in), cachedIn: read2 ?? guess("cachedIn", 0), ...written2 !== undefined ? { cacheWrite: written2 } : {}, out: out ?? guess("out", estimate.out + estimate.reasoningOut), reasoningOut: guess("reasoningOut", estimate.reasoningOut), estimated, ...priced };
  }
  if (provider === "google" || provider === "google_vertex") {
    const total = count(raw, "total_tokens");
    const thoughts = total !== undefined && prompt !== undefined && completion !== undefined ? Math.max(0, total - prompt - completion) : undefined;
    return {
      in: prompt ?? guess("in", estimate.in),
      cachedIn: guess("cachedIn", 0),
      out: completion !== undefined ? completion + (thoughts ?? 0) : guess("out", estimate.out + estimate.reasoningOut),
      reasoningOut: thoughts ?? guess("reasoningOut", estimate.reasoningOut),
      estimated,
      ...priced
    };
  }
  const promptDetails = isRecord(own.prompt_tokens_details) ? own.prompt_tokens_details : {};
  const completionDetails = isRecord(own.completion_tokens_details) ? own.completion_tokens_details : {};
  const cached = count(promptDetails, "cached_tokens") ?? count(own, "prompt_cache_hit_tokens") ?? count(own, "cache_read_input_tokens") ?? count(own, "cached_tokens");
  const written = count(promptDetails, "cache_write_tokens") ?? count(own, "cache_creation_input_tokens") ?? count(own, "cache_creation_tokens");
  const reasoning = count(completionDetails, "reasoning_tokens") ?? count(own, "reasoning_tokens");
  return {
    in: prompt ?? guess("in", estimate.in),
    cachedIn: cached ?? guess("cachedIn", 0),
    ...written !== undefined ? { cacheWrite: written } : {},
    out: completion ?? guess("out", estimate.out + estimate.reasoningOut),
    reasoningOut: reasoning ?? guess("reasoningOut", estimate.reasoningOut),
    estimated,
    ...priced
  };
}
function priced(usage, model, prices) {
  const price2 = hasOwn(prices, model) ? prices[model] : undefined;
  if (usage.cost !== undefined || !price2)
    return usage;
  const fresh = Math.max(0, usage.in - usage.cachedIn);
  const cost = (fresh * price2.in + usage.cachedIn * price2.cachedIn + usage.out * price2.out) / 1e6;
  return { ...usage, cost, estimated: [...usage.estimated, "cost"] };
}
function emptyUsage() {
  return { calls: 0, toolTurns: 0, in: 0, cachedIn: 0, out: 0, reasoningOut: 0, estimated: false, ms: 0, cost: 0 };
}
function addCall(call, ms, ...tallies) {
  for (const t of tallies) {
    t.calls += 1;
    t.in += call.in;
    t.cachedIn += call.cachedIn;
    if (call.cacheWrite !== undefined)
      t.cacheWrite = (t.cacheWrite ?? 0) + call.cacheWrite;
    t.out += call.out;
    t.reasoningOut += call.reasoningOut;
    t.estimated ||= call.estimated.length > 0;
    t.ms += ms;
    if (t.cost !== undefined) {
      if (call.cost === undefined)
        delete t.cost;
      else
        t.cost += call.cost;
    }
  }
}

// src/core/provider.ts
class AgentStop extends Error {
  code;
  text;
  constructor(code, text) {
    super(renderDefault(text.id, text.vars ?? {}));
    this.code = code;
    this.text = text;
    this.name = "AgentStop";
  }
}

class ToolsRefused extends Error {
  constructor(cause) {
    super(`the connection refused native tools (${errorText(cause)})`, { cause });
    this.name = "ToolsRefused";
  }
}
var TOOL_REFUSALS = [
  /\b(?:does|do)(?: not|n't) support (?:native )?(?:tools?|tool[ _-]?(?:use|calls?|calling)|function[ _-]?(?:calls?|calling)|functions)\b/i,
  /\b(?:tools?|tool[ _-]?(?:use|calls?|calling)|function[ _-]?(?:calls?|calling))\b[^.\n]{0,40}\b(?:is|are) not (?:supported|enabled|available)\b/i,
  /\b(?:tools?|tool[ _-]?(?:use|calls?|calling)|function[ _-]?(?:calls?|calling))(?: are| is)? unsupported\b/i,
  /\bno endpoints found that support tool use\b/i,
  /\bunsupported (?:parameter|argument|field)\b[^.\n]{0,8}\btools?\b/i,
  /\bunrecognized request arguments? supplied\b[^.\n]{0,8}\btools?\b/i,
  /--enable-auto-tool-choice\b/i,
  /\btools? param(?:eter)? requires --jinja\b/i,
  /\bfunction calling is not enabled\b/i
];
function isToolRefusal(error) {
  const texts = [errorText(error), error instanceof Error && error.cause !== undefined ? errorText(error.cause) : ""];
  return texts.some((text) => TOOL_REFUSALS.some((pattern) => pattern.test(text)));
}
var LASTING = [/\binsufficient[ _]quota\b/i, /\bcurrent quota\b/i, /\b(?:billing|payment required|credit balance)\b/i];
var TRANSIENT = [
  /(?:^\s*|\b(?:status(?: code)?|http(?:\/[\d.]+)?|error|code)[\s:=#(]*)(?:408|425|429|5\d\d)\b/i,
  /\b(?:timed[ -]?out|time[ -]?out|deadline exceeded)\b/i,
  /\b(?:rate[ _-]?limit|too many requests|overloaded|(?:at|over) capacity|resource[ _]exhausted)/i,
  /\b(?:temporarily unavailable|service unavailable|bad gateway|gateway time-?out|internal server error|server (?:error|is busy)|try again later)\b/i,
  /\b(?:ECONNRESET|ECONNREFUSED|ECONNABORTED|ETIMEDOUT|EPIPE|EAI_AGAIN|ENETUNREACH|EHOSTUNREACH|UND_ERR_[A-Z_]+|Connection(?:Refused|Closed|Reset)|FailedToOpenSocket)\b/,
  /\b(?:socket hang up|network error|connection error|fetch failed|unable to connect|other side closed|premature close|unexpected end of (?:stream|data|file|json input))\b/i,
  /\b(?:socket|connection)\b[^.\n]{0,30}\b(?:reset|closed|lost|refused|terminated|dropped)\b/i,
  /^\s*terminated\s*$/i,
  /\bstream\b[^.\n]{0,40}\b(?:cut|dropped|ended|closed|interrupted|reset|lost|terminated|broke|broken)\b/i
];
function isTransient(error) {
  const texts = [errorText(error), error instanceof Error && error.cause !== undefined ? errorText(error.cause) : ""];
  return !texts.some((text) => LASTING.some((pattern) => pattern.test(text))) && texts.some((text) => TRANSIENT.some((pattern) => pattern.test(text)));
}
function callEffort(effort, offersTools, thinkingInToolLoops) {
  return offersTools && !thinkingInToolLoops ? "off" : effort;
}
var NATIVE_TURNS = {
  kind: "native",
  assistant(turn) {
    const parts = turn.text === "" ? [] : [{ type: "text", text: turn.text }];
    for (const c of turn.calls)
      parts.push({ type: "tool_use", id: c.id, name: c.name, input: c.args, ...c.thoughtSignature !== undefined ? { thoughtSignature: c.thoughtSignature } : {} });
    return {
      role: "assistant",
      content: [turn.text, ...turn.calls.map((c) => `${c.name} ${JSON.stringify(c.args)}`)].filter((s) => s !== "").join(`
`),
      parts,
      ...turn.reasoning ? { reasoning: turn.reasoning } : {},
      ...turn.thinkingBlocks ? { thinkingBlocks: turn.thinkingBlocks } : {},
      ...turn.reasoningDetails ? { reasoningDetails: turn.reasoningDetails } : {}
    };
  },
  results(results) {
    return { role: "user", content: results.map((r) => r.text).join(`

`), parts: results.map((r) => ({ type: "tool_result", toolUseId: r.call.id, content: r.text, ...r.error ? { isError: true } : {} })) };
  }
};
var TEXT_TURNS = {
  kind: "text",
  assistant: (turn) => ({ role: "assistant", content: turn.raw }),
  results(results, texts) {
    const each = results.map((r) => r.error ? texts.render(TEXT.runtime.toolError, { name: r.call.name, error: r.text }) : texts.render(TEXT.runtime.toolResult, { name: r.call.name, result: r.text }));
    return { role: "user", content: texts.render(TEXT.runtime.toolResults, { results: each.join(`

`) }) };
  }
};
function toolsAsText(tools, texts) {
  const each = tools.map((t) => texts.render(TEXT.runtime.toolInText, { name: t.name, description: t.description, parameters: JSON.stringify(t.parameters) }));
  return texts.render(TEXT.runtime.toolsInText, { tools: each.join(`

`) });
}
function writtenArgs(v2) {
  if (v2 === undefined || v2 === null)
    return {};
  const parsed = typeof v2 === "string" ? parseJson(v2) : v2;
  return isRecord(parsed) ? parsed : null;
}
function callsFromJson(value, names) {
  const list = Array.isArray(value) ? value : [value];
  if (list.length === 0)
    return null;
  const out = [];
  for (const item of list) {
    if (!isRecord(item) || item.description !== undefined)
      return null;
    const fn = isRecord(item.function) ? item.function : null;
    const named = [item.name, item.tool, item.tool_name, item.function, fn?.name].find((n) => typeof n === "string");
    if (named === undefined || !names.has(named))
      return null;
    const args = writtenArgs(item.arguments ?? item.args ?? item.parameters ?? item.input ?? fn?.arguments);
    if (args === null)
      return null;
    out.push({ name: named, args });
  }
  return out;
}
function writtenValue(text) {
  const trimmed = text.trim();
  const parsed = parseJson(trimmed);
  return parsed === undefined ? trimmed : parsed;
}
var DEEPSEEK_CALL = /<\uFF5Ctool\u2581call\u2581begin\uFF5C>(?:function<\uFF5Ctool\u2581sep\uFF5C>)?([^\n<]+?)(?:<\uFF5Ctool\u2581sep\uFF5C>|\n)\s*(?:```(?:json)?\s*)?([\s\S]*?)\s*(?:```\s*)?<\uFF5Ctool\u2581call\u2581end\uFF5C>/g;
var TAGGED_CALL = /<tool_call>\s*([\s\S]*?)\s*<\/tool_call>/g;
var FUNCTION_CALLS = /<(?:antml:)?function_calls>([\s\S]*?)<\/(?:antml:)?function_calls>/g;
var INVOKE = /<(?:antml:)?invoke\s+name="([^"]+)"\s*>([\s\S]*?)<\/(?:antml:)?invoke>/g;
var PARAMETER = /<(?:antml:)?parameter\s+name="([^"]+)"\s*>([\s\S]*?)<\/(?:antml:)?parameter>/g;
var LLAMA_CALL = /<function=([^>\s]+)>\s*([\s\S]*?)\s*<\/function>/g;
var MISTRAL_CALLS = /\[TOOL_CALLS\]\s*(\[[\s\S]*\]|\{[\s\S]*\})/g;
var FENCED = /```[A-Za-z_]*[ \t]*\n([\s\S]*?)\n?```/g;
var LEFTOVERS = /<\uFF5Ctool\u2581calls\u2581begin\uFF5C>|<\uFF5Ctool\u2581calls\u2581end\uFF5C>|<(?:antml:)?function_calls>\s*<\/(?:antml:)?function_calls>/g;
function recoverToolCalls(text, names) {
  const calls = [];
  let rest = text;
  const take = (pattern, read2) => {
    rest = rest.replace(pattern, (match, ...captures) => {
      const found = read2(captures.slice(0, -2).map((g) => typeof g === "string" ? g : ""));
      if (!found)
        return match;
      calls.push(...found);
      return "";
    });
  };
  const named = (name, args) => {
    const parsed = writtenArgs(args);
    return names.has(name) && parsed ? [{ name, args: parsed }] : null;
  };
  take(DEEPSEEK_CALL, ([name = "", args]) => named(name.trim(), args));
  take(TAGGED_CALL, ([body = ""]) => callsFromJson(parseJson(body.trim()), names));
  take(FUNCTION_CALLS, ([body = ""]) => {
    const invoked = [...body.matchAll(INVOKE)].map(([, name = "", inner = ""]) => ({ name, args: Object.fromEntries([...inner.matchAll(PARAMETER)].map(([, key = "", value = ""]) => [key, writtenValue(value)])) }));
    return invoked.length > 0 && invoked.every((c) => names.has(c.name)) ? invoked : null;
  });
  take(LLAMA_CALL, ([name = "", args]) => named(name, args));
  take(MISTRAL_CALLS, ([body = ""]) => callsFromJson(parseJson(body.trim()), names));
  take(FENCED, ([body = ""]) => callsFromJson(parseJson(body.trim()), names));
  if (calls.length === 0) {
    const whole2 = callsFromJson(parseJson(rest.trim()), names);
    if (whole2)
      return { calls: whole2, rest: "" };
  }
  return { calls, rest: calls.length > 0 ? rest.replace(LEFTOVERS, "").trim() : text };
}
function marked(m) {
  const parts = m.parts ? [...m.parts] : [{ type: "text", text: m.content }];
  const last = parts.at(-1);
  if (last)
    parts[parts.length - 1] = { ...last, cache: true };
  return { ...m, parts };
}
function assemble(opening, conversation, breakpoints) {
  const head = opening.nonce !== null && opening.nonce !== "" ? [opening.nonce] : [];
  const texts = [...head, ...opening.prefix, opening.system, ...opening.tools ? [opening.tools] : []].filter((t) => t !== "");
  if (texts.length === 0)
    return [...conversation];
  const content = texts.join(`

`);
  if (breakpoints <= 0)
    return [{ role: "system", content }, ...conversation];
  const parts = texts.map((text) => ({ type: "text", text }));
  const lastPrefix = head.length + opening.prefix.filter((t) => t !== "").length - 1;
  parts[parts.length - 1] = { type: "text", text: texts[texts.length - 1] ?? "", cache: true };
  if (breakpoints >= 3 && lastPrefix >= 0 && lastPrefix < parts.length - 1)
    parts[lastPrefix] = { type: "text", text: texts[lastPrefix] ?? "", cache: true };
  const out = [{ role: "system", content, parts }, ...conversation];
  if (breakpoints >= 2 && conversation.length > 0)
    out[out.length - 1] = marked(out[out.length - 1]);
  return out;
}
function ownBreakpoints(cache, nativeTools) {
  return (cache.system ? 1 : 0) + (cache.lastMessage ? 1 : 0) + (cache.automatic ? 1 : 0) + (cache.tools && nativeTools > 0 ? 1 : 0);
}
var MINUTE_MS = 60000;
var NOTHING_HELD = () => {
  return;
};

class ConnectionGate {
  running = 0;
  most = 0;
  queue = [];
  async take(most, signal) {
    this.most = most;
    this.fill();
    if (this.queue.length === 0 && this.running < most)
      this.running++;
    else
      await this.wait(signal);
    let held = true;
    return () => {
      if (!held)
        return;
      held = false;
      this.running--;
      this.fill();
    };
  }
  fill() {
    while (this.queue.length > 0 && this.running < this.most) {
      this.running++;
      this.queue.shift()?.();
    }
  }
  wait(signal) {
    signal.throwIfAborted();
    const { promise, resolve, reject } = Promise.withResolvers();
    const wake = () => {
      signal.removeEventListener("abort", abort);
      resolve();
    };
    const abort = () => {
      const at = this.queue.indexOf(wake);
      if (at >= 0)
        this.queue.splice(at, 1);
      reject(signal.reason);
    };
    this.queue.push(wake);
    signal.addEventListener("abort", abort, { once: true });
    return promise;
  }
}

class AgentAccounts {
  host;
  window = new Map;
  refusing = new Set;
  gates = new Map;
  constructor(host) {
    this.host = host;
  }
  refusesTools(connection) {
    return this.refusing.has(connection);
  }
  refuseTools(connection, reason) {
    if (this.refusing.has(connection))
      return;
    this.refusing.add(connection);
    this.host.log("info", `connection ${connection} refused native tools (${reason}); its agents are offered them as text from now on`);
  }
  async throttle(connection, tokens, throttle, texts, signal) {
    if (!throttle)
      return;
    const requests = limitOf(throttle.requestsPerMinute);
    const perMinute = limitOf(throttle.tokensPerMinute);
    if (tokens > perMinute)
      throw new AgentStop("throttle", { id: TEXT.stop.throttle, vars: { tokens: texts.counted(tokens, TEXT.word.token), limit: String(perMinute) } });
    for (;; ) {
      const now = this.host.clock.now();
      const recent = (this.window.get(connection) ?? []).filter((e) => e.at > now - MINUTE_MS);
      this.window.set(connection, recent);
      const used = recent.reduce((n, e) => n + e.tokens, 0);
      const oldest = recent[0];
      if (!oldest || recent.length < requests && used + tokens <= perMinute)
        return;
      await this.host.clock.sleep(oldest.at + MINUTE_MS - now, signal);
    }
  }
  async reserve(input) {
    const { connection, settings } = input;
    const throttle = hasOwn(settings.throttles, connection) ? settings.throttles[connection] : undefined;
    const release = await this.atOnce(connection, settings, input.signal);
    try {
      await this.throttle(connection, input.tokensIn + input.tokensOut, throttle, input.texts, input.signal);
    } catch (error) {
      release();
      throw error;
    }
    const entry = { at: this.host.clock.now(), tokens: input.tokensIn + input.tokensOut };
    if (throttle)
      this.window.set(connection, [...this.window.get(connection) ?? [], entry]);
    return { connection, entry, release };
  }
  async atOnce(connection, settings, signal) {
    const own = hasOwn(settings.throttles, connection) ? settings.throttles[connection]?.atOnce : undefined;
    const most = limitOf(own ?? settings.atOnce);
    if (most === Number.POSITIVE_INFINITY)
      return NOTHING_HELD;
    let gate = this.gates.get(connection);
    if (!gate) {
      gate = new ConnectionGate;
      this.gates.set(connection, gate);
    }
    return gate.take(most, signal);
  }
  settle(r, usage) {
    r.release();
    if (usage)
      r.entry.tokens = usage.in + usage.out;
  }
}
function requestOf(spec, p, maxTokens, settings) {
  return {
    messages: p.messages,
    maxTokens,
    connectionId: spec.connectionId,
    model: spec.model,
    ...p.tools.length > 0 ? { tools: p.tools } : {},
    ...p.tools.length > 0 && !p.parallel ? { parallelToolCalls: false } : {},
    effort: callEffort(spec.effort, p.names.size > 0, settings.loop.thinkingInToolLoops),
    ...settings.loop.thinkingInToolLoops ? { thinkingDisplay: "summarized" } : {},
    ...spec.params && Object.keys(spec.params).length > 0 ? { params: spec.params } : {},
    usage: true,
    ...settings.loop.stream || spec.onDelta ? { stream: true } : {}
  };
}

class ProviderSession {
  deps;
  spec;
  profile;
  textTools = false;
  refusal = null;
  written = 0;
  constructor(deps, spec) {
    this.deps = deps;
    this.spec = spec;
  }
  async connection() {
    if (this.profile !== undefined)
      return this.profile;
    const asked = this.spec.connectionId;
    let profile;
    try {
      profile = await this.deps.host.connections.get(asked);
    } catch (error) {
      throw new AgentStop("connection", { id: TEXT.stop.connectionUnread, vars: { connection: asked ?? "", error: errorText(error) } });
    }
    if (profile === null)
      throw new AgentStop("connection", asked === null ? { id: TEXT.stop.noDefault } : { id: TEXT.stop.noConnection, vars: { connection: asked } });
    if (profile.loopback)
      throw new AgentStop("connection", { id: TEXT.stop.loopback, vars: { connection: profile.name } });
    this.profile = profile;
    return profile;
  }
  refuseNativeTools(reason) {
    this.textTools = true;
    this.refusal = reason;
  }
  async prepare(conversation, tools) {
    const { settings, texts, accounts } = this.deps;
    const profile = await this.connection();
    if (!this.textTools && tools.length > 0 && accounts.refusesTools(profile.id))
      this.textTools = true;
    const offered = this.textTools ? [] : [...tools];
    const { cache: own } = this.spec;
    const hasOpening = this.spec.system !== "" || this.spec.prefix.some((text) => text !== "");
    const opening = { nonce: own.key === "" || !hasOpening ? null : texts.render(TEXT.runtime.cacheNonce, { nonce: own.key }), prefix: this.spec.prefix, system: this.spec.system, tools: this.textTools && tools.length > 0 ? toolsAsText(tools, texts) : null };
    const cache = profile.cache;
    const breakpoints = own.breakpoints && cache ? Math.max(0, cache.limit - ownBreakpoints(cache, offered.length)) : 0;
    const toolMark = offered.length > 0 && cache !== null && !cache.tools && breakpoints >= 3;
    const native = toolMark ? offered.map((t, i) => i === offered.length - 1 ? { ...t, cache: true } : t) : offered;
    const messages = assemble(opening, conversation, toolMark ? breakpoints - 1 : breakpoints);
    return { messages, tools: native, names: new Set(tools.map((t) => t.name)), textTools: this.textTools && tools.length > 0, estimate: promptTokens(messages, native, settings.loop.charsPerToken), connection: profile.id, model: this.spec.model ?? profile.model ?? "", parallel: profile.parallelTools };
  }
  async send(p, request, signal) {
    const { host, settings, texts, accounts } = this.deps;
    const held = await accounts.reserve({ connection: p.connection, tokensIn: p.estimate, tokensOut: request.maxTokens, settings: settings.connections, texts, signal });
    const t0 = host.clock.now();
    let result;
    try {
      result = await host.models.call(request, signal, this.spec.onDelta);
    } catch (error) {
      accounts.settle(held, null);
      if (!signal.aborted && p.tools.length > 0 && isToolRefusal(error))
        throw new ToolsRefused(error);
      throw error;
    }
    const native = (result.toolCalls ?? []).map((c) => ({ id: c.callId, name: c.name, args: c.args, ...c.thoughtSignature !== undefined ? { thoughtSignature: c.thoughtSignature } : {} }));
    const recovered = native.length === 0 && p.names.size > 0 ? recoverToolCalls(result.content, p.names) : { calls: [], rest: result.content };
    const calls = native.length > 0 ? native : recovered.calls.map((c) => ({ id: `written_${++this.written}`, ...c }));
    const model = result.model ?? p.model;
    const { charsPerToken } = settings.loop;
    const estimate = { in: p.estimate, out: tokensOf(`${result.content}${native.map((c) => `${c.name} ${JSON.stringify(c.args)}`).join("")}`, charsPerToken), reasoningOut: tokensOf(result.reasoning ?? "", charsPerToken) };
    const usage = priced(parseUsage(result.usage, this.profile?.provider ?? null, estimate), model, settings.prices);
    accounts.settle(held, usage);
    if (this.refusal !== null && p.textTools) {
      accounts.refuseTools(p.connection, this.refusal);
      this.refusal = null;
    }
    return {
      text: native.length > 0 ? result.content : recovered.rest,
      raw: result.content,
      calls,
      written: native.length === 0 && calls.length > 0,
      ...result.reasoning !== undefined ? { reasoning: result.reasoning } : {},
      ...result.thinkingBlocks ? { thinkingBlocks: result.thinkingBlocks } : {},
      ...result.reasoningDetails ? { reasoningDetails: result.reasoningDetails } : {},
      usage,
      model,
      finishReason: result.finishReason,
      ms: host.clock.now() - t0
    };
  }
}

// src/core/loop.ts
function cutShort(finish) {
  const f = finish?.toLowerCase();
  return f === "length" || f === "max_tokens" || f === "max_output_tokens";
}

class AgentTurn {
  budget;
  startedAt;
  trace;
  usage = emptyUsage();
  constructor(budget, startedAt, trace = null) {
    this.budget = budget;
    this.startedAt = startedAt;
    this.trace = trace;
  }
}
function startAgent(spec, deps) {
  return new Agent(spec, deps);
}
var STATUS = { cancelled: "cancelled", failed: "failed", loop: "stopped" };

class Agent {
  spec;
  deps;
  id = `agent_${crypto.randomUUID().slice(0, 8)}`;
  controller = new AbortController;
  session;
  callSpec;
  tools = new Map;
  offered;
  offeredTokens;
  conversation;
  entries = [];
  total = emptyUsage();
  scratch = new Map;
  startedAt = null;
  answered = false;
  revisions = 0;
  busy = false;
  ending = null;
  sentOn = false;
  watched;
  live = null;
  answers = 0;
  constructor(spec, deps) {
    this.spec = spec;
    this.deps = deps;
    const { settings } = deps;
    const { onDelta } = spec;
    this.watched = settings.trace.deltaMs > 0 && Boolean(deps.turn?.trace) && (settings.loop.stream || onDelta !== undefined);
    const streamed = onDelta || this.watched ? (delta) => {
      if (onDelta) {
        if (delta.content !== undefined && delta.content !== "")
          this.sentOn = true;
        onDelta(delta);
      }
      this.piece(delta);
    } : undefined;
    this.callSpec = { connectionId: spec.connectionId, model: spec.model, effort: spec.effort, system: spec.system, prefix: spec.prefix, cache: settings.cache, ...spec.params ? { params: spec.params } : {}, ...streamed ? { onDelta: streamed } : {} };
    this.session = new ProviderSession(deps, this.callSpec);
    this.conversation = [...spec.history ?? []];
    for (const tool2 of spec.tools)
      this.tools.set(tool2.name, tool2);
    if (this.tools.size > 0)
      this.tools.set(SCRATCH_READ, this.scratchRead());
    this.offered = [...this.tools.values()].map((t) => ({ name: t.name, description: t.description, parameters: t.parameters }));
    this.offeredTokens = toolTokens(this.offered, settings.loop.charsPerToken);
    deps.turn?.trace?.start({ id: this.id, role: spec.role, connectionId: spec.connectionId, model: spec.model, effort: spec.effort, system: spec.system, prefix: [...spec.prefix], history: this.conversation.length, ...spec.parent !== undefined ? { parent: spec.parent } : {}, ...spec.task !== undefined ? { task: spec.task } : {}, at: this.now() });
  }
  now() {
    return this.deps.host.clock.now();
  }
  text(id, vars = {}) {
    return this.deps.texts.render(id, vars);
  }
  send(text, signal) {
    return this.work(text, signal);
  }
  run(signal) {
    return this.work(null, signal);
  }
  async work(text, signal) {
    const used = emptyUsage();
    if (this.controller.signal.aborted)
      return this.end(used, new AgentStop("cancelled", { id: TEXT.stop.cancelled }));
    if (this.busy)
      return this.end(used, new AgentStop("busy", { id: TEXT.stop.busy }));
    if (this.answered) {
      if (this.revisions >= this.spec.budget.revisions)
        return this.end(used, new AgentStop("revisions", { id: TEXT.stop.revisions, vars: { revisions: this.deps.texts.counted(this.spec.budget.revisions, TEXT.word.revision) } }));
      this.revisions += 1;
    }
    this.busy = true;
    this.ending = null;
    this.sentOn = false;
    this.startedAt ??= this.now();
    if (text !== null) {
      this.conversation.push({ role: "user", content: text });
      this.record({ kind: "message", text, at: this.now() });
    }
    try {
      return await this.loop(used, signal);
    } catch (error) {
      return this.end(used, error instanceof AgentStop ? error : new AgentStop("failed", { id: TEXT.stop.failed, vars: { error: errorText(error) } }));
    } finally {
      this.busy = false;
      this.deps.turn?.trace?.idle(this.id, { ...this.total });
    }
  }
  record(entry) {
    this.entries.push(entry);
    if (entry.kind === "answer")
      this.answers += 1;
    this.deps.turn?.trace?.entry(this.id, entry);
  }
  piece(delta) {
    const live = this.live;
    if (!live)
      return;
    live.text += delta.content ?? "";
    live.reasoning += delta.reasoning ?? "";
    if (live.sentAt === null || this.now() - live.sentAt >= this.deps.settings.trace.deltaMs)
      this.flush(live);
  }
  flush(live) {
    if (live.text === "" && live.reasoning === "")
      return;
    this.deps.turn?.trace?.delta(this.id, this.answers + 1, { ...live.text !== "" ? { text: live.text } : {}, ...live.reasoning !== "" ? { reasoning: live.reasoning } : {} });
    live.text = "";
    live.reasoning = "";
    live.sentAt = this.now();
  }
  closeLive() {
    if (this.live)
      this.flush(this.live);
    this.live = null;
  }
  cancel() {
    this.controller.abort(new AgentStop("cancelled", { id: TEXT.stop.cancelled }));
  }
  transcript() {
    return { id: this.id, role: this.spec.role, system: this.spec.system, prefix: [...this.spec.prefix], history: this.spec.history?.length ?? 0, entries: [...this.entries] };
  }
  usage() {
    return { ...this.total };
  }
  async loop(used, signal) {
    const { budget } = this.spec;
    const { turn, settings } = this.deps;
    const repeat = { call: null, state: null, times: 0 };
    let said = "";
    let finish;
    let retried = 0;
    for (;; ) {
      const late = this.timeUp();
      if (late)
        return this.end(used, late, said, finish);
      let prepared;
      try {
        prepared = await this.session.prepare(this.conversation, this.offered);
      } catch (error) {
        return this.end(used, this.why(error, this.controller.signal), said, finish);
      }
      const over = this.overBudget(prepared);
      if (over)
        return this.end(used, over, said, finish);
      const outLeft = Math.min(limitOf(budget.tokensOut) - this.total.out, turn ? limitOf(turn.budget.tokensOut) - turn.usage.out : Number.POSITIVE_INFINITY);
      const request = requestOf(this.callSpec, prepared, Math.min(budget.callTokensOut, outLeft), settings);
      const kept = turn?.trace?.prompt(this.id, request).catch(() => {
        return;
      }) ?? Promise.resolve(undefined);
      const scope = this.scope(signal, true);
      const sentAt = this.now();
      let reply;
      this.live = this.watched ? { text: "", reasoning: "", sentAt: null } : null;
      try {
        reply = await this.session.send(prepared, request, scope.signal);
      } catch (error) {
        this.closeLive();
        const prompt2 = await kept;
        if (error instanceof ToolsRefused) {
          this.record({ kind: "tools_refused", reason: error.message, ms: this.now() - sentAt, at: this.now(), ...prompt2 !== undefined ? { prompt: prompt2 } : {} });
          this.session.refuseNativeTools(error.message);
          continue;
        }
        const stop3 = this.why(error, scope.signal);
        if (stop3.code !== "failed" || this.sentOn || retried >= settings.loop.retries || !isTransient(error))
          return this.end(used, stop3, said, finish, prompt2);
        retried += 1;
        scope.clear();
        this.record({ kind: "retry", reason: errorText(error), attempt: retried, of: settings.loop.retries, waitMs: settings.loop.retryWaitMs, ms: this.now() - sentAt, at: this.now(), ...prompt2 !== undefined ? { prompt: prompt2 } : {} });
        const stopped = await this.pause(settings.loop.retryWaitMs, signal);
        if (stopped)
          return this.end(used, stopped, said, finish);
        continue;
      } finally {
        scope.clear();
      }
      this.closeLive();
      retried = 0;
      const prompt = await kept;
      addCall(reply.usage, reply.ms, this.total, used, ...turn ? [turn.usage] : []);
      turn?.trace?.usage(this.id, reply.usage, { ...this.total });
      said = reply.text;
      finish = reply.finishReason;
      this.record({
        kind: "answer",
        text: reply.text,
        ...reply.reasoning ? { reasoning: reply.reasoning } : {},
        calls: reply.calls.map((c) => ({ id: c.id, name: c.name, args: c.args })),
        written: reply.written,
        tools: prepared.names.size === 0 ? "none" : prepared.textTools ? "text" : "native",
        ...prepared.names.size > 0 ? { offered: { tools: prepared.names.size, tokens: this.offeredTokens } } : {},
        usage: reply.usage,
        model: reply.model,
        finishReason: reply.finishReason,
        ms: reply.ms,
        at: this.now(),
        ...prompt !== undefined ? { prompt } : {}
      });
      if (reply.calls.length === 0) {
        this.answered = true;
        this.conversation.push({ role: "assistant", content: reply.text });
        return { status: "answered", text: reply.text, finish, usage: { ...used } };
      }
      const stop2 = this.roundStop(reply.calls, repeat) ?? this.timeUp();
      if (stop2) {
        if (reply.text !== "")
          this.conversation.push({ role: "assistant", content: reply.text });
        return this.end(used, stop2, said, finish);
      }
      this.total.toolTurns += 1;
      used.toolTurns += 1;
      if (turn)
        turn.usage.toolTurns += 1;
      const tools = this.scope(signal, false);
      let results;
      try {
        results = await this.runCalls(reply.calls, tools.signal);
      } finally {
        tools.clear();
      }
      const encoding = reply.written ? TEXT_TURNS : NATIVE_TURNS;
      this.conversation.push(encoding.assistant(reply), encoding.results(results, this.deps.texts));
      if (tools.signal.aborted)
        return this.end(used, this.why(tools.signal.reason, tools.signal), said, finish);
      if (this.ending !== null) {
        const text = this.ending;
        this.ending = null;
        this.answered = true;
        return { status: "answered", text, finish, usage: { ...used } };
      }
    }
  }
  timeUp() {
    const now = this.now();
    if (now - (this.startedAt ?? now) >= limitOf(this.spec.budget.wallMs))
      return new AgentStop("wall_time", { id: TEXT.stop.wallTime });
    const turn = this.deps.turn;
    if (turn && now - turn.startedAt >= limitOf(turn.budget.wallMs))
      return new AgentStop("turn_time", { id: TEXT.stop.turnTime });
    return null;
  }
  overBudget(p) {
    const { budget } = this.spec;
    const turn = this.deps.turn;
    const { texts } = this.deps;
    if (p.estimate > limitOf(budget.callTokensIn))
      return new AgentStop("call_tokens_in", { id: TEXT.stop.callTokensIn, vars: { tokens: texts.counted(p.estimate, TEXT.word.token), limit: String(budget.callTokensIn) } });
    if (this.total.in + p.estimate > limitOf(budget.tokensIn))
      return new AgentStop("tokens_in", { id: TEXT.stop.tokensIn, vars: { limit: String(budget.tokensIn) } });
    if (this.total.out >= limitOf(budget.tokensOut))
      return new AgentStop("tokens_out", { id: TEXT.stop.tokensOut, vars: { tokens: texts.counted(limitOf(budget.tokensOut), TEXT.word.token) } });
    if (turn && turn.usage.in + p.estimate > limitOf(turn.budget.tokensIn))
      return new AgentStop("turn_tokens_in", { id: TEXT.stop.turnTokensIn, vars: { limit: String(turn.budget.tokensIn) } });
    if (turn && turn.usage.out >= limitOf(turn.budget.tokensOut))
      return new AgentStop("turn_tokens_out", { id: TEXT.stop.turnTokensOut, vars: { tokens: texts.counted(limitOf(turn.budget.tokensOut), TEXT.word.token) } });
    return null;
  }
  roundStop(calls, repeat) {
    const { settings, turn } = this.deps;
    for (const call of calls) {
      const state = this.tools.get(call.name)?.state?.() ?? null;
      const same = repeat.call !== null && repeat.call.name === call.name && jsonEqual(repeat.call.args, call.args) && repeat.state === state;
      repeat.times = same ? repeat.times + 1 : 1;
      repeat.call = call;
      repeat.state = state;
      if (repeat.times >= settings.loop.repeats)
        return new AgentStop("loop", { id: TEXT.stop.loop, vars: { tool: call.name, times: this.deps.texts.counted(repeat.times, TEXT.word.time) } });
    }
    if (this.total.toolTurns >= limitOf(this.spec.budget.toolTurns))
      return new AgentStop("tool_turns", { id: TEXT.stop.toolTurns, vars: { rounds: this.deps.texts.counted(limitOf(this.spec.budget.toolTurns), TEXT.word.round) } });
    if (turn && turn.usage.toolTurns >= limitOf(turn.budget.toolTurns))
      return new AgentStop("turn_tool_turns", { id: TEXT.stop.turnToolTurns, vars: { rounds: this.deps.texts.counted(limitOf(turn.budget.toolTurns), TEXT.word.round) } });
    return null;
  }
  scope(signal, call) {
    const { clock } = this.deps.host;
    const sources = [this.controller.signal, ...signal ? [signal] : []];
    const over = new AbortController;
    const deadline = (left, stop2) => {
      const ms = timerMs(left);
      if (ms === null)
        return;
      const ends = new AbortController;
      clock.sleep(ms, over.signal).then(() => ends.abort(stop2), () => {
        return;
      });
      sources.push(ends.signal);
    };
    const now = this.now();
    const turn = this.deps.turn;
    deadline(limitOf(this.spec.budget.wallMs) - (now - (this.startedAt ?? now)), new AgentStop("wall_time", { id: TEXT.stop.wallTime }));
    if (turn)
      deadline(limitOf(turn.budget.wallMs) - (now - turn.startedAt), new AgentStop("turn_time", { id: TEXT.stop.turnTime }));
    if (call)
      deadline(limitOf(this.spec.budget.callMs), new AgentStop("call_time", { id: TEXT.stop.callTime }));
    return { signal: AbortSignal.any(sources), clear: () => over.abort() };
  }
  async pause(ms, signal) {
    const wait = this.scope(signal, false);
    try {
      wait.signal.throwIfAborted();
      if (ms > 0)
        await this.deps.host.clock.sleep(ms, wait.signal);
      return null;
    } catch (error) {
      return this.why(error, wait.signal);
    } finally {
      wait.clear();
    }
  }
  why(error, signal) {
    if (error instanceof AgentStop)
      return error;
    if (signal.aborted)
      return signal.reason instanceof AgentStop ? signal.reason : new AgentStop("cancelled", { id: TEXT.stop.cancelled });
    return new AgentStop("failed", { id: TEXT.stop.failed, vars: { error: errorText(error) } });
  }
  end(used, stop2, said = "", finish, prompt) {
    const status = STATUS[stop2.code] ?? "refused";
    const reason = this.text(stop2.text.id, stop2.text.vars);
    this.record({ kind: "stop", status, code: stop2.code, reason, at: this.now(), ...prompt !== undefined ? { prompt } : {} });
    return { status, text: said, code: stop2.code, reason, ...finish !== undefined ? { finish } : {}, usage: { ...used } };
  }
  async runCalls(calls, signal) {
    const { budget } = this.spec;
    const results = [];
    let next = 0;
    const worker = async () => {
      while (next < calls.length) {
        const at = next++;
        const call = calls[at];
        if (call)
          results[at] = await this.runCall(call, at < limitOf(budget.callTools), signal);
      }
    };
    await Promise.all(Array.from({ length: Math.min(budget.concurrency, calls.length) }, worker));
    return results;
  }
  async runCall(call, allowed2, signal) {
    const t0 = this.now();
    const tool2 = this.tools.get(call.name);
    let outcome;
    if (!allowed2)
      outcome = { text: this.text(TEXT.runtime.tooManyCalls, { limit: String(this.spec.budget.callTools), tools: this.deps.texts.noun(limitOf(this.spec.budget.callTools), TEXT.word.tool), name: call.name }), error: true };
    else if (!tool2)
      outcome = { text: this.text(TEXT.runtime.unknownTool, { name: call.name, tools: [...this.tools.keys()].join(", ") }), error: true };
    else {
      try {
        outcome = await tool2.run(call.args, { signal, agentId: this.id, role: this.spec.role, callId: call.id });
      } catch (error) {
        outcome = { text: this.text(TEXT.runtime.toolFailed, { name: call.name, error: errorText(error) }), error: true };
      }
    }
    const ends = outcome.end === true && outcome.error !== true;
    const kept = call.name === SCRATCH_READ || ends ? null : this.clip(outcome.text);
    const text = kept?.text ?? outcome.text;
    this.record({ kind: "result", callId: call.id, name: call.name, text, error: outcome.error === true, ...kept ? { scratch: kept.handle } : {}, ms: this.now() - t0, at: this.now() });
    if (ends)
      this.ending = outcome.text;
    return { call, text, error: outcome.error === true };
  }
  clip(text) {
    const max = this.deps.settings.loop.clipChars;
    if (text.length <= max)
      return null;
    const shown = cutAt(text, max);
    const handle = `s${this.scratch.size + 1}`;
    this.scratch.set(handle, text);
    return { text: `${text.slice(0, shown)}
${this.text(TEXT.runtime.clipped, { shown: String(shown), total: String(text.length), handle })}`, handle };
  }
  scratchRead() {
    const max = this.deps.settings.loop.clipChars;
    return {
      name: SCRATCH_READ,
      description: this.text(TEXT.runtime.scratchRead),
      parameters: {
        type: "object",
        properties: {
          handle: { type: "string", description: this.text(TEXT.runtime.scratchHandle) },
          offset: { type: "integer", minimum: 0, description: this.text(TEXT.runtime.scratchOffset) },
          length: { type: "integer", minimum: 1, maximum: max, description: this.text(TEXT.runtime.scratchLength, { max: String(max) }) }
        },
        required: ["handle"]
      },
      run: async (args) => {
        const handle = typeof args.handle === "string" ? args.handle : "";
        const whole2 = this.scratch.get(handle);
        if (whole2 === undefined)
          return { text: this.text(TEXT.runtime.scratchMissing, { handle, handles: [...this.scratch.keys()].join(", ") || this.text(TEXT.session.none) }), error: true };
        const from = Math.min(Math.max(0, wholeArg(args.offset) ?? 0), whole2.length);
        const length = Math.min(Math.max(1, wholeArg(args.length) ?? max), max);
        const to = cutAt(whole2, Math.min(whole2.length, from + length));
        return { text: this.text(TEXT.runtime.scratchPart, { handle, from: String(from), to: String(to), total: String(whole2.length), text: whole2.slice(from, to) }) };
      }
    };
  }
}

// src/core/receipts.ts
function toldOf(segment, texts) {
  const vars = { reply: String(segment.reply), kind: segment.turn, count: texts.counted(segment.request.messages, TEXT.word.message) };
  return segment.request.last === null ? texts.render(TEXT.session.toldUnplaced, vars) : texts.render(TEXT.session.told, { ...vars, last: String(segment.request.last) });
}
function stepText(step) {
  if (step.kind === "said")
    return step.text;
  if (step.kind === "call")
    return `${JSON.stringify(step.args)}
${step.result}`;
  return step.kind === "stop" ? step.reason : "";
}
function receiptOf(segment, chars, texts) {
  const reply = String(segment.reply);
  const short = (text) => text.length <= chars ? text : texts.render(TEXT.session.receiptClipped, { text: text.slice(0, cutAt(text, chars)), chars: String(text.length), reply });
  const lines = segment.steps.map((step) => {
    if (step.kind === "said")
      return texts.render(TEXT.session.receiptSaid, { text: short(step.text) });
    if (step.kind === "call")
      return texts.render(step.error ? TEXT.session.receiptFailed : TEXT.session.receiptCall, { tool: step.name, args: JSON.stringify(step.args), result: short(step.result) });
    if (step.kind === "reply")
      return texts.render(TEXT.session.receiptReply, { chars: String(step.chars), reply });
    return texts.render(TEXT.session.receiptStop, { reason: step.reason });
  });
  return texts.render(TEXT.session.receipt, { steps: lines.length > 0 ? lines.join(`
`) : texts.render(TEXT.session.receiptNothing) });
}
function carriedOf(session, input) {
  const { texts } = input;
  const summary = session.summary === null ? null : texts.render(TEXT.session.summary, { summary: session.summary });
  const history = session.turns.flatMap((turn, i) => [
    { role: "user", content: i === 0 && summary !== null ? `${summary}

${toldOf(turn.segment, texts)}` : toldOf(turn.segment, texts) },
    { role: "assistant", content: receiptOf(turn.segment, input.receiptChars, texts) }
  ]);
  const lead = history.length === 0 ? summary : null;
  let tokens = lead === null ? 0 : tokensOf(lead, input.charsPerToken);
  for (const m of history)
    tokens += tokensOf(m.content, input.charsPerToken);
  return { history, lead, tokens };
}

// src/core/compaction.ts
function foldOf(session, input) {
  const { texts } = input;
  const cut = Math.max(0, session.turns.length - input.keep);
  const folded = session.turns.slice(0, cut);
  if (folded.length === 0)
    return null;
  const turns = folded.map((t) => texts.render(TEXT.session.summarizerTurn, { told: toldOf(t.segment, texts), receipt: receiptOf(t.segment, input.receiptChars, texts) }));
  return {
    system: texts.render(TEXT.session.summarizer, { keep: texts.counted(input.keep, TEXT.word.turn), limit: String(input.limit) }),
    message: texts.render(TEXT.session.summarizerInput, { summary: session.summary ?? texts.render(TEXT.session.none), turns: turns.join(`

`) }),
    folded,
    kept: session.turns.slice(cut)
  };
}
var DANGLING = /(?:[,;:([{/&+\-\u2013\u2014]|\b(?:and|or|but|nor|the|a|an|of|to|with|from|for|that|which|whose|than|into))$/i;
function summaryOf(reply, texts) {
  const summary = reply.text.trim();
  if (reply.status !== "answered")
    return { failed: reply.reason ?? texts.render(TEXT.session.failedNothing) };
  if (summary === "")
    return { failed: texts.render(TEXT.session.failedNothing) };
  if (cutShort(reply.finish))
    return { failed: texts.render(TEXT.session.failedCut), cut: true };
  if (DANGLING.test(summary))
    return { failed: texts.render(TEXT.session.failedMidSentence), cut: true };
  return { summary };
}
function foldKey(input) {
  return partsHash("lumiah.fold", input.connectionId ?? "", input.model ?? "", input.effort, String(input.callTokensOut), input.system, input.message);
}

class CompactionMemo {
  cap;
  folds = new Map;
  constructor(cap) {
    this.cap = cap;
  }
  run(key, make) {
    const had = this.folds.get(key);
    if (had) {
      this.touch(key, had);
      return had.result;
    }
    const entry = { result: Promise.resolve({ failed: "" }) };
    entry.result = make().catch((error) => ({ failed: errorText(error) })).then((result) => {
      if ("failed" in result && result.cut !== true && this.folds.get(key) === entry)
        this.folds.delete(key);
      return result;
    });
    this.touch(key, entry);
    return entry.result;
  }
  get size() {
    return this.folds.size;
  }
  touch(key, entry) {
    this.folds.delete(key);
    this.folds.set(key, entry);
    const cap = Math.max(0, this.cap());
    for (const old of this.folds.keys()) {
      if (this.folds.size <= cap || old === key)
        break;
      this.folds.delete(old);
    }
  }
}

// src/core/request.ts
function shown(m, texts) {
  if (!m.parts)
    return m.content;
  return m.parts.map((p) => p.type === "text" ? p.text : p.type === "media" ? texts.render(TEXT.request.media, { media: p.media }) : p.type === "tool_use" ? `${p.name} ${JSON.stringify(p.input)}` : p.content).filter((part) => part !== "").join(`
`);
}
function requestDocument(messages, blocks, path, texts) {
  const blockOf = new Map(blocks.map((b) => [b.id, b]));
  const nameOf = new Map(path.map((m) => [m.id, m.name]));
  let last = null;
  const parts = messages.map((m, i) => {
    const base = { n: String(i + 1), role: m.role, text: shown(m, texts) };
    const source = m.source;
    if (source?.kind === "history") {
      last = last === null ? source.index : Math.max(last, source.index);
      const name = nameOf.get(source.messageId) ?? "";
      return texts.render(TEXT.request.message, { ...base, from: texts.render(TEXT.request.fromHistory, { index: String(source.index), name: name === "" ? "" : `, ${name}` }) });
    }
    if (source?.kind === "block") {
      const block = blockOf.get(source.blockId);
      if (block?.kind === "instruction")
        return texts.render(TEXT.request.instruction, { ...base, name: block.name });
      const from = block ? texts.render(TEXT.request.fromMarker, { marker: block.marker ?? block.name, name: block.name }) : texts.render(TEXT.request.fromBlock, { name: source.blockId });
      return texts.render(TEXT.request.message, { ...base, from });
    }
    return texts.render(TEXT.request.message, { ...base, from: "" });
  });
  return { text: parts.length > 0 ? parts.join(`

`) : texts.render(TEXT.request.empty), messages: messages.length, last };
}
function plain(m) {
  const { source: _source, ...message } = m;
  return message;
}
function writerMessages(messages, brief, reply, texts) {
  const out = messages.map(plain);
  if (brief === null)
    return out;
  const message = { role: reply.briefRole, content: texts.render(TEXT.writer.brief, { brief }) };
  let at = reply.briefAt === "start" ? 0 : out.length;
  if (reply.briefAt === "before_last_user") {
    const traced = messages.findLastIndex((m) => m.role === "user" && m.source?.kind === "history");
    const found = traced >= 0 ? traced : messages.findLastIndex((m) => m.role === "user");
    if (found >= 0)
      at = found;
  }
  out.splice(at, 0, message);
  return out;
}

// src/core/sessions.ts
var TURN_KINDS = ["new", "regenerate", "swipe", "continue"];
function isTurnKind(v2) {
  return typeof v2 === "string" && TURN_KINDS.includes(v2);
}
var isCount = (v2) => typeof v2 === "number" && Number.isSafeInteger(v2) && v2 >= 0;
function stepOf(raw) {
  if (!isRecord(raw))
    return null;
  if (raw.kind === "said" && typeof raw.text === "string")
    return { kind: "said", text: raw.text };
  if (raw.kind === "call" && typeof raw.name === "string" && isRecord(raw.args) && typeof raw.result === "string")
    return { kind: "call", name: raw.name, args: raw.args, result: raw.result, ...raw.error === true ? { error: true } : {} };
  if (raw.kind === "reply" && isCount(raw.chars))
    return { kind: "reply", chars: raw.chars };
  if (raw.kind === "stop" && typeof raw.reason === "string")
    return { kind: "stop", reason: raw.reason };
  return null;
}
function segmentOf(raw) {
  if (!isRecord(raw) || raw.v !== 1 || raw.kind !== "segment" || !isCount(raw.reply) || typeof raw.generationId !== "string" || !isTurnKind(raw.turn) || typeof raw.at !== "number" || !isRecord(raw.request) || !Array.isArray(raw.steps))
    return null;
  const { messages, last } = raw.request;
  return { v: 1, kind: "segment", reply: raw.reply, generationId: raw.generationId, turn: raw.turn, at: raw.at, request: { messages: isCount(messages) ? messages : 0, last: isCount(last) ? last : null }, steps: raw.steps.flatMap((s) => stepOf(s) ?? []) };
}
function usageOf(raw) {
  const out = emptyUsage();
  if (!isRecord(raw))
    return out;
  const n = (key) => {
    const v2 = raw[key];
    return typeof v2 === "number" && Number.isFinite(v2) && v2 >= 0 ? v2 : 0;
  };
  Object.assign(out, { calls: n("calls"), toolTurns: n("toolTurns"), in: n("in"), cachedIn: n("cachedIn"), out: n("out"), reasoningOut: n("reasoningOut"), estimated: raw.estimated === true, ms: n("ms") });
  if (typeof raw.cacheWrite === "number")
    out.cacheWrite = n("cacheWrite");
  if (typeof raw.cost === "number")
    out.cost = n("cost");
  else
    delete out.cost;
  return out;
}
function recordOf(anchor) {
  if (!isRecord(anchor) || anchor.v !== 1 || typeof anchor.generationId !== "string" || !isTurnKind(anchor.kind) || typeof anchor.at !== "number" || typeof anchor.path !== "string" || !isHash(anchor.segment))
    return null;
  const summary = isHash(anchor.summary) ? anchor.summary : undefined;
  return {
    v: 1,
    generationId: anchor.generationId,
    kind: anchor.kind,
    at: anchor.at,
    path: anchor.path,
    segment: anchor.segment,
    ...isHash(anchor.transcript) ? { transcript: anchor.transcript } : {},
    ...summary !== undefined ? { summary, kept: Array.isArray(anchor.kept) ? anchor.kept.filter(isHash) : [], folded: isCount(anchor.folded) ? anchor.folded : 0 } : {},
    ...summary !== undefined && typeof anchor.rolledBack === "number" ? { rolledBack: anchor.rolledBack } : {},
    usage: usageOf(anchor.usage)
  };
}
async function pathHashes(path) {
  const out = [ROOT_PATH];
  let hash = ROOT_PATH;
  for (const m of path) {
    hash = await nextPath(hash, m.role, m.hash);
    out.push(hash);
  }
  return out;
}
async function pathTurns(path, hashes) {
  const before = hashes ?? await pathHashes(path);
  return path.flatMap((m, at) => {
    const record = recordOf(m.anchor);
    return record ? [{ at, index: m.index, messageId: m.id, swipeId: m.swipeId, record, onPath: record.path === before[at] }] : [];
  });
}
function sessionAt(turns) {
  const segments = [];
  const dropped = [];
  let rolledBack = null;
  for (let i = turns.length - 1;i >= 0; i--) {
    const turn = turns[i];
    if (!turn.onPath) {
      dropped.unshift(turn.index);
      continue;
    }
    const { record } = turn;
    segments.unshift(record.segment);
    if (record.summary === undefined)
      continue;
    if (record.rolledBack !== undefined) {
      rolledBack ??= record.summary;
      continue;
    }
    return { summary: record.summary, segments: [...record.kept ?? [], ...segments], dropped, rolledBack };
  }
  return { summary: null, segments, dropped, rolledBack };
}

class Sessions {
  host;
  blobs;
  constructor(host, blobs) {
    this.host = host;
    this.blobs = blobs;
  }
  async resume(turn) {
    const path = await this.host.chat.path(turn.chatId);
    const found = turn.target.messageId === null ? -1 : path.findIndex((m) => m.id === turn.target.messageId);
    const at = found < 0 ? path.length : found;
    const hashes = await pathHashes(path);
    const refs = sessionAt((await pathTurns(path, hashes)).filter((t) => t.at < at));
    let missing = 0;
    const summary = refs.summary === null ? null : await this.blobs.get(refs.summary);
    if (refs.summary !== null && summary === null)
      missing++;
    const read2 = await Promise.all(refs.segments.map(async (hash) => ({ hash, segment: segmentOf(await this.blobs.getJson(hash)) })));
    const turns = [];
    for (const { hash, segment } of read2) {
      if (segment)
        turns.push({ reply: segment.reply, hash, segment });
      else
        missing++;
    }
    const target = path[at];
    const own = turn.kind === "continue" && target ? recordOf(target.anchor) : null;
    const before = own && own.path === hashes[at] ? segmentOf(await this.blobs.getJson(own.segment)) : null;
    const continued = own && before ? { reply: before.reply, hash: own.segment, segment: before } : null;
    return { refs, summary, turns, missing, before: path.slice(0, at), reply: target ? target.index : (path.at(-1)?.index ?? -1) + 1, path: hashes[at] ?? ROOT_PATH, continued };
  }
  segment(segment) {
    return this.blobs.putJson(segment);
  }
  async compact(summary, kept, folded) {
    return { summary: await this.blobs.put(summary), kept: kept.map((t) => t.hash), folded };
  }
}

// src/core/tools.ts
class ToolRegistry {
  byName = new Map;
  register(...definitions) {
    for (const d of definitions)
      this.byName.set(d.name, d);
  }
  has(name) {
    return this.byName.has(name);
  }
  names() {
    return [...this.byName.keys()];
  }
  build(names, env) {
    const out = [];
    for (const name of new Set(names)) {
      const tool2 = this.byName.get(name)?.build(env);
      if (tool2)
        out.push(tool2);
    }
    return out;
  }
}

// src/core/lexical.ts
var STOP = new Set("a an and are as at be been but by for from had has have he her hers him his i if in into is it its me my of on or our she so than that the their them then there they this to too was we were what when where which who whom why will with you your".split(" "));
function stem(word2) {
  if (word2.length > 5 && word2.endsWith("ing"))
    return word2.slice(0, -3);
  if (word2.length > 4 && word2.endsWith("ed"))
    return word2.slice(0, -2);
  if (word2.length > 4 && word2.endsWith("es"))
    return word2.slice(0, -2);
  if (word2.length > 3 && word2.endsWith("s") && !word2.endsWith("ss"))
    return word2.slice(0, -1);
  return word2;
}
function tokenize(text) {
  const out = [];
  for (const m of text.toLowerCase().matchAll(/[\p{L}\p{N}]+(?:'[\p{L}]+)?/gu)) {
    const word2 = m[0].replace(/'s$/u, "");
    if (word2.length < 2 || STOP.has(word2))
      continue;
    out.push(stem(word2));
  }
  return out;
}
function piecesOf(text, size) {
  const out = [];
  const most = Math.max(1, size);
  let start = 0;
  while (start < text.length) {
    let end = Math.min(text.length, start + most);
    if (end < text.length) {
      const para = text.lastIndexOf(`
`, end);
      const sentence = Math.max(text.lastIndexOf(". ", end), text.lastIndexOf("! ", end), text.lastIndexOf("? ", end));
      if (para > start + most / 3)
        end = para + 1;
      else if (sentence > start + most / 3)
        end = sentence + 2;
    }
    out.push({ start, end });
    start = end;
  }
  return out;
}
var K1 = 1.2;
var B = 0.75;

class LexicalIndex {
  size;
  entries = [];
  postings = new Map;
  totalLength = 0;
  constructor(size) {
    this.size = size;
  }
  get count() {
    return this.entries.length;
  }
  add(key, text) {
    for (const piece of piecesOf(text, this.size)) {
      const words = tokenize(text.slice(piece.start, piece.end));
      const counts = new Map;
      for (const w of words)
        counts.set(w, (counts.get(w) ?? 0) + 1);
      const id = this.entries.length;
      this.entries.push({ key, piece, length: words.length });
      this.totalLength += words.length;
      for (const [w, n] of counts) {
        const list = this.postings.get(w);
        if (list)
          list.push(id, n);
        else
          this.postings.set(w, [id, n]);
      }
    }
  }
  search(query) {
    const words = [...new Set(tokenize(query))];
    const live = this.entries.length;
    if (words.length === 0 || live === 0)
      return [];
    const avg = this.totalLength / live || 1;
    const scores = new Map;
    for (const w of words) {
      const list = this.postings.get(w);
      if (!list)
        continue;
      const df = list.length / 2;
      const idf = Math.log(1 + (live - df + 0.5) / (df + 0.5));
      for (let i = 0;i < list.length; i += 2) {
        const id = list[i];
        const entry = this.entries[id];
        if (!entry)
          continue;
        const tf = list[i + 1];
        const score = idf * tf * (K1 + 1) / (tf + K1 * (1 - B + B * entry.length / avg));
        scores.set(id, (scores.get(id) ?? 0) + score);
      }
    }
    const best = new Map;
    for (const [id, score] of scores) {
      const entry = this.entries[id];
      if (!entry)
        continue;
      const known = best.get(entry.key);
      if (!known || score > known.hit.score || score === known.hit.score && id < known.id)
        best.set(entry.key, { hit: { key: entry.key, piece: entry.piece, score }, id });
    }
    return [...best.values()].sort((a, b) => b.hit.score - a.hit.score || a.id - b.id).map((b) => b.hit);
  }
}
function excerptOf(text, piece, max) {
  let stop2 = Math.min(piece.end, piece.start + Math.max(1, max));
  if (stop2 < piece.end) {
    const space = text.lastIndexOf(" ", stop2);
    if (space > piece.start + max / 2)
      stop2 = space;
  }
  const cut = text.slice(piece.start, stop2).replace(/\s+/g, " ").trim();
  return stop2 < piece.end ? `${cut}\u2026` : cut;
}

// src/core/tools/paging.ts
function pagerOf(env, tool2) {
  return { tool: tool2, texts: env.texts, pageChars: env.settings.tools.pageChars, pageItems: env.settings.tools.pageItems };
}
var CURSOR2 = /^(\d{1,15})(?::(\d{1,15}))?$/;
function readCursor(p, args) {
  const raw = args.cursor;
  if (raw === undefined || raw === null || raw === "")
    return { at: 0, within: 0, given: false };
  const match = typeof raw === "number" && Number.isSafeInteger(raw) && raw >= 0 ? CURSOR2.exec(String(raw)) : typeof raw === "string" ? CURSOR2.exec(raw.trim()) : null;
  if (!match)
    return badCursor(p, raw);
  return { at: Number(match[1]), within: Number(match[2] ?? 0), given: true };
}
function badCursor(p, raw) {
  return { text: p.texts.render(TEXT.answer.badCursor, { cursor: typeof raw === "string" ? raw : JSON.stringify(raw) ?? "", tool: p.tool }), error: true };
}
function needs(p, arg) {
  return { text: p.texts.render(TEXT.answer.needs, { tool: p.tool, arg, what: p.texts.render(TEXT.toolArg(p.tool, arg)) }), error: true };
}
function footer(p, next, given) {
  if (next !== null)
    return p.texts.render(TEXT.answer.more, { tool: p.tool, cursor: next });
  return given ? p.texts.render(TEXT.answer.end) : "";
}
function roomFor(p, heading, longestCursor) {
  return Math.max(1, p.pageChars - heading.length - footer(p, longestCursor, true).length - 2);
}
function listPage(p, input) {
  const { total, cursor } = input;
  const start = cursor.at;
  if (cursor.within !== 0 || start >= total)
    return badCursor(p, `${cursor.at}${cursor.within !== 0 ? `:${cursor.within}` : ""}`);
  const found = (to) => p.texts.render(TEXT.answer.found, { total: p.texts.counted(total, input.noun), from: String(start + 1), to: String(to) });
  const lead = input.lead === undefined ? "" : `${input.lead}
`;
  const room = roomFor(p, `${lead}${found(total)}`, String(total));
  const lines = [];
  let used = 0;
  let i = start;
  for (;i < total && lines.length < p.pageItems; i++) {
    const line = input.item(i, i === start);
    if (used + line.length + 1 > room) {
      if (lines.length > 0)
        break;
      const frame = p.texts.render(TEXT.answer.cut, { text: "" }).length;
      lines.push(p.texts.render(TEXT.answer.cut, { text: line.slice(0, cutAt(line, Math.max(1, room - frame))) }));
      i++;
      break;
    }
    lines.push(line);
    used += line.length + 1;
  }
  return { text: [`${lead}${found(i)}`, ...lines, footer(p, i < total ? String(i) : null, cursor.given)].filter((part) => part !== "").join(`
`) };
}
function pageEnd(text, from, room) {
  const end = cutAt(text, Math.min(text.length, from + room));
  return end <= from && from < text.length ? Math.min(text.length, from + 2) : end;
}
function textPage(p, input) {
  const { text } = input;
  if (input.from > text.length)
    return badCursor(p, String(input.from));
  const from = cutAt(text, input.from);
  const write = input.cursor ?? String;
  const to = pageEnd(text, from, roomFor(p, input.frame({ from: text.length, to: text.length, text: "" }), write(text.length)));
  return { text: [input.frame({ from, to, text: text.slice(from, to) }), footer(p, to < text.length ? write(to) : null, input.given)].filter((part) => part !== "").join(`
`) };
}
function fitted(p, list, render) {
  return render(clip(list, Math.max(1, p.pageChars - render("").length)));
}
function around(line, at, length, max) {
  if (line.length <= max)
    return line;
  const from = cutAt(line, Math.max(0, Math.min(at - Math.floor((max - length) / 2), line.length - max)));
  const to = cutAt(line, Math.min(line.length, from + max));
  return `${from > 0 ? "\u2026" : ""}${line.slice(from, to)}${to < line.length ? "\u2026" : ""}`;
}
function grepLines(texts, needle) {
  const lower = needle.toLowerCase();
  const found = [];
  texts.forEach((text, key) => {
    text.split(`
`).forEach((line, i) => {
      const at = line.toLowerCase().indexOf(lower);
      if (at >= 0)
        found.push({ key, line: i + 1, text: line, at });
    });
  });
  return found;
}

// src/core/tools/chat.ts
function who(m) {
  return m.name.trim() !== "" ? m.name : m.role;
}
var chatSearch = {
  name: TOOL.chatSearch,
  build(env) {
    const { texts } = env;
    const p = pagerOf(env, TOOL.chatSearch);
    return {
      name: TOOL.chatSearch,
      description: texts.render(TEXT.tool(TOOL.chatSearch)),
      parameters: { type: "object", properties: { query: { type: "string", description: texts.render(TEXT.toolArg(TOOL.chatSearch, "query")) }, cursor: { type: "string", description: texts.render(TEXT.toolArg(TOOL.chatSearch, "cursor")) } }, required: ["query"] },
      async run(args) {
        const query = textArg(args.query);
        if (query === null)
          return needs(p, "query");
        const cursor = readCursor(p, args);
        if ("text" in cursor)
          return cursor;
        const messages = await env.chat.messages();
        if (messages.length === 0)
          return { text: texts.render(TEXT.answer.chatEmpty) };
        const hits = (await env.chat.index()).search(query);
        if (hits.length === 0)
          return { text: texts.render(TEXT.answer.chatSearchNothing, { query }) };
        return listPage(p, {
          total: hits.length,
          noun: TEXT.word.message,
          cursor,
          item: (i) => {
            const hit = hits[i];
            const m = hit ? messages[hit.key] : undefined;
            return hit && m ? texts.render(TEXT.answer.chatHit, { index: String(m.index), who: who(m), chars: String(m.content.length), excerpt: excerptOf(m.content, hit.piece, env.settings.tools.excerptChars) }) : "";
          }
        });
      }
    };
  }
};
var chatGrep = {
  name: TOOL.chatGrep,
  build(env) {
    const { texts } = env;
    const p = pagerOf(env, TOOL.chatGrep);
    return {
      name: TOOL.chatGrep,
      description: texts.render(TEXT.tool(TOOL.chatGrep)),
      parameters: { type: "object", properties: { text: { type: "string", description: texts.render(TEXT.toolArg(TOOL.chatGrep, "text")) }, cursor: { type: "string", description: texts.render(TEXT.toolArg(TOOL.chatGrep, "cursor")) } }, required: ["text"] },
      async run(args) {
        const needle = textArg(args.text);
        if (needle === null)
          return needs(p, "text");
        const cursor = readCursor(p, args);
        if ("text" in cursor)
          return cursor;
        const messages = await env.chat.messages();
        if (messages.length === 0)
          return { text: texts.render(TEXT.answer.chatEmpty) };
        const found = grepLines(messages.map((m) => m.content), needle);
        if (found.length === 0)
          return { text: texts.render(TEXT.answer.chatGrepNothing, { query: needle }) };
        return listPage(p, {
          total: found.length,
          noun: TEXT.word.line,
          cursor,
          item: (i) => {
            const line = found[i];
            const m = line ? messages[line.key] : undefined;
            return line && m ? texts.render(TEXT.answer.chatLine, { index: String(m.index), who: who(m), line: String(line.line), text: around(line.text, line.at, needle.length, env.settings.tools.lineChars) }) : "";
          }
        });
      }
    };
  }
};
var chatRead = {
  name: TOOL.chatRead,
  build(env) {
    const { texts } = env;
    const p = pagerOf(env, TOOL.chatRead);
    return {
      name: TOOL.chatRead,
      description: texts.render(TEXT.tool(TOOL.chatRead)),
      parameters: {
        type: "object",
        properties: { from: { type: "integer", description: texts.render(TEXT.toolArg(TOOL.chatRead, "from")) }, to: { type: "integer", description: texts.render(TEXT.toolArg(TOOL.chatRead, "to")) }, cursor: { type: "string", description: texts.render(TEXT.toolArg(TOOL.chatRead, "cursor")) } },
        required: ["from"]
      },
      async run(args) {
        const from = wholeArg(args.from);
        if (from === null)
          return needs(p, "from");
        const to = wholeArg(args.to) ?? from;
        const given = readCursor(p, args);
        if ("text" in given)
          return given;
        const messages = await env.chat.messages();
        const first = messages[0];
        const last = messages.at(-1);
        if (!first || !last)
          return { text: texts.render(TEXT.answer.chatEmpty) };
        const missing = [from, to].find((index) => !messages.some((m) => m.index === index));
        if (missing !== undefined)
          return { text: texts.render(TEXT.answer.chatNoMessage, { index: String(missing), first: String(first.index), last: String(last.index) }), error: true };
        const range = messages.filter((m) => m.index >= Math.min(from, to) && m.index <= Math.max(from, to));
        const start = given.given ? range.findIndex((m) => m.index === given.at) : 0;
        if (start < 0 || given.within > (range[start]?.content.length ?? 0))
          return badCursor(p, args.cursor);
        const head = texts.render(TEXT.answer.chatRead, { from: String(range[0]?.index ?? from), to: String(range.at(-1)?.index ?? to), count: String(range.length) });
        const frame = (m, part) => texts.render(TEXT.answer.chatMessage, { index: String(m.index), who: who(m), from: String(part.from), to: String(part.to), chars: String(m.content.length), text: part.text });
        const more = (cursor) => texts.render(TEXT.answer.more, { tool: p.tool, cursor });
        const room = Math.max(1, p.pageChars - head.length - more(`${last.index}:${Math.max(...range.map((m) => m.content.length))}`).length - 2);
        const parts = [];
        let used = 0;
        let next = null;
        let offset = given.within;
        for (let i = start;i < range.length; i++) {
          const m = range[i];
          const left = room - used - frame(m, { from: m.content.length, to: m.content.length, text: "" }).length - 2;
          if (left < 1 && parts.length > 0) {
            next = `${m.index}:${offset}`;
            break;
          }
          const end = pageEnd(m.content, offset, Math.max(1, left));
          const part = frame(m, { from: offset, to: end, text: m.content.slice(offset, end) });
          parts.push(part);
          used += part.length + 2;
          if (end < m.content.length) {
            next = `${m.index}:${end}`;
            break;
          }
          offset = 0;
        }
        const footer2 = next !== null ? more(next) : given.given ? texts.render(TEXT.answer.end) : "";
        return { text: [head, parts.join(`

`), footer2].filter((part) => part !== "").join(`
`) };
      }
    };
  }
};
var CHAT_TOOLS = [chatSearch, chatGrep, chatRead];

// src/core/views.ts
function once(make) {
  let made;
  return () => made ??= make();
}
function chatView(host, chatId, before, settings) {
  const messages = once(async () => {
    const first = before[0];
    const last = before.at(-1);
    if (!first || !last)
      return [];
    const wanted = new Set(before.map((m) => m.id));
    const out = [];
    for (let from = first.index;from <= last.index; from += settings.chatBatch) {
      const batch = await host.chat.messages(chatId, from, Math.min(last.index + 1, from + settings.chatBatch));
      for (const m of batch)
        if (wanted.has(m.id))
          out.push(m);
    }
    return out;
  });
  const index = once(async () => {
    const built = new LexicalIndex(settings.pieceChars);
    (await messages()).forEach((m, at) => built.add(at, m.content));
    return built;
  });
  return { path: async () => before, messages, index };
}
function shortIds(ids, least) {
  return ids.map((id) => {
    let length = Math.min(id.length, least);
    while (length < id.length && ids.some((other) => other !== id && other.startsWith(id.slice(0, length))))
      length++;
    return id.slice(0, length);
  });
}
var SHORT_ID = 8;
function loreText(item) {
  return [item.entry.title, [...item.entry.keys, ...item.entry.secondaryKeys].join(", "), item.entry.content].filter((part) => part !== "").join(`
`);
}
function loreExcerpt(item, piece, max) {
  const { content } = item.entry;
  const head = loreText(item).length - content.length;
  const start = Math.max(0, piece.start - head);
  const end = piece.end - head;
  return excerptOf(content, end > start ? { start, end } : { start: 0, end: content.length }, max);
}
function loreView(host, turn, settings) {
  const books = once(() => host.lore.books(turn.chatId));
  const items = once(async () => {
    const read2 = await Promise.all((await books()).map(async (book) => ({ book, entries: await host.lore.entries(book.id) })));
    const all = read2.flatMap(({ book, entries }) => entries.map((entry) => ({ entry, book })));
    const short = shortIds(all.map((x) => x.entry.id), SHORT_ID);
    return all.map((x, i) => ({ ...x, short: short[i] ?? x.entry.id }));
  });
  const index = once(async () => {
    const built = new LexicalIndex(settings.pieceChars);
    (await items()).forEach((item, at) => built.add(at, loreText(item)));
    return built;
  });
  const activated = once(() => host.lore.activated(turn.chatId, turn.generationId));
  return { books, items, index, activated };
}

// src/core/tools/lore.ts
function flags(item, texts) {
  return `${item.entry.enabled ? "" : texts.render(TEXT.answer.loreOff)}${item.entry.constant ? texts.render(TEXT.answer.loreAlways) : ""}`;
}
function keys(item, texts) {
  const all = [...item.entry.keys, ...item.entry.secondaryKeys];
  return all.length > 0 ? all.join(", ") : texts.render(TEXT.session.none);
}
function named(items, ref) {
  const id = ref.replace(/^\[|\]$/g, "").split("/").at(-1)?.trim() ?? "";
  if (id === "")
    return [];
  const exact = items.filter((item) => item.entry.id === id || item.short === id);
  return exact.length > 0 ? exact.slice(0, 1) : items.filter((item) => item.entry.id.startsWith(id));
}
var loreIndex = {
  name: TOOL.loreIndex,
  build(env) {
    const { texts } = env;
    const p = pagerOf(env, TOOL.loreIndex);
    return {
      name: TOOL.loreIndex,
      description: texts.render(TEXT.tool(TOOL.loreIndex)),
      parameters: { type: "object", properties: { book: { type: "string", description: texts.render(TEXT.toolArg(TOOL.loreIndex, "book")) }, cursor: { type: "string", description: texts.render(TEXT.toolArg(TOOL.loreIndex, "cursor")) } } },
      async run(args) {
        const cursor = readCursor(p, args);
        if ("text" in cursor)
          return cursor;
        const books = await env.lore.books();
        if (books.length === 0)
          return { text: texts.render(TEXT.answer.loreNoBooks) };
        const wanted = textArg(args.book);
        const shown2 = wanted === null ? books : books.filter((b) => b.id === wanted || b.name.trim().toLowerCase() === wanted.toLowerCase());
        if (shown2.length === 0)
          return { text: fitted(p, books.map((b) => `\u201C${b.name}\u201D [${b.id}]`).join(", "), (list) => texts.render(TEXT.answer.loreNoBook, { book: wanted ?? "", books: list })), error: true };
        const items = (await env.lore.items()).filter((item) => shown2.some((b) => b.id === item.book.id));
        const heading = (bookId) => {
          const book = shown2.find((b) => b.id === bookId);
          const count2 = items.filter((item) => item.book.id === bookId).length;
          return book ? texts.render(TEXT.answer.loreBook, { name: book.name, id: book.id, count: texts.counted(count2, TEXT.word.entry), description: book.description.trim() === "" ? "" : ` \u2014 ${clip(book.description.trim(), env.settings.tools.lineChars)}` }) : "";
        };
        if (items.length === 0)
          return { text: shown2.map((b) => heading(b.id)).join(`
`) };
        return listPage(p, {
          total: items.length,
          noun: TEXT.word.entry,
          cursor,
          item: (i, first) => {
            const item = items[i];
            if (!item)
              return "";
            const line = texts.render(TEXT.answer.loreEntry, { id: item.short, title: item.entry.title, flags: flags(item, texts), keys: clip(keys(item, texts), env.settings.tools.lineChars), chars: String(item.entry.content.length) });
            return first || items[i - 1]?.book.id !== item.book.id ? `${heading(item.book.id)}
${line}` : line;
          }
        });
      }
    };
  }
};
var loreSearch = {
  name: TOOL.loreSearch,
  build(env) {
    const { texts } = env;
    const p = pagerOf(env, TOOL.loreSearch);
    return {
      name: TOOL.loreSearch,
      description: texts.render(TEXT.tool(TOOL.loreSearch)),
      parameters: { type: "object", properties: { query: { type: "string", description: texts.render(TEXT.toolArg(TOOL.loreSearch, "query")) }, cursor: { type: "string", description: texts.render(TEXT.toolArg(TOOL.loreSearch, "cursor")) } }, required: ["query"] },
      async run(args) {
        const query = textArg(args.query);
        if (query === null)
          return needs(p, "query");
        const cursor = readCursor(p, args);
        if ("text" in cursor)
          return cursor;
        const items = await env.lore.items();
        if (items.length === 0)
          return { text: texts.render(TEXT.answer.loreNoBooks) };
        const hits = (await env.lore.index()).search(query);
        if (hits.length === 0)
          return { text: texts.render(TEXT.answer.loreSearchNothing, { query }) };
        return listPage(p, {
          total: hits.length,
          noun: TEXT.word.entry,
          cursor,
          item: (i) => {
            const hit = hits[i];
            const item = hit ? items[hit.key] : undefined;
            return hit && item ? texts.render(TEXT.answer.loreHit, { id: item.short, title: item.entry.title, flags: flags(item, texts), book: item.book.name, chars: String(item.entry.content.length), excerpt: loreExcerpt(item, hit.piece, env.settings.tools.excerptChars) }) : "";
          }
        });
      }
    };
  }
};
var loreGrep = {
  name: TOOL.loreGrep,
  build(env) {
    const { texts } = env;
    const p = pagerOf(env, TOOL.loreGrep);
    return {
      name: TOOL.loreGrep,
      description: texts.render(TEXT.tool(TOOL.loreGrep)),
      parameters: { type: "object", properties: { text: { type: "string", description: texts.render(TEXT.toolArg(TOOL.loreGrep, "text")) }, cursor: { type: "string", description: texts.render(TEXT.toolArg(TOOL.loreGrep, "cursor")) } }, required: ["text"] },
      async run(args) {
        const needle = textArg(args.text);
        if (needle === null)
          return needs(p, "text");
        const cursor = readCursor(p, args);
        if ("text" in cursor)
          return cursor;
        const items = await env.lore.items();
        if (items.length === 0)
          return { text: texts.render(TEXT.answer.loreNoBooks) };
        const found = grepLines(items.map((item) => item.entry.content), needle);
        if (found.length === 0)
          return { text: texts.render(TEXT.answer.loreGrepNothing, { query: needle }) };
        return listPage(p, {
          total: found.length,
          noun: TEXT.word.line,
          cursor,
          item: (i) => {
            const line = found[i];
            const item = line ? items[line.key] : undefined;
            return line && item ? texts.render(TEXT.answer.loreLine, { id: item.short, title: item.entry.title, line: String(line.line), text: around(line.text, line.at, needle.length, env.settings.tools.lineChars) }) : "";
          }
        });
      }
    };
  }
};
var loreRead = {
  name: TOOL.loreRead,
  build(env) {
    const { texts } = env;
    const p = pagerOf(env, TOOL.loreRead);
    return {
      name: TOOL.loreRead,
      description: texts.render(TEXT.tool(TOOL.loreRead)),
      parameters: { type: "object", properties: { id: { type: "string", description: texts.render(TEXT.toolArg(TOOL.loreRead, "id")) }, cursor: { type: "string", description: texts.render(TEXT.toolArg(TOOL.loreRead, "cursor")) } }, required: ["id"] },
      async run(args) {
        const ref = textArg(args.id);
        if (ref === null)
          return needs(p, "id");
        const cursor = readCursor(p, args);
        if ("text" in cursor)
          return cursor;
        const found = named(await env.lore.items(), ref);
        const [item] = found;
        if (!item)
          return { text: texts.render(TEXT.answer.loreNoEntry, { id: ref }), error: true };
        if (found.length > 1)
          return { text: fitted(p, found.map((x) => `[${x.short}] ${x.entry.title}`).join(", "), (list) => texts.render(TEXT.answer.loreAmbiguous, { id: ref, entries: list })), error: true };
        return textPage(p, {
          text: item.entry.content,
          from: cursor.at,
          given: cursor.given,
          frame: (part) => texts.render(TEXT.answer.loreRead, { id: item.short, title: item.entry.title, flags: flags(item, texts), book: item.book.name, keys: clip(keys(item, texts), env.settings.tools.lineChars), from: String(part.from), to: String(part.to), chars: String(item.entry.content.length), text: part.text })
        });
      }
    };
  }
};
var activeLore = {
  name: TOOL.activeLore,
  build(env) {
    const { texts } = env;
    const p = pagerOf(env, TOOL.activeLore);
    return {
      name: TOOL.activeLore,
      description: texts.render(TEXT.tool(TOOL.activeLore)),
      parameters: { type: "object", properties: { cursor: { type: "string", description: texts.render(TEXT.toolArg(TOOL.activeLore, "cursor")) } } },
      async run(args) {
        const cursor = readCursor(p, args);
        if ("text" in cursor)
          return cursor;
        const active = await env.lore.activated();
        if (active.length === 0)
          return { text: texts.render(TEXT.answer.activeNone) };
        const items = await env.lore.items();
        return listPage(p, {
          total: active.length,
          noun: TEXT.word.entry,
          cursor,
          item: (i) => {
            const entry = active[i];
            if (!entry)
              return "";
            const item = items.find((x) => x.entry.id === entry.entryId);
            return texts.render(TEXT.answer.activeEntry, { id: item?.short ?? entry.entryId, title: entry.title, book: item?.book.name ?? entry.bookId, chars: String(entry.content.length), excerpt: clip(entry.content.replace(/\s+/g, " ").trim(), env.settings.tools.excerptChars) });
          }
        });
      }
    };
  }
};
var LORE_TOOLS = [loreIndex, loreSearch, loreGrep, loreRead, activeLore];

// src/core/tools/past-turn.ts
var pastTurn = {
  name: TOOL.pastTurn,
  build(env) {
    const { texts, past } = env;
    const p = pagerOf(env, TOOL.pastTurn);
    const what = (step, turn) => {
      if (step.kind === "call")
        return texts.render(step.error ? TEXT.answer.pastFailed : TEXT.answer.pastCall, { tool: step.name, args: clip(JSON.stringify(step.args), env.settings.tools.lineChars) });
      if (step.kind === "said")
        return texts.render(TEXT.answer.pastSaid);
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
          cursor: { type: "string", description: texts.render(TEXT.toolArg(TOOL.pastTurn, "cursor")) }
        }
      },
      async run(args) {
        const cursor = readCursor(p, args);
        if ("text" in cursor)
          return cursor;
        if (past.length === 0)
          return { text: texts.render(TEXT.answer.pastNone) };
        const reply = wholeArg(args.reply);
        const turn = reply === null ? undefined : past.findLast((t) => t.reply === reply);
        if (reply !== null && !turn)
          return { text: fitted(p, past.map((t) => `#${t.reply}`).join(", "), (list) => texts.render(TEXT.answer.pastNoTurn, { reply: String(reply), replies: list })), error: true };
        const needle = textArg(args.grep);
        if (needle !== null) {
          const read2 = turn ? [turn] : past.slice(-env.settings.tools.grepTurns);
          const steps2 = read2.flatMap((t) => t.segment.steps.map((step2, i) => ({ turn: t, n: i + 1, step: step2 })));
          const found = grepLines(steps2.map((s) => stepText(s.step)), needle);
          const where = turn ? texts.render(TEXT.answer.pastWhereReply, { reply: String(turn.reply) }) : texts.render(TEXT.answer.pastWhereLatest, { turns: texts.counted(read2.length, TEXT.word.turn) });
          if (found.length === 0)
            return { text: texts.render(TEXT.answer.pastGrepNothing, { where, query: needle }) };
          return listPage(p, {
            total: found.length,
            noun: TEXT.word.line,
            cursor,
            item: (i) => {
              const line = found[i];
              const at = line ? steps2[line.key] : undefined;
              return line && at ? texts.render(TEXT.answer.pastLine, { reply: String(at.turn.reply), n: String(at.n), line: String(line.line), text: around(line.text, line.at, needle.length, env.settings.tools.lineChars) }) : "";
            }
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
            }
          });
        }
        const { steps } = turn.segment;
        const n = wholeArg(args.step);
        if (n === null) {
          if (steps.length === 0)
            return { text: `${toldOf(turn.segment, texts)}
${texts.render(TEXT.session.receiptNothing)}` };
          return listPage(p, {
            total: steps.length,
            noun: TEXT.word.step,
            cursor,
            lead: texts.render(TEXT.answer.pastTurn, { told: toldOf(turn.segment, texts) }),
            item: (i) => {
              const step2 = steps[i];
              if (!step2)
                return "";
              const shown2 = step2.kind === "call" ? step2.result : stepText(step2);
              return texts.render(TEXT.answer.pastStep, { n: String(i + 1), what: what(step2, turn), chars: String(stepText(step2).length), first: clip(shown2.replace(/\s+/g, " ").trim(), env.settings.tools.excerptChars) });
            }
          });
        }
        const step = steps[n - 1];
        if (!step || n < 1)
          return { text: texts.render(TEXT.answer.pastNoStep, { reply: String(turn.reply), count: texts.counted(steps.length, TEXT.word.step), last: String(steps.length) }), error: true };
        const whole2 = stepText(step);
        return textPage(p, {
          text: whole2,
          from: cursor.at,
          given: cursor.given,
          frame: (part) => texts.render(TEXT.answer.pastRead, { reply: String(turn.reply), n: String(n), what: what(step, turn), from: String(part.from), to: String(part.to), chars: String(whole2.length), text: part.text })
        });
      }
    };
  }
};
var PAST_TOOLS = [pastTurn];

// src/core/tools/preset.ts
var presetInstructions = {
  name: TOOL.presetInstructions,
  build(env) {
    const { texts } = env;
    const p = pagerOf(env, TOOL.presetInstructions);
    let read2;
    const instructions = () => read2 ??= env.turn.presetId === null ? Promise.resolve([]) : env.host.preset.blocks(env.turn.presetId).then((blocks) => blocks.filter((b) => b.kind === "instruction"));
    const off = (b) => b.enabled ? "" : texts.render(TEXT.answer.presetOff);
    return {
      name: TOOL.presetInstructions,
      description: texts.render(TEXT.tool(TOOL.presetInstructions)),
      parameters: { type: "object", properties: { block: { type: "string", description: texts.render(TEXT.toolArg(TOOL.presetInstructions, "block")) }, cursor: { type: "string", description: texts.render(TEXT.toolArg(TOOL.presetInstructions, "cursor")) } } },
      async run(args) {
        const cursor = readCursor(p, args);
        if ("text" in cursor)
          return cursor;
        const blocks = await instructions();
        if (blocks.length === 0)
          return { text: texts.render(TEXT.answer.presetNone) };
        const wanted = textArg(args.block)?.replace(/^\[|\]$/g, "");
        if (wanted === undefined) {
          return listPage(p, {
            total: blocks.length,
            noun: TEXT.word.block,
            cursor,
            item: (i) => {
              const b = blocks[i];
              return b ? texts.render(TEXT.answer.presetBlock, { id: b.id, name: b.name, role: b.role, flags: off(b), chars: String(b.content.length), excerpt: clip(b.content.replace(/\s+/g, " ").trim(), env.settings.tools.excerptChars) }) : "";
            }
          });
        }
        const block = blocks.find((b) => b.id === wanted) ?? blocks.find((b) => b.name.trim().toLowerCase() === wanted.toLowerCase());
        if (!block)
          return { text: fitted(p, blocks.map((b) => `\u201C${b.name}\u201D [${b.id}]`).join(", "), (list) => texts.render(TEXT.answer.presetNoBlock, { block: wanted, blocks: list })), error: true };
        return textPage(p, {
          text: block.content,
          from: cursor.at,
          given: cursor.given,
          frame: (part) => texts.render(TEXT.answer.presetRead, { name: block.name, id: block.id, role: block.role, flags: off(block), from: String(part.from), to: String(part.to), chars: String(block.content.length), text: part.text })
        });
      }
    };
  }
};
var PRESET_TOOLS = [presetInstructions];

// src/core/tools/write-reply.ts
var writeReply = {
  name: TOOL.writeReply,
  build(env) {
    const { texts, writeReply: write } = env;
    if (!write)
      return null;
    return {
      name: TOOL.writeReply,
      description: texts.render(TEXT.tool(TOOL.writeReply)),
      parameters: { type: "object", properties: { brief: { type: "string", description: texts.render(TEXT.toolArg(TOOL.writeReply, "brief")) } }, required: ["brief"] },
      async run(args, ctx) {
        const brief = textArg(args.brief);
        return brief === null ? { text: texts.render(TEXT.answer.replyNoBrief), error: true } : write(brief, ctx);
      }
    };
  }
};
var REPLY_TOOLS = [writeReply];

// src/core/tools/base.ts
var BASE_TOOLS = [...CHAT_TOOLS, ...LORE_TOOLS, ...PRESET_TOOLS, ...PAST_TOOLS, ...REPLY_TOOLS];

// src/core/prompts.ts
class PromptKeeper {
  blobs;
  last = new Map;
  constructor(blobs) {
    this.blobs = blobs;
  }
  async keep(agentId, request) {
    const { messages, ...rest } = request;
    const json = messages.map((m) => JSON.stringify(m));
    const before = this.last.get(agentId);
    let shared = 0;
    if (before)
      while (shared < json.length && shared < before.messages.length && json[shared] === before.messages[shared])
        shared++;
    const stored = { v: 1, kind: "prompt", request: rest, base: before && shared > 0 ? before.hash : null, keep: before ? shared : 0, messages: messages.slice(shared) };
    const hash = await this.blobs.put(JSON.stringify(stored), false);
    this.last.set(agentId, { hash, messages: json });
    return hash;
  }
}

// src/core/transcript.ts
class TurnTrace {
  host;
  ids;
  heard;
  records = [];
  prompts;
  turn = null;
  constructor(host, ids, blobs, keepPrompts, heard = () => {
    return;
  }) {
    this.host = host;
    this.ids = ids;
    this.heard = heard;
    this.prompts = keepPrompts ? new PromptKeeper(blobs) : null;
  }
  emit(event) {
    const record = { turn: this.ids.turn, chatId: this.ids.chatId, seq: this.records.length + 1, event };
    this.records.push(record);
    try {
      this.host.trace.event(record);
    } catch (error) {
      this.host.log("warn", `a trace event wasn't delivered (${errorText(error)})`);
    }
    this.heard(event);
  }
  start(agent) {
    this.emit({ kind: "agent_started", agent });
  }
  entry(agentId, entry) {
    this.emit({ kind: "agent_entry", agentId, entry });
  }
  usage(agentId, call, agent) {
    this.emit({ kind: "usage", agentId, call, agent, turn: { ...this.turn?.usage ?? agent }, at: this.host.clock.now() });
  }
  idle(agentId, spent) {
    this.emit({ kind: "agent_idle", agentId, spent, at: this.host.clock.now() });
  }
  delta(agentId, call, piece) {
    try {
      this.host.trace.delta?.({ turn: this.ids.turn, chatId: this.ids.chatId, agentId, call, ...piece, at: this.host.clock.now() });
    } catch (error) {
      this.host.log("debug", `a piece of a streaming answer wasn't delivered to the live view (${errorText(error)})`);
    }
  }
  async prompt(agentId, request) {
    if (!this.prompts)
      return;
    try {
      return await this.prompts.keep(agentId, request);
    } catch (error) {
      this.host.log("warn", `a call's prompt wasn't kept (${errorText(error)})`);
      return;
    }
  }
  transcript(turn) {
    const transcript = { v: 1, kind: "transcript", turn: this.ids.turn, chatId: this.ids.chatId, ...turn, events: [...this.records] };
    return transcript;
  }
}

// src/core/harness.ts
function createHarness(host, options) {
  const tools = new ToolRegistry;
  tools.register(...BASE_TOOLS);
  const agents = new AgentRegistry;
  agents.register(...baseAgents());
  const blobs = new Blobs(host, () => shared.latest.keep.blobChars);
  const shared = { host, options, tools, agents, accounts: new AgentAccounts(host), blobs, sessions: new Sessions(host, blobs), memo: new CompactionMemo(() => shared.latest.keep.summaries), latest: defaultSettings() };
  return { tools, agents, answer: (turn, sink, signal) => new Turn(shared, turn, sink, signal).answer() };
}

class Stopped extends Error {
}

class Turn {
  shared;
  turn;
  sink;
  signal;
  host;
  settings;
  texts = textsOf(null);
  startedAt;
  reply = "";
  finish = "stop";
  closed = false;
  writing = false;
  written = false;
  broken = null;
  mainId = null;
  constructor(shared, turn, sink, signal) {
    this.shared = shared;
    this.turn = turn;
    this.sink = sink;
    this.signal = signal;
    this.host = shared.host;
    this.settings = shared.latest;
    this.startedAt = this.host.clock.now();
  }
  async answer() {
    const { host, turn } = this;
    try {
      const stored = await this.shared.options.settings();
      this.settings = settingsOf(stored.values, { tools: this.shared.tools.names(), agents: this.shared.agents.extra() });
      this.texts = textsOf(stored.texts);
      this.shared.latest = this.settings;
    } catch (error) {
      const reason2 = `LumiAH couldn't read its settings (${errorText(error)}), so this turn wasn't answered. Check that the runtime is linked to the extension, then try again.`;
      this.end(() => this.sink.error(reason2, "failed"));
      return { status: "failed", reason: reason2, record: null, reply: "", usage: emptyUsage() };
    }
    const trace = new TurnTrace(host, { turn: turn.generationId, chatId: turn.chatId }, this.shared.blobs, this.settings.keep.prompts, (event) => this.heard(event));
    const agents = new AgentTurn(this.settings.turn, this.startedAt, trace);
    trace.turn = agents;
    trace.emit({ kind: "turn_started", turn: turn.generationId, chatId: turn.chatId, generation: turn.kind, messageId: turn.target.messageId, at: this.startedAt });
    const work = new Work;
    let outcome;
    try {
      outcome = await this.work(work, trace, { host, settings: this.settings, texts: this.texts, accounts: this.shared.accounts, turn: agents });
    } catch (error) {
      outcome = error instanceof Stopped || this.signal.aborted ? { status: "stopped", reason: this.text(TEXT.progress.turnStopped) } : { status: "failed", reason: errorText(error) };
    }
    const usage = { ...agents.usage };
    const at = host.clock.now();
    if (outcome.status === "done")
      this.end(() => this.sink.done(this.finish, usage));
    else if (outcome.status === "stopped" && this.reply !== "")
      this.end(() => this.sink.done("stop", usage));
    else {
      const { reason: reason2, status } = outcome;
      this.progress(TEXT.progress.stopped, { reason: reason2 });
      this.end(() => this.sink.error(reason2, status));
    }
    const reason = outcome.status === "done" ? undefined : outcome.reason;
    trace.emit({ kind: "turn_ended", status: outcome.status, ...reason !== undefined ? { reason } : {}, usage, at });
    const record = await this.record(work, trace, { status: outcome.status, at, ...reason !== undefined ? { reason } : {} }, usage);
    return { status: outcome.status, ...reason !== undefined ? { reason } : {}, record, reply: this.reply, usage };
  }
  async work(work, trace, deps) {
    const { host, turn, settings, texts, shared } = this;
    const session = await shared.sessions.resume(turn);
    work.session = session;
    this.live();
    let carried = { summary: session.summary, turns: session.turns };
    const sizes = { receiptChars: settings.session.receiptChars, charsPerToken: settings.loop.charsPerToken, texts };
    const env = { host, turn, settings, texts, agent: AGENT.main, chat: chatView(host, turn.chatId, session.before, settings.tools), lore: loreView(host, turn, settings.tools), past: carried.turns };
    if (carriedOf(carried, sizes).tokens > limitOf(settings.session.summarizeAtTokens)) {
      const made = await this.compact(carried, env, deps);
      if (made) {
        work.compaction = made.landed;
        carried = { summary: made.summary, turns: made.kept };
      }
      this.live();
    }
    const { history, lead, tokens } = carriedOf(carried, sizes);
    const { refs } = session;
    trace.emit({
      kind: "session",
      session: { turns: carried.turns.length, tokens, summary: carried.summary !== null, dropped: [...refs.dropped], missing: session.missing, ...work.compaction ? { compacted: { folded: work.compaction.folded, kept: work.compaction.kept.length, summary: work.compaction.summary } } : {}, ...refs.rolledBack !== null ? { rolledBack: { summary: refs.rolledBack } } : {} },
      at: host.clock.now()
    });
    if (carried.turns.length === 0 && carried.summary === null)
      this.progress(TEXT.progress.fresh);
    else
      this.progress(carried.summary !== null ? TEXT.progress.sessionSummary : TEXT.progress.session, { turns: texts.counted(carried.turns.length, TEXT.word.earlierTurn) });
    const droppedReplies = texts.render(refs.dropped.length === 1 ? TEXT.main.replyOne : TEXT.main.replyMany, { list: refs.dropped.map((index) => `#${index}`).join(", ") });
    if (refs.dropped.length > 0)
      this.progress(TEXT.progress.dropped, { replies: droppedReplies });
    const main = this.resolved(AGENT.main);
    const writes = settings.reply.writer === "main";
    const blocks = await this.blocks();
    const document = requestDocument(turn.messages, blocks, session.before, texts);
    work.request = { messages: document.messages, last: document.last };
    const notes = [
      ...refs.dropped.length > 0 ? [texts.render(TEXT.main.noteDropped, { replies: droppedReplies })] : [],
      ...refs.rolledBack !== null ? [texts.render(TEXT.main.noteRolledBack)] : [],
      ...session.missing > 0 ? [texts.render(TEXT.main.noteMissing, { count: texts.counted(session.missing, TEXT.word.part) })] : [],
      ...lead !== null ? [texts.render(TEXT.main.noteSummary, { summary: lead })] : [],
      ...session.continued ? [texts.render(TEXT.main.noteContinued, { receipt: receiptOf(session.continued.segment, settings.session.receiptChars, texts) })] : []
    ];
    const kinds = { new: TEXT.main.kindNew, regenerate: TEXT.main.kindRegenerate, swipe: TEXT.main.kindSwipe, continue: TEXT.main.kindContinue };
    const message = texts.render(TEXT.main.turn, { kind: texts.render(kinds[turn.kind]), notes: notes.map((note) => `${note}

`).join(""), count: texts.counted(document.messages, TEXT.word.message), request: document.text, ask: texts.render(writes ? TEXT.main.askWrites : TEXT.main.ask) });
    const past = session.continued ? [...carried.turns, session.continued] : carried.turns;
    const tools = shared.tools.build(main.tools, { ...env, past, ...writes ? {} : { writeReply: (brief, ctx) => this.writeReply(brief, ctx.agentId, env, deps) } });
    const agent = startAgent({ role: AGENT.main, connectionId: main.connectionId, model: main.model, effort: main.effort, system: texts.render(writes ? TEXT.main.systemWrites : main.definition.instructions), prefix: [], tools, budget: main.budget, history }, deps);
    this.mainId = agent.id;
    const reply = await agent.send(message, this.signal);
    work.main = agent.transcript().entries;
    work.wrote = writes;
    return writes ? this.ownReply(reply) : this.briefed(reply, agent.id, env, deps, work);
  }
  live() {
    if (this.signal.aborted)
      throw new Stopped;
  }
  resolved(id) {
    const agent = this.shared.agents.resolve(id, this.settings);
    if (!agent)
      throw new Error(`there is no agent definition "${id}"`);
    return agent;
  }
  async blocks() {
    const { presetId } = this.turn;
    if (presetId === null)
      return [];
    try {
      return await this.host.preset.blocks(presetId);
    } catch (error) {
      this.host.log("warn", `the preset ${presetId} couldn't be read (${errorText(error)}), so the request's instructions aren't marked this turn`);
      return [];
    }
  }
  ownReply(reply) {
    if (reply.status === "answered" && reply.text.trim() !== "") {
      this.content(reply.text);
      this.finish = reply.finish ?? "stop";
      this.written = true;
      return { status: "done" };
    }
    if (reply.status === "cancelled")
      return { status: "stopped", reason: this.text(TEXT.progress.turnStopped) };
    return { status: "failed", reason: reply.reason ?? this.text(TEXT.answer.replyEmpty) };
  }
  async briefed(reply, mainId, env, deps, work) {
    if (this.written)
      return { status: "done" };
    if (this.broken !== null)
      return { status: "failed", reason: this.broken };
    if (reply.status === "cancelled" || this.signal.aborted)
      return { status: "stopped", reason: this.text(TEXT.progress.turnStopped) };
    let brief = null;
    let short;
    if (reply.status === "answered" && reply.text.trim() !== "") {
      brief = reply.text.trim();
      work.briefed = brief;
    } else {
      short = reply.reason ?? this.text(TEXT.answer.replyEmpty);
      if (this.settings.reply.withoutBrief === "fail")
        return { status: "failed", reason: short };
      this.progress(TEXT.progress.writingAlone, { reason: short });
    }
    const wrote = await this.write(brief, mainId, env, deps, short);
    if (wrote.ok)
      return { status: "done" };
    return wrote.stopped ? { status: "stopped", reason: this.text(TEXT.progress.turnStopped) } : { status: "failed", reason: wrote.reason };
  }
  async compact(carried, env, deps) {
    const { settings, texts, shared } = this;
    const fold = foldOf(carried, { keep: settings.session.keepTurns, limit: settings.session.summaryTokens, receiptChars: settings.session.receiptChars, texts });
    if (!fold)
      return null;
    const summarizer = this.resolved(AGENT.summarizer);
    this.progress(TEXT.progress.compacting, { turns: texts.counted(fold.folded.length, TEXT.word.turn) });
    const key = await foldKey({ connectionId: summarizer.connectionId, model: summarizer.model, effort: summarizer.effort, callTokensOut: summarizer.budget.callTokensOut, system: fold.system, message: fold.message });
    const result = await shared.memo.run(key, async () => {
      const agent = startAgent({ role: AGENT.summarizer, connectionId: summarizer.connectionId, model: summarizer.model, effort: summarizer.effort, system: fold.system, prefix: [], tools: shared.tools.build(summarizer.tools, { ...env, agent: AGENT.summarizer }), budget: summarizer.budget, task: "summarize the main agent's notes" }, deps);
      return summaryOf(await agent.send(fold.message, this.signal), texts);
    });
    if ("failed" in result) {
      this.progress(TEXT.progress.notCompacted, { reason: result.failed });
      this.host.log("warn", `the main agent's notes weren't summarized (${result.failed}); they go on whole`);
      return null;
    }
    const landed = await shared.sessions.compact(result.summary, fold.kept, fold.folded.length);
    this.progress(TEXT.progress.compacted, { folded: texts.counted(fold.folded.length, TEXT.word.turn), kept: String(fold.kept.length) });
    return { landed, summary: result.summary, kept: fold.kept };
  }
  async writeReply(brief, mainId, env, deps) {
    if (this.writing || this.written || this.broken !== null)
      return { text: this.text(TEXT.answer.replyBusy), error: true };
    const wrote = await this.write(brief, mainId, env, deps);
    if (wrote.ok)
      return { text: this.reply, end: true };
    if (this.reply !== "") {
      this.broken = wrote.reason;
      return { text: this.reply, end: true };
    }
    return { text: this.text(TEXT.answer.replyFailed, { reason: wrote.reason }), error: true };
  }
  async write(brief, parent, env, deps, short) {
    const { turn, settings, texts, shared } = this;
    this.writing = true;
    try {
      const writer = this.resolved(AGENT.writer);
      if (brief !== null)
        this.progress(TEXT.progress.writing);
      const agent = startAgent({
        role: AGENT.writer,
        connectionId: writer.connectionId,
        model: writer.model,
        effort: writer.effort,
        system: "",
        prefix: [],
        tools: shared.tools.build(writer.tools, { ...env, agent: AGENT.writer }),
        budget: { ...writer.budget, callTokensOut: turn.maxTokens ?? writer.budget.callTokensOut },
        history: writerMessages(turn.messages, brief, settings.reply, texts),
        params: turn.params,
        onDelta: (delta) => this.delta(delta),
        parent,
        task: brief !== null ? "write the reply from the brief" : `write the reply without a brief: the main agent stopped short of one (${short ?? "no reason given"})`
      }, deps);
      const reply = await agent.run(this.signal);
      if (reply.status !== "answered")
        return { ok: false, reason: reply.reason ?? texts.render(TEXT.answer.replyEmpty), stopped: reply.status === "cancelled" };
      if (reply.text.startsWith(this.reply))
        this.content(reply.text.slice(this.reply.length));
      if (this.reply.trim() === "")
        return { ok: false, reason: texts.render(TEXT.answer.replyEmpty), stopped: false };
      this.finish = reply.finish ?? "stop";
      this.written = true;
      return { ok: true };
    } finally {
      this.writing = false;
    }
  }
  text(id, vars = {}) {
    return this.texts.render(id, vars);
  }
  toSink(send) {
    if (this.closed)
      return;
    try {
      send();
    } catch (error) {
      this.host.log("warn", `the reply's stream took nothing (${errorText(error)})`);
    }
  }
  end(send) {
    this.toSink(send);
    this.closed = true;
  }
  content(text) {
    if (text === "")
      return;
    this.reply += text;
    this.toSink(() => this.sink.content(text));
  }
  delta(delta) {
    const { reasoning } = delta;
    if (reasoning !== undefined && reasoning !== "")
      this.toSink(() => this.sink.reasoning(reasoning));
    if (delta.content !== undefined)
      this.content(delta.content);
  }
  progress(id, vars = {}) {
    const { progress, progressChars } = this.settings.reply;
    if (progress)
      this.toSink(() => this.sink.progress(clip(this.text(id, vars), progressChars)));
  }
  heard(event) {
    if (event.kind !== "agent_entry")
      return;
    const { entry } = event;
    if (entry.kind === "retry")
      this.progress(TEXT.progress.retry, { reason: entry.reason, attempt: String(entry.attempt), retries: String(entry.of) });
    if (event.agentId !== this.mainId || entry.kind !== "answer")
      return;
    for (const call of entry.calls)
      this.progress(TEXT.progress.call, { tool: call.name, args: JSON.stringify(call.args) });
  }
  async record(work, trace, ended, usage) {
    const { turn, settings, shared } = this;
    const { session } = work;
    if (this.reply === "" || !session)
      return null;
    try {
      const own = stepsOf(work, { reply: String(session.reply), chars: String(this.reply.length), texts: this.texts, stopped: ended.reason });
      const segment = { v: 1, kind: "segment", reply: session.reply, generationId: turn.generationId, turn: turn.kind, at: ended.at, request: work.request, steps: [...session.continued?.segment.steps ?? [], ...own] };
      const segmentHash = await shared.sessions.segment(segment);
      const transcript = settings.keep.transcripts ? await shared.blobs.putJson(trace.transcript({ generation: turn.kind, messageId: turn.target.messageId, startedAt: this.startedAt, ended }), false) : undefined;
      return { v: 1, generationId: turn.generationId, kind: turn.kind, at: ended.at, path: session.path, segment: segmentHash, ...transcript !== undefined ? { transcript } : {}, ...work.compaction ? { summary: work.compaction.summary, kept: work.compaction.kept, folded: work.compaction.folded } : {}, usage };
    } catch (error) {
      this.host.log("warn", `the turn's record wasn't made (${errorText(error)}): the reply stands, and the main agent's notes won't hold this turn`);
      return null;
    }
  }
}

class Work {
  session = null;
  compaction = null;
  request = { messages: 0, last: null };
  main = [];
  wrote = false;
  briefed = null;
}
function stepsOf(work, input) {
  const { texts } = input;
  const written = texts.render(TEXT.session.replyWritten, { chars: input.chars, reply: input.reply });
  const results = new Map;
  for (const entry of work.main)
    if (entry.kind === "result")
      results.set(entry.callId, entry);
  const answers = work.main.filter((entry) => entry.kind === "answer");
  const steps = [];
  for (const entry of work.main) {
    if (entry.kind === "stop")
      steps.push({ kind: "stop", reason: entry.reason });
    if (entry.kind !== "answer")
      continue;
    const final = entry === answers.at(-1) && entry.calls.length === 0;
    if (final && work.wrote)
      steps.push({ kind: "reply", chars: Number(input.chars) });
    else if (final && work.briefed !== null)
      steps.push({ kind: "call", name: TOOL.writeReply, args: { brief: work.briefed }, result: written });
    else if (entry.text.trim() !== "")
      steps.push({ kind: "said", text: entry.text });
    for (const call of entry.calls) {
      const result = results.get(call.id);
      if (!result)
        continue;
      const replied = call.name === TOOL.writeReply && !result.error;
      steps.push({ kind: "call", name: call.name, args: call.args, result: replied ? written : result.text, ...result.error ? { error: true } : {} });
    }
  }
  if (input.stopped !== undefined && !steps.some((step) => step.kind === "stop"))
    steps.push({ kind: "stop", reason: input.stopped });
  return steps;
}
// src/link/json.ts
function isRecord2(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
function hasOwn2(object, key) {
  return Object.prototype.hasOwnProperty.call(object, key);
}

// src/link/contract.ts
var LINK_VERSION = 1;
var LINK = "lumiah-link";
var EXTENSION_IDENTIFIER = "lumi_ah";
var MODEL_ID = "lumiah";
var TAG_PARAM = "lumiah_turn";
var RUNTIME_NAME = /^[a-z0-9][a-z0-9_-]{0,39}$/;
var FRAME_LIMIT = 4 * 1024 * 1024;
function terminal(chunk) {
  return chunk.kind === "done" || chunk.kind === "error";
}
function versionWords(runtime, extension) {
  if (runtime < extension)
    return `This runtime speaks link version ${runtime} and LumiAH ${extension}: update the runtime by running its start line on LumiAH's Runtime page again.`;
  return `This runtime speaks link version ${runtime} and LumiAH ${extension}: update LumiAH in Lumiverse (Extensions \u2192 LumiAH \u2192 Update), then restart the runtime.`;
}
function contentMark(role, text) {
  let hash = 2166136261;
  for (let i = 0;i < text.length; i++) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return `${role.charAt(0)}${text.length.toString(36)}.${(hash >>> 0).toString(36)}`;
}
function runtimeBase(listen, port) {
  const host = listen.includes(":") && !listen.startsWith("[") ? `[${listen}]` : listen;
  return `http://${host}:${port}/v1`;
}
function shellWord(word2) {
  return /^[A-Za-z0-9_./:@%+=,-]+$/.test(word2) ? word2 : `'${word2.replaceAll("'", "'\\''")}'`;
}
function unitName(name) {
  return `lumiah-${name}.service`;
}

// src/link/settings.ts
var TRANSPORT_KEY = "transport";
var RUNTIME_DEFAULTS = Object.freeze({
  commentMs: 5000,
  progressMs: 60000,
  stallMs: 30 * 60000,
  lostMs: 120000,
  probeMs: 15000,
  heartbeatMs: 60000,
  silentMs: 45000,
  crashMs: 1e4,
  resendMs: 3000,
  resendTries: 5,
  ackEvery: 64,
  requestMs: 60000,
  socketPingMs: 45000,
  modelsWaitMs: 1e4,
  maxBodyBytes: 4 * 1024 * 1024 - 64 * 1024,
  drainMs: 5 * 60000,
  drainPollMs: 2000,
  connectionsRead: 200,
  reconnectMs: 1000,
  reconnectMaxMs: 30000,
  sessionCheckMs: 24 * 60 * 60000,
  stopGraceMs: 500,
  traceMs: 100,
  traceBatch: 64,
  traceHeld: 20000,
  turnWaitMs: 30000,
  joinMaxUnits: 32 * 1024 * 1024,
  partStaleMs: 60000
});
var TRANSPORT_DEFAULTS = Object.freeze({
  history: Object.freeze({ keep: "last", count: 40 }),
  tags: Object.freeze({ lifeMs: 2 * 60 * 60000, held: 256 }),
  streams: Object.freeze({ coalesceMs: 40, keepMs: 10 * 60000 }),
  connections: Object.freeze({ oneToolAtATime: Object.freeze([]) }),
  link: Object.freeze({ quietMs: 120000, relays: 8, connectionMs: 15000, joinMaxUnits: 32 * 1024 * 1024, partStaleMs: 60000 }),
  live: Object.freeze({ events: 20000, page: 500, chats: 32, lostMs: 30000 }),
  anchors: Object.freeze({ waitMs: 10 * 60000, held: 64 }),
  sessions: Object.freeze({ previewChars: 120, page: 50, pathsKept: 16 }),
  runtime: RUNTIME_DEFAULTS
});
var ms = (title, description, minimum, maximum) => ({ type: "integer", title, description, minimum, maximum, "x-unit": "ms" });
var whole2 = (title, description, minimum, maximum, unit) => ({ type: "integer", title, description, minimum, maximum, ...unit !== undefined ? { "x-unit": unit } : {} });
var DAY_MS = 24 * 60 * 60000;
var TRANSPORT_SCHEMA = {
  type: "object",
  title: "Transport",
  description: "How LumiAH's runtime, its link to this extension and the extension itself carry a reply. The defaults suit a runtime on the same machine as Lumiverse.",
  additionalProperties: false,
  properties: {
    history: {
      type: "object",
      title: "History cutoff",
      description: "Which of the chat's messages stay in the prompt Lumiverse sends for a reply LumiAH answers. The main agent reads the rest of the chat with its tools when a reply needs it.",
      additionalProperties: false,
      properties: {
        keep: {
          title: "Keep",
          oneOf: [
            { const: "last", title: "The latest messages", description: "Only the latest messages stay; how many is set below." },
            { const: "all", title: "Every message", description: "Nothing is left out: the prompt is as large as Lumiverse makes it." }
          ]
        },
        count: whole2("Latest messages kept", "How many of the chat's latest messages stay in the prompt when only the latest are kept.", 1, 1e4, "messages")
      }
    },
    tags: {
      type: "object",
      title: "Turn tags",
      description: "The single-use tag the prompt interceptor puts on each generation LumiAH answers.",
      additionalProperties: false,
      properties: {
        lifeMs: ms("A tag's life", "How long after a generation starts its tag still admits its request.", 60000, DAY_MS),
        held: whole2("Tags remembered", "The most tags remembered at once; the oldest is let go first.", 8, 4096)
      }
    },
    streams: {
      type: "object",
      title: "Streams",
      description: "How a model call's answer travels from this extension to the runtime.",
      additionalProperties: false,
      properties: {
        coalesceMs: ms("Text held back", "How long a stream's text waits to be sent with what follows it. Lower shows text sooner in more, smaller pieces.", 0, 2000),
        keepMs: ms("Unacknowledged chunks kept", "How long a finished stream's chunks are kept for an acknowledgement that never came.", 1e4, DAY_MS)
      }
    },
    connections: {
      type: "object",
      title: "Connections",
      description: "What LumiAH must know of a connection that Lumiverse doesn't say.",
      additionalProperties: false,
      properties: {
        oneToolAtATime: {
          type: "array",
          title: "One tool call per answer",
          description: "Connections whose model must call one tool at a time: a call on one asks its provider for no parallel tool calls. Add a connection here when its model's answers with several tool calls at once come back broken.",
          uniqueItems: true,
          items: { type: "string", format: "connection", maxLength: 256 }
        }
      }
    },
    link: {
      type: "object",
      title: "Link",
      description: "The extension's end of the link to your runtimes.",
      additionalProperties: false,
      properties: {
        quietMs: ms("Quiet after", "How long without a word from a runtime before the Runtime page shows it as quiet.", 1e4, DAY_MS),
        relays: whole2("Runtimes per account", "The runtimes one account may have registered at once.", 1, 64, "runtimes"),
        connectionMs: ms("Wait for the connection", "How long minting a key waits for your linked runtime to make the loopback connection.", 1000, 5 * 60000),
        joinMaxUnits: whole2("Largest frame joined", "The largest frame the extension puts together from parts: a stored transcript or a model call's prompt may be this long.", 1024 * 1024, 256 * 1024 * 1024, "characters"),
        partStaleMs: ms("Parts kept", "How long the first parts of a frame wait for the rest.", 1000, 60 * 60000)
      }
    },
    live: {
      type: "object",
      title: "Live view",
      description: "What the extension keeps of each chat's current turn for the Live page.",
      additionalProperties: false,
      properties: {
        events: whole2("Events kept per turn", "The most events kept of a chat's live turn; past it the reply's later events stay out of the Live page (its stored transcript is whole all the same).", 100, 1e6, "events"),
        page: whole2("Events per read", "The most events one read of a live view or a stored transcript answers.", 10, 1e4, "events"),
        chats: whole2("Chats kept", "The most chats whose latest turn is kept for the Live page.", 1, 1024, "chats"),
        lostMs: ms("Lost after", "How long after its generation ended a turn that never said it ended counts as lost.", 1000, 60 * 60000)
      }
    },
    anchors: {
      type: "object",
      title: "Anchors",
      description: "The record each turn leaves on its reply's message.",
      additionalProperties: false,
      properties: {
        waitMs: ms("Wait for the reply", "How long a turn's record waits for Lumiverse to save the reply before it is let go.", 1e4, DAY_MS),
        held: whole2("Records waiting", "The most records waiting for their replies at once.", 1, 4096, "records")
      }
    },
    sessions: {
      type: "object",
      title: "Sessions page",
      additionalProperties: false,
      properties: {
        previewChars: whole2("Reply preview", "How much of a reply's opening the Sessions page shows to find it by.", 0, 2000, "characters"),
        page: whole2("Turns per page", "The most turns one page of the Sessions list holds.", 1, 500, "turns"),
        pathsKept: whole2("Chats kept in memory", "The most chats whose list of messages (without their text) is kept in memory until the chat changes, so a reply reads its chat once. 0 keeps none: every read asks Lumiverse again.", 0, 1024, "chats")
      }
    },
    runtime: {
      type: "object",
      title: "Runtime",
      description: "The runtime's own limits and timings. It reads them when it links and whenever you change them; until it has linked it uses the ones it last read.",
      additionalProperties: false,
      properties: {
        commentMs: ms("Keep-alive comment", "A comment goes out on a reply's stream after this much silence, so nothing between the runtime and Lumiverse closes it.", 1000, 60000),
        progressMs: ms("Progress line", "A progress line is restated in the thinking block after this long without a token, so Lumiverse sees the reply alive.", 5000, 10 * 60000),
        stallMs: ms("Stream stalled after", "A model call with nothing from this extension for this long is given up.", 1e4, DAY_MS),
        lostMs: ms("Extension lost after", "How long this extension may stay out of the runtime's reach during a reply before the reply ends.", 5000, 60 * 60000),
        probeMs: ms("Ping while working", "How often the runtime pings while it answers a reply.", 1000, 5 * 60000),
        heartbeatMs: ms("Ping while idle", "How often the runtime pings while it answers none.", 5000, 60 * 60000),
        silentMs: ms("Silent after", "How long a request may go unanswered, with nothing heard meanwhile, before this extension counts as silent.", 5000, 60 * 60000),
        crashMs: ms("Crashed after", "After Lumiverse reports an error in this extension, how long silence makes it a crash.", 1000, 5 * 60000),
        resendMs: ms("Ask again after", "How long a gap in a stream waits before the missing chunk is asked for again.", 500, 60000),
        resendTries: whole2("Times to ask again", "How many times a gap is asked about before its stream is given up.", 1, 50, "times"),
        ackEvery: whole2("Chunks per acknowledgement", "How many chunks of a stream go by between acknowledgements.", 1, 4096, "chunks"),
        requestMs: ms("Request wait", "How long each request to this extension waits for its answer.", 5000, 60 * 60000),
        socketPingMs: ms("Socket ping", "How often the runtime pings Lumiverse's event socket. Lumiverse closes one idle for two minutes.", 5000, 110000),
        modelsWaitMs: ms("Model list wait", "How long the connection's model list waits for the link to come up.", 1000, 5 * 60000),
        maxBodyBytes: whole2("Largest request", "The largest request the runtime reads from Lumiverse. A larger one is refused: lower the connection's context size, or the history cutoff.", 64 * 1024, 64 * 1024 * 1024, "bytes"),
        drainMs: ms("Wait before restart", "How long setting the runtime up again waits for replies under way before it restarts it.", 0, 60 * 60000),
        drainPollMs: ms("Restart poll", "How often it asks meanwhile.", 500, 60000),
        connectionsRead: whole2("Connections read", "How many of your connections the runtime reads when it looks for the loopback's.", 10, 200, "connections"),
        reconnectMs: ms("First reconnect wait", "The first wait before the runtime reconnects to Lumiverse; each failure doubles it.", 100, 60000),
        reconnectMaxMs: ms("Longest reconnect wait", "The longest wait between two tries to reconnect.", 1000, 60 * 60000),
        sessionCheckMs: ms("Session check", "How often the runtime asks Lumiverse about its session, which renews it.", 60000, 7 * DAY_MS),
        stopGraceMs: ms("Stop grace", "How long a stopping runtime waits for its last words to go out.", 0, 30000),
        traceMs: ms("Trace held back", "How long the runtime holds trace events to send them together.", 0, 5000),
        traceBatch: whole2("Trace events per request", "The most trace events one request carries to the Live page.", 1, 4096, "events"),
        traceHeld: whole2("Trace events held", "The most trace events held while they can't be sent; past it a reply's later events stay out of the Live page (its stored transcript is whole all the same).", 100, 1e6, "events"),
        turnWaitMs: ms("Wait for the earlier reply", "How long a new reply waits for the chat's earlier one to stop before it is refused.", 1000, 10 * 60000),
        joinMaxUnits: whole2("Largest frame joined", "The largest frame the runtime puts together from parts.", 1024 * 1024, 256 * 1024 * 1024, "characters"),
        partStaleMs: ms("Parts kept", "How long the first parts of a frame wait for the rest.", 1000, 60 * 60000)
      }
    }
  }
};
function check(schema, value, path, problems) {
  const title = typeof schema.title === "string" ? schema.title : String(path.at(-1) ?? "This setting");
  if (Array.isArray(schema.oneOf)) {
    const choices = schema.oneOf.flatMap((c) => isRecord2(c) && c.const !== undefined ? [c.const] : []);
    if (!choices.some((c) => c === value))
      problems.push({ path, message: `${title} must be one of: ${choices.map(String).join(", ")}.` });
    return;
  }
  if (schema.type === "object") {
    if (!isRecord2(value)) {
      problems.push({ path, message: `${title} must be a group of settings.` });
      return;
    }
    const properties = isRecord2(schema.properties) ? schema.properties : {};
    for (const key of Object.keys(value))
      if (!hasOwn2(properties, key))
        problems.push({ path: [...path, key], message: `There is no setting ${[...path, key].join(".")}.` });
    for (const [key, child] of Object.entries(properties))
      if (hasOwn2(value, key) && isRecord2(child))
        check(child, value[key], [...path, key], problems);
    return;
  }
  if (schema.type === "array") {
    const max = isRecord2(schema.items) && typeof schema.items.maxLength === "number" ? schema.items.maxLength : Number.MAX_SAFE_INTEGER;
    if (!Array.isArray(value))
      problems.push({ path, message: `${title} must be a list.` });
    else
      value.forEach((item, i) => {
        if (typeof item !== "string" || item === "" || item.length > max)
          problems.push({ path: [...path, i], message: `${title} lists text, each at most ${max} characters.` });
        else if (value.indexOf(item) !== i)
          problems.push({ path: [...path, i], message: `${title} lists "${item}" twice.` });
      });
    return;
  }
  if (schema.type === "integer") {
    const unit = typeof schema["x-unit"] === "string" ? ` ${schema["x-unit"]}` : "";
    const min = typeof schema.minimum === "number" ? schema.minimum : Number.MIN_SAFE_INTEGER;
    const max = typeof schema.maximum === "number" ? schema.maximum : Number.MAX_SAFE_INTEGER;
    if (typeof value !== "number" || !Number.isSafeInteger(value))
      problems.push({ path, message: `${title} must be a whole number.` });
    else if (value < min || value > max)
      problems.push({ path, message: `${title} must be from ${min} to ${max}${unit}.` });
  }
}
function checkTransport(values) {
  const problems = [];
  if (values !== undefined)
    check(TRANSPORT_SCHEMA, values, [], problems);
  return problems;
}
function merged(defaults, own) {
  if (!isRecord2(defaults))
    return own === undefined ? defaults : own;
  const out = {};
  for (const [key, value] of Object.entries(defaults))
    out[key] = merged(value, isRecord2(own) && hasOwn2(own, key) ? own[key] : undefined);
  return out;
}
function transportDefaults() {
  return JSON.parse(JSON.stringify(TRANSPORT_DEFAULTS));
}
function transportOf(values) {
  const SEP = "\x00";
  const refused = checkTransport(values).map((p) => p.path.join(SEP));
  const strip = (value, path) => {
    const at = path.join(SEP);
    if (refused.includes(at))
      return;
    if (Array.isArray(value))
      return refused.some((r) => r.startsWith(`${at}${SEP}`)) ? undefined : value;
    if (!isRecord2(value))
      return value;
    const out = {};
    for (const [key, child] of Object.entries(value)) {
      const kept = strip(child, [...path, key]);
      if (kept !== undefined)
        out[key] = kept;
    }
    return out;
  };
  return merged(transportDefaults(), strip(values, []));
}
function runtimeTuningOf(values) {
  return transportOf(isRecord2(values) ? values[TRANSPORT_KEY] : undefined).runtime;
}

// src/runtime/config.ts
var FORMAT = 1;
function configDir(env, home) {
  const xdg = env.XDG_CONFIG_HOME;
  return `${xdg !== undefined && xdg.startsWith("/") ? xdg : `${home}/.config`}/lumiah`;
}
function configPathOf(dir, name) {
  return `${dir}/${name}.json`;
}
function configText(config) {
  return `${JSON.stringify({ lumiah: FORMAT, runtime: config }, null, 2)}
`;
}
function configOf(text, path) {
  if (text === null)
    throw new Error(`There is no runtime config at ${path}. Set the runtime up with: lumiah up --url <the address you open Lumiverse at>`);
  let raw;
  try {
    raw = JSON.parse(text);
  } catch {
    throw new Error(`${path} isn't readable JSON. Set the runtime up again with: lumiah up`);
  }
  const c = isRecord2(raw) && raw.lumiah === FORMAT && isRecord2(raw.runtime) ? raw.runtime : null;
  const s = c !== null && isRecord2(c.session) ? c.session : null;
  if (c === null || s === null || typeof c.name !== "string" || typeof c.base !== "string" || typeof c.listen !== "string" || typeof c.port !== "number" || typeof c.relay !== "string" || typeof c.secret !== "string" || typeof s.username !== "string" || typeof s.token !== "string") {
    throw new Error(`${path} isn't a runtime config this lumiah reads. Set the runtime up again with: lumiah up`);
  }
  const tuning = isRecord2(c.tuning) ? runtimeTuningOf({ [TRANSPORT_KEY]: { runtime: c.tuning } }) : { ...RUNTIME_DEFAULTS };
  return { name: c.name, base: c.base, listen: c.listen, port: c.port, relay: c.relay, secret: c.secret, session: { username: s.username, token: s.token, savedAt: typeof s.savedAt === "number" ? s.savedAt : 0, ...s.allowHttp === true ? { allowHttp: true } : {} }, tuning };
}

// src/link/frames.ts
var text = (v2) => typeof v2 === "string";
var count2 = (v2) => typeof v2 === "number" && Number.isSafeInteger(v2) && v2 >= 0;
function isLinkFrame(raw) {
  return isRecord2(raw) && raw.link === LINK;
}
function toolCallOf(raw) {
  if (!isRecord2(raw) || !text(raw.callId) || !text(raw.name) || !isRecord2(raw.args) || raw.thoughtSignature !== undefined && !text(raw.thoughtSignature))
    return null;
  return { callId: raw.callId, name: raw.name, args: raw.args, ...raw.thoughtSignature !== undefined ? { thoughtSignature: raw.thoughtSignature } : {} };
}
function thinkingBlockOf(raw) {
  if (!isRecord2(raw) || raw.type !== "thinking" && raw.type !== "redacted_thinking")
    return null;
  const block = { type: raw.type };
  if (text(raw.thinking))
    block.thinking = raw.thinking;
  if (text(raw.signature))
    block.signature = raw.signature;
  if (text(raw.data))
    block.data = raw.data;
  return block;
}
function modelResultOf(raw) {
  if (!isRecord2(raw) || !text(raw.content) || !text(raw.finishReason))
    return null;
  const result = { content: raw.content, finishReason: raw.finishReason };
  if (raw.model !== undefined) {
    if (!text(raw.model))
      return null;
    result.model = raw.model;
  }
  if (raw.reasoning !== undefined) {
    if (!text(raw.reasoning))
      return null;
    result.reasoning = raw.reasoning;
  }
  if (raw.toolCalls !== undefined) {
    if (!Array.isArray(raw.toolCalls))
      return null;
    const calls = raw.toolCalls.map(toolCallOf);
    if (calls.some((c) => c === null))
      return null;
    result.toolCalls = calls;
  }
  if (raw.thinkingBlocks !== undefined) {
    if (!Array.isArray(raw.thinkingBlocks))
      return null;
    const blocks = raw.thinkingBlocks.map(thinkingBlockOf);
    if (blocks.some((b) => b === null))
      return null;
    result.thinkingBlocks = blocks;
  }
  if (raw.reasoningDetails !== undefined) {
    if (!Array.isArray(raw.reasoningDetails) || !raw.reasoningDetails.every(isRecord2))
      return null;
    result.reasoningDetails = raw.reasoningDetails;
  }
  if (raw.usage !== undefined) {
    if (!isRecord2(raw.usage))
      return null;
    result.usage = raw.usage;
  }
  return result;
}
function chunkOf(raw) {
  if (!isRecord2(raw))
    return null;
  switch (raw.kind) {
    case "content":
    case "reasoning":
      return text(raw.text) ? { kind: raw.kind, text: raw.text } : null;
    case "done": {
      const result = modelResultOf(raw.result);
      return result === null ? null : { kind: "done", result };
    }
    case "error":
      return text(raw.message) && text(raw.code) ? { kind: "error", message: raw.message, code: raw.code } : null;
    default:
      return null;
  }
}
function pushOf(raw) {
  if (!isLinkFrame(raw))
    return null;
  switch (raw.type) {
    case "chunk": {
      const chunk = chunkOf(raw.chunk);
      if (chunk === null || !text(raw.stream) || !count2(raw.seq) || raw.seq < 1)
        return null;
      return { link: LINK, type: "chunk", stream: raw.stream, seq: raw.seq, chunk };
    }
    case "stop":
      return text(raw.turn) && text(raw.why) ? { link: LINK, type: "stop", turn: raw.turn, why: raw.why } : null;
    case "settings":
      return count2(raw.revision) ? { link: LINK, type: "settings", revision: raw.revision } : null;
    case "secret":
      return text(raw.relay) && text(raw.secret) && raw.secret !== "" ? { link: LINK, type: "secret", relay: raw.relay, secret: raw.secret } : null;
    case "connection":
      return text(raw.ref) && raw.ref !== "" && text(raw.key) && raw.key !== "" ? { link: LINK, type: "connection", ref: raw.ref, key: raw.key } : null;
    default:
      return null;
  }
}
var ERROR_CODES = { bad_request: true, forbidden: true, not_found: true, conflict: true, unavailable: true, version: true, too_large: true, internal: true };
function answerOf(raw) {
  if (!isLinkFrame(raw) || !text(raw.id))
    return null;
  if (raw.type === "result")
    return { link: LINK, type: "result", id: raw.id, body: raw.body };
  if (raw.type === "error") {
    const code = text(raw.code) && hasOwn2(ERROR_CODES, raw.code) ? raw.code : "internal";
    return { link: LINK, type: "error", id: raw.id, code, message: text(raw.message) ? raw.message : "LumiAH refused the request." };
  }
  return null;
}

// src/link/parts.ts
var PART_UNITS = 512 * 1024;
var ENVELOPE_BYTES = 1024;
var encoder = new TextEncoder;
function needsParts(text2) {
  if (text2.length * 3 + ENVELOPE_BYTES <= FRAME_LIMIT)
    return false;
  return encoder.encode(text2).length + ENVELOPE_BYTES > FRAME_LIMIT;
}
function splitFrame(text2, id) {
  const count3 = Math.max(1, Math.ceil(text2.length / PART_UNITS));
  const parts = [];
  for (let index = 0;index < count3; index++)
    parts.push({ link: LINK, type: "part", id, index, count: count3, data: text2.slice(index * PART_UNITS, (index + 1) * PART_UNITS) });
  return parts;
}
function partOf(raw) {
  if (!isRecord2(raw) || raw.link !== LINK || raw.type !== "part")
    return null;
  const { id, index, count: count3, data } = raw;
  if (typeof id !== "string" || id === "" || typeof data !== "string")
    return null;
  if (typeof index !== "number" || typeof count3 !== "number" || !Number.isSafeInteger(index) || !Number.isSafeInteger(count3) || count3 < 1 || index < 0 || index >= count3)
    return null;
  return { link: LINK, type: "part", id, index, count: count3, data };
}

class PartJoiner {
  limits;
  groups = new Map;
  constructor(limits) {
    this.limits = limits;
  }
  get waiting() {
    return this.groups.size;
  }
  take(part, now) {
    const { maxUnits, staleMs } = this.limits();
    for (const [id, g] of this.groups)
      if (now - g.at > staleMs)
        this.groups.delete(id);
    if (part.count * PART_UNITS - PART_UNITS >= maxUnits) {
      this.groups.delete(part.id);
      return { refused: `That frame is over ${(maxUnits / 1048576).toFixed(0)} million characters, the most LumiAH's link puts together.`, id: part.id };
    }
    let group = this.groups.get(part.id);
    if (group === undefined || group.count !== part.count) {
      group = { count: part.count, pieces: new Array(part.count), got: 0, units: 0, at: now };
      this.groups.set(part.id, group);
    }
    if (group.pieces[part.index] === undefined) {
      group.pieces[part.index] = part.data;
      group.got++;
      group.units += part.data.length;
    }
    if (group.units > maxUnits) {
      this.groups.delete(part.id);
      return { refused: `That frame is over ${(maxUnits / 1048576).toFixed(0)} million characters, the most LumiAH's link puts together.`, id: part.id };
    }
    if (group.got < group.count)
      return { waiting: true };
    this.groups.delete(part.id);
    return { text: group.pieces.join("") };
  }
  clear() {
    this.groups.clear();
  }
}

// src/runtime/lumiverse.ts
class LiveError extends Error {
  problem;
  constructor(problem, message) {
    super(message);
    this.problem = problem;
    this.name = "LiveError";
  }
}
function normalizeBase(input) {
  let url;
  try {
    url = new URL(input.trim());
  } catch {
    throw new Error(`"${input}" isn't a URL: give Lumiverse's address as you open it in a browser, such as http://localhost:7860`);
  }
  if (url.protocol !== "http:" && url.protocol !== "https:")
    throw new Error(`"${input}" isn't an http or https URL: give Lumiverse's address as you open it in a browser, such as http://localhost:7860`);
  return `${url.origin}${url.pathname.replace(/\/+$/, "")}`;
}
function inClear(base) {
  const url = new URL(base);
  if (url.protocol !== "http:")
    return false;
  const host = url.hostname;
  return !(host === "localhost" || host.endsWith(".localhost") || /^127(\.\d{1,3}){3}$/.test(host) || host === "[::1]");
}
function parse(text2) {
  try {
    return JSON.parse(text2);
  } catch {
    return null;
  }
}
function said(text2) {
  const body = parse(text2);
  const words = isRecord2(body) ? body.message ?? body.error : null;
  return typeof words === "string" && words !== "" ? `: ${words}` : "";
}
var loginAgain = (base) => `The runtime's Lumiverse session for ${base} is no longer valid (it expired, or was signed out). Sign it in again: lumiah login`;
var forbidden = (base) => `Lumiverse at ${base} refused this client (403 Forbidden): the address isn't one of its trusted hosts. Use the URL you open Lumiverse at in your browser, or add the host to Lumiverse's trusted hosts (Operator panel) or TRUSTED_ORIGINS.`;
function waitOf(reply) {
  const minutes = Math.ceil(Number(reply.header("retry-after")) / 60);
  return Number.isFinite(minutes) && minutes > 0 ? `for about ${minutes} minute${minutes === 1 ? "" : "s"}` : "for a while";
}
function refused(base, reply, asked) {
  if (reply.status === 401)
    return new LiveError("login", loginAgain(base));
  if (reply.status === 403)
    return new LiveError("forbidden", forbidden(base));
  if (reply.status === 429)
    return new LiveError("locked", `Lumiverse is refusing every request from this address ${waitOf(reply)}${said(reply.text)}: it locks an address out after repeated failed sign-ins. Wait it out; signing in again before then only makes the next lockout longer.`);
  if (reply.status === 404)
    return new LiveError("unreachable", `There is no Lumiverse at ${base} (404 when it ${asked}). Check the URL: it's the address you open Lumiverse at.`);
  return new LiveError("unreachable", `Lumiverse at ${base} answered ${reply.status} when it ${asked}${said(reply.text)}. Behind a proxy, that can mean Lumiverse itself is down.`);
}
async function exchange(http, base, method, path, token, body) {
  const headers = { Accept: "application/json" };
  if (body !== undefined)
    headers["Content-Type"] = "application/json";
  if (token !== null)
    headers.Authorization = `Bearer ${token}`;
  let reply;
  try {
    reply = await http({ method, url: `${base}${path}`, headers, ...body !== undefined ? { body } : {} });
  } catch (error) {
    throw new LiveError("unreachable", `Can't reach Lumiverse at ${base}: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (reply.status >= 300 && reply.status < 400) {
    let target = null;
    try {
      target = new URL(reply.header("location") ?? "", `${base}${path}`);
    } catch {}
    const instead = target === null ? "<that address>" : target.pathname.endsWith(path) ? `${target.origin}${target.pathname.slice(0, -path.length)}` : target.href;
    if (target !== null && target.protocol === "https:" && base.startsWith("http:"))
      throw new LiveError("insecure", `Lumiverse at ${base} answers on https: use --url ${instead}, so the password and the session token never cross the network in clear.`);
    throw new LiveError("unreachable", `Lumiverse at ${base} answered with a redirect to ${target?.href ?? "another address"}. Use the address it redirects to (--url ${instead}).`);
  }
  return reply;
}
async function signIn(http, base, username, password) {
  const reply = await exchange(http, base, "POST", "/api/auth/sign-in/username", null, JSON.stringify({ username, password }));
  if (reply.status >= 200 && reply.status < 300) {
    const body = parse(reply.text);
    const token = isRecord2(body) && typeof body.token === "string" && body.token !== "" ? body.token : reply.header("set-auth-token");
    if (token === null || token === "")
      throw new LiveError("protocol", `Lumiverse at ${base} signed you in but sent back no session token, so the runtime can't use the session. Is it Lumiverse's staging branch?`);
    return token;
  }
  if (reply.status === 401)
    throw new LiveError("login", `Lumiverse refused that username or password${said(reply.text)}. Careful: after 5 failed sign-ins Lumiverse locks your address out, your browser on this machine included, and each lockout lasts longer than the last.`);
  if (reply.status === 429)
    throw new LiveError("locked", `Lumiverse is refusing sign-ins from this address ${waitOf(reply)}${said(reply.text)}. It allows few sign-ins in a short time, and after 5 failed ones it locks the whole address out (your browser on this machine included) for longer each time. Wait, then sign in once.`);
  if (reply.status === 403)
    throw new LiveError("forbidden", forbidden(base));
  if (reply.status === 404)
    throw new LiveError("unreachable", `There is no Lumiverse sign-in at ${base} (404). Check the URL: it's the address you open Lumiverse at.`);
  throw new LiveError("protocol", `Lumiverse answered the sign-in with ${reply.status}${said(reply.text)}.`);
}
async function sessionOf(http, base, token) {
  const reply = await exchange(http, base, "GET", "/api/auth/get-session", token);
  if (reply.status === 401)
    return { valid: false, expiresAt: null };
  if (reply.status < 200 || reply.status >= 300)
    throw refused(base, reply, "was asked about the session");
  const body = parse(reply.text);
  const session = isRecord2(body) && isRecord2(body.session) ? body.session : null;
  if (session === null)
    return { valid: false, expiresAt: null };
  return { valid: true, expiresAt: typeof session.expiresAt === "string" ? session.expiresAt : null };
}
function profileOf(raw) {
  if (!isRecord2(raw) || typeof raw.id !== "string" || typeof raw.provider !== "string")
    return null;
  return { id: raw.id, name: typeof raw.name === "string" ? raw.name : "", provider: raw.provider, apiUrl: typeof raw.api_url === "string" ? raw.api_url : "", model: typeof raw.model === "string" ? raw.model : "" };
}
async function connectionProfiles(http, base, token, limit2) {
  const reply = await exchange(http, base, "GET", `/api/v1/connections?limit=${limit2}`, token);
  if (reply.status !== 200)
    throw refused(base, reply, "was asked for your connections");
  const body = parse(reply.text);
  const rows = isRecord2(body) && Array.isArray(body.data) ? body.data : Array.isArray(body) ? body : [];
  return rows.map(profileOf).filter((p) => p !== null);
}
async function addConnectionProfile(http, base, token, profile) {
  const reply = await exchange(http, base, "POST", "/api/v1/connections", token, JSON.stringify({ name: profile.name, provider: profile.provider, api_url: profile.apiUrl, model: profile.model, ...profile.apiKey !== undefined ? { api_key: profile.apiKey } : {} }));
  if (reply.status !== 200 && reply.status !== 201)
    throw refused(base, reply, "was asked to add the connection");
  const made = profileOf(parse(reply.text));
  if (made === null)
    throw new LiveError("protocol", `Lumiverse at ${base} added the connection but didn't say what it made.`);
  return made;
}
async function setConnectionKey(http, base, token, connectionId, apiKey) {
  const reply = await exchange(http, base, "PUT", `/api/v1/connections/${encodeURIComponent(connectionId)}/api-key`, token, JSON.stringify({ api_key: apiKey }));
  if (reply.status !== 200)
    throw refused(base, reply, "was asked to set the connection's key");
}
function loopbackProfile(profiles, url, model) {
  const want = url.replace(/\/+$/, "").toLowerCase();
  return profiles.find((p) => p.provider === "custom" && (p.model === model || p.apiUrl.trim().replace(/\/+$/, "").toLowerCase() === want)) ?? null;
}
async function editAndSendPrefersActive(http, base, token) {
  const reply = await exchange(http, base, "GET", "/api/v1/settings/quickToolbarSettings", token).catch(() => null);
  if (reply === null)
    return null;
  if (reply.status === 404)
    return false;
  if (reply.status !== 200)
    return null;
  const body = parse(reply.text);
  const value = isRecord2(body) && isRecord2(body.value) ? body.value : null;
  return value !== null && value.editAndSendAlwaysUseActiveConnection === true;
}
function runtimeOrigins(listen, port) {
  const host = listen.includes(":") && !listen.startsWith("[") ? `[${listen}]` : listen.toLowerCase();
  if (host === "127.0.0.1" || host === "localhost")
    return [`http://127.0.0.1:${port}`, `http://localhost:${port}`];
  return [`http://${host}:${port}`];
}
async function excludeOrigins(http, base, token, origins) {
  const url = `${base}/api/v1/inference-scheduler/config`;
  const headers = { Accept: "application/json", Authorization: `Bearer ${token}` };
  const listed = (text2) => {
    const body = parse(text2);
    const config = isRecord2(body) && isRecord2(body.config) ? body.config : body;
    return isRecord2(config) && Array.isArray(config.excludedOrigins) ? config.excludedOrigins.filter((o) => typeof o === "string") : [];
  };
  try {
    const got = await http({ method: "GET", url, headers });
    if (got.status === 404)
      return "unavailable";
    if (got.status !== 200)
      return "missing";
    const current = listed(got.text);
    if (origins.every((o) => current.includes(o)))
      return "excluded";
    const put = await http({ method: "PUT", url, headers: { ...headers, "Content-Type": "application/json" }, body: JSON.stringify({ excludedOrigins: [...current, ...origins.filter((o) => !current.includes(o))] }) });
    return put.status === 200 && origins.every((o) => listed(put.text).includes(o)) ? "excluded" : "missing";
  } catch {
    return "unknown";
  }
}

// src/runtime/connection.ts
class LinkError extends Error {
  code;
  constructor(code, message) {
    super(message);
    this.code = code;
    this.name = "LinkError";
  }
}
function frontendSession() {
  return [...crypto.getRandomValues(new Uint8Array(16))].map((b) => b.toString(16).padStart(2, "0")).join("");
}
var formatMs = (ms2) => ms2 % 1000 === 0 ? `${ms2 / 1000} s` : `${ms2} ms`;
function quiet(timer) {
  const t = timer;
  t.unref?.();
  return timer;
}

class HostConnection {
  options;
  socket = null;
  extension = null;
  ready = false;
  opening = null;
  lastExtension = null;
  pending = new Map;
  seq = 0;
  prefix = "";
  ping = null;
  openedToken = null;
  greeting = null;
  joiner;
  constructor(options) {
    this.options = options;
    this.joiner = new PartJoiner(() => {
      const { joinMaxUnits, partStaleMs } = options.limits();
      return { maxUnits: joinMaxUnits, staleMs: partStaleMs };
    });
  }
  get base() {
    return this.options.base;
  }
  isOpen() {
    return this.ready && this.socket !== null;
  }
  async ensureOpen() {
    const saved = this.options.credentials();
    if (this.isOpen()) {
      if (saved !== null && saved.token === this.openedToken)
        return;
      this.close();
    }
    this.opening ??= this.open().finally(() => {
      this.opening = null;
    });
    return this.opening;
  }
  request(type, fields) {
    const socket = this.socket;
    const extension = this.extension;
    if (socket === null || extension === null || !this.ready)
      return Promise.reject(new LiveError("closed", "The connection to Lumiverse closed. Try again."));
    const id = `${this.prefix}${++this.seq}`;
    const wrap = (payload2) => JSON.stringify({ type: "SPINDLE_BACKEND_MSG", extensionId: extension.id, payload: payload2 });
    const payload = { ...fields, link: LINK, type, id };
    const whole3 = wrap(payload);
    const frames = needsParts(whole3) ? splitFrame(JSON.stringify(payload), id).map(wrap) : [whole3];
    const { promise, resolve, reject } = Promise.withResolvers();
    const limit2 = this.options.limits().requestMs;
    const timer = limit2 === null ? undefined : setTimeout(() => {
      this.pending.delete(id);
      reject(new LiveError("timeout", `LumiAH didn't answer ${type} within ${formatMs(limit2)}.`));
    }, limit2);
    this.pending.set(id, { type, resolve, reject, timer });
    for (const frame of frames)
      socket.send(frame);
    return promise;
  }
  notify(notice) {
    const socket = this.socket;
    const extension = this.extension;
    if (socket === null || extension === null || !this.ready)
      return;
    const whole3 = JSON.stringify({ type: "SPINDLE_BACKEND_MSG", extensionId: extension.id, payload: notice });
    if (!needsParts(whole3))
      socket.send(whole3);
  }
  close() {
    const socket = this.socket;
    this.socket = null;
    socket?.close();
    this.closed(1000, "closed by the runtime");
  }
  signedIn() {
    const { base } = this.options;
    const saved = this.options.credentials();
    if (saved === null)
      throw new LiveError("login", `The runtime isn't signed in to ${base}. Run: lumiah login`);
    if (inClear(base) && saved.allowHttp !== true)
      throw new LiveError("insecure", `${base} is plain http to another machine, and this sign-in wasn't made with --allow-http, so its session token won't be sent there in clear. Use https, or set the runtime up again with --allow-http.`);
    return saved;
  }
  async findExtension(token) {
    const { base, http } = this.options;
    this.lastExtension = null;
    const reply = await exchange(http, base, "GET", "/api/v1/spindle", token);
    if (reply.status === 401)
      throw new LiveError("login", loginAgain(base));
    if (reply.status !== 200)
      throw refused(base, reply, "was asked for its extensions");
    let body = null;
    try {
      body = JSON.parse(reply.text);
    } catch {}
    const found = isRecord2(body) && Array.isArray(body.extensions) ? body.extensions.find((e) => isRecord2(e) && e.identifier === EXTENSION_IDENTIFIER) : undefined;
    if (!found || typeof found.id !== "string")
      throw new LiveError("not_installed", `LumiAH isn't installed on ${base}, or your account can't use it. Install it in Lumiverse's Extensions tab.`);
    const extension = { id: found.id, version: typeof found.version === "string" ? found.version : null, enabled: found.enabled === true, status: typeof found.status === "string" ? found.status : "unknown" };
    this.lastExtension = extension;
    if (extension.status !== "running")
      throw new LiveError("not_running", `LumiAH is installed on ${base} but not running (${extension.enabled ? extension.status : "disabled"}). Enable it in Lumiverse's Extensions tab.`);
    return extension;
  }
  async ticket(token) {
    const { base, http } = this.options;
    const reply = await exchange(http, base, "POST", "/api/v1/ws-ticket", token, "{}");
    if (reply.status !== 200)
      throw refused(base, reply, "was asked for a socket ticket");
    let body = null;
    try {
      body = JSON.parse(reply.text);
    } catch {}
    if (!isRecord2(body) || typeof body.ticket !== "string")
      throw new LiveError("protocol", `Lumiverse at ${base} gave no socket ticket.`);
    return body.ticket;
  }
  async open() {
    const { token } = this.signedIn();
    this.openedToken = token;
    this.extension = await this.findExtension(token);
    for (let attempt = 1;; attempt++) {
      try {
        await this.connect(await this.ticket(token));
        break;
      } catch (error) {
        if (!(error instanceof LiveError && error.problem === "protocol" && attempt === 1))
          throw error;
      }
    }
    this.ready = true;
    this.options.onOpen?.();
  }
  connect(ticket) {
    const session = frontendSession();
    this.prefix = `${session.slice(0, 8)}-`;
    const url = new URL(this.options.base);
    url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
    url.pathname = `${url.pathname.replace(/\/+$/, "")}/api/ws`;
    url.search = new URLSearchParams({ ticket, frontend_session: session, frontend_runtime: "widget" }).toString();
    const { promise, resolve, reject } = Promise.withResolvers();
    const settle = (error) => {
      clearTimeout(timer);
      this.greeting = null;
      if (error === null)
        return resolve();
      if (this.socket === socket)
        this.socket = null;
      socket.close();
      reject(error);
    };
    const limit2 = this.options.limits().requestMs;
    const timer = limit2 === null ? undefined : setTimeout(() => settle(new LiveError("timeout", `Lumiverse at ${this.options.base} opened no event socket within ${formatMs(limit2)}. Behind a proxy, the proxy must pass WebSocket upgrades on /api/ws.`)), limit2);
    this.greeting = { resolve: () => settle(null), reject: settle };
    const socket = this.options.openSocket(url.toString(), {
      message: (text2) => this.received(socket, text2),
      close: (code, reason) => {
        if (this.socket !== socket)
          return;
        this.socket = null;
        const why = code === 1006 ? "it never opened (1006): behind a proxy, the proxy must pass WebSocket upgrades on /api/ws" : `Lumiverse closed it (${code}${reason ? ` ${reason}` : ""})`;
        this.greeting?.reject(new LiveError(code === 1008 ? "protocol" : "closed", `The event socket at ${this.options.base}/api/ws failed: ${why}.`));
        this.closed(code, reason);
      }
    });
    this.socket = socket;
    return promise;
  }
  received(socket, text2) {
    if (socket !== this.socket)
      return;
    let msg;
    try {
      msg = JSON.parse(text2);
    } catch {
      return;
    }
    if (!isRecord2(msg))
      return;
    if (msg.event === "CONNECTED") {
      this.ping ??= quiet(setInterval(() => this.socket?.send(JSON.stringify({ type: "ping" })), this.options.limits().socketPingMs));
      this.greeting?.resolve();
      return;
    }
    if (msg.event === "AUTH_ERROR") {
      this.greeting?.reject(new LiveError("protocol", "Lumiverse refused the event socket's ticket."));
      return;
    }
    const lifecycle = msg.event === "SPINDLE_EXTENSION_LOADED" ? "loaded" : msg.event === "SPINDLE_EXTENSION_UNLOADED" ? "unloaded" : msg.event === "SPINDLE_EXTENSION_ERROR" ? "error" : null;
    if (lifecycle !== null) {
      const id = this.extension?.id ?? this.lastExtension?.id;
      if (isRecord2(msg.payload) && id !== undefined && msg.payload.extensionId === id)
        this.options.onExtension?.(lifecycle, typeof msg.payload.error === "string" ? msg.payload.error : null);
      return;
    }
    if (msg.event !== "SPINDLE_FRONTEND_MSG" || !isRecord2(msg.payload) || msg.payload.extensionId !== this.extension?.id)
      return;
    this.frame(msg.payload.data);
  }
  frame(data) {
    if (!isLinkFrame(data))
      return;
    const part = partOf(data);
    if (part !== null) {
      const joined = this.joiner.take(part, this.options.now());
      if ("text" in joined) {
        let whole3 = null;
        try {
          whole3 = JSON.parse(joined.text);
        } catch {}
        if (partOf(whole3) === null)
          this.frame(whole3);
      } else if ("refused" in joined) {
        const waiting2 = this.pending.get(joined.id);
        if (waiting2 !== undefined) {
          this.pending.delete(joined.id);
          clearTimeout(waiting2.timer);
          waiting2.reject(new LiveError("too_large", `LumiAH's answer to ${waiting2.type} was too large for the runtime: ${joined.refused} Raise the runtime's "Largest frame joined" in LumiAH's settings.`));
        }
      }
      return;
    }
    const answer = answerOf(data);
    const waiting = answer !== null ? this.pending.get(answer.id) : undefined;
    if (answer === null || waiting === undefined) {
      this.options.onPush?.(data);
      return;
    }
    this.pending.delete(answer.id);
    clearTimeout(waiting.timer);
    if (answer.type === "result")
      waiting.resolve(answer.body);
    else
      waiting.reject(new LinkError(answer.code, answer.message));
  }
  closed(code, reason) {
    clearInterval(this.ping ?? undefined);
    this.ping = null;
    this.ready = false;
    this.joiner.clear();
    const waiting = [...this.pending.values()];
    this.pending.clear();
    for (const w of waiting) {
      clearTimeout(w.timer);
      w.reject(new LiveError("closed", `The connection to Lumiverse closed (${code}${reason ? ` ${reason}` : ""}) before LumiAH answered ${w.type}.`));
    }
  }
}

// src/link/stream.ts
class StreamReceiver {
  next = 1;
  ahead = new Map;
  sinceAck = 0;
  finished = false;
  get seq() {
    return this.next - 1;
  }
  get ended() {
    return this.finished;
  }
  get missing() {
    return this.ahead.size > 0 ? this.next : null;
  }
  take(seq, chunk, ackEvery) {
    const out = { deliver: [], missing: null, ack: null };
    if (this.finished || seq < this.next || this.ahead.has(seq)) {
      out.missing = this.missing;
      return out;
    }
    this.ahead.set(seq, chunk);
    for (let held = this.ahead.get(this.next);held !== undefined; held = this.ahead.get(this.next)) {
      this.ahead.delete(this.next);
      this.next++;
      out.deliver.push(held);
      if (terminal(held)) {
        this.finished = true;
        this.ahead.clear();
        out.ack = this.next - 1;
        return out;
      }
      if (++this.sinceAck >= ackEvery) {
        this.sinceAck = 0;
        out.ack = this.next - 1;
      }
    }
    out.missing = this.missing;
    return out;
  }
}

// src/runtime/link.ts
var LASTING2 = { login: true, locked: true, forbidden: true, insecure: true, not_installed: true, too_old: true };
function stoppedWords(why, detail) {
  if (why === "stopped")
    return "LumiAH was stopped on Lumiverse (restarted, updated or turned off), so this reply ended here. Press Retry, or swipe, once it runs again (Lumiverse's Extensions tab).";
  const said2 = detail?.replace(/\s+/g, " ").trim().slice(0, 200) ?? "";
  return `LumiAH stopped with an error${said2 !== "" ? ` (${said2})` : ""}, so this reply ended here. Lumiverse doesn't restart it by itself: restart it in Lumiverse's Extensions tab, then press Retry.`;
}

class LinkClient {
  options;
  conn;
  handlers = null;
  socketGen = 0;
  greetedGen = -1;
  connecting = null;
  failures = 0;
  retryAt = 0;
  lastProblem = "";
  pingedAt = 0;
  pinging = false;
  refusal = null;
  asked = new Map;
  askSeq = 0;
  heardAt = 0;
  timedOut = null;
  downAt = null;
  stoppedBy = null;
  suspect = null;
  hello = null;
  scheduler = "unknown";
  session = { valid: null, expiresAt: null, checkedAt: null };
  constructor(options) {
    this.options = options;
    this.conn = new HostConnection({
      base: options.base,
      credentials: options.credentials,
      http: options.http,
      openSocket: options.openSocket,
      limits: () => {
        const { requestMs, socketPingMs, joinMaxUnits, partStaleMs } = options.tuning();
        return { requestMs, socketPingMs, joinMaxUnits, partStaleMs };
      },
      now: options.now,
      onOpen: () => {
        this.socketGen++;
      },
      onPush: (data) => this.push(data),
      onExtension: (change, detail) => this.lifecycle(change, detail)
    });
  }
  attach(handlers) {
    this.handlers = handlers;
  }
  get up() {
    return this.refusal === null && this.stoppedBy === null && this.conn.isOpen() && this.greetedGen === this.socketGen;
  }
  get refused() {
    return this.refusal;
  }
  get out() {
    const now = this.options.now();
    if (this.stoppedBy !== null)
      return { since: this.stoppedBy.at, why: this.stoppedBy.why, detail: this.stoppedBy.detail };
    if (!this.up)
      return { since: this.downAt ?? now, why: "down" };
    let oldest = this.timedOut;
    for (const at of this.asked.values())
      if (oldest === null || at < oldest)
        oldest = at;
    if (oldest === null)
      return null;
    const since = Math.max(oldest, this.heardAt);
    return now - since >= this.options.tuning().silentMs ? { since, why: "silent" } : null;
  }
  lifecycle(change, detail) {
    const now = this.options.now();
    if (change === "loaded") {
      if (this.stoppedBy !== null)
        this.options.log("LumiAH is running again on Lumiverse");
      this.stoppedBy = null;
      this.suspect = null;
      this.greetedGen = -1;
      this.retryAt = 0;
      return;
    }
    if (change === "unloaded") {
      this.stop({ at: now, why: "stopped", detail: null });
      return;
    }
    this.suspect ??= { at: now, detail };
    this.pingedAt = 0;
  }
  stop(stopped) {
    this.stoppedBy = stopped;
    this.suspect = null;
    this.greetedGen = -1;
    this.options.log(stoppedWords(stopped.why, stopped.detail));
    this.handlers?.stopped(stopped.why, stopped.detail);
  }
  report() {
    const { name, build, runtime, host, listen, port } = this.options;
    return { name, build, runtime, host, listen, port, scheduler: this.scheduler, session: this.session, turns: this.handlers?.turns().length ?? 0 };
  }
  async request(type, fields, waitMs) {
    const deadline = this.options.now() + waitMs;
    const pause = async () => {
      const { promise, resolve } = Promise.withResolvers();
      setTimeout(resolve, Math.min(1000, Math.max(0, deadline - this.options.now())));
      await promise;
    };
    while (!this.up) {
      if (this.refusal !== null)
        throw new LiveError("forbidden", this.refusal);
      const stopped = this.stoppedBy;
      if (stopped !== null && this.conn.isOpen()) {
        if (stopped.why === "crashed" || this.options.now() >= deadline)
          throw new LiveError("not_running", stoppedWords(stopped.why, stopped.detail));
        await pause();
        continue;
      }
      try {
        await this.connect();
      } catch (error) {
        if (error instanceof LiveError && LASTING2[error.problem] === true || this.options.now() >= deadline)
          throw error;
        await pause();
      }
    }
    return this.ask(type, { ...fields, secret: this.options.secret() });
  }
  notify(notice) {
    if (this.up)
      this.conn.notify({ link: LINK, ...notice });
  }
  async ask(type, fields) {
    const id = ++this.askSeq;
    const at = this.options.now();
    this.asked.set(id, at);
    try {
      const answer = await this.conn.request(type, fields);
      this.heard();
      return answer;
    } catch (error) {
      if (error instanceof LinkError)
        this.heard();
      else if (error instanceof LiveError && error.problem === "timeout" && at >= this.heardAt)
        this.timedOut ??= at;
      throw error;
    } finally {
      this.asked.delete(id);
    }
  }
  heard() {
    this.heardAt = this.options.now();
    this.timedOut = null;
  }
  connect() {
    this.connecting ??= this.greet().finally(() => {
      this.connecting = null;
    });
    return this.connecting;
  }
  async greet() {
    await this.conn.ensureOpen();
    const gen = this.socketGen;
    let answer;
    try {
      answer = await this.ask("hello", { secret: this.options.secret(), version: LINK_VERSION, build: this.options.build, report: this.report(), open: this.handlers?.open() ?? [] });
    } catch (error) {
      if (error instanceof LinkError && error.code === "forbidden")
        this.refuse(`LumiAH refused this runtime (${error.message}) Register it again with its start line on LumiAH's Runtime page.`);
      else if (error instanceof LinkError && error.code === "version")
        this.refuse(error.message);
      else if (error instanceof LinkError && error.code === "bad_request")
        this.refuse(`LumiAH on ${this.options.base} doesn't know this runtime's hello (${error.message}): update LumiAH (Extensions \u2192 LumiAH \u2192 Update).`);
      else if (error instanceof LiveError && error.problem === "timeout")
        throw new LiveError("timeout", `LumiAH on ${this.options.base} didn't answer the runtime's hello. Check that it's running in Lumiverse's Extensions tab.`);
      throw error;
    }
    if (answer.version !== LINK_VERSION) {
      this.refuse(versionWords(LINK_VERSION, answer.version));
      throw new LiveError("too_old", this.refusal ?? "");
    }
    const again = this.hello !== null || this.failures > 0;
    this.hello = answer;
    this.pingedAt = this.options.now();
    if (gen === this.socketGen)
      this.greetedGen = gen;
    this.stoppedBy = null;
    this.suspect = null;
    if (Array.isArray(answer.lost) && answer.lost.length > 0)
      this.handlers?.lost(answer.lost);
    if (typeof answer.settings === "number")
      this.handlers?.settings(answer.settings);
    this.options.log(`${again ? "linked again" : "linked"} to LumiAH ${answer.build} on ${this.options.base}`);
    this.failures = 0;
    this.lastProblem = "";
  }
  refuse(why) {
    this.refusal = why;
    this.options.log(why);
    this.conn.close();
  }
  push(data) {
    this.heard();
    const push = pushOf(data);
    if (push === null)
      return;
    switch (push.type) {
      case "chunk":
        this.handlers?.chunk(push);
        return;
      case "stop":
        this.handlers?.stop(push);
        return;
      case "settings":
        this.handlers?.settings(push.revision);
        return;
      case "connection":
        this.handlers?.connection(push);
        return;
      case "secret":
        if (push.relay !== this.options.relay)
          return;
        this.options.rotated(push.secret);
        this.options.log("LumiAH rotated this runtime's secret: the new one is in its config");
        return;
    }
  }
  async fix() {
    const token = this.options.credentials()?.token;
    if (token === undefined)
      return;
    const origins = runtimeOrigins(this.options.listen, this.options.port);
    const was = this.scheduler;
    this.scheduler = await excludeOrigins(this.options.http, this.options.base, token, origins);
    if (this.scheduler !== was && (this.scheduler === "missing" || this.scheduler === "unknown"))
      this.options.log(`couldn't put ${origins.join(" and ")} in the local-inference scheduler's Excluded origins. Before turning the scheduler on, add them there (Lumiverse \u2192 Settings \u2192 Inference scheduler): a turn would otherwise wait on its own calls.`);
    this.pingedAt = 0;
  }
  async refreshSession() {
    const now = this.options.now();
    try {
      const state = await sessionOf(this.options.http, this.options.base, this.options.credentials()?.token ?? null);
      this.session = { valid: state.valid, expiresAt: state.expiresAt, checkedAt: now };
      if (state.valid === false)
        this.options.log(`the runtime's Lumiverse session for ${this.options.base} has ended: sign it in again with lumiah login`);
    } catch (error) {
      this.session = { ...this.session, valid: null, checkedAt: now };
      this.options.log(`couldn't ask ${this.options.base} about the runtime's session: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  ping(streams, turns) {
    this.pingedAt = this.options.now();
    this.pinging = true;
    this.ask("ping", { secret: this.options.secret(), report: this.report(), streams, turns }).then((answer) => {
      if (Array.isArray(answer.lost) && answer.lost.length > 0)
        this.handlers?.lost(answer.lost);
    }).catch((error) => {
      if (error instanceof LinkError && error.code === "forbidden")
        this.refuse(`LumiAH refused this runtime (${error.message}) Register it again with its start line on LumiAH's Runtime page.`);
    }).finally(() => {
      this.pinging = false;
    });
  }
  tick() {
    const now = this.options.now();
    const { crashMs, sessionCheckMs, reconnectMs, reconnectMaxMs, probeMs, heartbeatMs } = this.options.tuning();
    if (!this.up)
      this.downAt ??= now;
    else
      this.downAt = null;
    if (this.refusal !== null)
      return;
    if (this.suspect !== null) {
      if (this.heardAt >= this.suspect.at)
        this.suspect = null;
      else if (now - this.suspect.at >= crashMs)
        this.stop({ at: this.suspect.at, why: "crashed", detail: this.suspect.detail });
    }
    if (this.session.checkedAt === null || now - this.session.checkedAt >= sessionCheckMs) {
      this.session = { ...this.session, checkedAt: now };
      this.refreshSession();
    }
    if (!this.up) {
      if (this.stoppedBy !== null && this.conn.isOpen())
        return;
      if (this.connecting !== null || now < this.retryAt)
        return;
      this.connect().catch((error) => {
        const ended = error instanceof LiveError && error.problem === "login";
        if (ended)
          this.session = { ...this.session, valid: false };
        const problem = ended ? `the runtime's Lumiverse session for ${this.options.base} has ended: sign it in again with lumiah login` : error instanceof Error ? error.message : String(error);
        this.retryAt = this.options.now() + Math.min(reconnectMaxMs, reconnectMs * 2 ** Math.min(this.failures, 16));
        this.failures++;
        if (problem !== this.lastProblem)
          this.options.log(`can't reach LumiAH yet (trying again): ${problem}`);
        this.lastProblem = problem;
      });
      return;
    }
    if (this.pinging)
      return;
    const streams = (this.handlers?.open() ?? []).map((s) => s.stream);
    const turns = this.handlers?.turns() ?? [];
    if (now - this.pingedAt >= (streams.length > 0 || turns.length > 0 ? probeMs : heartbeatMs))
      this.ping(streams, turns);
  }
  close() {
    this.conn.close();
  }
}

// src/runtime/streams.ts
function problemOf(error) {
  if (error instanceof LinkError)
    return { message: error.message, code: error.code };
  if (error instanceof LiveError) {
    if (error.problem === "login")
      return { message: "The runtime's Lumiverse session has ended, so it can't reach LumiAH. Sign it in again on the machine it runs on: lumiah login (LumiAH's Runtime page shows the line).", code: "login" };
    if (error.problem === "timeout")
      return { message: "LumiAH didn't answer the runtime in time: it may be restarting or busy. Press Retry in a moment.", code: "timeout" };
    return { message: `The runtime couldn't reach LumiAH: ${error.message}`, code: error.problem === "forbidden" ? "unreachable" : error.problem };
  }
  return { message: error instanceof Error ? error.message : String(error), code: "internal" };
}

class Streams {
  link;
  env;
  streams = new Map;
  constructor(link, env) {
    this.link = link;
    this.env = env;
  }
  get count() {
    return this.streams.size;
  }
  open() {
    return [...this.streams.values()].filter((s) => s.begun).map((s) => ({ stream: s.id, seq: s.receiver.seq }));
  }
  start(id, reader, send) {
    const now = this.env.now();
    const stream = { id, reader, receiver: new StreamReceiver, started: Promise.resolve(false), begun: false, heard: now, gap: null, at: now, ended: false };
    this.streams.set(id, stream);
    const run = async () => {
      const first = this.env.now();
      for (;; ) {
        try {
          await send();
          stream.heard = this.env.now();
          stream.begun = true;
          return true;
        } catch (error) {
          if (error instanceof LiveError && error.problem === "closed" && !stream.ended && this.env.now() - first < this.env.tuning().lostMs)
            continue;
          this.end(stream, problemOf(error), false);
          return false;
        }
      }
    };
    stream.started = run();
  }
  chunk(push) {
    const stream = this.streams.get(push.stream);
    if (stream === undefined || stream.ended)
      return;
    stream.heard = this.env.now();
    const got = stream.receiver.take(push.seq, push.chunk, this.env.tuning().ackEvery);
    for (const chunk of got.deliver) {
      if (stream.receiver.ended && chunk === got.deliver.at(-1)) {
        stream.ended = true;
        this.streams.delete(stream.id);
      }
      stream.reader.chunk(chunk);
    }
    if (got.ack !== null)
      this.link.request("stream.ack", { stream: stream.id, seq: got.ack }, 0).catch(() => {
        return;
      });
    if (stream.ended)
      return;
    if (got.missing === null)
      stream.gap = null;
    else if (stream.gap === null)
      this.askAgain(stream);
  }
  lost(ids) {
    for (const id of ids) {
      const stream = this.streams.get(id);
      if (stream)
        this.end(stream, { message: "LumiAH restarted during this call, so it stopped here. Press Retry, or swipe.", code: "lost" }, false);
    }
  }
  stopped(why, detail) {
    for (const stream of [...this.streams.values()])
      this.end(stream, { message: stoppedWords(why, detail), code: "unavailable" }, false);
  }
  shutdown() {
    for (const stream of [...this.streams.values()])
      this.end(stream, { message: "The runtime is restarting. Press Retry in a moment.", code: "unavailable" }, true);
  }
  cancel(id, reason) {
    const stream = this.streams.get(id);
    if (stream === undefined || stream.ended)
      return;
    stream.ended = true;
    this.streams.delete(id);
    this.tell(stream, reason);
  }
  tick() {
    const now = this.env.now();
    const tuning = this.env.tuning();
    const up = this.link.up;
    const out = this.link.out;
    const refused2 = this.link.refused;
    for (const stream of [...this.streams.values()]) {
      if (stream.ended)
        continue;
      if (refused2 !== null) {
        this.end(stream, { message: `The runtime can't reach LumiAH: ${refused2}`, code: "revoked" }, false);
        continue;
      }
      if (out !== null && now - Math.max(out.since, stream.at) >= tuning.lostMs) {
        const seconds = Math.round((now - Math.max(out.since, stream.at)) / 1000);
        const problem = out.why === "silent" ? { message: `LumiAH stopped answering the runtime during this call (nothing for ${seconds} s): it may have restarted or hung. Press Retry, or swipe.`, code: "stalled" } : out.why === "down" ? { message: `The runtime lost its connection to Lumiverse for ${seconds} s during this call. Press Retry once it is back (lumiah status says how it is).`, code: "lost" } : { message: stoppedWords(out.why, out.detail), code: "unavailable" };
        this.end(stream, problem, out.why === "silent" || out.why === "down");
        continue;
      }
      if (up && stream.gap !== null && now - stream.gap.asked >= tuning.resendMs) {
        if (stream.gap.tries >= tuning.resendTries) {
          this.end(stream, { message: `Part of this answer never reached the runtime (chunk ${stream.receiver.seq + 1} is missing). Press Retry.`, code: "lost" }, true);
          continue;
        }
        this.askAgain(stream);
      }
      if (out === null && now - stream.heard >= tuning.stallMs)
        this.end(stream, { message: `LumiAH sent nothing for this call in ${Math.round(tuning.stallMs / 60000)} minutes, so the runtime gave it up. Press Retry.`, code: "stalled" }, true);
    }
  }
  askAgain(stream) {
    stream.gap = { asked: this.env.now(), tries: (stream.gap?.tries ?? 0) + 1 };
    this.link.request("stream.resend", { stream: stream.id, from: stream.receiver.seq + 1 }, 0).catch(() => {
      return;
    });
  }
  end(stream, problem, cancel) {
    if (stream.ended)
      return;
    stream.ended = true;
    this.streams.delete(stream.id);
    stream.reader.chunk({ kind: "error", message: problem.message, code: problem.code });
    if (cancel)
      this.tell(stream, problem.code);
  }
  tell(stream, reason) {
    stream.started.then((started) => {
      if (started)
        return this.link.request("stream.cancel", { stream: stream.id, reason }, this.env.tuning().lostMs);
    }).catch((error) => this.env.log(`the cancel of stream ${stream.id.slice(0, 8)} wasn't delivered: ${error instanceof Error ? error.message : String(error)}`));
  }
}

// src/runtime/host.ts
class ModelCallError extends Error {
  code;
  constructor(message, code) {
    super(message);
    this.code = code;
    this.name = "ModelCallError";
  }
}
function reasonOf(signal) {
  const reason = signal.reason;
  return reason instanceof Error ? reason : new Error(typeof reason === "string" ? reason : "The call was cancelled.");
}
function linkHost(deps) {
  const { link, streams } = deps;
  async function ask(type, fields) {
    const first = deps.now();
    for (;; ) {
      const wait = deps.tuning().lostMs;
      try {
        return await link.request(type, fields, wait);
      } catch (error) {
        if (error instanceof LiveError && error.problem === "closed" && deps.now() - first < wait)
          continue;
        throw new Error(problemOf(error).message, { cause: error });
      }
    }
  }
  function call(request, signal, onDelta) {
    if (signal.aborted)
      return Promise.reject(reasonOf(signal));
    const stream = deps.id();
    const turn = deps.turn();
    const { promise, resolve, reject } = Promise.withResolvers();
    const cancel = () => {
      streams.cancel(stream, "cancelled");
      reject(reasonOf(signal));
    };
    signal.addEventListener("abort", cancel, { once: true });
    streams.start(stream, {
      chunk: (chunk) => {
        switch (chunk.kind) {
          case "content":
            onDelta?.({ content: chunk.text });
            return;
          case "reasoning":
            onDelta?.({ reasoning: chunk.text });
            return;
          case "done":
            signal.removeEventListener("abort", cancel);
            resolve(chunk.result);
            return;
          case "error":
            signal.removeEventListener("abort", cancel);
            reject(new ModelCallError(chunk.message, chunk.code));
            return;
        }
      }
    }, () => link.request("model.call", { stream, turn, request }, deps.tuning().lostMs));
    return promise;
  }
  return {
    models: { call },
    connections: {
      list: async () => (await ask("connections.list", {})).connections,
      get: async (connectionId) => (await ask("connections.get", { connection: connectionId })).profile
    },
    blobs: {
      put: async (hash, text2) => {
        await ask("blob.put", { hash, text: text2 });
      },
      get: async (hash) => (await ask("blob.get", { hash })).text
    },
    store: {
      read: async (path) => (await ask("doc.get", { path })).doc,
      write: async (path, value) => {
        await ask("doc.put", { path, doc: value });
      },
      remove: async (path) => {
        await ask("doc.remove", { path });
      }
    },
    chat: {
      path: async (chatId) => (await ask("chat.path", { chat: chatId })).messages,
      messages: async (chatId, from, to) => (await ask("chat.messages", { chat: chatId, from, to })).messages,
      anchor: async (chatId, messageId, swipeId, record) => (await ask("chat.anchor", { chat: chatId, message: messageId, swipe: swipeId, record })).written
    },
    lore: {
      books: async (chatId) => (await ask("lore.books", { chat: chatId })).books,
      entries: async (bookId) => (await ask("lore.entries", { book: bookId })).entries,
      activated: async (chatId, generationId) => (await ask("lore.activated", { chat: chatId, generation: generationId })).entries
    },
    preset: {
      blocks: async (presetId) => (await ask("preset.blocks", { preset: presetId, chat: deps.chat() })).blocks
    },
    trace: { event: (record) => deps.trace(record), delta: (delta) => deps.delta(delta) },
    clock: {
      now: deps.now,
      sleep: (ms2, signal) => {
        if (signal.aborted)
          return Promise.reject(reasonOf(signal));
        const { promise, resolve, reject } = Promise.withResolvers();
        const ended = () => {
          clearTimeout(timer);
          reject(reasonOf(signal));
        };
        const timer = setTimeout(() => {
          signal.removeEventListener("abort", ended);
          resolve();
        }, ms2);
        signal.addEventListener("abort", ended, { once: true });
        return promise;
      }
    },
    log: deps.log
  };
}

// src/runtime/openai.ts
function textOf(content) {
  if (typeof content === "string")
    return content;
  if (!Array.isArray(content))
    return "";
  return content.map((p) => isRecord2(p) && (p.type === "text" || p.type === "input_text") && typeof p.text === "string" ? p.text : "").join("");
}
function argsOf(raw) {
  if (isRecord2(raw))
    return raw;
  if (typeof raw !== "string" || raw.trim() === "")
    return {};
  try {
    const parsed = JSON.parse(raw);
    return isRecord2(parsed) ? parsed : {};
  } catch {
    return {};
  }
}
function mediaOf(content) {
  if (!Array.isArray(content))
    return [];
  const out = [];
  for (const p of content) {
    if (!isRecord2(p))
      continue;
    if (p.type === "image_url" && isRecord2(p.image_url) && typeof p.image_url.url === "string") {
      const found = /^data:([^;,]+);base64,(.*)$/s.exec(p.image_url.url);
      if (found)
        out.push({ type: "media", media: "image", mimeType: found[1] ?? "", data: found[2] ?? "" });
    } else if (p.type === "input_audio" && isRecord2(p.input_audio) && typeof p.input_audio.data === "string") {
      out.push({ type: "media", media: "audio", mimeType: `audio/${typeof p.input_audio.format === "string" ? p.input_audio.format : "wav"}`, data: p.input_audio.data });
    }
  }
  return out;
}
function modelMessages(raw) {
  const out = [];
  for (const m of Array.isArray(raw) ? raw : []) {
    if (!isRecord2(m))
      continue;
    const text2 = textOf(m.content);
    if (m.role === "tool") {
      const part = { type: "tool_result", toolUseId: typeof m.tool_call_id === "string" ? m.tool_call_id : "", content: text2 };
      const last = out.at(-1);
      if (last?.role === "user" && last.parts !== undefined && last.parts.every((p) => p.type === "tool_result")) {
        last.parts.push(part);
        last.content = `${last.content}
${text2}`;
      } else
        out.push({ role: "user", content: text2, parts: [part] });
      continue;
    }
    const media = mediaOf(m.content);
    if (m.role === "assistant") {
      const reasoning = typeof m.reasoning_content === "string" && m.reasoning_content !== "" ? m.reasoning_content : undefined;
      const details = Array.isArray(m.reasoning_details) ? m.reasoning_details.filter(isRecord2) : [];
      const calls = Array.isArray(m.tool_calls) ? m.tool_calls.filter(isRecord2) : [];
      const uses = calls.map((c, i) => {
        const fn = isRecord2(c.function) ? c.function : {};
        return { type: "tool_use", id: typeof c.id === "string" ? c.id : `call_${i}`, name: typeof fn.name === "string" ? fn.name : "", input: argsOf(fn.arguments) };
      });
      const parts = uses.length > 0 || media.length > 0 ? [...text2 !== "" ? [{ type: "text", text: text2 }] : [], ...media, ...uses] : [];
      out.push({ role: "assistant", content: text2, ...parts.length > 0 ? { parts } : {}, ...reasoning !== undefined ? { reasoning } : {}, ...details.length > 0 ? { reasoningDetails: details } : {} });
      continue;
    }
    const role = m.role === "system" || m.role === "developer" ? "system" : "user";
    out.push({ role, content: text2, ...media.length > 0 ? { parts: [...text2 !== "" ? [{ type: "text", text: text2 }] : [], ...media] } : {} });
  }
  return out;
}
function modelTools(raw) {
  return (Array.isArray(raw) ? raw : []).flatMap((t) => {
    if (!isRecord2(t))
      return [];
    const fn = isRecord2(t.function) ? t.function : t;
    if (typeof fn.name !== "string" || fn.name === "")
      return [];
    return [{ name: fn.name, description: typeof fn.description === "string" ? fn.description : "", parameters: isRecord2(fn.parameters) ? fn.parameters : { type: "object", properties: {} } }];
  });
}
var NUMBERS = ["temperature", "top_p", "top_k", "min_p", "frequency_penalty", "presence_penalty", "repetition_penalty", "seed"];
function samplingOf(body) {
  const out = {};
  for (const key of NUMBERS) {
    const v2 = body[key];
    if (typeof v2 === "number" && Number.isFinite(v2))
      out[key] = v2;
  }
  const stop2 = typeof body.stop === "string" ? [body.stop] : Array.isArray(body.stop) ? body.stop.filter((s) => typeof s === "string") : [];
  if (stop2.length > 0)
    out.stop = stop2;
  return out;
}
function maxTokensOf(body) {
  const v2 = body.max_tokens ?? body.max_completion_tokens;
  return typeof v2 === "number" && Number.isSafeInteger(v2) && v2 > 0 ? v2 : null;
}
var OWN_FIELDS = { messages: true, tools: true, model: true, stream: true, stream_options: true, [TAG_PARAM]: true };
function passedParameters(body) {
  const out = {};
  const tools = Array.isArray(body.tools) && body.tools.length > 0;
  for (const [key, value] of Object.entries(body)) {
    if (Object.hasOwn(OWN_FIELDS, key) || key === "tool_choice" && !tools)
      continue;
    out[key] = value;
  }
  return out;
}
var LOOKAHEAD = 64;
function withSources(messages, sources) {
  let next = 0;
  return messages.map((m) => {
    if (next >= sources.length)
      return m;
    const mark = contentMark(m.role, m.content);
    for (let i = next;i < Math.min(sources.length, next + LOOKAHEAD); i++) {
      const candidate = sources[i];
      if (candidate !== undefined && candidate.mark === mark) {
        next = i + 1;
        return { ...m, source: candidate.source };
      }
    }
    return m;
  });
}

// src/runtime/sse.ts
var SSE_HEADERS = {
  "Content-Type": "text/event-stream; charset=utf-8",
  "Cache-Control": "no-cache, no-transform",
  Connection: "keep-alive",
  "X-Accel-Buffering": "no"
};
var DONE = `data: [DONE]

`;
var data = (value) => `data: ${JSON.stringify(value)}

`;
function frame(c, delta, finish) {
  return { id: c.id, object: "chat.completion.chunk", created: c.created, model: c.model, choices: [{ index: 0, delta, finish_reason: finish }] };
}
function toolCallJson(t) {
  const fn = {};
  if (t.name !== undefined)
    fn.name = t.name;
  if (t.arguments !== undefined)
    fn.arguments = t.arguments;
  return { index: t.index, ...t.id !== undefined ? { id: t.id, type: "function" } : {}, function: fn };
}
function errorJson(message, code) {
  return { error: { message, type: "lumiah_error", code } };
}
var minutes = (ms2) => Math.max(1, Math.floor(ms2 / 60000));
var oneLine = (text2) => text2.replace(/\s*\n\s*/g, " ").trim();

class SseAnswer {
  c;
  write;
  done = false;
  lastWrite;
  lastToken;
  lineEnded = true;
  progress = null;
  constructor(c, write, now) {
    this.c = c;
    this.write = write;
    this.lastWrite = now;
    this.lastToken = now;
    this.send(data(frame(c, { role: "assistant", reasoning: "" }, null)), now);
  }
  get ended() {
    return this.done;
  }
  send(text2, now) {
    this.lastWrite = now;
    this.write(text2);
  }
  reasoning(text2, now) {
    if (text2 === "")
      return;
    this.lineEnded = text2.endsWith(`
`);
    this.lastToken = now;
    this.send(data(frame(this.c, { reasoning: text2 }, null)), now);
  }
  line(text2, now) {
    this.reasoning(`${this.lineEnded ? "" : `
`}${text2}
`, now);
  }
  piece(piece, now) {
    if (this.done)
      return;
    switch (piece.kind) {
      case "reasoning":
        this.reasoning(piece.text, now);
        return;
      case "progress": {
        const text2 = oneLine(piece.text);
        if (text2 === "")
          return;
        this.progress = { text: text2, at: now };
        this.line(text2, now);
        return;
      }
      case "content":
        if (piece.text === "")
          return;
        this.lastToken = now;
        this.send(data(frame(this.c, { content: piece.text }, null)), now);
        return;
      case "tool_calls":
        this.lastToken = now;
        this.send(data(frame(this.c, { tool_calls: piece.calls.map(toolCallJson) }, null)), now);
        return;
      case "finish":
        this.done = true;
        this.send(data(frame(this.c, {}, piece.finish)), now);
        if (piece.usage !== undefined)
          this.send(data({ id: this.c.id, object: "chat.completion.chunk", created: this.c.created, model: this.c.model, choices: [], usage: piece.usage }), now);
        this.send(DONE, now);
        return;
      case "error":
        this.fail(piece.message, piece.code, now);
        return;
    }
  }
  fail(message, code, now) {
    if (this.done)
      return;
    this.done = true;
    this.send(data(errorJson(message, code)), now);
  }
  keepAlive(now, alive, k) {
    if (this.done)
      return;
    if (alive && now - this.lastToken >= k.progressMs) {
      const p = this.progress;
      this.line(p === null ? `Still working (${minutes(now - this.lastToken)} min)` : `${p.text} (${minutes(now - p.at)} min)`, now);
      return;
    }
    if (now - this.lastWrite >= k.commentMs)
      this.send(`: keep-alive

`, now);
  }
}
function statusOf(code) {
  switch (code) {
    case "bad_request":
    case "invalid_request":
      return 400;
    case "invalid_api_key":
      return 401;
    case "forbidden":
      return 403;
    case "not_found":
      return 404;
    case "too_large":
      return 413;
    case "rate_limited":
      return 429;
    case "conflict":
      return 409;
    case "unavailable":
    case "unreachable":
    case "closed":
    case "lost":
    case "revoked":
    case "version":
    case "login":
    case "locked":
    case "insecure":
    case "not_installed":
    case "not_running":
    case "too_old":
    case "protocol":
      return 503;
    case "timeout":
    case "stalled":
      return 504;
    default:
      return 500;
  }
}

class JsonAnswer {
  c;
  content = "";
  reasoningText = "";
  tools = new Map;
  result = null;
  constructor(c) {
    this.c = c;
  }
  get ended() {
    return this.result !== null;
  }
  get answer() {
    return this.result;
  }
  piece(piece) {
    if (this.result !== null)
      return;
    switch (piece.kind) {
      case "reasoning":
        this.reasoningText += piece.text;
        return;
      case "progress": {
        const text2 = oneLine(piece.text);
        if (text2 !== "")
          this.reasoningText += `${this.reasoningText === "" || this.reasoningText.endsWith(`
`) ? "" : `
`}${text2}
`;
        return;
      }
      case "content":
        this.content += piece.text;
        return;
      case "tool_calls":
        for (const t of piece.calls) {
          const held = this.tools.get(t.index) ?? { id: "", name: "", arguments: "" };
          if (t.id !== undefined && held.id === "")
            held.id = t.id;
          held.name += t.name ?? "";
          held.arguments += t.arguments ?? "";
          this.tools.set(t.index, held);
        }
        return;
      case "finish": {
        const toolCalls = [...this.tools.entries()].sort(([a], [b]) => a - b).map(([, t]) => ({ id: t.id, type: "function", function: { name: t.name, arguments: t.arguments } }));
        const message = { role: "assistant", content: this.content === "" && toolCalls.length > 0 ? null : this.content };
        if (this.reasoningText !== "")
          message.reasoning = this.reasoningText;
        if (toolCalls.length > 0)
          message.tool_calls = toolCalls;
        this.result = {
          status: 200,
          body: { id: this.c.id, object: "chat.completion", created: this.c.created, model: this.c.model, choices: [{ index: 0, message, finish_reason: piece.finish }], ...piece.usage !== undefined ? { usage: piece.usage } : {} }
        };
        return;
      }
      case "error":
        this.fail(piece.message, piece.code);
        return;
    }
  }
  fail(message, code) {
    if (this.result !== null)
      return;
    this.result = { status: statusOf(code), body: errorJson(message, code) };
  }
}

// src/runtime/relay.ts
var encoder2 = new TextEncoder;
function json(status, body, headers = {}) {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json", ...headers } });
}
var LOOPBACK_HOSTS = { "127.0.0.1": true, localhost: true, "[::1]": true, "::1": true };
var WILDCARD_HOSTS = { "0.0.0.0": true, "::": true, "[::]": true };

class Relay {
  link;
  streams;
  turns;
  settings;
  env;
  calls = new Map;
  constructor(link, streams, turns, settings, env) {
    this.link = link;
    this.streams = streams;
    this.turns = turns;
    this.settings = settings;
    this.env = env;
  }
  get count() {
    return this.calls.size;
  }
  tick() {
    const now = this.env.now();
    const alive = this.link.out === null;
    const tuning = this.env.tuning();
    for (const call of this.calls.values())
      if (call.answer instanceof SseAnswer)
        call.answer.keepAlive(now, alive, tuning);
  }
  shutdown() {
    for (const call of [...this.calls.values()]) {
      call.closed();
      this.end(call, { message: "The runtime is restarting. Press Retry in a moment.", code: "unavailable" });
    }
  }
  fetch = async (req) => {
    const url = new URL(req.url);
    if (req.headers.get("origin") !== null)
      return json(403, errorJson("LumiAH's runtime answers Lumiverse's server, not a browser.", "forbidden"));
    if (!this.hostAllowed(req.headers.get("host")))
      return json(421, errorJson(`This is LumiAH's runtime at ${this.settings.listen}:${this.settings.port}; it answers requests addressed to it alone.`, "misdirected"));
    const path = url.pathname.replace(/\/+$/, "").replace(/^\/v1(?=\/)/, "");
    if (path === "/healthz" && req.method === "GET") {
      const out = this.link.out;
      return json(200, { ok: this.link.refused === null, link: this.link.refused !== null ? "refused" : out?.why ?? (this.link.up ? "up" : "down"), turns: this.turns.count, requests: this.calls.size, ...this.link.refused !== null ? { problem: this.link.refused } : {} });
    }
    if (path === "/models" && req.method === "GET")
      return this.models(req);
    if (path === "/chat/completions" && req.method === "POST")
      return this.completions(req);
    return json(404, errorJson(`LumiAH's runtime has no ${req.method} ${url.pathname}: it serves POST /v1/chat/completions and GET /v1/models.`, "not_found"));
  };
  hostAllowed(host) {
    if (host === null)
      return false;
    const listen = this.settings.listen.toLowerCase();
    if (hasOwn2(WILDCARD_HOSTS, listen))
      return true;
    const at = host.lastIndexOf(":");
    const ported = at > 0 && !host.endsWith("]");
    const name = (ported ? host.slice(0, at) : host).toLowerCase();
    if ((ported ? Number(host.slice(at + 1)) : 80) !== this.settings.port)
      return false;
    return hasOwn2(LOOPBACK_HOSTS, listen) ? hasOwn2(LOOPBACK_HOSTS, name) : name === listen || name === `[${listen}]`;
  }
  keyOf(req) {
    const auth = req.headers.get("authorization") ?? "";
    const key = /^Bearer\s+(.+)$/i.exec(auth.trim())?.[1]?.trim() ?? "";
    return key === "" ? null : key;
  }
  noKey() {
    return json(401, errorJson("This is LumiAH's runtime: set the connection's API key to your loopback key (LumiAH \u2192 Runtime).", "invalid_api_key"));
  }
  async models(req) {
    const key = this.keyOf(req);
    if (key === null)
      return this.noKey();
    if (this.link.refused !== null)
      return json(503, errorJson(this.link.refused, "revoked"));
    try {
      const { models } = await this.link.request("models", { key }, this.env.tuning().modelsWaitMs);
      return json(200, { object: "list", data: models.map((m) => ({ id: m.id, object: "model", created: 0, owned_by: "lumiah" })) });
    } catch (error) {
      const p = problemOf(error);
      const badKey = error instanceof LinkError && error.code === "forbidden";
      return json(badKey ? 401 : statusOf(p.code), errorJson(p.message, badKey ? "invalid_api_key" : p.code));
    }
  }
  async completions(req) {
    const key = this.keyOf(req);
    if (key === null)
      return this.noKey();
    const cap = this.env.tuning().maxBodyBytes;
    const length = Number(req.headers.get("content-length") ?? "0");
    const tooLarge = (bytes2) => json(413, errorJson(`This request is ${(bytes2 / 1048576).toFixed(1)} MiB, and the runtime reads at most ${(cap / 1048576).toFixed(1)} MiB (LumiAH \u2192 Settings \u2192 Transport \u2192 Runtime). Lower the history cutoff or the connection's context size.`, "too_large"));
    if (length > cap)
      return tooLarge(length);
    const parts = [];
    let bytes = 0;
    if (req.body !== null) {
      const reader = req.body.getReader();
      for (;; ) {
        const { done, value } = await reader.read();
        if (done)
          break;
        bytes += value.byteLength;
        if (bytes > cap) {
          reader.cancel().catch(() => {});
          return tooLarge(bytes);
        }
        parts.push(value);
      }
    }
    let body;
    try {
      body = JSON.parse(new TextDecoder().decode(Buffer.concat(parts)));
    } catch {
      return json(400, errorJson("The request body isn't JSON.", "invalid_request"));
    }
    if (!isRecord2(body) || !Array.isArray(body.messages))
      return json(400, errorJson("The request isn't a chat completion: it has no messages.", "invalid_request"));
    const tag = body[TAG_PARAM];
    if (tag !== undefined && (typeof tag !== "string" || tag === ""))
      return json(400, errorJson(`${TAG_PARAM} must be the turn's tag.`, "invalid_request"));
    const forwarded = { ...body };
    delete forwarded[TAG_PARAM];
    if (this.link.refused !== null)
      return json(503, errorJson(this.link.refused, "revoked"));
    const now = this.env.now();
    const id = this.env.id();
    const completion = { id: `chatcmpl-${id.slice(0, 24)}`, model: typeof body.model === "string" && body.model !== "" ? body.model : MODEL_ID, created: Math.floor(now / 1000) };
    const jsonAnswer = new JsonAnswer(completion);
    const call = { id, answer: jsonAnswer, settle: () => {
      return;
    }, closed: () => {
      return;
    }, ended: false };
    req.signal.addEventListener("abort", () => this.close(call), { once: true });
    const start = () => typeof tag === "string" ? this.turn(call, tag, key, forwarded) : this.passthrough(call, key, forwarded);
    if (body.stream === true) {
      const stream = new ReadableStream({
        start: (controller) => {
          let open = true;
          const write = (piece) => {
            if (!open)
              return;
            try {
              controller.enqueue(encoder2.encode(piece));
            } catch {
              open = false;
            }
          };
          call.answer = new SseAnswer(completion, write, now);
          call.settle = () => {
            if (!open)
              return;
            open = false;
            try {
              controller.close();
            } catch {}
          };
        },
        cancel: () => this.close(call)
      });
      start();
      return new Response(stream, { status: 200, headers: SSE_HEADERS });
    }
    const { promise, resolve } = Promise.withResolvers();
    call.settle = () => {
      const answer = jsonAnswer.answer;
      resolve(answer === null ? json(500, errorJson("The runtime ended this call without an answer.", "internal")) : json(answer.status, answer.body));
    };
    start();
    return promise;
  }
  writer(call) {
    return {
      get ended() {
        return call.ended || call.answer.ended;
      },
      piece: (piece, now) => {
        if (call.ended)
          return;
        call.answer.piece(piece, now);
        if (call.answer.ended)
          this.finish(call);
      },
      fail: (message, code, now) => {
        if (call.ended)
          return;
        call.answer.fail(message, code, now);
        this.finish(call);
      }
    };
  }
  turn(call, tag, key, body) {
    this.calls.set(call.id, call);
    const stop2 = new AbortController;
    call.closed = () => stop2.abort(new Error("Lumiverse closed the request (Stop)"));
    const answer = this.writer(call);
    this.turns.run({ request: call.id, tag, key, body, answer, signal: stop2.signal }).catch((error) => {
      const p = problemOf(error);
      this.env.log(`a turn failed: ${p.message}`);
      answer.fail(p.message, p.code, this.env.now());
    }).finally(() => {
      if (!call.ended)
        answer.fail("The turn ended without a reply.", "internal", this.env.now());
    });
  }
  passthrough(call, key, body) {
    this.calls.set(call.id, call);
    const stream = this.env.id();
    const answer = this.writer(call);
    const reader = {
      chunk: (chunk) => {
        const now = this.env.now();
        switch (chunk.kind) {
          case "content":
          case "reasoning":
            answer.piece({ kind: chunk.kind, text: chunk.text }, now);
            return;
          case "done": {
            const calls = chunk.result.toolCalls ?? [];
            if (calls.length > 0)
              answer.piece({ kind: "tool_calls", calls: calls.map((c, index) => ({ index, id: c.callId, name: c.name, arguments: JSON.stringify(c.args) })) }, now);
            const piece = { kind: "finish", finish: chunk.result.finishReason || (calls.length > 0 ? "tool_calls" : "stop") };
            if (chunk.result.usage !== undefined)
              piece.usage = chunk.result.usage;
            answer.piece(piece, now);
            return;
          }
          case "error":
            answer.fail(chunk.message, chunk.code, now);
            return;
        }
      }
    };
    call.closed = () => this.streams.cancel(stream, "closed");
    const messages = modelMessages(body.messages);
    const tools = modelTools(body.tools);
    const parameters = passedParameters(body);
    this.streams.start(stream, reader, async () => {
      const connection = await this.turns.writerConnection();
      return this.link.request("passthrough", { key, stream, connection, messages, tools, parameters }, this.env.tuning().lostMs);
    });
  }
  finish(call) {
    if (call.ended)
      return;
    call.ended = true;
    this.calls.delete(call.id);
    call.settle();
  }
  end(call, problem) {
    if (call.ended)
      return;
    call.answer.fail(problem.message, problem.code, this.env.now());
    this.finish(call);
  }
  close(call) {
    if (call.ended)
      return;
    call.closed();
    this.finish(call);
  }
}

// src/runtime/settings.ts
class RuntimeSettings {
  link;
  env;
  held = null;
  latest = null;
  named = 0;
  reading = null;
  current;
  constructor(link, env) {
    this.link = link;
    this.env = env;
    this.current = env.tuning;
  }
  tuning = () => this.current;
  note(revision) {
    this.latest = revision;
    this.named++;
    if (this.held?.revision !== revision)
      this.get().catch((error) => this.env.log(`couldn't read the settings yet: ${error instanceof Error ? error.message : String(error)}`));
  }
  get() {
    if (this.held !== null && (this.latest === null || this.held.revision === this.latest))
      return Promise.resolve(this.held);
    this.reading ??= this.read().finally(() => {
      this.reading = null;
    });
    return this.reading;
  }
  async read() {
    const named2 = this.named;
    const snapshot = await this.link.request("settings.get", {}, this.current.lostMs);
    this.held = snapshot;
    if (named2 === this.named)
      this.latest = snapshot.revision;
    const tuning = runtimeTuningOf(snapshot.values);
    if (JSON.stringify(tuning) !== JSON.stringify(this.current)) {
      this.current = tuning;
      this.env.keep(tuning);
    }
    return snapshot;
  }
}

// src/runtime/trace.ts
class TraceSink {
  link;
  env;
  queue = [];
  timer = null;
  sending = null;
  broken = new Set;
  deltas = [];
  deltaTimer = null;
  constructor(link, env) {
    this.link = link;
    this.env = env;
  }
  event(record) {
    if (this.broken.has(record.turn))
      return;
    if (this.queue.length >= this.env.tuning().traceHeld) {
      this.give(record.turn, `more than ${this.env.tuning().traceHeld} of its events are waiting to be sent`);
      return;
    }
    this.queue.push(record);
    if (this.sending !== null || this.timer !== null)
      return;
    this.timer = setTimeout(() => {
      this.timer = null;
      this.flush();
    }, this.env.tuning().traceMs);
  }
  delta(delta) {
    if (this.broken.has(delta.turn))
      return;
    const last = this.deltas.at(-1);
    if (last !== undefined && last.turn === delta.turn && last.agentId === delta.agentId && last.call === delta.call) {
      if (delta.text !== undefined)
        last.text = (last.text ?? "") + delta.text;
      if (delta.reasoning !== undefined)
        last.reasoning = (last.reasoning ?? "") + delta.reasoning;
    } else {
      if (this.deltas.length >= this.env.tuning().traceHeld)
        this.deltas.shift();
      this.deltas.push({ ...delta });
    }
    if (this.deltaTimer !== null)
      return;
    this.deltaTimer = setTimeout(() => {
      this.deltaTimer = null;
      this.sendDeltas();
    }, this.env.tuning().traceMs);
  }
  sendDeltas() {
    if (this.deltaTimer !== null) {
      clearTimeout(this.deltaTimer);
      this.deltaTimer = null;
    }
    if (this.deltas.length === 0)
      return;
    const deltas = this.deltas;
    this.deltas = [];
    this.link.notify({ type: "trace.deltas", deltas });
  }
  async drained() {
    if (this.timer !== null) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    this.flush();
    while (this.sending !== null)
      await this.sending;
  }
  forget(turn) {
    this.broken.delete(turn);
    this.deltas = this.deltas.filter((d) => d.turn !== turn);
  }
  flush() {
    if (this.sending !== null || this.queue.length === 0)
      return;
    this.sending = this.send().finally(() => {
      this.sending = null;
      if (this.queue.length > 0)
        this.flush();
    });
  }
  async send() {
    while (this.queue.length > 0) {
      const batch = this.queue.slice(0, this.env.tuning().traceBatch);
      this.sendDeltas();
      const first = this.env.now();
      for (;; ) {
        const wait = this.env.tuning().lostMs;
        try {
          await this.link.request("trace.push", { records: batch }, wait);
          break;
        } catch (error) {
          if (error instanceof LiveError && error.problem === "closed" && this.env.now() - first < wait)
            continue;
          for (const turn of new Set(batch.map((r) => r.turn)))
            this.give(turn, problemOf(error).message);
          break;
        }
      }
      const sent = new Set(batch);
      this.queue = this.queue.filter((r) => !sent.has(r));
    }
  }
  give(turn, why) {
    if (this.broken.has(turn))
      return;
    this.broken.add(turn);
    this.queue = this.queue.filter((r) => r.turn !== turn);
    this.deltas = this.deltas.filter((d) => d.turn !== turn);
    this.env.log(`turn ${turn.slice(0, 8)}'s later steps won't show in the live view (${why}); its stored transcript is unaffected`);
  }
}

// src/runtime/turn.ts
import { AsyncLocalStorage } from "async_hooks";
function usageJson(usage, turn) {
  return {
    prompt_tokens: usage.in,
    completion_tokens: usage.out,
    total_tokens: usage.in + usage.out,
    prompt_tokens_details: { cached_tokens: usage.cachedIn },
    completion_tokens_details: { reasoning_tokens: usage.reasoningOut },
    lumiah_turn: turn,
    lumiah: { calls: usage.calls, tool_turns: usage.toolTurns, ms: usage.ms, estimated: usage.estimated, ...usage.cost !== undefined ? { cost: usage.cost } : {} }
  };
}

class Turns {
  link;
  harness;
  settings;
  trace;
  env;
  byTurn = new Map;
  byChat = new Map;
  scope = new AsyncLocalStorage;
  constructor(link, harness, settings, trace, env) {
    this.link = link;
    this.harness = harness;
    this.settings = settings;
    this.trace = trace;
    this.env = env;
  }
  get count() {
    return this.byTurn.size;
  }
  ids() {
    return [...this.byTurn.keys()];
  }
  current = () => this.scope.getStore()?.turn ?? null;
  currentChat = () => this.scope.getStore()?.chat ?? null;
  async writerConnection() {
    return this.env.writerConnection((await this.settings.get()).values);
  }
  stop(push) {
    this.byTurn.get(push.turn)?.stop.abort(new Error(push.why));
  }
  shutdown() {
    for (const running of this.byTurn.values())
      running.stop.abort(new Error("The runtime is restarting."));
  }
  async run(request) {
    const { answer } = request;
    let facts;
    try {
      facts = await this.begin(request);
    } catch (error) {
      const p = problemOf(error);
      answer.fail(p.message, p.code === "forbidden" ? "invalid_api_key" : p.code, this.env.now());
      return;
    }
    const stop2 = new AbortController;
    const closed = () => stop2.abort(request.signal.reason instanceof Error ? request.signal.reason : new Error("Lumiverse closed the request (Stop)"));
    if (request.signal.aborted)
      closed();
    else
      request.signal.addEventListener("abort", closed, { once: true });
    const finished = Promise.withResolvers();
    const running = { turn: facts.turn, chat: facts.chat, stop: stop2, done: finished.promise };
    try {
      if (!await this.takeChat(running)) {
        answer.fail("The chat's earlier reply hasn't stopped yet, so this one wasn't started. Try again in a moment.", "conflict", this.env.now());
        return;
      }
      this.settings.note(facts.settings);
      const turn = {
        userId: facts.user,
        chatId: facts.chat,
        generationId: facts.generation,
        kind: facts.kind,
        target: { messageId: facts.target.message, swipeId: facts.target.swipe },
        presetId: facts.preset,
        messages: withSources(modelMessages(request.body.messages), facts.sources),
        params: samplingOf(request.body),
        maxTokens: maxTokensOf(request.body)
      };
      const sink = {
        progress: (text2) => answer.piece({ kind: "progress", text: text2 }, this.env.now()),
        reasoning: (text2) => answer.piece({ kind: "reasoning", text: text2 }, this.env.now()),
        content: (text2) => answer.piece({ kind: "content", text: text2 }, this.env.now()),
        done: (finish, usage) => answer.piece({ kind: "finish", finish: finish === "" ? "stop" : finish, usage: usageJson(usage, facts.turn) }, this.env.now()),
        error: (message, code) => answer.fail(stop2.signal.aborted && stop2.signal.reason instanceof Error ? stop2.signal.reason.message : message, code ?? "turn_failed", this.env.now())
      };
      const result = await this.scope.run({ turn: facts.turn, chat: facts.chat }, () => this.harness.answer(turn, sink, stop2.signal));
      if (!answer.ended)
        answer.fail(result.reason ?? "The turn ended without a reply.", "turn_failed", this.env.now());
      if (result.record !== null)
        await this.commit(facts, result.record);
      else if (result.status !== "done")
        this.env.log(`turn ${facts.turn.slice(0, 8)} ${result.status}${result.reason !== undefined ? `: ${result.reason}` : ""}`);
    } catch (error) {
      const p = problemOf(error);
      this.env.log(`turn ${facts.turn.slice(0, 8)} failed: ${p.message}`);
      answer.fail(`LumiAH's turn failed: ${p.message}`, p.code, this.env.now());
    } finally {
      request.signal.removeEventListener("abort", closed);
      await this.trace.drained().catch(() => {
        return;
      });
      this.trace.forget(facts.turn);
      if (this.byTurn.get(facts.turn) === running)
        this.byTurn.delete(facts.turn);
      if (this.byChat.get(facts.chat) === running)
        this.byChat.delete(facts.chat);
      finished.resolve();
    }
  }
  async begin(request) {
    const first = this.env.now();
    for (;; ) {
      const wait = this.env.tuning().lostMs;
      try {
        return await this.link.request("turn.begin", { key: request.key, tag: request.tag, request: request.request }, wait);
      } catch (error) {
        if (error instanceof LiveError && error.problem === "closed" && !request.signal.aborted && this.env.now() - first < wait)
          continue;
        throw error;
      }
    }
  }
  async takeChat(running) {
    const earlier = this.byChat.get(running.chat);
    if (earlier !== undefined) {
      earlier.stop.abort(new Error("Another reply was asked for in this chat."));
      const { promise: late, resolve } = Promise.withResolvers();
      const timer = setTimeout(() => resolve("late"), this.env.tuning().turnWaitMs);
      const outcome = await Promise.race([earlier.done.then(() => "ended"), late]);
      clearTimeout(timer);
      if (outcome === "late")
        return false;
      if (this.byChat.has(running.chat))
        return this.takeChat(running);
    }
    this.byChat.set(running.chat, running);
    this.byTurn.set(running.turn, running);
    return true;
  }
  async commit(facts, record) {
    const { turn } = facts;
    const first = this.env.now();
    for (;; ) {
      const wait = this.env.tuning().lostMs;
      try {
        const { anchoring } = await this.link.request("turn.commit", { turn, chat: facts.chat, target: facts.target, record }, wait);
        if (anchoring === "never")
          this.env.log(`turn ${turn.slice(0, 8)}: its record wasn't anchored (the reply's message is gone)`);
        return;
      } catch (error) {
        if (error instanceof LiveError && error.problem === "closed" && this.env.now() - first < wait)
          continue;
        this.env.log(`turn ${turn.slice(0, 8)}: its record wasn't handed to LumiAH, so the session won't carry this turn (${problemOf(error).message})`);
        return;
      }
    }
  }
}

// src/runtime/runtime.ts
var CONNECTION_NAME = "LumiAH";
var hex2 = (bytes) => [...crypto.getRandomValues(new Uint8Array(bytes))].map((b) => b.toString(16).padStart(2, "0")).join("");
function createRuntime(config, deps) {
  let settings = null;
  const tuning = () => settings?.tuning() ?? config.tuning;
  const link = new LinkClient({
    base: config.base,
    credentials: deps.credentials,
    http: deps.http,
    openSocket: deps.openSocket,
    relay: config.relay,
    secret: deps.secret,
    rotated: deps.rotated,
    name: config.name,
    build: deps.build,
    runtime: deps.ran,
    host: deps.host,
    listen: config.listen,
    port: config.port,
    tuning,
    now: deps.now,
    log: deps.log
  });
  settings = new RuntimeSettings(link, { tuning: config.tuning, keep: deps.keepTuning, log: deps.log });
  const held = settings;
  const streams = new Streams(link, { now: deps.now, log: deps.log, tuning });
  const trace = new TraceSink(link, { now: deps.now, log: deps.log, tuning });
  let turns = null;
  const host = linkHost({
    link,
    streams,
    id: () => hex2(16),
    now: deps.now,
    tuning,
    log: (level, message) => deps.log(level === "info" || level === "debug" ? message : `${level}: ${message}`),
    trace: (record) => trace.event(record),
    delta: (delta) => trace.delta(delta),
    turn: () => turns?.current() ?? null,
    chat: () => turns?.currentChat() ?? null
  });
  const harness = deps.harness(host, async () => {
    const snapshot = await held.get();
    return { values: snapshot.values.core, texts: snapshot.texts };
  });
  const running = new Turns(link, harness, held, trace, { now: deps.now, log: deps.log, tuning, writerConnection: deps.writerConnection });
  turns = running;
  const relay = new Relay(link, streams, running, { listen: config.listen, port: config.port }, { now: deps.now, id: () => hex2(16), log: deps.log, tuning });
  async function connection(push) {
    const url = runtimeBase(config.listen, config.port);
    let made = null;
    let problem = null;
    try {
      const token = deps.credentials()?.token;
      if (token === undefined)
        throw new Error("the runtime isn't signed in to Lumiverse");
      const found = loopbackProfile(await connectionProfiles(deps.http, config.base, token, tuning().connectionsRead), url, MODEL_ID);
      if (found !== null) {
        await setConnectionKey(deps.http, config.base, token, found.id, push.key);
        made = { id: found.id, name: found.name };
      } else {
        const added = await addConnectionProfile(deps.http, config.base, token, { name: CONNECTION_NAME, provider: "custom", apiUrl: url, model: MODEL_ID, apiKey: push.key });
        made = { id: added.id, name: added.name };
      }
      deps.log(`put the loopback key in the connection "${made.name}"`);
    } catch (error) {
      problem = error instanceof Error ? error.message : String(error);
      deps.log(`couldn't put the loopback key in a connection: ${problem}`);
    }
    await link.request("setup.connection", { ref: push.ref, connection: made, problem }, tuning().lostMs).catch((error) => deps.log(`couldn't tell LumiAH about the connection: ${error instanceof Error ? error.message : String(error)}`));
  }
  link.attach({
    chunk: (push) => streams.chunk(push),
    open: () => streams.open(),
    lost: (ids) => streams.lost(ids),
    stopped: (why, detail) => streams.stopped(why, detail),
    stop: (push) => running.stop(push),
    settings: (revision) => held.note(revision),
    connection: (push) => void connection(push),
    turns: () => running.ids()
  });
  return {
    fetch: relay.fetch,
    tick() {
      link.tick();
      streams.tick();
      relay.tick();
    },
    shutdown() {
      running.shutdown();
      relay.shutdown();
      streams.shutdown();
    },
    close: () => link.close(),
    link,
    relay,
    turns: running
  };
}

// src/runtime/cli.ts
var FLAGS = { "--systemd": true, "--allow-http": true, "--help": true, "--version": true };
var DEFAULT_PORT = 7871;
var LAST_PORT = 7899;
var LISTEN = "127.0.0.1";
var DEFAULT_MEMORY = "1G";
var STICKY = 512;
var GROUP_WRITE = 16;
var OTHERS_WRITE = 2;
var USAGE = `lumiah: LumiAH's runtime, which answers Lumiverse's loopback connection.

  lumiah up --url <address> [--port <n>] [--name <name>] [--systemd]
                        Sign in, register with LumiAH, and serve on 127.0.0.1. --systemd installs it as
                        a service of your account instead, so it survives logout and reboot.
                        More: --listen <host>, --username <name>, --allow-http, --memory <size> (the
                        service's memory cap, ${DEFAULT_MEMORY} by default), --bun <path>
  lumiah serve --config <file> | --name <name>
                        Run the runtime from its config (what the service runs)
  lumiah login | status | down [--name <name>]
                        Sign the runtime in again; how it is; stop and remove its service
  lumiah --version
`;

class UsageError extends Error {
}
function parse2(argv) {
  const args = { positionals: [], values: {}, flags: {} };
  for (let i = 0;i < argv.length; i++) {
    const word2 = argv[i] ?? "";
    if (!word2.startsWith("--")) {
      args.positionals.push(word2);
      continue;
    }
    const eq = word2.indexOf("=");
    const name = eq < 0 ? word2 : word2.slice(0, eq);
    if (Object.hasOwn(FLAGS, name)) {
      args.flags[name] = true;
      continue;
    }
    const value = eq < 0 ? argv[++i] : word2.slice(eq + 1);
    if (value === undefined)
      throw new UsageError(`${name} needs a value.

${USAGE}`);
    args.values[name] = value;
  }
  return args;
}
function only(a, sub, options, flags2) {
  const stray = [...Object.keys(a.values).filter((o) => !options.includes(o)), ...Object.keys(a.flags).filter((f) => !flags2.includes(f) && f !== "--help")];
  if (stray.length > 0)
    throw new UsageError(`lumiah ${sub} doesn't take ${stray.join(", ")}.

${USAGE}`);
  if (a.positionals.length > 1)
    throw new UsageError(`lumiah ${sub} takes no argument (${a.positionals.slice(1).join(" ")}).

${USAGE}`);
}
async function lumiah(argv, io) {
  try {
    const a = parse2(argv);
    const sub = a.positionals[0];
    if (a.flags["--version"] === true) {
      io.out(`lumiah ${io.version} (build ${io.build})`);
      return 0;
    }
    if (sub === undefined || a.flags["--help"] === true) {
      io.out(USAGE);
      return sub === undefined && a.flags["--help"] !== true ? 2 : 0;
    }
    const refused2 = sub === "up" || sub === "serve" || sub === "login" || sub === "status" || sub === "down" ? await refusal(a, io) : null;
    if (refused2 !== null)
      throw new Error(refused2);
    switch (sub) {
      case "up":
        only(a, "up", ["--url", "--port", "--listen", "--name", "--username", "--memory", "--bun"], ["--systemd", "--allow-http"]);
        return await up(a, io);
      case "serve": {
        only(a, "serve", ["--config", "--name"], []);
        const path = configPath(a, io);
        return await serve(configOf(io.files.read(path), path), path, io);
      }
      case "login":
        only(a, "login", ["--config", "--name", "--username"], []);
        return await login(a, io);
      case "status":
        only(a, "status", ["--config", "--name"], []);
        return await status(a, io);
      case "down":
        only(a, "down", ["--name"], []);
        return await down(a, io);
      default:
        throw new UsageError(`There is no lumiah ${sub}: up, serve, login, status or down.

${USAGE}`);
    }
  } catch (error) {
    io.err(error instanceof Error ? error.message : String(error));
    return error instanceof UsageError ? 2 : 1;
  }
}
function placeOf(name, io) {
  const xdg = (variable, fallback) => {
    const v2 = io.env[variable];
    return v2 !== undefined && v2.startsWith("/") ? v2 : `${io.home}/${fallback}`;
  };
  const name_ = unitName(name);
  return { config: configPathOf(configDir(io.env, io.home), name), data: `${xdg("XDG_DATA_HOME", ".local/share")}/lumiah`, unit: `${xdg("XDG_CONFIG_HOME", ".config")}/systemd/user/${name_}`, unitName: name_ };
}
function ctlOf(io) {
  const runtime = io.env.XDG_RUNTIME_DIR ?? (io.uid !== null ? `/run/user/${io.uid}` : undefined);
  return { args: ["--user"], env: runtime !== undefined ? { XDG_RUNTIME_DIR: runtime } : {} };
}
function groupsOf(io) {
  const asked = new Map;
  const ask = async (gid) => {
    const group = await io.run("getent", ["group", String(gid)]);
    const [name = "", , id, listed = ""] = (group.out.split(`
`)[0] ?? "").trim().split(":");
    if (group.code !== 0 || name === "" || id !== String(gid))
      return { name: String(gid), uids: null };
    const passwd = await io.run("getent", ["passwd"]);
    if (passwd.code !== 0)
      return { name, uids: null };
    const accounts = passwd.out.split(`
`).flatMap((line) => {
      const [account = "", , uid = "", primary = ""] = line.trim().split(":");
      return account !== "" && /^\d+$/.test(uid) ? [{ account, uid: Number(uid), primary }] : [];
    });
    const uids = accounts.filter((x) => x.primary === String(gid)).map((x) => x.uid);
    for (const member of listed.split(",").filter((m) => m !== "")) {
      const found = accounts.find((x) => x.account === member);
      if (found === undefined)
        return { name, uids: null };
      uids.push(found.uid);
    }
    return { name, uids };
  };
  return (gid) => {
    let answer = asked.get(gid);
    if (answer === undefined)
      asked.set(gid, answer = ask(gid));
    return answer;
  };
}
async function ownersGroup(entry, groupOf) {
  const { uids } = await groupOf(entry.gid);
  return uids !== null && uids.length > 0 && uids.every((u) => u === entry.uid);
}
async function onlyTheirs(entry, uid, groupOf) {
  if (entry.uid !== uid && entry.uid !== 0 || (entry.mode & OTHERS_WRITE) !== 0)
    return false;
  return (entry.mode & GROUP_WRITE) === 0 || await ownersGroup(entry, groupOf);
}
async function changeable(io, path, uid, groupOf) {
  const found = [];
  let below = null;
  for (let at = io.files.real(path);; at = at.slice(0, at.lastIndexOf("/")) || "/") {
    const entry = io.files.stat(at);
    const sticky = entry !== null && below !== null && (entry.mode & STICKY) !== 0 && (entry.uid === uid || entry.uid === 0) && (below.uid === uid || below.uid === 0);
    if (entry !== null && !sticky && !await onlyTheirs(entry, uid, groupOf)) {
      found.push({ path: at, entry });
      if (entry.uid !== uid && entry.uid !== 0)
        return found;
    }
    if (at === "/")
      return found;
    below = entry;
  }
}
async function refusal(a, io) {
  const me = io.uid;
  if (me === null)
    return null;
  const groupOf = groupsOf(io);
  const unsafe = [];
  for (const path of new Set([io.self, io.bun, a.values["--bun"]])) {
    if (path === null || path === undefined)
      continue;
    let found;
    try {
      found = await changeable(io, path, me, groupOf);
    } catch (error) {
      unsafe.push({ path, uid: null, why: `can't be checked (${error instanceof Error ? error.message : String(error)})` });
      continue;
    }
    for (const f of found)
      if (!unsafe.some((u) => u.path === f.path))
        unsafe.push({ path: f.path, uid: f.entry.uid, why: null, entry: f.entry });
  }
  if (unsafe.length === 0)
    return null;
  const names = new Map;
  for (const { uid } of unsafe)
    if (uid !== null && uid !== 0 && uid !== me && !names.has(uid))
      names.set(uid, (await io.run("id", ["-nu", String(uid)])).out.trim() || String(uid));
  const shared = new Map;
  for (const { path, uid, entry } of unsafe) {
    if (entry === undefined || uid !== me && uid !== 0)
      continue;
    const group = (entry.mode & GROUP_WRITE) !== 0 && !await ownersGroup(entry, groupOf) ? (await groupOf(entry.gid)).name : null;
    const others = (entry.mode & OTHERS_WRITE) !== 0;
    const why = group !== null ? `its group, ${group}, ${others ? "and everyone else " : ""}can change it` : "everyone else can change it";
    shared.set(path, { why, chmod: `  ${uid === 0 && me !== 0 ? "sudo " : ""}chmod ${group !== null ? "g" : ""}${others ? "o" : ""}-w ${shellWord(path)}` });
  }
  const who2 = me === 0 ? "root" : (await io.run("id", ["-nu"])).out.trim() || String(me);
  const listed = unsafe.map(({ path, uid, why }) => `  ${path}: ${why ?? shared.get(path)?.why ?? `${names.get(uid ?? -1) ?? uid} can change it`}`);
  const chmods = unsafe.flatMap((u) => shared.get(u.path)?.chmod ?? []);
  const head = `Refusing to run as ${who2}: another account can change these, and would then run code as ${who2} through this command.`;
  if (unsafe.every((u) => shared.has(u.path)))
    return [head, ...listed, "Take that write away, then run it again:", ...chmods].join(`
`);
  const account = names.values().next().value ?? null;
  const as = account !== null ? shellWord(account) : "<the account Lumiverse runs as>";
  return [head, ...listed, ...chmods.length > 0 ? ["First take away the write that isn't its owner's:", ...chmods] : [], `Run the runtime as ${as} instead, the account its files belong to:`, `  sudo -u ${as} <the same line>`].join(`
`);
}
function nameFrom(username) {
  const name = username.toLowerCase().replace(/[^a-z0-9_-]+/g, "-").replace(/^[-_]+/, "").slice(0, 40);
  return RUNTIME_NAME.test(name) ? name : "runtime";
}
function givenName(a) {
  const name = a.values["--name"];
  if (name !== undefined && !RUNTIME_NAME.test(name))
    throw new UsageError(`--name is "${name}": use lowercase letters, digits, _ and -, up to 40.`);
  return name;
}
function configured(io) {
  return io.files.list(configDir(io.env, io.home)).filter((f) => f.endsWith(".json") && RUNTIME_NAME.test(f.slice(0, -5))).map((f) => f.slice(0, -5)).sort();
}
function configPath(a, io) {
  const given = a.values["--config"];
  if (given !== undefined)
    return given;
  const dir = configDir(io.env, io.home);
  const name = givenName(a);
  if (name !== undefined)
    return configPathOf(dir, name);
  const found = configured(io);
  if (found.length === 1 && found[0] !== undefined)
    return configPathOf(dir, found[0]);
  throw new UsageError(found.length === 0 ? `No runtime is set up here (${dir}). Start one with: lumiah up --url <the address you open Lumiverse at>` : `Several runtimes are set up here (${found.join(", ")}): pick one with --name.`);
}
function writeConfig(path, config, io) {
  io.files.write(path, configText(config), 384, 448);
}
async function signInFor(base, io, username, allowHttp) {
  const clear = inClear(base);
  if (clear && !allowHttp)
    throw new UsageError(`${base} is plain http to another machine: the password, and the runtime's session on every call after, would cross the network in clear. Use Lumiverse's https address, or accept that with --allow-http.`);
  await sessionOf(io.http, base, null);
  const user = username ?? io.env.LUMIVERSE_USERNAME ?? await io.ask("Lumiverse username for the runtime: ", false);
  if (user === null || user.trim() === "")
    throw new UsageError("The runtime needs your Lumiverse username: --username <name>, or LUMIVERSE_USERNAME.");
  const password = io.env.LUMIVERSE_PASSWORD ?? await io.ask(`Password for ${user.trim()} at ${base}: `, true);
  if (password === null || password === "")
    throw new UsageError("No password: run this in a terminal and type it at the prompt, or set LUMIVERSE_PASSWORD.");
  const token = await signIn(io.http, base, user.trim(), password);
  return { username: user.trim(), token, savedAt: io.now(), ...clear ? { allowHttp: true } : {} };
}
async function sessionFor(base, a, io, previous) {
  const asked = a.values["--username"];
  const saved = previous !== null && previous.base === base ? previous.session : null;
  if (saved !== null && (asked === undefined || asked === saved.username)) {
    const state = await sessionOf(io.http, base, saved.token).catch(() => null);
    if (state?.valid === true) {
      io.out(`Using the runtime's saved sign-in to ${base} as ${saved.username}.`);
      return saved;
    }
  }
  return signInFor(base, io, asked ?? saved?.username, a.flags["--allow-http"] === true || saved?.allowHttp === true);
}
function portFree(io, listen, port) {
  const serve = io.serve;
  if (serve === null)
    return false;
  try {
    serve({ hostname: listen, port, fetch: async () => new Response(null, { status: 503 }) }).stop();
    return true;
  } catch {
    return false;
  }
}
function portOf(a, io, listen, previous) {
  const given = a.values["--port"];
  if (given !== undefined) {
    const port = Number(given);
    if (!Number.isInteger(port) || port < 1 || port > 65535)
      throw new UsageError(`--port is "${given}": give a port number.`);
    if (previous?.port !== port && !portFree(io, listen, port))
      throw new Error(`Port ${port} on ${listen} is taken. Pick another with --port.`);
    return port;
  }
  if (previous !== null && previous.listen === listen)
    return previous.port;
  for (let port = DEFAULT_PORT;port <= LAST_PORT; port++)
    if (portFree(io, listen, port))
      return port;
  throw new Error(`No port from ${DEFAULT_PORT} to ${LAST_PORT} is free on ${listen}: pick one with --port.`);
}
function inContainer(io) {
  return io.files.exists("/.dockerenv") || io.files.exists("/run/.containerenv");
}
function containerGuide(bun, self, config, base) {
  return [
    "Lumiverse runs in a container here: there is no systemd, and Lumiverse's 127.0.0.1 is the container's own.",
    "Run the runtime inside Lumiverse's container, as a second process:",
    `  ${bun} ${self} up --url ${base}`,
    "or as a compose service that shares Lumiverse's network (127.0.0.1 is then the same for both):",
    "  lumiah:",
    "    image: <Lumiverse's image>",
    '    network_mode: "service:lumiverse"',
    "    volumes: [<Lumiverse's data volume, mounted where it is in Lumiverse's service>]",
    `    command: ["${bun}", "${self}", "serve", "--config", "${config}"]`,
    "    restart: always",
    "    mem_limit: 1g",
    `(run \`up\` once inside the container first, so ${config} exists).`
  ].join(`
`);
}
function unitWord(word2) {
  const escaped = word2.replace(/%/g, "%%").replace(/\$/g, "$$$$");
  return /^[A-Za-z0-9_@%+=:,./$-]+$/.test(escaped) ? escaped : `"${escaped.replace(/\\/g, "\\\\").replace(/"/g, "\\\"")}"`;
}
var MEMORY = /^[1-9][0-9]*[KMGT]?$/;
function unitText(u) {
  return [
    `# Written by \`lumiah up --systemd\`: LumiAH's runtime. \`lumiah down --name ${u.name}\` removes it.`,
    "[Unit]",
    `Description=LumiAH runtime (${u.name})`,
    "StartLimitIntervalSec=0",
    "",
    "[Service]",
    "Type=simple",
    `ExecStart=${[u.bun, u.script, "serve", "--config", u.config].map(unitWord).join(" ")}`,
    "Restart=always",
    "RestartSec=2",
    `MemoryMax=${u.memory}`,
    "",
    "[Install]",
    "WantedBy=default.target",
    ""
  ].join(`
`);
}
async function must(io, command, args, env) {
  const r = await io.run(command, args, env);
  if (r.code !== 0)
    throw new Error(`${command} ${args.join(" ")} failed (${r.code}): ${(r.err || r.out).trim()}`);
  return r.out.trim();
}
async function baseFor(a, io) {
  const given = a.values["--url"] ?? io.env.LUMIVERSE_URL;
  if (given !== undefined)
    return normalizeBase(given);
  const names = configured(io);
  const name = givenName(a) ?? (names.length === 1 ? names[0] : undefined);
  if (name !== undefined) {
    try {
      const path = configPathOf(configDir(io.env, io.home), name);
      return configOf(io.files.read(path), path).base;
    } catch {}
  }
  const asked = await io.ask("Lumiverse address (as you open it in a browser): ", false);
  if (asked === null || asked.trim() === "")
    throw new UsageError("lumiah up needs Lumiverse's address: --url <address>, or LUMIVERSE_URL.");
  return normalizeBase(asked);
}
async function up(a, io) {
  if (io.serve === null || io.bun === null)
    throw new UsageError("LumiAH's runtime runs on Bun (Bun.serve, idleTimeout 0): run this line with Bun, as LumiAH's Runtime page shows it.");
  const systemd = a.flags["--systemd"] === true;
  const base = await baseFor(a, io);
  const listen = a.values["--listen"] ?? LISTEN;
  if (listen !== LISTEN && listen !== "localhost")
    io.err(`Warning: the runtime will listen on ${listen}, where other machines can reach it, not only this one. Every call still needs your loopback key and must be addressed to ${listen} itself, unless that is a wildcard address (0.0.0.0, ::), which answers any name; nothing else stands between them and it.`);
  const bun = a.values["--bun"] ?? io.bun;
  if (!bun.startsWith("/"))
    throw new UsageError(`--bun must be an absolute path (systemd searches no PATH that has Bun): ${bun}`);
  const memory = a.values["--memory"] ?? DEFAULT_MEMORY;
  if (!MEMORY.test(memory))
    throw new UsageError(`--memory is "${memory}": give a size as systemd reads one, such as 768M or 2G.`);
  if (systemd && io.platform !== "linux")
    throw new Error(`--systemd installs a systemd service, and this is ${io.platform}. Run the runtime in the foreground instead (leave out --systemd), under your own service manager.`);
  if (systemd && io.uid === 0)
    throw new Error("--systemd installs a service of your own account, and root's account has none on most systems. Run the runtime as the account Lumiverse runs as (sudo -u <account> \u2026): it needs no more rights than that.");
  if (systemd && inContainer(io))
    throw new Error(containerGuide(bun, io.self, placeOf(givenName(a) ?? "runtime", io).config, base));
  if (systemd && /\.ts$/.test(io.self))
    throw new Error(`The service runs a built runtime, and this runs from source (${io.self}). Build first (bun run build), then run dist/lumiah.js.`);
  const readPrevious = (name2) => {
    try {
      const path = placeOf(name2, io).config;
      return configOf(io.files.read(path), path);
    } catch {
      return null;
    }
  };
  const named2 = givenName(a);
  const names = configured(io);
  const session = await sessionFor(base, a, io, readPrevious(named2 ?? (names.length === 1 && names[0] !== undefined ? names[0] : "")));
  const name = named2 ?? nameFrom(session.username);
  const place = placeOf(name, io);
  const previous = readPrevious(name);
  const port = portOf(a, io, listen, previous);
  const tuning = previous?.tuning ?? { ...RUNTIME_DEFAULTS };
  const conn = new HostConnection({ base, credentials: () => session, http: io.http, openSocket: io.openSocket, limits: () => tuning, now: io.now });
  let registered;
  try {
    await conn.ensureOpen();
    registered = await conn.request("register", { name, build: io.build, host: io.hostname, listen, port });
  } catch (error) {
    if (error instanceof LinkError)
      throw new Error(`LumiAH didn't register the runtime: ${error.message}`);
    if (error instanceof LiveError && error.problem === "timeout")
      throw new Error(`LumiAH on ${base} didn't answer the runtime's registration. Check that it's running in Lumiverse's Extensions tab.`);
    throw error;
  } finally {
    conn.close();
  }
  const who2 = session.username;
  io.out(`Registered the runtime "${name}" with LumiAH: it answers ${who2}'s replies.`);
  const origins = runtimeOrigins(listen, port);
  const scheduler = await excludeOrigins(io.http, base, session.token, origins);
  if (scheduler === "excluded")
    io.out(`Its address (${origins.join(", ")}) is in ${who2}'s local-inference scheduler exclusions, so the scheduler never holds a turn's own calls behind it.`);
  else if (scheduler === "unavailable")
    io.out("This Lumiverse has no local-inference scheduler: nothing to exclude.");
  else
    io.err(`Couldn't put ${origins.join(" and ")} in ${who2}'s local-inference scheduler exclusions. Before turning the scheduler on, add them under Settings \u2192 Inference scheduler \u2192 Excluded origins: a turn would otherwise wait on its own calls.`);
  const config = { name, base, listen, port, relay: registered.relay, secret: registered.secret, session, tuning };
  const connection = await loopbackConnection(io, base, session.token, runtimeBase(listen, port), registered.model || MODEL_ID, config.tuning.connectionsRead);
  if (await editAndSendPrefersActive(io.http, base, session.token) === true)
    io.err(`${who2} has "always use the active connection" on for Edit and Send: a message sent with Edit and Send goes on the active connection, not a chat's pin to the loopback, and LumiAH answers it only when the active connection is the loopback.`);
  if (!systemd) {
    writeConfig(place.config, config, io);
    io.out(`Saved the runtime's config in ${place.config} (readable only by you).`);
    io.out(connection);
    if (inContainer(io))
      io.out(containerGuide(bun, io.self, place.config, base));
    return serve(config, place.config, io);
  }
  writeConfig(place.config, config, io);
  const script = `${place.data}/${io.self.slice(io.self.lastIndexOf("/") + 1)}`;
  io.files.copy(io.self, script, 420);
  io.files.write(place.unit, unitText({ name, bun, script, config: place.config, memory }), 420, 493);
  const ctl = ctlOf(io);
  const user = await must(io, "id", ["-nu"]);
  const lingering = await linger(io, user);
  try {
    await must(io, "systemctl", [...ctl.args, "daemon-reload"], ctl.env);
  } catch (error) {
    if (lingering)
      throw error;
    throw new Error(`${user}'s service manager isn't running (lingering is off, and ${user} isn't logged in), so the runtime's service can't start. Turn lingering on with: sudo loginctl enable-linger ${user}, then run this again.`);
  }
  await must(io, "systemctl", [...ctl.args, "enable", place.unitName], ctl.env);
  if (previous !== null)
    await drain(previous, io);
  await must(io, "systemctl", [...ctl.args, "restart", place.unitName], ctl.env);
  const when = lingering ? "it is started, and starts at boot and keeps running when you log out" : "it is started, but only runs while you are logged in (see above)";
  io.out(`Installed the runtime in ${place.data} and the unit ${place.unitName} (memory cap ${memory}); ${when}.`);
  io.out(connection);
  return 0;
}
async function linger(io, user) {
  const on = async () => (await io.run("loginctl", ["show-user", user, "--property=Linger", "--value"])).out.trim() === "yes";
  if (await on())
    return true;
  const asked = await io.run("loginctl", ["enable-linger", user]);
  if (asked.code === 0 && await on()) {
    io.out(`Turned lingering on for ${user}, so the runtime's service starts at boot and keeps running after you log out.`);
    return true;
  }
  io.err(`Lingering is off for ${user} and couldn't be turned on from here${asked.err.trim() !== "" ? ` (${asked.err.trim()})` : ""}: the runtime's service won't start at boot and stops when you log out. Turn it on with: sudo loginctl enable-linger ${user}`);
  return false;
}
async function loopbackConnection(io, base, token, url, model, read2) {
  try {
    const found = loopbackProfile(await connectionProfiles(io.http, base, token, read2), url, model);
    if (found !== null)
      return `Your connection "${found.name}" is the loopback (${url}, model ${model}). Its API key is your loopback key: mint one on LumiAH's Runtime page and it is put in for you.`;
    const made = await addConnectionProfile(io.http, base, token, { name: CONNECTION_NAME, provider: "custom", apiUrl: url, model });
    return `Added the connection "${made.name}" to Lumiverse: Custom (OpenAI-compatible), base URL ${url}, model ${model}. Mint your loopback key on LumiAH's Runtime page next: it is put in the connection for you.`;
  } catch (error) {
    return `Couldn't add the loopback connection for you (${error instanceof Error ? error.message : String(error)}). In Lumiverse, the loopback is a Custom (OpenAI-compatible) connection: base URL ${url}, model ${model}, and as its API key your loopback key (LumiAH's Runtime page).`;
  }
}
async function serve(config, path, io) {
  const start = io.serve;
  if (start === null)
    throw new UsageError("LumiAH's runtime runs on Bun (Bun.serve, idleTimeout 0): run it with Bun.");
  const log = (text2) => io.err(`[lumiah ${config.name}] ${text2}`);
  let current = config;
  const session = () => {
    try {
      current = { ...current, session: configOf(io.files.read(path), path).session };
    } catch {}
    return current.session;
  };
  const keep = (change) => {
    session();
    current = { ...current, ...change };
    try {
      writeConfig(path, current, io);
    } catch (error) {
      log(`couldn't write ${path}: ${error instanceof Error ? error.message : String(error)}`);
    }
  };
  const unit = io.env.INVOCATION_ID !== undefined ? unitName(config.name) : null;
  const runtime = createRuntime(config, {
    http: io.http,
    openSocket: io.openSocket,
    now: io.now,
    log,
    build: io.build,
    ran: { bun: io.bun, script: io.self, unit },
    host: io.hostname,
    credentials: session,
    secret: () => current.secret,
    rotated: (secret) => keep({ secret }),
    keepTuning: (tuning) => keep({ tuning }),
    harness: io.harness,
    writerConnection: io.writerConnection
  });
  let server;
  try {
    server = start({ hostname: config.listen, port: config.port, fetch: runtime.fetch });
  } catch (error) {
    throw new Error(`The runtime can't serve on ${config.listen}:${config.port}: ${error instanceof Error ? error.message : String(error)}. Is another runtime running there?`);
  }
  log(`serving ${runtimeBase(config.listen, config.port)} for ${config.base} as ${config.session.username} (build ${io.build})`);
  runtime.link.fix();
  const timer = setInterval(() => runtime.tick(), 1000);
  const signal = await io.stopped();
  log(`stopping (${signal})`);
  clearInterval(timer);
  runtime.shutdown();
  await io.sleep(current.tuning.stopGraceMs);
  server.stop();
  runtime.close();
  return 0;
}
async function turnsUnderWay(config, io) {
  try {
    const reply = await io.http({ method: "GET", url: `${runtimeBase(config.listen, config.port).replace(/\/v1$/, "")}/healthz`, headers: { Accept: "application/json" } });
    const body = JSON.parse(reply.text);
    return isRecord2(body) && typeof body.requests === "number" ? body.requests : 0;
  } catch {
    return 0;
  }
}
async function drain(config, io) {
  const { drainMs, drainPollMs } = config.tuning;
  let turns = await turnsUnderWay(config, io);
  if (turns === 0)
    return;
  io.out(`The running runtime has ${turns} request(s) under way: waiting up to ${Math.round(drainMs / 60000)} minutes for them to finish before restarting it.`);
  for (let waited = 0;waited < drainMs && turns > 0; waited += drainPollMs) {
    await io.sleep(drainPollMs);
    turns = await turnsUnderWay(config, io);
  }
  if (turns > 0)
    io.err(`${turns} request(s) still under way after ${Math.round(drainMs / 60000)} minutes: restarting the runtime ends them.`);
}
async function login(a, io) {
  const path = configPath(a, io);
  const config = configOf(io.files.read(path), path);
  const session = await signInFor(config.base, io, a.values["--username"] ?? config.session.username, config.session.allowHttp === true);
  writeConfig(path, { ...config, session }, io);
  io.out(`The runtime "${config.name}" is signed in to ${config.base} as ${session.username} again.`);
  const place = placeOf(config.name, io);
  if (!io.files.exists(place.unit))
    io.out("A runtime running in the foreground takes the new sign-in when it next connects.");
  else {
    const ctl = ctlOf(io);
    await must(io, "systemctl", [...ctl.args, "restart", place.unitName], ctl.env);
    io.out(`Restarted ${place.unitName}.`);
  }
  return 0;
}
async function status(a, io) {
  const path = configPath(a, io);
  const config = configOf(io.files.read(path), path);
  const place = placeOf(config.name, io);
  io.out(`Runtime "${config.name}" for ${config.base} as ${config.session.username}, at ${runtimeBase(config.listen, config.port)}.`);
  if (io.files.exists(place.unit)) {
    const ctl = ctlOf(io);
    const active = await io.run("systemctl", [...ctl.args, "is-active", place.unitName], ctl.env);
    io.out(`Service ${place.unitName}: ${active.out.trim() || "unknown"}.`);
  } else
    io.out("No service: it runs only while `lumiah up` or `lumiah serve` does.");
  let healthy = false;
  try {
    const reply = await io.http({ method: "GET", url: `${runtimeBase(config.listen, config.port).replace(/\/v1$/, "")}/healthz`, headers: { Accept: "application/json" } });
    const body = JSON.parse(reply.text);
    if (isRecord2(body)) {
      healthy = body.ok === true && body.link === "up";
      io.out(`It answers: link to LumiAH ${String(body.link)}, ${String(body.turns)} turn(s) under way${typeof body.problem === "string" ? `. ${body.problem}` : ""}.`);
    }
  } catch (error) {
    io.out(`It doesn't answer on ${config.listen}:${config.port} (${error instanceof Error ? error.message : String(error)}).`);
  }
  try {
    const session = await sessionOf(io.http, config.base, config.session.token);
    io.out(session.valid === false ? `Its Lumiverse session has ended: lumiah login --name ${config.name}` : `Its Lumiverse session holds${session.expiresAt !== null ? ` until ${session.expiresAt} unused (the runtime renews it daily)` : ""}.`);
    if (session.valid === false)
      healthy = false;
  } catch (error) {
    io.out(`Couldn't ask ${config.base} about its session: ${error instanceof Error ? error.message : String(error)}`);
  }
  return healthy ? 0 : 1;
}
async function down(a, io) {
  const path = configPath(a, io);
  const name = givenName(a) ?? configOf(io.files.read(path), path).name;
  const place = placeOf(name, io);
  if (!io.files.exists(place.unit)) {
    io.out(`There is no unit ${place.unitName}: nothing to stop.`);
    return 0;
  }
  const ctl = ctlOf(io);
  await must(io, "systemctl", [...ctl.args, "disable", "--now", place.unitName], ctl.env);
  io.files.remove(place.unit);
  await must(io, "systemctl", [...ctl.args, "daemon-reload"], ctl.env);
  io.out(`Stopped and removed ${place.unitName}. Its config, with the runtime's session, stays in ${place.config}: delete it to forget the runtime here.`);
  return 0;
}

// src/runtime/main.ts
if (process.versions.bun === undefined) {
  process.stderr.write(`LumiAH's runtime runs on Bun 1.4 or newer (its server is Bun.serve): run this file with bun, as LumiAH's Runtime page shows it.
`);
  process.exit(1);
}
var BUILD = "1b9974c5";
var http = async (request) => {
  const response = await fetch(request.url, { method: request.method, headers: request.headers, ...request.body !== undefined ? { body: request.body } : {}, redirect: "manual" });
  const text2 = await response.text();
  return { status: response.status, header: (name) => response.headers.get(name), text: text2 };
};
var openSocket = (url, events) => {
  const ws = new WebSocket(url);
  ws.addEventListener("message", (event) => events.message(typeof event.data === "string" ? event.data : String(event.data)));
  ws.addEventListener("close", (event) => events.close(event.code, event.reason));
  ws.addEventListener("error", () => {
    return;
  });
  return { send: (text2) => ws.send(text2), close: () => ws.close() };
};
function ask(question, hidden) {
  const input = process.stdin;
  if (!input.isTTY)
    return Promise.resolve(null);
  const { promise, resolve } = Promise.withResolvers();
  if (!hidden) {
    const rl = createInterface({ input, output: process.stderr });
    rl.question(question, (answer) => {
      rl.close();
      resolve(answer);
    });
    rl.on("SIGINT", () => {
      rl.close();
      resolve(null);
    });
    return promise;
  }
  process.stderr.write(question);
  const typed = [];
  const done = (value) => {
    input.setRawMode(false);
    input.pause();
    input.off("data", key);
    process.stderr.write(`
`);
    resolve(value);
  };
  const key = (chunk) => {
    for (const ch of chunk) {
      if (ch === "\r" || ch === `
`)
        return done(typed.join(""));
      if (ch === "\x03")
        return done(null);
      if (ch === "\x04")
        return done(typed.length > 0 ? typed.join("") : null);
      if (ch === "\x7F" || ch === "\b")
        typed.pop();
      else
        typed.push(ch);
    }
  };
  input.setEncoding("utf8");
  input.setRawMode(true);
  input.resume();
  input.on("data", key);
  return promise;
}
var io = {
  out: (text2) => process.stdout.write(text2.endsWith(`
`) ? text2 : `${text2}
`),
  err: (text2) => process.stderr.write(text2.endsWith(`
`) ? text2 : `${text2}
`),
  env: process.env,
  ask,
  http,
  openSocket,
  serve(options) {
    const server = Bun.serve({ hostname: options.hostname, port: options.port, idleTimeout: 0, fetch: options.fetch });
    return { stop: () => void server.stop(true) };
  },
  stopped() {
    const { promise, resolve } = Promise.withResolvers();
    process.once("SIGTERM", () => resolve("SIGTERM"));
    process.once("SIGINT", () => resolve("SIGINT"));
    return promise;
  },
  bun: process.execPath,
  self: fileURLToPath(import.meta.url),
  uid: process.getuid?.() ?? null,
  hostname: hostname(),
  platform: process.platform,
  home: homedir(),
  files: {
    read(path) {
      try {
        return readFileSync(path, "utf8");
      } catch (error) {
        if (error instanceof Error && "code" in error && error.code === "ENOENT")
          return null;
        throw error;
      }
    },
    write(path, text2, mode, dirMode) {
      mkdirSync(dirname(path), { recursive: true, mode: dirMode });
      const temp = `${path}.${process.pid}.tmp`;
      writeFileSync(temp, text2, { mode });
      chmodSync(temp, mode);
      renameSync(temp, path);
    },
    copy(from, to, mode) {
      mkdirSync(dirname(to), { recursive: true, mode: 493 });
      const temp = `${to}.${process.pid}.tmp`;
      copyFileSync(from, temp);
      chmodSync(temp, mode);
      renameSync(temp, to);
    },
    exists: (path) => existsSync(path),
    list(dir) {
      try {
        return readdirSync(dir);
      } catch {
        return [];
      }
    },
    remove: (path) => rmSync(path, { force: true }),
    stat(path) {
      if (process.platform === "win32")
        return null;
      const entry = statSync(path);
      return { uid: entry.uid, gid: entry.gid, mode: entry.mode };
    },
    real: (path) => realpathSync(path)
  },
  run(command, args, env) {
    const { promise, resolve } = Promise.withResolvers();
    execFile(command, [...args], { encoding: "utf8", ...env !== undefined ? { env: { ...process.env, ...env } } : {} }, (error, out, err) => {
      const code = error === null ? 0 : typeof error.code === "number" ? error.code : 127;
      resolve({ code, out, err: err || (error !== null && typeof error.code !== "number" ? error.message : "") });
    });
    return promise;
  },
  sleep(ms2) {
    const { promise, resolve } = Promise.withResolvers();
    setTimeout(resolve, ms2);
    return promise;
  },
  now: Date.now,
  build: BUILD,
  version: package_default.version,
  harness: (host, settings) => createHarness(host, { settings }),
  writerConnection: (values) => settingsOf(isRecord2(values) ? values.core : undefined).agents[AGENT.writer]?.connectionId ?? null
};
process.exitCode = await lumiah(process.argv.slice(2), io);
