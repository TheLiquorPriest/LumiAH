// @bun
// src/core/ports.ts
function isRecord(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

// src/core/util.ts
var TIMER_MAX_MS = 2147483647;
function cutAt(text, at) {
  const unit = text.charCodeAt(at - 1);
  return at > 0 && at < text.length && unit >= 55296 && unit <= 56319 ? at - 1 : at;
}
function hasOwn(o, key) {
  return Object.prototype.hasOwnProperty.call(o, key);
}
function tokensOf(text, charsPerToken) {
  return Math.ceil(text.length / charsPerToken);
}
function parseJson(text) {
  try {
    return JSON.parse(text);
  } catch {
    return;
  }
}

// src/core/texts.ts
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
function checkSettings(values, scope) {
  const problems = [];
  const { schema, defaults } = shapeOf(scope);
  read(schema, defaults, values ?? {}, [], problems);
  return problems;
}
function settingsOf(values, scope) {
  const { schema, defaults } = shapeOf(scope);
  return read(schema, defaults, isRecord(values) ? values : {}, [], []);
}

// src/link/contract.ts
var LINK_VERSION = 1;
var LINK = "lumiah-link";
var EXTENSION_IDENTIFIER = "lumi_ah";
var MODEL_ID = "lumiah";
var TAG_PARAM = "lumiah_turn";
var KEY_PREFIX = "lah_";
var RUNTIME_NAME = /^[a-z0-9][a-z0-9_-]{0,39}$/;
var STREAM_ID = /^[0-9a-f]{32}$/;
var BLOB_HASH = /^[0-9a-f]{64}$/;
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

// src/link/json.ts
function isRecord2(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
function hasOwn2(object, key) {
  return Object.prototype.hasOwnProperty.call(object, key);
}
function toJson(value) {
  if (value === null || typeof value === "string" || typeof value === "boolean")
    return value;
  if (typeof value === "number")
    return Number.isFinite(value) ? value : null;
  if (Array.isArray(value))
    return value.map(toJson);
  if (isRecord2(value))
    return toJsonObject(value);
  return null;
}
function toJsonObject(value) {
  const out = {};
  if (!isRecord2(value))
    return out;
  for (const [k, v2] of Object.entries(value))
    if (v2 !== undefined && typeof v2 !== "function")
      out[k] = toJson(v2);
  return out;
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

// src/extension/backend/docs.ts
async function sha256(text) {
  const bytes = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text)));
  return [...bytes].map((b) => b.toString(16).padStart(2, "0")).join("");
}
function randomHex(bits) {
  const bytes = crypto.getRandomValues(new Uint8Array(bits / 8));
  return [...bytes].map((b) => b.toString(16).padStart(2, "0")).join("");
}
var USERS_KEPT = 256;

class UserDocs {
  host;
  file;
  read;
  empty;
  loaded = new Map;
  writing = Promise.resolve();
  unreadable = new Map;
  constructor(host, file, read2, empty) {
    this.host = host;
    this.file = file;
    this.read = read2;
    this.empty = empty;
  }
  get(userId) {
    let loaded = this.loaded.get(userId);
    if (loaded === undefined) {
      loaded = this.host.storage.read(this.file, userId).then((text) => {
        if (text === null)
          return this.empty();
        let doc = null;
        try {
          doc = this.read(JSON.parse(text));
        } catch {}
        if (doc !== null)
          return doc;
        this.unreadable.set(userId, text);
        this.host.log("warn", `[LumiAH] ${this.file} couldn't be read, so it starts afresh (the file is kept as ${this.file}.bad)`);
        return this.empty();
      }, (error) => {
        this.loaded.delete(userId);
        throw new Error(`LumiAH couldn't read ${this.file} (${error instanceof Error ? error.message : String(error)}). Try again in a moment.`);
      });
      this.loaded.set(userId, loaded);
      if (this.loaded.size > USERS_KEPT)
        this.loaded.delete(this.loaded.keys().next().value ?? "");
    }
    return loaded;
  }
  async change(userId, fn) {
    const doc = await this.get(userId);
    const out = fn(doc);
    const text = JSON.stringify(doc);
    const write = this.writing.then(async () => {
      const unreadable = this.unreadable.get(userId);
      if (unreadable !== undefined) {
        await this.host.storage.write(`${this.file}.bad`, unreadable, userId);
        this.unreadable.delete(userId);
      }
      await this.host.storage.write(this.file, text, userId);
    });
    this.writing = write.catch(() => {
      return;
    });
    try {
      await write;
    } catch (error) {
      this.loaded.delete(userId);
      throw new Error(`LumiAH couldn't save ${this.file} (${error instanceof Error ? error.message : String(error)}). Try again in a moment.`);
    }
    return out;
  }
  settle() {
    return this.writing;
  }
}

class KeyedQueue {
  tails = new Map;
  run(key, work) {
    const run = (this.tails.get(key) ?? Promise.resolve()).then(work, work);
    const tail = run.catch(() => {
      return;
    });
    this.tails.set(key, tail);
    tail.then(() => {
      if (this.tails.get(key) === tail)
        this.tails.delete(key);
    });
    return run;
  }
}

// src/extension/backend/errors.ts
class LinkRefused extends Error {
  code;
  constructor(code, message) {
    super(message);
    this.code = code;
    this.name = "LinkRefused";
  }
}

class UiRefused extends Error {
  code;
  problems;
  constructor(code, message, problems) {
    super(message);
    this.code = code;
    this.problems = problems;
    this.name = "UiRefused";
  }
}
function wordsOf(error) {
  return error instanceof Error ? error.message : String(error);
}

// src/extension/backend/chat.ts
function anchorsOf(own) {
  const out = { v: 1, swipes: {} };
  if (!isRecord2(own) || own.v !== 1 || !isRecord2(own.swipes))
    return out;
  for (const [swipe, record] of Object.entries(own.swipes))
    if (/^(0|[1-9][0-9]*)$/.test(swipe) && record !== undefined && record !== null)
      out.swipes[swipe] = record;
  return out;
}
function shownAnchor(message) {
  return anchorsOf(message.own).swipes[String(message.swipeId)] ?? null;
}
var TAIL_FIRST = 4;

class Chats {
  host;
  kept;
  writes = new KeyedQueue;
  paths = new Map;
  constructor(host, kept) {
    this.host = host;
    this.kept = kept;
  }
  async own(userId, chatId) {
    const chat = await this.host.chats.get(chatId, userId);
    if (chat === null)
      throw new LinkRefused("not_found", "There is no such chat in this account.");
    return chat;
  }
  touched(chatId) {
    const held = this.paths.get(chatId);
    if (held === undefined)
      return;
    held.fresh = false;
    held.changes++;
  }
  dropped(chatId) {
    this.paths.delete(chatId);
  }
  async path(userId, chatId) {
    await this.own(userId, chatId);
    const held = this.paths.get(chatId);
    if (held?.fresh === true) {
      const last = await this.last(chatId);
      const keptLast = held.rows.at(-1);
      const same = last === null ? keptLast === undefined : keptLast !== undefined && keptLast.id === last.id && keptLast.index === last.index && keptLast.swipeId === last.swipeId && keptLast.mark === contentMark(last.role, last.content);
      if (same)
        return held.rows.map(({ mark: _mark, ...row }) => row);
    }
    const mine = held ?? { rows: [], fresh: false, changes: 0 };
    if (held === undefined)
      this.paths.set(chatId, mine);
    const changes = mine.changes;
    const rows = await this.host.chats.messages(chatId);
    const before = new Map(mine.rows.map((row) => [row.id, row]));
    const read2 = await Promise.all(rows.map(async (m) => {
      const mark = contentMark(m.role, m.content);
      const old = before.get(m.id);
      const hash = old !== undefined && old.swipeId === m.swipeId && old.mark === mark ? old.hash : await textHash(m.content);
      return { id: m.id, index: m.index, role: m.role, name: m.name, swipeId: m.swipeId, chars: m.content.length, hash, anchor: shownAnchor(m), mark };
    }));
    const most = await this.kept(userId);
    const unchanged = this.paths.get(chatId) === mine && mine.changes === changes;
    this.paths.delete(chatId);
    if (most > 0) {
      this.paths.set(chatId, { rows: read2, fresh: unchanged, changes: mine.changes });
      for (const oldest of this.paths.keys()) {
        if (this.paths.size <= most)
          break;
        this.paths.delete(oldest);
      }
    }
    return read2.map(({ mark: _mark, ...row }) => row);
  }
  async messages(userId, chatId, from, to) {
    await this.own(userId, chatId);
    if (to <= from)
      return [];
    let rows = await this.host.chats.messages(chatId, { from, count: to - from });
    if (rows.some((m, i) => m.index !== from + i))
      rows = await this.host.chats.messages(chatId);
    return rows.filter((m) => m.index >= from && m.index < to).map((m) => ({ id: m.id, index: m.index, role: m.role, name: m.name, swipeId: m.swipeId, content: m.content }));
  }
  async find(chatId, messageId) {
    const tail = await this.host.chats.messages(chatId, { tail: TAIL_FIRST });
    const near = tail.find((m) => m.id === messageId);
    if (near !== undefined)
      return near;
    if (tail.length < TAIL_FIRST)
      return null;
    return (await this.host.chats.messages(chatId)).find((m) => m.id === messageId) ?? null;
  }
  async last(chatId) {
    return (await this.host.chats.messages(chatId, { tail: 1 })).at(-1) ?? null;
  }
  async anchor(userId, chatId, messageId, swipe, record) {
    await this.own(userId, chatId);
    return this.writes.run(`${chatId}\x00${messageId}`, async () => {
      const message = await this.find(chatId, messageId);
      if (message === null)
        return false;
      const at = swipe ?? message.swipeId;
      if (!Number.isSafeInteger(at) || at < 0 || at >= message.swipes)
        return false;
      const anchors = anchorsOf(message.own);
      anchors.swipes[String(at)] = record;
      await this.host.chats.setOwn(chatId, messageId, anchors);
      this.touched(chatId);
      return true;
    });
  }
  async swipeDeleted(chatId, messageId, deleted) {
    await this.writes.run(`${chatId}\x00${messageId}`, async () => {
      const message = await this.find(chatId, messageId);
      if (message === null)
        return;
      const anchors = anchorsOf(message.own);
      const held = Object.keys(anchors.swipes).map(Number);
      if (!held.some((swipe) => swipe >= deleted))
        return;
      const moved = { v: 1, swipes: {} };
      for (const swipe of held) {
        if (swipe === deleted)
          continue;
        const record = anchors.swipes[String(swipe)];
        if (record !== undefined)
          moved.swipes[String(swipe > deleted ? swipe - 1 : swipe)] = record;
      }
      await this.host.chats.setOwn(chatId, messageId, moved);
      this.touched(chatId);
    });
  }
}

// src/extension/backend/connections.ts
var LOOPBACK_PROVIDER = "custom";
var ANTHROPIC_CACHE_BREAKPOINTS = 4;
function cacheBreakpoints(provider, metadata) {
  if (provider !== "anthropic")
    return null;
  const caching = isRecord2(metadata) ? metadata.prompt_caching : undefined;
  const on = caching === true || isRecord2(caching);
  const own = isRecord2(caching) ? caching : {};
  const marks = isRecord2(own.breakpoints) ? own.breakpoints : {};
  return { limit: ANTHROPIC_CACHE_BREAKPOINTS, system: on && marks.system !== false, lastMessage: on && marks.messages === true, tools: on && marks.tools === true, automatic: on && own.automatic !== false };
}
var NO_PARALLEL_FLAG = { google: true, google_vertex: true, anthropic: true };
function takesParallelFlag(provider) {
  return !Object.hasOwn(NO_PARALLEL_FLAG, provider);
}
var sameUrl = (a, b) => a.trim().replace(/\/+$/, "").toLowerCase() === b.trim().replace(/\/+$/, "").toLowerCase();

class Connections {
  host;
  deps;
  constructor(host, deps) {
    this.host = host;
    this.deps = deps;
  }
  loops(c, bases) {
    return c.provider === LOOPBACK_PROVIDER && (c.model === MODEL_ID || bases.some((base) => sameUrl(base, c.url)));
  }
  info(c, bases) {
    return { id: c.id, name: c.name, provider: c.provider, model: c.model === "" ? null : c.model, loopback: this.loops(c, bases) };
  }
  raw(userId) {
    return this.host.connections.list(userId);
  }
  async list(userId) {
    const bases = await this.deps.bases(userId);
    return (await this.raw(userId)).map((c) => this.info(c, bases));
  }
  async views(userId) {
    return (await this.list(userId)).map((c) => ({ id: c.id, name: c.name, provider: c.provider, model: c.model, loopback: c.loopback }));
  }
  async one(userId, connectionId) {
    if (connectionId !== null)
      return this.host.connections.get(connectionId, userId);
    return (await this.raw(userId)).find((c) => c.isDefault) ?? null;
  }
  async profile(userId, connectionId) {
    const c = await this.one(userId, connectionId);
    if (c === null)
      return null;
    const serial = await this.deps.serialTools(userId);
    return { ...this.info(c, await this.deps.bases(userId)), cache: cacheBreakpoints(c.provider, c.metadata), parallelTools: !serial.includes(c.id) };
  }
  async loopbacks(userId) {
    const bases = await this.deps.bases(userId);
    return (await this.raw(userId)).filter((c) => this.loops(c, bases));
  }
  async resolve(userId, connectionId) {
    const c = await this.one(userId, connectionId);
    return c === null ? null : { connection: c, loopback: this.loops(c, await this.deps.bases(userId)) };
  }
  async isLoopback(userId, connectionId) {
    return (await this.resolve(userId, connectionId))?.loopback === true;
  }
  async ofChat(userId, chat) {
    const pin = chat.metadata.connection_profile_id;
    const all = await this.raw(userId);
    const c = (typeof pin === "string" && pin !== "" ? all.find((x) => x.id === pin) : undefined) ?? all.find((x) => x.isDefault) ?? null;
    return c === null ? null : { id: c.id, name: c.name, loopback: this.loops(c, await this.deps.bases(userId)) };
  }
}

// src/extension/backend/keys.ts
class Keys {
  host;
  deps;
  waiting = new Map;
  constructor(host, deps) {
    this.host = host;
    this.deps = deps;
  }
  async mint(userId) {
    const { registry, relays, settings, now, later } = this.deps;
    const key = `${KEY_PREFIX}${randomHex(256)}`;
    const hash = await sha256(key);
    await registry.change(userId, (r) => {
      r.key = { hash, print: hash.slice(0, 8), at: now() };
    });
    const relay = (await relays.linked(userId))[0];
    if (relay === undefined)
      return { key, connection: null };
    const ref = randomHex(64);
    const waitMs = (await settings.transport(userId)).link.connectionMs;
    const k = `${userId}\x00${ref}`;
    const { promise, resolve } = Promise.withResolvers();
    const cancel = later(waitMs, () => {
      this.waiting.delete(k);
      resolve(null);
    });
    this.waiting.set(k, (answer) => {
      cancel();
      this.waiting.delete(k);
      resolve(answer);
    });
    if (!relays.push(userId, relay.id, { link: LINK, type: "connection", ref, key }))
      this.waiting.get(k)?.(null);
    const made = await promise;
    if (made === null)
      this.host.log("warn", `[LumiAH] runtime "${relay.name}" didn't say it put the new loopback key in a connection`);
    else if (made.problem !== null)
      this.host.log("warn", `[LumiAH] runtime "${relay.name}" couldn't put the new loopback key in a connection: ${made.problem}`);
    return { key, connection: made?.connection ?? null };
  }
  async forget(userId) {
    await this.deps.registry.change(userId, (r) => {
      r.key = null;
    });
    return { key: null, connection: null };
  }
  made(userId, ref, connection, problem) {
    this.waiting.get(`${userId}\x00${ref}`)?.({ connection, problem });
  }
}

// src/shared/ui.ts
var UI_VERSION = 1;
var URL_SLOT = "{{url}}";
function chatAnswered(chat) {
  return chat.connection?.loopback === true;
}
var isId = (v2) => typeof v2 === "string" && v2.length > 0 && v2.length <= 256;
var isCount = (v2) => typeof v2 === "number" && Number.isSafeInteger(v2) && v2 >= 0;
var isSeq = (v2) => typeof v2 === "number" && Number.isSafeInteger(v2) && v2 >= 1;
var isPath = (v2) => Array.isArray(v2) && v2.every((key) => typeof key === "string");
var BODY = {
  "lah.hello": () => true,
  "lah.chat.get": (r) => isId(r.chatId),
  "lah.chat.set": (r) => isId(r.chatId) && typeof r.on === "boolean",
  "lah.live.open": (r) => isId(r.chatId),
  "lah.live.events": (r) => isId(r.chatId) && isId(r.turn) && isSeq(r.from),
  "lah.live.close": (r) => isId(r.chatId),
  "lah.turn.stop": (r) => isId(r.chatId) && isId(r.turn),
  "lah.turns.list": (r) => isId(r.chatId) && (r.cursor === null || isId(r.cursor)) && isCount(r.limit) && r.limit > 0,
  "lah.transcript.get": (r) => isId(r.chatId) && isId(r.transcript) && isSeq(r.from),
  "lah.prompt.get": (r) => isId(r.prompt),
  "lah.blob.get": (r) => isId(r.hash),
  "lah.session.rollback": (r) => isId(r.chatId) && isId(r.messageId) && isCount(r.swipe),
  "lah.settings.set": (r) => Array.isArray(r.set) && r.set.every((s) => isRecord(s) && isPath(s.path) && s.value !== undefined) && Array.isArray(r.reset) && r.reset.every(isPath),
  "lah.models.list": (r) => r.connectionId === null || isId(r.connectionId),
  "lah.text.set": (r) => isId(r.id) && typeof r.text === "string",
  "lah.text.reset": (r) => isId(r.id),
  "lah.key": (r) => r.op === "mint" || r.op === "forget",
  "lah.relay": (r) => (r.op === "rotate" || r.op === "forget") && isId(r.relay)
};
function uiRequestOf(raw) {
  if (!isRecord(raw) || raw.lah === undefined || typeof raw.type !== "string" || !raw.type.startsWith("lah."))
    return null;
  const reqId = typeof raw.reqId === "string" && raw.reqId !== "" ? raw.reqId : null;
  if (raw.lah !== UI_VERSION)
    return { malformed: `This page speaks version ${String(raw.lah)} of LumiAH's messages and the extension speaks ${UI_VERSION}: reload the page.`, reqId };
  if (reqId === null)
    return { malformed: "The request has no reqId.", reqId };
  if (!Object.hasOwn(BODY, raw.type))
    return { malformed: `There is no request ${raw.type}.`, reqId };
  const check2 = BODY[raw.type];
  if (!check2(raw))
    return { malformed: `The request ${raw.type} is malformed.`, reqId };
  return { request: raw };
}

