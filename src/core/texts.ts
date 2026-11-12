// Every text the core sends to a model (DESIGN §3.3, §9), in one place: what each text is, its
// shipped default and the placeholders it may use. Code names a text by its id (`TEXT`), never by a
// literal at a call site, and renders it through the user's texts (`Texts`): the user's own where
// they replaced it, else the default. A text's id, the placeholder syntax `{{name}}` and the
// placeholders a text requires are stored formats (the user's own texts are kept by them), so they
// never change once shipped.
//
// The progress lines a turn writes into the reply's thinking block are here too: a preset may send a
// reply's thinking back to a model, so they are texts like the rest.
//
// The texts of the first slice are written in this file. Each later area's are in a file of its own
// under texts/, which this one gathers: `TEXT` names every id, `TEXT_DEFS` lists every text.

import { isRecord } from "./ports";
import { CURSOR_ARG as CURSOR, GROUP, stopText as stop, type TextDef, TOOL, toolArgId, toolId, toolTexts as tool, v, word } from "./text-def";
import { AGENTS_TEXT, AGENTS_TEXTS } from "./texts/agents";
import { APPROVAL_TEXT, APPROVAL_TEXTS } from "./texts/approval";
import { BOOK_TEXT, BOOK_TEXTS } from "./texts/book";
import { JOBS_TEXT, JOBS_TEXTS } from "./texts/jobs";
import { RECALL_TEXT, RECALL_TEXTS } from "./texts/recall";
import { SIDE_TEXT, SIDE_TEXTS } from "./texts/side";
import { SPEND_TEXT, SPEND_TEXTS } from "./texts/spend";
import { WORKSPACE_TEXT, WORKSPACE_TEXTS } from "./texts/workspace";
import { hasOwn } from "./util";

export { FAMILY, SCRATCH_READ, type TextDef, type TextVar, TOOL } from "./text-def";

/** The text ids, so code names each once. */
export const TEXT = {
  runtime: {
    scratchRead: "runtime.scratch_read",
    cutThinking: "runtime.cut_thinking",
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
    cacheNonce: "runtime.cache_nonce",
    budget: "runtime.budget",
    roundsLeft: "runtime.rounds_left",
    roundsSpent: "runtime.rounds_spent",
    notRun: "runtime.tool_not_run",
    oneEnding: "runtime.one_ending",
    clippedLost: "runtime.clipped_lost",
    scratchLost: "runtime.scratch_lost",
    windowCut: "runtime.window_cut",
    scratchFull: "runtime.scratch_full",
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
    answerRoom: "stop.answer_room",
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
    replyMany: "main.turn.reply_many",
    directed: "main.turn.directed",
    direction: "main.turn.directed.direction",
    noDirection: "main.turn.directed.none",
    turnNewest: "main.turn.newest",
    noNewest: "main.turn.newest.none",
    askReleases: "main.turn.ask.releases",
  },
  request: {
    message: "request.message",
    instruction: "request.instruction",
    fromHistory: "request.from.history",
    fromBlock: "request.from.block",
    fromMarker: "request.from.marker",
    media: "request.media",
    empty: "request.empty",
  },
  writer: {
    brief: "writer.brief",
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
    receiptArgsClipped: "session.receipt.args_clipped",
    receiptNothing: "session.receipt.nothing",
    replyWritten: "session.reply_written",
    answerAsBrief: "session.answer_as_brief",
    unbriefed: "session.unbriefed",
    summarizer: "session.summarizer",
    summarizerInput: "session.summarizer.input",
    summarizerTurn: "session.summarizer.turn",
    none: "session.none",
    failedNothing: "session.summary_failed.nothing",
    failedCut: "session.summary_failed.cut",
  },
  answer: {
    more: "tool.answer.more",
    end: "tool.answer.end",
    found: "tool.answer.found",
    pastGrepNothing: "tool.answer.past_grep_nothing",
    pastWhereReply: "tool.answer.past_where.reply",
    pastWhereLatest: "tool.answer.past_where.latest",
    badCursor: "tool.answer.bad_cursor",
    needs: "tool.answer.needs",
    cut: "tool.answer.cut",
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
    replyBusy: "tool.answer.reply_busy",
    replyFailed: "tool.answer.reply_failed",
    replyNoBrief: "tool.answer.reply_no_brief",
    replyEmpty: "tool.answer.reply_empty",
    replyReleased: "tool.answer.reply_released",
    released: "tool.answer.released",
    releaseWriter: "tool.answer.release_writer",
    releaseHeld: "tool.answer.release_held",
    releaseUnchecked: "tool.answer.release_unchecked",
    releaseEnded: "tool.answer.release_ended",
  },
  progress: {
    session: "progress.session",
    sessionSummary: "progress.session_summary",
    fresh: "progress.fresh",
    dropped: "progress.dropped",
    compacting: "progress.compacting",
    compacted: "progress.compacted",
    notCompacted: "progress.not_compacted",
    compactionHeld: "progress.compaction_held",
    call: "progress.call",
    writing: "progress.writing",
    writingAlone: "progress.writing_alone",
    writingFailed: "progress.writing_failed",
    answerAsBrief: "progress.answer_as_brief",
    recordFailed: "progress.record_failed",
    retry: "progress.retry",
    stopped: "progress.stopped",
    turnStopped: "progress.turn_stopped",
    dueWait: "progress.due_wait",
    nothingReleased: "progress.nothing_released",
    leadMissing: "progress.lead_missing",
    leadOff: "progress.lead_off",
    leadLate: "progress.lead_late",
    leadUnread: "progress.lead_unread",
    claimLate: "progress.claim_late",
    claimUnread: "progress.claim_unread",
    agentsLate: "progress.agents_late",
    agentsUnread: "progress.agents_unread",
  },
  /** A noun as answers and notes count with it: its text holds the word for one and the word for several, with `|` between. */
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
    block: "word.instruction_block",
  },
  /** Agents, skills, guidance and delegation (§12 to §14, §18). */
  agents: AGENTS_TEXT,
  /** The workspace (§11). */
  workspace: WORKSPACE_TEXT,
  /** Jobs (§15). */
  jobs: JOBS_TEXT,
  /** Approval (§17). */
  approval: APPROVAL_TEXT,
  /** Side sessions (§19). */
  side: SIDE_TEXT,
  /** Spend and upkeep (§20). */
  spend: SPEND_TEXT,
  /** A story's book (§23). */
  book: BOOK_TEXT,
  /** Lore and history (§24): what the prompt already holds, the lore and chat tools, the chronicle. */
  recall: RECALL_TEXT,
  /** A tool's description. */
  tool: toolId,
  /** The description of one of a tool's arguments. */
  toolArg: toolArgId,
} as const;

const RUNTIME = GROUP.runtime;
const MAIN = GROUP.main;
const REQUEST = GROUP.request;
const WRITER = GROUP.writer;
const SESSION = GROUP.session;
const ANSWERS = GROUP.answers;
const PROGRESS = GROUP.progress;

