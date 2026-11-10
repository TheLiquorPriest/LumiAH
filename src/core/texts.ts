// Every text the core sends to a model (DESIGN §3.3, §9), in one place: what each text is, its
// shipped default and the placeholders it may use. Code names a text by its id (`TEXT`), never by a
// literal at a call site, and renders it through the user's texts (`Texts`): the user's own where
// they replaced it, else the default. A text's id, the placeholder syntax `{{name}}` and the
// placeholders a text requires are stored formats (the user's own texts are kept by them), so they
// never change once shipped.
//
// The progress lines a turn writes into the reply's thinking block are here too: a preset may send a
// reply's thinking back to a model, so they are texts like the rest.

import { isRecord } from "./ports";
import { hasOwn } from "./util";

/** A placeholder a text may use: `{{name}}`, filled with what `text` says; `required` when the text can't work without it. */
export interface TextVar {
  name: string;
  text: string;
  required?: true;
}

/** One editable text: its id, the group it sits under, what it is for, its default and its placeholders. */
export interface TextDef {
  id: string;
  group: string;
  label: string;
  note: string;
  text: string;
  vars: TextVar[];
}

/** The built-in tool that reads the rest of a clipped result. */
export const SCRATCH_READ = "scratch_read";

/** The base tools, by name (DESIGN §4.3). */
export const TOOL = {
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
  writeReply: "write_reply",
} as const;

/** The text ids, so code names each once. */
export const TEXT = {
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
    cacheNonce: "runtime.cache_nonce",
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
    loopback: "stop.loopback",
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
    receiptNothing: "session.receipt.nothing",
    replyWritten: "session.reply_written",
    summarizer: "session.summarizer",
    summarizerInput: "session.summarizer.input",
    summarizerTurn: "session.summarizer.turn",
    none: "session.none",
    failedNothing: "session.summary_failed.nothing",
    failedCut: "session.summary_failed.cut",
    failedMidSentence: "session.summary_failed.mid_sentence",
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
    replyEmpty: "tool.answer.reply_empty",
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
    turnStopped: "progress.turn_stopped",
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
  /** A tool's description. */
  tool: (name: string): string => `tool.${name}`,
  /** The description of one of a tool's arguments. */
  toolArg: (name: string, arg: string): string => `tool.${name}.${arg}`,
} as const;

const v = (name: string, text: string, required?: true): TextVar => (required ? { name, text, required } : { name, text });

const RUNTIME = "Every agent";
const STOPS = "Why an agent stopped";
const MAIN = "Main agent";
const REQUEST = "The request, as the main agent reads it";
const WRITER = "Writer";
const SESSION = "Session";
const TOOLS = "Tools";
const ANSWERS = "Tool answers";
const PROGRESS = "Progress lines";
const WORDS = "Words";

/** A noun's text: the word for one of it, and for several. */
const word = (id: string, one: string, many: string): TextDef => ({ id, group: WORDS, label: `${one}, ${many}`, note: `The word a count of these takes in answers, notes and stops: for one, then for several, with | between ("1 ${one}", "3 ${many}").`, text: `${one}|${many}`, vars: [] });

const stop = (id: string, label: string, note: string, text: string, vars: TextVar[] = []): TextDef => ({ id, group: STOPS, label, note: `${note} The reason an agent that stopped so gives, in the live view and to whoever started it.`, text, vars });

/** A tool's description and each of its arguments', as texts. */
function tool(name: string, description: string, args: Readonly<Record<string, string>>): TextDef[] {
  return [
    { id: TEXT.tool(name), group: TOOLS, label: `${name}: what it does`, note: `The description of the ${name} tool, as the model is offered it.`, text: description, vars: [] },
    ...Object.entries(args).map(([arg, text]): TextDef => ({ id: TEXT.toolArg(name, arg), group: TOOLS, label: `${name}: ${arg}`, note: `The description of ${name}'s ${arg} argument.`, text, vars: [] })),
  ];
}

const CURSOR = "Where to go on from: the cursor the last answer gave you. Leave it out to start at the beginning.";