// src/extension/backend/live.ts
var SEP = "\x00";
var chatKey = (userId, chatId) => `${userId}${SEP}${chatId}`;
var PINGS_WITHOUT = 2;

class LiveBuffer {
  host;
  env;
  byChat = new Map;
  byTurn = new Map;
  watchers = new Map;
  changed = [];
  constructor(host, env) {
    this.host = host;
    this.env = env;
  }
  onChange(listener) {
    this.changed.push(listener);
  }
  tell(userId) {
    for (const listener of this.changed)
      listener(userId);
  }
  send(turn, push) {
    const sessions = this.watchers.get(chatKey(turn.userId, turn.chatId));
    if (sessions === undefined)
      return;
    for (const session of sessions)
      this.host.frontend.send(push, turn.userId, session);
  }
  say(turn, change) {
    this.send(turn, { lah: UI_VERSION, type: "lah.live", chatId: turn.chatId, change });
  }
  viewOf(turn, events) {
    const partials = [...turn.partials].map(([agentId, p]) => ({ agentId, call: p.call, text: p.text, reasoning: p.reasoning, at: p.at }));
    return { chatId: turn.chatId, turn: turn.turn, kind: turn.kind, messageId: turn.messageId, startedAt: turn.startedAt, ended: turn.ended, events, partials };
  }
  async begin(userId, relay, facts) {
    const key = chatKey(userId, facts.chat);
    const earlier = this.byChat.get(key);
    if (earlier !== undefined)
      this.byTurn.delete(earlier.turn);
    const turn = { userId, chatId: facts.chat, turn: facts.turn, relay, kind: facts.kind, messageId: facts.target.message, startedAt: this.env.now(), ended: null, events: [], overAt: null, unnamed: 0, partials: new Map, answered: new Map };
    this.byChat.delete(key);
    this.byChat.set(key, turn);
    this.byTurn.set(turn.turn, turn);
    this.say(turn, { view: this.viewOf(turn, []) });
    this.tell(userId);
    const most = (await this.env.transport(userId)).live.chats;
    for (const [k, held] of [...this.byChat]) {
      if (this.byChat.size <= most)
        break;
      if (held.ended === null)
        continue;
      this.byChat.delete(k);
      this.byTurn.delete(held.turn);
      this.tell(held.userId);
    }
  }
  async push(userId, records) {
    const most = (await this.env.transport(userId)).live.events;
    let taken = 0;
    const fresh = new Map;
    for (const raw of records) {
      const record = raw;
      if (record === null || typeof record !== "object" || typeof record.turn !== "string" || typeof record.seq !== "number" || typeof record.event !== "object" || record.event === null)
        continue;
      const turn = this.byTurn.get(record.turn);
      if (turn === undefined || turn.userId !== userId)
        continue;
      if (record.seq <= turn.events.length) {
        taken++;
        continue;
      }
      if (record.seq !== turn.events.length + 1 || turn.events.length >= most)
        continue;
      const kept = { turn: turn.turn, chatId: turn.chatId, seq: record.seq, event: record.event };
      turn.events.push(kept);
      taken++;
      const list = fresh.get(turn) ?? [];
      list.push(kept);
      fresh.set(turn, list);
      const event = kept.event;
      if (event.kind === "turn_started")
        turn.startedAt = event.at;
      if (event.kind === "agent_entry" && (event.entry.kind === "answer" || event.entry.kind === "tools_refused" || event.entry.kind === "retry" || event.entry.kind === "stop"))
        turn.partials.delete(event.agentId);
      if (event.kind === "agent_entry" && event.entry.kind === "answer")
        turn.answered.set(event.agentId, (turn.answered.get(event.agentId) ?? 0) + 1);
      if (event.kind === "agent_idle")
        turn.partials.delete(event.agentId);
      if (event.kind === "turn_ended") {
        turn.partials.clear();
        if (turn.ended === null) {
          turn.ended = { state: event.status, at: event.at, ...event.reason !== undefined ? { reason: event.reason } : {} };
          this.tell(turn.userId);
        }
      }
    }
    for (const [turn, events] of fresh)
      this.say(turn, { turn: turn.turn, events, ended: turn.ended });
    return taken;
  }
  deltas(userId, relay, deltas) {
    for (const delta of deltas) {
      const turn = this.byTurn.get(delta.turn);
      if (turn === undefined || turn.userId !== userId || turn.relay !== relay || turn.ended !== null)
        continue;
      if (delta.text === undefined && delta.reasoning === undefined)
        continue;
      let partial = turn.partials.get(delta.agentId);
      if (delta.call <= (turn.answered.get(delta.agentId) ?? 0) || partial !== undefined && delta.call < partial.call)
        continue;
      if (partial === undefined || delta.call > partial.call) {
        partial = { call: delta.call, text: "", reasoning: "", at: delta.at };
        turn.partials.set(delta.agentId, partial);
      }
      const before = { text: partial.text.length, reasoning: partial.reasoning.length };
      if (delta.text !== undefined)
        partial.text += delta.text;
      if (delta.reasoning !== undefined)
        partial.reasoning += delta.reasoning;
      this.send(turn, { lah: UI_VERSION, type: "lah.live.delta", chatId: turn.chatId, delta: { turn: turn.turn, agentId: delta.agentId, call: delta.call, ...delta.text !== undefined ? { text: delta.text } : {}, ...delta.reasoning !== undefined ? { reasoning: delta.reasoning } : {}, before, at: delta.at } });
    }
  }
  lose(turn, reason) {
    if (turn.ended !== null)
      return;
    turn.partials.clear();
    turn.ended = { state: "lost", at: this.env.now(), reason };
    this.say(turn, { turn: turn.turn, events: [], ended: turn.ended });
    this.tell(turn.userId);
  }
  named(userId, relay, turns) {
    const named = new Set(turns);
    for (const turn of this.byTurn.values()) {
      if (turn.userId !== userId || turn.relay !== relay || turn.ended !== null)
        continue;
      if (named.has(turn.turn))
        turn.unnamed = 0;
      else if (++turn.unnamed >= PINGS_WITHOUT)
        this.lose(turn, "The runtime stopped answering this reply without saying how it ended (it restarted, or its trace never arrived).");
    }
  }
  over(generationId) {
    const turn = this.byTurn.get(generationId);
    if (turn !== undefined && turn.overAt === null)
      turn.overAt = this.env.now();
  }
  async tick() {
    const now = this.env.now();
    for (const turn of [...this.byTurn.values()]) {
      if (turn.ended !== null || turn.overAt === null)
        continue;
      const lostMs = (await this.env.transport(turn.userId)).live.lostMs;
      if (now - turn.overAt > lostMs)
        this.lose(turn, "Lumiverse ended this reply's generation and the runtime never said how its turn ended.");
    }
  }
  relayOf(userId, chatId, turnId) {
    const turn = this.byTurn.get(turnId);
    return turn !== undefined && turn.userId === userId && turn.chatId === chatId && turn.ended === null ? turn.relay : null;
  }
  runningOf(userId) {
    const out = [];
    for (const turn of this.byChat.values())
      if (turn.userId === userId && turn.ended === null)
        out.push({ chatId: turn.chatId, turn: turn.turn, kind: turn.kind, startedAt: turn.startedAt });
    return out;
  }
  chatsOf(userId) {
    const out = [];
    for (const turn of this.byChat.values())
      if (turn.userId === userId)
        out.push(turn.chatId);
    return out;
  }
  async open(userId, chatId, session) {
    const key = chatKey(userId, chatId);
    if (session !== undefined) {
      const sessions = this.watchers.get(key) ?? new Set;
      sessions.add(session);
      this.watchers.set(key, sessions);
    }
    const turn = this.byChat.get(key);
    if (turn === undefined)
      return { live: null, next: null };
    const page = (await this.env.transport(userId)).live.page;
    const events = turn.events.slice(0, page);
    return { live: this.viewOf(turn, events), next: turn.events.length > events.length ? events.length + 1 : null };
  }
  async events(userId, chatId, turnId, from) {
    const turn = this.byChat.get(chatKey(userId, chatId));
    if (turn === undefined || turn.turn !== turnId)
      return null;
    const page = (await this.env.transport(userId)).live.page;
    const events = turn.events.slice(from - 1, from - 1 + page);
    const read2 = from - 1 + events.length;
    return { events, next: turn.events.length > read2 ? read2 + 1 : null };
  }
  close(userId, chatId, session) {
    if (session === undefined)
      return;
    const key = chatKey(userId, chatId);
    const sessions = this.watchers.get(key);
    if (sessions === undefined)
      return;
    sessions.delete(session);
    if (sessions.size === 0)
      this.watchers.delete(key);
  }
  sessionClosed(session) {
    for (const [key, sessions] of this.watchers) {
      sessions.delete(session);
      if (sessions.size === 0)
        this.watchers.delete(key);
    }
  }
}

// src/extension/backend/models.ts
var isMessage = (m) => isRecord2(m) && (m.role === "system" || m.role === "user" || m.role === "assistant") && typeof m.content === "string" && (m.parts === undefined || Array.isArray(m.parts));
var isTool = (t) => isRecord2(t) && typeof t.name === "string" && typeof t.description === "string" && isRecord2(t.parameters);
function requestOf(raw) {
  if (!isRecord2(raw) || !Array.isArray(raw.messages) || !raw.messages.every(isMessage))
    return null;
  if (typeof raw.maxTokens !== "number" || !Number.isFinite(raw.maxTokens) || raw.maxTokens <= 0)
    return null;
  if (!(raw.connectionId === null || typeof raw.connectionId === "string") || !(raw.model === null || typeof raw.model === "string"))
    return null;
  if (raw.tools !== undefined && !(Array.isArray(raw.tools) && raw.tools.every(isTool)))
    return null;
  return raw;
}
function streamOf(raw) {
  if (typeof raw !== "string" || !STREAM_ID.test(raw))
    throw new LinkRefused("bad_request", "A stream is named by 32 hex characters: update the runtime and LumiAH to the same build.");
  return raw;
}

class Models {
  host;
  deps;
  constructor(host, deps) {
    this.host = host;
    this.deps = deps;
  }
  async run(userId, writer, connectionId, who, make, deltas) {
    try {
      const found = await this.deps.connections.resolve(userId, connectionId);
      if (found === null) {
        writer.error(connectionId === null ? `${who} uses your default connection, and this account has none. Pick a connection in LumiAH's settings, or set a default one in Lumiverse.` : `${who} uses a connection that is no longer there. Pick another in LumiAH's settings.`, "connection");
        return;
      }
      if (found.loopback) {
        writer.error(`${who} is set to "${found.connection.name}", which is LumiAH's own loopback connection: a call on it would come back to the runtime and wait on itself. Pick another connection in LumiAH's settings${connectionId === null ? " (it is your default connection now)" : ""}.`, "loopback");
        return;
      }
      writer.done(await make(found.connection, deltas ? writer.delta : () => {
        return;
      }));
    } catch (error) {
      writer.error(wordsOf(error), writer.signal.aborted ? "cancelled" : "model_failed");
    }
  }
  async call(caller, fields) {
    const stream = streamOf(fields.stream);
    const request = requestOf(fields.request);
    if (request === null)
      throw new LinkRefused("bad_request", "The model call is malformed: update the runtime and LumiAH to the same build.");
    const turn = typeof fields.turn === "string" && fields.turn !== "" ? fields.turn : null;
    const { streams, settings } = this.deps;
    const writer = streams.open(caller.userId, caller.relay.id, stream, turn, (await settings.transport(caller.userId)).streams);
    if (writer === null)
      return { accepted: true };
    this.run(caller.userId, writer, request.connectionId, "This agent", (connection, onDelta) => {
      const { parallelToolCalls: _serial, ...plain } = request;
      return this.host.models.call(request.parallelToolCalls === false && !takesParallelFlag(connection.provider) ? plain : request, caller.userId, writer.signal, onDelta);
    }, request.stream === true);
    return { accepted: true };
  }
  async pass(caller, fields) {
    const stream = streamOf(fields.stream);
    const { key, connection, messages, tools, parameters } = fields;
    if (typeof key !== "string" || !(connection === null || typeof connection === "string") || !Array.isArray(messages) || !messages.every(isMessage) || !Array.isArray(tools) || !tools.every(isTool) || !isRecord2(parameters)) {
      throw new LinkRefused("bad_request", "The passed-through request is malformed: update the runtime and LumiAH to the same build.");
    }
    if (!await this.deps.registry.keyIs(caller.userId, key))
      throw new LinkRefused("forbidden", "The key in the loopback connection isn't this account's loopback key. Mint a new one on LumiAH's Runtime page: your linked runtime puts it in the connection.");
    const { streams, settings } = this.deps;
    const writer = streams.open(caller.userId, caller.relay.id, stream, null, (await settings.transport(caller.userId)).streams);
    if (writer === null)
      return { accepted: true };
    this.run(caller.userId, writer, connection, "A request that reached LumiAH's loopback without a turn is passed to the writer, which", (_connection, onDelta) => this.host.models.pass({ connectionId: connection, messages, tools, parameters: toJsonObject(parameters) }, caller.userId, writer.signal, onDelta), true);
    return { accepted: true };
  }
}

// src/extension/backend/reads.ts
var blobPath = (hash) => `blobs/${hash.slice(0, 2)}/${hash}`;
var DOC_PATH = /^(?!.*(?:^|\/)\.{1,2}(?:\/|$))[A-Za-z0-9._-]{1,128}(?:\/[A-Za-z0-9._-]{1,128}){0,7}$/;

class Storage {
  host;
  constructor(host) {
    this.host = host;
  }
  static hash(hash) {
    if (typeof hash !== "string" || !BLOB_HASH.test(hash))
      throw new LinkRefused("bad_request", "A blob is named by its SHA-256 hash, in lower-case hex.");
    return hash;
  }
  static path(path) {
    if (typeof path !== "string" || !DOC_PATH.test(path))
      throw new LinkRefused("bad_request", "A document's path is names of letters, digits, '.', '_' and '-' joined by '/'.");
    return `docs/${path}`;
  }
  blob(userId, hash) {
    return this.host.storage.read(blobPath(Storage.hash(hash)), userId);
  }
  async putBlob(userId, hash, text) {
    if (typeof text !== "string")
      throw new LinkRefused("bad_request", "A blob is text.");
    await this.host.storage.write(blobPath(Storage.hash(hash)), text, userId);
  }
  blobSize(userId, hash) {
    return this.host.storage.size(blobPath(Storage.hash(hash)), userId);
  }
  async doc(userId, path) {
    const text = await this.host.storage.read(Storage.path(path), userId);
    if (text === null)
      return null;
    try {
      return JSON.parse(text);
    } catch {
      return null;
    }
  }
  async putDoc(userId, path, doc) {
    if (doc === undefined)
      throw new LinkRefused("bad_request", "A document needs a value.");
    await this.host.storage.write(Storage.path(path), JSON.stringify(doc), userId);
  }
  async removeDoc(userId, path) {
    await this.host.storage.remove(Storage.path(path), userId);
  }
}
function ids(value) {
  return Array.isArray(value) ? value.filter((id) => typeof id === "string" && id !== "") : [];
}

class Lore {
  host;
  deps;
  constructor(host, deps) {
    this.host = host;
    this.deps = deps;
  }
  async books(userId, chat) {
    const { lore } = this.host;
    const persona = this.deps.persona(userId, chat.id);
    const wanted = [
      ...ids(chat.metadata.chat_world_book_ids),
      ...chat.characterId !== null ? await lore.ofCharacter(chat.characterId, userId).catch(() => []) : [],
      persona === null ? null : await lore.ofPersona(persona ?? null, userId).catch(() => null),
      ...await lore.global(userId).catch(() => []),
      ...this.deps.activatedBooks(userId, chat.id)
    ];
    const out = [];
    const seen = new Set;
    for (const id of wanted) {
      if (id === null || seen.has(id))
        continue;
      seen.add(id);
      const book = await lore.book(id, userId).catch(() => null);
      if (book !== null)
        out.push({ id: book.id, name: book.name, description: book.description });
    }
    return out;
  }
  async entries(userId, bookId) {
    if (typeof bookId !== "string" || bookId === "")
      throw new LinkRefused("bad_request", "A world book is named by its id.");
    if (await this.host.lore.book(bookId, userId) === null)
      return [];
    return (await this.host.lore.entries(bookId, userId)).map((e) => ({ id: e.id, bookId: e.bookId, title: e.title, keys: e.keys, secondaryKeys: e.secondaryKeys, content: e.content, enabled: e.enabled, constant: e.constant }));
  }
}