const RUNTIME_TEXTS: TextDef[] = [
  { id: TEXT.runtime.cutThinking, group: RUNTIME, label: "An answer that ran out while thinking", note: "Told to an agent whose last answer ran out of room while its model was still thinking, before it wrote anything or called a tool, as the same call is made again with more room.", text: "[Your last answer ran out of room while you were still thinking, so nothing came of it. Think briefly, then act: call a tool or answer.]", vars: [] },
  { id: TEXT.runtime.scratchRead, group: RUNTIME, label: "scratch_read: what it does", note: "The description of the built-in tool that reads the rest of a clipped tool result.", text: "Read more of a tool result that came back clipped. Give the scratch handle the clipped result names and where to start; you get the next part.", vars: [] },
  { id: TEXT.runtime.scratchHandle, group: RUNTIME, label: "scratch_read: handle", note: "The description of scratch_read's handle argument.", text: "The scratch handle the clipped result names, such as s1.", vars: [] },
  { id: TEXT.runtime.scratchOffset, group: RUNTIME, label: "scratch_read: offset", note: "The description of scratch_read's offset argument.", text: "The character to start from; 0 is the start.", vars: [] },
  { id: TEXT.runtime.scratchLength, group: RUNTIME, label: "scratch_read: length", note: "The description of scratch_read's length argument.", text: "How many characters to read, at most {{max}}.", vars: [v("max", "the most one read returns: Tool results clipped past, or the most any of the agent's tools gives whole, where that is more")] },
  {
    id: TEXT.runtime.scratchPart,
    group: RUNTIME,
    label: "scratch_read: its answer",
    note: "What scratch_read returns.",
    text: "[Scratch {{handle}}, characters {{from}} to {{to}} of {{total}}.]\n{{text}}",
    vars: [v("handle", "the scratch handle read", true), v("from", "the first character returned"), v("to", "the character after the last one returned"), v("total", "the whole result's length"), v("text", "the characters read", true)],
  },
  { id: TEXT.runtime.scratchMissing, group: RUNTIME, label: "scratch_read: no such handle", note: "scratch_read's answer to a handle that doesn't exist.", text: "There's no scratch {{handle}}. Scratch holds: {{handles}}. Give one of those as the handle.", vars: [v("handle", "the handle asked for"), v("handles", "the handles there are, or none")] },
  {
    id: TEXT.runtime.clipped,
    group: RUNTIME,
    label: "A clipped tool result",
    note: "Follows the part of a long tool result that reaches the model.",
    text: "[Clipped: the first {{shown}} of {{total}} characters. The rest is in scratch {{handle}}; read it with scratch_read from offset {{shown}}.]",
    vars: [v("shown", "the characters shown"), v("total", "the result's length"), v("handle", "where the whole result waits", true)],
  },
  { id: TEXT.runtime.unknownTool, group: RUNTIME, label: "A tool that doesn't exist", note: "The result of a call to a tool the agent wasn't given.", text: "There's no tool {{name}}. The tools are: {{tools}}. Call one of those.", vars: [v("name", "the name the model called"), v("tools", "the agent's tools")] },
  { id: TEXT.runtime.toolFailed, group: RUNTIME, label: "A tool that failed", note: "The result of a tool call that failed.", text: "{{name}} failed: {{error}}", vars: [v("name", "the tool"), v("error", "why", true)] },
  {
    id: TEXT.runtime.tooManyCalls,
    group: RUNTIME,
    label: "Too many calls in one answer",
    note: "The result of each call past Tool calls per answer.",
    text: "Not run: one answer may call at most {{limit}} {{tools}}. Call {{name}} again in your next answer if you still need it.",
    vars: [v("limit", "Tool calls per answer"), v("tools", '"tool" for 1, else "tools"'), v("name", "the tool not run")],
  },
  {
    id: TEXT.runtime.toolsInText,
    group: RUNTIME,
    label: "Tools offered as text",
    note: "Follows an agent's instructions on a connection that refuses native tools, offering them as text instead.",
    text: 'You can use tools. To call one, write a block like this and stop there:\n<tool_call>{"name": "the tool\'s name", "arguments": {"an argument": "its value"}}</tool_call>\nWrite several blocks to call several tools. The results come back in the next message. Once you have what you need, answer with no tool call.\n\nThe tools:\n{{tools}}',
    vars: [v("tools", "each tool, as Each tool offered as text writes it", true)],
  },
  { id: TEXT.runtime.toolInText, group: RUNTIME, label: "Each tool offered as text", note: "One tool in Tools offered as text.", text: "{{name}}: {{description}}\nArguments (JSON Schema): {{parameters}}", vars: [v("name", "the tool's name", true), v("description", "what it does"), v("parameters", "its arguments' JSON Schema")] },
  { id: TEXT.runtime.toolResults, group: RUNTIME, label: "Tool results sent as text", note: "The message that brings tool calls written as text their results.", text: "Results of your tool calls:\n\n{{results}}", vars: [v("results", "each result, as A tool result as text writes it", true)] },
  { id: TEXT.runtime.toolResult, group: RUNTIME, label: "A tool result as text", note: "One result in Tool results sent as text.", text: '<tool_result name="{{name}}">\n{{result}}\n</tool_result>', vars: [v("name", "the tool"), v("result", "its result", true)] },
  { id: TEXT.runtime.toolError, group: RUNTIME, label: "A failed tool result as text", note: "One failed result in Tool results sent as text.", text: '<tool_result name="{{name}}" error="true">\n{{error}}\n</tool_result>', vars: [v("name", "the tool"), v("error", "why it failed", true)] },
  { id: TEXT.runtime.cacheNonce, group: RUNTIME, label: "Cache key", note: "Heads an agent's prompt while Settings hold a cache key, so the provider's cached prompt no longer matches.", text: "Cache key {{nonce}}; ignore it.", vars: [v("nonce", "the key", true)] },
  { id: TEXT.runtime.budget, group: RUNTIME, label: "Its rounds, told up front", note: "Ends the first message an agent with tools is sent, when its rounds of tool calls are limited: how many it has.", text: "[You have {{rounds}} of tool calls for this. A round is one answer of yours that calls tools, however many. An answer that calls a tool after your last round isn't run and your work stops there, so keep a round for what must come last.]", vars: [v("rounds", 'the rounds it has, with the word: "24 rounds"', true)] },
  { id: TEXT.runtime.roundsLeft, group: RUNTIME, label: "Rounds running out", note: "Follows a round's tool results once an agent has as few rounds left as Rounds left warning says.", text: "[You have {{rounds}} of tool calls left. Finish with what you have.]", vars: [v("rounds", 'the rounds it has left, with the word: "2 rounds"', true)] },
  { id: TEXT.runtime.roundsSpent, group: RUNTIME, label: "Rounds spent", note: "Follows the tool results of an agent's last round.", text: "[That was your last round of tool calls. Answer now with what you have: a tool call in your next answer isn't run, and your work stops without an answer.]", vars: [] },
  { id: TEXT.runtime.notRun, group: RUNTIME, label: "A tool call that never began", note: "The result of a tool call its round's end overtook before it began: the turn was stopped or a time limit passed while the call still waited for its place among the calls at once, or for your word.", text: "Not run: {{reason}}, before this call of {{name}} began. Nothing of it was started.", vars: [v("name", "the tool"), v("reason", "what ended the round, as the agent's stop says it", true)] },
  { id: TEXT.runtime.oneEnding, group: RUNTIME, label: "A second call that would end the work", note: "The result of a call to a tool whose result ends the agent's work (write_reply), where an earlier call of the same answer already does: only that first one is run.", text: "Not run: one answer may make one call that ends your work, and this answer's earlier call of {{first}} is that one. It stands, with what it was given. If its result says it failed, call {{name}} again in your next answer.", vars: [v("name", "the tool whose call wasn't run", true), v("first", "the tool whose earlier call stands")] },
  { id: TEXT.runtime.clippedLost, group: RUNTIME, label: "A clipped tool result whose rest couldn't be kept", note: "Follows the part of a long tool result that reaches the model when the whole couldn't be stored for scratch_read.", text: "[Clipped: the first {{shown}} of {{total}} characters. The rest couldn't be kept ({{error}}), so scratch_read can't give it. Call the tool again and ask for less at a time.]", vars: [v("shown", "the characters shown"), v("total", "the result's length"), v("error", "why the whole couldn't be stored")] },
  { id: TEXT.runtime.scratchLost, group: RUNTIME, label: "scratch_read: the result is no longer stored", note: "scratch_read's answer to a handle whose whole result is gone from storage.", text: "Scratch {{handle}} is no longer stored, so it can't be read. Call the tool that gave it again for what you need.", vars: [v("handle", "the handle asked for")] },
  {
    id: TEXT.runtime.windowCut,
    group: RUNTIME,
    label: "A tool result cut to the room left",
    note: "Follows the part of a tool result that reaches the model when the whole would take the agent's next call past Prompt per call.",
    text: "[Cut to fit: your prompt has room for only the first {{shown}} of {{total}} characters of this result (Prompt per call). The rest is in scratch {{handle}}; scratch_read gives it from offset {{shown}}, as much as your prompt still has room for. Once there is no room left, answer with what you have.]",
    vars: [v("shown", "the characters shown"), v("total", "the result's length"), v("handle", "where the whole result waits", true)],
  },
  { id: TEXT.runtime.scratchFull, group: RUNTIME, label: "scratch_read: no room left", note: "scratch_read's answer when the agent's prompt has no room left for any more of a result (Prompt per call).", text: "Your prompt has no room left for more of scratch {{handle}} (Prompt per call). Answer with what you have.", vars: [v("handle", "the handle asked for", true)] },
];