const RUNTIME_TEXTS: TextDef[] = [
  { id: TEXT.runtime.scratchRead, group: RUNTIME, label: "scratch_read: what it does", note: "The description of the built-in tool that reads the rest of a clipped tool result.", text: "Read more of a tool result that came back clipped. Give the scratch handle the clipped result names and where to start; you get the next part.", vars: [] },
  { id: TEXT.runtime.scratchHandle, group: RUNTIME, label: "scratch_read: handle", note: "The description of scratch_read's handle argument.", text: "The scratch handle the clipped result names, such as s1.", vars: [] },
  { id: TEXT.runtime.scratchOffset, group: RUNTIME, label: "scratch_read: offset", note: "The description of scratch_read's offset argument.", text: "The character to start from; 0 is the start.", vars: [] },
  { id: TEXT.runtime.scratchLength, group: RUNTIME, label: "scratch_read: length", note: "The description of scratch_read's length argument.", text: "How many characters to read, at most {{max}}.", vars: [v("max", "the most one read returns: Tool results clipped past")] },
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
];

const STOP_TEXTS: TextDef[] = [
  stop(TEXT.stop.cancelled, "Cancelled", "The agent was cancelled: the turn was stopped, or whoever started it stopped it.", "the agent was cancelled"),
  stop(TEXT.stop.busy, "Still working", "A message sent while the agent still works on its last one.", "the agent is still working on its last message"),
  stop(TEXT.stop.revisions, "Out of revisions", "A message after its first answer, once it has had every revision its budget allows (Revisions).", "it has had the {{revisions}} it may have after its first answer (Revisions)", [v("revisions", 'the revisions it may have, with the word: "2 revisions"', true)]),
  stop(TEXT.stop.wallTime, "Out of time", "The agent's own time ran out (Time per agent).", "the agent's time ran out (Time per agent)"),
  stop(TEXT.stop.turnTime, "The turn out of time", "The turn's time ran out (Time per turn).", "the turn's time ran out (Time per turn)"),
  stop(TEXT.stop.callTime, "A call too slow", "One call took longer than Time per call.", "the call took longer than Time per call"),
  stop(TEXT.stop.callTokensIn, "A prompt too long", "A call whose prompt, as estimated, is past Prompt per call.", "the call's prompt, about {{tokens}}, is past Prompt per call ({{limit}})", [v("tokens", 'the prompt\'s estimate, with the word: "9000 tokens"', true), v("limit", "Prompt per call", true)]),
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
  stop(TEXT.stop.loopback, "The loopback connection", "The agent is set to run on the loopback connection, whose calls come back to LumiAH itself.", "the connection {{connection}} is LumiAH's own loopback: a call on it would come straight back here. Give this agent a connection to a model in LumiAH's Settings", [v("connection", "the connection's name", true)]),
];