class Presets {
  host;
  constructor(host) {
    this.host = host;
  }
  async blocks(userId, presetId, chatId) {
    if (typeof presetId !== "string" || presetId === "")
      throw new LinkRefused("bad_request", "A preset is named by its id.");
    const blocks = await this.host.presets.blocks(presetId, userId);
    if (blocks === null)
      return [];
    const active = chatId === null ? null : await this.host.presets.active(chatId, userId).catch(() => null);
    const states = active !== null && active.presetId === presetId ? active.states : {};
    return blocks.map((b) => ({ id: b.id, name: b.name, role: b.role, kind: b.marker === null ? "instruction" : "marker", marker: b.marker, content: b.content, enabled: states[b.id] ?? b.enabled }));
  }
}

// src/link/frames.ts
var text = (v2) => typeof v2 === "string";
var count = (v2) => typeof v2 === "number" && Number.isSafeInteger(v2) && v2 >= 0;
var REQUEST_TYPES = {
  register: true,
  hello: true,
  ping: true,
  models: true,
  "turn.begin": true,
  "turn.commit": true,
  passthrough: true,
  "model.call": true,
  "stream.ack": true,
  "stream.resend": true,
  "stream.cancel": true,
  "settings.get": true,
  "trace.push": true,
  "setup.connection": true,
  "blob.get": true,
  "blob.put": true,
  "doc.get": true,
  "doc.put": true,
  "doc.remove": true,
  "chat.path": true,
  "chat.messages": true,
  "chat.anchor": true,
  "lore.books": true,
  "lore.entries": true,
  "lore.activated": true,
  "preset.blocks": true,
  "connections.list": true,
  "connections.get": true
};
function isLinkFrame(raw) {
  return isRecord2(raw) && raw.link === LINK;
}
function requestOf2(raw) {
  if (!isLinkFrame(raw))
    return null;
  const id = text(raw.id) && raw.id !== "" ? raw.id : null;
  if (id === null)
    return { malformed: "A link request has no id.", id: null };
  if (!text(raw.type) || !hasOwn2(REQUEST_TYPES, raw.type))
    return { malformed: `There is no link request ${String(raw.type)}: update LumiAH in Lumiverse, or the runtime, so both are the same build.`, id };
  return { request: raw };
}
function deltaOf(raw) {
  if (!isRecord2(raw) || !text(raw.turn) || !text(raw.chatId) || !text(raw.agentId) || !count(raw.call) || raw.call < 1 || typeof raw.at !== "number")
    return null;
  if (raw.text !== undefined && !text(raw.text) || raw.reasoning !== undefined && !text(raw.reasoning))
    return null;
  return { turn: raw.turn, chatId: raw.chatId, agentId: raw.agentId, call: raw.call, ...raw.text !== undefined ? { text: raw.text } : {}, ...raw.reasoning !== undefined ? { reasoning: raw.reasoning } : {}, at: raw.at };
}
function noticeOf(raw) {
  if (!isLinkFrame(raw) || raw.type !== "trace.deltas" || !Array.isArray(raw.deltas))
    return null;
  return { link: LINK, type: "trace.deltas", deltas: raw.deltas.flatMap((d) => deltaOf(d) ?? []) };
}
var REPORT_TEXT_MAX = 255;
var REPORT_PATH_MAX = 4096;
var SCHEDULER = { excluded: true, missing: true, unavailable: true, unknown: true };
function runtimeReportOf(raw) {
  if (!isRecord2(raw) || !isRecord2(raw.runtime) || !isRecord2(raw.session))
    return null;
  const short = (v2) => text(v2) && v2.length <= REPORT_TEXT_MAX;
  const path = (v2) => text(v2) && v2.length <= REPORT_PATH_MAX;
  const { name, build, host, listen, port, scheduler, turns } = raw;
  const { bun, script, unit } = raw.runtime;
  const { valid, expiresAt, checkedAt } = raw.session;
  if (!short(name) || !short(build) || !short(host) || !short(listen) || !count(port) || port < 1 || port > 65535 || !text(scheduler) || !hasOwn2(SCHEDULER, scheduler) || !count(turns))
    return null;
  if (!(bun === null || path(bun)) || !path(script) || !(unit === null || short(unit)))
    return null;
  if (!(valid === null || typeof valid === "boolean") || !(expiresAt === null || short(expiresAt)) || !(checkedAt === null || typeof checkedAt === "number"))
    return null;
  return { name, build, runtime: { bun, script, unit }, host, listen, port, scheduler, session: { valid, expiresAt, checkedAt }, turns };
}

// src/extension/backend/registry.ts
var FILE = "registry.json";
var port = (value) => typeof value === "number" && Number.isInteger(value) && value >= 1 && value <= 65535;
function registryOf(raw) {
  if (!isRecord2(raw) || raw.v !== 1)
    return null;
  const out = { v: 1, key: null, relays: {}, replied: raw.replied === true };
  const k = raw.key;
  if (isRecord2(k) && typeof k.hash === "string" && typeof k.print === "string" && typeof k.at === "number")
    out.key = { hash: k.hash, print: k.print, at: k.at };
  if (isRecord2(raw.relays)) {
    for (const [id, x] of Object.entries(raw.relays)) {
      if (!isRecord2(x) || typeof x.name !== "string" || typeof x.secret !== "string" || !port(x.port))
        continue;
      out.relays[id] = { id, name: x.name, secret: x.secret, build: typeof x.build === "string" ? x.build : "", host: typeof x.host === "string" ? x.host : "", listen: typeof x.listen === "string" ? x.listen : "127.0.0.1", port: x.port, registeredAt: typeof x.registeredAt === "number" ? x.registeredAt : 0, report: runtimeReportOf(x.report) };
    }
  }
  return out;
}

class RegistryStore {
  docs;
  constructor(host) {
    this.docs = new UserDocs(host, FILE, registryOf, () => ({ v: 1, key: null, relays: {}, replied: false }));
  }
  read(userId) {
    return this.docs.get(userId);
  }
  change(userId, fn) {
    return this.docs.change(userId, fn);
  }
  async keyIs(userId, key) {
    const stored = (await this.read(userId)).key;
    return stored !== null && stored.hash === await sha256(key);
  }
  settle() {
    return this.docs.settle();
  }
}

// src/extension/backend/relays.ts
var SEP2 = "\x00";
var key = (userId, relay) => `${userId}${SEP2}${relay}`;
var short = (v2) => typeof v2 === "string" && v2.length <= REPORT_TEXT_MAX;
var installOf = (r) => r === null ? "" : JSON.stringify([r.name, r.build, r.runtime, r.host, r.listen, r.port]);