const STOP_TEXTS: TextDef[] = [
  stop(TEXT.stop.cancelled, "Cancelled", "The agent was cancelled: the turn was stopped, or whoever started it stopped it.", "the agent was cancelled"),
  stop(TEXT.stop.busy, "Still working", "A message sent while the agent still works on its last one.", "the agent is still working on its last message"),
  stop(TEXT.stop.revisions, "Out of revisions", "A message after its first answer, once it has had every revision its budget allows (Revisions).", "it has had the {{revisions}} it may have after its first answer (Revisions)", [v("revisions", 'the revisions it may have, with the word: "2 revisions"', true)]),
  stop(TEXT.stop.wallTime, "Out of time", "The agent's own time ran out (Time per agent).", "the agent's time ran out (Time per agent)"),
  stop(TEXT.stop.turnTime, "The turn out of time", "The turn's time ran out (Time per turn).", "the turn's time ran out (Time per turn)"),
  stop(TEXT.stop.callTime, "A call too slow", "One call took longer than Time per call.", "the call took longer than Time per call"),
  stop(TEXT.stop.callTokensIn, "A prompt too long", "A call whose prompt, as estimated, is past Prompt per call.", "the call's prompt, about {{tokens}}, is past Prompt per call ({{limit}})", [v("tokens", 'the prompt\'s estimate, with the word: "9000 tokens"', true), v("limit", "Prompt per call", true)]),
  stop(TEXT.stop.tokensIn, "The agent's prompt tokens spent", "A call that would take the agent's prompt tokens past Prompt tokens per agent.", "the call would take the agent's prompt tokens past Prompt tokens per agent: counted as {{counted}} of the {{limit}} allowed (a cached re-read counts as {{weight}} of a token)", [v("counted", "the prompt tokens with this call, as the limit counts them"), v("weight", "What a cached re-read counts as"), v("limit", "Prompt tokens per agent", true)]),
  stop(TEXT.stop.tokensOut, "The agent's answer tokens spent", "The agent has written all Answer tokens per agent allows.", "the agent has written its {{tokens}} (Answer tokens per agent)", [v("tokens", 'Answer tokens per agent, with the word: "4000 tokens"', true)]),
  stop(TEXT.stop.turnTokensIn, "The turn's prompt tokens spent", "A call that would take the turn's prompt tokens past Prompt tokens per turn.", "the call would take the turn's prompt tokens past Prompt tokens per turn: counted as {{counted}} of the {{limit}} allowed (a cached re-read counts as {{weight}} of a token)", [v("counted", "the prompt tokens with this call, as the limit counts them"), v("weight", "What a cached re-read counts as"), v("limit", "Prompt tokens per turn", true)]),
  stop(TEXT.stop.turnTokensOut, "The turn's answer tokens spent", "The turn's agents have written all Answer tokens per turn allows.", "the turn's agents have written its {{tokens}} (Answer tokens per turn)", [v("tokens", 'Answer tokens per turn, with the word: "20000 tokens"', true)]),
  stop(TEXT.stop.loop, "The loop detector", "The agent called one tool with the same arguments, and got the same result, as many times in a row as the loop detector allows.", "the agent called {{tool}} with the same arguments {{times}} in a row and got the same result each time (Loop detector)", [v("tool", "the tool's name", true), v("times", 'how many times, with the word: "3 times"', true)]),
  stop(TEXT.stop.toolTurns, "The agent's tool rounds spent", "The agent has had every round of tool calls Tool rounds per agent allows.", "the agent has had its {{rounds}} of tool calls (Tool rounds per agent)", [v("rounds", 'Tool rounds per agent, with the word: "8 rounds"', true)]),
  stop(TEXT.stop.turnToolTurns, "The turn's tool rounds spent", "The turn's agents have had every round of tool calls Tool rounds per turn allows.", "the turn's agents have had its {{rounds}} of tool calls (Tool rounds per turn)", [v("rounds", 'Tool rounds per turn, with the word: "40 rounds"', true)]),
  stop(TEXT.stop.failed, "A call failed", "A call that failed: the provider's error, as it gave it; words of your own may go around it.", "{{error}}", [v("error", "the error, as the provider gave it", true)]),
  stop(TEXT.stop.throttle, "Past a connection's throttle", "A call that needs more tokens than its connection's throttle lets through in a minute.", "the call needs {{tokens}}, more than this connection's throttle lets through in a minute ({{limit}})", [v("tokens", 'the tokens the call needs, with the word: "9000 tokens"', true), v("limit", "the tokens the throttle lets through in a minute", true)]),
  stop(TEXT.stop.connectionUnread, "A connection that couldn't be read", "The runtime couldn't read its connections to find the agent's.", "the connection {{connection}} couldn't be read ({{error}})", [v("connection", "the connection's id; empty for the default connection"), v("error", "why", true)]),
  stop(TEXT.stop.noDefault, "No connection to run on", "An agent with no connection of its own runs on the runtime's default connection, and there is none.", "there is no connection to run this agent on: it has none of its own, and the runtime has no default connection. Add one, or make one the default, on LumiAH's Runtime page under Connections"),
  stop(TEXT.stop.noConnection, "A connection that is gone, and no default", "The agent's connection isn't one of the runtime's any more, and the runtime has no default connection to run it on instead.", "the connection {{connection}} is no longer one of the runtime's, and the runtime has no default connection to run this agent on instead: give it another in LumiAH's Settings, or make one the default on LumiAH's Runtime page under Connections", [v("connection", "the connection's id", true)]),
  stop(TEXT.stop.answerRoom, "Too little room left for an answer", "A call that would have fewer answer tokens than Least answer room, because the agent's or its turn's answer tokens are nearly spent.", "only {{left}} are left of its answer tokens, fewer than Least answer room ({{floor}}): an answer written in them would be cut", [v("left", 'the answer tokens left, with the word: "40 tokens"', true), v("floor", "Least answer room", true)]),
];