const MAIN_TEXTS: TextDef[] = [
  {
    id: TEXT.main.system,
    group: MAIN,
    label: "Instructions",
    note: "The main agent's instructions while a separate writer writes the reply (Who writes the reply: the writer).",
    text: [
      "You are the main agent behind a roleplay chat in Lumiverse. The user never reads you: they read the reply. Each turn a reply is needed. Your work is to find out what that reply needs and hand it to the writer, who writes the prose from the same prompt Lumiverse assembled, plus your brief.",
      "What you are given each turn:\n- The request: every message Lumiverse assembled for this reply, numbered, in order. A message marked as a preset instruction is the preset author's: the reply must achieve it. The rest is context: the character, the persona, the lore Lumiverse activated, and the chat's recent messages, ending with what the user just sent.\n- Your notes: what you did on your earlier turns in this chat, as a summary of the older ones and a receipt of each turn since. They are yours, not the story's. past_turn reads an earlier turn of yours in full.",
      "How to work:\n- Decide what this reply turns on: who is present, what was promised or left open, what the lore says about what is in play, and what the preset's instructions ask of this reply in particular.\n- Use your tools for what the request doesn't show. chat_search, chat_grep and chat_read reach every message of the chat, those too old to be in the request among them. lore_index, lore_search, lore_grep and lore_read reach every entry of the world books that apply, those Lumiverse didn't activate among them; active_lore lists the ones it did. preset_instructions lists the preset's instruction blocks.\n- Call several tools in one answer when none of them depends on another's result. Don't read again what the request already shows. A result that says it was clipped, or that there is more, names the handle or the cursor to read on with.\n- Stop looking once you have what the reply needs. Most replies need little.",
      "Then call write_reply with your brief. The writer already has the whole prompt, so give it only what it would miss or get wrong without you: facts to keep straight (names, places, who knows what, what happened before), lore that bears on this moment, the thread to pick up, an instruction the last replies drifted from. Be specific, quote exact wording where it matters, and keep it short. Don't write the reply's prose, and don't restate the preset. When the prompt already holds everything, say so in one line. write_reply ends your turn. If you answer without calling it, your answer is taken as the brief.",
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
      "What you are given each turn:\n- The request: every message Lumiverse assembled for this reply, numbered, in order. A message marked as a preset instruction is the preset author's: the reply must achieve it. The rest is context: the character, the persona, the lore Lumiverse activated, and the chat's recent messages, ending with what the user just sent.\n- Your notes: what you did on your earlier turns in this chat, as a summary of the older ones and a receipt of each turn since. They are yours, not the story's. past_turn reads an earlier turn of yours in full.",
      "How to work:\n- Decide what this reply turns on: who is present, what was promised or left open, what the lore says about what is in play, and what the preset's instructions ask of this reply in particular.\n- Use your tools for what the request doesn't show. chat_search, chat_grep and chat_read reach every message of the chat, those too old to be in the request among them. lore_index, lore_search, lore_grep and lore_read reach every entry of the world books that apply, those Lumiverse didn't activate among them; active_lore lists the ones it did. preset_instructions lists the preset's instruction blocks.\n- Call several tools in one answer when none of them depends on another's result. Don't read again what the request already shows. A result that says it was clipped, or that there is more, names the handle or the cursor to read on with.\n- Stop looking once you have what the reply needs. Most replies need little.",
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
    vars: [v("kind", "why a reply is needed, in the words below", true), v("notes", "what changed about its notes since its last turn, each ending in a blank line; nothing when nothing did"), v("count", 'how many messages the request has, with the word: "42 messages"'), v("request", "the request's messages, each framed as below", true), v("ask", "what to do with it, in the words below", true)],
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
  { id: TEXT.main.noteContinued, group: MAIN, label: "The turn continued", note: "Leads a turn's message when it continues a reply the main agent already worked on: what it did then.", text: "You already worked on this reply before it was continued. What you did then:\n{{receipt}}", vars: [v("receipt", "the receipt of that work", true)] },
  { id: TEXT.main.replyOne, group: MAIN, label: "Notes dropped: one reply", note: "Fills {{replies}} in Notes dropped, and in its progress line, when one reply's notes were dropped.", text: "reply {{list}}", vars: [v("list", 'the reply\'s number: "#12"', true)] },
  { id: TEXT.main.replyMany, group: MAIN, label: "Notes dropped: several replies", note: "Fills {{replies}} in Notes dropped, and in its progress line, when several replies' notes were dropped.", text: "replies {{list}}", vars: [v("list", 'the replies\' numbers: "#12, #14"', true)] },
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
  { id: TEXT.session.receiptNothing, group: SESSION, label: "A receipt: nothing done", note: "A receipt of a turn in which the main agent did nothing on record.", text: "- nothing on record", vars: [] },
  { id: TEXT.session.replyWritten, group: SESSION, label: "write_reply's result, as kept", note: "What the main agent's notes keep in place of write_reply's result. The reply isn't kept: it is in the chat.", text: "the writer wrote the reply ({{chars}} characters; it is chat message #{{reply}})", vars: [v("chars", "the reply's length"), v("reply", "the reply's number in the chat")] },
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
  { id: TEXT.session.failedMidSentence, group: SESSION, label: "No summary: mid-sentence", note: "Why the notes weren't summarized, when the summary stops mid-sentence.", text: "its summary stops mid-sentence", vars: [] },
];

const TOOL_TEXTS: TextDef[] = [
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
  ...tool(TOOL.writeReply, "Hand the writer your brief and have it write the reply, which goes to the user. This ends your turn: call it once, when you have what the reply needs, and call nothing else beside it.", { brief: "What the writer needs that the prompt doesn't already give it: facts to keep straight, lore that bears on this moment, the thread to pick up. Short and specific; no prose for the reply itself." }),
];

const ANSWER_TEXTS: TextDef[] = [
  { id: TEXT.answer.more, group: ANSWERS, label: "There is more", note: "Ends a tool's answer that has more to give.", text: '[There is more: call {{tool}} again with the same arguments and cursor "{{cursor}}".]', vars: [v("tool", "the tool"), v("cursor", "where the next page starts", true)] },
  { id: TEXT.answer.end, group: ANSWERS, label: "That is all", note: "Ends the last page of an answer that came in pages.", text: "[That is the end.]", vars: [] },
  { id: TEXT.answer.found, group: ANSWERS, label: "What a search found", note: "Heads a search's or a listing's answer: how many it found and which of them this page shows.", text: "{{total}} found; showing {{from}} to {{to}}.", vars: [v("total", 'how many it found, with the word: "37 messages"', true), v("from", "the first shown, counted from 1"), v("to", "the last shown")] },
  { id: TEXT.answer.chatSearchNothing, group: ANSWERS, label: "chat_search: nothing found", note: "chat_search's answer when no message matches, with what to try next.", text: "No message of this chat matches “{{query}}”. Try fewer or other words (names and rare words find the most), or chat_grep for an exact phrase.", vars: [v("query", "what was looked for", true)] },
  { id: TEXT.answer.chatGrepNothing, group: ANSWERS, label: "chat_grep: nothing found", note: "chat_grep's answer when no line holds the text, with what to try next.", text: "No line of this chat holds “{{query}}”. Try a shorter piece of it, or chat_search for the words in any order.", vars: [v("query", "what was looked for", true)] },
  { id: TEXT.answer.loreSearchNothing, group: ANSWERS, label: "lore_search: nothing found", note: "lore_search's answer when no entry matches, with what to try next.", text: "No lore entry matches “{{query}}”. Try fewer or other words, or lore_index to see what the books hold.", vars: [v("query", "what was looked for", true)] },
  { id: TEXT.answer.loreGrepNothing, group: ANSWERS, label: "lore_grep: nothing found", note: "lore_grep's answer when no line holds the text, with what to try next.", text: "No line of the lore holds “{{query}}”. Try a shorter piece of it, or lore_search for the words in any order.", vars: [v("query", "what was looked for", true)] },
  { id: TEXT.answer.pastGrepNothing, group: ANSWERS, label: "past_turn: grep found nothing", note: "past_turn's answer when no line of the turns it read holds the text.", text: "No line of {{where}} holds “{{query}}”. Try a shorter piece of it, or give reply to search one turn.", vars: [v("where", "the turns it read, in the words below"), v("query", "what was looked for", true)] },
  { id: TEXT.answer.pastWhereReply, group: ANSWERS, label: "past_turn: where it looked, one turn", note: "Fills {{where}} when the grep read one turn.", text: "reply #{{reply}}", vars: [v("reply", "the reply's number", true)] },
  { id: TEXT.answer.pastWhereLatest, group: ANSWERS, label: "past_turn: where it looked, the latest turns", note: "Fills {{where}} when the grep read the latest turns.", text: "your latest {{turns}}", vars: [v("turns", 'how many turns it read, with the word: "8 turns"', true)] },
  { id: TEXT.answer.badCursor, group: ANSWERS, label: "A cursor that isn't one", note: "The answer to a cursor the tool never gave.", text: "“{{cursor}}” isn't a cursor {{tool}} gave. Pass the cursor exactly as the last answer wrote it, or leave it out to start at the beginning.", vars: [v("cursor", "the cursor given", true), v("tool", "the tool")] },
  { id: TEXT.answer.needs, group: ANSWERS, label: "A missing argument", note: "The answer to a call that lacks an argument the tool can't do without.", text: "{{tool}} needs {{arg}}: {{what}} Call it again with {{arg}}.", vars: [v("tool", "the tool"), v("arg", "the argument's name", true), v("what", "what the argument is, from its description")] },
  { id: TEXT.answer.cut, group: ANSWERS, label: "An item cut to fit", note: "Ends an item too long for one page of a listing.", text: "{{text}}… (cut to fit)", vars: [v("text", "the start of the item", true)] },
  { id: TEXT.answer.chatHit, group: ANSWERS, label: "chat_search: a hit", note: "One message chat_search found.", text: "- #{{index}} ({{who}}, {{chars}} characters): {{excerpt}}", vars: [v("index", "the message's number", true), v("who", "who wrote it"), v("chars", "the message's length"), v("excerpt", "the excerpt that matched best")] },
  { id: TEXT.answer.chatLine, group: ANSWERS, label: "chat_grep: a line", note: "One line chat_grep found.", text: "- #{{index}} ({{who}}), line {{line}}: {{text}}", vars: [v("index", "the message's number", true), v("who", "who wrote it"), v("line", "the line's number in the message"), v("text", "the line, around what was found", true)] },
  { id: TEXT.answer.chatMessage, group: ANSWERS, label: "chat_read: a message", note: "One message, or the part of one a page holds, in chat_read's answer.", text: "#{{index}} ({{who}}), characters {{from}} to {{to}} of {{chars}}:\n{{text}}", vars: [v("index", "the message's number", true), v("who", "who wrote it"), v("from", "the first character shown"), v("to", "the character after the last shown"), v("chars", "the message's length"), v("text", "the text", true)] },
  { id: TEXT.answer.chatRead, group: ANSWERS, label: "chat_read: its answer", note: "Heads chat_read's answer.", text: "Chat messages #{{from}} to #{{to}} ({{count}} asked for):", vars: [v("from", "the first message asked for"), v("to", "the last message asked for"), v("count", "how many that is")] },
  { id: TEXT.answer.chatNoMessage, group: ANSWERS, label: "chat_read: no such message", note: "chat_read's answer to a number the chat doesn't have.", text: "There is no chat message #{{index}}: this turn reads messages #{{first}} to #{{last}}. Give a number in that range.", vars: [v("index", "the number asked for", true), v("first", "the first message's number"), v("last", "the last message's number")] },
  { id: TEXT.answer.chatEmpty, group: ANSWERS, label: "The chat is empty", note: "A chat tool's answer when the chat has no message before this reply.", text: "This chat has no messages before this reply, so there is nothing to read here. Work from the request.", vars: [] },
  { id: TEXT.answer.loreBook, group: ANSWERS, label: "lore_index: a book", note: "A book's heading in lore_index's answer.", text: "Book “{{name}}” [{{id}}], {{count}}{{description}}:", vars: [v("name", "the book's name", true), v("id", "the book's id"), v("count", 'how many entries it has, with the word: "12 entries"'), v("description", "its description, after a dash; nothing when it has none")] },
  { id: TEXT.answer.loreEntry, group: ANSWERS, label: "lore_index: an entry", note: "One entry in lore_index's answer.", text: "- [{{id}}] {{title}}{{flags}} · keys: {{keys}} · {{chars}} characters", vars: [v("id", "the entry's id, as lore_read takes it", true), v("title", "its title"), v("flags", "whether it is switched off, or always sent, in the words below"), v("keys", "its keys, or the text for nothing"), v("chars", "its length")] },
  { id: TEXT.answer.loreHit, group: ANSWERS, label: "lore_search: a hit", note: "One entry lore_search found.", text: "- [{{id}}] {{title}}{{flags}} (book “{{book}}”, {{chars}} characters): {{excerpt}}", vars: [v("id", "the entry's id, as lore_read takes it", true), v("title", "its title"), v("flags", "whether it is switched off, or always sent"), v("book", "its book's name"), v("chars", "its length"), v("excerpt", "the excerpt that matched best")] },
  { id: TEXT.answer.loreLine, group: ANSWERS, label: "lore_grep: a line", note: "One line lore_grep found.", text: "- [{{id}}] {{title}}, line {{line}}: {{text}}", vars: [v("id", "the entry's id, as lore_read takes it", true), v("title", "its title"), v("line", "the line's number in the entry"), v("text", "the line, around what was found", true)] },
  { id: TEXT.answer.loreRead, group: ANSWERS, label: "lore_read: its answer", note: "lore_read's answer: an entry, or the part of it a page holds.", text: "[{{id}}] {{title}}{{flags}} (book “{{book}}”) · keys: {{keys}} · characters {{from}} to {{to}} of {{chars}}:\n{{text}}", vars: [v("id", "the entry's id", true), v("title", "its title"), v("flags", "whether it is switched off, or always sent"), v("book", "its book's name"), v("keys", "its keys, or the text for nothing"), v("from", "the first character shown"), v("to", "the character after the last shown"), v("chars", "the entry's length"), v("text", "the text", true)] },
  { id: TEXT.answer.loreNoEntry, group: ANSWERS, label: "lore_read: no such entry", note: "lore_read's answer to an id no entry has.", text: "There is no lore entry {{id}} in the books that apply to this chat. Take an id from lore_index or a lore search, written as it gives it.", vars: [v("id", "the id asked for", true)] },
  { id: TEXT.answer.loreNoBook, group: ANSWERS, label: "lore_index: no such book", note: "lore_index's answer to a book that isn't among those that apply.", text: "No book “{{book}}” applies to this chat. The books are: {{books}}. Give one of those, or leave book out to list them all.", vars: [v("book", "the book asked for", true), v("books", "the books that apply, by name and id")] },
  { id: TEXT.answer.loreNoBooks, group: ANSWERS, label: "No world books", note: "A lore tool's answer when no world book applies to the chat.", text: "No world book applies to this chat, so there is no lore to read here. Work from the request.", vars: [] },
  { id: TEXT.answer.loreOff, group: ANSWERS, label: "An entry switched off", note: "Marks an entry that is switched off in its book, in the lore tools' answers.", text: " (switched off)", vars: [] },
  { id: TEXT.answer.loreAlways, group: ANSWERS, label: "An entry always sent", note: "Marks an entry its book always sends, in the lore tools' answers.", text: " (always sent)", vars: [] },
  { id: TEXT.answer.activeEntry, group: ANSWERS, label: "active_lore: an entry", note: "One entry in active_lore's answer.", text: "- [{{id}}] {{title}} (book “{{book}}”, {{chars}} characters): {{excerpt}}", vars: [v("id", "the entry's id, as lore_read takes it", true), v("title", "its title"), v("book", "its book's name"), v("chars", "the length of the text Lumiverse put in the prompt"), v("excerpt", "the start of that text")] },
  { id: TEXT.answer.activeNone, group: ANSWERS, label: "active_lore: none", note: "active_lore's answer when Lumiverse activated no entry.", text: "Lumiverse activated no lore entry for this reply. lore_search and lore_index reach the books that apply.", vars: [] },
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
  { id: TEXT.answer.loreAmbiguous, group: ANSWERS, label: "lore_read: an id that names several", note: "lore_read's answer to an id several entries start with.", text: "{{id}} names several entries: {{entries}}. Give more of the id.", vars: [v("id", "the id asked for", true), v("entries", "the entries it names, by id and title")] },
  { id: TEXT.answer.replyBusy, group: ANSWERS, label: "write_reply: already writing", note: "write_reply's answer to a second call while the writer is at work on the first.", text: "The writer is already writing this reply from your other write_reply call. Call write_reply once.", vars: [] },
  { id: TEXT.answer.replyFailed, group: ANSWERS, label: "write_reply: the writer failed", note: "write_reply's answer when the writer's call failed before any of the reply was sent.", text: "The writer couldn't write the reply: {{reason}}. Nothing was sent to the user. Call write_reply again to try once more.", vars: [v("reason", "why", true)] },
  { id: TEXT.answer.replyNoBrief, group: ANSWERS, label: "write_reply: no brief", note: "write_reply's answer to a call without a brief.", text: "write_reply needs brief: what the writer needs that the prompt doesn't already give it. When the prompt holds everything, say that in a line. Call write_reply again with brief.", vars: [] },
  { id: TEXT.answer.replyEmpty, group: ANSWERS, label: "write_reply: an empty reply", note: "Fills {{reason}} in The writer failed, and the turn's error, when the writer's model answered with nothing.", text: "its model answered with nothing", vars: [] },
];

const PROGRESS_TEXTS: TextDef[] = [
  { id: TEXT.progress.session, group: PROGRESS, label: "Notes carried", note: "The first line a turn writes into the reply's thinking block: what the main agent carries from earlier turns.", text: "LumiAH: the main agent carries its notes from {{turns}}.", vars: [v("turns", 'how many earlier turns, with the word: "4 earlier turns"', true)] },
  { id: TEXT.progress.sessionSummary, group: PROGRESS, label: "Notes carried, after a summary", note: "The first line of a turn whose main agent carries a summary of its older turns.", text: "LumiAH: the main agent carries its notes from {{turns}}, after a summary of the ones before.", vars: [v("turns", 'how many earlier turns, with the word: "4 earlier turns"', true)] },
  { id: TEXT.progress.fresh, group: PROGRESS, label: "No notes yet", note: "The first line of a turn whose main agent carries nothing.", text: "LumiAH: the main agent starts without notes from earlier turns.", vars: [] },
  { id: TEXT.progress.dropped, group: PROGRESS, label: "Notes dropped", note: "A line for notes that no longer fit the chat.", text: "An earlier message changed, so its notes from {{replies}} were dropped.", vars: [v("replies", 'the replies: "reply #12" or "replies #12, #14"', true)] },
  { id: TEXT.progress.compacting, group: PROGRESS, label: "Summarizing", note: "A line while the main agent's notes are summarized.", text: "Summarizing its notes from {{turns}}…", vars: [v("turns", 'how many turns fold into the summary, with the word: "6 turns"', true)] },
  { id: TEXT.progress.compacted, group: PROGRESS, label: "Summarized", note: "A line once the summary is made.", text: "Summarized {{folded}}; the latest {{kept}} stay whole.", vars: [v("folded", 'how many turns the summary took in, with the word: "6 turns"', true), v("kept", "how many stay whole")] },
  { id: TEXT.progress.notCompacted, group: PROGRESS, label: "Not summarized", note: "A line when the summary couldn't be made: the notes go on whole.", text: "Its notes weren't summarized ({{reason}}); they go on whole.", vars: [v("reason", "why", true)] },
  { id: TEXT.progress.call, group: PROGRESS, label: "A tool call", note: "A line for each tool the main agent calls.", text: "{{tool}} {{args}}", vars: [v("tool", "the tool", true), v("args", "its arguments, shortened")] },
  { id: TEXT.progress.writing, group: PROGRESS, label: "Writing", note: "A line when the writer starts on the reply.", text: "Writing the reply from the main agent's brief…", vars: [] },
  { id: TEXT.progress.writingAlone, group: PROGRESS, label: "Writing without a brief", note: "A line when the writer starts with no brief, because the main agent stopped short of one.", text: "The main agent stopped before its brief ({{reason}}); the writer writes from your preset alone.", vars: [v("reason", "why the main agent stopped", true)] },
  { id: TEXT.progress.retry, group: PROGRESS, label: "Trying a call again", note: "A line each time a model call that failed in passing is made again, whichever of the turn's agents made it.", text: "A model call failed ({{reason}}); trying again, {{attempt}} of {{retries}}…", vars: [v("reason", "the failure, in the provider's own words", true), v("attempt", "which try this is"), v("retries", "how many Settings allow")] },
  { id: TEXT.progress.stopped, group: PROGRESS, label: "Stopped", note: "A line when the turn ends without a reply.", text: "No reply: {{reason}}.", vars: [v("reason", "why", true)] },
  { id: TEXT.progress.turnStopped, group: PROGRESS, label: "Why: the turn was stopped", note: "The reason a turn gives when it was stopped before its agents could say why.", text: "the turn was stopped", vars: [] },
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

/** Every text the core sends, in the order the Settings page shows them. */
export const TEXT_DEFS: readonly TextDef[] = [...MAIN_TEXTS, ...REQUEST_TEXTS, ...WRITER_TEXTS, ...SESSION_TEXTS, ...TOOL_TEXTS, ...ANSWER_TEXTS, ...RUNTIME_TEXTS, ...STOP_TEXTS, ...PROGRESS_TEXTS, ...WORD_TEXTS];

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