class Relays {
  host;
  registry;
  settings;
  env;
  live = new Map;
  sessions = new Map;
  outgoing = new Map;
  changed = [];
  pinged = [];
  constructor(host, registry, settings, env) {
    this.host = host;
    this.registry = registry;
    this.settings = settings;
    this.env = env;
  }
  onChange(listener) {
    this.changed.push(listener);
  }
  onPing(listener) {
    this.pinged.push(listener);
  }
  tell(userId) {
    for (const listener of this.changed)
      listener(userId);
  }
  liveOf(userId, relay) {
    const k = key(userId, relay);
    let live = this.live.get(k);
    if (live === undefined) {
      live = { session: null, seenAt: null, report: null, refused: null, turns: [], shown: "down" };
      this.live.set(k, live);
    }
    return live;
  }
  stateOf(live, quietMs) {
    if (live === undefined)
      return "down";
    if (live.refused !== null)
      return "refused";
    if (live.session === null || live.seenAt === null)
      return "down";
    return this.env.now() - live.seenAt <= quietMs ? "linked" : "quiet";
  }
  async follow(userId, live) {
    const state = this.stateOf(live, (await this.settings.transport(userId)).link.quietMs);
    if (state === live.shown)
      return;
    live.shown = state;
    this.tell(userId);
  }
  async authenticate(secret, userId, session) {
    const refused = new LinkRefused("forbidden", "LumiAH doesn't know this runtime (its registration was forgotten or replaced): run its start line on LumiAH's Runtime page again.");
    if (typeof secret !== "string" || secret === "")
      throw refused;
    const hash = await sha256(secret);
    const relays = (await this.registry.read(userId)).relays;
    let relay = Object.values(relays).find((r) => r.secret === hash);
    if (relay !== undefined)
      this.outgoing.delete(key(userId, relay.id));
    else {
      relay = Object.values(relays).find((r) => {
        const old = this.outgoing.get(key(userId, r.id));
        return old !== undefined && old.hash === hash && this.env.now() <= old.until;
      });
      if (relay === undefined)
        throw refused;
    }
    const live = this.liveOf(userId, relay.id);
    if (live.session !== session) {
      if (live.session !== null)
        this.sessions.delete(live.session);
      live.session = session;
      this.sessions.set(session, key(userId, relay.id));
    }
    return { userId, relay, session };
  }
  async register(fields, userId) {
    const { name, build, host, listen, port: port2 } = fields;
    if (typeof name !== "string" || !RUNTIME_NAME.test(name))
      throw new LinkRefused("bad_request", "A runtime's name is lowercase letters, digits, _ and -, up to 40.");
    if (!short(build) || !short(host) || !short(listen) || listen === "" || typeof port2 !== "number" || !Number.isInteger(port2) || port2 < 1 || port2 > 65535)
      throw new LinkRefused("bad_request", "The runtime's registration is malformed: update the runtime and LumiAH to the same build.");
    const most = (await this.settings.transport(userId)).link.relays;
    const secret = randomHex(256);
    const hash = await sha256(secret);
    const now = this.env.now();
    const id = await this.registry.change(userId, (registry) => {
      const held = Object.values(registry.relays).find((r) => r.name === name);
      if (held === undefined && Object.keys(registry.relays).length >= most)
        return null;
      const relay = held?.id ?? randomHex(64);
      registry.relays[relay] = { id: relay, name, secret: hash, build, host, listen, port: port2, registeredAt: now, report: held?.report ?? null };
      return relay;
    });
    if (id === null)
      throw new LinkRefused("conflict", `This account has ${most} runtimes registered already: forget one on LumiAH's Runtime page first.`);
    const live = this.liveOf(userId, id);
    if (live.session !== null)
      this.sessions.delete(live.session);
    live.session = null;
    live.refused = null;
    this.outgoing.delete(key(userId, id));
    this.host.log("info", `[LumiAH] runtime "${name}" registered`);
    this.tell(userId);
    return { relay: id, secret, model: MODEL_ID, user: userId };
  }
  async hello(caller, fields) {
    const live = this.liveOf(caller.userId, caller.relay.id);
    const version = fields.version;
    if (typeof version !== "number" || !Number.isSafeInteger(version))
      throw new LinkRefused("bad_request", "The runtime's hello names no link version: update the runtime with its start line on LumiAH's Runtime page.");
    if (version !== LINK_VERSION) {
      live.refused = versionWords(version, LINK_VERSION);
      live.seenAt = this.env.now();
      const report = runtimeReportOf(fields.report);
      if (report !== null)
        live.report = report;
      live.shown = "refused";
      this.tell(caller.userId);
      throw new LinkRefused("version", live.refused);
    }
    live.refused = null;
    await this.heard(caller, fields.report);
  }
  async ping(caller, fields) {
    const turns = Array.isArray(fields.turns) ? fields.turns.filter((t) => typeof t === "string") : [];
    this.liveOf(caller.userId, caller.relay.id).turns = turns;
    await this.heard(caller, fields.report);
    for (const listener of this.pinged)
      listener(caller.userId, caller.relay.id, turns);
  }
  async heard(caller, rawReport) {
    const live = this.liveOf(caller.userId, caller.relay.id);
    const report = runtimeReportOf(rawReport);
    const before = JSON.stringify(live.report);
    live.seenAt = this.env.now();
    if (report !== null) {
      live.report = report;
      if (installOf(report) !== installOf(caller.relay.report)) {
        await this.registry.change(caller.userId, (registry) => {
          const held = registry.relays[caller.relay.id];
          if (held !== undefined)
            held.report = report;
        });
      }
    }
    if (before !== JSON.stringify(live.report)) {
      live.shown = this.stateOf(live, (await this.settings.transport(caller.userId)).link.quietMs);
      this.tell(caller.userId);
    } else
      await this.follow(caller.userId, live);
  }
  sessionClosed(session) {
    const k = this.sessions.get(session);
    if (k === undefined)
      return;
    this.sessions.delete(session);
    const live = this.live.get(k);
    if (live === undefined || live.session !== session)
      return;
    live.session = null;
    live.turns = [];
    live.shown = this.stateOf(live, 0);
    this.tell(k.slice(0, k.indexOf(SEP2)));
  }
  async tick() {
    const now = this.env.now();
    for (const [k, old] of this.outgoing)
      if (now > old.until)
        this.outgoing.delete(k);
    for (const [k, live] of this.live)
      if (live.session !== null)
        await this.follow(k.slice(0, k.indexOf(SEP2)), live).catch(() => {
          return;
        });
  }
  push(userId, relay, push) {
    const session = this.live.get(key(userId, relay))?.session ?? null;
    if (session === null)
      return false;
    this.env.send(push, userId, session);
    return true;
  }
  async linked(userId) {
    const quietMs = (await this.settings.transport(userId)).link.quietMs;
    const seen = (r) => this.live.get(key(userId, r.id))?.seenAt ?? 0;
    return Object.values((await this.registry.read(userId)).relays).filter((r) => this.stateOf(this.live.get(key(userId, r.id)), quietMs) === "linked").sort((a, b) => seen(b) - seen(a));
  }
  async bases(userId) {
    return Object.values((await this.registry.read(userId)).relays).map((r) => runtimeBase(r.listen, r.port));
  }
  async rotate(userId, relay) {
    const held = (await this.registry.read(userId)).relays[relay];
    if (held === undefined)
      throw new LinkRefused("not_found", "There is no such runtime.");
    const transport = await this.settings.transport(userId);
    if (this.stateOf(this.live.get(key(userId, relay)), transport.link.quietMs) !== "linked")
      throw new LinkRefused("unavailable", "This runtime isn't linked now, so it couldn't take a new secret. Start it first, or forget it and run its start line again.");
    const secret = randomHex(256);
    const hash = await sha256(secret);
    this.outgoing.set(key(userId, relay), { hash: held.secret, until: this.env.now() + transport.runtime.requestMs });
    await this.registry.change(userId, (r) => {
      const record = r.relays[relay];
      if (record !== undefined)
        record.secret = hash;
    });
    this.push(userId, relay, { link: LINK, type: "secret", relay, secret });
    this.tell(userId);
  }
  async forget(userId, relay) {
    const found = await this.registry.change(userId, (r) => {
      if (r.relays[relay] === undefined)
        return false;
      delete r.relays[relay];
      return true;
    });
    if (!found)
      throw new LinkRefused("not_found", "There is no such runtime.");
    const k = key(userId, relay);
    const session = this.live.get(k)?.session ?? null;
    if (session !== null)
      this.sessions.delete(session);
    this.live.delete(k);
    this.outgoing.delete(k);
    this.tell(userId);
  }
  relayOf(userId, session) {
    const bound = this.sessions.get(session);
    return bound !== undefined && bound.startsWith(`${userId}${SEP2}`) ? bound.slice(userId.length + SEP2.length) : null;
  }
  turnsOf(userId, relay) {
    return this.live.get(key(userId, relay))?.turns ?? [];
  }
  reachable(userId, relay) {
    return (this.live.get(key(userId, relay))?.session ?? null) !== null;
  }
  async view(userId, issues) {
    const quietMs = (await this.settings.transport(userId)).link.quietMs;
    const { bun, dir } = this.host.install;
    const script = dir === null ? null : `${dir}/lumiah.js`;
    const relays = Object.values((await this.registry.read(userId)).relays).sort((a, b) => a.registeredAt - b.registeredAt).map((r) => {
      const live = this.live.get(key(userId, r.id));
      const report = live?.report ?? r.report;
      const link = this.stateOf(live, quietMs);
      if (live !== undefined)
        live.shown = link;
      const unit = report?.runtime.unit ?? null;
      const updateBun = bun ?? report?.runtime.bun ?? null;
      const loginBun = report?.runtime.bun ?? bun;
      const problem = link === "linked" ? null : link === "refused" ? live?.refused ?? null : link === "quiet" ? `LumiAH hasn't heard from this runtime for over ${Math.round(quietMs / 1000)} seconds. Check that it is still running${unit !== null ? ` (systemctl --user status ${unit})` : ""}.` : `This runtime isn't connected to Lumiverse now. ${unit !== null ? `Check its service (systemctl --user status ${unit}), or run its update line.` : "Start it with its line."}`;
      return {
        id: r.id,
        name: r.name,
        build: report?.build ?? null,
        host: report?.host ?? null,
        url: report === null ? null : runtimeBase(report.listen, report.port),
        registeredAt: r.registeredAt,
        seenAt: live?.seenAt ?? null,
        link,
        problem,
        update: report !== null && report.build !== this.env.build,
        turns: live?.turns.length ?? 0,
        unit,
        session: { valid: live?.report?.session.valid ?? null, endsAt: live?.report?.session.expiresAt ?? null },
        scheduler: live?.report?.scheduler ?? "unknown",
        lines: {
          update: updateBun !== null && script !== null ? [updateBun, script, "up", "--name", r.name, ...unit !== null ? ["--systemd"] : []].map(shellWord).join(" ") : null,
          login: report !== null && loginBun !== null ? [loginBun, report.runtime.script, "login", "--name", r.name].map(shellWord).join(" ") : null
        }
      };
    });
    const missing = [...bun === null ? ["the path of Lumiverse's Bun (use the full path of your own bun)"] : [], ...script === null ? ["where this extension is installed (the runtime is dist/lumiah.js in LumiAH's extension folder)"] : []];
    const line = (systemd) => bun === null || script === null ? null : `${[bun, script, "up", "--url"].map(shellWord).join(" ")} ${URL_SLOT}${systemd ? " --systemd" : ""}`;
    return { build: this.env.build, link: LINK_VERSION, model: MODEL_ID, relays, start: { service: line(true), foreground: line(false), missing }, issues };
  }
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
  const count2 = Math.max(1, Math.ceil(text2.length / PART_UNITS));
  const parts = [];
  for (let index = 0;index < count2; index++)
    parts.push({ link: LINK, type: "part", id, index, count: count2, data: text2.slice(index * PART_UNITS, (index + 1) * PART_UNITS) });
  return parts;
}
function partOf(raw) {
  if (!isRecord2(raw) || raw.link !== LINK || raw.type !== "part")
    return null;
  const { id, index, count: count2, data } = raw;
  if (typeof id !== "string" || id === "" || typeof data !== "string")
    return null;
  if (typeof index !== "number" || typeof count2 !== "number" || !Number.isSafeInteger(index) || !Number.isSafeInteger(count2) || count2 < 1 || index < 0 || index >= count2)
    return null;
  return { link: LINK, type: "part", id, index, count: count2, data };
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

// src/extension/backend/server.ts
var text2 = (v2, what) => {
  if (typeof v2 !== "string" || v2 === "")
    throw new LinkRefused("bad_request", `The request names no ${what}: update the runtime and LumiAH to the same build.`);
  return v2;
};
var whole3 = (v2, what) => {
  if (typeof v2 !== "number" || !Number.isSafeInteger(v2) || v2 < 0)
    throw new LinkRefused("bad_request", `The request's ${what} isn't a whole number: update the runtime and LumiAH to the same build.`);
  return v2;
};
var streamId = (v2) => {
  if (typeof v2 !== "string" || !STREAM_ID.test(v2))
    throw new LinkRefused("bad_request", "A stream is named by 32 hex characters: update the runtime and LumiAH to the same build.");
  return v2;
};
var strings = (v2) => Array.isArray(v2) ? v2.filter((s) => typeof s === "string") : [];
function openOf(v2) {
  if (!Array.isArray(v2))
    return [];
  return v2.flatMap((o) => isRecord2(o) && typeof o.stream === "string" && typeof o.seq === "number" && Number.isSafeInteger(o.seq) && o.seq >= 0 ? [{ stream: o.stream, seq: o.seq }] : []);
}

class LinkServer {
  host;
  deps;
  joiners = new Map;
  limits = new Map;
  constructor(host, deps) {
    this.host = host;
    this.deps = deps;
  }
  send(frame, userId, session, id = randomHex(64)) {
    const whole4 = JSON.stringify(frame);
    if (!needsParts(whole4)) {
      this.host.frontend.send(frame, userId, session);
      return;
    }
    const parts = splitFrame(whole4, id);
    const next = (at) => {
      const part = parts[at];
      if (part === undefined)
        return;
      this.host.frontend.send(part, userId, session);
      this.deps.later(0, () => next(at + 1));
    };
    next(0);
  }
  answer(id, userId, session, body) {
    const frame = { link: LINK, type: "result", id, body };
    if (session === undefined)
      this.host.frontend.send(frame, userId);
    else
      this.send(frame, userId, session, id);
  }
  refuse(id, userId, session, code, message) {
    const frame = { link: LINK, type: "error", id, code, message };
    this.host.frontend.send(frame, userId, session);
  }
  sessionClosed(session) {
    this.joiners.get(session)?.clear();
    this.joiners.delete(session);
  }
  async frame(payload, userId, session) {
    if (!isLinkFrame(payload))
      return false;
    let raw = payload;
    const part = partOf(payload);
    if (part !== null) {
      const key2 = session ?? `user:${userId}`;
      let joiner = this.joiners.get(key2);
      if (joiner === undefined) {
        joiner = new PartJoiner(() => this.limits.get(userId) ?? { maxUnits: TRANSPORT_DEFAULTS.link.joinMaxUnits, staleMs: TRANSPORT_DEFAULTS.link.partStaleMs });
        this.joiners.set(key2, joiner);
      }
      if (!this.limits.has(userId)) {
        const { link } = await this.deps.settings.transport(userId);
        this.limits.set(userId, { maxUnits: link.joinMaxUnits, staleMs: link.partStaleMs });
      }
      const joined = joiner.take(part, this.deps.now());
      if ("waiting" in joined)
        return true;
      if ("refused" in joined) {
        this.refuse(joined.id, userId, session, "too_large", joined.refused);
        return true;
      }
      try {
        raw = JSON.parse(joined.text);
      } catch {
        this.refuse(part.id, userId, session, "bad_request", "A frame sent in parts didn't read as JSON once put together.");
        return true;
      }
    }
    const notice = noticeOf(raw);
    if (notice !== null) {
      const relay = session === undefined ? null : this.deps.relays.relayOf(userId, session);
      if (relay !== null)
        this.deps.live.deltas(userId, relay, notice.deltas);
      return true;
    }
    const read2 = requestOf2(raw);
    if (read2 === null)
      return isLinkFrame(raw);
    if ("malformed" in read2) {
      if (read2.id !== null)
        this.refuse(read2.id, userId, session, "bad_request", read2.malformed);
      return true;
    }
    const request = read2.request;
    try {
      if (session === undefined)
        throw new LinkRefused("unavailable", "This Lumiverse doesn't say which connection a runtime's requests come from, so LumiAH can't answer them: update Lumiverse.");
      this.answer(request.id, userId, session, await this.serve(request.type, request, userId, session));
    } catch (error) {
      if (error instanceof LinkRefused)
        this.refuse(request.id, userId, session, error.code, error.message);
      else {
        this.host.log("error", `[LumiAH] ${request.type} failed: ${wordsOf(error)}`);
        this.refuse(request.id, userId, session, "internal", `LumiAH couldn't do that (${wordsOf(error)}).`);
      }
    }
    return true;
  }
  settingsChanged(userId) {
    this.limits.delete(userId);
  }
  async serve(type, r, userId, session) {
    const d = this.deps;
    if (type === "register")
      return d.relays.register(r, userId);
    const caller = await d.relays.authenticate(r.secret, userId, session);
    const relay = caller.relay.id;
    switch (type) {
      case "hello": {
        await d.relays.hello(caller, r);
        return { relay, version: LINK_VERSION, build: d.build, lost: d.streams.resume(userId, relay, openOf(r.open)), settings: await d.settings.revision(userId) };
      }
      case "ping": {
        await d.relays.ping(caller, r);
        return { lost: d.streams.missing(userId, relay, strings(r.streams)) };
      }
      case "models": {
        if (typeof r.key !== "string" || !await d.registry.keyIs(userId, r.key))
          throw new LinkRefused("forbidden", "The key in the loopback connection isn't this account's loopback key. Mint a new one on LumiAH's Runtime page: your linked runtime puts it in the connection.");
        return { models: [{ id: MODEL_ID }] };
      }
      case "turn.begin":
        return d.turns.begin(userId, relay, r.key, r.tag, r.request);
      case "turn.commit":
        return { anchoring: await d.turns.commit(userId, r.turn, r.chat, r.target, r.record) };
      case "passthrough":
        return d.models.pass(caller, r);
      case "model.call":
        return d.models.call(caller, r);
      case "stream.ack":
        return { done: d.streams.ack(userId, relay, streamId(r.stream), whole3(r.seq, "chunk number")) };
      case "stream.resend":
        return { last: d.streams.resend(userId, relay, streamId(r.stream), whole3(r.from, "chunk number")) };
      case "stream.cancel":
        return { cancelled: d.streams.cancel(userId, relay, streamId(r.stream), typeof r.reason === "string" ? r.reason : "") };
      case "settings.get":
        return d.settings.snapshot(userId);
      case "trace.push":
        return { taken: await d.live.push(userId, Array.isArray(r.records) ? r.records : []) };
      case "setup.connection": {
        const made = isRecord2(r.connection) && typeof r.connection.id === "string" && typeof r.connection.name === "string" ? { id: r.connection.id, name: r.connection.name } : null;
        d.connectionMade(userId, text2(r.ref, "connection request"), made, typeof r.problem === "string" ? r.problem : null);
        return { taken: true };
      }
      case "blob.get":
        return { text: await d.storage.blob(userId, r.hash) };
      case "blob.put":
        await d.storage.putBlob(userId, r.hash, r.text);
        return { stored: true };
      case "doc.get":
        return { doc: await d.storage.doc(userId, r.path) };
      case "doc.put":
        await d.storage.putDoc(userId, r.path, r.doc);
        return { written: true };
      case "doc.remove":
        await d.storage.removeDoc(userId, r.path);
        return { removed: true };
      case "chat.path":
        return { messages: await d.chats.path(userId, text2(r.chat, "chat")) };
      case "chat.messages":
        return { messages: await d.chats.messages(userId, text2(r.chat, "chat"), whole3(r.from, "range"), whole3(r.to, "range")) };
      case "chat.anchor": {
        if (r.record === undefined || r.record === null)
          throw new LinkRefused("bad_request", "The request has no record.");
        return { written: await d.chats.anchor(userId, text2(r.chat, "chat"), text2(r.message, "message"), whole3(r.swipe, "swipe"), r.record) };
      }
      case "lore.books":
        return { books: await d.lore.books(userId, await d.chats.own(userId, text2(r.chat, "chat"))) };
      case "lore.entries":
        return { entries: await d.lore.entries(userId, r.book) };
      case "lore.activated":
        return { entries: await d.turns.activated(userId, text2(r.chat, "chat"), text2(r.generation, "generation")) };
      case "preset.blocks": {
        const chat = typeof r.chat === "string" && r.chat !== "" ? (await d.chats.own(userId, r.chat)).id : null;
        return { blocks: await d.presets.blocks(userId, r.preset, chat) };
      }
      case "connections.list":
        return { connections: await d.connections.list(userId) };
      case "connections.get":
        return { profile: await d.connections.profile(userId, typeof r.connection === "string" && r.connection !== "" ? r.connection : null) };
      default:
        throw new LinkRefused("bad_request", `There is no link request ${String(type)}.`);
    }
  }
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
  async put(text3, kept = true) {
    const hash = await textHash(text3);
    const under = this.writing.get(hash);
    if (under) {
      await under;
      return hash;
    }
    const write = this.host.blobs.put(hash, text3);
    this.writing.set(hash, write);
    try {
      await write;
    } finally {
      this.writing.delete(hash);
    }
    if (kept)
      this.remember(hash, text3);
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
    const text3 = await this.host.blobs.get(hash);
    if (text3 === null)
      return null;
    if (await textHash(text3) !== hash) {
      this.host.log("warn", `the stored blob ${hash} doesn't match its hash, so it is read as missing`);
      return null;
    }
    this.remember(hash, text3);
    return text3;
  }
  async getJson(hash) {
    const text3 = await this.get(hash);
    return text3 === null ? undefined : parseJson(text3);
  }
  remember(hash, text3) {
    const limit2 = this.keep();
    const before = this.kept.get(hash);
    if (before !== undefined) {
      this.kept.delete(hash);
      this.chars -= before.length;
    }
    if (text3.length <= limit2) {
      this.kept.set(hash, text3);
      this.chars += text3.length;
    }
    for (const [old, held] of this.kept) {
      if (this.chars <= limit2)
        break;
      this.kept.delete(old);
      this.chars -= held.length;
    }
  }
}

// src/core/prompts.ts
function storedOf(raw) {
  if (!isRecord(raw) || raw.v !== 1 || raw.kind !== "prompt" || !isRecord(raw.request) || !Array.isArray(raw.messages) || typeof raw.keep !== "number" || !Number.isSafeInteger(raw.keep) || raw.keep < 0)
    return null;
  if (raw.base !== null && !isHash(raw.base))
    return null;
  return raw;
}
async function readCallPrompt(blobs, hash) {
  const chain = [];
  for (let at = hash;at !== null; ) {
    if (!isHash(at))
      return null;
    const text3 = await blobs.get(at);
    if (text3 === null || await textHash(text3) !== at)
      return null;
    const stored = storedOf(parseJson(text3));
    if (!stored)
      return null;
    chain.push(stored);
    at = stored.keep > 0 ? stored.base : null;
  }
  let messages = [];
  for (const stored of chain.reverse()) {
    if (stored.keep > messages.length)
      return null;
    messages = [...messages.slice(0, stored.keep), ...stored.messages];
  }
  const own = chain.at(-1);
  return own ? { ...own.request, messages } : null;
}

// src/core/receipts.ts
function toldOf(segment, texts) {
  const vars = { reply: String(segment.reply), kind: segment.turn, count: texts.counted(segment.request.messages, TEXT.word.message) };
  return segment.request.last === null ? texts.render(TEXT.session.toldUnplaced, vars) : texts.render(TEXT.session.told, { ...vars, last: String(segment.request.last) });
}
function receiptOf(segment, chars, texts) {
  const reply = String(segment.reply);
  const short2 = (text3) => text3.length <= chars ? text3 : texts.render(TEXT.session.receiptClipped, { text: text3.slice(0, cutAt(text3, chars)), chars: String(text3.length), reply });
  const lines = segment.steps.map((step) => {
    if (step.kind === "said")
      return texts.render(TEXT.session.receiptSaid, { text: short2(step.text) });
    if (step.kind === "call")
      return texts.render(step.error ? TEXT.session.receiptFailed : TEXT.session.receiptCall, { tool: step.name, args: JSON.stringify(step.args), result: short2(step.result) });
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

// src/core/usage.ts
function emptyUsage() {
  return { calls: 0, toolTurns: 0, in: 0, cachedIn: 0, out: 0, reasoningOut: 0, estimated: false, ms: 0, cost: 0 };
}

// src/core/sessions.ts
var TURN_KINDS = ["new", "regenerate", "swipe", "continue"];
function isTurnKind(v2) {
  return typeof v2 === "string" && TURN_KINDS.includes(v2);
}
var isCount2 = (v2) => typeof v2 === "number" && Number.isSafeInteger(v2) && v2 >= 0;
function stepOf(raw) {
  if (!isRecord(raw))
    return null;
  if (raw.kind === "said" && typeof raw.text === "string")
    return { kind: "said", text: raw.text };
  if (raw.kind === "call" && typeof raw.name === "string" && isRecord(raw.args) && typeof raw.result === "string")
    return { kind: "call", name: raw.name, args: raw.args, result: raw.result, ...raw.error === true ? { error: true } : {} };
  if (raw.kind === "reply" && isCount2(raw.chars))
    return { kind: "reply", chars: raw.chars };
  if (raw.kind === "stop" && typeof raw.reason === "string")
    return { kind: "stop", reason: raw.reason };
  return null;
}
function segmentOf(raw) {
  if (!isRecord(raw) || raw.v !== 1 || raw.kind !== "segment" || !isCount2(raw.reply) || typeof raw.generationId !== "string" || !isTurnKind(raw.turn) || typeof raw.at !== "number" || !isRecord(raw.request) || !Array.isArray(raw.steps))
    return null;
  const { messages, last } = raw.request;
  return { v: 1, kind: "segment", reply: raw.reply, generationId: raw.generationId, turn: raw.turn, at: raw.at, request: { messages: isCount2(messages) ? messages : 0, last: isCount2(last) ? last : null }, steps: raw.steps.flatMap((s) => stepOf(s) ?? []) };
}
function usageOf(raw) {
  const out = emptyUsage();
  if (!isRecord(raw))
    return out;
  const n = (key2) => {
    const v2 = raw[key2];
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
    ...summary !== undefined ? { summary, kept: Array.isArray(anchor.kept) ? anchor.kept.filter(isHash) : [], folded: isCount2(anchor.folded) ? anchor.folded : 0 } : {},
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
async function rollback(host, chatId, messageId, swipeId) {
  const message = (await host.chat.path(chatId)).find((m) => m.id === messageId);
  if (!message)
    return { refused: "That reply is no longer on the chat's active path." };
  if (message.swipeId !== swipeId)
    return { refused: "The chat shows another swipe of that reply now. Switch to the swipe whose summary you want to roll back, then try again." };
  const record = recordOf(message.anchor);
  if (!record)
    return { refused: "That reply has no record of LumiAH's." };
  if (record.summary === undefined)
    return { refused: "No summary was made at that turn, so there is nothing to roll back." };
  if (record.rolledBack !== undefined)
    return { refused: "That summary was already rolled back." };
  const marked = { ...record, rolledBack: host.clock.now() };
  if (!await host.chat.anchor(chatId, messageId, swipeId, marked))
    return { refused: "That reply is gone, so its record couldn't be written." };
  return { record: marked };
}

// src/core/transcript.ts
function transcriptOf(text3) {
  const raw = parseJson(text3);
  if (!isRecord(raw) || raw.v !== 1 || raw.kind !== "transcript" || typeof raw.turn !== "string" || typeof raw.chatId !== "string" || typeof raw.startedAt !== "number" || !isRecord(raw.ended) || !Array.isArray(raw.events))
    return null;
  return raw;
}

// src/extension/backend/sessions.ts
function hashOf(raw, what) {
  if (!BLOB_HASH.test(raw))
    throw new UiRefused("bad_request", `${what} is named by its hash.`);
  return raw;
}
function rollbackState(turn, turns, standing) {
  const { record } = turn;
  if (record.summary === undefined)
    return "none";
  if (record.rolledBack !== undefined)
    return turns.some((t) => t.onPath && t.record.at > (record.rolledBack ?? 0)) ? "done" : "pending";
  return turn.onPath && record.summary === standing ? "available" : "none";
}

class SessionsPage {
  deps;
  constructor(deps) {
    this.deps = deps;
  }
  chatPort(userId) {
    const { chats } = this.deps;
    return {
      path: (chatId) => chats.path(userId, chatId),
      messages: (chatId, from, to) => chats.messages(userId, chatId, from, to),
      anchor: (chatId, messageId, swipeId, record) => chats.anchor(userId, chatId, messageId, swipeId, record)
    };
  }
  async session(userId, path) {
    const { storage, settings } = this.deps;
    const snapshot = await settings.snapshot(userId);
    const core = settingsOf(snapshot.values.core);
    const blobs = new Blobs({ blobs: { get: (hash) => storage.blob(userId, hash), put: async () => {
      return;
    } }, log: () => {
      return;
    } }, () => 0);
    const resumed = await new Sessions({ chat: { ...this.chatPort(userId), path: async () => path } }, blobs).resume({ chatId: "", target: { messageId: null, swipeId: 0 }, kind: "new" });
    const carried = carriedOf({ summary: resumed.summary, turns: resumed.turns }, { receiptChars: core.session.receiptChars, charsPerToken: core.loop.charsPerToken, texts: textsOf(snapshot.texts) });
    return { turns: resumed.turns.length, tokens: carried.tokens, summary: resumed.summary !== null, dropped: resumed.refs.dropped.length, missing: resumed.missing };
  }
  row(turn, turns, standing, preview) {
    const { record } = turn;
    return {
      turn: record.generationId,
      messageId: turn.messageId,
      index: turn.index,
      swipe: turn.swipeId,
      at: record.at,
      kind: record.kind,
      onPath: turn.onPath,
      preview,
      transcript: record.transcript ?? null,
      compaction: record.summary !== undefined ? { summary: record.summary, replaced: record.folded ?? 0, rollback: rollbackState(turn, turns, standing) } : null,
      usage: record.usage
    };
  }
  async previews(userId, chatId, turns) {
    const out = new Map;
    const chars = (await this.deps.settings.transport(userId)).sessions.previewChars;
    if (turns.length === 0 || chars === 0)
      return out;
    const indexes = turns.map((t) => t.index);
    const wanted = new Set(indexes);
    for (const m of await this.deps.chats.messages(userId, chatId, Math.min(...indexes), Math.max(...indexes) + 1)) {
      if (!wanted.has(m.index))
        continue;
      const text3 = m.content.replace(/\s+/g, " ").trim();
      out.set(m.index, text3.length > chars ? `${text3.slice(0, chars).trimEnd()}\u2026` : text3);
    }
    return out;
  }
  async list(userId, chatId, cursor, limit2) {
    const path = await this.deps.chats.path(userId, chatId);
    const turns = await pathTurns(path);
    const from = cursor === null ? 0 : Number(cursor);
    if (!Number.isSafeInteger(from) || from < 0)
      throw new UiRefused("bad_request", "That page of the chat's turns isn't one LumiAH gave.");
    const size = Math.min(limit2, (await this.deps.settings.transport(userId)).sessions.page);
    const page = [...turns].reverse().slice(from, from + size);
    const previews = await this.previews(userId, chatId, page);
    const standing = sessionAt(turns).summary;
    return {
      turns: page.map((t) => this.row(t, turns, standing, previews.get(t.index) ?? "")),
      next: from + page.length < turns.length ? String(from + page.length) : null,
      total: turns.length,
      session: await this.session(userId, path)
    };
  }
  async transcript(userId, chatId, hash, from) {
    await this.deps.chats.own(userId, chatId);
    const text3 = await this.deps.storage.blob(userId, hashOf(hash, "A transcript"));
    const stored = text3 === null ? null : transcriptOf(text3);
    if (stored === null || stored.chatId !== chatId)
      throw new UiRefused("not_found", "That turn's transcript is no longer stored.");
    const size = (await this.deps.settings.transport(userId)).live.page;
    const events = stored.events.slice(from - 1, from - 1 + size);
    const read2 = from - 1 + events.length;
    const { ended } = stored;
    return {
      view: { chatId, turn: stored.turn, kind: stored.generation, messageId: stored.messageId, startedAt: stored.startedAt, ended: { state: ended.status, at: ended.at, ...ended.reason !== undefined ? { reason: ended.reason } : {} }, events, partials: [] },
      next: stored.events.length > read2 ? read2 + 1 : null
    };
  }
  async prompt(userId, hash) {
    const prompt = await readCallPrompt({ get: (h) => this.deps.storage.blob(userId, h) }, hashOf(hash, "A call's prompt"));
    if (prompt === null)
      throw new UiRefused("not_found", "That call's prompt is no longer stored.");
    return prompt;
  }
  async blob(userId, hash) {
    const text3 = await this.deps.storage.blob(userId, hashOf(hash, "A stored text"));
    if (text3 === null)
      throw new UiRefused("not_found", "That text is no longer stored.");
    return text3;
  }
  async rollback(userId, chatId, messageId, swipe) {
    const { now } = this.deps;
    const done = await rollback({ chat: this.chatPort(userId), clock: { now, sleep: async () => {
      return;
    } } }, chatId, messageId, swipe);
    if ("refused" in done)
      throw new UiRefused("unavailable", done.refused);
    const path = await this.deps.chats.path(userId, chatId);
    const turns = await pathTurns(path);
    const turn = turns.find((t) => t.messageId === messageId && t.swipeId === swipe);
    if (turn === undefined)
      throw new UiRefused("not_found", "That reply is no longer on the chat's active path.");
    const previews = await this.previews(userId, chatId, [turn]);
    return { turn: this.row(turn, turns, sessionAt(turns).summary, previews.get(turn.index) ?? ""), session: await this.session(userId, path) };
  }
}

// src/extension/backend/settings.ts
class SettingsRefused extends Error {
  problems;
  constructor(message, problems) {
    super(message);
    this.problems = problems;
    this.name = "SettingsRefused";
  }
}
var FILE2 = "settings.json";
var FORBIDDEN_KEYS = Object.assign(Object.create(null), { __proto__: true, constructor: true, prototype: true });
var isPath2 = (v2) => Array.isArray(v2) && v2.every((k) => typeof k === "string");
function storedOf2(raw) {
  if (!isRecord2(raw) || raw.v !== 1)
    return null;
  const own = [];
  if (Array.isArray(raw.own)) {
    for (const o of raw.own)
      if (isRecord2(o) && isPath2(o.path) && o.path.length > 0 && o.value !== undefined)
        own.push({ path: o.path, value: o.value });
  }
  const texts = {};
  if (isRecord2(raw.texts)) {
    for (const [id, text3] of Object.entries(raw.texts))
      if (typeof text3 === "string")
        texts[id] = text3;
  }
  return { v: 1, rev: typeof raw.rev === "number" && Number.isSafeInteger(raw.rev) && raw.rev >= 0 ? raw.rev : 0, own, texts };
}
var clone2 = (value) => JSON.parse(JSON.stringify(value));
var within = (path, under) => under.length <= path.length && under.every((key2, i) => path[i] === key2);
function at(root, path) {
  let node = root;
  for (const key2 of path) {
    if (!isRecord2(node) || !hasOwn2(node, key2))
      return;
    node = node[key2];
  }
  return node;
}
function put(root, path, value) {
  let node = root;
  for (const key2 of path.slice(0, -1)) {
    const next = node[key2];
    if (!isRecord2(next))
      node[key2] = {};
    node = node[key2];
  }
  const last = path.at(-1);
  if (last === undefined)
    return;
  if (value === undefined)
    delete node[last];
  else
    node[last] = value;
}

class SettingsStore {
  sections;
  textsDef;
  docs;
  listeners = [];
  whole = new Map;
  constructor(host, sections, textsDef) {
    this.sections = sections;
    this.textsDef = textsDef;
    this.docs = new UserDocs(host, FILE2, storedOf2, () => ({ v: 1, rev: 0, own: [], texts: {} }));
  }
  onChange(listener) {
    this.listeners.push(listener);
  }
  defaults() {
    const out = {};
    for (const section of this.sections)
      out[section.key] = section.defaults();
    return out;
  }
  schema() {
    const properties = {};
    for (const section of this.sections)
      properties[section.key] = section.schema;
    return { type: "object", additionalProperties: false, properties };
  }
  valuesOf(own) {
    const values = this.defaults();
    for (const o of [...own].sort((a, b) => a.path.length - b.path.length))
      put(values, o.path, clone2(o.value));
    return values;
  }
  async current(userId) {
    const stored = await this.docs.get(userId);
    const held = this.whole.get(userId);
    if (held !== undefined && held.rev === stored.rev)
      return held;
    const values = this.valuesOf(stored.own);
    const now = { rev: stored.rev, values, transport: transportOf(values[TRANSPORT_KEY]) };
    this.whole.set(userId, now);
    return now;
  }
  async values(userId) {
    return (await this.current(userId)).values;
  }
  async transport(userId) {
    return (await this.current(userId)).transport;
  }
  async revision(userId) {
    return (await this.docs.get(userId)).rev;
  }
  async snapshot(userId) {
    const { rev, values } = await this.current(userId);
    return { revision: rev, values, texts: { ...(await this.docs.get(userId)).texts } };
  }
  async view(userId) {
    return { values: await this.values(userId), defaults: this.defaults(), schema: this.schema() };
  }
  async texts(userId) {
    return { defs: [...this.textsDef.defs], own: { ...(await this.docs.get(userId)).texts } };
  }
  async change(userId, set, reset) {
    const stored = await this.docs.get(userId);
    const defaults = this.defaults();
    let own = stored.own.map((o) => ({ path: [...o.path], value: clone2(o.value) }));
    const known = (path) => {
      const bad = path.find((key2) => hasOwn2(FORBIDDEN_KEYS, key2) || key2 === "");
      if (bad !== undefined)
        return { path: [...path], message: `"${bad}" can't name a setting.` };
      const section = path[0];
      if (section !== undefined && !this.sections.some((s) => s.key === section))
        return { path: [...path], message: `There is no settings section "${section}".` };
      return null;
    };
    const place = (path, value) => {
      const above = own.find((o) => o.path.length < path.length && within(path, o.path));
      own = own.filter((o) => !within(o.path, path));
      if (above !== undefined) {
        const rest = path.slice(above.path.length);
        if (!isRecord2(above.value))
          above.value = {};
        put(above.value, rest, value ?? at(defaults, path));
      } else if (value !== undefined)
        own.push({ path, value });
    };
    const problems = [];
    for (const path of reset) {
      const problem = known(path);
      if (problem)
        problems.push(problem);
      else if (path.length === 0)
        own = [];
      else
        place([...path], undefined);
    }
    for (const { path, value } of set) {
      const problem = known(path) ?? (path.length === 0 ? { path: [], message: "A value is put at a setting, not over all of them." } : null);
      if (problem)
        problems.push(problem);
      else
        place([...path], clone2(value));
    }
    const values = this.valuesOf(own);
    for (const section of this.sections)
      for (const p of section.check(values[section.key]))
        problems.push({ path: [section.key, ...p.path], message: p.message });
    if (problems.length > 0)
      throw new SettingsRefused(`The settings refused ${problems.length === 1 ? "a value" : `${problems.length} values`}: nothing was changed.`, problems);
    const revision = await this.docs.change(userId, (doc) => {
      doc.own = own;
      return ++doc.rev;
    });
    for (const listener of this.listeners)
      listener(userId, revision);
    return this.view(userId);
  }
  async text(userId, id, text3) {
    if (!this.textsDef.defs.some((d) => d.id === id))
      throw new SettingsRefused(`There is no text "${id}".`, [{ path: [id], message: "There is no such text." }]);
    if (text3 !== null) {
      const refused = this.textsDef.check(id, text3);
      if (refused !== null)
        throw new SettingsRefused(refused, [{ path: [id], message: refused }]);
    }
    const revision = await this.docs.change(userId, (doc) => {
      if (text3 === null)
        delete doc.texts[id];
      else
        doc.texts[id] = text3;
      return ++doc.rev;
    });
    for (const listener of this.listeners)
      listener(userId, revision);
    return this.texts(userId);
  }
  settle() {
    return this.docs.settle();
  }
}

// src/link/stream.ts
class StreamSender {
  held = new Map;
  count = 0;
  finished = false;
  get last() {
    return this.count;
  }
  get done() {
    return this.finished;
  }
  get kept() {
    return this.held.size;
  }
  push(chunk) {
    if (this.finished)
      return null;
    const seq = ++this.count;
    this.held.set(seq, chunk);
    if (terminal(chunk))
      this.finished = true;
    return { seq, chunk };
  }
  from(from) {
    const out = [];
    for (let seq = Math.max(1, from);seq <= this.count; seq++) {
      const chunk = this.held.get(seq);
      if (chunk !== undefined)
        out.push({ seq, chunk });
    }
    return out;
  }
  ack(seq) {
    for (const held of [...this.held.keys()])
      if (held <= seq)
        this.held.delete(held);
    return this.finished && seq >= this.count;
  }
}

// src/extension/backend/streams.ts
var key2 = (userId, stream) => `${userId}\x00${stream}`;

class StreamRegistry {
  env;
  streams = new Map;
  constructor(env) {
    this.env = env;
  }
  get size() {
    return this.streams.size;
  }
  emit(sent, chunk) {
    const numbered = sent.sender.push(chunk);
    if (numbered === null)
      return;
    this.env.push(sent.userId, sent.relay, { link: LINK, type: "chunk", stream: sent.stream, seq: numbered.seq, chunk });
  }
  flush(sent) {
    sent.unhold?.();
    sent.unhold = null;
    const held = sent.held;
    sent.held = null;
    if (held !== null)
      this.emit(sent, held);
  }
  text(sent, kind, text3) {
    if (text3 === "" || sent.endedAt !== null)
      return;
    if (sent.held !== null && sent.held.kind !== kind)
      this.flush(sent);
    sent.held = { kind, text: (sent.held?.text ?? "") + text3 };
    if (sent.coalesceMs <= 0)
      this.flush(sent);
    else if (sent.unhold === null)
      sent.unhold = this.env.later(sent.coalesceMs, () => {
        sent.unhold = null;
        this.flush(sent);
      });
  }
  end(sent, chunk) {
    if (sent.endedAt !== null || this.streams.get(key2(sent.userId, sent.stream)) !== sent)
      return;
    this.flush(sent);
    this.emit(sent, chunk);
    sent.endedAt = this.env.now();
  }
  open(userId, relay, stream, turn, tuning) {
    const k = key2(userId, stream);
    if (this.streams.has(k))
      return null;
    const sent = { userId, relay, stream, turn, sender: new StreamSender, abort: new AbortController, held: null, unhold: null, coalesceMs: tuning.coalesceMs, keepMs: tuning.keepMs, endedAt: null };
    this.streams.set(k, sent);
    return {
      signal: sent.abort.signal,
      delta: (delta) => {
        if (delta.reasoning !== undefined)
          this.text(sent, "reasoning", delta.reasoning);
        if (delta.content !== undefined)
          this.text(sent, "content", delta.content);
      },
      done: (result) => this.end(sent, { kind: "done", result }),
      error: (message, code) => this.end(sent, { kind: "error", message, code })
    };
  }
  of(userId, relay, stream) {
    const sent = this.streams.get(key2(userId, stream));
    return sent !== undefined && sent.relay === relay ? sent : null;
  }
  drop(sent) {
    sent.unhold?.();
    sent.unhold = null;
    sent.held = null;
    this.streams.delete(key2(sent.userId, sent.stream));
  }
  ack(userId, relay, stream, seq) {
    const sent = this.of(userId, relay, stream);
    if (sent === null)
      return true;
    if (!sent.sender.ack(seq))
      return false;
    this.drop(sent);
    return true;
  }
  resend(userId, relay, stream, from) {
    const sent = this.of(userId, relay, stream);
    if (sent === null)
      return null;
    for (const { seq, chunk } of sent.sender.from(from))
      this.env.push(userId, relay, { link: LINK, type: "chunk", stream, seq, chunk });
    return sent.sender.last;
  }
  cancel(userId, relay, stream, reason) {
    const sent = this.of(userId, relay, stream);
    if (sent === null)
      return false;
    this.drop(sent);
    sent.abort.abort(new Error(reason === "" ? "The runtime cancelled the call." : reason));
    return true;
  }
  resume(userId, relay, open) {
    const lost = [];
    const named = new Set;
    for (const { stream, seq } of open) {
      named.add(stream);
      const sent = this.of(userId, relay, stream);
      if (sent === null)
        lost.push(stream);
      else
        for (const n of sent.sender.from(seq + 1))
          this.env.push(userId, relay, { link: LINK, type: "chunk", stream, seq: n.seq, chunk: n.chunk });
    }
    for (const sent of [...this.streams.values()]) {
      if (sent.userId !== userId || sent.relay !== relay || named.has(sent.stream))
        continue;
      this.drop(sent);
      sent.abort.abort(new Error("The runtime no longer reads this call's answer."));
    }
    return lost;
  }
  missing(userId, relay, streams) {
    return streams.filter((stream) => this.of(userId, relay, stream) === null);
  }
  stopTurn(userId, turn, why) {
    let n = 0;
    for (const sent of this.streams.values()) {
      if (sent.userId !== userId || sent.turn !== turn || sent.endedAt !== null)
        continue;
      sent.abort.abort(new Error(why));
      n++;
    }
    return n;
  }
  forget(userId, relay) {
    for (const sent of [...this.streams.values()]) {
      if (sent.userId !== userId || sent.relay !== relay)
        continue;
      this.drop(sent);
      sent.abort.abort(new Error("The runtime was forgotten."));
    }
  }
  sweep() {
    const now = this.env.now();
    for (const sent of [...this.streams.values()])
      if (sent.endedAt !== null && now - sent.endedAt > sent.keepMs)
        this.drop(sent);
  }
}

// src/extension/backend/switch.ts
var PIN = "connection_profile_id";
var PIN_MODEL = "connection_model";
function storedOf3(raw) {
  if (!isRecord2(raw) || raw.v !== 1 || !isRecord2(raw.on))
    return null;
  const on = {};
  for (const [chatId, s] of Object.entries(raw.on)) {
    if (!isRecord2(s) || typeof s.since !== "number")
      continue;
    on[chatId] = { since: s.since, prior: typeof s.prior === "string" ? s.prior : null, priorModel: s.priorModel === undefined ? null : s.priorModel };
  }
  return { v: 1, on };
}

class ChatSwitch {
  host;
  deps;
  docs;
  constructor(host, deps) {
    this.host = host;
    this.deps = deps;
    this.docs = new UserDocs(host, "chats.json", storedOf3, () => ({ v: 1, on: {} }));
  }
  async viewOf(userId, chat) {
    const connection = await this.deps.connections.ofChat(userId, chat);
    const switched = (await this.docs.get(userId)).on[chat.id];
    const on = switched !== undefined && connection?.loopback === true && chat.metadata[PIN] === connection.id;
    return { chatId: chat.id, name: chat.name === "" ? null : chat.name, on, since: on ? switched.since : null, connection };
  }
  async view(userId, chatId) {
    return this.viewOf(userId, await this.deps.chats.own(userId, chatId));
  }
  async set(userId, chatId, on) {
    const { chats, connections } = this.deps;
    const chat = await chats.own(userId, chatId);
    const loops = await connections.loopbacks(userId);
    const pin = typeof chat.metadata[PIN] === "string" ? chat.metadata[PIN] : null;
    const pinnedLoop = pin !== null && loops.some((c) => c.id === pin);
    if (on) {
      const loop = loops[0];
      if (loop === undefined)
        throw new UiRefused("unavailable", "There is no loopback connection yet. Mint a loopback key on the Runtime page: your linked runtime makes the connection with it.");
      if (!pinnedLoop) {
        await this.host.chats.patchMetadata(chatId, { [PIN]: loop.id, [PIN_MODEL]: null }, userId);
        await this.docs.change(userId, (doc) => {
          doc.on[chatId] = { since: this.deps.now(), prior: pin, priorModel: chat.metadata[PIN_MODEL] ?? null };
        });
      } else if ((await this.docs.get(userId)).on[chatId] === undefined) {
        await this.docs.change(userId, (doc) => {
          doc.on[chatId] = { since: this.deps.now(), prior: null, priorModel: null };
        });
      }
    } else {
      const switched = (await this.docs.get(userId)).on[chatId];
      if (pinnedLoop) {
        const prior = switched?.prior ?? null;
        const back = prior !== null && !loops.some((c) => c.id === prior) ? prior : null;
        await this.host.chats.patchMetadata(chatId, { [PIN]: back, [PIN_MODEL]: back !== null ? switched?.priorModel ?? null : null }, userId);
      }
      if (switched !== undefined) {
        await this.docs.change(userId, (doc) => {
          delete doc.on[chatId];
        });
      }
    }
    return this.viewOf(userId, await chats.own(userId, chatId));
  }
  async any(userId) {
    return Object.keys((await this.docs.get(userId)).on).length > 0;
  }
  async list(userId, answered) {
    const switched = Object.keys((await this.docs.get(userId)).on);
    const out = [];
    const gone = [];
    for (const chatId of new Set([...switched, ...answered])) {
      try {
        out.push(await this.view(userId, chatId));
      } catch (error) {
        if (!(error instanceof LinkRefused && error.code === "not_found"))
          throw error;
        if (switched.includes(chatId))
          gone.push(chatId);
      }
    }
    if (gone.length > 0) {
      await this.docs.change(userId, (doc) => {
        for (const chatId of gone)
          delete doc.on[chatId];
      });
    }
    return out;
  }
  settle() {
    return this.docs.settle();
  }
}

// src/extension/backend/turns.ts
var INTERCEPTOR_PRIORITY = Number.MAX_SAFE_INTEGER;
var KINDS = { normal: "new", regenerate: "regenerate", swipe: "swipe", continue: "continue" };
var TAGGED_TYPES = ["normal", "regenerate", "swipe", "continue"];
function cutoff(messages, history) {
  if (history.keep === "all")
    return [];
  const places = messages.flatMap((m, i) => m.history ? [i] : []);
  return places.slice(0, Math.max(0, places.length - history.count));
}

class Turns {
  host;
  deps;
  generations = new Map;
  latest = new Map;
  byTag = new Map;
  byTurn = new Map;
  byChat = new Map;
  pending = new Map;
  begun = [];
  stopped = [];
  over = [];
  answered = [];
  constructor(host, deps) {
    this.host = host;
    this.deps = deps;
  }
  onBegun(listener) {
    this.begun.push(listener);
  }
  onStopped(listener) {
    this.stopped.push(listener);
  }
  onOver(listener) {
    this.over.push(listener);
  }
  onAnswered(listener) {
    this.answered.push(listener);
  }
  turn(id) {
    return this.byTurn.get(id);
  }
  ofChat(userId, chatId) {
    return this.byChat.get(`${userId}\x00${chatId}`);
  }
  started(event) {
    const held = this.generations.get(event.generationId);
    if (held !== undefined) {
      held.targetMessageId = event.targetMessageId ?? held.targetMessageId;
      held.targetSwipeId = event.targetSwipeId ?? held.targetSwipeId;
      held.userId = event.userId ?? held.userId;
      return;
    }
    this.generations.set(event.generationId, { id: event.generationId, chatId: event.chatId, userId: event.userId, type: event.type, targetMessageId: event.targetMessageId, targetSwipeId: event.targetSwipeId, at: this.deps.now(), ended: null, stopped: false });
    this.latest.set(event.chatId, event.generationId);
  }
  ended(event) {
    const generation = this.generations.get(event.generationId);
    const ended = { messageId: event.messageId, at: this.deps.now() };
    if (generation !== undefined)
      generation.ended = ended;
    else
      this.generations.set(event.generationId, { id: event.generationId, chatId: event.chatId, userId: event.userId, type: "other", targetMessageId: null, targetSwipeId: null, at: ended.at, ended, stopped: false });
    const pending = this.pending.get(event.generationId);
    if (pending !== undefined) {
      this.pending.delete(event.generationId);
      this.write(pending, event.messageId);
    }
    for (const listener of this.over)
      listener(event.generationId, event.chatId);
  }
  stoppedBy(event) {
    const generation = this.generations.get(event.generationId);
    if (generation !== undefined)
      generation.stopped = true;
    const turn = this.byTurn.get(event.generationId);
    if (turn !== undefined)
      for (const listener of this.stopped)
        listener(turn, "You stopped the reply in Lumiverse.");
    const pending = this.pending.get(event.generationId);
    if (pending !== undefined) {
      this.pending.delete(event.generationId);
      this.write(pending, null);
    }
    for (const listener of this.over)
      listener(event.generationId, event.chatId);
  }
  generationOf(input) {
    if (input.generationId !== null) {
      const named = this.generations.get(input.generationId);
      if (named !== undefined)
        return named;
      const made = { id: input.generationId, chatId: input.chatId, userId: input.userId, type: input.type, targetMessageId: null, targetSwipeId: null, at: this.deps.now(), ended: null, stopped: false };
      this.generations.set(made.id, made);
      return made;
    }
    const id = this.latest.get(input.chatId);
    const generation = id === undefined ? undefined : this.generations.get(id);
    if (generation === undefined || generation.ended !== null || generation.stopped || generation.type !== input.type)
      return null;
    if (generation.userId !== null && generation.userId !== input.userId)
      return null;
    return this.byTurn.get(generation.id)?.request != null ? null : generation;
  }
  async intercept(input) {
    const kind = KINDS[input.type];
    if (kind === undefined)
      return {};
    const { connections, chats, settings } = this.deps;
    const loopback = input.connectionId !== null ? await connections.isLoopback(input.userId, input.connectionId) : (await connections.ofChat(input.userId, await chats.own(input.userId, input.chatId)))?.loopback === true;
    if (!loopback)
      return {};
    const transport = await settings.transport(input.userId);
    const omit = cutoff(input.messages, transport.history);
    if (input.dryRun)
      return { omit };
    const generation = this.generationOf(input);
    if (generation === null)
      throw new Error("LumiAH couldn't tell which generation this prompt belongs to, so the reply wasn't started. Send the message again.");
    const left = new Set(omit);
    const sources = input.messages.flatMap((m, i) => m.history && !left.has(i) && m.sourceId !== undefined && m.sourceIndex !== undefined ? [{ mark: contentMark(m.role, m.text), source: { kind: "history", messageId: m.sourceId, index: m.sourceIndex } }] : []);
    const earlier = this.byTurn.get(generation.id);
    if (earlier !== undefined)
      this.byTag.delete(earlier.tag);
    const turn = { turn: generation.id, tag: randomHex(128), userId: input.userId, chatId: input.chatId, kind, presetId: input.presetId, personaId: input.personaId, sources, activated: input.activated, at: this.deps.now(), request: null, relay: null, facts: null };
    this.byTag.set(turn.tag, turn);
    this.byTurn.set(turn.turn, turn);
    this.byChat.set(`${turn.userId}\x00${turn.chatId}`, turn);
    this.trim(transport.tags.held);
    return { omit, parameters: { [TAG_PARAM]: turn.tag } };
  }
  trim(held) {
    while (this.byTag.size > held) {
      const oldest = this.byTag.values().next().value;
      if (oldest === undefined)
        return;
      this.forget(oldest);
    }
    while (this.generations.size > held * 2) {
      const oldest = this.generations.keys().next().value;
      if (oldest === undefined)
        return;
      const generation = this.generations.get(oldest);
      this.generations.delete(oldest);
      if (generation !== undefined && this.latest.get(generation.chatId) === oldest)
        this.latest.delete(generation.chatId);
    }
  }
  forget(turn) {
    this.byTag.delete(turn.tag);
    if (this.byTurn.get(turn.turn) === turn)
      this.byTurn.delete(turn.turn);
    const chat = `${turn.userId}\x00${turn.chatId}`;
    if (this.byChat.get(chat) === turn)
      this.byChat.delete(chat);
  }
  async targetOf(turn) {
    const generation = this.generations.get(turn.turn);
    let message = generation?.targetMessageId ?? null;
    let swipe = generation?.targetSwipeId ?? null;
    if (message === null) {
      const last = await this.deps.chats.last(turn.chatId);
      if (last !== null && last.role === "assistant" && (turn.kind !== "new" || last.content === "")) {
        message = last.id;
        swipe = last.swipeId;
      }
    } else if (swipe === null)
      swipe = (await this.deps.chats.find(turn.chatId, message))?.swipeId ?? null;
    return { message, swipe: swipe ?? 0 };
  }
  async begin(userId, relay, key3, tag, request) {
    if (typeof key3 !== "string" || typeof tag !== "string" || typeof request !== "string" || request === "")
      throw new LinkRefused("bad_request", "The turn's request is malformed: update the runtime and LumiAH to the same build.");
    if (!await this.deps.registry.keyIs(userId, key3))
      throw new LinkRefused("forbidden", "The key in the loopback connection isn't this account's loopback key. Mint a new one on LumiAH's Runtime page: your linked runtime puts it in the connection.");
    const lifeMs = (await this.deps.settings.transport(userId)).tags.lifeMs;
    const settings = await this.deps.settings.revision(userId);
    const turn = this.byTag.get(tag);
    if (turn === undefined || this.deps.now() - turn.at > lifeMs)
      throw new LinkRefused("not_found", "LumiAH doesn't know this reply's tag: the extension started again since the reply was asked for, or the tag is too old. Send the message again.");
    if (turn.userId !== userId)
      throw new LinkRefused("forbidden", "This reply's tag belongs to another account.");
    if (turn.request !== null && turn.request !== request)
      throw new LinkRefused("conflict", "This reply's tag was already used. A tag admits one request, so this one wasn't answered: send the message again.");
    if (turn.facts === null) {
      turn.request = request;
      turn.relay = relay;
      turn.facts = this.targetOf(turn).then((target) => {
        const facts = { turn: turn.turn, user: turn.userId, chat: turn.chatId, generation: turn.turn, kind: turn.kind, target, preset: turn.presetId, sources: turn.sources };
        for (const listener of this.begun)
          listener(turn, facts);
        return facts;
      });
    }
    return { ...await turn.facts, settings };
  }
  async commit(userId, turnId, chatId, target, rawRecord) {
    const record = recordOf(rawRecord);
    const where = target;
    if (typeof turnId !== "string" || typeof chatId !== "string" || record === null || where === null || typeof where !== "object" || !(where.message === null || typeof where.message === "string") || typeof where.swipe !== "number" || !Number.isSafeInteger(where.swipe) || where.swipe < 0) {
      throw new LinkRefused("bad_request", "The turn's record is malformed: update the runtime and LumiAH to the same build.");
    }
    await this.deps.chats.own(userId, chatId);
    const known = this.byTurn.get(turnId);
    if (known !== undefined && (known.userId !== userId || known.chatId !== chatId))
      throw new LinkRefused("forbidden", "That turn isn't this account's.");
    const pending = { turn: turnId, userId, chatId, target: { message: where.message, swipe: where.swipe }, record, at: this.deps.now() };
    const generation = this.generations.get(turnId);
    if (generation?.ended != null)
      return await this.write(pending, generation.ended.messageId) ? "now" : "never";
    if (generation?.stopped === true)
      return await this.write(pending, null) ? "now" : "never";
    this.pending.set(turnId, pending);
    const held = (await this.deps.settings.transport(userId)).anchors.held;
    while (this.pending.size > held) {
      const oldest = this.pending.values().next().value;
      if (oldest === undefined)
        break;
      this.pending.delete(oldest.turn);
      this.write(oldest, null);
    }
    return "on_save";
  }
  async write(pending, saved) {
    const messageId = saved ?? pending.target.message;
    try {
      if (messageId === null) {
        this.host.log("warn", `[LumiAH] turn ${pending.turn.slice(0, 8)}: its reply wasn't saved, so its record wasn't written`);
        return false;
      }
      const swipe = messageId === pending.target.message ? pending.target.swipe : null;
      const written = await this.deps.chats.anchor(pending.userId, pending.chatId, messageId, swipe, pending.record);
      if (!written)
        this.host.log("warn", `[LumiAH] turn ${pending.turn.slice(0, 8)}: its reply's message is gone, so its record wasn't written`);
      else
        for (const listener of this.answered)
          listener(pending.userId);
      return written;
    } catch (error) {
      this.host.log("error", `[LumiAH] turn ${pending.turn.slice(0, 8)}: its record couldn't be written (${wordsOf(error)})`);
      return false;
    }
  }
  async activated(userId, chatId, generationId) {
    const turn = this.byTurn.get(generationId);
    if (turn === undefined || turn.userId !== userId || turn.chatId !== chatId)
      return [];
    const out = [];
    for (const a of turn.activated) {
      const entry = await this.host.lore.entry(a.entryId, userId).catch(() => null);
      if (entry !== null)
        out.push({ entryId: a.entryId, bookId: a.bookId ?? entry.bookId, title: a.title !== "" ? a.title : entry.title, content: entry.content });
    }
    return out;
  }
  async tick() {
    const now = this.deps.now();
    const of = async (userId) => userId === null ? TRANSPORT_DEFAULTS : this.deps.settings.transport(userId).catch(() => TRANSPORT_DEFAULTS);
    for (const pending of [...this.pending.values()]) {
      if (now - pending.at <= (await of(pending.userId)).anchors.waitMs)
        continue;
      this.pending.delete(pending.turn);
      this.write(pending, null);
    }
    for (const turn of [...this.byTag.values()])
      if (now - turn.at > (await of(turn.userId)).tags.lifeMs && !this.pending.has(turn.turn))
        this.forget(turn);
    for (const [id, generation] of [...this.generations]) {
      if (now - generation.at <= (await of(generation.userId)).tags.lifeMs || this.byTurn.has(id) || this.pending.has(id))
        continue;
      this.generations.delete(id);
      if (this.latest.get(generation.chatId) === id)
        this.latest.delete(generation.chatId);
    }
  }
}

// src/extension/backend/ui.ts
var LINK_CODES = { bad_request: "bad_request", forbidden: "forbidden", not_found: "not_found", conflict: "unavailable", unavailable: "unavailable", too_large: "bad_request" };

class Ui {
  host;
  deps;
  users = new Map;
  queue = new KeyedQueue;
  constructor(host, deps) {
    this.host = host;
    this.deps = deps;
  }
  async key(userId) {
    const key3 = (await this.deps.registry.read(userId)).key;
    return { set: key3 !== null, print: key3?.print ?? null, at: key3?.at ?? null };
  }
  async setup(userId) {
    const d = this.deps;
    const registry = await d.registry.read(userId);
    const chats = await d.switch.list(userId, d.live.chatsOf(userId));
    return {
      steps: [
        { id: "runtime", done: (await d.relays.linked(userId)).length > 0 },
        { id: "key", done: registry.key !== null },
        { id: "connection", done: (await d.connections.loopbacks(userId)).length > 0 },
        { id: "chat", done: chats.some((chat) => chat.on || chatAnswered(chat)) },
        { id: "reply", done: registry.replied }
      ]
    };
  }
  async part(userId, part) {
    const d = this.deps;
    switch (part) {
      case "runtime":
        return d.relays.view(userId, d.issues());
      case "setup":
        return this.setup(userId);
      case "key":
        return this.key(userId);
      case "chats":
        return d.switch.list(userId, d.live.chatsOf(userId));
      case "running":
        return d.live.runningOf(userId);
      case "connections":
        return d.connections.views(userId);
      case "settings":
        return d.settings.view(userId);
      case "texts":
        return d.settings.texts(userId);
    }
  }
  async state(userId, rev) {
    const [runtime, setup, key3, chats, connections, settings, texts] = await Promise.all([this.part(userId, "runtime"), this.part(userId, "setup"), this.part(userId, "key"), this.part(userId, "chats"), this.part(userId, "connections"), this.part(userId, "settings"), this.part(userId, "texts")]);
    return { rev, runtime, setup, key: key3, chats, running: this.deps.live.runningOf(userId), connections, settings, texts };
  }
  touch(userId, ...parts) {
    const user = this.users.get(userId);
    if (user === undefined)
      return;
    const idle = user.dirty.size === 0;
    for (const part of parts)
      user.dirty.add(part);
    if (idle && user.dirty.size > 0)
      this.queue.run(userId, () => this.flush(userId));
  }
  touchAll(...parts) {
    for (const userId of this.users.keys())
      this.touch(userId, ...parts);
  }
  async flush(userId) {
    const user = this.users.get(userId);
    if (user === undefined || user.dirty.size === 0)
      return;
    const parts = [...user.dirty];
    user.dirty.clear();
    const patch = {};
    for (const part of parts) {
      try {
        Object.assign(patch, { [part]: await this.part(userId, part) });
      } catch (error) {
        this.host.log("warn", `[LumiAH] the pages' ${part} couldn't be read (${wordsOf(error)})`);
      }
    }
    if (Object.keys(patch).length === 0)
      return;
    user.rev++;
    this.send({ lah: UI_VERSION, type: "lah.state", rev: user.rev, patch }, userId, undefined);
  }
  async settle() {
    for (const userId of this.users.keys())
      await this.queue.run(userId, async () => {
        return;
      });
  }
  send(message, userId, session) {
    this.host.frontend.send(message, userId, session);
  }
  fail(reqId, userId, session, code, message, problems) {
    this.send({ lah: UI_VERSION, type: "lah.error", reqId, code, message, ...problems !== undefined ? { problems } : {} }, userId, session);
  }
  async message(payload, userId, session) {
    const read2 = uiRequestOf(payload);
    if (read2 === null)
      return false;
    if ("malformed" in read2) {
      if (read2.reqId !== null)
        this.fail(read2.reqId, userId, session, "bad_request", read2.malformed);
      return true;
    }
    const { request } = read2;
    try {
      if (request.type === "lah.hello") {
        await this.queue.run(userId, async () => {
          let user = this.users.get(userId);
          if (user === undefined) {
            user = { rev: this.deps.now(), dirty: new Set };
            this.users.set(userId, user);
          }
          const body2 = await this.state(userId, user.rev);
          this.send({ lah: UI_VERSION, type: "lah.result", reqId: request.reqId, request: "lah.hello", body: body2 }, userId, session);
        });
        return true;
      }
      const body = await this.serve(request, userId, session);
      this.send({ lah: UI_VERSION, type: "lah.result", reqId: request.reqId, request: request.type, body }, userId, session);
    } catch (error) {
      if (error instanceof UiRefused)
        this.fail(request.reqId, userId, session, error.code, error.message, error.problems);
      else if (error instanceof SettingsRefused)
        this.fail(request.reqId, userId, session, "invalid", error.message, error.problems);
      else if (error instanceof LinkRefused)
        this.fail(request.reqId, userId, session, LINK_CODES[error.code] ?? "internal", error.message);
      else {
        this.host.log("error", `[LumiAH] ${request.type} failed: ${wordsOf(error)}`);
        this.fail(request.reqId, userId, session, "internal", `LumiAH couldn't do that (${wordsOf(error)}).`);
      }
    }
    return true;
  }
  async serve(r, userId, session) {
    const d = this.deps;
    switch (r.type) {
      case "lah.chat.get":
        return { chat: await d.switch.view(userId, r.chatId) };
      case "lah.chat.set": {
        const chat = await d.switch.set(userId, r.chatId, r.on);
        this.touch(userId, "chats", "setup");
        return { chat };
      }
      case "lah.live.open":
        await d.chats.own(userId, r.chatId);
        return d.live.open(userId, r.chatId, session);
      case "lah.live.events": {
        const page = await d.live.events(userId, r.chatId, r.turn, r.from);
        if (page === null)
          throw new UiRefused("not_found", "That turn is no longer the chat's live one: open the chat's live view again.");
        return page;
      }
      case "lah.live.close":
        d.live.close(userId, r.chatId, session);
        return { closed: true };
      case "lah.turn.stop": {
        const relay = d.live.relayOf(userId, r.chatId, r.turn);
        if (relay === null)
          return { stopped: false };
        const why = "You stopped the reply from LumiAH's live view.";
        const told = d.relays.push(userId, relay, { link: LINK, type: "stop", turn: r.turn, why });
        return { stopped: d.streams.stopTurn(userId, r.turn, why) > 0 || told };
      }
      case "lah.turns.list":
        return d.sessions.list(userId, r.chatId, r.cursor, r.limit);
      case "lah.transcript.get":
        return d.sessions.transcript(userId, r.chatId, r.transcript, r.from);
      case "lah.prompt.get":
        return { prompt: await d.sessions.prompt(userId, r.prompt) };
      case "lah.blob.get":
        return { text: await d.sessions.blob(userId, r.hash) };
      case "lah.session.rollback":
        return d.sessions.rollback(userId, r.chatId, r.messageId, r.swipe);
      case "lah.settings.set":
        return { settings: await d.settings.change(userId, r.set, r.reset) };
      case "lah.models.list": {
        const connection = await d.connections.one(userId, r.connectionId);
        if (connection === null)
          throw new UiRefused("not_found", r.connectionId === null ? "This account has no default connection." : "There is no such connection.");
        const models = await this.host.connections.models(connection.id, userId);
        if (models === null)
          throw new UiRefused("unavailable", "This Lumiverse can't list a connection's models: type the model's name.");
        return { models };
      }
      case "lah.text.set":
        return { texts: await d.settings.text(userId, r.id, r.text) };
      case "lah.text.reset":
        return { texts: await d.settings.text(userId, r.id, null) };
      case "lah.key": {
        const out = r.op === "mint" ? await d.keys.mint(userId) : await d.keys.forget(userId);
        this.touch(userId, "key", "setup", "connections", "chats");
        return { ...out, view: await this.key(userId) };
      }
      case "lah.relay": {
        if (r.op === "rotate")
          await d.relays.rotate(userId, r.relay);
        else {
          await d.relays.forget(userId, r.relay);
          d.streams.forget(userId, r.relay);
        }
        return { runtime: await d.relays.view(userId, d.issues()) };
      }
    }
  }
}

// src/extension/backend/backend.ts
var CORE_KEY = "core";
function settingsSections() {
  return [
    { key: CORE_KEY, defaults: () => defaultSettings(), schema: SETTINGS_SCHEMA, check: (values) => checkSettings(values) },
    { key: TRANSPORT_KEY, defaults: transportDefaults, schema: TRANSPORT_SCHEMA, check: checkTransport }
  ];
}
var NEEDS = [
  ["generation", "make its agents' model calls and hear when a reply starts and ends"],
  ["interceptor", "tag the replies it answers"],
  ["generation_parameters", "put a reply's tag in its request"],
  ["chats", "read a chat and switch LumiAH on for it"],
  ["chat_mutation", "write each turn's record on its reply"],
  ["world_books", "read the chat's lore"],
  ["presets", "read the preset's instructions"],
  ["characters", "find the world books attached to the chat's character"],
  ["personas", "find the world book attached to your persona"]
];
function startBackend(host, env) {
  const { now, later, build } = env;
  const warn = (what) => (error) => host.log("warn", `[LumiAH] ${what}: ${wordsOf(error)}`);
  const registry = new RegistryStore(host);
  const settings = new SettingsStore(host, settingsSections(), { defs: TEXT_DEFS, check: checkText });
  const made = { server: null };
  const relays = new Relays(host, registry, settings, { now, build, send: (frame, userId, session) => made.server?.send(frame, userId, session) });
  const streams = new StreamRegistry({ now, later, push: (userId, relay, push) => relays.push(userId, relay, push) });
  const connections = new Connections(host, { bases: (userId) => relays.bases(userId), serialTools: async (userId) => (await settings.transport(userId)).connections.oneToolAtATime });
  const chats = new Chats(host, async (userId) => (await settings.transport(userId)).sessions.pathsKept);
  const turns = new Turns(host, { chats, connections, registry, settings, now });
  const storage = new Storage(host);
  const lore = new Lore(host, {
    persona: (userId, chatId) => turns.ofChat(userId, chatId)?.personaId,
    activatedBooks: (userId, chatId) => (turns.ofChat(userId, chatId)?.activated ?? []).flatMap((a) => a.bookId !== null ? [a.bookId] : [])
  });
  const presets = new Presets(host);
  const live = new LiveBuffer(host, { now, transport: (userId) => settings.transport(userId) });
  const models = new Models(host, { connections, streams, settings, registry });
  const keys = new Keys(host, { registry, relays, settings, now, later });
  const chatSwitch = new ChatSwitch(host, { chats, connections, now });
  const sessions = new SessionsPage({ chats, storage, settings, now });
  const issues = () => [
    ...NEEDS.filter(([permission]) => !host.granted(permission)).map(([permission, what]) => `LumiAH isn't granted "${permission}", which it needs to ${what}. Grant it in Lumiverse (Extensions \u2192 LumiAH \u2192 Permissions).`),
    ...host.capability("chat-lean-messages-v1") ? [] : ["This Lumiverse can't write an extension's own entry on a message, so no turn's record can be kept and the session won't carry from one reply to the next. Update Lumiverse."],
    ...host.capability("frontend-session-routing-v1") ? [] : ["This Lumiverse doesn't say which connection a message comes from, so no runtime can link. Update Lumiverse."]
  ];
  const ui = new Ui(host, { relays, registry, settings, streams, connections, chats, live, switch: chatSwitch, sessions, keys, issues, now });
  const server = new LinkServer(host, {
    relays,
    registry,
    settings,
    streams,
    models,
    turns,
    chats,
    storage,
    lore,
    presets,
    connections,
    live,
    connectionMade: (userId, ref, connection, problem) => {
      keys.made(userId, ref, connection, problem);
      ui.touch(userId, "connections", "setup", "chats");
    },
    now,
    later,
    build
  });
  made.server = server;
  relays.onChange((userId) => ui.touch(userId, "runtime", "setup", "connections", "chats"));
  relays.onPing((userId, relay, named) => live.named(userId, relay, named));
  live.onChange((userId) => ui.touch(userId, "running", "chats", "setup"));
  settings.onChange((userId, revision) => {
    server.settingsChanged(userId);
    ui.touch(userId, "settings", "texts");
    registry.read(userId).then((r) => {
      for (const relay of Object.keys(r.relays))
        relays.push(userId, relay, { link: LINK, type: "settings", revision });
    }).catch(warn("the runtimes weren't told of the new settings"));
  });
  host.onPermission(() => ui.touchAll("runtime"));
  turns.onBegun((turn, facts) => void live.begin(turn.userId, turn.relay ?? "", facts).catch(warn("a turn's live view couldn't be started")));
  turns.onStopped((turn, why) => {
    if (turn.relay !== null)
      relays.push(turn.userId, turn.relay, { link: LINK, type: "stop", turn: turn.turn, why });
    streams.stopTurn(turn.userId, turn.turn, why);
  });
  turns.onOver((generationId) => live.over(generationId));
  turns.onAnswered((userId) => {
    registry.read(userId).then(async (r) => {
      if (r.replied)
        return;
      await registry.change(userId, (doc) => {
        doc.replied = true;
      });
      ui.touch(userId, "setup");
    }).catch(warn("first-time setup's last step couldn't be kept"));
  });
  host.events.onGenerationStarted((event) => turns.started(event));
  host.events.onGenerationEnded((event) => {
    chats.touched(event.chatId);
    turns.ended(event);
  });
  host.events.onGenerationStopped((event) => {
    chats.touched(event.chatId);
    turns.stoppedBy(event);
  });
  host.events.onSwipe((event) => {
    if (event.action === "deleted")
      chats.swipeDeleted(event.chatId, event.messageId, event.swipeId).catch(warn("a deleted swipe's record couldn't be let go"));
  });
  host.events.onChatTouched((chatId, gone) => gone ? chats.dropped(chatId) : chats.touched(chatId));
  host.events.onChatChanged((_chatId, userId) => {
    if (userId !== null)
      ui.touch(userId, "chats", "setup");
  });
  host.registerInterceptor((input) => turns.intercept(input), { priority: INTERCEPTOR_PRIORITY, types: TAGGED_TYPES, required: host.capability("required-interceptors-v1") });
  host.frontend.onMessage((payload, userId, session) => {
    (async () => {
      if (await server.frame(payload, userId, session))
        return;
      await ui.message(payload, userId, session);
    })().catch(warn("a message couldn't be handled"));
  });
  host.frontend.onClosed((session) => {
    relays.sessionClosed(session);
    live.sessionClosed(session);
    server.sessionClosed(session);
  });
  return {
    async tick() {
      await relays.tick();
      streams.sweep();
      await turns.tick();
      await live.tick();
    },
    async settle() {
      await registry.settle();
      await settings.settle();
      await chatSwitch.settle();
      await ui.settle();
    },
    registry,
    settings,
    relays,
    streams,
    turns,
    live,
    chats,
    ui,
    server
  };
}

// src/extension/backend/spindle.ts
function str(o, key3) {
  if (!isRecord2(o))
    return;
  const v2 = o[key3];
  return typeof v2 === "string" ? v2 : undefined;
}
function num(o, key3) {
  if (!isRecord2(o))
    return;
  const v2 = o[key3];
  return typeof v2 === "number" && Number.isFinite(v2) ? v2 : undefined;
}
var GENERATION_TYPES = { normal: "normal", regenerate: "regenerate", swipe: "swipe", continue: "continue", impersonate: "impersonate" };
function generationType(o) {
  const type = str(o, "generationType");
  return type === undefined ? "normal" : GENERATION_TYPES[type] ?? "other";
}
function roleOf(raw) {
  if (raw === "system")
    return "system";
  return typeof raw === "string" && raw.startsWith("assistant") ? "assistant" : "user";
}
function partsText(content) {
  if (typeof content === "string")
    return content;
  if (!Array.isArray(content))
    return "";
  return content.map((p) => isRecord2(p) && p.type === "text" && typeof p.text === "string" ? p.text : "").join("");
}
var PROMPT_FLAGS = ["__isChatHistory", "__isWorldInfoEntry", "sourceMessageId", "sourceIndexInChat", "sourceMessageMetadata"];
function promptMessageOf(raw) {
  const flagged = raw;
  const clean = { ...flagged };
  for (const flag2 of PROMPT_FLAGS)
    delete clean[flag2];
  const index = flagged.sourceIndexInChat;
  const id = flagged.sourceMessageId;
  return {
    message: { role: raw.role, text: partsText(raw.content), history: flagged.__isChatHistory === true, ...typeof id === "string" ? { sourceId: id } : {}, ...typeof index === "number" ? { sourceIndex: index } : {} },
    clean
  };
}
function messageOf(raw) {
  const id = str(raw, "id");
  if (!isRecord2(raw) || id === undefined)
    return null;
  const swipes = Array.isArray(raw.swipes) ? raw.swipes : [];
  const swipeId = num(raw, "swipe_id") ?? 0;
  const shown = swipes[swipeId];
  const metadata = isRecord2(raw.metadata) ? raw.metadata : isRecord2(raw.extra) && isRecord2(raw.extra.spindle_metadata) ? raw.extra.spindle_metadata : {};
  const own = metadata[EXTENSION_IDENTIFIER];
  return {
    id,
    index: num(raw, "index_in_chat") ?? 0,
    role: raw.role === "system" || raw.role === "assistant" || raw.role === "user" ? raw.role : raw.is_user === true ? "user" : "assistant",
    name: str(raw, "name") ?? "",
    swipeId,
    swipes: Math.max(1, swipes.length),
    content: str(raw, "content") ?? (typeof shown === "string" ? shown : ""),
    own: own === undefined ? null : toJson(own)
  };
}
function reasoningOverride(effort, display) {
  if (effort === undefined || effort === "inherit")
    return;
  return effort === "off" ? { source: "off" } : { source: "custom", apiReasoning: true, effort, ...display ? { thinkingDisplay: display } : {} };
}
function messageDTO(m) {
  const cache = (on) => on ? { cache_control: { type: "ephemeral" } } : {};
  const content = m.parts?.map((p) => {
    if (p.type === "text")
      return { type: "text", text: p.text, ...cache(p.cache) };
    if (p.type === "tool_use")
      return { type: "tool_use", id: p.id, name: p.name, input: p.input, ...p.thoughtSignature !== undefined ? { thought_signature: p.thoughtSignature } : {}, ...cache(p.cache) };
    if (p.type === "tool_result")
      return { type: "tool_result", tool_use_id: p.toolUseId, content: p.content, ...p.isError ? { is_error: true } : {}, ...cache(p.cache) };
    return { type: p.media, data: p.data, mime_type: p.mimeType, ...cache(p.cache) };
  }) ?? m.content;
  return {
    role: m.role,
    content,
    ...m.reasoning !== undefined ? { reasoning_content: m.reasoning } : {},
    ...m.thinkingBlocks ? { thinking_blocks: m.thinkingBlocks } : {},
    ...m.reasoningDetails ? { reasoning_details: m.reasoningDetails } : {}
  };
}
function toolDTO(t) {
  return { name: t.name, description: t.description, parameters: t.parameters, ...t.cache ? { cache_control: { type: "ephemeral" } } : {} };
}
function thinkingBlock(raw) {
  const type = str(raw, "type");
  if (type !== "thinking" && type !== "redacted_thinking")
    return null;
  const thinking = str(raw, "thinking");
  const signature = str(raw, "signature");
  const data = str(raw, "data");
  return { type, ...thinking !== undefined ? { thinking } : {}, ...signature !== undefined ? { signature } : {}, ...data !== undefined ? { data } : {} };
}
function modelResult(raw) {
  const calls = isRecord2(raw) && Array.isArray(raw.tool_calls) ? raw.tool_calls : [];
  const toolCalls = calls.flatMap((c, i) => {
    if (!isRecord2(c) || typeof c.name !== "string")
      return [];
    const signature = str(c, "thought_signature");
    return [{ name: c.name, args: toJsonObject(c.args), callId: str(c, "call_id") ?? `call_${i}`, ...signature !== undefined ? { thoughtSignature: signature } : {} }];
  });
  const model = str(raw, "model");
  const thought = str(raw, "reasoning");
  const blocks = isRecord2(raw) && Array.isArray(raw.thinking_blocks) ? raw.thinking_blocks.flatMap((b) => thinkingBlock(b) ?? []) : [];
  const details = isRecord2(raw) && Array.isArray(raw.reasoning_details) ? raw.reasoning_details.filter(isRecord2).map(toJsonObject) : [];
  return {
    content: str(raw, "content") ?? "",
    finishReason: str(raw, "finish_reason") ?? "",
    ...model ? { model } : {},
    ...toolCalls.length > 0 ? { toolCalls } : {},
    ...thought ? { reasoning: thought } : {},
    ...blocks.length > 0 ? { thinkingBlocks: blocks } : {},
    ...details.length > 0 ? { reasoningDetails: details } : {},
    ...isRecord2(raw) && isRecord2(raw.usage) ? { usage: toJsonObject(raw.usage) } : {}
  };
}
async function streamedAnswer(stream, signal, onDelta) {
  let wait = null;
  const abort = () => wait?.reject(new DOMException("Generation aborted", "AbortError"));
  signal.addEventListener("abort", abort, { once: true });
  try {
    for (;; ) {
      wait = Promise.withResolvers();
      if (signal.aborted)
        abort();
      else
        stream.next().then(wait.resolve, wait.reject);
      const step = await wait.promise;
      if (step.done)
        throw new Error("The model's stream ended without its answer");
      const chunk = step.value;
      if (chunk.type === "done")
        return chunk;
      if (chunk.token !== "")
        onDelta(chunk.type === "reasoning" ? { reasoning: chunk.token } : { content: chunk.token });
    }
  } finally {
    signal.removeEventListener("abort", abort);
    stream.return(undefined).catch(() => {
      return;
    });
  }
}
async function generate(input, signal, onDelta) {
  return modelResult(await streamedAnswer(spindle.generate.quietStream(input), signal, onDelta));
}
async function readOrNull(path, userId) {
  try {
    return await spindle.userStorage.read(path, userId);
  } catch (error) {
    if (!await spindle.userStorage.exists(path, userId))
      return null;
    throw error;
  }
}
var HOST_PAGE = 200;
var MESSAGE_PAGE = 1000;
function createSpindleHost() {
  const capabilities = spindle.host?.capabilities ?? {};
  const capability = (name) => (capabilities[name] ?? 0) >= 1;
  const lean = capability("chat-lean-messages-v1");
  const url = import.meta.url;
  const dir = url.startsWith("file://") ? decodeURIComponent(url.slice("file://".length).replace(/\/[^/]*$/, "")) : null;
  return {
    log(level, message) {
      if (level === "error")
        spindle.log.error(message);
      else if (level === "warn")
        spindle.log.warn(message);
      else
        spindle.log.info(message);
    },
    granted: (permission) => spindle.permissions.has(permission),
    onPermission(handler) {
      spindle.permissions.onChanged((detail) => handler(detail.permission, detail.granted));
    },
    capability,
    install: { bun: typeof process.execPath === "string" && process.execPath.startsWith("/") ? process.execPath : null, dir },
    frontend: {
      send(message, userId, sessionId) {
        spindle.sendToFrontend(message, userId, sessionId !== undefined ? { frontendSessionId: sessionId } : undefined);
      },
      onMessage(handler) {
        spindle.onFrontendMessage(handler);
      },
      onClosed(handler) {
        spindle.on("FRONTEND_SESSION_CLOSED", (payload) => {
          const id = str(payload, "frontendSessionId");
          if (id !== undefined)
            handler(id);
        });
      }
    },
    events: {
      onGenerationStarted(handler) {
        spindle.on("GENERATION_STARTED", (p, userId) => {
          const generationId = str(p, "generationId");
          const chatId = str(p, "chatId");
          if (generationId === undefined || chatId === undefined)
            return;
          handler({ generationId, chatId, userId: userId ?? null, type: generationType(p), targetMessageId: str(p, "targetMessageId") ?? null, targetSwipeId: num(p, "targetSwipeId") ?? null });
        });
      },
      onGenerationEnded(handler) {
        spindle.on("GENERATION_ENDED", (p, userId) => {
          const generationId = str(p, "generationId");
          const chatId = str(p, "chatId");
          if (generationId === undefined || chatId === undefined)
            return;
          handler({ generationId, chatId, userId: userId ?? null, messageId: str(p, "messageId") ?? null, error: str(p, "error") ?? null });
        });
      },
      onGenerationStopped(handler) {
        spindle.on("GENERATION_STOPPED", (p, userId) => {
          const generationId = str(p, "generationId");
          const chatId = str(p, "chatId");
          if (generationId !== undefined && chatId !== undefined)
            handler({ generationId, chatId, userId: userId ?? null });
        });
      },
      onSwipe(handler) {
        spindle.on("MESSAGE_SWIPED", (p, userId) => {
          const chatId = str(p, "chatId");
          const message = isRecord2(p) ? p.message : undefined;
          const messageId = str(message, "id");
          const action = str(p, "action");
          if (chatId === undefined || messageId === undefined || action !== "added" && action !== "updated" && action !== "deleted" && action !== "navigated")
            return;
          handler({ chatId, userId: userId ?? null, messageId, action, swipeId: num(p, "swipeId") ?? num(message, "swipe_id") ?? 0 });
        });
      },
      onChatChanged(handler) {
        spindle.on("CHAT_CHANGED", (p, userId) => {
          const chatId = str(p, "chatId");
          if (chatId !== undefined)
            handler(chatId, userId ?? null);
        });
      },
      onChatTouched(handler) {
        for (const event of ["MESSAGE_SENT", "MESSAGE_EDITED", "MESSAGE_DELETED", "MESSAGE_SWIPED", "SWIPE_EDITED", "CHAT_CHANGED"]) {
          spindle.on(event, (p) => {
            const chatId = str(p, "chatId");
            if (chatId !== undefined)
              handler(chatId, false);
          });
        }
        spindle.on("CHAT_DELETED", (p) => {
          const chatId = str(p, "id") ?? str(p, "chatId");
          if (chatId !== undefined)
            handler(chatId, true);
        });
      }
    },
    registerInterceptor(handler, options) {
      let dispose = null;
      const register = () => {
        dispose?.();
        dispose = spindle.registerInterceptor(async (messages, context) => {
          const read2 = messages.map(promptMessageOf);
          const clean = read2.map((r) => r.clean);
          const ctx = context;
          const chatId = str(ctx, "chatId");
          const userId = str(ctx, "userId");
          if (chatId === undefined || userId === undefined)
            return clean;
          const activated = isRecord2(ctx) && Array.isArray(ctx.activatedWorldInfo) ? ctx.activatedWorldInfo : [];
          const verdict = await handler({
            chatId,
            userId,
            generationId: str(ctx, "generationId") ?? null,
            type: generationType(ctx),
            dryRun: isRecord2(ctx) && (ctx.dryRun === true || ctx.isDryRun === true),
            connectionId: str(ctx, "connectionId") ?? null,
            presetId: str(ctx, "presetId") ?? null,
            personaId: str(ctx, "personaId") ?? null,
            activated: activated.flatMap((e) => {
              const entryId = str(e, "id");
              return entryId === undefined ? [] : [{ entryId, bookId: str(e, "bookId") ?? null, title: str(e, "comment") ?? "" }];
            }),
            messages: read2.map((r) => r.message)
          });
          const omit = new Set(verdict.omit ?? []);
          const sent = omit.size > 0 ? clean.filter((_, i) => !omit.has(i)) : clean;
          return verdict.parameters ? { messages: sent, parameters: verdict.parameters } : sent;
        }, { priority: options.priority, match: { generationTypes: options.types.filter((t) => t !== "other") }, required: options.required });
      };
      register();
      spindle.permissions.onChanged((detail) => {
        if (detail.permission === "interceptor" && detail.granted)
          register();
      });
    },
    models: {
      call(request, userId, signal, onDelta) {
        const parameters = { ...request.params, max_tokens: request.maxTokens };
        if (request.model)
          parameters.model = request.model;
        if (request.usage)
          parameters._include_usage = true;
        if (request.parallelToolCalls === false && request.tools !== undefined && request.tools.length > 0)
          parameters.parallel_tool_calls = false;
        const reasoning = reasoningOverride(request.effort, request.thinkingDisplay);
        return generate({
          type: "quiet",
          messages: request.messages.map(messageDTO),
          parameters,
          ...request.connectionId ? { connection_id: request.connectionId } : {},
          ...request.tools && request.tools.length > 0 ? { tools: request.tools.map(toolDTO) } : {},
          ...reasoning ? { reasoning } : {},
          userId,
          signal
        }, signal, onDelta);
      },
      pass(request, userId, signal, onDelta) {
        return generate({
          type: "quiet",
          messages: request.messages.map(messageDTO),
          parameters: { ...request.parameters, _include_usage: true },
          ...request.connectionId ? { connection_id: request.connectionId } : {},
          ...request.tools.length > 0 ? { tools: request.tools.map(toolDTO) } : {},
          userId,
          signal
        }, signal, onDelta);
      }
    },
    connections: {
      async list(userId) {
        return (await spindle.connections.list(userId)).map((c) => ({ id: c.id, name: c.name, provider: c.provider, url: c.api_url, model: c.model, isDefault: c.is_default, metadata: toJsonObject(c.metadata) }));
      },
      async get(connectionId, userId) {
        const c = await spindle.connections.get(connectionId, userId);
        return c ? { id: c.id, name: c.name, provider: c.provider, url: c.api_url, model: c.model, isDefault: c.is_default, metadata: toJsonObject(c.metadata) } : null;
      },
      async models(connectionId, userId) {
        const list = spindle.connections.getModels;
        if (!list)
          return null;
        return (await list.call(spindle.connections, connectionId, userId)).map((m) => m.id);
      }
    },
    storage: {
      read: readOrNull,
      write: (path, text3, userId) => spindle.userStorage.write(path, text3, userId),
      remove: (path, userId) => spindle.userStorage.delete(path, userId),
      async size(path, userId) {
        const stat = await spindle.userStorage.stat(path, userId);
        return stat.exists && stat.isFile ? stat.sizeBytes : null;
      }
    },
    chats: {
      async get(chatId, userId) {
        const chat = await spindle.chats.get(chatId, userId);
        return chat ? { id: chat.id, name: chat.name, characterId: typeof chat.character_id === "string" && chat.character_id !== "" ? chat.character_id : null, metadata: toJsonObject(chat.metadata) } : null;
      },
      async patchMetadata(chatId, patch, userId) {
        const chat = await spindle.chats.get(chatId, userId);
        if (!chat)
          throw new Error(`chat ${chatId} not found`);
        const metadata = { ...chat.metadata };
        for (const [key3, value] of Object.entries(patch)) {
          if (value === null)
            delete metadata[key3];
          else
            metadata[key3] = value;
        }
        await spindle.chats.update(chatId, { metadata }, userId);
      },
      async messages(chatId, range) {
        const out = [];
        const take = (rows) => {
          for (const row of rows) {
            const m = messageOf(row);
            if (m)
              out.push(m);
          }
        };
        if (!lean) {
          take(await spindle.chat.getMessages(chatId));
          out.sort((a, b) => a.index - b.index);
          if (range === undefined)
            return out;
          return "tail" in range ? out.slice(-range.tail) : out.slice(range.from, range.from + range.count);
        }
        const options = { light: true, includeExtra: false, ownMetadataOnly: true };
        if (range !== undefined && "tail" in range) {
          take(await spindle.chat.getMessages(chatId, { ...options, tail: Math.max(1, Math.min(MESSAGE_PAGE, range.tail)) }));
          return out.sort((a, b) => a.index - b.index);
        }
        const end = range ? range.from + range.count : Number.POSITIVE_INFINITY;
        for (let offset = range?.from ?? 0;offset < end; offset += MESSAGE_PAGE) {
          const limit2 = Math.min(MESSAGE_PAGE, end - offset);
          const rows = await spindle.chat.getMessages(chatId, { ...options, limit: limit2, offset });
          take(rows);
          if (rows.length < limit2)
            break;
        }
        return out.sort((a, b) => a.index - b.index);
      },
      async setOwn(chatId, messageId, value) {
        if (!lean)
          throw new Error("This Lumiverse can't write an extension's own entry on a message (it lacks chat-lean-messages-v1): update Lumiverse.");
        await spindle.chat.updateMessage(chatId, messageId, { ownMetadata: value });
      }
    },
    lore: {
      async book(bookId, userId) {
        const b = await spindle.world_books.get(bookId, userId);
        return b ? { id: b.id, name: b.name, description: b.description ?? "" } : null;
      },
      async entries(bookId, userId) {
        const out = [];
        for (let offset = 0;; offset += HOST_PAGE) {
          const page = await spindle.world_books.entries.list(bookId, { limit: HOST_PAGE, offset, userId });
          for (const e of page.data)
            out.push({ id: e.id, bookId: e.world_book_id, title: e.comment, keys: [...e.key], secondaryKeys: [...e.keysecondary ?? []], content: e.content, enabled: !e.disabled, constant: e.constant });
          if (page.data.length < HOST_PAGE || out.length >= page.total)
            return out;
        }
      },
      async entry(entryId, userId) {
        const e = await spindle.world_books.entries.get(entryId, userId);
        return e ? { id: e.id, bookId: e.world_book_id, title: e.comment, keys: [...e.key], secondaryKeys: [...e.keysecondary ?? []], content: e.content, enabled: !e.disabled, constant: e.constant } : null;
      },
      global: (userId) => spindle.world_books.getGlobal(userId),
      async ofCharacter(characterId, userId) {
        if (!spindle.permissions.has("characters"))
          return [];
        const c = await spindle.characters.get(characterId, userId);
        return c && Array.isArray(c.world_book_ids) ? c.world_book_ids.filter((id) => typeof id === "string") : [];
      },
      async ofPersona(personaId, userId) {
        if (!spindle.permissions.has("personas"))
          return null;
        const p = personaId === null ? await spindle.personas.getActive(userId) : await spindle.personas.get(personaId, userId);
        return p?.attached_world_book_id ?? null;
      }
    },
    presets: {
      async blocks(presetId, userId) {
        if (await spindle.presets.get(presetId, userId) === null)
          return null;
        return (await spindle.presets.blocks.list(presetId, userId)).map((b) => ({ id: b.id, name: b.name, role: roleOf(b.role), content: b.content, enabled: b.enabled, marker: typeof b.marker === "string" && b.marker !== "" ? b.marker : null }));
      },
      async active(chatId, userId) {
        const presets = spindle.presets;
        const getActive = isRecord2(presets) ? presets.getActive : undefined;
        if (typeof getActive !== "function")
          return null;
        const raw = await getActive.call(presets, chatId, userId);
        if (!isRecord2(raw))
          return null;
        const states = {};
        if (isRecord2(raw.block_states)) {
          for (const [id, on] of Object.entries(raw.block_states))
            if (typeof on === "boolean")
              states[id] = on;
        }
        return { presetId: typeof raw.preset_id === "string" ? raw.preset_id : null, states };
      }
    }
  };
}

// src/extension/backend/main.ts
var BUILD = "1b9974c5";
var TICK_MS = 1000;
var host = createSpindleHost();
var backend = startBackend(host, {
  now: () => Date.now(),
  later: (ms2, fn) => {
    const timer = setTimeout(fn, ms2);
    return () => clearTimeout(timer);
  },
  build: BUILD
});
setInterval(() => {
  backend.tick().catch((error) => host.log("warn", `[LumiAH] the backend's tick failed: ${error instanceof Error ? error.message : String(error)}`));
}, TICK_MS);
host.log("info", `[LumiAH] backend ${BUILD} started`);