const MAIN_TEXTS: TextDef[] = [
  {
    id: TEXT.main.system,
    group: MAIN,
    label: "Instructions",
    note: "The main agent's instructions while a separate writer writes the reply (Who writes the reply: the writer).",
    text: [
      "You are the main agent behind a roleplay chat in Lumiverse. The user never reads you: they read the reply. Each turn a reply is needed. Your work is to find out what that reply needs and hand it to the writer, who writes the prose from the same prompt Lumiverse assembled, plus your brief.",
      "What you are given each turn:\n- The request: every message Lumiverse assembled for this reply, numbered, in order. A message marked as a preset instruction is the preset author's: the reply must achieve it. The rest is context: the character, the persona, the lore Lumiverse activated, and the chat's recent messages, ending with what the user just sent. After its messages come notes on what it holds: which lore entries are in the prompt and how each got there, an index of the entries that aren't (with the ids the lore tools take), which chat messages it holds word for word and what stands in for the rest, and, once the chat has one, the top of its chronicle: what the story has established, each line citing the messages it rests on.\n- Your notes: what you did on your earlier turns in this chat, as a summary of the older ones and a receipt of each turn since. They are yours, not the story's. past_turn reads an earlier turn of yours in full.",
      "How to work:\n- Decide what this reply turns on: who is present, what was promised or left open, what the lore says about what is in play, and what the preset's instructions ask of this reply in particular.\n- Use your tools for what the request and its notes don't show, going from coarse to exact. The chat tools reach every message of the chat, those too old to be in the request among them: chat_outline gives the story's parts, chat_about the trail of a name or a thing, chat_search and chat_grep find, chat_read and chat_around give the words themselves, each message with a citation such as [#412 a3f9c27e]. The lore tools reach every entry of the world books that apply, those Lumiverse didn't activate among them: lore_search, lore_about and lore_related find, lore_read reads entries whole, lore_index lists them all. preset_instructions lists the preset's instruction blocks.\n- One call carries several queries or several ids, and several tools go in one answer when none of them depends on another's result. Don't read again what the request already shows. A result that says it was clipped, or that there is more, names the handle or the cursor to read on with.\n- Stop looking once you have what the reply needs. Most replies need little.",
      "You may also hold tools beyond the chat and its lore: the workspace (the workspace_ tools: files you keep for yourself from turn to turn; those pinned for you lead each turn's message), skills (skill_load), other agents to hand a task to (delegate) and jobs that go on after the reply (job_start). Each one's description says when it is worth using. None of them is needed for most replies.",
      "The chronicle is kept by a job, not by you, and never at the reply's cost. The line that ends the pinned chronicle says where it stands. Have it brought up to date only when that line says the chat is further past the chronicle than the user's setting allows, or when this turn changed something the chronicle states; then call job_start in the same answer as write_reply, with the agent and the task that line gives, never in a round of its own. No skill needs loading for it.",
      "Then call write_reply with your brief. The writer already has the whole prompt, so give it only what it would miss or get wrong without you: facts to keep straight (names, places, who knows what, what happened before), lore that bears on this moment, the thread to pick up, an instruction the last replies drifted from. Where write_reply offers add and drop, a lore entry the writer needs whole goes by its id in add, and one in the prompt that would mislead this reply in drop: the entry's own text is put into, or taken out of, what the writer is sent, so don't retype lore in the brief. The writer is sent the prompt as Lumiverse assembled it and nothing of yours but the brief: where guidance you were given bears on the prose, the brief has to carry it. Be specific, quote exact wording where it matters, and keep it short. Don't write the reply's prose, and don't restate the preset. When the prompt already holds everything, say so in one line. write_reply ends your turn: always end with it. An answer without it is handed to the writer as your brief, whatever it says, so never end on a plan or a remark.",
    ].join("\n\n"),
    vars: [],
  },
  {
    id: TEXT.main.systemWrites,
    group: MAIN,
    label: "Instructions, when it writes the reply itself",
    note: "The main agent's instructions while it writes the reply itself (Who writes the reply: the main agent).",
    text: [
      "You are the main agent behind a roleplay chat in Lumiverse. Each turn a reply is needed, and you write it. The user reads only your final answer.",
      "What you are given each turn:\n- The request: every message Lumiverse assembled for this reply, numbered, in order. A message marked as a preset instruction is the preset author's: the reply must achieve it. The rest is context: the character, the persona, the lore Lumiverse activated, and the chat's recent messages, ending with what the user just sent. After its messages come notes on what it holds: which lore entries are in the prompt and how each got there, an index of the entries that aren't (with the ids the lore tools take), which chat messages it holds word for word and what stands in for the rest, and, once the chat has one, the top of its chronicle: what the story has established, each line citing the messages it rests on.\n- Your notes: what you did on your earlier turns in this chat, as a summary of the older ones and a receipt of each turn since. They are yours, not the story's. past_turn reads an earlier turn of yours in full.",
      "How to work:\n- Decide what this reply turns on: who is present, what was promised or left open, what the lore says about what is in play, and what the preset's instructions ask of this reply in particular.\n- Use your tools for what the request and its notes don't show, going from coarse to exact. The chat tools reach every message of the chat, those too old to be in the request among them: chat_outline gives the story's parts, chat_about the trail of a name or a thing, chat_search and chat_grep find, chat_read and chat_around give the words themselves, each message with a citation such as [#412 a3f9c27e]. The lore tools reach every entry of the world books that apply, those Lumiverse didn't activate among them: lore_search, lore_about and lore_related find, lore_read reads entries whole, lore_index lists them all. preset_instructions lists the preset's instruction blocks.\n- One call carries several queries or several ids, and several tools go in one answer when none of them depends on another's result. Don't read again what the request already shows. A result that says it was clipped, or that there is more, names the handle or the cursor to read on with.\n- Stop looking once you have what the reply needs. Most replies need little.",
      "You may also hold tools beyond the chat and its lore: the workspace (the workspace_ tools: files you keep for yourself from turn to turn; those pinned for you lead each turn's message), skills (skill_load), other agents to hand a task to (delegate) and jobs that go on after the reply (job_start). Each one's description says when it is worth using. None of them is needed for most replies.",
      "The chronicle is kept by a job, not by you, and never at the reply's cost. The line that ends the pinned chronicle says where it stands. Have it brought up to date only when that line says the chat is further past the chronicle than the user's setting allows, or when this turn changed something the chronicle states; then call job_start among the tool calls of a round this reply needs anyway, with the agent and the task that line gives, never in a round of its own: a turn that needs no tool call leaves it to a later one. No skill needs loading for it.",
      "Then answer with the reply itself. Your final answer, the one with no tool call, goes to the user exactly as you write it: no notes, no preamble, nothing about your tools or your work. It must achieve every preset instruction in the request, in the form they ask for.",
    ].join("\n\n"),
    vars: [],
  },
  {
    id: TEXT.main.turn,
    group: MAIN,
    label: "A turn's message",
    note: "What the main agent is sent each turn: why a reply is needed, anything that changed about its notes, the request, and what to do.",
    text: "{{kind}}\n\n{{notes}}The request, as Lumiverse assembled it for this reply ({{count}}, in order):\n\n{{request}}\n\n{{ask}}",
    vars: [v("kind", "why a reply is needed, in the words below", true), v("notes", "what changed about its notes since its last turn, and how the user directs the story where only the model's replies are its story, each ending in a blank line; nothing when there is none of it. Required: a summary of its notes reaches the agent only here when no later turn follows it", true), v("count", 'how many messages the request has, with the word: "42 messages"'), v("request", "the request's messages, each framed as below", true), v("ask", "what to do with it, in the words below", true)],
  },
  { id: TEXT.main.kindNew, group: MAIN, label: "Why: a new reply", note: "Fills {{kind}} for a new reply.", text: "The user sent a message: a reply is needed.", vars: [] },
  { id: TEXT.main.kindRegenerate, group: MAIN, label: "Why: a regenerate", note: "Fills {{kind}} when the user regenerated the reply.", text: "The user asked for this reply again (a regenerate): the last one is gone, and a new reply is needed in its place.", vars: [] },
  { id: TEXT.main.kindSwipe, group: MAIN, label: "Why: a swipe", note: "Fills {{kind}} when the user swiped for another reply.", text: "The user asked for another version of this reply (a swipe): the earlier versions stay beside it, and a different reply is needed.", vars: [] },
  { id: TEXT.main.kindContinue, group: MAIN, label: "Why: a continue", note: "Fills {{kind}} when the user continued the last reply.", text: "The user asked to continue the last reply: the request ends with it, and the new text carries on from where it stops.", vars: [] },
  { id: TEXT.main.ask, group: MAIN, label: "What to do: brief the writer", note: "Fills {{ask}} while a separate writer writes the reply.", text: "Work out what this reply needs, then call write_reply with your brief.", vars: [] },
  { id: TEXT.main.askWrites, group: MAIN, label: "What to do: write the reply", note: "Fills {{ask}} while the main agent writes the reply itself.", text: "Work out what this reply needs, then answer with the reply itself.", vars: [] },
  { id: TEXT.main.noteDropped, group: MAIN, label: "Notes dropped", note: "Leads a turn's message when an earlier message of the chat was edited or deleted, so the notes of the turns after it no longer fit the chat.", text: "An earlier message of this chat was changed or removed, so your notes from {{replies}} no longer fit it and were dropped: you don't have them, and what they said may no longer be true.", vars: [v("replies", 'the replies whose notes were dropped: "reply #12" or "replies #12, #14"', true)] },
  { id: TEXT.main.noteRolledBack, group: MAIN, label: "A summary rolled back", note: "Leads the message of the first turn after the user rolled back a summary of its notes: the turns it summarized are read again. The turns after it aren't told again.", text: "The user rolled back a summary of your notes: the turns it had replaced are back as their own receipts.", vars: [] },
  { id: TEXT.main.noteMissing, group: MAIN, label: "Notes missing", note: "Leads a turn's message when some stored notes couldn't be read.", text: "{{count}} of your stored notes couldn't be read and are left out.", vars: [v("count", 'how many, with the word: "2 parts"', true)] },
  { id: TEXT.main.noteSummary, group: MAIN, label: "Notes summarized, nothing after", note: "Leads a turn's message with the summary of the main agent's notes when no turn's receipt follows it.", text: "{{summary}}", vars: [v("summary", "the summary, framed as The summary frames it", true)] },
  { id: TEXT.main.noteContinued, group: MAIN, label: "The turn continued", note: "Leads a turn's message when it continues a reply the main agent already worked on: what it did then.", text: "You already worked on this reply before it was continued. What you did then:\n{{receipt}}", vars: [v("receipt", "the receipt of that work", true)] },
  { id: TEXT.main.replyOne, group: MAIN, label: "Notes dropped: one reply", note: "Fills {{replies}} in Notes dropped, and in its progress line, when one reply's notes were dropped.", text: "reply {{list}}", vars: [v("list", 'the reply\'s number: "#12"', true)] },
  { id: TEXT.main.replyMany, group: MAIN, label: "Notes dropped: several replies", note: "Fills {{replies}} in Notes dropped, and in its progress line, when several replies' notes were dropped.", text: "replies {{list}}", vars: [v("list", 'the replies\' numbers: "#12, #14"', true)] },
  {
    id: TEXT.main.directed,
    group: MAIN,
    label: "The user directs the story",
    note: "A note of a turn's message where only the model's replies are the story (What counts as the story): the user's messages are directions from outside it.",
    text: "The user directs this story from outside it. Their messages are directions to you, not events of the story and not their character's words, and the directions they gave before this one are not part of its record: the chat tools leave the user's messages out.{{direction}}",
    vars: [v("direction", "the direction for this reply, or that there is none, in the words below; nothing where the user's newest message is left out too")],
  },
  { id: TEXT.main.direction, group: MAIN, label: "The direction for this reply", note: "Fills {{direction}} with the user's newest message, read from the chat, where it is given to the main agent (Your newest message: give it as the direction).", text: "\n\nThe direction for this reply:\n{{text}}", vars: [v("text", "the user's newest message", true)] },
  { id: TEXT.main.noDirection, group: MAIN, label: "No direction for this reply", note: "Fills {{direction}} where the chat ends with a reply, or with a message the user hid, so the user gave no direction for this one.", text: "\n\nThe user gave no direction for this reply: carry the story on from where it stands.", vars: [] },
  {
    id: TEXT.main.turnNewest,
    group: MAIN,
    label: "A turn's message, with only the newest message",
    note: "What the main agent is sent each turn in a chat whose extension shows it only the user's newest message, not the whole request Lumiverse assembled.",
    text: "{{kind}}\n\n{{notes}}The user's newest message:\n\n{{message}}\n\n{{ask}}",
    vars: [v("kind", "why a reply is needed, in the words above", true), v("notes", "what changed about its notes since its last turn, each ending in a blank line; nothing when there is none of it. Required: a summary of its notes reaches the agent only here when no later turn follows it", true), v("message", "the user's newest message, framed as a message of the request is, or that there is none", true), v("ask", "what to do, in the words above", true)],
  },
  { id: TEXT.main.noNewest, group: MAIN, label: "No newest message", note: "Fills {{message}} where the request holds no message from the user.", text: "The request holds no message from the user: carry the story on from where it stands.", vars: [] },
  { id: TEXT.main.askReleases, group: MAIN, label: "What to do: release the reply", note: "Fills {{ask}} in a chat whose reply is only what its agents release: no writer writes it.", text: "Work out what this reply needs, then release it with reply_write, a passage at a time, or hand it to an agent with delegate and to_reply. Nothing else reaches the user.", vars: [] },
];

const REQUEST_TEXTS: TextDef[] = [
  { id: TEXT.request.message, group: REQUEST, label: "A message", note: "One message of the request that isn't a preset instruction.", text: "[{{n}}] {{role}}{{from}}\n{{text}}", vars: [v("n", "its number in the request, from 1", true), v("role", "whose it is: system, user or assistant"), v("from", "where it came from, in the words below; nothing when that isn't known"), v("text", "its text", true)] },
  { id: TEXT.request.instruction, group: REQUEST, label: "A preset instruction", note: "One message of the request that is an instruction block of the preset: what the reply must achieve.", text: "[{{n}}] {{role}} · preset instruction “{{name}}”: the reply must achieve this\n{{text}}", vars: [v("n", "its number in the request, from 1", true), v("role", "whose it is: system, user or assistant"), v("name", "the block's name in the preset"), v("text", "its text", true)] },
  { id: TEXT.request.fromHistory, group: REQUEST, label: "From the chat", note: "Fills {{from}} for a message of the chat's history.", text: " · chat message #{{index}}{{name}}", vars: [v("index", "the message's number in the chat, as the chat tools take it", true), v("name", "who wrote it, after a comma; nothing when that isn't known")] },
  { id: TEXT.request.fromBlock, group: REQUEST, label: "From a preset block", note: "Fills {{from}} for a message from a preset block that the preset, as it reads now, no longer has.", text: " · preset block {{name}}", vars: [v("name", "the block's id", true)] },
  { id: TEXT.request.fromMarker, group: REQUEST, label: "From a marker", note: "Fills {{from}} for something Lumiverse put where a preset's marker stands: the character's description, World Info.", text: " · {{marker}}, placed by “{{name}}”", vars: [v("marker", "what Lumiverse put there, by the marker's own name", true), v("name", "the block's name in the preset")] },
  { id: TEXT.request.media, group: REQUEST, label: "Attached media", note: "Stands in a message's text for an image, audio or video it carries: the main agent is sent text only.", text: "[{{media}} attached]", vars: [v("media", "image, audio or video", true)] },
  { id: TEXT.request.empty, group: REQUEST, label: "An empty request", note: "The request when Lumiverse sent no messages.", text: "(the request holds no messages)", vars: [] },
];

const WRITER_TEXTS: TextDef[] = [
  {
    id: TEXT.writer.brief,
    group: WRITER,
    label: "The brief",
    note: "The writer's instructions: how the main agent's brief is put to it, as one message among those Lumiverse assembled (where it goes, and as whose, are settings). Everything else the writer is sent is your preset's.",
    text: "[Notes for this reply, from a planner that has read the whole chat and its lore. Follow them where they bear on what you write; never mention them, and never quote them.]\n{{brief}}",
    vars: [v("brief", "the main agent's brief", true)],
  },
];

const SESSION_TEXTS: TextDef[] = [
  { id: TEXT.session.summary, group: SESSION, label: "The summary", note: "Opens what the main agent carries once its notes were summarized: the summary stands for the turns it replaced.", text: "Your notes from this chat's earlier turns, summarized:\n{{summary}}", vars: [v("summary", "the summary", true)] },
  { id: TEXT.session.told, group: SESSION, label: "An earlier turn: what it was for", note: "How the main agent's notes say what an earlier turn of its was for. The request itself isn't kept: Lumiverse sends the chat with every request.", text: "Reply #{{reply}} ({{kind}}): a request of {{count}}, ending at chat message #{{last}}.", vars: [v("reply", "the reply's number in the chat", true), v("kind", "new, regenerate, swipe or continue"), v("count", 'how many messages the request had, with the word: "42 messages"'), v("last", "the last chat message the request held")] },
  { id: TEXT.session.toldUnplaced, group: SESSION, label: "An earlier turn, its request's end unknown", note: "As above, when no message of the request could be traced to the chat.", text: "Reply #{{reply}} ({{kind}}): a request of {{count}}.", vars: [v("reply", "the reply's number in the chat", true), v("kind", "new, regenerate, swipe or continue"), v("count", 'how many messages the request had, with the word: "42 messages"')] },
  { id: TEXT.session.receipt, group: SESSION, label: "A receipt", note: "What the main agent carries of an earlier turn of its own: each thing it did, one line or two each. past_turn reads the turn in full.", text: "What you did:\n{{steps}}", vars: [v("steps", "each step, as below", true)] },
  { id: TEXT.session.receiptCall, group: SESSION, label: "A receipt: a tool call", note: "One tool call in a receipt, with the start of its result.", text: "- {{tool}} {{args}}\n  → {{result}}", vars: [v("tool", "the tool", true), v("args", "its arguments, as JSON"), v("result", "the start of its result")] },
  { id: TEXT.session.receiptFailed, group: SESSION, label: "A receipt: a failed tool call", note: "One tool call that failed, in a receipt.", text: "- {{tool}} {{args}}\n  → failed: {{result}}", vars: [v("tool", "the tool", true), v("args", "its arguments, as JSON"), v("result", "the start of why it failed")] },
  { id: TEXT.session.receiptSaid, group: SESSION, label: "A receipt: something it wrote", note: "Something the main agent wrote beside its tool calls, in a receipt.", text: "- you noted: {{text}}", vars: [v("text", "the start of what it wrote", true)] },
  { id: TEXT.session.receiptReply, group: SESSION, label: "A receipt: it wrote the reply", note: "In a receipt, a turn whose reply the main agent wrote itself. The reply isn't kept: it is in the chat.", text: "- you wrote the reply yourself ({{chars}} characters; it is chat message #{{reply}})", vars: [v("chars", "the reply's length"), v("reply", "the reply's number in the chat")] },
  { id: TEXT.session.receiptStop, group: SESSION, label: "A receipt: it stopped short", note: "In a receipt, a turn the main agent didn't finish.", text: "- you stopped before you were done: {{reason}}", vars: [v("reason", "why", true)] },
  { id: TEXT.session.receiptClipped, group: SESSION, label: "A receipt: a clipped text", note: "Ends a text a receipt keeps only the start of (Receipt length).", text: "{{text}}… ({{chars}} characters in all; past_turn with reply {{reply}} reads it whole)", vars: [v("text", "the start of the text", true), v("chars", "its whole length"), v("reply", "the reply's number in the chat")] },
  { id: TEXT.session.receiptArgsClipped, group: SESSION, label: "A receipt: clipped arguments", note: "Ends a tool call's arguments a receipt keeps only the start of (Receipt length: arguments), as JSON cut where the length ran out: a file the call wrote, a long brief.", text: "{{text}}… (arguments of {{chars}} characters in all; past_turn with reply {{reply}} and step {{step}} reads them whole)", vars: [v("text", "the start of the arguments, as JSON", true), v("chars", "their whole length"), v("reply", "the reply's number in the chat"), v("step", "the step's number in the turn, as past_turn lists it")] },
  { id: TEXT.session.receiptNothing, group: SESSION, label: "A receipt: nothing done", note: "A receipt of a turn in which the main agent did nothing on record.", text: "- nothing on record", vars: [] },
  { id: TEXT.session.replyWritten, group: SESSION, label: "write_reply's result, as kept", note: "What the main agent's notes keep in place of write_reply's result. The reply isn't kept: it is in the chat.", text: "the writer wrote the reply ({{chars}} characters; it is chat message #{{reply}})", vars: [v("chars", "the reply's length"), v("reply", "the reply's number in the chat")] },
  { id: TEXT.session.answerAsBrief, group: SESSION, label: "An answer taken as the brief, as kept", note: "What the main agent's notes say of a turn it ended without calling write_reply: its answer is kept as what it wrote, and this follows it.", text: "you ended without calling write_reply, so that answer was handed to the writer as your brief, and the writer wrote the reply ({{chars}} characters; it is chat message #{{reply}})", vars: [v("chars", "the reply's length"), v("reply", "the reply's number in the chat")] },
  { id: TEXT.session.unbriefed, group: SESSION, label: "A turn that failed before its brief, as kept", note: "What the main agent's notes say of a turn where something of LumiAH's failed before the agent gave a brief, and the writer was started on the reply all the same.", text: "LumiAH failed before you gave a brief ({{reason}}), so the writer was started on the reply from the request alone", vars: [v("reason", "what failed", true)] },
  {
    id: TEXT.session.summarizer,
    group: SESSION,
    label: "Summarizer: instructions",
    note: "The instructions of the call that summarizes the main agent's notes once they pass Summarize past.",
    text: "You keep a main agent's notes short. The agent works behind a roleplay chat: each turn it looks things up and briefs a writer. You get the summary of its notes so far, if there is one, and the receipts of the turns that now fold into it. Write one summary the agent can keep working from: what the story's people, places and open threads are as its notes have them, what it looked up and found, what it told the writer to keep straight, and anything it noted for itself. Keep names, numbers and exact wording that matter as they are, and leave out what no later turn needs. The latest {{keep}} stay whole after your summary, so don't repeat them. Keep the summary under {{limit}} tokens, and finish it: a summary cut off is thrown away. Answer with the summary alone.",
    vars: [v("keep", 'how many of the latest turns stay whole, with the word: "3 turns"'), v("limit", "how long the summary may be, in tokens (Summary length)")],
  },
  { id: TEXT.session.summarizerInput, group: SESSION, label: "Summarizer: what it summarizes", note: "The summarizing call's message: the summary so far and the turns to fold into it.", text: "The summary so far:\n{{summary}}\n\nThe turns to fold into it, oldest first:\n\n{{turns}}", vars: [v("summary", "the summary so far, or the text for nothing"), v("turns", "the turns to summarize, each framed as below", true)] },
  { id: TEXT.session.summarizerTurn, group: SESSION, label: "Summarizer: one turn", note: "One turn in what the summarizer is sent.", text: "{{told}}\n{{receipt}}", vars: [v("told", "what the turn was for", true), v("receipt", "its receipt", true)] },
  { id: TEXT.session.none, group: SESSION, label: "Nothing", note: "Stands in for a part that is empty.", text: "(none)", vars: [] },
  { id: TEXT.session.failedNothing, group: SESSION, label: "No summary: nothing answered", note: "Why the main agent's notes weren't summarized, when the summarizing call answered nothing.", text: "the summarizing call answered nothing", vars: [] },
  { id: TEXT.session.failedCut, group: SESSION, label: "No summary: cut off", note: "Why the notes weren't summarized, when the summary stopped at its limit.", text: "its summary was cut off at its limit (the summarizer's Answer per call)", vars: [] },
];

const TOOL_TEXTS: TextDef[] = [
  ...tool(TOOL.presetInstructions, "List the active preset's instruction blocks in order, those switched off marked: what the preset's author tells the model, as written in the preset, before Lumiverse fills in its macros. Give block to read one whole.", { block: "A block's id or name, to read that block whole.", cursor: CURSOR }),
  ...tool(TOOL.pastTurn, "Read or search an earlier turn of yours in full: every tool call you made with what came back, and your brief, where your notes keep only a receipt. Without arguments it lists your turns. Give reply to list that turn's steps; add step to read one whole; give grep to find the lines that hold some text, in that turn or, without reply, in your latest turns.", { reply: "The reply's number in the chat, as your receipts name it (reply #12).", step: "Which of the turn's steps to read whole, by its number in the turn's list.", grep: "Text to find, in any letter case: every line that holds it, with its reply, step and line.", cursor: CURSOR }),
  ...tool(TOOL.writeReply, "Hand the writer your brief and have it write the reply, which goes to the user. This ends your turn: call it once, when you have what the reply needs, and call nothing else beside it.", { brief: "What the writer needs that the prompt doesn't already give it: facts to keep straight, lore that bears on this moment, the thread to pick up. Short and specific; no prose for the reply itself." }),
  ...tool(TOOL.replyWrite, "Release a passage of the reply: it streams to the user at once, after what was released before. Call it again for the next passage; the reply is everything released, in order. Released text can't be taken back. Your turn ends when you answer.", { text: "The passage, exactly as the user should read it." }),
];

const ANSWER_TEXTS: TextDef[] = [
  { id: TEXT.answer.more, group: ANSWERS, label: "There is more", note: "Ends a tool's answer that has more to give.", text: '[There is more: call {{tool}} again with the same arguments and cursor "{{cursor}}".]', vars: [v("tool", "the tool"), v("cursor", "where the next page starts", true)] },
  { id: TEXT.answer.end, group: ANSWERS, label: "That is all", note: "Ends the last page of an answer that came in pages.", text: "[That is the end.]", vars: [] },
  { id: TEXT.answer.found, group: ANSWERS, label: "What a search found", note: "Heads a search's or a listing's answer: how many it found and which of them this page shows.", text: "{{total}} found; showing {{from}} to {{to}}.", vars: [v("total", 'how many it found, with the word: "37 messages"', true), v("from", "the first shown, counted from 1"), v("to", "the last shown")] },
  { id: TEXT.answer.pastGrepNothing, group: ANSWERS, label: "past_turn: grep found nothing", note: "past_turn's answer when no line of the turns it read holds the text.", text: "No line of {{where}} holds “{{query}}”. Try a shorter piece of it, or give reply to search one turn.", vars: [v("where", "the turns it read, in the words below"), v("query", "what was looked for", true)] },
  { id: TEXT.answer.pastWhereReply, group: ANSWERS, label: "past_turn: where it looked, one turn", note: "Fills {{where}} when the grep read one turn.", text: "reply #{{reply}}", vars: [v("reply", "the reply's number", true)] },
  { id: TEXT.answer.pastWhereLatest, group: ANSWERS, label: "past_turn: where it looked, the latest turns", note: "Fills {{where}} when the grep read the latest turns.", text: "your latest {{turns}}", vars: [v("turns", 'how many turns it read, with the word: "8 turns"', true)] },
  { id: TEXT.answer.badCursor, group: ANSWERS, label: "A cursor that isn't one", note: "The answer to a cursor the tool never gave.", text: "“{{cursor}}” isn't a cursor {{tool}} gave. Pass the cursor exactly as the last answer wrote it, or leave it out to start at the beginning.", vars: [v("cursor", "the cursor given", true), v("tool", "the tool")] },
  { id: TEXT.answer.needs, group: ANSWERS, label: "A missing argument", note: "The answer to a call that lacks an argument the tool can't do without.", text: "{{tool}} needs {{arg}}: {{what}} Call it again with {{arg}}.", vars: [v("tool", "the tool"), v("arg", "the argument's name", true), v("what", "what the argument is, from its description")] },
  { id: TEXT.answer.cut, group: ANSWERS, label: "An item cut to fit", note: "Ends an item too long for one page of a listing.", text: "{{text}}… (cut to fit)", vars: [v("text", "the start of the item", true)] },
  { id: TEXT.answer.presetBlock, group: ANSWERS, label: "preset_instructions: a block", note: "One instruction block in preset_instructions' answer.", text: "- [{{id}}] “{{name}}” ({{role}}{{flags}}, {{chars}} characters): {{excerpt}}", vars: [v("id", "the block's id", true), v("name", "its name in the preset"), v("role", "whose message it becomes"), v("flags", "that it is switched off, in the words below; nothing when it is on"), v("chars", "its length"), v("excerpt", "the start of its text")] },
  { id: TEXT.answer.presetRead, group: ANSWERS, label: "preset_instructions: a block read", note: "preset_instructions' answer for one block: its text, or the part a page holds.", text: "Preset instruction “{{name}}” [{{id}}] ({{role}}{{flags}}), characters {{from}} to {{to}} of {{chars}}:\n{{text}}", vars: [v("name", "the block's name", true), v("id", "its id"), v("role", "whose message it becomes"), v("flags", "that it is switched off; nothing when it is on"), v("from", "the first character shown"), v("to", "the character after the last shown"), v("chars", "the block's length"), v("text", "the text", true)] },
  { id: TEXT.answer.presetNoBlock, group: ANSWERS, label: "preset_instructions: no such block", note: "preset_instructions' answer to a block the preset doesn't have among its instructions.", text: "The preset has no instruction block “{{block}}”. Its instruction blocks are: {{blocks}}. Give one of those, or leave block out to list them.", vars: [v("block", "the block asked for", true), v("blocks", "the instruction blocks, by name and id")] },
  { id: TEXT.answer.presetNone, group: ANSWERS, label: "preset_instructions: none", note: "preset_instructions' answer when the preset has no instruction block, or the chat has no preset.", text: "This reply's preset has no instruction blocks to list. The instructions that reached the request are marked in it.", vars: [] },
  { id: TEXT.answer.presetOff, group: ANSWERS, label: "A block switched off", note: "Marks a block that is switched off in the preset, in preset_instructions' answers.", text: ", switched off", vars: [] },
  { id: TEXT.answer.pastTurns, group: ANSWERS, label: "past_turn: your turns", note: "Leads past_turn's answer without arguments: the turns it can read, one line each after it.", text: "Your earlier turns in this chat, oldest first. Give reply to list one turn's steps.", vars: [] },
  { id: TEXT.answer.pastTurnLine, group: ANSWERS, label: "past_turn: one turn", note: "One turn in past_turn's list of turns.", text: "- {{told}} You took {{count}}.", vars: [v("told", "what the turn was for", true), v("count", 'how many steps it took, with the word: "5 steps"')] },
  { id: TEXT.answer.pastTurn, group: ANSWERS, label: "past_turn: a turn's steps", note: "Leads past_turn's answer for a reply: what the turn was for; its steps follow, one line each.", text: "{{told}}\nIts steps, in full as they were; read one whole with step:", vars: [v("told", "what the turn was for", true)] },
  { id: TEXT.answer.pastStep, group: ANSWERS, label: "past_turn: one step", note: "One step in past_turn's list.", text: "{{n}}. {{what}} ({{chars}} characters): {{first}}", vars: [v("n", "its number in the turn", true), v("what", "what the step is: a tool call with its arguments, a note, the reply, a stop"), v("chars", "how long its text is"), v("first", "the start of its text")] },
  { id: TEXT.answer.pastRead, group: ANSWERS, label: "past_turn: a step read", note: "past_turn's answer for one step: its text, or the part a page holds.", text: "Reply #{{reply}}, step {{n}}: {{what}}, characters {{from}} to {{to}} of {{chars}}:\n{{text}}", vars: [v("reply", "the reply's number", true), v("n", "the step's number"), v("what", "what the step is"), v("from", "the first character shown"), v("to", "the character after the last shown"), v("chars", "how long its text is"), v("text", "the text", true)] },
  { id: TEXT.answer.pastLine, group: ANSWERS, label: "past_turn: a line found", note: "One line past_turn's grep found.", text: "- reply #{{reply}}, step {{n}}, line {{line}}: {{text}}", vars: [v("reply", "the reply's number", true), v("n", "the step's number"), v("line", "the line's number in the step"), v("text", "the line, around what was found", true)] },
  { id: TEXT.answer.pastNone, group: ANSWERS, label: "past_turn: no turns", note: "past_turn's answer when the main agent has no earlier turn in the chat.", text: "You have no earlier turn in this chat: this is your first, or your notes from before were dropped. Work from the request and your other tools.", vars: [] },
  { id: TEXT.answer.pastNoTurn, group: ANSWERS, label: "past_turn: no such turn", note: "past_turn's answer for a reply that is no turn of the main agent's.", text: "Reply #{{reply}} is no turn of yours on this chat. Your turns are replies {{replies}}. Give one of those.", vars: [v("reply", "the reply asked for", true), v("replies", "the replies that are")] },
  { id: TEXT.answer.pastNoStep, group: ANSWERS, label: "past_turn: no such step", note: "past_turn's answer for a step number the turn doesn't have.", text: "Reply #{{reply}} has {{count}}: give step 1 to {{last}}.", vars: [v("reply", "the reply's number", true), v("count", 'how many steps it has, with the word: "5 steps"'), v("last", "its last step's number")] },
  { id: TEXT.answer.pastSaid, group: ANSWERS, label: "past_turn: a note", note: "Names a step that is something the main agent wrote beside its tool calls.", text: "a note of yours", vars: [] },
  { id: TEXT.answer.pastCall, group: ANSWERS, label: "past_turn: a tool call", note: "Names a step that is a tool call: its text is what came back.", text: "{{tool}} {{args}}", vars: [v("tool", "the tool", true), v("args", "its arguments, as JSON")] },
  { id: TEXT.answer.pastFailed, group: ANSWERS, label: "past_turn: a failed tool call", note: "Names a step that is a tool call that failed.", text: "{{tool}} {{args}}, which failed", vars: [v("tool", "the tool", true), v("args", "its arguments, as JSON")] },
  { id: TEXT.answer.pastReply, group: ANSWERS, label: "past_turn: the reply", note: "Names the step in which the main agent wrote the reply itself. The reply isn't kept: it is in the chat.", text: "the reply, which you wrote yourself (not kept here: it is chat message #{{reply}}, {{chars}} characters)", vars: [v("reply", "the reply's number in the chat"), v("chars", "the reply's length")] },
  { id: TEXT.answer.pastStop, group: ANSWERS, label: "past_turn: a stop", note: "Names the step at which the main agent stopped short.", text: "where you stopped short", vars: [] },
  { id: TEXT.answer.replyBusy, group: ANSWERS, label: "write_reply: already writing", note: "write_reply's answer to a second call while the writer is at work on the first.", text: "The writer is already writing this reply from your other write_reply call. Call write_reply once.", vars: [] },
  { id: TEXT.answer.replyFailed, group: ANSWERS, label: "write_reply: the writer failed", note: "write_reply's answer when the writer's call failed before any of the reply was sent.", text: "The writer couldn't write the reply: {{reason}}. Nothing was sent to the user. Call write_reply again to try once more.", vars: [v("reason", "why", true)] },
  { id: TEXT.answer.replyNoBrief, group: ANSWERS, label: "write_reply: no brief", note: "write_reply's answer to a call without a brief.", text: "write_reply needs brief: what the writer needs that the prompt doesn't already give it. When the prompt holds everything, say that in a line. Call write_reply again with brief.", vars: [] },
  { id: TEXT.answer.replyEmpty, group: ANSWERS, label: "write_reply: an empty reply", note: "Fills {{reason}} in The writer failed, and the turn's error, when the writer's model answered with nothing.", text: "its model answered with nothing", vars: [] },
  { id: TEXT.answer.replyReleased, group: ANSWERS, label: "write_reply: the reply was released already", note: "write_reply's answer once part of the reply was released with reply_write: no writer writes after it.", text: "Not handed to the writer: you released part of this reply with reply_write, so the reply is yours to finish. Go on with reply_write, or end your turn.", vars: [] },
  { id: TEXT.answer.released, group: ANSWERS, label: "reply_write: released", note: "reply_write's answer once its passage reached the user.", text: "Released: {{chars}} characters reached the user. The reply holds {{total}} characters now. Release the next passage, or end your turn.", vars: [v("chars", "the passage's length", true), v("total", "the reply's length so far")] },
  { id: TEXT.answer.releaseWriter, group: ANSWERS, label: "reply_write: the writer has the reply", note: "The answer of reply_write, and of delegate with to_reply, once the writer is writing the reply or has written it.", text: "Not released: the writer is writing this reply, or has written it, so nothing more can go into it.", vars: [] },
  { id: TEXT.answer.releaseHeld, group: ANSWERS, label: "reply_write: another agent's answer is streaming", note: "The answer of reply_write, and of delegate with to_reply, while a sub-agent's answer streams into the reply.", text: "Not released: another agent's answer is streaming into the reply now. Wait for that call to end, then release yours.", vars: [] },
  { id: TEXT.answer.releaseUnchecked, group: ANSWERS, label: "reply_write: the extension didn't say", note: "reply_write's answer when the extension that checks each passage gave no word on it in time, or gave one that isn't a word: nothing goes out unchecked.", text: "Not released: the check on each passage didn't answer, so nothing was sent. Try again.", vars: [] },
  { id: TEXT.answer.releaseEnded, group: ANSWERS, label: "reply_write: the reply has ended", note: "The answer of reply_write, and of delegate with to_reply, once the turn's reply has ended or the turn was stopped.", text: "Not released: this reply has ended.", vars: [] },
];

const PROGRESS_TEXTS: TextDef[] = [
  { id: TEXT.progress.session, group: PROGRESS, label: "Notes carried", note: "The first line a turn writes into the reply's thinking block: what the main agent carries from earlier turns.", text: "LumiAH: the main agent carries its notes from {{turns}}.", vars: [v("turns", 'how many earlier turns, with the word: "4 earlier turns"', true)] },
  { id: TEXT.progress.sessionSummary, group: PROGRESS, label: "Notes carried, after a summary", note: "The first line of a turn whose main agent carries a summary of its older turns.", text: "LumiAH: the main agent carries its notes from {{turns}}, after a summary of the ones before.", vars: [v("turns", 'how many earlier turns, with the word: "4 earlier turns"', true)] },
  { id: TEXT.progress.fresh, group: PROGRESS, label: "No notes yet", note: "The first line of a turn whose main agent carries nothing.", text: "LumiAH: the main agent starts without notes from earlier turns.", vars: [] },
  { id: TEXT.progress.dropped, group: PROGRESS, label: "Notes dropped", note: "A line for notes that no longer fit the chat.", text: "An earlier message changed, so its notes from {{replies}} were dropped.", vars: [v("replies", 'the replies: "reply #12" or "replies #12, #14"', true)] },
  { id: TEXT.progress.compacting, group: PROGRESS, label: "Summarizing", note: "A line while the main agent's notes are summarized.", text: "Summarizing its notes from {{turns}}…", vars: [v("turns", 'how many turns fold into the summary, with the word: "6 turns"', true)] },
  { id: TEXT.progress.compacted, group: PROGRESS, label: "Summarized", note: "A line once the summary is made.", text: "Summarized {{folded}}; the latest {{kept}} stay whole.", vars: [v("folded", 'how many turns the summary took in, with the word: "6 turns"', true), v("kept", "how many stay whole")] },
  { id: TEXT.progress.notCompacted, group: PROGRESS, label: "Not summarized", note: "A line when the summary couldn't be made: the notes go on whole.", text: "Its notes weren't summarized ({{reason}}); they go on whole.", vars: [v("reason", "why", true)] },
  { id: TEXT.progress.compactionHeld, group: PROGRESS, label: "Not summarized again yet", note: "A line while a rollback holds the notes whole: they are past Summarize past, and aren't summarized until they have grown by After a rollback or you ask for it.", text: "Its notes stay whole after your rollback: they are summarized again once they have grown by {{margin}} tokens (After a rollback), or when you ask for it.", vars: [v("margin", "After a rollback", true)] },
  { id: TEXT.progress.call, group: PROGRESS, label: "A tool call", note: "A line for each tool the main agent calls.", text: "{{tool}} {{args}}", vars: [v("tool", "the tool", true), v("args", "its arguments, shortened")] },
  { id: TEXT.progress.writing, group: PROGRESS, label: "Writing", note: "A line when the writer starts on the reply from a brief the main agent gave with write_reply.", text: "Writing the reply from the main agent's brief…", vars: [] },
  { id: TEXT.progress.answerAsBrief, group: PROGRESS, label: "Writing from an answer taken as the brief", note: "A line when the main agent ended without calling write_reply: its last answer is handed to the writer in the brief's place.", text: "The main agent ended without calling write_reply; the writer is given its last answer as the brief.", vars: [] },
  { id: TEXT.progress.writingAlone, group: PROGRESS, label: "Writing without a brief", note: "A line when the writer starts with no brief, because the main agent stopped short of one.", text: "The main agent stopped before its brief ({{reason}}); the writer writes from your preset alone.", vars: [v("reason", "why the main agent stopped", true)] },
  { id: TEXT.progress.writingFailed, group: PROGRESS, label: "Writing after a failure", note: "A line when the writer starts with no brief because something of LumiAH's failed before the main agent gave one: its settings or its notes couldn't be read, or its own run broke.", text: "The main agent had no part in this reply ({{reason}}); the writer writes from your preset alone.", vars: [v("reason", "what failed", true)] },
  { id: TEXT.progress.recordFailed, group: PROGRESS, label: "A turn's notes not stored", note: "A line when a turn's notes couldn't be stored, and what the live view says of it: the reply stands, and the main agent won't remember the turn.", text: "This turn's notes couldn't be stored ({{error}}): the reply stands, but the main agent won't remember this turn.", vars: [v("error", "why", true)] },
  { id: TEXT.progress.retry, group: PROGRESS, label: "Trying a call again", note: "A line each time a model call that failed in passing is made again, whichever of the turn's agents made it.", text: "A model call failed ({{reason}}); trying again, {{attempt}} of {{retries}}…", vars: [v("reason", "the failure, in the provider's own words", true), v("attempt", "which try this is"), v("retries", "how many Settings allow")] },
  { id: TEXT.progress.stopped, group: PROGRESS, label: "Stopped", note: "A line when the turn ends without a reply.", text: "No reply: {{reason}}.", vars: [v("reason", "why", true)] },
  { id: TEXT.progress.turnStopped, group: PROGRESS, label: "Why: the turn was stopped", note: "The reason a turn gives when it was stopped before its agents could say why.", text: "the turn was stopped", vars: [] },
  { id: TEXT.progress.dueWait, group: PROGRESS, label: "Waiting for jobs due", note: "A line when a turn waits at its start for the jobs started as due by it.", text: "Waiting for {{jobs}} due by this turn…", vars: [v("jobs", 'how many, with the word: "2 jobs"', true)] },
  { id: TEXT.progress.nothingReleased, group: PROGRESS, label: "Why: nothing was released", note: "Why a turn failed in a chat whose reply is only what its agents release, when they released none of it. No writer writes in their place there.", text: "the agents ended without releasing any of the reply, and in this chat no writer writes it in their place", vars: [] },
  { id: TEXT.progress.leadMissing, group: PROGRESS, label: "Why: the agent that leads isn't there", note: "Why a turn didn't start in a chat whose extension names the agent that leads its replies, when there is no such agent. No other agent leads in its place.", text: "{{extension}} names {{agent}} to lead this chat's replies, and there is no such agent, so this reply wasn't started. {{extension}} has to supply it: update it, or tell its author", vars: [v("extension", "the extension's name"), v("agent", "the agent's id", true)] },
  { id: TEXT.progress.leadOff, group: PROGRESS, label: "Why: the agent that leads is switched off", note: "Why a turn didn't start in a chat whose extension names the agent that leads its replies, when that agent is switched off. No other agent leads in its place.", text: "{{extension}} names {{agent}} to lead this chat's replies, and it is switched off, so this reply wasn't started. Switch it on on the Agents page, then try again", vars: [v("extension", "the extension's name"), v("agent", 'the agent, by its name and its id: "Author (author)"', true)] },
  { id: TEXT.progress.leadLate, group: PROGRESS, label: "Why: the agent that leads wasn't given in time", note: "Why a turn didn't start in a chat whose extension names the agent that leads its replies, when the extension didn't give its agents within Wait for the extension. No other agent leads in its place.", text: "{{extension}} names {{agent}} to lead this chat's replies, and it isn't in this run: {{extension}} didn't give its agents within {{wait}}, so this reply wasn't started. Try again; if it keeps happening, give {{extension}} longer with {{setting}}", vars: [v("extension", "the extension's name"), v("agent", "the agent's id", true), v("wait", 'how long it was waited for: "10 seconds"'), v("setting", "Wait for the extension, with where it is changed", true)] },
  { id: TEXT.progress.leadUnread, group: PROGRESS, label: "Why: the agent that leads couldn't be had", note: "Why a turn didn't start in a chat whose extension names the agent that leads its replies, when asking the extension for its agents failed. No other agent leads in its place.", text: "{{extension}} names {{agent}} to lead this chat's replies, and it isn't in this run: {{extension}}'s agents couldn't be had ({{error}}), so this reply wasn't started. Try again in a moment", vars: [v("extension", "the extension's name"), v("agent", "the agent's id", true), v("error", "why, in the extension's or the link's words", true)] },
  { id: TEXT.progress.claimLate, group: PROGRESS, label: "Why: no word on the chat in time", note: "Why a reply, a job's run or a conversation's turn about a chat didn't start, when the extension didn't say within Wait for the extension whether it answers that chat itself: run as one of LumiAH's own, the chat could be answered wrongly.", text: "{{extension}} didn't say within {{wait}} whether it answers this chat itself, so this wasn't started: run as one of LumiAH's own chats, it could be answered wrongly. Try again; if it keeps happening, give {{extension}} longer with {{setting}}", vars: [v("extension", "the extension's name", true), v("wait", 'how long it was waited for: "10 seconds"'), v("setting", "Wait for the extension, with where it is changed", true)] },
  { id: TEXT.progress.claimUnread, group: PROGRESS, label: "Why: no word on the chat", note: "Why a reply, a job's run or a conversation's turn about a chat didn't start, when asking the extension whether it answers that chat itself failed: run as one of LumiAH's own, the chat could be answered wrongly.", text: "{{extension}} couldn't say whether it answers this chat itself ({{error}}), so this wasn't started: run as one of LumiAH's own chats, it could be answered wrongly. Try again in a moment", vars: [v("extension", "the extension's name", true), v("error", "why, in the extension's or the link's words", true)] },
  { id: TEXT.progress.agentsLate, group: PROGRESS, label: "The extension's agents missing: not given in time", note: "What a run's live view says when the extension didn't give its agents and skills within Wait for the extension: the run goes on without them where none of them is needed. Why a job or a conversation whose agent is the extension's didn't start, too.", text: "{{extension}}'s agents and skills are missing from this run: it didn't give them within {{wait}}. If it keeps happening, give it longer with {{setting}}", vars: [v("extension", "the extension's name", true), v("wait", 'how long it was waited for: "10 seconds"'), v("setting", "Wait for the extension, with where it is changed", true)] },
  { id: TEXT.progress.agentsUnread, group: PROGRESS, label: "The extension's agents missing: couldn't be had", note: "What a run's live view says when asking the extension for its agents and skills failed: the run goes on without them where none of them is needed. Why a job or a conversation whose agent is the extension's didn't start, too.", text: "{{extension}}'s agents and skills are missing from this run: they couldn't be had ({{error}})", vars: [v("extension", "the extension's name", true), v("error", "why, in the extension's or the link's words", true)] },
];

/** The nouns counts are written with. */
const WORD_TEXTS: TextDef[] = [
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
  word(TEXT.word.block, "instruction block", "instruction blocks"),
];

/**
 * Every text the core sends, in the order the Settings page shows them. A text's group is its own
 * (`TextDef.group`), so an area's tool descriptions and answers sort under Tools and Tool answers
 * wherever its file puts them.
 */
export const TEXT_DEFS: readonly TextDef[] = [...MAIN_TEXTS, ...REQUEST_TEXTS, ...WRITER_TEXTS, ...SESSION_TEXTS, ...AGENTS_TEXTS, ...WORKSPACE_TEXTS, ...JOBS_TEXTS, ...APPROVAL_TEXTS, ...SIDE_TEXTS, ...SPEND_TEXTS, ...BOOK_TEXTS, ...RECALL_TEXTS, ...TOOL_TEXTS, ...ANSWER_TEXTS, ...RUNTIME_TEXTS, ...STOP_TEXTS, ...PROGRESS_TEXTS, ...WORD_TEXTS];

const BY_ID: ReadonlyMap<string, TextDef> = new Map(TEXT_DEFS.map((d) => [d.id, d]));

/** Anything in double braces: a placeholder, or what a text mistakes for one. */
const BRACES = /\{\{[\s\S]*?\}\}/g;

/** The placeholder token for a name. */
function placeholder(name: string): string {
  return `{{${name}}}`;
}

/** The text with id `id`, or undefined when there is none. */
export function textDef(id: string): TextDef | undefined {
  return BY_ID.get(id);
}

/**
 * Why `text` can't stand in for the text `id`, in plain words; null when it can. A text is refused
 * when there is no such id, when it lacks a placeholder its text requires (it couldn't carry what it
 * is for), or when it holds a placeholder the text doesn't have (it would be sent as nothing, so it
 * is flagged rather than lost silently).
 */
export function checkText(id: string, text: string): string | null {
  const def = BY_ID.get(id);
  if (!def) return `There is no text "${id}".`;
  const missing = def.vars.filter((x) => x.required && !text.includes(placeholder(x.name)));
  if (missing.length > 0) return `It must keep ${missing.map((x) => `${placeholder(x.name)} (${x.text})`).join(" and ")}.`;
  const known = new Set(def.vars.map((x) => placeholder(x.name)));
  const unknown = [...new Set([...text.matchAll(BRACES)].map((m) => m[0]))].filter((token) => !known.has(token));
  if (unknown.length > 0) return def.vars.length > 0 ? `${unknown.join(", ")} isn't one of this text's placeholders (${def.vars.map((x) => placeholder(x.name)).join(", ")}).` : `${unknown.join(", ")} isn't a placeholder: this text has none.`;
  return null;
}

/** `text` with each of `def`'s placeholders filled from `vars` (one without a value is empty), and anything else in double braces left out. What fills a placeholder is never read for placeholders itself. */
function fill(def: TextDef, text: string, vars: Readonly<Record<string, string>>): string {
  const names = new Set(def.vars.map((x) => x.name));
  return text.replace(BRACES, (token) => {
    const name = token.slice(2, -2);
    return names.has(name) && hasOwn(vars, name) ? (vars[name] ?? "") : "";
  });
}

function defOf(id: string): TextDef {
  const def = BY_ID.get(id);
  // A text id that isn't in the registry is a mistake in the code, never in the user's data.
  if (!def) throw new Error(`LumiAH has no text "${id}"`);
  return def;
}

/** The shipped text for `id`, filled: for logs, which never read the user's texts. */
export function renderDefault(id: string, vars: Readonly<Record<string, string>> = {}): string {
  const def = defOf(id);
  return fill(def, def.text, vars);
}

/**
 * The texts as one user has them: each is their own where they replaced it and it can be sent
 * (`checkText`), else the shipped one. Made once per turn from the user's texts as stored, so a text
 * replaced takes effect on the next turn.
 */
export class Texts {
  private readonly own: ReadonlyMap<string, string>;

  constructor(own: Readonly<Record<string, string>> = {}) {
    const kept = new Map<string, string>();
    for (const [id, text] of Object.entries(own)) if (typeof text === "string" && checkText(id, text) === null) kept.set(id, text);
    this.own = kept;
  }

  /** The text for `id` as it stands, its placeholders unfilled. */
  text(id: string): string {
    return this.own.get(id) ?? defOf(id).text;
  }

  /** The text for `id`, filled. */
  render(id: string, vars: Readonly<Record<string, string>> = {}): string {
    return fill(defOf(id), this.text(id), vars);
  }

  /** A noun in the number a count takes, from its word text (`TEXT.word`): the word for one, else the word for several. A text with one form is used for both. */
  noun(n: number, id: string): string {
    const [one = "", many = one] = this.text(id).split("|");
    return n === 1 ? one : many;
  }

  /** A count with its noun in the number it takes: "1 tool", "3 tools", "0 tools". */
  counted(n: number, id: string): string {
    return `${n} ${this.noun(n, id)}`;
  }

  /** Whether the user replaced the text `id`. */
  replaced(id: string): boolean {
    return this.own.has(id);
  }
}

/** The user's texts as stored (an object of texts by id), read: anything that isn't one is left out. */
export function textsOf(own: unknown): Texts {
  const texts: Record<string, string> = {};
  if (isRecord(own)) for (const [id, text] of Object.entries(own)) if (typeof text === "string") texts[id] = text;
  return new Texts(texts);
}
